import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const url = new URL(req.url);
  const threadId = url.searchParams.get("thread_id");

  try {
    if (threadId) {
      // Get messages for specific thread
      const { data: messages, error } = await supabase
        .from("thread_messages")
        .select("id, role, content, agent_name, model_used, input_tokens, output_tokens, cost_usd, created_at")
        .eq("thread_id", threadId)
        .order("created_at", { ascending: true });

      if (error) throw error;

      return new Response(
        JSON.stringify({ thread_id: threadId, messages: messages || [] }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    } else {
      // List all threads
      const { data: threads, error } = await supabase
        .from("conversation_threads")
        .select("id, title, status, message_count, total_tokens, total_cost_usd, created_at, updated_at, last_message_at")
        .eq("status", "active")
        .order("last_message_at", { ascending: false, nullsFirst: false })
        .order("created_at", { ascending: false })
        .limit(50);

      if (error) throw error;

      return new Response(
        JSON.stringify({ threads: threads || [] }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }
  } catch (error) {
    console.error("Portal threads error:", error);
    return new Response(
      JSON.stringify({ error: String(error) }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
