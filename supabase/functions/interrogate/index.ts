// interrogate/index.ts v1
// P2 Fix 7: Interrogation loop Edge Function
// Endpoints: POST /start, /answer, /complete, /status, /check-wo
// Exposes DB functions start_interrogation, submit_interrogation_answer,
// complete_interrogation, get_interrogation_status, check_wo_needs_interrogation

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

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

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return jsonResponse({ error: "POST only" }, 405);

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  try {
    const url = new URL(req.url);
    const path = url.pathname.split("/").pop() || "";
    const body = await req.json().catch(() => ({}));

    // Route by path suffix
    switch (path) {

      // POST /interrogate/start
      // Body: { trigger_type, project_id?, thread_id?, work_order_id? }
      case "start": {
        const { trigger_type, project_id, thread_id, work_order_id } = body;
        if (!trigger_type) return jsonResponse({ error: "trigger_type required" }, 400);

        const { data: sessionId, error } = await supabase.rpc("start_interrogation", {
          p_trigger_type: trigger_type,
          p_project_id: project_id || null,
          p_thread_id: thread_id || null,
          p_work_order_id: work_order_id || null,
        });
        if (error) return jsonResponse({ error: error.message }, 500);

        // Return full status including first questions
        const { data: status, error: statusErr } = await supabase.rpc("get_interrogation_status", {
          p_session_id: sessionId,
        });
        if (statusErr) return jsonResponse({ error: statusErr.message }, 500);

        // Emit trace event
        try {
          await supabase.from("trace_events").insert({
            trace_id: body.trace_id || null,
            event_type: "lifecycle",
            name: "interrogation_started",
            level: "info",
            payload: { session_id: sessionId, trigger_type, project_id },
          });
        } catch (_) { /* non-critical */ }

        return jsonResponse({ session_id: sessionId, ...status });
      }

      // POST /interrogate/answer
      // Body: { session_id, domain, answers: [{question, answer}] }
      case "answer": {
        const { session_id, domain, answers } = body;
        if (!session_id || !domain || !answers) {
          return jsonResponse({ error: "session_id, domain, and answers required" }, 400);
        }

        const { data: result, error } = await supabase.rpc("submit_interrogation_answer", {
          p_session_id: session_id,
          p_domain: domain,
          p_answers: answers,
        });
        if (error) return jsonResponse({ error: error.message }, 500);

        // If error in result (session not found, wrong status)
        if (result?.error) return jsonResponse({ error: result.error }, 400);

        // If all domains answered, fetch next questions for convenience
        if (!result.all_answered) {
          const { data: status } = await supabase.rpc("get_interrogation_status", {
            p_session_id: session_id,
          });
          return jsonResponse({ ...result, next_domain: status?.next_domain, next_questions: status?.next_questions });
        }

        return jsonResponse({ ...result, message: "All domains answered. Call /complete to finalize." });
      }

      // POST /interrogate/complete
      // Body: { session_id, summary?, generated_docs? }
      case "complete": {
        const { session_id, summary, generated_docs } = body;
        if (!session_id) return jsonResponse({ error: "session_id required" }, 400);

        const { data: result, error } = await supabase.rpc("complete_interrogation", {
          p_session_id: session_id,
          p_summary: summary || null,
          p_generated_docs: generated_docs || null,
        });
        if (error) return jsonResponse({ error: error.message }, 500);
        if (result?.error) return jsonResponse({ error: result.error }, 400);

        return jsonResponse(result);
      }

      // POST /interrogate/status
      // Body: { session_id }
      case "status": {
        const { session_id } = body;
        if (!session_id) return jsonResponse({ error: "session_id required" }, 400);

        const { data: result, error } = await supabase.rpc("get_interrogation_status", {
          p_session_id: session_id,
        });
        if (error) return jsonResponse({ error: error.message }, 500);
        if (result?.error) return jsonResponse({ error: result.error }, 400);

        return jsonResponse(result);
      }

      // POST /interrogate/check-wo
      // Body: { work_order_id }
      case "check-wo": {
        const { work_order_id } = body;
        if (!work_order_id) return jsonResponse({ error: "work_order_id required" }, 400);

        const { data: needs, error } = await supabase.rpc("check_wo_needs_interrogation", {
          p_work_order_id: work_order_id,
        });
        if (error) return jsonResponse({ error: error.message }, 500);

        return jsonResponse({ work_order_id, needs_interrogation: needs });
      }

      default:
        return jsonResponse({
          error: `Unknown action: ${path}`,
          available_actions: ["start", "answer", "complete", "status", "check-wo"],
        }, 400);
    }
  } catch (err) {
    console.error("interrogate error:", err);
    return jsonResponse({ error: (err as Error).message }, 500);
  }
});
