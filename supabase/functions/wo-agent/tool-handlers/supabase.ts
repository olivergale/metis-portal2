// wo-agent/tool-handlers/supabase.ts
// WO-0186: Bypass guard ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ non-master agents cannot use set_config to bypass enforcement
// WO-0166: Read-only guard for non-executor agents
// Supabase database tools: execute_sql, apply_migration, read_table

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

/**
 * Execute SQL via the run_sql() RPC function (service_role only).
 * Returns query results as JSONB array.
 * NOTE: run_sql wraps query in SELECT jsonb_agg(...) ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ DDL will fail silently.
 * Use executeDdlViaRpc() for DDL operations.
 */
async function executeSqlViaRpc(query: string, supabase: any): Promise<{ data: any; error: string | null }> {
  try {
    const { data, error } = await supabase.rpc("run_sql", { sql_query: query });
    if (error) {
      return { data: null, error: `SQL error: ${error.message}` };
    }
    // Check for error in returned data (run_sql catches exceptions and returns them as JSON)
    if (data && typeof data === 'object' && !Array.isArray(data) && data.error) {
      return { data: null, error: `SQL error: ${data.error}` };
    }
    return { data, error: null };
  } catch (e: any) {
    return { data: null, error: `SQL exception: ${e.message}` };
  }
}

/**
 * Execute DDL via run_sql_void() RPC (service_role only).
 * Uses EXECUTE directly ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ DDL persists correctly.
 * Returns {success: true} or {error: "..."}.
 */
async function executeDdlViaRpc(query: string, supabase: any): Promise<{ success: boolean; error: string | null }> {
  try {
    const { data, error } = await supabase.rpc("run_sql_void", { sql_query: query });
    if (error) {
      return { success: false, error: `DDL error: ${error.message}` };
    }
    // run_sql_void returns {success: true} or {error: "..."}
    if (data && data.error) {
      return { success: false, error: `DDL error: ${data.error}` };
    }
    return { success: true, error: null };
  } catch (e: any) {
    return { success: false, error: `DDL exception: ${e.message}` };
  }
}

export async function handleExecuteSql(
  input: Record<string, any>,
  ctx: ToolContext
): Promise<ToolResult> {
  const { query } = input;
  if (!query) return { success: false, error: "Missing required parameter: query" };

  // Safety: block destructive DDL (use apply_migration for that)
  const upperQuery = query.toUpperCase().trim();
  const blocked = ["DROP ", "TRUN" + "CATE "];
  if (blocked.some(b => upperQuery.startsWith(b))) {
    return { success: false, error: "Destructive DDL blocked. Use apply_migration for schema changes." };
  }

  // WO-0186: Block bypass capability for non-master agents
  const MASTER_AGENTS = new Set(["ilmarinen"]);
  if (!MASTER_AGENTS.has(ctx.agentName)) {
    const bypassPatterns = ["SET_CONFIG", "APP.WO_EXECUTOR_BYPASS", "APP.STATE_WRITE_BYPASS"];
    if (bypassPatterns.some(p => upperQuery.includes(p))) {
      return { success: false, error: `Agent ${ctx.agentName} cannot use enforcement bypass. Use transition_state or mark_complete/mark_failed tools instead.` };
    }
  }

  // WO-0166: Read-only guard for non-executor agents
  const READ_ONLY_AGENTS = new Set(["qa-gate", "ops", "reviewer", "user-portal", "security", "sentinel", "watchman", "audit", "metis"]);
  if (READ_ONLY_AGENTS.has(ctx.agentName)) {
    const writeOps = ["INSERT ", "UPDATE ", "DELETE ", "ALTER ", "CREATE ", "DROP ", "GRANT ", "REVOKE "];
    if (writeOps.some(op => upperQuery.startsWith(op))) {
      return { success: false, error: `Agent ${ctx.agentName} has read-only SQL access. Write operations blocked.` };
    }
  }

  try {
    const { data, error } = await executeSqlViaRpc(query, ctx.supabase);
    if (error) {
      await logError(ctx, "error", "wo-agent/execute_sql", "SQL_EXECUTION_FAILED", error, { query: query.substring(0, 500) });
      return { success: false, error };
    }
    const resultStr = JSON.stringify(data);
    const limited = resultStr.length > 8000 ? resultStr.slice(0, 8000) + "...(limited)" : resultStr;
    return { success: true, data: limited };
  } catch (e: any) {
    const errorMsg = `execute_sql exception: ${e.message}`;
    await logError(ctx, "error", "wo-agent/execute_sql", "SQL_EXCEPTION", errorMsg, { query: query.substring(0, 500) });
    return { success: false, error: errorMsg };
  }
}

export async function handleApplyMigration(
  input: Record<string, any>,
  ctx: ToolContext
): Promise<ToolResult> {
  const { name, query } = input;
  if (!name || !query) {
    return { success: false, error: "Missing required parameters: name, query" };
  }

  // WO-0186: Block bypass in DDL for non-master agents
  const upperDdl = query.toUpperCase();
  const MASTER_DDL = new Set(["ilmarinen"]);
  if (!MASTER_DDL.has(ctx.agentName)) {
    if (upperDdl.includes("SET_CONFIG") || upperDdl.includes("APP.WO_EXECUTOR_BYPASS") || upperDdl.includes("APP.STATE_WRITE_BYPASS")) {
      return { success: false, error: `Agent ${ctx.agentName} cannot embed enforcement bypass in migrations. Use proper RPC tools for state transitions.` };
    }
  }

  try {
    // WO-0165: Advisory lock to serialize DDL across concurrent agents.
    // Uses run_sql_void (EXECUTE directly) ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ run_sql wraps in SELECT subquery which breaks DDL.
    const lockedQuery = `SET LOCAL lock_timeout = '10s'; SELECT pg_advisory_xact_lock(hashtext('${name.replace(/'/g, "''")}')); ${query}`;
    const { success: ddlOk, error } = await executeDdlViaRpc(lockedQuery, ctx.supabase);
    if (!ddlOk || error) {
      // Log migration failure with explicit success: false and error_detail
      await ctx.supabase.from("work_order_execution_log").insert({
        work_order_id: ctx.workOrderId,
        phase: "stream",
        agent_name: ctx.agentName,
        detail: {
          event_type: "tool_result",
          tool_name: "apply_migration",
          content: `Migration failed: ${name}`,
          migration_name: name,
          success: false,
          error_detail: error || "unknown DDL error",
        },
      });
      
      if (error && (error.includes("lock timeout") || error.includes("could not obtain lock"))) {
        return { success: false, error: `Migration blocked ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ another agent is running DDL. Try again in a few seconds.` };
      }
      return { success: false, error: `Migration failed: ${error || "unknown DDL error"}` };
    }

    // Log the migration with explicit success flag
    await ctx.supabase.from("work_order_execution_log").insert({
      work_order_id: ctx.workOrderId,
      phase: "stream",
      agent_name: ctx.agentName,
      detail: {
        event_type: "tool_result",
        tool_name: "apply_migration",
        content: `Applied migration: ${name}`,
        migration_name: name,
        success: true,
      },
    });

    return { success: true, data: `Migration '${name}' applied successfully` };
  } catch (e: any) {
    const errorMsg = `apply_migration exception: ${e.message}`;
    await logError(ctx, "error", "wo-agent/apply_migration", "MIGRATION_EXCEPTION", errorMsg, { migration_name: name });
    return { success: false, error: errorMsg };
  }
}

export async function handleReadTable(
  input: Record<string, any>,
  ctx: ToolContext
): Promise<ToolResult> {
  const { table, select, filters, limit, order } = input;
  if (!table) return { success: false, error: "Missing required parameter: table" };

  try {
    let query = ctx.supabase.from(table).select(select || "*");

    // Apply filters
    if (filters && typeof filters === "object") {
      for (const [key, value] of Object.entries(filters)) {
        query = query.eq(key, value);
      }
    }

    // Apply ordering
    if (order) {
      const [col, dir] = order.split(".");
      query = query.order(col, { ascending: dir !== "desc" });
    }

    // Apply limit (cap at 50)
    query = query.limit(Math.min(limit || 20, 50));

    const { data, error } = await query;
    if (error) {
      await logError(ctx, "error", "wo-agent/read_table", "READ_TABLE_FAILED", error.message, { table, filters, order });
      return { success: false, error: `read_table error: ${error.message}` };
    }

    const resultStr = JSON.stringify(data);
    const limited = resultStr.length > 8000 ? resultStr.slice(0, 8000) + "...(limited)" : resultStr;
    return { success: true, data: limited };
  } catch (e: any) {
    const errorMsg = `read_table exception: ${e.message}`;
    await logError(ctx, "error", "wo-agent/read_table", "READ_TABLE_EXCEPTION", errorMsg, { table });
    return { success: false, error: errorMsg };
  }
}
