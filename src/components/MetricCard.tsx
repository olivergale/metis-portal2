interface MetricCardProps {
  label: string;
  value: string | number;
  trend?: 'up' | 'down' | 'neutral';
  color?: string;
}

export default function MetricCard({ label, value, trend, color }: MetricCardProps) {
  const trendIcon = trend === 'up' ? '\u2191' : trend === 'down' ? '\u2193' : '';
  const trendColor = trend === 'up' ? 'var(--status-success)' : trend === 'down' ? 'var(--status-error)' : 'var(--text-muted)';

  return (
    <div style={styles.card}>
      <div style={{ ...styles.value, color: color || 'var(--text-primary)' }}>
        {value}
        {trendIcon && <span style={{ ...styles.trend, color: trendColor }}>{trendIcon}</span>}
      </div>
      <div style={styles.label}>{label}</div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  card: {
    background: 'var(--bg-surface)',
    border: '1px solid var(--border-default)',
    borderRadius: 'var(--radius-md)',
    padding: '16px 20px',
    textAlign: 'center',
  },
  value: {
    fontSize: 28,
    fontWeight: 700,
    marginBottom: 4,
  },
  label: {
    fontSize: 11,
    color: 'var(--text-muted)',
    textTransform: 'uppercase' as const,
    letterSpacing: '0.5px',
  },
  trend: {
    fontSize: 14,
    marginLeft: 4,
    fontWeight: 600,
  },
};
