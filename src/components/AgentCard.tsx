import { relativeTime } from '../utils/api.ts';
import type { Agent, AgentStats } from '../types/index.ts';

interface AgentCardProps {
  agent: Agent;
  stats?: AgentStats;
}

export default function AgentCard({ agent, stats }: AgentCardProps) {
  const lastMut = stats?.last_mutation_at;
  const minsSinceMut = lastMut ? (Date.now() - new Date(lastMut).getTime()) / 60000 : Infinity;

  let liveness: 'green' | 'yellow' | 'red' = 'red';
  if (minsSinceMut < 10) liveness = 'green';
  else if (minsSinceMut < 30) liveness = 'yellow';

  const isZombie = stats?.current_wo_status === 'in_progress' && minsSinceMut > 30;

  const livenessColors = {
    green: '#22c55e',
    yellow: '#f59e0b',
    red: '#ef4444',
  };

  return (
    <div style={styles.card}>
      <div style={styles.header}>
        <div style={styles.nameRow}>
          <span style={{ ...styles.dot, background: livenessColors[liveness] }} />
          <span style={styles.name}>{agent.name}</span>
          {isZombie && <span style={styles.zombie}>ZOMBIE</span>}
        </div>
        <span style={styles.role}>{agent.agent_type}</span>
      </div>

      <div style={styles.statsGrid}>
        <div style={styles.stat}>
          <div style={styles.statValue}>{stats?.wos_done ?? '-'}</div>
          <div style={styles.statLabel}>Done (24h)</div>
        </div>
        <div style={styles.stat}>
          <div style={{ ...styles.statValue, color: (stats?.wos_failed ?? 0) > 0 ? 'var(--status-error)' : 'var(--text-primary)' }}>
            {stats?.wos_failed ?? '-'}
          </div>
          <div style={styles.statLabel}>Failed</div>
        </div>
        <div style={styles.stat}>
          <div style={{
            ...styles.statValue,
            color: (stats?.mutation_success_rate ?? 1) >= 0.8 ? 'var(--status-success)' :
                   (stats?.mutation_success_rate ?? 1) >= 0.5 ? 'var(--status-warning)' : 'var(--status-error)',
          }}>
            {stats?.mutation_success_rate != null ? `${(stats.mutation_success_rate * 100).toFixed(0)}%` : '-'}
          </div>
          <div style={styles.statLabel}>Mut. Rate</div>
        </div>
      </div>

      <div style={styles.footer}>
        {stats?.current_wo_slug && (
          <div style={styles.currentWO}>
            <span style={{ color: 'var(--text-muted)', fontSize: 11 }}>Current:</span>
            <span style={{ color: 'var(--accent)', fontFamily: 'var(--font-mono)', fontSize: 11 }}>{stats.current_wo_slug}</span>
          </div>
        )}
        <div style={styles.lastMut}>
          Last mutation: {lastMut ? relativeTime(lastMut) : 'never'}
        </div>
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  card: {
    background: 'var(--bg-surface)',
    border: '1px solid var(--border-default)',
    borderRadius: 'var(--radius-md)',
    padding: 16,
  },
  header: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 12,
  },
  nameRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: '50%',
  },
  name: {
    fontWeight: 600,
    fontSize: 14,
    color: 'var(--text-primary)',
  },
  zombie: {
    fontSize: 10,
    fontWeight: 700,
    padding: '2px 6px',
    borderRadius: 4,
    background: 'rgba(239,68,68,0.2)',
    color: '#ef4444',
    textTransform: 'uppercase' as const,
  },
  role: {
    fontSize: 11,
    color: 'var(--text-muted)',
    textTransform: 'uppercase' as const,
  },
  statsGrid: {
    display: 'grid',
    gridTemplateColumns: '1fr 1fr 1fr',
    gap: 8,
    marginBottom: 12,
  },
  stat: {
    textAlign: 'center' as const,
    padding: 8,
    background: 'var(--bg-elevated)',
    borderRadius: 4,
  },
  statValue: {
    fontSize: 18,
    fontWeight: 700,
    color: 'var(--text-primary)',
  },
  statLabel: {
    fontSize: 10,
    color: 'var(--text-muted)',
    marginTop: 2,
  },
  footer: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 4,
  },
  currentWO: {
    display: 'flex',
    gap: 6,
    alignItems: 'center',
  },
  lastMut: {
    fontSize: 11,
    color: 'var(--text-muted)',
  },
};
