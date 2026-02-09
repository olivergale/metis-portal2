import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.39.3';
import Anthropic from 'https://esm.sh/@anthropic-ai/sdk@0.30.1';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// Valid categories per database constraint
const VALID_CATEGORIES = [
  'state_consistency',
  'acceptance_criteria',
  'acceptance_criterion',
  'anomaly',
  'security',
  'completeness',
  'execution_log',
  'execution_trail',
  'completion_summary',
  'qa_checklist',
  'qa_checklist_item'
] as const;

const VALID_FINDING_TYPES = ['pass', 'fail', 'warning', 'info', 'na'] as const;

interface QAFinding {
  id?: string;
  finding_type: typeof VALID_FINDING_TYPES[number];
  category: typeof VALID_CATEGORIES[number];
  description: string;
  evidence: any;
  checklist_item_id?: string;
  error_code?: string;
}

interface EvidenceRequest {
  finding_id: string;
  question: string;
  required_evidence_type: string;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const { work_order_id, agent_id, findings, evidence_requests } = await req.json();

    if (!work_order_id) {
      return new Response(
        JSON.stringify({ error: 'work_order_id is required' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const anthropicKey = Deno.env.get('ANTHROPIC_API_KEY')!;

    const supabase = createClient(supabaseUrl, supabaseKey);
    const anthropic = new Anthropic({ apiKey: anthropicKey });

    // Get QA agent info
    const qaAgentId = agent_id || 'a53f20af-69e3-4768-99d1-72be21185af4';
    const { data: qaAgent } = await supabase
      .from('agents')
      .select('*')
      .eq('id', qaAgentId)
      .single();

    if (!qaAgent) {
      return new Response(
        JSON.stringify({ error: 'QA agent not found' }),
        { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Get work order details
    const { data: wo, error: woError } = await supabase
      .from('work_orders')
      .select('*, qa_checklist')
      .eq('id', work_order_id)
      .single();

    if (woError || !wo) {
      return new Response(
        JSON.stringify({ error: 'Work order not found', details: woError }),
        { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Get execution log for evidence
    const { data: execLog } = await supabase
      .from('work_order_execution_log')
      .select('*')
      .eq('work_order_id', work_order_id)
      .order('created_at', { ascending: false })
      .limit(50);

    // Handle evidence requests if provided
    if (evidence_requests && evidence_requests.length > 0) {
      const responses = [];
      for (const request of evidence_requests) {
        const { data: finding } = await supabase
          .from('qa_findings')
          .select('*')
          .eq('id', request.finding_id)
          .single();

        if (!finding) continue;

        // Use Claude to analyze and respond to evidence request
        const prompt = `You are a QA agent reviewing a work order. A finding has been flagged:

Finding: ${finding.description}
Category: ${finding.category}
Severity: ${finding.finding_type}

Evidence request: ${request.question}
Required evidence type: ${request.required_evidence_type}

Execution log context:
${JSON.stringify(execLog?.slice(0, 10), null, 2)}

Work order context:
- Status: ${wo.status}
- Objective: ${wo.objective}
- Summary: ${wo.summary}

Provide a structured response with:
1. Evidence found (yes/no)
2. Details of the evidence
3. Whether this satisfies the finding or if it should be escalated

Respond in JSON format.`;

        const message = await anthropic.messages.create({
          model: 'claude-sonnet-4-5-20250929',
          max_tokens: 2000,
          messages: [{ role: 'user', content: prompt }]
        });

        const responseText = message.content[0].type === 'text' ? message.content[0].text : '';
        let parsedResponse;
        try {
          parsedResponse = JSON.parse(responseText);
        } catch {
          parsedResponse = { raw_response: responseText };
        }

        responses.push({
          finding_id: request.finding_id,
          request: request.question,
          response: parsedResponse
        });

        // Update finding with evidence response
        await supabase
          .from('qa_findings')
          .update({
            evidence: {
              ...finding.evidence,
              evidence_response: parsedResponse,
              evidence_requested_at: new Date().toISOString()
            }
          })
          .eq('id', request.finding_id);

        // Log to audit_log
        await supabase.from('audit_log').insert({
          event_type: 'qa_evidence_requested',
          actor_type: 'agent',
          actor_id: qaAgentId,
          target_type: 'qa_finding',
          target_id: request.finding_id,
          action: 'evidence_request',
          payload: { question: request.question, response: parsedResponse },
          work_order_id: work_order_id
        });
      }

      return new Response(
        JSON.stringify({
          success: true,
          evidence_responses: responses,
          message: `Processed ${responses.length} evidence requests`
        }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Process findings if provided
    if (findings && findings.length > 0) {
      const insertedFindings = [];
      const errors = [];

      for (const finding of findings) {
        // Validate category
        const category = finding.category || 'anomaly';
        if (!VALID_CATEGORIES.includes(category as any)) {
          errors.push({ finding, error: `Invalid category: ${category}. Must be one of: ${VALID_CATEGORIES.join(', ')}` });
          continue;
        }

        const { data: inserted, error: insertError } = await supabase
          .from('qa_findings')
          .insert({
            work_order_id: work_order_id,
            finding_type: finding.finding_type || 'warning',
            category: category,
            description: finding.description,
            evidence: finding.evidence || {},
            agent_id: qaAgentId,
            checklist_item_id: finding.checklist_item_id,
            error_code: finding.error_code
          })
          .select()
          .single();

        if (insertError) {
          errors.push({ finding, error: insertError.message });
        } else if (inserted) {
          insertedFindings.push(inserted);

          // Log to audit_log
          await supabase.from('audit_log').insert({
            event_type: 'qa_finding_created',
            actor_type: 'agent',
            actor_id: qaAgentId,
            target_type: 'qa_finding',
            target_id: inserted.id,
            action: 'create',
            payload: finding,
            work_order_id: work_order_id
          });
        }
      }

      return new Response(
        JSON.stringify({
          success: true,
          findings: insertedFindings,
          errors: errors.length > 0 ? errors : undefined,
          message: `Created ${insertedFindings.length} findings${errors.length > 0 ? ` (${errors.length} errors)` : ''}`
        }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Default: Run QA evaluation using Claude
    const checklistContext = wo.qa_checklist || [];
    const prompt = `You are a QA agent reviewing work order completion.

Work Order: ${wo.slug}
Objective: ${wo.objective}
Status: ${wo.status}
Summary: ${wo.summary || 'N/A'}

QA Checklist:
${JSON.stringify(checklistContext, null, 2)}

Recent execution log (last 10 entries):
${JSON.stringify(execLog?.slice(0, 10), null, 2)}

Evaluate this work order and identify any issues. For each issue found, provide:
1. finding_type: "error", "warning", or "info"
2. category: one of ${VALID_CATEGORIES.join(', ')}
3. description: clear description of the issue
4. evidence: relevant evidence from logs or checklist
5. checklist_item_id: if related to a specific checklist item

Respond with a JSON array of findings. If no issues, return empty array.`;

    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-5-20250929',
      max_tokens: 4000,
      messages: [{ role: 'user', content: prompt }]
    });

    const responseText = message.content[0].type === 'text' ? message.content[0].text : '';
    let evaluatedFindings = [];
    try {
      const jsonMatch = responseText.match(/\[.*\]/s);
      if (jsonMatch) {
        evaluatedFindings = JSON.parse(jsonMatch[0]);
      }
    } catch (e) {
      console.error('Failed to parse Claude response:', e);
    }

    // Insert evaluated findings
    const insertedFindings = [];
    const errors = [];

    for (const finding of evaluatedFindings) {
      const category = finding.category || 'anomaly';
      if (!VALID_CATEGORIES.includes(category as any)) {
        errors.push({ finding, error: `Invalid category: ${category}` });
        continue;
      }

      const { data: inserted } = await supabase
        .from('qa_findings')
        .insert({
          work_order_id: work_order_id,
          finding_type: finding.finding_type || 'warning',
          category: category,
          description: finding.description,
          evidence: finding.evidence || {},
          agent_id: qaAgentId,
          checklist_item_id: finding.checklist_item_id,
          error_code: finding.error_code
        })
        .select()
        .single();

      if (inserted) {
        insertedFindings.push(inserted);

        // Log to audit_log
        await supabase.from('audit_log').insert({
          event_type: 'qa_finding_created',
          actor_type: 'agent',
          actor_id: qaAgentId,
          target_type: 'qa_finding',
          target_id: inserted.id,
          action: 'create',
          payload: finding,
          work_order_id: work_order_id
        });
      }
    }

    // Update work order last_qa_run_at
    await supabase
      .from('work_orders')
      .update({ last_qa_run_at: new Date().toISOString() })
      .eq('id', work_order_id);

    // Log QA review completion
    await supabase.from('audit_log').insert({
      event_type: 'qa_review_completed',
      actor_type: 'agent',
      actor_id: qaAgentId,
      target_type: 'work_order',
      target_id: work_order_id,
      action: 'qa_review',
      payload: {
        findings_count: insertedFindings.length,
        has_errors: insertedFindings.some(f => f.finding_type === 'error'),
        has_warnings: insertedFindings.some(f => f.finding_type === 'warning')
      },
      work_order_id: work_order_id
    });

    return new Response(
      JSON.stringify({
        success: true,
        findings: insertedFindings,
        errors: errors.length > 0 ? errors : undefined,
        evaluation: {
          total_findings: insertedFindings.length,
          errors: insertedFindings.filter(f => f.finding_type === 'error').length,
          warnings: insertedFindings.filter(f => f.finding_type === 'warning').length,
          info: insertedFindings.filter(f => f.finding_type === 'info').length
        },
        message: 'QA review completed'
      }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error) {
    console.error('QA review error:', error);
    return new Response(
      JSON.stringify({ error: error.message, stack: error.stack }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
