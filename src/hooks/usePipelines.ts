import { useState, useEffect, useCallback } from 'react';
import { apiFetch } from '../utils/api.ts';
import { useRealtime } from './useRealtime.ts';
import type { PipelineRun } from '../types/index.ts';

export function usePipelines() {
  const [pipelines, setPipelines] = useState<PipelineRun[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const data = await apiFetch<{ pipeline_runs: PipelineRun[] }>(
        '/rest/v1/rpc/get_manifold_dashboard', 'POST'
      );
      setPipelines(data?.pipeline_runs || []);
    } catch (e) {
      console.error('Failed to load pipelines:', e);
    }
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);
  useRealtime('pipeline_runs', () => { load(); });

  return { pipelines, loading, reload: load };
}

export function usePipelineDetail(pipelineRunId: string | null) {
  const [detail, setDetail] = useState<any>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    if (!pipelineRunId) { setDetail(null); return; }
    setLoading(true);
    try {
      const data = await apiFetch<any>(
        '/rest/v1/rpc/get_pipeline_detail', 'POST',
        { p_pipeline_run_id: pipelineRunId }
      );
      setDetail(data);
    } catch (e) {
      console.error('Failed to load pipeline detail:', e);
    }
    setLoading(false);
  }, [pipelineRunId]);

  useEffect(() => { load(); }, [load]);

  return { detail, loading, reload: load };
}
