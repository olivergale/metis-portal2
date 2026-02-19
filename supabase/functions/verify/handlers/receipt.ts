// verify/handlers/receipt.ts
// Generate and verify receipts for work orders

import { SupabaseClient } from "jsr:@supabase/supabase-js@2";

interface ReceiptGetRequest {
  wo_id: string;
}

/**
 * Get/verify receipt for a work order.
 * Reads from verification_receipts table.
 */
export async function handleGetReceipt(
  woId: string,
  supabase: SupabaseClient
): Promise<Response> {
  if (!woId) {
    return json({ success: false, error: "Missing wo_id" }, 400);
  }

  try {
    const { data, error } = await supabase
      .from("verification_receipts")
      .select("*")
      .eq("work_order_id", woId)
      .order("created_at", { ascending: false })
      .limit(1)
      .single();

    if (error) {
      return json(
        { success: false, error: `Receipt not found: ${error.message}` },
        404
      );
    }

    return json({
      success: true,
      receipt: data,
    });
  } catch (e: unknown) {
    return json(
      { success: false, error: `Receipt exception: ${(e as Error).message}` },
      500
    );
  }
}

interface GenerateReceiptRequest {
  wo_id: string;
  agent_name: string;
}

/**
 * Generate a receipt for a work order.
 * Calls generate_verification_receipt RPC.
 */
export async function handleGenerateReceipt(
  body: GenerateReceiptRequest,
  supabase: SupabaseClient
): Promise<Response> {
  const { wo_id, agent_name } = body;

  if (!wo_id || !agent_name) {
    return json({ success: false, error: "Missing wo_id or agent_name" }, 400);
  }

  try {
    const { data, error } = await supabase.rpc(
      "generate_verification_receipt",
      { p_wo_id: wo_id }
    );

    if (error) {
      return json(
        { success: false, error: `Receipt generation failed: ${error.message}` },
        500
      );
    }

    return json({
      success: true,
      receipt: data,
    });
  } catch (e: unknown) {
    return json(
      { success: false, error: `Receipt exception: ${(e as Error).message}` },
      500
    );
  }
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
