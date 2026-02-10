// wo-agent/context.ts v4
// Context loading for the agentic work order executor
// Builds comprehensive system prompt with WO details, directives, lessons, schema
// v2: Agent name from DB (builder) instead of generated
// v3: WO-0165 â concurrent WO awareness in agent context
// v4: WO-0164 â tag-filtered directive loading

import {
  loadWorkerPromptTemplate,
  loadActiveDirectives,
  loadCriticalLessons,
  loadSystemContext,
  buildWorkerPrompt,
  generateWorkerAgentName,
  loadKnowledgeBase,
} from "../wo-daemon/worker-prompt.ts";

export interface WorkOrderContext {
  systemPrompt: string;
  userMessage: string;
  agentName: string;
}

interface WorkOrder {
  id: string;
  slug: string;
  name: string;
  objective: string;
  acceptance_criteria: string | null;
  tags: string[] | null;
  priority: string;
  status: string;
  summary: string | null;
  qa_checklist: any[] | null;
  client_info: any | null;
  project_brief_id: string | null;
  depends_on: string[] | null;
  assigned_to: string | null;
}

/**
 * Build the full context for an agentic work order execution.
 * Returns system prompt + first user message.
 */
export async function buildAgentContext(
  supabase: any,
  workOrder: WorkOrder
): Promise<WorkOrderContext> {
  // Look up agent from DB based on assignment, fallback to builder
  let agentName = "builder";
  try {
    const { data: assignedAgent } = await supabase
      .from("agents")
      .select("name")
      .eq("id", workOrder.assigned_to || "")
      .single();
    if (assignedAgent?.name) agentName = assignedAgent.name;
  } catch {
    // Fallback to builder
  }

  // Load schema context
  let schemaContext = "## Database Schema\nSchema loading failed";
  try {
    const { data } = await supabase.rpc("get_schema_context");
    if (data) schemaContext = data;
  } catch {
    // Schema load failed, use fallback
  }

  // Build base system prompt from worker template
  // WO-0164: Pass WO tags for tag-filtered directive loading
  const woTags = workOrder.tags || [];
  let systemPrompt: string;
  const template = await loadWorkerPromptTemplate(supabase);
  if (template) {
    systemPrompt = await buildWorkerPrompt(supabase, template, agentName, schemaContext, woTags);
  } else {
    // Fallback: build minimal prompt
    systemPrompt = await buildFallbackPrompt(supabase, agentName, schemaContext, woTags);
  }

  // Inject institutional knowledge base (filtered by agent role + WO tags)
  const knowledgeBase = await loadKnowledgeBase(supabase, agentName, woTags);
  if (knowledgeBase) {
    systemPrompt += `\n\n${knowledgeBase}`;
  }

  // Add agent-specific instructions
  systemPrompt += `\n\n# AGENTIC EXECUTOR RULES\n\n`;
  systemPrompt += `You are executing work order **${workOrder.slug}** (${workOrder.name}).\n`;
  systemPrompt += `Agent identity: **${agentName}**\n\n`;

  // WO-0166: Dynamic tool list based on agent role
  const { getToolsForWO } = await import("./tools.ts");
  const availableTools = await getToolsForWO(woTags, supabase, agentName);
  const toolDescriptions: Record<string, string> = {
    execute_sql: "Run SQL queries (SELECT, INSERT, UPDATE, DELETE)",
    apply_migration: "Apply DDL changes (CREATE TABLE, ALTER, etc)",
    read_table: "Read rows from any Supabase table",
    github_read_file: "Read files from GitHub repos",
    github_write_file: "Write/update files in GitHub repos (whole file)",
    github_edit_file: "Patch-edit files in GitHub (send only the diff, not whole file)",
    github_list_files: "List files in a GitHub repository directory",
    github_create_branch: "Create a new branch in a GitHub repository",
    github_create_pr: "Create a pull request in a GitHub repository",
    deploy_edge_function: "Deploy Supabase Edge Functions (small ones only)",
    log_progress: "Log progress messages",
    read_execution_log: "Read execution logs (useful for remediation)",
    get_schema: "Get database schema reference",
    mark_complete: "Mark WO complete (TERMINAL â ends execution)",
    mark_failed: "Mark WO failed (TERMINAL â ends execution)",
    resolve_qa_findings: "Resolve unresolved QA failure findings",
    update_qa_checklist: "Update a QA checklist item status",
  };
  systemPrompt += `## Available Tools (${availableTools.length} for ${agentName})\n`;
  for (const tool of availableTools) {
    systemPrompt += `- **${tool.name}**: ${toolDescriptions[tool.name] || tool.name}\n`;
  }
  systemPrompt += `\n`;
  systemPrompt += `## Execution Rules\n`;
  systemPrompt += `1. Start by logging your plan with log_progress\n`;
  systemPrompt += `2. Execute the objective step by step\n`;
  systemPrompt += `3. Verify your changes work (query to confirm)\n`;
  systemPrompt += `4. Call mark_complete with a detailed summary when done\n`;
  systemPrompt += `5. Call mark_failed if you cannot complete the objective\n`;
  systemPrompt += `6. You MUST call either mark_complete or mark_failed before finishing\n`;
  systemPrompt += `7. Never make up data â query first, then act\n`;
  systemPrompt += `8. Log key steps with log_progress so reviewers can see what happened\n`;

  // Build user message with WO details
  let userMessage = `# Work Order: ${workOrder.slug}\n\n`;
  userMessage += `**Name**: ${workOrder.name}\n`;
  userMessage += `**Priority**: ${workOrder.priority}\n`;
  userMessage += `**Status**: ${workOrder.status}\n\n`;
  userMessage += `## Objective\n${workOrder.objective}\n\n`;

  if (workOrder.acceptance_criteria) {
    userMessage += `## Acceptance Criteria\n${workOrder.acceptance_criteria}\n\n`;
  }

  if (workOrder.client_info) {
    userMessage += `## Additional Context\n${JSON.stringify(workOrder.client_info, null, 2).slice(0, 3000)}\n\n`;
  }

  // Check if this is a remediation WO
  const tags = workOrder.tags || [];
  const isRemediation = tags.includes("remediation");

  if (isRemediation) {
    userMessage += await buildRemediationContext(supabase, workOrder);
  }

  // Add related WO context
  if (workOrder.depends_on && workOrder.depends_on.length > 0) {
    userMessage += await buildDependencyContext(supabase, workOrder.depends_on);
  }

  // Add project context
  if (workOrder.project_brief_id) {
    userMessage += await buildProjectContext(supabase, workOrder.project_brief_id);
  }

  // WO-0165: Add concurrent WO awareness
  userMessage += await buildConcurrentWOContext(supabase, workOrder.id);

  userMessage += `\n---\nExecute this work order now. Start by logging your plan, then proceed step by step.`;

  return { systemPrompt, userMessage, agentName };
}

/**
 * Build remediation-specific context: parent WO details, execution history, QA failures
 */
async function buildRemediationContext(
  supabase: any,
  workOrder: WorkOrder
): Promise<string> {
  const tags = workOrder.tags || [];
  const parentTag = tags.find((t: string) => t.startsWith("parent:"));
  if (!parentTag) return "";

  const parentSlug = parentTag.replace("parent:", "");
  let ctx = `## REMEDIATION CONTEXT\n\n`;
  ctx += `This is a **remediation** work order for parent WO **${parentSlug}**.\n`;
  ctx += `Fix ONLY the listed failures. Do NOT redo work that already passed.\n\n`;

  // Load parent WO
  const { data: parentWo } = await supabase
    .from("work_orders")
    .select("id, slug, name, objective, acceptance_criteria, summary, qa_checklist, tags")
    .eq("slug", parentSlug)
    .single();

  if (!parentWo) {
    ctx += `**Warning**: Could not load parent WO ${parentSlug}\n\n`;
    return ctx;
  }

  ctx += `### Parent Work Order: ${parentWo.name}\n`;
  ctx += `**Objective**: ${parentWo.objective}\n\n`;

  if (parentWo.acceptance_criteria) {
    ctx += `**Acceptance Criteria**:\n${parentWo.acceptance_criteria}\n\n`;
  }

  if (parentWo.summary) {
    ctx += `**Previous Summary**: ${parentWo.summary.slice(0, 2000)}\n\n`;
  }

  // Parent QA checklist with pass/fail status
  if (parentWo.qa_checklist && parentWo.qa_checklist.length > 0) {
    ctx += `### QA Checklist Status\n`;
    for (const item of parentWo.qa_checklist) {
      const status = item.status || item.result || "pending";
      ctx += `- [${status}] ${item.criterion || item.description || item.name}\n`;
    }
    ctx += `\n`;
  }

  // Parent QA findings (unresolved failures)
  const { data: findings } = await supabase
    .from("qa_findings")
    .select("id, finding_type, description, evidence, checklist_item_id, resolution_status")
    .eq("work_order_id", parentWo.id)
    .eq("finding_type", "fail")
    .is("resolution_status", null)
    .order("created_at", { ascending: false })
    .limit(10);

  if (findings && findings.length > 0) {
    ctx += `### Unresolved QA Failures (FIX THESE)\n`;
    for (const f of findings) {
      ctx += `- **${f.description}**\n`;
      if (f.evidence) {
        ctx += `  Evidence: ${JSON.stringify(f.evidence).slice(0, 500)}\n`;
      }
    }
    ctx += `\n`;
  }

  // Parent execution log (what was done before)
  const { data: execLogs } = await supabase
    .from("work_order_execution_log")
    .select("phase, agent_name, detail, created_at")
    .eq("work_order_id", parentWo.id)
    .order("created_at", { ascending: false })
    .limit(30);

  if (execLogs && execLogs.length > 0) {
    ctx += `### Parent Execution History (most recent first)\n`;
    for (const log of execLogs.slice(0, 15)) {
      const detail = log.detail || {};
      const toolName = detail.tool_name || detail.event_type || log.phase;
      const content = (detail.content || "").slice(0, 300);
      ctx += `- [${log.phase}] ${toolName}: ${content}\n`;
    }
    ctx += `\n`;
  }

  // Previous remediation attempts
  const { data: prevRemediations } = await supabase
    .from("work_orders")
    .select("slug, status, summary")
    .contains("tags", ["remediation", `parent:${parentSlug}`])
    .neq("id", workOrder.id)
    .order("created_at", { ascending: false })
    .limit(3);

  if (prevRemediations && prevRemediations.length > 0) {
    ctx += `### Previous Remediation Attempts\n`;
    for (const prev of prevRemediations) {
      ctx += `- **${prev.slug}** (${prev.status}): ${(prev.summary || "no summary").slice(0, 300)}\n`;
    }
    ctx += `\nDo NOT repeat what previous attempts tried. Take a different approach.\n\n`;
  }

  return ctx;
}

/**
 * Build context about dependency WOs
 */
async function buildDependencyContext(
  supabase: any,
  dependsOn: string[]
): Promise<string> {
  let ctx = `## Dependencies\n\n`;

  const { data: deps } = await supabase
    .from("work_orders")
    .select("slug, name, status, summary")
    .in("id", dependsOn)
    .limit(5);

  if (deps && deps.length > 0) {
    for (const dep of deps) {
      ctx += `- **${dep.slug}** (${dep.status}): ${dep.name}`;
      if (dep.summary) ctx += ` â ${dep.summary.slice(0, 200)}`;
      ctx += `\n`;
    }
    ctx += `\n`;
  }

  return ctx;
}

/**
 * Build project context
 */
async function buildProjectContext(
  supabase: any,
  projectId: string
): Promise<string> {
  const { data: project } = await supabase
    .from("project_briefs")
    .select("code, title, description, current_phase, architecture_doc, api_doc, prd_doc")
    .eq("id", projectId)
    .single();

  if (!project) return "";

  let ctx = `## Project Context: ${project.title} (${project.code})\n\n`;
  ctx += `**Phase**: ${project.current_phase}\n`;
  if (project.description) ctx += `**Description**: ${project.description.slice(0, 500)}\n`;

  // Include key docs (limited)
  if (project.architecture_doc) {
    ctx += `\n### Architecture\n${project.architecture_doc.slice(0, 2000)}\n`;
  }

  ctx += `\n`;
  return ctx;
}

/**
 * WO-0165: Build concurrent WO awareness context.
 * Shows other in_progress WOs so agent avoids conflicts.
 */
async function buildConcurrentWOContext(
  supabase: any,
  currentWoId: string
): Promise<string> {
  try {
    const { data: concurrent } = await supabase
      .from("work_orders")
      .select("slug, name, tags, assigned_to")
      .eq("status", "in_progress")
      .neq("id", currentWoId)
      .order("started_at", { ascending: false })
      .limit(5);

    if (!concurrent || concurrent.length === 0) return "";

    let ctx = `\n## Concurrent Work Orders (DO NOT conflict with these)\n`;
    for (const wo of concurrent) {
      const agentTag = wo.assigned_to ? ` [agent: ${wo.assigned_to.slice(0, 8)}]` : "";
      const tags = (wo.tags || []).slice(0, 4).join(", ");
      ctx += `- **${wo.slug}**: ${wo.name}${tags ? ` [${tags}]` : ""}${agentTag}\n`;
    }
    ctx += `\nAvoid modifying the same tables, columns, or functions these WOs are working on.\n\n`;
    return ctx;
  } catch {
    return "";
  }
}

/**
 * Fallback prompt when template is not available
 * WO-0164: Accepts woTags for tag-filtered directive loading
 */
async function buildFallbackPrompt(
  supabase: any,
  agentName: string,
  schemaContext: string,
  woTags?: string[]
): Promise<string> {
  let prompt = `# ENDGAME Work Order Agent: ${agentName}\n\n`;
  prompt += `You are an automated work order executor for the ENDGAME-001 system.\n`;
  prompt += `You execute tasks by using the provided tools. Always verify your work.\n\n`;
  prompt += `## Key Rules\n`;
  prompt += `- Use execute_sql for queries, apply_migration for DDL\n`;
  prompt += `- Always verify changes after making them\n`;
  prompt += `- Log progress for observability\n`;
  prompt += `- Call mark_complete or mark_failed when done\n\n`;
  prompt += schemaContext + `\n\n`;

  // Inject knowledge base
  const kb = await loadKnowledgeBase(supabase, agentName, woTags);
  if (kb) prompt += kb + '\n';

  // Still load directives and lessons (filtered by WO tags)
  const directives = await loadActiveDirectives(supabase, woTags);
  if (directives.length > 0) {
    prompt += `# ACTIVE DIRECTIVES\n`;
    for (const dir of directives) {
      prompt += `## ${dir.name}\n${dir.content}\n\n`;
    }
  }

  const lessons = await loadCriticalLessons(supabase);
  if (lessons.length > 0) {
    prompt += `# CRITICAL LESSONS\n`;
    for (const l of lessons) {
      prompt += `- [${l.severity}] ${l.pattern.slice(0, 80)}: ${l.rule}\n`;
    }
    prompt += `\n`;
  }

  return prompt;
}
