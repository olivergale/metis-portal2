// kernel/index.ts
// HTTP API exposing kernel state machine operations
// Endpoints: transition, state, paths, verify, spec, validate

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-trace-id",
  "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
};

// Authenticate request - returns user info or null if invalid
async function authenticateRequest(req: Request, supabase: any): Promise<{ authenticated: boolean; user?: any; error?: string }> {
  const authHeader = req.headers.get("Authorization");
  
  if (!authHeader) {
    return { authenticated: false, error: "Missing Authorization header" };
  }

  try {
    // Try to verify JWT token
    const token = authHeader.replace(/^Bearer\s+/i, "");
    const { data: { user }, error } = await supabase.auth.getUser(token);
    
    if (error || !user) {
      // Try service role key as fallback
      const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
      if (token === serviceKey) {
        return { authenticated: true, user: { id: "service-role", email: "service@supabase" } };
      }
      return { authenticated: false, error: "Invalid token" };
    }
    
    return { authenticated: true, user };
  } catch (err) {
    return { authenticated: false, error: (err as Error).message };
  }
}

// Extract path parameter from URL
function getPathParam(url: URL, param: string): string | null {
  const pathParts = url.pathname.split("/").filter(Boolean);
  const paramIndex = pathParts.indexOf(param);
  if (paramIndex >= 0 && pathParts[paramIndex + 1]) {
    return pathParts[paramIndex + 1];
  }
  return null;
}

// Handle POST /kernel/transition - wo_transition with evidence
async function handleTransition(req: Request, supabase: any): Promise<Response> {
  try {
    let body: any = {};
    try {
      body = await req.json();
    } catch {
      return new Response(
        JSON.stringify({ error: "Invalid JSON body", error_code: "ERR_DATA_VALIDATION" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const { work_order_id, event, payload = {}, actor = "api" } = body;

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

    // Validate UUID format
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
      console.error("[kernel/transition] RPC error:", error);
      return new Response(
        JSON.stringify({ error: error.message, error_code: "ERR_INTERNAL" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (data && !data.success) {
      return new Response(
        JSON.stringify({
          success: false,
          error: data.error || "Transition failed",
          evaluation: data.evaluation
        }),
        { status: 422, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    return new Response(
      JSON.stringify({
        success: true,
        event_id: data.event_id,
        new_status: data.new_status,
        previous_status: data.previous_status,
        work_order_id: data.work_order_id,
        effects: data.effects
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("[kernel/transition] Unexpected error:", error);
    return new Response(
      JSON.stringify({ error: (error as Error).message, error_code: "ERR_INTERNAL" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
}

// Handle GET /kernel/state/:wo_id - reconstruct state
async function handleState(req: Request, supabase: any): Promise<Response> {
  try {
    const url = new URL(req.url);
    const woId = getPathParam(url, "state");

    if (!woId) {
      return new Response(
        JSON.stringify({ error: "wo_id path parameter required", error_code: "ERR_DATA_VALIDATION" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Validate UUID format
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!uuidRegex.test(woId)) {
      return new Response(
        JSON.stringify({ error: "wo_id must be a valid UUID", error_code: "ERR_DATA_VALIDATION" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Get stream_id from work_orders
    const { data: wo, error: woError } = await supabase
      .from("work_orders")
      .select("id, slug, name, status, priority, objective, summary, created_at, started_at, completed_at, assigned_to, tags, client_info")
      .eq("id", woId)
      .single();

    if (woError || !wo) {
      return new Response(
        JSON.stringify({ error: "Work order not found", error_code: "ERR_NOT_FOUND" }),
        { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Call reconstruct_wo_state RPC to get event stream
    const { data: stateData, error: stateError } = await supabase.rpc("reconstruct_wo_state", {
      p_stream_id: woId,
      p_up_to_version: null
    });

    if (stateError) {
      console.error("[kernel/state] reconstruct error:", stateError);
      return new Response(
        JSON.stringify({ error: stateError.message, error_code: "ERR_INTERNAL" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    return new Response(
      JSON.stringify({
        work_order: wo,
        state: stateData
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("[kernel/state] Unexpected error:", error);
    return new Response(
      JSON.stringify({ error: (error as Error).message, error_code: "ERR_INTERNAL" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
}

// Handle GET /kernel/paths/:wo_id - compute valid paths
async function handlePaths(req: Request, supabase: any): Promise<Response> {
  try {
    const url = new URL(req.url);
    const woId = getPathParam(url, "paths");

    if (!woId) {
      return new Response(
        JSON.stringify({ error: "wo_id path parameter required", error_code: "ERR_DATA_VALIDATION" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Validate UUID format
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!uuidRegex.test(woId)) {
      return new Response(
        JSON.stringify({ error: "wo_id must be a valid UUID", error_code: "ERR_DATA_VALIDATION" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Get current status from work_orders
    const { data: wo, error: woError } = await supabase
      .from("work_orders")
      .select("status")
      .eq("id", woId)
      .single();

    if (woError || !wo) {
      return new Response(
        JSON.stringify({ error: "Work order not found", error_code: "ERR_NOT_FOUND" }),
        { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Call get_valid_next_states to get possible paths
    const { data: paths, error: pathsError } = await supabase.rpc("get_valid_next_states", {
      p_current_status: wo.status
    });

    if (pathsError) {
      console.error("[kernel/paths] RPC error:", pathsError);
      return new Response(
        JSON.stringify({ error: pathsError.message, error_code: "ERR_INTERNAL" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    return new Response(
      JSON.stringify({
        work_order_id: woId,
        current_status: wo.status,
        valid_paths: paths || []
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("[kernel/paths] Unexpected error:", error);
    return new Response(
      JSON.stringify({ error: (error as Error).message, error_code: "ERR_INTERNAL" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
}

// Handle GET /kernel/verify/:wo_id - verify evidence chain
async function handleVerify(req: Request, supabase: any): Promise<Response> {
  try {
    const url = new URL(req.url);
    const woId = getPathParam(url, "verify");

    if (!woId) {
      return new Response(
        JSON.stringify({ error: "wo_id path parameter required", error_code: "ERR_DATA_VALIDATION" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Validate UUID format
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!uuidRegex.test(woId)) {
      return new Response(
        JSON.stringify({ error: "wo_id must be a valid UUID", error_code: "ERR_DATA_VALIDATION" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Verify work_order exists
    const { data: wo, error: woError } = await supabase
      .from("work_orders")
      .select("id")
      .eq("id", woId)
      .single();

    if (woError || !wo) {
      return new Response(
        JSON.stringify({ error: "Work order not found", error_code: "ERR_NOT_FOUND" }),
        { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Call verify_evidence_chain RPC
    const { data: verifyResult, error: verifyError } = await supabase.rpc("verify_evidence_chain", {
      p_stream_id: woId
    });

    if (verifyError) {
      console.error("[kernel/verify] RPC error:", verifyError);
      return new Response(
        JSON.stringify({ error: verifyError.message, error_code: "ERR_INTERNAL" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    return new Response(
      JSON.stringify({
        valid: verifyResult?.is_valid ?? false,
        chain_length: verifyResult?.chain_length ?? 0,
        work_order_id: woId
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("[kernel/verify] Unexpected error:", error);
    return new Response(
      JSON.stringify({ error: (error as Error).message, error_code: "ERR_INTERNAL" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
}

// Handle GET /kernel/spec - get active kernel spec
async function handleSpec(req: Request, supabase: any): Promise<Response> {
  try {
    // Call get_active_spec RPC
    const { data: spec, error: specError } = await supabase.rpc("get_active_spec");

    if (specError) {
      console.error("[kernel/spec] RPC error:", specError);
      return new Response(
        JSON.stringify({ error: specError.message, error_code: "ERR_INTERNAL" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (!spec) {
      return new Response(
        JSON.stringify({ error: "No active kernel spec found", error_code: "ERR_NOT_FOUND" }),
        { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    return new Response(
      JSON.stringify(spec),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("[kernel/spec] Unexpected error:", error);
    return new Response(
      JSON.stringify({ error: (error as Error).message, error_code: "ERR_INTERNAL" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
}

// Handle POST /kernel/validate - dry-run invariant check
async function handleValidate(req: Request, supabase: any): Promise<Response> {
  try {
    let body: any = {};
    try {
      body = await req.json();
    } catch {
      return new Response(
        JSON.stringify({ error: "Invalid JSON body", error_code: "ERR_DATA_VALIDATION" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const { work_order_id, invariant_names = [] } = body;

    if (!work_order_id) {
      return new Response(
        JSON.stringify({ error: "work_order_id is required", error_code: "ERR_DATA_VALIDATION" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Validate UUID format
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!uuidRegex.test(work_order_id)) {
      return new Response(
        JSON.stringify({ error: "work_order_id must be a valid UUID", error_code: "ERR_DATA_VALIDATION" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Get work order data
    const { data: wo, error: woError } = await supabase
      .from("work_orders")
      .select("*")
      .eq("id", work_order_id)
      .single();

    if (woError || !wo) {
      return new Response(
        JSON.stringify({ error: "Work order not found", error_code: "ERR_NOT_FOUND" }),
        { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Call evaluate_invariants for dry-run
    const { data: evalResult, error: evalError } = await supabase.rpc("evaluate_invariants", {
      p_wo: wo,
      p_invariant_names: invariant_names
    });

    if (evalError) {
      console.error("[kernel/validate] RPC error:", evalError);
      return new Response(
        JSON.stringify({ error: evalError.message, error_code: "ERR_INTERNAL" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    return new Response(
      JSON.stringify({
        valid: evalResult?.valid ?? true,
        details: evalResult,
        work_order_id: work_order_id
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("[kernel/validate] Unexpected error:", error);
    return new Response(
      JSON.stringify({ error: (error as Error).message, error_code: "ERR_INTERNAL" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
}

// Main request handler
Deno.serve(async (req) => {
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  // Create Supabase client
  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  // Authenticate request (AC #8)
  const auth = await authenticateRequest(req, supabase);
  if (!auth.authenticated) {
    return new Response(
      JSON.stringify({ error: auth.error || "Unauthorized", error_code: "ERR_UNAUTHORIZED" }),
      { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  // Parse URL and route to handler
  const url = new URL(req.url);
  const path = url.pathname;
  const method = req.method;

  console.log(`[kernel] ${method} ${path}`);

  // Route: POST /kernel/transition
  if (path === "/kernel/transition" && method === "POST") {
    return handleTransition(req, supabase);
  }

  // Route: GET /kernel/state/:wo_id
  if (path.match(/^\/kernel\/state\/[^/]+$/) && method === "GET") {
    return handleState(req, supabase);
  }

  // Route: GET /kernel/paths/:wo_id
  if (path.match(/^\/kernel\/paths\/[^/]+$/) && method === "GET") {
    return handlePaths(req, supabase);
  }

  // Route: GET /kernel/verify/:wo_id
  if (path.match(/^\/kernel\/verify\/[^/]+$/) && method === "GET") {
    return handleVerify(req, supabase);
  }

  // Route: GET /kernel/spec
  if (path === "/kernel/spec" && method === "GET") {
    return handleSpec(req, supabase);
  }

  // Route: POST /kernel/validate
  if (path === "/kernel/validate" && method === "POST") {
    return handleValidate(req, supabase);
  }

  // Default: 404 Not Found
  return new Response(
    JSON.stringify({ error: "Endpoint not found", error_code: "ERR_NOT_FOUND", path }),
    { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } }
  );
});
