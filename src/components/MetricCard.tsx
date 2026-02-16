interface MetricCardProps {
  label: string;
  value: string | number;
  trend?: 'up' | 'down' | 'neutral';
  color?: string;
}

export default function MetricCard({ label, value, trend, color }: MetricCardProps) {
  const trendIcon = trend === 'up' ? '↑' : trend === 'down' ? '↓' : '';
  const trendColor = trend === 'up' ? 'text-success' : trend === 'down' ? 'text-error' : 'text-muted';

  return (
    <div className="bg-surface border border-default rounded-lg p-4 px-5 text-center">
      <div className="flex items-center justify-center gap-1">
        <span className={`text-[28px] font-bold ${color ? '' : 'text-primary'}`} style={color ? { color } : {}}>
          {value}
        </span>
        {trendIcon && (
          <span className={`text-sm font-semibold ${trendColor}`}>
            {trendIcon}
          </span>
        )}
      </div>
      <div className="text-[11px] text-muted uppercase tracking-wide mt-1">
        {label}
      </div>
    </div>
  );
}
