// wo-agent/handlers/execute.ts
// WO-0743: Extracted from index.ts — main execution handler
import { createClient } from "jsr:@supabase/supabase-js@2";
import { buildAgentContext } from "../context.ts";
import { runAgentLoop } from "../agent-loop.ts";
import type { ToolContext } from "../tools.ts";
import { attemptEscalation } from "./escalation.ts";

type JsonResponse = (data: any, status?: number) => Response;

/**
 * POST /execute
 * Execute a work order using the agentic loop
 * Body: { work_order_id: string }
 */
export async function handleExecute(req: Request, jsonResponse: JsonResponse): Promise<Response> {
  const body = await req.json();
  const { work_order_id } = body;

  if (!work_order_id) {
    return jsonResponse({ error: "Missing work_order_id" }, 400);
  }

  const sbUrl = Deno.env.get("SUPABASE_URL")!;
  const sbKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const supabase = createClient(sbUrl, sbKey);

  const { data: wo, error: woError } = await supabase
    .from("work_orders")
    .select(
      "id, slug, name, objective, acceptance_criteria, tags, priority, status, summary, qa_checklist, client_info, project_brief_id, depends_on, assigned_to, pipeline_phase, pipeline_run_id, parent_id"
    )
    .eq("id", work_order_id)
    .single();

  if (woError || !wo) {
    return jsonResponse(
      { error: `Work order not found: ${woError?.message || work_order_id}` },
      404
    );
  }

  if (wo.status !== "in_progress") {
    return jsonResponse(
      { error: `Work order ${wo.slug} is not in_progress (current: ${wo.status})` },
      400
    );
  }

  // WO-0155 + WO-0363: MOOT DETECTION ON START - Guard against orphaned remediation WOs
  const tags: string[] = wo.tags || [];
  if (tags.includes("remediation")) {
    const parentTag = tags.find((t: string) => t.startsWith("parent:"));
    if (parentTag) {
      const parentSlug = parentTag.replace("parent:", "");
      const { data: parentWo } = await supabase
        .from("work_orders")
        .select("id, slug, status")
        .eq("slug", parentSlug)
        .single();

      // WO-0363: Check for both 'done' and 'cancelled' parent status
      if (parentWo && (parentWo.status === "done" || parentWo.status === "cancelled")) {
        const msg = `Parent ${parentSlug} already resolved (${parentWo.status}) -- remediation unnecessary`;
        console.log(`[WO-AGENT] ${wo.slug}: ${msg}`);

        await supabase.from("work_order_execution_log").insert({
          work_order_id: wo.id,
          phase: "execution_complete",
          agent_name: "wo-agent",
          detail: { event_type: "result", content: msg },
        });
        await supabase.rpc("run_sql_void", {
          sql_query: `SELECT set_config('app.wo_executor_bypass', 'true', true); UPDATE work_orders SET status = 'done', completed_at = NOW(), summary = 'Parent already resolved' WHERE id = '${wo.id}';`,
        });

        return jsonResponse({
          work_order_id: wo.id, slug: wo.slug, status: "completed",
          turns: 0, summary: "Parent already resolved", tool_calls: 0,
        });
      }
    }
  }

  // Load GitHub token
  let githubToken: string | null = null;
  try {
    const { data } = await supabase
      .from("secrets").select("value").eq("key", "GITHUB_TOKEN").single();
    githubToken = data?.value || null;
  } catch { /* GitHub tools will fail gracefully */ }

  // Build agent context
  const agentContext = await buildAgentContext(supabase, wo);

  const toolCtx: ToolContext = {
    supabase,
    workOrderId: wo.id,
    workOrderSlug: wo.slug,
    githubToken,
    agentName: agentContext.agentName,
  };

  // WO-0187: Check for continuation
  let finalUserMessage = agentContext.userMessage;
  const { data: checkpoint } = await supabase
    .from("work_order_execution_log")
    .select("detail, created_at")
    .eq("work_order_id", work_order_id)
    .eq("phase", "checkpoint")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (checkpoint?.detail) {
    const { count: checkpointCount } = await supabase
      .from("work_order_execution_log")
      .select("id", { count: "exact", head: true })
      .eq("work_order_id", work_order_id)
      .eq("phase", "checkpoint");

    // AC4: Hard safety cap - if checkpointCount >= 8, unconditionally fail
    if ((checkpointCount || 0) >= 8) {
      const msg = `Hard circuit breaker cap: 8 checkpoints reached. Marking failed.`;
      await supabase.from("work_order_execution_log").insert({
        work_order_id: wo.id, phase: "loop_breaker", agent_name: agentContext.agentName,
        detail: {
          event_type: "circuit_breaker_decision",
          decision: "hard_cap",
          reason: msg,
          mutation_count_current: 0,
          mutation_count_previous: 0,
          delta: 0,
          checkpoint_count: checkpointCount,
        },
      });
      await supabase.from("work_order_execution_log").insert({
        work_order_id: wo.id, phase: "failed", agent_name: agentContext.agentName,
        detail: { event_type: "circuit_breaker", content: msg, decision: "hard_cap" },
      });
      // P6: Try escalation before failing
      const escalated = await attemptEscalation(supabase, wo, agentContext.agentName, agentContext.model, msg);
      if (escalated) {
        return jsonResponse({ work_order_id: wo.id, slug: wo.slug, status: "escalated", turns: 0, summary: `Escalated: ${msg}`, tool_calls: 0 });
      }
      await supabase.rpc("wo_transition", {
        p_wo_id: wo.id, p_event: "mark_failed",
        p_payload: { failure_reason: msg, source: "circuit_breaker_hard_cap" },
        p_actor: agentContext.agentName, p_depth: 0,
      });
      return jsonResponse({ work_order_id: wo.id, slug: wo.slug, status: "failed", turns: 0, summary: msg, tool_calls: 0 });
    }

    if ((checkpointCount || 0) >= 3) {
      // WO-0499: Progress-based circuit breaker  --  mutation-delta decides continue vs stuck
      const previousMutations = checkpoint?.detail?.mutation_digest?.total || null;
      const { data: cbResult, error: cbErr } = await supabase.rpc("evaluate_circuit_breaker_progress", {
        p_wo_id: wo.id,
        p_checkpoint_count: checkpointCount,
        p_previous_mutation_count: previousMutations,
      });

      if (cbErr) {
        console.error(`[WO-AGENT] evaluate_circuit_breaker_progress error:`, cbErr.message);
      }

      const decision = cbResult?.decision || "stuck";
      const reason = cbResult?.reason || `Circuit breaker (${checkpointCount} checkpoints)`;
      const mutationCount = cbResult?.mutation_count_current || 0;

      // AC5: Log circuit breaker decision to loop_breaker phase
      await supabase.from("work_order_execution_log").insert({
        work_order_id: wo.id, phase: "loop_breaker", agent_name: agentContext.agentName,
        detail: {
          event_type: "circuit_breaker_decision", decision, reason,
          mutation_count_current: cbResult?.mutation_count_current,
          mutation_count_previous: cbResult?.mutation_count_previous,
          delta: cbResult?.mutation_delta,
          checkpoint_count: checkpointCount,
        },
      });

      if (decision === "continue") {
        // AC3: New mutations detected  --  allow continuation regardless of checkpoint count
        // Fall through to continuation logic below
      } else {
        // stuck or hard_cap  --  try escalation first, then fail + remediation
        const msg = `${reason}. Marking failed.`;
        // P6: Try escalation before failing
        const escalated = await attemptEscalation(supabase, wo, agentContext.agentName, agentContext.model, msg);
        if (escalated) {
          return jsonResponse({ work_order_id: wo.id, slug: wo.slug, status: "escalated", turns: 0, summary: `Escalated: ${msg}`, tool_calls: 0 });
        }
        await supabase.from("work_order_execution_log").insert({
          work_order_id: wo.id, phase: "failed", agent_name: agentContext.agentName,
          detail: { event_type: "circuit_breaker", content: msg, decision, mutation_count: mutationCount },
        });
        await supabase.rpc("wo_transition", {
          p_wo_id: wo.id, p_event: "mark_failed",
          p_payload: { failure_reason: msg, source: "circuit_breaker_progress", decision, mutation_count: mutationCount },
          p_actor: agentContext.agentName, p_depth: 0,
        });
        return jsonResponse({ work_order_id: wo.id, slug: wo.slug, status: "failed", turns: 0, summary: msg, tool_calls: 0 });
      }
    }


    // Build continuation context
    const cp = checkpoint.detail;
    let childStatusContext = "";
    if (cp.delegated_children && cp.delegated_children.length > 0) {
      const childSlugs = cp.delegated_children.map((c: any) => c.child_slug);
      const { data: childWOs } = await supabase
        .from("work_orders").select("slug, status, summary").in("slug", childSlugs);
      if (childWOs && childWOs.length > 0) {
        childStatusContext = `\n## Delegated Children Status\n`;
        for (const child of childWOs) {
          childStatusContext += `- **${child.slug}** (${child.status}): ${(child.summary || "no summary yet").slice(0, 300)}\n`;
        }
        childStatusContext += `\n`;
      }
    }
    finalUserMessage = `# CONTINUATION -- Work Order: ${wo.slug}\n\n`;
    finalUserMessage += `**You are CONTINUING a previous execution that checkpointed.**\n`;
    finalUserMessage += `Continuation #${(checkpointCount || 0) + 1} of max 3.\n\n`;

    // WO-0387: Include accomplishments so agent doesn't waste turns rediscovering progress
    const accomplishments: string[] = cp.accomplishments || [];
    if (accomplishments.length > 0) {
      finalUserMessage += `## What Was Already Done\n`;
      for (const acc of accomplishments) {
        finalUserMessage += `- ${acc}\n`;
      }
      finalUserMessage += `\n**Do NOT call read_execution_log to check progress. The above is your accomplishment list. Continue from where you left off.**\n\n`;
    } else {
      finalUserMessage += `Previous progress: ${cp.turns_completed} turns, ${cp.mutations || 0} mutations.\n`;
      finalUserMessage += `Last actions: ${cp.last_actions || 'unknown'}\n\n`;
    }

    // WO-0486: Inject mutation digest for data-driven continuation context
    const mutationDigest = cp.mutation_digest;
    if (mutationDigest && mutationDigest.total > 0) {
      finalUserMessage += `## What Was Already Done (Mutation Summary)\n`;
      finalUserMessage += `- **Total mutations**: ${mutationDigest.total}\n`;
      finalUserMessage += `- **Successful**: ${mutationDigest.successful}\n`;
      finalUserMessage += `- **Failed**: ${mutationDigest.failed}\n`;
      if (mutationDigest.by_error_class && Object.keys(mutationDigest.by_error_class).length > 0) {
        finalUserMessage += `- **Failures by error class**: ${JSON.stringify(mutationDigest.by_error_class)}\n`;
      }
      finalUserMessage += `\n`;
    }

    // WO-0486: Inject failed approaches to prevent retry loops
    const failedApproaches: any[] = cp.failed_approaches || [];
    if (failedApproaches.length > 0) {
      finalUserMessage += `## Failed Approaches (DO NOT RETRY)\n`;
      finalUserMessage += `The following operations already failed in previous execution. Do NOT retry them:\n\n`;
      for (const fa of failedApproaches) {
        finalUserMessage += `- **${fa.tool}** on \`${fa.target}\` (action: ${fa.action})\n`;
        finalUserMessage += `  - Error class: ${fa.error_class}\n`;
        if (fa.error_detail) {
          finalUserMessage += `  - Error: ${fa.error_detail}\n`;
        }
        finalUserMessage += `\n`;
      }
      finalUserMessage += `**IMPORTANT**: These approaches already failed. Try a different strategy or escalate if you cannot proceed.\n\n`;
    }

    // P2: Schema refresh on continuation — re-extract schema for objects agent created/modified
    try {
      const { data: refreshedSchema } = await supabase.rpc("get_dynamic_schema_context", {
        p_work_order_id: wo.id,
      });
      if (refreshedSchema) {
        finalUserMessage += `## Updated Schema Context\n`;
        finalUserMessage += refreshedSchema.slice(0, 8000) + `\n\n`;
      }
    } catch {
      // Schema refresh failed, continue without
    }

    finalUserMessage += `## Original Objective\n${wo.objective}\n\n`;
    if (wo.acceptance_criteria) {
      finalUserMessage += `## Acceptance Criteria\n${wo.acceptance_criteria}\n\n`;
    }
    if (childStatusContext) {
      finalUserMessage += childStatusContext;
    }
    finalUserMessage += `**IMPORTANT**: Do NOT redo work already done. Continue from where you left off. Call mark_complete when done.\n`;

    await supabase.from("work_order_execution_log").insert({
      work_order_id: wo.id, phase: "continuation", agent_name: agentContext.agentName,
      detail: { event_type: "continuation_start", checkpoint_count: (checkpointCount || 0) + 1, previous_turns: cp.turns_completed },
    });
  }

  // WO-0740 Fix B: Inject escalation context when agent was escalated to a higher model
  const clientInfo = wo.client_info || {};
  if (clientInfo.escalation_tier && !checkpoint?.detail) {
    // This is a fresh execution after escalation — agent needs to know what happened
    const { data: escalationLogs } = await supabase
      .from("work_order_execution_log")
      .select("detail, created_at")
      .eq("work_order_id", wo.id)
      .eq("phase", "escalation")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    // Query mutation history from previous execution
    const { data: mutSummary } = await supabase
      .from("wo_mutation_summary")
      .select("*")
      .eq("work_order_id", wo.id)
      .maybeSingle();

    // Query failed mutations for DO NOT RETRY context
    const { data: failedMuts } = await supabase
      .from("wo_mutations")
      .select("tool_name, action_keyword, target_object, error_class, error_detail")
      .eq("work_order_id", wo.id)
      .eq("success", false)
      .order("created_at", { ascending: false })
      .limit(20);

    let escalationContext = `\n\n## ESCALATION CONTEXT\n`;
    escalationContext += `**You are an escalated agent.** A previous agent (lower-tier model) attempted this work order and failed.\n`;
    escalationContext += `You have been escalated to tier ${clientInfo.escalation_tier} (model: ${clientInfo.escalation_model || "unknown"}).\n\n`;

    if (escalationLogs?.detail) {
      const esc = escalationLogs.detail;
      escalationContext += `### Why You Were Escalated\n`;
      escalationContext += `- **Previous model**: ${esc.previous_model || "unknown"}\n`;
      escalationContext += `- **Escalation reason**: ${esc.reason || "unknown"}\n`;
      escalationContext += `- **Escalated at**: ${escalationLogs.created_at}\n\n`;
    }

    if (mutSummary) {
      escalationContext += `### Previous Agent's Mutation History\n`;
      escalationContext += `- Total mutations: ${mutSummary.total_mutations || 0} (${mutSummary.successful_mutations || 0} successful, ${mutSummary.failed_mutations || 0} failed)\n`;
      if (mutSummary.tools_used) {
        escalationContext += `- Tools used: ${mutSummary.tools_used}\n`;
      }
      escalationContext += `\n`;
    }

    if (failedMuts && failedMuts.length > 0) {
      escalationContext += `### Failed Approaches (DO NOT RETRY)\n`;
      escalationContext += `The previous agent tried these and they failed. Use a different strategy:\n\n`;
      for (const fm of failedMuts) {
        escalationContext += `- **${fm.tool_name}** on \`${fm.target_object || "unknown"}\` (${fm.action_keyword || "unknown"})\n`;
        escalationContext += `  - Error class: ${fm.error_class || "unknown"}\n`;
        if (fm.error_detail) {
          escalationContext += `  - Error: ${String(fm.error_detail).slice(0, 200)}\n`;
        }
      }
      escalationContext += `\n**CRITICAL**: Do NOT repeat the same failed approaches. The previous agent already tried them.\n`;
      escalationContext += `If the file is too large to read via github_read_file, use github_read_file_range to read specific line ranges.\n\n`;
    }

    finalUserMessage += escalationContext;
  }

  // WO-0513: Run agentic loop as background task via EdgeRuntime.waitUntil()
  // This returns the HTTP response immediately, avoiding the 150s request idle timeout.
  // The background task uses the full 400s Pro plan wall clock budget.
  const backgroundExecution = async () => {
    try {
      // WO-0401: Pass config-driven model from agent profile
      // WO-0590: Pass config-driven max_tokens from agent profile
      // MR-003: Pass message budget for budget-driven history management
      // MR-002: Pass context window for pressure-based escalation
      const result = await runAgentLoop(
        agentContext.systemPrompt,
        finalUserMessage,
        toolCtx,
        wo.tags || [],
        agentContext.model,
        agentContext.maxTokens,
        agentContext.budget?.messageBudget,
        agentContext.budget?.totalContext
      );

      console.log(`[WO-AGENT] ${wo.slug} finished: ${result.status} in ${result.turns} turns`);

      // WO-0187: Self-reinvoke on checkpoint/timeout
      // Fix: read anon key from system_settings (same source as triggers) instead of env var
      if (result.status === "checkpoint" || result.status === "timeout") {
        try {
          const selfUrl = Deno.env.get("SUPABASE_URL")!;
          await supabase.rpc("run_sql_void", {
            sql_query: `SELECT net.http_post(
              url := '${selfUrl}/functions/v1/wo-agent/execute',
              headers := jsonb_build_object(
                'Content-Type', 'application/json',
                'Authorization', 'Bearer ' || (SELECT setting_value #>> '{}' FROM system_settings WHERE setting_key = 'supabase_anon_key'),
                'apikey', (SELECT setting_value #>> '{}' FROM system_settings WHERE setting_key = 'supabase_anon_key')
              ),
              body := jsonb_build_object('work_order_id', '${wo.id}')
            );`,
          });
          console.log(`[WO-AGENT] ${wo.slug} checkpointed -- self-reinvoke queued`);
        } catch (e: any) {
          console.error(`[WO-AGENT] ${wo.slug} self-reinvoke failed:`, e.message);
          await supabase.from("work_order_execution_log").insert({
            work_order_id: wo.id, phase: "failed", agent_name: agentContext.agentName,
            detail: { event_type: "continuation_failed", error: e.message, content: `Self-reinvoke failed after checkpoint: ${e.message}` },
          }).then(null, () => {});
        }
      }
    } catch (e: any) {
      console.error(`[WO-AGENT] ${wo.slug} background execution error:`, e.message);
      try {
        await supabase.from("work_order_execution_log").insert({
          work_order_id: wo.id, phase: "failed", agent_name: agentContext.agentName,
          detail: { event_type: "background_error", error: e.message, content: `Background execution crashed: ${e.message}` },
        });
        await supabase.rpc("run_sql_void", {
          sql_query: `SELECT set_config('app.wo_executor_bypass', 'true', true); UPDATE work_orders SET status = 'failed', summary = 'Background execution error: ${e.message.replace(/'/g, "''")}' WHERE id = '${wo.id}';`,
        });
      } catch { /* meta-error */ }
    }
  };

  EdgeRuntime.waitUntil(backgroundExecution());

  // Return immediately -- caller (pg_net trigger) already ignores this response
  return jsonResponse({
    work_order_id: wo.id, slug: wo.slug, status: "started",
    message: "Execution started in background (400s wall clock budget)",
  });
}
