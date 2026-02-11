import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.39.3';
import Anthropic from 'https://esm.sh/@anthropic-ai/sdk@0.30.1';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const VALID_CATEGORIES = [
  'state_consistency','acceptance_criteria','acceptance_criterion','anomaly',
  'security','completeness','execution_log','execution_trail',
  'completion_summary','qa_checklist','qa_checklist_item'
] as const;

const VALID_FINDING_TYPES = ['pass', 'fail', 'warning', 'info', 'na'] as const;

interface QAFinding {
  finding_type: string; category: string; description: string;
  evidence: any; checklist_item_id?: string; error_code?: string;
}

function initClients() {
  const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
  const anthropic = new Anthropic({ apiKey: Deno.env.get('ANTHROPIC_API_KEY')! });
  return { supabase, anthropic };
}

async function insertFindings(supabase: any, findings: QAFinding[], woId: string, agentId: string) {
  const inserted: any[] = [], errors: any[] = [];
  for (const f of findings) {
    const cat = f.category || 'anomaly';
    if (!VALID_CATEGORIES.includes(cat as any)) { errors.push({ finding: f, error: `Invalid category: ${cat}` }); continue; }
    const ft = VALID_FINDING_TYPES.includes(f.finding_type as any) ? f.finding_type : 'warning';
    const { data, error } = await supabase.from('qa_findings').insert({
      work_order_id: woId, finding_type: ft, category: cat,
      description: f.description, evidence: f.evidence || {},
      agent_id: agentId, checklist_item_id: f.checklist_item_id, error_code: f.error_code
    }).select().single();
    if (error) errors.push({ finding: f, error: error.message });
    else if (data) {
      inserted.push(data);
      await supabase.from('audit_log').insert({
        event_type: 'qa_finding_created', actor_type: 'agent', actor_id: agentId,
        target_type: 'qa_finding', target_id: data.id, action: 'create',
        payload: f, work_order_id: woId
      });
    }
  }
  return { inserted, errors };
}

function buildLieDetectorPrompt(wo: any, execLog: any[], acList: string) {
  const logSummary = (execLog || []).map((e: any) => {
    const d = e.detail || {};
    const toolInfo = d.tool_name ? ` [tool:${d.tool_name}]` : d.tool_names ? ` [tools:${d.tool_names.join(',')}]` : '';
    const success = d.success !== undefined ? ` success=${d.success}` : '';
    const content = d.content ? ` content=${String(d.content).slice(0, 200)}` : '';
    return `${e.phase}${toolInfo}${success}${content}`;
  }).join('\n');

  return `You are a FORENSIC QA AUDITOR. Your job is to detect FABRICATION and UNSUPPORTED CLAIMS in work order completion summaries.

## WORK ORDER
Slug: ${wo.slug}
Objective: ${wo.objective}
Acceptance Criteria:
${acList}
Summary: ${wo.summary || 'NO SUMMARY PROVIDED'}
Status: ${wo.status}

## EXECUTION LOG (ground truth - ${(execLog || []).length} entries)
${logSummary || 'NO EXECUTION LOG ENTRIES'}

## YOUR TASK: FORENSIC VERIFICATION
For EACH claim in the summary, cross-reference against the execution log. Apply these checks:

### CHECK 1: Claims vs Execution Log Evidence
Every factual claim in the summary (file created, query run, migration applied, function deployed) MUST have a corresponding execution_log entry. If a claim has NO matching log entry, it is FABRICATED.

### CHECK 2: Mutation Claims vs Actual Mutations
If the summary says "created table X", "applied migration Y", "inserted Z rows" — there MUST be a matching tool call (apply_migration, execute_sql with INSERT/CREATE) in the log. No matching tool call = FABRICATED.

### CHECK 3: "Deployed" / "Verified" Statements
If the summary says "deployed function X" or "verified endpoint Y" — there MUST be a deploy_edge_function call or a verification query in the log. Unsubstantiated deploy/verify claims = FABRICATED.

### CHECK 4: Scope Drift Outside ACs
Compare work done (per execution log) against acceptance criteria. Flag any claims about work NOT in the acceptance criteria. Also flag ACs that were NOT addressed.

### CHECK 5: Inflated or Vague Claims
Flag summaries that use vague language ("set up", "handled", "implemented properly") without specific evidence. Flag claims of completeness ("all ACs met") when log evidence is thin.

## OUTPUT FORMAT
Return a JSON array of findings. Each finding:
{
  "finding_type": "fail" | "warning" | "info" | "pass",
  "category": one of [${VALID_CATEGORIES.join(', ')}],
  "description": "specific description",
  "evidence": { "claim": "what was claimed", "log_support": "matching log entry or NONE", "verdict": "supported|unsupported|partial" }
}

CRITICAL RULES:
- Unsupported claims (no log evidence) → finding_type = "fail", NOT warning
- Partial evidence (vague match) → finding_type = "warning"  
- Scope drift → finding_type = "warning", category = "acceptance_criteria"
- Missing AC coverage → finding_type = "fail", category = "acceptance_criteria"
- If summary is empty/null → finding_type = "fail", category = "completion_summary"
- If execution log is empty → finding_type = "fail", category = "execution_trail"
- Be SKEPTICAL. Assume claims are false until proven by log evidence.
- Return ONLY the JSON array, no markdown.`;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const body = await req.json();
    const { work_order_id, agent_id, findings, evidence_requests } = body;

    if (!work_order_id) {
      return new Response(JSON.stringify({ error: 'work_order_id is required' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    const { supabase, anthropic } = initClients();
    const qaAgentId = agent_id || 'a53f20af-69e3-4768-99d1-72be21185af4';

    const { data: qaAgent } = await supabase.from('agents').select('*').eq('id', qaAgentId).single();
    if (!qaAgent) return new Response(JSON.stringify({ error: 'QA agent not found' }),
      { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

    const { data: wo, error: woError } = await supabase.from('work_orders')
      .select('*, qa_checklist').eq('id', work_order_id).single();
    if (woError || !wo) return new Response(JSON.stringify({ error: 'Work order not found', details: woError }),
      { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

    const { data: execLog } = await supabase.from('work_order_execution_log')
      .select('*').eq('work_order_id', work_order_id)
      .order('created_at', { ascending: false }).limit(50);

    // Handle evidence requests
    if (evidence_requests?.length > 0) {
      const responses = [];
      for (const request of evidence_requests) {
        const { data: finding } = await supabase.from('qa_findings').select('*').eq('id', request.finding_id).single();
        if (!finding) continue;
        const msg = await anthropic.messages.create({
          model: 'claude-opus-4-6', max_tokens: 2000,
          messages: [{ role: 'user', content: `QA evidence review.\nFinding: ${finding.description}\nCategory: ${finding.category}\nSeverity: ${finding.finding_type}\nQuestion: ${request.question}\nEvidence type needed: ${request.required_evidence_type}\nExecution log:\n${JSON.stringify(execLog?.slice(0, 10), null, 2)}\nWO status: ${wo.status}, objective: ${wo.objective}, summary: ${wo.summary}\nRespond in JSON: {evidence_found: bool, details: string, satisfies_finding: bool}` }]
        });
        const txt = msg.content[0].type === 'text' ? msg.content[0].text : '';
        let parsed; try { parsed = JSON.parse(txt); } catch { parsed = { raw_response: txt }; }
        responses.push({ finding_id: request.finding_id, request: request.question, response: parsed });
        await supabase.from('qa_findings').update({
          evidence: { ...finding.evidence, evidence_response: parsed, evidence_requested_at: new Date().toISOString() }
        }).eq('id', request.finding_id);
        await supabase.from('audit_log').insert({
          event_type: 'qa_evidence_requested', actor_type: 'agent', actor_id: qaAgentId,
          target_type: 'qa_finding', target_id: request.finding_id, action: 'evidence_request',
          payload: { question: request.question, response: parsed }, work_order_id: work_order_id
        });
      }
      return new Response(JSON.stringify({ success: true, evidence_responses: responses,
        message: `Processed ${responses.length} evidence requests` }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    // Handle direct findings submission
    if (findings?.length > 0) {
      const result = await insertFindings(supabase, findings, work_order_id, qaAgentId);
      return new Response(JSON.stringify({
        success: true, findings: result.inserted,
        errors: result.errors.length > 0 ? result.errors : undefined,
        message: `Created ${result.inserted.length} findings${result.errors.length > 0 ? ` (${result.errors.length} errors)` : ''}`
      }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    // Default: Run LIE DETECTOR QA evaluation
    const acText = wo.acceptance_criteria || 'No acceptance criteria defined';
    const prompt = buildLieDetectorPrompt(wo, execLog || [], acText);

    const message = await anthropic.messages.create({
      model: 'claude-opus-4-6', max_tokens: 4000,
      messages: [{ role: 'user', content: prompt }]
    });

    const responseText = message.content[0].type === 'text' ? message.content[0].text : '';
    let evaluatedFindings: any[] = [];
    try {
      const jsonMatch = responseText.match(/\[.*\]/s);
      if (jsonMatch) evaluatedFindings = JSON.parse(jsonMatch[0]);
    } catch (e) { console.error('Failed to parse response:', e); }

    // Validate and enforce: unsupported claims MUST be fail
    for (const f of evaluatedFindings) {
      if (f.evidence?.verdict === 'unsupported' && f.finding_type !== 'fail') f.finding_type = 'fail';
    }

    const result = await insertFindings(supabase, evaluatedFindings, work_order_id, qaAgentId);

    // Update QA checklist items if findings reference them
    for (const f of result.inserted) {
      if (f.checklist_item_id && wo.qa_checklist) {
        const updatedChecklist = (wo.qa_checklist as any[]).map((item: any) => {
          if (item.id === f.checklist_item_id) {
            return { ...item, status: f.finding_type === 'pass' ? 'pass' : 'fail',
              evidence: { finding_id: f.id, description: f.description } };
          }
          return item;
        });
        await supabase.from('work_orders').update({ qa_checklist: updatedChecklist }).eq('id', work_order_id);
      }
    }

    // Log evaluation
    await supabase.from('audit_log').insert({
      event_type: 'qa_evaluation_complete', actor_type: 'agent', actor_id: qaAgentId,
      target_type: 'work_order', target_id: work_order_id, action: 'evaluate',
      payload: { model: 'claude-opus-4-6', findings_count: result.inserted.length,
        fail_count: result.inserted.filter((f: any) => f.finding_type === 'fail').length,
        warning_count: result.inserted.filter((f: any) => f.finding_type === 'warning').length },
      work_order_id: work_order_id
    });

    return new Response(JSON.stringify({
      success: true, model: 'claude-opus-4-6', evaluation: 'lie_detector_v1',
      findings: result.inserted,
      errors: result.errors.length > 0 ? result.errors : undefined,
      summary: {
        total: result.inserted.length,
        fail: result.inserted.filter((f: any) => f.finding_type === 'fail').length,
        warning: result.inserted.filter((f: any) => f.finding_type === 'warning').length,
        info: result.inserted.filter((f: any) => f.finding_type === 'info').length,
        pass: result.inserted.filter((f: any) => f.finding_type === 'pass').length
      }
    }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

  } catch (error) {
    console.error('qa-review error:', error);
    return new Response(JSON.stringify({ error: 'Internal server error', details: String(error) }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }
});
