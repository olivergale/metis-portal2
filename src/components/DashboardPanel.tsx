/**
 * DashboardPanel - Open Manifold Golden Exemplar Component
 * 
 * This component demonstrates EVERY pattern in the Open Manifold design system:
 * - Framer Motion entrance animations (fade + slide)
 * - Responsive grid (1 col mobile, 2 col tablet, 3 col desktop)
 * - MetricCard with animated count-up
 * - StatusBadge with pulse animation for active states
 * - DataTable with hover rows and expandable detail
 * - Loading skeleton state
 * - Empty state
 * 
 * USAGE: Reference this component when building new features.
 * Pattern markers below make discovery easy.
 */

import { motion } from 'framer-motion';
import { useState, useEffect } from 'react';
import { staggerContainer, staggerItem, fadeIn, hoverScale } from '../animations';

// XSS Prevention: Escape HTML entities to prevent script injection
// This is a defense-in-depth measure - React escapes by default but this adds extra protection
function escapeHtml(str: string): string {
  const htmlEntities: Record<string, string> = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
    '/': '&#x2F;',
  };
  return String(str).replace(/[&<>"'/]/g, char => htmlEntities[char] || char);
}

interface Metric {
  id: string;
  label: string;
  value: number;
  trend?: 'up' | 'down';
  status?: 'active' | 'warning' | 'error';
}

interface DataRow {
  id: string;
  name: string;
  status: string;
  value: number;
  detail?: string;
}

interface DashboardPanelProps {
  title: string;
  metrics?: Metric[];
  data?: DataRow[];
  loading?: boolean;
}

export default function DashboardPanel({ 
  title, 
  metrics = [], 
  data = [], 
  loading = false 
}: DashboardPanelProps) {
  const [expandedRow, setExpandedRow] = useState<string | null>(null);
  const [animatedValues, setAnimatedValues] = useState<Record<string, number>>({});

  // XSS Prevention: Sanitize title before rendering
  const safeTitle = escapeHtml(title);

  // XSS Prevention: Clamp counter values to prevent animation DoS
  // Max value: 999,999 (prevents integer overflow and animation exhaustion)
  const MAX_SAFE_VALUE = 999999;

  // PATTERN: Animated count-up for metrics
  useEffect(() => {
    if (loading) return;
    
    metrics.forEach(metric => {
      let start = 0;
      // Clamp the end value to prevent animation DoS and integer overflow
      const clampedEnd = Math.min(Math.max(metric.value, 0), MAX_SAFE_VALUE);
      const end = clampedEnd;
      const duration = 1000;
      const increment = end / (duration / 16);
      
      const timer = setInterval(() => {
        start += increment;
        if (start >= end) {
          setAnimatedValues(prev => ({ ...prev, [metric.id]: end }));
          clearInterval(timer);
        } else {
          setAnimatedValues(prev => ({ ...prev, [metric.id]: Math.floor(start) }));
        }
      }, 16);
    });
  }, [metrics, loading]);

  // PATTERN: Loading skeleton state
  if (loading) {
    return (
      <div className="bg-surface border border-default rounded-lg p-6">
        <div className="h-6 bg-hover rounded w-48 mb-6 animate-pulse" />
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {[1, 2, 3].map(i => (
            <div key={i} className="bg-hover rounded-lg p-6 animate-pulse">
              <div className="h-10 bg-active rounded w-20 mx-auto mb-2" />
              <div className="h-3 bg-active rounded w-24 mx-auto" />
            </div>
          ))}
        </div>
      </div>
    );
  }

  // PATTERN: Empty state
  if (metrics.length === 0 && data.length === 0) {
    return (
      <motion.div
        className="bg-surface border border-default rounded-lg p-12 text-center"
        variants={fadeIn}
        initial="initial"
        animate="animate"
      >
        <div className="text-4xl mb-4 opacity-30">ð\u011ds\u011d</div>
        <h3 className="text-lg font-semibold text-secondary mb-2">No data yet</h3>
        <p className="text-sm text-muted">Start adding metrics to see your dashboard come to life</p>
      </motion.div>
    );
  }

  return (
    // PATTERN: Entrance animation - container fades in
    <motion.div
      className="bg-surface border border-default rounded-lg p-6"
      variants={fadeIn}
      initial="initial"
      animate="animate"
    >
      {/* PATTERN: Section header - using dangerouslySetInnerHTML NOT used, relying on React text rendering */}
      <h2 className="text-xl font-semibold text-primary mb-6">{safeTitle}</h2>

      {/* PATTERN: Responsive grid (1 col \u2192 2 col \u2192 3 col) */}
      {metrics.length > 0 && (
        <motion.div
          className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 mb-8"
          variants={staggerContainer}
          initial="initial"
          animate="animate"
        >
          {metrics.map(metric => (
            // PATTERN: MetricCard with hover interaction
            <motion.div
              key={metric.id}
              className="bg-card border border-default rounded-lg p-6 text-center transition-all hover:border-accent-glow hover:shadow-[0_0_8px_rgba(59,130,246,0.3)]"
              variants={staggerItem}
              whileHover={{ scale: 1.02 }}
            >
              {/* PATTERN: Large monospace value with animated count-up */}
              <div className="flex items-center justify-center gap-2">
                <div className="text-4xl font-bold font-mono text-primary">
                  {animatedValues[metric.id] || 0}
                </div>
                {/* PATTERN: Trend indicator */}
                {metric.trend && (
                  <span className={`text-lg ${
                    metric.trend === 'up' ? 'text-success' : 'text-error'
                  }`}>
                    {metric.trend === 'up' ? '\u2191' : '\u2193'}
                  </span>
                )}
              </div>
              
              {/* PATTERN: Muted label with uppercase styling - escapeHtml applied */}
              <div className="text-xs text-muted uppercase tracking-wide mt-1">
                {escapeHtml(metric.label)}
              </div>
              
              {/* PATTERN: StatusBadge with pulse animation for active states */}
              {metric.status && (
                <motion.div
                  className="mt-3"
                  animate={metric.status === 'active' ? {
                    opacity: [0.5, 1, 0.5],
                  } : {}}
                  transition={metric.status === 'active' ? {
                    repeat: Infinity,
                    duration: 2,
                    ease: 'easeInOut',
                  } : {}}
                >
                  <StatusBadge status={metric.status} />
                </motion.div>
              )}
            </motion.div>
          ))}
        </motion.div>
      )}

      {/* PATTERN: DataTable with hover rows and expandable detail */}
      {data.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full">
            {/* PATTERN: Sticky header */}
            <thead className="sticky top-0 bg-surface border-b border-default">
              <tr className="text-xs text-muted uppercase tracking-wide">
                <th className="text-left p-3">Name</th>
                <th className="text-left p-3">Status</th>
                <th className="text-right p-3">Value</th>
                <th className="w-8"></th>
              </tr>
            </thead>
            <tbody>
              {data.map(row => (
                <motion.tr
                  key={row.id}
                  className="border-b border-default hover:bg-hover transition-colors cursor-pointer"
                  onClick={() => setExpandedRow(expandedRow === row.id ? null : row.id)}
                  variants={hoverScale}
                  whileHover="whileHover"
                >
                  {/* XSS Prevention: escapeHtml applied to user-controlled data */}
                  <td className="p-3 font-medium text-primary">{escapeHtml(row.name)}</td>
                  <td className="p-3">
                    <StatusBadge status={row.status} />
                  </td>
                  <td className="p-3 text-right font-mono text-sm text-secondary">
                    {row.value.toLocaleString()}
                  </td>
                  <td className="p-3 text-muted text-xs">
                    {expandedRow === row.id ? '\u25BC' : '\u25B6'}
                  </td>
                </motion.tr>
              ))}
              
              {/* PATTERN: Expandable detail row - escapeHtml applied */}
              {data.map(row => expandedRow === row.id && row.detail && (
                <motion.tr
                  key={`${row.id}-detail`}
                  initial={{ opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: 'auto' }}
                  exit={{ opacity: 0, height: 0 }}
                  className="bg-card border-b border-default"
                >
                  <td colSpan={4} className="p-4">
                    <div className="text-sm text-secondary">
                      {escapeHtml(row.detail)}
                    </div>
                  </td>
                </motion.tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </motion.div>
  );
}

// PATTERN: StatusBadge component (inline for reference)
function StatusBadge({ status }: { status: string }) {
  const colors: Record<string, { bg: string; text: string }> = {
    active: { bg: 'bg-[rgba(59,130,246,0.15)]', text: 'text-accent' },
    warning: { bg: 'bg-[rgba(245,158,11,0.15)]', text: 'text-warning' },
    error: { bg: 'bg-[rgba(239,68,68,0.15)]', text: 'text-error' },
    success: { bg: 'bg-[rgba(34,197,94,0.15)]', text: 'text-success' },
  };
  
  const color = colors[status] || colors.active;
  
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold ${color.bg} ${color.text}`}>
      {status}
    </span>
  );
}
