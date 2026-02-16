import { useState, useEffect } from 'react';
import { useAgents } from '../hooks/useAgents.ts';
import { supabase } from '../utils/supabase.ts';
import AgentCard from '../components/AgentCard.tsx';
import type { WorkOrder } from '../types/index.ts';

export default function Agents() {
  const { agents, stats, loading } = useAgents();
  const [assignments, setAssignments] = useState<Record<string, WorkOrder[]>>({});

  // Load current WO assignments per agent
  useEffect(() => {
    async function loadAssignments() {
      const { data } = await supabase
        .from('work_orders')
        .select('id,slug,name,status,assigned_to')
        .in('status', ['in_progress', 'review', 'blocked', 'blocked_on_input'])
        .order('updated_at', { ascending: false });

      if (data) {
        const map: Record<string, WorkOrder[]> = {};
        (data as WorkOrder[]).forEach(wo => {
          if (wo.assigned_to) {
            if (!map[wo.assigned_to]) map[wo.assigned_to] = [];
            map[wo.assigned_to].push(wo);
          }
        });
        setAssignments(map);
      }
    }
    loadAssignments();
  }, []);

  if (loading) {
    return <div style={styles.loading}>Loading agents...</div>;
  }

  return (
    <div>
      <h1 style={styles.title}>Agent Diagnostics</h1>

      <div style={styles.grid}>
        {agents.map(agent => {
          const agentStats = stats.find(s => s.agent_name === agent.name);
          const agentWOs = assignments[agent.name] || [];

          return (
            <div key={agent.id}>
              <AgentCard agent={agent} stats={agentStats} />

              {/* Model info */}
              {agent.model && (
                <div style={styles.modelRow}>
                  <span style={styles.modelLabel}>Model:</span>
                  <span style={styles.modelValue}>{agent.model}</span>
                </div>
              )}

              {/* Assigned WOs */}
              {agentWOs.length > 0 && (
                <div style={styles.woList}>
                  <div style={styles.woListLabel}>Assigned WOs ({agentWOs.length}):</div>
                  {agentWOs.map(wo => (
                    <div key={wo.id} style={styles.woItem}>
                      <span style={styles.woSlug}>{wo.slug}</span>
                      <span style={{
                        fontSize: 10,
                        padding: '1px 6px',
                        borderRadius: 3,
                        background: wo.status === 'in_progress' ? 'rgba(59,130,246,0.15)' : 'rgba(156,163,175,0.15)',
                        color: wo.status === 'in_progress' ? '#3b82f6' : '#9ca3af',
                        textTransform: 'uppercase' as const,
                        fontWeight: 600,
                      }}>{wo.status.replace(/_/g, ' ')}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  title: {
    fontSize: 22,
    fontWeight: 600,
    marginBottom: 20,
  },
  loading: {
    color: 'var(--text-muted)',
    textAlign: 'center',
    padding: 40,
  },
  grid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))',
    gap: 16,
  },
  modelRow: {
    display: 'flex',
    gap: 6,
    padding: '8px 16px 0',
    fontSize: 11,
  },
  modelLabel: {
    color: 'var(--text-muted)',
  },
  modelValue: {
    fontFamily: 'var(--font-mono)',
    color: 'var(--accent)',
  },
  woList: {
    padding: '8px 16px 12px',
    display: 'flex',
    flexDirection: 'column',
    gap: 4,
  },
  woListLabel: {
    fontSize: 11,
    fontWeight: 600,
    color: 'var(--text-muted)',
    textTransform: 'uppercase',
    marginBottom: 2,
  },
  woItem: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: '4px 8px',
    background: 'var(--bg-elevated)',
    borderRadius: 4,
  },
  woSlug: {
    fontFamily: 'var(--font-mono)',
    fontSize: 11,
    color: 'var(--text-secondary)',
  },
};
