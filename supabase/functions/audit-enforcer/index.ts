import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from 'jsr:@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

interface EnforcerCheck {
  check_name: string;
  passed: boolean;
  evidence: any;
  severity?: 'critical' | 'high' | 'medium' | 'low' | 'info';
  description?: string;
}

Deno.serve(async (req: Request) => {
  try {
    const { method } = req;

    if (method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        },
      });
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    const { trigger_event, trigger_wo_id, run_type = 'manual' } = await req.json();

    // Create enforcer run
    const { data: runData, error: runError } = await supabase
      .from('enforcer_runs')
      .insert({
        run_type,
        trigger_event: trigger_event || 'manual_invoke',
        trigger_wo_id,
        trigger_type: run_type,
        status: 'running',
        metadata: { checks: [] },
      })
      .select()
      .single();

    if (runError) {
      console.error('Failed to create enforcer run:', runError);
      return new Response(JSON.stringify({ error: 'Failed to create enforcer run', details: runError }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const runId = runData.id;
    const checks: EnforcerCheck[] = [];

    // ═══════════════════════════════════════════════════
    // CHECK 1: Canary Test - Verify enforcement triggers work
    // ═══════════════════════════════════════════════════
    try {
      const canaryValue = `INVALID_CANARY_${Date.now()}`;
      const { error: canaryError } = await supabase
        .from('enforcer_canary_test')
        .insert({ test_value: canaryValue, is_canary: true });

      if (canaryError) {
        checks.push({
          check_name: 'canary_check',
          passed: true,
          evidence: { constraint_triggered: true, error: canaryError.message },
          severity: 'info',
          description: 'Canary check constraint correctly rejected invalid entry',
        });
      } else {
        checks.push({
          check_name: 'canary_check',
          passed: false,
          evidence: { constraint_triggered: false, inserted_value: canaryValue },
          severity: 'critical',
          description: 'CRITICAL: Canary constraint failed to trigger - enforcement system may be compromised',
        });

        await supabase.from('enforcer_findings').insert({
          enforcer_run_id: runId,
          finding_type: 'canary_failure',
          severity: 'critical',
          description: 'Known-invalid canary entry was not rejected by database constraint',
          evidence: { canary_value: canaryValue },
        });
      }
    } catch (e) {
      checks.push({
        check_name: 'canary_check',
        passed: false,
        evidence: { error: String(e) },
        severity: 'high',
        description: 'Canary check failed to execute',
      });
    }

    // ═══════════════════════════════════════════════════
    // CHECK 2: Schema Integrity - Verify critical tables exist
    // ═══════════════════════════════════════════════════
    try {
      const { data: woData, error: woError } = await supabase
        .from('work_orders')
        .select('id, slug, status, enforcer_verified')
        .limit(1);

      if (woError) {
        checks.push({
          check_name: 'schema_integrity_work_orders',
          passed: false,
          evidence: { error: woError.message },
          severity: 'critical',
          description: 'work_orders table access failed',
        });

        await supabase.from('enforcer_findings').insert({
          enforcer_run_id: runId,
          finding_type: 'schema_drift',
          severity: 'critical',
          description: 'work_orders table could not be accessed',
          evidence: { table: 'work_orders', error: woError.message },
        });
      } else {
        checks.push({
          check_name: 'schema_integrity_work_orders',
          passed: true,
          evidence: { table: 'work_orders', accessible: true },
          severity: 'info',
          description: 'work_orders schema validated',
        });
      }
    } catch (e) {
      checks.push({
        check_name: 'schema_integrity_work_orders',
        passed: false,
        evidence: { error: String(e) },
        severity: 'high',
        description: 'Schema integrity check failed',
      });
    }

    // ═══════════════════════════════════════════════════
    // CHECK 3: Work Order Verification (if trigger_wo_id provided)
    // ═══════════════════════════════════════════════════
    if (trigger_wo_id) {
      try {
        const { data: woData, error: woError } = await supabase
          .from('work_orders')
          .select('id, slug, status, enforcer_verified, qa_checklist')
          .eq('id', trigger_wo_id)
          .single();

        if (woError || !woData) {
          checks.push({
            check_name: 'work_order_verification',
            passed: false,
            evidence: { error: woError?.message || 'WO not found' },
            severity: 'high',
            description: `Work order ${trigger_wo_id} verification failed`,
          });

          await supabase.from('enforcer_findings').insert({
            enforcer_run_id: runId,
            work_order_id: trigger_wo_id,
            finding_type: 'state_violation',
            severity: 'high',
            description: `Cannot verify work order ${trigger_wo_id}`,
            evidence: { error: woError?.message },
          });
        } else {
          if (woData.status === 'review') {
            const qaComplete = woData.qa_checklist &&
              Array.isArray(woData.qa_checklist) &&
              woData.qa_checklist.length > 0 &&
              woData.qa_checklist.every((item: any) => item.status === 'verified' || item.status === 'pass');

            if (qaComplete) {
              await supabase
                .from('work_orders')
                .update({
                  enforcer_verified: true,
                  enforcer_verified_at: new Date().toISOString(),
                  enforcer_run_id: runId,
                  enforcer_last_check_at: new Date().toISOString(),
                })
                .eq('id', trigger_wo_id);

              await supabase.from('enforcer_findings').insert({
                enforcer_run_id: runId,
                work_order_id: trigger_wo_id,
                finding_type: 'verification_passed',
                severity: 'info',
                description: `Work order ${woData.slug} verified - all acceptance criteria verified, system integrity checks passed`,
                evidence: { wo_slug: woData.slug, status: woData.status },
              });

              checks.push({
                check_name: 'work_order_verification',
                passed: true,
                evidence: { wo_slug: woData.slug, status: woData.status, verified: true },
                severity: 'info',
                description: `Work order ${woData.slug} passed verification`,
              });
            } else {
              checks.push({
                check_name: 'work_order_verification',
                passed: false,
                evidence: { wo_slug: woData.slug, qa_complete: qaComplete },
                severity: 'medium',
                description: `Work order ${woData.slug} not ready for verification - QA incomplete`,
              });

              await supabase.from('enforcer_findings').insert({
                enforcer_run_id: runId,
                work_order_id: trigger_wo_id,
                finding_type: 'state_violation',
                severity: 'medium',
                description: `Work order ${woData.slug} in review but QA checklist not fully verified`,
                evidence: { wo_slug: woData.slug, qa_checklist: woData.qa_checklist },
              });
            }
          } else {
            checks.push({
              check_name: 'work_order_verification',
              passed: true,
              evidence: { wo_slug: woData.slug, status: woData.status },
              severity: 'info',
              description: `Work order ${woData.slug} status: ${woData.status} (not in review)`,
            });
          }
        }
      } catch (e) {
        checks.push({
          check_name: 'work_order_verification',
          passed: false,
          evidence: { error: String(e) },
          severity: 'high',
          description: 'Work order verification check failed',
        });
      }
    }

    // ═══════════════════════════════════════════════════
    // Complete the enforcer run
    // ═══════════════════════════════════════════════════
    const allChecksPassed = checks.every(c => c.passed);
    const criticalFailures = checks.filter(c => !c.passed && c.severity === 'critical');

    const summary = {
      total_checks: checks.length,
      passed: checks.filter(c => c.passed).length,
      failed: checks.filter(c => !c.passed).length,
      critical_failures: criticalFailures.length,
      all_passed: allChecksPassed,
    };

    await supabase
      .from('enforcer_runs')
      .update({
        status: 'completed',
        completed_at: new Date().toISOString(),
        metadata: { checks },
        summary,
        findings_count: summary.failed,
        critical_findings_count: criticalFailures.length,
      })
      .eq('id', runId);

    return new Response(
      JSON.stringify({
        success: true,
        run_id: runId,
        summary,
        checks,
        message: allChecksPassed
          ? 'All enforcement checks passed'
          : `${summary.failed} checks failed (${criticalFailures.length} critical)`,
      }),
      {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          'X-Enforcer-Run-Id': runId,
          'X-Enforcer-Version': '1.3.0',
        },
      }
    );
  } catch (error) {
    console.error('Audit enforcer error:', error);
    return new Response(
      JSON.stringify({ error: 'Internal enforcer error', details: String(error) }),
      {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }
});
