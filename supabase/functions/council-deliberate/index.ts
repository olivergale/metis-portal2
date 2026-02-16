import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

interface CouncilRequest {
  work_order_id: string;
  preset_name?: string;
  preset_id?: string;
  force_run?: boolean;
}

interface Stage1Response {
  model: string;
  label: string;
  content: string;
  tokens_in?: number;
  tokens_out?: number;
  cost_usd?: number;
  error?: string;
}

interface Stage2Evaluation {
  evaluator_model: string;
  response_label: string;
  ranking: number; // 1 = best
  justification: string;
}

interface AggregateRanking {
  model: string;
  average_rank: number;
  win_count: number;
  total_evaluations: number;
}

// Random label generator for Stage 2 anonymization
function generateLabels(count: number): string[] {
  const labels = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L'];
  const shuffled = [...labels].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, count);
}

// Build context injection from preset config
async function buildContextInjection(
  supabase: ReturnType<typeof createClient>,
  contextInjection: Record<string, boolean>,
  workOrderId: string
): Promise<string> {
  let contextText = "";

  if (contextInjection.directives) {
    const { data: directives } = await supabase
      .from('system_directives')
      .select('directive_text, enforcement')
      .eq('is_active', true)
      .limit(10);
    if (directives?.length) {
      contextText += "\n## Active Directives\n";
      directives.forEach(d => {
        contextText += `- ${d.directive_text} (${d.enforcement})\n`;
      });
    }
  }

  if (contextInjection.lessons) {
    const { data: lessons } = await supabase
      .from('lessons')
      .select('pattern, rule, severity')
      .eq('review_status', 'promoted')
      .order('created_at', { ascending: false })
      .limit(5);
    if (lessons?.length) {
      contextText += "\n## Recent Lessons Learned\n";
      lessons.forEach(l => {
        contextText += `- [${l.severity}] ${l.pattern}: ${l.rule}\n`;
      });
    }
  }

  if (contextInjection.schema) {
    const { data: tables } = await supabase
      .from('information_schema.tables')
      .select('table_name')
      .eq('table_schema', 'public')
      .limit(20);
    if (tables?.length) {
      contextText += "\n## Database Schema Summary\n";
      tables.forEach(t => {
        contextText += `- ${t.table_name}\n`;
      });
    }
  }

  if (contextInjection.work_order_context && workOrderId) {
    const { data: wo } = await supabase
      .from('work_orders')
      .select('id, slug, name, objective, status, complexity, tags')
      .eq('id', workOrderId)
      .single();
    if (wo) {
      contextText += `\n## Target Work Order\n- Slug: ${wo.slug}\n- Name: ${wo.name}\n- Status: ${wo.status}\n- Complexity: ${wo.complexity}\n- Tags: ${(wo.tags || []).join(', ')}\n`;
    }
  }

  return contextText;
}

// Call OpenRouter API for a single model
async function callModel(
  openrouterKey: string,
  model: string,
  messages: Array<{ role: string; content: string }>,
  systemPrompt?: string,
  temperature?: number
): Promise<{ content: string; tokens_in: number; tokens_out: number; cost_usd: number }> {
  const requestBody: any = {
    model,
    messages: messages,
  };

  if (systemPrompt) {
    requestBody.messages.unshift({ role: 'system', content: systemPrompt });
  }

  if (temperature !== undefined) {
    requestBody.temperature = temperature;
  }

  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${openrouterKey}`,
      "HTTP-Referer": "https://metis-portal2.vercel.app",
      "X-Title": "ENDGAME-001",
    },
    body: JSON.stringify(requestBody),
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.error?.message || 'OpenRouter API error');
  }

  const content = data.choices?.[0]?.message?.content || '';
  const tokens_in = data.usage?.prompt_tokens || 0;
  const tokens_out = data.usage?.completion_tokens || 0;

  // Estimate cost (simplified - actual should come from llm_provider_config)
  const cost_per_m = 0.001; // Placeholder - would use actual pricing
  const cost_usd = (tokens_in + tokens_out) * cost_per_m / 1_000_000;

  return { content, tokens_in, tokens_out, cost_usd };
}

// Stage 1: Fan-out to all council members
async function stage1FanOut(
  supabase: ReturnType<typeof createClient>,
  openrouterKey: string,
  preset: any,
  prompt: string,
  workOrderId: string
): Promise<{ responses: Stage1Response[]; labelMap: Record<string, string> }> {
  const models = preset.council_models || [];
  const labels = generateLabels(models.length);
  const labelMap: Record<string, string> = {};

  const responses: Stage1Response[] = [];
  const contextInjection = preset.context_injection || {};
  const contextText = await buildContextInjection(supabase, contextInjection, workOrderId);

  const fullPrompt = contextText
    ? `${prompt}\n\n---\nAdditional Context:\n${contextText}`
    : prompt;

  const modelParams = preset.model_params || {};

  // Parallel calls with graceful degradation
  const promises = models.map(async (model: string, index: number) => {
    try {
      const result = await callModel(
        openrouterKey,
        model,
        [{ role: 'user', content: fullPrompt }],
        preset.chairman_system_prompt,
        modelParams.temperature
      );

      return {
        model,
        label: labels[index],
        content: result.content,
        tokens_in: result.tokens_in,
        tokens_out: result.tokens_out,
        cost_usd: result.cost_usd,
      };
    } catch (error) {
      console.error(`Model ${model} failed:`, error.message);
      return {
        model,
        label: labels[index],
        content: '',
        error: error.message,
      };
    }
  });

  const results = await Promise.all(promises);

  // Build label map (label -> model)
  results.forEach(r => {
    labelMap[r.label] = r.model;
  });

  // Filter out failed responses but continue if at least 1 succeeded
  const successful = results.filter(r => !r.error && r.content);
  if (successful.length === 0) {
    throw new Error('All council models failed in Stage 1');
  }

  console.log(`Stage 1 complete: ${successful.length}/${models.length} models responded`);

  return { responses: results, labelMap };
}

// Stage 2: Blind peer review
async function stage2BlindReview(
  supabase: ReturnType<typeof createClient>,
  openrouterKey: string,
  preset: any,
  stage1Responses: Stage1Response[],
  originalPrompt: string
): Promise<{ evaluations: Stage2Evaluation[]; aggregateRankings: AggregateRanking[] }> {
  const models = preset.council_models || [];
  const evaluationCriteria = preset.evaluation_criteria || {};

  const responses = stage1Responses.filter(r => !r.error && r.content);
  if (responses.length < 2) {
    // Not enough responses for peer review
    return { evaluations: [], aggregateRankings: [] };
  }

  const evaluationPrompt = buildEvaluationPrompt(originalPrompt, responses, evaluationCriteria);

  const evaluations: Stage2Evaluation[] = [];

  // Each model evaluates all responses
  for (const evaluator of models) {
    const evaluatorResponses = responses.filter(r => r.model !== evaluator);
    if (evaluatorResponses.length === 0) continue;

    const prompt = evaluationPrompt + "\n\n---\nEvaluate each response and provide a ranking from best (1) to worst (" + responses.length + ").\nRespond in JSON format: {"evaluations": [{"response_label": "A", "ranking": 1, "justification": "..."}, ...]}";

    try {
      const result = await callModel(
        openrouterKey,
        evaluator,
        [{ role: 'user', content: prompt }],
        undefined,
        0.3 // Lower temperature for evaluation
      );

      // Parse JSON response
      const parsed = JSON.parse(result.content);
      if (parsed.evaluations) {
        parsed.evaluations.forEach((e: any) => {
          evaluations.push({
            evaluator_model: evaluator,
            response_label: e.response_label,
            ranking: e.ranking,
            justification: e.justification || '',
          });
        });
      }
    } catch (error) {
      console.error(`Evaluation by ${evaluator} failed:`, error.message);
    }
  }

  // Compute aggregate rankings
  const aggregateRankings: Map<string, { totalRank: number; wins: number; count: number }> = new Map();

  responses.forEach(r => {
    aggregateRankings.set(r.model, { totalRank: 0, wins: 0, count: 0 });
  });

  evaluations.forEach(e => {
    const model = Object.entries(e).find(([k]) => k === 'response_label')?.[1];
    // Find actual model from label
    const labelModel = stage1Responses.find(sr => sr.label === e.response_label)?.model;
    if (labelModel) {
      const stats = aggregateRankings.get(labelModel);
      if (stats) {
        stats.totalRank += e.ranking;
        if (e.ranking === 1) stats.wins++;
        stats.count++;
      }
    }
  });

  const rankings: AggregateRanking[] = [];
  aggregateRankings.forEach((stats, model) => {
    rankings.push({
      model,
      average_rank: stats.count > 0 ? stats.totalRank / stats.count : 999,
      win_count: stats.wins,
      total_evaluations: stats.count,
    });
  });

  // Sort by average rank
  rankings.sort((a, b) => a.average_rank - b.average_rank);

  console.log(`Stage 2 complete: ${evaluations.length} evaluations, top model: ${rankings[0]?.model}`);

  return { evaluations, aggregateRankings: rankings };
}

function buildEvaluationPrompt(
  originalPrompt: string,
  responses: Stage1Response[],
  criteria: Record<string, any>
): string {
  let prompt = "## Original Request\n" + originalPrompt + "\n\n";
  prompt += "## Responses to Evaluate\n";

  responses.forEach(r => {
    prompt += `\n### Response ${r.label}\n${r.content}\n`;
  });

  if (criteria.focus) {
    prompt += `\n## Evaluation Criteria\n${criteria.focus}\n`;
  }

  return prompt;
}

// Stage 3: Chairman synthesis
async function stage3ChairmanSynthesis(
  openrouterKey: string,
  preset: any,
  stage1Responses: Stage1Response[],
  stage2Evaluations: Stage2Evaluation[],
  aggregateRankings: AggregateRanking[],
  originalPrompt: string
): Promise<{ synthesis: string; tokens_in: number; tokens_out: number }> {
  const chairmanModel = preset.chairman_model || preset.council_models?.[0];

  // Build synthesis prompt with all context
  let prompt = "## Original Request\n" + originalPrompt + "\n\n";

  prompt += "## All Council Responses\n";
  stage1Responses.filter(r => !r.error && r.content).forEach(r => {
    prompt += `\n### ${r.label} (${r.model})\n${r.content}\n`;
  });

  prompt += "\n## Peer Review Evaluations\n";
  if (stage2Evaluations.length > 0) {
    stage2Evaluations.forEach(e => {
      prompt += `- ${e.evaluator_model} evaluated ${e.response_label}: rank ${e.ranking} - ${e.justification}\n`;
    });
  } else {
    prompt += "(Peer review not available - using direct responses)\n";
  }

  prompt += "\n## Aggregate Rankings\n";
  aggregateRankings.forEach((r, i) => {
    prompt += `${i + 1}. ${r.model}: avg rank ${r.average_rank.toFixed(2)}, wins: ${r.win_count}\n`;
  });

  prompt += "\n---\nAs the chairman, synthesize the council's deliberations into a cohesive recommendation. Consider the rankings and evaluations but exercise independent judgment. Provide your final synthesis with reasoning.";

  const result = await callModel(
    openrouterKey,
    chairmanModel,
    [{ role: 'user', content: prompt }],
    preset.chairman_system_prompt,
    0.5
  );

  console.log(`Stage 3 complete: chairman ${chairmanModel} produced synthesis`);

  return {
    synthesis: result.content,
    tokens_in: result.tokens_in,
    tokens_out: result.tokens_out,
  };
}

// Check if WO should skip council deliberation
async function shouldSkipCouncil(
  supabase: ReturnType<typeof createClient>,
  workOrderId: string
): Promise<{ skip: boolean; reason: string }> {
  const { data: wo, error } = await supabase
    .from('work_orders')
    .select('id, complexity, tags, council_deliberation_id, status')
    .eq('id', workOrderId)
    .single();

  if (error || !wo) {
    return { skip: true, reason: 'Work order not found' };
  }

  // Already has deliberation
  if (wo.council_deliberation_id) {
    return { skip: true, reason: 'Work order already has council deliberation' };
  }

  // Check tags for remediation
  const tags = wo.tags || [];
  if (tags.includes('remediation')) {
    return { skip: true, reason: 'Remediation WOs skip council' };
  }

  // For now, always allow manual trigger
  return { skip: false, reason: '' };
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const openrouterKey = Deno.env.get("OPENROUTER_API_KEY");

    if (!openrouterKey) {
      throw new Error("OPENROUTER_API_KEY not configured");
    }

    const supabase = createClient(supabaseUrl, supabaseKey);
    const requestBody: CouncilRequest = await req.json();

    const { work_order_id, preset_name, preset_id, force_run } = requestBody;

    if (!work_order_id) {
      throw new Error("work_order_id is required");
    }

    // Check skip conditions unless forced
    if (!force_run) {
      const skipCheck = await shouldSkipCouncil(supabase, work_order_id);
      if (skipCheck.skip) {
        return new Response(
          JSON.stringify({ skipped: true, reason: skipCheck.reason }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
    }

    // Load preset
    let preset: any = null;

    if (preset_id) {
      const { data } = await supabase
        .from('council_presets')
        .select('*')
        .eq('id', preset_id)
        .single();
      preset = data;
    } else if (preset_name) {
      const { data } = await supabase
        .from('council_presets')
        .select('*')
        .eq('name', preset_name)
        .single();
      preset = data;
    } else {
      // Auto-detect based on WO complexity/risk
      const { data: wo } = await supabase
        .from('work_orders')
        .select('complexity')
        .eq('id', work_order_id)
        .single();

      const presetName = wo?.complexity === 'large' || wo?.complexity === 'unknown'
        ? 'plan_council'
        : 'review_council';

      const { data } = await supabase
        .from('council_presets')
        .select('*')
        .eq('name', presetName)
        .single();
      preset = data;
    }

    if (!preset) {
      throw new Error("Council preset not found");
    }

    if (!preset.enabled) {
      throw new Error(`Council preset '${preset.name}' is disabled`);
    }

    // Load WO context for prompt
    const { data: wo } = await supabase
      .from('work_orders')
      .select('id, slug, name, objective, complexity, tags')
      .eq('id', work_order_id)
      .single();

    if (!wo) {
      throw new Error("Work order not found");
    }

    const prompt = `Please analyze and provide recommendations for the following work order:

## Work Order: ${wo.name} (${wo.slug})
## Complexity: ${wo.complexity}
## Tags: ${(wo.tags || []).join(', ')}

### Objective:
${wo.objective}`;

    // Create deliberation record
    const deliberationId = crypto.randomUUID();
    const now = new Date().toISOString();

    const { error: insertError } = await supabase
      .from('council_deliberations')
      .insert({
        id: deliberationId,
        work_order_id,
        preset_id: preset.id,
        gate_type: preset.gate_type,
        status: 'running',
        stage1_prompt: prompt,
        started_at: now,
      });

    if (insertError) {
      throw new Error(`Failed to create deliberation: ${insertError.message}`);
    }

    // Link WO to deliberation
    await supabase
      .from('work_orders')
      .update({ council_deliberation_id: deliberationId })
      .eq('id', work_order_id);

    const startTime = Date.now();
    let stage1Responses: Stage1Response[] = [];
    let labelMap: Record<string, string> = {};
    let stage2Evaluations: Stage2Evaluation[] = [];
    let aggregateRankings: AggregateRanking[] = [];
    let stage3Result: { synthesis: string; tokens_in: number; tokens_out: number } | null = null;
    let status = 'running';

    try {
      // Stage 1: Fan-out
      const stage1Result = await stage1FanOut(supabase, openrouterKey, preset, prompt, work_order_id);
      stage1Responses = stage1Result.responses;
      labelMap = stage1Result.labelMap;

      // Stage 2: Blind peer review (skip if not enough responses)
      if (stage1Responses.filter(r => !r.error && r.content).length >= 2) {
        const stage2Result = await stage2BlindReview(supabase, openrouterKey, preset, stage1Responses, prompt);
        stage2Evaluations = stage2Result.evaluations;
        aggregateRankings = stage2Result.aggregateRankings;
      }

      // Stage 3: Chairman synthesis
      stage3Result = await stage3ChairmanSynthesis(
        openrouterKey,
        preset,
        stage1Responses,
        stage2Evaluations,
        aggregateRankings,
        prompt
      );

      status = 'completed';
    } catch (stageError: any) {
      console.error("Council stage failed:", stageError);
      status = 'failed';

      // Try fallback: chairman-only
      try {
        stage3Result = await stage3ChairmanSynthesis(
          openrouterKey,
          preset,
          stage1Responses.filter(r => !r.error && r.content),
          [],
          [],
          prompt
        );
        status = 'completed';
      } catch (fallbackError) {
        console.error("Fallback also failed:", fallbackError);
      }
    }

    // Compute totals
    const totalTokensIn = stage1Responses.reduce((sum, r) => sum + (r.tokens_in || 0), 0) + (stage3Result?.tokens_in || 0);
    const totalTokensOut = stage1Responses.reduce((sum, r) => sum + (r.tokens_out || 0), 0) + (stage3Result?.tokens_out || 0);
    const totalCost = stage1Responses.reduce((sum, r) => sum + (r.cost_usd || 0), 0);
    const durationMs = Date.now() - startTime;
    const completedAt = new Date().toISOString();

    // Update deliberation record
    const { error: updateError } = await supabase
      .from('council_deliberations')
      .update({
        status,
        stage1_responses: stage1Responses,
        stage2_label_map: labelMap,
        stage2_evaluations: stage2Evaluations,
        stage2_aggregate_rankings: aggregateRankings,
        stage3_chairman_model: preset.chairman_model,
        stage3_synthesis: stage3Result?.synthesis || null,
        stage3_tokens_in: stage3Result?.tokens_in || null,
        stage3_tokens_out: stage3Result?.tokens_out || null,
        total_input_tokens: totalTokensIn,
        total_output_tokens: totalTokensOut,
        total_cost_usd: totalCost,
        completed_at: completedAt,
        duration_ms: durationMs,
      })
      .eq('id', deliberationId);

    if (updateError) {
      console.error("Failed to update deliberation:", updateError);
    }

    return new Response(
      JSON.stringify({
        deliberation_id: deliberationId,
        status,
        preset: preset.name,
        stage1_responses_count: stage1Responses.length,
        stage2_evaluations_count: stage2Evaluations.length,
        aggregate_rankings: aggregateRankings,
        total_cost_usd: totalCost,
        duration_ms: durationMs,
        synthesis: stage3Result?.synthesis,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("Council deliberation error:", error);

    return new Response(
      JSON.stringify({
        error: {
          message: error.message,
          type: "internal_error",
        },
      }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  }
});
