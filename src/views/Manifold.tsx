import { useState, useCallback } from 'react';
import { usePipelines, usePipelineDetail } from '../hooks/usePipelines.ts';
import { useWorkOrders } from '../hooks/useWorkOrders.ts';
import { useRealtimeMulti } from '../hooks/useRealtime.ts';
import { apiFetch, relativeTime } from '../utils/api.ts';
import MetricCard from '../components/MetricCard.tsx';
import PhaseTrack from '../components/PhaseTrack.tsx';
import WOCard from '../components/WOCard.tsx';
import WODetail from '../components/WODetail.tsx';
import StatusBadge from '../components/StatusBadge.tsx';
import ActivityStream, { type ActivityEvent } from '../components/ActivityStream.tsx';
import PhaseSummary from '../components/PhaseSummary.tsx';
import type { PipelineRun, WorkOrder } from '../types/index.ts';

const PHASES = ['spec', 'plan', 'scaffold', 'build', 'verify', 'harden', 'integrate'];

export default function Manifold() {
  const { pipelines, loading } = usePipelines();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedWO, setSelectedWO] = useState<WorkOrder | null>(null);
  const [filter, setFilter] = useState<'all' | 'active' | 'completed' | 'failed'>('all');
  const [activityEvents, setActivityEvents] = useState<ActivityEvent[]>([]);

  const { detail, loading: detailLoading } = usePipelineDetail(selectedId);
  const { workOrders } = useWorkOrders(selectedId || undefined);

  // Live activity feed
  const handleRealtime = useCallback((table: string, payload: any) => {
    const record = payload.new || payload.old || {};
    const eventType = payload.eventType || 'UNKNOWN';
    let summary = '';

    if (table === 'work_orders') {
      summary = eventType === 'INSERT' ? `New WO: ${record.slug}` : `${record.slug} \u2192 ${record.status}`;
    } else if (table === 'wo_mutations') {
      summary = `${record.tool_name} \u2192 ${record.action}`;
    } else if (table === 'pipeline_runs') {
      summary = eventType === 'INSERT' ? `New pipeline: ${record.target}` : `${record.target} in ${record.current_phase}`;
    } else {
      summary = `${eventType} on ${table}`;
    }

    setActivityEvents(prev => [{
      id: `${Date.now()}-${Math.random()}`,
      timestamp: new Date().toISOString(),
      table,
      eventType,
      summary,
    }, ...prev].slice(0, 100));
  }, []);

  useRealtimeMulti(['pipeline_runs', 'work_orders', 'wo_mutations', 'wo_events'], handleRealtime);

  const filtered = pipelines.filter(p => {
    if (filter === 'active') return p.status === 'active';
    if (filter === 'completed') return p.status === 'completed';
    if (filter === 'failed') return p.status === 'failed';
    return true;
  });

  const stats = {
    total: pipelines.length,
    active: pipelines.filter(p => p.status === 'active').length,
    completed: pipelines.filter(p => p.status === 'completed').length,
    failed: pipelines.filter(p => p.status === 'failed').length,
  };

  const selected = pipelines.find(p => p.id === selectedId);
  const phaseHistory: Array<{ phase: string; wo_id?: string; completed_at?: string }> = selected?.phase_history || [];
  const completedPhases = phaseHistory.map(h => h.phase);
  const detailMutations = detail?.mutations || [];

  // Group WOs by phase — detail.phase_wos is keyed by phase name, fallback to workOrders list
  const wosByPhase: Record<string, WorkOrder[]> = {};
  PHASES.forEach(p => { wosByPhase[p] = []; });
  const detailPhaseWOs = detail?.phase_wos || {};
  if (typeof detailPhaseWOs === 'object' && !Array.isArray(detailPhaseWOs)) {
    Object.entries(detailPhaseWOs).forEach(([phase, wos]) => {
      if (wosByPhase[phase]) wosByPhase[phase] = wos as WorkOrder[];
    });
  }
  // Also merge in workOrders from the hook (live-updated)
  workOrders.forEach(wo => {
    if (wo.pipeline_phase && wosByPhase[wo.pipeline_phase]) {
      const existing = wosByPhase[wo.pipeline_phase];
      if (!existing.find(w => w.id === wo.id)) {
        existing.push(wo);
      }
    }
  });

  async function intervene(action: string) {
    if (!selectedId) return;
    if (!confirm(`Are you sure you want to ${action.replace('_', ' ')} this pipeline?`)) return;
    try {
      await apiFetch('/rest/v1/rpc/intervene_pipeline', 'POST', { p_pipeline_run_id: selectedId, p_action: action });
    } catch (e) {
      console.error('Intervention failed:', e);
    }
  }

  return (
    <div>
      <div style={styles.topBar}>
        <h1 style={styles.title}>Pipeline Command Center</h1>
        <button className="btn btn-primary" onClick={() => {
          const target = prompt('Pipeline target name:');
          if (!target) return;
          const desc = prompt('Description:') || '';
          apiFetch('/rest/v1/rpc/create_pipeline', 'POST', { p_target: target, p_description: desc });
        }}>+ New Pipeline</button>
      </div>

      <div style={styles.statsRow}>
        <MetricCard label="Total" value={stats.total} />
        <MetricCard label="Active" value={stats.active} color="var(--accent)" />
        <MetricCard label="Completed" value={stats.completed} color="var(--status-success)" />
        <MetricCard label="Failed" value={stats.failed} color="var(--status-error)" />
      </div>

      <div style={styles.mainGrid}>
        {/* Pipeline list sidebar */}
        <div style={styles.listPanel}>
          <div style={styles.filterRow}>
            {(['all', 'active', 'completed', 'failed'] as const).map(f => (
              <button key={f} onClick={() => setFilter(f)} style={{
                ...styles.filterBtn,
                ...(filter === f ? styles.filterBtnActive : {}),
              }}>{f}</button>
            ))}
          </div>
          {loading ? (
            <div style={styles.empty}>Loading pipelines...</div>
          ) : !filtered.length ? (
            <div style={styles.empty}>No pipelines found</div>
          ) : (
            <div style={styles.pipelineList}>
              {filtered.map(p => (
                <PipelineCard key={p.id} pipeline={p} selected={p.id === selectedId} onClick={() => setSelectedId(p.id)} />
              ))}
            </div>
          )}
        </div>

        {/* Pipeline detail */}
        <div style={styles.detailPanel}>
          {!selected ? (
            <div style={styles.empty}>Select a pipeline to view details</div>
          ) : detailLoading ? (
            <div style={styles.empty}>Loading...</div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
              <div style={styles.detailHeader}>
                <div>
                  <h2 style={styles.detailTitle}>{selected.target}</h2>
                  <p style={{ fontSize: 13, color: 'var(--text-secondary)', marginTop: 4 }}>{selected.description}</p>
                </div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <StatusBadge status={selected.status} />
                  <StatusBadge status={selected.current_phase} />
                </div>
              </div>

              <div>
                <h3 style={styles.sectionTitle}>Phase Progress</h3>
                <PhaseTrack currentPhase={selected.current_phase} completedPhases={completedPhases} status={selected.status} />
              </div>

              {/* Phase summary stats */}
              <div>
                <h3 style={styles.sectionTitle}>Phase Summary</h3>
                <PhaseSummary
                  phases={PHASES}
                  phaseHistory={phaseHistory}
                  wosByPhase={wosByPhase}
                  mutations={detailMutations}
                  pipelineCreatedAt={selected.created_at}
                />
              </div>

              {/* Per-phase WO cards */}
              <div>
                <h3 style={styles.sectionTitle}>Work Orders by Phase</h3>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                  {PHASES.map(phase => {
                    const wos = wosByPhase[phase];
                    const isSkipped = completedPhases.includes(phase) && !wos.length;
                    return (
                      <div key={phase}>
                        <div style={styles.phaseHeader}>
                          <span style={{ fontSize: 12, fontWeight: 600, textTransform: 'uppercase', color: 'var(--text-muted)' }}>{phase}</span>
                          {isSkipped && <span style={styles.skippedBadge}>AUTO-SKIPPED</span>}
                          <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{wos.length} WO{wos.length !== 1 ? 's' : ''}</span>
                        </div>
                        {wos.map(wo => (
                          <WOCard key={wo.id} wo={wo} onClick={() => setSelectedWO(wo)} />
                        ))}
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* Intervention controls */}
              <div>
                <h3 style={styles.sectionTitle}>Intervene</h3>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button className="btn btn-warning" onClick={() => intervene('pause')}>Pause</button>
                  <button className="btn btn-success" onClick={() => intervene('resume')}>Resume</button>
                  <button className="btn btn-secondary" onClick={() => intervene('skip_phase')}>Skip Phase</button>
                  <button className="btn btn-secondary" onClick={() => intervene('restart_phase')}>Restart Phase</button>
                </div>
              </div>

              <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                Created: {relativeTime(selected.created_at)} | Updated: {relativeTime(selected.updated_at)}
                {selected.completed_at && <> | Completed: {relativeTime(selected.completed_at)}</>}
              </div>
            </div>
          )}
        </div>

        {/* Activity stream */}
        <div style={styles.activityPanel}>
          <h3 style={styles.sectionTitle}>Live Activity</h3>
          <ActivityStream events={activityEvents} maxHeight={600} />
        </div>
      </div>

      {/* WO Detail modal */}
      {selectedWO && (
        <div style={styles.modal} onClick={() => setSelectedWO(null)}>
          <div style={styles.modalInner} onClick={e => e.stopPropagation()}>
            <WODetail wo={selectedWO} onClose={() => setSelectedWO(null)} />
          </div>
        </div>
      )}
    </div>
  );
}

function PipelineCard({ pipeline, selected, onClick }: { pipeline: PipelineRun; selected: boolean; onClick: () => void }) {
  return (
    <div onClick={onClick} style={{
      ...pcStyles.card,
      borderColor: selected ? 'var(--accent)' : 'var(--border-default)',
      background: selected ? 'var(--bg-hover)' : 'var(--bg-elevated)',
    }}>
      <div style={pcStyles.header}>
        <span style={pcStyles.target}>{pipeline.target}</span>
        <StatusBadge status={pipeline.status} />
      </div>
      <div style={pcStyles.meta}>
        <span>Phase: {pipeline.current_phase}</span>
        <span>{relativeTime(pipeline.updated_at)}</span>
      </div>
    </div>
  );
}

const pcStyles: Record<string, React.CSSProperties> = {
  card: {
    padding: '10px 14px',
    borderRadius: 6,
    border: '1px solid',
    cursor: 'pointer',
    transition: 'all 0.15s',
  },
  header: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 6,
  },
  target: {
    fontWeight: 600,
    fontSize: 13,
    color: 'var(--text-primary)',
  },
  meta: {
    display: 'flex',
    justifyContent: 'space-between',
    fontSize: 11,
    color: 'var(--text-muted)',
  },
};

const styles: Record<string, React.CSSProperties> = {
  topBar: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 20,
  },
  title: {
    fontSize: 22,
    fontWeight: 600,
  },
  statsRow: {
    display: 'grid',
    gridTemplateColumns: 'repeat(4, 1fr)',
    gap: 16,
    marginBottom: 20,
  },
  mainGrid: {
    display: 'grid',
    gridTemplateColumns: '280px 1fr 300px',
    gap: 20,
  },
  listPanel: {
    background: 'var(--bg-surface)',
    border: '1px solid var(--border-default)',
    borderRadius: 'var(--radius-md)',
    padding: 16,
    maxHeight: 'calc(100vh - 260px)',
    overflowY: 'auto' as const,
  },
  filterRow: {
    display: 'flex',
    gap: 4,
    marginBottom: 12,
  },
  filterBtn: {
    padding: '4px 10px',
    borderRadius: 4,
    fontSize: 11,
    fontWeight: 500,
    color: 'var(--text-muted)',
    textTransform: 'capitalize' as const,
  },
  filterBtnActive: {
    background: 'var(--accent-subtle)',
    color: 'var(--accent)',
  },
  pipelineList: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 8,
  },
  detailPanel: {
    background: 'var(--bg-surface)',
    border: '1px solid var(--border-default)',
    borderRadius: 'var(--radius-md)',
    padding: 20,
    maxHeight: 'calc(100vh - 260px)',
    overflowY: 'auto' as const,
  },
  activityPanel: {
    background: 'var(--bg-surface)',
    border: '1px solid var(--border-default)',
    borderRadius: 'var(--radius-md)',
    padding: 16,
    maxHeight: 'calc(100vh - 260px)',
    overflowY: 'auto' as const,
  },
  empty: {
    color: 'var(--text-muted)',
    textAlign: 'center' as const,
    padding: 32,
    fontSize: 13,
  },
  detailHeader: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
  },
  detailTitle: {
    fontSize: 18,
    fontWeight: 600,
  },
  sectionTitle: {
    fontSize: 13,
    fontWeight: 600,
    textTransform: 'uppercase' as const,
    letterSpacing: '0.5px',
    color: 'var(--text-secondary)',
    marginBottom: 8,
  },
  phaseHeader: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    marginBottom: 6,
    paddingBottom: 4,
    borderBottom: '1px solid var(--border-default)',
  },
  skippedBadge: {
    fontSize: 10,
    fontWeight: 700,
    padding: '2px 6px',
    borderRadius: 4,
    background: 'rgba(245,158,11,0.15)',
    color: '#f59e0b',
  },
  modal: {
    position: 'fixed' as const,
    inset: 0,
    background: 'rgba(0,0,0,0.5)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 100,
  },
  modalInner: {
    width: '90%',
    maxWidth: 800,
    maxHeight: '85vh',
    overflowY: 'auto' as const,
  },
};
