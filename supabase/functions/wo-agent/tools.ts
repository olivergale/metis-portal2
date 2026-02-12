// wo-agent/tools.ts v4
// WO-0153: Fixed imports for Deno Deploy compatibility
// WO-0166: Role-based tool filtering per agent identity
// WO-0245: delegate_subtask tool for WO tree execution
// WO-0257: github_edit_file patch-based editing
// Tool definitions for the agentic work order executor
// Each tool maps to an Anthropic tool_use schema + a dispatch handler

import type { Tool } from "npm:@anthropic-ai/sdk@0.39.0/resources/messages.mjs";
import { handleExecuteSql, handleApplyMigration, handleReadTable } from "./tool-handlers/supabase.ts";
import { handleGithubReadFile, handleGithubWriteFile, handleGithubEditFile, handleGithubPatchFile, handleGithubListFiles, handleGithubCreateBranch, handleGithubCreatePr } from "./tool-handlers/github.ts";
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
    name: "github_write_file",
    description:
      "Create or update a file in a GitHub repository. Automatically handles SHA for updates. For modifying existing files, prefer github_edit_file instead (sends only the diff).",
    input_schema: {
      type: "object" as const,
      properties: {
        repo: {
          type: "string",
          description: "Repository in owner/repo format",
        },
        path: {
          type: "string",
          description: "File path within the repo",
        },
        content: {
          type: "string",
          description: "File content to write",
        },
        message: {
          type: "string",
          description: "Commit message",
        },
        branch: {
          type: "string",
          description: "Branch name (default: main)",
        },
      },
      required: ["repo", "path", "content", "message"],
    },
  },
  {
    name: "github_edit_file",
    description:
      "Edit a file in a GitHub repository using patch-based replacement. Reads current file, replaces old_string with new_string, commits back. Much more efficient than github_write_file for modifications -- only send the diff, not the whole file. old_string must be unique in the file.",
    input_schema: {
      type: "object" as const,
      properties: {
        repo: {
          type: "string",
          description: "Repository in owner/repo format (default: olivergale/metis-portal2)",
        },
        path: {
          type: "string",
          description: "File path within the repo, e.g. src/App.tsx",
        },
        old_string: {
          type: "string",
          description: "The exact string to find and replace (must be unique in the file)",
        },
        new_string: {
          type: "string",
          description: "The replacement string",
        },
        message: {
          type: "string",
          description: "Commit message (default: 'Edit {path} via github_edit_file')",
        },
        branch: {
          type: "string",
          description: "Branch name (default: main)",
        },
      },
      required: ["path", "old_string", "new_string"],
    },
  },
  {
    name: "github_patch_file",
    description:
      "Apply multiple search-and-replace patches to a file in GitHub. Reads the FULL file server-side (no size limit), applies patches sequentially, commits result. Use this for editing large files where github_edit_file old_string would be too large to output, or when multiple edits are needed in one commit.",
    input_schema: {
      type: "object" as const,
      properties: {
        repo: {
          type: "string",
          description: "Repository in owner/repo format (default: olivergale/metis-portal2)",
        },
        path: {
          type: "string",
          description: "File path within the repo, e.g. supabase/functions/wo-agent/tools.ts",
        },
        patches: {
          type: "array",
          items: {
            type: "object",
            properties: {
              search: { type: "string", description: "Exact string to find (must exist in file)" },
              replace: { type: "string", description: "Replacement string" },
            },
            required: ["search", "replace"],
          },
          description: "Array of {search, replace} patches applied in order. Each search must be found in the file.",
        },
        message: {
          type: "string",
          description: "Commit message",
        },
        branch: {
          type: "string",
          description: "Branch name (default: main)",
        },
      },
      required: ["path", "patches"],
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
      "Create a child work order with inherited context and specific model assignment. The child WO is immediately dispatched for execution. Always non-blocking ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ parent continues immediately. Use check_child_status to poll for completion.",
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
];

// Tool categories for filtering
const ORCHESTRATION_TOOLS = ["delegate_subtask", "check_child_status"];
const SYSTEM_TOOLS = ["log_progress", "read_execution_log", "get_schema", "mark_complete", "mark_failed", "resolve_qa_findings", "update_qa_checklist", "transition_state", "search_knowledge_base", "search_lessons"];
const SUPABASE_TOOLS = ["execute_sql", "apply_migration", "read_table"];
const GITHUB_TOOLS = ["github_read_file", "github_write_file", "github_edit_file", "github_patch_file", "github_list_files", "github_create_branch", "github_create_pr"];
const DEPLOY_TOOLS = ["deploy_edge_function"];
const WEB_TOOLS = ["web_fetch"];

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
    const allowed = new Set([...SYSTEM_TOOLS, ...SUPABASE_TOOLS]);
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
  switch (toolName) {
    case "execute_sql":
      return handleExecuteSql(toolInput, ctx);
    case "apply_migration":
      return handleApplyMigration(toolInput, ctx);
    case "read_table":
      return handleReadTable(toolInput, ctx);
    case "github_read_file":
      return handleGithubReadFile(toolInput, ctx);
    case "github_write_file":
      return handleGithubWriteFile(toolInput, ctx);
    case "github_edit_file":
      return handleGithubEditFile(toolInput, ctx);
    case "github_patch_file":
      return handleGithubPatchFile(toolInput, ctx);
    case "deploy_edge_function":
      return handleDeployEdgeFunction(toolInput, ctx);
    case "log_progress":
      return handleLogProgress(toolInput, ctx);
    case "read_execution_log":
      return handleReadExecutionLog(toolInput, ctx);
    case "get_schema":
      return handleGetSchema(toolInput, ctx);
    case "mark_complete":
      return handleMarkComplete(toolInput, ctx);
    case "mark_failed":
      return handleMarkFailed(toolInput, ctx);
    case "resolve_qa_findings":
      return handleResolveQaFindings(toolInput, ctx);
    case "update_qa_checklist":
      return handleUpdateQaChecklist(toolInput, ctx);
    case "transition_state":
      return handleTransitionState(toolInput, ctx);
    case "delegate_subtask":
      return handleDelegateSubtask(toolInput, ctx);
    case "check_child_status":
      return handleCheckChildStatus(toolInput, ctx);
    case "web_fetch":
      return handleWebFetch(toolInput, ctx);
    case "github_list_files":
      return handleGithubListFiles(toolInput, ctx);
    case "github_create_branch":
      return handleGithubCreateBranch(toolInput, ctx);
    case "github_create_pr":
      return handleGithubCreatePr(toolInput, ctx);
    case "search_knowledge_base":
      return handleSearchKnowledgeBase(toolInput, ctx);
    case "search_lessons":
      return handleSearchLessons(toolInput, ctx);
    default:
      return { success: false, error: `Unknown tool: ${toolName}` };
  }
}
