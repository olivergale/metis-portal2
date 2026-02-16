import type { WorkOrder, WOMutation } from '../types/index.ts';

interface PhaseHistory {
  phase: string;
  wo_id?: string;
  completed_at?: string;
}

interface PhaseSummaryProps {
  phases: string[];
  phaseHistory: PhaseHistory[];
  wosByPhase: Record<string, WorkOrder[]>;
  mutations: Array<{ mutation: WOMutation; work_order: WorkOrder }>;
  pipelineCreatedAt: string;
}

interface PhaseStats {
  woCount: number;
  wosDone: number;
  wosFailed: number;
  totalMutations: number;
  successMutations: number;
  failedMutations: number;
  agents: string[];
  startedAt: string | null;
  completedAt: string | null;
  durationMin: number | null;
}

export default function PhaseSummary({ phases, phaseHistory, wosByPhase, mutations, pipelineCreatedAt }: PhaseSummaryProps) {
  const historyMap = new Map(phaseHistory.map(h => [h.phase, h]));

  // Group mutations by phase via work_order.pipeline_phase
  const mutsByPhase: Record<string, Array<{ mutation: WOMutation; work_order: WorkOrder }>> = {};
  phases.forEach(p => { mutsByPhase[p] = []; });
  mutations.forEach(m => {
    const phase = m.work_order?.pipeline_phase;
    if (phase && mutsByPhase[phase]) {
      mutsByPhase[phase].push(m);
    }
  });

  const phaseStats: Record<string, PhaseStats> = {};
  phases.forEach(phase => {
    const wos = wosByPhase[phase] || [];
    const phaseMuts = mutsByPhase[phase] || [];
    const hist = historyMap.get(phase);

    const agents = [...new Set(phaseMuts.map(m => m.mutation?.agent_name).filter(Boolean))] as string[];

    const woTimestamps = wos.map(w => w.created_at).filter((t): t is string => !!t);
    const startedAt: string | null = woTimestamps.length ? woTimestamps.sort()[0] : null;
    const completedAt = hist?.completed_at || null;

    let durationMin: number | null = null;
    if (startedAt && completedAt) {
      durationMin = Math.round((new Date(completedAt).getTime() - new Date(startedAt).getTime()) / 60000);
    }

    phaseStats[phase] = {
      woCount: wos.length,
      wosDone: wos.filter(w => w.status === 'done').length,
      wosFailed: wos.filter(w => w.status === 'failed').length,
      totalMutations: phaseMuts.length,
      successMutations: phaseMuts.filter(m => m.mutation?.success === true || m.mutation?.status === 'success').length,
      failedMutations: phaseMuts.filter(m => m.mutation?.success === false || m.mutation?.status === 'failure').length,
      agents,
      startedAt,
      completedAt,
      durationMin,
    };
  });

  return (
    <div style={styles.grid}>
      {phases.map(phase => {
        const s = phaseStats[phase];
        const hist = historyMap.get(phase);
        const isCompleted = !!hist?.completed_at;
        const isSkipped = isCompleted && s.woCount === 0;
        const mutRate = s.totalMutations > 0 ? Math.round((s.successMutations / s.totalMutations) * 100) : null;

        return (
          <div key={phase} style={{
            ...styles.card,
            borderColor: isSkipped ? 'var(--status-warning)' : isCompleted ? 'var(--status-done)' : 'var(--border-default)',
            opacity: isSkipped ? 0.6 : 1,
          }}>
            <div style={styles.cardHeader}>
              <span style={styles.phaseName}>{phase.toUpperCase()}</span>
              {isSkipped ? (
                <span style={styles.skippedBadge}>SKIPPED</span>
              ) : isCompleted ? (
                <span style={styles.doneBadge}>DONE</span>
              ) : s.woCount > 0 ? (
                <span style={styles.activeBadge}>ACTIVE</span>
              ) : (
                <span style={styles.pendingBadge}>PENDING</span>
              )}
            </div>

            {isSkipped ? (
              <div style={styles.skippedMsg}>No execution manifest</div>
            ) : (
              <div style={styles.statsGrid}>
                <StatRow label="WOs" value={`${s.wosDone}/${s.woCount}`} sub={s.wosFailed > 0 ? `${s.wosFailed} failed` : undefined} color={s.wosFailed > 0 ? 'var(--status-error)' : undefined} />
                <StatRow label="Mutations" value={String(s.totalMutations)} sub={mutRate !== null ? `${mutRate}% pass` : undefined} color={mutRate !== null && mutRate < 80 ? 'var(--status-warning)' : undefined} />
                {s.agents.length > 0 && (
                  <StatRow label="Agents" value={String(s.agents.length)} sub={s.agents.join(', ')} />
                )}
                {s.durationMin !== null && (
                  <StatRow label="Duration" value={formatDuration(s.durationMin)} />
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function StatRow({ label, value, sub, color }: { label: string; value: string; sub?: string; color?: string }) {
  return (
    <div style={styles.statRow}>
      <span style={styles.statLabel}>{label}</span>
      <span style={{ ...styles.statValue, color: color || 'var(--text-primary)' }}>{value}</span>
      {sub && <span style={{ ...styles.statSub, color: color || 'var(--text-muted)' }}>{sub}</span>}
    </div>
  );
}

function formatDuration(min: number): string {
  if (min < 1) return '<1m';
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

const styles: Record<string, React.CSSProperties> = {
  grid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))',
    gap: 10,
  },
  card: {
    background: 'var(--bg-elevated)',
    border: '1px solid',
    borderRadius: 8,
    padding: '10px 12px',
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
  },
  cardHeader: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  phaseName: {
    fontSize: 11,
    fontWeight: 700,
    letterSpacing: '0.5px',
    color: 'var(--text-secondary)',
  },
  doneBadge: {
    fontSize: 9,
    fontWeight: 700,
    padding: '2px 6px',
    borderRadius: 3,
    background: 'rgba(34, 197, 94, 0.15)',
    color: '#22c55e',
  },
  activeBadge: {
    fontSize: 9,
    fontWeight: 700,
    padding: '2px 6px',
    borderRadius: 3,
    background: 'rgba(59, 130, 246, 0.15)',
    color: '#3b82f6',
  },
  pendingBadge: {
    fontSize: 9,
    fontWeight: 700,
    padding: '2px 6px',
    borderRadius: 3,
    background: 'rgba(100, 116, 139, 0.15)',
    color: '#64748b',
  },
  skippedBadge: {
    fontSize: 9,
    fontWeight: 700,
    padding: '2px 6px',
    borderRadius: 3,
    background: 'rgba(245, 158, 11, 0.15)',
    color: '#f59e0b',
  },
  skippedMsg: {
    fontSize: 11,
    color: 'var(--text-muted)',
    fontStyle: 'italic',
  },
  statsGrid: {
    display: 'flex',
    flexDirection: 'column',
    gap: 4,
  },
  statRow: {
    display: 'flex',
    alignItems: 'baseline',
    gap: 6,
    fontSize: 12,
  },
  statLabel: {
    color: 'var(--text-muted)',
    fontSize: 10,
    fontWeight: 600,
    textTransform: 'uppercase',
    letterSpacing: '0.3px',
    minWidth: 58,
  },
  statValue: {
    fontFamily: 'var(--font-mono)',
    fontWeight: 600,
    fontSize: 13,
  },
  statSub: {
    fontSize: 10,
    fontFamily: 'var(--font-mono)',
  },
};
