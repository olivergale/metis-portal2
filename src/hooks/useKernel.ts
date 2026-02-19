import { useState, useEffect, useCallback } from 'react';
import { supabase } from '../utils/supabase.ts';
import type { KernelDashboard } from '../types/index.ts';

export function useKernel() {
  const [data, setData] = useState<KernelDashboard | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const { data: result, error: rpcError } = await supabase.rpc('get_kernel_dashboard');
      if (rpcError) {
        setError(rpcError.message);
        return;
      }
      setData(result as KernelDashboard);
      setError(null);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    const interval = setInterval(load, 30_000);
    return () => clearInterval(interval);
  }, [load]);

  return { data, loading, error, reload: load };
}
