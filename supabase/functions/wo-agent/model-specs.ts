// wo-agent/model-specs.ts
// CB-001: Dynamic model spec resolution + proportional budget computation
// Zero hardcoded values: specs from provider APIs, budgets from system_settings ratios

export interface ModelSpec {
  contextWindow: number;   // total context window in tokens
  maxOutput: number;       // maximum output/completion tokens
}

export interface BudgetRatios {
  reserve_for_output: number;    // 0 = use model's maxOutput directly
  reserve_for_messages: number;  // fraction reserved for conversation history growth
  components: Record<string, number>;  // component name -> fraction of prompt budget (sum = 1.0)
}

export interface PromptBudget {
  totalContext: number;
  outputBudget: number;
  messageBudget: number;
  promptBudget: number;          // total available for system prompt + user message
  components: Record<string, number>;  // component name -> token budget
}

// --- Model Spec Resolution ---

/**
 * Resolve model capabilities from provider APIs.
 * Chain: OpenRouter API -> system_settings cache -> conservative fallback
 */
export async function resolveModelSpec(
  model: string,
  supabase: any
): Promise<ModelSpec> {
  // 1. Try OpenRouter API (covers all providers: Anthropic, Qwen, DeepSeek, etc.)
  try {
    const spec = await fetchOpenRouterSpec(model);
    if (spec) {
      // Write-through cache: update system_settings with fresh values
      cacheModelSpec(spec, model, supabase);
      // Apply system_settings overrides (e.g. 1M beta context for Claude)
      return await applyOverrides(spec, model, supabase);
    }
  } catch (e) {
    console.warn(`[MODEL-SPECS] OpenRouter fetch failed for ${model}:`, (e as Error).message);
  }

  // 2. system_settings fallback (last known good values)
  try {
    const spec = await fetchSettingsSpec(model, supabase);
    if (spec) return spec;
  } catch (e) {
    console.warn(`[MODEL-SPECS] Settings fallback failed:`, (e as Error).message);
  }

  // 3. Emergency: conservative spec (only reached if both API and settings fail)
  console.warn(`[MODEL-SPECS] All lookups failed for ${model}, using conservative fallback`);
  return { contextWindow: 128000, maxOutput: 8192 };
}

/**
 * Write-through cache: store fetched model spec to system_settings.
 * Called without await (fire-and-forget) to avoid adding latency to critical path.
 * Failures are logged but never break the main flow.
 */
async function cacheModelSpec(spec: ModelSpec, model: string, supabase: any): Promise<void> {
  try {
    // Read current cached values
    const { data, error: fetchError } = await supabase
      .from('system_settings')
      .select('setting_value')
      .eq('setting_key', 'model_context_windows')
      .single();

    if (fetchError && fetchError.code !== 'PGRST116') {
      console.warn(`[MODEL-SPECS] Cache read failed:`, fetchError.message);
      return;
    }

    // Build updated value object
    const currentValue = data?.setting_value?.value || {};
    const currentMaxOutput = data?.setting_value?.max_output || {};

    // Update with fresh values from OpenRouter
    const bare = model.includes('/') ? model.split('/').pop()! : model;
    currentValue[bare] = spec.contextWindow;
    currentMaxOutput[bare] = spec.maxOutput;

    // Upsert back to system_settings
    const { error: upsertError } = await supabase
      .from('system_settings')
      .upsert({
        setting_key: 'model_context_windows',
        setting_value: {
          value: currentValue,
          max_output: currentMaxOutput,
        },
        last_modified_by: 'wo-agent',
      }, {
        onConflict: 'setting_key',
      });

    if (upsertError) {
      console.warn(`[MODEL-SPECS] Cache write failed:`, upsertError.message);
      return;
    }

    console.log(`[MODEL-SPECS] Cached spec for ${bare}: ${spec.contextWindow}t / ${spec.maxOutput}t`);
  } catch (e) {
    // Fire-and-forget: never propagate errors
    console.warn(`[MODEL-SPECS] Cache update exception:`, (e as Error).message);
  }
}

/**
 * Fetch model spec from OpenRouter's OpenAI-compatible models endpoint.
 * Tries exact ID first, then common provider-prefixed variants.
 */
async function fetchOpenRouterSpec(model: string): Promise<ModelSpec | null> {
  const key = Deno.env.get("OPENROUTER_API_KEY");
  if (!key) return null;

  // Build candidate model IDs: exact match + provider-prefixed variants
  const candidates = [model];
  if (!model.includes('/')) {
    if (model.startsWith('claude-')) candidates.push(`anthropic/${model}`);
    if (model.startsWith('qwen')) candidates.push(`qwen/${model}`);
    if (model.startsWith('gpt-')) candidates.push(`openai/${model}`);
    if (model.startsWith('deepseek')) candidates.push(`deepseek/${model}`);
    if (model.startsWith('minimax')) candidates.push(`minimax/${model}`);
  }

  for (const id of candidates) {
    try {
      const resp = await fetch(
        `https://openrouter.ai/api/v1/models/${encodeURIComponent(id)}`,
        {
          headers: { "Authorization": `Bearer ${key}` },
          signal: AbortSignal.timeout(5000),
        }
      );
      if (!resp.ok) continue;

      const json = await resp.json();
      // OpenRouter may wrap in { data: ... } or return directly
      const data = json.data || json;

      const contextWindow = data.context_length;
      if (!contextWindow) continue;

      const maxOutput = data.top_provider?.max_completion_tokens
        || Math.floor(contextWindow / 4);

      return { contextWindow, maxOutput };
    } catch {
      continue;
    }
  }
  return null;
}

/**
 * Fetch model spec from system_settings.model_context_windows (cached values).
 */
async function fetchSettingsSpec(model: string, supabase: any): Promise<ModelSpec | null> {
  const { data } = await supabase
    .from('system_settings')
    .select('setting_value')
    .eq('setting_key', 'model_context_windows')
    .single();

  if (!data?.setting_value?.value) return null;

  const windows = data.setting_value.value;
  const maxOutputMap = data.setting_value.max_output || {};

  // Try exact match, then bare model name (strip provider prefix)
  const bare = model.includes('/') ? model.split('/').pop()! : model;
  const contextWindow = windows[model] || windows[bare];
  if (!contextWindow) return null;

  return {
    contextWindow,
    maxOutput: maxOutputMap[model] || maxOutputMap[bare] || Math.floor(contextWindow / 4),
  };
}

/**
 * Apply per-model overrides from system_settings (e.g. 1M beta context for Claude).
 */
async function applyOverrides(spec: ModelSpec, model: string, supabase: any): Promise<ModelSpec> {
  try {
    const { data } = await supabase
      .from('system_settings')
      .select('setting_value')
      .eq('setting_key', 'model_spec_overrides')
      .single();

    if (!data?.setting_value) return spec;

    const bare = model.includes('/') ? model.split('/').pop()! : model;
    const override = data.setting_value[model] || data.setting_value[bare];
    if (!override) return spec;

    return {
      contextWindow: override.context_window ?? spec.contextWindow,
      maxOutput: override.max_output ?? spec.maxOutput,
    };
  } catch {
    return spec;
  }
}

// --- Budget Computation ---

/**
 * Load budget ratios from system_settings.context_budget_ratios.
 * Ratios define proportional allocation -- every budget is a function of the context window.
 */
export async function loadBudgetRatios(supabase: any): Promise<BudgetRatios> {
  try {
    const { data } = await supabase
      .from('system_settings')
      .select('setting_value')
      .eq('setting_key', 'context_budget_ratios')
      .single();

    if (data?.setting_value) return data.setting_value as BudgetRatios;
  } catch {
    // Fall through to defaults
  }

  // Emergency defaults (only if system_settings load fails entirely)
  // These match the initial DB seed values -- kept in sync, not authoritative
  return {
    reserve_for_output: 0,
    reserve_for_messages: 0.15,
    components: {
      base_template: 0.28,
      agent_profile: 0.05,
      directives: 0.10,
      tools: 0.07,
      knowledge_base: 0.20,
      memories: 0.05,
      critical_lessons: 0.08,
      promoted_lessons: 0.05,
      user_message: 0.12,
    },
  };
}

/**
 * Compute proportional prompt budget from model spec and ratios.
 * Every component budget is a pure function of the model's context window.
 *
 * Formula:
 *   outputBudget  = maxOutput (from model spec, or contextWindow * reserve_for_output)
 *   messageBudget = contextWindow * reserve_for_messages
 *   promptBudget  = contextWindow - outputBudget - messageBudget
 *   component[i]  = promptBudget * ratios.components[i]
 */
export function computePromptBudget(spec: ModelSpec, ratios: BudgetRatios): PromptBudget {
  const outputBudget = ratios.reserve_for_output > 0
    ? Math.floor(spec.contextWindow * ratios.reserve_for_output)
    : spec.maxOutput;

  const messageBudget = Math.floor(spec.contextWindow * ratios.reserve_for_messages);
  const promptBudget = spec.contextWindow - outputBudget - messageBudget;

  const components: Record<string, number> = {};
  for (const [name, ratio] of Object.entries(ratios.components)) {
    components[name] = Math.floor(promptBudget * ratio);
  }

  return {
    totalContext: spec.contextWindow,
    outputBudget,
    messageBudget,
    promptBudget,
    components,
  };
}

// --- Token Utilities ---

/** Estimate tokens from string length (chars/4 approximation). */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Clip text to fit within a token budget. Returns original if within budget. */
export function clipToTokenBudget(text: string, maxTokens: number): string {
  const maxChars = maxTokens * 4;
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars - 40) + '\n\n... [clipped to fit budget]';
}
