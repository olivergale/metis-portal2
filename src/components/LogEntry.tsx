import { useState } from 'react';
import StatusBadge from './StatusBadge.tsx';
import type { UnifiedLogEntry } from '../types/index.ts';

interface LogEntryProps {
  entry: UnifiedLogEntry;
}

export default function LogEntry({ entry }: LogEntryProps) {
  const [expanded, setExpanded] = useState(false);

  const sourceColors: Record<string, string> = {
    execution: 'var(--accent)',
    mutation: '#a78bfa',
    event: '#22c55e',
    audit: '#f59e0b',
  };

  return (
    <div style={styles.row} onClick={() => entry.detail && setExpanded(!expanded)}>
      <span style={styles.time}>
        {new Date(entry.timestamp).toLocaleTimeString('en-US', {
          hour: '2-digit', minute: '2-digit', second: '2-digit', timeZone: 'America/Los_Angeles'
        })}
      </span>
      <span style={{ ...styles.source, color: sourceColors[entry.source] || 'var(--text-muted)' }}>
        {entry.source}
      </span>
      <span style={styles.agent}>{entry.agent || '-'}</span>
      <span style={styles.woSlug}>{entry.woSlug || '-'}</span>
      <span style={styles.level}><StatusBadge status={entry.level === 'error' ? 'failed' : entry.level === 'success' ? 'done' : entry.level === 'warning' ? 'blocked_on_input' : 'draft'} /></span>
      <span style={styles.message}>{entry.message}</span>
      {entry.detail && <span style={styles.expand}>{expanded ? '\u25BC' : '\u25B6'}</span>}
      {expanded && entry.detail && (
        <div style={styles.detail}>
          <pre style={styles.json}>{JSON.stringify(entry.detail, null, 2)}</pre>
        </div>
      )}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  row: {
    display: 'grid',
    gridTemplateColumns: '80px 80px 80px 100px 70px 1fr 20px',
    gap: 8,
    padding: '8px 12px',
    borderBottom: '1px solid var(--border-default)',
    fontSize: 12,
    alignItems: 'center',
    cursor: 'pointer',
    transition: 'background 0.1s',
  },
  time: {
    fontFamily: 'var(--font-mono)',
    color: 'var(--text-muted)',
    fontSize: 11,
  },
  source: {
    fontWeight: 600,
    fontSize: 11,
    textTransform: 'uppercase' as const,
  },
  agent: {
    color: 'var(--text-secondary)',
    fontSize: 11,
  },
  woSlug: {
    fontFamily: 'var(--font-mono)',
    color: 'var(--accent)',
    fontSize: 11,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap' as const,
  },
  level: {},
  message: {
    color: 'var(--text-secondary)',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap' as const,
  },
  expand: {
    color: 'var(--text-muted)',
    fontSize: 10,
    textAlign: 'center' as const,
  },
  detail: {
    gridColumn: '1 / -1',
    marginTop: 8,
    padding: 12,
    background: 'var(--bg-primary)',
    borderRadius: 4,
    maxHeight: 300,
    overflow: 'auto',
  },
  json: {
    fontFamily: 'var(--font-mono)',
    fontSize: 11,
    color: 'var(--text-secondary)',
    whiteSpace: 'pre-wrap' as const,
    margin: 0,
  },
};
