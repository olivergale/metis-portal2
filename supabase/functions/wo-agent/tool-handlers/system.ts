// wo-agent/tool-handlers/system.ts
// System tools: log_progress, read_execution_log, get_schema, mark_complete, mark_failed,
//               resolve_qa_findings, update_qa_checklist, transition_state, search_knowledge_base

import type { ToolContext, ToolResult } from "../tools.ts";

/**
 * Log error to error_events table for centralized error tracking
 * WO-0266: Silent failure detection
 */
async function logError(
  ctx: ToolContext,
  severity: string,
  sourceFunction: string,
  errorCode: string,
  message: string,
  context: Record<string, any> = {}
): Promise<void> {
  try {
    await ctx.supabase.rpc("log_error_event", {
      p_severity: severity,
      p_source_function: sourceFunction,
      p_error_code: errorCode,
      p_message: message,
      p_context: context,
      p_work_order_id: ctx.workOrderId,
      p_agent_id: null,
    });
  } catch (e: any) {
    // Silent failure in error logging - don't cascade
    console.error(`[ERROR_LOG] Failed to log error: ${e.message}`);
  }
}

export async function handleLogProgress(
  input: Record<string, any>,
  ctx: ToolContext
): Promise<ToolResult> {
  const { message, phase } = input;
  if (!message) return { success: false, error: "Missing required parameter: message" };

  try {
    // Ensure message is converted to string to avoid bytea encoding issues
    const contentStr = typeof message === 'string' ? message : JSON.stringify(message);
    
    const { error } = await ctx.supabase.from("work_order_execution_log").insert({
      work_order_id: ctx.workOrderId,
      phase: phase || "stream",
      agent_name: ctx.agentName,
      detail: {
        event_type: "tool_result",
        tool_name: "log_progress",
        content: contentStr,
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

    // WO-0389: Check for deployment_verification records when WO has deployment-related tags
    // If the WO deployed edge functions but has no verification records, block completion
    const DEPLOYMENT_TAGS = new Set(["edge-function", "deploy", "deployment", "supabase", "migration", "schema"]);
    const { data: woForTags } = await ctx.supabase
      .from("work_orders")
      .select("tags")
      .eq("id", ctx.workOrderId)
      .single();
    
    const woTags = woForTags?.tags || [];
    const hasDeploymentTag = woTags.some((t: string) => DEPLOYMENT_TAGS.has(t.toLowerCase()));
    
    if (hasDeploymentTag) {
      // Check for deployment_verification entries in execution log
      const { count: verifyCount } = await ctx.supabase
        .from("work_order_execution_log")
        .select("id", { count: "exact", head: true })
        .eq("work_order_id", ctx.workOrderId)
        .eq("phase", "deployment_verification");
      
      if ((verifyCount || 0) === 0) {
        return {
          success: false,
          error: `BLOCKED: WO has deployment-related tags but no deployment_verification records. Deployments must be verified before mark_complete. Run deploy and ensure verification passes, or use transition_state to move to review manually.`,
        };
      }
    }

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

    // Transition to review using wo_transition (handles all enforcement uniformly)
    const { error: rpcErr } = await ctx.supabase.rpc("wo_transition", {
      p_wo_id: ctx.workOrderId,
      p_event: "submit_for_review",
      p_actor: ctx.agentName,
      p_payload: { summary: summary + overlapWarning },
    });
    if (rpcErr) {
      return { success: false, error: `mark_complete state transition failed: ${rpcErr.message}` };
    }

    // Check if this is a remediation WO -- propagate evidence to parent
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

    // Transition to failed using wo_transition (handles all enforcement uniformly)
    const { error: rpcErr } = await ctx.supabase.rpc("wo_transition", {
      p_work_order_id: ctx.workOrderId,
      p_event: "mark_failed",
      p_actor: ctx.agentName,
      p_payload: { reason },
    });
    if (rpcErr) {
      return { success: false, error: `mark_failed state transition failed: ${rpcErr.message}` };
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

    return { success: true, data: `Checklist item ${checklist_item_id} -- ${status}` };
  } catch (e: any) {
    return { success: false, error: `update_qa_checklist exception: ${e.message}` };
  }
}

/**
 * WO-0186: Transition a WO status via the enforcement layer (no bypass).
 * Safe for all agents -- goes through update_work_order_state() RPC.
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

    // Map new_status to wo_transition event
    const EVENT_MAP: Record<string, string> = {
      review: "submit_for_review",
      done: "mark_done",
      failed: "mark_failed",
    };
    const event = EVENT_MAP[new_status];

    // Use wo_transition for state changes
    const { data: rpcData, error: rpcError } = await ctx.supabase.rpc("wo_transition", {
      p_work_order_id: woId,
      p_event: event,
      p_actor: ctx.agentName,
      p_payload: { summary: summary || null },
    });

    // WO-0352: Check for RPC error and log it
    if (rpcError) {
      // Log error to execution_log
      await ctx.supabase.from("work_order_execution_log").insert({
        work_order_id: woId,
        phase: "failed",
        agent_name: ctx.agentName,
        detail: {
          event_type: "tool_result",
          tool_name: "transition_state",
          content: `transition_state RPC failed: ${rpcError.message}`,
          new_status,
          error: rpcError.message,
          error_code: rpcError.code,
        },
      });

      // Log to error_events table
      await logError(
        ctx,
        "error",
        "handleTransitionState",
        "ERR_TRANSITION_FAILED",
        `Failed to transition WO ${woId} to ${new_status}: ${rpcError.message}`,
        { new_status, rpc_error: rpcError }
      );

      return { success: false, error: `transition_state RPC failed: ${rpcError.message}` };
    }

    // WO-0352: Verify the status actually changed in the database
    const { data: woCheck, error: checkError } = await ctx.supabase
      .from("work_orders")
      .select("status")
      .eq("id", woId)
      .single();

    if (checkError) {
      await ctx.supabase.from("work_order_execution_log").insert({
        work_order_id: woId,
        phase: "failed",
        agent_name: ctx.agentName,
        detail: {
          event_type: "tool_result",
          tool_name: "transition_state",
          content: `Failed to verify status after RPC: ${checkError.message}`,
          new_status,
        },
      });
      return { success: false, error: `Failed to verify status change: ${checkError.message}` };
    }

    // WO-0352: Check if status actually matches what we requested
    if (woCheck?.status !== new_status) {
      await ctx.supabase.from("work_order_execution_log").insert({
        work_order_id: woId,
        phase: "failed",
        agent_name: ctx.agentName,
        detail: {
          event_type: "tool_result",
          tool_name: "transition_state",
          content: `Status mismatch after RPC: expected ${new_status}, got ${woCheck?.status}`,
          expected_status: new_status,
          actual_status: woCheck?.status,
        },
      });

      await logError(
        ctx,
        "error",
        "handleTransitionState",
        "ERR_STATUS_MISMATCH",
        `Status did not persist: expected ${new_status}, got ${woCheck?.status}`,
        { expected: new_status, actual: woCheck?.status, rpc_data: rpcData }
      );

      return {
        success: false,
        error: `Status transition failed: DB shows ${woCheck?.status} instead of ${new_status}`,
      };
    }

    // Log successful transition with verification
    await ctx.supabase.from("work_order_execution_log").insert({
      work_order_id: woId,
      phase: "stream",
      agent_name: ctx.agentName,
      detail: {
        event_type: "tool_result",
        tool_name: "transition_state",
        content: `Successfully transitioned to ${new_status} (verified in DB)`,
        new_status,
        verified: true,
      },
    });

    const isTerminal = new_status === "done" || new_status === "failed";
    return {
      success: true,
      data: `Work order transitioned to ${new_status} (verified)`,
      terminal: isTerminal,
    };
  } catch (e: any) {
    // WO-0352: Log exception to execution_log and error_events
    await ctx.supabase.from("work_order_execution_log").insert({
      work_order_id: woId,
      phase: "failed",
      agent_name: ctx.agentName,
      detail: {
        event_type: "tool_result",
        tool_name: "transition_state",
        content: `transition_state exception: ${e.message}`,
        new_status,
        exception: e.message,
      },
    });

    await logError(
      ctx,
      "error",
      "handleTransitionState",
      "ERR_TRANSITION_EXCEPTION",
      `Exception during transition to ${new_status}: ${e.message}`,
      { new_status, exception: e.message, stack: e.stack }
    );

    return { success: false, error: `transition_state exception: ${e.message}` };
  }
}

export async function handleSearchLessons(
  input: Record<string, any>,
  ctx: ToolContext
): Promise<ToolResult> {
  const { query: searchQuery, category, limit } = input;
  const maxLimit = Math.min(limit || 10, 20);

  try {
    let dbQuery = ctx.supabase
      .from("lessons")
      .select("id, pattern, rule, category, severity, created_at")
      .not("promoted_at", "is", null)
      .order("severity", { ascending: true })
      .order("created_at", { ascending: false });

    // Text search: match against pattern (title) or rule (content)
    if (searchQuery) {
      dbQuery = dbQuery.or(`rule.ilike.%${searchQuery}%,pattern.ilike.%${searchQuery}%`);
    }

    // Filter by category if provided
    if (category) {
      dbQuery = dbQuery.eq("category", category);
    }

    dbQuery = dbQuery.limit(maxLimit);

    const { data, error } = await dbQuery;

    if (error) {
      return { success: false, error: `search_lessons error: ${error.message}` };
    }

    const results = data || [];
    return { 
      success: true, 
      data: {
        count: results.length,
        lessons: results.slice(0, maxLimit)
      }
    };
  } catch (e: any) {
    return { success: false, error: `search_lessons exception: ${e.message}` };
  }
}

export async function handleSearchKnowledgeBase(
  input: Record<string, any>,
  ctx: ToolContext
): Promise<ToolResult> {
  const { query, category, severity, limit } = input;
  if (!query) {
    return { success: false, error: "Missing required parameter: query" };
  }

  try {
    let dbQuery = ctx.supabase
      .from("agent_knowledge_base")
      .select("id, category, topic, content, severity, tags, created_at")
      .ilike("content", `%${query}%`)
      .order("severity", { ascending: false })
      .order("created_at", { ascending: false })
      .limit(limit || 10);

    if (category) {
      dbQuery = dbQuery.eq("category", category);
    }

    if (severity) {
      dbQuery = dbQuery.eq("severity", severity);
    }

    const { data, error } = await dbQuery;

    if (error) {
      return { success: false, error: `search_knowledge_base error: ${error.message}` };
    }

    if (!data || data.length === 0) {
      return {
        success: true,
        data: {
          count: 0,
          message: `No knowledge base entries found for query: ${query}`,
          entries: [],
        },
      };
    }

    // Format results with limited content length
    const results = data.map((entry: any) => ({
      id: entry.id,
      category: entry.category,
      title: entry.title,
      content: entry.content.length > 500 ? entry.content.slice(0, 500) + "..." : entry.content,
      severity: entry.severity,
      tags: entry.tags,
      created_at: entry.created_at,
    }));

    return {
      success: true,
      data: {
        count: results.length,
        query: query,
        entries: results,
      },
    };
  } catch (e: any) {
    return { success: false, error: `search_knowledge_base exception: ${e.message}` };
  }
}
