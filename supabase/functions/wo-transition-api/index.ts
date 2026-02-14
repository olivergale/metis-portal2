// wo-transition-api/index.ts
// HTTP wrapper for wo_transition() RPC - thin API layer
// Routes status change requests through wo_transition() instead of direct status updates

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-trace-id",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

Deno.serve(async (req) => {
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return new Response(
      JSON.stringify({ error: "Method not allowed", error_code: "ERR_INVALID_METHOD" }),
      { status: 405, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  try {
    // Parse request body
    let body: any = {};
    try {
      body = await req.json();
    } catch {
      return new Response(
        JSON.stringify({ error: "Invalid JSON body", error_code: "ERR_DATA_VALIDATION" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Extract and validate required fields
    const { work_order_id, event, payload = {}, actor = "system" } = body;

    if (!work_order_id) {
      return new Response(
        JSON.stringify({ error: "work_order_id is required", error_code: "ERR_DATA_VALIDATION" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (!event) {
      return new Response(
        JSON.stringify({ error: "event is required", error_code: "ERR_DATA_VALIDATION" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Validate work_order_id is a valid UUID
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!uuidRegex.test(work_order_id)) {
      return new Response(
        JSON.stringify({ error: "work_order_id must be a valid UUID", error_code: "ERR_DATA_VALIDATION" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Call wo_transition RPC
    const { data, error } = await supabase.rpc("wo_transition", {
      p_wo_id: work_order_id,
      p_event: event,
      p_payload: payload,
      p_actor: actor,
      p_depth: 0
    });

    if (error) {
      console.error("[wo-transition-api] RPC error:", error);
      return new Response(
        JSON.stringify({ error: error.message, error_code: "ERR_INTERNAL" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Check if transition was successful
    if (data && !data.success) {
      return new Response(
        JSON.stringify({
          error: data.error || "Transition failed",
          error_code: "ERR_TRANSITION_FAILED",
          evaluation: data.evaluation
        }),
        { status: 422, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Return successful transition result
    return new Response(
      JSON.stringify({
        success: true,
        work_order_id: data.work_order_id,
        previous_status: data.previous_status,
        new_status: data.new_status,
        event_id: data.event_id,
        effects: data.effects
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );

  } catch (error) {
    console.error("[wo-transition-api] Unexpected error:", error);
    return new Response(
      JSON.stringify({ error: (error as Error).message, error_code: "ERR_INTERNAL" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
