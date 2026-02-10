// wo-agent/tool-handlers/delegate.ts
// WO-0245: delegate_subtask — create child WO with inherited context + model assignment

import type { ToolContext, ToolResult } from "../tools.ts";

const MODEL_TIER_MAP: Record<string, string> = {
  opus: "claude-sonnet-4-20250514",  // Opus = top tier (current best)
  sonnet: "claude-sonnet-4-20250514",
  haiku: "claude-haiku-3-20250307",
};

export async function handleDelegateSubtask(
  input: Record<string, any>,
  ctx: ToolContext
): Promise<ToolResult> {
  const { name, objective, acceptance_criteria, model_tier, context_injection, blocking } = input;

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
        content: `Delegated child WO ${childSlug}: ${name} (model: ${tier}, blocking: ${!!blocking})`,
        child_wo_id: childId,
        child_wo_slug: childSlug,
        model_tier: tier,
        blocking: !!blocking,
      },
    });

    // 6. If blocking=true, poll for child completion (with timeout)
    if (blocking) {
      const POLL_INTERVAL = 5000; // 5 seconds
      const MAX_POLLS = 18; // 90 seconds max (stay within edge function timeout)
      let polls = 0;
      let childStatus = "in_progress";

      while (polls < MAX_POLLS) {
        await new Promise((r) => setTimeout(r, POLL_INTERVAL));
        polls++;

        const { data: check } = await ctx.supabase
          .from("work_orders")
          .select("status, summary")
          .eq("id", childId)
          .single();

        if (check) {
          childStatus = check.status;
          if (["done", "review", "failed", "cancelled"].includes(childStatus)) {
            return {
              success: childStatus !== "failed" && childStatus !== "cancelled",
              data: {
                child_slug: childSlug,
                child_id: childId,
                child_status: childStatus,
                child_summary: check.summary,
                blocking: true,
                polls_taken: polls,
              },
            };
          }
        }
      }

      // Timeout — return current status
      return {
        success: true,
        data: {
          child_slug: childSlug,
          child_id: childId,
          child_status: childStatus,
          blocking: true,
          timed_out: true,
          message: `Child WO still ${childStatus} after ${MAX_POLLS * POLL_INTERVAL / 1000}s. Parent can check later.`,
        },
      };
    }

    // 7. Non-blocking — return immediately
    return {
      success: true,
      data: {
        child_slug: childSlug,
        child_id: childId,
        child_status: "in_progress",
        blocking: false,
        message: `Child WO ${childSlug} created and dispatched. Parent continues.`,
      },
    };
  } catch (e: any) {
    return { success: false, error: `delegate_subtask exception: ${e.message}` };
  }
}
