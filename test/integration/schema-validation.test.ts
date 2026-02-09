// Integration test: Schema validation
// Tests that critical tables and RPCs exist

import { assertEquals, assertExists } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { getTestConfig } from "../config.ts";

const config = getTestConfig();

Deno.test("Schema: work_orders table exists", async () => {
  const response = await fetch(
    `${config.supabaseUrl}/rest/v1/work_orders?select=id&limit=1`,
    {
      headers: {
        "apikey": config.supabaseKey,
        "Authorization": `Bearer ${config.supabaseKey}`,
      },
    }
  );

  assertEquals(response.ok, true, "work_orders table should be accessible");
});

Deno.test("Schema: agents table exists", async () => {
  const response = await fetch(
    `${config.supabaseUrl}/rest/v1/agents?select=id&limit=1`,
    {
      headers: {
        "apikey": config.supabaseKey,
        "Authorization": `Bearer ${config.supabaseKey}`,
      },
    }
  );

  assertEquals(response.ok, true, "agents table should be accessible");
});

Deno.test("Schema: create_draft_work_order RPC exists", async () => {
  const response = await fetch(`${config.supabaseUrl}/rest/v1/rpc/create_draft_work_order`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "apikey": config.supabaseKey,
      "Authorization": `Bearer ${config.supabaseKey}`,
    },
    body: JSON.stringify({
      p_slug: "WO-SCHEMA-TEST",
      p_name: "Schema test",
      p_objective: "Test RPC exists",
    }),
  });

  assertExists(response, "RPC should respond");
  assertEquals(response.status < 500, true, "RPC should not return 5xx error");
});

Deno.test("Schema: start_work_order RPC exists", async () => {
  const response = await fetch(`${config.supabaseUrl}/rest/v1/rpc/start_work_order`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "apikey": config.supabaseKey,
      "Authorization": `Bearer ${config.supabaseKey}`,
    },
    body: JSON.stringify({
      p_work_order_id: "00000000-0000-0000-0000-000000000000",
      p_agent_name: "test",
    }),
  });

  assertExists(response, "RPC should respond");
  // May fail due to invalid WO ID, but function should exist
  assertEquals(response.status !== 404, true, "RPC should exist");
});

Deno.test("Schema: system_manifest table exists", async () => {
  const response = await fetch(
    `${config.supabaseUrl}/rest/v1/system_manifest?select=id&limit=1`,
    {
      headers: {
        "apikey": config.supabaseKey,
        "Authorization": `Bearer ${config.supabaseKey}`,
      },
    }
  );

  assertEquals(response.ok, true, "system_manifest table should be accessible");
});
