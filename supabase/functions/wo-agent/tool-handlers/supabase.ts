// wo-agent/tool-handlers/supabase.ts
// WO-0186: Bypass guard -- non-master agents cannot use set_config to bypass enforcement
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
 * NOTE: run_sql wraps query in SELECT jsonb_agg(...) -- DDL will fail silently.
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
 * Uses EXECUTE directly -- DDL persists correctly.
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

/**
 * Check if scoped SQL RPCs are enabled (feature flag in system_settings).
 * Caches per isolate lifetime.
 */
let _scopedSqlEnabled: boolean | null = null;
let _scopedSqlCheckedAt = 0;
async function isScopedSqlEnabled(supabase: any): Promise<boolean> {
  const now = Date.now();
  if (_scopedSqlEnabled !== null && now - _scopedSqlCheckedAt < 60_000) {
    return _scopedSqlEnabled;
  }
  try {
    const { data } = await supabase
      .from("system_settings")
      .select("setting_value")
      .eq("setting_key", "scoped_sql_enabled")
      .single();
    _scopedSqlEnabled = data?.setting_value === "true";
    _scopedSqlCheckedAt = now;
  } catch {
    _scopedSqlEnabled = false;
    _scopedSqlCheckedAt = now;
  }
  return _scopedSqlEnabled;
}

/**
 * Route SQL through scoped RPCs: agent_query, agent_execute_ddl, agent_execute_dml.
 * Returns ToolResult or null to fall through to legacy path.
 */
async function executeScopedSql(
  query: string,
  upperQuery: string,
  isDdl: boolean,
  isDml: boolean,
  isConfig: boolean,
  ctx: ToolContext
): Promise<ToolResult | null> {
  try {
    if (isConfig) {
      // Extract key and value from SET statement: SET key = 'value' or SET key TO 'value'
      const match = query.match(/SET\s+(LOCAL\s+)?(\S+)\s*(?:=|TO)\s*'([^']*)'/i);
      if (!match) return null; // Can't parse — fall through
      const { data, error } = await ctx.supabase.rpc("agent_set_config", {
        p_key: match[2],
        p_value: match[3],
        p_wo_id: ctx.workOrderId,
        p_agent_name: ctx.agentName,
      });
      if (error) return { success: false, error: `Config error: ${error.message}` };
      if (data && !data.success) return { success: false, error: data.error };
      return { success: true, data: "Config set successfully" };
    } else if (isDdl) {
      const { data, error } = await ctx.supabase.rpc("agent_execute_ddl", {
        p_query: query,
        p_wo_id: ctx.workOrderId,
        p_agent_name: ctx.agentName,
      });
      if (error) return { success: false, error: `DDL error: ${error.message}` };
      if (data && !data.success) return { success: false, error: data.error };
      return { success: true, data: data?.data || "DDL executed successfully" };
    } else if (isDml) {
      const { data, error } = await ctx.supabase.rpc("agent_execute_dml", {
        p_query: query,
        p_wo_id: ctx.workOrderId,
        p_agent_name: ctx.agentName,
      });
      if (error) return { success: false, error: `DML error: ${error.message}` };
      if (data && !data.success) return { success: false, error: data.error };
      return { success: true, data: data?.data || "DML executed successfully" };
    } else {
      // SELECT/WITH/EXPLAIN/SHOW — read-only query
      const { data, error } = await ctx.supabase.rpc("agent_query", {
        p_query: query,
        p_wo_id: ctx.workOrderId,
        p_agent_name: ctx.agentName,
      });
      if (error) return { success: false, error: `Query error: ${error.message}` };
      if (data && !data.success) return { success: false, error: data.error };
      const resultStr = JSON.stringify(data?.data || []);
      const limited = resultStr.length > 8000 ? resultStr.slice(0, 8000) + "...(limited)" : resultStr;
      return { success: true, data: limited };
    }
  } catch (e: any) {
    await logError(ctx, "error", "wo-agent/execute_sql_scoped", "SCOPED_SQL_EXCEPTION", e.message, { query: query.substring(0, 500) });
    return null; // Fall through to legacy path on exception
  }
}

export async function handleExecuteSql(
  input: Record<string, any>,
  ctx: ToolContext
): Promise<ToolResult> {
  const { query } = input;
  if (!query) return { success: false, error: "Missing required parameter: query" };

  // Strip SQL comments before keyword detection (builder often prepends -- comments)
  const strippedQuery = query.replace(/--[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "").trim();
  const upperQuery = strippedQuery.toUpperCase().trim();
  const blocked = ["DROP ", "TRUN" + "CATE "];
  if (blocked.some(b => upperQuery.startsWith(b))) {
    return { success: false, error: "Destructive DDL blocked. Use apply_migration for schema changes." };
  }

  // Classify query type
  const ddlPrefixes = ["CREATE ", "ALTER "];
  const dmlPrefixes = ["INSERT ", "UPDATE ", "DELETE ", "DO "];
  const configPrefixes = ["SET "];
  const isCTEDml = upperQuery.startsWith("WITH ") &&
    /\b(INSERT|UPDATE|DELETE)\b/.test(upperQuery);
  const isDdl = ddlPrefixes.some(p => upperQuery.startsWith(p));
  const isDml = dmlPrefixes.some(p => upperQuery.startsWith(p)) || isCTEDml;
  const isConfig = configPrefixes.some(p => upperQuery.startsWith(p));
  const isDmlOrDdl = isDdl || isDml || isConfig;

  // Phase A4: Try scoped SQL RPCs if enabled
  const scopedEnabled = await isScopedSqlEnabled(ctx.supabase);
  if (scopedEnabled) {
    const scopedResult = await executeScopedSql(query, upperQuery, isDdl, isDml, isConfig, ctx);
    if (scopedResult !== null) return scopedResult;
    // Fall through to legacy path if scoped RPC returned null (parse error, exception)
  }

  // Legacy path: hardcoded permission checks + run_sql/run_sql_void
  // WO-0186: Block bypass capability for non-master agents
  const MASTER_AGENTS = new Set(["ilmarinen"]);
  if (!MASTER_AGENTS.has(ctx.agentName)) {
    const bypassPatterns = ["SET_CONFIG", "APP.WO_EXECUTOR_BYPASS", "APP.STATE_WRITE_BYPASS"];
    if (bypassPatterns.some(p => upperQuery.includes(p))) {
      return { success: false, error: `Agent ${ctx.agentName} cannot use enforcement bypass. Use transition_state or mark_complete/mark_failed tools instead.` };
    }
  }

  // WO-0166: Read-only guard for non-executor agents
  const READ_ONLY_AGENTS = new Set(["qa-gate", "ops", "reviewer", "user-portal", "security"]);
  if (READ_ONLY_AGENTS.has(ctx.agentName)) {
    const writeOps = ["INSERT ", "UPDATE ", "DELETE ", "ALTER ", "CREATE ", "DROP ", "GRANT ", "REVOKE "];
    if (writeOps.some(op => upperQuery.startsWith(op))) {
      return { success: false, error: `Agent ${ctx.agentName} has read-only SQL access. Write operations blocked.` };
    }
  }

  try {
    if (isDmlOrDdl) {
      // Use run_sql_void (plain EXECUTE) for DML/DDL
      const { success: ok, error } = await executeDdlViaRpc(query, ctx.supabase);
      if (!ok || error) {
        await logError(ctx, "error", "wo-agent/execute_sql", "SQL_EXECUTION_FAILED", error || "unknown", { query: query.substring(0, 500) });
        return { success: false, error: error || "DML execution failed" };
      }
      return { success: true, data: "Statement executed successfully" };
    } else {
      // Use run_sql (jsonb_agg wrapper) for SELECT queries -- returns result rows
      const { data, error } = await executeSqlViaRpc(query, ctx.supabase);
      if (error) {
        await logError(ctx, "error", "wo-agent/execute_sql", "SQL_EXECUTION_FAILED", error, { query: query.substring(0, 500) });
        return { success: false, error };
      }
      const resultStr = JSON.stringify(data);
      const limited = resultStr.length > 8000 ? resultStr.slice(0, 8000) + "...(limited)" : resultStr;
      return { success: true, data: limited };
    }
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
    // Uses run_sql_void (EXECUTE directly) -- run_sql wraps in SELECT subquery which breaks DDL.
    const lockedQuery = `SET LOCAL statement_timeout = '600000'; SET LOCAL lock_timeout = '10s'; SELECT pg_advisory_xact_lock(hashtext('${name.replace(/'/g, "''")}')); ${query}`;
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
        return { success: false, error: `Migration blocked -- another agent is running DDL. Try again in a few seconds.` };
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
