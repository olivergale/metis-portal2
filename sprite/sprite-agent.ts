// Sprite Agent — Model-agnostic agent loop for Fly Machine execution
// Runs inside the Sprite container, reads WO context from env vars,
// calls LLM (Anthropic or OpenRouter), executes tools, loops until done.

import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";

// ── ENV ──────────────────────────────────────────────────────────────
const WO_ID = Deno.env.get("WO_ID")!;
const WO_SLUG = Deno.env.get("WO_SLUG")!;
const WO_NAME = Deno.env.get("WO_NAME") || "";
const WO_OBJECTIVE = Deno.env.get("WO_OBJECTIVE")!;
const WO_ACCEPTANCE_CRITERIA = Deno.env.get("WO_ACCEPTANCE_CRITERIA") || "";
const WO_TAGS = JSON.parse(Deno.env.get("WO_TAGS") || "[]") as string[];
const WO_PRIORITY = Deno.env.get("WO_PRIORITY") || "p2_medium";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const GITHUB_TOKEN = Deno.env.get("GITHUB_TOKEN") || "";
const GITHUB_REPO = Deno.env.get("GITHUB_REPO") || "olivergale/metis-portal2";
const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY") || "";
const OPENROUTER_API_KEY = Deno.env.get("OPENROUTER_API_KEY") || "";
const AGENT_MODEL = Deno.env.get("AGENT_MODEL") || "minimax/minimax-m2.5";
const SPRITE_WORK_DIR = Deno.env.get("SPRITE_WORK_DIR") || "/workspace/repo";

const MAX_TURNS = 50;
const MAX_RESULT_CHARS = 10000;

// ── SUPABASE HELPERS ─────────────────────────────────────────────────
const supabase: SupabaseClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

async function supabaseRpc(fn: string, params: Record<string, unknown> = {}): Promise<unknown> {
  const { data, error } = await supabase.rpc(fn, params);
  if (error) throw new Error(`RPC ${fn} failed: ${error.message}`);
  return data;
}

async function supabaseQuery(table: string, select: string, filters: Record<string, unknown> = {}): Promise<unknown[]> {
  let q = supabase.from(table).select(select);
  for (const [k, v] of Object.entries(filters)) {
    q = q.eq(k, v);
  }
  const { data, error } = await q;
  if (error) throw new Error(`Query ${table} failed: ${error.message}`);
  return data || [];
}

async function supabaseInsert(table: string, row: Record<string, unknown>): Promise<void> {
  const { error } = await supabase.from(table).insert(row);
  if (error) console.error(`Insert ${table} failed: ${error.message}`);
}

async function recordMutation(
  toolName: string,
  action: string,
  objectType: string,
  objectId: string,
  success: boolean,
  detail: Record<string, unknown> = {}
): Promise<void> {
  try {
    await supabase.rpc("record_mutation", {
      p_work_order_id: WO_ID,
      p_tool_name: toolName,
      p_action: action,
      p_object_type: objectType,
      p_object_id: objectId,
      p_success: success,
      p_error_class: detail.error_class || null,
      p_error_detail: detail.error ? String(detail.error) : null,
      p_context: detail,
      p_agent_name: "builder",
    });
  } catch (e) {
    console.error(`[mutation] Record failed: ${e}`);
  }
}

async function logExecution(phase: string, detail: Record<string, unknown> = {}): Promise<void> {
  await supabaseInsert("work_order_execution_log", {
    work_order_id: WO_ID,
    agent_name: "builder",
    phase,
    detail,
  });
}

// ── LLM PROVIDERS ────────────────────────────────────────────────────
function isAnthropicModel(model: string): boolean {
  return model.startsWith("claude-");
}

interface LLMMessage {
  role: "user" | "assistant";
  content: string | ContentBlock[];
}

interface ContentBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: string;
}

interface ToolDef {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

async function callAnthropic(
  systemPrompt: string,
  messages: LLMMessage[],
  tools: ToolDef[]
): Promise<{ content: ContentBlock[]; stop_reason: string }> {
  const resp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: AGENT_MODEL,
      max_tokens: 4096,
      system: systemPrompt,
      messages,
      tools,
    }),
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`Anthropic API ${resp.status}: ${errText}`);
  }

  const data = await resp.json();
  return { content: data.content, stop_reason: data.stop_reason };
}

async function callOpenRouter(
  systemPrompt: string,
  messages: LLMMessage[],
  tools: ToolDef[]
): Promise<{ content: ContentBlock[]; stop_reason: string }> {
  // Convert Anthropic-style messages to OpenAI-style
  const openaiMessages: Record<string, unknown>[] = [
    { role: "system", content: systemPrompt },
  ];

  for (const msg of messages) {
    if (typeof msg.content === "string") {
      openaiMessages.push({ role: msg.role, content: msg.content });
    } else {
      // Handle content blocks (tool results, etc.)
      for (const block of msg.content) {
        if (block.type === "text") {
          openaiMessages.push({ role: msg.role, content: block.text });
        } else if (block.type === "tool_use") {
          openaiMessages.push({
            role: "assistant",
            content: null,
            tool_calls: [{
              id: block.id,
              type: "function",
              function: { name: block.name, arguments: JSON.stringify(block.input) },
            }],
          });
        } else if (block.type === "tool_result") {
          openaiMessages.push({
            role: "tool",
            tool_call_id: block.tool_use_id,
            content: typeof block.content === "string" ? block.content : JSON.stringify(block.content),
          });
        }
      }
    }
  }

  // Convert tools to OpenAI format
  const openaiTools = tools.map((t) => ({
    type: "function" as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.input_schema,
    },
  }));

  const resp = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://endgame-sprite.fly.dev",
    },
    body: JSON.stringify({
      model: AGENT_MODEL,
      messages: openaiMessages,
      tools: openaiTools,
      max_tokens: 4096,
    }),
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`OpenRouter API ${resp.status}: ${errText}`);
  }

  const data = await resp.json();
  const choice = data.choices?.[0];
  if (!choice) throw new Error("No choice in OpenRouter response");

  // Convert back to Anthropic-style content blocks
  const blocks: ContentBlock[] = [];

  if (choice.message?.content) {
    blocks.push({ type: "text", text: choice.message.content });
  }

  if (choice.message?.tool_calls) {
    for (const tc of choice.message.tool_calls) {
      blocks.push({
        type: "tool_use",
        id: tc.id,
        name: tc.function.name,
        input: JSON.parse(tc.function.arguments || "{}"),
      });
    }
  }

  const stopReason = choice.finish_reason === "tool_calls" ? "tool_use" : "end_turn";
  return { content: blocks, stop_reason: stopReason };
}

async function callLLM(
  systemPrompt: string,
  messages: LLMMessage[],
  tools: ToolDef[]
): Promise<{ content: ContentBlock[]; stop_reason: string }> {
  if (isAnthropicModel(AGENT_MODEL)) {
    return callAnthropic(systemPrompt, messages, tools);
  }
  return callOpenRouter(systemPrompt, messages, tools);
}

// ── TOOL DEFINITIONS ─────────────────────────────────────────────────
function getToolDefinitions(): ToolDef[] {
  return [
    {
      name: "execute_sql",
      description: "Execute a SQL query against the Supabase database. Use for SELECT, INSERT, UPDATE, DELETE.",
      input_schema: {
        type: "object",
        properties: {
          query: { type: "string", description: "The SQL query to execute" },
        },
        required: ["query"],
      },
    },
    {
      name: "apply_migration",
      description: "Apply a DDL migration (CREATE TABLE, ALTER, etc.). This is recorded and tracked.",
      input_schema: {
        type: "object",
        properties: {
          name: { type: "string", description: "Migration name in snake_case" },
          query: { type: "string", description: "The DDL SQL to apply" },
        },
        required: ["name", "query"],
      },
    },
    {
      name: "github_push_files",
      description: "Push multiple files to GitHub atomically via Git Data API. Each file needs path and content.",
      input_schema: {
        type: "object",
        properties: {
          commit_message: { type: "string", description: "Git commit message" },
          files: {
            type: "array",
            items: {
              type: "object",
              properties: {
                path: { type: "string", description: "File path relative to repo root" },
                content: { type: "string", description: "File content" },
              },
              required: ["path", "content"],
            },
            description: "Files to push",
          },
        },
        required: ["commit_message", "files"],
      },
    },
    {
      name: "sandbox_exec",
      description: "Execute a shell command in the Sprite workspace. Working directory is the WO worktree.",
      input_schema: {
        type: "object",
        properties: {
          command: { type: "string", description: "Shell command to execute" },
          timeout_ms: { type: "number", description: "Timeout in ms (default 30000)" },
        },
        required: ["command"],
      },
    },
    {
      name: "sandbox_read_file",
      description: "Read a file from the Sprite workspace.",
      input_schema: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path (absolute or relative to /workspace)" },
        },
        required: ["path"],
      },
    },
    {
      name: "sandbox_write_file",
      description: "Write content to a file in the Sprite workspace.",
      input_schema: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path (absolute or relative to /workspace)" },
          content: { type: "string", description: "File content to write" },
        },
        required: ["path", "content"],
      },
    },
    {
      name: "sandbox_edit_file",
      description: "Apply a targeted string replacement in a file.",
      input_schema: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path" },
          old_string: { type: "string", description: "Exact string to find" },
          new_string: { type: "string", description: "Replacement string" },
        },
        required: ["path", "old_string", "new_string"],
      },
    },
    {
      name: "sandbox_grep",
      description: "Search for a pattern in files within the workspace.",
      input_schema: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "Regex pattern to search for" },
          path: { type: "string", description: "Directory or file to search (default: /workspace)" },
        },
        required: ["pattern"],
      },
    },
    {
      name: "transition_state",
      description: "Transition the current WO to a new state via wo_transition RPC.",
      input_schema: {
        type: "object",
        properties: {
          event: { type: "string", description: "Transition event name (e.g. submit_for_review, mark_failed)" },
          summary: { type: "string", description: "Optional summary for the transition" },
        },
        required: ["event"],
      },
    },
  ];
}

// ── TOOL EXECUTION ───────────────────────────────────────────────────
function limitResultSize(text: string): string {
  if (text.length > MAX_RESULT_CHARS) {
    return text.substring(0, MAX_RESULT_CHARS) + `\n... [clipped at ${MAX_RESULT_CHARS} chars]`;
  }
  return text;
}

async function executeTool(name: string, input: Record<string, unknown>): Promise<string> {
  try {
    switch (name) {
      case "execute_sql": {
        const query = input.query as string;
        const { data, error } = await supabase.rpc("run_sql", { sql_query: query });
        if (error) {
          await recordMutation("execute_sql", "QUERY", "sql", query.substring(0, 100), false, { error: error.message });
          return `ERROR: ${error.message}`;
        }
        await recordMutation("execute_sql", "QUERY", "sql", query.substring(0, 100), true);
        return limitResultSize(JSON.stringify(data, null, 2));
      }

      case "apply_migration": {
        const migName = input.name as string;
        const query = input.query as string;
        // apply_migration uses run_sql (same RPC, DDL goes through same path)
        const { data, error } = await supabase.rpc("run_sql", { sql_query: query });
        if (error) {
          await recordMutation("apply_migration", "DDL", "migration", migName, false, { error: error.message });
          return `ERROR: ${error.message}`;
        }
        await recordMutation("apply_migration", "DDL", "migration", migName, true);
        return `Migration '${migName}' applied successfully. ${JSON.stringify(data)}`;
      }

      case "github_push_files": {
        const commitMsg = input.commit_message as string;
        const files = input.files as Array<{ path: string; content: string }>;
        const result = await pushToGitHub(commitMsg, files);
        await recordMutation("github_push_files", "PUSH", "github", GITHUB_REPO, result.success, result);
        return result.success ? `Pushed ${files.length} files: ${result.sha}` : `ERROR: ${result.error}`;
      }

      case "sandbox_exec": {
        const command = input.command as string;
        const timeoutMs = (input.timeout_ms as number) || 30000;
        const proc = new Deno.Command("bash", {
          args: ["-c", command],
          cwd: SPRITE_WORK_DIR,
          stdout: "piped",
          stderr: "piped",
        });
        const child = proc.spawn();
        const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
        const output = await child.output();
        clearTimeout(timer);
        const stdout = new TextDecoder().decode(output.stdout);
        const stderr = new TextDecoder().decode(output.stderr);
        const success = output.code === 0;
        await recordMutation("sandbox_exec", "EXEC", "sandbox", command.substring(0, 100), success, { exit_code: output.code });
        return limitResultSize(success ? stdout : `EXIT ${output.code}\nSTDOUT: ${stdout}\nSTDERR: ${stderr}`);
      }

      case "sandbox_read_file": {
        const path = resolvePath(input.path as string);
        const content = await Deno.readTextFile(path);
        await recordMutation("sandbox_read_file", "READ", "sandbox_file", path, true);
        return limitResultSize(content);
      }

      case "sandbox_write_file": {
        const path = resolvePath(input.path as string);
        const content = input.content as string;
        await Deno.mkdir(path.substring(0, path.lastIndexOf("/")), { recursive: true });
        await Deno.writeTextFile(path, content);
        const stat = await Deno.stat(path);
        await recordMutation("sandbox_write_file", "WRITE", "sandbox_file", path, true, { size: stat.size });
        return `Wrote ${stat.size} bytes to ${path}`;
      }

      case "sandbox_edit_file": {
        const path = resolvePath(input.path as string);
        const oldStr = input.old_string as string;
        const newStr = input.new_string as string;
        const content = await Deno.readTextFile(path);
        if (!content.includes(oldStr)) {
          await recordMutation("sandbox_edit_file", "EDIT", "sandbox_file", path, false, { error: "old_string not found" });
          return `ERROR: old_string not found in ${path}`;
        }
        const updated = content.replace(oldStr, newStr);
        await Deno.writeTextFile(path, updated);
        await recordMutation("sandbox_edit_file", "EDIT", "sandbox_file", path, true);
        return `Edited ${path}: replaced ${oldStr.length} chars with ${newStr.length} chars`;
      }

      case "sandbox_grep": {
        const pattern = input.pattern as string;
        const searchPath = resolvePath((input.path as string) || "/workspace");
        const proc = new Deno.Command("grep", {
          args: ["-rn", "--include=*.ts", "--include=*.sql", "--include=*.json", pattern, searchPath],
          stdout: "piped",
          stderr: "piped",
        });
        const output = await proc.output();
        const stdout = new TextDecoder().decode(output.stdout);
        await recordMutation("sandbox_grep", "SEARCH", "sandbox_file", pattern, true);
        return limitResultSize(stdout || "No matches found.");
      }

      case "transition_state": {
        const event = input.event as string;
        const summary = (input.summary as string) || "";
        const payload: Record<string, unknown> = {};
        if (summary) payload.summary = summary;
        const result = await supabase.rpc("wo_transition", {
          p_wo_id: WO_ID,
          p_event: event,
          p_payload: payload,
          p_actor: "builder",
        });
        if (result.error) {
          return `ERROR: ${result.error.message}`;
        }
        return `Transition '${event}' applied. ${JSON.stringify(result.data)}`;
      }

      default:
        return `Unknown tool: ${name}`;
    }
  } catch (e) {
    return `ERROR: ${String(e)}`;
  }
}

function resolvePath(path: string): string {
  if (path.startsWith("/")) return path;
  return `${SPRITE_WORK_DIR}/${path}`;
}

// ── GITHUB PUSH ──────────────────────────────────────────────────────
interface PushResult {
  success: boolean;
  sha?: string;
  error?: string;
}

async function pushToGitHub(
  commitMsg: string,
  files: Array<{ path: string; content: string }>
): Promise<PushResult> {
  const headers = {
    Authorization: `token ${GITHUB_TOKEN}`,
    Accept: "application/vnd.github.v3+json",
    "Content-Type": "application/json",
  };
  const apiBase = `https://api.github.com/repos/${GITHUB_REPO}`;

  try {
    // 1. Get latest commit SHA on main
    const refResp = await fetch(`${apiBase}/git/ref/heads/main`, { headers });
    if (!refResp.ok) throw new Error(`Get ref failed: ${refResp.status}`);
    const refData = await refResp.json();
    const latestSha = refData.object.sha;

    // 2. Get the tree SHA of that commit
    const commitResp = await fetch(`${apiBase}/git/commits/${latestSha}`, { headers });
    const commitData = await commitResp.json();
    const baseTreeSha = commitData.tree.sha;

    // 3. Create blobs for each file
    const treeItems = [];
    for (const file of files) {
      const blobResp = await fetch(`${apiBase}/git/blobs`, {
        method: "POST",
        headers,
        body: JSON.stringify({ content: file.content, encoding: "utf-8" }),
      });
      if (!blobResp.ok) throw new Error(`Blob creation failed for ${file.path}: ${blobResp.status}`);
      const blobData = await blobResp.json();
      treeItems.push({
        path: file.path,
        mode: "100644",
        type: "blob",
        sha: blobData.sha,
      });
    }

    // 4. Create tree
    const treeResp = await fetch(`${apiBase}/git/trees`, {
      method: "POST",
      headers,
      body: JSON.stringify({ base_tree: baseTreeSha, tree: treeItems }),
    });
    if (!treeResp.ok) throw new Error(`Tree creation failed: ${treeResp.status}`);
    const treeData = await treeResp.json();

    // 5. Create commit
    const newCommitResp = await fetch(`${apiBase}/git/commits`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        message: commitMsg,
        tree: treeData.sha,
        parents: [latestSha],
      }),
    });
    if (!newCommitResp.ok) throw new Error(`Commit creation failed: ${newCommitResp.status}`);
    const newCommitData = await newCommitResp.json();

    // 6. Update ref
    const updateResp = await fetch(`${apiBase}/git/refs/heads/main`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ sha: newCommitData.sha }),
    });
    if (!updateResp.ok) throw new Error(`Ref update failed: ${updateResp.status}`);

    return { success: true, sha: newCommitData.sha };
  } catch (e) {
    return { success: false, error: String(e) };
  }
}

// ── SYSTEM PROMPT BUILDER ────────────────────────────────────────────
async function buildSystemPrompt(): Promise<string> {
  const sections: string[] = [];

  // ── 1. IDENTITY & WO CONTEXT (top — highest attention zone) ────────
  sections.push(`You are a builder agent executing work order ${WO_SLUG}.

## Work Order
- **Name**: ${WO_NAME}
- **Objective**: ${WO_OBJECTIVE}
- **Acceptance Criteria**: ${WO_ACCEPTANCE_CRITERIA}
- **Tags**: ${WO_TAGS.join(", ")}
- **Priority**: ${WO_PRIORITY}

## Environment
You are running inside a Fly Machine (Sprite) with direct filesystem access to the repo at ${SPRITE_WORK_DIR}.
You have tools for SQL execution, DDL migrations, GitHub push, and filesystem operations.`);

  // ── 2. EXECUTION RULES (top — critical) ────────────────────────────
  sections.push(`## Execution Rules
1. Complete ALL acceptance criteria before submitting for review.
2. Record every mutation. If a tool call fails, do NOT retry the same approach — try a different strategy.
3. Use sandbox_exec for running tests, checking file sizes, verifying deploys.
4. Use github_push_files for committing code changes (atomic multi-file push). Always read the file first, then push full content.
5. Use apply_migration for DDL changes (CREATE TABLE, ALTER, triggers, functions).
6. Use execute_sql for DML queries (SELECT, INSERT, UPDATE, DELETE).
7. When done, call transition_state with event "submit_for_review" and a summary.
8. If stuck or unable to complete, call transition_state with event "mark_failed" and explain why.
9. NEVER use github_write_file or github_edit_file — they are deprecated. Only github_push_files.
10. After DDL changes: run NOTIFY pgrst, 'reload schema' via execute_sql.
11. For file changes: read the FULL file first (sandbox_read_file), make changes, verify with sandbox_exec (wc -c).`);

  // ── 3. AGENT EXECUTION PROFILE ─────────────────────────────────────
  try {
    const { data: profiles } = await supabase
      .from("agent_execution_profiles")
      .select("mission, error_style, custom_instructions")
      .eq("agent_name", "builder")
      .limit(1);
    if (profiles && profiles.length > 0) {
      const p = profiles[0];
      let profileText = "## Agent Profile\n";
      if (p.mission) profileText += `Mission: ${p.mission}\n`;
      if (p.error_style) profileText += `Error handling: ${p.error_style}\n`;
      if (p.custom_instructions) profileText += `\n${p.custom_instructions}`;
      sections.push(profileText);
    }
  } catch (_e) { /* non-fatal */ }

  // ── 4. KNOWLEDGE BASE (role + tag filtered) ────────────────────────
  try {
    const { data: kb } = await supabase
      .from("agent_knowledge_base")
      .select("category, topic, content, severity, applicable_roles, applicable_tags")
      .eq("active", true);
    if (kb && kb.length > 0) {
      const filtered = kb.filter((e: Record<string, unknown>) => {
        const sev = e.severity as string;
        if (sev !== "critical" && sev !== "high") return false;
        const roles = e.applicable_roles as string[] | null;
        if (roles && roles.length > 0 && !roles.includes("builder")) return false;
        const tags = e.applicable_tags as string[] | null;
        if (tags && tags.length > 0) {
          if (!tags.some((t: string) => WO_TAGS.includes(t))) return false;
        }
        return true;
      });
      if (filtered.length > 0) {
        sections.push("## Schema Knowledge\n" +
          filtered.map((e: Record<string, unknown>) =>
            `- [${e.category}/${e.severity}] ${e.topic}: ${e.content}`
          ).join("\n"));
      }
    }
  } catch (_e) { /* non-fatal */ }

  // ── 5. SYSTEM DIRECTIVES (middle — lower attention OK for soft) ────
  try {
    const { data: directives } = await supabase
      .from("directives")
      .select("name, content, enforcement, enforcement_mode")
      .eq("active", true)
      .order("priority", { ascending: true })
      .limit(30);
    if (directives && directives.length > 0) {
      const hard = directives.filter((d: Record<string, unknown>) =>
        d.enforcement === "hard" || d.enforcement_mode === "hard");
      const soft = directives.filter((d: Record<string, unknown>) =>
        d.enforcement !== "hard" && d.enforcement_mode !== "hard");
      let text = "## System Directives\n";
      if (hard.length > 0) {
        text += "### MANDATORY\n" + hard.map((d: Record<string, unknown>) =>
          `- **${d.name}**: ${d.content}`).join("\n") + "\n";
      }
      if (soft.length > 0) {
        text += "### Advisory\n" + soft.slice(0, 10).map((d: Record<string, unknown>) =>
          `- ${d.name}: ${d.content}`).join("\n");
      }
      sections.push(text);
    }
  } catch (_e) { /* non-fatal */ }

  // ── 6. PROMOTED LESSONS (middle) ───────────────────────────────────
  try {
    const { data: lessons } = await supabase
      .from("lessons")
      .select("pattern, rule, category, severity")
      .eq("review_status", "approved")
      .not("promoted_at", "is", null)
      .in("category", ["schema", "deployment", "testing", "enforcement", "tool_usage", "agent_behavior"])
      .limit(20);
    if (lessons && lessons.length > 0) {
      sections.push("## Learned Lessons\n" +
        lessons.map((l: Record<string, unknown>) =>
          `- [${l.category}] ${l.pattern}: ${l.rule}`
        ).join("\n"));
    }
  } catch (_e) { /* non-fatal */ }

  // ── 7. CONCURRENT WO AWARENESS (middle) ────────────────────────────
  try {
    const { data: concurrent } = await supabase
      .from("work_orders")
      .select("slug, name")
      .eq("status", "in_progress")
      .neq("id", WO_ID)
      .limit(10);
    if (concurrent && concurrent.length > 0) {
      sections.push("## Concurrent Work Orders (avoid conflicts)\n" +
        concurrent.map((w: Record<string, unknown>) => `- ${w.slug}: ${w.name}`).join("\n"));
    }
  } catch (_e) { /* non-fatal */ }

  // ── 8. REMEDIATION CONTEXT (if applicable) ─────────────────────────
  if (WO_TAGS.includes("remediation")) {
    try {
      const { data: thisWO } = await supabase
        .from("work_orders")
        .select("parent_id")
        .eq("id", WO_ID)
        .single();
      if (thisWO?.parent_id) {
        const { data: parentWO } = await supabase
          .from("work_orders")
          .select("slug, name, objective")
          .eq("id", thisWO.parent_id)
          .single();
        const { data: parentMuts } = await supabase
          .from("wo_mutations")
          .select("tool_name, action, object_id, success, error_detail")
          .eq("work_order_id", thisWO.parent_id)
          .order("created_at", { ascending: true });
        if (parentWO && parentMuts) {
          const ok = parentMuts.filter((m: Record<string, unknown>) => m.success);
          const fail = parentMuts.filter((m: Record<string, unknown>) => !m.success);
          let ctx = `## Remediation Context\nRemediating ${parentWO.slug}: ${parentWO.name}\nOriginal objective: ${parentWO.objective}\n`;
          if (ok.length > 0) {
            ctx += "\n### Completed Mutations (DO NOT REDO)\n" +
              ok.map((m: Record<string, unknown>) => `- ${m.tool_name}: ${m.action} on ${m.object_id}`).join("\n") + "\n";
          }
          if (fail.length > 0) {
            ctx += "\n### Failed Mutations (DO NOT RETRY same approach)\n" +
              fail.map((m: Record<string, unknown>) =>
                `- ${m.tool_name}: ${m.action} on ${m.object_id} — ${m.error_detail || "unknown"}`
              ).join("\n") + "\n";
          }
          sections.push(ctx);
        }
      }
    } catch (_e) { /* non-fatal */ }
  }

  // ── 9. CRITICAL GOTCHAS (bottom — high attention zone) ─────────────
  sections.push(`## Critical Gotchas
- work_orders.name NOT title; .created_by is agent_type enum NOT UUID; .priority is enum (p0-p3)
- audit_log columns: target_type/target_id/payload (immutable), event_type NOT NULL
- pgcrypto is in extensions schema: use extensions.digest()
- After DDL changes: NOTIFY pgrst, 'reload schema'
- github_push_files requires FULL file content, not patches. Read file first.
- wo_transition() is the ONLY way to change WO status. Never UPDATE work_orders directly.
- system_settings columns: setting_key/setting_value (NOT key/value)
- ACs must be numbered/bullets format for count_acceptance_criteria() regex`);

  return sections.join("\n\n");
}

// ── MAIN AGENT LOOP ──────────────────────────────────────────────────
async function main() {
  console.log(`[sprite-agent] Starting for ${WO_SLUG} (${WO_ID})`);
  console.log(`[sprite-agent] Model: ${AGENT_MODEL}`);
  console.log(`[sprite-agent] Work dir: ${SPRITE_WORK_DIR}`);

  await logExecution("execution_start", {
    wo_slug: WO_SLUG,
    model: AGENT_MODEL,
    sprite: true,
    machine_id: Deno.env.get("FLY_MACHINE_ID") || "unknown",
  });

  const systemPrompt = await buildSystemPrompt();
  const tools = getToolDefinitions();
  const messages: LLMMessage[] = [
    {
      role: "user",
      content: `Execute the work order. Read the objective and acceptance criteria carefully. Complete all ACs, then submit for review.\n\nObjective: ${WO_OBJECTIVE}\n\nAcceptance Criteria:\n${WO_ACCEPTANCE_CRITERIA}`,
    },
  ];

  let turn = 0;
  let done = false;

  while (turn < MAX_TURNS && !done) {
    turn++;
    console.log(`[sprite-agent] Turn ${turn}/${MAX_TURNS}`);

    try {
      const response = await callLLM(systemPrompt, messages, tools);

      // Check if response has tool calls
      const toolUseBlocks = response.content.filter((b) => b.type === "tool_use");
      const textBlocks = response.content.filter((b) => b.type === "text");

      // Log any text output
      for (const tb of textBlocks) {
        console.log(`[sprite-agent] LLM: ${(tb.text || "").substring(0, 200)}`);
      }

      // Add assistant response to messages
      messages.push({ role: "assistant", content: response.content });

      if (toolUseBlocks.length === 0 || response.stop_reason === "end_turn") {
        // No tool calls — agent is done talking
        console.log("[sprite-agent] Agent finished (no tool calls)");
        done = true;
        break;
      }

      // Execute all tool calls
      const toolResults: ContentBlock[] = [];
      for (const toolBlock of toolUseBlocks) {
        console.log(`[sprite-agent] Tool: ${toolBlock.name}(${JSON.stringify(toolBlock.input).substring(0, 100)})`);
        const result = await executeTool(toolBlock.name!, toolBlock.input!);
        console.log(`[sprite-agent] Result: ${result.substring(0, 200)}`);

        toolResults.push({
          type: "tool_result",
          tool_use_id: toolBlock.id,
          content: result,
        });

        // Check if this was a terminal transition
        if (toolBlock.name === "transition_state") {
          const event = (toolBlock.input as Record<string, string>).event;
          if (event === "submit_for_review" || event === "mark_failed") {
            console.log(`[sprite-agent] Terminal transition: ${event}`);
            done = true;
          }
        }
      }

      // Add tool results to messages
      messages.push({ role: "user", content: toolResults });

    } catch (e) {
      console.error(`[sprite-agent] Turn ${turn} error: ${e}`);
      await logExecution("failed", { turn, error: String(e) });

      // If LLM call fails, retry once then bail
      if (turn > 2) {
        console.error("[sprite-agent] Too many errors, marking failed");
        try {
          await supabase.rpc("wo_transition", {
            p_wo_id: WO_ID,
            p_event: "mark_failed",
            p_payload: { failure_reason: `Agent error at turn ${turn}: ${String(e)}` },
            p_actor: "builder",
          });
        } catch (_) {
          // Best effort
        }
        done = true;
      }
    }
  }

  if (!done) {
    console.log(`[sprite-agent] Hit MAX_TURNS (${MAX_TURNS}) without terminal transition`);
    await logExecution("failed", { reason: "max_turns_exceeded", turns: MAX_TURNS });
    try {
      await supabase.rpc("wo_transition", {
        p_wo_id: WO_ID,
        p_event: "mark_failed",
        p_payload: { failure_reason: `Agent exhausted ${MAX_TURNS} turns without completing` },
        p_actor: "builder",
      });
    } catch (_) {
      // Best effort
    }
  }

  await logExecution("execution_complete", { turns: turn, model: AGENT_MODEL });
  console.log(`[sprite-agent] Done after ${turn} turns`);
}

// Run
main().catch((e) => {
  console.error(`[sprite-agent] Fatal: ${e}`);
  Deno.exit(1);
});
