// Sprite Dispatcher — Creates ephemeral Fly Machines for WO execution
// Replaces wo-agent edge function execution with native Fly Machine execution.
// Each WO gets its own Machine: boot → clone → agent loop → push → self-destruct.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";

const FLY_API_BASE = "https://api.machines.dev/v1";
const FLY_APP = "endgame-sprite";
const SPRITE_IMAGE = "registry.fly.io/endgame-sprite:deployment-01KHRTJTRRVB6XDDCF9XAT9M94";
const REGION = "iad";

interface DispatchPayload {
  work_order_id: string;
}

interface WOContext {
  id: string;
  slug: string;
  name: string;
  objective: string;
  acceptance_criteria: string | null;
  tags: string[];
  priority: string;
  assigned_to: string | null;
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { "Content-Type": "application/json" },
    });
  }

  try {
    const payload: DispatchPayload = await req.json();
    const { work_order_id } = payload;

    if (!work_order_id) {
      return new Response(
        JSON.stringify({ error: "work_order_id required" }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    // Connect to Supabase
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    // Load WO context
    const { data: wo, error: woErr } = await supabase
      .from("work_orders")
      .select("id, slug, name, objective, acceptance_criteria, tags, priority, assigned_to")
      .eq("id", work_order_id)
      .single();

    if (woErr || !wo) {
      return new Response(
        JSON.stringify({ error: "WO not found", detail: woErr?.message }),
        { status: 404, headers: { "Content-Type": "application/json" } }
      );
    }

    const woCtx = wo as WOContext;

    // Load secrets from system_settings + secrets table
    const { data: settings } = await supabase
      .from("system_settings")
      .select("setting_key, setting_value")
      .in("setting_key", ["fly_api_token"]);

    const { data: secrets } = await supabase
      .from("secrets")
      .select("key, value")
      .in("key", ["ANTHROPIC_API_KEY", "GITHUB_TOKEN", "OPENROUTER_API_KEY"]);

    const flyToken = settings?.find((s: { setting_key: string }) => s.setting_key === "fly_api_token")
      ?.setting_value?.replace(/^"/, "").replace(/"$/, "");

    if (!flyToken) {
      return new Response(
        JSON.stringify({ error: "fly_api_token not configured in system_settings" }),
        { status: 500, headers: { "Content-Type": "application/json" } }
      );
    }

    const secretMap: Record<string, string> = {};
    for (const s of secrets || []) {
      secretMap[s.key] = typeof s.value === "string" ? s.value : JSON.stringify(s.value);
    }

    // Fall back to edge function env for keys not in secrets table
    if (!secretMap["ANTHROPIC_API_KEY"]) secretMap["ANTHROPIC_API_KEY"] = Deno.env.get("ANTHROPIC_API_KEY") || "";
    if (!secretMap["GITHUB_TOKEN"]) secretMap["GITHUB_TOKEN"] = Deno.env.get("GITHUB_TOKEN") || "";
    if (!secretMap["OPENROUTER_API_KEY"]) secretMap["OPENROUTER_API_KEY"] = Deno.env.get("OPENROUTER_API_KEY") || "";

    // Load agent model from agent_execution_profiles
    const { data: profile } = await supabase
      .from("agent_execution_profiles")
      .select("model")
      .eq("agent_name", "builder")
      .single();

    const agentModel = profile?.model || "minimax/minimax-m2.5";

    // Build env vars for the Machine
    const envVars: Record<string, string> = {
      // WO Context
      WO_ID: woCtx.id,
      WO_SLUG: woCtx.slug,
      WO_NAME: woCtx.name,
      WO_OBJECTIVE: woCtx.objective,
      WO_ACCEPTANCE_CRITERIA: woCtx.acceptance_criteria || "",
      WO_TAGS: JSON.stringify(woCtx.tags || []),
      WO_PRIORITY: woCtx.priority,
      // Execution mode
      SPRITE_MODE: "agent",
      AGENT_MODEL: agentModel,
      // Supabase access (for mutations, transitions, tool calls)
      SUPABASE_URL: supabaseUrl,
      SUPABASE_SERVICE_ROLE_KEY: supabaseKey,
      // GitHub access (for repo clone + push)
      GITHUB_TOKEN: secretMap["GITHUB_TOKEN"] || "",
      GITHUB_REPO: "olivergale/metis-portal2",
      // LLM access
      ANTHROPIC_API_KEY: secretMap["ANTHROPIC_API_KEY"] || "",
      OPENROUTER_API_KEY: secretMap["OPENROUTER_API_KEY"] || "",
    };

    // Create ephemeral Fly Machine
    const machineConfig = {
      region: REGION,
      config: {
        image: SPRITE_IMAGE,
        env: envVars,
        auto_destroy: true, // Self-destruct when agent loop exits
        guest: {
          cpu_kind: "shared",
          cpus: 1,
          memory_mb: 512,
        },
        restart: {
          policy: "no",
          max_retries: 0,
        },
        metadata: {
          wo_id: woCtx.id,
          wo_slug: woCtx.slug,
          managed_by: "sprite-dispatcher",
        },
      },
    };

    const createResp = await fetch(
      `${FLY_API_BASE}/apps/${FLY_APP}/machines`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${flyToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(machineConfig),
      }
    );

    if (!createResp.ok) {
      const errBody = await createResp.text();
      // Log failure
      await supabase.from("work_order_execution_log").insert({
        work_order_id: woCtx.id,
        agent_name: "sprite-dispatcher",
        phase: "failed",
        detail: { error: "Failed to create Fly Machine", status: createResp.status, body: errBody },
      });
      return new Response(
        JSON.stringify({ error: "Failed to create Fly Machine", detail: errBody }),
        { status: 502, headers: { "Content-Type": "application/json" } }
      );
    }

    const machine = await createResp.json();

    // Log successful dispatch
    await supabase.from("work_order_execution_log").insert({
      work_order_id: woCtx.id,
      agent_name: "sprite-dispatcher",
      phase: "execution_start",
      detail: {
        machine_id: machine.id,
        region: REGION,
        model: agentModel,
        image: SPRITE_IMAGE,
      },
    });

    // Record in audit log
    await supabase.from("audit_log").insert({
      event_type: "sprite_dispatched",
      target_type: "work_order",
      target_id: woCtx.id,
      payload: {
        machine_id: machine.id,
        wo_slug: woCtx.slug,
        model: agentModel,
      },
    });

    return new Response(
      JSON.stringify({
        ok: true,
        machine_id: machine.id,
        machine_state: machine.state,
        wo_slug: woCtx.slug,
        model: agentModel,
      }),
      { headers: { "Content-Type": "application/json" } }
    );
  } catch (err) {
    return new Response(
      JSON.stringify({ error: "Internal error", detail: String(err) }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
});
