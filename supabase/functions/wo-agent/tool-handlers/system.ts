// wo-agent/tool-handlers/system.ts
// System tools: log_progress, read_execution_log, get_schema, mark_complete, mark_failed,
//               resolve_qa_findings, update_qa_checklist

import type { ToolContext, ToolResult } from "../tools.ts";

export async function handleLogProgress(
  input: Record<string, any>,
  ctx: ToolContext
): Promise<ToolResult> {
  const { message, phase } = input;
  if (!message) return { success: false, error: "Missing required parameter: message" };

  try {
    const { error } = await ctx.supabase.from("work_order_execution_log").insert({
      work_order_id: ctx.workOrderId,
      phase: phase || "stream",
      agent_name: ctx.agentName,
      detail: {
        event_type: "tool_result",
        tool_name: "log_progress",
        content: message,
      },
    });

    if (error) {
      return { success: false, error: `log_progress error: ${error.message}` };
    }
    return { success: true, data: "Progress logged" };
  } catch (e: any) {
    return { success: false, error: `log_progress exception: ${e.message}` };
  }
}

export async function handleReadExecutionLog(
  input: Record<string, any>,
  ctx: ToolContext
): Promise<ToolResult> {
  const woId = input.work_order_id || ctx.workOrderId;
  const limit = Math.min(input.limit || 20, 30);

  try {
    const { data, error } = await ctx.supabase
      .from("work_order_execution_log")
      .select("id, phase, agent_name, detail, created_at")
      .eq("work_order_id", woId)
      .order("created_at", { ascending: false })
      .limit(limit);

    if (error) {
      return { success: false, error: `read_execution_log error: ${error.message}` };
    }

    const resultStr = JSON.stringify(data);
    const limited =
      resultStr.length > 10000
        ? resultStr.slice(0, 10000) + "...(limited)"
        : resultStr;
    return { success: true, data: limited };
  } catch (e: any) {
    return { success: false, error: `read_execution_log exception: ${e.message}` };
  }
}

export async function handleGetSchema(
  _input: Record<string, any>,
  ctx: ToolContext
): Promise<ToolResult> {
  try {
    const { data, error } = await ctx.supabase.rpc("get_schema_context");
    if (error) {
      return { success: false, error: `get_schema error: ${error.message}` };
    }
    return { success: true, data: data || "No schema context available" };
  } catch (e: any) {
    return { success: false, error: `get_schema exception: ${e.message}` };
  }
}

export async function handleMarkComplete(
  input: Record<string, any>,
  ctx: ToolContext
): Promise<ToolResult> {
  const { summary } = input;
  if (!summary) return { success: false, error: "Missing required parameter: summary" };

  try {
    // WO-0165: Check for concurrent WOs with overlapping tags
    let overlapWarning = "";
    try {
      const { data: thisWo } = await ctx.supabase
        .from("work_orders")
        .select("tags")
        .eq("id", ctx.workOrderId)
        .single();
      const myTags: string[] = (thisWo?.tags || []).filter((t: string) =>
        !t.startsWith("parent:") && t !== "remediation" && t !== "auto-qa-loop" &&
        t !== "no-retry" && t !== "local-filesystem" && t !== "server-side-agent"
      );
      if (myTags.length > 0) {
        const { data: overlapping } = await ctx.supabase
          .from("work_orders")
          .select("slug, tags")
          .eq("status", "in_progress")
          .neq("id", ctx.workOrderId)
          .limit(10);
        const conflicts = (overlapping || []).filter((wo: any) =>
          (wo.tags || []).some((t: string) => myTags.includes(t))
        );
        if (conflicts.length > 0) {
          overlapWarning = ` [concurrent overlap: ${conflicts.map((c: any) => c.slug).join(", ")}]`;
        }
      }
    } catch { /* non-critical */ }

    // Update the WO summary (with overlap warning if any)
    await ctx.supabase
      .from("work_orders")
      .update({ summary: summary + overlapWarning })
      .eq("id", ctx.workOrderId);

    // Log completion
    await ctx.supabase.from("work_order_execution_log").insert({
      work_order_id: ctx.workOrderId,
      phase: "execution_complete",
      agent_name: ctx.agentName,
      detail: {
        event_type: "result",
        content: summary,
        tools_used: [],
        mcp_tools_used: [],
      },
    });

    // Transition to review — non-master agents use enforcement RPC, master uses bypass
    const MASTER = new Set(["ilmarinen"]);
    if (MASTER.has(ctx.agentName)) {
      await ctx.supabase.rpc("run_sql_void", {
        sql_query: `SELECT set_config('app.wo_executor_bypass', 'true', true); UPDATE work_orders SET status = 'review' WHERE id = '${ctx.workOrderId}' AND status = 'in_progress';`,
      });
    } else {
      // WO-0236: Correct 7-param RPC signature
      const { error: rpcErr } = await ctx.supabase.rpc("update_work_order_state", {
        p_work_order_id: ctx.workOrderId,
        p_status: "review",
        p_approved_at: null,
        p_approved_by: null,
        p_started_at: null,
        p_completed_at: null,
        p_summary: summary + overlapWarning,
      });
      if (rpcErr) {
        return { success: false, error: `mark_complete state transition failed: ${rpcErr.message}` };
      }
    }

    // Check if this is a remediation WO — propagate evidence to parent
    const { data: wo } = await ctx.supabase
      .from("work_orders")
      .select("tags")
      .eq("id", ctx.workOrderId)
      .single();

    if (wo?.tags && Array.isArray(wo.tags)) {
      const parentTag = wo.tags.find((t: string) => t.startsWith("parent:"));
      if (parentTag && wo.tags.includes("remediation")) {
        const parentSlug = parentTag.replace("parent:", "");
        // Find parent WO
        const { data: parentWo } = await ctx.supabase
          .from("work_orders")
          .select("id")
          .eq("slug", parentSlug)
          .single();

        if (parentWo) {
          // Propagate evidence to parent's execution log
          await ctx.supabase.from("work_order_execution_log").insert({
            work_order_id: parentWo.id,
            phase: "stream",
            agent_name: ctx.agentName,
            detail: {
              event_type: "tool_result",
              tool_name: "remediation_result",
              content: `Remediation WO ${ctx.workOrderSlug} completed: ${summary}`,
              remediation_wo_slug: ctx.workOrderSlug,
              remediation_wo_id: ctx.workOrderId,
            },
          });
        }
      }
    }

    return { success: true, data: "Work order marked complete and moved to review", terminal: true };
  } catch (e: any) {
    return { success: false, error: `mark_complete exception: ${e.message}` };
  }
}

export async function handleMarkFailed(
  input: Record<string, any>,
  ctx: ToolContext
): Promise<ToolResult> {
  const { reason } = input;
  if (!reason) return { success: false, error: "Missing required parameter: reason" };

  try {
    // Log failure
    await ctx.supabase.from("work_order_execution_log").insert({
      work_order_id: ctx.workOrderId,
      phase: "failed",
      agent_name: ctx.agentName,
      detail: {
        event_type: "result",
        content: reason,
      },
    });

    // Transition to failed — non-master agents use enforcement RPC, master uses bypass
    const MASTER_FAIL = new Set(["ilmarinen"]);
    if (MASTER_FAIL.has(ctx.agentName)) {
      await ctx.supabase.rpc("run_sql_void", {
        sql_query: `SELECT set_config('app.wo_executor_bypass', 'true', true); UPDATE work_orders SET status = 'failed', summary = '${reason.replace(/'/g, "''")}' WHERE id = '${ctx.workOrderId}';`,
      });
    } else {
      // WO-0236: Correct 7-param RPC signature (summary set via RPC param)
      const { error: rpcErr } = await ctx.supabase.rpc("update_work_order_state", {
        p_work_order_id: ctx.workOrderId,
        p_status: "failed",
        p_approved_at: null,
        p_approved_by: null,
        p_started_at: null,
        p_completed_at: new Date().toISOString(),
        p_summary: reason,
      });
      if (rpcErr) {
        return { success: false, error: `mark_failed state transition failed: ${rpcErr.message}` };
      }
    }

    return { success: true, data: "Work order marked as failed", terminal: true };
  } catch (e: any) {
    return { success: false, error: `mark_failed exception: ${e.message}` };
  }
}

export async function handleResolveQaFindings(
  input: Record<string, any>,
  ctx: ToolContext
): Promise<ToolResult> {
  const woId = input.work_order_id || ctx.workOrderId;

  try {
    // Resolve all unresolved fail findings for the WO
    const { data, error } = await ctx.supabase
      .from("qa_findings")
      .update({ resolved_at: new Date().toISOString() })
      .eq("work_order_id", woId)
      .eq("finding_type", "fail")
      .is("resolved_at", null)
      .select("id");

    if (error) {
      return { success: false, error: `resolve_qa_findings error: ${error.message}` };
    }

    const count = data?.length || 0;
    return { success: true, data: `Resolved ${count} QA finding(s) for ${woId}` };
  } catch (e: any) {
    return { success: false, error: `resolve_qa_findings exception: ${e.message}` };
  }
}

export async function handleUpdateQaChecklist(
  input: Record<string, any>,
  ctx: ToolContext
): Promise<ToolResult> {
  const woId = input.work_order_id || ctx.workOrderId;
  const { checklist_item_id, status, evidence_summary } = input;

  if (!checklist_item_id || !status) {
    return { success: false, error: "Missing required: checklist_item_id, status" };
  }
  if (!["pass", "fail", "na"].includes(status)) {
    return { success: false, error: "status must be pass, fail, or na" };
  }

  try {
    // Read current qa_checklist from work_orders
    const { data: wo, error: readErr } = await ctx.supabase
      .from("work_orders")
      .select("qa_checklist")
      .eq("id", woId)
      .single();

    if (readErr || !wo) {
      return { success: false, error: `Read WO failed: ${readErr?.message || "not found"}` };
    }

    const checklist = wo.qa_checklist || [];
    const item = checklist.find((c: any) => c.id === checklist_item_id);
    if (!item) {
      return { success: false, error: `Checklist item ${checklist_item_id} not found` };
    }

    // Update the item
    item.status = status;
    item.evidence = evidence_summary || item.evidence;
    item.evaluated_at = new Date().toISOString();

    // Write back
    const { error: writeErr } = await ctx.supabase
      .from("work_orders")
      .update({ qa_checklist: checklist })
      .eq("id", woId);

    if (writeErr) {
      return { success: false, error: `Update checklist failed: ${writeErr.message}` };
    }

    return { success: true, data: `Checklist item ${checklist_item_id} → ${status}` };
  } catch (e: any) {
    return { success: false, error: `update_qa_checklist exception: ${e.message}` };
  }
}

/**
 * WO-0186: Transition a WO status via the enforcement layer (no bypass).
 * Safe for all agents — goes through update_work_order_state() RPC.
 */
export async function handleTransitionState(
  input: Record<string, any>,
  ctx: ToolContext
): Promise<ToolResult> {
  const woId = input.work_order_id || ctx.workOrderId;
  const { new_status, summary } = input;

  if (!new_status) return { success: false, error: "Missing required parameter: new_status" };
  if (!["review", "done", "failed"].includes(new_status)) {
    return { success: false, error: "new_status must be review, done, or failed" };
  }

  try {
    // Update summary if provided
    if (summary) {
      await ctx.supabase.from("work_orders").update({ summary }).eq("id", woId);
    }

    // WO-0236: Correct 7-param RPC signature
    const { error } = await ctx.supabase.rpc("update_work_order_state", {
      p_work_order_id: woId,
      p_status: new_status,
      p_approved_at: null,
      p_approved_by: null,
      p_started_at: null,
      p_completed_at: new_status === "failed" ? new Date().toISOString() : null,
      p_summary: summary || null,
    });

    if (error) {
      return { success: false, error: `transition_state error: ${error.message}` };
    }

    // Log the transition
    await ctx.supabase.from("work_order_execution_log").insert({
      work_order_id: woId,
      phase: "stream",
      agent_name: ctx.agentName,
      detail: {
        event_type: "tool_result",
        tool_name: "transition_state",
        content: `Transitioned to ${new_status} via enforcement RPC`,
        new_status,
      },
    });

    const isTerminal = new_status === "done" || new_status === "failed";
    return {
      success: true,
      data: `Work order transitioned to ${new_status}`,
      terminal: isTerminal,
    };
  } catch (e: any) {
    return { success: false, error: `transition_state exception: ${e.message}` };
  }
}
