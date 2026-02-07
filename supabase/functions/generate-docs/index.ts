// generate-docs/index.ts v4
// P2 Fix 8: LLM Doc Population
// v4: Aligned /status with intake gate, auto-sets intake_complete

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import Anthropic from "npm:@anthropic-ai/sdk@0.39.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

const DOC_TYPES = [
  { type: "prd", title: "Product Requirements Document" },
  { type: "app_flow", title: "Application Flow" },
  { type: "tech_stack", title: "Technology Stack" },
  { type: "frontend_guidelines", title: "Frontend Guidelines" },
  { type: "backend_structure", title: "Backend Structure" },
  { type: "implementation_plan", title: "Implementation Plan" },
  { type: "security_model", title: "Security Model" },
  { type: "testing_strategy", title: "Testing Strategy" },
] as const;

function buildDocPrompt(docType: string, projectName: string, answers: Record<string, unknown>): string {
  const answerText = Object.entries(answers)
    .map(([domain, domainAnswers]) => {
      if (!Array.isArray(domainAnswers)) return `## ${domain}\n${JSON.stringify(domainAnswers)}`;
      return `## ${domain}\n${domainAnswers.map((a: any) => `Q: ${a.question}\nA: ${a.answer}`).join("\n\n")}`;
    })
    .join("\n\n");

  const docInstructions: Record<string, string> = {
    prd: "Write a concise Product Requirements Document. Include: overview, problem statement, target users, functional requirements (numbered), non-functional requirements, success metrics, constraints, and out-of-scope items.",
    app_flow: "Document the application flow. Include: user journey steps, state transitions, decision points, error flows, and data flow between components.",
    tech_stack: "Document the technology stack. Include: languages, frameworks, databases, infrastructure, third-party services, deployment targets, and rationale for each choice.",
    frontend_guidelines: "Write frontend development guidelines. Include: component structure, styling approach, state management patterns, routing, accessibility requirements, and performance targets.",
    backend_structure: "Document the backend architecture. Include: API design patterns, database schema overview, authentication flow, service boundaries, error handling patterns, and data validation approach.",
    implementation_plan: "Write an implementation plan. Include: phased delivery milestones, task breakdown with estimated effort, dependencies between tasks, critical path items, and risk mitigation.",
    security_model: "Document the security model. Include: authentication mechanism, authorization model, data protection, input validation, rate limiting, audit logging, and threat model summary.",
    testing_strategy: "Write a testing strategy. Include: unit test coverage targets, integration test approach, E2E test scenarios, performance test criteria, security test checklist, and CI/CD integration.",
  };

  return `You are generating a ${docType} document for the project "${projectName}".

${docInstructions[docType] || "Write a comprehensive document for this aspect of the project."}

Base your document on these interrogation answers:

${answerText}

Rules:
- Be specific and actionable, not generic.
- Reference concrete details from the answers.
- Use markdown formatting.
- Keep it under 2000 words.
- Start directly with the document content.`;
}

async function generateSingleDoc(
  anthropic: Anthropic,
  supabase: any,
  projectId: string,
  projectName: string,
  docType: string,
  docTitle: string,
  answers: Record<string, unknown>,
): Promise<{ doc_type: string; status: string; chars: number; version?: number; error?: string }> {
  try {
    const prompt = buildDocPrompt(docType, projectName, answers);

    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 4096,
      messages: [{ role: "user", content: prompt }],
    });

    const content = response.content[0].type === "text" ? response.content[0].text : "";

    const { data: result, error: upsertErr } = await supabase.rpc("upsert_project_document", {
      p_project_id: projectId,
      p_doc_type: docType,
      p_title: docTitle,
      p_content: content,
      p_created_by: "generate-docs",
    });

    if (upsertErr) {
      console.error(`Upsert failed for ${docType}:`, upsertErr);
      return { doc_type: docType, status: "error", chars: content.length, error: upsertErr.message };
    }

    return { doc_type: docType, status: "generated", chars: result?.chars || content.length, version: result?.version };
  } catch (err) {
    console.error(`Failed to generate ${docType}:`, err);
    return { doc_type: docType, status: "error", chars: 0, error: (err as Error).message };
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return jsonResponse({ error: "POST only" }, 405);

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );
  const anthropic = new Anthropic({ apiKey: Deno.env.get("ANTHROPIC_API_KEY")! });

  try {
    const url = new URL(req.url);
    const path = url.pathname.split("/").pop() || "";
    const body = await req.json().catch(() => ({}));

    switch (path) {

      case "generate": {
        let projectId: string;
        let projectName: string;
        let answers: Record<string, unknown>;

        if (body.session_id) {
          const { data: session, error: sessErr } = await supabase
            .from("interrogation_sessions")
            .select("project_id, answers_received")
            .eq("id", body.session_id)
            .single();
          if (sessErr || !session) return jsonResponse({ error: "Session not found" }, 404);
          projectId = session.project_id;
          answers = session.answers_received || {};
        } else if (body.project_id && body.answers) {
          projectId = body.project_id;
          answers = body.answers;
        } else {
          return jsonResponse({ error: "session_id or (project_id + answers) required" }, 400);
        }

        const { data: project } = await supabase
          .from("project_briefs")
          .select("name")
          .eq("id", projectId)
          .single();
        projectName = project?.name || "Unknown Project";

        if (Object.keys(answers).length === 0) {
          return jsonResponse({ error: "No answers found. Complete interrogation first." }, 400);
        }

        const results = [];
        for (const dt of DOC_TYPES) {
          const result = await generateSingleDoc(
            anthropic, supabase, projectId, projectName, dt.type, dt.title, answers
          );
          results.push(result);
        }

        // Update session with generated doc refs
        if (body.session_id) {
          const docRefs = Object.fromEntries(results.map(r => [r.doc_type, r.status]));
          await supabase
            .from("interrogation_sessions")
            .update({ generated_docs: docRefs })
            .eq("id", body.session_id);
        }

        const succeeded = results.filter(r => r.status === "generated").length;
        const failed = results.filter(r => r.status === "error").length;

        // Check and set intake_complete (trigger handles per-doc, this is belt-and-suspenders)
        const { data: intakeCheck } = await supabase.rpc('check_project_intake_ready', {
          p_project_id: projectId
        });
        let intakeComplete = false;
        if (intakeCheck?.ready) {
          await supabase.from('project_briefs')
            .update({ intake_complete: true, updated_at: new Date().toISOString() })
            .eq('id', projectId);
          intakeComplete = true;
        }

        // Log audit entry
        await supabase.from('audit_log').insert({
          event_type: 'doc_generation',
          actor_type: 'system',
          actor_id: 'generate-docs',
          target_type: 'project',
          target_id: projectId,
          action: 'generate_all',
          payload: {
            session_id: body.session_id || null,
            succeeded,
            failed,
            intake_complete: intakeComplete,
            doc_types: results.map(r => ({ type: r.doc_type, status: r.status })),
          },
        }).then(() => {}).catch((e: any) => console.error('Audit log failed:', e));

        return jsonResponse({
          project_id: projectId,
          project_name: projectName,
          docs_generated: succeeded,
          docs_failed: failed,
          intake_complete: intakeComplete,
          results,
        });
      }

      case "generate-single": {
        const { doc_type } = body;
        if (!doc_type) return jsonResponse({ error: "doc_type required" }, 400);

        const docDef = DOC_TYPES.find(d => d.type === doc_type);
        if (!docDef) {
          return jsonResponse({ error: `Unknown doc_type. Valid: ${DOC_TYPES.map(d => d.type).join(", ")}` }, 400);
        }

        let projectId: string;
        let answers: Record<string, unknown>;

        if (body.session_id) {
          const { data: session } = await supabase
            .from("interrogation_sessions")
            .select("project_id, answers_received")
            .eq("id", body.session_id)
            .single();
          if (!session) return jsonResponse({ error: "Session not found" }, 404);
          projectId = session.project_id;
          answers = session.answers_received || {};
        } else if (body.project_id && body.answers) {
          projectId = body.project_id;
          answers = body.answers;
        } else {
          return jsonResponse({ error: "session_id or (project_id + answers) required" }, 400);
        }

        const { data: project } = await supabase
          .from("project_briefs")
          .select("name")
          .eq("id", projectId)
          .single();

        const result = await generateSingleDoc(
          anthropic, supabase, projectId, project?.name || "Unknown", docDef.type, docDef.title, answers
        );

        return jsonResponse({ project_id: projectId, ...result });
      }

      case "status": {
        const { project_id } = body;
        if (!project_id) return jsonResponse({ error: "project_id required" }, 400);

        const { data: docs } = await supabase
          .from("project_documents")
          .select("doc_type, title, status, version, created_by, updated_by, updated_at")
          .eq("project_id", project_id)
          .order("doc_type");

        // Use check_project_intake_ready for consistent readiness check
        const { data: intakeCheck } = await supabase.rpc('check_project_intake_ready', {
          p_project_id: project_id
        });

        const expected = DOC_TYPES.map(d => d.type);
        const existing = (docs || []).map((d: any) => d.doc_type);
        const missingTypes = expected.filter(e => !existing.includes(e));

        return jsonResponse({
          project_id,
          docs: docs || [],
          total: (docs || []).length,
          expected: expected.length,
          missing_types: missingTypes,
          all_types_exist: missingTypes.length === 0,
          // Gate-aligned readiness (requires generated|approved status)
          intake_ready: intakeCheck?.ready || false,
          generated_or_approved: intakeCheck?.generated_or_approved || 0,
          missing_generated: intakeCheck?.missing_doc_types || [],
        });
      }

      default:
        return jsonResponse({
          error: `Unknown action: ${path}`,
          available_actions: ["generate", "generate-single", "status"],
        }, 400);
    }
  } catch (err) {
    console.error("generate-docs error:", err);
    return jsonResponse({ error: (err as Error).message }, 500);
  }
});
