import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-agent-name',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    )

    // Send heartbeat ping
    supabase.from('system_status')
      .update({ last_heartbeat: new Date().toISOString() })
      .eq('component', 'workspace')
      .then(() => {}).catch(() => {}); // Fire and forget

    const agentName = req.headers.get('x-agent-name')
    if (!agentName) {
      return new Response(
        JSON.stringify({ error: 'Missing x-agent-name header' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    const body = await req.json()
    const { action, ...params } = body

    let result: any

    switch (action) {
      case 'get_ready_work_orders': {
        // Get work orders ready for this agent type
        const { data: agent } = await supabase
          .from('agents')
          .select('id, agent_type')
          .eq('name', agentName)
          .single()

        if (!agent) {
          return new Response(
            JSON.stringify({ error: 'Agent not found' }),
            { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
          )
        }

        // Get stale threshold from user preferences or default to 30 days
        const { data: prefData } = await supabase
          .from('user_preferences')
          .select('value')
          .eq('key', 'stale_wo_threshold_days')
          .maybeSingle()

        const staleThresholdDays = prefData?.value || 30
        const staleDate = new Date()
        staleDate.setDate(staleDate.getDate() - staleThresholdDays)

        let query = supabase
          .from('work_orders')
          .select('id, slug, name, objective, priority, constraints, acceptance_criteria, collaboration_mode, created_at, updated_at, status')
          .eq('status', 'ready')
          .or(`assigned_to.is.null,assigned_to.eq.${agent.id}`)
          .order('priority', { ascending: true })
          .order('created_at', { ascending: true })

        // Filter out stale WOs if requested
        if (!params.include_stale) {
          query = query.gte('updated_at', staleDate.toISOString())
        }

        const { data: workOrders } = await query.limit(params.limit || 10)

        // Log audit event if stale filter was applied
        if (!params.include_stale) {
          await supabase.from('audit_log').insert({
            event_type: 'workspace_stale_filter',
            actor: agentName,
            details: { threshold_days: staleThresholdDays, action: 'get_ready_work_orders' }
          })
        }

        result = { work_orders: workOrders || [] }
        break
      }

      case 'claim': {
        const { data } = await supabase.rpc('claim_work_order', {
          p_agent_name: agentName,
          p_work_order_id: params.work_order_id
        })
        result = data
        break
      }

      case 'complete': {
        const { data } = await supabase.rpc('complete_work_order', {
          p_agent_name: agentName,
          p_work_order_id: params.work_order_id,
          p_result: params.result || {}
        })
        result = data
        break
      }

      case 'acquire_lock': {
        const { data } = await supabase.rpc('acquire_lock', {
          p_agent_name: agentName,
          p_resource_type: params.resource_type,
          p_resource_id: params.resource_id,
          p_lock_type: params.lock_type || 'exclusive',
          p_ttl_minutes: params.ttl_minutes || 30,
          p_reason: params.reason
        })
        result = data
        break
      }

      case 'release_lock': {
        const { data } = await supabase.rpc('release_lock', {
          p_agent_name: agentName,
          p_resource_type: params.resource_type,
          p_resource_id: params.resource_id
        })
        result = data
        break
      }

      case 'post_event': {
        const { data: agent } = await supabase
          .from('agents')
          .select('id')
          .eq('name', agentName)
          .single()

        if (!agent) {
          return new Response(
            JSON.stringify({ error: 'Agent not found' }),
            { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
          )
        }

        const { data, error } = await supabase
          .from('workspace_events')
          .insert({
            agent_id: agent.id,
            event_type: params.event_type,
            work_order_id: params.work_order_id,
            target_agent_id: params.target_agent_id,
            payload: params.payload || {}
          })
          .select()
          .single()

        if (error) throw error
        result = { success: true, event_id: data.id }
        break
      }

      case 'get_events': {
        let query = supabase
          .from('workspace_events')
          .select(`
            id, event_type, payload, created_at,
            agent:agents!workspace_events_agent_id_fkey(name),
            target_agent:agents!workspace_events_target_agent_id_fkey(name),
            work_order:work_orders(slug, name)
          `)
          .order('created_at', { ascending: false })
          .limit(params.limit || 50)

        if (params.since) {
          query = query.gt('created_at', params.since)
        }
        if (params.work_order_id) {
          query = query.eq('work_order_id', params.work_order_id)
        }

        const { data } = await query
        result = { events: data || [] }
        break
      }

      case 'get_locks': {
        const { data } = await supabase
          .from('workspace_locks')
          .select(`
            id, resource_type, resource_id, lock_type, reason, acquired_at, expires_at,
            agent:agents(name)
          `)
          .gt('expires_at', new Date().toISOString())

        result = { locks: data || [] }
        break
      }

      case 'save_memory': {
        const { data: agent } = await supabase
          .from('agents')
          .select('id')
          .eq('name', agentName)
          .single()

        if (!agent) {
          return new Response(
            JSON.stringify({ error: 'Agent not found' }),
            { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
          )
        }

        // Set agent context for RLS
        await supabase.rpc('set_agent_context', { p_agent_name: agentName })

        const { data, error } = await supabase
          .from('agent_memory')
          .upsert({
            agent_id: agent.id,
            memory_type: params.memory_type,
            key: params.key,
            value: params.value,
            expires_at: params.expires_at
          }, { onConflict: 'agent_id,memory_type,key' })
          .select()
          .single()

        if (error) throw error
        result = { success: true, memory_id: data.id }
        break
      }

      case 'get_memory': {
        const { data: agent } = await supabase
          .from('agents')
          .select('id')
          .eq('name', agentName)
          .single()

        if (!agent) {
          return new Response(
            JSON.stringify({ error: 'Agent not found' }),
            { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
          )
        }

        let query = supabase
          .from('agent_memory')
          .select('id, memory_type, key, value, created_at, updated_at')
          .eq('agent_id', agent.id)

        if (params.memory_type) {
          query = query.eq('memory_type', params.memory_type)
        }
        if (params.key) {
          query = query.eq('key', params.key)
        }

        const { data } = await query.limit(params.limit || 100)
        result = { memories: data || [] }
        break
      }

      default:
        return new Response(
          JSON.stringify({ error: `Unknown action: ${action}` }),
          { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        )
    }

    return new Response(
      JSON.stringify(result),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )

  } catch (error) {
    console.error('Workspace API error:', error)
    return new Response(
      JSON.stringify({ error: error.message }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }
})