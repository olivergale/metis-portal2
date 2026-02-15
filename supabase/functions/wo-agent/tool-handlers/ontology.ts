// tool-handlers/ontology.ts — MF-FOUND-006
// Read-only ontology query tools for manifold pipeline

import { ToolContext, ToolResult } from "../tools.ts";

export async function handleQueryOntology(
  toolInput: Record<string, any>,
  ctx: ToolContext
): Promise<ToolResult> {
  try {
    const { data, error } = await ctx.supabase.rpc("query_object_registry", {
      p_object_type: toolInput.object_type || null,
      p_name_pattern: toolInput.name_pattern || null,
      p_parent_id: toolInput.parent_id || null,
      p_limit: toolInput.limit || 20,
    });
    if (error) return { success: false, error: error.message };
    return { success: true, data };
  } catch (e: any) {
    return { success: false, error: `query_ontology failed: ${e.message}` };
  }
}

export async function handleQueryObjectLinks(
  toolInput: Record<string, any>,
  ctx: ToolContext
): Promise<ToolResult> {
  try {
    const { data, error } = await ctx.supabase.rpc("query_object_links", {
      p_source_id: toolInput.source_id || null,
      p_target_id: toolInput.target_id || null,
      p_link_type: toolInput.link_type || null,
      p_limit: toolInput.limit || 20,
    });
    if (error) return { success: false, error: error.message };
    return { success: true, data };
  } catch (e: any) {
    return { success: false, error: `query_object_links failed: ${e.message}` };
  }
}

export async function handleQueryPipelineStatus(
  toolInput: Record<string, any>,
  ctx: ToolContext
): Promise<ToolResult> {
  try {
    if (toolInput.pipeline_run_id) {
      const { data, error } = await ctx.supabase.rpc("get_pipeline_detail", {
        p_pipeline_run_id: toolInput.pipeline_run_id,
      });
      if (error) return { success: false, error: error.message };
      return { success: true, data };
    } else {
      const { data, error } = await ctx.supabase.rpc("get_manifold_dashboard");
      if (error) return { success: false, error: error.message };
      return { success: true, data };
    }
  } catch (e: any) {
    return { success: false, error: `query_pipeline_status failed: ${e.message}` };
  }
}
