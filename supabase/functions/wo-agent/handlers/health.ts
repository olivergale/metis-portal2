// wo-agent/handlers/health.ts
// WO-0743: Extracted from index.ts — health check + ops logic
import { createClient } from "jsr:@supabase/supabase-js@2";

type JsonResponse = (data: any, status?: number) => Response;

export function createHealthHandlers(jsonResponse: JsonResponse) {
  return {
    handleHealthCheck: async (req: Request): Promise<Response> => {
      const body = await req.json().catch(() => ({}));
      const trigger = body.trigger || "cron";

      // Timeout wrapper -- prevent platform 503 on slow queries
      const timeoutMs = 45_000;
      let timer: number | undefined;

      try {
        const timeoutPromise = new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("Health-check timeout after 45s")), timeoutMs) as unknown as number;
        });
        const result = await Promise.race([healthCheckLogic(trigger), timeoutPromise]);
        clearTimeout(timer);
        return jsonResponse(result);
      } catch (e: any) {
        if (timer) clearTimeout(timer);
        const isTimeout = e.message?.includes("timeout");
        console.error(`[HEALTH-CHECK] ${isTimeout ? "TIMEOUT" : "ERROR"}: ${e.message}`);
        // Return 200 even on timeout -- never cascade 503 which kills the whole system
        return jsonResponse({
          status: isTimeout ? "timeout" : "error",
          error: e.message,
          timestamp: new Date().toISOString(),
        });
      }
    },
  };
}

async function healthCheckLogic(trigger: string) {
  const sbUrl = Deno.env.get("SUPABASE_URL");
  const sbKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!sbUrl || !sbKey) {
    return { status: "error", error: "Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY" };
  }
  const supabase = createClient(sbUrl, sbKey);

  const actions: any[] = [];
  const now = new Date();

  // 1. Stuck WO detection with CONSECUTIVE warning before failure
  const tenMinAgo = new Date(now.getTime() - 10 * 60 * 1000).toISOString();
  const { data: stuckWOs } = await supabase
    .from("work_orders")
    .select("id, slug, started_at, assigned_to, tags, status")
    .eq("status", "in_progress")
    .limit(50);

  for (const wo of stuckWOs || []) {
    const { data: recentLog } = await supabase
      .from("work_order_execution_log")
      .select("created_at, phase")
      .eq("work_order_id", wo.id)
      .gte("created_at", tenMinAgo)
      .limit(1);

    if (!recentLog || recentLog.length === 0) {
      // Check for active children
      const { count: activeChildCount } = await supabase
        .from("work_orders")
        .select("id", { count: "exact", head: true })
        .eq("parent_id", wo.id)
        .in("status", ["in_progress", "review", "ready"]);

      if ((activeChildCount || 0) > 0) {
        await supabase.rpc("run_sql_void", {
          sql_query: `SELECT set_config('app.wo_executor_bypass', 'true', true); UPDATE work_orders SET tags = array_append(COALESCE(tags, ARRAY[]::TEXT[]), 'waiting-on-children') WHERE id = '${wo.id}' AND NOT ('waiting-on-children' = ANY(COALESCE(tags, ARRAY[]::TEXT[])));`,
        });
        actions.push({ type: "stuck_detection", wo_slug: wo.slug, action: "skipped_has_active_children", active_children: activeChildCount });
      } else {
        // CONSECUTIVE DETECTION: count recent stuck_detection warnings in last 30 min
        const thirtyMinAgo = new Date(now.getTime() - 30 * 60 * 1000).toISOString();
        const { count: warnCount } = await supabase
          .from("work_order_execution_log")
          .select("id", { count: "exact", head: true })
          .eq("work_order_id", wo.id)
          .eq("phase", "stuck_detection")
          .gte("created_at", thirtyMinAgo);

        const warnings = warnCount || 0;

        if (warnings >= 2) {
          // 3rd detection -- genuinely stuck for 30+ min, NOW mark failed
          await supabase.rpc("run_sql_void", {
            sql_query: `SELECT set_config('app.wo_executor_bypass', 'true', true); UPDATE work_orders SET status = 'failed', completed_at = NOW() WHERE id = '${wo.id}' AND status = 'in_progress';`,
          });
          await supabase.from("work_order_execution_log").insert({
            work_order_id: wo.id, phase: "stuck_detection", agent_name: "ops",
            detail: { event_type: "stuck_detection", action: "marked_failed",
              reason: `No heartbeat for 30+ min (${warnings + 1} consecutive detections)`,
              started_at: wo.started_at, detection_time: now.toISOString(), consecutive_warnings: warnings },
          });
          actions.push({ type: "stuck_detection", wo_slug: wo.slug, action: "marked_failed", warnings: warnings + 1 });
        } else {
          // Warning only -- don't mark failed yet
          await supabase.from("work_order_execution_log").insert({
            work_order_id: wo.id, phase: "stuck_detection", agent_name: "ops",
            detail: { event_type: "stuck_detection", action: "warning",
              reason: `No heartbeat in 10 min (warning ${warnings + 1}/3 before failure)`,
              detection_time: now.toISOString(), consecutive_warnings: warnings + 1 },
          });
          actions.push({ type: "stuck_detection", wo_slug: wo.slug, action: "warning", warning_number: warnings + 1 });
        }
      }
    }
  }

  // 2. Orphan cleanup: remediation WOs where parent is done
  const { data: orphanRems } = await supabase
    .from("work_orders")
    .select("id, slug, tags, status")
    .contains("tags", ["remediation"])
    .in("status", ["draft", "ready", "in_progress"])
    .limit(50);

  for (const rem of orphanRems || []) {
    const parentTag = (rem.tags || []).find((t: string) => t.startsWith("parent:"));
    if (!parentTag) continue;
    const parentSlug = parentTag.replace("parent:", "");
    const { data: parent } = await supabase
      .from("work_orders").select("status").eq("slug", parentSlug).single();

    if (parent && parent.status === "done") {
      await supabase.rpc("run_sql_void", {
        sql_query: `SELECT set_config('app.wo_executor_bypass', 'true', true); UPDATE work_orders SET status = 'done', completed_at = NOW(), summary = 'Auto-completed by ops: parent ${parentSlug.replace(/'/g, "''")} already done' WHERE id = '${rem.id}';`,
      });
      actions.push({ type: "orphan_cleanup", wo_slug: rem.slug, parent_slug: parentSlug, action: "auto_completed" });
    }
  }

  // 3. Failed WO triage + AUTO-RECOVERY for stuck_detection false positives
  const { data: failedWOs } = await supabase
    .from("work_orders")
    .select("id, slug, tags, priority")
    .eq("status", "failed")
    .not("tags", "cs", '{"no-retry"}')
    .limit(50);

  for (const wo of failedWOs || []) {
    // Check if this was a stuck_detection failure (likely false positive during infra outage)
    const { data: lastFailLog } = await supabase
      .from("work_order_execution_log")
      .select("phase, detail, created_at")
      .eq("work_order_id", wo.id)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    const wasStuckDetection = lastFailLog?.phase === "stuck_detection" && lastFailLog?.detail?.action === "marked_failed";
    const alreadyRetried = (wo.tags || []).includes("auto-recovered");

    if (wasStuckDetection && !alreadyRetried) {
      // Auto-recovery: reset to draft, tag, approve so auto-start picks it up
      await supabase.rpc("run_sql_void", {
        sql_query: `SELECT set_config('app.wo_executor_bypass', 'true', true); UPDATE work_orders SET status = 'draft', completed_at = NULL, tags = array_append(COALESCE(tags, ARRAY[]::TEXT[]), 'auto-recovered') WHERE id = '${wo.id}' AND status = 'failed';`,
      });
      await supabase.rpc("run_sql_void", {
        sql_query: `SELECT set_config('app.wo_executor_bypass', 'true', true); UPDATE work_orders SET status = 'ready', approved_at = NOW(), approved_by = 'ops-auto-recovery' WHERE id = '${wo.id}' AND status = 'draft';`,
      });
      await supabase.from("work_order_execution_log").insert({
        work_order_id: wo.id, phase: "stream", agent_name: "ops",
        detail: { event_type: "auto_recovery", action: "recovered_from_stuck_detection",
          reason: "Stuck detection failure likely caused by infra outage -- auto-retrying once" },
      });
      actions.push({ type: "auto_recovery", wo_slug: wo.slug, action: "recovered" });
      continue;
    }

    // Standard triage: tag no-retry after 3 failures
    const { count } = await supabase
      .from("work_order_execution_log")
      .select("id", { count: "exact", head: true })
      .eq("work_order_id", wo.id)
      .eq("phase", "failed");

    if ((count || 0) >= 3) {
      await supabase.rpc("run_sql_void", {
        sql_query: `SELECT set_config('app.wo_executor_bypass', 'true', true); UPDATE work_orders SET tags = array_append(COALESCE(tags, ARRAY[]::TEXT[]), 'no-retry') WHERE id = '${wo.id}';`,
      });
      actions.push({ type: "failed_triage", wo_slug: wo.slug, attempts: count, action: "tagged_no_retry" });
    }
  }

  // 4. Queue stall detection
  const thirtyMinAgo2 = new Date(now.getTime() - 30 * 60 * 1000).toISOString();
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
      .gte("created_at", thirtyMinAgo2);

    if ((recentTransitions || 0) === 0) {
      queueStalled = true;
      actions.push({ type: "queue_stall", pending_wos: pendingCount, action: "alert",
        message: "No WO transitions in 30+ min with pending work" });
    }
  }

  // 5. Auto-unblock: ready WOs with satisfied depends_on
  const { data: blockedWOs } = await supabase
    .from("work_orders")
    .select("id, slug, depends_on")
    .eq("status", "ready")
    .not("depends_on", "is", null)
    .limit(50);

  for (const wo of blockedWOs || []) {
    if (!wo.depends_on || wo.depends_on.length === 0) continue;
    const { count: openDeps } = await supabase
      .from("work_orders")
      .select("id", { count: "exact", head: true })
      .in("id", wo.depends_on)
      .not("status", "in", '("done","cancelled")');

    if ((openDeps || 0) === 0) {
      const { error: startErr } = await supabase.rpc("start_work_order", {
        p_work_order_id: wo.id, p_agent_name: "builder",
      });
      if (!startErr) {
        actions.push({ type: "auto_unblock", wo_slug: wo.slug, action: "started" });
      }
    }
  }

  // Log health check result
  await supabase.from("audit_log").insert({
    event_type: "health_check", actor_type: "system", actor_id: "ops",
    target_type: "system", target_id: "27148e96-5094-4a80-a832-8cdb93c8d96f",
    action: `Health check: ${actions.length} actions taken`,
    payload: { trigger, actions_taken: actions.length, stuck_detected: stuckWOs?.length || 0,
      failed_triaged: failedWOs?.length || 0, queue_stalled: queueStalled, actions },
  });

  return {
    status: "ok", timestamp: now.toISOString(), trigger,
    actions_taken: actions.length, details: actions,
  };
}
