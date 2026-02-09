// deploy-smoke-test/index.ts v1
// WO-0107: Post-deploy smoke test for critical Edge Function endpoints
// Tests that endpoints return expected status codes after deployment

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

interface SmokeTestResult {
  endpoint: string;
  method: string;
  expected_status: number;
  actual_status: number;
  passed: boolean;
  error?: string;
  response_body?: any;
  handler_count?: number;
}

interface SmokeTestSuite {
  function_name: string;
  endpoints: Array<{
    path: string;
    method: string;
    expected_status: number;
    body?: any;
    validate?: (response: any) => { passed: boolean; error?: string };
  }>;
}

const SMOKE_TEST_SUITES: Record<string, SmokeTestSuite> = {
  "work-order-executor": {
    function_name: "work-order-executor",
    endpoints: [
      {
        path: "/status",
        method: "GET",
        expected_status: 200,
        validate: (data: any) => {
          if (!data.version) {
            return { passed: false, error: "Missing version field" };
          }
          if (!data.counts) {
            return { passed: false, error: "Missing counts field" };
          }
          if (typeof data.handler_count !== 'number') {
            return { passed: false, error: "Missing or invalid handler_count field" };
          }
          return { passed: true };
        },
      },
      {
        path: "/poll",
        method: "GET",
        expected_status: 200,
        validate: (data: any) => {
          if (!Array.isArray(data.work_orders)) {
            return { passed: false, error: "Missing work_orders array" };
          }
          if (typeof data.count !== 'number') {
            return { passed: false, error: "Missing count field" };
          }
          return { passed: true };
        },
      },
    ],
  },
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  try {
    const { function_name, work_order_id } = await req.json();

    if (!function_name) {
      return new Response(
        JSON.stringify({ error: "function_name required" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const suite = SMOKE_TEST_SUITES[function_name];
    if (!suite) {
      return new Response(
        JSON.stringify({
          error: `No smoke test suite configured for ${function_name}`,
          available_suites: Object.keys(SMOKE_TEST_SUITES),
        }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const baseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const results: SmokeTestResult[] = [];
    let allPassed = true;

    for (const endpoint of suite.endpoints) {
      const url = `${baseUrl}/functions/v1/${function_name}${endpoint.path}`;
      const fetchOptions: RequestInit = {
        method: endpoint.method,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${serviceKey}`,
        },
      };

      if (endpoint.body) {
        fetchOptions.body = JSON.stringify(endpoint.body);
      }

      try {
        const response = await fetch(url, fetchOptions);
        const status = response.status;
        let responseBody: any;

        try {
          responseBody = await response.json();
        } catch {
          responseBody = await response.text();
        }

        let passed = status === endpoint.expected_status;
        let validationError: string | undefined;

        if (passed && endpoint.validate) {
          const validation = endpoint.validate(responseBody);
          passed = validation.passed;
          validationError = validation.error;
        }

        if (!passed) allPassed = false;

        results.push({
          endpoint: endpoint.path,
          method: endpoint.method,
          expected_status: endpoint.expected_status,
          actual_status: status,
          passed,
          error: validationError || (status !== endpoint.expected_status ? `Status mismatch` : undefined),
          response_body: responseBody,
          handler_count: responseBody?.handler_count,
        });
      } catch (error) {
        allPassed = false;
        results.push({
          endpoint: endpoint.path,
          method: endpoint.method,
          expected_status: endpoint.expected_status,
          actual_status: 0,
          passed: false,
          error: (error as Error).message,
        });
      }
    }

    // Log smoke test results to audit_log
    await supabase.from("audit_log").insert({
      event_type: allPassed ? "deploy_smoke_test_passed" : "deploy_smoke_test_failed",
      actor_type: "system",
      actor_id: "deploy-smoke-test",
      target_type: "edge_function",
      action: "smoke_test",
      payload: {
        function_name,
        work_order_id: work_order_id || null,
        results,
        all_passed: allPassed,
      },
    });

    // If smoke test failed, create a P0 lesson
    if (!allPassed) {
      const failures = results.filter((r) => !r.passed);
      const failureDetails = failures
        .map((f) => `${f.method} ${f.endpoint}: ${f.error || "status " + f.actual_status}`)
        .join("; ");

      try {
        await supabase.rpc("auto_create_lesson", {
          p_failure_source: "deploy_smoke_test",
          p_error_message: `Smoke test failed for ${function_name}: ${failureDetails}`,
          p_context: {
            function_name,
            work_order_id: work_order_id || null,
            failure_count: failures.length,
            failures: failures.map((f) => ({
              endpoint: f.endpoint,
              error: f.error,
              actual_status: f.actual_status,
            })),
          },
          p_work_order_id: work_order_id || null,
        });
      } catch (lessonErr) {
        console.error("[SMOKE-TEST] Failed to create lesson:", lessonErr);
      }
    }

    return new Response(
      JSON.stringify({
        function_name,
        all_passed: allPassed,
        test_count: results.length,
        passed_count: results.filter((r) => r.passed).length,
        failed_count: results.filter((r) => !r.passed).length,
        results,
      }),
      {
        status: allPassed ? 200 : 422,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  } catch (error) {
    console.error("[SMOKE-TEST] Unhandled error:", error);
    return new Response(
      JSON.stringify({
        error: (error as Error).message,
        error_code: "ERR_INTERNAL",
      }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
