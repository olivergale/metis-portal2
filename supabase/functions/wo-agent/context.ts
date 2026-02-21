// wo-agent/context.ts v16
// v16: Phase 11 — CMDB surface injection (discover_surfaces BFS for builder awareness)
// v15: CB-001 proportional budget assembly (all budgets are functions of model context window, zero hardcoded values)
// v14: CB-001 budget-first context assembly (per-component token budgets from model context window)
// v13: MR-004 depth-aware remediation model override (chain_depth → model from system_settings)
// v12: CB-002 fix LitM ordering — directives to Block 1 (beginning), critical lessons to Block 5 (end)
// v11: CTX-004 lesson dedup + CTX-005 Lost-in-the-Middle prompt reordering
// v10: Add custom_instructions injection from agent_execution_profiles, frontend agent rules
// v9: WO-MF-P25 -- pipeline_phase-aware adversarial prompt injection (red-team, blue-team)
// v8: WO-0405 -- per-agent lesson filtering, ROLE_LESSON_CATEGORIES
// v7: WO-0245  --  delegate_subtask + github_edit_file tool descriptions, restored v6 features
// v6: WO-0253  --  use parent_id for remediation context (fallback to parent: tag)
// v5: WO-0252  --  per-agent model selection from agents.model column
// v4: WO-0164  --  tag-filtered directive loading
// v3: WO-0165  --  concurrent WO awareness in agent context
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

import {
  resolveModelSpec,
  loadBudgetRatios,
  computePromptBudget,
  estimateTokens,
  clipToTokenBudget,
  type PromptBudget,
} from "./model-specs.ts";

export interface WorkOrderContext {
  systemPrompt: string;
  userMessage: string;
  agentName: string;
  model: string;
  maxTokens: number;
  budget?: PromptBudget;
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
  pipeline_phase: string | null;
  pipeline_run_id: string | null;
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

  // WO-MF-P26: Escalation tier model override (takes priority over client_info.model)
  if (workOrder.client_info?.escalation_model) {
    agentModel = workOrder.client_info.escalation_model;
  }

  // Load schema context — P2: dynamic WO-aware schema extraction
  let schemaContext = "## Database Schema\nSchema loading failed";
  try {
    const { data } = await supabase.rpc("get_dynamic_schema_context", {
      p_work_order_id: workOrder.id,
    });
    if (data) schemaContext = data;
  } catch {
    // Dynamic schema load failed, try static fallback
    try {
      const { data } = await supabase.rpc("get_schema_context");
      if (data) schemaContext = data;
    } catch {
      // Schema load failed entirely, use fallback
    }
  }

  // Build base system prompt from worker template
  // WO-0164: Pass WO tags for tag-filtered directive loading
  const woTags = workOrder.tags || [];
  let systemPrompt: string;
  const template = await loadWorkerPromptTemplate(supabase);
  if (template) {
    // CB-002: Skip directives/lessons in template — context.ts places them in LitM-optimal positions
    systemPrompt = await buildWorkerPrompt(supabase, template, agentName, schemaContext, woTags, { skipDirectives: true, skipLessons: true });
  } else {
    // Fallback: build minimal prompt
    systemPrompt = await buildFallbackPrompt(supabase, agentName, schemaContext, woTags);
  }

  // CTX-005: Lost-in-the-Middle prompt ordering
  // U-shaped attention: BEGINNING and END get highest model attention.
  // Order: Identity+Profile → Tools+Rules → KB → Memories → Lessons (end)

  // ── CB-002: Load directives and critical lessons early (injected at LitM-optimal positions) ──
  const activeDirectives = await loadActiveDirectives(supabase, woTags);
  const criticalLessons = await loadCriticalLessons(supabase);

  // ── BLOCK 1: Agent Identity & Profile + Directives (BEGINNING — highest attention) ──
  // Load agent execution profile first (needed for identity block)
  let agentProfile: any = null;
  try {
    const { data } = await supabase
      .from("agent_execution_profiles")
      .select("*")
      .eq("agent_name", agentName)
      .single();
    agentProfile = data;
    // WO-0401: Config-driven model selection from profile
    // BUG FIX (CTX-002): Profile model must NOT overwrite escalation_model
    if (agentProfile?.model && !workOrder.client_info?.escalation_model) {
      agentModel = agentProfile.model;
    }
  } catch {
    // Profile not found, continue with defaults
  }

  // MR-004: Depth-aware remediation model override
  // Priority: above agent/profile default, below explicit escalation_model
  // chain_depth is set by spawn_remediation: 1 = first remediation, 2 = last chance
  if ((workOrder.tags || []).includes("remediation") && !workOrder.client_info?.escalation_model) {
    const chainDepth = workOrder.client_info?.chain_depth ?? 1;
    try {
      const { data: rmTiers } = await supabase
        .from('system_settings')
        .select('setting_value')
        .eq('setting_key', 'remediation_model_tiers')
        .single();
      if (rmTiers?.setting_value?.tiers) {
        const tiers = rmTiers.setting_value.tiers as Record<string, string>;
        const maxKey = Math.max(...Object.keys(tiers).map(Number));
        agentModel = tiers[String(Math.min(chainDepth, maxKey))] || 'claude-opus-4-6';
      }
    } catch {
      // Hardcoded fallback: depth 1 → Sonnet, depth 2+ → Opus
      agentModel = chainDepth >= 2 ? 'claude-opus-4-6' : 'claude-sonnet-4-6';
    }
  }

  // CB-001: Resolve model spec from provider APIs + compute proportional budget
  const modelSpec = await resolveModelSpec(agentModel, supabase);
  const budgetRatios = await loadBudgetRatios(supabase);
  const budget = computePromptBudget(modelSpec, budgetRatios);

  // Clip base template to its proportional budget
  systemPrompt = clipToTokenBudget(systemPrompt, budget.components.base_template || budget.promptBudget);

  systemPrompt += `\n\n# AGENTIC EXECUTOR RULES\n\n`;
  systemPrompt += `You are executing work order **${workOrder.slug}** (${workOrder.name}).\n`;
  systemPrompt += `Agent identity: **${agentName}**\n\n`;

  if (agentProfile) {
    let profileBlock = '';
    profileBlock += `## Agent Profile\n`;
    profileBlock += `**Mission**: ${agentProfile.mission}\n`;
    profileBlock += `**Pace**: ${agentProfile.pace} -- `;
    if (agentProfile.pace === "aggressive") {
      profileBlock += `Prioritize speed and iteration velocity. Implement fast, verify incrementally.\n`;
    } else if (agentProfile.pace === "measured") {
      profileBlock += `Balance speed and thoroughness. Plan before executing.\n`;
    } else {
      profileBlock += `Prioritize correctness over speed. Verify before mutating.\n`;
    }
    profileBlock += `**Error Handling**: ${agentProfile.error_style} -- `;
    if (agentProfile.error_style === "retry-then-escalate") {
      profileBlock += `Classify errors (retriable vs non-retriable), retry up to ${agentProfile.escalation_rules?.max_retries || 3}x on retriable errors, escalate non-retriable.\n`;
    } else if (agentProfile.error_style === "fail-fast") {
      profileBlock += `Do not retry on errors. Log and exit immediately for manual review.\n`;
    } else {
      profileBlock += `Log errors but continue execution. Do not block on transient failures.\n`;
    }

    if (agentProfile.budget_guidance) {
      profileBlock += `**Budget Guidance**: Max ${agentProfile.budget_guidance.max_turns || 50} turns. `;
      profileBlock += `Target ${Math.round((agentProfile.budget_guidance.mutation_ratio_target || 0.3) * 100)}% mutation rate. `;
      profileBlock += `Implement-first: ${agentProfile.budget_guidance.implement_first_pct || 80}%, verify: ${agentProfile.budget_guidance.verification_budget_pct || 20}%.\n`;
    }

    if (agentProfile.scope_boundaries) {
      profileBlock += `**Scope Boundaries**: ${agentProfile.scope_boundaries.mutation_scope || "See allowed_tables"}. `;
      const protectedTables = agentProfile.scope_boundaries.protected_tables_via_rpc || [];
      if (protectedTables.length > 0) {
        profileBlock += `Protected tables (use state_write RPC): ${protectedTables.join(", ")}.\n`;
      } else {
        profileBlock += `\n`;
      }
    }

    if (agentProfile.escalation_rules) {
      const escalationTarget = agentProfile.escalation_rules.escalation_target || "ops";
      const escalateOn = agentProfile.escalation_rules.escalate_on || [];
      if (escalateOn.length > 0) {
        profileBlock += `**Escalation**: Escalate to ${escalationTarget} on: ${escalateOn.join(", ")}.\n`;
      }
    }
    profileBlock += `\n`;

    if (agentProfile.custom_instructions) {
      profileBlock += `## Agent-Specific Instructions\n`;
      profileBlock += agentProfile.custom_instructions;
      profileBlock += `\n\n`;
    }

    // CB-001: Clip agent profile to proportional budget
    systemPrompt += clipToTokenBudget(profileBlock, budget.components.agent_profile || budget.promptBudget);
  }

  // ── CB-002: Directives in BEGINNING zone (high attention) ──
  if (activeDirectives.length > 0) {
    let directivesBlock = `# ACTIVE SYSTEM DIRECTIVES\n\n`;
    directivesBlock += `The following directives are currently active and must be followed:\n\n`;
    for (const dir of activeDirectives) {
      directivesBlock += `## ${dir.name} (priority: ${dir.priority}, enforcement: ${dir.enforcement_mode})\n`;
      directivesBlock += `${dir.content}\n\n`;
    }
    // CB-001: Clip directives to proportional budget
    systemPrompt += clipToTokenBudget(directivesBlock, budget.components.directives || budget.promptBudget);
  }

  // ── BLOCK 2: Tools & Execution Rules (BEGINNING -- critical operational info) ──
  const { getToolsForWO } = await import("./tools.ts");
  const availableTools = await getToolsForWO(woTags, supabase, agentName);
  const toolDescriptions: Record<string, string> = {
    execute_sql: "Run SQL queries (SELECT, INSERT, UPDATE, DELETE)",
    apply_migration: "Apply DDL changes (CREATE TABLE, ALTER, etc)",
    read_table: "Read rows from any Supabase table",
    github_read_file: "Read files from GitHub repos",
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
    github_push_files: "Atomic multi-file commit via Git Data API. Preferred for all file changes.",
    github_list_files: "List files in a directory of a GitHub repo",
    github_search_code: "Search code across a GitHub repo by keyword/pattern",
    github_grep: "Grep file contents in a GitHub repo",
    github_read_file_range: "Read specific line range of a file in GitHub",
    github_tree: "Get full file tree of a GitHub repo (recursive listing)",
    search_knowledge_base: "Search the agent knowledge base for patterns, gotchas, and institutional knowledge",
    web_fetch: "Fetch a URL and return its content (for verifying deployed pages)",
    save_memory: "Save a pattern/gotcha/preference to agent memory for future sessions",
    recall_memory: "Recall saved memories relevant to current work",
    run_tests: "Run test suite in sandbox",
    sandbox_write_file: "Write a file into the sandbox for testing/verification",
    sandbox_pipeline: "Run multi-step pipeline in sandbox (build, test, verify)",
  };
  let toolsBlock = `## Available Tools (${availableTools.length} for ${agentName})\n`;
  for (const tool of availableTools) {
    toolsBlock += `- **${tool.name}**: ${toolDescriptions[tool.name] || tool.name}\n`;
  }
  toolsBlock += `\n`;
  toolsBlock += `## Execution Rules\n`;
  toolsBlock += `1. Start by logging your plan with log_progress\n`;
  toolsBlock += `2. Execute the objective step by step\n`;
  toolsBlock += `3. Verify your changes work (query to confirm)\n`;
  toolsBlock += `4. Call mark_complete with a detailed summary when done\n`;
  toolsBlock += `5. Call mark_failed if you cannot complete the objective\n`;
  toolsBlock += `6. You MUST call either mark_complete or mark_failed before finishing\n`;
  toolsBlock += `7. Never make up data -- query first, then act\n`;
  toolsBlock += `8. Log key steps with log_progress so reviewers can see what happened\n`;
  toolsBlock += `9. For file edits, use github_push_files for atomic multi-file commits. Read files first, then push all changes in a single commit.\n`;
  toolsBlock += `10. SELF-VERIFY: After writing/editing files, read back the file to confirm changes applied correctly before marking complete.\n`;

  if (agentName === "frontend") {
    toolsBlock += `\n## Frontend Verification (MANDATORY)\n`;
    toolsBlock += `After writing or editing any .ts/.js/.html/.css file:\n`;
    toolsBlock += `1. Read the file back with github_read_file to confirm changes applied correctly\n`;
    toolsBlock += `2. For TypeScript files: use sandbox_exec with command="npx" args=["tsc", "--noEmit"] to verify compilation\n`;
    toolsBlock += `3. For new pages: verify the HTML file is added to vite.config.ts rollupOptions.input\n`;
    toolsBlock += `4. For new routes: verify vercel.json has the rewrite rule\n`;
    toolsBlock += `5. Use github_search_code to verify new exports/imports are properly connected\n`;
    toolsBlock += `6. After ALL file changes: use sandbox_exec to run "npx vite build" and verify 0 errors\n`;
    toolsBlock += `7. If build fails 3 times: escalate via log_progress, do NOT submit broken code\n`;
    toolsBlock += `8. Commit all related files atomically via github_push_files (NEVER commit files one at a time)\n`;
  }

  if (agentName === "builder") {
    toolsBlock += `\n## Sandbox Verification (MANDATORY for TypeScript/JavaScript)\n`;
    toolsBlock += `After writing or editing any .ts/.js file, you MUST verify it compiles:\n`;
    toolsBlock += `1. Call sandbox_exec with command="deno" args=["check", "<filename>"] and include the file content in files array\n`;
    toolsBlock += `2. If exit_code != 0, fix the errors and re-check (MAXIMUM 3 attempts per file)\n`;
    toolsBlock += `3. If tests exist for the file, run sandbox_exec with command="deno" args=["test", "--no-run", "<test_file>"] to verify test compilation\n`;
    toolsBlock += `4. Only mark the deliverable complete when deno check passes\n`;
    toolsBlock += `5. After 3 failed verification attempts: call request_clarification with the error output -- do NOT submit broken code\n`;
    toolsBlock += `6. Do NOT spawn fix work orders after verification failures -- escalate via request_clarification instead\n`;
  }

  // CB-001: Clip tools block to proportional budget
  systemPrompt += clipToTokenBudget(toolsBlock, budget.components.tools || budget.promptBudget);

  // ── BLOCK 3: Knowledge Base (MIDDLE -- lower attention zone) ──
  const knowledgeBase = await loadKnowledgeBase(supabase, agentName, woTags);
  if (knowledgeBase) {
    // CB-001: Clip KB to proportional budget (largest variable component)
    systemPrompt += `\n\n${clipToTokenBudget(knowledgeBase, budget.components.knowledge_base || budget.promptBudget)}`;
  }

  // ── BLOCK 4: Agent Memories (MIDDLE) ──
  try {
    const { data: memories } = await supabase
      .from("agent_memory")
      .select("key, memory_type, value")
      .eq("agent_id", agentName)
      .order("updated_at", { ascending: false })
      .limit(20);

    if (memories && memories.length > 0) {
      let memoriesBlock = `\n\n## Your Memories\nPatterns and gotchas saved from previous work:\n`;
      for (const mem of memories) {
        memoriesBlock += `- [${mem.memory_type}] ${mem.key}: ${JSON.stringify(mem.value)}\n`;
      }
      // CB-001: Clip memories to proportional budget
      systemPrompt += clipToTokenBudget(memoriesBlock, budget.components.memories || budget.promptBudget);
    }
  } catch {
    // Memory loading failed, non-critical
  }

  // ── BLOCK 5: Critical Lessons + Promoted Lessons (END -- high attention recency zone) ──
  // CB-002: Critical lessons moved here from base template middle zone
  if (criticalLessons.length > 0) {
    let critLessonsBlock = `\n\n# CRITICAL LESSONS LEARNED\n\n`;
    critLessonsBlock += `The following lessons were learned from past failures and MUST be applied:\n\n`;
    for (const lesson of criticalLessons) {
      critLessonsBlock += `## [${lesson.severity.toUpperCase()}] ${lesson.category}: ${lesson.pattern.slice(0, 100)}\n`;
      critLessonsBlock += `**Rule**: ${lesson.rule}\n`;
      if (lesson.example_good) {
        critLessonsBlock += `**Example**: ${lesson.example_good}\n`;
      }
      critLessonsBlock += `\n`;
    }
    // CB-001: Clip critical lessons to proportional budget
    systemPrompt += clipToTokenBudget(critLessonsBlock, budget.components.critical_lessons || budget.promptBudget);
  }

  const ROLE_LESSON_CATEGORIES: Record<string, string[]> = {
    builder: ["execution", "schema_gotcha", "deployment", "rpc_signature", "migration", "scope_creep"],
    "qa-gate": ["qa_pattern", "testing", "acceptance_criteria", "hallucination", "state_consistency"],
    ops: ["operational", "monitoring", "failure_archetype", "execution"],
    security: ["security", "enforcement", "approval_flow"],
    frontend: ["execution", "deployment", "scope_creep", "schema_gotcha", "hallucination", "testing"],
    ilmarinen: ["execution", "schema_gotcha", "deployment", "rpc_signature", "migration", "operational", "scope_creep", "hallucination"],
    "user-portal": ["approval_flow", "scope_creep"],
  };
  try {
    const roleCategories = ROLE_LESSON_CATEGORIES[agentName] || ROLE_LESSON_CATEGORIES["builder"];
    // CTX-004: Exclude critical/high severity -- already loaded by loadCriticalLessons() in worker-prompt.ts
    const { data: promotedLessons } = await supabase
      .from("lessons")
      .select("id, pattern, rule, category, severity")
      .eq("review_status", "approved")
      .not("promoted_at", "is", null)
      .not("severity", "in", "(critical,high)")
      .in("category", roleCategories)
      .order("promoted_at", { ascending: false })
      .limit(10);

    if (promotedLessons && promotedLessons.length > 0) {
      let promLessonsBlock = `\n\n## Lessons From Past Failures\n`;
      for (const lesson of promotedLessons) {
        const ruleSnippet = (lesson.rule || "").slice(0, 200);
        promLessonsBlock += `- [${lesson.category}] ${lesson.pattern}: ${ruleSnippet}\n`;
      }
      // CB-001: Clip promoted lessons to proportional budget
      systemPrompt += clipToTokenBudget(promLessonsBlock, budget.components.promoted_lessons || budget.promptBudget);
    }
  } catch {
    // Lesson loading failed, non-critical
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

  // WO-0739: Load parent context injection from team_context
  // AC: Query matches on metadata->>'target_wo_id' (string comparison with workOrder.id)
  try {
    const { data: parentContext, error: ctxError } = await supabase
      .from('team_context')
      .select('content, author_agent, context_type')
      .filter('metadata->>target_wo_id', 'eq', workOrder.id)
      .order('created_at', { ascending: true })
      .limit(5);
    
    if (!ctxError && parentContext && parentContext.length > 0) {
      userMessage += '\n\n## Parent Context Injection\n';
      for (const ctx of parentContext) {
        userMessage += `From ${ctx.author_agent} (${ctx.context_type}):\n${ctx.content}\n`;
      }
    }
  } catch (ctxErr) {
    // Non-fatal: team_context may be empty or query may fail
  }

  // Phase 11: CMDB surface injection — builder sees dependency graph
  userMessage += await buildCmdbContext(supabase, workOrder, budget);

  // WO-MF-P25: Pipeline-phase aware adversarial prompt injection
  const woPipelinePhase = workOrder.pipeline_phase || "";
  const woTags2 = workOrder.tags || [];
  
  if (woPipelinePhase === "harden") {
    if (woTags2.includes("red-team")) {
      // P7: Enhanced adversarial red-team testing mode
      systemPrompt += `\n\n## RED TEAM: ADVERSARIAL TESTING MODE\n`;
      systemPrompt += `Break this implementation. Your job is to find every failure mode.\n\n`;
      systemPrompt += `1. Execute adversarial SQL queries against all created/modified objects\n`;
      systemPrompt += `2. Test edge cases: NULL inputs, empty strings, maximum-length values, special characters\n`;
      systemPrompt += `3. Check for injection vectors: SQL injection via RPC params, XSS in text fields\n`;
      systemPrompt += `4. Verify RLS policies: test as anon, authenticated, and service_role\n`;
      systemPrompt += `5. Test error handling: invalid UUIDs, non-existent references, constraint violations\n`;
      systemPrompt += `6. Check race conditions: concurrent updates, duplicate inserts\n`;
      systemPrompt += `7. Record EVERY finding as a wo_mutation with success=false and detailed error_detail\n`;
      systemPrompt += `\nYour goal is to find problems, not to fix them. Record findings for the blue-team.\n`;
    } else if (woTags2.includes("blue-team")) {
      // P7: Enhanced defensive blue-team mode
      systemPrompt += `\n\n## BLUE TEAM: DEFENSIVE REMEDIATION MODE\n`;
      systemPrompt += `Review red-team findings from sibling WOs and fix every issue found.\n\n`;
      systemPrompt += `1. Query wo_mutations for sibling red-team WO (same pipeline_run_id, red-team tag) to get findings\n`;
      systemPrompt += `2. For each finding with success=false, create a targeted fix\n`;
      systemPrompt += `3. After each fix, re-run the adversarial test that found the issue\n`;
      systemPrompt += `4. Record each fix as a wo_mutation with success=true\n`;
      systemPrompt += `5. If a fix cannot be applied, record it with success=false and explain why\n`;
      systemPrompt += `\nEvery red-team finding must have a corresponding blue-team response.\n`;
    }
  }

  // MF-FOUND-008: Manifold pipeline context injection
  if (woPipelinePhase || woTags2.includes("manifold-v1")) {
    userMessage += await buildManifoldContext(supabase, workOrder);
  }

  userMessage += `\n---\nExecute this work order now. Start by logging your plan, then proceed step by step.`;

  // CB-001: Clip user message to proportional budget
  userMessage = clipToTokenBudget(userMessage, budget.components.user_message || budget.promptBudget);

  // CB-001: maxTokens from model spec (agent profile can cap lower, but never above model max)
  const maxTokens = Math.min(
    agentProfile?.max_tokens || modelSpec.maxOutput,
    modelSpec.maxOutput
  );

  return { systemPrompt, userMessage, agentName, model: agentModel, maxTokens, budget };
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

  // P2: Schema refresh for remediation — include objects parent WO created/modified
  try {
    const { data: parentSchema } = await supabase.rpc("get_dynamic_schema_context", {
      p_work_order_id: parentWo.id,
    });
    if (parentSchema) {
      ctx += `### Parent Schema Context (objects created/modified)\n`;
      ctx += parentSchema.slice(0, 8000) + `\n\n`;
    }
  } catch {
    // Schema refresh failed, continue without
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
 * MF-FOUND-008: Build manifold pipeline context.
 * Injects pipeline status and ontology summary for manifold-tagged WOs.
 * Kept under 3,000 chars to avoid token bloat.
 */
async function buildManifoldContext(
  supabase: any,
  workOrder: any
): Promise<string> {
  try {
    let ctx = `\n## Manifold Pipeline Context\n`;

    // Get dashboard summary
    const { data: dashboard, error: dashErr } = await supabase.rpc("get_manifold_dashboard");
    if (dashErr || !dashboard) {
      ctx += `(Dashboard unavailable: ${dashErr?.message || "no data"})\n`;
      return ctx;
    }

    // Pipeline runs summary
    const runs = dashboard.pipeline_runs || [];
    if (runs.length > 0) {
      ctx += `### Active Pipelines\n`;
      for (const r of runs.slice(0, 3)) {
        ctx += `- **${r.id.slice(0, 8)}**: phase=${r.current_phase || "none"}, status=${r.status}\n`;
      }
    }

    // Ontology summary
    const ont = dashboard.ontology_summary;
    if (ont) {
      ctx += `### Ontology: ${ont.total_objects} objects, ${ont.objects_with_properties} with props, ${ont.total_links} links\n`;
    }

    // If this WO has a pipeline_run_id, get detail
    if (workOrder.pipeline_run_id) {
      const { data: detail } = await supabase.rpc("get_pipeline_detail", {
        p_pipeline_run_id: workOrder.pipeline_run_id,
      });
      if (detail && !detail.error) {
        ctx += `### This Pipeline Run\n`;
        ctx += `- Phase: ${detail.pipeline?.current_phase || "unknown"}\n`;
        ctx += `- Status: ${detail.pipeline?.status || "unknown"}\n`;
        const phaseWos = detail.phase_wos || {};
        for (const [phase, wos] of Object.entries(phaseWos)) {
          const woList = wos as any[];
          if (woList.length > 0) {
            const statuses = woList.map((w: any) => `${w.slug}:${w.status}`).join(", ");
            ctx += `- ${phase}: ${statuses}\n`;
          }
        }
      }
    }

    ctx += `\n`;
    return ctx;
  } catch {
    return "";
  }
}

/**
 * Phase 11: CMDB surface injection — builder sees dependency graph
 * Extracts key terms from WO objective/name, queries discover_surfaces() BFS,
 * formats as context section capped at 20 surfaces.
 */
async function buildCmdbContext(
  supabase: any,
  workOrder: WorkOrder,
  budget: PromptBudget
): Promise<string> {
  try {
    // Extract function/table/edge-function names from objective + name
    const text = `${workOrder.name || ""} ${workOrder.objective || ""}`;
    const terms = extractCmdbTerms(text);
    if (terms.length === 0) return "";

    // Query discover_surfaces for up to 3 terms
    const allSurfaces: Array<{ depth: number; relationship: string; object_type: string; object_name: string }> = [];
    const seen = new Set<string>();

    for (const term of terms.slice(0, 3)) {
      try {
        const { data, error } = await supabase.rpc("discover_surfaces", {
          p_target: term,
          p_depth: 2,
        });
        if (error || !data?.surfaces) continue;
        for (const s of data.surfaces) {
          const key = `${s.object_type}:${s.object_name}`;
          if (!seen.has(key)) {
            seen.add(key);
            allSurfaces.push(s);
          }
        }
      } catch {
        // Non-fatal: term may not match any object
      }
    }

    if (allSurfaces.length === 0) return "";

    // Cap at 20 surfaces, sorted by depth then name
    const capped = allSurfaces
      .sort((a, b) => a.depth - b.depth || a.object_name.localeCompare(b.object_name))
      .slice(0, 20);

    let section = "\n\n## CMDB Context — Dependency Graph\n";
    section += "Objects related to this work order (from CMDB `discover_surfaces` BFS):\n\n";
    section += "| Depth | Relationship | Type | Name |\n";
    section += "|-------|-------------|------|------|\n";
    for (const s of capped) {
      section += `| ${s.depth} | ${s.relationship} | ${s.object_type} | ${s.object_name} |\n`;
    }
    section += `\nTotal surfaces: ${allSurfaces.length}${allSurfaces.length > 20 ? " (showing top 20)" : ""}\n`;

    // Clip to budget (use knowledge_base budget as proxy — CMDB context is similar in purpose)
    return clipToTokenBudget(section, budget.components.knowledge_base || budget.promptBudget);
  } catch {
    return "";
  }
}

/**
 * Extract function names, table names, and edge function identifiers from text.
 * Returns unique terms suitable for discover_surfaces() queries.
 */
function extractCmdbTerms(text: string): string[] {
  const terms = new Set<string>();

  // Match function calls: word() or word_word()
  const fnPattern = /\b([a-z][a-z0-9_]{2,})\s*\(\)/gi;
  let m;
  while ((m = fnPattern.exec(text)) !== null) {
    terms.add(m[1].toLowerCase());
  }

  // Match backtick-quoted identifiers: `some_name`
  const btPattern = /`([a-z][a-z0-9_]{2,})`/gi;
  while ((m = btPattern.exec(text)) !== null) {
    terms.add(m[1].toLowerCase());
  }

  // Match snake_case identifiers that look like DB objects (3+ chars, has underscore)
  const scPattern = /\b([a-z][a-z0-9]*_[a-z0-9_]{2,})\b/gi;
  while ((m = scPattern.exec(text)) !== null) {
    const candidate = m[1].toLowerCase();
    // Filter out common prose/non-object patterns
    const exclude = new Set([
      "work_order", "work_orders", "auto_start", "auto_approve",
      "this_is", "can_be", "will_be", "should_be", "must_be",
      "end_to", "one_of", "each_of", "all_of", "any_of",
    ]);
    if (!exclude.has(candidate)) {
      terms.add(candidate);
    }
  }

  return Array.from(terms);
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
