import { useState, useRef, useEffect } from 'react';

export interface ActivityEvent {
  id: string;
  timestamp: string;
  table: string;
  eventType: string;
  summary: string;
}

interface ActivityStreamProps {
  events: ActivityEvent[];
  maxHeight?: number;
}

export default function ActivityStream({ events, maxHeight = 400 }: ActivityStreamProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (containerRef.current) {
      containerRef.current.scrollTop = 0;
    }
  }, [events.length]);

  if (!events.length) {
    return <div style={styles.empty}>Waiting for activity...</div>;
  }

  return (
    <div ref={containerRef} style={{ ...styles.container, maxHeight }}>
      {events.map((event) => (
        <div key={event.id} style={styles.item}>
          <div style={styles.header}>
            <div style={styles.meta}>
              <span style={styles.table}>{event.table}</span>
              <span style={{
                ...styles.eventType,
                background: event.eventType === 'INSERT' ? 'rgba(34,197,94,0.2)' :
                             event.eventType === 'UPDATE' ? 'rgba(59,130,246,0.2)' :
                             'rgba(239,68,68,0.2)',
                color: event.eventType === 'INSERT' ? 'var(--status-done)' :
                       event.eventType === 'UPDATE' ? 'var(--accent)' :
                       'var(--status-error)',
              }}>{event.eventType}</span>
            </div>
            <span style={styles.time}>
              {new Date(event.timestamp).toLocaleTimeString('en-US', {
                hour: '2-digit', minute: '2-digit', second: '2-digit', timeZone: 'America/Los_Angeles'
              })}
            </span>
          </div>
          <div style={styles.summary}>{event.summary}</div>
        </div>
      ))}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    overflowY: 'auto',
    background: 'var(--bg-elevated)',
    borderRadius: 6,
    padding: 8,
  },
  empty: {
    color: 'var(--text-muted)',
    textAlign: 'center',
    padding: 24,
    fontSize: 13,
  },
  item: {
    padding: '10px 12px',
    borderBottom: '1px solid var(--border-default)',
  },
  header: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  meta: {
    display: 'flex',
    gap: 8,
    alignItems: 'center',
  },
  table: {
    fontWeight: 600,
    fontSize: 12,
    color: 'var(--accent)',
  },
  eventType: {
    padding: '2px 6px',
    borderRadius: 4,
    fontSize: 10,
    fontWeight: 600,
    textTransform: 'uppercase' as const,
  },
  time: {
    fontSize: 11,
    color: 'var(--text-muted)',
    fontFamily: 'var(--font-mono)',
  },
  summary: {
    fontSize: 12,
    color: 'var(--text-secondary)',
    marginTop: 4,
  },
};
