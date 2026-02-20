// verify/index.ts
// T2 Edge Proxy — Server-side execution proxy for mutating tools
// Routes requests to handler modules, authenticates, records mutations with edge_proxy mode
//
// Endpoints:
//   POST /verify/github/push     — Proxy github_push_files (Git Data API)
//   POST /verify/github/branch   — Proxy github_create_branch
//   POST /verify/github/pr       — Proxy github_create_pr
//   POST /verify/sandbox/exec    — Proxy sandbox_exec via Fly Machine
//   POST /verify/sandbox/write   — Proxy sandbox_write_file via Fly Machine
//   POST /verify/sandbox/pipeline — Proxy sandbox_pipeline via Fly Machine
//   POST /verify/sandbox/test    — Proxy run_tests via Fly Machine
//   POST /verify/deploy          — Proxy deploy_edge_function via Supabase Mgmt API
//   POST /verify/assert          — Evaluate assertions for a WO
//   POST /verify/snapshot        — Capture before/after snapshot
//   POST /verify/receipt         — Generate receipt
//   GET  /verify/receipt/:wo_id  — Get/verify receipt
//   POST /verify/spec/derive    — LLM-based formal spec derivation
//   POST /verify/spec/evaluate-external — Sandbox formal spec evaluation
//   GET  /verify/health          — Health check

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { authenticateRequest, validateAgent } from "./lib/auth.ts";
import { handlePush, handleCreateBranch, handleCreatePr } from "./handlers/github.ts";
import { handleExec, handleWrite, handlePipeline, handleTest } from "./handlers/sandbox.ts";
import { handleDeploy } from "./handlers/deploy.ts";
import { handleAssert } from "./handlers/assert.ts";
import { handleSnapshot } from "./handlers/snapshot.ts";
import { handleGetReceipt, handleGenerateReceipt } from "./handlers/receipt.ts";
import { handleSpecDerive } from "./handlers/spec-derive.ts";
import { handleSpecEvaluateExternal } from "./handlers/spec-evaluate.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-trace-id",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

Deno.serve(async (req: Request) => {
  // CORS preflight
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const url = new URL(req.url);
  // Path: /verify/... — strip the function name prefix
  // Supabase routes: /functions/v1/verify/github/push -> pathname = /verify/github/push
  // We need the part after /verify
  const pathParts = url.pathname
    .split("/")
    .filter(Boolean);

  // Find 'verify' in path and get everything after it
  const verifyIdx = pathParts.indexOf("verify");
  const subPath = verifyIdx >= 0 ? pathParts.slice(verifyIdx + 1) : pathParts;
  const route = subPath.join("/");

  // Health check (no auth required)
  if (route === "health" && req.method === "GET") {
    return jsonResponse({ status: "ok", service: "verify", version: "1.0.0" });
  }

  // Create Supabase client
  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const supabase = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false },
  });

  // Authenticate
  const auth = await authenticateRequest(req, supabase);
  if (!auth.authenticated) {
    return jsonResponse(
      { success: false, error: `Authentication failed: ${auth.error}` },
      401
    );
  }

  // Parse request body for POST requests
  let body: Record<string, any> = {};
  if (req.method === "POST") {
    try {
      body = await req.json();
    } catch {
      return jsonResponse({ success: false, error: "Invalid JSON body" }, 400);
    }

    // Validate agent_name if present
    if (body.agent_name) {
      const agent = await validateAgent(supabase, body.agent_name);
      if (!agent) {
        return jsonResponse(
          { success: false, error: `Unknown agent: ${body.agent_name}` },
          400
        );
      }

      // Check agent permission for the tool via check_agent_permission RPC
      const toolName = routeToToolName(route);
      if (toolName) {
        const { data: perm } = await supabase.rpc("check_agent_permission", {
          p_agent_name: body.agent_name,
          p_tool_name: toolName,
        });
        if (perm && !perm.allowed) {
          return jsonResponse(
            {
              success: false,
              error: `Agent '${body.agent_name}' does not have permission for '${toolName}': ${perm.reason}`,
            },
            403
          );
        }
      }
    }
  }

  // Route to handler
  try {
    switch (route) {
      // GitHub handlers
      case "github/push":
        return withCors(await handlePush(body, supabase));
      case "github/branch":
        return withCors(await handleCreateBranch(body, supabase));
      case "github/pr":
        return withCors(await handleCreatePr(body, supabase));

      // Sandbox handlers
      case "sandbox/exec":
        return withCors(await handleExec(body, supabase));
      case "sandbox/write":
        return withCors(await handleWrite(body, supabase));
      case "sandbox/pipeline":
        return withCors(await handlePipeline(body, supabase));
      case "sandbox/test":
        return withCors(await handleTest(body, supabase));

      // Deploy handler
      case "deploy":
        return withCors(await handleDeploy(body, supabase));

      // Assertion handler
      case "assert":
        return withCors(await handleAssert(body, supabase));

      // Snapshot handler
      case "snapshot":
        return withCors(await handleSnapshot(body, supabase));

      // Formal spec derivation (LLM-based)
      case "spec/derive":
        return withCors(await handleSpecDerive(body, supabase));

      // Sandbox formal spec evaluation (Phase 4B)
      case "spec/evaluate-external":
        return withCors(await handleSpecEvaluateExternal(body, supabase));

      // Receipt handlers
      case "receipt":
        if (req.method === "POST") {
          return withCors(await handleGenerateReceipt(body, supabase));
        }
        return jsonResponse({ success: false, error: "Use GET /verify/receipt/:wo_id" }, 400);

      default:
        // Check for receipt GET: receipt/<wo_id>
        if (subPath[0] === "receipt" && subPath[1] && req.method === "GET") {
          return withCors(await handleGetReceipt(subPath[1], supabase));
        }
        return jsonResponse(
          { success: false, error: `Unknown route: ${route}` },
          404
        );
    }
  } catch (e: unknown) {
    console.error(`[verify] Unhandled error on /${route}:`, (e as Error).message);
    return jsonResponse(
      { success: false, error: `Internal error: ${(e as Error).message}` },
      500
    );
  }
});

/**
 * Map route to tool name for permission checking.
 */
function routeToToolName(route: string): string | null {
  const map: Record<string, string> = {
    "github/push": "github_push_files",
    "github/branch": "github_create_branch",
    "github/pr": "github_create_pr",
    "sandbox/exec": "sandbox_exec",
    "sandbox/write": "sandbox_write_file",
    "sandbox/pipeline": "sandbox_pipeline",
    "sandbox/test": "run_tests",
    deploy: "deploy_edge_function",
  };
  return map[route] || null;
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function withCors(response: Response): Response {
  const newHeaders = new Headers(response.headers);
  for (const [key, value] of Object.entries(corsHeaders)) {
    newHeaders.set(key, value);
  }
  return new Response(response.body, {
    status: response.status,
    headers: newHeaders,
  });
}
