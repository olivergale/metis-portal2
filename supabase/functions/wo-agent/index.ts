// wo-agent/index.ts v3
// WO-0153: Fixed imports for Deno Deploy compatibility
// Server-side agentic work order executor
// Replaces CLI subprocess model with API-based tool-use loop
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { buildAgentContext } from "./context.ts";
import { runAgentLoop } from "./agent-loop.ts";
import type { ToolContext } from "./tools.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

function jsonResponse(data: any, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: CORS });
  }

  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  const url = new URL(req.url);
  const action = url.pathname.split("/").pop();

  try {
    switch (action) {
      case "execute":
        return await handleExecute(req);
      case "execute-batch":
        return await handleExecuteBatch(req);
      case "status":
        return await handleStatus(req);
      case "health-check":
        return await handleHealthCheck(req);
      default:
        return jsonResponse({ error: `Unknown action: ${action}` }, 404);
    }
  } catch (e: any) {
    console.error("[WO-AGENT] Unhandled error:", e);
    return jsonResponse({ error: e.message }, 500);
  }
});

/**
 * POST /execute
 * Execute a work order using the agentic loop
 * Body: { work_order_id: string }
 */
async function handleExecute(req: Request): Promise<Response> {
  const body = await req.json();
  const { work_order_id } = body;

  if (!work_order_id) {
    return jsonResponse({ error: "Missing work_order_id" }, 400);
  }

  const sbUrl = Deno.env.get("SUPABASE_URL")!;
  const sbKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const supabase = createClient(sbUrl, sbKey);

  // Load the work order
  const { data: wo, error: woError } = await supabase
    .from("work_orders")
    .select(
      "id, slug, name, objective, acceptance_criteria, tags, priority, status, summary, qa_checklist, client_info, project_brief_id, depends_on, assigned_to"
    )
    .eq("id", work_order_id)
    .single();

  if (woError || !wo) {
    return jsonResponse(
      { error: `Work order not found: ${woError?.message || work_order_id}` },
      404
    );
  }

  // Validate status
  if (wo.status !== "in_progress") {
    return jsonResponse(
      {
        error: `Work order ${wo.slug} is not in_progress (current: ${wo.status})`,
      },
      400
    );
  }

  // WO-0155: Guard against orphaned remediation WOs â if parent is already done, auto-complete
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

      if (parentWo && parentWo.status === "done") {
        const msg = `Parent ${parentSlug} already completed â remediation unnecessary`;
        console.log(`[WO-AGENT] ${wo.slug}: ${msg}`);

        // Log and auto-complete
        await supabase.from("work_order_execution_log").insert({
          work_order_id: wo.id,
          phase: "execution_complete",
          agent_name: "wo-agent",
          detail: { event_type: "result", content: msg },
        });
        await supabase.rpc("run_sql_void", {
          sql_query: `SELECT set_config('app.wo_executor_bypass', 'true', true); UPDATE work_orders SET status = 'review', summary = '${msg.replace(/'/g, "''")}' WHERE id = '${wo.id}';`,
        });
        // Immediately complete (skip QA â nothing to evaluate)
        await supabase.rpc("run_sql_void", {
          sql_query: `SELECT set_config('app.wo_executor_bypass', 'true', true); UPDATE work_orders SET status = 'done', completed_at = NOW(), summary = '${msg.replace(/'/g, "''")}' WHERE id = '${wo.id}';`,
        });

        return jsonResponse({
          work_order_id: wo.id,
          slug: wo.slug,
          status: "completed",
          turns: 0,
          summary: msg,
          tool_calls: 0,
        });
      }
    }
  }

  // Load GitHub token
  let githubToken: string | null = null;
  try {
    const { data } = await supabase
      .from("secrets")
      .select("value")
      .eq("key", "GITHUB_TOKEN")
      .single();
    githubToken = data?.value || null;
  } catch {
    // GitHub token not available â GitHub tools will fail gracefully
  }

  // Build agent context
  const agentContext = await buildAgentContext(supabase, wo);

  // Build tool context
  const toolCtx: ToolContext = {
    supabase,
    workOrderId: wo.id,
    workOrderSlug: wo.slug,
    githubToken,
    agentName: agentContext.agentName,
  };

  // WO-0187: Check for continuation â if there's a recent checkpoint, build continuation context
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
    // Count total checkpoints for circuit breaker
    const { count: checkpointCount } = await supabase
      .from("work_order_execution_log")
      .select("id", { count: "exact", head: true })
      .eq("work_order_id", work_order_id)
      .eq("phase", "checkpoint");

    if ((checkpointCount || 0) >= 5) {
      // Circuit breaker â too many continuations
      const msg = `Exceeded continuation budget (${checkpointCount} checkpoints). Marking failed.`;
      await supabase.from("work_order_execution_log").insert({
        work_order_id: wo.id,
        phase: "failed",
        agent_name: agentContext.agentName,
        detail: { event_type: "circuit_breaker", content: msg },
      });
      await supabase.rpc("run_sql_void", {
        sql_query: `SELECT set_config('app.wo_executor_bypass', 'true', true); UPDATE work_orders SET status = 'failed', summary = '${msg.replace(/'/g, "''")}' WHERE id = '${wo.id}';`,
      });
      return jsonResponse({ work_order_id: wo.id, slug: wo.slug, status: "failed", turns: 0, summary: msg, tool_calls: 0 });
    }

    // Build continuation context
    const cp = checkpoint.detail;
    finalUserMessage = `# CONTINUATION â Work Order: ${wo.slug}\n\n`;
    finalUserMessage += `**You are CONTINUING a previous execution that checkpointed.**\n`;
    finalUserMessage += `Previous progress: ${cp.turns_completed} turns, ${cp.mutations || 0} mutations.\n`;
    finalUserMessage += `Last actions: ${cp.last_actions || 'unknown'}\n`;
    finalUserMessage += `Continuation #${(checkpointCount || 0) + 1} of max 5.\n\n`;
    finalUserMessage += `## Original Objective\n${wo.objective}\n\n`;
    if (wo.acceptance_criteria) {
      finalUserMessage += `## Acceptance Criteria\n${wo.acceptance_criteria}\n\n`;
    }
    finalUserMessage += `**IMPORTANT**: Do NOT redo work already done. Verify what was completed, then finish the remaining items. Call mark_complete when done.\n`;

    await supabase.from("work_order_execution_log").insert({
      work_order_id: wo.id,
      phase: "continuation",
      agent_name: agentContext.agentName,
      detail: { event_type: "continuation_start", checkpoint_count: (checkpointCount || 0) + 1, previous_turns: cp.turns_completed },
    });
  }

  // Run the agentic loop with tag-filtered tools
  const result = await runAgentLoop(
    agentContext.systemPrompt,
    finalUserMessage,
    toolCtx,
    wo.tags || []
  );

  // Log final result
  console.log(
    `[WO-AGENT] ${wo.slug} finished: ${result.status} in ${result.turns} turns`
  );

  // WO-0187: If checkpoint, self-reinvoke via pg_net for continuation
  if (result.status === "checkpoint") {
    try {
      const anonKey = Deno.env.get("SUPABASE_ANON_KEY") || "";
      const sbUrl = Deno.env.get("SUPABASE_URL")!;
      // Self-reinvoke with 2s delay via pg_net
      await supabase.rpc("run_sql_void", {
        sql_query: `SELECT net.http_post(
          url := '${sbUrl}/functions/v1/wo-agent/execute',
          headers := jsonb_build_object(
            'Content-Type', 'application/json',
            'Authorization', 'Bearer ${anonKey}',
            'apikey', '${anonKey}'
          ),
          body := jsonb_build_object('work_order_id', '${wo.id}')
        );`,
      });
      console.log(`[WO-AGENT] ${wo.slug} checkpointed â self-reinvoke queued`);
    } catch (e: any) {
      console.error(`[WO-AGENT] ${wo.slug} self-reinvoke failed:`, e.message);
    }
  }

  return jsonResponse({
    work_order_id: wo.id,
    slug: wo.slug,
    status: result.status,
    turns: result.turns,
    summary: result.summary,
    tool_calls: result.toolCalls.length,
  });
}

/**
 * POST /status
 * Check the execution status of a work order
 * Body: { work_order_id: string }
 */
async function handleStatus(req: Request): Promise<Response> {
  const body = await req.json();
  const { work_order_id } = body;

  if (!work_order_id) {
    return jsonResponse({ error: "Missing work_order_id" }, 400);
  }

  const sbUrl = Deno.env.get("SUPABASE_URL")!;
  const sbKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const supabase = createClient(sbUrl, sbKey);

  // Get WO status
  const { data: wo } = await supabase
    .from("work_orders")
    .select("id, slug, status, summary")
    .eq("id", work_order_id)
    .single();

  if (!wo) {
    return jsonResponse({ error: "Work order not found" }, 404);
  }

  // Get latest execution log entries
  const { data: logs } = await supabase
    .from("work_order_execution_log")
    .select("phase, detail, created_at")
    .eq("work_order_id", work_order_id)
    .order("created_at", { ascending: false })
    .limit(5);

  return jsonResponse({
    work_order_id: wo.id,
    slug: wo.slug,
    status: wo.status,
    summary: wo.summary,
    recent_activity: logs || [],
  });
}

/**
 * POST /health-check
 * Ops agent endpoint: detects stuck WOs, orphans, failed WO triage, queue stalls
 * Body: { trigger?: "cron" | "manual" }
 */
async function handleHealthCheck(req: Request): Promise<Response> {
  const body = await req.json().catch(() => ({}));
  const trigger = body.trigger || "cron";

  const sbUrl = Deno.env.get("SUPABASE_URL")!;
  const sbKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const supabase = createClient(sbUrl, sbKey);

  const actions: any[] = [];
  const now = new Date();

  // 1. Stuck WO detection: in_progress with no execution_log heartbeat in 10 min
  // WO-0238: AC3 - Heartbeat-based liveness using execution_log recency, not started_at
  const tenMinAgo = new Date(now.getTime() - 10 * 60 * 1000).toISOString();
  const { data: stuckWOs } = await supabase
    .from("work_orders")
    .select("id, slug, started_at, assigned_to, tags, status")
    .eq("status", "in_progress");

  for (const wo of stuckWOs || []) {
    // Check for recent execution_log heartbeat (any entry in last 10 min)
    const { data: recentLog } = await supabase
      .from("work_order_execution_log")
      .select("created_at, phase")
      .eq("work_order_id", wo.id)
      .gte("created_at", tenMinAgo)
      .limit(1);

    if (!recentLog || recentLog.length === 0) {
      // No heartbeat in 10 min â mark as failed (AC1: never overwrite summary)
      await supabase.rpc("run_sql_void", {
        sql_query: `SELECT set_config('app.wo_executor_bypass', 'true', true); UPDATE work_orders SET status = 'failed', completed_at = NOW() WHERE id = '${wo.id}' AND status = 'in_progress';`,
      });

      // AC1: Stuck detection info goes to execution_log ONLY (not summary)
      await supabase.from("work_order_execution_log").insert({
        work_order_id: wo.id,
        phase: "stuck_detection",
        agent_name: "ops",
        detail: {
          event_type: "stuck_detection",
          action: "marked_failed",
          reason: "No execution_log heartbeat in 10 minutes",
          started_at: wo.started_at,
          detection_time: now.toISOString(),
        },
      });

      actions.push({
        type: "stuck_detection",
        wo_slug: wo.slug,
        action: "marked_failed",
      });
    }
  }

  // 2. Orphan cleanup: remediation WOs where parent is done
  const { data: orphanRems } = await supabase
    .from("work_orders")
    .select("id, slug, tags, status")
    .contains("tags", ["remediation"])
    .in("status", ["draft", "ready", "in_progress"]);

  for (const rem of orphanRems || []) {
    const parentTag = (rem.tags || []).find((t: string) =>
      t.startsWith("parent:")
    );
    if (!parentTag) continue;

    const parentSlug = parentTag.replace("parent:", "");
    const { data: parent } = await supabase
      .from("work_orders")
      .select("status")
      .eq("slug", parentSlug)
      .single();

    if (parent && parent.status === "done") {
      await supabase.rpc("run_sql_void", {
        sql_query: `SELECT set_config('app.wo_executor_bypass', 'true', true); UPDATE work_orders SET status = 'done', completed_at = NOW(), summary = 'Auto-completed by ops: parent ${parentSlug.replace(/'/g, "''")} already done' WHERE id = '${rem.id}';`,
      });

      await supabase.from("work_order_execution_log").insert({
        work_order_id: rem.id,
        phase: "stream",
        agent_name: "ops",
        detail: {
          event_type: "tool_result",
          tool_name: "health_check",
          action: "orphan_auto_completed",
          reason: `parent ${parentSlug} already done`,
        },
      });

      actions.push({
        type: "orphan_cleanup",
        wo_slug: rem.slug,
        parent_slug: parentSlug,
        action: "auto_completed",
      });
    }
  }

  // 3. Failed WO triage: detect-and-tag only (NO auto-retry)
  // WO-0238: AC2 - Ops never transitions failed or done WOs. Terminal states are sacred.
  // WO-0238: AC4 - Circuit breaker satisfied: no retry dispatches (was removed entirely).
  // Only tags with no-retry after 3 failures for human triage.
  const { data: failedWOs } = await supabase
    .from("work_orders")
    .select("id, slug, tags, priority")
    .eq("status", "failed")
    .not("tags", "cs", '{"no-retry"}');

  for (const wo of failedWOs || []) {
    const { count } = await supabase
      .from("work_order_execution_log")
      .select("id", { count: "exact", head: true })
      .eq("work_order_id", wo.id)
      .eq("phase", "failed");

    const attempts = count || 0;

    if (attempts >= 3) {
      // Tag with no-retry for human attention â no state change
      await supabase.rpc("run_sql_void", {
        sql_query: `SELECT set_config('app.wo_executor_bypass', 'true', true); UPDATE work_orders SET tags = array_append(COALESCE(tags, ARRAY[]::TEXT[]), 'no-retry') WHERE id = '${wo.id}';`,
      });

      await supabase.from("work_order_execution_log").insert({
        work_order_id: wo.id,
        phase: "stream",
        agent_name: "ops",
        detail: {
          event_type: "tool_result",
          tool_name: "health_check",
          action: "tagged_no_retry",
          reason: `Failed ${attempts} times, tagged for human triage`,
          attempts,
        },
      });

      actions.push({
        type: "failed_triage",
        wo_slug: wo.slug,
        attempts,
        action: "tagged_no_retry",
      });
    }
  }

  // 4. Queue stall detection: no WO transitions in 30+ min despite pending WOs
  const thirtyMinAgo = new Date(now.getTime() - 30 * 60 * 1000).toISOString();
  const { count: pendingCount } = await supabase
    .from("work_orders")
    .select("id", { count: "exact", head: true })
    .in("status", ["ready", "in_progress"]);

  let queueStalled = false;
  if ((pendingCount || 0) > 0) {
    const { count: recentTransitions } = await supabase
      .from("state_mutations")
      .select("id", { count: "exact", head: true })
      .eq("target_table", "work_orders")
      .gte("created_at", thirtyMinAgo);

    if ((recentTransitions || 0) === 0) {
      queueStalled = true;
      actions.push({
        type: "queue_stall",
        pending_wos: pendingCount,
        action: "alert",
        message: "No WO transitions in 30+ min with pending work",
      });
    }
  }

  // Log health check result
  await supabase.from("audit_log").insert({
    event_type: "health_check",
    actor_type: "system",
    actor_id: "ops",
    target_type: "system",
    target_id: "27148e96-5094-4a80-a832-8cdb93c8d96f",
    action: `Health check: ${actions.length} actions taken`,
    payload: {
      trigger,
      actions_taken: actions.length,
      stuck_detected: stuckWOs?.length || 0,
      orphans_cleaned: (orphanRems || []).filter((r: any) => {
        const pt = (r.tags || []).find((t: string) => t.startsWith("parent:"));
        return pt;
      }).length,
      failed_triaged: failedWOs?.length || 0,
      queue_stalled: queueStalled,
      actions,
    },
  });

  return jsonResponse({
    status: "ok",
    timestamp: now.toISOString(),
    trigger,
    actions_taken: actions.length,
    details: actions,
  });
}
