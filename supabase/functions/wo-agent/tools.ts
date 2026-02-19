// wo-agent/tools.ts v5
// WO-0744: Thin dispatch — definitions extracted to tool-definitions.ts, inline handlers to tool-handlers/inline.ts
// Each tool maps to an Anthropic tool_use schema + a dispatch handler

// Tool type from Anthropic SDK -- inlined to avoid deep npm sub-path import that breaks Deno edge runtime
type Tool = { name: string; description: string; input_schema: Record<string, any> };
import { classifyError } from "./error-classifier.ts";
import { proxyViaVerify, PROXY_ELIGIBLE_TOOLS } from "./proxy-verify.ts";
import { handleExecuteSql, handleApplyMigration, handleReadTable } from "./tool-handlers/supabase.ts";
import { handleGithubReadFile, handleGithubPushFiles, handleGithubListFiles, handleGithubCreateBranch, handleGithubCreatePr, handleGithubSearchCode, handleGithubGrep, handleGithubReadFileRange, handleGithubTree, handleReadFullFile, handleGitLog, handleGitDiff, handleGitBlame } from "./tool-handlers/github.ts";
import { handleDeployEdgeFunction } from "./tool-handlers/deploy.ts";
import { handleWebFetch } from "./tool-handlers/web.ts";
import {
  handleLogProgress,
  handleReadExecutionLog,
  handleGetSchema,
  handleMarkComplete,
  handleMarkFailed,
  handleResolveQaFindings,
  handleUpdateQaChecklist,
  handleTransitionState,
  handleSearchKnowledgeBase,
  handleSearchLessons,
} from "./tool-handlers/system.ts";
import { handleDelegateSubtask, handleCheckChildStatus } from "./tool-handlers/delegate.ts";
import { handleQueryOntology, handleQueryObjectLinks, handleQueryPipelineStatus } from "./tool-handlers/ontology.ts";
import {
  handleSaveMemory,
  handleRecallMemory,
  handleRequestClarification,
  handleCheckClarification,
  handleSandboxExec,
  handleRunTests,
  handleSandboxWriteFile,
  handleSandboxPipeline,
  handleSandboxReadFile,
  handleSandboxEditFile,
  handleSandboxGrep,
  handleSandboxGlob,
} from "./tool-handlers/inline.ts";

// Re-export from tool-definitions for existing importers
export { TOOL_DEFINITIONS, SANDBOX_TOOLS, getToolsForWO, getToolsForWOSync } from "./tool-definitions.ts";

export interface ToolContext {
  supabase: any;
  workOrderId: string;
  workOrderSlug: string;
  githubToken: string | null;
  agentName: string;
}

export interface ToolResult {
  success: boolean;
  data?: any;
  error?: string;
  terminal?: boolean; // if true, loop should stop
}

/**
 * Record mutation to wo_mutations table with return value and retry logic
 * WO-0628: Sequential accountability - returns {success, mutation_id}
 * WO-0485: Mutation tracking for all mutating tool operations
 */
/**
 * Compute SHA-256 hash of a string using SubtleCrypto (available in Deno edge runtime)
 */
async function sha256(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function recordMutation(
  ctx: ToolContext,
  toolName: string,
  objectType: string,
  objectId: string,
  action: string,
  success: boolean,
  errorMessage?: string,
  context?: Record<string, any>,
  resultHash?: string,
  proxyMode?: string
): Promise<{ success: boolean; mutation_id: string | null }> {
  const maxRetries = 3;
  let lastError: string | null = null;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const params: any = {
        p_work_order_id: ctx.workOrderId,
        p_tool_name: toolName,
        p_object_type: objectType,
        p_object_id: objectId,
        p_action: action,
        p_success: success,
        p_agent_name: ctx.agentName,
      };

      if (!success && errorMessage) {
        params.p_error_class = classifyError(errorMessage);
        params.p_error_detail = errorMessage.substring(0, 500);
      }

      if (context) {
        params.p_context = context;
      }

      // Provable execution: pass result hash and proxy mode
      if (resultHash) {
        params.p_result_hash = resultHash;
      }
      if (proxyMode) {
        params.p_proxy_mode = proxyMode;
      }

      const result = await ctx.supabase.rpc("record_mutation", params);

      if (result.error) {
        lastError = result.error.message;
        console.warn(`[recordMutation] Attempt ${attempt} failed: ${lastError}`);
        if (!lastError.includes('network') && !lastError.includes('timeout') && attempt < maxRetries) {
          await new Promise(resolve => setTimeout(resolve, 100 * attempt));
          continue;
        }
      } else {
        return { success: true, mutation_id: result.data };
      }
    } catch (e: any) {
      lastError = e.message;
      console.warn(`[recordMutation] Attempt ${attempt} exception: ${lastError}`);
      if (attempt < maxRetries) {
        await new Promise(resolve => setTimeout(resolve, 100 * attempt));
      }
    }
  }

  console.error(`[recordMutation] Failed after ${maxRetries} attempts: ${lastError}`);
  return { success: false, mutation_id: null };
}

// Dispatch a tool call to its handler
export async function dispatchTool(
  toolName: string,
  toolInput: Record<string, any>,
  ctx: ToolContext
): Promise<ToolResult> {
  // Define mutating tools that need recording
  const MUTATING_TOOLS = new Set([
    "execute_sql",
    "apply_migration",
    "github_push_files",
    "sandbox_exec",
    "sandbox_write_file",
    "sandbox_pipeline",
    "run_tests",
    "deploy_edge_function",
  ]);

  let result: ToolResult;

  // D2: Permission check at dispatch entry point
  // Check agent_tool_permissions for deny before executing any mutating tool
  if (MUTATING_TOOLS.has(toolName)) {
    try {
      const { data: perm } = await ctx.supabase.rpc("check_agent_permission", {
        p_agent_name: ctx.agentName,
        p_tool_name: toolName,
      });
      if (perm && !perm.allowed && perm.permission === "deny") {
        return {
          success: false,
          error: `Permission denied: agent '${ctx.agentName}' cannot use '${toolName}'. Reason: ${perm.reason || "denied by permission matrix"}`,
        };
      }
    } catch {
      // Permission check failed — allow through (fail-open for now)
    }
  }

  // Phase C: Check if tool should route through /verify edge proxy
  if (PROXY_ELIGIBLE_TOOLS.has(toolName)) {
    const proxyResult = await proxyViaVerify(toolName, toolInput, ctx);
    if (proxyResult !== null) {
      // Proxy handled the request — mutation already recorded server-side with edge_proxy mode
      return proxyResult;
    }
    // proxyResult === null means proxy is disabled or not applicable — fall through to direct execution
  }

  switch (toolName) {
    case "execute_sql":
      result = await handleExecuteSql(toolInput, ctx);
      break;
    case "apply_migration":
      result = await handleApplyMigration(toolInput, ctx);
      break;
    case "read_table":
      result = await handleReadTable(toolInput, ctx);
      break;
    case "github_read_file":
      result = await handleGithubReadFile(toolInput, ctx);
      break;
    case "github_push_files":
      result = await handleGithubPushFiles(toolInput, ctx);
      break;
    case "deploy_edge_function":
      result = await handleDeployEdgeFunction(toolInput, ctx);
      break;
    case "log_progress":
      result = await handleLogProgress(toolInput, ctx);
      break;
    case "read_execution_log":
      result = await handleReadExecutionLog(toolInput, ctx);
      break;
    case "get_schema":
      result = await handleGetSchema(toolInput, ctx);
      break;
    case "mark_complete":
      result = await handleMarkComplete(toolInput, ctx);
      break;
    case "mark_failed":
      result = await handleMarkFailed(toolInput, ctx);
      break;
    case "resolve_qa_findings":
      result = await handleResolveQaFindings(toolInput, ctx);
      break;
    case "update_qa_checklist":
      result = await handleUpdateQaChecklist(toolInput, ctx);
      break;
    case "transition_state":
      result = await handleTransitionState(toolInput, ctx);
      break;
    case "delegate_subtask":
      result = await handleDelegateSubtask(toolInput, ctx);
      break;
    case "check_child_status":
      result = await handleCheckChildStatus(toolInput, ctx);
      break;
    case "web_fetch":
      result = await handleWebFetch(toolInput, ctx);
      break;
    case "github_list_files":
      result = await handleGithubListFiles(toolInput, ctx);
      break;
    case "github_create_branch":
      result = await handleGithubCreateBranch(toolInput, ctx);
      break;
    case "github_create_pr":
      result = await handleGithubCreatePr(toolInput, ctx);
      break;
    case "github_search_code":
      result = await handleGithubSearchCode(toolInput, ctx);
      break;
    case "github_grep":
      result = await handleGithubGrep(toolInput, ctx);
      break;
    case "github_read_file_range":
      result = await handleGithubReadFileRange(toolInput, ctx);
      break;
    case "github_tree":
      result = await handleGithubTree(toolInput, ctx);
      break;
    case "read_full_file":
      result = await handleReadFullFile(toolInput, ctx);
      break;
    case "git_log":
      result = await handleGitLog(toolInput, ctx);
      break;
    case "git_diff":
      result = await handleGitDiff(toolInput, ctx);
      break;
    case "git_blame":
      result = await handleGitBlame(toolInput, ctx);
      break;
    case "search_knowledge_base":
      result = await handleSearchKnowledgeBase(toolInput, ctx);
      break;
    case "search_lessons":
      result = await handleSearchLessons(toolInput, ctx);
      break;
    case "save_memory":
      result = await handleSaveMemory(toolInput, ctx);
      break;
    case "recall_memory":
      result = await handleRecallMemory(toolInput, ctx);
      break;
    case "request_clarification":
      result = await handleRequestClarification(toolInput, ctx);
      break;
    case "check_clarification":
      result = await handleCheckClarification(toolInput, ctx);
      break;
    case "sandbox_exec":
      result = await handleSandboxExec(toolInput, ctx);
      break;
    case "run_tests":
      result = await handleRunTests(toolInput, ctx);
      break;
    case "sandbox_write_file":
      result = await handleSandboxWriteFile(toolInput, ctx);
      break;
    case "sandbox_pipeline":
      result = await handleSandboxPipeline(toolInput, ctx);
      break;
    case "sandbox_read_file":
      result = await handleSandboxReadFile(toolInput, ctx);
      break;
    case "sandbox_edit_file":
      result = await handleSandboxEditFile(toolInput, ctx);
      break;
    case "sandbox_grep":
      result = await handleSandboxGrep(toolInput, ctx);
      break;
    case "sandbox_glob":
      result = await handleSandboxGlob(toolInput, ctx);
      break;
    case "query_ontology":
      result = await handleQueryOntology(toolInput, ctx);
      break;
    case "query_object_links":
      result = await handleQueryObjectLinks(toolInput, ctx);
      break;
    case "query_pipeline_status":
      result = await handleQueryPipelineStatus(toolInput, ctx);
      break;
    default:
      result = { success: false, error: `Unknown tool: ${toolName}` };
  }

  // Record mutation for mutating tools (fire-and-forget)
  if (MUTATING_TOOLS.has(toolName)) {
    // Extract object_type, object_id, and action from toolInput and result
    let objectType = "unknown";
    let objectId = "unknown";
    let action = "unknown";

    let context: Record<string, any> | undefined;

    if (toolName === "execute_sql") {
      objectType = "sql_query";
      // Strip SQL comments before extracting action keyword and object_id
      const rawSql = toolInput.query || "";
      const strippedSql = rawSql.replace(/--[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "").trim();
      objectId = strippedSql.substring(0, 100) || "unknown";
      action = strippedSql.split(/\s+/)[0]?.toUpperCase() || "UNKNOWN";
      context = { sql: (toolInput.query || "").substring(0, 2000) };
    } else if (toolName === "apply_migration") {
      objectType = "migration";
      objectId = toolInput.name || "unknown";
      action = "DDL";
      context = {
        sql: (toolInput.query || "").substring(0, 2000),
        migration_name: toolInput.name
      };
    } else if (toolName === "github_push_files") {
      objectType = "github_file";
      objectId = (toolInput.files || []).map((f: any) => f.path).join(", ") || "unknown";
      action = "PUSH";
      context = {
        files: (toolInput.files || []).map((f: any) => ({
          path: f.path,
          mode: f.content ? "content" : "patch"
        })),
        message: toolInput.message
      };
    } else if (toolName === "deploy_edge_function") {
      objectType = "edge_function";
      objectId = toolInput.function_name || "unknown";
      action = "DEPLOY";
      context = { function_name: toolInput.function_name };
    } else if (toolName.startsWith("sandbox_") || toolName === "run_tests") {
      objectType = "sandbox";
      objectId = toolInput.path || toolInput.pattern || toolInput.command || toolInput.test_command || "unknown";
      action = toolName === "run_tests" ? "TEST" : toolName.replace("sandbox_", "").toUpperCase();
      context = { path: toolInput.path, command: toolInput.command || toolName };
    }

    // Skip recording SELECT queries (reads, not mutations)
    const shouldRecord = !(toolName === "execute_sql" && action === "SELECT");

    if (shouldRecord) {
      // Compute SHA-256 hash of result data for provable execution
      let resultHash: string | undefined;
      try {
        const resultData = result.data != null ? JSON.stringify(result.data) : result.error || "";
        resultHash = await sha256(resultData.substring(0, 10000));
      } catch {
        // Non-critical — proceed without hash
      }

      await recordMutation(
        ctx,
        toolName,
        objectType,
        objectId,
        action,
        result.success,
        result.error,
        context,
        resultHash,
        "self_report"
      );
    }
  }

  return result;
}
