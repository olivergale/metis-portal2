import StatusBadge from './StatusBadge.tsx';
import { relativeTime } from '../utils/api.ts';
import type { WorkOrder } from '../types/index.ts';

interface WOCardProps {
  wo: WorkOrder;
  onClick?: () => void;
  compact?: boolean;
}

export default function WOCard({ wo, onClick, compact }: WOCardProps) {
  return (
    <div onClick={onClick} style={{ ...styles.card, cursor: onClick ? 'pointer' : 'default' }}>
      <div style={styles.header}>
        <span style={styles.slug}>{wo.slug}</span>
        <StatusBadge status={wo.status} />
      </div>
      {!compact && <div style={styles.name}>{wo.name}</div>}
      <div style={styles.meta}>
        {wo.assigned_to && <span style={styles.agent}>{wo.assigned_to}</span>}
        <span style={styles.time}>{relativeTime(wo.updated_at || wo.created_at)}</span>
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  card: {
    padding: '10px 14px',
    background: 'var(--bg-elevated)',
    borderRadius: 6,
    border: '1px solid var(--border-default)',
    transition: 'border-color 0.15s',
  },
  header: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 4,
  },
  slug: {
    fontFamily: 'var(--font-mono)',
    fontSize: 12,
    color: 'var(--accent)',
    fontWeight: 600,
  },
  name: {
    fontSize: 13,
    color: 'var(--text-primary)',
    marginBottom: 6,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap' as const,
  },
  meta: {
    display: 'flex',
    justifyContent: 'space-between',
    fontSize: 11,
    color: 'var(--text-muted)',
  },
  agent: {
    color: 'var(--text-secondary)',
  },
  time: {},
};
