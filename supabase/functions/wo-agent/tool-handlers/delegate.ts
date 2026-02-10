// wo-agent/tool-handlers/delegate.ts
// WO-0245: delegate_subtask — create child WO with inherited context + model assignment

import type { ToolContext, ToolResult } from "../tools.ts";

const MODEL_TIER_MAP: Record<string, string> = {
  opus: "claude-opus-4-6",
  sonnet: "claude-sonnet-4-5-20250929",
  haiku: "claude-haiku-4-5-20251001",
};

export async function handleDelegateSubtask(
  input: Record<string, any>,
  ctx: ToolContext
): Promise<ToolResult> {
  const { name, objective, acceptance_criteria, model_tier, context_injection } = input;

  // Validate required params
  if (!name || !objective) {
    return { success: false, error: "Missing required parameters: name, objective" };
  }
  if (!acceptance_criteria) {
    return { success: false, error: "Missing required parameter: acceptance_criteria (must be numbered lines)" };
  }

  const tier = (model_tier || "sonnet").toLowerCase();
  if (!MODEL_TIER_MAP[tier]) {
    return { success: false, error: `Invalid model_tier: ${tier}. Must be opus, sonnet, or haiku` };
  }

  try {
    // 1. Get parent WO info (tags, slug) for inheritance
    const { data: parentWo, error: parentErr } = await ctx.supabase
      .from("work_orders")
      .select("id, slug, tags")
      .eq("id", ctx.workOrderId)
      .single();

    if (parentErr || !parentWo) {
      return { success: false, error: `Could not fetch parent WO: ${parentErr?.message}` };
    }

    // Inherit parent tags minus remediation/auto-qa-loop, add parent: tag
    const inheritedTags = (parentWo.tags || []).filter(
      (t: string) => t !== "remediation" && t !== "auto-qa-loop" && !t.startsWith("parent:")
    );
    const childTags = [...inheritedTags, `parent:${parentWo.slug}`];

    // 2. Create child WO via RPC
    const { data: childWo, error: createErr } = await ctx.supabase.rpc("create_draft_work_order", {
      p_slug: null, // auto-sequential
      p_name: name,
      p_objective: objective,
      p_priority: "p2_medium",
      p_source: "api",
      p_tags: childTags,
      p_acceptance_criteria: acceptance_criteria,
      p_parent_id: ctx.workOrderId,
      p_client_info: { model_override: MODEL_TIER_MAP[tier], delegated_by: parentWo.slug },
    });

    if (createErr) {
      return { success: false, error: `create_draft_work_order failed: ${createErr.message}` };
    }

    const childId = childWo?.id;
    const childSlug = childWo?.slug;
    if (!childId) {
      return { success: false, error: "create_draft_work_order returned no id" };
    }

    // 3. Write context_injection to team_context (if provided)
    if (context_injection) {
      const { error: ctxErr } = await ctx.supabase.from("team_context").insert({
        root_wo_id: ctx.workOrderId,
        source_wo_id: ctx.workOrderId,
        author_agent: ctx.agentName,
        context_type: "plan",
        content: context_injection,
        metadata: { target_wo_id: childId, target_wo_slug: childSlug },
      });

      if (ctxErr) {
        // Non-fatal — log warning but continue
        await ctx.supabase.from("work_order_execution_log").insert({
          work_order_id: ctx.workOrderId,
          phase: "stream",
          agent_name: ctx.agentName,
          detail: {
            event_type: "tool_result",
            tool_name: "delegate_subtask",
            content: `Warning: context_injection write failed: ${ctxErr.message}`,
          },
        });
      }
    }

    // 4. Start the child WO immediately (draft → ready → in_progress)
    const { data: startResult, error: startErr } = await ctx.supabase.rpc("start_work_order", {
      p_work_order_id: childId,
      p_agent_name: "builder", // Server-side agent
    });

    if (startErr) {
      return {
        success: false,
        error: `Child WO ${childSlug} created but start_work_order failed: ${startErr.message}`,
      };
    }

    // 5. Log delegation event
    await ctx.supabase.from("work_order_execution_log").insert({
      work_order_id: ctx.workOrderId,
      phase: "stream",
      agent_name: ctx.agentName,
      detail: {
        event_type: "tool_result",
        tool_name: "delegate_subtask",
        content: `Delegated child WO ${childSlug}: ${name} (model: ${tier})`,
        child_wo_id: childId,
        child_wo_slug: childSlug,
        model_tier: tier,
      },
    });

    // 6. Always non-blocking — return immediately. Use check_child_status to poll.
    return {
      success: true,
      data: {
        child_slug: childSlug,
        child_id: childId,
        child_status: "in_progress",
        message: `Child WO ${childSlug} created and dispatched. Use check_child_status to poll for completion.`,
      },
    };
  } catch (e: any) {
    return { success: false, error: `delegate_subtask exception: ${e.message}` };
  }
}

/**
 * check_child_status — query a child WO's current status + summary.
 * Used by parent agents to poll for child completion after non-blocking delegation.
 */
export async function handleCheckChildStatus(
  input: Record<string, any>,
  ctx: ToolContext
): Promise<ToolResult> {
  const { child_slug, child_id } = input;

  if (!child_slug && !child_id) {
    return { success: false, error: "Must provide child_slug or child_id" };
  }

  try {
    let query = ctx.supabase
      .from("work_orders")
      .select("id, slug, status, summary, completed_at, started_at");

    if (child_id) {
      query = query.eq("id", child_id);
    } else {
      query = query.eq("slug", child_slug);
    }

    const { data: child, error } = await query.single();

    if (error || !child) {
      return { success: false, error: `Child WO not found: ${error?.message || child_slug || child_id}` };
    }

    const result: Record<string, any> = {
      child_slug: child.slug,
      child_id: child.id,
      child_status: child.status,
    };

    if (["done", "review", "failed", "cancelled"].includes(child.status)) {
      result.child_summary = child.summary;
      result.completed_at = child.completed_at;
      result.terminal = true;
    } else {
      // Get activity count for in-progress children
      const { count } = await ctx.supabase
        .from("work_order_execution_log")
        .select("id", { count: "exact", head: true })
        .eq("work_order_id", child.id);

      // Get last action
      const { data: lastLog } = await ctx.supabase
        .from("work_order_execution_log")
        .select("detail, created_at")
        .eq("work_order_id", child.id)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      result.log_entries = count || 0;
      result.last_action = lastLog?.detail?.tool_name || lastLog?.detail?.event_type || "unknown";
      result.last_activity = lastLog?.created_at;
      result.terminal = false;
    }

    return { success: true, data: result };
  } catch (e: any) {
    return { success: false, error: `check_child_status exception: ${e.message}` };
  }
}
