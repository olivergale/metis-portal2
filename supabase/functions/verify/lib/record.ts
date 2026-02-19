// verify/lib/record.ts
// Mutation recording helper for /verify edge function
// Calls record_mutation RPC with proxy_mode='edge_proxy'

import { SupabaseClient } from "jsr:@supabase/supabase-js@2";

export interface RecordMutationParams {
  workOrderId: string;
  toolName: string;
  objectType: string;
  objectId: string;
  action: string;
  success: boolean;
  resultHash?: string;
  errorClass?: string;
  errorDetail?: string;
  context?: Record<string, unknown>;
  agentName: string;
  verificationQuery?: string;
}

export interface RecordMutationResult {
  mutationId: string | null;
  proxySignature: string | null;
  error: string | null;
}

/**
 * Record a mutation via the record_mutation RPC.
 * Uses proxy_mode='edge_proxy' to indicate server-side execution.
 */
export async function recordMutation(
  supabase: SupabaseClient,
  params: RecordMutationParams
): Promise<RecordMutationResult> {
  try {
    const { data, error } = await supabase.rpc("record_mutation", {
      p_work_order_id: params.workOrderId,
      p_tool_name: params.toolName,
      p_object_type: params.objectType,
      p_object_id: params.objectId,
      p_action: params.action,
      p_success: params.success,
      p_result_hash: params.resultHash || null,
      p_error_class: params.errorClass || null,
      p_error_detail: params.errorDetail || null,
      p_context: params.context || {},
      p_agent_name: params.agentName,
      p_proxy_mode: "edge_proxy",
      p_verification_query: params.verificationQuery || null,
    });

    if (error) {
      return { mutationId: null, proxySignature: null, error: error.message };
    }

    return {
      mutationId: data?.mutation_id || data?.id || null,
      proxySignature: data?.proxy_signature || null,
      error: null,
    };
  } catch (e: unknown) {
    return {
      mutationId: null,
      proxySignature: null,
      error: (e as Error).message,
    };
  }
}
