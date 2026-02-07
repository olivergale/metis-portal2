// context-sync/index.ts
// Allows Metis to update its own context: project status, decisions, directives, preferences

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const supabase = createClient(supabaseUrl, supabaseKey);

  try {
    const body = await req.json();
    const { action, data } = body;

    // UPDATE PROJECT STATUS
    if (action === "update_project") {
      const { code, phase, completion_pct, status, summary } = data;
      if (!code) throw new Error("project code required");

      const updates: Record<string, any> = { updated_at: new Date().toISOString() };
      if (phase !== undefined) updates.current_phase = phase;
      if (completion_pct !== undefined) updates.completion_pct = completion_pct;
      if (status) updates.status = status;
      if (summary) updates.summary = summary;

      const { data: result, error } = await supabase
        .from("project_briefs")
        .update(updates)
        .eq("code", code)
        .select("code, current_phase, completion_pct, summary")
        .single();

      if (error) throw error;
      return Response.json({ success: true, project: result }, { headers: corsHeaders });
    }

    // ADD DECISION
    if (action === "add_decision") {
      const { subject, choice, rationale, type = "technical" } = data;
      if (!subject || !choice) throw new Error("subject and choice required");

      const { data: result, error } = await supabase
        .from("decisions")
        .insert({ type, subject, choice, rationale, status: "active" })
        .select("id, subject, choice")
        .single();

      if (error) throw error;
      return Response.json({ success: true, decision: result }, { headers: corsHeaders });
    }

    // UPDATE DIRECTIVE (for self-improvement)
    if (action === "update_directive") {
      const { name, content, priority } = data;
      if (!name) throw new Error("directive name required");

      // Try update first
      const { data: existing } = await supabase
        .from("system_directives")
        .select("id")
        .eq("name", name)
        .single();

      let result;
      if (existing) {
        const updates: Record<string, any> = { updated_at: new Date().toISOString() };
        if (content) updates.content = content;
        if (priority !== undefined) updates.priority = priority;

        const { data: updated, error } = await supabase
          .from("system_directives")
          .update(updates)
          .eq("name", name)
          .select("name, content, priority")
          .single();
        if (error) throw error;
        result = { updated: true, directive: updated };
      } else {
        // Insert new
        const { data: inserted, error } = await supabase
          .from("system_directives")
          .insert({
            directive_type: "constraint",
            scope: "global",
            name,
            content: content || "",
            enforcement: "soft",
            priority: priority || 50,
            active: true,
          })
          .select("name, content, priority")
          .single();
        if (error) throw error;
        result = { created: true, directive: inserted };
      }

      return Response.json({ success: true, ...result }, { headers: corsHeaders });
    }

    // ADD/UPDATE USER PREFERENCE
    if (action === "update_preference") {
      const { key, value, user_id = "default" } = data;
      if (!key) throw new Error("preference key required");

      const { data: result, error } = await supabase
        .from("user_preferences")
        .upsert(
          { user_id, key, value, updated_at: new Date().toISOString() },
          { onConflict: "user_id,key" }
        )
        .select("key, value")
        .single();

      if (error) throw error;
      return Response.json({ success: true, preference: result }, { headers: corsHeaders });
    }

    // ADD TO BACKLOG
    if (action === "add_backlog") {
      const { name, priority = "p2_medium", project = "METIS-001", description } = data;
      if (!name) throw new Error("backlog item name required");

      const { data: result, error } = await supabase
        .from("backlog")
        .insert({ name, priority, project, description, status: "active" })
        .select("id, name, priority")
        .single();

      if (error) throw error;
      return Response.json({ success: true, backlog_item: result }, { headers: corsHeaders });
    }

    // COMPLETE BACKLOG ITEM
    if (action === "complete_backlog") {
      const { name } = data;
      if (!name) throw new Error("backlog item name required");

      const { data: result, error } = await supabase
        .from("backlog")
        .update({ status: "done", updated_at: new Date().toISOString() })
        .eq("name", name)
        .eq("status", "active")
        .select("name, status")
        .single();

      if (error) throw error;
      return Response.json({ success: true, completed: result }, { headers: corsHeaders });
    }

    // PROCESS FEEDBACK (main self-improvement entry point)
    if (action === "feedback") {
      const { feedback, category = "general" } = data;
      if (!feedback) throw new Error("feedback text required");

      // Log the feedback
      await supabase.from("feedback_log").insert({
        feedback,
        category,
        processed: false,
      }).catch(() => {}); // Ignore if table doesn't exist

      // Parse feedback for actionable changes
      const feedbackLower = feedback.toLowerCase();
      const changes: string[] = [];

      // Response length preferences
      if (feedbackLower.includes("too long") || feedbackLower.includes("too verbose") || feedbackLower.includes("shorter")) {
        await supabase.from("user_preferences").upsert(
          { user_id: "default", key: "response_length", value: "concise", updated_at: new Date().toISOString() },
          { onConflict: "user_id,key" }
        );
        changes.push("Set response_length preference to 'concise'");
      }

      if (feedbackLower.includes("more detail") || feedbackLower.includes("too short")) {
        await supabase.from("user_preferences").upsert(
          { user_id: "default", key: "response_length", value: "detailed", updated_at: new Date().toISOString() },
          { onConflict: "user_id,key" }
        );
        changes.push("Set response_length preference to 'detailed'");
      }

      // Code preferences
      if (feedbackLower.includes("no code") || feedbackLower.includes("don't show code") || feedbackLower.includes("without code")) {
        await supabase.from("user_preferences").upsert(
          { user_id: "default", key: "show_code", value: false, updated_at: new Date().toISOString() },
          { onConflict: "user_id,key" }
        );
        changes.push("Disabled code in responses");
      }

      if (feedbackLower.includes("show code") || feedbackLower.includes("include code")) {
        await supabase.from("user_preferences").upsert(
          { user_id: "default", key: "show_code", value: true, updated_at: new Date().toISOString() },
          { onConflict: "user_id,key" }
        );
        changes.push("Enabled code in responses");
      }

      // Format preferences
      if (feedbackLower.includes("no bullet") || feedbackLower.includes("no list")) {
        await supabase.from("user_preferences").upsert(
          { user_id: "default", key: "use_bullets", value: false, updated_at: new Date().toISOString() },
          { onConflict: "user_id,key" }
        );
        changes.push("Disabled bullet points");
      }

      return Response.json({
        success: true,
        feedback_received: feedback,
        changes_applied: changes,
        message: changes.length ? "Preferences updated" : "Feedback logged (no automatic changes detected)"
      }, { headers: corsHeaders });
    }

    // GET CURRENT CONTEXT (for debugging)
    if (action === "get_context" || req.method === "GET") {
      const [project, directives, decisions, preferences, backlog] = await Promise.all([
        supabase.from("project_briefs").select("code, current_phase, completion_pct, summary").eq("code", "METIS-001").single(),
        supabase.from("system_directives").select("name, content, priority").eq("active", true).order("priority", { ascending: false }).limit(10),
        supabase.from("decisions").select("subject, choice").eq("status", "active").limit(10),
        supabase.from("user_preferences").select("key, value").eq("user_id", "default"),
        supabase.from("backlog").select("name, priority").eq("status", "active").eq("project", "METIS-001").limit(10),
      ]);

      return Response.json({
        project: project.data,
        directives: directives.data,
        decisions: decisions.data,
        preferences: preferences.data,
        backlog: backlog.data,
        fetched_at: new Date().toISOString(),
      }, { headers: corsHeaders });
    }

    throw new Error(`Unknown action: ${action}. Available: update_project, add_decision, update_directive, update_preference, add_backlog, complete_backlog, feedback, get_context`);

  } catch (error) {
    console.error("context-sync error:", error);
    return Response.json({ error: error.message }, { status: 400, headers: corsHeaders });
  }
});
