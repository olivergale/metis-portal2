/**
 * WO Effect Processor Edge Function
 * 
 * Polls wo_events table for pending events, claims a batch atomically,
 * and processes each event by dispatching to the appropriate handler.
 * 
 * Event types handled:
 * - dispatch_execution: POST to wo-agent to start work order execution
 * - run_qa: POST to qa-review to run QA evaluation
 * - populate_qa_checklist: Generate QA checklist for a work order
 * - spawn_child: Create a child work order from parent
 * - notify_parent: Notify parent work order of child completion
 * - unblock_dependents: Unblock work orders that depend on completed one
 * - sync_notion: Sync work order to Notion (fire-and-forget)
 * - webhook: Trigger registered webhooks for work order events
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
 * populate_qa_checklist handler
 * Generate QA checklist for a work order
 */
async function populateQaChecklistHandler(event: WoEvent): Promise<void> {
  console.log(`populate_qa_checklist: Generating QA checklist for work order ${event.work_order_id}`);
  
  const { data, error } = await supabase.rpc('generate_qa_checklist', {
    p_work_order_id: event.work_order_id
  });
  
  if (error) {
    throw new Error(`generate_qa_checklist failed: ${error.message}`);
  }
  
  console.log(`populate_qa_checklist: Successfully generated checklist for ${event.work_order_id}:`, data);
}

/**
 * spawn_child handler
 * Create a child work order from parent
 */
async function spawnChildHandler(event: WoEvent): Promise<void> {
  console.log(`spawn_child: Creating child work order for parent ${event.work_order_id}`);
  
  const payload = event.payload as {
    name?: string;
    objective?: string;
    priority?: string;
    tags?: string[];
    acceptance_criteria?: string;
  };
  
  const { data, error } = await supabase.rpc('create_draft_work_order', {
    p_slug: null, // auto-generate
    p_name: payload.name || `Child of ${event.work_order_id}`,
    p_objective: payload.objective || '',
    p_priority: payload.priority || 'p2_medium',
    p_source: 'effect-processor',
    p_tags: payload.tags || ['spawned'],
    p_acceptance_criteria: payload.acceptance_criteria || null,
    p_parent_id: event.work_order_id
  });
  
  if (error) {
    throw new Error(`create_draft_work_order failed: ${error.message}`);
  }
  
  console.log(`spawn_child: Successfully created child work order:`, data);
}

/**
 * notify_parent handler
 * Notify parent work order of child completion
 */
async function notifyParentHandler(event: WoEvent): Promise<void> {
  console.log(`notify_parent: Notifying parent of child completion for ${event.work_order_id}`);
  
  const payload = event.payload as {
    parent_id?: string;
  };
  
  if (!payload.parent_id) {
    console.log(`notify_parent: No parent_id in payload, skipping`);
    return;
  }
  
  const { data, error } = await supabase.rpc('wo_transition', {
    p_wo_id: payload.parent_id,
    p_event: 'child_completed',
    p_payload: event.payload,
    p_actor: 'effect-processor',
    p_depth: event.depth + 1
  });
  
  if (error) {
    throw new Error(`wo_transition (notify_parent) failed: ${error.message}`);
  }
  
  console.log(`notify_parent: Successfully notified parent ${payload.parent_id}:`, data);
}

/**
 * unblock_dependents handler
 * Unblock work orders that depend on completed one
 */
async function unblockDependentsHandler(event: WoEvent): Promise<void> {
  console.log(`unblock_dependents: Checking for dependents of ${event.work_order_id}`);
  
  // Query work_orders where depends_on contains this work_order_id
  const { data: dependents, error } = await supabase
    .from('work_orders')
    .select('id, name, depends_on')
    .contains('depends_on', [event.work_order_id]);
  
  if (error) {
    throw new Error(`query dependents failed: ${error.message}`);
  }
  
  if (!dependents || dependents.length === 0) {
    console.log(`unblock_dependents: No dependents found for ${event.work_order_id}`);
    return;
  }
  
  console.log(`unblock_dependents: Found ${dependents.length} dependent(s)`);
  
  // Transition each dependent
  for (const dep of dependents) {
    console.log(`unblock_dependents: Unblocking dependent ${dep.id} (${dep.name})`);
    
    const { error: transitionError } = await supabase.rpc('wo_transition', {
      p_wo_id: dep.id,
      p_event: 'dependency_satisfied',
      p_payload: {},
      p_actor: 'effect-processor',
      p_depth: event.depth + 1
    });
    
    if (transitionError) {
      console.error(`unblock_dependents: Failed to unblock ${dep.id}:`, transitionError.message);
    } else {
      console.log(`unblock_dependents: Successfully unblocked ${dep.id}`);
    }
  }
}

/**
 * sync_notion handler
 * Sync work order to Notion (fire-and-forget, mark done even if fails)
 */
async function syncNotionHandler(event: WoEvent): Promise<void> {
  console.log(`sync_notion: Syncing work order ${event.work_order_id} to Notion`);
  
  try {
    const response = await fetch(
      `${supabaseUrl}/functions/v1/notion-sync`,
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
    
    // Fire-and-forget: log but don't throw on failure
    if (!response.ok) {
      const errorText = await response.text();
      console.warn(`sync_notion: Notion sync failed (non-fatal): ${response.status} - ${errorText}`);
    } else {
      console.log(`sync_notion: Successfully triggered Notion sync for ${event.work_order_id}`);
    }
  } catch (error) {
    // Fire-and-forget: log but don't throw
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.warn(`sync_notion: Notion sync error (non-fatal): ${errorMessage}`);
  }
  
  // Always succeed - fire-and-forget
}

/**
 * webhook handler
 * Trigger registered webhooks for work order events
 */
async function webhookHandler(event: WoEvent): Promise<void> {
  console.log(`webhook: Processing webhook triggers for work order ${event.work_order_id}`);
  
  // Query request_schemas for matching webhook endpoints
  const { data: webhooks, error } = await supabase
    .from('request_schemas')
    .select('id, endpoint, method, schema_name')
    .eq('endpoint', 'webhook');
  
  if (error) {
    throw new Error(`query webhooks failed: ${error.message}`);
  }
  
  if (!webhooks || webhooks.length === 0) {
    console.log(`webhook: No registered webhook endpoints found`);
    return;
  }
  
  // Build payload for webhook
  const webhookPayload = {
    work_order_id: event.work_order_id,
    event_type: event.event_type,
    actor: event.actor,
    previous_status: event.previous_status,
    new_status: event.new_status,
    payload: event.payload,
    timestamp: new Date().toISOString()
  };
  
  // POST to each registered webhook URL
  for (const webhook of webhooks) {
    try {
      // Get webhook URL from system_settings or config
      const { data: settings } = await supabase
        .from('system_settings')
        .select('key, value')
        .eq('key', `webhook_url_${webhook.id}`)
        .single();
      
      if (!settings) {
        console.log(`webhook: No URL configured for webhook ${webhook.id}`);
        continue;
      }
      
      const webhookUrl = settings.value;
      
      console.log(`webhook: POSTing to ${webhookUrl}`);
      
      const response = await fetch(webhookUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(webhookPayload)
      });
      
      if (!response.ok) {
        console.warn(`webhook: Failed to POST to ${webhookUrl}: ${response.status}`);
      } else {
        console.log(`webhook: Successfully triggered webhook ${webhook.id}`);
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.warn(`webhook: Error triggering webhook ${webhook.id}: ${errorMessage}`);
    }
  }
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
          case 'populate_qa_checklist':
            handler = populateQaChecklistHandler;
            break;
          case 'spawn_child':
            handler = spawnChildHandler;
            break;
          case 'notify_parent':
            handler = notifyParentHandler;
            break;
          case 'unblock_dependents':
            handler = unblockDependentsHandler;
            break;
          case 'sync_notion':
            handler = syncNotionHandler;
            break;
          case 'webhook':
            handler = webhookHandler;
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
