import { useState, useEffect, useCallback } from 'react';
import { supabase } from '../utils/supabase.ts';
import { apiFetch } from '../utils/api.ts';
import type { Agent, AgentStats } from '../types/index.ts';

export function useAgents() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [stats, setStats] = useState<AgentStats[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const [agentRes, statsRes] = await Promise.all([
        supabase.from('agents').select('*').order('name'),
        apiFetch<AgentStats[]>('/rest/v1/rpc/get_agent_performance_summary', 'POST', { p_days: 1 }),
      ]);
      if (agentRes.data) setAgents(agentRes.data as Agent[]);
      if (statsRes) setStats(statsRes);
    } catch (e) {
      console.error('Failed to load agents:', e);
    }
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  // Refresh every 30s for liveness
  useEffect(() => {
    const id = setInterval(load, 30000);
    return () => clearInterval(id);
  }, [load]);

  return { agents, stats, loading, reload: load };
}
