/**
 * WO Effect Processor Edge Function
 * 
 * Polls wo_events table for pending events, claims a batch atomically,
 * and processes each event by dispatching to the appropriate handler.
 * 
 * Event types handled:
 * - dispatch_execution: POST to wo-agent to start work order execution
 * - run_qa: POST to qa-review to run QA evaluation
 * 
 * This is a scaffold - additional handlers will be added in subsequent WOs.
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const supabase = createClient(supabaseUrl, supabaseServiceKey);

// Handler interfaces
interface EventHandler {
  (event: WoEvent): Promise<void>;
}

interface WoEvent {
  id: string;
  work_order_id: string;
  event_type: string;
  actor: string;
  depth: number;
  payload: Record<string, unknown>;
  previous_status?: string;
  new_status?: string;
  retry_count: number;
}

/**
 * Default handler for unknown effect types
 */
async function unknownEffectHandler(event: WoEvent): Promise<void> {
  console.log(`Unknown effect type: ${event.event_type}, marking event failed`);
  
  await supabase
    .from('wo_events')
    .update({
      status: 'failed',
      error_detail: `unknown_effect_type: ${event.event_type}`,
      processed_at: new Date().toISOString()
    })
    .eq('id', event.id);
}

/**
 * dispatch_execution handler
 * POST to wo-agent to start work order execution
 */
async function dispatchExecutionHandler(event: WoEvent): Promise<void> {
  console.log(`dispatch_execution: Dispatching work order ${event.work_order_id}`);
  
  const response = await fetch(
    `${supabaseUrl}/functions/v1/wo-agent`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${supabaseServiceKey}`
      },
      body: JSON.stringify({
        work_order_id: event.work_order_id
      })
    }
  );
  
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`wo-agent dispatch failed: ${response.status} - ${errorText}`);
  }
  
  console.log(`dispatch_execution: Successfully dispatched ${event.work_order_id}`);
}

/**
 * run_qa handler
 * POST to qa-review to run QA evaluation
 */
async function runQaHandler(event: WoEvent): Promise<void> {
  console.log(`run_qa: Running QA for work order ${event.work_order_id}`);
  
  const response = await fetch(
    `${supabaseUrl}/functions/v1/qa-review`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${supabaseServiceKey}`
      },
      body: JSON.stringify({
        work_order_id: event.work_order_id
      })
    }
  );
  
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`qa-review failed: ${response.status} - ${errorText}`);
  }
  
  console.log(`run_qa: Successfully triggered QA for ${event.work_order_id}`);
}

/**
 * Main handler - processes a batch of pending events
 */
Deno.serve(async (req) => {
  // Parse request body for optional batch_size
  let batchSize = 10; // default
  try {
    const body = await req.json();
    batchSize = body.batch_size || batchSize;
  } catch {
    // Use default if no body or parse error
  }
  
  console.log(`WO Effect Processor: Processing batch of up to ${batchSize} events`);
  
  try {
    // Step 1: Claim a batch of pending events atomically
    const { data: claimedEvents, error: claimError } = await supabase.rpc(
      'claim_pending_events',
      { p_batch_size: batchSize }
    );
    
    if (claimError) {
      console.error('Failed to claim events:', claimError);
      return new Response(
        JSON.stringify({ error: 'Failed to claim events', details: claimError }),
        { status: 500, headers: { 'Content-Type': 'application/json' } }
      );
    }
    
    if (!claimedEvents || claimedEvents.length === 0) {
      console.log('No pending events to process');
      return new Response(
        JSON.stringify({ processed: 0, message: 'No pending events' }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }
    
    console.log(`Claimed ${claimedEvents.length} events for processing`);
    
    // Step 2: Process each event
    const results: Array<{ eventId: string; success: boolean; error?: string }> = [];
    
    for (const event of claimedEvents) {
      const woEvent: WoEvent = {
        id: event.id,
        work_order_id: event.work_order_id,
        event_type: event.event_type,
        actor: event.actor,
        depth: event.depth || 0,
        payload: event.payload || {},
        previous_status: event.previous_status,
        new_status: event.new_status,
        retry_count: event.retry_count || 0
      };
      
      try {
        // Cascade depth check
        if (woEvent.depth > 5) {
          console.log(`Cascade depth exceeded for event ${woEvent.id}: depth=${woEvent.depth}`);
          
          await supabase
            .from('wo_events')
            .update({
              status: 'failed',
              error_detail: 'cascade_depth_exceeded',
              processed_at: new Date().toISOString()
            })
            .eq('id', woEvent.id);
          
          results.push({ eventId: woEvent.id, success: false, error: 'cascade_depth_exceeded' });
          continue;
        }
        
        // Route to appropriate handler based on event_type
        let handler: EventHandler;
        
        switch (woEvent.event_type) {
          case 'dispatch_execution':
            handler = dispatchExecutionHandler;
            break;
          case 'run_qa':
            handler = runQaHandler;
            break;
          default:
            handler = unknownEffectHandler;
        }
        
        // Execute the handler
        await handler(woEvent);
        
        // Mark event as done
        await supabase
          .from('wo_events')
          .update({
            status: 'done',
            processed_at: new Date().toISOString()
          })
          .eq('id', woEvent.id);
        
        results.push({ eventId: woEvent.id, success: true });
        console.log(`Successfully processed event ${woEvent.id} (${woEvent.event_type})`);
        
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        console.error(`Error processing event ${woEvent.id}:`, errorMessage);
        
        // Check retry count and decide next action
        const newRetryCount = woEvent.retry_count + 1;
        
        if (newRetryCount < 3) {
          // Retry: reset to pending and increment retry_count
          await supabase
            .from('wo_events')
            .update({
              status: 'pending',
              retry_count: newRetryCount,
              error_detail: null
            })
            .eq('id', woEvent.id);
          
          results.push({ 
            eventId: woEvent.id, 
            success: false, 
            error: `retry: ${errorMessage}` 
          });
        } else {
          // Max retries exceeded: mark as failed
          await supabase
            .from('wo_events')
            .update({
              status: 'failed',
              error_detail: errorMessage,
              processed_at: new Date().toISOString()
            })
            .eq('id', woEvent.id);
          
          results.push({ 
            eventId: woEvent.id, 
            success: false, 
            error: `failed: ${errorMessage}` 
          });
        }
      }
    }
    
    const successCount = results.filter(r => r.success).length;
    const failCount = results.filter(r => !r.success).length;
    
    console.log(`Batch complete: ${successCount} succeeded, ${failCount} failed`);
    
    return new Response(
      JSON.stringify({
        processed: claimedEvents.length,
        succeeded: successCount,
        failed: failCount,
        results
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
    
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error('WO Effect Processor error:', errorMessage);
    
    return new Response(
      JSON.stringify({ error: 'Internal error', details: errorMessage }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
});
