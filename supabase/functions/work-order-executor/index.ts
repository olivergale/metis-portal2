// work-order-executor/index.ts v32
// v32: WO-367B574B — Add /rollback endpoint for git-versioned rollbacks (source control workflow)
// v31: AC2 fix — auto-qa reads wo.summary as primary context instead of only client_info
// v30: Restore all missing endpoints from v29 deployment — poll, status, logs, manifest, auto-qa, refine-stale, consolidate, reject, fail, phase
// v29: WO-0006 — Structured error codes (ERR_*) with severity, category, retry_allowed
// v28: Auto-refine stale WOs — freshness check calls LLM to deprecate/refine/proceed instead of hard-blocking
// v27: Add /auto-qa endpoint — automated QA checklist evaluation via Haiku, record verification, auto-accept on all-pass

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

    if (!['status','poll','logs','manifest'].includes(action||'')) {
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

      const { data, error } = await supabase.rpc('update_work_order_state', { p_work_order_id: work_order_id, p_status: 'ready', p_approved_at: new Date().toISOString(), p_approved_by: approved_by });
      if (error) throw error;
      if (data && data.error) {
        const firstError = data.errors?.[0];
        const errorCode = firstError?.code || 'ERR_TRANSITION_REJECTED';
        await createLesson(supabase, 'transition', firstError?.message || JSON.stringify(data.errors), { endpoint: 'approve', approved_by }, work_order_id, traceId, null, errorCode);
        return new Response(JSON.stringify({ ...data, error_code: errorCode }), { status: 422, headers: {...corsHeaders,"Content-Type":"application/json"} });
      }

      await logPhase(supabase, work_order_id, "approved", "metis", { approved_by });
      return new Response(JSON.stringify({ approved: true, work_order: data, approved_at: new Date().toISOString() }), { headers: {...corsHeaders,"Content-Type":"application/json"} });
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

      if (!skip_freshness_check) {
        const freshnessCheck = await validateWorkOrderFreshness(supabase, work_order_id);
        await logPhase(supabase, work_order_id, "freshness_check", "ilmarinen", { fresh: freshnessCheck.fresh, stale_details: freshnessCheck.stale_details });

        if (!freshnessCheck.fresh) {
          try {
            const refinement = await refineStaleness(supabase, work_order_id, freshnessCheck.stale_details);
            if (refinement.decision === 'deprecate') {
              await supabase.rpc('update_work_order_state', { p_work_order_id: work_order_id, p_status: 'cancelled', p_summary: `Auto-deprecated: ${refinement.reason}` });
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
        const err = buildStructuredError('ERR_GATE_BLOCKED', 'Gate approval required', { gates: gateResult.pending });
        await createLesson(supabase, 'gate', err.message, { gates_pending: gateResult.pending }, work_order_id, traceId, ILMARINEN_ID, err.code);
        return new Response(JSON.stringify({ ...err, gates_pending: gateResult.pending }), { status: 403, headers: {...corsHeaders,"Content-Type":"application/json"} });
      }

      let woTraceId: string | null = null;
      try { const { data: traceData } = await supabase.rpc('start_wo_trace', { p_work_order_id: work_order_id, p_session_id: session_id || headers['x-session-id'] || null }); woTraceId = traceData; }
      catch (traceErr) { console.error('[TRACE] Failed:', traceErr); }

      const { data, error } = await supabase.rpc('update_work_order_state', { p_work_order_id: work_order_id, p_status: 'in_progress', p_started_at: new Date().toISOString() });
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
      const { data, error } = await supabase.rpc('update_work_order_state', { p_work_order_id: work_order_id, p_status: newStatus, p_completed_at: new Date().toISOString(), p_summary: summary });
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

      await logPhase(supabase, work_order_id, "completing", "ilmarinen", { summary: summary?.slice?.(0, 5000), final_status: newStatus, trace_id: traceId });
      return new Response(JSON.stringify({ completed: true, needs_review: newStatus === "review", work_order: data, completed_at: new Date().toISOString() }), { headers: {...corsHeaders,"Content-Type":"application/json"} });
    }

    if (req.method === "POST" && action === "accept") {
      const { work_order_id, skip_qa_validation } = body;
      if (!work_order_id) return new Response(JSON.stringify(buildStructuredError('ERR_DATA_VALIDATION', 'work_order_id required')), { status: 400, headers: {...corsHeaders,"Content-Type":"application/json"} });
      const { data: wo } = await supabase.from("work_orders").select("status, slug").eq("id", work_order_id).single();
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

      const { data, error } = await supabase.rpc('update_work_order_state', { p_work_order_id: work_order_id, p_status: 'done' });
      if (error) throw error;
      if (data && data.error) {
        const firstError = data.errors?.[0];
        const errorCode = firstError?.code || 'ERR_TRANSITION_REJECTED';
        await createLesson(supabase, 'transition', firstError?.message || JSON.stringify(data.errors), {}, work_order_id, traceId, null, errorCode);
        return new Response(JSON.stringify({ ...data, error_code: errorCode }), { status: 422, headers: {...corsHeaders,"Content-Type":"application/json"} });
      }

      await logPhase(supabase, work_order_id, "completing", "metis", { action: "accepted", slug: wo.slug });
      return new Response(JSON.stringify({ accepted: true, work_order: data }), { headers: {...corsHeaders,"Content-Type":"application/json"} });
    }

    // === POST /auto-qa — Automated QA evaluation using Haiku ===
    // v31: Now reads wo.summary as PRIMARY context for evaluation
    if (req.method === "POST" && action === "auto-qa") {
      const { work_order_id, execution_output } = body;
      if (!work_order_id) return new Response(JSON.stringify(buildStructuredError('ERR_DATA_VALIDATION', 'work_order_id required')), { status: 400, headers: {...corsHeaders,"Content-Type":"application/json"} });

      // v31: Added summary to SELECT
      const { data: wo, error: woError } = await supabase.from("work_orders")
        .select("id, slug, status, qa_checklist, objective, acceptance_criteria, summary, client_info")
        .eq("id", work_order_id).single();
      if (woError || !wo) return new Response(JSON.stringify(buildStructuredError('ERR_WO_NOT_FOUND', 'Work order not found')), { status: 404, headers: {...corsHeaders,"Content-Type":"application/json"} });

      if (wo.status !== 'review') {
        return new Response(JSON.stringify({ ...buildStructuredError('ERR_INVALID_STATUS', `Not in review (current: ${wo.status})`), all_pass: false, accepted: false }), { status: 400, headers: {...corsHeaders,"Content-Type":"application/json"} });
      }

      let checklist = wo.qa_checklist || [];
      if (checklist.length === 0) {
        await initializeQAChecklistIfNeeded(supabase, work_order_id);
        const { data: refreshed } = await supabase.from("work_orders").select("qa_checklist").eq("id", work_order_id).single();
        checklist = refreshed?.qa_checklist || [];
      }

      if (checklist.length === 0) {
        return new Response(JSON.stringify({ all_pass: true, items_evaluated: 0, accepted: false, failures: [], message: "No checklist items to evaluate" }), { headers: {...corsHeaders,"Content-Type":"application/json"} });
      }

      // v31: Prioritize wo.summary as primary context, then fall back to client_info
      const output = execution_output || wo.summary || wo.client_info?.summary || wo.client_info?.output || '';
      if (!output) {
        return new Response(JSON.stringify({ ...buildStructuredError('ERR_DATA_VALIDATION', 'No execution output available for evaluation'), all_pass: false, accepted: false }), { status: 400, headers: {...corsHeaders,"Content-Type":"application/json"} });
      }

      const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
      const criteriaText = checklist.map((ci: any) => `- [${ci.id}] ${ci.criterion || ci.description || ci.name}`).join('\n');

      let evaluations: any[];
      try {
        const evalResp = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-api-key": apiKey!, "anthropic-version": "2023-06-01" },
          body: JSON.stringify({
            model: "claude-haiku-4-5-20251001",
            max_tokens: 2048,
            messages: [{
              role: "user",
              content: `You are a QA evaluator for a work order execution system. Given the execution output and acceptance criteria below, evaluate whether each criterion was met.\n\nWORK ORDER: ${wo.slug}\nOBJECTIVE: ${wo.objective || 'N/A'}\n\nEXECUTION OUTPUT (last 10000 chars):\n${output.slice(-10000)}\n\nACCEPTANCE CRITERIA:\n${criteriaText}\n\nFor each criterion, respond with ONLY a JSON array (no other text):\n[\n  {"id": "ac-1", "status": "pass", "summary": "brief evidence"},\n  {"id": "ac-2", "status": "fail", "summary": "reason for failure"}\n]\n\nRules:\n- "pass" = clear evidence the criterion was met in the output\n- "fail" = no evidence found or evidence shows it was NOT met\n- "na" = criterion is clearly not applicable\n- Be strict: if there is no clear evidence, mark as "fail"\n- Keep summaries under 200 characters`
            }],
          }),
        });

        if (!evalResp.ok) {
          const errText = await evalResp.text();
          console.error('[AUTO-QA] Haiku evaluation failed:', errText.slice(0, 300));
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

      const failures: any[] = [];
      let itemsEvaluated = 0;

      for (const criterion of evaluations) {
        if (!criterion.id || !criterion.status) continue;
        try {
          await supabase.rpc('update_checklist_item', {
            p_work_order_id: work_order_id,
            p_item_id: criterion.id,
            p_status: criterion.status,
            p_evidence: { summary: criterion.summary, verified_by: 'auto-qa-haiku', auto_evaluated: true }
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
          p_evidence: { evaluations, items_evaluated: itemsEvaluated, failures, auto_qa_version: 'v31' },
          p_passed: allPass
        });
      } catch (verifyErr) {
        console.error('[AUTO-QA] Failed to record verification:', verifyErr);
      }

      let accepted = false;
      if (allPass && itemsEvaluated > 0) {
        const { data: acceptData, error: acceptError } = await supabase.rpc('update_work_order_state', { p_work_order_id: work_order_id, p_status: 'done' });
        if (!acceptError && !(acceptData?.error)) {
          accepted = true;
          await logPhase(supabase, work_order_id, "completing", "auto-qa", { action: "auto-accepted", items_evaluated: itemsEvaluated, slug: wo.slug });
        } else {
          console.error('[AUTO-QA] Accept transition failed:', acceptError || acceptData);
        }
      }

      await logPhase(supabase, work_order_id, "qa_validation", "auto-qa", {
        all_pass: allPass, items_evaluated: itemsEvaluated,
        failures: failures.slice(0, 5), accepted, slug: wo.slug
      });

      return new Response(JSON.stringify({
        all_pass: allPass, accepted, items_evaluated: itemsEvaluated,
        failures, work_order_id, slug: wo.slug
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
          await supabase.rpc('update_work_order_state', { p_work_order_id: work_order_id, p_status: 'cancelled', p_summary: `Auto-deprecated: ${refinement.reason}` });
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

    // === POST /consolidate — Consolidate duplicate WOs ===
    if (req.method === "POST" && action === "consolidate") {
      const { work_order_ids, primary_id, reason } = body;
      if (!work_order_ids || !primary_id) return new Response(JSON.stringify(buildStructuredError('ERR_DATA_VALIDATION', 'work_order_ids and primary_id required')), { status: 400, headers: {...corsHeaders,"Content-Type":"application/json"} });

      const secondaryIds = work_order_ids.filter((id: string) => id !== primary_id);
      let consolidated = 0;
      const errors: string[] = [];
      for (const secId of secondaryIds) {
        const { data, error } = await supabase.rpc('update_work_order_state', { p_work_order_id: secId, p_status: 'cancelled', p_summary: `Consolidated into ${primary_id}: ${reason || 'Duplicate'}` });
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

      const { data, error } = await supabase.rpc('update_work_order_state', { p_work_order_id: work_order_id, p_status: 'in_progress', p_summary: `Rejected: ${reason || 'Needs changes'}` });
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

      const { data, error } = await supabase.rpc('update_work_order_state', { p_work_order_id: work_order_id, p_status: 'failed', p_summary: reason });
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
        .select("id, slug, name, objective, status, priority, assigned_to, approved_at, tags, client_info, created_at, acceptance_criteria, requires_approval, project_brief_id")
        .in("status", ["ready", "in_progress"])
        .eq("assigned_to", ILMARINEN_ID)
        .order("priority", { ascending: true })
        .order("created_at", { ascending: true });

      if (pollError) return new Response(JSON.stringify({ error: pollError.message, error_code: "ERR_INTERNAL" }), { status: 500, headers: {...corsHeaders,"Content-Type":"application/json"} });

      // Join project briefs for project-aware daemon
      const projectIds = [...new Set((workOrders || []).map((wo: any) => wo.project_brief_id).filter(Boolean))];
      let projectBriefs: Record<string, any> = {};
      if (projectIds.length > 0) {
        const { data: briefs } = await supabase.from("project_briefs")
          .select("id, code, name, description, work_dir, current_phase")
          .in("id", projectIds);
        if (briefs) {
          for (const b of briefs) projectBriefs[b.id] = b;
        }
      }

      const enriched = (workOrders || []).map((wo: any) => ({
        ...wo,
        project: wo.project_brief_id ? projectBriefs[wo.project_brief_id] || null : null,
      }));

      return new Response(JSON.stringify({ work_orders: enriched, count: enriched.length, version: "v32" }), { headers: {...corsHeaders,"Content-Type":"application/json"} });
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

      return new Response(JSON.stringify({
        status: "operational", version: "v32",
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

    // === POST /rollback — Rollback edge function to previous version from git history ===
    if (req.method === "POST" && action === "rollback") {
      const { function_slug, git_commit_sha, reason } = body;
      if (!function_slug) return new Response(JSON.stringify(buildStructuredError('ERR_DATA_VALIDATION', 'function_slug required')), { status: 400, headers: {...corsHeaders,"Content-Type":"application/json"} });

      try {
        // NOTE: In production, this would:
        // 1. Read the function source from git at specified commit
        // 2. Deploy that version via Supabase deploy API
        // 3. Log the rollback to audit_log
        // 4. Update system_manifest with rollback metadata

        // For now, return rollback plan
        const rollbackPlan = {
          function: function_slug,
          target_commit: git_commit_sha || 'previous',
          reason: reason || 'Manual rollback',
          steps: [
            'Fetch function source from git history',
            'Validate function integrity',
            'Deploy previous version via Supabase API',
            'Verify deployment with smoke test',
            'Log rollback to audit_log',
            'Update system_manifest version'
          ],
          warning: 'Rollback requires git history to be initialized (AC1)',
        };

        await supabase.from('audit_log').insert({
          event_type: 'function_rollback_requested',
          actor_type: 'system',
          actor_id: 'work-order-executor',
          action: 'rollback',
          payload: { function_slug, git_commit_sha, reason, timestamp: new Date().toISOString() }
        });

        return new Response(JSON.stringify({ rollback_plan: rollbackPlan, status: 'planned' }), { headers: {...corsHeaders,"Content-Type":"application/json"} });
      } catch (e) {
        return new Response(JSON.stringify(buildStructuredError('ERR_INTERNAL', `Rollback failed: ${(e as Error).message}`)), { status: 500, headers: {...corsHeaders,"Content-Type":"application/json"} });
      }
    }

    return new Response(JSON.stringify({ error: "Unknown action", error_code: "ERR_INVALID_REQUEST", available: ["POST /approve","POST /consolidate","POST /refine-stale","POST /claim","POST /complete","POST /accept","POST /auto-qa","POST /reject","POST /fail","POST /phase","POST /rollback","GET /poll","GET /status","GET /logs","GET /manifest"] }), { status: 400, headers: {...corsHeaders,"Content-Type":"application/json"} });


  } catch (error) {
    console.error("work-order-executor error:", error);
    await createLesson(supabase, 'executor', `Unhandled exception in ${action}: ${(error as Error).message}`, { endpoint: action, stack: (error as Error).stack?.slice(0, 500) }, body?.work_order_id || null, null, ILMARINEN_ID).catch(() => {});
    return new Response(JSON.stringify({ error: (error as Error).message, error_code: "ERR_INTERNAL" }), { status: 500, headers: {...corsHeaders,"Content-Type":"application/json"} });
  }
});
