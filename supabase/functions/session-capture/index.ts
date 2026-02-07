// session-capture/index.ts - v2.0
// Ilmarinen Phase 3: Full Claude.ai Export Ingestion
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.0";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

interface ClaudeMessage {
  uuid: string;
  text: string;
  sender: "human" | "assistant";
  created_at: string;
  updated_at: string;
  attachments?: any[];
  files?: any[];
}

interface ClaudeExport {
  uuid: string;
  name: string;
  created_at: string;
  updated_at: string;
  chat_messages: ClaudeMessage[];
  project?: { uuid: string; name: string } | null;
}

interface ExtractedContent {
  summary: string;
  intent_tags: string[];
  key_decisions: string[];
  key_facts: string[];
  project_code: string | null;
  entities: Array<{ name: string; type: string; context: string }>;
}

async function generateEmbedding(text: string, openaiKey: string): Promise<number[]> {
  const response = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: { "Authorization": `Bearer ${openaiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: "text-embedding-3-small", input: text.slice(0, 8000), dimensions: 384 }),
  });
  if (!response.ok) { console.error("Embedding error:", await response.text()); return []; }
  const data = await response.json();
  return data.data?.[0]?.embedding || [];
}

async function extractWithClaude(messages: ClaudeMessage[], title: string, claudeKey: string): Promise<ExtractedContent> {
  const conversationText = messages.map(m => `${m.sender === 'human' ? 'User' : 'Assistant'}: ${m.text.slice(0, 1000)}`).join('\n\n').slice(0, 12000);
  const prompt = `Analyze this conversation and extract structured information.\n\nTitle: ${title}\n\nConversation:\n${conversationText}\n\nRespond with JSON only:\n{\n  "summary": "2-3 sentence summary",\n  "intent_tags": ["tag1", "tag2"],\n  "key_decisions": ["decision1"],\n  "key_facts": ["fact1"],\n  "project_code": "METIS-001" or null,\n  "entities": [{"name": "name", "type": "type", "context": "context"}]\n}`;

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": claudeKey, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: "claude-haiku-4-5-20251001", max_tokens: 1500, messages: [{ role: "user", content: prompt }] }),
  });

  if (!response.ok) return { summary: `Conversation: ${title}`, intent_tags: [], key_decisions: [], key_facts: [], project_code: null, entities: [] };
  const data = await response.json();
  const text = data.content?.[0]?.text || "";
  try {
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error("No JSON");
    return JSON.parse(jsonMatch[0]);
  } catch { return { summary: `Conversation: ${title}`, intent_tags: [], key_decisions: [], key_facts: [], project_code: null, entities: [] }; }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });

  const sbUrl = Deno.env.get("SUPABASE_URL")!;
  const sbKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const openaiKey = Deno.env.get("OPENAI_API_KEY")!;
  const claudeKey = Deno.env.get("ANTHROPIC_API_KEY") || Deno.env.get("ANTHROPIC_API_KEY2");

  const sb = createClient(sbUrl, sbKey);
  const url = new URL(req.url);
  const path = url.pathname.replace(/^\/session-capture/, "");

  try {
    if (req.method === "POST" && (path === "/ingest" || path === "" || path === "/")) {
      const body = await req.json();

      if (body.chat_messages && Array.isArray(body.chat_messages)) {
        const export_data = body as ClaudeExport;
        if (!export_data.uuid || !export_data.chat_messages.length) {
          return new Response(JSON.stringify({ error: "Invalid Claude export" }), { status: 400, headers: { ...CORS, "Content-Type": "application/json" } });
        }

        const messages = export_data.chat_messages;
        const title = export_data.name || messages[0]?.text?.slice(0, 100) || "Untitled";

        let extracted: ExtractedContent;
        if (claudeKey) { extracted = await extractWithClaude(messages, title, claudeKey); }
        else { extracted = { summary: `${messages.length} messages`, intent_tags: [], key_decisions: [], key_facts: [], project_code: null, entities: [] }; }

        const embeddingText = `${title}\n\n${extracted.summary}\n\nDecisions: ${extracted.key_decisions.join(', ')}`;
        const embedding = await generateEmbedding(embeddingText, openaiKey);

        const metadata = {
          message_count: messages.length,
          first_message_at: messages[0]?.created_at,
          last_message_at: messages[messages.length - 1]?.created_at,
          claude_project: export_data.project?.name || null,
          key_decisions: extracted.key_decisions,
          key_facts: extracted.key_facts,
          entities: extracted.entities,
          capture_method: "session-capture-v2",
          captured_at: new Date().toISOString(),
        };

        const startedAt = messages[0]?.created_at || new Date().toISOString();
        const endedAt = messages[messages.length - 1]?.created_at || new Date().toISOString();

        const { data: conv, error: convError } = await sb.from("conversations").upsert({
          source: "claude_web", external_id: export_data.uuid, title, summary: extracted.summary,
          intent_tags: extracted.intent_tags, participants: ["user", "assistant"], org: "master_layer",
          metadata, embedding: embedding.length ? `[${embedding.join(",")}]` : null,
          started_at: startedAt, ended_at: endedAt, updated_at: new Date().toISOString(),
        }, { onConflict: "external_id" }).select("id").single();

        if (convError) throw convError;

        if (extracted.key_decisions.length && conv?.id) {
          for (const decision of extracted.key_decisions) {
            await sb.from("decisions").insert({ decision_text: decision, context: `From: ${title}`, status: "active", source_conversation_id: conv.id, project_code: extracted.project_code });
          }
        }

        if (extracted.entities.length && conv?.id) {
          for (const entity of extracted.entities) {
            await sb.from("entities").upsert({ name: entity.name, entity_type: entity.type, context: entity.context, source_conversation_id: conv.id }, { onConflict: "name" });
          }
        }

        if (extracted.project_code) {
          const { data: project } = await sb.from("project_briefs").select("id").eq("code", extracted.project_code).single();
          if (project) {
            await sb.from("project_context").upsert({ project_id: project.id, context_type: "conversation", content: { conversation_id: conv?.id, summary: extracted.summary }, source: "session-capture" });
          }
        }

        return new Response(JSON.stringify({
          success: true, conversation_id: conv?.id, external_id: export_data.uuid, title,
          messages_processed: messages.length,
          extracted: { summary: extracted.summary, intent_tags: extracted.intent_tags, decisions_count: extracted.key_decisions.length, entities_count: extracted.entities.length, project_code: extracted.project_code },
        }), { headers: { ...CORS, "Content-Type": "application/json" } });

      } else if (body.chat_url && body.title) {
        const chatIdMatch = body.chat_url.match(/chat\/([a-f0-9-]+)/);
        const externalId = chatIdMatch ? chatIdMatch[1] : body.chat_url;
        const embeddingText = `${body.title}\n\n${body.summary}`;
        const embedding = await generateEmbedding(embeddingText, openaiKey);

        const { data, error } = await sb.from("conversations").upsert({
          source: "claude_web", external_id: externalId, title: body.title, summary: body.summary,
          org: "master_layer", metadata: { key_decisions: body.key_decisions || [], capture_method: "session-capture-manual", captured_at: new Date().toISOString() },
          embedding: embedding.length ? `[${embedding.join(",")}]` : null, started_at: new Date().toISOString(), updated_at: new Date().toISOString(),
        }, { onConflict: "external_id" }).select("id, title").single();

        if (error) throw error;
        return new Response(JSON.stringify({ success: true, conversation_id: data?.id, title: data?.title, message: "Session captured (manual)" }), { headers: { ...CORS, "Content-Type": "application/json" } });
      } else {
        return new Response(JSON.stringify({ error: "Invalid request format" }), { status: 400, headers: { ...CORS, "Content-Type": "application/json" } });
      }
    }

    if (req.method === "POST" && path === "/bulk") {
      const { conversations } = await req.json();
      if (!Array.isArray(conversations)) return new Response(JSON.stringify({ error: "Expected array" }), { status: 400, headers: { ...CORS, "Content-Type": "application/json" } });

      const results = [], errors = [];
      for (const conv of conversations) {
        try {
          const messages = conv.chat_messages || [];
          const title = conv.name || messages[0]?.text?.slice(0, 100) || "Untitled";
          const summary = `${messages.length} messages. ${messages[0]?.text?.slice(0, 200) || ''}...`;
          const embedding = await generateEmbedding(`${title}\n\n${summary}`, openaiKey);

          const { data, error } = await sb.from("conversations").upsert({
            source: "claude_web", external_id: conv.uuid, title, summary, participants: ["user", "assistant"], org: "master_layer",
            metadata: { message_count: messages.length, capture_method: "session-capture-bulk", captured_at: new Date().toISOString() },
            embedding: embedding.length ? `[${embedding.join(",")}]` : null,
            started_at: messages[0]?.created_at || new Date().toISOString(), ended_at: messages[messages.length - 1]?.created_at || new Date().toISOString(), updated_at: new Date().toISOString(),
          }, { onConflict: "external_id" }).select("id").single();

          if (error) throw error;
          results.push({ uuid: conv.uuid, id: data?.id, title });
        } catch (e) { errors.push({ uuid: conv.uuid, error: String(e) }); }
      }
      return new Response(JSON.stringify({ success: true, processed: results.length, failed: errors.length, results, errors: errors.length ? errors : undefined }), { headers: { ...CORS, "Content-Type": "application/json" } });
    }

    if (req.method === "GET" && path === "/stats") {
      const [totalResult, recentResult, sourceResult] = await Promise.all([
        sb.from("conversations").select("id", { count: "exact", head: true }),
        sb.from("conversations").select("id, title, source, created_at").order("created_at", { ascending: false }).limit(5),
        sb.from("conversations").select("source")
      ]);
      const sourceCounts: Record<string, number> = {};
      (sourceResult.data || []).forEach((r: any) => { sourceCounts[r.source] = (sourceCounts[r.source] || 0) + 1; });
      return new Response(JSON.stringify({ total_conversations: totalResult.count || 0, by_source: sourceCounts, recent: recentResult.data || [] }), { headers: { ...CORS, "Content-Type": "application/json" } });
    }

    return new Response(JSON.stringify({ error: "Not found", endpoints: ["POST /ingest", "POST /bulk", "GET /stats"] }), { status: 404, headers: { ...CORS, "Content-Type": "application/json" } });
  } catch (e: any) {
    console.error("session-capture error:", e);
    return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: { ...CORS, "Content-Type": "application/json" } });
  }
});
