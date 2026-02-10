// wo-agent/tool-handlers/team-context.ts
// WO-0244: Team context tool handler for multi-agent collaboration
// Allows executor agents to write structured findings that child WOs inherit

import type { ToolContext, ToolResult } from "../tools.ts";

/**
 * Handle write_team_context tool - writes structured context entries
 * that are shared across all WOs in the same tree (via root_wo_id).
 *
 * Uses the write_team_context RPC which:
 * 1. Walks up parent_id chain to find root WO
 * 2. Inserts into team_context table with root_wo_id
 * 3. Returns the new entry UUID
 */
export async function handleWriteTeamContext(
  input: Record<string, any>,
  ctx: ToolContext
): Promise<ToolResult> {
  const { context_type, content, metadata } = input;

  if (!context_type) {
    return { success: false, error: "Missing required parameter: context_type" };
  }
  if (!content) {
    return { success: false, error: "Missing required parameter: content" };
  }

  const validTypes = ["plan", "finding", "decision", "file_list", "schema_change"];
  if (!validTypes.includes(context_type)) {
    return {
      success: false,
      error: `Invalid context_type: ${context_type}. Must be one of: ${validTypes.join(", ")}`,
    };
  }

  try {
    const { data, error } = await ctx.supabase.rpc("write_team_context", {
      p_work_order_id: ctx.workOrderId,
      p_context_type: context_type,
      p_content: content,
      p_author_agent: ctx.agentName,
      p_metadata: metadata || {},
    });

    if (error) {
      return { success: false, error: `write_team_context error: ${error.message}` };
    }

    return {
      success: true,
      data: `Team context written (type=${context_type}, id=${data}). This will be visible to all child WOs in this tree.`,
    };
  } catch (e: any) {
    return { success: false, error: `write_team_context exception: ${e.message}` };
  }
}
