// approval-notify/index.ts - v1
// Sends Slack notification when approval is needed

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const slackWebhook = Deno.env.get("SLACK_WEBHOOK_URL");

  const supabase = createClient(supabaseUrl, supabaseKey);

  try {
    // Get pending approvals
    const { data: pending, error } = await supabase
      .from("pending_approvals")
      .select("*")
      .limit(10);

    if (error) throw error;

    if (!pending || pending.length === 0) {
      return new Response(JSON.stringify({ message: "No pending approvals" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Format message
    const blocks = [
      {
        type: "header",
        text: { type: "plain_text", text: `🔔 ${pending.length} Pending Approval(s)` }
      },
      { type: "divider" }
    ];

    for (const item of pending) {
      blocks.push({
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*${item.work_order_slug || 'N/A'}* (${item.priority || 'unknown'})\n${item.request_summary}\n_Gate: ${item.gate_name} | Requested by: ${item.requested_by}_`
        }
      });
    }

    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: "<https://metis-portal2.vercel.app/workspace|View in Workspace>"
      }
    });

    // Send to Slack if webhook configured
    if (slackWebhook) {
      await fetch(slackWebhook, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ blocks }),
      });
    }

    return new Response(JSON.stringify({
      pending_count: pending.length,
      items: pending,
      slack_notified: !!slackWebhook
    }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  } catch (error) {
    console.error("approval-notify error:", error);
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
