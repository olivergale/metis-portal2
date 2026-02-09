// Integration test: Edge function validation
// Tests edge function availability and basic functionality

import { assertEquals, assertExists } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { getTestConfig } from "../config.ts";

const config = getTestConfig();

Deno.test("Edge Function: work-order endpoint exists", async () => {
  const response = await fetch(`${config.supabaseUrl}/functions/v1/work-order`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${config.supabaseKey}`,
    },
    body: JSON.stringify({
      action: "get",
      work_order_id: "00000000-0000-0000-0000-000000000000",
    }),
  });

  // Even if WO doesn't exist, function should respond
  assertExists(response, "Response should exist");
  assertEquals(response.status < 500, true, "Should not return 5xx error");
});

Deno.test("Edge Function: context-load endpoint exists", async () => {
  const response = await fetch(`${config.supabaseUrl}/functions/v1/context-load`, {
    method: "GET",
    headers: {
      "Authorization": `Bearer ${config.supabaseKey}`,
    },
  });

  assertEquals(response.ok, true, "context-load should respond successfully");

  const data = await response.json();
  assertExists(data, "Response data should exist");
});

Deno.test("Edge Function: orchestrate endpoint exists", async () => {
  const response = await fetch(`${config.supabaseUrl}/functions/v1/orchestrate`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${config.supabaseKey}`,
    },
    body: JSON.stringify({
      message: "health check",
      mode: "test",
    }),
  });

  assertExists(response, "Response should exist");
  assertEquals(response.status < 500, true, "Should not return 5xx error");
});
