// wo-agent/handlers/batch.ts
// WO-0743: Extracted from index.ts — batch execution handler
import { createClient } from "jsr:@supabase/supabase-js@2";

type JsonResponse = (data: any, status?: number) => Response;

export async function handleExecuteBatch(req: Request, jsonResponse: JsonResponse): Promise<Response> {
  const body = await req.json();
  const { batch_id } = body;

  if (!batch_id) {
    return jsonResponse({ error: "Missing batch_id" }, 400);
  }

  const sbUrl = Deno.env.get("SUPABASE_URL")!;
  const sbKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const supabase = createClient(sbUrl, sbKey);

  const { data: startResult, error: startError } = await supabase.rpc(
    "start_batch_execution", { p_batch_id: batch_id }
  );

  if (startError || !startResult?.success) {
    return jsonResponse(
      { error: `Failed to start batch: ${startError?.message || startResult?.error}` },
      400
    );
  }

  const { data: batch } = await supabase
    .from("wo_batches").select("parallel_slots, execution_mode").eq("id", batch_id).single();

  const parallelSlots = batch?.parallel_slots || 3;
  const executionMode = batch?.execution_mode || "step";

  console.log(`[BATCH] Starting batch ${batch_id} in ${executionMode} mode with ${parallelSlots} parallel slots`);

  const executedWOs: string[] = [];
  const failedWOs: string[] = [];
  let iterationCount = 0;
  const maxIterations = 100;

  while (iterationCount < maxIterations) {
    iterationCount++;

    const { data: readyWOs, error: readyError } = await supabase.rpc(
      "get_batch_ready_wos", { p_batch_id: batch_id }
    );

    if (readyError) { console.error(`[BATCH] Error getting ready WOs:`, readyError); break; }
    if (!readyWOs || readyWOs.length === 0) { console.log(`[BATCH] No more ready WOs.`); break; }

    const waveWOs = readyWOs.slice(0, parallelSlots);

    const startPromises = waveWOs.map(async (wo: any) => {
      try {
        const { data: startWOResult } = await supabase.rpc("start_work_order", {
          p_work_order_id: wo.work_order_id, p_agent_name: "builder",
        });
        if (!startWOResult?.id) throw new Error(`Failed to start WO ${wo.slug}`);

        const anonKey = Deno.env.get("SUPABASE_ANON_KEY") || "";
        const executeRes = await fetch(`${sbUrl}/functions/v1/wo-agent/execute`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "Authorization": `Bearer ${anonKey}`, "apikey": anonKey },
          body: JSON.stringify({ work_order_id: wo.work_order_id }),
        });

        const result = await executeRes.json();
        if (result.status === "completed" || result.status === "done") {
          executedWOs.push(wo.slug);
          return { success: true, slug: wo.slug };
        } else {
          failedWOs.push(wo.slug);
          return { success: false, slug: wo.slug, error: result.error };
        }
      } catch (e: any) {
        console.error(`[BATCH] Error executing ${wo.slug}:`, e.message);
        failedWOs.push(wo.slug);
        return { success: false, slug: wo.slug, error: e.message };
      }
    });

    await Promise.all(startPromises);
  }

  const summary = `Batch execution completed: ${executedWOs.length} WOs succeeded, ${failedWOs.length} failed across ${iterationCount} waves`;
  const { data: completeResult } = await supabase.rpc("complete_batch_execution", {
    p_batch_id: batch_id, p_summary: summary,
  });

  return jsonResponse({
    batch_id, execution_mode: executionMode, waves: iterationCount,
    executed: executedWOs.length, failed: failedWOs.length,
    summary, completion_rate: completeResult?.completion_rate || 0,
  });
}
