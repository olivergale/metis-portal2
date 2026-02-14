import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

interface LLMCallRequest {
  messages: Array<{
    role: string;
    content: string;
  }>;
  model?: string;
  tools?: any[];
  temperature?: number;
  max_tokens?: number;
  response_format?: any;
  work_order_id?: string;
  agent_id?: string;
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
    const requestBody: LLMCallRequest = await req.json();

    console.log("LLM call request:", {
      model: requestBody.model,
      agent_id: requestBody.agent_id,
      work_order_id: requestBody.work_order_id,
      messages_count: requestBody.messages?.length,
    });

    // Model resolution chain:
    // 1. Explicit model from request
    // 2. Per-agent model from agents.model column
    // 3. Default from llm_provider_config
    let resolvedModel = requestBody.model;
    let modelConfig = null;

    if (!resolvedModel && requestBody.agent_id) {
      // Check per-agent config
      const { data: agent, error: agentError } = await supabase
        .from("agents")
        .select("model")
        .eq("id", requestBody.agent_id)
        .single();

      if (!agentError && agent?.model) {
        resolvedModel = agent.model;
        console.log("Resolved model from agent config:", resolvedModel);
      }
    }

    if (!resolvedModel) {
      // Get default from llm_provider_config
      const { data: defaultConfig, error: configError } = await supabase
        .from("llm_provider_config")
        .select("*")
        .eq("is_default", true)
        .eq("is_active", true)
        .single();

      if (configError || !defaultConfig) {
        throw new Error("No default model configured in llm_provider_config");
      }

      resolvedModel = defaultConfig.model_id;
      modelConfig = defaultConfig;
      console.log("Resolved model from default config:", resolvedModel);
    }

    // If we don't have config yet, fetch it for cost tracking
    if (!modelConfig) {
      const { data: config } = await supabase
        .from("llm_provider_config")
        .select("*")
        .eq("model_id", resolvedModel)
        .single();

      modelConfig = config;
    }

    const startTime = Date.now();

    // Build OpenRouter request
    const openrouterRequest: any = {
      model: resolvedModel,
      messages: requestBody.messages,
    };

    if (requestBody.tools) openrouterRequest.tools = requestBody.tools;
    if (requestBody.temperature !== undefined) openrouterRequest.temperature = requestBody.temperature;
    if (requestBody.max_tokens) openrouterRequest.max_tokens = requestBody.max_tokens;
    if (requestBody.response_format) openrouterRequest.response_format = requestBody.response_format;

    // Call OpenRouter
    const openrouterResponse = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${openrouterKey}`,
        "HTTP-Referer": "https://metis-portal2.vercel.app",
        "X-Title": "ENDGAME-001",
      },
      body: JSON.stringify(openrouterRequest),
    });

    const latencyMs = Date.now() - startTime;
    const responseData = await openrouterResponse.json();

    // Extract usage data
    const inputTokens = responseData.usage?.prompt_tokens || 0;
    const outputTokens = responseData.usage?.completion_tokens || 0;
    const openrouterId = responseData.id || null;

    // Log usage to llm_usage table
    const usageRecord: any = {
      model_id: resolvedModel,
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      latency_ms: latencyMs,
      success: openrouterResponse.ok,
      openrouter_id: openrouterId,
    };

    if (requestBody.work_order_id) {
      usageRecord.work_order_id = requestBody.work_order_id;
    }

    if (requestBody.agent_id) {
      usageRecord.agent_id = requestBody.agent_id;
    }

    if (modelConfig) {
      usageRecord.input_cost_per_m = modelConfig.input_cost_per_m;
      usageRecord.output_cost_per_m = modelConfig.output_cost_per_m;
    }

    if (!openrouterResponse.ok) {
      usageRecord.error_message = responseData.error?.message || JSON.stringify(responseData);
    }

    const { error: usageError } = await supabase
      .from("llm_usage")
      .insert(usageRecord);

    if (usageError) {
      console.error("Failed to log usage:", usageError);
      // Don't fail the request if logging fails
    }

    console.log("LLM call completed:", {
      model: resolvedModel,
      success: openrouterResponse.ok,
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      latency_ms: latencyMs,
    });

    // Return OpenRouter response as-is
    return new Response(
      JSON.stringify(responseData),
      {
        status: openrouterResponse.status,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  } catch (error) {
    console.error("LLM call error:", error);

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
