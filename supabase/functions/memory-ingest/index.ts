import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY")!;
const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY")!;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

interface Message {
  role: string;
  content: string;
}

interface IngestRequest {
  source: string;
  title: string;
  org?: string;
  messages: Message[];
}

const SOURCE_MAP: Record<string, string> = {
  "claude": "claude_api",
  "claude-api": "claude_api",
  "claude_api": "claude_api",
  "claude (api)": "claude_api",
  "claude-cowork": "claude_cowork",
  "claude_cowork": "claude_cowork",
  "claude (cowork)": "claude_cowork",
  "cowork": "claude_cowork",
  "claude_export": "claude_export",
  "claude-export": "claude_export",
  "claude (export)": "claude_export",
  "gpt": "gpt",
  "chatgpt": "gpt",
  "openai": "gpt",
  "slack": "slack",
  "email": "email",
  "manual": "manual",
  "test": "manual",
};

function mapSource(source: string): string {
  return SOURCE_MAP[source.toLowerCase()] || "claude_api";
}

function formatMessages(messages: Message[]): string {
  return messages
    .map((m, i) => `[${i + 1}] ${(m.role || "user").toUpperCase()}:\n${m.content || ""}`)
    .join("\n\n---\n\n");
}

async function extractWithClaude(
  source: string,
  title: string,
  transcript: string
): Promise<{ entities: unknown[]; decisions: unknown[]; facts: unknown[]; preferences: unknown[] }> {
  const prompt = `Extract entities, decisions, facts, preferences from this conversation as JSON.\nSource: ${source}\nTitle: ${title}\nTranscript: ${transcript}\n\nRespond only with JSON: {"entities":[], "decisions":[], "facts":[], "preferences":[]}`;

  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 4096,
        messages: [{ role: "user", content: prompt }],
      }),
    });

    if (!response.ok) {
      console.error("Claude API error:", await response.text());
      return { entities: [], decisions: [], facts: [], preferences: [] };
    }

    const data = await response.json();
    const text = data.content
      ?.filter((c: { type: string }) => c.type === "text")
      .map((c: { text: string }) => c.text)
      .join("");

    const match = text?.match(/\{[\s\S]*\}/);
    if (match) {
      return JSON.parse(match[0]);
    }
  } catch (e) {
    console.error("Claude extraction error:", e);
  }

  return { entities: [], decisions: [], facts: [], preferences: [] };
}

async function generateEmbedding(text: string): Promise<number[] | null> {
  try {
    const response = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: "text-embedding-3-small",
        input: text.slice(0, 8000),
        dimensions: 384,
      }),
    });

    if (!response.ok) {
      console.error("OpenAI API error:", await response.text());
      return null;
    }

    const data = await response.json();
    return data.data?.[0]?.embedding || null;
  } catch (e) {
    console.error("Embedding generation error:", e);
    return null;
  }
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const body: IngestRequest = await req.json();

    // Validate input
    if (!body.source || typeof body.source !== "string") {
      return new Response(JSON.stringify({ error: "Missing source" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    if (!body.title || typeof body.title !== "string") {
      return new Response(JSON.stringify({ error: "Missing title" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    if (!body.messages || !Array.isArray(body.messages) || body.messages.length === 0) {
      return new Response(JSON.stringify({ error: "Missing messages" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const mappedSource = mapSource(body.source);
    const formattedTranscript = formatMessages(body.messages);
    const embeddingText = `Title: ${body.title}\nSource: ${mappedSource}\n\n${formattedTranscript}`;
    const ingestedAt = new Date().toISOString();

    // Run Claude extraction and OpenAI embedding in parallel
    const [extracted, embedding] = await Promise.all([
      extractWithClaude(mappedSource, body.title, formattedTranscript),
      generateEmbedding(embeddingText),
    ]);

    // Prepare payload for Supabase
    const payload: Record<string, unknown> = {
      source: mappedSource,
      title: body.title,
      metadata: {
        org: body.org || null,
        message_count: body.messages.length,
        extraction_counts: {
          entities: extracted.entities.length,
          decisions: extracted.decisions.length,
          facts: extracted.facts.length,
          preferences: extracted.preferences.length,
        },
        extracted,
        ingested_at: ingestedAt,
      },
    };

    if (embedding) {
      payload.embedding = `[${embedding.join(",")}]`;
    }

    // Insert into Supabase
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    const { data, error } = await supabase
      .from("conversations")
      .upsert(payload, { onConflict: "title,source" })
      .select("id")
      .single();

    if (error) {
      console.error("Supabase error:", error);
      return new Response(JSON.stringify({ error: error.message }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    return new Response(
      JSON.stringify({
        success: true,
        conversationId: data?.id,
        source: mappedSource,
        title: body.title,
        extracted,
        hasEmbedding: !!embedding,
        message: `Ingested ${body.messages.length} messages`,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (e) {
    console.error("Handler error:", e);
    return new Response(JSON.stringify({ error: String(e) }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
