// wo-agent/context.ts v8
// v8: WO-0405 — per-agent lesson filtering, ROLE_LESSON_CATEGORIES
// v7: WO-0245 â delegate_subtask + github_edit_file tool descriptions, restored v6 features
// v6: WO-0253 â use parent_id for remediation context (fallback to parent: tag)
// v5: WO-0252 â per-agent model selection from agents.model column
// v4: WO-0164 â tag-filtered directive loading
// v3: WO-0165 â concurrent WO awareness in agent context
// v2: Agent name from DB (builder) instead of generated

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
  model: string;
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
  parent_id: string | null;
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
  let agentModel = "claude-opus-4-6";
  try {
    const { data: assignedAgent } = await supabase
      .from("agents")
      .select("name, model")
      .eq("id", workOrder.assigned_to || "")
      .single();
    if (assignedAgent?.name) agentName = assignedAgent.name;
    if (assignedAgent?.model) agentModel = assignedAgent.model;
  } catch {
    // Fallback to builder
  }

  // WO-0252: Allow WO-level model override via client_info.model
  if (workOrder.client_info?.model) {
    agentModel = workOrder.client_info.model;
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

  // WO-0546: Load agent memories (patterns, gotchas, preferences, facts)
  try {
    const { data: memories } = await supabase
      .from("agent_memory")
      .select("key, memory_type, value")
      .eq("agent_id", agentName)
      .order("updated_at", { ascending: false })
      .limit(20);

    if (memories && memories.length > 0) {
      systemPrompt += `\n\n## Your Memories\nPatterns and gotchas saved from previous work:\n`;
      for (const mem of memories) {
        systemPrompt += `- [${mem.memory_type}] ${mem.key}: ${JSON.stringify(mem.value)}\n`;
      }
    }
  } catch {
    // Memory loading failed, non-critical
  }

  // WO-0405: Load promoted lessons filtered by agent role
  const ROLE_LESSON_CATEGORIES: Record<string, string[]> = {
    builder: ["execution", "schema_gotcha", "deployment", "rpc_signature", "migration", "scope_creep"],
    "qa-gate": ["qa_pattern", "testing", "acceptance_criteria", "hallucination", "state_consistency"],
    ops: ["operational", "monitoring", "failure_archetype", "execution"],
    security: ["security", "enforcement", "approval_flow"],
    frontend: ["execution", "deployment", "scope_creep"],
    ilmarinen: ["execution", "schema_gotcha", "deployment", "rpc_signature", "migration", "operational", "scope_creep", "hallucination"],
    "user-portal": ["approval_flow", "scope_creep"],
  };
  try {
    const roleCategories = ROLE_LESSON_CATEGORIES[agentName] || ROLE_LESSON_CATEGORIES["builder"];
    const { data: promotedLessons } = await supabase
      .from("lessons")
      .select("id, pattern, rule, category, severity")
      .eq("review_status", "approved")
      .not("promoted_at", "is", null)
      .in("category", roleCategories)
      .order("promoted_at", { ascending: false })
      .limit(10);

    if (promotedLessons && promotedLessons.length > 0) {
      systemPrompt += `\n\n## Lessons From Past Failures\n`;
      for (const lesson of promotedLessons) {
        const ruleSnippet = (lesson.rule || "").slice(0, 200);
        systemPrompt += `- [${lesson.category}] ${lesson.pattern}: ${ruleSnippet}\n`;
      }
    }
  } catch {
    // Lesson loading failed, non-critical
  }

  // Load agent execution profile (WO-0380, WO-0401: model from profile)
  let agentProfile: any = null;
  try {
    const { data } = await supabase
      .from("agent_execution_profiles")
      .select("*")
      .eq("agent_name", agentName)
      .single();
    agentProfile = data;
    // WO-0401: Config-driven model selection from profile
    if (agentProfile?.model) {
      agentModel = agentProfile.model;
    }
  } catch {
    // Profile not found, continue with defaults
  }

  // WO-0569: Remediation WOs now route to ilmarinen CLI (configurable via system_settings.remediation_default_agent)
  // Model override removed — remediation handled by CLI session, not server-side API

  // Add agent-specific instructions
  systemPrompt += `\n\n# AGENTIC EXECUTOR RULES\n\n`;
  systemPrompt += `You are executing work order **${workOrder.slug}** (${workOrder.name}).\n`;
  systemPrompt += `Agent identity: **${agentName}**\n\n`;

  // Inject agent profile if available
  if (agentProfile) {
    systemPrompt += `## Agent Profile\n`;
    systemPrompt += `**Mission**: ${agentProfile.mission}\n`;
    systemPrompt += `**Pace**: ${agentProfile.pace} — `;
    if (agentProfile.pace === "aggressive") {
      systemPrompt += `Prioritize speed and iteration velocity. Implement fast, verify incrementally.\n`;
    } else if (agentProfile.pace === "measured") {
      systemPrompt += `Balance speed and thoroughness. Plan before executing.\n`;
    } else {
      systemPrompt += `Prioritize correctness over speed. Verify before mutating.\n`;
    }
    systemPrompt += `**Error Handling**: ${agentProfile.error_style} — `;
    if (agentProfile.error_style === "retry-then-escalate") {
      systemPrompt += `Classify errors (retriable vs non-retriable), retry up to ${agentProfile.escalation_rules?.max_retries || 3}x on retriable errors, escalate non-retriable.\n`;
    } else if (agentProfile.error_style === "fail-fast") {
      systemPrompt += `Do not retry on errors. Log and exit immediately for manual review.\n`;
    } else {
      systemPrompt += `Log errors but continue execution. Do not block on transient failures.\n`;
    }
    
    if (agentProfile.budget_guidance) {
      systemPrompt += `**Budget Guidance**: Max ${agentProfile.budget_guidance.max_turns || 50} turns. `;
      systemPrompt += `Target ${Math.round((agentProfile.budget_guidance.mutation_ratio_target || 0.3) * 100)}% mutation rate. `;
      systemPrompt += `Implement-first: ${agentProfile.budget_guidance.implement_first_pct || 80}%, verify: ${agentProfile.budget_guidance.verification_budget_pct || 20}%.\n`;
    }

    if (agentProfile.scope_boundaries) {
      systemPrompt += `**Scope Boundaries**: ${agentProfile.scope_boundaries.mutation_scope || "See allowed_tables"}. `;
      const protectedTables = agentProfile.scope_boundaries.protected_tables_via_rpc || [];
      if (protectedTables.length > 0) {
        systemPrompt += `Protected tables (use state_write RPC): ${protectedTables.join(", ")}.\n`;
      } else {
        systemPrompt += `\n`;
      }
    }

    if (agentProfile.escalation_rules) {
      const escalationTarget = agentProfile.escalation_rules.escalation_target || "ops";
      const escalateOn = agentProfile.escalation_rules.escalate_on || [];
      if (escalateOn.length > 0) {
        systemPrompt += `**Escalation**: Escalate to ${escalationTarget} on: ${escalateOn.join(", ")}.\n`;
      }
    }
    systemPrompt += `\n`;
  }

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
    deploy_edge_function: "Deploy Supabase Edge Functions (small ones only)",
    log_progress: "Log progress messages",
    read_execution_log: "Read execution logs (useful for remediation)",
    get_schema: "Get database schema reference",
    mark_complete: "Mark WO complete (TERMINAL -- ends execution)",
    mark_failed: "Mark WO failed (TERMINAL -- ends execution)",
    resolve_qa_findings: "Resolve unresolved QA failure findings",
    update_qa_checklist: "Update a QA checklist item status",
    transition_state: "Transition WO status via enforcement RPC",
    delegate_subtask: "Create a child WO with model assignment and dispatch it (always non-blocking)",
    check_child_status: "Check status/summary of a delegated child WO",
    sandbox_exec: "Execute command in sandboxed env (deno check, deno test, grep, etc.) to verify work before submitting",
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
  systemPrompt += `7. Never make up data -- query first, then act\n`;
  systemPrompt += `8. Log key steps with log_progress so reviewers can see what happened\n`;
  systemPrompt += `9. For file edits, prefer github_patch_file (multi-edit, one commit) over github_edit_file (single edit) over github_write_file (full rewrite)\n`;
  systemPrompt += `10. SELF-VERIFY: After writing/editing files, read back the file to confirm changes applied correctly before marking complete. Use github_search_code to verify new exports/functions are reachable.\n`;

  // WO-0553: Mandatory sandbox verification instructions for builder
  if (agentName === "builder") {
    systemPrompt += `\n## Sandbox Verification (MANDATORY for TypeScript/JavaScript)\n`;
    systemPrompt += `After writing or editing any .ts/.js file, you MUST verify it compiles:\n`;
    systemPrompt += `1. Call sandbox_exec with command="deno" args=["check", "<filename>"] and include the file content in files array\n`;
    systemPrompt += `2. If exit_code != 0, fix the errors and re-check (MAXIMUM 3 attempts per file)\n`;
    systemPrompt += `3. If tests exist for the file, run sandbox_exec with command="deno" args=["test", "--no-run", "<test_file>"] to verify test compilation\n`;
    systemPrompt += `4. Only mark the deliverable complete when deno check passes\n`;
    systemPrompt += `5. After 3 failed verification attempts: call request_clarification with the error output -- do NOT submit broken code\n`;
    systemPrompt += `6. Do NOT spawn fix work orders after verification failures -- escalate via request_clarification instead\n`;
  }

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

  return { systemPrompt, userMessage, agentName, model: agentModel };
}

/**
 * Build remediation-specific context: parent WO details, execution history, QA failures
 * WO-0253: Use parent_id first, fall back to parent: tag for backwards compat
 */
async function buildRemediationContext(
  supabase: any,
  workOrder: WorkOrder
): Promise<string> {
  let parentWo: any = null;

  // WO-0253: Use parent_id first
  if (workOrder.parent_id) {
    const { data } = await supabase
      .from("work_orders")
      .select("id, slug, name, objective, acceptance_criteria, summary, qa_checklist, tags")
      .eq("id", workOrder.parent_id)
      .single();
    parentWo = data;
  }

  // Fallback to parent: tag if parent_id not set or lookup failed
  const tags = workOrder.tags || [];
  const parentTag = tags.find((t: string) => t.startsWith("parent:"));

  if (!parentWo && parentTag) {
    const parentSlug = parentTag.replace("parent:", "");
    const { data } = await supabase
      .from("work_orders")
      .select("id, slug, name, objective, acceptance_criteria, summary, qa_checklist, tags")
      .eq("slug", parentSlug)
      .single();
    parentWo = data;
  }

  if (!parentWo) return "";

  let ctx = `## REMEDIATION CONTEXT\n\n`;
  ctx += `This is a **remediation** work order for parent WO **${parentWo.slug}**.\n`;
  ctx += `Fix ONLY the listed failures. Do NOT redo work that already passed.\n\n`;

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
    .select("id, finding_type, description, evidence, checklist_item_id, resolved_at")
    .eq("work_order_id", parentWo.id)
    .eq("finding_type", "fail")
    .is("resolved_at", null)
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

  // Previous remediation attempts -- use parent_id if available, fallback to tag
  let prevRemediationQuery = supabase
    .from("work_orders")
    .select("slug, status, summary")
    .neq("id", workOrder.id)
    .order("created_at", { ascending: false })
    .limit(3);

  if (workOrder.parent_id) {
    prevRemediationQuery = prevRemediationQuery.eq("parent_id", workOrder.parent_id);
  } else {
    prevRemediationQuery = prevRemediationQuery.contains("tags", ["remediation", `parent:${parentWo.slug}`]);
  }
  const { data: prevRemediations } = await prevRemediationQuery;

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
      if (dep.summary) ctx += ` -- ${dep.summary.slice(0, 200)}`;
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
