import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";

const SANDBOX_URL = Deno.env.get("SANDBOX_URL");
const SANDBOX_AUTH_TOKEN = Deno.env.get("SANDBOX_AUTH_TOKEN");
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

interface ExecRequest {
  command: string;
  args: string[];
  files?: Array<{ path: string; content: string }>;
  timeout_ms?: number;
  work_order_id?: string;
}

interface ExecResponse {
  stdout: string;
  stderr: string;
  exit_code: number;
  timed_out: boolean;
  duration_ms: number;
}

serve(async (req) => {
  // CORS headers
  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "authorization, content-type",
      },
    });
  }

  try {
    if (!SANDBOX_URL || !SANDBOX_AUTH_TOKEN) {
      return new Response(
        JSON.stringify({ error: "Sandbox service not configured" }),
        { status: 500, headers: { "content-type": "application/json" } },
      );
    }

    const body: ExecRequest = await req.json();
    const { work_order_id, ...execRequest } = body;

    // Forward request to Fly.io sandbox
    const sandboxResponse = await fetch(`${SANDBOX_URL}/exec`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "authorization": `Bearer ${SANDBOX_AUTH_TOKEN}`,
      },
      body: JSON.stringify(execRequest),
    });

    const result: ExecResponse = await sandboxResponse.json();

    // Log execution to database
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    
    const logData: Record<string, unknown> = {
      work_order_id: work_order_id || null,
      command: execRequest.command,
      args: execRequest.args || [],
      exit_code: result.exit_code,
      stdout: result.stdout,
      stderr: result.stderr,
      timed_out: result.timed_out,
      duration_ms: result.duration_ms,
      file_count: execRequest.files?.length || 0,
    };

    const { error: logError } = await supabase
      .from("sandbox_executions")
      .insert(logData);

    if (logError) {
      console.error("Failed to log sandbox execution:", logError);
    }

    return new Response(
      JSON.stringify(result),
      { 
        status: sandboxResponse.status,
        headers: { 
          "content-type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      },
    );
  } catch (err) {
    console.error("Sandbox exec error:", err);
    return new Response(
      JSON.stringify({ error: "Internal server error", message: String(err) }),
      { 
        status: 500,
        headers: { 
          "content-type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      },
    );
  }
});
