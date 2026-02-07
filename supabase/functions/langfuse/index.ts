import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const LANGFUSE_PUBLIC_KEY = Deno.env.get("LANGFUSE_PUBLIC_KEY");
const LANGFUSE_SECRET_KEY = Deno.env.get("LANGFUSE_SECRET_KEY");
// Check both env var names and default to US region
const LANGFUSE_BASE_URL = Deno.env.get("LANGFUSE_BASE_URL") || Deno.env.get("LANGFUSE_HOST") || "https://us.cloud.langfuse.com";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// Generate a random trace ID (32 hex chars)
function generateTraceId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

// Generate a random span ID (16 hex chars)
function generateSpanId(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

// Langfuse API client
class LangfuseClient {
  private baseUrl: string;
  private auth: string;

  constructor(publicKey: string, secretKey: string, baseUrl: string) {
    this.baseUrl = baseUrl;
    this.auth = btoa(`${publicKey}:${secretKey}`);
  }

  async ingest(events: any[]): Promise<{ success: boolean; error?: string }> {
    try {
      const response = await fetch(`${this.baseUrl}/api/public/ingestion`, {
        method: "POST",
        headers: {
          "Authorization": `Basic ${this.auth}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ batch: events }),
      });

      if (!response.ok) {
        const text = await response.text();
        return { success: false, error: `Langfuse API error: ${response.status} ${text}` };
      }

      return { success: true };
    } catch (e) {
      return { success: false, error: String(e) };
    }
  }

  createTraceEvent(params: {
    id: string;
    name: string;
    sessionId?: string;
    userId?: string;
    input?: any;
    output?: any;
    metadata?: any;
    tags?: string[];
    timestamp?: string;
  }) {
    return {
      type: "trace-create",
      id: crypto.randomUUID(),
      timestamp: params.timestamp || new Date().toISOString(),
      body: {
        id: params.id,
        name: params.name,
        sessionId: params.sessionId,
        userId: params.userId,
        input: params.input,
        output: params.output,
        metadata: params.metadata,
        tags: params.tags,
      },
    };
  }

  createGenerationEvent(params: {
    id: string;
    traceId: string;
    name: string;
    model: string;
    input?: any;
    output?: any;
    usage?: { input?: number; output?: number; total?: number };
    metadata?: any;
    startTime: string;
    endTime?: string;
    level?: string;
    statusMessage?: string;
    completionStartTime?: string;
  }) {
    return {
      type: "generation-create",
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      body: {
        id: params.id,
        traceId: params.traceId,
        name: params.name,
        model: params.model,
        input: params.input,
        output: params.output,
        usage: params.usage,
        metadata: params.metadata,
        startTime: params.startTime,
        endTime: params.endTime,
        level: params.level,
        statusMessage: params.statusMessage,
        completionStartTime: params.completionStartTime,
      },
    };
  }

  createSpanEvent(params: {
    id: string;
    traceId: string;
    parentObservationId?: string;
    name: string;
    input?: any;
    output?: any;
    metadata?: any;
    startTime: string;
    endTime?: string;
    level?: string;
    statusMessage?: string;
  }) {
    return {
      type: "span-create",
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      body: {
        id: params.id,
        traceId: params.traceId,
        parentObservationId: params.parentObservationId,
        name: params.name,
        input: params.input,
        output: params.output,
        metadata: params.metadata,
        startTime: params.startTime,
        endTime: params.endTime,
        level: params.level,
        statusMessage: params.statusMessage,
      },
    };
  }

  createScoreEvent(params: {
    traceId: string;
    observationId?: string;
    name: string;
    value: number;
    comment?: string;
  }) {
    return {
      type: "score-create",
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      body: {
        traceId: params.traceId,
        observationId: params.observationId,
        name: params.name,
        value: params.value,
        comment: params.comment,
      },
    };
  }
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  // Check if Langfuse is configured
  if (!LANGFUSE_PUBLIC_KEY || !LANGFUSE_SECRET_KEY) {
    return new Response(
      JSON.stringify({
        error: "Langfuse not configured",
        message: "Set LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY in Supabase secrets"
      }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  const langfuse = new LangfuseClient(LANGFUSE_PUBLIC_KEY, LANGFUSE_SECRET_KEY, LANGFUSE_BASE_URL);

  try {
    const body = await req.json();
    const { action } = body;

    // ACTION: Create a new trace
    if (action === "trace") {
      const { thread_id, name, user_id, input, output, metadata, tags } = body;
      const traceId = generateTraceId();
      const sessionId = thread_id || generateTraceId();

      const events = [
        langfuse.createTraceEvent({
          id: traceId,
          name: name || "portal-chat",
          sessionId,
          userId: user_id,
          input,
          output,
          metadata: { ...metadata, source: "metis-portal" },
          tags: tags || ["metis"],
        }),
      ];

      const result = await langfuse.ingest(events);

      if (result.success) {
        // Store reference in DB
        await supabase.from("langfuse_traces").insert({
          trace_id: traceId,
          thread_id,
          session_id: sessionId,
          user_id,
          name: name || "portal-chat",
          input,
          output,
          metadata,
          tags,
        });
      }

      return new Response(
        JSON.stringify({
          success: result.success,
          trace_id: traceId,
          session_id: sessionId,
          error: result.error
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // ACTION: Log a generation (LLM call)
    if (action === "generation") {
      const {
        trace_id,
        name,
        model,
        input,
        output,
        input_tokens,
        output_tokens,
        latency_ms,
        metadata
      } = body;

      const generationId = generateSpanId();
      const startTime = new Date(Date.now() - (latency_ms || 0)).toISOString();
      const endTime = new Date().toISOString();

      const events = [
        langfuse.createGenerationEvent({
          id: generationId,
          traceId: trace_id,
          name: name || "llm-call",
          model: model || "claude-sonnet-4-20250514",
          input,
          output,
          usage: {
            input: input_tokens,
            output: output_tokens,
            total: (input_tokens || 0) + (output_tokens || 0),
          },
          metadata,
          startTime,
          endTime,
        }),
      ];

      const result = await langfuse.ingest(events);

      return new Response(
        JSON.stringify({
          success: result.success,
          generation_id: generationId,
          error: result.error
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // ACTION: Log a tool call
    if (action === "tool_call") {
      const {
        trace_id,
        thread_id,
        message_id,
        tool_name,
        tool_input,
        tool_output,
        status,
        error_message,
        latency_ms
      } = body;

      const spanId = generateSpanId();
      const startTime = new Date(Date.now() - (latency_ms || 0)).toISOString();
      const endTime = new Date().toISOString();

      // Log to Langfuse as a span
      if (trace_id) {
        const events = [
          langfuse.createSpanEvent({
            id: spanId,
            traceId: trace_id,
            name: `tool:${tool_name}`,
            input: tool_input,
            output: tool_output,
            metadata: { status, error_message },
            startTime,
            endTime,
            level: status === "error" ? "ERROR" : "DEFAULT",
            statusMessage: error_message,
          }),
        ];
        await langfuse.ingest(events);
      }

      // Store in local DB
      const { data: toolCall, error } = await supabase
        .from("tool_calls")
        .insert({
          thread_id,
          message_id,
          trace_id,
          tool_name,
          tool_input,
          tool_output,
          status: status || "success",
          error_message,
          latency_ms,
          started_at: startTime,
          completed_at: endTime,
        })
        .select("id")
        .single();

      return new Response(
        JSON.stringify({
          success: !error,
          tool_call_id: toolCall?.id,
          span_id: spanId,
          error: error?.message
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // ACTION: Score a trace (user feedback, quality score, etc.)
    if (action === "score") {
      const { trace_id, observation_id, name, value, comment } = body;

      const events = [
        langfuse.createScoreEvent({
          traceId: trace_id,
          observationId: observation_id,
          name: name || "user_feedback",
          value,
          comment,
        }),
      ];

      const result = await langfuse.ingest(events);

      return new Response(
        JSON.stringify({ success: result.success, error: result.error }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // ACTION: Get tool call stats
    if (action === "stats") {
      const { thread_id, days = 7 } = body;
      const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

      let query = supabase
        .from("tool_calls")
        .select("tool_name, status, latency_ms")
        .gte("created_at", since);

      if (thread_id) {
        query = query.eq("thread_id", thread_id);
      }

      const { data, error } = await query;

      if (error) {
        return new Response(
          JSON.stringify({ error: error.message }),
          { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      // Aggregate stats
      const stats: Record<string, { count: number; errors: number; avgLatency: number; totalLatency: number }> = {};
      for (const call of data || []) {
        if (!stats[call.tool_name]) {
          stats[call.tool_name] = { count: 0, errors: 0, avgLatency: 0, totalLatency: 0 };
        }
        stats[call.tool_name].count++;
        stats[call.tool_name].totalLatency += call.latency_ms || 0;
        if (call.status === "error") stats[call.tool_name].errors++;
      }

      for (const tool in stats) {
        stats[tool].avgLatency = Math.round(stats[tool].totalLatency / stats[tool].count);
        delete (stats[tool] as any).totalLatency;
      }

      return new Response(
        JSON.stringify({ stats, total_calls: data?.length || 0 }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // ACTION: Check Langfuse connection - try both regions
    if (action === "ping") {
      const testTraceId = generateTraceId();
      const events = [
        langfuse.createTraceEvent({
          id: testTraceId,
          name: "connection-test",
          metadata: { test: true, timestamp: new Date().toISOString() },
          tags: ["test"],
        }),
      ];

      // Try configured region first
      let result = await langfuse.ingest(events);
      let usedUrl = LANGFUSE_BASE_URL;

      // If that fails with 401, try the other region
      if (!result.success && result.error?.includes("401")) {
        const otherUrl = LANGFUSE_BASE_URL.includes("us.cloud")
          ? "https://cloud.langfuse.com"
          : "https://us.cloud.langfuse.com";

        const otherClient = new LangfuseClient(LANGFUSE_PUBLIC_KEY, LANGFUSE_SECRET_KEY, otherUrl);
        const otherResult = await otherClient.ingest(events);

        if (otherResult.success) {
          result = otherResult;
          usedUrl = otherUrl;
        }
      }

      return new Response(
        JSON.stringify({
          connected: result.success,
          langfuse_url: usedUrl,
          configured_url: LANGFUSE_BASE_URL,
          test_trace_id: result.success ? testTraceId : null,
          error: result.error,
          hint: !result.success && result.error?.includes("401")
            ? "Try setting LANGFUSE_BASE_URL to the correct region (https://cloud.langfuse.com for EU or https://us.cloud.langfuse.com for US)"
            : undefined
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    return new Response(
      JSON.stringify({ error: "Unknown action. Use: trace, generation, tool_call, score, stats, ping" }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );

  } catch (error) {
    return new Response(
      JSON.stringify({ error: String(error) }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
