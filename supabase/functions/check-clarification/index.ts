// check-clarification/index.ts
// WO-0552: Agent clarification protocol
// Agent polls to check if clarification has been answered

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

interface RequestBody {
  clarification_id: string;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: CORS });
  }

  try {
    const body: RequestBody = await req.json();
    const { clarification_id } = body;

    if (!clarification_id) {
      return new Response(
        JSON.stringify({ error: "clarification_id is required" }),
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
      .select("*")
      .eq("id", clarification_id)
      .single();

    if (clarErr || !clarification) {
      return new Response(
        JSON.stringify({ error: "Clarification request not found" }),
        { status: 404, headers: { ...CORS, "Content-Type": "application/json" } }
      );
    }

    // Check if expired
    const now = new Date();
    const expiresAt = new Date(clarification.expires_at);
    if (expiresAt < now && clarification.status === "pending") {
      // Mark as expired
      await supabase
        .from("clarification_requests")
        .update({ status: "expired" })
        .eq("id", clarification_id);

      // Transition WO to failed
      await supabase.rpc("update_work_order_state", {
        p_work_order_id: clarification.work_order_id,
        p_status: "failed",
      });

      // Log expiration
      await supabase.from("work_order_execution_log").insert({
        work_order_id: clarification.work_order_id,
        phase: "failed",
        agent_name: "system",
        detail: {
          event_type: "clarification_expired",
          clarification_id,
          question: clarification.question,
        },
      });

      return new Response(
        JSON.stringify({
          ...clarification,
          status: "expired",
        }),
        { status: 200, headers: { ...CORS, "Content-Type": "application/json" } }
      );
    }

    // Return current state
    return new Response(
      JSON.stringify(clarification),
      { status: 200, headers: { ...CORS, "Content-Type": "application/json" } }
    );
  } catch (e: any) {
    console.error("[CHECK-CLARIFICATION] Error:", e);
    return new Response(
      JSON.stringify({ error: e.message }),
      { status: 500, headers: { ...CORS, "Content-Type": "application/json" } }
    );
  }
});
