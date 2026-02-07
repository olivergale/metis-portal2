// evaluate-gates/index.ts v1
// P0 Fix 2: Evaluates decision_gates for WO transitions.
// If gate requires approval, creates approval_queue record.
// Returns { approved: bool, pending: ApprovalRecord[], auto_approved: string[] }

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

interface GateEvalRequest {
  work_order_id: string;
  trigger_type: string;
  context?: Record<string, unknown>;
}

interface GateRecord {
  id: string;
  name: string;
  trigger_type: string;
  conditions: Record<string, unknown>;
  requires_approval: boolean;
  auto_approve_after_minutes: number | null;
  notify_channels: string[] | null;
  default_assignee: string | null;
}

function matchesConditions(gate: GateRecord, ctx: Record<string, unknown>): boolean {
  const cond = gate.conditions || {};

  if (cond.priority && Array.isArray(cond.priority)) {
    if (!ctx.priority || !(cond.priority as string[]).includes(ctx.priority as string)) {
      return false;
    }
  }

  if (cond.cost_usd_gt !== undefined) {
    const cost = typeof ctx.cost_usd === 'number' ? ctx.cost_usd : 0;
    if (cost <= (cond.cost_usd_gt as number)) return false;
  }

  if (cond.cost_usd_lt !== undefined) {
    const cost = typeof ctx.cost_usd === 'number' ? ctx.cost_usd : 0;
    if (cost >= (cond.cost_usd_lt as number)) return false;
  }

  if (cond.tables && Array.isArray(cond.tables)) {
    if (!ctx.table || !(cond.tables as string[]).includes(ctx.table as string)) return false;
  }

  if (cond.tables_exclude && Array.isArray(cond.tables_exclude)) {
    if (ctx.table && (cond.tables_exclude as string[]).includes(ctx.table as string)) return false;
  }

  if (cond.mutation_type && Array.isArray(cond.mutation_type)) {
    if (!ctx.mutation_type || !(cond.mutation_type as string[]).includes(ctx.mutation_type as string)) return false;
  }

  return true;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "POST only" }), { status: 405, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  try {
    const body: GateEvalRequest = await req.json();
    const { work_order_id, trigger_type, context = {} } = body;

    if (!work_order_id || !trigger_type) {
      return new Response(
        JSON.stringify({ error: "work_order_id and trigger_type required" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const { data: wo } = await supabase
      .from("work_orders")
      .select("id, slug, name, priority, tags, requires_approval")
      .eq("id", work_order_id)
      .single();

    if (!wo) {
      return new Response(
        JSON.stringify({ error: "Work order not found" }),
        { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const enrichedContext: Record<string, unknown> = {
      ...context,
      priority: context.priority || wo.priority,
      wo_slug: wo.slug,
      wo_tags: wo.tags,
    };

    const { data: gates, error: gatesError } = await supabase
      .from("decision_gates")
      .select("*")
      .eq("trigger_type", trigger_type)
      .eq("active", true);

    if (gatesError) throw gatesError;

    const matchedGates: GateRecord[] = [];
    const autoApproved: string[] = [];
    const pendingApprovals: Record<string, unknown>[] = [];
    let allApproved = true;

    for (const gate of (gates || []) as GateRecord[]) {
      if (!matchesConditions(gate, enrichedContext)) continue;
      matchedGates.push(gate);

      if (!gate.requires_approval) {
        autoApproved.push(gate.name);
        continue;
      }

      const { data: existingApproval } = await supabase
        .from("approval_queue")
        .select("id, status, requested_at")
        .eq("gate_id", gate.id)
        .eq("work_order_id", work_order_id)
        .single();

      if (existingApproval) {
        if (existingApproval.status === 'approved') {
          autoApproved.push(gate.name + ' (pre-approved)');
        } else if (existingApproval.status === 'pending') {
          if (gate.auto_approve_after_minutes) {
            const requestedAt = new Date(existingApproval.requested_at).getTime();
            const timeoutMs = gate.auto_approve_after_minutes * 60 * 1000;
            if (Date.now() - requestedAt > timeoutMs) {
              await supabase
                .from("approval_queue")
                .update({
                  status: 'approved',
                  decided_by: 'auto_timeout',
                  decided_at: new Date().toISOString(),
                  decision_notes: `Auto-approved after ${gate.auto_approve_after_minutes}min timeout`
                })
                .eq("id", existingApproval.id);
              autoApproved.push(gate.name + ' (auto-timeout)');
              continue;
            }
          }
          allApproved = false;
          pendingApprovals.push({ approval_id: existingApproval.id, gate_name: gate.name, status: 'pending' });
        } else {
          allApproved = false;
          pendingApprovals.push({ approval_id: existingApproval.id, gate_name: gate.name, status: existingApproval.status });
        }
        continue;
      }

      const expiresAt = gate.auto_approve_after_minutes
        ? new Date(Date.now() + gate.auto_approve_after_minutes * 60 * 1000).toISOString()
        : null;

      const { data: newApproval, error: insertErr } = await supabase
        .from("approval_queue")
        .insert({
          gate_id: gate.id,
          work_order_id: work_order_id,
          request_type: trigger_type,
          request_summary: `Gate '${gate.name}' triggered for WO ${wo.slug}`,
          request_detail: enrichedContext,
          status: 'pending',
          requested_by: 'evaluate-gates',
          expires_at: expiresAt,
        })
        .select("id")
        .single();

      if (insertErr) {
        console.error(`Failed to create approval for gate ${gate.name}:`, insertErr);
        continue;
      }

      allApproved = false;
      pendingApprovals.push({
        approval_id: newApproval?.id,
        gate_name: gate.name,
        status: 'pending',
        expires_at: expiresAt,
      });
    }

    await supabase.from("audit_log").insert({
      event_type: 'gate_evaluation',
      actor_type: 'system',
      actor_id: 'evaluate-gates',
      target_type: 'work_order',
      target_id: work_order_id,
      action: allApproved ? 'gates_passed' : 'gates_pending',
      payload: {
        trigger_type,
        gates_matched: matchedGates.map(g => g.name),
        auto_approved: autoApproved,
        pending: pendingApprovals.length,
        context: enrichedContext,
      },
    });

    return new Response(
      JSON.stringify({
        approved: allApproved,
        gates_evaluated: matchedGates.length,
        auto_approved: autoApproved,
        pending: pendingApprovals,
        work_order_id,
        evaluated_at: new Date().toISOString(),
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );

  } catch (error) {
    console.error("evaluate-gates error:", error);
    return new Response(
      JSON.stringify({ error: (error as Error).message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
