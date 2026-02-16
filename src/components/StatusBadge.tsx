const STATUS_COLORS: Record<string, { bg: string; text: string }> = {
  draft:         { bg: 'rgba(156,163,175,0.15)', text: '#9ca3af' },
  ready:         { bg: 'rgba(96,165,250,0.15)',  text: '#60a5fa' },
  in_progress:   { bg: 'rgba(59,130,246,0.15)',  text: '#3b82f6' },
  review:        { bg: 'rgba(167,139,250,0.15)', text: '#a78bfa' },
  done:          { bg: 'rgba(34,197,94,0.15)',   text: '#22c55e' },
  completed:     { bg: 'rgba(34,197,94,0.15)',   text: '#22c55e' },
  failed:        { bg: 'rgba(239,68,68,0.15)',   text: '#ef4444' },
  cancelled:     { bg: 'rgba(156,163,175,0.15)', text: '#9ca3af' },
  blocked:       { bg: 'rgba(248,113,113,0.15)', text: '#f87171' },
  blocked_on_input: { bg: 'rgba(245,158,11,0.15)', text: '#f59e0b' },
  active:        { bg: 'rgba(59,130,246,0.15)',  text: '#3b82f6' },
  pending:       { bg: 'rgba(156,163,175,0.15)', text: '#9ca3af' },
  pending_approval: { bg: 'rgba(245,158,11,0.15)', text: '#f59e0b' },
};

export default function StatusBadge({ status }: { status: string }) {
  const colors = STATUS_COLORS[status] || STATUS_COLORS.pending;
  return (
    <span
      style={{
        display: 'inline-block',
        padding: '2px 8px',
        borderRadius: 4,
        fontSize: 11,
        fontWeight: 600,
        textTransform: 'uppercase',
        background: colors.bg,
        color: colors.text,
        whiteSpace: 'nowrap',
      }}
    >
      {status.replace(/_/g, ' ')}
    </span>
  );
}
