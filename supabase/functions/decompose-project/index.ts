// decompose-project/index.ts v1
// Phase 5 WO-2: WO Decomposition Engine
// Reads project docs after generation, uses Claude to decompose into 3-10 sequential work orders
// Each WO is linked to the project via project_brief_id

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import Anthropic from "npm:@anthropic-ai/sdk@0.39.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function respond(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

const DECOMPOSITION_PROMPT = `You are a senior software architect decomposing a project into sequential work orders for an AI agent to execute.

Given the project documentation below, create 3-10 work orders that together deliver the complete project. Each work order should:

1. Be completable in a single agent session (30-60 min of focused work)
2. Have a clear, specific objective (not vague)
3. Have concrete acceptance criteria
4. Be sequenced logically (foundations first, then features, then polish)
5. Include the right dependencies

Common patterns:
- WO 1: Project setup (repo init, base config, DB schema)
- WO 2-N: Feature implementation (one feature per WO)
- WO N-1: Integration & testing
- WO N: Documentation & deployment

Return ONLY a JSON array of objects with these fields:
- name: string (short descriptive name, under 80 chars)
- objective: string (detailed description of what to build)
- acceptance_criteria: string (bullet list of what "done" looks like)
- sequence: number (1-based order)
- depends_on: number[] (sequence numbers this WO depends on, empty for first WO)
- priority: string (one of: p0_critical, p1_high, p2_medium, p3_low)
- estimated_complexity: string (one of: trivial, simple, moderate, complex)
- tags: string[] (relevant tags like "setup", "backend", "frontend", "api", "testing", "deployment")

No markdown, no explanation. Just the JSON array.`;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return respond({ error: "POST only" }, 405);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const anthropicKey = Deno.env.get("ANTHROPIC_API_KEY")!;

  const supabase = createClient(supabaseUrl, supabaseKey);
  const anthropic = new Anthropic({ apiKey: anthropicKey });

  try {
    const body = await req.json();
    const { project_brief_id } = body;

    if (!project_brief_id) {
      return respond({ error: "project_brief_id required" }, 400);
    }

    // Get project brief
    const { data: project, error: projErr } = await supabase
      .from('project_briefs')
      .select('id, code, name, summary')
      .eq('id', project_brief_id)
      .single();

    if (projErr || !project) {
      return respond({ error: "Project not found" }, 404);
    }

    // Get project documents (the 5 key ones for decomposition)
    const keyDocTypes = ['implementation_plan', 'prd', 'tech_stack', 'backend_structure', 'security_model'];
    const { data: docs, error: docsErr } = await supabase
      .from('project_documents')
      .select('doc_type, title, content')
      .eq('project_id', project_brief_id)
      .in('doc_type', keyDocTypes);

    if (docsErr) {
      return respond({ error: `Failed to read docs: ${docsErr.message}` }, 500);
    }

    if (!docs || docs.length === 0) {
      return respond({ error: "No project documents found. Generate docs first." }, 400);
    }

    // Build context from docs
    const docsContext = docs.map((d: any) =>
      `## ${d.title} (${d.doc_type})\n\n${d.content}`
    ).join('\n\n---\n\n');

    // Call Claude to decompose
    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 4096,
      system: DECOMPOSITION_PROMPT,
      messages: [{
        role: "user",
        content: `Project: ${project.name}\nCode: ${project.code}\nSummary: ${project.summary || 'No summary'}\n\n${docsContext}`
      }],
    });

    const responseText = response.content[0].type === 'text' ? response.content[0].text : '[]';

    // Parse the JSON response
    let workOrderSpecs: any[];
    try {
      const cleaned = responseText.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
      workOrderSpecs = JSON.parse(cleaned);
    } catch (parseErr) {
      console.error('[DECOMPOSE] Failed to parse LLM response:', responseText.slice(0, 500));
      return respond({ error: "Failed to parse decomposition response", raw: responseText.slice(0, 1000) }, 500);
    }

    if (!Array.isArray(workOrderSpecs) || workOrderSpecs.length === 0) {
      return respond({ error: "Decomposition produced no work orders" }, 500);
    }

    // Cap at 10 WOs
    const specs = workOrderSpecs.slice(0, 10);

    // Create work orders via RPC
    const createdWOs: any[] = [];
    const slugMap: Record<number, string> = {}; // sequence -> slug

    for (const spec of specs) {
      const seq = spec.sequence || (createdWOs.length + 1);
      const slug = `WO-${project.code}-${seq}`;

      const tags = [
        'decomposed',
        `project:${project.code}`,
        `seq:${seq}`,
        ...(spec.tags || [])
      ];

      const clientInfo = {
        decomposition_sequence: seq,
        depends_on: (spec.depends_on || []).map((d: number) => slugMap[d]).filter(Boolean),
        depends_on_sequences: spec.depends_on || [],
        estimated_complexity: spec.estimated_complexity || 'moderate',
        project_code: project.code,
        project_name: project.name
      };

      try {
        const { data: woId, error: woErr } = await supabase.rpc('create_draft_work_order', {
          p_slug: slug,
          p_name: (spec.name || `Step ${seq}`).slice(0, 200),
          p_objective: spec.objective || spec.name,
          p_priority: spec.priority || 'p2_medium',
          p_source: 'decomposition',
          p_tags: tags
        });

        if (woErr) {
          console.error(`[DECOMPOSE] Failed to create WO ${slug}:`, woErr);
          createdWOs.push({ slug, name: spec.name, status: 'error', error: woErr.message });
          continue;
        }

        // Update WO with additional fields not in RPC
        if (woId) {
          await supabase.from('work_orders').update({
            project_brief_id: project_brief_id,
            acceptance_criteria: spec.acceptance_criteria || null,
            client_info: clientInfo,
            requires_approval: true
          }).eq('id', woId);

          slugMap[seq] = slug;
          createdWOs.push({
            id: woId,
            slug,
            name: spec.name,
            sequence: seq,
            priority: spec.priority || 'p2_medium',
            status: 'created'
          });
        }
      } catch (createErr: any) {
        console.error(`[DECOMPOSE] Exception creating WO ${slug}:`, createErr);
        createdWOs.push({ slug, name: spec.name, status: 'error', error: createErr.message });
      }
    }

    const successCount = createdWOs.filter(w => w.status === 'created').length;
    const errorCount = createdWOs.filter(w => w.status === 'error').length;

    // Audit log
    try {
      await supabase.from('audit_log').insert({
        event_type: 'project_decomposition',
        actor_type: 'system',
        actor_id: 'decompose-project',
        target_type: 'project',
        target_id: project_brief_id,
        action: 'decompose',
        payload: {
          project_code: project.code,
          docs_used: docs.map((d: any) => d.doc_type),
          work_orders_created: successCount,
          work_orders_failed: errorCount,
          slugs: createdWOs.filter(w => w.status === 'created').map(w => w.slug)
        }
      });
    } catch (_) {}

    return respond({
      project_brief_id,
      project_code: project.code,
      project_name: project.name,
      work_orders_created: successCount,
      work_orders_failed: errorCount,
      work_orders: createdWOs,
      docs_used: docs.map((d: any) => d.doc_type)
    });

  } catch (error: any) {
    console.error('decompose-project error:', error);
    return respond({ error: error.message }, 500);
  }
});
