// validate-objective/index.ts v1
// WO-0122: Pre-execution WO objective validation endpoint
// Prevents wasted Claude sessions by validating WO objectives before spawning subprocess
// Returns confidence score (high/medium/low) with detailed reasoning

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

Deno.serve(async (req) => {
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
    const supabaseKey = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
    const supabase = createClient(supabaseUrl, supabaseKey);

    const { work_order_id, objective, acceptance_criteria } = await req.json();

    if (!work_order_id && !objective) {
      return new Response(
        JSON.stringify({
          error: "work_order_id or objective required",
          valid: false,
          confidence: "low"
        }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Call validation RPC
    const { data, error } = await supabase.rpc("validate_work_order_objective", {
      p_work_order_id: work_order_id || null,
      p_objective: objective || null,
      p_acceptance_criteria: acceptance_criteria || null,
    });

    if (error) {
      console.error("[VALIDATE] RPC error:", error);
      return new Response(
        JSON.stringify({
          error: error.message,
          valid: false,
          confidence: "low"
        }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    console.log(`[VALIDATE] WO ${work_order_id || 'inline'}: ${data.confidence} confidence`);
    if (data.issues && data.issues.length > 0) {
      console.log(`[VALIDATE] Issues: ${JSON.stringify(data.issues)}`);
    }

    return new Response(
      JSON.stringify(data),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );

  } catch (error) {
    console.error("[VALIDATE] Unexpected error:", error);
    return new Response(
      JSON.stringify({
        error: error.message,
        valid: false,
        confidence: "low"
      }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
