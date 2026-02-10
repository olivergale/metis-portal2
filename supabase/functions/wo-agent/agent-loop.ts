// wo-agent/agent-loop.ts v6
// WO-0187: Continuation pattern — checkpoint at ~100s, self-reinvoke via pg_net
// WO-0163: Progress-based velocity gate replaces hard turn limits
// WO-0167: Message history summarization replaces blind truncation
// WO-0166: Role-based tool filtering per agent identity
// Core agentic tool-use loop for work order execution
// Calls Anthropic API iteratively, dispatching tool calls until completion

import Anthropic from "npm:@anthropic-ai/sdk@0.39.0";
import { TOOL_DEFINITIONS, dispatchTool, getToolsForWO, getToolsForWOSync, type ToolContext } from "./tools.ts";

const INITIAL_BUDGET = 15; // Start with 15 turns, extend based on velocity
const REMEDIATION_INITIAL_BUDGET = 20; // Remediation gets more room to investigate
const HARD_CEILING = 50; // Absolute max — never exceed regardless of velocity
const VELOCITY_CHECK_INTERVAL = 5; // Evaluate every 5 turns
const TIMEOUT_MS = 125_000; // 125s — leave 25s buffer for 150s edge function limit
const CHECKPOINT_MS = 100_000; // 100s — save checkpoint before timeout to enable continuation
const MAX_CONTINUATIONS = 5; // Circuit breaker: max 5 continuations per WO execution
const MODEL = "claude-sonnet-4-5-20250929";

// Tools that modify state vs read-only
const MUTATION_TOOLS = new Set([
  'execute_sql', 'apply_migration', 'github_write_file', 'github_edit_file',
  'deploy_edge_function', 'resolve_qa_findings', 'update_qa_checklist',
  'delegate_subtask',
]);

interface VelocityWindow {
  startTurn: number;
  successfulCalls: number;
  failedCalls: number;
  uniqueTools: Set<string>;
  mutations: number;
  readOps: number;
}

type VelocityDecision = 'extend' | 'continue' | 'wrap_up';

interface VelocityResult {
  decision: VelocityDecision;
  reason: string;
  extension: number;
}

function createVelocityWindow(startTurn: number): VelocityWindow {
  return {
    startTurn,
    successfulCalls: 0,
    failedCalls: 0,
    uniqueTools: new Set(),
    mutations: 0,
    readOps: 0,
  };
}

function evaluateVelocity(window: VelocityWindow): VelocityResult {
  const totalCalls = window.successfulCalls + window.failedCalls;
  if (totalCalls === 0) {
    return { decision: 'continue', reason: 'No tool calls in window (text-only turns)', extension: 2 };
  }

  const successRate = window.successfulCalls / totalCalls;
  const toolDiversity = window.uniqueTools.size;

  // High velocity: mutations happening with reasonable success
  if (window.mutations > 0 && successRate >= 0.5) {
    return {
      decision: 'extend',
      reason: `Productive: ${window.mutations} mutations, ${Math.round(successRate * 100)}% success, ${toolDiversity} tools`,
      extension: 10,
    };
  }

  // Medium velocity: investigating (reads, diverse tools)
  if (window.readOps > 0 && successRate >= 0.5 && toolDiversity >= 2) {
    return {
      decision: 'extend',
      reason: `Investigating: ${window.readOps} reads, ${toolDiversity} unique tools, ${Math.round(successRate * 100)}% success`,
      extension: 5,
    };
  }

  // Low velocity: mostly errors or no meaningful work
  if (successRate < 0.3 || (window.failedCalls > 3 && window.mutations === 0)) {
    return {
      decision: 'wrap_up',
      reason: `Stalling: ${Math.round(successRate * 100)}% success, ${window.failedCalls} errors, ${window.mutations} mutations`,
      extension: 0,
    };
  }

  // Default: some progress, modest extension
  return {
    decision: 'continue',
    reason: `Moderate: ${window.successfulCalls} ok, ${window.failedCalls} errors, ${toolDiversity} tools`,
    extension: 3,
  };
}

/**
 * WO-0167: Summarize messages being trimmed instead of discarding them.
 * Extracts tool calls, results, mutations, and errors into a concise summary.
 */
function summarizeTrimmedMessages(
  messages: Array<{ role: string; content: any }>,
  startIdx: number,
  count: number
): string {
  const toolCounts: Record<string, number> = {};
  const errors: string[] = [];
  const mutations: string[] = [];
  let successCount = 0;
  let failCount = 0;

  for (let i = startIdx; i < startIdx + count && i < messages.length; i++) {
    const msg = messages[i];
    if (!msg || !Array.isArray(msg.content)) continue;

    for (const block of msg.content as any[]) {
      if (block.type === 'tool_use') {
        toolCounts[block.name] = (toolCounts[block.name] || 0) + 1;
      }
      if (block.type === 'tool_result') {
        const content = typeof block.content === 'string'
          ? block.content
          : JSON.stringify(block.content).slice(0, 300);
        if (block.is_error) {
          failCount++;
          if (content) errors.push(content.slice(0, 200));
        } else {
          successCount++;
          if (/INSERT|UPDATE|CREATE|ALTER|DROP|DEPLOY|applied migration/i.test(content)) {
            mutations.push(content.slice(0, 200));
          }
        }
      }
    }
  }

  let summary = `## Execution History (earlier turns, summarized)\n`;

  const toolList = Object.entries(toolCounts)
    .sort(([, a], [, b]) => b - a)
    .map(([name, cnt]) => `${name} (${cnt}x)`)
    .join(', ');
  if (toolList) summary += `- Tools used: ${toolList}\n`;
  summary += `- Results: ${successCount} successful, ${failCount} failed\n`;

  if (mutations.length > 0) {
    summary += `- Mutations made:\n`;
    for (const m of mutations.slice(0, 5)) {
      summary += `  - ${m.slice(0, 150)}\n`;
    }
  }

  if (errors.length > 0) {
    summary += `- Errors encountered:\n`;
    for (const e of errors.slice(0, 3)) {
      summary += `  - ${e.slice(0, 150)}\n`;
    }
  }

  return summary.slice(0, 4000);
}

export interface AgentLoopResult {
  status: "completed" | "failed" | "timeout" | "max_turns" | "checkpoint";
  turns: number;
  summary: string;
  toolCalls: Array<{ turn: number; tool: string; success: boolean }>;
}

export async function runAgentLoop(
  systemPrompt: string,
  userMessage: string,
  ctx: ToolContext,
  tags?: string[]
): Promise<AgentLoopResult> {
  const isRemediation = (tags || []).some((t: string) =>
    t === 'remediation' || t === 'auto-qa-loop' || t.startsWith('parent:')
  );

  // Velocity-based budget: start small, extend based on progress
  let currentBudget = isRemediation ? REMEDIATION_INITIAL_BUDGET : INITIAL_BUDGET;
  let velocityWindow = createVelocityWindow(1);
  let wrapUpInjected = false;

  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) {
    return {
      status: "failed",
      turns: 0,
      summary: "ANTHROPIC_API_KEY not set",
      toolCalls: [],
    };
  }

  const client = new Anthropic({ apiKey });
  const startTime = Date.now();
  const toolCalls: AgentLoopResult["toolCalls"] = [];

  // WO-0166: Filter tools based on WO tags AND agent role (tools_allowed)
  const tools = await getToolsForWO(tags || [], ctx.supabase, ctx.agentName);

  // Log execution start with velocity info
  await ctx.supabase.from("work_order_execution_log").insert({
    work_order_id: ctx.workOrderId,
    phase: "execution_start",
    agent_name: ctx.agentName,
    detail: {
      event_type: "execution_start",
      content: `Starting agentic loop for ${ctx.workOrderSlug}`,
      model: MODEL,
      initial_budget: currentBudget,
      hard_ceiling: HARD_CEILING,
      velocity_interval: VELOCITY_CHECK_INTERVAL,
      timeout_ms: TIMEOUT_MS,
      tool_count: tools.length,
      tools_available: tools.map((t) => t.name),
    },
  });

  type MessageParam = Anthropic.MessageParam;
  const messages: MessageParam[] = [
    { role: "user", content: userMessage },
  ];

  let turn = 0;
  let turnsTrimmed = 0;
  const MAX_HISTORY_PAIRS = isRemediation ? 15 : 10;

  while (turn < Math.min(currentBudget, HARD_CEILING)) {
    // Check checkpoint / timeout — checkpoint FIRST so long turns don't skip it
    const elapsed = Date.now() - startTime;

    // WO-0187: Checkpoint at 100s+ OR timeout at 125s+ — both save progress for continuation
    if (elapsed > CHECKPOINT_MS) {
      const lastActions = toolCalls.slice(-5).map(tc => `${tc.tool}(${tc.success ? 'ok' : 'err'})`).join(', ');
      const summary = `Checkpointed at ${Math.round(elapsed / 1000)}s, ${turn} turns. Last: ${lastActions}`;

      // Collect delegated children from tool calls in this execution
      const delegatedChildren = toolCalls
        .filter(tc => tc.tool === "delegate_subtask" && tc.success)
        .map(tc => tc.tool); // slug/id come from result data, but we track tool name here
      // Extract child info from execution log (more reliable)
      let childWOs: Array<{ child_slug: string; child_id: string }> = [];
      try {
        const { data: delegationLogs } = await ctx.supabase
          .from("work_order_execution_log")
          .select("detail")
          .eq("work_order_id", ctx.workOrderId)
          .eq("phase", "stream")
          .order("created_at", { ascending: false })
          .limit(50);
        if (delegationLogs) {
          childWOs = delegationLogs
            .filter((l: any) => l.detail?.tool_name === "delegate_subtask" && l.detail?.child_wo_slug)
            .map((l: any) => ({ child_slug: l.detail.child_wo_slug, child_id: l.detail.child_wo_id }));
        }
      } catch { /* non-critical */ }

      await ctx.supabase.from("work_order_execution_log").insert({
        work_order_id: ctx.workOrderId,
        phase: "checkpoint",
        agent_name: ctx.agentName,
        detail: {
          event_type: "checkpoint",
          turns_completed: turn,
          tools_used: Array.from(velocityWindow.uniqueTools),
          mutations: velocityWindow.mutations,
          last_actions: lastActions,
          elapsed_ms: elapsed,
          budget_remaining: Math.min(currentBudget, HARD_CEILING) - turn,
          delegated_children: childWOs.length > 0 ? childWOs : undefined,
        },
      });

      return { status: "checkpoint", turns: turn, summary, toolCalls };
    }

    turn++;

    // WO-0167: Summarize + trim message history to prevent context window exhaustion
    // Keep: first user message (index 0) + summary (index 1) + last MAX_HISTORY_PAIRS*2 messages
    const maxMessages = 1 + MAX_HISTORY_PAIRS * 2; // first msg + pairs
    if (messages.length > maxMessages) {
      const trimCount = messages.length - maxMessages;

      // Summarize before discarding — extract tool calls, mutations, errors
      const historySummary = summarizeTrimmedMessages(messages, 1, trimCount);

      // Remove old messages (preserve index 0 = original WO context)
      messages.splice(1, trimCount);
      turnsTrimmed += trimCount;

      // Insert or replace summary at index 1
      const hasSummary = messages.length > 1 &&
        messages[1].role === 'user' &&
        typeof messages[1].content === 'string' &&
        (messages[1].content as string).startsWith('## Execution History');

      if (hasSummary) {
        messages[1] = { role: 'user', content: historySummary };
      } else {
        messages.splice(1, 0, { role: 'user', content: historySummary });
      }
    }

    console.log(`[WO-AGENT] Turn ${turn}/${currentBudget} for ${ctx.workOrderSlug} (msgs: ${messages.length}, ceiling: ${HARD_CEILING})`);

    try {
      const response = await client.messages.create({
        model: MODEL,
        max_tokens: 4096,
        system: [
          {
            type: "text" as const,
            text: systemPrompt,
            cache_control: { type: "ephemeral" as const },
          },
        ],
        tools,
        messages,
      });

      // Log the turn
      await logTurn(ctx, turn, response, turnsTrimmed, messages.length);

      // Check stop reason
      if (response.stop_reason === "end_turn") {
        // Model wants to stop without calling a tool
        // Extract text content
        const textContent = response.content
          .filter((b): b is Anthropic.TextBlock => b.type === "text")
          .map((b) => b.text)
          .join("\n");

        // If no terminal tool was called, nudge the model
        if (turn < Math.min(currentBudget, HARD_CEILING)) {
          messages.push({ role: "assistant", content: response.content });
          messages.push({
            role: "user",
            content:
              "You stopped without calling mark_complete or mark_failed. You MUST call one of these tools to finish. If the work is done, call mark_complete with a summary. If you cannot proceed, call mark_failed with a reason.",
          });
          continue;
        }
      }

      if (response.stop_reason === "tool_use") {
        // Process tool calls
        const toolBlocks = response.content.filter(
          (b): b is Anthropic.ToolUseBlock => b.type === "tool_use"
        );

        // Add assistant message to conversation
        messages.push({ role: "assistant", content: response.content });

        // Execute each tool and collect results
        const toolResults: Anthropic.ToolResultBlockParam[] = [];
        let terminalReached = false;

        for (const toolBlock of toolBlocks) {
          const result = await dispatchTool(
            toolBlock.name,
            toolBlock.input as Record<string, any>,
            ctx
          );

          toolCalls.push({
            turn,
            tool: toolBlock.name,
            success: result.success,
          });

          // Log tool result
          await logToolResult(ctx, turn, toolBlock.name, result);

          toolResults.push({
            type: "tool_result",
            tool_use_id: toolBlock.id,
            content: result.success
              ? JSON.stringify(result.data || "ok")
              : `Error: ${result.error}`,
            is_error: !result.success,
          });

          if (result.terminal) {
            terminalReached = true;
          }
        }

        // Add tool results to conversation
        messages.push({ role: "user", content: toolResults });

        // Update velocity window with this turn's tool calls
        for (const toolBlock of toolBlocks) {
          const tc = toolCalls[toolCalls.length - toolBlocks.length + toolBlocks.indexOf(toolBlock)];
          if (tc) {
            velocityWindow.uniqueTools.add(tc.tool);
            if (tc.success) {
              velocityWindow.successfulCalls++;
              if (MUTATION_TOOLS.has(tc.tool)) velocityWindow.mutations++;
              else velocityWindow.readOps++;
            } else {
              velocityWindow.failedCalls++;
            }
          }
        }

        if (terminalReached) {
          const terminalTool = toolBlocks.find(
            (b) => b.name === "mark_complete" || b.name === "mark_failed" || b.name === "transition_state"
          );
          const status = terminalTool?.name === "mark_failed" ? "failed" : "completed";
          const input = terminalTool?.input as Record<string, any>;
          const summary = input?.summary || input?.reason || "Execution finished";

          return { status, turns: turn, summary, toolCalls };
        }

        // Velocity check every N turns
        if (turn > 0 && turn % VELOCITY_CHECK_INTERVAL === 0) {
          const velocity = evaluateVelocity(velocityWindow);

          // Log velocity check
          await logVelocityCheck(ctx, turn, velocityWindow, velocity, currentBudget);

          if (velocity.decision === 'extend') {
            currentBudget = Math.min(currentBudget + velocity.extension, HARD_CEILING);
            console.log(`[WO-AGENT] ${ctx.workOrderSlug} velocity EXTEND: budget now ${currentBudget} (${velocity.reason})`);
          } else if (velocity.decision === 'wrap_up' && !wrapUpInjected) {
            // Give 2 more turns to finish gracefully
            currentBudget = Math.min(turn + 2, HARD_CEILING);
            wrapUpInjected = true;
            messages.push({
              role: "user",
              content: `VELOCITY CHECK — ${velocity.reason}. You have ${Math.min(2, HARD_CEILING - turn)} turns remaining. Call mark_complete with a summary of progress so far, or mark_failed explaining what's blocking you.`,
            });
            console.log(`[WO-AGENT] ${ctx.workOrderSlug} velocity WRAP_UP: ${velocity.reason}`);
          } else {
            if (velocity.extension > 0) {
              currentBudget = Math.min(currentBudget + velocity.extension, HARD_CEILING);
            }
            console.log(`[WO-AGENT] ${ctx.workOrderSlug} velocity CONTINUE: budget ${currentBudget} (${velocity.reason})`);
          }

          // Reset window for next interval
          velocityWindow = createVelocityWindow(turn + 1);
        }

        continue;
      }

      // Other stop reasons (max_tokens, etc)
      messages.push({ role: "assistant", content: response.content });
      messages.push({
        role: "user",
        content:
          "Your response was cut off. Please continue and remember to call mark_complete or mark_failed when done.",
      });
    } catch (e: any) {
      console.error(`[WO-AGENT] Turn ${turn} error:`, e.message);

      // Log the error
      await ctx.supabase.from("work_order_execution_log").insert({
        work_order_id: ctx.workOrderId,
        phase: "stream",
        agent_name: ctx.agentName,
        detail: {
          event_type: "error",
          content: `Turn ${turn} API error: ${e.message}`,
        },
      });

      // If API error, wait briefly and retry (up to the turn limit)
      if (turn < Math.min(currentBudget, HARD_CEILING)) {
        await new Promise((r) => setTimeout(r, 2000));
        continue;
      }
    }
  }

  // Exceeded budget (velocity-gated)
  const summary = `Budget exhausted after ${turn} turns (budget: ${currentBudget}, ceiling: ${HARD_CEILING})`;
  await logFailed(ctx, summary);
  return { status: "max_turns", turns: turn, summary, toolCalls };
}

async function logVelocityCheck(
  ctx: ToolContext,
  turn: number,
  window: VelocityWindow,
  result: VelocityResult,
  currentBudget: number
): Promise<void> {
  try {
    await ctx.supabase.from("work_order_execution_log").insert({
      work_order_id: ctx.workOrderId,
      phase: "velocity_check",
      agent_name: ctx.agentName,
      iteration: turn,
      detail: {
        event_type: "velocity_check",
        decision: result.decision,
        reason: result.reason,
        extension: result.extension,
        current_budget: currentBudget,
        window_start: window.startTurn,
        successful_calls: window.successfulCalls,
        failed_calls: window.failedCalls,
        unique_tools: Array.from(window.uniqueTools),
        mutations: window.mutations,
        read_ops: window.readOps,
      },
    });
  } catch {
    // Non-critical
  }
}

async function logTurn(
  ctx: ToolContext,
  turn: number,
  response: Anthropic.Message,
  turnsTrimmed = 0,
  messageCount = 0
): Promise<void> {
  try {
    const textContent = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text.slice(0, 500))
      .join(" | ");

    const toolNames = response.content
      .filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use")
      .map((b) => b.name);

    const usage = response.usage as any;
    await ctx.supabase.from("work_order_execution_log").insert({
      work_order_id: ctx.workOrderId,
      phase: "stream",
      agent_name: ctx.agentName,
      iteration: turn,
      detail: {
        event_type: "agent_turn",
        turn,
        stop_reason: response.stop_reason,
        tool_names: toolNames,
        thinking: textContent.slice(0, 500),
        input_tokens: usage?.input_tokens,
        output_tokens: usage?.output_tokens,
        cache_creation_input_tokens: usage?.cache_creation_input_tokens || 0,
        cache_read_input_tokens: usage?.cache_read_input_tokens || 0,
        turns_trimmed: turnsTrimmed,
        message_count: messageCount,
      },
    });
  } catch {
    // Non-critical — don't fail the loop
  }
}

async function logToolResult(
  ctx: ToolContext,
  turn: number,
  toolName: string,
  result: any
): Promise<void> {
  try {
    const contentStr = result.success
      ? JSON.stringify(result.data || "ok").slice(0, 1000)
      : result.error?.slice(0, 1000) || "Unknown error";

    await ctx.supabase.from("work_order_execution_log").insert({
      work_order_id: ctx.workOrderId,
      phase: "stream",
      agent_name: ctx.agentName,
      iteration: turn,
      detail: {
        event_type: "tool_result",
        tool_name: toolName,
        success: result.success,
        content: contentStr,
      },
    });
  } catch {
    // Non-critical
  }
}

async function logFailed(ctx: ToolContext, reason: string): Promise<void> {
  try {
    await ctx.supabase.from("work_order_execution_log").insert({
      work_order_id: ctx.workOrderId,
      phase: "failed",
      agent_name: ctx.agentName,
      detail: {
        event_type: "result",
        content: reason,
      },
    });

    // Transition WO to failed
    await ctx.supabase.rpc("run_sql_void", {
      sql_query: `SELECT set_config('app.wo_executor_bypass', 'true', true); UPDATE work_orders SET status = 'failed', summary = '${reason.replace(/'/g, "''")}' WHERE id = '${ctx.workOrderId}';`,
    });
  } catch {
    // Best effort
  }
}
