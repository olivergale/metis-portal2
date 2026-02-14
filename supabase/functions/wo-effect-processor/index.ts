// wo-effect-processor/index.ts
// WO-0619: Effect processor scaffold with claim_pending_events RPC integration
//
// Polls wo_events table, claims a batch atomically, processes each event.
// Dispatch handlers: dispatch_execution, run_qa. Remaining handlers added in WO-0617.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const WO_AGENT_URL = `${SUPABASE_URL}/functions/v1/wo-agent`;
const QA_REVIEW_URL = `${SUPABASE_URL}/functions/v1/qa-review`;

const MAX_RETRIES = 3;
const MAX_DEPTH = 5;

interface WoEvent {
  id: string;
  work_order_id: string | null;
  event_type: string;
  previous_status: string | null;
  new_status: string | null;
  payload: Record<string, unknown> | null;
  actor: string;
  depth: number | null;
  status: string | null;
  retry_count: number | null;
  created_at: string;
  processed_at: string | null;
}

async function claimEvents(supabase: any, batchSize: number): Promise<WoEvent[]> {
  const { data, error } = await supabase.rpc('claim_pending_events', {
    p_batch_size: batchSize,
  });

  if (error) {
    console.error('[CLAIM] RPC error:', error);
    throw error;
  }

  console.log(`[CLAIM] Claimed ${data?.length || 0} events`);
  return data || [];
}

async function markEventDone(supabase: any, eventId: string): Promise<void> {
  const { error } = await supabase
    .from('wo_events')
    .update({ status: 'done', processed_at: new Date().toISOString() })
    .eq('id', eventId);

  if (error) {
    console.error(`[MARK_DONE] Failed for ${eventId}:`, error);
  }
}

async function markEventFailed(
  supabase: any,
  eventId: string,
  errorDetail: string,
  retryCount: number
): Promise<void> {
  if (retryCount < MAX_RETRIES) {
    // Retry: reset to pending and increment retry_count
    const { error } = await supabase
      .from('wo_events')
      .update({
        status: 'pending',
        retry_count: retryCount + 1,
        error_detail: errorDetail,
      })
      .eq('id', eventId);

    if (error) {
      console.error(`[MARK_RETRY] Failed for ${eventId}:`, error);
    } else {
      console.log(`[MARK_RETRY] Event ${eventId} queued for retry (attempt ${retryCount + 1})`);
    }
  } else {
    // Max retries exceeded: mark as failed
    const { error } = await supabase
      .from('wo_events')
      .update({
        status: 'failed',
        error_detail: errorDetail,
        processed_at: new Date().toISOString(),
      })
      .eq('id', eventId);

    if (error) {
      console.error(`[MARK_FAILED] Failed for ${eventId}:`, error);
    } else {
      console.log(`[MARK_FAILED] Event ${eventId} marked as failed: ${errorDetail}`);
    }
  }
}

async function dispatchExecution(supabase: any, event: WoEvent): Promise<void> {
  if (!event.work_order_id) {
    throw new Error('dispatch_execution requires work_order_id in event');
  }

  console.log(`[DISPATCH] Executing work order: ${event.work_order_id}`);

  const resp = await fetch(WO_AGENT_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${SERVICE_KEY}`,
    },
    body: JSON.stringify({
      work_order_id: event.work_order_id,
    }),
  });

  if (!resp.ok) {
    const errorText = await resp.text();
    throw new Error(`dispatch_execution failed: ${errorText.slice(0, 200)}`);
  }

  const result = await resp.json();
  console.log(`[DISPATCH] Result:`, result);
}

async function runQaReview(supabase: any, event: WoEvent): Promise<void> {
  if (!event.work_order_id) {
    throw new Error('run_qa requires work_order_id in event');
  }

  console.log(`[QA] Running QA review for work order: ${event.work_order_id}`);

  const resp = await fetch(QA_REVIEW_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${SERVICE_KEY}`,
    },
    body: JSON.stringify({
      work_order_id: event.work_order_id,
    }),
  });

  if (!resp.ok) {
    const errorText = await resp.text();
    throw new Error(`run_qa failed: ${errorText.slice(0, 200)}`);
  }

  const result = await resp.json();
  console.log(`[QA] Result:`, result);
}

async function handleUnknownEffectType(supabase: any, event: WoEvent): Promise<void> {
  console.warn(`[UNKNOWN] Unknown effect_type: ${event.event_type}`);
  throw new Error(`unknown_effect_type: ${event.event_type}`);
}

async function processEvent(supabase: any, event: WoEvent): Promise<void> {
  console.log(`[PROCESS] Event ${event.id}: type=${event.event_type}, depth=${event.depth}, retry=${event.retry_count}`);

  // Check cascade depth
  const depth = event.depth || 0;
  if (depth > MAX_DEPTH) {
    console.error(`[CASCADE] Depth exceeded: ${depth} > ${MAX_DEPTH}`);
    await markEventFailed(supabase, event.id, 'cascade_depth_exceeded', event.retry_count || 0);
    return;
  }

  try {
    switch (event.event_type) {
      case 'dispatch_execution':
        await dispatchExecution(supabase, event);
        break;

      case 'run_qa':
        await runQaReview(supabase, event);
        break;

      default:
        await handleUnknownEffectType(supabase, event);
        break;
    }

    // Success: mark as done
    await markEventDone(supabase, event.id);
    console.log(`[PROCESS] Event ${event.id} completed successfully`);

  } catch (error) {
    const errorMessage = (error as Error).message;
    console.error(`[PROCESS] Event ${event.id} failed:`, errorMessage);
    await markEventFailed(supabase, event.id, errorMessage, event.retry_count || 0);
  }
}

async function pollAndProcess(supabase: any, batchSize: number = 10): Promise<number> {
  const events = await claimEvents(supabase, batchSize);

  if (events.length === 0) {
    console.log('[POLL] No pending events');
    return 0;
  }

  console.log(`[POLL] Processing ${events.length} events...`);

  for (const event of events) {
    await processEvent(supabase, event);
  }

  return events.length;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const supabase = createClient(SUPABASE_URL, SERVICE_KEY);

  const url = new URL(req.url);
  const action = url.pathname.split('/').pop();

  try {
    // POST /process — Poll and process a batch of events
    if (req.method === "POST" && action === "process") {
      const { batch_size } = await req.json().catch(() => ({}));
      const batchSize = batch_size || 10;

      console.log(`[HTTP] Processing batch (size: ${batchSize})`);
      const processed = await pollAndProcess(supabase, batchSize);

      return new Response(
        JSON.stringify({
          processed,
          timestamp: new Date().toISOString(),
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // GET /status — Get processor status
    if (req.method === "GET" && action === "status") {
      // Get pending count
      const { count: pendingCount } = await supabase
        .from('wo_events')
        .select('*', { count: 'exact', head: true })
        .eq('status', 'pending');

      // Get processing count
      const { count: processingCount } = await supabase
        .from('wo_events')
        .select('*', { count: 'exact', head: true })
        .eq('status', 'processing');

      // Get failed count
      const { count: failedCount } = await supabase
        .from('wo_events')
        .select('*', { count: 'exact', head: true })
        .eq('status', 'failed');

      return new Response(
        JSON.stringify({
          function: 'wo-effect-processor',
          version: 'scaffold-v1',
          handlers: ['dispatch_execution', 'run_qa'],
          limits: {
            max_retries: MAX_RETRIES,
            max_depth: MAX_DEPTH,
          },
          event_counts: {
            pending: pendingCount || 0,
            processing: processingCount || 0,
            failed: failedCount || 0,
          },
          endpoints: {
            process: 'POST /process — Poll and process events',
            status: 'GET /status — Get processor status',
          },
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    return new Response(
      JSON.stringify({
        error: "Unknown action",
        available: ["POST /process", "GET /status"],
      }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );

  } catch (error) {
    console.error('[ERROR]', error);
    return new Response(
      JSON.stringify({ error: (error as Error).message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
