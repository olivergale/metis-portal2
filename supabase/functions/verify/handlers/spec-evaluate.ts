// verify/handlers/spec-evaluate.ts
// Phase 4B: Sandbox formal spec external evaluation
// Evaluates sandbox_exec and sandbox_test specs by calling Fly Machine API
// Stores results in wo_formal_specs.evaluation_result

import { SupabaseClient } from "jsr:@supabase/supabase-js@2";
import { sha256 } from "../lib/hash.ts";

interface SpecEvaluateRequest {
  wo_id: string;
  agent_name?: string;
}

interface SandboxSpecDefinition {
  command?: string;
  args?: string[];
  exit_code?: number;
  output_contains?: string;
  test_command?: string;
}

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

const ALLOWED_COMMANDS = new Set([
  "grep", "find", "wc", "cat", "head", "tail", "echo", "test", "ls",
  "file", "deno", "diff", "jq", "node", "npm", "npx", "tsc", "python3",
  "git", "curl", "sed",
]);

const TEST_ALLOWED = new Set(["npm", "npx", "node", "deno", "tsc"]);

/**
 * Evaluate sandbox_exec spec:
 * - Execute command via Fly Machine
 * - Check exit_code matches expected
 * - Check output_contains if specified
 */
async function evaluateSandboxExec(
  specDef: SandboxSpecDefinition,
  flyUrl: string,
  flyToken: string | null,
  woId: string
): Promise<JSON> {
  const { command, args = [], exit_code: expectedExit, output_contains } = specDef;

  if (!command) {
    return {
      status: "FAIL",
      details: { error: "sandbox_exec spec missing command" },
    };
  }

  // Validate command whitelist
  if (!ALLOWED_COMMANDS.has(command.trim())) {
    return {
      status: "FAIL",
      details: { error: `Command '${command}' not in whitelist` },
    };
  }

  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 60000);

    const response = await fetch(`${flyUrl}/exec`, {
      method: "POST",
      headers: flyHeaders(flyToken),
      signal: ctrl.signal,
      body: JSON.stringify({
        command,
        args,
        timeout_ms: 60000,
        wo_slug: woId,
      }),
    });
    clearTimeout(timer);

    if (!response.ok) {
      return {
        status: "FAIL",
        details: {
          error: `Sandbox API error: ${response.status}`,
          status_code: response.status,
        },
      };
    }

    const execResult = await response.json();
    const stdout = execResult.stdout || "";
    const stderr = execResult.stderr || "";
    const actualExit = execResult.exit_code;

    // Check exit_code
    if (expectedExit !== undefined && actualExit !== expectedExit) {
      return {
        status: "FAIL",
        details: {
          expected_exit: expectedExit,
          actual_exit: actualExit,
          stdout: stdout.slice(0, 1000),
          stderr: stderr.slice(0, 500),
        },
      };
    }

    // Check output_contains
    if (output_contains && !stdout.includes(output_contains) && !stderr.includes(output_contains)) {
      return {
        status: "FAIL",
        details: {
          expected_output: output_contains,
          actual_output: stdout.slice(0, 1000),
          found_in_stdout: stdout.includes(output_contains),
          found_in_stderr: stderr.includes(output_contains),
        },
      };
    }

    return {
      status: "PASS",
      details: {
        exit_code: actualExit,
        stdout: stdout.slice(0, 1000),
        stderr: stderr.slice(0, 500),
      },
    };
  } catch (e: unknown) {
    if ((e as Error).name === "AbortError") {
      return {
        status: "FAIL",
        details: { error: "Sandbox execution timed out after 60s" },
      };
    }
    return {
      status: "FAIL",
      details: { error: `Sandbox execution error: ${(e as Error).message}` },
    };
  }
}

/**
 * Evaluate sandbox_test spec:
 * - Execute test command via Fly Machine
 * - Check exit_code = 0 for pass
 */
async function evaluateSandboxTest(
  specDef: SandboxSpecDefinition,
  flyUrl: string,
  flyToken: string | null,
  woId: string
): Promise<JSON> {
  const { test_command } = specDef;

  if (!test_command) {
    return {
      status: "FAIL",
      details: { error: "sandbox_test spec missing test_command" },
    };
  }

  const parts = test_command.trim().split(/\s+/);
  const command = parts[0];
  const args = parts.slice(1);

  if (!TEST_ALLOWED.has(command)) {
    return {
      status: "FAIL",
      details: { error: `Test command '${command}' not allowed` },
    };
  }

  try {
    // Git pull first
    try {
      await fetch(`${flyUrl}/git-pull`, {
        method: "POST",
        headers: flyHeaders(flyToken),
        body: "{}",
      });
    } catch {
      // non-fatal
    }

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 120000);

    const response = await fetch(`${flyUrl}/exec`, {
      method: "POST",
      headers: flyHeaders(flyToken),
      signal: ctrl.signal,
      body: JSON.stringify({
        command,
        args,
        timeout_ms: 120000,
        wo_slug: woId,
      }),
    });
    clearTimeout(timer);

    if (!response.ok) {
      return {
        status: "FAIL",
        details: {
          error: `Test execution API error: ${response.status}`,
          status_code: response.status,
        },
      };
    }

    const execResult = await response.json();
    const stdout = execResult.stdout || "";
    const stderr = execResult.stderr || "";
    const actualExit = execResult.exit_code;

    // Test passes if exit_code = 0
    if (actualExit === 0) {
      return {
        status: "PASS",
        details: {
          test_command,
          exit_code: actualExit,
          stdout: stdout.slice(0, 1000),
        },
      };
    } else {
      return {
        status: "FAIL",
        details: {
          test_command,
          expected_exit: 0,
          actual_exit: actualExit,
          stdout: stdout.slice(0, 1000),
          stderr: stderr.slice(0, 500),
        },
      };
    }
  } catch (e: unknown) {
    if ((e as Error).name === "AbortError") {
      return {
        status: "FAIL",
        details: { error: "Test execution timed out after 120s" },
      };
    }
    return {
      status: "FAIL",
      details: { error: `Test execution error: ${(e as Error).message}` },
    };
  }
}

/**
 * Handle external spec evaluation for sandbox types.
 * Evaluates all locked sandbox_exec and sandbox_test specs for a WO.
 */
export async function handleSpecEvaluateExternal(
  body: SpecEvaluateRequest,
  supabase: SupabaseClient
): Promise<Response> {
  const { wo_id, agent_name = "system" } = body;

  if (!wo_id) {
    return json({ success: false, error: "Missing wo_id" }, 400);
  }

  try {
    // 1. Verify WO exists
    const { data: wo, error: woErr } = await supabase
      .from("work_orders")
      .select("id, slug")
      .eq("id", wo_id)
      .single();

    if (woErr || !wo) {
      return json({ success: false, error: `Work order not found: ${woErr?.message}` }, 404);
    }

    // 2. Get sandbox specs that need evaluation
    const { data: specs, error: specsErr } = await supabase
      .from("wo_formal_specs")
      .select("id, ac_index, ac_text, spec_type, spec_definition, evaluation_result, evaluated_at")
      .eq("work_order_id", wo_id)
      .in("spec_type", ["sandbox_exec", "sandbox_test"])
      .is("locked_at", null)
      .order("ac_index");

    if (specsErr) {
      return json({ success: false, error: `Failed to fetch specs: ${specsErr.message}` }, 500);
    }

    if (!specs || specs.length === 0) {
      // Also check locked specs without evaluation_result
      const { data: lockedSpecs } = await supabase
        .from("wo_formal_specs")
        .select("id, ac_index, ac_text, spec_type, spec_definition, evaluation_result, evaluated_at")
        .eq("work_order_id", wo_id)
        .in("spec_type", ["sandbox_exec", "sandbox_test"])
        .is("locked_at", null)
        .is("evaluation_result", null)
        .order("ac_index");

      if (!lockedSpecs || lockedSpecs.length === 0) {
        return json({
          success: true,
          message: "No sandbox specs to evaluate",
          evaluated: 0,
        });
      }
    }

    // 3. Get Fly config
    const { flyUrl, flyToken } = await getFlyConfig(supabase);
    if (!flyUrl) {
      return json({ success: false, error: "Fly Machine URL not configured" }, 500);
    }

    // 4. Evaluate each spec
    const results: Array<{
      spec_id: string;
      ac_index: number;
      spec_type: string;
      status: string;
      error?: string;
    }> = [];

    for (const spec of specs || []) {
      // Skip if already evaluated
      if (spec.evaluation_result && spec.evaluated_at) {
        results.push({
          spec_id: spec.id,
          ac_index: spec.ac_index,
          spec_type: spec.spec_type,
          status: "SKIPPED",
          error: "Already evaluated",
        });
        continue;
      }

      const specDef = spec.spec_definition as SandboxSpecDefinition;
      let evalResult: Record<string, unknown>;

      if (spec.spec_type === "sandbox_exec") {
        evalResult = await evaluateSandboxExec(specDef, flyUrl, flyToken, wo_id);
      } else if (spec.spec_type === "sandbox_test") {
        evalResult = await evaluateSandboxTest(specDef, flyUrl, flyToken, wo_id);
      } else {
        evalResult = { status: "FAIL", details: { error: "Unknown spec type" } };
      }

      // 5. Store evaluation result
      const { error: updateErr } = await supabase
        .from("wo_formal_specs")
        .update({
          evaluation_result: evalResult as any,
          evaluated_at: new Date().toISOString(),
        })
        .eq("id", spec.id);

      if (updateErr) {
        console.error(`[SPEC-EVALUATE] Failed to update spec ${spec.id}:`, updateErr.message);
        results.push({
          spec_id: spec.id,
          ac_index: spec.ac_index,
          spec_type: spec.spec_type,
          status: "ERROR",
          error: updateErr.message,
        });
      } else {
        results.push({
          spec_id: spec.id,
          ac_index: spec.ac_index,
          spec_type: spec.spec_type,
          status: evalResult.status as string,
        });
      }
    }

    const passed = results.filter((r) => r.status === "PASS").length;
    const failed = results.filter((r) => r.status === "FAIL").length;

    return json({
      success: true,
      evaluated: results.length,
      passed,
      failed,
      results,
    });
  } catch (e: unknown) {
    console.error("[SPEC-EVALUATE] Unhandled error:", (e as Error).message);
    return json(
      { success: false, error: `Evaluation exception: ${(e as Error).message}` },
      500
    );
  }
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
