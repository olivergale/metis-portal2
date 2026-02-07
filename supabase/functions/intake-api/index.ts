// METIS Intake API v2 - Unified intake for all request sources
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.0";

var CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type"
};

// Simple in-memory rate limiter (per-source, resets on cold start)
var rateLimits: Record<string, { count: number; windowStart: number }> = {};
var RATE_LIMIT = 30;
var RATE_WINDOW_MS = 60 * 1000;

function checkRateLimit(source: string): boolean {
  var now = Date.now();
  var key = source || "unknown";
  if (!rateLimits[key] || now - rateLimits[key].windowStart > RATE_WINDOW_MS) {
    rateLimits[key] = { count: 1, windowStart: now };
    return true;
  }
  rateLimits[key].count++;
  return rateLimits[key].count <= RATE_LIMIT;
}

interface IntakeRequest {
  source: string;
  title: string;
  description?: string;
  urgency?: string;
  requester?: string;
}

interface Classification {
  type: "question" | "build" | "research" | "admin";
  confidence: number;
  reasoning: string;
  suggested_priority?: string;
  suggested_tags?: string[];
}

async function classifyRequest(
  title: string,
  description: string,
  claudeKey: string
): Promise<Classification> {
  var prompt = "You are a request classifier for an AI engineering platform (METIS).\n";
  prompt += "Classify this incoming request into exactly one category.\n\n";
  prompt += "Request title: " + title + "\n";
  prompt += "Description: " + (description || "(none)") + "\n\n";
  prompt += "Categories:\n";
  prompt += "- question: Asking about status, data, how something works, or requesting information. No code changes needed.\n";
  prompt += "- build: Requesting new features, bug fixes, deployments, code changes, or infrastructure work.\n";
  prompt += "- research: Requesting investigation, analysis, exploration, or design work before building.\n";
  prompt += "- admin: Administrative tasks like access requests, config changes, cleanup, or process changes.\n\n";
  prompt += "Respond with JSON only:\n";
  prompt += '{"type": "question|build|research|admin", "confidence": 0.0-1.0, "reasoning": "brief explanation", "suggested_priority": "p0_critical|p1_high|p2_medium|p3_low", "suggested_tags": ["tag1"]}';

  var resp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": claudeKey,
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 300,
      messages: [{ role: "user", content: prompt }]
    })
  });

  if (!resp.ok) {
    throw new Error("Classification failed: " + resp.status);
  }

  var data = await resp.json();
  var text = data.content && data.content[0] && data.content[0].text || "";
  var jsonMatch = text.match(/\{[\s\S]*\}/);

  if (!jsonMatch) {
    return { type: "admin", confidence: 0.3, reasoning: "Classification parse failed, defaulting to admin" };
  }

  return JSON.parse(jsonMatch[0]);
}

async function routeQuestion(
  title: string,
  description: string,
  sbUrl: string,
  anonKey: string
): Promise<string> {
  var message = title;
  if (description) {
    message = title + "\n\n" + description;
  }

  var resp = await fetch(sbUrl + "/functions/v1/portal-chat", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": "Bearer " + anonKey
    },
    body: JSON.stringify({
      message: message,
      project_id: "ENDGAME-001"
    })
  });

  if (!resp.ok) {
    var errText = await resp.text();
    throw new Error("Portal-chat routing failed: " + resp.status + " - " + errText);
  }

  var data = await resp.json();
  return data.message || data.response || JSON.stringify(data);
}

async function createWorkOrder(
  sb: any,
  classification: Classification,
  intake: IntakeRequest,
  claudeKey: string
): Promise<{ id: string; slug: string }> {
  var prompt = "You are structuring a work order for an AI engineering platform.\n\n";
  prompt += "Title: " + intake.title + "\n";
  prompt += "Description: " + (intake.description || "(none)") + "\n";
  prompt += "Type: " + classification.type + "\n";
  prompt += "Source: " + intake.source + "\n";
  prompt += "Urgency: " + (intake.urgency || "normal") + "\n\n";
  prompt += "Create a structured work order. Respond with JSON only:\n";
  prompt += '{"name": "short title (max 60 chars)", "objective": "1-3 sentence objective", "constraints": "bullet constraints", "acceptance_criteria": "numbered testable criteria", "complexity": "trivial|small|medium|large|unknown", "tags": ["tag1"]}';

  var resp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": claudeKey,
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 800,
      messages: [{ role: "user", content: prompt }]
    })
  });

  if (!resp.ok) {
    throw new Error("WO structuring failed: " + resp.status);
  }

  var data = await resp.json();
  var text = data.content && data.content[0] && data.content[0].text || "";
  var jsonMatch = text.match(/\{[\s\S]*\}/);
  var parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : {
    name: intake.title.slice(0, 60),
    objective: intake.description || intake.title,
    constraints: "None specified",
    acceptance_criteria: "Verify implementation meets request",
    complexity: "unknown",
    tags: []
  };

  var randomSuffix = Math.random().toString(36).slice(2, 8).toUpperCase();
  var slug = "WO-" + randomSuffix;

  var priority = classification.suggested_priority || "p2_medium";
  if (intake.urgency === "critical" || intake.urgency === "urgent") {
    priority = "p1_high";
  }

  var tags = (classification.suggested_tags || []).concat(parsed.tags || []);
  if (classification.type === "research") {
    tags.push("research");
  }
  tags = tags.filter(function(t: string, i: number, arr: string[]) { return arr.indexOf(t) === i; });

  var woData = {
    slug: slug,
    name: parsed.name || intake.title.slice(0, 60),
    objective: parsed.objective,
    constraints: parsed.constraints,
    acceptance_criteria: parsed.acceptance_criteria,
    priority: priority,
    complexity: parsed.complexity || "unknown",
    tags: tags,
    status: "draft",
    source: "intake_api",
    project_brief_id: "7558abf4-78d4-4ca2-a4dd-457f5b061e25",
    max_iterations: 10,
    client_info: {
      intake_source: intake.source,
      requester: intake.requester,
      urgency: intake.urgency,
      classification: classification
    }
  };

  var result = await sb.from("work_orders").insert(woData).select("id, slug").single();

  if (result.error) {
    throw new Error("WO creation failed: " + result.error.message);
  }

  return { id: result.data.id, slug: result.data.slug };
}

Deno.serve(async function(req: Request) {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: CORS });
  }

  if (req.method !== "POST") {
    return new Response(
      JSON.stringify({ error: "POST required" }),
      { status: 405, headers: Object.assign({}, CORS, { "Content-Type": "application/json" }) }
    );
  }

  var startTime = Date.now();
  var sbUrl = Deno.env.get("SUPABASE_URL");
  var sbServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  var sbAnonKey = Deno.env.get("SUPABASE_ANON_KEY") || Deno.env.get("SB_ANON_KEY");
  var claudeKey = Deno.env.get("ANTHROPIC_API_KEY") || Deno.env.get("ANTHROPIC_API_KEY2");

  if (!sbUrl || !sbServiceKey || !claudeKey) {
    return new Response(
      JSON.stringify({ error: "Server configuration error" }),
      { status: 500, headers: Object.assign({}, CORS, { "Content-Type": "application/json" }) }
    );
  }

  var sb = createClient(sbUrl, sbServiceKey);

  try {
    var body = await req.json() as IntakeRequest;
    var source = body.source || "unknown";
    var title = body.title;
    var description = body.description || "";
    var urgency = body.urgency || "normal";
    var requester = body.requester || "anonymous";

    if (!title) {
      return new Response(
        JSON.stringify({ error: "title is required" }),
        { status: 400, headers: Object.assign({}, CORS, { "Content-Type": "application/json" }) }
      );
    }

    if (!checkRateLimit(source)) {
      return new Response(
        JSON.stringify({ error: "Rate limit exceeded. Max " + RATE_LIMIT + " requests per minute per source." }),
        { status: 429, headers: Object.assign({}, CORS, { "Content-Type": "application/json" }) }
      );
    }

    // Step 1: Classify
    var classification = await classifyRequest(title, description, claudeKey);

    // Step 2: Route based on classification
    var routed_to = "";
    var work_order_id: string | null = null;
    var work_order_slug: string | null = null;
    var response: string | null = null;

    if (classification.type === "question") {
      routed_to = "portal-chat";
      var chatKey = sbAnonKey || sbServiceKey;
      response = await routeQuestion(title, description, sbUrl, chatKey);

    } else if (classification.type === "build") {
      routed_to = "ilmarinen";
      var wo = await createWorkOrder(sb, classification, body, claudeKey);
      work_order_id = wo.id;
      work_order_slug = wo.slug;
      response = "Work order created: " + wo.slug + ". Assigned to build queue.";

    } else if (classification.type === "research") {
      routed_to = "metis";
      var wo = await createWorkOrder(sb, classification, body, claudeKey);
      work_order_id = wo.id;
      work_order_slug = wo.slug;
      response = "Research work order created: " + wo.slug + ". Assigned to METIS for investigation.";

    } else {
      routed_to = "metis";
      response = "Administrative request logged. Will be reviewed by METIS orchestrator.";
    }

    var latencyMs = Date.now() - startTime;

    // Step 3: Log to intake_log
    var logEntry = {
      source: source,
      title: title,
      description: description,
      urgency: urgency,
      requester: requester,
      classification: classification.type,
      routed_to: routed_to,
      work_order_id: work_order_id,
      work_order_slug: work_order_slug,
      response: response ? response.slice(0, 5000) : null,
      client_info: {
        confidence: classification.confidence,
        reasoning: classification.reasoning,
        suggested_tags: classification.suggested_tags
      },
      latency_ms: latencyMs
    };

    var logResult = await sb.from("intake_log").insert(logEntry).select("id").single();
    var intakeId = logResult.data ? logResult.data.id : null;

    // Step 4: Return response
    return new Response(
      JSON.stringify({
        intake_id: intakeId,
        classification: classification.type,
        confidence: classification.confidence,
        routed_to: routed_to,
        work_order_slug: work_order_slug,
        response: response,
        latency_ms: latencyMs
      }),
      { headers: Object.assign({}, CORS, { "Content-Type": "application/json" }) }
    );

  } catch (e: any) {
    var latencyMs = Date.now() - startTime;
    console.error("Intake API error:", e);

    try {
      await sb.from("intake_log").insert({
        source: "error",
        classification: "admin",
        routed_to: "error",
        error: e.message,
        latency_ms: latencyMs
      });
    } catch (_logErr) {
      // silent
    }

    return new Response(
      JSON.stringify({ error: e.message }),
      { status: 500, headers: Object.assign({}, CORS, { "Content-Type": "application/json" }) }
    );
  }
});
