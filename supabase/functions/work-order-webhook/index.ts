// work-order-webhook/index.ts
// Sends webhook notifications when work orders change status
// Can trigger n8n, Slack, or other automation

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

interface WebhookPayload {
  event: "work_order.created" | "work_order.updated" | "work_order.completed";
  work_order: {
    id: string;
    slug: string;
    name: string;
    objective: string;
    status: string;
    priority: string;
    assigned_to: string;
  };
  timestamp: string;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const n8nWebhookUrl = Deno.env.get("N8N_WEBHOOK_URL");
  const slackWebhookUrl = Deno.env.get("SLACK_WEBHOOK_URL");

  const supabase = createClient(supabaseUrl, supabaseKey);

  try {
    // This is called by Supabase database triggers or manually
    const body = await req.json();
    const { type, table, record, old_record } = body;

    // Only process work_orders table
    if (table !== "work_orders") {
      return new Response(JSON.stringify({ ignored: true }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Determine event type
    let event: WebhookPayload["event"];
    if (type === "INSERT") {
      event = "work_order.created";
    } else if (type === "UPDATE" && record?.status === "done") {
      event = "work_order.completed";
    } else {
      event = "work_order.updated";
    }

    const payload: WebhookPayload = {
      event,
      work_order: {
        id: record.id,
        slug: record.slug,
        name: record.name,
        objective: record.objective,
        status: record.status,
        priority: record.priority,
        assigned_to: record.assigned_to,
      },
      timestamp: new Date().toISOString(),
    };

    const results: Record<string, any> = {};

    // Send to n8n if configured
    if (n8nWebhookUrl) {
      try {
        const n8nRes = await fetch(n8nWebhookUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        results.n8n = { status: n8nRes.status, ok: n8nRes.ok };
      } catch (e) {
        results.n8n = { error: e.message };
      }
    }

    // Send to Slack if configured (for new work orders)
    if (slackWebhookUrl && event === "work_order.created") {
      try {
        const slackPayload = {
          text: `\uD83D\uDD14 New Work Order: ${record.slug}`,
          blocks: [
            {
              type: "section",
              text: {
                type: "mrkdwn",
                text: `*New Work Order Created*\n*${record.slug}*: ${record.name}\n\n_${record.objective}_`,
              },
            },
            {
              type: "context",
              elements: [
                { type: "mrkdwn", text: `Priority: ${record.priority}` },
                { type: "mrkdwn", text: `Status: ${record.status}` },
              ],
            },
          ],
        };
        const slackRes = await fetch(slackWebhookUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(slackPayload),
        });
        results.slack = { status: slackRes.status, ok: slackRes.ok };
      } catch (e) {
        results.slack = { error: e.message };
      }
    }

    // Log webhook dispatch
    await supabase.from("webhook_logs").insert({
      event,
      payload,
      results,
      source: "work-order-webhook",
    }).catch(() => {}); // Ignore if table doesn't exist

    return new Response(JSON.stringify({
      event,
      work_order_id: record.id,
      dispatched_to: Object.keys(results),
      results,
    }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  } catch (error) {
    console.error("work-order-webhook error:", error);
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
