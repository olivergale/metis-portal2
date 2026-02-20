// verify/handlers/spec-evaluate.ts
// Phase 4B: Evaluate sandbox_exec and sandbox_test formal specs externally
// Calls Fly Machine sandbox, stores results, then runs evaluate_formal_specs
// and handles WO transitions (PASS → qa_passed, FAIL → qa_failed, other → LLM QA)

import { SupabaseClient } from "jsr:@supabase/supabase-js@2";

interface SpecEvaluateRequest {
  wo_id: string;
}

interface FormalSpec {
  id: string;
  ac_index: number;
  ac_text: string;
  spec_type: string;
  spec_definition: Record<string, unknown>;
}

interface EvalCheck {
  check: string;
  expected: unknown;
  actual: unknown;
  passed: boolean;
}

interface EvalResult {
  status: "PASS" | "FAIL" | "ERROR";
  exit_code?: number;
  stdout?: string;
  stderr?: string;
  checks: EvalCheck[];
}

/**
 * Evaluate all sandbox_exec and sandbox_test formal specs for a WO.
 * After evaluation, calls evaluate_formal_specs RPC and handles transitions.
 */
export async function handleSpecEvaluateExternal(
  body: SpecEvaluateRequest,
  supabase: SupabaseClient
): Promise<Response> {
  const { wo_id } = body;

  if (!wo_id) {
    return json({ success: false, error: "Missing wo_id" }, 400);
  }

  try {
    // 1. Get Fly Machine config
    const { data: settings } = await supabase
      .from("system_settings")
      .select("setting_key, setting_value")
      .in("setting_key", ["fly_machine_url", "fly_machine_token"]);

    const flyUrl =
      settings?.find((s: { setting_key: string }) => s.setting_key === "fly_machine_url")
        ?.setting_value || null;
    const flyToken =
      settings?.find((s: { setting_key: string }) => s.setting_key === "fly_machine_token")
        ?.setting_value || null;

    if (!flyUrl) {
      return json(
        { success: false, error: "fly_machine_url not configured in system_settings" },
        500
      );
    }

    // 2. Get sandbox specs needing evaluation
    const { data: specs, error: specErr } = await supabase
      .from("wo_formal_specs")
      .select("id, ac_index, ac_text, spec_type, spec_definition")
      .eq("work_order_id", wo_id)
      .in("spec_type", ["sandbox_exec", "sandbox_test"])
      .not("locked_at", "is", null)
      .is("evaluation_result", null)
      .order("ac_index");

    if (specErr) {
      return json(
        { success: false, error: `Failed to fetch specs: ${specErr.message}` },
        500
      );
    }

    // 3. Evaluate each sandbox spec
    const results: Array<{
      ac_index: number;
      spec_type: string;
      result: EvalResult;
    }> = [];

    if (specs && specs.length > 0) {
      for (const spec of specs as FormalSpec[]) {
        const result = await evaluateSandboxSpec(spec, flyUrl, flyToken);
        results.push({
          ac_index: spec.ac_index,
          spec_type: spec.spec_type,
          result,
        });

        // Store result in wo_formal_specs
        await supabase
          .from("wo_formal_specs")
          .update({
            evaluation_result: result,
            evaluated_at: new Date().toISOString(),
          })
          .eq("id", spec.id);
      }
    }

    // 4. Run full evaluation (SQL + sandbox with stored results)
    return await evaluateAndTransition(wo_id, supabase, results);
  } catch (e: unknown) {
    console.error(
      "[SPEC-EVALUATE] Unhandled error:",
      (e as Error).message
    );
    return json(
      {
        success: false,
        error: `Spec evaluation error: ${(e as Error).message}`,
      },
      500
    );
  }
}

/**
 * Evaluate a single sandbox spec against the Fly Machine.
 */
async function evaluateSandboxSpec(
  spec: FormalSpec,
  flyUrl: string,
  flyToken: string | null
): Promise<EvalResult> {
  const def = spec.spec_definition;
  const checks: EvalCheck[] = [];

  try {
    let command: string;
    let args: string[] = [];
    let timeout_ms = 30000;

    if (spec.spec_type === "sandbox_exec") {
      command = (def.command as string) || "";
      args = (def.args as string[]) || [];
      timeout_ms = (def.timeout_ms as number) || 30000;
    } else {
      // sandbox_test
      command = (def.test_command as string) || "npm test";
      args = (def.args as string[]) || [];
      timeout_ms = 120000;
    }

    if (!command) {
      return {
        status: "ERROR",
        checks: [
          {
            check: "command_present",
            expected: "non-empty",
            actual: "",
            passed: false,
          },
        ],
      };
    }

    // Build headers
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (flyToken && flyToken !== "not_required_public_endpoint") {
      headers["Authorization"] = `Bearer ${flyToken}`;
    }

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeout_ms + 5000);

    let response: Response;
    try {
      // For sandbox_test, git-pull first to ensure latest code
      if (spec.spec_type === "sandbox_test") {
        await fetch(`${flyUrl}/git-pull`, {
          method: "POST",
          headers,
          body: "{}",
        });
      }

      response = await fetch(`${flyUrl}/exec`, {
        method: "POST",
        headers,
        signal: ctrl.signal,
        body: JSON.stringify({
          command,
          args,
          timeout_ms,
          wo_slug: "formal-verify",
        }),
      });
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      const errText = await response.text();
      return {
        status: "ERROR",
        checks: [
          {
            check: "fly_response",
            expected: "200",
            actual: String(response.status),
            passed: false,
          },
        ],
        stderr: errText.slice(0, 1000),
      };
    }

    const execResult = await response.json();
    const exitCode = execResult.exit_code ?? -1;
    const stdout = (execResult.stdout || "") as string;
    const stderr = (execResult.stderr || "") as string;

    // Check exit code
    const expectedExitCode = (def.expected_exit_code as number) ?? 0;
    checks.push({
      check: "exit_code",
      expected: expectedExitCode,
      actual: exitCode,
      passed: exitCode === expectedExitCode,
    });

    // Check output_contains
    if (def.output_contains) {
      const needle = def.output_contains as string;
      const haystack = stdout + stderr;
      checks.push({
        check: "output_contains",
        expected: needle,
        actual: haystack.slice(0, 200),
        passed: haystack.includes(needle),
      });
    }

    // Check output_not_contains
    if (def.output_not_contains) {
      const needle = def.output_not_contains as string;
      const haystack = stdout + stderr;
      checks.push({
        check: "output_not_contains",
        expected: `NOT ${needle}`,
        actual: haystack.slice(0, 200),
        passed: !haystack.includes(needle),
      });
    }

    // Check output_regex
    if (def.output_regex) {
      const pattern = def.output_regex as string;
      const haystack = stdout + stderr;
      const match = new RegExp(pattern).test(haystack);
      checks.push({
        check: "output_regex",
        expected: pattern,
        actual: haystack.slice(0, 200),
        passed: match,
      });
    }

    const allPassed = checks.every((c) => c.passed);
    return {
      status: allPassed ? "PASS" : "FAIL",
      exit_code: exitCode,
      stdout: stdout.slice(0, 2000),
      stderr: stderr.slice(0, 2000),
      checks,
    };
  } catch (e: unknown) {
    return {
      status: "ERROR",
      checks: [
        {
          check: "execution",
          expected: "success",
          actual: (e as Error).message,
          passed: false,
        },
      ],
    };
  }
}

/**
 * Run evaluate_formal_specs and handle WO transitions.
 * PASS → certificate + qa_passed
 * FAIL → qa_failed
 * Other → dispatch to LLM QA
 */
async function evaluateAndTransition(
  woId: string,
  supabase: SupabaseClient,
  sandboxResults: Array<{
    ac_index: number;
    spec_type: string;
    result: EvalResult;
  }>
): Promise<Response> {
  // Call evaluate_formal_specs RPC
  const { data: evalResult, error: evalErr } = await supabase.rpc(
    "evaluate_formal_specs",
    { p_work_order_id: woId }
  );

  if (evalErr) {
    return json(
      {
        success: false,
        error: `evaluate_formal_specs failed: ${evalErr.message}`,
      },
      500
    );
  }

  const verdict = evalResult?.verdict || "UNKNOWN";

  if (verdict === "PASS") {
    // Generate certificate
    const { data: certResult } = await supabase.rpc(
      "generate_verification_certificate",
      { p_work_order_id: woId }
    );

    // Auto-transition to qa_passed
    const { data: transResult } = await supabase.rpc("wo_transition", {
      p_work_order_id: woId,
      p_event: "qa_passed",
      p_client_info: {
        auto_verified: true,
        method: "formal_verification",
        verdict: "CERTIFIED",
        sandbox_evaluated: sandboxResults.length,
        receipt_id: certResult?.receipt_id,
      },
      p_actor: "system",
      p_nonce: 1,
    });

    return json({
      success: true,
      verdict: "PASS",
      certified: true,
      receipt_id: certResult?.receipt_id,
      auto_transitioned: transResult?.success ?? false,
      sandbox_results: sandboxResults,
    });
  } else if (verdict === "FAIL") {
    // Auto-transition to qa_failed
    const failedSpecs = evalResult?.results?.filter(
      (r: { status: string }) => r.status === "FAIL"
    );

    const { data: transResult } = await supabase.rpc("wo_transition", {
      p_work_order_id: woId,
      p_event: "qa_failed",
      p_client_info: {
        method: "formal_verification",
        verdict: "FAIL",
        failed_specs: failedSpecs,
        passed: evalResult?.passed,
        failed: evalResult?.failed,
        sandbox_evaluated: sandboxResults.length,
      },
      p_actor: "system",
      p_nonce: 1,
    });

    return json({
      success: true,
      verdict: "FAIL",
      evaluation: evalResult,
      auto_transitioned: transResult?.success ?? false,
      sandbox_results: sandboxResults,
    });
  } else {
    // PARTIAL, UNVERIFIABLE, NO_SPECS — defer to LLM QA
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    try {
      await fetch(`${supabaseUrl}/functions/v1/qa-review`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${serviceKey}`,
          apikey: serviceKey,
        },
        body: JSON.stringify({ work_order_id: woId }),
      });
    } catch (e: unknown) {
      console.error(
        "[SPEC-EVALUATE] QA dispatch failed:",
        (e as Error).message
      );
    }

    return json({
      success: true,
      verdict,
      deferred_to_llm_qa: true,
      evaluation: evalResult,
      sandbox_results: sandboxResults,
    });
  }
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
