import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.39.7'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    const supabase = createClient(supabaseUrl, supabaseKey)

    // Fetch active regression suite definitions
    const { data: suites, error: suitesError } = await supabase
      .from('regression_suite_definitions')
      .select('*')
      .eq('enabled', true)
      .order('suite_name')

    if (suitesError) {
      console.error('Error fetching suites:', suitesError)
      return new Response(
        JSON.stringify({ error: 'Failed to fetch test suites', details: suitesError }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    if (!suites || suites.length === 0) {
      return new Response(
        JSON.stringify({ message: 'No active regression suites found' }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    const results = []

    // Execute each suite
    for (const suite of suites) {
      const runStart = new Date()
      let scorecard = null
      let error = null

      try {
        // Call get-scorecard function for the work order
        const scorecardResponse = await fetch(
          `${supabaseUrl}/functions/v1/get-scorecard`,
          {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${supabaseKey}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              work_order_id: suite.work_order_id,
            }),
          }
        )

        if (!scorecardResponse.ok) {
          throw new Error(`Scorecard fetch failed: ${scorecardResponse.statusText}`)
        }

        scorecard = await scorecardResponse.json()

        // Extract aggregate score
        const aggregateScore = scorecard.aggregate_score || 0

        // Insert test run record
        const { data: runRecord, error: insertError } = await supabase
          .from('regression_suite_runs')
          .insert({
            suite_id: suite.id,
            work_order_id: suite.work_order_id,
            started_at: runStart.toISOString(),
            completed_at: new Date().toISOString(),
            aggregate_score: aggregateScore,
            scorecard_snapshot: scorecard,
            status: 'completed',
          })
          .select()
          .single()

        if (insertError) {
          throw new Error(`Failed to insert run record: ${insertError.message}`)
        }

        // Compare to baseline if exists
        if (suite.baseline_score !== null) {
          const scoreDrop = suite.baseline_score - aggregateScore
          const dropPercent = (scoreDrop / suite.baseline_score) * 100

          // Create alert if drop exceeds threshold
          if (dropPercent > suite.alert_threshold_percent) {
            const { error: alertError } = await supabase
              .from('regression_alerts')
              .insert({
                suite_id: suite.id,
                run_id: runRecord.id,
                alert_type: 'score_drop',
                severity: dropPercent > 20 ? 'critical' : 'warning',
                message: `Regression detected: ${suite.suite_name} score dropped by ${dropPercent.toFixed(1)}% (baseline: ${suite.baseline_score}, current: ${aggregateScore})`,
                details: {
                  baseline_score: suite.baseline_score,
                  current_score: aggregateScore,
                  drop_percent: dropPercent,
                  threshold: suite.alert_threshold_percent,
                },
              })

            if (alertError) {
              console.error('Failed to create alert:', alertError)
            }
          }
        }

        results.push({
          suite_name: suite.suite_name,
          status: 'completed',
          aggregate_score: aggregateScore,
          baseline_score: suite.baseline_score,
          run_id: runRecord.id,
        })
      } catch (err) {
        error = err.message

        // Insert failed run record
        await supabase
          .from('regression_suite_runs')
          .insert({
            suite_id: suite.id,
            work_order_id: suite.work_order_id,
            started_at: runStart.toISOString(),
            completed_at: new Date().toISOString(),
            status: 'failed',
            error_message: error,
          })

        results.push({
          suite_name: suite.suite_name,
          status: 'failed',
          error,
        })
      }
    }

    return new Response(
      JSON.stringify({
        message: 'Regression suite execution completed',
        total_suites: suites.length,
        results,
      }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  } catch (error) {
    console.error('Regression suite error:', error)
    return new Response(
      JSON.stringify({ error: error.message }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }
})
