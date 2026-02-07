// Metis v1.0.0 - Full Memory Integration + Multi-Model Support
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.39.0";

// ============================================================================
// TYPES
// ============================================================================

interface Message { role: "user" | "assistant" | "system"; content: string; }
interface OrchestrateRequest {
  messages: Message[];
  user_id: string;
  session_id?: string;
  request_id?: string;
  project_code?: string;
  model_preference?: "anthropic" | "openai" | "auto";
  debug?: boolean;
}

interface AgentOutput {
  agent: string;
  timestamp: string;
  blocks: Block[];
  sources: Source[];
  reasoning?: string;
  tools_used?: ToolUse[];
  _quality?: QualityEvaluation;
}

type Block =
  | { type: "text"; content: string; format?: string }
  | { type: "table"; title?: string; columns: Column[]; rows: Record<string, any>[] }
  | { type: "alert"; severity: string; message: string }
  | { type: "memory"; matches: MemoryMatch[] };

interface Column { key: string; label: string; }
interface Source { id: string; title: string; url?: string; retrieved_at: string; type: string; }
interface ToolUse { tool: string; input: any; output?: any; latency_ms: number; }

interface MemoryMatch {
  id: string;
  title: string;
  source: string;
  similarity: number;
  snippet?: string;
}

interface CoSAssessment {
  clarity: string;
  clarifying_questions?: string[];
  complexity: string;
  primary_agent?: string;
  domains: string[];
  requires_live_data: boolean;
  requires_memory: boolean;
  reasoning: string;
}

interface QualityEvaluation {
  decision: string;
  issues: { type: string; description: string; severity: string }[];
  caveats: string[];
  reasoning: string;
  attempt: number;
}

interface TokenUsage { input_tokens: number; output_tokens: number; }
interface CostBreakdown { model: string; input_tokens: number; output_tokens: number; total_usd: number; }

interface ProjectBrief {
  code: string;
  name: string;
  status: string;
  summary: string | null;
  scope: any;
  phases: any[];
  current_phase: number;
}

interface ArchitectureRules {
  source_of_truth: string;
  allowed_mcp: string[];
  allowed_apis: string[];
  read_only_services: string[];
}

interface LoadedContext {
  project_brief: ProjectBrief | null;
  architecture: ArchitectureRules;
  decisions: any[];
  memory_matches: MemoryMatch[];
  system_prompt: string;
}

// ============================================================================
// CONSTANTS
// ============================================================================

const VERSION = "v1.0.0";
const ANTHROPIC_MODEL = "claude-haiku-4-5-20251001";
const OPENAI_MODEL = "gpt-4o-mini";

const PRICING: Record<string, { input: number; output: number }> = {
  "claude-haiku-4-5-20251001": { input: 1.00e-6, output: 5.00e-6 },
  "claude-sonnet-4-20250514": { input: 3.00e-6, output: 15.00e-6 },
  "claude-opus-4-20250514": { input: 15.00e-6, output: 75.00e-6 },
  "gpt-4o-mini": { input: 0.15e-6, output: 0.60e-6 },
  "gpt-4o": { input: 2.50e-6, output: 10.00e-6 },
};

const DEFAULT_ARCHITECTURE: ArchitectureRules = {
  source_of_truth: "supabase",
  allowed_mcp: ["supabase", "slack", "figma", "n8n", "asana"],
  allowed_apis: ["anthropic", "openai", "yahoo_finance", "coingecko"],
  read_only_services: ["notion"],
};

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const RECENCY = /\b(today|tonight|currently|right now|latest|newest|most recent)\b/i;
const MEMORY_TRIGGERS = /\b(remember|recall|previously|last time|we discussed|you said|earlier|before)\b/i;

// ============================================================================
// MEMORY FUNCTIONS
// ============================================================================

async function generateEmbedding(text: string, openaiKey: string): Promise<number[] | null> {
  try {
    const r = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${openaiKey}` },
      body: JSON.stringify({ model: "text-embedding-3-small", input: text.slice(0, 8000), dimensions: 384 }),
    });
    if (!r.ok) return null;
    const d = await r.json();
    return d.data?.[0]?.embedding || null;
  } catch { return null; }
}

async function memoryRecall(
  sb: SupabaseClient,
  query: string,
  openaiKey: string,
  limit = 5
): Promise<MemoryMatch[]> {
  const embedding = await generateEmbedding(query, openaiKey);
  if (!embedding) return [];

  const { data, error } = await sb.rpc("search_conversations_semantic", {
    query_embedding: `[${embedding.join(",")}]`,
    match_threshold: 0.35,
    match_count: limit,
    filter_source: null,
    filter_org: null,
  });

  if (error) {
    console.error("Memory recall error:", error);
    return [];
  }

  return (data || []).map((r: any) => ({
    id: r.id,
    title: r.title,
    source: r.source,
    similarity: Math.round((r.similarity || 0) * 1000) / 1000,
    snippet: r.metadata?.extracted?.summary || null,
  }));
}

async function memoryIngest(
  sb: SupabaseClient,
  anthropicKey: string,
  openaiKey: string,
  messages: Message[],
  sessionId: string,
  userId: string
): Promise<{ conversationId: string | null; extracted: any }> {
  const transcript = messages.map((m, i) => `[${i + 1}] ${m.role.toUpperCase()}:\n${m.content}`).join("\n\n---\n\n");
  const title = `Session ${sessionId} - ${new Date().toISOString().split("T")[0]}`;

  // Extract with Claude
  let extracted = { entities: [], decisions: [], facts: [], preferences: [] };
  try {
    const prompt = `Extract key information from this conversation as JSON.\nTranscript: ${transcript.slice(0, 4000)}\n\nRespond only with JSON: {"entities":[{"name":"","type":""}], "decisions":[{"subject":"","choice":""}], "facts":[{"statement":"","confidence":""}], "preferences":[{"key":"","value":""}]}`;
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": anthropicKey, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: ANTHROPIC_MODEL, max_tokens: 1024, messages: [{ role: "user", content: prompt }] }),
    });
    if (r.ok) {
      const d = await r.json();
      const m = (d.content?.[0]?.text || "").match(/\{[\s\S]*\}/);
      if (m) extracted = JSON.parse(m[0]);
    }
  } catch (e) { console.error("Extraction error:", e); }

  // Generate embedding
  const embedding = await generateEmbedding(`${title}\n\n${transcript}`, openaiKey);

  // Store conversation
  const payload: any = {
    source: "metis_orchestrator",
    title,
    metadata: {
      user_id: userId,
      session_id: sessionId,
      message_count: messages.length,
      extracted,
      ingested_at: new Date().toISOString(),
    },
  };
  if (embedding) payload.embedding = `[${embedding.join(",")}]`;

  const { data, error } = await sb.from("conversations").insert(payload).select("id").single();
  if (error) console.error("Ingest error:", error);

  return { conversationId: data?.id || null, extracted };
}

// ============================================================================
// CONTEXT LOADING
// ============================================================================

async function loadContext(
  sb: SupabaseClient,
  openaiKey: string,
  projectCode?: string,
  query?: string
): Promise<LoadedContext> {
  const context: LoadedContext = {
    project_brief: null,
    architecture: DEFAULT_ARCHITECTURE,
    decisions: [],
    memory_matches: [],
    system_prompt: "",
  };

  // Load project_context (global architecture rules)
  const { data: pc } = await sb
    .from("project_context")
    .select("architecture, decisions")
    .eq("project_name", "master_layer")
    .single();

  if (pc?.architecture) {
    const arch = pc.architecture as any;
    if (arch.connections?.mcp) {
      context.architecture.allowed_mcp = Object.keys(arch.connections.mcp).filter(
        k => arch.connections.mcp[k]?.status === "active"
      );
    }
  }

  // Load project brief if code provided
  if (projectCode) {
    const { data: brief } = await sb
      .from("project_briefs")
      .select("code, name, status, summary, scope, phases, current_phase")
      .eq("code", projectCode)
      .single();
    if (brief) context.project_brief = brief as ProjectBrief;
  }

  // Load recent decisions
  const { data: decisions } = await sb
    .from("decisions")
    .select("subject, choice, rationale, made_at")
    .eq("status", "active")
    .order("made_at", { ascending: false })
    .limit(5);
  if (decisions) context.decisions = decisions;

  // Memory recall if query provided
  if (query && MEMORY_TRIGGERS.test(query)) {
    context.memory_matches = await memoryRecall(sb, query, openaiKey, 3);
  }

  context.system_prompt = buildSystemPrompt(context);
  return context;
}

function buildSystemPrompt(ctx: LoadedContext): string {
  const parts: string[] = [];

  if (ctx.project_brief) {
    const pb = ctx.project_brief;
    parts.push(`PROJECT CONTEXT: ${pb.code} - ${pb.name}`);
    parts.push(`Status: ${pb.status} | Phase: ${pb.current_phase}`);
    if (pb.summary) parts.push(`Summary: ${pb.summary}`);
    const currentPhase = pb.phases?.find((p: any) => p.phase === pb.current_phase);
    if (currentPhase) {
      parts.push(`Current Phase: ${currentPhase.name} [${currentPhase.status}]`);
      if (currentPhase.tasks) {
        const tasks = currentPhase.tasks.map((t: any) => `${t.name} [${t.status}]`).join(", ");
        parts.push(`Tasks: ${tasks}`);
      }
    }
    parts.push("");
  }

  if (ctx.memory_matches.length > 0) {
    parts.push("RELEVANT MEMORY:");
    for (const m of ctx.memory_matches) {
      parts.push(`- ${m.title} (${m.source}, similarity: ${m.similarity})`);
    }
    parts.push("");
  }

  if (ctx.decisions.length > 0) {
    parts.push("RECENT DECISIONS:");
    for (const d of ctx.decisions.slice(0, 3)) {
      parts.push(`- ${d.subject}: ${d.choice}`);
    }
    parts.push("");
  }

  parts.push(`Architecture: Source of truth is ${ctx.architecture.source_of_truth}. Notion is read-only.`);
  return parts.join("\n");
}

// ============================================================================
// MODEL CLIENTS
// ============================================================================

async function callAnthropic(
  messages: Message[],
  key: string,
  model: string,
  systemPrompt?: string,
  maxTokens = 2048
): Promise<{ text: string; usage: TokenUsage }> {
  const apiMsgs = messages.filter(m => m.role !== "system").map(m => ({ role: m.role, content: m.content }));

  if (systemPrompt && apiMsgs.length > 0) {
    apiMsgs[0] = { role: apiMsgs[0].role, content: `<context>\n${systemPrompt}\n</context>\n\n${apiMsgs[0].content}` };
  }

  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model, max_tokens: maxTokens, messages: apiMsgs }),
  });

  if (!r.ok) throw new Error(`Anthropic API ${r.status}: ${await r.text()}`);
  const d = await r.json();
  return {
    text: d.content?.[0]?.text || "",
    usage: { input_tokens: d.usage?.input_tokens || 0, output_tokens: d.usage?.output_tokens || 0 },
  };
}

async function callOpenAI(
  messages: Message[],
  key: string,
  model: string,
  systemPrompt?: string,
  maxTokens = 2048
): Promise<{ text: string; usage: TokenUsage }> {
  const apiMsgs: { role: string; content: string }[] = [];
  if (systemPrompt) apiMsgs.push({ role: "system", content: systemPrompt });
  for (const m of messages) {
    if (m.role !== "system") apiMsgs.push({ role: m.role, content: m.content });
  }

  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${key}` },
    body: JSON.stringify({ model, max_tokens: maxTokens, messages: apiMsgs }),
  });

  if (!r.ok) throw new Error(`OpenAI API ${r.status}: ${await r.text()}`);
  const d = await r.json();
  return {
    text: d.choices?.[0]?.message?.content || "",
    usage: { input_tokens: d.usage?.prompt_tokens || 0, output_tokens: d.usage?.completion_tokens || 0 },
  };
}

// ============================================================================
// CHIEF OF STAFF
// ============================================================================

async function cosAssess(
  messages: Message[],
  key: string,
  ctx: LoadedContext
): Promise<{ assessment: CoSAssessment; usage: TokenUsage }> {
  const last = messages.filter(m => m.role === "user").pop()?.content || "";

  // Trivial check
  if (/^(hi|hello|hey|thanks|ok|sure|yes|no)[\s!?.]*$/i.test(last.trim())) {
    return {
      assessment: { clarity: "clear", complexity: "trivial", domains: ["general"], requires_live_data: false, requires_memory: false, reasoning: "Trivial" },
      usage: { input_tokens: 0, output_tokens: 0 },
    };
  }

  // Project context fast-path
  if (ctx.project_brief && /\b(this project|the project|current phase|project status|METIS|ILMARINEN)\b/i.test(last)) {
    return {
      assessment: { clarity: "clear", complexity: "single_agent", primary_agent: "general", domains: ["project"], requires_live_data: false, requires_memory: false, reasoning: `Project ${ctx.project_brief.code} context loaded` },
      usage: { input_tokens: 0, output_tokens: 0 },
    };
  }

  const isMkt = /\b(stock|market|crypto|bitcoin|btc|eth|nasdaq|s&p|dow|price|portfolio)\b/i.test(last);
  const needsMemory = MEMORY_TRIGGERS.test(last);

  const prompt = `Route query. JSON only. Query:"${last.slice(0, 500)}" {"clarity":"clear|needs_clarification","clarifying_questions":[],"complexity":"trivial|single_agent|multi_agent","primary_agent":"market_intel|general","domains":[],"requires_live_data":bool,"requires_memory":bool,"reasoning":"brief"}`;

  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: ANTHROPIC_MODEL, max_tokens: 300, messages: [{ role: "user", content: prompt }] }),
    });
    if (r.ok) {
      const d = await r.json();
      const m = (d.content?.[0]?.text || "").match(/\{[\s\S]*\}/);
      if (m) {
        const p = JSON.parse(m[0]);
        if (isMkt) { p.primary_agent = "market_intel"; p.domains = [...new Set([...(p.domains || []), "financial"])]; }
        if (needsMemory) p.requires_memory = true;
        return { assessment: p, usage: { input_tokens: d.usage?.input_tokens || 0, output_tokens: d.usage?.output_tokens || 0 } };
      }
    }
  } catch (e) { console.error("CoS error:", e); }

  return {
    assessment: { clarity: "clear", complexity: isMkt ? "single_agent" : "trivial", primary_agent: isMkt ? "market_intel" : "general", domains: isMkt ? ["financial"] : ["general"], requires_live_data: isMkt, requires_memory: needsMemory, reasoning: "Fallback" },
    usage: { input_tokens: 0, output_tokens: 0 },
  };
}

// ============================================================================
// AGENTS
// ============================================================================

interface MktData { symbol: string; name?: string; price?: number; changePercent?: number; timestamp?: string; }

async function fetchYahoo(sym: string): Promise<MktData | null> {
  try {
    const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=1d&range=1d`, { headers: { "User-Agent": "Mozilla/5.0" } });
    if (!r.ok) return null;
    const d = await r.json(); const m = d.chart?.result?.[0]?.meta; if (!m) return null;
    return { symbol: m.symbol, name: m.shortName, price: m.regularMarketPrice, changePercent: m.previousClose ? ((m.regularMarketPrice - m.previousClose) / m.previousClose) * 100 : 0, timestamp: new Date((m.regularMarketTime || 0) * 1000).toISOString() };
  } catch { return null; }
}

async function fetchCrypto(sym: string): Promise<MktData | null> {
  const map: Record<string, string> = { BTC: "bitcoin", ETH: "ethereum", SOL: "solana" };
  try {
    const r = await fetch(`https://api.coingecko.com/api/v3/coins/${map[sym.toUpperCase()] || sym.toLowerCase()}?localization=false&tickers=false&community_data=false&developer_data=false`);
    if (!r.ok) return null; const d = await r.json(); const m = d.market_data;
    return { symbol: d.symbol?.toUpperCase(), name: d.name, price: m?.current_price?.usd, changePercent: m?.price_change_percentage_24h, timestamp: new Date().toISOString() };
  } catch { return null; }
}

async function marketAgent(query: string, anthropicKey: string, systemPrompt?: string): Promise<{ output: AgentOutput; usage: TokenUsage }> {
  const ts = new Date().toISOString();
  const tu: ToolUse[] = []; const src: Source[] = []; const blk: Block[] = [];
  let usage: TokenUsage = { input_tokens: 0, output_tokens: 0 };

  const t0 = Date.now();
  const [stk, cry] = await Promise.all([Promise.all(["^GSPC", "^DJI", "^IXIC"].map(fetchYahoo)), Promise.all(["BTC", "ETH"].map(fetchCrypto))]);
  tu.push({ tool: "data_fetch", input: {}, output: { stocks: stk.filter(Boolean).length, crypto: cry.filter(Boolean).length }, latency_ms: Date.now() - t0 });

  const vs = stk.filter((d): d is MktData => d !== null);
  const vc = cry.filter((d): d is MktData => d !== null);

  if (vs.length) {
    blk.push({ type: "table", title: "US Markets", columns: [{ key: "symbol", label: "Symbol" }, { key: "name", label: "Name" }, { key: "price", label: "Price" }, { key: "chg", label: "Change" }], rows: vs.map(d => ({ symbol: d.symbol, name: d.name || d.symbol, price: `$${d.price?.toFixed(2)}`, chg: `${d.changePercent?.toFixed(2)}%` })) });
    src.push({ id: "yahoo", title: "Yahoo Finance", url: "https://finance.yahoo.com", retrieved_at: ts, type: "api" });
  }
  if (vc.length) {
    blk.push({ type: "table", title: "Crypto", columns: [{ key: "symbol", label: "Symbol" }, { key: "name", label: "Name" }, { key: "price", label: "Price" }, { key: "chg", label: "24h" }], rows: vc.map(d => ({ symbol: d.symbol, name: d.name, price: `$${d.price?.toLocaleString()}`, chg: `${d.changePercent?.toFixed(2)}%` })) });
    src.push({ id: "coingecko", title: "CoinGecko", url: "https://coingecko.com", retrieved_at: ts, type: "api" });
  }

  const ap = `Brief analysis. Stocks:${vs.map(d => `${d.symbol}:$${d.price?.toFixed(0)}(${d.changePercent?.toFixed(1)}%)`).join(",")} Crypto:${vc.map(d => `${d.symbol}:$${d.price?.toLocaleString()}(${d.changePercent?.toFixed(1)}%)`).join(",")} Q:"${query}" 2-3 sentences.`;
  try {
    const res = await callAnthropic([{ role: "user", content: ap }], anthropicKey, ANTHROPIC_MODEL, systemPrompt, 300);
    blk.unshift({ type: "text", content: res.text, format: "markdown" });
    usage = res.usage;
  } catch (e) { console.error("Analysis error:", e); }

  blk.push({ type: "alert", severity: "info", message: `Data as of ${new Date(vs[0]?.timestamp || ts).toLocaleString()} UTC` });
  return { output: { agent: "market_intel", timestamp: ts, blocks: blk, sources: src, tools_used: tu, reasoning: `${vs.length} stocks, ${vc.length} crypto` }, usage };
}

async function generalAgent(
  msgs: Message[],
  provider: "anthropic" | "openai",
  anthropicKey: string,
  openaiKey: string,
  systemPrompt?: string
): Promise<{ output: AgentOutput; usage: TokenUsage; model: string }> {
  let text: string;
  let usage: TokenUsage;
  let model: string;

  if (provider === "openai") {
    model = OPENAI_MODEL;
    const res = await callOpenAI(msgs, openaiKey, model, systemPrompt);
    text = res.text;
    usage = res.usage;
  } else {
    model = ANTHROPIC_MODEL;
    const res = await callAnthropic(msgs, anthropicKey, model, systemPrompt);
    text = res.text;
    usage = res.usage;
  }

  return {
    output: { agent: "general", timestamp: new Date().toISOString(), blocks: [{ type: "text", content: text, format: "markdown" }], sources: [], reasoning: `Via ${model}` },
    usage,
    model,
  };
}

// ============================================================================
// QUALITY CHECKS
// ============================================================================

function checkQuality(output: AgentOutput, assessment: CoSAssessment): { type: string; description: string; severity: string }[] {
  const issues: { type: string; description: string; severity: string }[] = [];
  const text = output.blocks.filter(b => b.type === "text").map(b => (b as any).content).join(" ");
  if (RECENCY.test(text) && output.sources.length === 0) {
    issues.push({ type: "hallucinated_recency", description: "Temporal claims without sources", severity: "warning" });
  }
  if (assessment.domains.includes("financial") && output.sources.length === 0) {
    issues.push({ type: "unsourced_claim", description: "Financial query without sources", severity: "warning" });
  }
  return issues;
}

function calcCost(usage: TokenUsage, model: string): CostBreakdown {
  const p = PRICING[model] || PRICING[ANTHROPIC_MODEL];
  return { model, ...usage, total_usd: (usage.input_tokens * p.input) + (usage.output_tokens * p.output) };
}

function formatText(out: AgentOutput): string {
  const p: string[] = [];
  for (const b of out.blocks) {
    if (b.type === "text") p.push((b as any).content);
    else if (b.type === "table") {
      if (b.title) p.push(`\n**${b.title}**`);
      const c = b.columns;
      p.push(`\n${c.map(x => x.label).join(" | ")}\n${c.map(() => "---").join(" | ")}\n${b.rows.map(r => c.map(x => r[x.key] ?? "-").join(" | ")).join("\n")}`);
    } else if (b.type === "alert") p.push(`\n> **${b.severity.toUpperCase()}**: ${b.message}`);
    else if (b.type === "memory" && b.matches.length > 0) {
      p.push(`\n**Relevant Memory:**`);
      b.matches.forEach(m => p.push(`- ${m.title} (${m.similarity})`));
    }
  }
  if (out.sources.length) {
    p.push("\n\n**Sources:**");
    out.sources.forEach((s, i) => p.push(`${i + 1}. [${s.title}](${s.url})`));
  }
  if (out._quality?.caveats?.length) {
    p.push("\n\n**Caveats:**");
    out._quality.caveats.forEach(c => p.push(`- ${c}`));
  }
  return p.join("\n");
}

// ============================================================================
// MAIN HANDLER
// ============================================================================

Deno.serve(async (req: Request) => {
  const url = new URL(req.url);
  const path = url.pathname.replace(/^\/orchestrate/, "");
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });

  const anthropicKey = Deno.env.get("ANTHROPIC_API_KEY2");
  const openaiKey = Deno.env.get("OPENAI_API_KEY");
  if (!anthropicKey) return new Response(JSON.stringify({ error: "Anthropic API key missing" }), { status: 500, headers: { ...CORS, "Content-Type": "application/json" } });
  if (!openaiKey) return new Response(JSON.stringify({ error: "OpenAI API key missing" }), { status: 500, headers: { ...CORS, "Content-Type": "application/json" } });

  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  try {
    // Health check
    if (req.method === "GET" && path === "/health") {
      return new Response(JSON.stringify({
        status: "ok",
        version: VERSION,
        timestamp: new Date().toISOString(),
        features: ["memory_recall", "memory_ingest", "multi_model", "context_loading", "quality_gate", "market_intel"],
        models: { anthropic: ANTHROPIC_MODEL, openai: OPENAI_MODEL },
      }), { headers: { ...CORS, "Content-Type": "application/json" } });
    }

    // Main orchestration
    if (req.method === "POST" && (path === "" || path === "/")) {
      const t0 = Date.now();
      const body: OrchestrateRequest = await req.json();

      if (!body.messages?.length || !body.user_id) {
        return new Response(JSON.stringify({ error: "messages and user_id required" }), { status: 400, headers: { ...CORS, "Content-Type": "application/json" } });
      }

      const sessionId = body.session_id || crypto.randomUUID();
      const lastQuery = body.messages.filter(m => m.role === "user").pop()?.content || "";

      // Load context with potential memory recall
      const context = await loadContext(sb, openaiKey, body.project_code, lastQuery);

      let tu: TokenUsage = { input_tokens: 0, output_tokens: 0 };

      // CoS assessment
      const { assessment, usage: au } = await cosAssess(body.messages, anthropicKey, context);
      tu.input_tokens += au.input_tokens;
      tu.output_tokens += au.output_tokens;

      // Handle clarification
      if (assessment.clarity === "needs_clarification" && assessment.clarifying_questions?.length) {
        return new Response(JSON.stringify({
          response: `Clarifying:\n${assessment.clarifying_questions.map((q, i) => `${i + 1}. ${q}`).join("\n")}`,
          routing: { assessment, decision: { agent: "cos", model: ANTHROPIC_MODEL, reason: "ambiguous" } },
          cost: { actual: calcCost(tu, ANTHROPIC_MODEL) },
          context: { loaded: !!context.system_prompt, project_code: body.project_code, memory_matches: context.memory_matches.length },
          session_id: sessionId,
          latency_ms: Date.now() - t0,
        }), { headers: { ...CORS, "Content-Type": "application/json" } });
      }

      // Determine model provider
      const provider = body.model_preference === "openai" ? "openai" : "anthropic";

      // Execute agent
      let out: AgentOutput;
      let model: string;

      if (assessment.primary_agent === "market_intel") {
        const res = await marketAgent(lastQuery, anthropicKey, context.system_prompt);
        out = res.output;
        tu.input_tokens += res.usage.input_tokens;
        tu.output_tokens += res.usage.output_tokens;
        model = ANTHROPIC_MODEL;
      } else {
        const res = await generalAgent(body.messages, provider, anthropicKey, openaiKey, context.system_prompt);
        out = res.output;
        tu.input_tokens += res.usage.input_tokens;
        tu.output_tokens += res.usage.output_tokens;
        model = res.model;
      }

      // Add memory matches to output if present
      if (context.memory_matches.length > 0) {
        out.blocks.push({ type: "memory", matches: context.memory_matches });
      }

      // Quality check
      const issues = checkQuality(out, assessment);
      const quality: QualityEvaluation = {
        decision: issues.some(i => i.severity === "blocking") ? "accept_with_caveat" : "accept",
        issues,
        caveats: issues.filter(i => i.severity !== "info").map(i => i.description),
        reasoning: issues.length ? `Issues: ${issues.map(i => i.type).join(", ")}` : "OK",
        attempt: 1,
      };
      out._quality = quality;

      const lat = Date.now() - t0;
      const txt = formatText(out);
      const cost = calcCost(tu, model);

      // Log transcript
      const { data: tx } = await sb.from("transcripts").insert({
        user_id: body.user_id,
        session_id: sessionId,
        request_id: body.request_id,
        intent: assessment.primary_agent || "general",
        domain: assessment.domains[0] || "general",
        risk_tier: assessment.complexity === "multi_agent" ? "medium" : "low",
        complexity_score: ["trivial", "single_agent", "multi_agent"].indexOf(assessment.complexity) * 0.33,
        routed_model: model,
        routing_reason: assessment.reasoning,
        input_messages: body.messages,
        output_message: { role: "assistant", content: txt },
        latency_ms: lat,
        status: "completed",
        metadata: {
          version: VERSION,
          assessment,
          quality,
          cost,
          context_loaded: !!context.system_prompt,
          project_code: body.project_code,
          memory_matches: context.memory_matches.length,
          provider,
        },
      }).select("id").single();

      // Background memory ingest (don't await to keep response fast)
      if (body.messages.length >= 2) {
        memoryIngest(sb, anthropicKey, openaiKey, body.messages, sessionId, body.user_id).catch(e => console.error("Ingest error:", e));
      }

      return new Response(JSON.stringify({
        response: txt,
        output: out,
        routing: { assessment, decision: { agent: out.agent, model, reason: assessment.reasoning } },
        quality,
        cost: {
          actual: cost,
          comparison: {
            haiku_estimate: (tu.input_tokens * 1.00e-6) + (tu.output_tokens * 5.00e-6),
            sonnet_estimate: (tu.input_tokens * 3.00e-6) + (tu.output_tokens * 15.00e-6),
            opus_estimate: (tu.input_tokens * 15.00e-6) + (tu.output_tokens * 75.00e-6),
            gpt4o_mini_estimate: (tu.input_tokens * 0.15e-6) + (tu.output_tokens * 0.60e-6),
          },
        },
        context: {
          loaded: !!context.system_prompt,
          project_code: body.project_code,
          project_name: context.project_brief?.name,
          memory_matches: context.memory_matches.length,
        },
        session_id: sessionId,
        transcript_id: tx?.id,
        latency_ms: lat,
      }), { headers: { ...CORS, "Content-Type": "application/json" } });
    }

    return new Response(JSON.stringify({ error: "Not found" }), { status: 404, headers: { ...CORS, "Content-Type": "application/json" } });
  } catch (e: any) {
    console.error("Error:", e);
    return new Response(JSON.stringify({ error: "Internal error", message: e.message }), { status: 500, headers: { ...CORS, "Content-Type": "application/json" } });
  }
});
