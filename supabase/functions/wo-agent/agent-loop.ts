// wo-agent/agent-loop.ts v11
// WO-0551: Dual-provider support -- Anthropic SDK for claude models, OpenRouter for all others (MiniMax, DeepSeek, etc.)
// WO-0474: Fix catch block bypassing stall detection  -- API error counter + emergency trim + non-retryable fail-fast
// WO-0477: Remove budget system, wall-clock only, non-productive recursion detection
// WO-0387: Accomplishments metadata in toolCalls + checkpoint detail for richer continuations
// WO-0378: Message corruption fix  -- repairMessages, dispatchTool try/catch, pair-safe trimming
// WO-0187: Continuation pattern  -- checkpoint before timeout, self-reinvoke via pg_net
// WO-0163: Progress-based velocity gate replaces hard turn limits
// WO-0167: Message history summarization replaces blind truncation
// WO-0166: Role-based tool filtering per agent identity
// Core agentic tool-use loop for work order execution
// Dual-provider: Anthropic SDK for claude-* models, OpenRouter (OpenAI-compatible) for everything else

import Anthropic from "npm:@anthropic-ai/sdk@0.39.0";
import { TOOL_DEFINITIONS, dispatchTool, getToolsForWO, getToolsForWOSync, type ToolContext } from "./tools.ts";
import { anthropicToolsToOpenAI, anthropicMessagesToOpenAI, openAIResponseToAnthropic } from "./format-converters.ts";

const TIMEOUT_MS = 380_000; // 380s  -- 20s buffer before 400s Supabase Pro wall clock limit (waitUntil mode)
const CHECKPOINT_MS = 350_000; // 350s  -- checkpoint before timeout to enable continuation
const MAX_CONTINUATIONS = 3; // Circuit breaker: max 3 continuations per WO execution
const STALL_WINDOW = 5; // Consecutive turns with zero mutations AND zero successful reads = fail
const DEFAULT_MODEL = "claude-opus-4-6"; // Fallback only  -- prefer agent_execution_profiles.model

// Tools that modify state vs read-only
const MUTATION_TOOLS = new Set([
  'execute_sql', 'apply_migration', 'github_write_file', 'github_edit_file',
  'deploy_edge_function', 'resolve_qa_findings', 'update_qa_checklist',
  'delegate_subtask',
]);

// WO-0528: Error recovery guidance map keyed by error_class
const ERROR_RECOVERY_GUIDANCE: Record<string, string> = {
  sql_syntax: 'Previous SQL had syntax errors. Read the target object definition before writing new SQL.',
  enforcement_blocked: 'You cannot use set_config bypass. Use transition_state tool for WO state changes.',
  schema_mismatch: 'A referenced object does not exist. Query information_schema to verify object names before retrying.',
  match_failed: 'The old_string was not found in the file. Use github_read_file to see current file contents before editing.',
  github_match_failure: 'The old_string was not found in the file. Use github_read_file to see current file contents before editing.',
  unknown: 'Previous approach failed. Try a fundamentally different strategy.',
};

// WO-0551: Provider detection -- route claude models to Anthropic SDK, everything else to OpenRouter
function isAnthropicModel(model: string): boolean {
  return model.startsWith('claude-') || model.startsWith('anthropic/');
}

// WO-0551: Call OpenRouter with OpenAI-compatible format, return Anthropic-format response
async function callOpenRouter(
  model: string,
  systemPrompt: string,
  messages: Array<{ role: string; content: any }>,
  tools: any[],
  ctx: ToolContext,
): Promise<any> {
  const openrouterKey = Deno.env.get("OPENROUTER_API_KEY");
  if (!openrouterKey) throw new Error("OPENROUTER_API_KEY not set");

  // Convert to OpenAI format
  const openAIMessages = anthropicMessagesToOpenAI(messages, systemPrompt);
  const openAITools = anthropicToolsToOpenAI(tools);

  const requestBody: any = {
    model,
    messages: openAIMessages,
    max_tokens: 4096,
  };
  if (openAITools.length > 0) requestBody.tools = openAITools;

  const resp = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${openrouterKey}`,
      "HTTP-Referer": "https://metis-portal2.vercel.app",
      "X-Title": "ENDGAME-001 wo-agent",
    },
    body: JSON.stringify(requestBody),
  });

  if (!resp.ok) {
    const errBody = await resp.text();
    throw new Error(`OpenRouter ${resp.status}: ${errBody.slice(0, 500)}`);
  }

  const openAIResponse = await resp.json();

  // Log usage to llm_usage if possible
  try {
    await ctx.supabase.from("llm_usage").insert({
      model_id: model,
      input_tokens: openAIResponse.usage?.prompt_tokens || 0,
      output_tokens: openAIResponse.usage?.completion_tokens || 0,
      work_order_id: ctx.workOrderId,
      openrouter_id: openAIResponse.id || null,
      success: true,
    });
  } catch { /* non-critical */ }

  // Convert back to Anthropic format for rest of agent loop
  return openAIResponseToAnthropic(openAIResponse);
}

// v9: Budget/velocity system removed. Wall-clock timeout + stall detection only.

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

/**
 * WO-0378: Repair corrupted message history where tool_use blocks lack matching tool_result.
 * This happens when dispatchTool throws an unhandled exception after assistant message is pushed
 * but before tool_results are pushed. Also handles trimming that splits pairs.
 * Returns the number of repairs made.
 */
function repairMessages(messages: Array<{ role: string; content: any }>): number {
  let repairs = 0;

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role !== 'assistant' || !Array.isArray(msg.content)) continue;

    const toolUseBlocks = (msg.content as any[]).filter((b: any) => b.type === 'tool_use');
    if (toolUseBlocks.length === 0) continue;

    // Check if next message has matching tool_results
    const nextMsg = messages[i + 1];
    if (!nextMsg || nextMsg.role !== 'user' || !Array.isArray(nextMsg.content)) {
      // No matching user message with tool_results  -- inject one
      const dummyResults = toolUseBlocks.map((tb: any) => ({
        type: 'tool_result' as const,
        tool_use_id: tb.id,
        content: 'Error: Tool execution was interrupted (message repair)',
        is_error: true,
      }));
      messages.splice(i + 1, 0, { role: 'user', content: dummyResults });
      repairs += toolUseBlocks.length;
      continue;
    }

    // Check for missing tool_results in the next message
    const existingResultIds = new Set(
      (nextMsg.content as any[])
        .filter((b: any) => b.type === 'tool_result')
        .map((b: any) => b.tool_use_id)
    );

    const missingResults = toolUseBlocks.filter((tb: any) => !existingResultIds.has(tb.id));
    if (missingResults.length > 0) {
      // Add missing tool_results to existing user message
      for (const tb of missingResults) {
        (nextMsg.content as any[]).push({
          type: 'tool_result',
          tool_use_id: tb.id,
          content: 'Error: Tool execution was interrupted (message repair)',
          is_error: true,
        });
        repairs++;
      }
    }
  }

  return repairs;
}

export interface AgentLoopResult {
  status: "completed" | "failed" | "timeout" | "max_turns" | "checkpoint";
  turns: number;
  summary: string;
  toolCalls: Array<{ turn: number; tool: string; success: boolean; migrationName?: string; filePath?: string; progressNote?: string }>;
}

export async function runAgentLoop(
  systemPrompt: string,
  userMessage: string,
  ctx: ToolContext,
  tags?: string[],
  model?: string
): Promise<AgentLoopResult> {
  const isRemediation = (tags || []).some((t: string) =>
    t === 'remediation' || t === 'auto-qa-loop' || t.startsWith('parent:')
  );

  // Stall detection: track consecutive non-productive turns
  let consecutiveStallTurns = 0;
  // API error tracking: catch block must also bail on repeated failures
  let consecutiveApiErrors = 0;
  // WO-0528: Track last error for consecutive failure detection
  let lastErrorClass: string | null = null;
  let lastErrorObject: string | null = null;

  const startTime = Date.now();
  const toolCalls: AgentLoopResult["toolCalls"] = [];
  // WO-0401: Config-driven model  -- profile > WO override > default
  const resolvedModel = model || DEFAULT_MODEL;
  const useAnthropic = isAnthropicModel(resolvedModel);

  // WO-0551: Validate required API key based on provider
  if (useAnthropic) {
    const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
    if (!apiKey) {
      return { status: "failed", turns: 0, summary: "ANTHROPIC_API_KEY not set", toolCalls: [] };
    }
  } else {
    const openrouterKey = Deno.env.get("OPENROUTER_API_KEY");
    if (!openrouterKey) {
      return { status: "failed", turns: 0, summary: "OPENROUTER_API_KEY not set", toolCalls: [] };
    }
  }

  // Only create Anthropic client if using Anthropic models
  const client = useAnthropic ? new Anthropic({ apiKey: Deno.env.get("ANTHROPIC_API_KEY")! }) : null;

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
      model: resolvedModel,
      timeout_ms: TIMEOUT_MS,
      checkpoint_ms: CHECKPOINT_MS,
      stall_window: STALL_WINDOW,
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
  const MAX_HISTORY_PAIRS = isRemediation ? 15 : 20;

  while (true) {
    // Check checkpoint / timeout  -- checkpoint FIRST so long turns don't skip it
    const elapsed = Date.now() - startTime;

    // WO-0187: Checkpoint at 100s+ OR timeout at 125s+  -- both save progress for continuation
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

      // WO-0387: Build accomplishments for continuation context
      const accomplishments = toolCalls
        .filter(tc => tc.success && (tc.migrationName || tc.filePath || tc.progressNote))
        .map(tc => {
          if (tc.migrationName) return `Applied migration: ${tc.migrationName}`;
          if (tc.filePath) return `Wrote: ${tc.filePath}`;
          if (tc.progressNote) return tc.progressNote;
          return `${tc.tool} (ok)`;
        });

      // WO-0486: Query mutation digest for checkpoint context
      let mutationDigest: any = null;
      let failedApproaches: any[] = [];
      try {
        // Get mutation summary
        const { data: mutSummary } = await ctx.supabase
          .from("wo_mutation_summary")
          .select("*")
          .eq("work_order_id", ctx.workOrderId)
          .maybeSingle();
        
        if (mutSummary) {
          mutationDigest = {
            total: mutSummary.total_mutations || 0,
            successful: mutSummary.successful_count || 0,
            failed: mutSummary.failed_count || 0,
            by_error_class: mutSummary.error_class_breakdown || {},
          };
        }

        // Get failed approaches grouped by tool+object+error_class
        const { data: failedMuts } = await ctx.supabase
          .from("wo_mutations")
          .select("tool_name, object_type, object_id, action, error_class, error_detail")
          .eq("work_order_id", ctx.workOrderId)
          .eq("success", false)
          .order("created_at", { ascending: false })
          .limit(20);
        
        if (failedMuts && failedMuts.length > 0) {
          // Group by tool_name + object_id + error_class to deduplicate
          const grouped = new Map<string, any>();
          for (const m of failedMuts) {
            const key = `${m.tool_name}:${m.object_id || m.object_type}:${m.error_class}`;
            if (!grouped.has(key)) {
              grouped.set(key, {
                tool: m.tool_name,
                target: m.object_id || m.object_type,
                action: m.action,
                error_class: m.error_class,
                error_detail: m.error_detail?.slice(0, 200),
              });
            }
          }
          failedApproaches = Array.from(grouped.values());
        }
      } catch (mutErr: any) {
        console.error(`[WO-AGENT] Failed to query mutation digest:`, mutErr.message);
      }

      await ctx.supabase.from("work_order_execution_log").insert({
        work_order_id: ctx.workOrderId,
        phase: "checkpoint",
        agent_name: ctx.agentName,
        detail: {
          event_type: "checkpoint",
          turns_completed: turn,
          last_actions: lastActions,
          elapsed_ms: elapsed,
          delegated_children: childWOs.length > 0 ? childWOs : undefined,
          accomplishments: accomplishments.length > 0 ? accomplishments : undefined,
          mutation_digest: mutationDigest,
          failed_approaches: failedApproaches.length > 0 ? failedApproaches : undefined,
        },
      });

      return { status: "checkpoint", turns: turn, summary, toolCalls };
    }

    turn++;

    // WO-0167: Summarize + trim message history to prevent context window exhaustion
    // Keep: first user message (index 0) + summary (index 1) + last MAX_HISTORY_PAIRS*2 messages
    const maxMessages = 1 + MAX_HISTORY_PAIRS * 2; // first msg + pairs
    if (messages.length > maxMessages) {
      let trimCount = messages.length - maxMessages;

      // WO-0378: Ensure trimCount doesn't split a tool_use/tool_result pair.
      // If the message at (1 + trimCount) is a user message with tool_results,
      // its preceding assistant message has tool_use blocks  -- keep the pair together.
      const cutIdx = 1 + trimCount;
      if (cutIdx < messages.length) {
        const msgAtCut = messages[cutIdx];
        if (msgAtCut.role === 'user' && Array.isArray(msgAtCut.content) &&
            (msgAtCut.content as any[]).some((b: any) => b.type === 'tool_result')) {
          // This is a tool_result message  -- its assistant pair is at cutIdx-1
          // Include it in the trim to keep pairs intact
          trimCount += 1;
        }
      }

      // Summarize before discarding  -- extract tool calls, mutations, errors
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

    // WO-0378: Repair any corrupted tool_use/tool_result pairs before API call
    const repairs = repairMessages(messages);
    if (repairs > 0) {
      console.log(`[WO-AGENT] Repaired ${repairs} corrupted tool_use/tool_result pairs for ${ctx.workOrderSlug}`);
    }

    console.log(`[WO-AGENT] Turn ${turn} for ${ctx.workOrderSlug} (msgs: ${messages.length}, elapsed: ${Math.round((Date.now() - startTime) / 1000)}s/${Math.round(TIMEOUT_MS / 1000)}s)`);

    try {
      // WO-0551: Dual-provider API call
      let response: any;
      if (useAnthropic && client) {
        response = await client.messages.create({
          model: resolvedModel,
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
      } else {
        // OpenRouter path -- converts to OpenAI format, calls API, converts response back
        response = await callOpenRouter(resolvedModel, systemPrompt, messages, tools, ctx);
      }

      // Successful API call  -- reset error counter
      consecutiveApiErrors = 0;

      // Log the turn
      await logTurn(ctx, turn, response, turnsTrimmed, messages.length);

      // Check stop reason
      if (response.stop_reason === "end_turn") {
        // Model wants to stop without calling a tool
        // Extract text content
        const textContent = (response.content || [])
          .filter((b: any) => b.type === "text")
          .map((b: any) => b.text)
          .join("\n");

        // WO-0508 Fix #2: Check if work appears complete based on tool call history
        const hasMutations = toolCalls.some(tc => tc.success && MUTATION_TOOLS.has(tc.tool));
        const hasRecentProgress = toolCalls.slice(-5).some(tc => tc.tool === 'log_progress' && tc.success);
        const appearsComplete = hasMutations && (hasRecentProgress || turn > 5);

        // No terminal tool was called  -- nudge the model
        messages.push({ role: "assistant", content: response.content });
        // WO-0508 Fix #2: Conditional nudge based on appearsComplete
        const nudgeMessage = appearsComplete
          ? "You stopped without calling mark_complete or mark_failed. Based on your tool calls (mutations made, progress logged), it appears the work is done. You MUST call mark_complete with a detailed summary to transition this WO to review. If you cannot proceed, call mark_failed with a reason."
          : "You stopped without calling mark_complete or mark_failed. You MUST call one of these tools to finish. If the work is done, call mark_complete with a summary. If you cannot proceed, call mark_failed with a reason.";
        
        messages.push({
          role: "user",
          content: nudgeMessage,
        });
        continue;
      }

      if (response.stop_reason === "tool_use") {
        // Process tool calls
        const toolBlocks = (response.content || []).filter(
          (b: any) => b.type === "tool_use"
        );

        // Add assistant message to conversation
        messages.push({ role: "assistant", content: response.content });

        // Execute each tool and collect results
        const toolResults: any[] = [];
        let terminalReached = false;

        for (const toolBlock of toolBlocks) {
          // WO-0378: Wrap dispatchTool so exceptions never corrupt message history
          let result;
          try {
            result = await dispatchTool(
              toolBlock.name,
              toolBlock.input as Record<string, any>,
              ctx
            );
          } catch (dispatchErr: any) {
            console.error(`[WO-AGENT] dispatchTool exception for ${toolBlock.name}:`, dispatchErr.message);
            result = { success: false, error: `Tool dispatch exception: ${dispatchErr.message}`, terminal: false, data: null };
          }

          toolCalls.push({
            turn,
            tool: toolBlock.name,
            success: result.success,
            // WO-0387: Capture metadata for checkpoint accomplishments
            migrationName: toolBlock.name === 'apply_migration' && result.success ? (toolBlock.input as any)?.name : undefined,
            filePath: (toolBlock.name === 'github_write_file' || toolBlock.name === 'github_edit_file') && result.success ? (toolBlock.input as any)?.path : undefined,
            progressNote: toolBlock.name === 'log_progress' && result.success ? String((toolBlock.input as any)?.content || '').slice(0, 100) : undefined,
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

        // WO-0528: Inject error recovery guidance after tool failures
        let errorGuidance: string | null = null;
        for (const toolBlock of toolBlocks) {
          const toolResult = toolResults.find(r => r.tool_use_id === toolBlock.id);
          if (toolResult && toolResult.is_error) {
            // Query the most recent mutation record for this tool call to get error_class
            try {
              const { data: mutationData } = await ctx.supabase
                .from("wo_mutations")
                .select("error_class, object_type, object_id")
                .eq("work_order_id", ctx.workOrderId)
                .eq("tool_name", toolBlock.name)
                .eq("success", false)
                .order("created_at", { ascending: false })
                .limit(1)
                .maybeSingle();

              if (mutationData) {
                const errorClass = mutationData.error_class || "unknown";
                const objectId = mutationData.object_id || mutationData.object_type;
                
                // Check if this is a consecutive failure on the same object
                const isConsecutive = lastErrorClass === errorClass && lastErrorObject === objectId;
                
                if (isConsecutive) {
                  // Escalate guidance for consecutive failures
                  errorGuidance = `## Recovery Guidance\nSTOP: You have failed twice with the same error (${errorClass}) on the same object (${objectId}). You MUST try a completely different approach.`;
                } else if (ERROR_RECOVERY_GUIDANCE[errorClass]) {
                  // First failure or different error/object
                  errorGuidance = `## Recovery Guidance\nYour last tool call failed with error class: ${errorClass}. ${ERROR_RECOVERY_GUIDANCE[errorClass]}`;
                }
                
                // Update tracking for next turn
                lastErrorClass = errorClass;
                lastErrorObject = objectId;
                break; // Only inject guidance for first error in turn
              }
            } catch (err: any) {
              console.warn(`[WO-AGENT] Failed to query mutation for error guidance: ${err.message}`);
            }
          }
        }

        // Add tool results to conversation (with optional error guidance)
        if (errorGuidance) {
          messages.push({ role: "user", content: [...toolResults, { type: "text" as const, text: errorGuidance }] });
        } else {
          messages.push({ role: "user", content: toolResults });
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

        // Stall detection: check if this turn was productive
        const turnToolCalls = toolBlocks.map((_, idx) =>
          toolCalls[toolCalls.length - toolBlocks.length + idx]
        ).filter(Boolean);
        const hadMutation = turnToolCalls.some(tc => tc.success && MUTATION_TOOLS.has(tc.tool));
        const hadSuccessfulRead = turnToolCalls.some(tc => tc.success && !MUTATION_TOOLS.has(tc.tool));
        const allFailed = turnToolCalls.every(tc => !tc.success);

        if (!hadMutation && !hadSuccessfulRead) {
          consecutiveStallTurns++;
          console.log(`[WO-AGENT] ${ctx.workOrderSlug} stall ${consecutiveStallTurns}/${STALL_WINDOW} (all failed: ${allFailed})`);
        } else {
          consecutiveStallTurns = 0;
        }

        if (consecutiveStallTurns >= STALL_WINDOW) {
          const stallSummary = `Non-productive recursion: ${consecutiveStallTurns} consecutive turns with no successful operations. Last tools: ${turnToolCalls.map(tc => `${tc.tool}(${tc.success ? 'ok' : 'err'})`).join(', ')}`;
          console.log(`[WO-AGENT] ${ctx.workOrderSlug} STALL KILL: ${stallSummary}`);
          await logFailed(ctx, stallSummary);
          return { status: "failed", turns: turn, summary: stallSummary, toolCalls };
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

      // Non-retryable: prompt too long  -- trim aggressively or fail immediately
      if (e.message?.includes('prompt is too long') || e.status === 400) {
        // Try emergency trim: keep only first message + last 4 pairs
        const emergencyMax = 1 + 4 * 2;
        if (messages.length > emergencyMax) {
          const trimCount = messages.length - emergencyMax;
          const historySummary = summarizeTrimmedMessages(messages, 1, trimCount);
          messages.splice(1, trimCount);
          const hasSummary = messages.length > 1 &&
            messages[1].role === 'user' &&
            typeof messages[1].content === 'string' &&
            (messages[1].content as string).startsWith('## Execution History');
          if (hasSummary) {
            messages[1] = { role: 'user', content: historySummary };
          } else {
            messages.splice(1, 0, { role: 'user', content: historySummary });
          }
          console.log(`[WO-AGENT] ${ctx.workOrderSlug} emergency trim: ${trimCount} messages removed, ${messages.length} remaining`);
          consecutiveApiErrors++;
        } else {
          // Already minimal  -- context is fundamentally too large, fail immediately
          const reason = `Fatal: prompt too large (${e.message}). Cannot trim further  -- system prompt + initial context exceeds model limit.`;
          console.log(`[WO-AGENT] ${ctx.workOrderSlug} FATAL: ${reason}`);
          await logFailed(ctx, reason);
          return { status: "failed", turns: turn, summary: reason, toolCalls };
        }

        if (consecutiveApiErrors >= 3) {
          const reason = `Fatal: ${consecutiveApiErrors} consecutive API errors after emergency trim. Last: ${e.message}`;
          await logFailed(ctx, reason);
          return { status: "failed", turns: turn, summary: reason, toolCalls };
        }
        continue;
      }

      // Retryable errors (rate limit, 500, network): count and bail after 5
      consecutiveApiErrors++;
      if (consecutiveApiErrors >= 5) {
        const reason = `Fatal: ${consecutiveApiErrors} consecutive API errors. Last: ${e.message}`;
        await logFailed(ctx, reason);
        return { status: "failed", turns: turn, summary: reason, toolCalls };
      }
      await new Promise((r) => setTimeout(r, 2000));
      continue;
    }
  }

  // Should not reach here  -- loop exits via checkpoint, terminal tool, or stall detection
  const summary = `Loop exited unexpectedly after ${turn} turns`;
  await logFailed(ctx, summary);
  return { status: "failed", turns: turn, summary, toolCalls };
}

async function logTurn(
  ctx: ToolContext,
  turn: number,
  response: any, // WO-0551: Accept both Anthropic.Message and converted OpenRouter response
  turnsTrimmed = 0,
  messageCount = 0
): Promise<void> {
  try {
    const textContent = (response.content || [])
      .filter((b: any) => b.type === "text")
      .map((b: any) => (b.text || "").slice(0, 500))
      .join(" | ");

    const toolNames = (response.content || [])
      .filter((b: any) => b.type === "tool_use")
      .map((b: any) => b.name);

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
    // Non-critical  -- don't fail the loop
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
