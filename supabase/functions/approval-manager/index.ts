// approval-manager/index.ts v1
// Manages approval queue: approve/reject pending approvals, retry gate-blocked WOs

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
};

interface ApprovalAction {
  approval_id: string;
  action: 'approve' | 'reject';
  decided_by: string;
  notes?: string;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  try {
    // GET: List pending approvals
    if (req.method === "GET") {
      const { data: pending, error } = await supabase
        .from("pending_approvals")
        .select("*")
        .order("requested_at", { ascending: false })
        .limit(50);

      if (error) throw error;

      return new Response(
        JSON.stringify({ pending_count: pending?.length || 0, approvals: pending }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // POST: Approve or reject
    if (req.method === "POST") {
      const body: ApprovalAction = await req.json();
      const { approval_id, action, decided_by, notes } = body;

      if (!approval_id || !action || !decided_by) {
        return new Response(
          JSON.stringify({ error: "approval_id, action, and decided_by required" }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      // Get approval details
      const { data: approval, error: approvalError } = await supabase
        .from("approval_queue")
        .select("*, work_orders(id, slug, status)")
        .eq("id", approval_id)
        .single();

      if (approvalError || !approval) {
        return new Response(
          JSON.stringify({ error: "Approval not found" }),
          { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      // Update approval status
      const newStatus = action === 'approve' ? 'approved' : 'rejected';
      const { error: updateError } = await supabase
        .from("approval_queue")
        .update({
          status: newStatus,
          decided_by,
          decided_at: new Date().toISOString(),
          decision_notes: notes || `${action}d by ${decided_by}`,
        })
        .eq("id", approval_id);

      if (updateError) throw updateError;

      // Log to audit
      await supabase.from("audit_log").insert({
        event_type: 'approval_decision',
        actor_type: 'human',
        actor_id: decided_by,
        target_type: 'approval_queue',
        target_id: approval_id,
        action: action,
        payload: {
          work_order_id: approval.work_order_id,
          work_order_slug: approval.work_orders?.slug,
          gate_id: approval.gate_id,
          notes,
        },
      });

      // If approved and WO is in pending_approval status, transition back to ready
      if (action === 'approve' && approval.work_orders?.status === 'pending_approval') {
        const { error: transitionError } = await supabase.rpc('update_work_order_state', {
          p_work_order_id: approval.work_order_id,
          p_status: 'ready',
          p_approved_at: new Date().toISOString(),
          p_approved_by: decided_by,
        });

        if (transitionError) {
          console.error('Failed to transition WO to ready:', transitionError);
          return new Response(
            JSON.stringify({
              success: true,
              action,
              approval_id,
              warning: 'Approval recorded but WO transition failed',
              error: transitionError,
            }),
            { status: 207, headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }

        return new Response(
          JSON.stringify({
            success: true,
            action,
            approval_id,
            work_order_id: approval.work_order_id,
            work_order_slug: approval.work_orders?.slug,
            wo_status: 'ready',
            message: `Approval ${action}d and WO transitioned to ready for execution`,
          }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      // If rejected, transition WO to cancelled
      if (action === 'reject' && approval.work_orders?.status === 'pending_approval') {
        await supabase.rpc('update_work_order_state', {
          p_work_order_id: approval.work_order_id,
          p_status: 'cancelled',
        });
      }

      return new Response(
        JSON.stringify({
          success: true,
          action,
          approval_id,
          work_order_id: approval.work_order_id,
          work_order_slug: approval.work_orders?.slug,
          message: `Approval ${action}d`,
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    return new Response(
      JSON.stringify({ error: "Method not allowed" }),
      { status: 405, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );

  } catch (error) {
    console.error("approval-manager error:", error);
    return new Response(
      JSON.stringify({ error: (error as Error).message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
