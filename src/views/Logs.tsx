import { useState, useEffect, useCallback } from 'react';
import { supabase } from '../utils/supabase.ts';
import LogEntry from '../components/LogEntry.tsx';
import type { UnifiedLogEntry, LogType } from '../types/index.ts';

type TimeRange = '1h' | '6h' | '24h' | '7d';

export default function Logs() {
  const [entries, setEntries] = useState<UnifiedLogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [agentFilter, setAgentFilter] = useState('');
  const [woFilter, setWoFilter] = useState('');
  const [typeFilter, setTypeFilter] = useState<LogType | ''>('');
  const [statusFilter, setStatusFilter] = useState<'all' | 'success' | 'failure'>('all');
  const [timeRange, setTimeRange] = useState<TimeRange>('24h');

  const load = useCallback(async () => {
    setLoading(true);
    const now = new Date();
    const hours = timeRange === '1h' ? 1 : timeRange === '6h' ? 6 : timeRange === '24h' ? 24 : 168;
    const since = new Date(now.getTime() - hours * 3600000).toISOString();

    const unified: UnifiedLogEntry[] = [];

    // Fetch all four sources in parallel
    const sources = typeFilter ? [typeFilter] : ['execution', 'mutation', 'event', 'audit'];

    const promises = sources.map(async (source) => {
      try {
        if (source === 'execution') {
          let q = supabase.from('work_order_execution_log')
            .select('id,work_order_id,phase,agent_name,detail,created_at')
            .gte('created_at', since)
            .order('created_at', { ascending: false })
            .limit(200);
          if (agentFilter) q = q.eq('agent_name', agentFilter);
          const { data } = await q;
          return (data || []).map((e: any) => ({
            id: e.id,
            timestamp: e.created_at,
            source: 'execution' as const,
            agent: e.agent_name,
            woId: e.work_order_id,
            level: e.phase === 'failed' ? 'error' as const : 'info' as const,
            message: extractExecDetail(e.detail),
            detail: e.detail,
          }));
        }
        if (source === 'mutation') {
          let q = supabase.from('wo_mutations')
            .select('id,work_order_id,tool_name,action,status,error_message,agent_name,created_at')
            .gte('created_at', since)
            .order('created_at', { ascending: false })
            .limit(200);
          if (agentFilter) q = q.eq('agent_name', agentFilter);
          if (statusFilter === 'success') q = q.eq('status', 'success');
          if (statusFilter === 'failure') q = q.eq('status', 'failure');
          const { data } = await q;
          return (data || []).map((m: any) => ({
            id: m.id,
            timestamp: m.created_at,
            source: 'mutation' as const,
            agent: m.agent_name,
            woId: m.work_order_id,
            level: m.status === 'failure' ? 'error' as const : 'success' as const,
            message: `${m.tool_name} \u2192 ${m.action}${m.error_message ? ` [${m.error_message}]` : ''}`,
            detail: m.error_message ? { error: m.error_message } : undefined,
          }));
        }
        if (source === 'event') {
          let q = supabase.from('wo_events')
            .select('id,work_order_id,event_type,previous_status,new_status,actor,payload,created_at')
            .gte('created_at', since)
            .order('created_at', { ascending: false })
            .limit(200);
          const { data } = await q;
          return (data || []).map((ev: any) => ({
            id: ev.id,
            timestamp: ev.created_at,
            source: 'event' as const,
            agent: ev.actor,
            woId: ev.work_order_id,
            level: ev.new_status === 'failed' ? 'error' as const : 'info' as const,
            message: `${ev.event_type}${ev.previous_status ? ` (${ev.previous_status} \u2192 ${ev.new_status})` : ''}`,
            detail: ev.payload,
          }));
        }
        if (source === 'audit') {
          let q = supabase.from('audit_log')
            .select('id,event_type,target_type,target_id,payload,created_at')
            .gte('created_at', since)
            .order('created_at', { ascending: false })
            .limit(200);
          const { data } = await q;
          return (data || []).map((a: any) => ({
            id: a.id,
            timestamp: a.created_at,
            source: 'audit' as const,
            level: 'info' as const,
            message: `${a.event_type}: ${a.target_type}/${a.target_id}`,
            detail: a.payload,
          }));
        }
        return [];
      } catch {
        return [];
      }
    });

    const results = await Promise.all(promises);
    results.forEach(r => unified.push(...r));

    // Enrich with WO slugs
    const woIds = [...new Set(unified.filter(e => e.woId).map(e => e.woId!))];
    if (woIds.length > 0 && woIds.length <= 100) {
      const { data: wos } = await supabase.from('work_orders').select('id,slug').in('id', woIds);
      const slugMap = new Map((wos || []).map((w: any) => [w.id, w.slug]));
      unified.forEach(e => { if (e.woId) e.woSlug = slugMap.get(e.woId); });
    }

    // Filter by WO slug if set
    let final = unified;
    if (woFilter) {
      final = final.filter(e => e.woSlug?.toLowerCase().includes(woFilter.toLowerCase()));
    }

    // Sort by timestamp descending
    final.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
    setEntries(final.slice(0, 500));
    setLoading(false);
  }, [agentFilter, woFilter, typeFilter, statusFilter, timeRange]);

  useEffect(() => { load(); }, [load]);

  return (
    <div>
      <h1 style={styles.title}>Unified Log Viewer</h1>

      <div style={styles.filterBar}>
        <input placeholder="Agent name" value={agentFilter} onChange={e => setAgentFilter(e.target.value)} style={styles.input} />
        <input placeholder="WO slug" value={woFilter} onChange={e => setWoFilter(e.target.value)} style={styles.input} />
        <select value={typeFilter} onChange={e => setTypeFilter(e.target.value as any)} style={styles.select}>
          <option value="">All types</option>
          <option value="execution">Execution</option>
          <option value="mutation">Mutation</option>
          <option value="event">Event</option>
          <option value="audit">Audit</option>
        </select>
        <select value={statusFilter} onChange={e => setStatusFilter(e.target.value as any)} style={styles.select}>
          <option value="all">All status</option>
          <option value="success">Success</option>
          <option value="failure">Failure</option>
        </select>
        <select value={timeRange} onChange={e => setTimeRange(e.target.value as TimeRange)} style={styles.select}>
          <option value="1h">Last 1h</option>
          <option value="6h">Last 6h</option>
          <option value="24h">Last 24h</option>
          <option value="7d">Last 7d</option>
        </select>
        <button className="btn btn-secondary" onClick={load}>Refresh</button>
      </div>

      {/* Column headers */}
      <div style={styles.colHeaders}>
        <span>Time (PT)</span>
        <span>Source</span>
        <span>Agent</span>
        <span>WO</span>
        <span>Level</span>
        <span>Message</span>
        <span></span>
      </div>

      <div style={styles.logContainer}>
        {loading ? (
          <div style={styles.empty}>Loading logs...</div>
        ) : !entries.length ? (
          <div style={styles.empty}>No log entries found</div>
        ) : (
          entries.map(e => <LogEntry key={e.id} entry={e} />)
        )}
      </div>

      <div style={styles.footer}>
        {entries.length} entries shown
      </div>
    </div>
  );
}

function extractExecDetail(detail: any): string {
  if (!detail) return '';
  if (typeof detail === 'string') return detail;
  if (detail.content) return String(detail.content);
  if (detail.tool_name) return `[${detail.tool_name}] ${detail.message || detail.result || ''}`;
  if (detail.message) return String(detail.message);
  return JSON.stringify(detail).slice(0, 200);
}

const styles: Record<string, React.CSSProperties> = {
  title: {
    fontSize: 22,
    fontWeight: 600,
    marginBottom: 16,
  },
  filterBar: {
    display: 'flex',
    gap: 8,
    marginBottom: 12,
    flexWrap: 'wrap' as const,
  },
  input: {
    width: 140,
  },
  select: {
    minWidth: 120,
  },
  colHeaders: {
    display: 'grid',
    gridTemplateColumns: '80px 80px 80px 100px 70px 1fr 20px',
    gap: 8,
    padding: '8px 12px',
    fontSize: 10,
    fontWeight: 600,
    color: 'var(--text-muted)',
    textTransform: 'uppercase' as const,
    letterSpacing: '0.5px',
    borderBottom: '2px solid var(--border-default)',
    background: 'var(--bg-surface)',
    borderRadius: '8px 8px 0 0',
  },
  logContainer: {
    background: 'var(--bg-surface)',
    border: '1px solid var(--border-default)',
    borderRadius: '0 0 8px 8px',
    maxHeight: 'calc(100vh - 280px)',
    overflowY: 'auto' as const,
  },
  empty: {
    color: 'var(--text-muted)',
    textAlign: 'center' as const,
    padding: 32,
    fontSize: 13,
  },
  footer: {
    marginTop: 8,
    fontSize: 11,
    color: 'var(--text-muted)',
    textAlign: 'right' as const,
  },
};
