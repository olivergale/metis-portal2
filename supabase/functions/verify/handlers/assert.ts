// verify/handlers/assert.ts
// Run assertions for a work order — evaluates wo_assertions via SQL

import { SupabaseClient } from "jsr:@supabase/supabase-js@2";

interface AssertRequest {
  wo_id: string;
  agent_name: string;
}

/**
 * Evaluate all assertions for a work order.
 * Calls evaluate_sql_assertions RPC.
 */
export async function handleAssert(
  body: AssertRequest,
  supabase: SupabaseClient
): Promise<Response> {
  const { wo_id, agent_name } = body;

  if (!wo_id || !agent_name) {
    return json({ success: false, error: "Missing wo_id or agent_name" }, 400);
  }

  try {
    const { data, error } = await supabase.rpc("evaluate_sql_assertions", {
      p_wo_id: wo_id,
    });

    if (error) {
      return json({ success: false, error: `Assertion evaluation failed: ${error.message}` }, 500);
    }

    return json({
      success: true,
      assertions: data,
    });
  } catch (e: unknown) {
    return json({ success: false, error: `Assert exception: ${(e as Error).message}` }, 500);
  }
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
