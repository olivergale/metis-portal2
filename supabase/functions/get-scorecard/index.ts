import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";
import { corsHeaders } from "../_shared/cors.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

interface ScorecardRequest {
  work_order_id?: string;
  work_order_slug?: string;
  limit?: number;
}

Deno.serve(async (req) => {
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    // Parse request body
    let params: ScorecardRequest = {};
    if (req.method === "POST") {
      params = await req.json();
    } else if (req.method === "GET") {
      const url = new URL(req.url);
      params = {
        work_order_id: url.searchParams.get("work_order_id") || undefined,
        work_order_slug: url.searchParams.get("work_order_slug") || undefined,
        limit: url.searchParams.get("limit") ? parseInt(url.searchParams.get("limit")!) : undefined,
      };
    }

    // Build query
    let query = supabase
      .from("run_scorecards")
      .select(`
        *,
        work_orders!inner(
          slug,
          name,
          status,
          priority,
          created_at,
          completed_at
        )
      `)
      .order("created_at", { ascending: false });

    // Apply filters
    if (params.work_order_id) {
      query = query.eq("work_order_id", params.work_order_id);
    }

    if (params.work_order_slug) {
      query = query.eq("work_orders.slug", params.work_order_slug);
    }

    // Apply limit (default 50, max 100)
    const limit = Math.min(params.limit || 50, 100);
    query = query.limit(limit);

    const { data, error } = await query;

    if (error) {
      console.error("Error fetching scorecards:", error);
      return new Response(
        JSON.stringify({ error: error.message }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Calculate summary statistics if multiple scorecards
    let summary = null;
    if (data && data.length > 0) {
      const scores = data.map((s) => s.overall_score);
      summary = {
        count: data.length,
        avg_overall_score: Math.round(scores.reduce((a, b) => a + b, 0) / scores.length),
        min_overall_score: Math.min(...scores),
        max_overall_score: Math.max(...scores),
        avg_policy_adherence: Math.round(
          data.reduce((a, b) => a + (b.policy_adherence_score || 0), 0) / data.length
        ),
        avg_cost_efficiency: Math.round(
          data.reduce((a, b) => a + (b.cost_efficiency_score || 0), 0) / data.length
        ),
        avg_time_efficiency: Math.round(
          data.reduce((a, b) => a + (b.time_efficiency_score || 0), 0) / data.length
        ),
        avg_qa_pass_rate: Math.round(
          data.reduce((a, b) => a + (b.qa_pass_rate_score || 0), 0) / data.length
        ),
        avg_evidence_completeness: Math.round(
          data.reduce((a, b) => a + (b.evidence_completeness_score || 0), 0) / data.length
        ),
      };
    }

    return new Response(
      JSON.stringify({
        scorecards: data,
        summary,
        meta: {
          count: data?.length || 0,
          limit,
        },
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("Unexpected error:", error);
    return new Response(
      JSON.stringify({ error: error.message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
