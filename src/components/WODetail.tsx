import { useState, useEffect } from 'react';
import StatusBadge from './StatusBadge.tsx';
import { apiFetch, relativeTime } from '../utils/api.ts';
import type { WorkOrder, ExecutionLogEntry, QAFinding, WOMutation } from '../types/index.ts';

interface WODetailProps {
  wo: WorkOrder;
  onClose?: () => void;
}

export default function WODetail({ wo, onClose }: WODetailProps) {
  const [execLog, setExecLog] = useState<ExecutionLogEntry[]>([]);
  const [mutations, setMutations] = useState<WOMutation[]>([]);
  const [findings, setFindings] = useState<QAFinding[]>([]);
  const [activeTab, setActiveTab] = useState<'info' | 'log' | 'mutations' | 'qa'>('info');

  useEffect(() => {
    Promise.all([
      apiFetch<ExecutionLogEntry[]>(`/rest/v1/work_order_execution_log?work_order_id=eq.${wo.id}&order=created_at.asc&limit=100`),
      apiFetch<WOMutation[]>(`/rest/v1/wo_mutations?work_order_id=eq.${wo.id}&order=created_at.desc&limit=100`),
      apiFetch<QAFinding[]>(`/rest/v1/qa_findings?work_order_id=eq.${wo.id}&order=created_at.desc&limit=50`),
    ]).then(([log, mut, qa]) => {
      setExecLog(log || []);
      setMutations(mut || []);
      setFindings(qa || []);
    });
  }, [wo.id]);

  const successMut = mutations.filter(m => m.status === 'success').length;
  const failMut = mutations.filter(m => m.status === 'failure').length;

  const tabs = [
    { id: 'info' as const, label: 'Details' },
    { id: 'log' as const, label: `Log (${execLog.length})` },
    { id: 'mutations' as const, label: `Mutations (${successMut}/${mutations.length})` },
    { id: 'qa' as const, label: `QA (${findings.length})` },
  ];

  return (
    <div style={styles.panel}>
      <div style={styles.header}>
        <div>
          <div style={styles.slugRow}>
            <span style={styles.slug}>{wo.slug}</span>
            <StatusBadge status={wo.status} />
            <span style={styles.priority}>{wo.priority.replace('_', ' ')}</span>
          </div>
          <div style={styles.name}>{wo.name}</div>
        </div>
        {onClose && <button onClick={onClose} style={styles.closeBtn}>&times;</button>}
      </div>

      <div style={styles.tabs}>
        {tabs.map(t => (
          <button key={t.id} onClick={() => setActiveTab(t.id)} style={{
            ...styles.tab,
            ...(activeTab === t.id ? styles.tabActive : {}),
          }}>{t.label}</button>
        ))}
      </div>

      <div style={styles.content}>
        {activeTab === 'info' && <InfoTab wo={wo} />}
        {activeTab === 'log' && <LogTab entries={execLog} />}
        {activeTab === 'mutations' && <MutationTab mutations={mutations} />}
        {activeTab === 'qa' && <QATab findings={findings} checklist={wo.qa_checklist} />}
      </div>
    </div>
  );
}

function InfoTab({ wo }: { wo: WorkOrder }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <Field label="Objective" value={wo.objective} />
      <Field label="Acceptance Criteria" value={wo.acceptance_criteria} mono />
      <Field label="Summary" value={wo.summary} />
      <Field label="Agent" value={wo.assigned_to} />
      <Field label="Created" value={relativeTime(wo.created_at)} />
      {wo.parent_id && <Field label="Parent" value={wo.parent_id} mono />}
    </div>
  );
}

function Field({ label, value, mono }: { label: string; value?: string | null; mono?: boolean }) {
  return (
    <div>
      <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 2, textTransform: 'uppercase' as const }}>{label}</div>
      <div style={{
        fontSize: 13,
        color: value ? 'var(--text-secondary)' : 'var(--text-muted)',
        whiteSpace: 'pre-wrap',
        fontFamily: mono ? 'var(--font-mono)' : 'inherit',
        lineHeight: 1.6,
      }}>{value || 'N/A'}</div>
    </div>
  );
}

function LogTab({ entries }: { entries: ExecutionLogEntry[] }) {
  if (!entries.length) return <Empty text="No execution log entries" />;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      {entries.map(e => (
        <div key={e.id} style={styles.logEntry}>
          <span style={{ ...styles.logPhase, color: e.phase === 'failed' ? 'var(--status-error)' : 'var(--accent)' }}>{e.phase}</span>
          <span style={styles.logAgent}>{e.agent_name}</span>
          <span style={styles.logDetail}>{extractDetail(e.detail)}</span>
          <span style={styles.logTime}>{fmtTime(e.created_at)}</span>
        </div>
      ))}
    </div>
  );
}

function MutationTab({ mutations }: { mutations: WOMutation[] }) {
  if (!mutations.length) return <Empty text="No mutations recorded" />;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      {mutations.map(m => (
        <div key={m.id} style={styles.logEntry}>
          <span style={{
            ...styles.logPhase,
            color: m.status === 'success' ? 'var(--status-success)' : 'var(--status-error)',
          }}>{m.status}</span>
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--accent)' }}>{m.tool_name}</span>
          <span style={styles.logDetail}>{m.action}{m.target_object ? ` on ${m.target_object}` : ''}</span>
          <span style={styles.logTime}>{fmtTime(m.created_at)}</span>
        </div>
      ))}
    </div>
  );
}

function QATab({ findings, checklist }: { findings: QAFinding[]; checklist: any[] }) {
  const passed = (checklist || []).filter((i: any) => i.status === 'pass').length;
  const total = (checklist || []).length;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {total > 0 && (
        <div>
          <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 8, color: 'var(--text-primary)' }}>
            Checklist ({passed}/{total})
          </div>
          {checklist.map((item: any, idx: number) => (
            <div key={idx} style={{ display: 'flex', gap: 8, padding: '4px 0', fontSize: 13 }}>
              <span>{item.status === 'pass' ? '\u2705' : item.status === 'fail' ? '\u274C' : '\u23F3'}</span>
              <span style={{ color: 'var(--text-secondary)' }}>{item.criterion || item.id || 'Unknown'}</span>
            </div>
          ))}
        </div>
      )}
      {findings.length > 0 && (
        <div>
          <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 8, color: 'var(--text-primary)' }}>
            Findings ({findings.length})
          </div>
          {findings.map(f => (
            <div key={f.id} style={{ padding: '8px', background: 'var(--bg-elevated)', borderRadius: 4, marginBottom: 4 }}>
              <div style={{ display: 'flex', gap: 8, marginBottom: 4 }}>
                <StatusBadge status={f.finding_type} />
                <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{f.category}</span>
              </div>
              <div style={{ fontSize: 13, color: 'var(--text-secondary)' }}>{f.description}</div>
            </div>
          ))}
        </div>
      )}
      {!total && !findings.length && <Empty text="No QA data" />}
    </div>
  );
}

function Empty({ text }: { text: string }) {
  return <div style={{ color: 'var(--text-muted)', textAlign: 'center', padding: 24, fontSize: 13 }}>{text}</div>;
}

function extractDetail(detail: any): string {
  if (!detail) return '';
  if (typeof detail === 'string') return detail;
  if (detail.content) return String(detail.content);
  if (detail.tool_name) return `[${detail.tool_name}] ${detail.message || detail.result || ''}`;
  if (detail.message) return String(detail.message);
  if (detail.summary) return String(detail.summary);
  return JSON.stringify(detail).slice(0, 200);
}

function fmtTime(iso: string): string {
  if (!iso) return '';
  return new Date(iso).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', timeZone: 'America/Los_Angeles' });
}

const styles: Record<string, React.CSSProperties> = {
  panel: {
    background: 'var(--bg-surface)',
    border: '1px solid var(--border-default)',
    borderRadius: 'var(--radius-md)',
    overflow: 'hidden',
  },
  header: {
    padding: '16px 20px',
    borderBottom: '1px solid var(--border-default)',
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
  },
  slugRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    marginBottom: 4,
  },
  slug: {
    fontFamily: 'var(--font-mono)',
    fontSize: 13,
    fontWeight: 600,
    color: 'var(--accent)',
  },
  priority: {
    fontSize: 11,
    color: 'var(--text-muted)',
    textTransform: 'uppercase' as const,
  },
  name: {
    fontSize: 15,
    fontWeight: 500,
    color: 'var(--text-primary)',
  },
  closeBtn: {
    fontSize: 20,
    color: 'var(--text-muted)',
    padding: '0 4px',
    lineHeight: 1,
  },
  tabs: {
    display: 'flex',
    borderBottom: '1px solid var(--border-default)',
    padding: '0 16px',
  },
  tab: {
    padding: '10px 16px',
    fontSize: 12,
    fontWeight: 500,
    color: 'var(--text-muted)',
    borderBottom: '2px solid transparent',
    transition: 'all 0.15s',
  },
  tabActive: {
    color: 'var(--accent)',
    borderBottomColor: 'var(--accent)',
  },
  content: {
    padding: 20,
    maxHeight: 500,
    overflowY: 'auto' as const,
  },
  logEntry: {
    display: 'grid',
    gridTemplateColumns: '80px 80px 1fr 70px',
    gap: 8,
    padding: '6px 0',
    borderBottom: '1px solid var(--border-default)',
    fontSize: 12,
    alignItems: 'center',
  },
  logPhase: {
    fontWeight: 600,
    fontSize: 11,
    textTransform: 'uppercase' as const,
  },
  logAgent: {
    fontSize: 11,
    color: 'var(--text-muted)',
  },
  logDetail: {
    color: 'var(--text-secondary)',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap' as const,
  },
  logTime: {
    fontSize: 10,
    color: 'var(--text-muted)',
    fontFamily: 'var(--font-mono)',
    textAlign: 'right' as const,
  },
};
