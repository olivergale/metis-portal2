// test-deploy-fail v2
// Test edge function for WO-TEST-DEPLOY-FAIL
// This function validates that deployment gates properly block completion when build fails
// Updated: Added build failure simulation and deployment error logging

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

Deno.serve(async (req: Request) => {
  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  try {
    const { work_order_id } = await req.json();

    if (!work_order_id) {
      return new Response(
        JSON.stringify({
          error: "work_order_id required",
          message: "This test function requires a work_order_id to simulate deployment failure"
        }),
        {
          headers: { "Content-Type": "application/json" },
          status: 400
        }
      );
    }

    // Log a failed build status to trigger deployment validation gate
    await supabase
      .from("work_order_execution_log")
      .insert({
        work_order_id,
        phase: "deploying",
        agent_name: "test-deploy-fail",
        detail: {
          build_status: "failed",
          error: "Simulated build failure for deployment gate testing",
          test_scenario: "WO-TEST-DEPLOY-FAIL",
          timestamp: new Date().toISOString()
        },
        iteration: 1
      });

    // Also log a critical deployment error
    await supabase
      .from("work_order_execution_log")
      .insert({
        work_order_id,
        phase: "completing",
        agent_name: "test-deploy-fail",
        detail: {
          status: "error",
          critical_error: true,
          error: "Critical deployment validation failure",
          test_scenario: "WO-TEST-DEPLOY-FAIL",
          timestamp: new Date().toISOString()
        },
        iteration: 1
      });

    return new Response(
      JSON.stringify({
        success: true,
        message: "Deployment failure conditions created successfully",
        work_order_id,
        logged_failures: [
          "build_status: failed in deploying phase",
          "critical_error in completing phase"
        ],
        next_step: "Attempt to complete this work order - it should be blocked by deployment validation gate",
        timestamp: new Date().toISOString()
      }),
      {
        headers: { "Content-Type": "application/json" },
        status: 200
      }
    );
  } catch (error) {
    return new Response(
      JSON.stringify({
        error: (error as Error).message,
        test_scenario: "WO-TEST-DEPLOY-FAIL"
      }),
      {
        headers: { "Content-Type": "application/json" },
        status: 500
      }
    );
  }
});