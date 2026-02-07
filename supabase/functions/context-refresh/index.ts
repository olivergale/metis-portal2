import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    // Get project code from query param or default to METIS-001
    const url = new URL(req.url);
    const projectCode = url.searchParams.get("project") || "METIS-001";
    const format = url.searchParams.get("format") || "markdown"; // markdown or json

    // Initialize Supabase client
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    if (format === "json") {
      // Return raw JSON context
      const { data, error } = await supabase.rpc("get_cli_bootstrap_context", {
        p_project_code: projectCode,
      });

      if (error) throw error;

      return new Response(JSON.stringify(data, null, 2), {
        headers: {
          ...corsHeaders,
          "Content-Type": "application/json",
        },
      });
    } else {
      // Return markdown CLAUDE.md
      const { data, error } = await supabase.rpc("generate_cli_claude_md", {
        p_project_code: projectCode,
      });

      if (error) throw error;

      return new Response(data, {
        headers: {
          ...corsHeaders,
          "Content-Type": "text/markdown; charset=utf-8",
          "Content-Disposition": "inline; filename=CLAUDE.md",
        },
      });
    }
  } catch (error) {
    console.error("Error:", error);
    return new Response(
      JSON.stringify({ error: error.message }),
      {
        status: 500,
        headers: {
          ...corsHeaders,
          "Content-Type": "application/json",
        },
      }
    );
  }
});
