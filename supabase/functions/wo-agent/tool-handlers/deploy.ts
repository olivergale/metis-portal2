// wo-agent/tool-handlers/deploy.ts
// Edge function deployment tool

import type { ToolContext, ToolResult } from "../tools.ts";

/**
 * Log error to error_events table for centralized error tracking
 * WO-0266: Silent failure detection
 */
async function logError(
  ctx: ToolContext,
  severity: string,
  sourceFunction: string,
  errorCode: string,
  message: string,
  context: Record<string, any> = {}
): Promise<void> {
  try {
    await ctx.supabase.rpc("log_error_event", {
      p_severity: severity,
      p_source_function: sourceFunction,
      p_error_code: errorCode,
      p_message: message,
      p_context: context,
      p_work_order_id: ctx.workOrderId,
      p_agent_id: null,
    });
  } catch (e: any) {
    // Silent failure in error logging - don't cascade
    console.error(`[ERROR_LOG] Failed to log error: ${e.message}`);
  }
}

export async function handleDeployEdgeFunction(
  input: Record<string, any>,
  ctx: ToolContext
): Promise<ToolResult> {
  const { function_name, files, entrypoint } = input;
  if (!function_name || !files || !Array.isArray(files) || files.length === 0) {
    return {
      success: false,
      error: "Missing required parameters: function_name, files (array of {name, content})",
    };
  }

  // Safety: refuse to deploy large functions via this path
  const totalSize = files.reduce((acc: number, f: any) => acc + (f.content?.length || 0), 0);
  if (totalSize > 50000) {
    const errorMsg = `Function too large (${totalSize} chars). Deploy via CLI instead to avoid partial deploys.`;
    await logError(ctx, "warning", "wo-agent/deploy_edge_function", "FUNCTION_TOO_LARGE", errorMsg, { function_name, totalSize });
    return {
      success: false,
      error: errorMsg,
    };
  }

  try {
    const projectRef = Deno.env.get("SUPABASE_PROJECT_REF") || "phfblljwuvzqzlbzkzpr";
    const managementKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    // Use the Supabase Management API to deploy
    // POST /v1/projects/{ref}/functions/{slug}
    const entrypointPath = entrypoint || "index.ts";

    // Check if function exists first
    const checkResp = await fetch(
      `https://api.supabase.com/v1/projects/${projectRef}/functions/${function_name}`,
      {
        headers: {
          Authorization: `Bearer ${managementKey}`,
        },
      }
    );

    const method = checkResp.ok ? "PATCH" : "POST";
    const url = checkResp.ok
      ? `https://api.supabase.com/v1/projects/${projectRef}/functions/${function_name}`
      : `https://api.supabase.com/v1/projects/${projectRef}/functions`;

    // Build multipart form for deploy
    const formData = new FormData();
    formData.append("name", function_name);
    formData.append("verify_jwt", "false");
    formData.append("entrypoint_path", entrypointPath);

    for (const file of files) {
      const blob = new Blob([file.content], { type: "application/typescript" });
      formData.append("files", blob, file.name);
    }

    const deployResp = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${managementKey}`,
      },
      body: formData,
    });

    if (!deployResp.ok) {
      const errText = await deployResp.text();
      return {
        success: false,
        error: `Deploy failed (${deployResp.status}): ${errText}`,
      };
    }

    const result = await deployResp.json();

    // Log deployment
    await ctx.supabase.from("work_order_execution_log").insert({
      work_order_id: ctx.workOrderId,
      phase: "stream",
      agent_name: ctx.agentName,
      detail: {
        event_type: "tool_result",
        tool_name: "deploy_edge_function",
        content: `Deployed edge function: ${function_name}`,
        function_name,
        version: result.version || "unknown",
      },
    });

    return {
      success: true,
      data: {
        function_name,
        version: result.version,
        message: `Deployed ${function_name} successfully`,
      },
    };
  } catch (e: any) {
    return { success: false, error: `deploy_edge_function exception: ${e.message}` };
  }
}
