// Work Order Management - Natural language brief intake
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.0";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type"
};

// Types matching Supabase enums
type WorkOrderStatus = 'draft' | 'ready' | 'in_progress' | 'blocked' | 'review' | 'done' | 'cancelled';
type WorkOrderPriority = 'p0_critical' | 'p1_high' | 'p2_medium' | 'p3_low';
type WorkOrderComplexity = 'trivial' | 'small' | 'medium' | 'large' | 'unknown';
type AgentType = 'you' | 'engineering' | 'audit' | 'cto' | 'cpo' | 'research' | 'analysis' | 'external';

interface ParsedBrief {
  name: string;
  objective: string;
  constraints: string[];
  acceptance_criteria: string[];
  escalation_conditions: string[];
  priority: WorkOrderPriority;
  complexity: WorkOrderComplexity;
  assigned_to: AgentType;
  tags: string[];
}

// Use Claude to parse natural language into structured brief
async function parseNaturalLanguageBrief(
  input: string,
  claudeKey: string
): Promise<ParsedBrief> {
  const prompt = `You are a Chief of Staff parsing a work order brief from natural language.

Input: "${input}"

Extract and structure this into a work order. Respond with JSON only:

{
  "name": "Short descriptive title (max 60 chars)",
  "objective": "What needs to be accomplished and why (1-3 sentences)",
  "constraints": ["constraint 1", "constraint 2"],
  "acceptance_criteria": ["testable criterion 1", "testable criterion 2"],
  "escalation_conditions": ["when to stop and report back"],
  "priority": "p0_critical" | "p1_high" | "p2_medium" | "p3_low",
  "complexity": "trivial" | "small" | "medium" | "large" | "unknown",
  "assigned_to": "engineering" | "audit" | "research" | "analysis",
  "tags": ["engineering", "product", "strategy", etc]
}

Guidelines:
- If priority not specified, default to p2_medium
- If complexity not clear, default to unknown
- Default assigned_to to engineering for code/build tasks, research for research tasks
- Constraints should be boundaries and requirements
- Acceptance criteria should be testable/verifiable
- Escalation conditions: when the agent should stop and ask for help
- Extract any mentioned deadlines, technologies, or specific requirements as constraints`;

  const resp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": claudeKey,
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 1000,
      messages: [{ role: "user", content: prompt }]
    })
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`Claude API error: ${resp.status} - ${errText}`);
  }

  const data = await resp.json();
  const text = data.content?.[0]?.text || "";
  const jsonMatch = text.match(/\{[\s\S]*\}/);

  if (!jsonMatch) {
    throw new Error("Failed to parse brief from Claude response");
  }

  return JSON.parse(jsonMatch[0]);
}

// Generate slug from name
function generateSlug(name: string, existingSlugs: string[]): string {
  const woNumbers = existingSlugs
    .filter(s => s.startsWith('wo-'))
    .map(s => parseInt(s.split('-')[1]))
    .filter(n => !isNaN(n));

  const nextNum = woNumbers.length > 0 ? Math.max(...woNumbers) + 1 : 1;
  const numPart = String(nextNum).padStart(3, '0');

  const namePart = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 30);

  return `wo-${numPart}-${namePart}`;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: CORS });
  }

  const sbUrl = Deno.env.get("SUPABASE_URL")!;
  const sbKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const claudeKey = Deno.env.get("ANTHROPIC_API_KEY") || Deno.env.get("ANTHROPIC_API_KEY2");

  if (!claudeKey) {
    return new Response(
      JSON.stringify({ error: "ANTHROPIC_API_KEY not configured" }),
      { status: 500, headers: { ...CORS, "Content-Type": "application/json" } }
    );
  }

  const sb = createClient(sbUrl, sbKey);
  const url = new URL(req.url);
  const path = url.pathname.replace(/^\/work-order/, "");

  try {
    // POST /work-order/create or /work-order - Create from natural language
    if (req.method === "POST" && (path === "/create" || path === "" || path === "/")) {
      const body = await req.json();
      const { input, project_brief_id } = body;

      if (!input) {
        return new Response(
          JSON.stringify({ error: "input required (natural language brief description)" }),
          { status: 400, headers: { ...CORS, "Content-Type": "application/json" } }
        );
      }

      const parsed = await parseNaturalLanguageBrief(input, claudeKey);

      const { data: existingWOs } = await sb
        .from('work_orders')
        .select('slug');

      const existingSlugs = (existingWOs || []).map((w: any) => w.slug);
      const slug = generateSlug(parsed.name, existingSlugs);

      const workOrder = {
        slug,
        name: parsed.name,
        objective: parsed.objective,
        constraints: parsed.constraints.join('\n• '),
        acceptance_criteria: parsed.acceptance_criteria.join('\n• '),
        escalation_conditions: parsed.escalation_conditions.join('\n• '),
        priority: parsed.priority,
        complexity: parsed.complexity,
        assigned_to: parsed.assigned_to,
        status: 'ready' as WorkOrderStatus,
        tags: parsed.tags,
        project_brief_id: project_brief_id || null,
        max_iterations: 10,
      };

      const { data, error } = await sb
        .from('work_orders')
        .insert(workOrder)
        .select()
        .single();

      if (error) {
        throw new Error(`Database error: ${error.message}`);
      }

      const confirmation = `## Work Order Created: ${data.slug}\n\n**${data.name}**\n\n**Objective:** ${data.objective}\n\n**Constraints:**\n• ${parsed.constraints.join('\n• ')}\n\n**Acceptance Criteria:**\n• ${parsed.acceptance_criteria.join('\n• ')}\n\n**Escalation Conditions:**\n• ${parsed.escalation_conditions.join('\n• ')}\n\n**Priority:** ${data.priority.replace('_', ' ').toUpperCase()}\n**Complexity:** ${data.complexity}\n**Assigned to:** ${data.assigned_to}\n**Status:** ${data.status}\n\n---\n*Work order is now in the Engineering Agent queue.*`;

      return new Response(
        JSON.stringify({
          success: true,
          work_order: data,
          parsed,
          message: confirmation
        }),
        { headers: { ...CORS, "Content-Type": "application/json" } }
      );
    }

    // GET /work-order/queue - Get engineering queue
    if (req.method === "GET" && path === "/queue") {
      const { data, error } = await sb
        .from('v_engineering_queue')
        .select('*');

      if (error) throw error;

      return new Response(
        JSON.stringify({ queue: data }),
        { headers: { ...CORS, "Content-Type": "application/json" } }
      );
    }

    // GET /work-order/attention - Get items needing attention
    if (req.method === "GET" && path === "/attention") {
      const { data, error } = await sb
        .from('v_work_orders_attention')
        .select('*');

      if (error) throw error;

      return new Response(
        JSON.stringify({ attention: data }),
        { headers: { ...CORS, "Content-Type": "application/json" } }
      );
    }

    // GET /work-order/health - Get system health
    if (req.method === "GET" && path === "/health") {
      const { data, error } = await sb
        .from('v_system_health')
        .select('*')
        .single();

      if (error) throw error;

      return new Response(
        JSON.stringify({ health: data }),
        { headers: { ...CORS, "Content-Type": "application/json" } }
      );
    }

    // GET /work-order/list - List all work orders
    if (req.method === "GET" && path === "/list") {
      const status = url.searchParams.get('status');
      const limit = parseInt(url.searchParams.get('limit') || '20');

      let query = sb
        .from('work_orders')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(limit);

      if (status) {
        query = query.eq('status', status);
      }

      const { data, error } = await query;
      if (error) throw error;

      return new Response(
        JSON.stringify({ work_orders: data }),
        { headers: { ...CORS, "Content-Type": "application/json" } }
      );
    }

    // GET /work-order/:id - Get specific work order
    if (req.method === "GET" && path.match(/^\/[a-z0-9-]+$/)) {
      const idOrSlug = path.slice(1);

      let query = sb.from('work_orders').select(`
        *,
        implementations (*),
        audits (*)
      `);

      if (idOrSlug.match(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)) {
        query = query.eq('id', idOrSlug);
      } else {
        query = query.eq('slug', idOrSlug);
      }

      const { data, error } = await query.single();

      if (error) throw error;
      if (!data) {
        return new Response(
          JSON.stringify({ error: "Work order not found" }),
          { status: 404, headers: { ...CORS, "Content-Type": "application/json" } }
        );
      }

      return new Response(
        JSON.stringify({ work_order: data }),
        { headers: { ...CORS, "Content-Type": "application/json" } }
      );
    }

    // PATCH /work-order/:id - Update work order
    if (req.method === "PATCH" && path.match(/^\/[a-z0-9-]+$/)) {
      const idOrSlug = path.slice(1);
      const updates = await req.json();

      const isUuid = idOrSlug.match(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
      const { data, error } = await sb
        .from('work_orders')
        .update(updates)
        .eq(isUuid ? 'id' : 'slug', idOrSlug)
        .select()
        .single();

      if (error) throw error;

      return new Response(
        JSON.stringify({ success: true, work_order: data }),
        { headers: { ...CORS, "Content-Type": "application/json" } }
      );
    }

    // POST /work-order/:id/accept - Accept completed work order
    if (req.method === "POST" && path.match(/^\/[a-z0-9-]+\/accept$/)) {
      const idOrSlug = path.split('/')[1];

      const isUuid = idOrSlug.match(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
      const { data, error } = await sb
        .from('work_orders')
        .update({
          status: 'done',
          completed_at: new Date().toISOString()
        })
        .eq(isUuid ? 'id' : 'slug', idOrSlug)
        .select()
        .single();

      if (error) throw error;

      return new Response(
        JSON.stringify({ success: true, message: `Work order ${data.slug} accepted and marked done`, work_order: data }),
        { headers: { ...CORS, "Content-Type": "application/json" } }
      );
    }

    // POST /work-order/:id/reject - Reject and send back
    if (req.method === "POST" && path.match(/^\/[a-z0-9-]+\/reject$/)) {
      const idOrSlug = path.split('/')[1];
      const { feedback } = await req.json();

      if (!feedback) {
        return new Response(
          JSON.stringify({ error: "feedback required when rejecting" }),
          { status: 400, headers: { ...CORS, "Content-Type": "application/json" } }
        );
      }

      const isUuid = idOrSlug.match(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);

      const { data: current } = await sb
        .from('work_orders')
        .select('constraints')
        .eq(isUuid ? 'id' : 'slug', idOrSlug)
        .single();

      const updatedConstraints = `${current?.constraints || ''}\n\n**Rejection Feedback (${new Date().toISOString()}):**\n${feedback}`;

      const { data, error } = await sb
        .from('work_orders')
        .update({
          status: 'ready',
          constraints: updatedConstraints
        })
        .eq(isUuid ? 'id' : 'slug', idOrSlug)
        .select()
        .single();

      if (error) throw error;

      return new Response(
        JSON.stringify({ success: true, message: `Work order ${data.slug} rejected and returned to queue with feedback`, work_order: data }),
        { headers: { ...CORS, "Content-Type": "application/json" } }
      );
    }

    return new Response(
      JSON.stringify({ error: "Not found", path }),
      { status: 404, headers: { ...CORS, "Content-Type": "application/json" } }
    );

  } catch (e: any) {
    console.error("Work order error:", e);
    return new Response(
      JSON.stringify({ error: e.message }),
      { status: 500, headers: { ...CORS, "Content-Type": "application/json" } }
    );
  }
});
