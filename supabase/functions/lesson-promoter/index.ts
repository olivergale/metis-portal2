// lesson-promoter/index.ts v3
// WO-227EA4AE: Added Tier 4 self-update — detect recurring lesson gaps, auto-create draft WOs
// Changes from v2:
//   - Tier 4: calls detect_lesson_gaps() RPC, then auto_create_gap_wo() for each gap without open WO
//   - Version bumped to v3

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  const url = new URL(req.url);
  const action = url.pathname.split('/').pop();
  const dryRun = url.searchParams.get('dry_run') === 'true';

  try {
    // GET /status - comprehensive lesson dashboard
    if (req.method === "GET" && action === "status") {
      const [pending, promoted, versions, categoryCounts] = await Promise.all([
        supabase
          .from('lessons')
          .select('id, pattern, category, severity, reported_by, review_status, created_at')
          .eq('applied_to_directives', false)
          .in('review_status', ['pending'])
          .order('severity')
          .order('created_at', { ascending: true }),
        supabase
          .from('lessons')
          .select('id, pattern, severity, directive_id, promoted_at, promoted_by')
          .eq('applied_to_directives', true)
          .order('promoted_at', { ascending: false })
          .limit(10),
        supabase
          .from('directive_versions')
          .select('directive_id, version_number, change_reason, changed_by, created_at')
          .order('created_at', { ascending: false })
          .limit(10),
        supabase.rpc('get_lesson_category_counts'),
      ]);

      // Group pending by severity
      const pendingBySeverity: Record<string, any[]> = {};
      for (const l of (pending.data || [])) {
        const sev = l.severity || 'unknown';
        if (!pendingBySeverity[sev]) pendingBySeverity[sev] = [];
        pendingBySeverity[sev].push(l);
      }

      return new Response(JSON.stringify({
        pending_count: pending.data?.length || 0,
        pending_by_severity: pendingBySeverity,
        recent_promotions: promoted.data || [],
        recent_versions: versions.data || [],
        category_counts: categoryCounts.data || [],
        checked_at: new Date().toISOString()
      }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // POST /run - execute promotion batch (cron entry point)
    if (req.method === "POST" && (action === "run" || action === "lesson-promoter")) {
      const results: any[] = [];

      // Tier 1: Error-severity lessons → auto-promote to soft directives
      const { data: errorLessons } = await supabase
        .from('lessons')
        .select('id, pattern, category, severity, context, rule, reported_by')
        .eq('applied_to_directives', false)
        .eq('severity', 'error')
        .in('review_status', ['pending'])
        .order('created_at', { ascending: true })
        .limit(5);

      for (const lesson of (errorLessons || [])) {
        if (dryRun) {
          results.push({ lesson_id: lesson.id, pattern: lesson.pattern, severity: 'error', action: 'would_promote', dry_run: true });
          continue;
        }
        try {
          const { data: directiveId, error } = await supabase.rpc('promote_lesson_to_directive', {
            p_lesson_id: lesson.id,
            p_directive_type: 'rule',
            p_enforcement: 'soft',
            p_priority: 70,
            p_promoted_by: 'lesson-promoter-cron'
          });
          if (error) {
            results.push({ lesson_id: lesson.id, promoted: false, error: error.message });
          } else {
            results.push({ lesson_id: lesson.id, pattern: lesson.pattern, promoted: true, directive_id: directiveId, tier: 'error' });
          }
        } catch (err: any) {
          results.push({ lesson_id: lesson.id, promoted: false, error: err.message });
        }
      }

      // Tier 2: Warning-severity lessons → flag for review (don't auto-promote)
      const { data: warningLessons } = await supabase
        .from('lessons')
        .select('id, pattern, category, severity')
        .eq('applied_to_directives', false)
        .eq('severity', 'warning')
        .eq('review_status', 'pending')
        .order('created_at', { ascending: true })
        .limit(10);

      const warningCount = warningLessons?.length || 0;
      if (warningCount > 0 && !dryRun) {
        results.push({
          tier: 'warning',
          count: warningCount,
          action: 'flagged_for_review',
          lesson_ids: warningLessons!.map(l => l.id)
        });
      }

      // Tier 3: Check for pattern clustering (same category, 3+ lessons → escalate)
      const { data: clusters } = await supabase
        .from('lessons')
        .select('category')
        .eq('applied_to_directives', false)
        .in('review_status', ['pending']);

      const clusterCounts: Record<string, number> = {};
      for (const l of (clusters?.filter(c => c.category) || [])) {
        clusterCounts[l.category!] = (clusterCounts[l.category!] || 0) + 1;
      }

      const hotClusters = Object.entries(clusterCounts).filter(([_, count]) => count >= 3);
      if (hotClusters.length > 0) {
        results.push({
          tier: 'cluster_alert',
          hot_categories: hotClusters.map(([cat, count]) => ({ category: cat, count })),
          action: 'pattern_detected'
        });
      }

      // Tier 4: Self-update — detect recurring gaps and auto-create draft WOs
      try {
        const { data: gaps, error: gapError } = await supabase.rpc('detect_lesson_gaps');

        if (gapError) {
          results.push({ tier: 'self_update', action: 'error', error: gapError.message });
        } else {
          for (const gap of (gaps || [])) {
            if (gap.has_open_wo) {
              results.push({
                tier: 'self_update', category: gap.category,
                action: 'skipped_existing_wo', lesson_count: gap.lesson_count
              });
              continue;
            }

            if (dryRun) {
              results.push({
                tier: 'self_update', category: gap.category,
                action: 'would_create_wo', lesson_count: gap.lesson_count,
                sample_pattern: gap.sample_pattern, dry_run: true
              });
              continue;
            }

            const { data: woId, error: woErr } = await supabase.rpc('auto_create_gap_wo', {
              p_category: gap.category,
              p_pattern: gap.sample_pattern,
              p_rule: gap.sample_rule,
              p_severity: gap.severities?.[0] || 'warning'
            });

            results.push({
              tier: 'self_update', category: gap.category,
              action: woErr ? 'failed' : 'wo_created',
              work_order_id: woId, error: woErr?.message,
              lesson_count: gap.lesson_count
            });
          }
        }
      } catch (selfUpdateErr: any) {
        results.push({ tier: 'self_update', action: 'error', error: selfUpdateErr.message });
      }

      const promotedCount = results.filter((r: any) => r.promoted).length;
      const wosCreated = results.filter((r: any) => r.action === 'wo_created').length;

      return new Response(JSON.stringify({
        promoted_count: promotedCount,
        wos_created: wosCreated,
        total_processed: (errorLessons?.length || 0) + warningCount,
        dry_run: dryRun,
        results,
        run_at: new Date().toISOString(),
        version: 'v3'
      }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // POST /promote-single - manually promote a specific lesson
    if (req.method === "POST" && action === "promote-single") {
      const body = await req.json();
      const { lesson_id, enforcement = 'soft', priority = 50, directive_type = 'rule' } = body;

      if (!lesson_id) {
        return new Response(JSON.stringify({ error: "lesson_id required" }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      const { data: directiveId, error } = await supabase.rpc('promote_lesson_to_directive', {
        p_lesson_id: lesson_id,
        p_directive_type: directive_type,
        p_enforcement: enforcement,
        p_priority: priority,
        p_promoted_by: 'manual'
      });

      if (error) throw error;

      return new Response(JSON.stringify({
        promoted: true, lesson_id, directive_id: directiveId,
        promoted_at: new Date().toISOString()
      }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // POST /review - approve or reject a warning lesson
    if (req.method === "POST" && action === "review") {
      const body = await req.json();
      const { lesson_id, decision, review_notes, reviewer = 'human' } = body;

      if (!lesson_id || !decision) {
        return new Response(JSON.stringify({ error: "lesson_id and decision (approved/rejected) required" }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      if (!['approved', 'rejected'].includes(decision)) {
        return new Response(JSON.stringify({ error: "decision must be 'approved' or 'rejected'" }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      const { error: updateError } = await supabase
        .from('lessons')
        .update({
          reviewed: true,
          reviewed_at: new Date().toISOString(),
          reviewed_by: reviewer,
          review_notes,
          review_status: decision,
          updated_at: new Date().toISOString()
        })
        .eq('id', lesson_id);

      if (updateError) throw updateError;

      let directiveId = null;
      if (decision === 'approved') {
        const { data: dId, error: promoteError } = await supabase.rpc('promote_lesson_to_directive', {
          p_lesson_id: lesson_id,
          p_directive_type: 'rule',
          p_enforcement: 'soft',
          p_priority: 60,
          p_promoted_by: `reviewed_by_${reviewer}`
        });
        if (promoteError) {
          return new Response(JSON.stringify({ error: `Review saved but promotion failed: ${promoteError.message}` }),
            { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
        }
        directiveId = dId;
      }

      return new Response(JSON.stringify({
        lesson_id, decision, directive_id: directiveId,
        reviewed_at: new Date().toISOString()
      }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // GET /versions - directive version history
    if (req.method === "GET" && action === "versions") {
      const directiveId = url.searchParams.get('directive_id');
      let query = supabase.from('directive_versions').select('*').order('created_at', { ascending: false }).limit(20);
      if (directiveId) query = query.eq('directive_id', directiveId);
      const { data, error } = await query;
      if (error) throw error;
      return new Response(JSON.stringify({ versions: data || [], count: data?.length || 0 }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    return new Response(JSON.stringify({
      error: "Unknown action",
      available: [
        "GET /status - lesson dashboard",
        "POST /run - execute promotion batch (cron)",
        "POST /run?dry_run=true - preview",
        "POST /promote-single - promote specific lesson",
        "POST /review - approve/reject warning lesson",
        "GET /versions - directive version history"
      ]
    }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });

  } catch (error: any) {
    console.error("lesson-promoter error:", error);
    return new Response(JSON.stringify({ error: error.message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
});
