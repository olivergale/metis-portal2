// context-load/index.ts - v17
// v17: Added design_doc_required flag to work_orders (WO-PRD-GATE)
// v16: Fix doc_status — use project UUID (not code string) for project_documents query + call check_doc_currency() RPC
// v15: Added verification_requirements to response (E2E verification gate)

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

interface LoadRequest {
  project_code?: string;
  user_id?: string;
  include_full?: boolean;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const supabase = createClient(supabaseUrl, supabaseKey);

  try {
    const body: LoadRequest = await req.json().catch(() => ({}));
    const projectCode = body.project_code || "METIS-001";
    const userId = body.user_id || "default";
    const includeFull = body.include_full ?? true;

    const loadedAt = new Date().toISOString();
    const oneDayAgo = new Date(Date.now() - 86400000).toISOString();
    const oneWeekAgo = new Date(Date.now() - 7 * 86400000).toISOString();
    const thirtyDaysAgo = new Date(Date.now() - 30 * 86400000).toISOString();

    // Parallel fetch all context (14 queries)
    const results = await Promise.all([
      // 1. Project brief
      supabase.from("project_briefs").select("*").eq("code", projectCode).single(),

      // 2. Agents
      supabase.from("agents").select("id, name, agent_type, status, description").eq("status", "active"),

      // 3. Work orders (active) - v17: added design_doc_id
      supabase.from("work_orders")
        .select("id, slug, name, objective, status, priority, assigned_to, approved_at, created_at, source, tags, verification_status, design_doc_id")
        .in("status", ["draft", "ready", "in_progress", "review", "blocked"])
        .order("created_at", { ascending: false })
        .limit(15),

      // 4. Capabilities
      supabase.from("metis_capabilities")
        .select("capability_type, name, status, implementation")
        .eq("status", "active"),

      // 5. Decisions (recent active)
      supabase.from("decisions")
        .select("subject, choice, rationale, created_at")
        .eq("status", "active")
        .order("created_at", { ascending: false })
        .limit(10),

      // 6. Directives (system rules)
      supabase.from("system_directives")
        .select("name, content, enforcement, priority")
        .eq("active", true)
        .order("priority", { ascending: false }),

      // 7. System status
      supabase.from("system_status")
        .select("component, status, last_heartbeat, metadata"),

      // 8. User preferences
      supabase.from("user_preferences")
        .select("key, value")
        .eq("user_id", userId),

      // 9. MCP connectors
      supabase.from("system_manifest")
        .select("name, config, status")
        .eq("component_type", "mcp_connector")
        .eq("status", "active"),

      // 10. Recent execution logs
      supabase.from("work_order_execution_log")
        .select("work_order_id, phase, agent_name, detail, created_at")
        .order("created_at", { ascending: false })
        .limit(20),

      // 11. Recently completed WOs (last 7 days)
      supabase.from("work_orders")
        .select("slug, name, status, completed_at, summary, verification_status")
        .eq("status", "done")
        .gte("completed_at", oneWeekAgo)
        .order("completed_at", { ascending: false })
        .limit(10),

      // 12. Lesson counts by category
      supabase.from("lessons")
        .select("id, category, severity, promoted_at")
        .order("created_at", { ascending: false })
        .limit(200),

      // 13. Directive count
      supabase.from("system_directives")
        .select("id", { count: "exact", head: true })
        .eq("active", true),

      // 14. Verification coverage (v15 - for E2E gate)
      supabase.from("work_orders")
        .select("id, verification_status")
        .eq("status", "done")
        .gte("completed_at", thirtyDaysAgo),
    ]);

    const [projectRes, agentsRes, workOrdersRes, capsRes, decisionsRes,
           directivesRes, statusRes, prefsRes, mcpRes, execLogsRes,
           completedWosRes, lessonsRes, directiveCountRes,
           verificationCoverageRes] = results;

    // Extract project UUID for doc queries
    const project = projectRes.data || {};
    const projectUUID = project.id;

    // v16: Use project UUID (not code string) for doc queries + call check_doc_currency RPC
    let docStatus: any = { drift_detected: false, doc_count: 0 };
    if (projectUUID) {
      const [projectDocsRes, docCurrencyRes] = await Promise.all([
        supabase.from("project_documents")
          .select("doc_type, updated_at, version")
          .eq("project_id", projectUUID),
        supabase.rpc("check_doc_currency", { p_project_id: projectUUID }),
      ]);

      const projectDocs = projectDocsRes.data || [];
      const docsByType: Record<string, { updated_at: string; version: number }> = {};
      for (const doc of projectDocs) {
        docsByType[doc.doc_type] = { updated_at: doc.updated_at, version: doc.version };
      }

      const currencyCheck = docCurrencyRes.data || {};
      docStatus = {
        architecture_updated_at: docsByType['architecture']?.updated_at || null,
        state_machine_updated_at: docsByType['state_machine']?.updated_at || null,
        tech_stack_updated_at: docsByType['tech_stack']?.updated_at || null,
        last_schema_change: currencyCheck.last_schema_change || null,
        last_manifest_mutation: currencyCheck.last_manifest_mutation || null,
        drift_detected: currencyCheck.drift_detected || false,
        drift_details: currencyCheck.details || [],
        doc_count: projectDocs.length,
      };
    }

    // v17: Add design_doc_required flag to work orders
    const workOrders = (workOrdersRes.data || []).map((wo: any) => {
      const requiresDesignDoc = (
        (wo.tags || []).some((tag: string) =>
          ['feature', 'architecture', 'build', 'deploy'].includes(tag)
        ) &&
        !(wo.tags || []).some((tag: string) =>
          ['simple', 'fix', 'hotfix'].includes(tag)
        )
      );

      return {
        ...wo,
        design_doc_required: requiresDesignDoc && !wo.design_doc_id && ['ready', 'in_progress'].includes(wo.status),
      };
    });

    // Compute lesson stats
    const lessons = lessonsRes.data || [];
    const lessonStats = {
      total: lessons.length,
      promoted: lessons.filter((l: any) => l.promoted_at).length,
      unpromoted: lessons.filter((l: any) => !l.promoted_at).length,
      by_category: lessons.reduce((acc: Record<string, number>, l: any) => {
        acc[l.category] = (acc[l.category] || 0) + 1;
        return acc;
      }, {}),
      by_severity: lessons.reduce((acc: Record<string, number>, l: any) => {
        acc[l.severity] = (acc[l.severity] || 0) + 1;
        return acc;
      }, {}),
    };

    // Extract phase status from project brief
    const phaseStatus = {
      current_phase: project.current_phase || "unknown",
      completion_pct: project.completion_pct || 0,
      phases: project.phases || {},
    };

    // Daemon status from system_status
    const daemonStatus = (statusRes.data || []).find((s: any) => s.component === "daemon");

    // v15: Compute verification requirements
    const verificationCoverage = verificationCoverageRes.data || [];
    const totalCompleted = verificationCoverage.length;
    const verifiedCount = verificationCoverage.filter((w: any) => w.verification_status === 'verified').length;
    const verificationCoveragePct = totalCompleted > 0 ? Math.round((verifiedCount / totalCompleted) * 100) : 0;

    const verificationRequirements = {
      gate_enabled: true,
      required_for_tags: ['requires_verification'],
      enforcement_transition: 'in_progress → review',
      verification_coverage_pct: verificationCoveragePct,
      verified_last_30d: verifiedCount,
      completed_last_30d: totalCompleted,
    };

    // Build response
    const response = {
      loaded_at: loadedAt,
      project_code: projectCode,

      project,
      agents: agentsRes.data || [],
      work_orders: workOrders,
      capabilities: capsRes.data || [],
      decisions: decisionsRes.data || [],
      directives: directivesRes.data || [],
      system_status: statusRes.data || [],
      user_preferences: prefsRes.data || [],
      mcp_connectors: mcpRes.data || [],
      execution_logs: execLogsRes.data || [],

      recent_completions: completedWosRes.data || [],
      phase_status: phaseStatus,
      lesson_stats: lessonStats,
      directive_count: directiveCountRes.count || 0,
      daemon_status: daemonStatus ? {
        status: daemonStatus.status,
        last_heartbeat: daemonStatus.last_heartbeat,
        mode: daemonStatus.metadata?.mode,
      } : null,

      doc_status: docStatus,
      verification_requirements: verificationRequirements,

      summary: {
        agents_count: (agentsRes.data || []).length,
        active_work_orders: workOrders.filter((w: any) =>
          ["in_progress", "ready"].includes(w.status)).length,
        blocked_work_orders: workOrders.filter((w: any) =>
          w.status === "blocked").length,
        draft_work_orders: workOrders.filter((w: any) =>
          w.status === "draft").length,
        capabilities_count: (capsRes.data || []).length,
        hard_constraints: (directivesRes.data || []).filter((d: any) =>
          d.enforcement === "hard").length,
        completed_this_week: (completedWosRes.data || []).length,
        total_lessons: lessonStats.total,
        total_directives: directiveCountRes.count || 0,
        daemon_active: daemonStatus?.status === "active",
        doc_drift: docStatus.drift_detected,
        verification_coverage: verificationCoveragePct,
        design_doc_warnings: workOrders.filter((w: any) => w.design_doc_required).length,
      },

      errors: [
        projectRes.error,
        agentsRes.error,
        workOrdersRes.error,
        capsRes.error,
        decisionsRes.error,
        directivesRes.error,
        statusRes.error,
        prefsRes.error,
        mcpRes.error,
        execLogsRes.error,
        completedWosRes.error,
        lessonsRes.error,
        verificationCoverageRes.error,
      ].filter(Boolean).map(e => e?.message),
    };

    return new Response(JSON.stringify(response), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  } catch (error) {
    console.error("context-load error:", error);
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
