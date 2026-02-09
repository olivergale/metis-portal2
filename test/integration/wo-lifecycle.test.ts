// Integration test: Work Order lifecycle validation
// Tests: create → start → review → complete

import { assertEquals, assertExists } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { getTestConfig, cleanupTestWorkOrders } from "../config.ts";

const config = getTestConfig();

// Helper: Create draft work order
async function createDraftWorkOrder(name: string, objective: string) {
  const response = await fetch(`${config.supabaseUrl}/rest/v1/rpc/create_draft_work_order`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "apikey": config.supabaseKey,
      "Authorization": `Bearer ${config.supabaseKey}`,
    },
    body: JSON.stringify({
      p_slug: `WO-TEST-${crypto.randomUUID().slice(0, 8)}`,
      p_name: name,
      p_objective: objective,
      p_priority: "p3_low",
      p_source: "test",
    }),
  });

  const data = await response.json();
  return data;
}

// Helper: Get work order by ID
async function getWorkOrder(workOrderId: string) {
  const response = await fetch(
    `${config.supabaseUrl}/rest/v1/work_orders?id=eq.${workOrderId}&select=*`,
    {
      headers: {
        "apikey": config.supabaseKey,
        "Authorization": `Bearer ${config.supabaseKey}`,
      },
    }
  );

  const data = await response.json();
  return data[0];
}

// Helper: Start work order
async function startWorkOrder(workOrderId: string) {
  const response = await fetch(`${config.supabaseUrl}/rest/v1/rpc/start_work_order`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "apikey": config.supabaseKey,
      "Authorization": `Bearer ${config.supabaseKey}`,
    },
    body: JSON.stringify({
      p_work_order_id: workOrderId,
      p_agent_name: "test-agent",
    }),
  });

  const data = await response.json();
  return data;
}

// Helper: Update work order status
async function updateWorkOrderStatus(workOrderId: string, status: string) {
  const response = await fetch(`${config.supabaseUrl}/rest/v1/rpc/update_work_order_state`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "apikey": config.supabaseKey,
      "Authorization": `Bearer ${config.supabaseKey}`,
    },
    body: JSON.stringify({
      p_work_order_id: workOrderId,
      p_status: status,
    }),
  });

  const data = await response.json();
  return data;
}

Deno.test("WO Lifecycle: Create draft work order", async () => {
  const result = await createDraftWorkOrder(
    "Test WO - Create",
    "Test objective for create validation"
  );

  assertExists(result.id, "Work order ID should exist");
  assertEquals(result.status, "draft", "Initial status should be draft");
  assertExists(result.slug, "Slug should be generated");
});

Deno.test("WO Lifecycle: Start work order", async () => {
  // Create a draft WO
  const createResult = await createDraftWorkOrder(
    "Test WO - Start",
    "Test objective for start validation"
  );

  const workOrderId = createResult.id;

  // Start the work order
  const startResult = await startWorkOrder(workOrderId);

  assertEquals(startResult.success, true, "Start should succeed");

  // Verify status changed
  const wo = await getWorkOrder(workOrderId);
  assertEquals(wo.status, "in_progress", "Status should be in_progress");
  assertExists(wo.started_at, "started_at should be set");
});

Deno.test("WO Lifecycle: Move to review", async () => {
  // Create and start a WO
  const createResult = await createDraftWorkOrder(
    "Test WO - Review",
    "Test objective for review validation"
  );

  const workOrderId = createResult.id;
  await startWorkOrder(workOrderId);

  // Move to review
  const reviewResult = await updateWorkOrderStatus(workOrderId, "review");

  assertEquals(reviewResult.success, true, "Review transition should succeed");

  // Verify status
  const wo = await getWorkOrder(workOrderId);
  assertEquals(wo.status, "review", "Status should be review");
});

Deno.test("WO Lifecycle: Complete work order", async () => {
  // Create, start, and review a WO
  const createResult = await createDraftWorkOrder(
    "Test WO - Complete",
    "Test objective for complete validation"
  );

  const workOrderId = createResult.id;
  await startWorkOrder(workOrderId);
  await updateWorkOrderStatus(workOrderId, "review");

  // Complete the work order
  const completeResult = await updateWorkOrderStatus(workOrderId, "done");

  assertEquals(completeResult.success, true, "Complete transition should succeed");

  // Verify status
  const wo = await getWorkOrder(workOrderId);
  assertEquals(wo.status, "done", "Status should be done");
  assertExists(wo.completed_at, "completed_at should be set");
});

// Cleanup after all tests
Deno.test("Cleanup test work orders", async () => {
  await cleanupTestWorkOrders(config.supabaseUrl, config.supabaseKey);
});
