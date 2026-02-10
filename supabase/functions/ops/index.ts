import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

interface HealthCheckResponse {
  checked_at: string;
  stuck_wos: Array<{
    slug: string;
    id: string;
    status: string;
    last_activity: string;
    minutes_idle: number;
  }>;
  continuation_wos_skipped: Array<{
    slug: string;
    id: string;
    last_checkpoint: string;
    minutes_since_checkpoint: number;
  }>;
  marked_failed: string[];
  error_spikes: Array<{
    error_code: string;
    source_function: string;
    count: number;
    severity: string;
    sample_message: string;
  }>;
  errors: string[];
}

serve(async (req: Request) => {
  const url = new URL(req.url);
  const pathname = url.pathname;

  // Health check endpoint
  if (pathname === "/health-check" && req.method === "POST") {
    try {
      const response: HealthCheckResponse = {
        checked_at: new Date().toISOString(),
        stuck_wos: [],
        continuation_wos_skipped: [],
        marked_failed: [],
        errors: [],
      };

      // Find WOs in in_progress status that might be stuck
      // Join with agents to check execution_mode (skip local_cli agents like ilmarinen)
      const { data: activeWOs, error: woError } = await supabase
        .from("work_orders")
        .select(`
          id, 
          slug, 
          status, 
          updated_at,
          client_info,
          assigned_to(
            name,
            execution_mode
          )
        `)
        .eq("status", "in_progress")
        .order("updated_at", { ascending: true });

      if (woError) {
        response.errors.push(`Error fetching WOs: ${woError.message}`);
        return new Response(JSON.stringify(response), {
          status: 500,
          headers: { "Content-Type": "application/json" },
        });
      }

      if (!activeWOs || activeWOs.length === 0) {
        return new Response(JSON.stringify(response), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      const now = new Date();

      // Check each WO for activity
      for (const wo of activeWOs) {
        // Skip local_cli agents (like ilmarinen) - they execute locally with no server heartbeat
        if (wo.assigned_to?.execution_mode === "local_cli") {
          continue;
        }

        // Get last activity from execution log
        const { data: lastLog, error: logError } = await supabase
          .from("work_order_execution_log")
          .select("phase, created_at")
          .eq("work_order_id", wo.id)
          .order("created_at", { ascending: false })
          .limit(1)
          .single();

        if (logError && logError.code !== "PGRST116") {
          // PGRST116 = no rows
          response.errors.push(
            `Error fetching log for ${wo.slug}: ${logError.message}`
          );
          continue;
        }

        const lastActivity = lastLog?.created_at
          ? new Date(lastLog.created_at)
          : new Date(wo.updated_at);
        const minutesIdle = (now.getTime() - lastActivity.getTime()) / 60000;

        // If idle > 10 minutes, check for continuation pattern
        if (minutesIdle > 10) {
          // Check for checkpoint or continuation phases in last 15 minutes
          const fifteenMinutesAgo = new Date(now.getTime() - 15 * 60 * 1000);
          const { data: recentCheckpoints, error: checkpointError } =
            await supabase
              .from("work_order_execution_log")
              .select("phase, created_at")
              .eq("work_order_id", wo.id)
              .in("phase", ["checkpoint", "continuation"])
              .gte("created_at", fifteenMinutesAgo.toISOString())
              .order("created_at", { ascending: false })
              .limit(1);

          if (checkpointError) {
            response.errors.push(
              `Error checking checkpoints for ${wo.slug}: ${checkpointError.message}`
            );
            continue;
          }

          // If there's a recent checkpoint/continuation, skip this WO
          if (recentCheckpoints && recentCheckpoints.length > 0) {
            const lastCheckpoint = new Date(recentCheckpoints[0].created_at);
            const minutesSinceCheckpoint =
              (now.getTime() - lastCheckpoint.getTime()) / 60000;

            response.continuation_wos_skipped.push({
              slug: wo.slug,
              id: wo.id,
              last_checkpoint: recentCheckpoints[0].created_at,
              minutes_since_checkpoint: Math.round(minutesSinceCheckpoint * 10) / 10,
            });
            continue;
          }

          // No recent checkpoint - this WO is truly stuck
          response.stuck_wos.push({
            slug: wo.slug,
            id: wo.id,
            status: wo.status,
            last_activity: lastActivity.toISOString(),
            minutes_idle: Math.round(minutesIdle * 10) / 10,
          });

          // Mark as failed
          const { error: failError } = await supabase.rpc(
            "update_work_order_state",
            {
              p_work_order_id: wo.id,
              p_status: "failed",
              p_summary: `Auto-failed by ops health-check: No activity for ${Math.round(minutesIdle)} minutes`,
            }
          );

          if (failError) {
            response.errors.push(
              `Error marking ${wo.slug} as failed: ${failError.message}`
            );
          } else {
            response.marked_failed.push(wo.slug);

            // Log the failure
            await supabase.from("work_order_execution_log").insert({
              work_order_id: wo.id,
              phase: "failed",
              agent_name: "ops",
              detail: {
                event_type: "health_check_failure",
                reason: "stuck_detection",
                minutes_idle: Math.round(minutesIdle * 10) / 10,
                last_activity: lastActivity.toISOString(),
              },
            });
          }
        }
      }

      return new Response(JSON.stringify(response), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    } catch (error) {
      return new Response(
        JSON.stringify({
          error: "Internal server error",
          message: error instanceof Error ? error.message : String(error),
        }),
        {
          status: 500,
          headers: { "Content-Type": "application/json" },
        }
      );
    }
  }

  // Root endpoint - return function info
  if (pathname === "/" && req.method === "GET") {
    return new Response(
      JSON.stringify({
        function: "ops",
        version: 1,
        description:
          "Operations agent for health monitoring and stuck detection",
        endpoints: ["/health-check"],
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }
    );
  }

  return new Response(JSON.stringify({ error: "Not found" }), {
    status: 404,
    headers: { "Content-Type": "application/json" },
  });
});
