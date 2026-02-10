// batch-executor.ts
// WO-0269: Batch execution modes - handles batch, step, and auto modes
import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";

export interface BatchExecutionResult {
  batch_id: string;
  execution_mode: "step" | "batch" | "auto";
  total_wos: number;
  completed_wos: number;
  failed_wos: number;
  in_progress_wos: number;
  duration_ms: number;
  status: "completed" | "partial" | "in_progress" | "failed";
}

/**
 * Execute a batch of work orders according to the batch's execution_mode
 * - step: execute one WO at a time (backward compatible)
 * - batch: execute multiple independent WOs concurrently, respecting depends_on
 * - auto: fully autonomous - auto-create, auto-approve, auto-execute
 */
export async function executeBatch(
  supabase: SupabaseClient,
  batchId: string
): Promise<BatchExecutionResult> {
  const startTime = Date.now();

  // Get batch details
  const { data: batch, error: batchError } = await supabase
    .from("wo_batches")
    .select("*")
    .eq("id", batchId)
    .single();

  if (batchError || !batch) {
    throw new Error(`Batch not found: ${batchId}`);
  }

  // Validate batch can be executed
  const { data: validation } = await supabase.rpc("validate_batch_execution", {
    p_batch_id: batchId,
  });

  if (!validation?.valid) {
    throw new Error(validation?.error || "Batch validation failed");
  }

  // Start batch execution
  await supabase.rpc("start_batch_execution", {
    p_batch_id: batchId,
    p_executor_agent: "builder",
  });

  const executionMode = batch.execution_mode as "step" | "batch" | "auto";
  const parallelSlots = batch.parallel_slots || 3;

  let result: BatchExecutionResult;

  switch (executionMode) {
    case "step":
      result = await executeStepMode(supabase, batchId);
      break;
    case "batch":
      result = await executeBatchMode(supabase, batchId, parallelSlots);
      break;
    case "auto":
      result = await executeAutoMode(supabase, batchId, parallelSlots);
      break;
    default:
      throw new Error(`Unknown execution mode: ${executionMode}`);
  }

  // Complete batch execution
  await supabase.rpc("complete_batch_execution", {
    p_batch_id: batchId,
    p_summary: `Executed in ${executionMode} mode: ${result.completed_wos}/${result.total_wos} completed`,
  });

  result.duration_ms = Date.now() - startTime;
  return result;
}

/**
 * STEP MODE: Execute one WO at a time (backward compatible)
 * Process WOs sequentially in priority order
 */
async function executeStepMode(
  supabase: SupabaseClient,
  batchId: string
): Promise<BatchExecutionResult> {
  const result: BatchExecutionResult = {
    batch_id: batchId,
    execution_mode: "step",
    total_wos: 0,
    completed_wos: 0,
    failed_wos: 0,
    in_progress_wos: 0,
    duration_ms: 0,
    status: "in_progress",
  };

  // Get all WOs in batch
  const { data: wos } = await supabase
    .from("work_orders")
    .select("id, slug, status")
    .eq("batch_id", batchId)
    .order("execution_rank", { ascending: true })
    .order("priority", { ascending: true });

  result.total_wos = wos?.length || 0;

  if (!wos || wos.length === 0) {
    result.status = "completed";
    return result;
  }

  // Execute one at a time
  for (const wo of wos) {
    if (wo.status === "done") {
      result.completed_wos++;
      continue;
    }

    if (wo.status === "failed" || wo.status === "cancelled") {
      result.failed_wos++;
      continue;
    }

    // Execute this WO (only if ready)
    if (wo.status === "draft" || wo.status === "ready") {
      try {
        // Start WO
        await supabase.rpc("start_work_order", {
          p_work_order_id: wo.id,
          p_agent_name: "builder",
        });

        // Execute via wo-agent
        const executeUrl = `${Deno.env.get("SUPABASE_URL")}/functions/v1/wo-agent/execute`;
        const anonKey = Deno.env.get("SUPABASE_ANON_KEY") || "";
        
        const response = await fetch(executeUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${anonKey}`,
            "apikey": anonKey,
          },
          body: JSON.stringify({ work_order_id: wo.id }),
        });

        if (response.ok) {
          result.completed_wos++;
        } else {
          result.failed_wos++;
        }
      } catch (error) {
        console.error(`[BATCH] Failed to execute ${wo.slug}:`, error);
        result.failed_wos++;
      }
    }
  }

  result.status = result.failed_wos > 0 ? "partial" : "completed";
  return result;
}

/**
 * BATCH MODE: Execute multiple independent WOs concurrently
 * Respects depends_on ordering and parallel_slots limit
 */
async function executeBatchMode(
  supabase: SupabaseClient,
  batchId: string,
  parallelSlots: number
): Promise<BatchExecutionResult> {
  const result: BatchExecutionResult = {
    batch_id: batchId,
    execution_mode: "batch",
    total_wos: 0,
    completed_wos: 0,
    failed_wos: 0,
    in_progress_wos: 0,
    duration_ms: 0,
    status: "in_progress",
  };

  // Count total WOs
  const { count } = await supabase
    .from("work_orders")
    .select("id", { count: "exact", head: true })
    .eq("batch_id", batchId);

  result.total_wos = count || 0;

  if (result.total_wos === 0) {
    result.status = "completed";
    return result;
  }

  // Track active executions
  const activeExecutions: Set<string> = new Set();
  const completedWOs: Set<string> = new Set();
  const failedWOs: Set<string> = new Set();

  // Keep polling for ready WOs until all are done
  let iterations = 0;
  const maxIterations = 100; // Safety limit

  while (iterations < maxIterations) {
    iterations++;

    // Get WOs ready to execute (dependencies satisfied)
    const { data: readyWOs } = await supabase.rpc("get_batch_ready_wos", {
      p_batch_id: batchId,
    });

    if (!readyWOs || readyWOs.length === 0) {
      // No more ready WOs - check if we're done
      if (activeExecutions.size === 0) {
        break; // All done
      }
      // Wait for active executions to complete
      await new Promise((resolve) => setTimeout(resolve, 2000));
      continue;
    }

    // Execute ready WOs up to parallel slot limit
    const slotsAvailable = parallelSlots - activeExecutions.size;
    const wosToExecute = readyWOs.slice(0, slotsAvailable);

    for (const wo of wosToExecute) {
      if (completedWOs.has(wo.work_order_id) || failedWOs.has(wo.work_order_id)) {
        continue;
      }

      activeExecutions.add(wo.work_order_id);

      // Execute asynchronously
      executeWorkOrder(supabase, wo.work_order_id, wo.slug)
        .then((success) => {
          activeExecutions.delete(wo.work_order_id);
          if (success) {
            completedWOs.add(wo.work_order_id);
          } else {
            failedWOs.add(wo.work_order_id);
          }
        })
        .catch((error) => {
          console.error(`[BATCH] Error executing ${wo.slug}:`, error);
          activeExecutions.delete(wo.work_order_id);
          failedWOs.add(wo.work_order_id);
        });
    }

    // Wait before next poll
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  // Wait for any remaining active executions
  while (activeExecutions.size > 0) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  result.completed_wos = completedWOs.size;
  result.failed_wos = failedWOs.size;
  result.status = result.failed_wos > 0 ? "partial" : "completed";

  return result;
}

/**
 * AUTO MODE: Fully autonomous execution
 * Auto-creates batch from project decomposition, auto-approves, auto-executes
 * Restricted to P2+ priority WOs only
 */
async function executeAutoMode(
  supabase: SupabaseClient,
  batchId: string,
  parallelSlots: number
): Promise<BatchExecutionResult> {
  // Auto mode uses batch mode execution but with auto-approval
  // The validation already ensures P2+ only

  // Auto-approve the batch if not already approved
  const { data: batch } = await supabase
    .from("wo_batches")
    .select("batch_approved_at")
    .eq("id", batchId)
    .single();

  if (!batch?.batch_approved_at) {
    await supabase
      .from("wo_batches")
      .update({
        batch_approved_by: "auto-mode",
        batch_approved_at: new Date().toISOString(),
        requires_batch_approval: false,
      })
      .eq("id", batchId);
  }

  // Auto-approve all WOs in the batch
  const { data: wos } = await supabase
    .from("work_orders")
    .select("id")
    .eq("batch_id", batchId)
    .eq("requires_approval", true);

  if (wos && wos.length > 0) {
    for (const wo of wos) {
      await supabase.rpc("update_work_order_state", {
        p_work_order_id: wo.id,
        p_approved_at: new Date().toISOString(),
        p_approved_by: "auto-mode",
      });
    }
  }

  // Execute using batch mode
  const result = await executeBatchMode(supabase, batchId, parallelSlots);
  result.execution_mode = "auto";

  return result;
}

/**
 * Execute a single work order
 */
async function executeWorkOrder(
  supabase: SupabaseClient,
  workOrderId: string,
  slug: string
): Promise<boolean> {
  try {
    // Start the WO
    await supabase.rpc("start_work_order", {
      p_work_order_id: workOrderId,
      p_agent_name: "builder",
    });

    // Execute via wo-agent endpoint
    const executeUrl = `${Deno.env.get("SUPABASE_URL")}/functions/v1/wo-agent/execute`;
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY") || "";

    const response = await fetch(executeUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${anonKey}`,
        "apikey": anonKey,
      },
      body: JSON.stringify({ work_order_id: workOrderId }),
    });

    if (!response.ok) {
      console.error(`[BATCH] Failed to execute ${slug}: ${response.statusText}`);
      return false;
    }

    const result = await response.json();
    return result.status === "completed" || result.status === "review";
  } catch (error) {
    console.error(`[BATCH] Error executing ${slug}:`, error);
    return false;
  }
}
