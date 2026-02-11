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
        error_spikes: [],
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

          // Check retry count in client_info
          const clientInfo = wo.client_info || {};
          const retryCount = clientInfo.ops_retry_count || 0;
          const maxRetries = 3;

          if (retryCount < maxRetries) {
            // Attempt to re-dispatch to wo-agent
            try {
              const WO_AGENT_URL = Deno.env.get("WO_AGENT_URL") || 
                "https://phfblljwuvzqzlbzkzpr.supabase.co/functions/v1/wo-agent";
              
              const dispatchResponse = await fetch(`${WO_AGENT_URL}/dispatch`, {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                  "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
                },
                body: JSON.stringify({
                  work_order_id: wo.id,
                  retry_attempt: retryCount + 1,
                }),
              });

              // If 503 (service unavailable), increment retry and continue
              if (dispatchResponse.status === 503) {
                const newRetryCount = retryCount + 1;
                await supabase
                  .from("work_orders")
                  .update({
                    client_info: {
                      ...clientInfo,
                      ops_retry_count: newRetryCount,
                      last_retry_at: new Date().toISOString(),
                      last_retry_status: 503,
                    },
                  })
                  .eq("id", wo.id);

                await supabase.from("work_order_execution_log").insert({
                  work_order_id: wo.id,
                  phase: "stream",
                  agent_name: "ops",
                  detail: {
                    event_type: "retry_scheduled",
                    reason: "wo_agent_unavailable",
                    retry_count: newRetryCount,
                    max_retries: maxRetries,
                    status_code: 503,
                    minutes_idle: Math.round(minutesIdle * 10) / 10,
                  },
                });

                response.errors.push(
                  `${wo.slug}: wo-agent unavailable (503), retry ${newRetryCount}/${maxRetries} scheduled`
                );
                continue; // Skip marking as failed
              }

              // If dispatch succeeded (2xx), reset retry count
              if (dispatchResponse.ok) {
                await supabase
                  .from("work_orders")
                  .update({
                    client_info: {
                      ...clientInfo,
                      ops_retry_count: 0,
                      last_redispatch_at: new Date().toISOString(),
                    },
                  })
                  .eq("id", wo.id);

                await supabase.from("work_order_execution_log").insert({
                  work_order_id: wo.id,
                  phase: "stream",
                  agent_name: "ops",
                  detail: {
                    event_type: "redispatched",
                    reason: "stuck_detection",
                    minutes_idle: Math.round(minutesIdle * 10) / 10,
                  },
                });

                continue; // Successfully redispatched, don't mark as failed
              }
            } catch (dispatchError) {
              // Network error or wo-agent completely down - treat as 503
              const newRetryCount = retryCount + 1;
              await supabase
                .from("work_orders")
                .update({
                  client_info: {
                    ...clientInfo,
                    ops_retry_count: newRetryCount,
                    last_retry_at: new Date().toISOString(),
                    last_retry_error: dispatchError instanceof Error ? dispatchError.message : String(dispatchError),
                  },
                })
                .eq("id", wo.id);

              await supabase.from("work_order_execution_log").insert({
                work_order_id: wo.id,
                phase: "stream",
                agent_name: "ops",
                detail: {
                  event_type: "retry_scheduled",
                  reason: "dispatch_error",
                  retry_count: newRetryCount,
                  max_retries: maxRetries,
                  error: dispatchError instanceof Error ? dispatchError.message : String(dispatchError),
                },
              });

              response.errors.push(
                `${wo.slug}: dispatch failed, retry ${newRetryCount}/${maxRetries} scheduled`
              );
              continue; // Skip marking as failed
            }
          }

          // Max retries exhausted or other failure - analyze and diagnose
          
          // Feature 3: Agent-task mismatch detection
          let agentMismatch = null;
          if (wo.assigned_to?.name && wo.assigned_to?.tools_allowed) {
            const tags = wo.tags || [];
            const toolsAllowed = wo.assigned_to.tools_allowed || [];
            
            // Check for common mismatches
            if (tags.includes('local-filesystem') && !toolsAllowed.includes('read_file')) {
              agentMismatch = {
                reason: 'Local filesystem WO assigned to server-side agent',
                assigned_agent: wo.assigned_to.name,
                required_tools: ['read_file', 'write_file'],
                available_tools: toolsAllowed,
                recommendation: 'Re-route to ilmarinen (local_cli agent)'
              };
            } else if (tags.includes('portal-frontend') && !toolsAllowed.includes('github_read_file')) {
              agentMismatch = {
                reason: 'Frontend WO assigned to agent without GitHub access',
                assigned_agent: wo.assigned_to.name,
                required_tools: ['github_read_file', 'github_write_file'],
                available_tools: toolsAllowed,
                recommendation: 'Re-route to agent with github tools'
              };
            }
          }
          
          // Feature 2: Mutation vs read ratio analysis
          const { data: execLogFull, error: fullLogError } = await supabase
            .from('work_order_execution_log')
            .select('detail')
            .eq('work_order_id', wo.id)
            .eq('phase', 'stream');
          
          let ratioAnalysis = null;
          if (!fullLogError && execLogFull && execLogFull.length > 0) {
            let readCount = 0;
            let writeCount = 0;
            
            for (const log of execLogFull) {
              const detail = log.detail || {};
              if (detail.tool_name === 'mcp__supabase__execute_sql' || detail.tool_name === 'execute_sql') {
                const query = detail.result?.query || detail.input?.query || '';
                if (query.trim().toUpperCase().startsWith('SELECT')) {
                  readCount++;
                } else if (query.trim().match(/^(INSERT|UPDATE|DELETE|CREATE|ALTER|DROP)/i)) {
                  writeCount++;
                }
              }
            }
            
            if (readCount > 0 || writeCount > 0) {
              const ratio = writeCount > 0 ? readCount / writeCount : readCount;
              ratioAnalysis = {
                read_count: readCount,
                write_count: writeCount,
                ratio: Math.round(ratio * 10) / 10,
                exploration_spiral: ratio > 5 && readCount > 10,
                diagnosis: ratio > 5 && readCount > 10 
                  ? 'High read:write ratio suggests exploration spiral - agent may be stuck in analysis loop'
                  : ratio > 3 
                    ? 'Moderate read:write ratio - agent may need more focused objective'
                    : 'Normal read:write ratio'
              };
            }
          }
          
          // Detect failure archetype
          let failureArchetype = 'stuck_wo'; // default
          if (agentMismatch) {
            failureArchetype = 'agent_mismatch';
          } else if (ratioAnalysis?.exploration_spiral) {
            failureArchetype = 'exploration_spiral';
          }
          
          // Circuit breaker: Check if we've already tried to mark this WO as failed
          const failureAttemptKey = `ops_failure_attempt_${wo.id}`;
          const existingFailureAttempts = clientInfo[failureAttemptKey] || 0;
          const maxFailureAttempts = 3;

          if (existingFailureAttempts >= maxFailureAttempts) {
            // Already tried to fail this WO 3 times - log permanent alert and skip
            await supabase.from("work_order_execution_log").insert({
              work_order_id: wo.id,
              phase: "stream",
              agent_name: "ops",
              detail: {
                event_type: "circuit_breaker_tripped",
                reason: "max_failure_attempts_reached",
                failure_attempts: existingFailureAttempts,
                max_attempts: maxFailureAttempts,
                minutes_idle: Math.round(minutesIdle * 10) / 10,
                message: `Circuit breaker: stopped attempting to mark ${wo.slug} as failed after ${existingFailureAttempts} attempts. Manual intervention required.`,
              },
            });
            
            response.errors.push(
              `${wo.slug}: Circuit breaker tripped (${existingFailureAttempts} failure attempts). Manual intervention required.`
            );
            continue; // Skip this WO
          }

          // Attempt to transition to failed status
          const { error: failError } = await supabase.rpc(
            "update_work_order_state",
            {
              p_work_order_id: wo.id,
              p_status: "failed",
              p_summary: retryCount >= maxRetries
                ? `Auto-failed by ops health-check: No activity for ${Math.round(minutesIdle)} minutes. Max retries (${maxRetries}) exhausted. Failure archetype: ${failureArchetype}`
                : `Auto-failed by ops health-check: No activity for ${Math.round(minutesIdle)} minutes. Failure archetype: ${failureArchetype}`,
            }
          );

          // Log RPC result (success or failure)
          if (failError) {
            // RPC failed - increment failure attempt counter
            const newFailureAttempts = existingFailureAttempts + 1;
            await supabase
              .from("work_orders")
              .update({
                client_info: {
                  ...clientInfo,
                  [failureAttemptKey]: newFailureAttempts,
                  last_failure_attempt_at: new Date().toISOString(),
                },
              })
              .eq("id", wo.id);

            await supabase.from("work_order_execution_log").insert({
              work_order_id: wo.id,
              phase: "stream",
              agent_name: "ops",
              detail: {
                event_type: "transition_failed",
                action: "marked_failed",
                target_status: "failed",
                error: failError.message,
                error_code: failError.code,
                failure_attempt: newFailureAttempts,
                max_attempts: maxFailureAttempts,
                minutes_idle: Math.round(minutesIdle * 10) / 10,
              },
            });

            response.errors.push(
              `Error transitioning ${wo.slug} to failed (attempt ${newFailureAttempts}/${maxFailureAttempts}): ${failError.message}`
            );
          } else {
            // RPC succeeded - reset failure counter and log success
            await supabase
              .from("work_orders")
              .update({
                client_info: {
                  ...clientInfo,
                  [failureAttemptKey]: 0, // Reset on success
                  last_failure_transition_at: new Date().toISOString(),
                },
              })
              .eq("id", wo.id);

            response.marked_failed.push(wo.slug);

            // Log the successful transition with enhanced diagnostics
            await supabase.from("work_order_execution_log").insert({
              work_order_id: wo.id,
              phase: "failed",
              agent_name: "ops",
              detail: {
                event_type: "health_check_failure",
                action: "marked_failed",
                target_status: "failed",
                transition_success: true,
                reason: "stuck_detection",
                minutes_idle: Math.round(minutesIdle * 10) / 10,
                last_activity: lastActivity.toISOString(),
                retry_count: retryCount,
                retries_exhausted: retryCount >= maxRetries,
                failure_archetype: failureArchetype,
                agent_mismatch: agentMismatch,
                ratio_analysis: ratioAnalysis,
                diagnostics: {
                  agent_mismatch: agentMismatch ? 'Agent lacks required tools for task domain' : null,
                  exploration_spiral: ratioAnalysis?.exploration_spiral ? 'High read:write ratio detected' : null,
                  recommendation: agentMismatch ? agentMismatch.recommendation : 
                    ratioAnalysis?.exploration_spiral ? 'Decompose WO into focused sub-tasks' : null
                }
              },
            });
            
            // Feature 1: Create remediation WO for specific failure types
            const shouldCreateRemediation = failureArchetype === 'exploration_spiral' || 
              failureArchetype === 'agent_mismatch';
            
            if (shouldCreateRemediation && retryCount >= maxRetries) {
              try {
                // Get parent WO details for remediation context
                const { data: parentWO } = await supabase
                  .from('work_orders')
                  .select('slug, name, objective')
                  .eq('id', wo.id)
                  .single();
                
                if (parentWO) {
                  const remediationName = `Fix: ${parentWO.slug} - ${failureArchetype}`;
                  const remediationObjective = failureArchetype === 'agent_mismatch'
                    ? `Remediate agent-task mismatch for ${parentWO.slug}:\n\nIssue: ${agentMismatch?.reason}\nAssigned: ${agentMismatch?.assigned_agent}\nRequired tools: ${agentMismatch?.required_tools?.join(', ')}\n\nAction: ${agentMismatch?.recommendation}\n\nParent objective: ${parentWO.objective}`
                    : `Remediate exploration spiral for ${parentWO.slug}:\n\nIssue: High read:write ratio (${ratioAnalysis?.ratio}:1) with ${ratioAnalysis?.read_count} reads, ${ratioAnalysis?.write_count} writes\n\nAction: Decompose into focused sub-tasks with clear acceptance criteria\n\nParent objective: ${parentWO.objective}`;
                  
                  const { data: remediationWO, error: remError } = await supabase.rpc(
                    'create_draft_work_order',
                    {
                      p_slug: null, // auto-generate
                      p_name: remediationName,
                      p_objective: remediationObjective,
                      p_priority: 'p1_high',
                      p_source: 'auto-qa',
                      p_tags: ['remediation', `parent:${parentWO.slug}`, 'ops-diagnostic'],
                      p_acceptance_criteria: failureArchetype === 'agent_mismatch'
                        ? `1. Re-assign ${parentWO.slug} to appropriate agent with required tools\n2. Verify agent has tools: ${agentMismatch?.required_tools?.join(', ')}\n3. Re-dispatch work order`
                        : `1. Review ${parentWO.slug} execution log and identify root cause\n2. Decompose into 2-3 focused sub-WOs with clear ACs\n3. Create child WOs via create_draft_work_order\n4. Cancel parent WO with cancellation_reason`,
                      p_parent_id: wo.id
                    }
                  );
                  
                  if (remError) {
                    response.errors.push(`Failed to create remediation WO: ${remError.message}`);
                  } else if (remediationWO) {
                    console.log(`[OPS] Created remediation WO ${remediationWO.slug} for ${parentWO.slug} (${failureArchetype})`);
                    
                    await supabase.from('work_order_execution_log').insert({
                      work_order_id: wo.id,
                      phase: 'stream',
                      agent_name: 'ops',
                      detail: {
                        event_type: 'remediation_created',
                        remediation_slug: remediationWO.slug,
                        remediation_id: remediationWO.id,
                        failure_archetype: failureArchetype,
                        diagnostic_context: {
                          agent_mismatch: agentMismatch,
                          ratio_analysis: ratioAnalysis
                        }
                      }
                    });
                  }
                }
              } catch (remediationError) {
                console.error('[OPS] Remediation WO creation failed:', remediationError);
                response.errors.push(`Remediation creation error: ${remediationError instanceof Error ? remediationError.message : String(remediationError)}`);
              }
            }
          }
        }
      }

      // WO-0266: Check for error spikes (>5 same error in last 10 minutes)
      const tenMinutesAgo = new Date(now.getTime() - 10 * 60 * 1000);
      const { data: errorSpikes, error: spikeError } = await supabase
        .rpc("get_error_spikes", {
          p_time_window_minutes: 10,
          p_threshold: 5
        });

      if (spikeError) {
        response.errors.push(`Error checking error spikes: ${spikeError.message}`);
      } else if (errorSpikes && errorSpikes.length > 0) {
        response.error_spikes = errorSpikes.map((spike: any) => ({
          error_code: spike.error_code,
          source_function: spike.source_function,
          count: spike.error_count,
          severity: spike.severity,
          sample_message: spike.sample_message
        }));
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
