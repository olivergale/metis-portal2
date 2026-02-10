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

    // Query all metrics in parallel using Supabase client directly
    const [
      woStats,
      qaStats,
      verificationStats,
      enforcerRuns,
      enforcerFindings,
      lessonStats,
      autoApprovalStats,
      edgeFunctionStats,
      deadTablesResult
    ] = await Promise.all([
      // Work order statistics
      supabase.from('work_orders').select('status', { count: 'exact', head: false }),
      
      // QA findings statistics
      supabase.from('qa_findings').select('category', { count: 'exact', head: false }),
      
      // Verification statistics
      supabase.from('work_orders')
        .select('verification_status', { count: 'exact', head: true })
        .not('verification_status', 'is', null),
      
      // Enforcer runs count
      supabase.from('enforcer_findings').select('enforcer_run_id', { count: 'exact', head: false }),
      
      // Enforcer findings count
      supabase.from('enforcer_findings').select('id', { count: 'exact', head: true }),
      
      // Lessons statistics
      supabase.from('lessons').select('promoted_at', { count: 'exact', head: false }),
      
      // Auto-approval statistics
      supabase.from('work_orders')
        .select('approved_at', { count: 'exact', head: false })
        .eq('requires_approval', false),
      
      // Edge function statistics (from system_manifest)
      supabase.from('system_manifest')
        .select('config', { count: 'exact', head: false })
        .eq('component_type', 'edge_function'),
      
      // Dead tables count from pg_stat_user_tables
      supabase.rpc('get_dead_tables_count').catch(() => ({ data: 0, error: null }))
    ]);

    // Parse results
    const woTotal = woStats.count || 0;
    const woDone = woStats.data?.filter((w: any) => w.status === 'done').length || 0;
    const woCancelled = woStats.data?.filter((w: any) => w.status === 'cancelled').length || 0;
    const woInFlight = woStats.data?.filter((w: any) => 
      ['in_progress', 'review', 'pending_approval', 'ready'].includes(w.status)
    ).length || 0;
    
    const qaTotal = qaStats.count || 0;
    const qaPass = qaStats.data?.filter((q: any) => q.category === 'pass').length || 0;
    const qaFail = qaStats.data?.filter((q: any) => q.category === 'fail').length || 0;
    
    const verificationCount = verificationStats.count || 0;
    
    // Count unique enforcer run IDs
    const uniqueRunIds = new Set(enforcerRuns.data?.map((r: any) => r.enforcer_run_id) || []);
    const enforcerRunsTotal = uniqueRunIds.size;
    const enforcerFindingsTotal = enforcerFindings.count || 0;
    
    const lessonsTotal = lessonStats.count || 0;
    const lessonsApplied = lessonStats.data?.filter((l: any) => l.promoted_at !== null).length || 0;
    
    const autoApprovalAttempted = autoApprovalStats.count || 0;
    const autoApprovalSucceeded = autoApprovalStats.data?.filter((a: any) => a.approved_at !== null).length || 0;
    
    const edgeFunctionsTotal = edgeFunctionStats.count || 0;
    const edgeFunctionsJwtEnabled = edgeFunctionStats.data?.filter((e: any) => 
      e.config?.jwt_enabled === true
    ).length || 0;
    
    const deadTablesCount = typeof deadTablesResult.data === 'number' ? deadTablesResult.data : 0;

    // Calculate percentages
    const woCancelRate = woTotal > 0 
      ? Math.round((woCancelled / woTotal) * 1000) / 10 
      : 0;
    
    const qaPassRate = qaTotal > 0 
      ? Math.round((qaPass / qaTotal) * 1000) / 10 
      : 0;
    
    const verificationPassRate = verificationCount > 0 
      ? Math.round((verificationCount / verificationCount) * 1000) / 10 
      : 0;
    
    const enforcerCoverage = woTotal > 0 
      ? Math.round((enforcerRunsTotal / woTotal) * 1000) / 10 
      : 0;
    
    const lessonApplicationRate = lessonsTotal > 0 
      ? Math.round((lessonsApplied / lessonsTotal) * 1000) / 10 
      : 0;
    
    const autoApprovalSuccessRate = autoApprovalAttempted > 0 
      ? Math.round((autoApprovalSucceeded / autoApprovalAttempted) * 1000) / 10 
      : 0;
    
    const jwtCoverage = edgeFunctionsTotal > 0 
      ? Math.round((edgeFunctionsJwtEnabled / edgeFunctionsTotal) * 1000) / 10 
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
