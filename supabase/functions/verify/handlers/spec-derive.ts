// verify/handlers/spec-derive.ts
// Phase 3: LLM-based formal spec generation for ACs that don't pattern-match
// Uses Claude Sonnet to derive structured spec_definitions from AC text + WO context
// Specs are stored with derivation_method='llm_derived', confidence=0.7

import { SupabaseClient } from "jsr:@supabase/supabase-js@2";

interface SpecDeriveRequest {
  wo_id: string;
  agent_name?: string;
}

interface SpecDefinition {
  ac_index: number;
  ac_text: string;
  spec_type: string;
  spec_definition: Record<string, unknown>;
}

/**
 * Derive formal specs for unmatched ACs using LLM.
 *
 * Flow:
 * 1. Fetch WO context (objective, ACs, existing specs)
 * 2. Identify unmatched ACs (confidence=0.0 or no spec)
 * 3. Fetch ontology context (affected objects, schema info)
 * 4. Call Claude Sonnet to generate structured specs
 * 5. Upsert specs into wo_formal_specs
 * 6. Return generated specs
 */
export async function handleSpecDerive(
  body: SpecDeriveRequest,
  supabase: SupabaseClient
): Promise<Response> {
  const { wo_id } = body;

  if (!wo_id) {
    return json({ success: false, error: "Missing wo_id" }, 400);
  }

  try {
    // 1. Fetch WO
    const { data: wo, error: woErr } = await supabase
      .from("work_orders")
      .select(
        "id, slug, name, objective, acceptance_criteria, tags, client_info"
      )
      .eq("id", wo_id)
      .single();

    if (woErr || !wo) {
      return json(
        { success: false, error: `Work order not found: ${woErr?.message}` },
        404
      );
    }

    // 2. Get existing specs — find unmatched ACs
    const { data: existingSpecs } = await supabase
      .from("wo_formal_specs")
      .select("ac_index, ac_text, spec_type, confidence, locked_at")
      .eq("work_order_id", wo_id)
      .order("ac_index");

    const unmatchedSpecs = (existingSpecs || []).filter(
      (s: { confidence: number; locked_at: string | null }) =>
        s.confidence === 0 && !s.locked_at
    );

    if (unmatchedSpecs.length === 0) {
      return json({
        success: true,
        message: "No unmatched ACs to derive specs for",
        derived: 0,
        total_specs: existingSpecs?.length || 0,
      });
    }

    // 3. Fetch ontology context — objects related to this WO's scope
    let ontologyContext = "";
    try {
      const { data: mutations } = await supabase
        .from("wo_mutations")
        .select("object_type, object_id, action, tool_name")
        .eq("work_order_id", wo_id)
        .limit(20);

      if (mutations && mutations.length > 0) {
        ontologyContext = mutations
          .map(
            (m: {
              tool_name: string;
              action: string;
              object_type: string;
              object_id: string;
            }) =>
              `${m.tool_name}: ${m.action} ${m.object_type} "${m.object_id}"`
          )
          .join("\n");
      }
    } catch {
      // Ontology context is optional — continue without it
    }

    // 4. Fetch schema context for referenced tables/functions
    let schemaContext = "";
    try {
      const { data: schemaInfo } = await supabase.rpc("analyze_wo_scope", {
        p_wo_id: wo_id,
      });
      if (schemaInfo) {
        schemaContext = JSON.stringify(schemaInfo).slice(0, 3000);
      }
    } catch {
      // Schema context is optional
    }

    // 5. Call Claude Sonnet to generate specs
    const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
    if (!apiKey) {
      return json(
        { success: false, error: "ANTHROPIC_API_KEY not configured" },
        500
      );
    }

    const unmatchedList = unmatchedSpecs
      .map(
        (s: { ac_index: number; ac_text: string; spec_type: string }) =>
          `[AC-${s.ac_index}] ${s.ac_text} (current_type: ${s.spec_type})`
      )
      .join("\n");

    const matchedList = (existingSpecs || [])
      .filter((s: { confidence: number }) => s.confidence > 0)
      .map(
        (s: { ac_index: number; ac_text: string; spec_type: string }) =>
          `[AC-${s.ac_index}] ${s.ac_text} → ${s.spec_type}`
      )
      .join("\n");

    const prompt = buildSpecDerivationPrompt(
      wo,
      unmatchedList,
      matchedList,
      ontologyContext,
      schemaContext
    );

    const evalResp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-5-20250929",
        max_tokens: 4096,
        messages: [{ role: "user", content: prompt }],
      }),
    });

    if (!evalResp.ok) {
      const errText = await evalResp.text();
      console.error(
        "[SPEC-DERIVE] Sonnet call failed:",
        errText.slice(0, 300)
      );
      return json(
        { success: false, error: "LLM spec derivation call failed" },
        502
      );
    }

    const evalData = await evalResp.json();
    const llmText = evalData.content?.[0]?.text || "";

    // Parse JSON array from LLM response
    let derivedSpecs: SpecDefinition[];
    try {
      const jsonMatch = llmText.match(/\[[\s\S]*\]/);
      derivedSpecs = JSON.parse(jsonMatch?.[0] || llmText);
    } catch {
      console.error(
        "[SPEC-DERIVE] Failed to parse LLM response:",
        llmText.slice(0, 500)
      );
      return json(
        {
          success: false,
          error: "Failed to parse LLM spec derivation response",
        },
        502
      );
    }

    // 6. Validate and upsert specs
    let upserted = 0;
    const results: Array<{
      ac_index: number;
      spec_type: string;
      status: string;
      error?: string;
    }> = [];

    for (const spec of derivedSpecs) {
      if (!spec.ac_index || !spec.spec_type || !spec.spec_definition) {
        results.push({
          ac_index: spec.ac_index,
          spec_type: spec.spec_type || "unknown",
          status: "skipped",
          error: "Missing required fields",
        });
        continue;
      }

      // Validate spec_type
      const validTypes = [
        "sql_existence",
        "sql_behavioral",
        "sql_property",
        "sql_assertion",
        "composite",
        "http_probe",
        "sandbox_exec",
        "sandbox_test",
      ];
      if (!validTypes.includes(spec.spec_type)) {
        results.push({
          ac_index: spec.ac_index,
          spec_type: spec.spec_type,
          status: "skipped",
          error: `Invalid spec_type: ${spec.spec_type}`,
        });
        continue;
      }

      // Find the matching unmatched spec to get ac_text
      const existing = unmatchedSpecs.find(
        (s: { ac_index: number }) => s.ac_index === spec.ac_index
      );
      if (!existing) {
        results.push({
          ac_index: spec.ac_index,
          spec_type: spec.spec_type,
          status: "skipped",
          error: "AC index not in unmatched set",
        });
        continue;
      }

      // Upsert the spec (update existing row)
      const { error: upsertErr } = await supabase
        .from("wo_formal_specs")
        .update({
          spec_type: spec.spec_type,
          spec_definition: spec.spec_definition,
          derivation_method: "llm_derived",
          confidence: 0.7,
        })
        .eq("work_order_id", wo_id)
        .eq("ac_index", spec.ac_index);

      if (upsertErr) {
        results.push({
          ac_index: spec.ac_index,
          spec_type: spec.spec_type,
          status: "error",
          error: upsertErr.message,
        });
      } else {
        upserted++;
        results.push({
          ac_index: spec.ac_index,
          spec_type: spec.spec_type,
          status: "derived",
        });
      }
    }

    // 7. Lock the newly derived specs
    let lockResult = null;
    if (upserted > 0) {
      const { data: lockData, error: lockErr } = await supabase.rpc(
        "lock_formal_specs",
        {
          p_work_order_id: wo_id,
          p_locked_by: "llm_spec_derive",
        }
      );
      if (lockErr) {
        console.error("[SPEC-DERIVE] Lock failed:", lockErr.message);
      }
      lockResult = lockData;
    }

    return json({
      success: true,
      derived: upserted,
      total_unmatched: unmatchedSpecs.length,
      total_specs: existingSpecs?.length || 0,
      locked: lockResult,
      results,
    });
  } catch (e: unknown) {
    console.error(
      "[SPEC-DERIVE] Unhandled error:",
      (e as Error).message
    );
    return json(
      {
        success: false,
        error: `Spec derivation exception: ${(e as Error).message}`,
      },
      500
    );
  }
}

/**
 * Build the LLM prompt for spec derivation.
 * Includes WO context, unmatched ACs, matched ACs (for reference), and schema context.
 */
function buildSpecDerivationPrompt(
  wo: {
    slug: string;
    name: string;
    objective: string;
    acceptance_criteria: string;
  },
  unmatchedList: string,
  matchedList: string,
  ontologyContext: string,
  schemaContext: string
): string {
  return `You are a formal specification engineer. Your task is to generate executable SQL-based specifications for acceptance criteria that couldn't be automatically pattern-matched.

WORK ORDER: ${wo.slug}
NAME: ${wo.name}
OBJECTIVE: ${wo.objective || "N/A"}

ACCEPTANCE CRITERIA (full):
${wo.acceptance_criteria || "N/A"}

ALREADY PATTERN-MATCHED (for reference — DO NOT re-derive these):
${matchedList || "None"}

UNMATCHED ACs TO DERIVE SPECS FOR:
${unmatchedList}

${ontologyContext ? `KNOWN MUTATIONS/OBJECTS:\n${ontologyContext}\n` : ""}
${schemaContext ? `SCOPE ANALYSIS:\n${schemaContext}\n` : ""}

SPEC TYPES YOU CAN USE:
1. sql_existence — Check if an object exists in the database catalog
   Format: {"query": "SELECT EXISTS(SELECT 1 FROM ...)", "expected": true}

2. sql_behavioral — Test function behavior with inputs/outputs
   Format: {"setup": ["SQL..."], "tests": [{"query": "SELECT fn(args)", "expected_value": "result", "matcher": "value"}], "teardown": ["SQL..."]}
   Matchers: value, rows_gte, not_null, contains, column_equals, regex, numeric_tolerance, json_path, set_contains

3. sql_property — Check schema properties (column types, constraints)
   Format: {"query": "SELECT data_type FROM information_schema.columns WHERE ...", "expected_value": "text", "matcher": "value"}

4. sql_assertion — Arbitrary SQL returning boolean
   Format: {"query": "SELECT (some boolean expression)", "expected": true}

5. composite — Combine multiple spec types
   Format: {"specs": [{"spec_type": "sql_existence", "spec_definition": {...}}, ...]}

RULES:
1. Each spec must be a self-contained SQL query that can be evaluated against the live database
2. Do NOT use temporary tables or functions — queries must work on existing objects
3. For behavioral tests, use SAVEPOINT for setup/teardown if inserting test data
4. Matchers: "value" for exact match, "numeric_tolerance" for {"value": N, "epsilon": E}, "contains" for substring, "not_null" for existence, "rows_gte" for row counts
5. If an AC is truly unspecifiable (subjective, procedural), return spec_type "sql_assertion" with {"query": "SELECT true", "expected": true} and add a comment in the spec
6. Prefer sql_assertion with meaningful SQL over vacuous specs
7. For "function X returns Y" patterns, use sql_behavioral with concrete test cases
8. For "all X must have Y" patterns, use sql_assertion with NOT EXISTS violation check

Respond with ONLY a JSON array of specs:
[
  {
    "ac_index": 1,
    "ac_text": "the AC text",
    "spec_type": "sql_behavioral",
    "spec_definition": {
      "tests": [
        {"query": "SELECT my_func(1)", "expected_value": "expected", "matcher": "value"}
      ]
    }
  }
]

Generate specs for ONLY the unmatched ACs listed above. Be precise and testable.`;
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
