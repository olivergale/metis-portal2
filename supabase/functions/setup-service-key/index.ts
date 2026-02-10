// setup-service-key/index.ts v1
// One-time setup function to populate service_role key in secrets table
// WO-0219: Enable JWT verification on internal functions

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
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    
    if (!serviceRoleKey) {
      return new Response(
        JSON.stringify({ error: "SUPABASE_SERVICE_ROLE_KEY not found in environment" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const supabase = createClient(supabaseUrl, serviceRoleKey);

    // Check if key already exists
    const { data: existing } = await supabase
      .from("secrets")
      .select("key")
      .eq("key", "SUPABASE_SERVICE_ROLE_KEY")
      .single();

    if (existing) {
      return new Response(
        JSON.stringify({ 
          success: true, 
          message: "Service role key already exists in secrets table" 
        }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Insert the service role key
    const { error: insertError } = await supabase
      .from("secrets")
      .insert({
        key: "SUPABASE_SERVICE_ROLE_KEY",
        value: serviceRoleKey,
      });

    if (insertError) {
      console.error("Failed to insert service key:", insertError);
      return new Response(
        JSON.stringify({ error: "Failed to insert service key", details: insertError }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Log to audit_log
    await supabase.from("audit_log").insert({
      event_type: "secret_stored",
      actor_type: "system",
      actor_id: "setup-service-key",
      target_type: "secrets",
      target_id: null,
      action: "Stored SUPABASE_SERVICE_ROLE_KEY in secrets table",
      payload: {
        key: "SUPABASE_SERVICE_ROLE_KEY",
        setup_function: "setup-service-key",
        wo_slug: "WO-0219"
      }
    });

    return new Response(
      JSON.stringify({ 
        success: true, 
        message: "Service role key successfully stored in secrets table" 
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );

  } catch (error) {
    console.error("Error in setup-service-key:", error);
    return new Response(
      JSON.stringify({ error: "Internal server error", details: String(error) }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
