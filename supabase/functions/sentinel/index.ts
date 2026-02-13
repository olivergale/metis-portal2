// sentinel/index.ts - Consolidated Tier-1 Health Monitor
// WO-0381: Replaces wo-agent /health-check, ops stuck detection, and health-check function
// Runs every 5 minutes via pg_cron

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

interface TriageEntry {
  wo_id: string;
  triage_type: string;
  severity: string;
  diagnostic_context: any;
  escalate_to?: string;
}

interface CorrelationGroup {
  correlation_type: string;
  affected_wo_ids: string[];
  root_cause: string;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: CORS });
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  const startTime = Date.now();
  const triageEntries: TriageEntry[] = [];
  const correlations: CorrelationGroup[] = [];

  try {
    // 1. STUCK WO DETECTION (consecutive model from wo-agent v5)
    const stuckWOs = await detectStuckWOs(supabase);
    for (const wo of stuckWOs) {
      triageEntries.push({
        wo_id: wo.id,
        triage_type: "stuck",
        severity: wo.severity,
        diagnostic_context: wo.context,
        escalate_to: wo.escalate_to,
      });
    }

    // 2. ORPHAN CLEANUP (WOs ready but no agent claimed for >10min)
    const orphans = await detectOrphans(supabase);
    for (const wo of orphans) {
      triageEntries.push({
        wo_id: wo.id,
        triage_type: "orphan",
        severity: "medium",
        diagnostic_context: { idle_minutes: wo.idle_minutes },
      });
    }

    // 3. AUTO-UNBLOCK (ready WOs with satisfied depends_on)
    const unblocked = await autoUnblockWOs(supabase);
    for (const wo of unblocked) {
      triageEntries.push({
        wo_id: wo.id,
        triage_type: "auto_unblock",
        severity: "info",
        diagnostic_context: { cleared_dependencies: wo.cleared },
      });
    }

    // 4. MISMATCH DETECTION (status vs execution_log)
    const mismatches = await detectMismatches(supabase);
    for (const wo of mismatches) {
      triageEntries.push({
        wo_id: wo.id,
        triage_type: "mismatch",
        severity: "medium",
        diagnostic_context: wo.context,
      });
    }

    // 5. EXPLORATION SPIRAL (>50% read-only tools over 10+ turns)
    const spirals = await detectExplorationSpirals(supabase);
    for (const wo of spirals) {
      triageEntries.push({
        wo_id: wo.id,
        triage_type: "spiral",
        severity: "medium",
        diagnostic_context: { read_ratio: wo.read_ratio, turns: wo.turns },
      });
    }

    // 6. CORRELATION LOGIC (group similar failures)
    const correlationGroups = await detectCorrelations(supabase, triageEntries);
    correlations.push(...correlationGroups);

    // AC #5: Escalate critical items and large correlations to diagnostician
    let shouldInvokeDiagnostician = false;
    
    // Check for critical severity items
    const criticalItems = triageEntries.filter((t) => t.severity === "critical");
    for (const item of criticalItems) {
      item.escalate_to = "diagnostician";
      shouldInvokeDiagnostician = true;
    }
    
    // Check for large correlations (3+ WOs)
    for (const corr of correlations) {
      if (corr.affected_wo_ids.length >= 3) {
        // Escalate all WOs in the correlation
        for (const woId of corr.affected_wo_ids) {
          const entry = triageEntries.find((t) => t.wo_id === woId);
          if (entry) {
            entry.escalate_to = "diagnostician";
          }
        }
        shouldInvokeDiagnostician = true;
      }
    }

    // WRITE TRIAGE ENTRIES
    if (triageEntries.length > 0) {
      const { error: triageErr } = await supabase
        .from("monitor_triage_queue")
        .insert(
          triageEntries.map((t) => ({
            wo_id: t.wo_id,
            triage_type: t.triage_type,
            severity: t.severity,
            diagnostic_context: t.diagnostic_context,
            escalate_to: t.escalate_to || null,
          }))
        );
      if (triageErr) console.error("[SENTINEL] Triage insert error:", triageErr);

      // AUTO-INVOKE DIAGNOSTICIAN for critical items or large correlations (WO-0382 AC#5)
      const criticalItems = triageEntries.filter((t) => t.severity === "critical");
      const shouldInvokeDiagnostician = criticalItems.length > 0 || correlations.some(c => c.affected_wo_ids.length >= 3);

      if (shouldInvokeDiagnostician) {
        // Update critical items to escalate_to = "diagnostician"
        const criticalWoIds = criticalItems.map(t => t.wo_id);
        if (criticalWoIds.length > 0) {
          await supabase
            .from("monitor_triage_queue")
            .update({ escalate_to: "diagnostician" })
            .in("wo_id", criticalWoIds)
            .is("resolved_at", null);
        }

        // Invoke diagnostician edge function via pg_net
        try {
          await supabase.rpc("http_post", {
            url: `${Deno.env.get("SUPABASE_URL")}/functions/v1/diagnostician`,
            headers: {
              "Content-Type": "application/json",
              "Authorization": `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`,
            },
            body: JSON.stringify({ trigger: "sentinel_escalation" }),
          });
          console.log("[SENTINEL] Invoked diagnostician for critical items");
        } catch (invokeErr) {
          console.error("[SENTINEL] Failed to invoke diagnostician:", invokeErr);
        }
      }
    }
    
    // AUTO-INVOKE DIAGNOSTICIAN (AC #5)
    if (shouldInvokeDiagnostician) {
      try {
        const diagnosticianUrl = `${Deno.env.get("SUPABASE_URL")}/functions/v1/diagnostician`;
        const response = await fetch(diagnosticianUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${Deno.env.get("SUPABASE_ANON_KEY")}`,
          },
          body: JSON.stringify({}),
        });
        
        if (!response.ok) {
          console.error("[SENTINEL] Diagnostician invocation failed:", response.status);
        } else {
          console.log("[SENTINEL] Diagnostician invoked successfully");
        }
      } catch (diagErr: any) {
        console.error("[SENTINEL] Error invoking diagnostician:", diagErr.message);
      }
    }

    // WRITE CORRELATIONS
    if (correlations.length > 0) {
      const { error: corrErr } = await supabase
        .from("monitor_correlations")
        .insert(
          correlations.map((c) => ({
            correlation_type: c.correlation_type,
            affected_wo_ids: c.affected_wo_ids,
            root_cause: c.root_cause,
            created_by: "sentinel",
          }))
        );
      if (corrErr) console.error("[SENTINEL] Correlation insert error:", corrErr);
    }

    const elapsed = Date.now() - startTime;
    return new Response(
      JSON.stringify({
        success: true,
        elapsed_ms: elapsed,
        triage_count: triageEntries.length,
        correlation_count: correlations.length,
        breakdown: {
          stuck: triageEntries.filter((t) => t.triage_type === "stuck").length,
          orphan: triageEntries.filter((t) => t.triage_type === "orphan").length,
          auto_unblock: triageEntries.filter((t) => t.triage_type === "auto_unblock").length,
          mismatch: triageEntries.filter((t) => t.triage_type === "mismatch").length,
          spiral: triageEntries.filter((t) => t.triage_type === "spiral").length,
        },
      }),
      { status: 200, headers: { ...CORS, "Content-Type": "application/json" } }
    );
  } catch (e: any) {
    console.error("[SENTINEL] Error:", e);
    return new Response(
      JSON.stringify({ error: e.message }),
      { status: 500, headers: { ...CORS, "Content-Type": "application/json" } }
    );
  }
});

// STUCK WO DETECTION: consecutive model (warn x2 then fail over 30min)
async function detectStuckWOs(supabase: any) {
  const thirtyMinAgo = new Date(Date.now() - 30 * 60 * 1000).toISOString();
  const tenMinAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();

  const { data: candidates } = await supabase
    .from("work_orders")
    .select("id, slug, status, started_at, updated_at")
    .eq("status", "in_progress")
    .lt("started_at", thirtyMinAgo);

  if (!candidates || candidates.length === 0) return [];

  const stuck = [];
  for (const wo of candidates) {
    const { data: logs } = await supabase
      .from("work_order_execution_log")
      .select("created_at")
      .eq("work_order_id", wo.id)
      .order("created_at", { ascending: false })
      .limit(1);

    const lastActivity = logs?.[0]?.created_at || wo.updated_at;
    if (lastActivity < tenMinAgo) {
      // Check existing triage entries to avoid duplicates
      const { data: existing } = await supabase
        .from("monitor_triage_queue")
        .select("id")
        .eq("wo_id", wo.id)
        .eq("triage_type", "stuck")
        .is("resolved_at", null)
        .limit(1);

      if (!existing || existing.length === 0) {
        stuck.push({
          id: wo.id,
          severity: "high",
          context: { slug: wo.slug, last_activity: lastActivity, started_at: wo.started_at },
          escalate_to: "ops",
        });
      }
    }
  }

  return stuck;
}

// ORPHAN DETECTION: ready WOs with no claim for >10min
async function detectOrphans(supabase: any) {
  const tenMinAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();

  const { data: candidates } = await supabase
    .from("work_orders")
    .select("id, slug, created_at")
    .eq("status", "ready")
    .lt("created_at", tenMinAgo);

  if (!candidates || candidates.length === 0) return [];

  return candidates.map((wo: any) => ({
    id: wo.id,
    idle_minutes: Math.floor((Date.now() - new Date(wo.created_at).getTime()) / 60000),
  }));
}

// AUTO-UNBLOCK: ready WOs with satisfied depends_on
async function autoUnblockWOs(supabase: any) {
  const { data: blocked } = await supabase
    .from("work_orders")
    .select("id, slug, depends_on")
    .eq("status", "ready")
    .not("depends_on", "is", null);

  if (!blocked || blocked.length === 0) return [];

  const unblocked = [];
  for (const wo of blocked) {
    if (!wo.depends_on || wo.depends_on.length === 0) continue;

    const { data: deps } = await supabase
      .from("work_orders")
      .select("id, status")
      .in("id", wo.depends_on);

    const allDone = deps && deps.every((d: any) => d.status === "done");
    if (allDone) {
      // Clear depends_on
      await supabase
        .from("work_orders")
        .update({ depends_on: [] })
        .eq("id", wo.id);
      unblocked.push({ id: wo.id, cleared: wo.depends_on });
    }
  }

  return unblocked;
}

// MISMATCH DETECTION: status vs execution_log
async function detectMismatches(supabase: any) {
  const { data: inProgress } = await supabase
    .from("work_orders")
    .select("id, slug, status")
    .eq("status", "in_progress");

  if (!inProgress || inProgress.length === 0) return [];

  const mismatches = [];
  for (const wo of inProgress) {
    const { data: logs } = await supabase
      .from("work_order_execution_log")
      .select("phase")
      .eq("work_order_id", wo.id)
      .order("created_at", { ascending: false })
      .limit(1);

    const lastPhase = logs?.[0]?.phase;
    if (lastPhase === "execution_complete" || lastPhase === "failed") {
      mismatches.push({
        id: wo.id,
        context: { status: wo.status, last_phase: lastPhase },
      });
    }
  }

  return mismatches;
}

// EXPLORATION SPIRAL: >50% read-only tools over 10+ turns
async function detectExplorationSpirals(supabase: any) {
  const { data: inProgress } = await supabase
    .from("work_orders")
    .select("id, slug")
    .eq("status", "in_progress");

  if (!inProgress || inProgress.length === 0) return [];

  const spirals = [];
  for (const wo of inProgress) {
    const { data: logs } = await supabase
      .from("work_order_execution_log")
      .select("detail")
      .eq("work_order_id", wo.id)
      .eq("phase", "stream");

    if (!logs || logs.length < 10) continue;

    let readCount = 0;
    let writeCount = 0;
    for (const log of logs) {
      const tool = log.detail?.tool_name || "";
      if (tool.includes("read") || tool.includes("execute_sql") || tool.includes("list")) {
        readCount++;
      } else if (tool.includes("write") || tool.includes("apply_migration") || tool.includes("deploy")) {
        writeCount++;
      }
    }

    const total = readCount + writeCount;
    if (total > 0) {
      const readRatio = readCount / total;
      if (readRatio > 0.5 && logs.length >= 10) {
        spirals.push({ id: wo.id, read_ratio: readRatio, turns: logs.length });
      }
    }
  }

  return spirals;
}

// CORRELATION: group similar failures
async function detectCorrelations(supabase: any, triageEntries: TriageEntry[]) {
  if (triageEntries.length < 2) return [];

  const recentFails = triageEntries.filter((t) => t.triage_type === "stuck" || t.triage_type === "mismatch");
  if (recentFails.length < 2) return [];

  // Simple correlation: if 2+ WOs failed in last 15min, group them
  const correlations: CorrelationGroup[] = [];
  const woIds = recentFails.map((t) => t.wo_id);

  // Check for API rate limit pattern
  const { data: rateLimitLogs } = await supabase
    .from("work_order_execution_log")
    .select("work_order_id, detail")
    .in("work_order_id", woIds)
    .ilike("detail->>content", "%rate limit%");

  if (rateLimitLogs && rateLimitLogs.length >= 2) {
    correlations.push({
      correlation_type: "api_rate_limit",
      affected_wo_ids: rateLimitLogs.map((l: any) => l.work_order_id),
      root_cause: "API rate limit exceeded across multiple WOs",
    });
  }

  // Check for schema drift
  const { data: schemaLogs } = await supabase
    .from("work_order_execution_log")
    .select("work_order_id, detail")
    .in("work_order_id", woIds)
    .or("detail->>content.ilike.%column does not exist%,detail->>content.ilike.%table does not exist%");

  if (schemaLogs && schemaLogs.length >= 2) {
    correlations.push({
      correlation_type: "schema_drift",
      affected_wo_ids: schemaLogs.map((l: any) => l.work_order_id),
      root_cause: "Schema mismatch detected across multiple WOs",
    });
  }

  return correlations;
}
