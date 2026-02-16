const STATUS_STYLES: Record<string, string> = {
  draft:            'bg-[rgba(156,163,175,0.15)] text-[#9ca3af]',
  ready:            'bg-[rgba(96,165,250,0.15)] text-[#60a5fa]',
  in_progress:      'bg-[rgba(59,130,246,0.15)] text-accent',
  review:           'bg-[rgba(167,139,250,0.15)] text-[#a78bfa]',
  done:             'bg-[rgba(34,197,94,0.15)] text-success',
  completed:        'bg-[rgba(34,197,94,0.15)] text-success',
  failed:           'bg-[rgba(239,68,68,0.15)] text-error',
  cancelled:        'bg-[rgba(156,163,175,0.15)] text-[#9ca3af]',
  blocked:          'bg-[rgba(248,113,113,0.15)] text-[#f87171]',
  blocked_on_input: 'bg-[rgba(245,158,11,0.15)] text-warning',
  active:           'bg-[rgba(59,130,246,0.15)] text-accent',
  pending:          'bg-[rgba(156,163,175,0.15)] text-[#9ca3af]',
  pending_approval: 'bg-[rgba(245,158,11,0.15)] text-warning',
};

export default function StatusBadge({ status }: { status: string }) {
  const styles = STATUS_STYLES[status] || STATUS_STYLES.pending;
  
  return (
    <span
      className={`inline-block px-2 py-0.5 rounded text-[11px] font-semibold uppercase whitespace-nowrap ${styles}`}
    >
      {status.replace(/_/g, ' ')}
    </span>
  );
}
