// diagnostician/index.ts - Tier-2 On-Demand Reasoning Agent
// WO-0382: Performs root cause analysis on escalated triage items from Sentinel
// Creates parent WOs with child decomposition for fixes

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY")!;
const MAX_TRIAGE_ITEMS = 5;
const MAX_INPUT_TOKENS = 8000;
const MAX_OUTPUT_TOKENS = 4000;

interface TriageItem {
  id: string;
  wo_id: string;
  triage_type: string;
  severity: string;
  diagnostic_context: any;
  escalate_to: string;
  created_at: string;
}

interface RCAResult {
  root_cause: string;
  contributing_factors: string[];
  recommended_fix: string;
  fix_tasks: Array<{
    name: string;
    objective: string;
    acceptance_criteria: string;
    tags: string[];
  }>;
  confidence: number;
  related_lessons: string[];
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: CORS });
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  const startTime = Date.now();
  const processedItems: string[] = [];
  const createdWOs: any[] = [];

  try {
    // 1. FETCH UNRESOLVED TRIAGE ITEMS ESCALATED TO DIAGNOSTICIAN
    const { data: triageItems, error: triageErr } = await supabase
      .from("monitor_triage_queue")
      .select("*")
      .eq("escalate_to", "diagnostician")
      .is("resolved_at", null)
      .order("created_at", { ascending: true })
      .limit(MAX_TRIAGE_ITEMS);

    if (triageErr) throw new Error(`Triage query error: ${triageErr.message}`);
    if (!triageItems || triageItems.length === 0) {
      return new Response(
        JSON.stringify({ success: true, message: "No items to process", elapsed_ms: Date.now() - startTime }),
        { status: 200, headers: { ...CORS, "Content-Type": "application/json" } }
      );
    }

    console.log(`[DIAGNOSTICIAN] Processing ${triageItems.length} triage items`);

    // 2. PROCESS EACH TRIAGE ITEM
    for (const item of triageItems as TriageItem[]) {
      try {
        // Load context for this WO
        const context = await loadDiagnosticContext(supabase, item.wo_id);

        // Query lessons for similar failures
        const lessons = await queryRelevantLessons(supabase, item);

        // Perform RCA using Claude
        const rca = await performRootCauseAnalysis(item, context, lessons);

        // Create parent WO with child decomposition
        const parentWO = await createParentWO(supabase, item, rca);
        const childWOs = await createChildWOs(supabase, parentWO.id, rca.fix_tasks);

        createdWOs.push({ parent: parentWO, children: childWOs });

        // Mark triage item as resolved
        await supabase
          .from("monitor_triage_queue")
          .update({ resolved_at: new Date().toISOString(), resolution_notes: `RCA complete, created parent WO: ${parentWO.slug}` })
          .eq("id", item.id);

        processedItems.push(item.id);
      } catch (itemErr: any) {
        console.error(`[DIAGNOSTICIAN] Error processing item ${item.id}:`, itemErr);
        // Log error but continue with other items
        await supabase
          .from("monitor_triage_queue")
          .update({ resolution_notes: `RCA failed: ${itemErr.message}` })
          .eq("id", item.id);
      }
    }

    const elapsed = Date.now() - startTime;
    return new Response(
      JSON.stringify({
        success: true,
        elapsed_ms: elapsed,
        processed_count: processedItems.length,
        created_wos: createdWOs.length,
        details: createdWOs.map(wo => ({ parent: wo.parent.slug, child_count: wo.children.length })),
      }),
      { status: 200, headers: { ...CORS, "Content-Type": "application/json" } }
    );
  } catch (e: any) {
    console.error("[DIAGNOSTICIAN] Error:", e);
    return new Response(
      JSON.stringify({ error: e.message }),
      { status: 500, headers: { ...CORS, "Content-Type": "application/json" } }
    );
  }
});

// Load diagnostic context for a work order
async function loadDiagnosticContext(supabase: any, woId: string) {
  // Get WO details
  const { data: wo } = await supabase
    .from("work_orders")
    .select("*")
    .eq("id", woId)
    .single();

  // Get execution log (last 20 entries)
  const { data: execLog } = await supabase
    .from("work_order_execution_log")
    .select("*")
    .eq("work_order_id", woId)
    .order("created_at", { ascending: false })
    .limit(20);

  // Get QA findings
  const { data: qaFindings } = await supabase
    .from("qa_findings")
    .select("*")
    .eq("work_order_id", woId)
    .is("resolved_at", null);

  return {
    work_order: wo,
    execution_log: execLog || [],
    qa_findings: qaFindings || [],
  };
}

// Query lessons for similar past failures
async function queryRelevantLessons(supabase: any, item: TriageItem) {
  // Map triage types to lesson categories
  const categoryMap: Record<string, string[]> = {
    stuck: ["execution", "scope_creep", "context_loss"],
    spiral: ["tool_misuse", "scope_creep", "execution"],
    mismatch: ["state_machine", "execution"],
    orphan: ["execution"],
  };

  const categories = categoryMap[item.triage_type] || ["general"];

  const { data: lessons } = await supabase
    .from("lessons")
    .select("*")
    .in("category", categories)
    .not("promoted_at", "is", null)
    .order("created_at", { ascending: false })
    .limit(10);

  return lessons || [];
}

// Perform root cause analysis using Claude
async function performRootCauseAnalysis(
  item: TriageItem,
  context: any,
  lessons: any[]
): Promise<RCAResult> {
  const prompt = buildRCAPrompt(item, context, lessons);

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: MAX_OUTPUT_TOKENS,
      temperature: 0.3,
      messages: [
        {
          role: "user",
          content: prompt,
        },
      ],
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Claude API error: ${response.status} ${errorText}`);
  }

  const result = await response.json();
  const content = result.content[0].text;

  // Parse Claude's response (expecting JSON)
  try {
    return JSON.parse(content);
  } catch (parseErr) {
    // If not JSON, wrap in structured format
    return {
      root_cause: content.substring(0, 500),
      contributing_factors: ["Parse error - see root_cause for raw output"],
      recommended_fix: "Manual review required",
      fix_tasks: [],
      confidence: 0.5,
      related_lessons: [],
    };
  }
}

// Build RCA prompt for Claude
function buildRCAPrompt(item: TriageItem, context: any, lessons: any[]): string {
  const wo = context.work_order;
  const execLog = context.execution_log.slice(0, 10); // Most recent 10 entries
  const qaFindings = context.qa_findings;

  return `You are a diagnostician analyzing a work order failure. Perform root cause analysis and propose a fix.

# Triage Item
- Type: ${item.triage_type}
- Severity: ${item.severity}
- WO ID: ${item.wo_id}
- Context: ${JSON.stringify(item.diagnostic_context, null, 2)}

# Work Order
- Slug: ${wo.slug}
- Name: ${wo.name}
- Status: ${wo.status}
- Objective: ${wo.objective}
- Acceptance Criteria: ${wo.acceptance_criteria}
- Started: ${wo.started_at}
- Updated: ${wo.updated_at}

# Recent Execution Log (last 10 entries)
${execLog.map((log: any) => `- [${log.created_at}] ${log.phase}: ${JSON.stringify(log.detail)}`).join('\n')}

# QA Findings
${qaFindings.length > 0 ? qaFindings.map((f: any) => `- ${f.category}: ${f.description}`).join('\n') : 'None'}

# Related Lessons (prior art from similar failures)
${lessons.length > 0 ? lessons.map((l: any) => `- [${l.severity}] ${l.pattern}\n  Rule: ${l.rule}\n  Example: ${l.example_good}`).join('\n\n') : 'None found'}

# Your Task
Analyze the failure and provide a structured response in JSON format:

{
  "root_cause": "Single-sentence root cause description",
  "contributing_factors": ["Factor 1", "Factor 2", ...],
  "recommended_fix": "High-level fix strategy",
  "fix_tasks": [
    {
      "name": "Task name",
      "objective": "What this task accomplishes",
      "acceptance_criteria": "1. Criterion 1\\n2. Criterion 2",
      "tags": ["tag1", "tag2"]
    }
  ],
  "confidence": 0.8,
  "related_lessons": ["lesson_id_1", "lesson_id_2"]
}

Rules:
- fix_tasks should be 2-4 concrete, actionable tasks
- Each task must have clear acceptance criteria (numbered list)
- Tags should match task domain (e.g., ["migration", "schema"] or ["code", "edge-function"])
- Confidence is 0.0-1.0 (how certain you are of the diagnosis)
- Include lesson IDs if any lessons directly informed your analysis

Respond ONLY with the JSON object, no additional text.`;
}

// Create parent WO
async function createParentWO(supabase: any, item: TriageItem, rca: RCAResult) {
  const { data: parentWO, error: createErr } = await supabase.rpc("create_draft_work_order", {
    p_slug: null, // Auto-generate
    p_name: `[RCA] ${item.triage_type} issue in ${item.wo_id.substring(0, 8)}`,
    p_objective: `Root cause: ${rca.root_cause}\n\nRecommended fix: ${rca.recommended_fix}\n\nContributing factors:\n${rca.contributing_factors.map(f => `- ${f}`).join('\n')}`,
    p_priority: item.severity === "critical" ? "p0_critical" : "p1_high",
    p_source: "diagnostician",
    p_tags: ["diagnostician-root-cause", "auto-generated", item.triage_type],
    p_acceptance_criteria: `1. Complete all child fix tasks\n2. Verify original WO issue is resolved\n3. Update lessons with new insights`,
  });

  if (createErr) throw new Error(`Parent WO creation failed: ${createErr.message}`);
  return parentWO;
}

// Create child WOs
async function createChildWOs(supabase: any, parentId: string, fixTasks: any[]) {
  const children = [];

  for (const task of fixTasks) {
    const { data: childWO, error: childErr } = await supabase.rpc("create_draft_work_order", {
      p_slug: null,
      p_name: task.name,
      p_objective: task.objective,
      p_priority: "p2_medium",
      p_source: "diagnostician",
      p_tags: [...task.tags, "diagnostician-child"],
      p_acceptance_criteria: task.acceptance_criteria,
      p_parent_id: parentId,
    });

    if (childErr) {
      console.error(`[DIAGNOSTICIAN] Child WO creation failed:`, childErr);
      continue;
    }

    children.push(childWO);
  }

  return children;
}
