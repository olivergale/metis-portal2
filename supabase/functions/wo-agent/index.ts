// wo-agent/index.ts v7
// WO-0743: Thin router — all logic extracted to handlers/
// Server-side agentic work order executor
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { handleExecute } from "./handlers/execute.ts";
import { handleExecuteBatch } from "./handlers/batch.ts";
import { handleStatus } from "./handlers/status.ts";
import { createHealthHandlers } from "./handlers/health.ts";

// WO-0513: beforeunload safety net -- log when worker is shutting down
addEventListener('beforeunload', (ev: any) => {
  console.log(`[WO-AGENT] Worker shutting down: ${ev.detail?.reason || 'unknown'}`);
});

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

function jsonResponse(data: any, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

const { handleHealthCheck } = createHealthHandlers(jsonResponse);

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: CORS });
  }

  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  const url = new URL(req.url);
  const action = url.pathname.split("/").pop();

  try {
    switch (action) {
      case "execute":
        return await handleExecute(req, jsonResponse);
      case "execute-batch":
        return await handleExecuteBatch(req, jsonResponse);
      case "status":
        return await handleStatus(req, jsonResponse);
      case "health-check":
        return await handleHealthCheck(req);
      default:
        return jsonResponse({ error: `Unknown action: ${action}` }, 404);
    }
  } catch (e: any) {
    console.error("[WO-AGENT] Unhandled error:", e);
    return jsonResponse({ error: e.message }, 500);
  }
});
