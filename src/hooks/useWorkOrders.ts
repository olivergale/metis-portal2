import { useState, useEffect, useCallback } from 'react';
import { supabase } from '../utils/supabase.ts';
import { useRealtime } from './useRealtime.ts';
import type { WorkOrder } from '../types/index.ts';

export function useWorkOrders(pipelineRunId?: string) {
  const [workOrders, setWorkOrders] = useState<WorkOrder[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    let query = supabase.from('work_orders').select('*').order('created_at', { ascending: false }).limit(200);
    if (pipelineRunId) {
      query = query.eq('pipeline_run_id', pipelineRunId);
    }
    const { data } = await query;
    if (data) setWorkOrders(data as WorkOrder[]);
    setLoading(false);
  }, [pipelineRunId]);

  useEffect(() => { load(); }, [load]);

  useRealtime('work_orders', () => { load(); });

  return { workOrders, loading, reload: load };
}
