// mcp-gateway/index.ts - v1
// Gateway for MCP bridge requests with signing validation
// Soft gate: logs bypasses but allows them through

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-request-id, x-request-signature, x-request-timestamp, x-session-token",
};

const MCP_BRIDGE_URL = Deno.env.get("MCP_BRIDGE_URL") || "https://mcp.authenticrevolution.com/mcp";
const MCP_API_KEY = Deno.env.get("MCP_API_KEY") || "";
const ENFORCE_SIGNING = Deno.env.get("ENFORCE_MCP_SIGNING") === "true"; // Soft gate by default

interface MCPRequest {
  jsonrpc: string;
  method: string;
  params?: any;
  id: number | string;
}

async function validateSignature(
  supabase: any,
  requestId: string,
  timestamp: string,
  payloadHash: string,
  signature: string
): Promise<boolean> {
  try {
    const { data, error } = await supabase.rpc("validate_request_signature", {
      p_request_id: requestId,
      p_timestamp: timestamp,
      p_payload_hash: payloadHash,
      p_signature: signature,
    });

    if (error) {
      console.error("Signature validation error:", error);
      return false;
    }

    return data === true;
  } catch (e) {
    console.error("Signature validation exception:", e);
    return false;
  }
}

async function logBypass(
  supabase: any,
  eventType: string,
  severity: string,
  details: any
): Promise<void> {
  try {
    await supabase.rpc("log_bypass_attempt", {
      p_event_type: eventType,
      p_severity: severity,
      p_details: details,
    });
  } catch (e) {
    console.error("Failed to log bypass:", e);
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const supabase = createClient(supabaseUrl, supabaseKey);

  try {
    const body = await req.text();
    const mcpRequest: MCPRequest = JSON.parse(body);

    // Extract signing headers
    const requestId = req.headers.get("x-request-id");
    const signature = req.headers.get("x-request-signature");
    const timestamp = req.headers.get("x-request-timestamp");
    const sessionToken = req.headers.get("x-session-token");

    // Compute payload hash
    const encoder = new TextEncoder();
    const data = encoder.encode(body);
    const hashBuffer = await crypto.subtle.digest("SHA-256", data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    const payloadHash = hashArray.map(b => b.toString(16).padStart(2, "0")).join("");

    let isValidRequest = false;
    let bypassReason = "";

    // Validate request
    if (requestId && signature && timestamp) {
      isValidRequest = await validateSignature(
        supabase,
        requestId,
        timestamp,
        payloadHash,
        signature
      );
      if (!isValidRequest) {
        bypassReason = "invalid_signature";
      }
    } else {
      bypassReason = "missing_signing_headers";
    }

    // Validate session if provided
    if (sessionToken) {
      const { data: session } = await supabase.rpc("validate_session", {
        p_token: sessionToken,
      });
      if (session?.[0]?.valid) {
        isValidRequest = true; // Valid session overrides missing signature
        bypassReason = "";
      }
    }

    // Log bypass attempt (soft gate)
    if (!isValidRequest && bypassReason) {
      await logBypass(supabase, "mcp_unsigned", "warning", {
        reason: bypassReason,
        method: mcpRequest.method,
        has_session: !!sessionToken,
        ip: req.headers.get("x-forwarded-for") || "unknown",
      });

      // Hard gate mode - block unsigned requests
      if (ENFORCE_SIGNING) {
        return new Response(JSON.stringify({
          jsonrpc: "2.0",
          error: {
            code: -32600,
            message: "Request signing required",
          },
          id: mcpRequest.id,
        }), {
          status: 401,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
    }

    // Forward to MCP bridge
    const mcpResponse = await fetch(MCP_BRIDGE_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": MCP_API_KEY,
        "X-Forwarded-Request-Id": requestId || crypto.randomUUID(),
        "X-Validated": isValidRequest ? "true" : "false",
      },
      body: body,
    });

    const responseBody = await mcpResponse.text();

    // Log the request for audit
    await supabase.from("mcp_request_log").insert({
      request_id: requestId || crypto.randomUUID(),
      method: mcpRequest.method,
      params: mcpRequest.params,
      validated: isValidRequest,
      session_token: sessionToken ? sessionToken.slice(0, 8) + "..." : null,
      response_status: mcpResponse.status,
    }).catch(() => {}); // Don't fail on logging

    return new Response(responseBody, {
      status: mcpResponse.status,
      headers: {
        ...corsHeaders,
        "Content-Type": "application/json",
        "X-Request-Validated": isValidRequest ? "true" : "false",
      },
    });

  } catch (error) {
    console.error("mcp-gateway error:", error);
    return new Response(JSON.stringify({
      jsonrpc: "2.0",
      error: {
        code: -32603,
        message: error.message,
      },
      id: null,
    }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
