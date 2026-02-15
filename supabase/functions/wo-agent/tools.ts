// wo-agent/tools.ts v4.1
// WO-0153: Fixed imports for Deno Deploy compatibility
// WO-0166: Role-based tool filtering per agent identity
// WO-0245: delegate_subtask tool for WO tree execution
// WO-0257: github_edit_file removed — replaced by github_push_files (Git Data API)
// WO-0485: Mutation recording in all mutating tool handlers
// WO-0491: Remediation - trigger re-deploy to confirm instrumentation
// Tool definitions for the agentic work order executor
// Each tool maps to an Anthropic tool_use schema + a dispatch handler

// Tool type from Anthropic SDK  --  inlined to avoid deep npm sub-path import that breaks Deno edge runtime
type Tool = { name: string; description: string; input_schema: Record<string, any> };
import { classifyError } from "./error-classifier.ts";
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
// WO-0434: search_lessons import verified
import { handleDelegateSubtask, handleCheckChildStatus } from "./tool-handlers/delegate.ts";
import { handleQueryOntology, handleQueryObjectLinks, handleQueryPipelineStatus } from "./tool-handlers/ontology.ts";

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
async function recordMutation(
  ctx: ToolContext,
  toolName: string,
  objectType: string,
  objectId: string,
  action: string,
  success: boolean,
  errorMessage?: string,
  context?: Record<string, any>
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

export const TOOL_DEFINITIONS: Tool[] = [
  {
    name: "execute_sql",
    description:
      "Execute a SQL query against the Supabase database. Use for SELECT, INSERT, UPDATE, DELETE. For DDL (CREATE TABLE, ALTER, etc), use apply_migration instead.",
    input_schema: {
      type: "object" as const,
      properties: {
        query: {
          type: "string",
          description: "The SQL query to execute",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "apply_migration",
    description:
      "Apply a DDL migration (CREATE TABLE, ALTER TABLE, CREATE FUNCTION, etc). This creates a tracked migration. Use execute_sql for DML operations.",
    input_schema: {
      type: "object" as const,
      properties: {
        name: {
          type: "string",
          description: "Migration name in snake_case, e.g. add_user_roles_column",
        },
        query: {
          type: "string",
          description: "The DDL SQL to apply",
        },
      },
      required: ["name", "query"],
    },
  },
  {
    name: "read_table",
    description:
      "Read rows from a Supabase table with optional filters. Returns up to 50 rows.",
    input_schema: {
      type: "object" as const,
      properties: {
        table: {
          type: "string",
          description: "Table name",
        },
        select: {
          type: "string",
          description: "Columns to select (PostgREST syntax), e.g. 'id, name, status'",
        },
        filters: {
          type: "object",
          description:
            "Key-value filters, e.g. {\"status\": \"active\", \"priority\": \"p1_high\"}",
        },
        limit: {
          type: "number",
          description: "Max rows to return (default 20, max 50)",
        },
        order: {
          type: "string",
          description: "Column to order by, e.g. 'created_at.desc'",
        },
      },
      required: ["table"],
    },
  },
  {
    name: "github_read_file",
    description:
      "Read a file from a GitHub repository. Returns the file content decoded from base64.",
    input_schema: {
      type: "object" as const,
      properties: {
        repo: {
          type: "string",
          description: "Repository in owner/repo format, e.g. olivergale/metis-portal2",
        },
        path: {
          type: "string",
          description: "File path within the repo, e.g. src/App.tsx",
        },
        branch: {
          type: "string",
          description: "Branch name (default: main)",
        },
      },
      required: ["repo", "path"],
    },
  },
  {
    name: "github_push_files",
    description:
      "Commit one or more files atomically to a GitHub repository using the Git Data API (UTF-8 blobs, no base64 round-trip). This is the ONLY tool for writing files to GitHub. Two modes per file: full content (provide 'content') or patch mode (provide 'patches' array of {search, replace} -- tool reads current file and applies patches). Atomic: all files committed in a single commit.",
    input_schema: {
      type: "object" as const,
      properties: {
        repo: {
          type: "string",
          description: "Repository in owner/repo format (default: olivergale/metis-portal2)",
        },
        branch: {
          type: "string",
          description: "Branch name (default: main)",
        },
        message: {
          type: "string",
          description: "Commit message",
        },
        files: {
          type: "array",
          items: {
            type: "object",
            properties: {
              path: { type: "string", description: "File path within the repo" },
              content: { type: "string", description: "Full file content (use this OR patches, not both)" },
              patches: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    search: { type: "string", description: "Exact string to find in current file" },
                    replace: { type: "string", description: "Replacement string" },
                  },
                  required: ["search", "replace"],
                },
                description: "Search/replace patches applied to current file content. Tool reads file, applies patches, commits.",
              },
            },
            required: ["path"],
          },
          description: "Array of files to commit. Each needs 'path' plus either 'content' (full file) or 'patches' (search/replace edits).",
        },
      },
      required: ["message", "files"],
    },
  },
  {
    name: "deploy_edge_function",
    description:
      "Deploy a Supabase Edge Function. Provide the function name and file contents. Use sparingly -- only for small functions.",
    input_schema: {
      type: "object" as const,
      properties: {
        function_name: {
          type: "string",
          description: "Name of the edge function to deploy",
        },
        entrypoint: {
          type: "string",
          description: "Entrypoint filename (default: index.ts)",
        },
        files: {
          type: "array",
          items: {
            type: "object",
            properties: {
              name: { type: "string" },
              content: { type: "string" },
            },
            required: ["name", "content"],
          },
          description: "Array of {name, content} file objects to deploy",
        },
      },
      required: ["function_name", "files"],
    },
  },
  {
    name: "web_fetch",
    description:
      "Fetch content from a URL and return text/markdown. Useful for reading documentation, API specs, or external resources. Handles HTML, text, markdown, and JSON responses.",
    input_schema: {
      type: "object" as const,
      properties: {
        url: {
          type: "string",
          description: "The URL to fetch (must be a valid HTTP/HTTPS URL)",
        },
      },
      required: ["url"],
    },
  },
  {
    name: "github_list_files",
    description:
      "List files and directories in a GitHub repository path. Returns metadata including name, path, type, size, and SHA for each item.",
    input_schema: {
      type: "object" as const,
      properties: {
        repo: {
          type: "string",
          description: "Repository in owner/repo format, e.g. olivergale/metis-portal2",
        },
        path: {
          type: "string",
          description: "Directory path within the repo (empty string for root)",
        },
        branch: {
          type: "string",
          description: "Branch name (default: main)",
        },
      },
      required: ["repo"],
    },
  },
  {
    name: "github_create_branch",
    description:
      "Create a new branch in a GitHub repository from an existing branch. Useful for preparing feature branches before making changes.",
    input_schema: {
      type: "object" as const,
      properties: {
        repo: {
          type: "string",
          description: "Repository in owner/repo format",
        },
        branch: {
          type: "string",
          description: "Name of the new branch to create",
        },
        from_branch: {
          type: "string",
          description: "Base branch to create from (default: main)",
        },
      },
      required: ["repo", "branch"],
    },
  },
  {
    name: "github_create_pr",
    description:
      "Create a pull request in a GitHub repository. Use after committing changes to a feature branch.",
    input_schema: {
      type: "object" as const,
      properties: {
        repo: {
          type: "string",
          description: "Repository in owner/repo format",
        },
        head: {
          type: "string",
          description: "The branch containing your changes",
        },
        base: {
          type: "string",
          description: "The branch you want to merge into (default: main)",
        },
        title: {
          type: "string",
          description: "Pull request title",
        },
        body: {
          type: "string",
          description: "Pull request description",
        },
      },
      required: ["repo", "head", "title"],
    },
  },
  {
    name: "github_search_code",
    description:
      "Search for code across the repository using GitHub Code Search API. Returns top 10 results with file paths, line numbers, and 3 lines of context around each match.",
    input_schema: {
      type: "object" as const,
      properties: {
        query: {
          type: "string",
          description: "Search query (automatically scoped to olivergale/metis-portal2 repo)",
        },
        path_filter: {
          type: "string",
          description: "Optional path filter (e.g., 'supabase/functions' or '*.ts')",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "github_grep",
    description:
      "Search file contents in GitHub repository using Code Search API. Returns up to 10 matches with file paths and matched line content.",
    input_schema: {
      type: "object" as const,
      properties: {
        repo: {
          type: "string",
          description: "Repository in owner/repo format (default: olivergale/metis-portal2)",
        },
        pattern: {
          type: "string",
          description: "Search pattern to find in file contents",
        },
        path: {
          type: "string",
          description: "Optional directory filter (e.g., 'supabase/functions' to search only in that directory)",
        },
        branch: {
          type: "string",
          description: "Branch name (default: main)",
        },
      },
      required: ["pattern"],
    },
  },
  {
    name: "github_read_file_range",
    description:
      "Read specific line range from a GitHub file without 10k char truncation. Decodes full file content and returns requested lines with line numbers.",
    input_schema: {
      type: "object" as const,
      properties: {
        repo: {
          type: "string",
          description: "Repository in owner/repo format (default: olivergale/metis-portal2)",
        },
        path: {
          type: "string",
          description: "File path within the repo",
        },
        start_line: {
          type: "number",
          description: "Starting line number (1-indexed)",
        },
        end_line: {
          type: "number",
          description: "Ending line number (1-indexed, inclusive)",
        },
        branch: {
          type: "string",
          description: "Branch name (default: main)",
        },
      },
      required: ["path", "start_line", "end_line"],
    },
  },
  {
    name: "github_tree",
    description:
      "Get the entire repository file tree in one call using GitHub Git Trees API. Returns full repo structure with optional path filtering and file sizes. Much more efficient than github_list_files for discovering repo structure.",
    input_schema: {
      type: "object" as const,
      properties: {
        repo: {
          type: "string",
          description: "Repository in owner/repo format (default: olivergale/metis-portal2)",
        },
        path_filter: {
          type: "string",
          description: "Optional path prefix filter (e.g., 'supabase/functions/' to only show that directory tree)",
        },
        branch: {
          type: "string",
          description: "Branch name (default: main)",
        },
        show_sizes: {
          type: "boolean",
          description: "Include file sizes in output (default: false)",
        },
      },
      required: [],
    },
  },
  {
    name: "read_full_file",
    description:
      "Read FULL file content from GitHub using Git Data API (no 10k char truncation). Use this instead of github_read_file for large files (>10k chars). Returns complete file content via blob API (up to 100MB).",
    input_schema: {
      type: "object" as const,
      properties: {
        path: {
          type: "string",
          description: "File path within the repo, e.g. supabase/functions/wo-agent/tools.ts",
        },
        repo: {
          type: "string",
          description: "Repository in owner/repo format (default: olivergale/metis-portal2)",
        },
        ref: {
          type: "string",
          description: "Branch name (default: main)",
        },
      },
      required: ["path"],
    },
  },
  {
    name: "git_log",
    description:
      "Get commit history for a file or repository. Returns commit SHA, message, author, and date. Useful for understanding code evolution and finding when changes were made.",
    input_schema: {
      type: "object" as const,
      properties: {
        path: {
          type: "string",
          description: "Optional file path to get history for (omit for repo-wide history)",
        },
        repo: {
          type: "string",
          description: "Repository in owner/repo format (default: olivergale/metis-portal2)",
        },
        ref: {
          type: "string",
          description: "Branch name or commit SHA to start from (default: main)",
        },
        limit: {
          type: "number",
          description: "Max commits to return (default: 20, max: 100)",
        },
      },
      required: [],
    },
  },
  {
    name: "git_diff",
    description:
      "Compare two commits or branches. Returns list of changed files with additions, deletions, and patch content. Useful for reviewing changes between versions.",
    input_schema: {
      type: "object" as const,
      properties: {
        base: {
          type: "string",
          description: "Base commit SHA or branch name to compare from",
        },
        head: {
          type: "string",
          description: "Head commit SHA or branch name to compare to (default: main)",
        },
        repo: {
          type: "string",
          description: "Repository in owner/repo format (default: olivergale/metis-portal2)",
        },
      },
      required: ["base"],
    },
  },
  {
    name: "git_blame",
    description:
      "Get line-by-line blame information for a file. Shows which commit last modified each line range, with author and date. Uses GitHub GraphQL API.",
    input_schema: {
      type: "object" as const,
      properties: {
        path: {
          type: "string",
          description: "File path within the repo",
        },
        repo: {
          type: "string",
          description: "Repository in owner/repo format (default: olivergale/metis-portal2)",
        },
        ref: {
          type: "string",
          description: "Branch name or commit SHA (default: main)",
        },
      },
      required: ["path"],
    },
  },
  {
    name: "search_knowledge_base",
    description:
      "Search the institutional knowledge base for lessons learned, patterns, and best practices. Returns relevant KB entries filtered by tags and severity.",
    input_schema: {
      type: "object" as const,
      properties: {
        query: {
          type: "string",
          description: "Search query text",
        },
        tags: {
          type: "array",
          items: { type: "string" },
          description: "Filter by tags (optional)",
        },
        limit: {
          type: "number",
          description: "Max results to return (default 10, max 20)",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "search_lessons",
    description:
      "Search promoted lessons filtered by category, tags, and agent role. Returns lessons ranked by relevance, recency, and severity. Use during failure triage to find past solutions to similar problems.",
    input_schema: {
      type: "object" as const,
      properties: {
        category: {
          type: "string",
          description: "Lesson category to filter by (e.g. state_machine, schema, deployment, qa)",
        },
        tags: {
          type: "array",
          items: { type: "string" },
          description: "Tags to match (lessons with overlapping tags score higher)",
        },
        agent_name: {
          type: "string",
          description: "Agent name to filter lessons relevant to this agent role (optional)",
        },
        limit: {
          type: "number",
          description: "Max results to return (default 10, max 20)",
        },
      },
      required: [],
    },
  },
  {
    name: "log_progress",
    description:
      "Log a progress message to the work order execution log. Use to record what you're doing.",
    input_schema: {
      type: "object" as const,
      properties: {
        message: {
          type: "string",
          description: "Progress message to log",
        },
        phase: {
          type: "string",
          description: "Phase identifier (default: stream)",
          enum: ["stream", "execution_start", "execution_complete"],
        },
      },
      required: ["message"],
    },
  },
  {
    name: "read_execution_log",
    description:
      "Read execution log entries for a work order. Useful for remediation WOs to see parent's execution history.",
    input_schema: {
      type: "object" as const,
      properties: {
        work_order_id: {
          type: "string",
          description: "Work order UUID to read logs for. Defaults to current WO if omitted.",
        },
        limit: {
          type: "number",
          description: "Max entries to return (default 20)",
        },
      },
      required: [],
    },
  },
  {
    name: "get_schema",
    description:
      "Get the database schema context including tables, enums, and RPCs. Returns formatted markdown.",
    input_schema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
  {
    name: "mark_complete",
    description:
      "Mark the work order as complete with a summary. This is a TERMINAL action -- the loop will end after this.",
    input_schema: {
      type: "object" as const,
      properties: {
        summary: {
          type: "string",
          description: "Summary of what was accomplished",
        },
      },
      required: ["summary"],
    },
  },
  {
    name: "mark_failed",
    description:
      "Mark the work order as failed with a reason. This is a TERMINAL action -- the loop will end after this.",
    input_schema: {
      type: "object" as const,
      properties: {
        reason: {
          type: "string",
          description: "Why the work order failed",
        },
      },
      required: ["reason"],
    },
  },
  {
    name: "resolve_qa_findings",
    description:
      "Resolve all unresolved QA failure findings for a work order. Use this when you have fixed the issues and want to clear the QA gate. For remediation WOs, pass the parent work_order_id to resolve the parent's findings.",
    input_schema: {
      type: "object" as const,
      properties: {
        work_order_id: {
          type: "string",
          description: "Work order UUID whose findings to resolve. Defaults to current WO.",
        },
      },
      required: [],
    },
  },
  {
    name: "update_qa_checklist",
    description:
      "Update a specific QA checklist item's status (pass/fail/na) with evidence. The qa_checklist lives on the work_orders table as JSONB. Each item has an id, criterion, status, and evidence field.",
    input_schema: {
      type: "object" as const,
      properties: {
        work_order_id: {
          type: "string",
          description: "Work order UUID. Defaults to current WO.",
        },
        checklist_item_id: {
          type: "string",
          description: "The id of the checklist item to update (from qa_checklist array)",
        },
        status: {
          type: "string",
          description: "New status for the item",
          enum: ["pass", "fail", "na"],
        },
        evidence_summary: {
          type: "string",
          description: "Evidence supporting the status (e.g. SQL query result, verification details)",
        },
      },
      required: ["checklist_item_id", "status"],
    },
  },
  {
    name: "transition_state",
    description:
      "Transition a work order's status via the enforcement layer (no bypass). Use this instead of direct SQL UPDATE on work_orders.status. Valid transitions: in_progress->review, in_progress->failed, review->done.",
    input_schema: {
      type: "object" as const,
      properties: {
        work_order_id: {
          type: "string",
          description: "Work order UUID to transition. Defaults to current WO.",
        },
        new_status: {
          type: "string",
          description: "Target status",
          enum: ["review", "done", "failed"],
        },
        summary: {
          type: "string",
          description: "Summary or reason for the transition",
        },
      },
      required: ["new_status"],
    },
  },
  {
    name: "delegate_subtask",
    description:
      "Create a child work order with inherited context. Always non-blocking -- parent continues immediately. Use check_child_status to poll for completion.",
    input_schema: {
      type: "object" as const,
      properties: {
        name: {
          type: "string",
          description: "Name/title for the child work order",
        },
        objective: {
          type: "string",
          description: "Clear objective for the child WO to execute",
        },
        acceptance_criteria: {
          type: "string",
          description: "Numbered acceptance criteria (e.g. '1. Create table X\\n2. Add column Y')",
        },
        model_tier: {
          type: "string",
          description: "Model tier for the child executor (default: sonnet)",
          enum: ["opus", "sonnet", "haiku"],
        },
        context_injection: {
          type: "string",
          description: "Context/plan text to inject into the child WO's team_context for shared understanding",
        },
      },
      required: ["name", "objective", "acceptance_criteria"],
    },
  },
  {
    name: "check_child_status",
    description:
      "Check the status of a delegated child work order. Returns current status, summary (if completed/failed), and last activity. Use after delegate_subtask to poll for child completion.",
    input_schema: {
      type: "object" as const,
      properties: {
        child_slug: {
          type: "string",
          description: "Slug of the child work order (e.g. WO-0300)",
        },
        child_id: {
          type: "string",
          description: "UUID of the child work order (alternative to child_slug)",
        },
      },
      required: [],
    },
  },
  {
    name: "request_clarification",
    description:
      "Pause the work order and request human input when encountering ambiguity. The WO will transition to blocked_on_input status and wait for a human response. Use this instead of guessing or failing when requirements are unclear.",
    input_schema: {
      type: "object" as const,
      properties: {
        question: {
          type: "string",
          description: "The specific question you need answered",
        },
        context: {
          type: "string",
          description: "Context about why you need clarification (what you've tried, what's ambiguous)",
        },
        options: {
          type: "array",
          items: { type: "string" },
          description: "Optional: Structured choice options for the human to select from",
        },
        urgency: {
          type: "string",
          enum: ["low", "normal", "high"],
          description: "Urgency level for the clarification request (default: normal)",
        },
      },
      required: ["question"],
    },
  },
  {
    name: "check_clarification",
    description:
      "Check if a clarification request has been answered. Returns the current status (pending/answered/expired) and response if available. If expired, the WO will be transitioned to failed.",
    input_schema: {
      type: "object" as const,
      properties: {
        clarification_id: {
          type: "string",
          description: "The UUID of the clarification request (returned from request_clarification)",
        },
      },
      required: ["clarification_id"],
    },
  },
  {
    name: "save_memory",
    description:
      "Save a memory for future work orders. Memories persist across WO executions and help you avoid repeating mistakes or rediscovering patterns.",
    input_schema: {
      type: "object" as const,
      properties: {
        key: {
          type: "string",
          description:
            "Unique key for this memory (e.g. 'github_push_patches_gotcha', 'tools_ts_large_file')",
        },
        memory_type: {
          type: "string",
          enum: ["pattern", "gotcha", "preference", "fact"],
          description: "Type of memory: pattern (reusable approach), gotcha (trap to avoid), preference (style/convention), fact (learned truth)",
        },
        value: {
          type: "object",
          description: "The memory content as JSON object with relevant details",
        },
      },
      required: ["key", "memory_type", "value"],
    },
  },
  {
    name: "recall_memory",
    description:
      "Recall saved memories from previous work orders. Returns all your memories, optionally filtered by type. Use this to check for known patterns or gotchas before attempting a task.",
    input_schema: {
      type: "object" as const,
      properties: {
        memory_type: {
          type: "string",
          enum: ["pattern", "gotcha", "preference", "fact"],
          description: "Optional filter to only return memories of this type",
        },
      },
    },
  },
  {
    name: "sandbox_exec",
    description:
      "Execute a command in sandboxed environment to verify work. Available: deno check, deno test, deno lint, grep, find, cat, diff, jq. Use after writing TypeScript to validate before submitting.",
    input_schema: {
      type: "object" as const,
      properties: {
        command: {
          type: "string",
          description: "Command to execute (e.g. 'deno', 'grep', 'find', 'cat', 'diff', 'jq')",
        },
        args: {
          type: "array",
          items: { type: "string" },
          description: "Array of command arguments (e.g. ['check', 'main.ts'] for deno check)",
        },
        files: {
          type: "array",
          items: {
            type: "object",
            properties: {
              path: { type: "string", description: "File path in sandbox" },
              content: { type: "string", description: "File content" },
            },
            required: ["path", "content"],
          },
          description: "Optional files to write into sandbox before running command",
        },
        timeout_ms: {
          type: "number",
          description: "Timeout in milliseconds (default: 30000)",
        },
      },
      required: ["command", "args"],
    },
  },
  {
    name: "run_tests",
    description:
      "Run test suite via Fly Machine sandbox. Executes npm test (or custom command) in the repo workspace. Use to verify changes before submitting work order.",
    input_schema: {
      type: "object" as const,
      properties: {
        test_command: {
          type: "string",
          description: "Test command to run (default: 'npm test'). Examples: 'npm test', 'npx jest --testPathPattern=foo'",
        },
        cwd: {
          type: "string",
          description: "Working directory inside sandbox (default: /workspace/{wo_slug})",
        },
      },
    },
  },
  {
    name: "sandbox_write_file",
    description:
      "Write a file to the sandbox /workspace directory. All writes are audit-logged. Path must be under /workspace. Returns {success, path, bytes_written}.",
    input_schema: {
      type: "object" as const,
      properties: {
        path: {
          type: "string",
          description: "File path in sandbox (must be under /workspace, e.g. '/workspace/test.txt')",
        },
        content: {
          type: "string",
          description: "File content to write",
        },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "sandbox_pipeline",
    description:
      "Execute multiple commands sequentially in the sandbox. Each command runs in order; if any returns non-zero exit code, pipeline stops and returns partial results. Useful for chained verification (e.g. ls then wc -l).",
    input_schema: {
      type: "object" as const,
      properties: {
        commands: {
          type: "array",
          items: {
            type: "object",
            properties: {
              command: { type: "string", description: "Command to execute" },
              args: { type: "array", items: { type: "string" }, description: "Command arguments" },
            },
            required: ["command"],
          },
          description: "Array of {command, args} to execute sequentially",
        },
        timeout_ms: {
          type: "number",
          description: "Timeout per step in milliseconds (default: 30000)",
        },
      },
      required: ["commands"],
    },
  },
  // MF-FOUND-006: Ontology query tools (read-only)
  {
    name: "query_ontology",
    description: "Query the object_registry for schema objects (tables, functions, views, triggers, etc). Returns matching objects with their properties.",
    input_schema: {
      type: "object" as const,
      properties: {
        object_type: { type: "string", description: "Filter by type: table, function, view, trigger, index, rls_policy, etc" },
        name_pattern: { type: "string", description: "Filter by name (ILIKE pattern, e.g. '%user%')" },
        parent_id: { type: "string", description: "Filter by parent object UUID" },
        limit: { type: "number", description: "Max results (default 20)" },
      },
      required: [],
    },
  },
  {
    name: "query_object_links",
    description: "Query relationships between schema objects (FK, depends_on, triggers, etc). Returns links with source/target names.",
    input_schema: {
      type: "object" as const,
      properties: {
        source_id: { type: "string", description: "Source object UUID" },
        target_id: { type: "string", description: "Target object UUID" },
        link_type: { type: "string", description: "Filter by link type: fk, depends_on, triggers, indexes, etc" },
        limit: { type: "number", description: "Max results (default 20)" },
      },
      required: [],
    },
  },
  {
    name: "query_pipeline_status",
    description: "Get manifold pipeline status. Without pipeline_run_id: returns dashboard summary (pipeline_runs, ontology, mutations, agents). With pipeline_run_id: returns detail for that specific run.",
    input_schema: {
      type: "object" as const,
      properties: {
        pipeline_run_id: { type: "string", description: "Optional UUID of specific pipeline run for detail view" },
      },
      required: [],
    },
  },
];

// Tool categories for filtering
export const SANDBOX_TOOLS = ["sandbox_exec", "run_tests", "sandbox_write_file", "sandbox_pipeline"];
const MEMORY_TOOLS = ["save_memory", "recall_memory"];
const ORCHESTRATION_TOOLS = ["delegate_subtask", "check_child_status"];
const CLARIFICATION_TOOLS = ["request_clarification", "check_clarification"];
const SYSTEM_TOOLS = ["log_progress", "read_execution_log", "get_schema", "mark_complete", "mark_failed", "resolve_qa_findings", "update_qa_checklist", "transition_state", "search_knowledge_base", "search_lessons"];
const SUPABASE_TOOLS = ["execute_sql", "apply_migration", "read_table"];
const GITHUB_TOOLS = ["github_read_file", "github_push_files", "github_list_files", "github_create_branch", "github_create_pr", "github_search_code", "github_grep", "github_read_file_range", "github_tree", "read_full_file", "git_log", "git_diff", "git_blame"];
const DEPLOY_TOOLS = ["deploy_edge_function"];
const WEB_TOOLS = ["web_fetch"];
const ONTOLOGY_TOOLS = ["query_ontology", "query_object_links", "query_pipeline_status"];

/**
 * Return filtered tool list based on WO tags AND agent role (tools_allowed).
 * WO-0166: Intersects tag-based filtering with agent.tools_allowed from DB.
 * WO-0203: GitHub tools now default-on. Only remediation/sql-only restricts to DB-only.
 *
 * Priority: agent.tools_allowed is the hard limit. Tag-based filtering
 * further reduces within what the agent is allowed.
 */
export async function getToolsForWO(
  tags: string[],
  supabase?: any,
  agentName?: string
): Promise<Tool[]> {
  const tagSet = new Set(tags || []);

  // Step 1: Tag-based filtering -- 2 tiers
  // Tier 1 (restricted): sql-only -> system + supabase only
  // Tier 2 (default): everything else (including remediation) -> all tools
  let tagFiltered: Tool[];
  if (tagSet.has("sql-only")) {
    const allowed = new Set([...SYSTEM_TOOLS, ...SUPABASE_TOOLS, ...ONTOLOGY_TOOLS]);
    tagFiltered = TOOL_DEFINITIONS.filter((t) => allowed.has(t.name));
  } else {
    tagFiltered = [...TOOL_DEFINITIONS];
  }

  // Step 2: Agent role-based filtering (tools_allowed from agents table)
  if (supabase && agentName) {
    try {
      const { data: agent } = await supabase
        .from("agents")
        .select("tools_allowed")
        .eq("name", agentName)
        .single();

      if (agent?.tools_allowed && Array.isArray(agent.tools_allowed)) {
        const agentAllowed = new Set(agent.tools_allowed as string[]);
        tagFiltered = tagFiltered.filter((t) => agentAllowed.has(t.name));
      }
    } catch {
      // Agent lookup failed -- fall through with tag-only filtering
    }
  }

  return tagFiltered;
}

/** Sync version for backwards compatibility (no agent filtering) */
export function getToolsForWOSync(tags: string[]): Tool[] {
  const tagSet = new Set(tags || []);
  if (tagSet.has("sql-only")) {
    const allowed = new Set([...SYSTEM_TOOLS, ...SUPABASE_TOOLS]);
    return TOOL_DEFINITIONS.filter((t) => allowed.has(t.name));
  }
  return TOOL_DEFINITIONS;
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
  ]);

  let result: ToolResult;

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
      // WO-0594: Auto-verify pushed files if push succeeded
      if (result.success && result.data?.file_paths) {
        for (const filepath of result.data.file_paths) {
          try {
            // 1. Verify file exists and is readable via cat
            const catResult = await fetch(`${flyUrl}/exec`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                command: "cat",
                args: [filepath],
                timeout_ms: 10000,
                wo_slug: ctx.workOrderSlug,
              }),
            });
            const catJson = await catResult.json();
            const verified = catJson.exit_code === 0;
            
            // 2. Verify byte count matches expected
            let byteCountMismatch = false;
            if (verified && toolInput.files) {
              const fileInput = toolInput.files.find((f: any) => f.path === filepath);
              if (fileInput?.content) {
                const expectedBytes = fileInput.content.length;
                const wcResult = await fetch(`${flyUrl}/exec`, {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({
                    command: "wc",
                    args: ["-c", filepath],
                    timeout_ms: 10000,
                    wo_slug: ctx.workOrderSlug,
                  }),
                });
                const wcJson = await wcResult.json();
                if (wcJson.exit_code === 0 && wcJson.stdout) {
                  const actualBytes = parseInt(wcJson.stdout.trim().split(/\s+/)[0], 10);
                  const mismatchPct = Math.abs(actualBytes - expectedBytes) / expectedBytes * 100;
                  if (mismatchPct > 5) {
                    byteCountMismatch = true;
                    // Log warning to execution_log
                    await ctx.supabase.from("work_order_execution_log").insert({
                      work_order_id: ctx.workOrderId,
                      phase: "stream",
                      agent_name: ctx.agentName,
                      detail: {
                        event_type: "verification_warning",
                        tool_name: "sandbox_exec",
                        message: `Byte count mismatch for ${filepath}: expected ${expectedBytes}, got ${actualBytes} (${mismatchPct.toFixed(1)}% diff)`,
                      },
                    });
                  }
                }
              }
            }
            
            // Log verification result via recordMutation
            await recordMutation(
              ctx,
              "sandbox_exec",
              "file_verification",
              filepath,
              "VERIFY",
              verified && !byteCountMismatch,
              byteCountMismatch ? `Byte count mismatch >5%` : undefined,
              { verified, byteCountMismatch, filepath }
            );
          } catch (verifyErr: any) {
            // Verification failed - log but don't fail the push
            await recordMutation(
              ctx,
              "sandbox_exec",
              "file_verification",
              filepath,
              "VERIFY",
              false,
              verifyErr.message,
              { filepath, verification_error: true }
            );
          }
        }
      }
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
    case "save_memory": {
      const { error: memErr } = await ctx.supabase
        .from("agent_memory")
        .upsert(
          {
            agent_id: ctx.agentName,
            memory_type: toolInput.memory_type,
            key: toolInput.key,
            value: toolInput.value,
            updated_at: new Date().toISOString(),
          },
          { onConflict: "agent_id,memory_type,key" }
        );
      if (memErr) {
        result = { success: false, error: `Failed to save memory: ${memErr.message}` };
      } else {
        result = { success: true, data: { saved: true, key: toolInput.key, memory_type: toolInput.memory_type } };
      }
      break;
    }
    case "recall_memory": {
      let query = ctx.supabase
        .from("agent_memory")
        .select("key, memory_type, value, updated_at")
        .eq("agent_id", ctx.agentName)
        .order("updated_at", { ascending: false })
        .limit(50);
      if (toolInput.memory_type) {
        query = query.eq("memory_type", toolInput.memory_type);
      }
      const { data: memories, error: recallErr } = await query;
      if (recallErr) {
        result = { success: false, error: `Failed to recall memories: ${recallErr.message}` };
      } else {
        result = { success: true, data: { memories: memories || [], count: (memories || []).length } };
      }
      break;
    }
    case "request_clarification": {
      try {
        const clarificationUrl = `${Deno.env.get("SUPABASE_URL")}/functions/v1/request-clarification`;
        const response = await fetch(clarificationUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`,
          },
          body: JSON.stringify({
            work_order_id: ctx.workOrderId,
            question: toolInput.question,
            context: toolInput.context,
            options: toolInput.options,
            urgency: toolInput.urgency || "normal",
          }),
        });
        
        if (!response.ok) {
          const errorData = await response.json().catch(() => ({ error: response.statusText }));
          result = { success: false, error: `Clarification request failed: ${errorData.error || response.statusText}` };
        } else {
          const data = await response.json();
          // Set terminal flag to stop the agent loop
          result = { success: true, data, terminal: true };
        }
      } catch (e: any) {
        result = { success: false, error: `Failed to request clarification: ${e.message}` };
      }
      break;
    }
    case "check_clarification": {
      try {
        const checkUrl = `${Deno.env.get("SUPABASE_URL")}/functions/v1/check-clarification`;
        const response = await fetch(checkUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`,
          },
          body: JSON.stringify({
            clarification_id: toolInput.clarification_id,
          }),
        });
        
        if (!response.ok) {
          const errorData = await response.json().catch(() => ({ error: response.statusText }));
          result = { success: false, error: `Check clarification failed: ${errorData.error || response.statusText}` };
        } else {
          const data = await response.json();
          result = { success: true, data };
        }
      } catch (e: any) {
        result = { success: false, error: `Failed to check clarification: ${e.message}` };
      }
      break;
    }
    case "sandbox_exec": {
      try {
        // WO-0590: Read-only command whitelist -- block writes, pipes, redirects
        const ALLOWED_COMMANDS = new Set(["grep", "find", "wc", "cat", "head", "tail", "echo", "test", "ls", "file", "deno", "diff", "jq", "node", "npm", "npx", "tsc", "python3", "git", "curl", "sed"]);
        const cmd = (toolInput.command || "").trim();
        if (!ALLOWED_COMMANDS.has(cmd)) {
          result = { success: false, error: `Command '${cmd}' is not in the sandbox whitelist. Allowed: ${[...ALLOWED_COMMANDS].join(", ")}` };
          break;
        }
        // Block shell injection via args: no pipes, redirects, semicolons, backticks
        const dangerousPatterns = /[|><;&`$(){}]/;
        const argsStr = (toolInput.args || []).join(" ");
        if (dangerousPatterns.test(argsStr)) {
          result = { success: false, error: "Sandbox args contain blocked characters (pipes, redirects, semicolons, backticks). Use separate tool calls instead." };
          break;
        }

        // WO-0593: Read Fly Machine URL from system_settings
        const { data: flySettings } = await ctx.supabase
          .from("system_settings")
          .select("setting_key, setting_value")
          .in("setting_key", ["fly_machine_url", "fly_machine_token"]);
        const flyUrl = flySettings?.find((s: any) => s.setting_key === "fly_machine_url")?.setting_value;
        const flyToken = flySettings?.find((s: any) => s.setting_key === "fly_machine_token")?.setting_value;

        if (!flyUrl) {
          result = { success: false, error: "Fly Machine URL not configured in system_settings (fly_machine_url)" };
          break;
        }

        // WO-0593: Git-pull-on-demand -- first sandbox call per WO triggers repo sync
        // Track per-WO git pull status via a simple static Set
        if (!(globalThis as any)._flyGitPulled) {
          (globalThis as any)._flyGitPulled = new Set<string>();
        }
        const pulledSet = (globalThis as any)._flyGitPulled as Set<string>;
        if (!pulledSet.has(ctx.workOrderId)) {
          try {
            const pullCtrl = new AbortController();
            const pullTimer = setTimeout(() => pullCtrl.abort(), 60000);
            await fetch(`${flyUrl}/git-pull`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              signal: pullCtrl.signal,
              body: "{}",
            });
            clearTimeout(pullTimer);
            pulledSet.add(ctx.workOrderId);
          } catch (_pullErr) {
            // Non-fatal: git pull failure shouldn't block exec
          }
        }

        // WO-0593: Call Fly Machine /exec endpoint
        const execCtrl = new AbortController();
        const execTimer = setTimeout(() => execCtrl.abort(), 30000);
        const headers: Record<string, string> = { "Content-Type": "application/json" };
        if (flyToken && flyToken !== "not_required_public_endpoint") {
          headers["Authorization"] = `Bearer ${flyToken}`;
        }
        const response = await fetch(`${flyUrl}/exec`, {
          method: "POST",
          headers,
          signal: execCtrl.signal,
          body: JSON.stringify({
            command: toolInput.command,
            args: toolInput.args || [],
            timeout_ms: toolInput.timeout_ms || 30000,
            wo_slug: ctx.workOrderSlug,
          }),
        });
        clearTimeout(execTimer);

        if (!response.ok) {
          const errorData = await response.json().catch(() => ({ error: response.statusText }));
          result = { success: false, error: `Sandbox exec failed (${response.status}): ${errorData.error || errorData.stderr || response.statusText}` };
        } else {
          const execResult = await response.json();
          const success = execResult.exit_code === 0;
          result = {
            success,
            output: execResult.stdout || "",
            error: execResult.stderr || undefined,
            data: {
              stdout: execResult.stdout,
              stderr: execResult.stderr,
              exit_code: execResult.exit_code,
            },
          };
        }

        // Record mutation
        const cmdStr = `${toolInput.command} ${(toolInput.args || []).join(" ")}`;
        await recordMutation(
          ctx,
          "sandbox_exec",
          "sandbox",
          cmdStr.substring(0, 100),
          "EXEC",
          result.success,
          result.error,
          {
            command: toolInput.command,
            args: toolInput.args,
            exit_code: result.data?.exit_code,
          }
        );
      } catch (e: any) {
        if (e.name === "AbortError") {
          result = { success: false, error: "Sandbox exec timed out after 30s" };
        } else {
          result = { success: false, error: `Sandbox exec error: ${e.message}` };
        }
      }
      break;
    }
    case "run_tests": {
      try {
        // WO-0594: Run tests via Fly Machine sandbox
        const { data: flySettings } = await ctx.supabase
          .from("system_settings")
          .select("setting_key, setting_value")
          .in("setting_key", ["fly_machine_url", "fly_machine_token"]);
        const flyUrl = flySettings?.find((s: any) => s.setting_key === "fly_machine_url")?.setting_value;
        const flyToken = flySettings?.find((s: any) => s.setting_key === "fly_machine_token")?.setting_value;

        if (!flyUrl) {
          result = { success: false, error: "Fly Machine URL not configured in system_settings (fly_machine_url)" };
          break;
        }

        // Git-pull to ensure latest code
        if (!(globalThis as any)._flyGitPulled) {
          (globalThis as any)._flyGitPulled = new Set<string>();
        }
        const pulledSet = (globalThis as any)._flyGitPulled as Set<string>;
        if (!pulledSet.has(ctx.workOrderId)) {
          try {
            const pullCtrl = new AbortController();
            const pullTimer = setTimeout(() => pullCtrl.abort(), 60000);
            await fetch(`${flyUrl}/git-pull`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              signal: pullCtrl.signal,
              body: "{}",
            });
            clearTimeout(pullTimer);
            pulledSet.add(ctx.workOrderId);
          } catch (_pullErr) {
            // Non-fatal
          }
        }

        // Parse test command Ã¢ÂÂ default to npm test
        const testCmd = (toolInput.test_command || "npm test").trim();
        const parts = testCmd.split(/\s+/);
        const command = parts[0];
        const args = parts.slice(1);

        // Validate command against whitelist
        const TEST_ALLOWED = new Set(["npm", "npx", "node", "deno", "tsc"]);
        if (!TEST_ALLOWED.has(command)) {
          result = { success: false, error: `Test command '${command}' not allowed. Use: ${[...TEST_ALLOWED].join(", ")}` };
          break;
        }

        const execCtrl = new AbortController();
        const execTimer = setTimeout(() => execCtrl.abort(), 120000); // 120s timeout for tests
        const headers: Record<string, string> = { "Content-Type": "application/json" };
        if (flyToken && flyToken !== "not_required_public_endpoint") {
          headers["Authorization"] = `Bearer ${flyToken}`;
        }
        const response = await fetch(`${flyUrl}/exec`, {
          method: "POST",
          headers,
          signal: execCtrl.signal,
          body: JSON.stringify({
            command,
            args,
            timeout_ms: 120000,
            wo_slug: ctx.workOrderSlug,
          }),
        });
        clearTimeout(execTimer);

        if (!response.ok) {
          const errorData = await response.json().catch(() => ({ error: response.statusText }));
          result = { success: false, error: `Test execution failed (${response.status}): ${errorData.error || errorData.stderr || response.statusText}` };
        } else {
          const execResult = await response.json();
          const success = execResult.exit_code === 0;
          result = {
            success,
            output: execResult.stdout || "",
            error: execResult.stderr || undefined,
            data: {
              stdout: execResult.stdout,
              stderr: execResult.stderr,
              exit_code: execResult.exit_code,
              test_command: testCmd,
            },
          };
        }

        // Record mutation
        await recordMutation(
          ctx,
          "run_tests",
          "test_suite",
          testCmd.substring(0, 100),
          "TEST",
          result.success,
          result.error,
          { test_command: testCmd, exit_code: result.data?.exit_code }
        );
      } catch (e: any) {
        if (e.name === "AbortError") {
          result = { success: false, error: "Test execution timed out after 120s" };
        } else {
          result = { success: false, error: `Test execution error: ${e.message}` };
        }
      }
      break;
    }
    case "sandbox_write_file": {
      try {
        const { data: flySettings } = await ctx.supabase
          .from("system_settings")
          .select("setting_key, setting_value")
          .in("setting_key", ["fly_machine_url", "fly_machine_token"]);
        const flyUrl = flySettings?.find((s: any) => s.setting_key === "fly_machine_url")?.setting_value;
        const flyToken = flySettings?.find((s: any) => s.setting_key === "fly_machine_token")?.setting_value;

        if (!flyUrl) {
          result = { success: false, error: "Fly Machine URL not configured" };
          break;
        }

        const filePath = toolInput.path || "";
        if (!filePath.startsWith("/workspace")) {
          result = { success: false, error: `Path must be under /workspace. Got: ${filePath}` };
          break;
        }

        // Use tee to write content via stdin simulation — exec endpoint with echo piped concept
        // Actually use the /exec endpoint with 'tee' command
        const headers: Record<string, string> = { "Content-Type": "application/json" };
        if (flyToken && flyToken !== "not_required_public_endpoint") {
          headers["Authorization"] = `Bearer ${flyToken}`;
        }

        // Ensure parent directory exists first
        const parentDir = filePath.substring(0, filePath.lastIndexOf("/"));
        if (parentDir && parentDir !== "/workspace") {
          await fetch(`${flyUrl}/exec`, {
            method: "POST",
            headers,
            body: JSON.stringify({ command: "mkdir", args: ["-p", parentDir], wo_slug: ctx.workOrderSlug }),
          });
        }

        // Write via echo + tee pipeline using the /pipeline endpoint
        const content = toolInput.content || "";
        const response = await fetch(`${flyUrl}/pipeline`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            commands: [
              { command: "tee", args: [filePath] },
            ],
            wo_slug: ctx.workOrderSlug,
            timeout_ms: 10000,
          }),
        });

        // tee reads from stdin but /pipeline doesn't pipe stdin
        // Use echo + redirect approach instead — write via node one-liner
        const writeResponse = await fetch(`${flyUrl}/exec`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            command: "node",
            args: ["-e", `require('fs').writeFileSync('${filePath.replace(/'/g, "\\'")}', Buffer.from('${Buffer.from(content).toString("base64")}', 'base64')); console.log(JSON.stringify({bytes: ${content.length}}))`],
            wo_slug: ctx.workOrderSlug,
            timeout_ms: 10000,
          }),
        });

        if (!writeResponse.ok) {
          result = { success: false, error: `Write failed: ${writeResponse.statusText}` };
        } else {
          const writeResult = await writeResponse.json();
          if (writeResult.exit_code !== 0) {
            result = { success: false, error: writeResult.stderr || "Write failed" };
          } else {
            result = { success: true, path: filePath, bytes_written: content.length };
          }
        }

        await recordMutation(ctx, "sandbox_write_file", "sandbox", filePath, "WRITE", result.success, result.error, { path: filePath, bytes: content.length });
      } catch (e: any) {
        result = { success: false, error: `Sandbox write error: ${e.message}` };
      }
      break;
    }
    case "sandbox_pipeline": {
      try {
        const { data: flySettings } = await ctx.supabase
          .from("system_settings")
          .select("setting_key, setting_value")
          .in("setting_key", ["fly_machine_url", "fly_machine_token"]);
        const flyUrl = flySettings?.find((s: any) => s.setting_key === "fly_machine_url")?.setting_value;
        const flyToken = flySettings?.find((s: any) => s.setting_key === "fly_machine_token")?.setting_value;

        if (!flyUrl) {
          result = { success: false, error: "Fly Machine URL not configured" };
          break;
        }

        const headers: Record<string, string> = { "Content-Type": "application/json" };
        if (flyToken && flyToken !== "not_required_public_endpoint") {
          headers["Authorization"] = `Bearer ${flyToken}`;
        }

        const pipelineCtrl = new AbortController();
        const pipelineTimer = setTimeout(() => pipelineCtrl.abort(), 60000);
        const response = await fetch(`${flyUrl}/pipeline`, {
          method: "POST",
          headers,
          signal: pipelineCtrl.signal,
          body: JSON.stringify({
            commands: toolInput.commands || [],
            timeout_ms: toolInput.timeout_ms || 30000,
            wo_slug: ctx.workOrderSlug,
          }),
        });
        clearTimeout(pipelineTimer);

        if (!response.ok) {
          const errorData = await response.json().catch(() => ({ error: response.statusText }));
          result = { success: false, error: `Pipeline failed (${response.status}): ${errorData.error || response.statusText}` };
        } else {
          const pipelineResult = await response.json();
          result = {
            success: pipelineResult.overall_success,
            data: pipelineResult,
            output: pipelineResult.steps?.map((s: any) => s.stdout).join("\n") || "",
          };
        }

        const cmdSummary = (toolInput.commands || []).map((c: any) => c.command).join(" | ");
        await recordMutation(ctx, "sandbox_pipeline", "sandbox", cmdSummary.substring(0, 100), "PIPELINE", result.success, result.error, { steps: (toolInput.commands || []).length });
      } catch (e: any) {
        if (e.name === "AbortError") {
          result = { success: false, error: "Pipeline timed out after 60s" };
        } else {
          result = { success: false, error: `Pipeline error: ${e.message}` };
        }
      }
      break;
    }
    // MF-FOUND-006: Ontology tools (read-only, no mutation recording)
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
    }

    // Skip recording SELECT queries (reads, not mutations)
    const shouldRecord = !(toolName === "execute_sql" && action === "SELECT");
    
    if (shouldRecord) {
      await recordMutation(
        ctx,
        toolName,
        objectType,
        objectId,
        action,
        result.success,
        result.error,
        context
      );
    }
  }

  return result;
}
