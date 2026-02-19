// wo-agent/proxy-verify.ts
// Phase C: Route mutating tools through /verify edge proxy
// When enabled, tool execution and mutation recording happen server-side (edge_proxy mode)
// Falls back to direct execution when proxy is disabled or not applicable

import type { ToolContext, ToolResult } from "./tools.ts";

/**
 * Tools eligible for proxy routing.
 * Maps tool name to /verify endpoint path.
 */
const TOOL_TO_ENDPOINT: Record<string, string> = {
  github_push_files: "github/push",
  github_create_branch: "github/branch",
  github_create_pr: "github/pr",
  sandbox_exec: "sandbox/exec",
  sandbox_write_file: "sandbox/write",
  sandbox_pipeline: "sandbox/pipeline",
  run_tests: "sandbox/test",
  deploy_edge_function: "deploy",
};

export const PROXY_ELIGIBLE_TOOLS = new Set(Object.keys(TOOL_TO_ENDPOINT));

/**
 * Check if the verify proxy is enabled via system_settings feature flag.
 * Caches result per isolate lifetime (edge function restart clears cache).
 */
let _proxyEnabled: boolean | null = null;
let _proxyCheckedAt = 0;
const CACHE_TTL_MS = 60_000; // Re-check every 60s

async function isProxyEnabled(supabase: any): Promise<boolean> {
  const now = Date.now();
  if (_proxyEnabled !== null && now - _proxyCheckedAt < CACHE_TTL_MS) {
    return _proxyEnabled;
  }

  try {
    const { data } = await supabase
      .from("system_settings")
      .select("setting_value")
      .eq("setting_key", "verify_proxy_enabled")
      .single();
    _proxyEnabled = data?.setting_value === "true";
    _proxyCheckedAt = now;
  } catch {
    // Default to disabled if we can't read settings
    _proxyEnabled = false;
    _proxyCheckedAt = now;
  }

  return _proxyEnabled;
}

/**
 * Check if an agent should use proxy_only mode for a given tool.
 * Reads from agent_tool_permissions table.
 */
async function shouldProxy(
  supabase: any,
  agentName: string,
  toolName: string
): Promise<boolean> {
  try {
    const { data } = await supabase.rpc("check_agent_permission", {
      p_agent_name: agentName,
      p_tool_name: toolName,
    });
    return data?.permission === "proxy_only";
  } catch {
    return false;
  }
}

/**
 * Route a tool call through the /verify edge proxy.
 * Returns ToolResult if proxy handled the request, or null to fall through to direct execution.
 */
export async function proxyViaVerify(
  toolName: string,
  toolInput: Record<string, any>,
  ctx: ToolContext
): Promise<ToolResult | null> {
  const endpoint = TOOL_TO_ENDPOINT[toolName];
  if (!endpoint) return null;

  // Check feature flag
  const enabled = await isProxyEnabled(ctx.supabase);
  if (!enabled) return null;

  // Check if agent has proxy_only permission (or if proxy is forced for all)
  const needsProxy = await shouldProxy(ctx.supabase, ctx.agentName, toolName);
  if (!needsProxy) return null;

  // Build proxy request body
  const proxyBody: Record<string, any> = {
    wo_id: ctx.workOrderId,
    agent_name: ctx.agentName,
    ...toolInput,
  };

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

  if (!supabaseUrl || !serviceKey) {
    console.error("[proxyViaVerify] Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
    return null; // Fall through to direct execution
  }

  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 120_000); // 2-minute timeout

    const response = await fetch(
      `${supabaseUrl}/functions/v1/verify/${endpoint}`,
      {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${serviceKey}`,
          "Content-Type": "application/json",
        },
        signal: ctrl.signal,
        body: JSON.stringify(proxyBody),
      }
    );
    clearTimeout(timer);

    if (!response.ok) {
      const errorText = await response.text().catch(() => response.statusText);
      console.error(
        `[proxyViaVerify] ${toolName} -> /verify/${endpoint} failed (${response.status}): ${errorText.substring(0, 500)}`
      );
      // On proxy failure, fall through to direct execution so the agent isn't blocked
      return null;
    }

    const data = await response.json();

    // Convert proxy response to ToolResult format
    return {
      success: data.success ?? false,
      data: data,
      error: data.error || undefined,
    };
  } catch (e: any) {
    if (e.name === "AbortError") {
      console.error(`[proxyViaVerify] ${toolName} -> /verify/${endpoint} timed out`);
    } else {
      console.error(`[proxyViaVerify] ${toolName} -> /verify/${endpoint} exception: ${e.message}`);
    }
    // Fall through to direct execution on any error
    return null;
  }
}
