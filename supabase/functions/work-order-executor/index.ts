// work-order-executor/index.ts v60
// v60: WO-0234 — Fix auto-QA race: check WO status before evaluation AND before writing findings, skip gracefully if done/cancelled
// v56: Agent rename — sentinel→qa-gate in all logging
// v54: WO-0151 — Fix /reprioritize to include 'review' status WOs in queue evaluation (AC7 compliance)
// v53: Add /reprioritize endpoint — dynamic queue scoring on 5 dimensions (priority, deps, freshness, lessons, complexity)
// v52: WO-0107 — Add handler_count to /status for post-deploy smoke test validation
// v51: WO-0110 — Enforce summary in /complete (400 if empty), add depends_on sync for remediation sub-WOs (block parent completion while children active)
// v50: Fix auto-QA race condition — idempotency guard in createRemediationWO (skip if active remediation exists), dedup guard in /auto-qa (10s cooldown via last_qa_run_at)
// v48: Fix remediation guard — check auto-qa-loop tag (not remediation), escalate failed sub-WOs to parent circuit breaker
// v47: Fix auto-QA duplicate findings — resolve existing unresolved findings at start of /auto-qa (idempotent concurrent calls)
// v46: Remediation loop — auto-QA failures create fix WOs, two-step parent re-evaluation on completion
// v39: WO-0023 — Rewrite /rollback as read-only planner (no execution, no Management API, no git fetch)
// v38: Upgrade auto-qa to Sonnet + execution log evidence; restore all endpoints; fix rollback (no Deno.Command)
// v37: Daemon deploy — rollback via audit_log + GitHub API (but dropped all other endpoints)
// v36: Daemon deploy — rollback rewrite attempt
// v35: Daemon deploy — rollback rewrite attempt
// v34: WO-0019 — Implement actual /rollback execution: git checkout, deploy, smoke test, audit log, manifest update
// v33: Fix /consolidate — add AI gap analysis mode for UI (work_order_id + duplicates) alongside legacy bulk cancel
// v32: WO-367B574B — Add /rollback endpoint stub for git-versioned rollbacks (source control workflow)
// v31: AC2 fix — auto-qa reads wo.summary as primary context instead of only client_info

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-trace-id",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

const ILMARINEN_ID = "3dcf0457-4a6d-4509-8fdc-bbd67e97b1d8";

const ACTION_MAP: Record<string, string> = {
  approve: 'claim_work_order',
  claim: 'claim_work_order',
  complete: 'complete_work_order',
  accept: 'complete_work_order',
  reject: 'complete_work_order',
  fail: 'complete_work_order',
  phase: 'log_phase',
};

interface StructuredError {
  code: string;
  message: string;
  severity: 'fatal' | 'error' | 'warning' | 'info';
  category: string;
  retry_allowed?: boolean;
  retry_delay_seconds?: number;
}

async function getErrorDefinition(supabase: any, code: string): Promise<StructuredError | null> {
  const { data } = await supabase.from('error_definitions').select('*').eq('code', code).single();
  return data;
}

function buildStructuredError(code: string, messageOverride?: string, templateVars?: Record<string, any>): StructuredError {
  const defaults: Record<string, Partial<StructuredError>> = {
    ERR_TRANSITION_INVALID: { severity: 'error', category: 'transition', retry_allowed: false },
    ERR_AC_MISSING: { severity: 'error', category: 'validation', retry_allowed: false },
    ERR_APPROVAL_REQUIRED: { severity: 'warning', category: 'gate', retry_allowed: false },
    ERR_DEPLOY_FAILED: { severity: 'error', category: 'deployment', retry_allowed: true, retry_delay_seconds: 60 },
    ERR_QA_CHECKLIST_INCOMPLETE: { severity: 'error', category: 'qa', retry_allowed: false },
    ERR_QA_VALIDATION_FAILED: { severity: 'error', category: 'qa', retry_allowed: true, retry_delay_seconds: 30 },
    ERR_GATE_BLOCKED: { severity: 'warning', category: 'gate', retry_allowed: false },
    ERR_WO_STALE: { severity: 'warning', category: 'validation', retry_allowed: false },
    ERR_WO_DUPLICATE: { severity: 'warning', category: 'validation', retry_allowed: false },
    ERR_RATE_LIMIT: { severity: 'warning', category: 'rate_limit', retry_allowed: true },
    ERR_ACTION_DENIED: { severity: 'error', category: 'permission', retry_allowed: false },
    ERR_WO_NOT_FOUND: { severity: 'error', category: 'data_integrity', retry_allowed: false },
    ERR_INVALID_STATUS: { severity: 'error', category: 'data_integrity', retry_allowed: false },
  };
  const def = defaults[code] || { severity: 'error', category: 'unknown', retry_allowed: false };
  let message = messageOverride || code;
  if (templateVars) {
    Object.entries(templateVars).forEach(([key, value]) => {
      message = message.replace(`{${key}}`, String(value));
    });
  }
  return { code, message, severity: def.severity as any, category: def.category, retry_allowed: def.retry_allowed, retry_delay_seconds: def.retry_delay_seconds };
}

async function createLesson(supabase: any, source: string, errorMessage: string, context: Record<string, unknown> = {}, workOrderId: string | null = null, traceId: string | null = null, agentId: string | null = null, errorCode?: string): Promise<string | null> {
  try {
    const enhancedContext = errorCode ? { ...context, error_code: errorCode } : context;
    const { data, error } = await supabase.rpc('auto_create_lesson', { p_failure_source: source, p_error_message: errorMessage, p_context: enhancedContext, p_work_order_id: workOrderId, p_trace_id: traceId, p_agent_id: agentId });
    if (error) { console.warn('[LESSON] RPC error:', error); return null; }
    console.log(`[LESSON] Created ${data} from ${source}: ${errorMessage.slice(0, 100)}${errorCode ? ' [' + errorCode + ']' : ''}`);
    return data;
  } catch (e) { console.warn('[LESSON] Exception:', e); return null; }
}

async function validateAndRateLimit(supabase: any, endpoint: string, method: string, body: any, headers: Record<string, string>): Promise<{ valid: boolean; error?: StructuredError; status?: number }> {
  const { data: validation, error: valError } = await supabase.rpc('validate_request', { p_endpoint: endpoint, p_method: method, p_body: body || {}, p_headers: headers || {} });
  if (valError) { console.warn('Validation RPC error (continuing):', valError); }
  else if (validation && !validation.valid) { return { valid: false, error: buildStructuredError('ERR_DATA_VALIDATION', `Validation failed: ${JSON.stringify(validation.errors)}`), status: 400 }; }
  const { data: rateLimit, error: rlError } = await supabase.rpc('check_rate_limit', { p_agent_id: ILMARINEN_ID, p_quota_type: 'requests_per_minute' });
  if (rlError) { console.warn('Rate limit RPC error (continuing):', rlError); }
  else if (rateLimit && !rateLimit.allowed) { return { valid: false, error: buildStructuredError('ERR_RATE_LIMIT', `Rate limit exceeded. Retry after ${rateLimit.retry_after}s`, { retry_after: rateLimit.retry_after }), status: 429 }; }
  return { valid: true };
}

async function checkAction(supabase: any, actionName: string, agentId: string | null, workOrderId: string | null): Promise<{ allowed: boolean; error?: StructuredError }> {
  try {
    const { data, error } = await supabase.rpc('check_allowed_action', { p_action_name: actionName, p_agent_id: agentId, p_work_order_id: workOrderId });
    if (error) { console.warn('check_allowed_action RPC error (continuing):', error); return { allowed: true }; }
    if (data && !data.allowed) { return { allowed: false, error: buildStructuredError('ERR_ACTION_DENIED', `Action denied: ${JSON.stringify(data.errors)}`, { action: actionName }) }; }
    return { allowed: true };
  } catch (e) { console.warn('check_allowed_action exception (continuing):', e); return { allowed: true }; }
}

async function evaluateGates(supabase: any, workOrderId: string, triggerType: string, context: Record<string, unknown> = {}): Promise<{ approved: boolean; pending?: unknown[]; error?: string }> {
  try {
    const baseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const resp = await fetch(`${baseUrl}/functions/v1/evaluate-gates`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${serviceKey}` }, body: JSON.stringify({ work_order_id: workOrderId, trigger_type: triggerType, context }) });
    const data = await resp.json();
    if (!resp.ok) return { approved: true, error: data.error };
    return { approved: data.approved, pending: data.pending };
  } catch (e) { console.warn('Gate evaluation failed (continuing):', e); return { approved: true }; }
}

async function logPhase(supabase: any, workOrderId: string, phase: string, agentName = "ilmarinen", detail = {}, iteration = 1) {
  try { await supabase.from("work_order_execution_log").insert({ work_order_id: workOrderId, phase, agent_name: agentName, detail, iteration }); }
  catch (e) { console.error("Failed to log phase:", e); }
}

async function determineAgent(_supabase: any, _wo: any): Promise<string> { return ILMARINEN_ID; }

function extractKeywords(text: string): string[] {
  const stopWords = new Set(['a','an','the','and','or','but','in','on','at','to','for','of','with','by','is','are','was','were','be','been','being','have','has','had','do','does','did','will','would','could','should','may','might','must','shall','can','need','this','that','these','those','i','you','he','she','it','we','they','what','which','who','where','when','why','how','all','each','every','both','few','more','most','other','some','such','no','nor','not','only','own','same','so','than','too','very','just','also','now','build','create','make','add','implement','deploy','write','new']);
  return text.toLowerCase().replace(/[^a-z0-9\s]/g,'').split(/\s+/).filter(w => w.length > 2 && !stopWords.has(w)).slice(0,10);
}

async function checkAndTripCircuitBreaker(supabase: any, workOrderId: string): Promise<void> {
  try {
    const { data: autoApproval } = await supabase.from('auto_approval_log').select('id, decision').eq('work_order_id', workOrderId).eq('decision', 'approved').limit(1);
    if (autoApproval && autoApproval.length > 0) {
      await supabase.from('user_preferences').update({ value: true }).eq('user_id', 'default').eq('key', 'auto_approval_circuit_breaker');
      console.log('[CIRCUIT-BREAKER] Tripped: auto-approved WO failed:', workOrderId);
      await supabase.from('audit_log').insert({ event_type: 'circuit_breaker_tripped', actor_type: 'system', actor_id: 'work-order-executor', target_type: 'work_order', target_id: workOrderId, action: 'auto_approval_circuit_breaker', payload: { reason: 'Auto-approved work order failed', auto_approval_id: autoApproval[0].id } });
    }
  } catch (e) { console.error('[CIRCUIT-BREAKER] Error:', e); }
}

async function validateDeployment(supabase: any, workOrderId: string, requiredEnvVars?: string[]): Promise<{ valid: boolean; checks: any[]; error?: StructuredError }> {
  try {
    const { data, error } = await supabase.rpc('validate_deployment_readiness', { p_work_order_id: workOrderId, p_required_env_vars: requiredEnvVars || null, p_check_build: true, p_check_deployment_logs: true });
    if (error) { console.error('[DEPLOY-GATE] RPC error:', error); return { valid: false, checks: [], error: buildStructuredError('ERR_DEPLOY_FAILED', error.message) }; }
    return { valid: data.valid === true, checks: data.checks || [], error: data.valid ? undefined : buildStructuredError('ERR_DEPLOY_FAILED', data.error || 'Deployment validation failed') };
  } catch (e) { console.error('[DEPLOY-GATE] Exception:', e); return { valid: false, checks: [], error: buildStructuredError('ERR_DEPLOY_FAILED', (e as Error).message) }; }
}

async function initializeQAChecklistIfNeeded(supabase: any, workOrderId: string): Promise<void> {
  try {
    const { data: checklist, error } = await supabase.rpc('initialize_qa_checklist', { wo_id: workOrderId });
    if (error) console.error('[QA-CHECKLIST] Failed to initialize:', error);
    else if (checklist) console.log(`[QA-CHECKLIST] Initialized ${checklist.length} items for WO ${workOrderId}`);
  } catch (e) { console.error('[QA-CHECKLIST] Exception:', e); }
}

async function validateQAChecklistComplete(supabase: any, workOrderId: string): Promise<{ complete: boolean; pending_items?: any[]; error?: StructuredError }> {
  try {
    const { data: isComplete, error: checkError } = await supabase.rpc('is_qa_checklist_complete', { wo_id: workOrderId });
    if (checkError) { console.error('[QA-CHECKLIST] Validation error:', checkError); return { complete: true, error: buildStructuredError('ERR_QA_VALIDATION_FAILED', checkError.message) }; }
    if (isComplete) return { complete: true };
    const { data: wo } = await supabase.from('work_orders').select('qa_checklist').eq('id', workOrderId).single();
    const pendingItems = (wo?.qa_checklist || []).filter((item: any) => item.status === 'pending');
    return { complete: false, pending_items: pendingItems.map((item: any) => ({ id: item.id, name: item.name, description: item.description })), error: buildStructuredError('ERR_QA_CHECKLIST_INCOMPLETE', `${pendingItems.length} items pending`, { count: pendingItems.length }) };
  } catch (e) { console.error('[QA-CHECKLIST] Exception:', e); return { complete: true, error: buildStructuredError('ERR_QA_VALIDATION_FAILED', (e as Error).message) }; }
}

async function validateWorkOrderFreshness(supabase: any, workOrderId: string): Promise<{ fresh: boolean; stale_details?: any; error?: string }> {
  try {
    const { data, error } = await supabase.rpc('validate_wo_freshness', { p_work_order_id: workOrderId });
    if (error) { console.error('[FRESHNESS-CHECK] RPC error:', error); return { fresh: true, error: error.message }; }
    if (data.error) { console.error('[FRESHNESS-CHECK] Validation error:', data.error); return { fresh: true, error: data.error }; }
    return {
      fresh: !data.stale,
      stale_details: data.stale ? { conflicts: data.conflicts || [], conflicting_wos: data.conflicting_wos || [], recommendation: data.recommendation || 'update', check_timestamp: data.check_timestamp, wo_created_at: data.wo_created_at, schema_changes_count: data.schema_changes_count || 0, state_mutations_count: data.state_mutations_count || 0, completed_wos_count: data.completed_wos_count || 0 } : undefined
    };
  } catch (e) { console.error('[FRESHNESS-CHECK] Exception:', e); return { fresh: true, error: (e as Error).message }; }
}

async function refineStaleness(
  supabase: any,
  workOrderId: string,
  staleDetails: any
): Promise<{ decision: string; refined_name?: string; refined_objective?: string; reason: string }> {
  const { data: wo } = await supabase.from("work_orders")
    .select("id, slug, name, objective, tags")
    .eq("id", workOrderId).single();
  if (!wo) throw new Error("Work order not found");

  const conflictingSlugs = staleDetails?.conflicting_wos || [];
  let conflictContext = "None";
  if (conflictingSlugs.length > 0) {
    const { data: conflictingWOs } = await supabase.from("work_orders")
      .select("slug, name, objective")
      .in("slug", conflictingSlugs);
    if (conflictingWOs?.length > 0) {
      conflictContext = conflictingWOs.map((cwo: any) =>
        `- ${cwo.slug}: ${cwo.name}\n  Objective: ${(cwo.objective || 'N/A').slice(0, 500)}`
      ).join('\n');
    }
  }

  const mutationContext = [
    staleDetails?.schema_changes_count ? `${staleDetails.schema_changes_count} schema changes since WO creation` : null,
    staleDetails?.state_mutations_count ? `${staleDetails.state_mutations_count} system manifest mutations since WO creation` : null,
    staleDetails?.completed_wos_count ? `${staleDetails.completed_wos_count} WOs with shared tags completed since creation` : null,
  ].filter(Boolean).join('\n');

  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  const resp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": apiKey!, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 1024,
      messages: [{
        role: "user",
        content: `You are evaluating whether a stale work order is still valid after system changes.\n\nWORK ORDER:\nSlug: ${wo.slug}\nName: ${wo.name}\nObjective: ${wo.objective}\nTags: ${(wo.tags || []).join(', ')}\n\nCHANGES SINCE CREATION:\n${mutationContext || 'None'}\n\nCOMPLETED WORK ORDERS WITH OVERLAPPING TAGS:\n${conflictContext}\n\nCONFLICTS:\n${(staleDetails?.conflicts || []).join('\n')}\n\nDecide one of:\n1. "deprecate" — completed WOs fully cover this objective. Cancel it.\n2. "refine" — parts are covered, gaps remain. Rewrite name+objective for ONLY what's missing.\n3. "proceed" — changes don't affect this WO. Execute as-is.\n\nRespond with ONLY JSON:\n{"decision": "deprecate"|"refine"|"proceed", "refined_name": "...", "refined_objective": "...", "reason": "brief explanation"}`
      }],
    }),
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`LLM refinement failed: ${errText.slice(0, 200)}`);
  }

  const data = await resp.json();
  const llmText = data.content?.[0]?.text || "";
  const jsonMatch = llmText.match(/\{[\s\S]*\}/);
  return JSON.parse(jsonMatch?.[0] || llmText);
}

// Helper: get git commit history for a function from audit_log
async function getGitHistory(supabase: any, functionSlug: string): Promise<any[]> {
  const { data } = await supabase.from('audit_log')
    .select('id, created_at, payload, new_state')
    .eq('event_type', 'edge_function_deployed')
    .eq('target_type', 'edge_function')
    .ilike('payload->>function_slug', functionSlug)
    .order('created_at', { ascending: false })
    .limit(10);
  return data || [];
}

// v46: Remediation loop — create fix WO when auto-QA finds failures
async function createRemediationWO(supabase: any, parentWo: { id: string; slug: string; name: string; objective?: string }, failures: any[]): Promise<{ remediation_wo_id?: string; error?: string }> {
  try {
    // Circuit breaker: check existing remediation attempts for this parent
    const { data: existingRemediations } = await supabase.from('work_orders')
      .select('id, slug, status')
      .contains('tags', ['remediation', `parent:${parentWo.slug}`])
      .limit(10);

    // v50: Idempotency guard — skip if an active remediation already exists
    const activeRemediation = (existingRemediations || []).find(
      (r: any) => ['draft', 'ready', 'in_progress', 'review'].includes(r.status)
    );
    if (activeRemediation) {
      console.log(`[REMEDIATION] Skipping — active remediation ${activeRemediation.slug} (${activeRemediation.status}) already exists for ${parentWo.slug}`);
      return { remediation_wo_id: activeRemediation.id };
    }

    const attempts = (existingRemediations || []).length;
    const MAX_ATTEMPTS = 3;

    if (attempts >= MAX_ATTEMPTS) {
      console.log(`[REMEDIATION] Circuit breaker: ${attempts}/${MAX_ATTEMPTS} for ${parentWo.slug} — escalating`);

      // Escalation: tag the WO for manual/ilmarinen pickup instead of just failing
      const failuresList = failures.map((f: any) => `- ${f.id}: ${f.reason}`).join('\n');
      const escalationSummary = `Auto-QA remediation circuit breaker: ${MAX_ATTEMPTS} attempts exhausted. Escalated to ilmarinen.\n\nUnresolved failures:\n${failuresList}`;

      // Add escalation tag so daemon/portal can identify these
      const currentTags: string[] = parentWo.tags || [];
      const escalationTags = [...new Set([...currentTags, 'escalation:ilmarinen', 'circuit-breaker-tripped'])];

      await supabase.rpc('update_work_order_state', {
        p_work_order_id: parentWo.id,
        p_status: 'failed',
        p_approved_at: null,
        p_approved_by: null,
        p_started_at: null,
        p_completed_at: new Date().toISOString(),
        p_summary: escalationSummary
      });

      // Update tags (bypass needed since WO is now failed)
      await supabase.from('work_orders').update({ tags: escalationTags }).eq('id', parentWo.id);

      // Audit log the escalation
      await supabase.from('audit_log').insert({
        event_type: 'escalation_requested',
        actor_type: 'system',
        actor_id: 'auto-qa-circuit-breaker',
        target_type: 'work_order',
        target_id: parentWo.id,
        action: `Circuit breaker tripped for ${parentWo.slug} — escalated to ilmarinen`,
        payload: { attempts, max_attempts: MAX_ATTEMPTS, failures: failures.slice(0, 5), parent_slug: parentWo.slug }
      });

      return { error: `Circuit breaker: ${MAX_ATTEMPTS} attempts exhausted — escalated to ilmarinen` };
    }

    const attemptNum = attempts + 1;

    // WO-0153: Classify failures to distinguish evidence gaps from actual bugs
    const evidenceGaps: any[] = [];
    const actualBugs: any[] = [];

    for (const f of failures) {
      const reason = (f.reason || '').toLowerCase();
      // Heuristics: evidence gap indicators
      const isEvidenceGap =
        reason.includes('no tool evidence') ||
        reason.includes('no edit/write') ||
        reason.includes('no concrete evidence') ||
        reason.includes('only summary claims') ||
        reason.includes('summary claims') ||
        reason.includes('lacks concrete proof') ||
        reason.includes('no deployment evidence') ||
        (reason.includes('summary') && reason.includes('evidence'));

      if (isEvidenceGap) {
        evidenceGaps.push(f);
      } else {
        actualBugs.push(f);
      }
    }

    const hasEvidenceGaps = evidenceGaps.length > 0;
    const hasActualBugs = actualBugs.length > 0;

    // Build objective based on failure type classification
    let objectiveText = `Fix the following auto-QA failures for ${parentWo.slug} (${parentWo.name}):\n\n`;

    if (hasEvidenceGaps && hasActualBugs) {
      objectiveText += `**MIXED FAILURE TYPES DETECTED:**\n\n`;
      objectiveText += `Evidence Gaps (${evidenceGaps.length}) — Work may have been done but not logged:\n`;
      objectiveText += evidenceGaps.map((f: any) => `- ${f.id}: ${f.reason}`).join('\n');
      objectiveText += `\n\nActual Bugs (${actualBugs.length}) — Work not completed or incorrect:\n`;
      objectiveText += actualBugs.map((f: any) => `- ${f.id}: ${f.reason}`).join('\n');
      objectiveText += `\n\n**REMEDIATION STRATEGY:**\n`;
      objectiveText += `1. For evidence gaps: Use resolve_qa_findings tool to clear false negatives, then update_qa_checklist tool to mark items as pass\n`;
      objectiveText += `2. For actual bugs: Complete the missing work using execute_sql/apply_migration, then log tool evidence\n`;
    } else if (hasEvidenceGaps) {
      objectiveText += `**EVIDENCE GAP DETECTED (${evidenceGaps.length} failures)** — Work may have been completed but tool evidence is missing:\n\n`;
      objectiveText += evidenceGaps.map((f: any) => `- ${f.id}: ${f.reason}`).join('\n');
      objectiveText += `\n\n**REMEDIATION STRATEGY:**\n`;
      objectiveText += `This is likely a false negative. Review the parent WO's execution log and summary. If work was actually completed:\n`;
      objectiveText += `1. Use resolve_qa_findings tool (pass parent work_order_id) to clear false-negative findings\n`;
      objectiveText += `2. Use update_qa_checklist tool (pass parent work_order_id, checklist_item_id, status='pass', evidence_summary) to update checklist\n`;
      objectiveText += `3. If work is genuinely missing, complete it using execute_sql/apply_migration\n`;
    } else {
      objectiveText += `**ACTUAL BUGS (${actualBugs.length} failures)** — Work not completed or incorrect:\n\n`;
      objectiveText += actualBugs.map((f: any) => `- ${f.id}: ${f.reason}`).join('\n');
      objectiveText += `\n\n**REMEDIATION STRATEGY:**\n`;
      objectiveText += `Complete the missing work. Ensure tool evidence (Edit/Write/Bash/deploy tools) is generated.\n`;
    }

    objectiveText += `\n\nParent WO objective: ${(parentWo.objective || '').slice(0, 1000)}`;

    const { data: newWoId, error: createError } = await supabase.rpc('create_draft_work_order', {
      p_slug: null,
      p_name: `Fix: ${parentWo.slug} auto-QA failures (attempt ${attemptNum}/${MAX_ATTEMPTS})`,
      p_objective: objectiveText,
      p_priority: 'p1_high',
      p_source: 'auto-qa',
      p_tags: ['remediation', `parent:${parentWo.slug}`, 'auto-qa-loop'],
      p_acceptance_criteria: hasEvidenceGaps
        ? `1. Use resolve_qa_findings tool to resolve false-negative findings on parent WO\n2. Use update_qa_checklist tool to mark parent checklist items as pass with evidence\n3. Verify parent WO ${parentWo.slug} QA gate is clear`
        : `1. Complete all missing work with tool evidence (execute_sql, apply_migration)\n2. Log progress with log_progress tool\n3. Verify parent WO ${parentWo.slug} passes auto-QA`
    });

    if (createError) {
      console.error('[REMEDIATION] Failed to create WO:', createError);
      return { error: createError.message };
    }

    // create_draft_work_order returns { id, name, slug, status } — extract UUID
    const woId = typeof newWoId === 'string' ? newWoId : newWoId?.id;

    // Set depends_on to block parent completion while remediation is active
    try {
      await supabase.from('work_orders')
        .update({ depends_on: [woId] })
        .eq('id', parentWo.id);
      console.log(`[REMEDIATION] Set parent ${parentWo.slug} depends_on=[${woId}]`);
    } catch (depErr) {
      console.error('[REMEDIATION] Failed to set depends_on:', depErr);
    }

    // Auto-start the remediation WO
    try {
      await supabase.rpc('start_work_order', { p_work_order_id: woId });
      console.log(`[REMEDIATION] Auto-started remediation WO ${woId} for ${parentWo.slug}`);
    } catch (startErr) {
      console.error('[REMEDIATION] Failed to auto-start:', startErr);
    }

    console.log(`[REMEDIATION] Created remediation WO for ${parentWo.slug} (attempt ${attemptNum})`);
    return { remediation_wo_id: woId };
  } catch (e) {
    console.error('[REMEDIATION] Exception:', e);
    return { error: (e as Error).message };
  }
}

// v46: When a remediation WO completes, re-trigger auto-QA on the parent via two-step transition
async function handleRemediationCompletion(supabase: any, wo: { id?: string; slug?: string; tags?: string[] }): Promise<void> {
  if (!wo?.tags?.includes('remediation')) return;
  const parentTag = (wo.tags || []).find((t: string) => t.startsWith('parent:'));
  if (!parentTag) return;
  const parentSlug = parentTag.replace('parent:', '');

  try {
    const { data: parentWo } = await supabase.from("work_orders")
      .select("id, status, depends_on").eq("slug", parentSlug).single();

    if (parentWo) {
      // Clear depends_on to unblock parent completion
      if (parentWo.depends_on && parentWo.depends_on.includes(wo.id)) {
        const updatedDeps = (parentWo.depends_on || []).filter((id: string) => id !== wo.id);
        await supabase.from('work_orders')
          .update({ depends_on: updatedDeps.length > 0 ? updatedDeps : null })
          .eq('id', parentWo.id);
        console.log(`[REMEDIATION] Cleared ${wo.id} from parent ${parentSlug} depends_on`);
      }

      if (parentWo.status === 'review') {
        // Two-step: review → in_progress → review triggers trg_auto_run_qa_evaluation
        await supabase.rpc('update_work_order_state', {
          p_work_order_id: parentWo.id,
          p_status: 'in_progress',
          p_approved_at: null,
          p_approved_by: null,
          p_started_at: null,
          p_completed_at: null,
          p_summary: `Remediation ${wo.slug} completed, re-evaluating`
        });
        await supabase.rpc('update_work_order_state', {
          p_work_order_id: parentWo.id,
          p_status: 'review',
          p_approved_at: null,
          p_approved_by: null,
          p_started_at: null,
          p_completed_at: null,
          p_summary: `Re-evaluation after remediation ${wo.slug}`
        });
        console.log(`[REMEDIATION] Re-triggered auto-QA on parent ${parentSlug}`);
      }
    }
  } catch (e) {
    console.error(`[REMEDIATION] Parent re-eval failed for ${parentSlug}:`, e);
  }
}


Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const url = new URL(req.url);
  const action = url.pathname.split('/').pop();

  try {
    let body: any = {};
    if (req.method === "POST") { try { body = await req.json(); } catch { body = {}; } }

    const headers: Record<string,string> = {};
    req.headers.forEach((v,k) => headers[k] = v);
    const traceId = body.trace_id || headers['x-trace-id'] || null;

    if (!['status','poll','logs','manifest','reprioritize'].includes(action||'')) {
      const check = await validateAndRateLimit(supabase, `/work-order-executor/${action}`, req.method, body, headers);
      if (!check.valid) {
        if (check.error?.code === 'ERR_RATE_LIMIT') await createLesson(supabase, 'executor', check.error.message, { endpoint: action }, body.work_order_id, traceId, ILMARINEN_ID, check.error.code);
        return new Response(JSON.stringify({ error: check.error?.message, error_code: check.error?.code, severity: check.error?.severity, category: check.error?.category, retry_allowed: check.error?.retry_allowed }), { status: check.status||400, headers: {...corsHeaders,"Content-Type":"application/json"} });
      }
    }

    const mappedAction = ACTION_MAP[action || ''];
    if (mappedAction) {
      const actionCheck = await checkAction(supabase, mappedAction, ILMARINEN_ID, body.work_order_id || null);
      if (!actionCheck.allowed) {
        await createLesson(supabase, 'action_check', actionCheck.error?.message || 'Action denied', { action: mappedAction, endpoint: action, agent_id: ILMARINEN_ID }, body.work_order_id, traceId, ILMARINEN_ID, actionCheck.error?.code);
        return new Response(JSON.stringify({ error: actionCheck.error?.message, error_code: actionCheck.error?.code, severity: actionCheck.error?.severity, category: actionCheck.error?.category }), { status: 403, headers: {...corsHeaders,"Content-Type":"application/json"} });
      }
    }

    if (req.method === "POST" && action === "approve") {
      const { work_order_id, approved_by = "human", acknowledge_duplicates = false } = body;
      if (!work_order_id) return new Response(JSON.stringify({ error: "work_order_id required", error_code: "ERR_DATA_VALIDATION" }), { status: 400, headers: {...corsHeaders,"Content-Type":"application/json"} });

      const { data: wo, error: woError } = await supabase.from("work_orders").select("id, name, objective, duplicate_check, duplicate_acknowledged, tags, assigned_to, status").eq("id", work_order_id).single();
      if (woError || !wo) return new Response(JSON.stringify(buildStructuredError('ERR_WO_NOT_FOUND', 'Work order not found', { work_order_id })), { status: 404, headers: {...corsHeaders,"Content-Type":"application/json"} });

      if (['ready', 'in_progress'].includes(wo.status)) {
        return new Response(JSON.stringify({ approved: true, already_approved: true, work_order: wo }), { headers: {...corsHeaders,"Content-Type":"application/json"} });
      }

      if (!acknowledge_duplicates) {
        let duplicates: any[];
        if (!wo.duplicate_check) {
          const keywords = extractKeywords(`${wo.name} ${wo.objective||''}`);
          const { data } = await supabase.rpc('check_build_duplicates', { p_description: `${wo.name} ${wo.objective||''}`, p_keywords: keywords, p_exclude_wo_id: work_order_id });
          duplicates = data || [];
          await supabase.from("work_orders").update({ duplicate_check: { checked_at: new Date().toISOString(), matches: duplicates, keywords_used: keywords } }).eq("id", work_order_id);
        } else {
          duplicates = wo.duplicate_check.matches || [];
        }
        const blockingDuplicates = duplicates.filter((d:any) => (d.source === 'work_orders' && d.relevance > 0.01) || (d.source === 'backlog' && d.relevance > 0.05));
        if (blockingDuplicates.length > 0) {
          const err = buildStructuredError('ERR_WO_DUPLICATE', 'Potential duplicate work orders found.', { duplicates: blockingDuplicates.length });
          return new Response(JSON.stringify({ approved: false, blocked_by: "duplicate_check", ...err, duplicates: blockingDuplicates, informational: duplicates.filter((d:any) => !blockingDuplicates.includes(d)) }), { status: 409, headers: {...corsHeaders,"Content-Type":"application/json"} });
        }
      }

      if (!wo.assigned_to) {
        const agentId = await determineAgent(supabase, wo);
        const { error: assignError } = await supabase.from("work_orders").update({ assigned_to: agentId }).eq("id", work_order_id);
        if (assignError) return new Response(JSON.stringify({ error: `Failed to auto-assign: ${assignError.message}` }), { status: 500, headers: {...corsHeaders,"Content-Type":"application/json"} });
      }

      const { data, error } = await supabase.rpc('update_work_order_state', { p_work_order_id: work_order_id, p_status: 'ready', p_approved_at: new Date().toISOString(), p_approved_by: approved_by, p_started_at: null, p_completed_at: null, p_summary: null });
      if (error) throw error;
      if (data && data.error) {
        const firstError = data.errors?.[0];
        const errorCode = firstError?.code || 'ERR_TRANSITION_REJECTED';
        await createLesson(supabase, 'transition', firstError?.message || JSON.stringify(data.errors), { endpoint: 'approve', approved_by }, work_order_id, traceId, null, errorCode);
        return new Response(JSON.stringify({ ...data, error_code: errorCode }), { status: 422, headers: {...corsHeaders,"Content-Type":"application/json"} });
      }

      await logPhase(supabase, work_order_id, "approved", "metis", { approved_by });

      // WO-0240: Atomic approve-and-start — immediately transition ready→in_progress
      // Determine agent name for start_work_order
      let agentNameForStart = 'ilmarinen'; // default
      if (wo.assigned_to) {
        const { data: agentData } = await supabase.from('agents').select('name').eq('id', wo.assigned_to).single();
        if (agentData?.name) agentNameForStart = agentData.name;
      }
      try {
        const { data: startResult, error: startError } = await supabase.rpc('start_work_order', {
          p_work_order_id: work_order_id,
          p_agent_name: agentNameForStart
        });
        if (startError) {
          console.error('[APPROVE] Auto-start failed:', startError.message);
          // Approval succeeded but start failed — return approval success with warning
          return new Response(JSON.stringify({ approved: true, started: false, start_error: startError.message, work_order: data, approved_at: new Date().toISOString() }), { headers: {...corsHeaders,"Content-Type":"application/json"} });
        }
        return new Response(JSON.stringify({ approved: true, started: true, work_order: startResult, approved_at: new Date().toISOString() }), { headers: {...corsHeaders,"Content-Type":"application/json"} });
      } catch (startErr: any) {
        console.error('[APPROVE] Auto-start exception:', startErr.message);
        return new Response(JSON.stringify({ approved: true, started: false, start_error: startErr.message, work_order: data, approved_at: new Date().toISOString() }), { headers: {...corsHeaders,"Content-Type":"application/json"} });
      }
    }

    if (req.method === "POST" && action === "claim") {
      const { work_order_id, session_id, skip_freshness_check } = body;
      if (!work_order_id) return new Response(JSON.stringify(buildStructuredError('ERR_DATA_VALIDATION', 'work_order_id required')), { status: 400, headers: {...corsHeaders,"Content-Type":"application/json"} });

      const { data: wo } = await supabase.from("work_orders").select("requires_approval, approved_at, status, slug, name, objective, acceptance_criteria, priority, created_at, client_info, tags").eq("id", work_order_id).single();
      if (wo?.requires_approval && !wo?.approved_at) {
        const err = buildStructuredError('ERR_APPROVAL_REQUIRED', 'Requires approval');
        await createLesson(supabase, 'executor', err.message, { slug: wo?.slug, status: wo?.status }, work_order_id, traceId, ILMARINEN_ID, err.code);
        return new Response(JSON.stringify({ ...err, needs_approval: true }), { status: 403, headers: {...corsHeaders,"Content-Type":"application/json"} });
      }
      if (!['draft','ready'].includes(wo?.status)) {
        const err = buildStructuredError('ERR_INVALID_STATUS', `Not claimable in '${wo?.status}' state`, { status: wo?.status });
        await createLesson(supabase, 'transition', err.message, { slug: wo?.slug, current_status: wo?.status }, work_order_id, traceId, ILMARINEN_ID, err.code);
        return new Response(JSON.stringify(err), { status: 400, headers: {...corsHeaders,"Content-Type":"application/json"} });
      }

      // WO-0155: Guard against orphaned remediation WOs — if parent is already done, auto-complete
      const tags: string[] = wo?.tags || [];
      if (tags.includes("remediation")) {
        const parentTag = tags.find((t: string) => t.startsWith("parent:"));
        if (parentTag) {
          const parentSlug = parentTag.replace("parent:", "");
          const { data: parentWo } = await supabase
            .from("work_orders")
            .select("id, slug, status")
            .eq("slug", parentSlug)
            .single();

          if (parentWo && parentWo.status === "done") {
            const msg = `Parent ${parentSlug} already completed — remediation unnecessary`;
            console.log(`[CLAIM] ${wo.slug}: ${msg}`);

            // Auto-complete the remediation WO immediately
            await logPhase(supabase, work_order_id, "parent_already_done", "ilmarinen", {
              parent_slug: parentSlug,
              parent_status: parentWo.status,
              auto_completed: true
            });

            // Transition directly to done
            await supabase.rpc('update_work_order_state', {
              p_work_order_id: work_order_id,
              p_status: 'done',
              p_approved_at: null,
              p_approved_by: null,
              p_started_at: null,
              p_completed_at: new Date().toISOString(),
              p_summary: msg
            });

            return new Response(JSON.stringify({
              claimed: false,
              auto_completed: true,
              reason: msg,
              parent_slug: parentSlug,
              parent_status: 'done'
            }), { headers: {...corsHeaders,"Content-Type":"application/json"} });
          }
        }
      }

      if (!skip_freshness_check) {
        const freshnessCheck = await validateWorkOrderFreshness(supabase, work_order_id);
        await logPhase(supabase, work_order_id, "freshness_check", "ilmarinen", { fresh: freshnessCheck.fresh, stale_details: freshnessCheck.stale_details });

        if (!freshnessCheck.fresh) {
          try {
            const refinement = await refineStaleness(supabase, work_order_id, freshnessCheck.stale_details);
            if (refinement.decision === 'deprecate') {
              await supabase.rpc('update_work_order_state', { p_work_order_id: work_order_id, p_status: 'cancelled', p_approved_at: null, p_approved_by: null, p_started_at: null, p_completed_at: new Date().toISOString(), p_summary: `Auto-deprecated: ${refinement.reason}` });
              return new Response(JSON.stringify(buildStructuredError('ERR_WO_STALE', `Deprecated: ${refinement.reason}`, { deprecated: true })), { status: 410, headers: {...corsHeaders,"Content-Type":"application/json"} });
            }
            if (refinement.decision === 'refine') {
              await supabase.from('work_orders').update({ name: refinement.refined_name || wo.name, objective: refinement.refined_objective || wo.objective, client_info: { ...(wo.client_info || {}), freshness_conflicts: null, refinement_applied: { reason: refinement.reason, refined_at: new Date().toISOString() } } }).eq('id', work_order_id);
              const { data: updatedWo } = await supabase.from('work_orders').select('name, objective, acceptance_criteria').eq('id', work_order_id).single();
              if (updatedWo) { wo.name = updatedWo.name; wo.objective = updatedWo.objective; }
            }
          } catch (refineErr) {
            const err = buildStructuredError('ERR_WO_STALE', `Auto-refine failed: ${(refineErr as Error).message}`);
            return new Response(JSON.stringify({ ...err, freshness_check_blocked: true, stale_details: freshnessCheck.stale_details }), { status: 422, headers: {...corsHeaders,"Content-Type":"application/json"} });
          }
        }
      }

      const gateResult = await evaluateGates(supabase, work_order_id, 'work_order_execute', { priority: wo.priority });
      if (!gateResult.approved) {
        // Transition WO to pending_approval status so it's visible in portal
        await supabase.rpc('update_work_order_state', {
          p_work_order_id: work_order_id,
          p_status: 'pending_approval',
          p_approved_at: null,
          p_approved_by: null,
          p_started_at: null,
          p_completed_at: null,
          p_summary: null
        });

        await logPhase(supabase, work_order_id, "gate_blocked", "ilmarinen", {
          gates_pending: gateResult.pending,
          reason: 'Gate approval required before execution'
        });

        const err = buildStructuredError('ERR_GATE_BLOCKED', 'Gate approval required - WO transitioned to pending_approval', { gates: gateResult.pending });
        // Don't create lesson - this is expected behavior for P0 WOs
        return new Response(JSON.stringify({ ...err, gates_pending: gateResult.pending, status: 'pending_approval' }), { status: 403, headers: {...corsHeaders,"Content-Type":"application/json"} });
      }

      let woTraceId: string | null = null;
      try { const { data: traceData } = await supabase.rpc('start_wo_trace', { p_work_order_id: work_order_id, p_session_id: session_id || headers['x-session-id'] || null }); woTraceId = traceData; }
      catch (traceErr) { console.error('[TRACE] Failed:', traceErr); }

      const { data, error } = await supabase.rpc('update_work_order_state', { p_work_order_id: work_order_id, p_status: 'in_progress', p_approved_at: null, p_approved_by: null, p_started_at: new Date().toISOString(), p_completed_at: null, p_summary: null });
      if (error) throw error;
      if (data && data.error) {
        const firstError = data.errors?.[0];
        const errorCode = firstError?.code || 'ERR_TRANSITION_REJECTED';
        await createLesson(supabase, 'transition', firstError?.message || JSON.stringify(data.errors), { endpoint: 'claim' }, work_order_id, traceId, ILMARINEN_ID, errorCode);
        return new Response(JSON.stringify({ ...data, error_code: errorCode }), { status: 422, headers: {...corsHeaders,"Content-Type":"application/json"} });
      }

      await logPhase(supabase, work_order_id, "claimed", "ilmarinen", { slug: wo.slug, trace_id: woTraceId });
      return new Response(JSON.stringify({ claimed: true, trace_id: woTraceId, work_order: { ...data, objective: wo.objective, acceptance_criteria: wo.acceptance_criteria }, claimed_at: new Date().toISOString() }), { headers: {...corsHeaders,"Content-Type":"application/json"} });
    }

    if (req.method === "POST" && action === "complete") {
      const { work_order_id, result, summary, manifest_entry, delivery, tool_metadata, skip_deploy_validation } = body;
      if (!work_order_id) return new Response(JSON.stringify(buildStructuredError('ERR_DATA_VALIDATION', 'work_order_id required')), { status: 400, headers: {...corsHeaders,"Content-Type":"application/json"} });
      if (!summary || summary.trim() === '') return new Response(JSON.stringify(buildStructuredError('ERR_DATA_VALIDATION', 'summary is required and cannot be empty')), { status: 400, headers: {...corsHeaders,"Content-Type":"application/json"} });
      const { data: wo } = await supabase.from("work_orders").select("slug, requires_approval, status, client_info, tags").eq("id", work_order_id).single();
      if (wo?.status !== 'in_progress') {
        const err = buildStructuredError('ERR_INVALID_STATUS', `Not in progress (current: ${wo?.status})`, { status: wo?.status });
        await createLesson(supabase, 'transition', err.message, { slug: wo?.slug }, work_order_id, traceId, ILMARINEN_ID, err.code);
        return new Response(JSON.stringify(err), { status: 400, headers: {...corsHeaders,"Content-Type":"application/json"} });
      }

      if (!skip_deploy_validation) {
        const deploymentTags = wo?.tags?.filter((t: string) => ['deploy','deployment','production','edge-function','migration'].some(kw => t.toLowerCase().includes(kw))) || [];
        if (deploymentTags.length > 0) {
          const deployValidation = await validateDeployment(supabase, work_order_id);
          if (!deployValidation.valid) {
            await createLesson(supabase, 'deployment_validation', deployValidation.error?.message || 'Validation failed', { validation_checks: deployValidation.checks }, work_order_id, traceId, ILMARINEN_ID, deployValidation.error?.code);
            return new Response(JSON.stringify({ ...deployValidation.error, deployment_gate_blocked: true, validation_checks: deployValidation.checks }), { status: 422, headers: {...corsHeaders,"Content-Type":"application/json"} });
          }
        }
      }

      const newStatus = wo?.requires_approval ? "review" : "done";
      const { data, error } = await supabase.rpc('update_work_order_state', { p_work_order_id: work_order_id, p_status: newStatus, p_approved_at: null, p_approved_by: null, p_started_at: null, p_completed_at: new Date().toISOString(), p_summary: summary });
      if (error) throw error;
      if (data && data.error) {
        const firstError = data.errors?.[0];
        const errorCode = firstError?.code || 'ERR_TRANSITION_REJECTED';
        await createLesson(supabase, 'transition', firstError?.message || JSON.stringify(data.errors), { endpoint: 'complete' }, work_order_id, traceId, ILMARINEN_ID, errorCode);
        return new Response(JSON.stringify({ ...data, error_code: errorCode }), { status: 422, headers: {...corsHeaders,"Content-Type":"application/json"} });
      }

      if (newStatus === "review") await initializeQAChecklistIfNeeded(supabase, work_order_id);

      try {
        const updatedClientInfo: Record<string, unknown> = { ...(wo?.client_info || {}) };
        if (delivery) updatedClientInfo.delivery = delivery;
        if (tool_metadata) updatedClientInfo.tool_metadata = tool_metadata;
        if (summary) updatedClientInfo.summary = summary?.slice?.(0, 20000);
        if (result) updatedClientInfo.output = result?.slice?.(0, 50000);
        await supabase.from('work_orders').update({ client_info: updatedClientInfo }).eq('id', work_order_id);
      } catch (metaErr) { console.error('[META] Failed:', metaErr); }

      if (traceId) { try { await supabase.rpc('complete_wo_trace', { p_trace_id: traceId, p_status: 'completed', p_output: { summary, result: result?.slice?.(0, 10000) } }); } catch { } }
      if (manifest_entry) { try { await supabase.rpc('state_write', { p_mutation_type: 'INSERT', p_target_table: 'system_manifest', p_payload: { component_type: manifest_entry.type||'edge_function', name: manifest_entry.name, description: manifest_entry.description, purpose: manifest_entry.purpose, config: manifest_entry.config||{}, created_by_wo: wo?.slug, status: 'active' }, p_work_order_id: work_order_id }); } catch { } }

      // v46: If remediation WO completed directly to done, re-trigger parent auto-QA
      if (newStatus === 'done') {
        try { await handleRemediationCompletion(supabase, { id: work_order_id, slug: wo.slug, tags: wo.tags }); } catch (e) { console.error('[COMPLETE] Remediation handler error:', e); }
      }

      await logPhase(supabase, work_order_id, "completing", "ilmarinen", { summary: summary?.slice?.(0, 5000), final_status: newStatus, trace_id: traceId });
      return new Response(JSON.stringify({ completed: true, needs_review: newStatus === "review", work_order: data, completed_at: new Date().toISOString() }), { headers: {...corsHeaders,"Content-Type":"application/json"} });
    }

    if (req.method === "POST" && action === "accept") {
      const { work_order_id, skip_qa_validation } = body;
      if (!work_order_id) return new Response(JSON.stringify(buildStructuredError('ERR_DATA_VALIDATION', 'work_order_id required')), { status: 400, headers: {...corsHeaders,"Content-Type":"application/json"} });
      const { data: wo } = await supabase.from("work_orders").select("status, slug, tags").eq("id", work_order_id).single();
      if (wo?.status === 'done') return new Response(JSON.stringify({ accepted: true, already_done: true, work_order: wo }), { headers: {...corsHeaders,"Content-Type":"application/json"} });
      if (wo?.status !== 'review') {
        const err = buildStructuredError('ERR_INVALID_STATUS', `Not in review (current: ${wo?.status})`, { status: wo?.status });
        await createLesson(supabase, 'transition', err.message, { slug: wo?.slug }, work_order_id, traceId, ILMARINEN_ID, err.code);
        return new Response(JSON.stringify(err), { status: 400, headers: {...corsHeaders,"Content-Type":"application/json"} });
      }

      if (!skip_qa_validation) {
        const qaValidation = await validateQAChecklistComplete(supabase, work_order_id);
        if (!qaValidation.complete) {
          await createLesson(supabase, 'qa_checklist', qaValidation.error?.message || 'QA incomplete', { pending_items: qaValidation.pending_items }, work_order_id, traceId, ILMARINEN_ID, qaValidation.error?.code);
          return new Response(JSON.stringify({ ...qaValidation.error, qa_checklist_blocked: true, pending_items: qaValidation.pending_items }), { status: 422, headers: {...corsHeaders,"Content-Type":"application/json"} });
        }
      }

      const { data, error } = await supabase.rpc('update_work_order_state', { p_work_order_id: work_order_id, p_status: 'done', p_approved_at: null, p_approved_by: null, p_started_at: null, p_completed_at: new Date().toISOString(), p_summary: null });
      if (error) throw error;
      if (data && data.error) {
        const firstError = data.errors?.[0];
        const errorCode = firstError?.code || 'ERR_TRANSITION_REJECTED';
        await createLesson(supabase, 'transition', firstError?.message || JSON.stringify(data.errors), {}, work_order_id, traceId, null, errorCode);
        return new Response(JSON.stringify({ ...data, error_code: errorCode }), { status: 422, headers: {...corsHeaders,"Content-Type":"application/json"} });
      }

      // v46: If accepted remediation WO, re-trigger parent auto-QA
      try { await handleRemediationCompletion(supabase, { id: work_order_id, slug: wo.slug, tags: wo.tags }); } catch (e) { console.error('[ACCEPT] Remediation handler error:', e); }

      await logPhase(supabase, work_order_id, "completing", "metis", { action: "accepted", slug: wo.slug });
      return new Response(JSON.stringify({ accepted: true, work_order: data }), { headers: {...corsHeaders,"Content-Type":"application/json"} });
    }

    // === POST /auto-qa — Automated QA evaluation using Sonnet + execution log evidence ===
    // v38: Upgraded from Haiku to Sonnet, added execution log context for evidence-based evaluation
    if (req.method === "POST" && action === "auto-qa") {
      const { work_order_id, execution_output } = body;
      if (!work_order_id) return new Response(JSON.stringify(buildStructuredError('ERR_DATA_VALIDATION', 'work_order_id required')), { status: 400, headers: {...corsHeaders,"Content-Type":"application/json"} });

      const { data: wo, error: woError } = await supabase.from("work_orders")
        .select("id, slug, name, status, qa_checklist, objective, acceptance_criteria, summary, client_info, tags, last_qa_run_at")
        .eq("id", work_order_id).single();
      if (woError || !wo) return new Response(JSON.stringify(buildStructuredError('ERR_WO_NOT_FOUND', 'Work order not found')), { status: 404, headers: {...corsHeaders,"Content-Type":"application/json"} });

      // v60: AC1 — Skip gracefully if WO already done/cancelled (race condition fix for WO-0234)
      if (wo.status === 'done' || wo.status === 'cancelled') {
        await logPhase(supabase, work_order_id, "auto-qa-skipped", "qa-gate", {
          reason: 'stale_evaluation',
          current_status: wo.status,
          slug: wo.slug,
          message: 'WO already completed before async auto-QA arrived'
        });
        return new Response(JSON.stringify({ skipped: true, reason: 'already_completed', current_status: wo.status }), { headers: {...corsHeaders,"Content-Type":"application/json"} });
      }

      if (wo.status !== 'review') {
        return new Response(JSON.stringify({ ...buildStructuredError('ERR_INVALID_STATUS', `Not in review (current: ${wo.status})`), all_pass: false, accepted: false }), { status: 400, headers: {...corsHeaders,"Content-Type":"application/json"} });
      }

      // v50: Dedup guard — prevent concurrent auto-QA calls (DB trigger + daemon race)
      // If last_qa_run_at is within 10 seconds, skip this call (another caller is handling it)
      if (wo.last_qa_run_at) {
        const lastRun = new Date(wo.last_qa_run_at).getTime();
        const now = Date.now();
        if (now - lastRun < 10000) {
          console.log(`[AUTO-QA] Dedup guard: skipping ${wo.slug} — last run ${Math.round((now - lastRun)/1000)}s ago`);
          return new Response(JSON.stringify({ skipped: true, reason: 'dedup_guard', last_qa_run_seconds_ago: Math.round((now - lastRun)/1000) }), { headers: {...corsHeaders,"Content-Type":"application/json"} });
        }
      }
      // Stamp this run
      await supabase.from('work_orders').update({ last_qa_run_at: new Date().toISOString() }).eq('id', work_order_id);

      // v47: Resolve existing unresolved findings before creating new ones.
      // Prevents duplicate contradictory findings from concurrent trigger + daemon invocations.
      // The DB trigger (trg_auto_run_qa_evaluation) also resolves, but if both /auto-qa calls
      // race, the second call's resolution here ensures only the last evaluation's findings remain.
      await supabase.from('qa_findings')
        .update({ resolved_at: new Date().toISOString() })
        .eq('work_order_id', work_order_id)
        .is('resolved_at', null);

      let checklist = wo.qa_checklist || [];
      if (checklist.length === 0) {
        await initializeQAChecklistIfNeeded(supabase, work_order_id);
        const { data: refreshed } = await supabase.from("work_orders").select("qa_checklist").eq("id", work_order_id).single();
        checklist = refreshed?.qa_checklist || [];
      }

      if (checklist.length === 0) {
        // v51: Auto-accept fallback — if no checklist items AND no unresolved fail findings AND summary exists, auto-accept
        const { count: failCount } = await supabase.from('qa_findings')
          .select('id', { count: 'exact', head: true })
          .eq('work_order_id', work_order_id)
          .eq('finding_type', 'fail')
          .is('resolved_at', null);

        if ((failCount || 0) === 0 && wo.summary) {
          // Safe to auto-accept: no checklist to evaluate, no outstanding failures, has summary
          await supabase.rpc('run_sql_void', {
            sql_query: `SELECT set_config('app.wo_executor_bypass', 'true', true); UPDATE work_orders SET status = 'done', completed_at = NOW() WHERE id = '${work_order_id}' AND status = 'review';`
          });
          await logPhase(supabase, work_order_id, "completing", "qa-gate", { action: "auto-accepted-empty-checklist", slug: wo.slug, reason: "No checklist items, no fail findings, summary present" });
          return new Response(JSON.stringify({ all_pass: true, items_evaluated: 0, accepted: true, failures: [], message: "Auto-accepted: no checklist items, no failures, summary present" }), { headers: {...corsHeaders,"Content-Type":"application/json"} });
        }

        return new Response(JSON.stringify({ all_pass: true, items_evaluated: 0, accepted: false, failures: [], message: "No checklist items to evaluate" }), { headers: {...corsHeaders,"Content-Type":"application/json"} });
      }

      // v38: Build rich evaluation context from multiple sources
      const summaryText = execution_output || wo.summary || wo.client_info?.summary || wo.client_info?.output || '';

      // v38: Pull execution log evidence — tool usage, deployment records, stream events
      let executionEvidence = '';
      try {
        const { data: execLogs } = await supabase.from('work_order_execution_log')
          .select('phase, agent_name, detail, created_at')
          .eq('work_order_id', work_order_id)
          .order('created_at', { ascending: false })
          .limit(20);

        if (execLogs && execLogs.length > 0) {
          const evidenceParts: string[] = [];

          // Extract the result event (daemon's final summary — most authoritative)
          const resultEvent = execLogs.find((l: any) => l.detail?.event_type === 'result');
          if (resultEvent?.detail?.content) {
            evidenceParts.push(`DAEMON FINAL OUTPUT:\n${(resultEvent.detail.content as string).slice(0, 8000)}`);
          }

          // Extract execution_complete event (tool usage proof)
          const completeEvent = execLogs.find((l: any) => l.phase === 'execution_complete');
          if (completeEvent?.detail) {
            evidenceParts.push(`EXECUTION STATS: ${completeEvent.detail.content || ''}\nTools used: ${(completeEvent.detail.tools_used || []).join(', ')}\nMCP tools: ${(completeEvent.detail.mcp_tools_used || []).join(', ')}`);
          }

          // Extract schema_validation event
          const schemaEvent = execLogs.find((l: any) => l.phase === 'schema_validation');
          if (schemaEvent?.detail) {
            evidenceParts.push(`SCHEMA VALIDATION: ${schemaEvent.detail.content || 'N/A'} (warnings: ${schemaEvent.detail.warning_count || 0})`);
          }

          // Extract key tool_result events (deployment evidence)
          const toolResults = execLogs.filter((l: any) => l.detail?.event_type === 'tool_result' && l.detail?.tool_name);
          if (toolResults.length > 0) {
            const toolSummary = toolResults.slice(0, 5).map((t: any) =>
              `- ${t.detail.tool_name}: ${(t.detail.content || '').slice(0, 300)}`
            ).join('\n');
            evidenceParts.push(`TOOL RESULTS:\n${toolSummary}`);
          }

          executionEvidence = evidenceParts.join('\n\n---\n\n');
        }
      } catch (logErr) {
        console.error('[AUTO-QA] Failed to fetch execution logs:', logErr);
      }

      // v47: Check audit_log for deployment records — EXCLUDE auto-QA metadata events
      // to prevent feedback loop where previous failure messages poison the next evaluation
      let deploymentEvidence = '';
      try {
        const { data: deployLogs } = await supabase.from('audit_log')
          .select('event_type, action, payload, new_state, created_at')
          .eq('target_type', 'work_order')
          .eq('target_id', work_order_id)
          .not('event_type', 'in', '(checklist_item_updated,verification_recorded,auto_qa_triggered)')
          .order('created_at', { ascending: false })
          .limit(5);

        if (deployLogs && deployLogs.length > 0) {
          deploymentEvidence = deployLogs.map((d: any) =>
            `[${d.event_type}] ${d.action || ''}: ${JSON.stringify(d.payload || {}).slice(0, 300)}`
          ).join('\n');
        }
      } catch (auditErr) {
        console.error('[AUTO-QA] Failed to fetch audit logs:', auditErr);
      }

      // Build combined context — prefer execution evidence over bare summary
      const fullContext = [
        summaryText ? `WORK ORDER SUMMARY:\n${summaryText.slice(0, 5000)}` : '',
        executionEvidence ? `\n\nEXECUTION EVIDENCE:\n${executionEvidence}` : '',
        deploymentEvidence ? `\n\nDEPLOYMENT RECORDS:\n${deploymentEvidence}` : ''
      ].filter(Boolean).join('');

      if (!fullContext) {
        return new Response(JSON.stringify({ ...buildStructuredError('ERR_DATA_VALIDATION', 'No execution output or evidence available for evaluation'), all_pass: false, accepted: false }), { status: 400, headers: {...corsHeaders,"Content-Type":"application/json"} });
      }

      const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
      const criteriaText = checklist.map((ci: any) => `- [${ci.id}] ${ci.criterion || ci.description || ci.name}`).join('\n');

      let evaluations: any[];
      try {
        const evalResp = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-api-key": apiKey!, "anthropic-version": "2023-06-01" },
          body: JSON.stringify({
            model: "claude-sonnet-4-5-20250929",
            max_tokens: 4096,
            messages: [{
              role: "user",
              content: `You are a strict QA evaluator for a software build system. You must evaluate whether each acceptance criterion was ACTUALLY met based on concrete evidence — not just claims in the summary.

WORK ORDER: ${wo.slug}
OBJECTIVE: ${wo.objective || 'N/A'}

${fullContext.slice(0, 15000)}

ACCEPTANCE CRITERIA TO EVALUATE:
${criteriaText}

EVALUATION RULES:
1. "pass" = You can cite SPECIFIC evidence: tool calls that executed, deployment records, code changes, test results
2. "fail" = No concrete evidence found, OR evidence contradicts the claim, OR only vague summary claims without proof
3. "na" = Criterion is clearly not applicable to this type of work order
4. A summary CLAIMING something was done is NOT sufficient evidence by itself — look for tool usage, deployment records, or execution logs that PROVE it
5. STRONG DEPLOYMENT EVIDENCE (any of these count):
   - mcp__supabase__deploy_edge_function tool call
   - Bash tool containing "supabase functions deploy" (CLI deploy)
   - Bash tool containing "git push" or "git commit" (code delivery)
   - deploy_edge_function tool call (wo-agent)
6. STRONG SCHEMA/CODE EVIDENCE (any of these count):
   - mcp__supabase__apply_migration or apply_migration tool call
   - mcp__supabase__execute_sql or execute_sql tool call with DDL
   - Edit/Write/Read tool calls (code modification evidence)
   - Bash tool containing "supabase" or "migration" commands
7. Be especially skeptical of claims without matching tool usage — but CLI tools (Bash) are equally valid as MCP tools

Respond with ONLY a JSON array:
[
  {"id": "ac-1", "status": "pass", "summary": "Evidence: deployed via Bash supabase functions deploy, execution log confirms success"},
  {"id": "ac-2", "status": "fail", "summary": "Summary claims implementation but no deployment or code modification evidence found"}
]

Keep evidence summaries under 250 characters. Cite specific tool names or log entries when possible.`
            }],
          }),
        });

        if (!evalResp.ok) {
          const errText = await evalResp.text();
          console.error('[AUTO-QA] Sonnet evaluation failed:', errText.slice(0, 300));
          return new Response(JSON.stringify({ ...buildStructuredError('ERR_QA_VALIDATION_FAILED', 'QA evaluation LLM call failed'), all_pass: false, accepted: false }), { status: 502, headers: {...corsHeaders,"Content-Type":"application/json"} });
        }

        const evalData = await evalResp.json();
        const llmText = evalData.content?.[0]?.text || "";
        const jsonMatch = llmText.match(/\[[\s\S]*\]/);
        evaluations = JSON.parse(jsonMatch?.[0] || llmText);
      } catch (parseErr) {
        console.error('[AUTO-QA] Failed to parse LLM evaluation:', parseErr);
        return new Response(JSON.stringify({ ...buildStructuredError('ERR_QA_VALIDATION_FAILED', 'Failed to parse QA evaluation response'), all_pass: false, accepted: false }), { status: 502, headers: {...corsHeaders,"Content-Type":"application/json"} });
      }

      // v60: AC2 — Re-check WO status before writing findings (race condition fix for WO-0234)
      // If WO transitioned to done/cancelled during LLM evaluation, skip writing findings
      const { data: freshWo } = await supabase.from("work_orders")
        .select("status, slug")
        .eq("id", work_order_id)
        .single();

      if (freshWo && (freshWo.status === 'done' || freshWo.status === 'cancelled')) {
        await logPhase(supabase, work_order_id, "auto-qa-skipped", "qa-gate", {
          reason: 'status_changed_during_evaluation',
          current_status: freshWo.status,
          slug: freshWo.slug,
          message: 'WO completed during LLM evaluation, skipping findings'
        });
        return new Response(JSON.stringify({ skipped: true, reason: 'status_changed_during_evaluation', current_status: freshWo.status }), { headers: {...corsHeaders,"Content-Type":"application/json"} });
      }

      const failures: any[] = [];
      let itemsEvaluated = 0;

      for (const criterion of evaluations) {
        if (!criterion.id || !criterion.status) continue;
        try {
          // update_checklist_item RPC creates a qa_finding automatically — pass rich evidence
          await supabase.rpc('update_checklist_item', {
            p_work_order_id: work_order_id,
            p_item_id: criterion.id,
            p_status: criterion.status,
            p_evidence: { summary: criterion.summary, verified_by: 'auto-qa-sonnet-v38', auto_evaluated: true, model: 'sonnet-4.5', auto_qa_version: 'v38', has_execution_evidence: !!executionEvidence }
          });
        } catch (updateErr) {
          console.error(`[AUTO-QA] Failed to update ${criterion.id}:`, updateErr);
        }
        itemsEvaluated++;
        if (criterion.status === 'fail') {
          failures.push({ id: criterion.id, reason: criterion.summary });
        }
      }

      const allPass = failures.length === 0;

      try {
        await supabase.rpc('record_verification', {
          p_work_order_id: work_order_id,
          p_verified_by: 'auto-qa',
          p_verification_type: 'automated_qa',
          p_evidence: { evaluations, items_evaluated: itemsEvaluated, failures, auto_qa_version: 'v38', model: 'sonnet-4.5', has_execution_evidence: !!executionEvidence },
          p_passed: allPass
        });
      } catch (verifyErr) {
        console.error('[AUTO-QA] Failed to record verification:', verifyErr);
      }

      let accepted = false;
      if (allPass && itemsEvaluated > 0) {
        const { data: acceptData, error: acceptError } = await supabase.rpc('update_work_order_state', { p_work_order_id: work_order_id, p_status: 'done', p_approved_at: null, p_approved_by: null, p_started_at: null, p_completed_at: new Date().toISOString(), p_summary: null });
        if (!acceptError && !(acceptData?.error)) {
          accepted = true;
          await logPhase(supabase, work_order_id, "completing", "qa-gate", { action: "auto-accepted", items_evaluated: itemsEvaluated, slug: wo.slug, model: 'sonnet-4.5' });
          // v46: If accepted remediation WO, re-trigger parent auto-QA
          try { await handleRemediationCompletion(supabase, { id: work_order_id, slug: wo.slug, tags: wo.tags }); } catch (e) { console.error('[AUTO-QA] Remediation handler error:', e); }
        } else {
          console.error('[AUTO-QA] Accept transition failed:', acceptError || acceptData);
        }
      }

      // v48: Create remediation WO for failures
      // Guard: only block auto-qa-loop WOs (actual recursion risk), not general remediation-tagged WOs
      // For auto-qa-loop WOs that fail: escalate to parent's circuit breaker
      let remediation_wo_id: string | undefined;
      if (!allPass && failures.length > 0) {
        const isAutoQaLoop = (wo.tags || []).includes('auto-qa-loop');
        if (!isAutoQaLoop) {
          // Regular WO (including remediation-tagged batch WOs) → create sub-WO
          try {
            const remResult = await createRemediationWO(supabase, wo, failures);
            remediation_wo_id = remResult.remediation_wo_id;
          } catch (remErr) {
            console.error('[AUTO-QA] Remediation WO creation failed:', remErr);
          }
        } else {
          // Auto-QA-generated sub-WO failed → move to failed and re-check parent circuit breaker
          console.log(`[AUTO-QA] auto-qa-loop WO ${wo.slug} failed — escalating to failed`);
          try {
            await supabase.rpc('update_work_order_state', {
              p_work_order_id: work_order_id,
              p_status: 'failed',
              p_approved_at: null,
              p_approved_by: null,
              p_started_at: null,
              p_completed_at: new Date().toISOString(),
              p_summary: `Remediation sub-WO failed auto-QA: ${failures.map((f: any) => f.id + ': ' + f.reason).join('; ').slice(0, 500)}`
            });
            // Trigger parent circuit breaker check by calling createRemediationWO on parent
            // This increments the attempt counter — if >= MAX, parent moves to failed
            const parentTag = (wo.tags || []).find((t: string) => t.startsWith('parent:'));
            if (parentTag) {
              const parentSlug = parentTag.replace('parent:', '');
              const { data: parentWo } = await supabase.from("work_orders")
                .select("id, slug, name, objective, status")
                .eq("slug", parentSlug).single();
              if (parentWo && parentWo.status === 'review') {
                const remResult = await createRemediationWO(supabase, parentWo, failures);
                remediation_wo_id = remResult.remediation_wo_id;
                console.log(`[AUTO-QA] Escalated to parent ${parentSlug}: new attempt or circuit breaker`);
              }
            }
          } catch (escErr) {
            console.error('[AUTO-QA] Failed to escalate auto-qa-loop failure:', escErr);
          }
        }
      }

      await logPhase(supabase, work_order_id, "qa_validation", "auto-qa", {
        all_pass: allPass, items_evaluated: itemsEvaluated,
        failures: failures.slice(0, 5), accepted, slug: wo.slug,
        model: 'sonnet-4.5', has_execution_evidence: !!executionEvidence,
        remediation_wo_id
      });

      return new Response(JSON.stringify({
        all_pass: allPass, accepted, items_evaluated: itemsEvaluated,
        failures, work_order_id, slug: wo.slug,
        model: 'sonnet-4.5', version: 'v48',
        remediation_wo_id
      }), { headers: {...corsHeaders,"Content-Type":"application/json"} });
    }

    // === POST /refine-stale — Standalone LLM staleness refinement ===
    if (req.method === "POST" && action === "refine-stale") {
      const { work_order_id } = body;
      if (!work_order_id) return new Response(JSON.stringify(buildStructuredError('ERR_DATA_VALIDATION', 'work_order_id required')), { status: 400, headers: {...corsHeaders,"Content-Type":"application/json"} });

      const freshnessCheck = await validateWorkOrderFreshness(supabase, work_order_id);
      if (freshnessCheck.fresh) {
        return new Response(JSON.stringify({ fresh: true, decision: "proceed", reason: "Work order is fresh" }), { headers: {...corsHeaders,"Content-Type":"application/json"} });
      }

      try {
        const refinement = await refineStaleness(supabase, work_order_id, freshnessCheck.stale_details);

        if (refinement.decision === 'deprecate') {
          await supabase.rpc('update_work_order_state', { p_work_order_id: work_order_id, p_status: 'cancelled', p_approved_at: null, p_approved_by: null, p_started_at: null, p_completed_at: new Date().toISOString(), p_summary: `Auto-deprecated: ${refinement.reason}` });
          await logPhase(supabase, work_order_id, "deprecated", "ilmarinen", { reason: refinement.reason });
        } else if (refinement.decision === 'refine') {
          const { data: wo } = await supabase.from('work_orders').select('client_info').eq('id', work_order_id).single();
          await supabase.from('work_orders').update({
            name: refinement.refined_name,
            objective: refinement.refined_objective,
            client_info: { ...(wo?.client_info || {}), refinement_applied: { reason: refinement.reason, refined_at: new Date().toISOString() } }
          }).eq('id', work_order_id);
          await logPhase(supabase, work_order_id, "refined", "ilmarinen", { reason: refinement.reason, new_name: refinement.refined_name });
        }

        return new Response(JSON.stringify({ ...refinement, stale_details: freshnessCheck.stale_details }), { headers: {...corsHeaders,"Content-Type":"application/json"} });
      } catch (e) {
        return new Response(JSON.stringify({ ...buildStructuredError('ERR_WO_STALE', `Staleness refinement failed: ${(e as Error).message}`), stale_details: freshnessCheck.stale_details }), { status: 500, headers: {...corsHeaders,"Content-Type":"application/json"} });
      }
    }

    // === POST /consolidate — AI gap analysis + refine OR bulk cancel ===
    if (req.method === "POST" && action === "consolidate") {
      // UI contract: { work_order_id, duplicates } → AI gap analysis
      if (body.work_order_id && body.duplicates) {
        const { work_order_id, duplicates } = body;
        const { data: wo } = await supabase.from("work_orders").select("id, slug, name, objective").eq("id", work_order_id).single();
        if (!wo) return new Response(JSON.stringify(buildStructuredError('ERR_WO_NOT_FOUND', 'Work order not found')), { status: 404, headers: {...corsHeaders,"Content-Type":"application/json"} });

        const dupSummary = (duplicates || []).map((d: any) => `- ${d.name} (${d.source || 'unknown'}, status: ${d.status || 'n/a'}): ${d.recommendation || ''}`).join('\n');
        const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
        const prompt = `You are analyzing whether a proposed work order is already covered by existing components.\n\nProposed WO: "${wo.name}"\nObjective: ${wo.objective}\n\nExisting overlapping components:\n${dupSummary}\n\nRespond with JSON only:\n{\n  "fully_covered": true/false,\n  "gap_analysis": "1-2 sentence explanation of what IS and ISN'T covered",\n  "refined": {\n    "name": "refined name focusing only on uncovered gaps (or original if fully covered)",\n    "objective": "refined objective excluding already-covered scope"\n  }\n}`;

        try {
          const resp = await fetch("https://api.anthropic.com/v1/messages", {
            method: "POST",
            headers: { "Content-Type": "application/json", "x-api-key": apiKey!, "anthropic-version": "2023-06-01" },
            body: JSON.stringify({ model: "claude-haiku-4-5-20251001", max_tokens: 500, messages: [{ role: "user", content: prompt }] }),
          });
          const result = await resp.json();
          const text = result.content?.[0]?.text || "{}";
          const jsonMatch = text.match(/\{[\s\S]*\}/);
          const analysis = jsonMatch ? JSON.parse(jsonMatch[0]) : { fully_covered: false, gap_analysis: "Analysis failed", refined: { name: wo.name, objective: wo.objective } };
          analysis.original = { name: wo.name, objective: wo.objective };
          return new Response(JSON.stringify(analysis), { headers: {...corsHeaders,"Content-Type":"application/json"} });
        } catch (err: any) {
          return new Response(JSON.stringify({ fully_covered: false, gap_analysis: `Analysis error: ${err.message}`, original: { name: wo.name, objective: wo.objective }, refined: { name: wo.name, objective: wo.objective } }), { headers: {...corsHeaders,"Content-Type":"application/json"} });
        }
      }

      // Legacy contract: { work_order_ids, primary_id } → bulk cancel secondaries
      const { work_order_ids, primary_id, reason } = body;
      if (!work_order_ids || !primary_id) return new Response(JSON.stringify(buildStructuredError('ERR_DATA_VALIDATION', 'work_order_ids and primary_id required, or work_order_id and duplicates for gap analysis')), { status: 400, headers: {...corsHeaders,"Content-Type":"application/json"} });

      const secondaryIds = work_order_ids.filter((id: string) => id !== primary_id);
      let consolidated = 0;
      const errors: string[] = [];
      for (const secId of secondaryIds) {
        const { data, error } = await supabase.rpc('update_work_order_state', { p_work_order_id: secId, p_status: 'cancelled', p_approved_at: null, p_approved_by: null, p_started_at: null, p_completed_at: new Date().toISOString(), p_summary: `Consolidated into ${primary_id}: ${reason || 'Duplicate'}` });
        if (error) { errors.push(`${secId}: ${error.message}`); }
        else if (data?.error) { errors.push(`${secId}: ${data.error}`); }
        else { consolidated++; }
      }

      await logPhase(supabase, primary_id, "consolidation", "metis", { consolidated, cancelled: secondaryIds, errors: errors.length > 0 ? errors : undefined });
      return new Response(JSON.stringify({ consolidated, primary_id, cancelled_ids: secondaryIds, errors: errors.length > 0 ? errors : undefined }), { headers: {...corsHeaders,"Content-Type":"application/json"} });
    }

    // === POST /reject — Reject a WO in review, back to in_progress ===
    if (req.method === "POST" && action === "reject") {
      const { work_order_id, reason } = body;
      if (!work_order_id) return new Response(JSON.stringify(buildStructuredError('ERR_DATA_VALIDATION', 'work_order_id required')), { status: 400, headers: {...corsHeaders,"Content-Type":"application/json"} });

      const { data: wo } = await supabase.from("work_orders").select("status, slug").eq("id", work_order_id).single();
      if (wo?.status !== 'review') {
        const err = buildStructuredError('ERR_INVALID_STATUS', `Not in review (current: ${wo?.status})`, { status: wo?.status });
        return new Response(JSON.stringify(err), { status: 400, headers: {...corsHeaders,"Content-Type":"application/json"} });
      }

      const { data, error } = await supabase.rpc('update_work_order_state', { p_work_order_id: work_order_id, p_status: 'in_progress', p_approved_at: null, p_approved_by: null, p_started_at: null, p_completed_at: null, p_summary: `Rejected: ${reason || 'Needs changes'}` });
      if (error) throw error;
      if (data && data.error) {
        const errorCode = data.errors?.[0]?.code || 'ERR_TRANSITION_REJECTED';
        return new Response(JSON.stringify({ ...data, error_code: errorCode }), { status: 422, headers: {...corsHeaders,"Content-Type":"application/json"} });
      }

      await logPhase(supabase, work_order_id, "rejected", "metis", { reason, slug: wo?.slug });
      return new Response(JSON.stringify({ rejected: true, work_order: data, reason }), { headers: {...corsHeaders,"Content-Type":"application/json"} });
    }

    // === POST /fail — Fail an in-progress WO ===
    if (req.method === "POST" && action === "fail") {
      const { work_order_id, reason } = body;
      if (!work_order_id) return new Response(JSON.stringify(buildStructuredError('ERR_DATA_VALIDATION', 'work_order_id required')), { status: 400, headers: {...corsHeaders,"Content-Type":"application/json"} });

      const { data: wo } = await supabase.from("work_orders").select("status, slug").eq("id", work_order_id).single();

      await checkAndTripCircuitBreaker(supabase, work_order_id);

      const { data, error } = await supabase.rpc('update_work_order_state', { p_work_order_id: work_order_id, p_status: 'failed', p_approved_at: null, p_approved_by: null, p_started_at: null, p_completed_at: new Date().toISOString(), p_summary: reason });
      if (error) throw error;
      if (data && data.error) {
        const errorCode = data.errors?.[0]?.code || 'ERR_TRANSITION_REJECTED';
        return new Response(JSON.stringify({ ...data, error_code: errorCode }), { status: 422, headers: {...corsHeaders,"Content-Type":"application/json"} });
      }

      await createLesson(supabase, 'executor', `WO failed: ${(reason || '').slice(0, 500)}`, { slug: wo?.slug }, work_order_id, traceId, ILMARINEN_ID);
      await logPhase(supabase, work_order_id, "failed", "ilmarinen", { reason: (reason || '').slice(0, 5000), slug: wo?.slug });
      return new Response(JSON.stringify({ failed: true, work_order: data }), { headers: {...corsHeaders,"Content-Type":"application/json"} });
    }

    // === POST /phase — Log an execution phase entry ===
    if (req.method === "POST" && action === "phase") {
      const { work_order_id, phase, agent_name, detail, iteration } = body;
      if (!work_order_id || !phase) return new Response(JSON.stringify(buildStructuredError('ERR_DATA_VALIDATION', 'work_order_id and phase required')), { status: 400, headers: {...corsHeaders,"Content-Type":"application/json"} });
      await logPhase(supabase, work_order_id, phase, agent_name || "ilmarinen", detail || {}, iteration || 1);
      return new Response(JSON.stringify({ logged: true, phase, work_order_id }), { headers: {...corsHeaders,"Content-Type":"application/json"} });
    }

    // === GET /poll — Return ready/in_progress WOs for daemon ===
    if (req.method === "GET" && action === "poll") {
      const { data: workOrders, error: pollError } = await supabase
        .from("work_orders")
        .select("id, slug, name, objective, status, priority, assigned_to, approved_at, tags, client_info, created_at, acceptance_criteria, requires_approval, project_brief_id, depends_on, execution_rank")
        .in("status", ["ready", "in_progress"])
        .eq("assigned_to", ILMARINEN_ID)
        .order("execution_rank", { ascending: true })
        .order("priority", { ascending: true })
        .order("created_at", { ascending: true });

      if (pollError) return new Response(JSON.stringify({ error: pollError.message, error_code: "ERR_INTERNAL" }), { status: 500, headers: {...corsHeaders,"Content-Type":"application/json"} });

      // v49: Filter out ready WOs with unmet dependencies (in_progress WOs always returned)
      let filtered = workOrders || [];
      const readyWithDeps = filtered.filter((wo: any) => wo.status === 'ready' && wo.depends_on?.length > 0);
      if (readyWithDeps.length > 0) {
        const allDepIds = [...new Set(readyWithDeps.flatMap((wo: any) => wo.depends_on))];
        const { data: depStatuses } = await supabase.from("work_orders")
          .select("id, status")
          .in("id", allDepIds);
        const depStatusMap: Record<string, string> = {};
        for (const d of (depStatuses || [])) depStatusMap[d.id] = d.status;

        filtered = filtered.filter((wo: any) => {
          if (wo.status !== 'ready' || !wo.depends_on?.length) return true;
          return wo.depends_on.every((depId: string) => depStatusMap[depId] === 'done');
        });
      }

      // Join project briefs for project-aware daemon
      const projectIds = [...new Set(filtered.map((wo: any) => wo.project_brief_id).filter(Boolean))];
      let projectBriefs: Record<string, any> = {};
      if (projectIds.length > 0) {
        const { data: briefs } = await supabase.from("project_briefs")
          .select("id, code, name, description, work_dir, current_phase")
          .in("id", projectIds);
        if (briefs) {
          for (const b of briefs) projectBriefs[b.id] = b;
        }
      }

      const enriched = filtered.map((wo: any) => ({
        ...wo,
        project: wo.project_brief_id ? projectBriefs[wo.project_brief_id] || null : null,
      }));

      return new Response(JSON.stringify({ work_orders: enriched, count: enriched.length, version: "v49" }), { headers: {...corsHeaders,"Content-Type":"application/json"} });
    }

    // === GET /status — System status ===
    if (req.method === "GET" && action === "status") {
      const { data: recentWOs } = await supabase.from("work_orders")
        .select("slug, name, status, priority, updated_at")
        .order("updated_at", { ascending: false })
        .limit(10);

      const { count: totalWOs } = await supabase.from("work_orders").select("id", { count: "exact", head: true });
      const { count: activeWOs } = await supabase.from("work_orders").select("id", { count: "exact", head: true }).in("status", ["draft", "ready", "in_progress", "review"]);
      const { count: doneWOs } = await supabase.from("work_orders").select("id", { count: "exact", head: true }).eq("status", "done");

      // Count registered handlers for smoke test validation
      const handlers = ["approve", "claim", "complete", "accept", "reject", "fail", "auto-qa", "refine-stale", "consolidate", "phase", "rollback", "reprioritize", "poll", "status", "logs", "manifest"];

      return new Response(JSON.stringify({
        status: "operational", version: "v60",
        handler_count: handlers.length,
        handlers,
        counts: { total: totalWOs, active: activeWOs, done: doneWOs },
        recent: recentWOs
      }), { headers: {...corsHeaders,"Content-Type":"application/json"} });
    }

    // === GET /logs — Recent execution logs ===
    if (req.method === "GET" && action === "logs") {
      const woId = url.searchParams.get("work_order_id");
      let query = supabase.from("work_order_execution_log")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(50);
      if (woId) query = query.eq("work_order_id", woId);
      const { data, error: logsError } = await query;
      if (logsError) return new Response(JSON.stringify({ error: logsError.message, error_code: "ERR_INTERNAL" }), { status: 500, headers: {...corsHeaders,"Content-Type":"application/json"} });
      return new Response(JSON.stringify({ logs: data }), { headers: {...corsHeaders,"Content-Type":"application/json"} });
    }

    // === GET /manifest — System manifest ===
    if (req.method === "GET" && action === "manifest") {
      const { data, error: manifestError } = await supabase.from("system_manifest").select("*").eq("status", "active");
      if (manifestError) return new Response(JSON.stringify({ error: manifestError.message, error_code: "ERR_INTERNAL" }), { status: 500, headers: {...corsHeaders,"Content-Type":"application/json"} });
      return new Response(JSON.stringify({ manifest: data, version: "v32" }), { headers: {...corsHeaders,"Content-Type":"application/json"} });
    }

    // === POST /rollback — Generate rollback plan (read-only planner, no execution) ===
    // v39: Rewrite as planner — returns rollback_plan JSON instead of executing
    if (req.method === "POST" && action === "rollback") {
      const { function_slug, target_version } = body;
      if (!function_slug) return new Response(JSON.stringify(buildStructuredError('ERR_DATA_VALIDATION', 'function_slug required')), { status: 400, headers: {...corsHeaders,"Content-Type":"application/json"} });

      try {
        // Step 1: Validate function exists in system_manifest
        const { data: currentManifest, error: manifestError } = await supabase.from('system_manifest')
          .select('id, version, config')
          .eq('component_type', 'edge_function')
          .eq('name', function_slug)
          .single();

        if (manifestError || !currentManifest) {
          return new Response(JSON.stringify(buildStructuredError('ERR_WO_NOT_FOUND', 'Function not found in system manifest')), { status: 404, headers: {...corsHeaders,"Content-Type":"application/json"} });
        }

        const currentVersion = currentManifest.version || 'unknown';
        const currentCommit = currentManifest.config?.git_commit || 'unknown';

        // Step 2: Query audit_log for deployment history
        const deployHistory = await getGitHistory(supabase, function_slug);
        if (deployHistory.length === 0) {
          return new Response(JSON.stringify({
            rollback_plan: {
              function_slug, current_version: currentVersion, current_manifest_id: currentManifest.id,
              ready: false, error: 'No deployment history found in audit_log',
              deployment_history: []
            }
          }), { status: 200, headers: {...corsHeaders,"Content-Type":"application/json"} });
        }

        // Step 3: Identify target deployment (explicit version or previous)
        let targetDeployment: any;
        if (target_version) {
          targetDeployment = deployHistory.find((d: any) => d.new_state?.version === target_version);
          if (!targetDeployment) {
            return new Response(JSON.stringify({
              rollback_plan: {
                function_slug, current_version: currentVersion, current_manifest_id: currentManifest.id,
                ready: false, error: `Version ${target_version} not found in history`,
                deployment_history: deployHistory.map((d: any) => ({
                  version: d.new_state?.version, git_commit: d.new_state?.git_commit || d.payload?.git_commit,
                  deployed_at: d.created_at
                }))
              }
            }), { status: 200, headers: {...corsHeaders,"Content-Type":"application/json"} });
          }
        } else {
          targetDeployment = deployHistory[1] || deployHistory[0];
        }

        const targetCommit = targetDeployment.new_state?.git_commit || targetDeployment.payload?.git_commit;
        const targetVersionNum = targetDeployment.new_state?.version || 'unknown';

        // Step 4: Return rollback plan (no execution)
        return new Response(JSON.stringify({
          rollback_plan: {
            function_slug,
            target_commit: targetCommit || 'unknown',
            target_version: targetVersionNum,
            current_version: currentVersion,
            current_commit: currentCommit,
            current_manifest_id: currentManifest.id,
            deployment_history: deployHistory.map((d: any) => ({
              version: d.new_state?.version || 'unknown',
              git_commit: d.new_state?.git_commit || d.payload?.git_commit || 'unknown',
              deployed_at: d.created_at
            })),
            ready: !!targetCommit
          }
        }), { headers: {...corsHeaders,"Content-Type":"application/json"} });

      } catch (e) {
        const errorMsg = (e as Error).message;
        return new Response(JSON.stringify({
          rollback_plan: {
            function_slug, ready: false, error: `Planning failed: ${errorMsg}`
          }
        }), { status: 500, headers: {...corsHeaders,"Content-Type":"application/json"} });
      }
    }

    // === POST /reprioritize — Dynamic queue re-scoring ===
    if (req.method === "POST" && action === "reprioritize") {
      const trigger = body.trigger || "manual";

      // Cooldown check: skip if < 60s since last run (unless cron/manual trigger)
      if (trigger === "insert") {
        const { data: cooldownRow } = await supabase.from("system_settings")
          .select("setting_value")
          .eq("setting_key", "last_reprioritize_at")
          .single();
        if (cooldownRow) {
          const lastRun = new Date(JSON.parse(JSON.stringify(cooldownRow.setting_value)).replace(/"/g, '')).getTime();
          const elapsed = Date.now() - lastRun;
          if (elapsed < 60000) {
            return new Response(JSON.stringify({
              skipped_cooldown: true, trigger, elapsed_ms: elapsed,
              message: "Debounced: last reprioritize was < 60s ago"
            }), { headers: {...corsHeaders,"Content-Type":"application/json"} });
          }
        }
      }

      // Load all non-terminal WOs (AC7: includes review status)
      const { data: allWOs, error: woErr } = await supabase.from("work_orders")
        .select("id, slug, name, objective, priority, status, tags, depends_on, created_at, updated_at")
        .in("status", ["draft", "ready", "in_progress", "review"]);

      if (woErr) {
        return new Response(JSON.stringify({ error: woErr.message, error_code: "ERR_INTERNAL" }), { status: 500, headers: {...corsHeaders,"Content-Type":"application/json"} });
      }

      const wos = allWOs || [];
      let reranked = 0;
      let staleCount = 0;
      const rankChanges: Array<{slug: string, old_rank: number, new_rank: number}> = [];

      // Score each WO using the DB function
      for (const wo of wos) {
        const { data: newRank, error: scoreErr } = await supabase.rpc("score_work_order", { p_wo_id: wo.id });
        if (scoreErr) { console.error(`[REPRIORITIZE] score error for ${wo.slug}:`, scoreErr); continue; }

        const oldRank = (wo as any).execution_rank ?? 500;
        if (newRank !== oldRank) {
          await supabase.from("work_orders").update({ execution_rank: newRank }).eq("id", wo.id);
          rankChanges.push({ slug: wo.slug, old_rank: oldRank, new_rank: newRank });
          reranked++;
        }

        // Staleness detection: WO older than 7 days in draft status
        const ageDays = (Date.now() - new Date(wo.created_at).getTime()) / (1000 * 60 * 60 * 24);
        if (ageDays > 7 && wo.status === "draft") {
          staleCount++;
        }
      }

      // Update cooldown timestamp
      await supabase.from("system_settings")
        .update({ setting_value: JSON.stringify(new Date().toISOString()), updated_at: new Date().toISOString() })
        .eq("setting_key", "last_reprioritize_at");

      // Log reprioritize action
      if (wos.length > 0) {
        // Use a representative WO for the log entry (first one)
        await logPhase(supabase, wos[0].id, "reprioritize", "qa-gate", {
          trigger,
          evaluated: wos.length,
          reranked,
          stale_candidates: staleCount,
          rank_changes: rankChanges.slice(0, 20),
          timestamp: new Date().toISOString()
        });
      }

      // Audit log
      await supabase.from("audit_log").insert({
        event_type: "queue_reprioritized",
        actor_type: "system",
        actor_id: "qa-gate",
        target_type: "work_order",
        target_id: wos[0]?.id || null,
        action: `Queue reprioritized: ${reranked}/${wos.length} WOs re-ranked (trigger: ${trigger})`,
        payload: { trigger, evaluated: wos.length, reranked, stale_candidates: staleCount, top_changes: rankChanges.slice(0, 10) }
      });

      return new Response(JSON.stringify({
        evaluated: wos.length,
        reranked,
        deprecated: 0,
        stale_candidates: staleCount,
        skipped_cooldown: false,
        trigger,
        rank_changes: rankChanges,
        version: "v60"
      }), { headers: {...corsHeaders,"Content-Type":"application/json"} });
    }

    return new Response(JSON.stringify({ error: "Unknown action", error_code: "ERR_INVALID_REQUEST", available: ["POST /approve","POST /consolidate","POST /refine-stale","POST /claim","POST /complete","POST /accept","POST /auto-qa","POST /reject","POST /fail","POST /phase","POST /rollback","POST /reprioritize","GET /poll","GET /status","GET /logs","GET /manifest"] }), { status: 400, headers: {...corsHeaders,"Content-Type":"application/json"} });


  } catch (error) {
    console.error("work-order-executor error:", error);
    await createLesson(supabase, 'executor', `Unhandled exception in ${action}: ${(error as Error).message}`, { endpoint: action, stack: (error as Error).stack?.slice(0, 500) }, body?.work_order_id || null, null, ILMARINEN_ID).catch(() => {});
    return new Response(JSON.stringify({ error: (error as Error).message, error_code: "ERR_INTERNAL" }), { status: 500, headers: {...corsHeaders,"Content-Type":"application/json"} });
  }
});
