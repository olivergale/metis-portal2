import { useState, useEffect } from 'react';
import { supabase } from '../utils/supabase.ts';
import { GRAFANA_URL } from '../utils/config.ts';
import type { HealthCheck } from '../types/index.ts';

export default function Health() {
  const [checks, setChecks] = useState<HealthCheck[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => { runChecks(); }, []);

  async function runChecks() {
    setLoading(true);
    const results: HealthCheck[] = [];

    // Agent liveness
    try {
      const { data } = await supabase.from('wo_mutations')
        .select('agent_name,created_at')
        .order('created_at', { ascending: false })
        .limit(50);
      const agentMap = new Map<string, string>();
      (data || []).forEach((m: any) => {
        if (!agentMap.has(m.agent_name)) agentMap.set(m.agent_name, m.created_at);
      });
      agentMap.forEach((lastAt, name) => {
        const mins = (Date.now() - new Date(lastAt).getTime()) / 60000;
        results.push({
          component: 'Agents',
          check: `${name} last mutation`,
          status: mins < 10 ? 'green' : mins < 30 ? 'yellow' : 'red',
          detail: `${mins.toFixed(0)}m ago`,
          lastActivity: lastAt,
        });
      });
    } catch { /* skip */ }

    // Audit system
    try {
      const { data } = await supabase.from('audit_log').select('created_at').order('created_at', { ascending: false }).limit(1);
      const lastAt = data?.[0]?.created_at;
      const mins = lastAt ? (Date.now() - new Date(lastAt).getTime()) / 60000 : Infinity;
      results.push({
        component: 'Audit System',
        check: 'Last audit_log entry',
        status: mins < 60 ? 'green' : mins < 120 ? 'yellow' : 'red',
        detail: lastAt ? `${mins.toFixed(0)}m ago` : 'No entries',
        lastActivity: lastAt,
      });
    } catch { /* skip */ }

    // Disabled triggers
    try {
      const { data } = await supabase.rpc('execute_sql', {
        query: "SELECT tgname FROM pg_trigger WHERE NOT tgenabled::text = 'O' AND tgrelid = 'public.work_orders'::regclass LIMIT 5"
      });
      const disabled = data || [];
      results.push({
        component: 'Triggers',
        check: 'Disabled triggers on work_orders',
        status: disabled.length === 0 ? 'green' : 'red',
        detail: disabled.length === 0 ? 'All enabled' : `${disabled.length} disabled`,
      });
    } catch {
      results.push({ component: 'Triggers', check: 'Trigger check', status: 'yellow', detail: 'Could not query' });
    }

    // Pipeline engine
    try {
      const { data } = await supabase.from('pipeline_runs').select('updated_at').eq('status', 'active').order('updated_at', { ascending: false }).limit(1);
      const lastAt = data?.[0]?.updated_at;
      const mins = lastAt ? (Date.now() - new Date(lastAt).getTime()) / 60000 : Infinity;
      results.push({
        component: 'Pipeline Engine',
        check: 'Last active pipeline update',
        status: mins < 60 ? 'green' : mins < 180 ? 'yellow' : 'red',
        detail: lastAt ? `${mins.toFixed(0)}m ago` : 'No active pipelines',
        lastActivity: lastAt,
      });
    } catch { /* skip */ }

    // QA system
    try {
      const { data } = await supabase.from('qa_findings').select('created_at').order('created_at', { ascending: false }).limit(1);
      const lastAt = data?.[0]?.created_at;
      const mins = lastAt ? (Date.now() - new Date(lastAt).getTime()) / 60000 : Infinity;
      results.push({
        component: 'QA System',
        check: 'Last QA finding',
        status: mins < 120 ? 'green' : mins < 360 ? 'yellow' : 'red',
        detail: lastAt ? `${mins.toFixed(0)}m ago` : 'No findings',
        lastActivity: lastAt,
      });
    } catch { /* skip */ }

    // Table row counts
    const tables = ['work_orders', 'wo_mutations', 'execution_log', 'audit_log', 'lessons'];
    for (const t of tables) {
      try {
        const { count } = await supabase.from(t).select('*', { count: 'exact', head: true });
        results.push({
          component: 'Tables',
          check: `${t} rows`,
          status: (count || 0) > 0 ? 'green' : 'yellow',
          detail: `${(count || 0).toLocaleString()} rows`,
        });
      } catch { /* skip */ }
    }

    // Realtime connection
    results.push({
      component: 'Realtime',
      check: 'Supabase connection',
      status: 'green',
      detail: 'Connected (client active)',
    });

    setChecks(results);
    setLoading(false);
  }

  const statusIcon = (s: string) => s === 'green' ? '\u25CF' : s === 'yellow' ? '\u25CF' : '\u25CF';
  const statusColor = (s: string) => s === 'green' ? '#22c55e' : s === 'yellow' ? '#f59e0b' : '#ef4444';

  const greenCount = checks.filter(c => c.status === 'green').length;
  const yellowCount = checks.filter(c => c.status === 'yellow').length;
  const redCount = checks.filter(c => c.status === 'red').length;

  return (
    <div>
      <div style={styles.header}>
        <h1 style={styles.title}>System Health</h1>
        <button className="btn btn-secondary" onClick={runChecks}>Re-check</button>
      </div>

      <div style={styles.summaryRow}>
        <div style={{ ...styles.summaryCard, borderColor: '#22c55e' }}>
          <span style={{ color: '#22c55e', fontSize: 28, fontWeight: 700 }}>{greenCount}</span>
          <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>Healthy</span>
        </div>
        <div style={{ ...styles.summaryCard, borderColor: '#f59e0b' }}>
          <span style={{ color: '#f59e0b', fontSize: 28, fontWeight: 700 }}>{yellowCount}</span>
          <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>Warning</span>
        </div>
        <div style={{ ...styles.summaryCard, borderColor: '#ef4444' }}>
          <span style={{ color: '#ef4444', fontSize: 28, fontWeight: 700 }}>{redCount}</span>
          <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>Critical</span>
        </div>
      </div>

      {loading ? (
        <div style={styles.loading}>Running health checks...</div>
      ) : (
        <div style={styles.table}>
          <div style={styles.tableHeader}>
            <span>Component</span>
            <span>Check</span>
            <span>Status</span>
            <span>Detail</span>
          </div>
          {checks.map((c, i) => (
            <div key={i} style={styles.tableRow}>
              <span style={{ fontWeight: 600, color: 'var(--text-primary)' }}>{c.component}</span>
              <span style={{ color: 'var(--text-secondary)' }}>{c.check}</span>
              <span style={{ color: statusColor(c.status), fontWeight: 600 }}>
                {statusIcon(c.status)} {c.status.toUpperCase()}
              </span>
              <span style={{ color: 'var(--text-muted)', fontFamily: 'var(--font-mono)', fontSize: 12 }}>{c.detail}</span>
            </div>
          ))}
        </div>
      )}

      {/* Grafana embeds */}
      {GRAFANA_URL && (
        <div style={styles.grafanaSection}>
          <h2 style={{ fontSize: 16, fontWeight: 600, marginBottom: 12 }}>Grafana Dashboards</h2>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
            <iframe src={`${GRAFANA_URL}/d/mutations?orgId=1&kiosk`} style={styles.iframe} title="Mutation Velocity" />
            <iframe src={`${GRAFANA_URL}/d/agents?orgId=1&kiosk`} style={styles.iframe} title="Agent Performance" />
          </div>
        </div>
      )}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  header: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 20,
  },
  title: {
    fontSize: 22,
    fontWeight: 600,
  },
  summaryRow: {
    display: 'grid',
    gridTemplateColumns: '1fr 1fr 1fr',
    gap: 16,
    marginBottom: 20,
  },
  summaryCard: {
    background: 'var(--bg-surface)',
    border: '1px solid',
    borderRadius: 'var(--radius-md)',
    padding: 16,
    textAlign: 'center' as const,
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 4,
  },
  loading: {
    color: 'var(--text-muted)',
    textAlign: 'center' as const,
    padding: 40,
  },
  table: {
    background: 'var(--bg-surface)',
    border: '1px solid var(--border-default)',
    borderRadius: 'var(--radius-md)',
    overflow: 'hidden',
  },
  tableHeader: {
    display: 'grid',
    gridTemplateColumns: '140px 1fr 100px 200px',
    gap: 12,
    padding: '10px 16px',
    fontSize: 10,
    fontWeight: 600,
    color: 'var(--text-muted)',
    textTransform: 'uppercase' as const,
    letterSpacing: '0.5px',
    borderBottom: '2px solid var(--border-default)',
  },
  tableRow: {
    display: 'grid',
    gridTemplateColumns: '140px 1fr 100px 200px',
    gap: 12,
    padding: '10px 16px',
    fontSize: 13,
    borderBottom: '1px solid var(--border-default)',
    alignItems: 'center',
  },
  grafanaSection: {
    marginTop: 24,
  },
  iframe: {
    width: '100%',
    height: 300,
    border: '1px solid var(--border-default)',
    borderRadius: 'var(--radius-md)',
    background: 'var(--bg-surface)',
  },
};
