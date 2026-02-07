// sync-notion/index.ts
// Syncs work orders from Supabase to Notion database

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

interface NotionPage {
  id: string;
  properties: Record<string, any>;
}

interface SyncResult {
  work_order_id: string;
  slug: string;
  action: "created" | "updated" | "skipped" | "error";
  notion_page_id?: string;
  error?: string;
}

async function findExistingPage(
  notionToken: string,
  databaseId: string,
  workOrderId: string
): Promise<NotionPage | null> {
  try {
    const response = await fetch(
      `https://api.notion.com/v1/databases/${databaseId}/query`,
      {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${notionToken}`,
          "Content-Type": "application/json",
          "Notion-Version": "2022-06-28",
        },
        body: JSON.stringify({
          filter: {
            property: "Work Order ID",
            rich_text: { equals: workOrderId },
          },
        }),
      }
    );

    if (!response.ok) return null;
    const data = await response.json();
    return data.results?.[0] || null;
  } catch {
    return null;
  }
}

async function createNotionPage(
  notionToken: string,
  databaseId: string,
  workOrder: any
): Promise<{ success: boolean; pageId?: string; error?: string }> {
  try {
    const response = await fetch("https://api.notion.com/v1/pages", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${notionToken}`,
        "Content-Type": "application/json",
        "Notion-Version": "2022-06-28",
      },
      body: JSON.stringify({
        parent: { database_id: databaseId },
        properties: {
          "Name": {
            title: [{ text: { content: workOrder.name || "Untitled" } }],
          },
          "Work Order ID": {
            rich_text: [{ text: { content: workOrder.id } }],
          },
          "Slug": {
            rich_text: [{ text: { content: workOrder.slug || "" } }],
          },
          "Status": {
            select: { name: mapStatus(workOrder.status) },
          },
          "Priority": {
            select: { name: mapPriority(workOrder.priority) },
          },
          "Objective": {
            rich_text: [{ text: { content: (workOrder.objective || "").slice(0, 2000) } }],
          },
          "Created": {
            date: { start: workOrder.created_at },
          },
        },
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      return { success: false, error };
    }

    const data = await response.json();
    return { success: true, pageId: data.id };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

async function updateNotionPage(
  notionToken: string,
  pageId: string,
  workOrder: any
): Promise<{ success: boolean; error?: string }> {
  try {
    const response = await fetch(`https://api.notion.com/v1/pages/${pageId}`, {
      method: "PATCH",
      headers: {
        "Authorization": `Bearer ${notionToken}`,
        "Content-Type": "application/json",
        "Notion-Version": "2022-06-28",
      },
      body: JSON.stringify({
        properties: {
          "Name": {
            title: [{ text: { content: workOrder.name || "Untitled" } }],
          },
          "Status": {
            select: { name: mapStatus(workOrder.status) },
          },
          "Priority": {
            select: { name: mapPriority(workOrder.priority) },
          },
          "Objective": {
            rich_text: [{ text: { content: (workOrder.objective || "").slice(0, 2000) } }],
          },
        },
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      return { success: false, error };
    }

    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

function mapStatus(status: string): string {
  const mapping: Record<string, string> = {
    draft: "Draft",
    ready: "Ready",
    in_progress: "In Progress",
    review: "Review",
    done: "Done",
    blocked: "Blocked",
    cancelled: "Cancelled",
  };
  return mapping[status] || "Draft";
}

function mapPriority(priority: string): string {
  const mapping: Record<string, string> = {
    p0_critical: "\uD83D\uDD34 Critical",
    p1_high: "\uD83D\uDFE0 High",
    p2_medium: "\uD83D\uDFE1 Medium",
    p3_low: "\uD83D\uDFE2 Low",
  };
  return mapping[priority] || "\uD83D\uDFE1 Medium";
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const notionToken = Deno.env.get("NOTION_TOKEN");
  const notionDatabaseId = Deno.env.get("NOTION_DATABASE_ID");

  if (!notionToken || !notionDatabaseId) {
    return new Response(
      JSON.stringify({
        error: "Notion not configured",
        help: "Set NOTION_TOKEN and NOTION_DATABASE_ID in Supabase secrets",
      }),
      {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  }

  const supabase = createClient(supabaseUrl, supabaseKey);

  try {
    const body = await req.json().catch(() => ({}));
    const { work_order_ids, sync_all = false, since } = body;

    // Build query
    let query = supabase
      .from("work_orders")
      .select("id, slug, name, objective, status, priority, created_at, updated_at")
      .order("updated_at", { ascending: false });

    if (work_order_ids?.length) {
      query = query.in("id", work_order_ids);
    } else if (since) {
      query = query.gte("updated_at", since);
    } else if (!sync_all) {
      // Default: last 24 hours
      const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      query = query.gte("updated_at", yesterday);
    }

    const { data: workOrders, error } = await query.limit(100);

    if (error) throw error;
    if (!workOrders?.length) {
      return new Response(
        JSON.stringify({ synced: 0, message: "No work orders to sync" }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Sync each work order
    const results: SyncResult[] = [];

    for (const wo of workOrders) {
      // Check if page exists
      const existingPage = await findExistingPage(notionToken, notionDatabaseId, wo.id);

      if (existingPage) {
        // Update existing
        const updateResult = await updateNotionPage(notionToken, existingPage.id, wo);
        results.push({
          work_order_id: wo.id,
          slug: wo.slug,
          action: updateResult.success ? "updated" : "error",
          notion_page_id: existingPage.id,
          error: updateResult.error,
        });
      } else {
        // Create new
        const createResult = await createNotionPage(notionToken, notionDatabaseId, wo);
        results.push({
          work_order_id: wo.id,
          slug: wo.slug,
          action: createResult.success ? "created" : "error",
          notion_page_id: createResult.pageId,
          error: createResult.error,
        });
      }

      // Rate limit: Notion allows ~3 requests/sec
      await new Promise((r) => setTimeout(r, 350));
    }

    const summary = {
      total: results.length,
      created: results.filter((r) => r.action === "created").length,
      updated: results.filter((r) => r.action === "updated").length,
      errors: results.filter((r) => r.action === "error").length,
    };

    return new Response(
      JSON.stringify({
        success: true,
        summary,
        results,
        synced_at: new Date().toISOString(),
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("sync-notion error:", error);
    return new Response(
      JSON.stringify({ error: error.message }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  }
});
