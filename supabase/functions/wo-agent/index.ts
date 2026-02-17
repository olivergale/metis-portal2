// wo-agent/index.ts v6
// WO-0387: Smart circuit breaker -- evaluate_wo_lifecycle for review-vs-fail, accomplishments in continuation
// WO-0153: Fixed imports for Deno Deploy compatibility
// WO-0258: Auto-remediation on circuit breaker / timeout failures
// v5: Resilient health-check -- consecutive detection, timeout, auto-recovery
// Server-side agentic work order executor
// Replaces CLI subprocess model with API-based tool-use loop
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { buildAgentContext } from "./context.ts";
import { runAgentLoop } from "./agent-loop.ts";
import type { ToolContext } from "./tools.ts";

// WO-0513: beforeunload safety net -- log when worker is shutting down
addEventListener('beforeunload', (ev: any) => {
  console.log(`[WO-AGENT] Worker shutting down: ${ev.detail?.reason || 'unknown'}`);
});

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

function jsonResponse(data: any, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: CORS });
  }

  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  const url = new URL(req.url);
  const action = url.pathname.split("/").pop();

  try {
    switch (action) {
      case "execute":
        return await handleExecute(req);
      case "execute-batch":
        return await handleExecuteBatch(req);
      case "status":
        return await handleStatus(req);
      case "health-check":
        return await handleHealthCheck(req);
      default:
        return jsonResponse({ error: `Unknown action: ${action}` }, 404);
    }
  } catch (e: any) {
    console.error("[WO-AGENT] Unhandled error:", e);
    return jsonResponse({ error: e.message }, 500);
  }
});

/**
 * P6: Attempt to escalate the WO to a higher model tier before creating remediation.
 * Uses get_next_escalation_tier() RPC to look up the agent_escalation_tiers table.
 */
async function attemptEscalation(
  supabase: any,
  wo: { id: string; slug: string; name: string; objective?: string; tags?: string[]; assigned_to?: string },
  agentName: string,
  currentModel: string,
  failureReason: string
): Promise<boolean> {
  try {
    if (!agentName) {
      console.log(`[WO-AGENT] No agent name for ${wo.slug} - cannot escalate`);
      return false;
    }

    // Query the escalation tiers table via RPC
    const { data: tierResult, error: tierErr } = await supabase.rpc("get_next_escalation_tier", {
      p_agent_name: agentName,
      p_current_model: currentModel,
    });

    if (tierErr || !tierResult) {
      console.log(`[WO-AGENT] Escalation tier lookup failed for ${agentName}:`, tierErr?.message);
      return false;
    }

    if (tierResult.is_max_tier) {
      console.log(`[WO-AGENT] ${wo.slug} already at max escalation tier (${currentModel}) - cannot escalate`);
      return false;
    }

    const nextModel = tierResult.next_model;
    const nextTier = tierResult.tier_order;
    console.log(`[WO-AGENT] Escalating ${wo.slug} from ${currentModel} to ${nextModel} (tier ${nextTier})`);

    // Update client_info with escalation model override + reset status to in_progress
    await supabase.rpc("run_sql_void", {
      sql_query: `SELECT set_config('app.wo_executor_bypass', 'true', true); UPDATE work_orders SET status = 'in_progress', client_info = COALESCE(client_info, '{}'::jsonb) || jsonb_build_object('escalation_tier', ${nextTier}, 'escalation_model', '${nextModel.replace(/'/g, "''")}') WHERE id = '${wo.id}';`,
    });

    // Log escalation
    await supabase.from("work_order_execution_log").insert({
      work_order_id: wo.id,
      phase: "escalation",
      agent_name: agentName,
      detail: {
        event_type: "escalation_attempt",
        previous_model: currentModel,
        next_model: nextModel,
        next_tier: nextTier,
        reason: failureReason,
      },
    }).then(null, () => {});

    // WO-0740: Reset checkpoint count on escalation so escalated model gets a full run
    await supabase.from("work_order_execution_log").delete().eq("work_order_id", wo.id).eq("phase", "checkpoint");

    // Re-dispatch via pg_net POST
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY") || "";
    const selfUrl = Deno.env.get("SUPABASE_URL")!;

    await supabase.rpc("run_sql_void", {
      sql_query: `SELECT net.http_post(
        url := '${selfUrl}/functions/v1/wo-agent/execute',
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'Authorization', 'Bearer ${anonKey}',
          'apikey', '${anonKey}'
        ),
        body := jsonb_build_object(
          'work_order_id', '${wo.id}',
          'escalation_tier', ${nextTier}
        )
      );`,
    });

    console.log(`[WO-AGENT] ${wo.slug} escalated to tier ${nextTier} (${nextModel}) - re-dispatch queued`);
    return true;
  } catch (e: any) {
    console.error(`[WO-AGENT] Escalation failed for ${wo.slug}:`, e.message);
    return false;
  }
}

/**
 * WO-0487: Suggest alternative approaches based on error class
 */
function getAlternativeApproaches(toolName: string, errorClass: string): string | null {
  // GitHub edit failures -> use write instead
  if (toolName === "github_edit_file" && errorClass === "github_match_failure") {
    return "Use github_write_file to replace the entire file instead of github_edit_file";
  }
  
  // SQL syntax errors -> review schema context
  if (errorClass === "sql_syntax") {
    return "Review get_schema() output for correct column names and table structure";
  }
  
  // RLS violations -> use enforcement bypass RPC
  if (errorClass === "rls_violation") {
    return "Use state_write() RPC for protected tables or run_sql_void with bypass";
  }
  
  // Schema mismatches -> verify table/column existence first
  if (errorClass === "schema_mismatch") {
    return "Query information_schema or use read_table to verify object exists before mutation";
  }
  
  // Encoding errors -> avoid special characters or use bytea
  if (errorClass === "encoding_error") {
    return "Check for UTF-8 corruption from github_edit_file; use github_write_file for clean rewrite";
  }
  
  // Enforcement blocked -> use proper RPC with bypass
  if (errorClass === "enforcement_blocked") {
    return "Use update_work_order_state() RPC instead of direct UPDATE on work_orders table";
  }
  
  return null;
}

/**
 * WO-0258: Create a remediation WO when builder fails from circuit breaker or timeout.
 * Routes to builder (fresh execution budget).
 * Skips remediation WOs to avoid loops.
 * 
 * WO-0487: Enhanced with mutation diagnosis - queries wo_mutations for parent to build
 * structured diagnosis including completed mutations, failed mutations, DO NOT RETRY guidance,
 * and QA checklist status. Handles remediation chains up to depth 3.
 */
async function createFailureRemediation(
  supabase: any,
  wo: { id: string; slug: string; name: string; objective?: string; tags?: string[] },
  failureReason: string
): Promise<void> {
  try {
    const tags: string[] = wo.tags || [];
    if (tags.includes("remediation")) {
      console.log(`[WO-AGENT] Skip remediation for remediation WO ${wo.slug}`);
      return;
    }

    // WO-0367: Use evaluate_wo_context for comprehensive checks
    const { data: contextCheck, error: contextErr } = await supabase.rpc(
      "evaluate_wo_context",
      { p_wo_id: wo.id, p_proposed_action: "create_remediation" }
    );

    if (contextErr) {
      console.error(`[WO-AGENT] evaluate_wo_context failed:`, contextErr.message);
      // Fall back to direct check
      const { data: parentStatus } = await supabase
        .from("work_orders")
        .select("id, slug, status")
        .eq("id", wo.id)
        .single();

      if (parentStatus && parentStatus.status === "done") {
        console.log(`[WO-AGENT] Skip remediation for ${wo.slug} - parent already done`);
        await supabase.from("work_order_execution_log").insert({
          work_order_id: wo.id,
          phase: "stream",
          agent_name: "wo-agent",
          detail: {
            event_type: "remediation_skipped_parent_done",
            content: `Remediation creation skipped because parent ${wo.slug} is already done`,
          },
        }).then(null, () => {});
        return;
      }
    } else {
      // Check verdict from evaluate_wo_context
      const verdict = contextCheck?.verdict;
      if (verdict === "skip" || verdict === "cancel") {
        console.log(`[WO-AGENT] evaluate_wo_context ${verdict}: ${contextCheck?.reason}`);
        await supabase.from("work_order_execution_log").insert({
          work_order_id: wo.id,
          phase: "stream",
          agent_name: "wo-agent",
          detail: {
            event_type: "remediation_skipped_context",
            content: `Remediation skipped: ${contextCheck?.reason}`,
            context: contextCheck,
          },
        }).then(null, () => {});
        return;
      }
      
      if (verdict === "escalate") {
        console.log(`[WO-AGENT] Remediation escalate: ${contextCheck?.reason}`);
        await supabase.from("work_order_execution_log").insert({
          work_order_id: wo.id,
          phase: "stream",
          agent_name: "wo-agent",
          detail: {
            event_type: "remediation_escalate",
            content: contextCheck?.reason,
            remediation_depth: contextCheck?.remediation_depth,
          },
        }).then(null, () => {});
        
        // Tag for human review
        await supabase.rpc("run_sql_void", {
          sql_query: `SELECT set_config('app.wo_executor_bypass', 'true', true); UPDATE work_orders SET tags = array_append(COALESCE(tags, ARRAY[]::TEXT[]), 'needs-human-review') WHERE id = '${wo.id}' AND NOT ('needs-human-review' = ANY(COALESCE(tags, ARRAY[]::TEXT[])));`,
        });
        return;
      }
    }

    const { data: existing } = await supabase
      .from("work_orders")
      .select("id, slug, status")
      .contains("tags", ["remediation", `parent:${wo.slug}`])
      .limit(10);

    const active = (existing || []).find(
      (r: any) => ["draft", "ready", "in_progress", "review"].includes(r.status)
    );
    if (active) {
      console.log(`[WO-AGENT] Active remediation ${active.slug} already exists for ${wo.slug}`);
      return;
    }

    const attempts = (existing || []).length;
    
    // WO-0455: REMEDIATION DEPTH LIMIT - Max 3 attempts per root WO
    const MAX_REMEDIATION_DEPTH = 3;
    
    if (attempts >= MAX_REMEDIATION_DEPTH) {
      console.log(`[WO-AGENT] Remediation depth limit: ${attempts}/${MAX_REMEDIATION_DEPTH} for ${wo.slug} - tagging for human review`);
      await supabase.from("work_order_execution_log").insert({
        work_order_id: wo.id,
        phase: "stream",
        agent_name: "wo-agent",
        detail: {
          event_type: "remediation_depth_exceeded",
          content: `Remediation depth limit reached (${attempts} existing). Parent ${wo.slug} tagged for human review.`,
        },
      }).then(null, () => {});
      
      await supabase.rpc("run_sql_void", {
        sql_query: `SELECT set_config('app.wo_executor_bypass', 'true', true); UPDATE work_orders SET tags = array_append(COALESCE(tags, ARRAY[]::TEXT[]), 'needs-human-review') WHERE id = '${wo.id}' AND NOT ('needs-human-review' = ANY(COALESCE(tags, ARRAY[]::TEXT[])));`,
      });
      return;
    }
    
    if (attempts >= 3) {
      console.log(`[WO-AGENT] Remediation circuit breaker: ${attempts}/3 for ${wo.slug}`);
      await supabase.rpc("run_sql_void", {
        sql_query: `SELECT set_config('app.wo_executor_bypass', 'true', true); UPDATE work_orders SET tags = array_append(COALESCE(tags, ARRAY[]::TEXT[]), 'escalation:ilmarinen') WHERE id = '${wo.id}' AND NOT ('escalation:ilmarinen' = ANY(COALESCE(tags, ARRAY[]::TEXT[])));`,
      });
      return;
    }

    // WO-0455: Walk parent_id chain to root for flat remediation tree
    let rootWoId = wo.id;
    let rootWoSlug = wo.slug;
    let walkDepth = 0;
    const maxWalkDepth = 10; // prevent infinite loops
    
    while (walkDepth < maxWalkDepth) {
      const { data: parentCheck } = await supabase
        .from("work_orders")
        .select("id, slug, parent_id, status")
        .eq("id", rootWoId)
        .single();
      
      if (!parentCheck || !parentCheck.parent_id) {
        // No parent -- this is the root
        break;
      }
      
      // Check if parent is terminal (done/cancelled) -- if so, current WO is the effective root
      const { data: parentWo } = await supabase
        .from("work_orders")
        .select("id, slug, status")
        .eq("id", parentCheck.parent_id)
        .single();
      
      if (!parentWo || parentWo.status === "done" || parentWo.status === "cancelled") {
        // Parent is terminal -- current WO is the effective root
        break;
      }
      
      // Walk up to parent
      rootWoId = parentWo.id;
      rootWoSlug = parentWo.slug;
      walkDepth++;
    }
    
    console.log(`[WO-AGENT] Remediation root: ${rootWoSlug} (walked ${walkDepth} levels from ${wo.slug})`);

    const attemptNum = attempts + 1;
    
    // WO-0487: Query mutations and build structured diagnosis
    let objectiveText =
      `Fix and complete ${wo.slug} (${wo.name}) which failed due to: ${failureReason}\n\n` +
      `The server-side builder agent exhausted its execution budget. ` +
      `Review what was accomplished (check execution_log for parent WO), ` +
      `then complete the remaining work.\n\n` +
      `Parent WO objective: ${(wo.objective || "").slice(0, 1500)}\n\n`;

    // Query parent mutations
    const { data: parentMutations } = await supabase
      .from("wo_mutations")
      .select("tool_name, object_type, object_id, action, success, error_class, error_detail")
      .eq("work_order_id", wo.id)
      .order("created_at", { ascending: true });

    // Query parent qa_checklist
    const { data: parentWo } = await supabase
      .from("work_orders")
      .select("qa_checklist")
      .eq("id", wo.id)
      .single();

    const qaChecklist = parentWo?.qa_checklist || [];
    
    // For remediation chains, collect mutations from grandparent (up to depth 3)
    const allMutations: any[] = [...(parentMutations || [])];
    if (tags.includes("remediation")) {
      const parentTag = tags.find((t: string) => t.startsWith("parent:"));
      if (parentTag) {
        const grandparentSlug = parentTag.replace("parent:", "");
        const { data: grandparent } = await supabase
          .from("work_orders")
          .select("id, tags")
          .eq("slug", grandparentSlug)
          .single();
        
        if (grandparent) {
          const { data: grandparentMutations } = await supabase
            .from("wo_mutations")
            .select("tool_name, object_type, object_id, action, success, error_class, error_detail")
            .eq("work_order_id", grandparent.id)
            .order("created_at", { ascending: true });
          
          if (grandparentMutations && grandparentMutations.length > 0) {
            allMutations.unshift(...grandparentMutations);
          }
          
          // Go one more level for depth 3
          const grandparentTags = grandparent.tags || [];
          if (grandparentTags.includes("remediation")) {
            const ggParentTag = grandparentTags.find((t: string) => t.startsWith("parent:"));
            if (ggParentTag) {
              const ggSlug = ggParentTag.replace("parent:", "");
              const { data: ggParent } = await supabase
                .from("work_orders")
                .select("id")
                .eq("slug", ggSlug)
                .single();
              
              if (ggParent) {
                const { data: ggMutations } = await supabase
                  .from("wo_mutations")
                  .select("tool_name, object_type, object_id, action, success, error_class, error_detail")
                  .eq("work_order_id", ggParent.id)
                  .order("created_at", { ascending: true });
                
                if (ggMutations && ggMutations.length > 0) {
                  allMutations.unshift(...ggMutations);
                }
              }
            }
          }
        }
      }
    }

    // Build "Completed Mutations" section
    const successfulMutations = allMutations.filter((m) => m.success);
    if (successfulMutations.length > 0) {
      objectiveText += `## Completed Mutations\n`;
      objectiveText += `The following mutations were successfully applied:\n\n`;
      
      const grouped: Record<string, any[]> = {};
      for (const mut of successfulMutations) {
        const key = `${mut.tool_name}:${mut.object_id}`;
        if (!grouped[key]) grouped[key] = [];
        grouped[key].push(mut);
      }
      
      for (const [key, muts] of Object.entries(grouped)) {
        const first = muts[0];
        const actions = muts.map((m) => m.action).join(", ");
        objectiveText += `- **${first.tool_name}** on \`${first.object_id}\` (${first.object_type}): ${actions}\n`;
      }
      objectiveText += `\n`;
    }

    // Build "Failed Mutations" section
    const failedMutations = allMutations.filter((m) => !m.success);
    if (failedMutations.length > 0) {
      objectiveText += `## Failed Mutations\n`;
      objectiveText += `The following mutations failed:\n\n`;
      
      for (const mut of failedMutations) {
        objectiveText += `- **${mut.tool_name}** on \`${mut.object_id}\` (${mut.object_type})\n`;
        objectiveText += `  - Action: ${mut.action}\n`;
        objectiveText += `  - Error class: ${mut.error_class || "unknown"}\n`;
        if (mut.error_detail) {
          objectiveText += `  - Error: ${(mut.error_detail || "").slice(0, 200)}\n`;
        }
        objectiveText += `\n`;
      }
    }

    // Build "DO NOT RETRY" section with alternatives
    if (failedMutations.length > 0) {
      objectiveText += `## DO NOT RETRY\n`;
      objectiveText += `The following approaches failed and should NOT be retried:\n\n`;
      
      const failedPatterns: Record<string, { count: number; error_class: string; sample_error: string }> = {};
      for (const mut of failedMutations) {
        const key = `${mut.tool_name}:${mut.error_class || "unknown"}`;
        if (!failedPatterns[key]) {
          failedPatterns[key] = { count: 0, error_class: mut.error_class || "unknown", sample_error: mut.error_detail || "" };
        }
        failedPatterns[key].count++;
      }
      
      for (const [key, pattern] of Object.entries(failedPatterns)) {
        const [toolName, errorClass] = key.split(":");
        objectiveText += `- **${toolName}** (${errorClass}): failed ${pattern.count}x\n`;
        
        // Suggest alternatives based on error_class
        const alternatives = getAlternativeApproaches(toolName, errorClass);
        if (alternatives) {
          objectiveText += `  - **Alternative**: ${alternatives}\n`;
        }
        objectiveText += `\n`;
      }
    }

    // Include parent QA checklist status
    if (qaChecklist && qaChecklist.length > 0) {
      objectiveText += `## Parent QA Checklist\n`;
      const passed = qaChecklist.filter((item: any) => item.status === "pass").length;
      const failed = qaChecklist.filter((item: any) => item.status === "fail").length;
      const pending = qaChecklist.filter((item: any) => item.status === "pending").length;
      
      objectiveText += `- Passed: ${passed}\n`;
      objectiveText += `- Failed: ${failed}\n`;
      objectiveText += `- Pending: ${pending}\n\n`;
      
      const failedItems = qaChecklist.filter((item: any) => item.status === "fail");
      if (failedItems.length > 0) {
        objectiveText += `Failed criteria:\n`;
        for (const item of failedItems) {
          objectiveText += `- ${item.criterion || item.id}\n`;
        }
        objectiveText += `\n`;
      }
    }

    const { data: newWo, error: createErr } = await supabase.rpc("create_draft_work_order", {
      p_slug: null,
      p_name: `Fix: ${wo.slug} execution failure (attempt ${attemptNum}/3)`,
      p_objective: objectiveText,
      p_priority: "p1_high",
      p_source: "auto-qa",
      p_tags: ["remediation", `parent:${wo.slug}`, "auto-qa-loop"],
      p_acceptance_criteria:
        `1. Review parent WO ${wo.slug} execution log to understand what was completed\n` +
        `2. Complete all remaining acceptance criteria from parent WO\n` +
        `3. Verify changes are correct using read_table or execute_sql\n` +
        `4. Mark complete with summary of what was fixed`,
      p_parent_id: rootWoId,
    });

    if (createErr) {
      console.error(`[WO-AGENT] Failed to create remediation WO:`, createErr.message);
      await supabase.from("work_order_execution_log").insert({
        work_order_id: wo.id, phase: "failed", agent_name: "wo-agent",
        detail: { event_type: "remediation_create_failed", error: createErr.message, content: `Failed to create remediation WO for ${wo.slug}` },
      }).then(null, () => {});
      return;
    }

    const woId = typeof newWo === "string" ? newWo : newWo?.id;
    if (!woId) {
      console.error(`[WO-AGENT] create_draft_work_order returned no id`);
      return;
    }

    // Read remediation agent from system_settings (configurable, not hardcoded)
    let remediationAgent = "builder"; // fallback default
    try {
      const { data: agentSetting } = await supabase
        .from("system_settings")
        .select("setting_value")
        .eq("setting_key", "remediation_default_agent")
        .single();
      if (agentSetting?.setting_value) {
        remediationAgent = typeof agentSetting.setting_value === "string"
          ? agentSetting.setting_value
          : JSON.parse(JSON.stringify(agentSetting.setting_value)).replace(/"/g, "");
      }
    } catch {
      // Use fallback default
    }

    try {
      await supabase.rpc("start_work_order", {
        p_work_order_id: woId,
        p_agent_name: remediationAgent,
      });
      console.log(`[WO-AGENT] Auto-started remediation WO for ${wo.slug} (attempt ${attemptNum}, agent=${remediationAgent})`);
    } catch (startErr: any) {
      console.error(`[WO-AGENT] Failed to auto-start remediation:`, startErr.message);
      await supabase.from("work_order_execution_log").insert({
        work_order_id: wo.id, phase: "failed", agent_name: "wo-agent",
        detail: { event_type: "remediation_start_failed", error: startErr.message, content: `Remediation WO created but start_work_order failed for ${wo.slug}` },
      }).then(null, () => {});
    }
  } catch (e: any) {
    console.error(`[WO-AGENT] createFailureRemediation exception:`, e.message);
    try {
      await supabase.from("work_order_execution_log").insert({
        work_order_id: wo.id, phase: "failed", agent_name: "wo-agent",
        detail: { event_type: "remediation_exception", error: e.message, content: `createFailureRemediation crashed for ${wo.slug}` },
      });
    } catch { /* meta-error */ }
  }
}

/**
 * POST /execute
 * Execute a work order using the agentic loop
 * Body: { work_order_id: string }
 */
async function handleExecute(req: Request): Promise<Response> {
  const body = await req.json();
  const { work_order_id } = body;

  if (!work_order_id) {
    return jsonResponse({ error: "Missing work_order_id" }, 400);
  }

  const sbUrl = Deno.env.get("SUPABASE_URL")!;
  const sbKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const supabase = createClient(sbUrl, sbKey);

  const { data: wo, error: woError } = await supabase
    .from("work_orders")
    .select(
      "id, slug, name, objective, acceptance_criteria, tags, priority, status, summary, qa_checklist, client_info, project_brief_id, depends_on, assigned_to, pipeline_phase, pipeline_run_id, parent_id"
    )
    .eq("id", work_order_id)
    .single();

  if (woError || !wo) {
    return jsonResponse(
      { error: `Work order not found: ${woError?.message || work_order_id}` },
      404
    );
  }

  if (wo.status !== "in_progress") {
    return jsonResponse(
      { error: `Work order ${wo.slug} is not in_progress (current: ${wo.status})` },
      400
    );
  }

  // WO-0155 + WO-0363: MOOT DETECTION ON START - Guard against orphaned remediation WOs
  const tags: string[] = wo.tags || [];
  if (tags.includes("remediation")) {
    const parentTag = tags.find((t: string) => t.startsWith("parent:"));
    if (parentTag) {
      const parentSlug = parentTag.replace("parent:", "");
      const { data: parentWo } = await supabase
        .from("work_orders")
        .select("id, slug, status")
        .eq("slug", parentSlug)
        .single();

      // WO-0363: Check for both 'done' and 'cancelled' parent status
      if (parentWo && (parentWo.status === "done" || parentWo.status === "cancelled")) {
        const msg = `Parent ${parentSlug} already resolved (${parentWo.status}) -- remediation unnecessary`;
        console.log(`[WO-AGENT] ${wo.slug}: ${msg}`);

        await supabase.from("work_order_execution_log").insert({
          work_order_id: wo.id,
          phase: "execution_complete",
          agent_name: "wo-agent",
          detail: { event_type: "result", content: msg },
        });
        await supabase.rpc("run_sql_void", {
          sql_query: `SELECT set_config('app.wo_executor_bypass', 'true', true); UPDATE work_orders SET status = 'done', completed_at = NOW(), summary = 'Parent already resolved' WHERE id = '${wo.id}';`,
        });

        return jsonResponse({
          work_order_id: wo.id, slug: wo.slug, status: "completed",
          turns: 0, summary: "Parent already resolved", tool_calls: 0,
        });
      }
    }
  }

  // Load GitHub token
  let githubToken: string | null = null;
  try {
    const { data } = await supabase
      .from("secrets").select("value").eq("key", "GITHUB_TOKEN").single();
    githubToken = data?.value || null;
  } catch { /* GitHub tools will fail gracefully */ }

  // Build agent context
  const agentContext = await buildAgentContext(supabase, wo);

  const toolCtx: ToolContext = {
    supabase,
    workOrderId: wo.id,
    workOrderSlug: wo.slug,
    githubToken,
    agentName: agentContext.agentName,
  };

  // WO-0187: Check for continuation
  let finalUserMessage = agentContext.userMessage;
  const { data: checkpoint } = await supabase
    .from("work_order_execution_log")
    .select("detail, created_at")
    .eq("work_order_id", work_order_id)
    .eq("phase", "checkpoint")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (checkpoint?.detail) {
    const { count: checkpointCount } = await supabase
      .from("work_order_execution_log")
      .select("id", { count: "exact", head: true })
      .eq("work_order_id", work_order_id)
      .eq("phase", "checkpoint");

    // AC4: Hard safety cap - if checkpointCount >= 8, unconditionally fail
    if ((checkpointCount || 0) >= 8) {
      const msg = `Hard circuit breaker cap: 8 checkpoints reached. Marking failed.`;
      await supabase.from("work_order_execution_log").insert({
        work_order_id: wo.id, phase: "loop_breaker", agent_name: agentContext.agentName,
        detail: {
          event_type: "circuit_breaker_decision",
          decision: "hard_cap",
          reason: msg,
          mutation_count_current: 0,
          mutation_count_previous: 0,
          delta: 0,
          checkpoint_count: checkpointCount,
        },
      });
      await supabase.from("work_order_execution_log").insert({
        work_order_id: wo.id, phase: "failed", agent_name: agentContext.agentName,
        detail: { event_type: "circuit_breaker", content: msg, decision: "hard_cap" },
      });
      // P6: Try escalation before failing
      const escalated = await attemptEscalation(supabase, wo, agentContext.agentName, agentContext.model, msg);
      if (escalated) {
        return jsonResponse({ work_order_id: wo.id, slug: wo.slug, status: "escalated", turns: 0, summary: `Escalated: ${msg}`, tool_calls: 0 });
      }
      await supabase.rpc("run_sql_void", {
        sql_query: `SELECT set_config('app.wo_executor_bypass', 'true', true); UPDATE work_orders SET status = 'failed', summary = '${msg.replace(/'/g, "''")}' WHERE id = '${wo.id}';`,
      });
      await createFailureRemediation(supabase, wo, msg);
      return jsonResponse({ work_order_id: wo.id, slug: wo.slug, status: "failed", turns: 0, summary: msg, tool_calls: 0 });
    }

    if ((checkpointCount || 0) >= 3) {
      // WO-0499: Progress-based circuit breaker  --  mutation-delta decides continue vs stuck
      const previousMutations = checkpoint?.detail?.mutation_digest?.total || null;
      const { data: cbResult, error: cbErr } = await supabase.rpc("evaluate_circuit_breaker_progress", {
        p_wo_id: wo.id,
        p_checkpoint_count: checkpointCount,
        p_previous_mutation_count: previousMutations,
      });

      if (cbErr) {
        console.error(`[WO-AGENT] evaluate_circuit_breaker_progress error:`, cbErr.message);
      }

      const decision = cbResult?.decision || "stuck";
      const reason = cbResult?.reason || `Circuit breaker (${checkpointCount} checkpoints)`;
      const mutationCount = cbResult?.mutation_count_current || 0;

      // AC5: Log circuit breaker decision to loop_breaker phase
      await supabase.from("work_order_execution_log").insert({
        work_order_id: wo.id, phase: "loop_breaker", agent_name: agentContext.agentName,
        detail: {
          event_type: "circuit_breaker_decision", decision, reason,
          mutation_count_current: cbResult?.mutation_count_current,
          mutation_count_previous: cbResult?.mutation_count_previous,
          delta: cbResult?.mutation_delta,
          checkpoint_count: checkpointCount,
        },
      });

      if (decision === "continue") {
        // AC3: New mutations detected  --  allow continuation regardless of checkpoint count
        // Fall through to continuation logic below
      } else {
        // stuck or hard_cap  --  try escalation first, then fail + remediation
        const msg = `${reason}. Marking failed.`;
        // P6: Try escalation before failing
        const escalated = await attemptEscalation(supabase, wo, agentContext.agentName, agentContext.model, msg);
        if (escalated) {
          return jsonResponse({ work_order_id: wo.id, slug: wo.slug, status: "escalated", turns: 0, summary: `Escalated: ${msg}`, tool_calls: 0 });
        }
        await supabase.from("work_order_execution_log").insert({
          work_order_id: wo.id, phase: "failed", agent_name: agentContext.agentName,
          detail: { event_type: "circuit_breaker", content: msg, decision, mutation_count: mutationCount },
        });
        await supabase.rpc("run_sql_void", {
          sql_query: `SELECT set_config('app.wo_executor_bypass', 'true', true); UPDATE work_orders SET status = 'failed', summary = '${msg.replace(/'/g, "''")}' WHERE id = '${wo.id}';`,
        });
        await createFailureRemediation(supabase, wo, msg);
        return jsonResponse({ work_order_id: wo.id, slug: wo.slug, status: "failed", turns: 0, summary: msg, tool_calls: 0 });
      }
    }


    // Build continuation context
    const cp = checkpoint.detail;
    let childStatusContext = "";
    if (cp.delegated_children && cp.delegated_children.length > 0) {
      const childSlugs = cp.delegated_children.map((c: any) => c.child_slug);
      const { data: childWOs } = await supabase
        .from("work_orders").select("slug, status, summary").in("slug", childSlugs);
      if (childWOs && childWOs.length > 0) {
        childStatusContext = `\n## Delegated Children Status\n`;
        for (const child of childWOs) {
          childStatusContext += `- **${child.slug}** (${child.status}): ${(child.summary || "no summary yet").slice(0, 300)}\n`;
        }
        childStatusContext += `\n`;
      }
    }
    finalUserMessage = `# CONTINUATION -- Work Order: ${wo.slug}\n\n`;
    finalUserMessage += `**You are CONTINUING a previous execution that checkpointed.**\n`;
    finalUserMessage += `Continuation #${(checkpointCount || 0) + 1} of max 3.\n\n`;

    // WO-0387: Include accomplishments so agent doesn't waste turns rediscovering progress
    const accomplishments: string[] = cp.accomplishments || [];
    if (accomplishments.length > 0) {
      finalUserMessage += `## What Was Already Done\n`;
      for (const acc of accomplishments) {
        finalUserMessage += `- ${acc}\n`;
      }
      finalUserMessage += `\n**Do NOT call read_execution_log to check progress. The above is your accomplishment list. Continue from where you left off.**\n\n`;
    } else {
      finalUserMessage += `Previous progress: ${cp.turns_completed} turns, ${cp.mutations || 0} mutations.\n`;
      finalUserMessage += `Last actions: ${cp.last_actions || 'unknown'}\n\n`;
    }

    // WO-0486: Inject mutation digest for data-driven continuation context
    const mutationDigest = cp.mutation_digest;
    if (mutationDigest && mutationDigest.total > 0) {
      finalUserMessage += `## What Was Already Done (Mutation Summary)\n`;
      finalUserMessage += `- **Total mutations**: ${mutationDigest.total}\n`;
      finalUserMessage += `- **Successful**: ${mutationDigest.successful}\n`;
      finalUserMessage += `- **Failed**: ${mutationDigest.failed}\n`;
      if (mutationDigest.by_error_class && Object.keys(mutationDigest.by_error_class).length > 0) {
        finalUserMessage += `- **Failures by error class**: ${JSON.stringify(mutationDigest.by_error_class)}\n`;
      }
      finalUserMessage += `\n`;
    }

    // WO-0486: Inject failed approaches to prevent retry loops
    const failedApproaches: any[] = cp.failed_approaches || [];
    if (failedApproaches.length > 0) {
      finalUserMessage += `## Failed Approaches (DO NOT RETRY)\n`;
      finalUserMessage += `The following operations already failed in previous execution. Do NOT retry them:\n\n`;
      for (const fa of failedApproaches) {
        finalUserMessage += `- **${fa.tool}** on \`${fa.target}\` (action: ${fa.action})\n`;
        finalUserMessage += `  - Error class: ${fa.error_class}\n`;
        if (fa.error_detail) {
          finalUserMessage += `  - Error: ${fa.error_detail}\n`;
        }
        finalUserMessage += `\n`;
      }
      finalUserMessage += `**IMPORTANT**: These approaches already failed. Try a different strategy or escalate if you cannot proceed.\n\n`;
    }

    // P2: Schema refresh on continuation — re-extract schema for objects agent created/modified
    try {
      const { data: refreshedSchema } = await supabase.rpc("get_dynamic_schema_context", {
        p_work_order_id: wo.id,
      });
      if (refreshedSchema) {
        finalUserMessage += `## Updated Schema Context\n`;
        finalUserMessage += refreshedSchema.slice(0, 8000) + `\n\n`;
      }
    } catch {
      // Schema refresh failed, continue without
    }

    finalUserMessage += `## Original Objective\n${wo.objective}\n\n`;
    if (wo.acceptance_criteria) {
      finalUserMessage += `## Acceptance Criteria\n${wo.acceptance_criteria}\n\n`;
    }
    if (childStatusContext) {
      finalUserMessage += childStatusContext;
    }
    finalUserMessage += `**IMPORTANT**: Do NOT redo work already done. Continue from where you left off. Call mark_complete when done.\n`;

    await supabase.from("work_order_execution_log").insert({
      work_order_id: wo.id, phase: "continuation", agent_name: agentContext.agentName,
      detail: { event_type: "continuation_start", checkpoint_count: (checkpointCount || 0) + 1, previous_turns: cp.turns_completed },
    });
  }

  // WO-0513: Run agentic loop as background task via EdgeRuntime.waitUntil()
  // This returns the HTTP response immediately, avoiding the 150s request idle timeout.
  // The background task uses the full 400s Pro plan wall clock budget.
  const backgroundExecution = async () => {
    try {
      // WO-0401: Pass config-driven model from agent profile
      // WO-0590: Pass config-driven max_tokens from agent profile
      const result = await runAgentLoop(
        agentContext.systemPrompt,
        finalUserMessage,
        toolCtx,
        wo.tags || [],
        agentContext.model,
        agentContext.maxTokens
      );

      console.log(`[WO-AGENT] ${wo.slug} finished: ${result.status} in ${result.turns} turns`);

      // WO-0187: Self-reinvoke on checkpoint/timeout
      // Fix: read anon key from system_settings (same source as triggers) instead of env var
      if (result.status === "checkpoint" || result.status === "timeout") {
        try {
          const selfUrl = Deno.env.get("SUPABASE_URL")!;
          await supabase.rpc("run_sql_void", {
            sql_query: `SELECT net.http_post(
              url := '${selfUrl}/functions/v1/wo-agent/execute',
              headers := jsonb_build_object(
                'Content-Type', 'application/json',
                'Authorization', 'Bearer ' || (SELECT setting_value #>> '{}' FROM system_settings WHERE setting_key = 'supabase_anon_key'),
                'apikey', (SELECT setting_value #>> '{}' FROM system_settings WHERE setting_key = 'supabase_anon_key')
              ),
              body := jsonb_build_object('work_order_id', '${wo.id}')
            );`,
          });
          console.log(`[WO-AGENT] ${wo.slug} checkpointed -- self-reinvoke queued`);
        } catch (e: any) {
          console.error(`[WO-AGENT] ${wo.slug} self-reinvoke failed:`, e.message);
          await supabase.from("work_order_execution_log").insert({
            work_order_id: wo.id, phase: "failed", agent_name: agentContext.agentName,
            detail: { event_type: "continuation_failed", error: e.message, content: `Self-reinvoke failed after checkpoint: ${e.message}` },
          }).then(null, () => {});
        }
      }
    } catch (e: any) {
      console.error(`[WO-AGENT] ${wo.slug} background execution error:`, e.message);
      try {
        await supabase.from("work_order_execution_log").insert({
          work_order_id: wo.id, phase: "failed", agent_name: agentContext.agentName,
          detail: { event_type: "background_error", error: e.message, content: `Background execution crashed: ${e.message}` },
        });
        await supabase.rpc("run_sql_void", {
          sql_query: `SELECT set_config('app.wo_executor_bypass', 'true', true); UPDATE work_orders SET status = 'failed', summary = 'Background execution error: ${e.message.replace(/'/g, "''")}' WHERE id = '${wo.id}';`,
        });
      } catch { /* meta-error */ }
    }
  };

  EdgeRuntime.waitUntil(backgroundExecution());

  // Return immediately -- caller (pg_net trigger) already ignores this response
  return jsonResponse({
    work_order_id: wo.id, slug: wo.slug, status: "started",
    message: "Execution started in background (400s wall clock budget)",
  });
}

/**
 * POST /execute-batch
 * Execute a batch of work orders in parallel with dependency ordering
 * Body: { batch_id: string }
 */
async function handleExecuteBatch(req: Request): Promise<Response> {
  const body = await req.json();
  const { batch_id } = body;

  if (!batch_id) {
    return jsonResponse({ error: "Missing batch_id" }, 400);
  }

  const sbUrl = Deno.env.get("SUPABASE_URL")!;
  const sbKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const supabase = createClient(sbUrl, sbKey);

  const { data: startResult, error: startError } = await supabase.rpc(
    "start_batch_execution", { p_batch_id: batch_id }
  );

  if (startError || !startResult?.success) {
    return jsonResponse(
      { error: `Failed to start batch: ${startError?.message || startResult?.error}` },
      400
    );
  }

  const { data: batch } = await supabase
    .from("wo_batches").select("parallel_slots, execution_mode").eq("id", batch_id).single();

  const parallelSlots = batch?.parallel_slots || 3;
  const executionMode = batch?.execution_mode || "step";

  console.log(`[BATCH] Starting batch ${batch_id} in ${executionMode} mode with ${parallelSlots} parallel slots`);

  const executedWOs: string[] = [];
  const failedWOs: string[] = [];
  let iterationCount = 0;
  const maxIterations = 100;

  while (iterationCount < maxIterations) {
    iterationCount++;

    const { data: readyWOs, error: readyError } = await supabase.rpc(
      "get_batch_ready_wos", { p_batch_id: batch_id }
    );

    if (readyError) { console.error(`[BATCH] Error getting ready WOs:`, readyError); break; }
    if (!readyWOs || readyWOs.length === 0) { console.log(`[BATCH] No more ready WOs.`); break; }

    const waveWOs = readyWOs.slice(0, parallelSlots);

    const startPromises = waveWOs.map(async (wo: any) => {
      try {
        const { data: startWOResult } = await supabase.rpc("start_work_order", {
          p_work_order_id: wo.work_order_id, p_agent_name: "builder",
        });
        if (!startWOResult?.id) throw new Error(`Failed to start WO ${wo.slug}`);

        const anonKey = Deno.env.get("SUPABASE_ANON_KEY") || "";
        const executeRes = await fetch(`${sbUrl}/functions/v1/wo-agent/execute`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "Authorization": `Bearer ${anonKey}`, "apikey": anonKey },
          body: JSON.stringify({ work_order_id: wo.work_order_id }),
        });

        const result = await executeRes.json();
        if (result.status === "completed" || result.status === "done") {
          executedWOs.push(wo.slug);
          return { success: true, slug: wo.slug };
        } else {
          failedWOs.push(wo.slug);
          return { success: false, slug: wo.slug, error: result.error };
        }
      } catch (e: any) {
        console.error(`[BATCH] Error executing ${wo.slug}:`, e.message);
        failedWOs.push(wo.slug);
        return { success: false, slug: wo.slug, error: e.message };
      }
    });

    await Promise.all(startPromises);
  }

  const summary = `Batch execution completed: ${executedWOs.length} WOs succeeded, ${failedWOs.length} failed across ${iterationCount} waves`;
  const { data: completeResult } = await supabase.rpc("complete_batch_execution", {
    p_batch_id: batch_id, p_summary: summary,
  });

  return jsonResponse({
    batch_id, execution_mode: executionMode, waves: iterationCount,
    executed: executedWOs.length, failed: failedWOs.length,
    summary, completion_rate: completeResult?.completion_rate || 0,
  });
}

/**
 * POST /status
 * Check the execution status of a work order
 * Body: { work_order_id: string }
 */
async function handleStatus(req: Request): Promise<Response> {
  const body = await req.json();
  const { work_order_id } = body;

  if (!work_order_id) {
    return jsonResponse({ error: "Missing work_order_id" }, 400);
  }

  const sbUrl = Deno.env.get("SUPABASE_URL")!;
  const sbKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const supabase = createClient(sbUrl, sbKey);

  const { data: wo } = await supabase
    .from("work_orders").select("id, slug, status, summary")
    .eq("id", work_order_id).single();

  if (!wo) {
    return jsonResponse({ error: "Work order not found" }, 404);
  }

  const { data: logs } = await supabase
    .from("work_order_execution_log")
    .select("phase, detail, created_at")
    .eq("work_order_id", work_order_id)
    .order("created_at", { ascending: false })
    .limit(5);

  return jsonResponse({
    work_order_id: wo.id, slug: wo.slug, status: wo.status,
    summary: wo.summary, recent_activity: logs || [],
  });
}

/**
 * POST /health-check
 * Ops agent endpoint: detects stuck WOs, orphans, failed WO triage, queue stalls, auto-recovery
 * Body: { trigger?: "cron" | "manual" }
 *
 * v5 resilience:
 * - 45s timeout wrapper (prevents platform 503)
 * - Consecutive detection: warn -> warn -> fail (3 cycles = 30 min before failure)
 * - Auto-recovery: stuck_detection failures get retried once automatically
 * - Pagination: max 50 WOs per scan
 */
async function handleHealthCheck(req: Request): Promise<Response> {
  const body = await req.json().catch(() => ({}));
  const trigger = body.trigger || "cron";

  // Timeout wrapper -- prevent platform 503 on slow queries
  const timeoutMs = 45_000;
  let timer: number | undefined;

  try {
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("Health-check timeout after 45s")), timeoutMs) as unknown as number;
    });
    const result = await Promise.race([healthCheckLogic(trigger), timeoutPromise]);
    clearTimeout(timer);
    return jsonResponse(result);
  } catch (e: any) {
    if (timer) clearTimeout(timer);
    const isTimeout = e.message?.includes("timeout");
    console.error(`[HEALTH-CHECK] ${isTimeout ? "TIMEOUT" : "ERROR"}: ${e.message}`);
    // Return 200 even on timeout -- never cascade 503 which kills the whole system
    return jsonResponse({
      status: isTimeout ? "timeout" : "error",
      error: e.message,
      timestamp: new Date().toISOString(),
    });
  }
}

async function healthCheckLogic(trigger: string) {
  const sbUrl = Deno.env.get("SUPABASE_URL");
  const sbKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!sbUrl || !sbKey) {
    return { status: "error", error: "Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY" };
  }
  const supabase = createClient(sbUrl, sbKey);

  const actions: any[] = [];
  const now = new Date();

  // 1. Stuck WO detection with CONSECUTIVE warning before failure
  const tenMinAgo = new Date(now.getTime() - 10 * 60 * 1000).toISOString();
  const { data: stuckWOs } = await supabase
    .from("work_orders")
    .select("id, slug, started_at, assigned_to, tags, status")
    .eq("status", "in_progress")
    .limit(50);

  for (const wo of stuckWOs || []) {
    const { data: recentLog } = await supabase
      .from("work_order_execution_log")
      .select("created_at, phase")
      .eq("work_order_id", wo.id)
      .gte("created_at", tenMinAgo)
      .limit(1);

    if (!recentLog || recentLog.length === 0) {
      // Check for active children
      const { count: activeChildCount } = await supabase
        .from("work_orders")
        .select("id", { count: "exact", head: true })
        .eq("parent_id", wo.id)
        .in("status", ["in_progress", "review", "ready"]);

      if ((activeChildCount || 0) > 0) {
        await supabase.rpc("run_sql_void", {
          sql_query: `SELECT set_config('app.wo_executor_bypass', 'true', true); UPDATE work_orders SET tags = array_append(COALESCE(tags, ARRAY[]::TEXT[]), 'waiting-on-children') WHERE id = '${wo.id}' AND NOT ('waiting-on-children' = ANY(COALESCE(tags, ARRAY[]::TEXT[])));`,
        });
        actions.push({ type: "stuck_detection", wo_slug: wo.slug, action: "skipped_has_active_children", active_children: activeChildCount });
      } else {
        // CONSECUTIVE DETECTION: count recent stuck_detection warnings in last 30 min
        const thirtyMinAgo = new Date(now.getTime() - 30 * 60 * 1000).toISOString();
        const { count: warnCount } = await supabase
          .from("work_order_execution_log")
          .select("id", { count: "exact", head: true })
          .eq("work_order_id", wo.id)
          .eq("phase", "stuck_detection")
          .gte("created_at", thirtyMinAgo);

        const warnings = warnCount || 0;

        if (warnings >= 2) {
          // 3rd detection -- genuinely stuck for 30+ min, NOW mark failed
          await supabase.rpc("run_sql_void", {
            sql_query: `SELECT set_config('app.wo_executor_bypass', 'true', true); UPDATE work_orders SET status = 'failed', completed_at = NOW() WHERE id = '${wo.id}' AND status = 'in_progress';`,
          });
          await supabase.from("work_order_execution_log").insert({
            work_order_id: wo.id, phase: "stuck_detection", agent_name: "ops",
            detail: { event_type: "stuck_detection", action: "marked_failed",
              reason: `No heartbeat for 30+ min (${warnings + 1} consecutive detections)`,
              started_at: wo.started_at, detection_time: now.toISOString(), consecutive_warnings: warnings },
          });
          actions.push({ type: "stuck_detection", wo_slug: wo.slug, action: "marked_failed", warnings: warnings + 1 });
        } else {
          // Warning only -- don't mark failed yet
          await supabase.from("work_order_execution_log").insert({
            work_order_id: wo.id, phase: "stuck_detection", agent_name: "ops",
            detail: { event_type: "stuck_detection", action: "warning",
              reason: `No heartbeat in 10 min (warning ${warnings + 1}/3 before failure)`,
              detection_time: now.toISOString(), consecutive_warnings: warnings + 1 },
          });
          actions.push({ type: "stuck_detection", wo_slug: wo.slug, action: "warning", warning_number: warnings + 1 });
        }
      }
    }
  }

  // 2. Orphan cleanup: remediation WOs where parent is done
  const { data: orphanRems } = await supabase
    .from("work_orders")
    .select("id, slug, tags, status")
    .contains("tags", ["remediation"])
    .in("status", ["draft", "ready", "in_progress"])
    .limit(50);

  for (const rem of orphanRems || []) {
    const parentTag = (rem.tags || []).find((t: string) => t.startsWith("parent:"));
    if (!parentTag) continue;
    const parentSlug = parentTag.replace("parent:", "");
    const { data: parent } = await supabase
      .from("work_orders").select("status").eq("slug", parentSlug).single();

    if (parent && parent.status === "done") {
      await supabase.rpc("run_sql_void", {
        sql_query: `SELECT set_config('app.wo_executor_bypass', 'true', true); UPDATE work_orders SET status = 'done', completed_at = NOW(), summary = 'Auto-completed by ops: parent ${parentSlug.replace(/'/g, "''")} already done' WHERE id = '${rem.id}';`,
      });
      actions.push({ type: "orphan_cleanup", wo_slug: rem.slug, parent_slug: parentSlug, action: "auto_completed" });
    }
  }

  // 3. Failed WO triage + AUTO-RECOVERY for stuck_detection false positives
  const { data: failedWOs } = await supabase
    .from("work_orders")
    .select("id, slug, tags, priority")
    .eq("status", "failed")
    .not("tags", "cs", '{"no-retry"}')
    .limit(50);

  for (const wo of failedWOs || []) {
    // Check if this was a stuck_detection failure (likely false positive during infra outage)
    const { data: lastFailLog } = await supabase
      .from("work_order_execution_log")
      .select("phase, detail, created_at")
      .eq("work_order_id", wo.id)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    const wasStuckDetection = lastFailLog?.phase === "stuck_detection" && lastFailLog?.detail?.action === "marked_failed";
    const alreadyRetried = (wo.tags || []).includes("auto-recovered");

    if (wasStuckDetection && !alreadyRetried) {
      // Auto-recovery: reset to draft, tag, approve so auto-start picks it up
      await supabase.rpc("run_sql_void", {
        sql_query: `SELECT set_config('app.wo_executor_bypass', 'true', true); UPDATE work_orders SET status = 'draft', completed_at = NULL, tags = array_append(COALESCE(tags, ARRAY[]::TEXT[]), 'auto-recovered') WHERE id = '${wo.id}' AND status = 'failed';`,
      });
      await supabase.rpc("run_sql_void", {
        sql_query: `SELECT set_config('app.wo_executor_bypass', 'true', true); UPDATE work_orders SET status = 'ready', approved_at = NOW(), approved_by = 'ops-auto-recovery' WHERE id = '${wo.id}' AND status = 'draft';`,
      });
      await supabase.from("work_order_execution_log").insert({
        work_order_id: wo.id, phase: "stream", agent_name: "ops",
        detail: { event_type: "auto_recovery", action: "recovered_from_stuck_detection",
          reason: "Stuck detection failure likely caused by infra outage -- auto-retrying once" },
      });
      actions.push({ type: "auto_recovery", wo_slug: wo.slug, action: "recovered" });
      continue;
    }

    // Standard triage: tag no-retry after 3 failures
    const { count } = await supabase
      .from("work_order_execution_log")
      .select("id", { count: "exact", head: true })
      .eq("work_order_id", wo.id)
      .eq("phase", "failed");

    if ((count || 0) >= 3) {
      await supabase.rpc("run_sql_void", {
        sql_query: `SELECT set_config('app.wo_executor_bypass', 'true', true); UPDATE work_orders SET tags = array_append(COALESCE(tags, ARRAY[]::TEXT[]), 'no-retry') WHERE id = '${wo.id}';`,
      });
      actions.push({ type: "failed_triage", wo_slug: wo.slug, attempts: count, action: "tagged_no_retry" });
    }
  }

  // 4. Queue stall detection
  const thirtyMinAgo2 = new Date(now.getTime() - 30 * 60 * 1000).toISOString();
  const { count: pendingCount } = await supabase
    .from("work_orders")
    .select("id", { count: "exact", head: true })
    .in("status", ["ready", "in_progress"]);

  let queueStalled = false;
  if ((pendingCount || 0) > 0) {
    const { count: recentTransitions } = await supabase
      .from("state_mutations")
      .select("id", { count: "exact", head: true })
      .eq("target_table", "work_orders")
      .gte("created_at", thirtyMinAgo2);

    if ((recentTransitions || 0) === 0) {
      queueStalled = true;
      actions.push({ type: "queue_stall", pending_wos: pendingCount, action: "alert",
        message: "No WO transitions in 30+ min with pending work" });
    }
  }

  // 5. Auto-unblock: ready WOs with satisfied depends_on
  const { data: blockedWOs } = await supabase
    .from("work_orders")
    .select("id, slug, depends_on")
    .eq("status", "ready")
    .not("depends_on", "is", null)
    .limit(50);

  for (const wo of blockedWOs || []) {
    if (!wo.depends_on || wo.depends_on.length === 0) continue;
    const { count: openDeps } = await supabase
      .from("work_orders")
      .select("id", { count: "exact", head: true })
      .in("id", wo.depends_on)
      .not("status", "in", '("done","cancelled")');

    if ((openDeps || 0) === 0) {
      const { error: startErr } = await supabase.rpc("start_work_order", {
        p_work_order_id: wo.id, p_agent_name: "builder",
      });
      if (!startErr) {
        actions.push({ type: "auto_unblock", wo_slug: wo.slug, action: "started" });
      }
    }
  }

  // Log health check result
  await supabase.from("audit_log").insert({
    event_type: "health_check", actor_type: "system", actor_id: "ops",
    target_type: "system", target_id: "27148e96-5094-4a80-a832-8cdb93c8d96f",
    action: `Health check: ${actions.length} actions taken`,
    payload: { trigger, actions_taken: actions.length, stuck_detected: stuckWOs?.length || 0,
      failed_triaged: failedWOs?.length || 0, queue_stalled: queueStalled, actions },
  });

  return {
    status: "ok", timestamp: now.toISOString(), trigger,
    actions_taken: actions.length, details: actions,
  };
}
