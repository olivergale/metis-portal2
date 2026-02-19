// verify/handlers/snapshot.ts
// Trigger snapshot capture for a work order

import { SupabaseClient } from "jsr:@supabase/supabase-js@2";

interface SnapshotRequest {
  wo_id: string;
  agent_name: string;
  snapshot_type: "before" | "after";
}

/**
 * Capture a before/after snapshot for a work order.
 * Calls capture_wo_snapshot RPC.
 */
export async function handleSnapshot(
  body: SnapshotRequest,
  supabase: SupabaseClient
): Promise<Response> {
  const { wo_id, agent_name, snapshot_type } = body;

  if (!wo_id || !agent_name || !snapshot_type) {
    return json(
      { success: false, error: "Missing wo_id, agent_name, or snapshot_type" },
      400
    );
  }

  if (!["before", "after"].includes(snapshot_type)) {
    return json(
      { success: false, error: "snapshot_type must be 'before' or 'after'" },
      400
    );
  }

  try {
    const { data, error } = await supabase.rpc("capture_wo_snapshot", {
      p_wo_id: wo_id,
      p_type: snapshot_type,
    });

    if (error) {
      return json(
        { success: false, error: `Snapshot capture failed: ${error.message}` },
        500
      );
    }

    return json({
      success: true,
      snapshot_type,
      snapshot_id: data?.id || null,
      content_hash: data?.content_hash || null,
    });
  } catch (e: unknown) {
    return json(
      { success: false, error: `Snapshot exception: ${(e as Error).message}` },
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
