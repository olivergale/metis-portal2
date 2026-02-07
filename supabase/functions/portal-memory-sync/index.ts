import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY")!;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

async function generateEmbedding(text: string): Promise<number[]> {
  const response = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "text-embedding-3-small",
      input: text.slice(0, 8000),
      dimensions: 384,
    }),
  });
  const data = await response.json();
  return data.data?.[0]?.embedding || [];
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  try {
    const url = new URL(req.url);
    const threadId = url.searchParams.get("thread_id");

    // Get all active threads
    let threadsQuery = supabase
      .from("conversation_threads")
      .select("id, title, created_at, message_count")
      .eq("status", "active");

    if (threadId) {
      threadsQuery = threadsQuery.eq("id", threadId);
    }

    const { data: threads, error: threadsError } = await threadsQuery;

    if (threadsError) {
      return new Response(
        JSON.stringify({ error: "Thread query error", details: threadsError }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (!threads?.length) {
      return new Response(
        JSON.stringify({ success: true, synced: 0, message: "No threads found" }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const results = [];
    const errors = [];

    for (const thread of threads) {
      try {
        // Get all messages for this thread
        const { data: messages, error: msgError } = await supabase
          .from("thread_messages")
          .select("role, content, created_at")
          .eq("thread_id", thread.id)
          .order("created_at", { ascending: true });

        if (msgError) {
          errors.push({ thread_id: thread.id, error: "Message query error", details: msgError });
          continue;
        }

        if (!messages?.length) {
          errors.push({ thread_id: thread.id, error: "No messages found" });
          continue;
        }

        // Build summary from first user message and last assistant message
        const firstUser = messages.find(m => m.role === "user");
        const lastAssistant = [...messages].reverse().find(m => m.role === "assistant");
        const summary = `User: ${firstUser?.content?.slice(0, 200) || "N/A"}... Assistant: ${lastAssistant?.content?.slice(0, 200) || "N/A"}...`;

        // Generate embedding
        const embeddingText = `Title: ${thread.title}\nSource: portal\n\n${summary}`;
        const embedding = await generateEmbedding(embeddingText);

        // Upsert to conversations table
        const { data: conv, error: convError } = await supabase
          .from("conversations")
          .upsert({
            source: "portal",
            external_id: thread.id,
            title: thread.title,
            summary: summary,
            org: "master_layer",
            metadata: {
              message_count: messages.length,
              synced_at: new Date().toISOString(),
              thread_created_at: thread.created_at,
            },
            embedding: embedding.length ? `[${embedding.join(",")}]` : null,
            updated_at: new Date().toISOString(),
          }, { onConflict: "external_id" })
          .select("id")
          .single();

        if (convError) {
          errors.push({ thread_id: thread.id, error: "Upsert error", details: convError });
          continue;
        }

        results.push({
          thread_id: thread.id,
          conversation_id: conv?.id,
          title: thread.title,
          messages_synced: messages.length,
        });
      } catch (e) {
        errors.push({ thread_id: thread.id, error: String(e) });
      }
    }

    return new Response(
      JSON.stringify({
        success: true,
        synced: results.length,
        results,
        errors: errors.length ? errors : undefined,
        threads_found: threads.length,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );

  } catch (error) {
    console.error("Sync error:", error);
    return new Response(
      JSON.stringify({ error: String(error) }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
