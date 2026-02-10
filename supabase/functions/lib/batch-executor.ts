// batch-executor.ts
// WO-0269: Batch execution modes - handles batch, step, and auto modes
import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";

export interface BatchExecutionResult {
  batch_id: string;
  mode: "step" | "batch" | "auto";
  completed: boolean;
  wos_completed: string[];
  wos_failed: string[];
  error?: string;
}

export interface WorkOrder {
  id: string;
  slug: string;
  name: string;
  status: string;
  priority: string;
  depends_on: string[] | null;
}

/**
 * Execute batch in STEP mode - one WO at a time, sequential
 * Maintains backward compatibility with current system behavior
 */
export async function executeStepMode(
  supabase: SupabaseClient,
  batchId: string
): Promise<BatchExecutionResult> {
  const result: BatchExecutionResult = {
    batch_id: batchId,
    mode: "step",
    completed: false,
    wos_completed: [],
    wos_failed: [],
  };

  try {
    // Start batch execution
    await supabase.rpc("start_batch_execution", { p_batch_id: batchId });

    // Get ready WOs (respects execution_rank and priority)
    let hasMore = true;
    while (hasMore) {
      const { data: readyWOs, error } = await supabase.rpc("get_batch_ready_wos", {
        p_batch_id: batchId,
        p_limit: 1, // Step mode: one at a time
      });

      if (error) throw error;
      if (!readyWOs || readyWOs.length === 0) {
        hasMore = false;
        break;
      }

      const wo = readyWOs[0];
      
      // Execute WO via work-order-executor
      const { data: execResult, error: execError } = await supabase.functions.invoke(
        "work-order-executor",
        {
          body: { action: "execute", work_order_id: wo.id },
        }
      );

      if (execError || !execResult?.success) {
        result.wos_failed.push(wo.slug);
      } else {
        result.wos_completed.push(wo.slug);
      }

      // Poll for completion before moving to next WO
      await waitForWOCompletion(supabase, wo.id);
    }

    // Complete batch execution
    await supabase.rpc("complete_batch_execution", { p_batch_id: batchId });
    result.completed = true;

  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
  }

  return result;
}

/**
 * Execute batch in BATCH mode - concurrent with dependency ordering
 * Respects depends_on relationships and parallel_slots limit
 */
export async function executeBatchMode(
  supabase: SupabaseClient,
  batchId: string,
  parallelSlots = 3
): Promise<BatchExecutionResult> {
  const result: BatchExecutionResult = {
    batch_id: batchId,
    mode: "batch",
    completed: false,
    wos_completed: [],
    wos_failed: [],
  };

  try {
    // Start batch execution
    await supabase.rpc("start_batch_execution", { p_batch_id: batchId });

    const activeExecutions = new Map<string, Promise<void>>();

    while (true) {
      // Get ready WOs that have no pending dependencies
      const { data: readyWOs, error } = await supabase.rpc("get_batch_ready_wos", {
        p_batch_id: batchId,
        p_limit: parallelSlots - activeExecutions.size,
      });

      if (error) throw error;

      // Start new executions
      if (readyWOs && readyWOs.length > 0) {
        for (const wo of readyWOs) {
          const executionPromise = executeWorkOrder(supabase, wo, result);
          activeExecutions.set(wo.id, executionPromise);

          // Clean up when done
          executionPromise.finally(() => {
            activeExecutions.delete(wo.id);
          });
        }
      }

      // If no active executions and no ready WOs, we're done
      if (activeExecutions.size === 0 && (!readyWOs || readyWOs.length === 0)) {
        break;
      }

      // Wait a bit before polling again
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }

    // Wait for all active executions to complete
    await Promise.all(Array.from(activeExecutions.values()));

    // Complete batch execution
    await supabase.rpc("complete_batch_execution", { p_batch_id: batchId });
    result.completed = true;

  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
  }

  return result;
}

/**
 * Execute batch in AUTO mode - fully autonomous
 * Auto-approves batch and all WOs, then executes in batch mode
 */
export async function executeAutoMode(
  supabase: SupabaseClient,
  batchId: string,
  parallelSlots = 3
): Promise<BatchExecutionResult> {
  const result: BatchExecutionResult = {
    batch_id: batchId,
    mode: "auto",
    completed: false,
    wos_completed: [],
    wos_failed: [],
  };

  try {
    // Auto-approve the batch
    const { error: batchApprovalError } = await supabase
      .from("wo_batches")
      .update({
        requires_batch_approval: false,
        approved_at: new Date().toISOString(),
        approved_by: "auto-mode",
      })
      .eq("id", batchId);

    if (batchApprovalError) throw batchApprovalError;

    // Auto-approve all WOs in the batch
    const { error: woApprovalError } = await supabase
      .from("work_orders")
      .update({
        requires_approval: false,
        approved_at: new Date().toISOString(),
        approved_by: "auto-mode",
        status: "ready",
      })
      .eq("batch_id", batchId)
      .in("status", ["draft", "pending_approval"]);

    if (woApprovalError) throw woApprovalError;

    // Execute using batch mode logic
    const batchResult = await executeBatchMode(supabase, batchId, parallelSlots);
    
    // Copy results
    result.completed = batchResult.completed;
    result.wos_completed = batchResult.wos_completed;
    result.wos_failed = batchResult.wos_failed;
    result.error = batchResult.error;

  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
  }

  return result;
}

/**
 * Main entry point - validates mode and dispatches to appropriate executor
 */
export async function executeBatch(
  supabase: SupabaseClient,
  batchId: string
): Promise<BatchExecutionResult> {
  // Get batch details
  const { data: batch, error: batchError } = await supabase
    .from("wo_batches")
    .select("execution_mode, parallel_slots, requires_batch_approval, approved_at")
    .eq("id", batchId)
    .single();

  if (batchError) {
    return {
      batch_id: batchId,
      mode: "step",
      completed: false,
      wos_completed: [],
      wos_failed: [],
      error: `Failed to fetch batch: ${batchError.message}`,
    };
  }

  const mode = batch.execution_mode || "step";

  // Validate execution based on mode
  const { data: validation, error: validationError } = await supabase.rpc(
    "validate_batch_execution",
    { p_batch_id: batchId }
  );

  if (validationError || !validation?.allowed) {
    return {
      batch_id: batchId,
      mode,
      completed: false,
      wos_completed: [],
      wos_failed: [],
      error: validation?.reason || validationError?.message || "Validation failed",
    };
  }

  // Dispatch to appropriate executor
  switch (mode) {
    case "step":
      return executeStepMode(supabase, batchId);
    case "batch":
      return executeBatchMode(supabase, batchId, batch.parallel_slots || 3);
    case "auto":
      return executeAutoMode(supabase, batchId, batch.parallel_slots || 3);
    default:
      return {
        batch_id: batchId,
        mode,
        completed: false,
        wos_completed: [],
        wos_failed: [],
        error: `Unknown execution mode: ${mode}`,
      };
  }
}

// Helper functions

async function executeWorkOrder(
  supabase: SupabaseClient,
  wo: WorkOrder,
  result: BatchExecutionResult
): Promise<void> {
  try {
    const { data: execResult, error: execError } = await supabase.functions.invoke(
      "work-order-executor",
      {
        body: { action: "execute", work_order_id: wo.id },
      }
    );

    if (execError || !execResult?.success) {
      result.wos_failed.push(wo.slug);
    } else {
      // Wait for completion
      await waitForWOCompletion(supabase, wo.id);
      result.wos_completed.push(wo.slug);
    }
  } catch (error) {
    result.wos_failed.push(wo.slug);
  }
}

async function waitForWOCompletion(
  supabase: SupabaseClient,
  woId: string,
  maxWaitMs = 300000 // 5 minutes max
): Promise<void> {
  const startTime = Date.now();
  
  while (Date.now() - startTime < maxWaitMs) {
    const { data: wo } = await supabase
      .from("work_orders")
      .select("status")
      .eq("id", woId)
      .single();

    if (wo && ["done", "failed", "cancelled"].includes(wo.status)) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
}
