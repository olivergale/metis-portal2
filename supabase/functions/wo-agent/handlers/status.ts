// wo-agent/handlers/status.ts
// WO-0743: Extracted from index.ts — status check handler
import { createClient } from "jsr:@supabase/supabase-js@2";

type JsonResponse = (data: any, status?: number) => Response;

export async function handleStatus(req: Request, jsonResponse: JsonResponse): Promise<Response> {
  const body = await req.json();
  const { work_order_id } = body;

  if (!work_order_id) {
    return jsonResponse({ error: "Missing work_order_id" }, 400);
  }

  const sbUrl = Deno.env.get("SUPABASE_URL")!;
  const sbKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const supabase = createClient(sbUrl, sbKey);

  const { data: wo } = await supabase
    .from("work_orders").select("id, slug, status, summary")
    .eq("id", work_order_id).single();

  if (!wo) {
    return jsonResponse({ error: "Work order not found" }, 404);
  }

  const { data: logs } = await supabase
    .from("work_order_execution_log")
    .select("phase, detail, created_at")
    .eq("work_order_id", work_order_id)
    .order("created_at", { ascending: false })
    .limit(5);

  return jsonResponse({
    work_order_id: wo.id, slug: wo.slug, status: wo.status,
    summary: wo.summary, recent_activity: logs || [],
  });
}
