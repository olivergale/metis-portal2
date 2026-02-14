// request-clarification/index.ts
// WO-0552: Agent clarification protocol
// Allows agents to pause WO and request human input

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

interface RequestBody {
  work_order_id: string;
  question: string;
  context?: string;
  options?: string[];
  urgency?: "low" | "normal" | "high";
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: CORS });
  }

  try {
    const body: RequestBody = await req.json();
    const { work_order_id, question, context, options, urgency = "normal" } = body;

    if (!work_order_id || !question) {
      return new Response(
        JSON.stringify({ error: "work_order_id and question are required" }),
        { status: 400, headers: { ...CORS, "Content-Type": "application/json" } }
      );
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    // Validate work order exists and is in_progress
    const { data: wo, error: woErr } = await supabase
      .from("work_orders")
      .select("id, slug, status")
      .eq("id", work_order_id)
      .single();

    if (woErr || !wo) {
      return new Response(
        JSON.stringify({ error: "Work order not found" }),
        { status: 404, headers: { ...CORS, "Content-Type": "application/json" } }
      );
    }

    if (wo.status !== "in_progress") {
      return new Response(
        JSON.stringify({ error: `Cannot request clarification: WO is ${wo.status}, must be in_progress` }),
        { status: 400, headers: { ...CORS, "Content-Type": "application/json" } }
      );
    }

    // Create clarification request
    const { data: clarification, error: clarErr } = await supabase
      .from("clarification_requests")
      .insert({
        work_order_id,
        question,
        context,
        options: options ? JSON.stringify(options) : null,
        urgency,
        status: "pending",
      })
      .select()
      .single();

    if (clarErr || !clarification) {
      console.error("[REQUEST-CLARIFICATION] Insert error:", clarErr);
      return new Response(
        JSON.stringify({ error: "Failed to create clarification request" }),
        { status: 500, headers: { ...CORS, "Content-Type": "application/json" } }
      );
    }

    // Transition WO to blocked_on_input via RPC
    const { data: updateResult, error: updateErr } = await supabase.rpc(
      "update_work_order_state",
      {
        p_work_order_id: work_order_id,
        p_status: "blocked_on_input",
      }
    );

    if (updateErr) {
      console.error("[REQUEST-CLARIFICATION] State transition error:", updateErr);
      // Rollback clarification request
      await supabase
        .from("clarification_requests")
        .update({ status: "cancelled" })
        .eq("id", clarification.id);
      
      return new Response(
        JSON.stringify({ error: "Failed to transition work order to blocked_on_input" }),
        { status: 500, headers: { ...CORS, "Content-Type": "application/json" } }
      );
    }

    // Log to execution log
    await supabase.from("work_order_execution_log").insert({
      work_order_id,
      phase: "stream",
      agent_name: "system",
      detail: {
        event_type: "clarification_requested",
        clarification_id: clarification.id,
        question,
        urgency,
      },
    });

    return new Response(
      JSON.stringify({
        success: true,
        clarification_id: clarification.id,
        status: "blocked",
        expires_at: clarification.expires_at,
      }),
      { status: 200, headers: { ...CORS, "Content-Type": "application/json" } }
    );
  } catch (e: any) {
    console.error("[REQUEST-CLARIFICATION] Error:", e);
    return new Response(
      JSON.stringify({ error: e.message }),
      { status: 500, headers: { ...CORS, "Content-Type": "application/json" } }
    );
  }
});
