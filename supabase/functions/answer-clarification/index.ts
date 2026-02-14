// answer-clarification/index.ts
// WO-0552: Agent clarification protocol
// Human answers a clarification request and resumes WO execution

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

interface RequestBody {
  clarification_id: string;
  response: string;
  responded_by: string;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: CORS });
  }

  try {
    const body: RequestBody = await req.json();
    const { clarification_id, response, responded_by } = body;

    if (!clarification_id || !response || !responded_by) {
      return new Response(
        JSON.stringify({ error: "clarification_id, response, and responded_by are required" }),
        { status: 400, headers: { ...CORS, "Content-Type": "application/json" } }
      );
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    // Get clarification request
    const { data: clarification, error: clarErr } = await supabase
      .from("clarification_requests")
      .select("*, work_orders(id, slug, status)")
      .eq("id", clarification_id)
      .single();

    if (clarErr || !clarification) {
      return new Response(
        JSON.stringify({ error: "Clarification request not found" }),
        { status: 404, headers: { ...CORS, "Content-Type": "application/json" } }
      );
    }

    if (clarification.status !== "pending") {
      return new Response(
        JSON.stringify({ error: `Clarification already ${clarification.status}` }),
        { status: 400, headers: { ...CORS, "Content-Type": "application/json" } }
      );
    }

    // Update clarification request
    const { error: updateErr } = await supabase
      .from("clarification_requests")
      .update({
        status: "answered",
        response,
        responded_at: new Date().toISOString(),
        responded_by,
      })
      .eq("id", clarification_id);

    if (updateErr) {
      console.error("[ANSWER-CLARIFICATION] Update error:", updateErr);
      return new Response(
        JSON.stringify({ error: "Failed to update clarification request" }),
        { status: 500, headers: { ...CORS, "Content-Type": "application/json" } }
      );
    }

    const work_order_id = clarification.work_order_id;
    const wo = clarification.work_orders;

    // Transition WO back to in_progress if it's blocked_on_input
    if (wo.status === "blocked_on_input") {
      const { error: stateErr } = await supabase.rpc("update_work_order_state", {
        p_work_order_id: work_order_id,
        p_status: "in_progress",
      });

      if (stateErr) {
        console.error("[ANSWER-CLARIFICATION] State transition error:", stateErr);
        return new Response(
          JSON.stringify({ error: "Failed to transition work order back to in_progress" }),
          { status: 500, headers: { ...CORS, "Content-Type": "application/json" } }
        );
      }
    }

    // Log to execution log
    await supabase.from("work_order_execution_log").insert({
      work_order_id,
      phase: "stream",
      agent_name: "system",
      detail: {
        event_type: "clarification_answered",
        clarification_id,
        response,
        responded_by,
      },
    });

    // Re-dispatch WO execution via pg_net POST to wo-agent
    try {
      const woAgentUrl = `${Deno.env.get("SUPABASE_URL")}/functions/v1/wo-agent`;
      const dispatchResponse = await fetch(woAgentUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`,
        },
        body: JSON.stringify({
          work_order_id,
          mode: "continue",
          checkpoint_accomplishments: `Human answered clarification: ${response}`,
        }),
      });

      if (!dispatchResponse.ok) {
        console.error(
          "[ANSWER-CLARIFICATION] Failed to dispatch wo-agent:",
          dispatchResponse.status
        );
      } else {
        console.log("[ANSWER-CLARIFICATION] WO re-dispatched successfully");
      }
    } catch (dispatchErr: any) {
      console.error("[ANSWER-CLARIFICATION] Dispatch error:", dispatchErr.message);
      // Don't fail the response - the answer was recorded successfully
    }

    return new Response(
      JSON.stringify({
        success: true,
        work_order_id,
        work_order_slug: wo.slug,
      }),
      { status: 200, headers: { ...CORS, "Content-Type": "application/json" } }
    );
  } catch (e: any) {
    console.error("[ANSWER-CLARIFICATION] Error:", e);
    return new Response(
      JSON.stringify({ error: e.message }),
      { status: 500, headers: { ...CORS, "Content-Type": "application/json" } }
    );
  }
});
