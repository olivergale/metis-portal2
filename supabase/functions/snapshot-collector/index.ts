import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.39.3';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    console.log('Starting platform health snapshot collection...');

    // Query all metrics in parallel
    const [
      woStats,
      qaStats,
      verificationStats,
      enforcerStats,
      lessonStats,
      autoApprovalStats,
      edgeFunctionStats,
      tokenStats,
      deadTables
    ] = await Promise.all([
      // Work order statistics
      supabase.rpc('execute_sql', {
        query: `
          SELECT 
            COUNT(*)::int as wo_total,
            COUNT(*) FILTER (WHERE status = 'done')::int as wo_done,
            COUNT(*) FILTER (WHERE status = 'cancelled')::int as wo_cancelled,
            COUNT(*) FILTER (WHERE status IN ('in_progress', 'review', 'pending_approval', 'ready'))::int as wo_in_flight
          FROM work_orders
        `
      }),
      
      // QA findings statistics
      supabase.rpc('execute_sql', {
        query: `
          SELECT 
            COUNT(*)::int as qa_findings_total,
            COUNT(*) FILTER (WHERE category = 'pass')::int as qa_pass_count,
            COUNT(*) FILTER (WHERE category = 'fail')::int as qa_fail_count
          FROM qa_findings
        `
      }),
      
      // Verification statistics
      supabase.from('work_orders')
        .select('verification_status', { count: 'exact', head: true })
        .not('verification_status', 'is', null),
      
      // Enforcer statistics
      supabase.rpc('execute_sql', {
        query: `
          SELECT 
            COUNT(DISTINCT run_id)::int as enforcer_runs_total,
            COUNT(*)::int as enforcer_findings_total
          FROM enforcer_findings
        `
      }),
      
      // Lessons statistics
      supabase.rpc('execute_sql', {
        query: `
          SELECT 
            COUNT(*)::int as lessons_total,
            COUNT(*) FILTER (WHERE promoted_at IS NOT NULL)::int as lessons_applied
          FROM lessons
        `
      }),
      
      // Auto-approval statistics
      supabase.rpc('execute_sql', {
        query: `
          SELECT 
            COUNT(*)::int as auto_approval_attempted,
            COUNT(*) FILTER (WHERE approved_at IS NOT NULL)::int as auto_approval_succeeded
          FROM work_orders
          WHERE requires_approval = false
        `
      }),
      
      // Edge function statistics (from system_manifest)
      supabase.rpc('execute_sql', {
        query: `
          SELECT 
            COUNT(*)::int as edge_functions_total,
            COUNT(*) FILTER (WHERE config->>'jwt_enabled' = 'true')::int as edge_functions_jwt_enabled
          FROM system_manifest
          WHERE component_type = 'edge_function'
        `
      }),
      
      // Token consumption (from work_order_execution_log)
      supabase.rpc('execute_sql', {
        query: `
          SELECT 
            COALESCE(SUM((detail->>'tokens_used')::int), 0)::bigint as total_tokens,
            COALESCE(SUM((detail->>'cost_usd')::numeric), 0)::numeric as total_cost
          FROM work_order_execution_log
          WHERE detail->>'tokens_used' IS NOT NULL
        `
      }),
      
      // Dead tables count (tables with 0 rows)
      supabase.rpc('execute_sql', {
        query: `
          SELECT COUNT(*)::int as dead_tables_count
          FROM (
            SELECT schemaname, tablename
            FROM pg_tables
            WHERE schemaname = 'public'
            AND tablename NOT LIKE 'pg_%'
          ) t
          LEFT JOIN LATERAL (
            SELECT count(*) as row_count
            FROM information_schema.tables
            WHERE table_schema = t.schemaname AND table_name = t.tablename
          ) rc ON true
          WHERE NOT EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_schema = t.schemaname AND table_name = t.tablename
          )
          OR (SELECT count(*) FROM pg_stat_user_tables WHERE schemaname = t.schemaname AND relname = t.tablename AND n_live_tup = 0) > 0
        `
      })
    ]);

    // Parse results
    const woData = woStats.data?.[0] || {};
    const qaData = qaStats.data?.[0] || {};
    const verificationCount = verificationStats.count || 0;
    const enforcerData = enforcerStats.data?.[0] || {};
    const lessonData = lessonStats.data?.[0] || {};
    const autoApprovalData = autoApprovalStats.data?.[0] || {};
    const edgeFunctionData = edgeFunctionStats.data?.[0] || {};
    const tokenData = tokenStats.data?.[0] || {};
    const deadTablesData = deadTables.data?.[0] || {};

    // Calculate percentages
    const woCancelRate = woData.wo_total > 0 
      ? Math.round((woData.wo_cancelled / woData.wo_total) * 1000) / 10 
      : 0;
    
    const qaPassRate = qaData.qa_findings_total > 0 
      ? Math.round((qaData.qa_pass_count / qaData.qa_findings_total) * 1000) / 10 
      : 0;
    
    const verificationPassRate = verificationCount > 0 
      ? Math.round((verificationCount / verificationCount) * 1000) / 10 
      : 0;
    
    const enforcerCoverage = woData.wo_total > 0 
      ? Math.round((enforcerData.enforcer_runs_total / woData.wo_total) * 1000) / 10 
      : 0;
    
    const lessonApplicationRate = lessonData.lessons_total > 0 
      ? Math.round((lessonData.lessons_applied / lessonData.lessons_total) * 1000) / 10 
      : 0;
    
    const autoApprovalSuccessRate = autoApprovalData.auto_approval_attempted > 0 
      ? Math.round((autoApprovalData.auto_approval_succeeded / autoApprovalData.auto_approval_attempted) * 1000) / 10 
      : 0;
    
    const jwtCoverage = edgeFunctionData.edge_functions_total > 0 
      ? Math.round((edgeFunctionData.edge_functions_jwt_enabled / edgeFunctionData.edge_functions_total) * 1000) / 10 
      : 0;

    // Get triggered_by from request body or default to 'cron'
    const body = req.method === 'POST' ? await req.json() : {};
    const triggeredBy = body.triggered_by || 'cron';

    // Insert snapshot
    const { data: snapshot, error: insertError } = await supabase
      .from('platform_health_snapshots')
      .insert({
        wo_total: woData.wo_total || 0,
        wo_done: woData.wo_done || 0,
        wo_cancelled: woData.wo_cancelled || 0,
        wo_cancel_rate_pct: woCancelRate,
        wo_in_flight: woData.wo_in_flight || 0,
        qa_findings_total: qaData.qa_findings_total || 0,
        qa_pass_count: qaData.qa_pass_count || 0,
        qa_fail_count: qaData.qa_fail_count || 0,
        qa_pass_rate_pct: qaPassRate,
        verification_total: verificationCount,
        verification_passed: verificationCount,
        verification_pass_rate_pct: verificationPassRate,
        enforcer_runs_total: enforcerData.enforcer_runs_total || 0,
        enforcer_findings_total: enforcerData.enforcer_findings_total || 0,
        enforcer_coverage_pct: enforcerCoverage,
        lessons_total: lessonData.lessons_total || 0,
        lessons_applied: lessonData.lessons_applied || 0,
        lesson_application_rate_pct: lessonApplicationRate,
        auto_approval_attempted: autoApprovalData.auto_approval_attempted || 0,
        auto_approval_succeeded: autoApprovalData.auto_approval_succeeded || 0,
        auto_approval_success_rate_pct: autoApprovalSuccessRate,
        edge_functions_total: edgeFunctionData.edge_functions_total || 0,
        edge_functions_jwt_enabled: edgeFunctionData.edge_functions_jwt_enabled || 0,
        jwt_coverage_pct: jwtCoverage,
        total_tokens_consumed: tokenData.total_tokens || 0,
        total_cost_usd: tokenData.total_cost || 0,
        dead_tables_count: deadTablesData.dead_tables_count || 0,
        triggered_by: triggeredBy,
        metadata: body.metadata || {}
      })
      .select()
      .single();

    if (insertError) {
      console.error('Error inserting snapshot:', insertError);
      throw insertError;
    }

    console.log('Platform health snapshot collected:', snapshot.id);

    return new Response(
      JSON.stringify({ success: true, snapshot }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error) {
    console.error('Error in snapshot-collector:', error);
    return new Response(
      JSON.stringify({ error: error.message }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
