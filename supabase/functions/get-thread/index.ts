// get-thread - Returns messages for a specific thread
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  try {
    const url = new URL(req.url);
    const threadId = url.searchParams.get("thread_id");

    if (!threadId) {
      return new Response(JSON.stringify({ error: "thread_id required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const [threadResult, messagesResult] = await Promise.all([
      supabase.from("conversation_threads").select("*").eq("id", threadId).single(),
      supabase.from("thread_messages")
        .select("id, role, content, model_used, input_tokens, output_tokens, cost_usd, trace_id, created_at")
        .eq("thread_id", threadId)
        .order("created_at", { ascending: true })
    ]);

    if (threadResult.error) throw threadResult.error;

    // Format messages with metadata
    const messages = (messagesResult.data || []).map(m => ({
      role: m.role,
      content: m.content,
      metadata: m.role === 'assistant' ? {
        input_tokens: m.input_tokens,
        output_tokens: m.output_tokens,
        cost_usd: m.cost_usd,
        langfuse_url: m.trace_id ? `https://us.cloud.langfuse.com/trace/${m.trace_id}` : null
      } : null
    }));

    return new Response(JSON.stringify({
      id: threadResult.data.id,
      title: threadResult.data.title,
      message_count: threadResult.data.message_count,
      total_cost_usd: threadResult.data.total_cost_usd,
      messages
    }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
