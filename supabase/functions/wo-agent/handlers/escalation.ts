// wo-agent/handlers/escalation.ts
// WO-0743: Extracted from index.ts — escalation logic + alternative approaches

/**
 * P6: Attempt to escalate the WO to a higher model tier before creating remediation.
 * Uses get_next_escalation_tier() RPC to look up the agent_escalation_tiers table.
 */
export async function attemptEscalation(
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
export function getAlternativeApproaches(toolName: string, errorClass: string): string | null {
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
