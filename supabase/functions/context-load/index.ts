// context-load/index.ts - v18
// v18: Added workspace snapshot with GitHub tree caching, DB schema, and recent mutations (WO-0526)
// v17: Added design_doc_required flag to work_orders (WO-PRD-GATE)
// v16: Fix doc_status ÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ use project UUID (not code string) for project_documents query + call check_doc_currency() RPC
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
  work_order_id?: string;
}

interface WorkspaceSnapshot {
  repository_structure: string;
  database_schema: string;
  recent_mutations: string;
  total_size: number;
}

// Helper: Fetch GitHub tree with caching
async function fetchGitHubTree(supabase: any, githubToken?: string): Promise<any> {
  const cacheKey = 'github_tree_main';
  const ttlMinutes = 60;
  
  // Check cache
  const { data: cached } = await supabase
    .from('workspace_cache')
    .select('content, cached_at, ttl_minutes')
    .eq('cache_key', cacheKey)
    .single();
  
  if (cached) {
    const cacheAge = Date.now() - new Date(cached.cached_at).getTime();
    const cacheValid = cacheAge < cached.ttl_minutes * 60 * 1000;
    if (cacheValid) {
      return cached.content;
    }
  }
  
  // Fetch from GitHub
  const token = githubToken || Deno.env.get('GITHUB_TOKEN');
  if (!token) {
    return null; // Skip if no token available
  }
  
  const response = await fetch(
    'https://api.github.com/repos/olivergale/metis-portal2/git/trees/main?recursive=true',
    {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/vnd.github.v3+json',
      },
    }
  );
  
  if (!response.ok) {
    console.error('GitHub API error:', response.status);
    return null;
  }
  
  const data = await response.json();
  
  // Cache the result
  await supabase
    .from('workspace_cache')
    .upsert({
      cache_key: cacheKey,
      content: data,
      cached_at: new Date().toISOString(),
      ttl_minutes: ttlMinutes,
    });
  
  return data;
}

// Helper: Build workspace snapshot
async function buildWorkspaceSnapshot(
  supabase: any,
  workOrderId?: string,
  workOrderObjective?: string
): Promise<WorkspaceSnapshot> {
  const parts: string[] = [];
  let totalSize = 0;
  
  // 1. Repository Structure (GitHub tree filtered to supabase/functions/)
  const githubTree = await fetchGitHubTree(supabase);
  let repoStructure = '## Repository Structure\n\n';
  
  if (githubTree?.tree) {
    const functionFiles = githubTree.tree
      .filter((item: any) => item.path.startsWith('supabase/functions/'))
      .sort((a: any, b: any) => a.path.localeCompare(b.path));
    
    // Build tree as indented list
    let lastDir = '';
    for (const item of functionFiles) {
      const path = item.path.replace('supabase/functions/', '');
      const parts = path.split('/');
      const indent = '  '.repeat(parts.length - 1);
      const name = parts[parts.length - 1];
      
      // Add directory header if changed
      if (parts.length > 1 && parts[0] !== lastDir) {
        repoStructure += `\n**${parts[0]}/**\n`;
        lastDir = parts[0];
      }
      
      if (item.type === 'blob') {
        repoStructure += `${indent}- ${name}\n`;
      }
    }
  } else {
    repoStructure += '_GitHub tree not available_\n';
  }
  
  parts.push(repoStructure);
  totalSize += repoStructure.length;
  
  // 2. Database Schema (tables and columns from information_schema)
  const { data: tables } = await supabase.rpc('run_sql', {
    query: `
      SELECT 
        t.table_name,
        array_agg(c.column_name ORDER BY c.ordinal_position) as columns
      FROM information_schema.tables t
      LEFT JOIN information_schema.columns c 
        ON t.table_name = c.table_name 
        AND t.table_schema = c.table_schema
      WHERE t.table_schema = 'public'
        AND t.table_type = 'BASE TABLE'
      GROUP BY t.table_name
      ORDER BY t.table_name
    `
  }).catch(() => ({ data: null }));
  
  let dbSchema = '## Database Schema\n\n';
  if (tables) {
    for (const table of tables) {
      dbSchema += `**${table.table_name}**: ${table.columns.join(', ')}\n`;
    }
  } else {
    dbSchema += '_Schema not available_\n';
  }
  
  parts.push(dbSchema);
  totalSize += dbSchema.length;
  
  // 3. Recent Mutations (last 24h from state_mutations)
  const oneDayAgo = new Date(Date.now() - 86400000).toISOString();
  const { data: mutations } = await supabase
    .from('state_mutations')
    .select('mutation_type, target_table, created_at, work_order_id')
    .gte('created_at', oneDayAgo)
    .order('created_at', { ascending: false })
    .limit(20);
  
  let recentMutations = '## Recent System Mutations (24h)\n\n';
  if (mutations && mutations.length > 0) {
    const grouped: Record<string, any[]> = {};
    for (const m of mutations) {
      const key = m.target_table;
      if (!grouped[key]) grouped[key] = [];
      grouped[key].push(m);
    }
    
    for (const [table, muts] of Object.entries(grouped)) {
      const types = muts.map(m => m.mutation_type).join(', ');
      recentMutations += `- **${table}**: ${muts.length} changes (${types})\n`;
    }
  } else {
    recentMutations += '_No recent mutations_\n';
  }
  
  parts.push(recentMutations);
  totalSize += recentMutations.length;
  
  // 4. Size guard: if over 4000 chars, reduce detail
  if (totalSize > 4000) {
    // Reduce repo structure to top-level only
    repoStructure = '## Repository Structure\n\n';
    if (githubTree?.tree) {
      const topLevel = new Set(
        githubTree.tree
          .filter((item: any) => item.path.startsWith('supabase/functions/'))
          .map((item: any) => item.path.replace('supabase/functions/', '').split('/')[0])
      );
      repoStructure += Array.from(topLevel).map(d => `- ${d}/`).join('\n') + '\n';
    }
    
    // Reduce schema to only tables mentioned in WO objective
    if (workOrderObjective && tables) {
      const mentionedTables = tables.filter((t: any) => 
        workOrderObjective.toLowerCase().includes(t.table_name.toLowerCase())
      );
      
      if (mentionedTables.length > 0) {
        dbSchema = '## Database Schema (filtered)\n\n';
        for (const table of mentionedTables) {
          dbSchema += `**${table.table_name}**: ${table.columns.join(', ')}\n`;
        }
      }
    }
    
    // Recalculate
    parts.length = 0;
    parts.push(repoStructure, dbSchema, recentMutations);
    totalSize = parts.reduce((sum, p) => sum + p.length, 0);
  }
  
  return {
    repository_structure: repoStructure,
    database_schema: dbSchema,
    recent_mutations: recentMutations,
    total_size: totalSize,
  };
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
    const workOrderId = body.work_order_id;

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

      // 6. Directives (system rules) ÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ exclude portal_only directives (v13)
      supabase.from("system_directives")
        .select("name, content, enforcement, priority")
        .eq("active", true)
        .in("context_filter", ["all", "executor_only"])
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
      enforcement_transition: 'in_progress ÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ review',
      verification_coverage_pct: verificationCoveragePct,
      verified_last_30d: verifiedCount,
      completed_last_30d: totalCompleted,
    };

    // v18: Build workspace snapshot (WO-0526)
    let workspaceSnapshot: WorkspaceSnapshot | null = null;
    
    if (workOrderId) {
      // Fetch WO objective for context filtering
      const { data: wo } = await supabase
        .from('work_orders')
        .select('objective')
        .eq('id', workOrderId)
        .single()
        .catch(() => ({ data: null }));
      
      const currentWoObjective = wo?.objective;
      
      workspaceSnapshot = await buildWorkspaceSnapshot(
        supabase,
        workOrderId,
        currentWoObjective
      );
    }

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
      workspace_snapshot: workspaceSnapshot,

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
