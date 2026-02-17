// DEPRECATED WO-0381: This function is replaced by sentinel edge function
// All health-check functionality (stuck WO detection, trending, etc) consolidated into sentinel
// This function will be removed in a future deployment
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

interface HealthMetrics {
  failure_rate: {
    last_hour: number;
    last_24h: number;
    trending: 'up' | 'down' | 'stable';
  };
  agent_success_rates: Array<{
    agent_name: string;
    domain: string;
    success_rate: number;
    total_wos: number;
    failed_wos: number;
  }>;
  dependency_alerts: Array<{
    wo_id: string;
    wo_slug: string;
    chain_depth: number;
    needs_decomposition: boolean;
  }>;
  self_heal_failures: Array<{
    parent_wo_id: string;
    parent_slug: string;
    attempt_count: number;
    needs_escalation: boolean;
  }>;
  stuck_wos: Array<{
    id: string;
    slug: string;
    status: string;
    last_activity: string;
    minutes_stuck: number;
  }>;
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    // AC#5: Handle liveness-check action from POST body
    if (req.method === "POST") {
      const body = await req.json();
      if (body.action === "liveness-check") {
        const workOrderId = body.work_order_id;
        if (workOrderId) {
          console.log(`[LIVENESS] Checking specific WO: ${workOrderId}`);
          const { data: livenessResult, error: livenessError } = await supabase.rpc(
            "check_wo_liveness",
            { p_wo_id: workOrderId }
          );
          
          if (livenessError) {
            console.error("[LIVENESS] Error:", livenessError);
            return new Response(
              JSON.stringify({ error: livenessError.message }),
              { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
            );
          }
          
          console.log("[LIVENESS] Result:", livenessResult);
          
          // Log to execution_log per AC#4
          await supabase.from("work_order_execution_log").insert({
            work_order_id: workOrderId,
            agent_name: "ops",
            phase: "stuck_detection",
            event_type: "liveness_check",
            detail: { liveness_result: livenessResult, checked_at: new Date().toISOString() }
          });
          
          return new Response(
            JSON.stringify({ success: true, liveness_result: livenessResult }),
            { headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }
        return new Response(
          JSON.stringify({ error: "work_order_id required for liveness-check" }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
    }

    console.log("Starting systemic health diagnosis...");

    const metrics: HealthMetrics = {
      failure_rate: { last_hour: 0, last_24h: 0, trending: 'stable' },
      agent_success_rates: [],
      dependency_alerts: [],
      self_heal_failures: [],
      stuck_wos: [],
    };

    // 1. FAILURE RATE TRENDING (3+ failures in 1 hour triggers alert)
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

    const { data: recentFailures, error: failureError } = await supabase
      .from('work_orders')
      .select('id, slug, completed_at, status')
      .eq('status', 'failed')
      .gte('completed_at', twentyFourHoursAgo)
      .order('completed_at', { ascending: false });

    if (failureError) throw failureError;

    const failuresLastHour = recentFailures?.filter(wo => 
      wo.completed_at && wo.completed_at >= oneHourAgo
    ).length || 0;

    const failuresLast24h = recentFailures?.length || 0;

    // Determine trend
    const failuresPerHour24h = failuresLast24h / 24;
    let trending: 'up' | 'down' | 'stable' = 'stable';
    if (failuresLastHour > failuresPerHour24h * 1.5) trending = 'up';
    else if (failuresLastHour < failuresPerHour24h * 0.5) trending = 'down';

    metrics.failure_rate = {
      last_hour: failuresLastHour,
      last_24h: failuresLast24h,
      trending
    };

    // Create alert WO if threshold exceeded
    if (failuresLastHour >= 3) {
      console.log(` -- HIGH FAILURE RATE: ${failuresLastHour} failures in last hour`);
      
      const { error: alertError } = await supabase.rpc('create_draft_work_order', {
        p_slug: null,
        p_name: ` -- High Failure Rate Alert: ${failuresLastHour} failures in 1 hour`,
        p_objective: `Investigate spike in work order failures. ${failuresLastHour} WOs failed in the last hour (trending ${trending}). Recent failures: ${recentFailures?.slice(0, 5).map(f => f.slug).join(', ')}`,
        p_priority: 'p0_critical',
        p_source: 'daemon',
        p_tags: ['health-alert', 'failure-spike', 'ops']
      });

      if (alertError) console.error('Failed to create alert WO:', alertError);
    }

    // 2. AGENT SUCCESS RATE TRACKING PER DOMAIN
    const { data: agentStats, error: agentError } = await supabase
      .from('work_orders')
      .select('assigned_to, status, tags')
      .in('status', ['done', 'failed'])
      .gte('completed_at', twentyFourHoursAgo);

    if (agentError) throw agentError;

    // Get agent names
    const { data: agents, error: agentsError } = await supabase
      .from('agents')
      .select('id, name');

    if (agentsError) throw agentsError;

    const agentMap = new Map(agents?.map(a => [a.id, a.name]) || []);
    const agentMetrics = new Map<string, { total: number; failed: number; domains: Set<string> }>();

    agentStats?.forEach(wo => {
      if (!wo.assigned_to) return;
      
      const agentName = agentMap.get(wo.assigned_to) || 'unknown';
      const key = agentName;
      
      if (!agentMetrics.has(key)) {
        agentMetrics.set(key, { total: 0, failed: 0, domains: new Set() });
      }
      
      const metrics = agentMetrics.get(key)!;
      metrics.total++;
      if (wo.status === 'failed') metrics.failed++;
      
      // Extract domain from tags (supabase, migration, portal-frontend, etc)
      wo.tags?.forEach((tag: string) => {
        if (!['remediation', 'auto-qa-loop', 'health-alert'].includes(tag)) {
          metrics.domains.add(tag);
        }
      });
    });

    agentMetrics.forEach((stats, agentName) => {
      const success_rate = stats.total > 0 ? ((stats.total - stats.failed) / stats.total) * 100 : 0;
      const domain = Array.from(stats.domains).join(',') || 'general';
      
      metrics.agent_success_rates.push({
        agent_name: agentName,
        domain,
        success_rate: Math.round(success_rate * 100) / 100,
        total_wos: stats.total,
        failed_wos: stats.failed
      });
    });

    // 3. DEPENDENCY CHAIN DEPTH ALERTS (chains deeper than 5 need decomposition)
    const { data: dependencyChains, error: depError } = await supabase
      .from('work_orders')
      .select('id, slug, depends_on')
      .in('status', ['draft', 'ready', 'pending_approval', 'in_progress', 'blocked'])
      .not('depends_on', 'is', null);

    if (depError) throw depError;

    const calculateDepth = async (woId: string, visited = new Set<string>()): Promise<number> => {
      if (visited.has(woId)) return 0; // Circular dependency guard
      visited.add(woId);

      const { data: wo } = await supabase
        .from('work_orders')
        .select('depends_on')
        .eq('id', woId)
        .single();

      if (!wo?.depends_on || wo.depends_on.length === 0) return 1;

      const depths = await Promise.all(
        wo.depends_on.map((depId: string) => calculateDepth(depId, new Set(visited)))
      );

      return 1 + Math.max(...depths);
    };

    for (const wo of dependencyChains || []) {
      if (wo.depends_on && wo.depends_on.length > 0) {
        const depth = await calculateDepth(wo.id);
        
        if (depth > 5) {
          metrics.dependency_alerts.push({
            wo_id: wo.id,
            wo_slug: wo.slug,
            chain_depth: depth,
            needs_decomposition: true
          });

          console.log(` -- DEEP DEPENDENCY CHAIN: ${wo.slug} has depth ${depth}`);
        }
      }
    }

    // 4. AUTO-ESCALATION AFTER 2 FAILED SELF-HEAL ATTEMPTS
    const { data: remediationWOs, error: remError } = await supabase
      .from('work_orders')
      .select('id, slug, parent_id, status, tags')
      .contains('tags', ['remediation'])
      .eq('status', 'failed');

    if (remError) throw remError;

    const parentFailures = new Map<string, number>();

    remediationWOs?.forEach(wo => {
      if (wo.parent_id) {
        parentFailures.set(wo.parent_id, (parentFailures.get(wo.parent_id) || 0) + 1);
      }
    });

    for (const [parentId, failCount] of parentFailures.entries()) {
      if (failCount >= 2) {
        const { data: parent } = await supabase
          .from('work_orders')
          .select('slug')
          .eq('id', parentId)
          .single();

        metrics.self_heal_failures.push({
          parent_wo_id: parentId,
          parent_slug: parent?.slug || 'unknown',
          attempt_count: failCount,
          needs_escalation: true
        });

        console.log(` -- SELF-HEAL FAILURE: ${parent?.slug} failed ${failCount} remediation attempts`);

        // Create escalation WO
        const { error: escalateError } = await supabase.rpc('create_draft_work_order', {
          p_slug: null,
          p_name: ` -- Escalation: ${parent?.slug} failed ${failCount} self-heal attempts`,
          p_objective: `Manual intervention required. Work order ${parent?.slug} (${parentId}) has failed ${failCount} automated remediation attempts. Review execution logs and determine root cause.`,
          p_priority: 'p0_critical',
          p_source: 'daemon',
          p_tags: ['escalation', 'manual-review', 'ops']
        });

        if (escalateError) console.error('Failed to create escalation WO:', escalateError);
      }
    }

    // 5. STUCK WO DETECTION (existing functionality - 10min threshold)
    const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();

    const { data: stuckWOs, error: stuckError } = await supabase
      .from('work_orders')
      .select(`
        id,
        slug,
        status,
        updated_at,
        work_order_execution_log!inner(created_at)
      `)
      .eq('status', 'in_progress')
      .order('created_at', { ascending: false, foreignTable: 'work_order_execution_log' });

    if (stuckError) throw stuckError;

    const now = Date.now();
    stuckWOs?.forEach((wo: any) => {
      const lastActivity = wo.work_order_execution_log?.[0]?.created_at || wo.updated_at;
      const minutesSinceActivity = (now - new Date(lastActivity).getTime()) / (1000 * 60);

      if (minutesSinceActivity > 10) {
        metrics.stuck_wos.push({
          id: wo.id,
          slug: wo.slug,
          status: wo.status,
          last_activity: lastActivity,
          minutes_stuck: Math.round(minutesSinceActivity)
        });
      }
    });

    // AC#1-4: LIVENESS CHECK FOR ZOMBIE WOs (in_progress > 7 minutes)
    const sevenMinutesAgo = new Date(Date.now() - 7 * 60 * 1000).toISOString();
    
    const { data: zombieCandidates, error: zombieError } = await supabase
      .from('work_orders')
      .select('id, slug, status, started_at, updated_at')
      .eq('status', 'in_progress')
      .lt('started_at', sevenMinutesAgo);

    if (zombieError) {
      console.error("[LIVENESS] Error fetching zombie candidates:", zombieError);
    } else if (zombieCandidates && zombieCandidates.length > 0) {
      console.log(`[LIVENESS] Found ${zombieCandidates.length} zombie candidates`);
      
      for (const wo of zombieCandidates) {
        // AC#3: Call check_wo_liveness for each candidate
        const { data: livenessResult, error: livenessError } = await supabase.rpc(
          "check_wo_liveness",
          { p_wo_id: wo.id }
        );
        
        if (livenessError) {
          console.error(`[LIVENESS] Error checking WO ${wo.slug}:`, livenessError);
        } else {
          console.log(`[LIVENESS] ${wo.slug}:`, livenessResult);
          
          // AC#4: Log each result to execution_log with phase=stuck_detection and agent_name=ops
          await supabase.from("work_order_execution_log").insert({
            work_order_id: wo.id,
            agent_name: "ops",
            phase: "stuck_detection",
            event_type: "liveness_check",
            detail: { 
              slug: wo.slug,
              liveness_result: livenessResult, 
              checked_at: new Date().toISOString(),
              threshold_minutes: 7
            }
          });
        }
      }
    }

    // 6. STALE WO_EVENTS CHECK (pending events older than 5 minutes) - WO-0621
    console.log("Checking for stale wo_events...");
    
    const { data: staleEventsResult, error: staleEventsError } = await supabase.rpc('check_stale_wo_events');
    
    if (staleEventsError) {
      console.error('Error checking stale wo_events:', staleEventsError);
    } else {
      console.log(`Stale event check complete: ${staleEventsResult} stale events processed`);
    }

    // 7. SAVE TO PLATFORM_HEALTH_SNAPSHOTS
    const health_status = 
      metrics.failure_rate.last_hour >= 3 || metrics.self_heal_failures.length > 0 
        ? 'critical' 
        : metrics.dependency_alerts.length > 0 || metrics.stuck_wos.length > 0
        ? 'warning'
        : 'healthy';

    const snapshot = {
      snapshot_at: new Date().toISOString(),
      triggered_by: 'health-check',
      metadata: {
        health_status,
        systemic_diagnosis: {
          failure_rate: metrics.failure_rate,
          agent_success_rates: metrics.agent_success_rates,
          dependency_alerts: metrics.dependency_alerts,
          self_heal_failures: metrics.self_heal_failures,
          stuck_wos: metrics.stuck_wos
        },
        summary: {
          failure_rate_last_hour: metrics.failure_rate.last_hour,
          failure_rate_last_24h: metrics.failure_rate.last_24h,
          trending: metrics.failure_rate.trending,
          total_agents_tracked: metrics.agent_success_rates.length,
          dependency_alerts_count: metrics.dependency_alerts.length,
          self_heal_failures_count: metrics.self_heal_failures.length,
          stuck_wos_count: metrics.stuck_wos.length
        }
      }
    };

    const { error: snapshotError } = await supabase
      .from('platform_health_snapshots')
      .insert(snapshot);

    if (snapshotError) console.error('Failed to save health snapshot:', snapshotError);

    console.log("Health check complete:", {
      status: health_status,
      summary: snapshot.metadata.summary
    });

    return new Response(
      JSON.stringify({ 
        success: true, 
        health_status,
        metrics,
        summary: snapshot.metadata.summary,
        timestamp: snapshot.snapshot_at
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );

  } catch (error) {
    console.error("Health check error:", error);
    return new Response(
      JSON.stringify({ error: error.message }),
      { 
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      }
    );
  }
});
