// verify/handlers/sandbox.ts
// Fly Machine sandbox proxy — server-side execution with edge_proxy mutation recording
// Replicates wo-agent/tool-handlers/inline.ts sandbox handlers

import { SupabaseClient } from "jsr:@supabase/supabase-js@2";
import { sha256 } from "../lib/hash.ts";
import { recordMutation } from "../lib/record.ts";

/**
 * Read Fly Machine URL and token from system_settings.
 */
async function getFlyConfig(
  supabase: SupabaseClient
): Promise<{ flyUrl: string | null; flyToken: string | null }> {
  const { data } = await supabase
    .from("system_settings")
    .select("setting_key, setting_value")
    .in("setting_key", ["fly_machine_url", "fly_machine_token"]);

  const flyUrl =
    data?.find((s: any) => s.setting_key === "fly_machine_url")?.setting_value ||
    null;
  const flyToken =
    data?.find((s: any) => s.setting_key === "fly_machine_token")
      ?.setting_value || null;
  return { flyUrl, flyToken };
}

function flyHeaders(flyToken: string | null): Record<string, string> {
  const h: Record<string, string> = { "Content-Type": "application/json" };
  if (flyToken && flyToken !== "not_required_public_endpoint") {
    h["Authorization"] = `Bearer ${flyToken}`;
  }
  return h;
}

// Command whitelist (matches wo-agent)
const ALLOWED_COMMANDS = new Set([
  "grep", "find", "wc", "cat", "head", "tail", "echo", "test", "ls",
  "file", "deno", "diff", "jq", "node", "npm", "npx", "tsc", "python3",
  "git", "curl", "sed",
]);

interface SandboxExecRequest {
  wo_id: string;
  agent_name: string;
  command: string;
  args?: string[];
  timeout_ms?: number;
}

/**
 * Proxy sandbox_exec: Execute a command in the Fly Machine sandbox.
 */
export async function handleExec(
  body: SandboxExecRequest,
  supabase: SupabaseClient
): Promise<Response> {
  const { wo_id, agent_name, command, args = [], timeout_ms = 30000 } = body;

  if (!wo_id || !agent_name || !command) {
    return json({ success: false, error: "Missing wo_id, agent_name, or command" }, 400);
  }

  // Command whitelist check
  if (!ALLOWED_COMMANDS.has(command.trim())) {
    return json({
      success: false,
      error: `Command '${command}' is not in the sandbox whitelist. Allowed: ${[...ALLOWED_COMMANDS].join(", ")}`,
    }, 400);
  }

  // Shell injection guard
  const argsStr = args.join(" ");
  if (/[|><;&`$(){}]/.test(argsStr)) {
    return json({
      success: false,
      error: "Args contain blocked characters (pipes, redirects, semicolons, backticks).",
    }, 400);
  }

  const { flyUrl, flyToken } = await getFlyConfig(supabase);
  if (!flyUrl) {
    return json({ success: false, error: "Fly Machine URL not configured" }, 500);
  }

  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), Math.min(timeout_ms, 60000));

    const response = await fetch(`${flyUrl}/exec`, {
      method: "POST",
      headers: flyHeaders(flyToken),
      signal: ctrl.signal,
      body: JSON.stringify({ command, args, timeout_ms, wo_slug: wo_id }),
    });
    clearTimeout(timer);

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({ error: response.statusText }));
      return json({
        success: false,
        error: `Sandbox exec failed (${response.status}): ${errorData.error || response.statusText}`,
      }, 502);
    }

    const execResult = await response.json();
    const success = execResult.exit_code === 0;
    const resultHash = await sha256(execResult.stdout || "");

    // Record mutation
    const mutation = await recordMutation(supabase, {
      workOrderId: wo_id,
      toolName: "sandbox_exec",
      objectType: "sandbox_command",
      objectId: command,
      action: "EXEC",
      success,
      resultHash,
      errorClass: success ? undefined : "SANDBOX_ERROR",
      errorDetail: success ? undefined : (execResult.stderr || "non-zero exit"),
      context: { command, args, exit_code: execResult.exit_code },
      agentName: agent_name,
    });

    return json({
      success,
      stdout: execResult.stdout,
      stderr: execResult.stderr,
      exit_code: execResult.exit_code,
      mutation_id: mutation.mutationId,
      proxy_signature: mutation.proxySignature,
      proxy_mode: "edge_proxy",
    });
  } catch (e: unknown) {
    if ((e as Error).name === "AbortError") {
      return json({ success: false, error: "Sandbox exec timed out" }, 504);
    }
    return json({ success: false, error: `Sandbox exec error: ${(e as Error).message}` }, 500);
  }
}

interface SandboxWriteRequest {
  wo_id: string;
  agent_name: string;
  path: string;
  content: string;
}

/**
 * Proxy sandbox_write_file: Write a file in the Fly Machine sandbox.
 */
export async function handleWrite(
  body: SandboxWriteRequest,
  supabase: SupabaseClient
): Promise<Response> {
  const { wo_id, agent_name, path, content } = body;

  if (!wo_id || !agent_name || !path) {
    return json({ success: false, error: "Missing wo_id, agent_name, or path" }, 400);
  }

  if (!path.startsWith("/workspace")) {
    return json({ success: false, error: `Path must be under /workspace. Got: ${path}` }, 400);
  }

  const { flyUrl, flyToken } = await getFlyConfig(supabase);
  if (!flyUrl) {
    return json({ success: false, error: "Fly Machine URL not configured" }, 500);
  }

  const hdrs = flyHeaders(flyToken);

  try {
    // Ensure parent directory exists
    const parentDir = path.substring(0, path.lastIndexOf("/"));
    if (parentDir && parentDir !== "/workspace") {
      await fetch(`${flyUrl}/exec`, {
        method: "POST",
        headers: hdrs,
        body: JSON.stringify({ command: "mkdir", args: ["-p", parentDir], wo_slug: wo_id }),
      });
    }

    // Write via node one-liner (same pattern as wo-agent)
    const b64Content = btoa(content);
    const writeResponse = await fetch(`${flyUrl}/exec`, {
      method: "POST",
      headers: hdrs,
      body: JSON.stringify({
        command: "node",
        args: [
          "-e",
          `require('fs').writeFileSync('${path.replace(/'/g, "\\'")}', Buffer.from('${b64Content}', 'base64')); console.log(JSON.stringify({bytes: ${content.length}}))`,
        ],
        wo_slug: wo_id,
        timeout_ms: 10000,
      }),
    });

    if (!writeResponse.ok) {
      return json({ success: false, error: `Write failed: ${writeResponse.statusText}` }, 502);
    }

    const writeResult = await writeResponse.json();
    if (writeResult.exit_code !== 0) {
      return json({ success: false, error: writeResult.stderr || "Write failed" }, 500);
    }

    const resultHash = await sha256(content);
    const mutation = await recordMutation(supabase, {
      workOrderId: wo_id,
      toolName: "sandbox_write_file",
      objectType: "file",
      objectId: path,
      action: "WRITE",
      success: true,
      resultHash,
      context: { path, bytes: content.length },
      agentName: agent_name,
    });

    return json({
      success: true,
      path,
      bytes_written: content.length,
      mutation_id: mutation.mutationId,
      proxy_signature: mutation.proxySignature,
      proxy_mode: "edge_proxy",
    });
  } catch (e: unknown) {
    return json({ success: false, error: `Sandbox write error: ${(e as Error).message}` }, 500);
  }
}

interface SandboxPipelineRequest {
  wo_id: string;
  agent_name: string;
  commands: Array<{ command: string; args?: string[] }>;
  timeout_ms?: number;
}

/**
 * Proxy sandbox_pipeline: Execute a command pipeline in the sandbox.
 */
export async function handlePipeline(
  body: SandboxPipelineRequest,
  supabase: SupabaseClient
): Promise<Response> {
  const { wo_id, agent_name, commands, timeout_ms = 30000 } = body;

  if (!wo_id || !agent_name || !commands || !Array.isArray(commands)) {
    return json({ success: false, error: "Missing wo_id, agent_name, or commands" }, 400);
  }

  const { flyUrl, flyToken } = await getFlyConfig(supabase);
  if (!flyUrl) {
    return json({ success: false, error: "Fly Machine URL not configured" }, 500);
  }

  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), Math.min(timeout_ms + 5000, 65000));

    const response = await fetch(`${flyUrl}/pipeline`, {
      method: "POST",
      headers: flyHeaders(flyToken),
      signal: ctrl.signal,
      body: JSON.stringify({ commands, timeout_ms, wo_slug: wo_id }),
    });
    clearTimeout(timer);

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({ error: response.statusText }));
      return json({
        success: false,
        error: `Pipeline failed (${response.status}): ${errorData.error || response.statusText}`,
      }, 502);
    }

    const result = await response.json();
    const success = result.exit_code === 0;
    const resultHash = await sha256(JSON.stringify(result));

    const mutation = await recordMutation(supabase, {
      workOrderId: wo_id,
      toolName: "sandbox_pipeline",
      objectType: "sandbox_pipeline",
      objectId: commands.map((c: any) => c.command).join("|"),
      action: "PIPELINE",
      success,
      resultHash,
      context: { commands: commands.map((c: any) => c.command), exit_code: result.exit_code },
      agentName: agent_name,
    });

    return json({
      success,
      stdout: result.stdout,
      stderr: result.stderr,
      exit_code: result.exit_code,
      mutation_id: mutation.mutationId,
      proxy_signature: mutation.proxySignature,
      proxy_mode: "edge_proxy",
    });
  } catch (e: unknown) {
    if ((e as Error).name === "AbortError") {
      return json({ success: false, error: "Pipeline timed out" }, 504);
    }
    return json({ success: false, error: `Pipeline error: ${(e as Error).message}` }, 500);
  }
}

interface RunTestsRequest {
  wo_id: string;
  agent_name: string;
  test_command?: string;
}

/**
 * Proxy run_tests: Execute tests in the sandbox.
 */
export async function handleTest(
  body: RunTestsRequest,
  supabase: SupabaseClient
): Promise<Response> {
  const { wo_id, agent_name, test_command = "npm test" } = body;

  if (!wo_id || !agent_name) {
    return json({ success: false, error: "Missing wo_id or agent_name" }, 400);
  }

  const parts = test_command.trim().split(/\s+/);
  const command = parts[0];
  const args = parts.slice(1);

  const TEST_ALLOWED = new Set(["npm", "npx", "node", "deno", "tsc"]);
  if (!TEST_ALLOWED.has(command)) {
    return json({
      success: false,
      error: `Test command '${command}' not allowed. Use: ${[...TEST_ALLOWED].join(", ")}`,
    }, 400);
  }

  const { flyUrl, flyToken } = await getFlyConfig(supabase);
  if (!flyUrl) {
    return json({ success: false, error: "Fly Machine URL not configured" }, 500);
  }

  try {
    // Git pull first
    try {
      await fetch(`${flyUrl}/git-pull`, {
        method: "POST",
        headers: flyHeaders(flyToken),
        body: "{}",
      });
    } catch (_) { /* non-fatal */ }

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 120000);

    const response = await fetch(`${flyUrl}/exec`, {
      method: "POST",
      headers: flyHeaders(flyToken),
      signal: ctrl.signal,
      body: JSON.stringify({ command, args, timeout_ms: 120000, wo_slug: wo_id }),
    });
    clearTimeout(timer);

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({ error: response.statusText }));
      return json({
        success: false,
        error: `Test execution failed (${response.status}): ${errorData.error || response.statusText}`,
      }, 502);
    }

    const execResult = await response.json();
    const success = execResult.exit_code === 0;
    const resultHash = await sha256(execResult.stdout || "");

    const mutation = await recordMutation(supabase, {
      workOrderId: wo_id,
      toolName: "run_tests",
      objectType: "test_run",
      objectId: test_command,
      action: "TEST",
      success,
      resultHash,
      context: { test_command, exit_code: execResult.exit_code },
      agentName: agent_name,
    });

    return json({
      success,
      stdout: execResult.stdout,
      stderr: execResult.stderr,
      exit_code: execResult.exit_code,
      test_command,
      mutation_id: mutation.mutationId,
      proxy_signature: mutation.proxySignature,
      proxy_mode: "edge_proxy",
    });
  } catch (e: unknown) {
    if ((e as Error).name === "AbortError") {
      return json({ success: false, error: "Test execution timed out after 120s" }, 504);
    }
    return json({ success: false, error: `Test execution error: ${(e as Error).message}` }, 500);
  }
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
