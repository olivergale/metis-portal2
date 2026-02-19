import { useState } from 'react';
import { motion } from 'framer-motion';
import { staggerContainer, staggerItem } from '../animations/index.ts';
import StatusBadge from './StatusBadge.tsx';
import type { KernelEvent } from '../types/index.ts';

interface EventTimelineProps {
  events: KernelEvent[];
}

function formatPT(iso: string): string {
  try {
    return new Date(iso).toLocaleString('en-US', {
      timeZone: 'America/Los_Angeles',
      month: 'short', day: 'numeric',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
  } catch {
    return iso;
  }
}

export default function EventTimeline({ events }: EventTimelineProps) {
  const [expanded, setExpanded] = useState<Set<number>>(new Set());

  const toggle = (id: number) => {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <div className="bg-surface border border-default rounded-lg p-4">
      <h3 className="text-[13px] font-semibold text-primary mb-3">Event Stream</h3>
      <motion.div
        variants={staggerContainer}
        initial="initial"
        animate="animate"
        className="max-h-[400px] overflow-y-auto flex flex-col gap-1"
      >
        {events.map((evt) => (
          <motion.div
            key={evt.id}
            variants={staggerItem}
            className="border border-default rounded px-3 py-2 hover:bg-hover transition-colors cursor-pointer"
            onClick={() => toggle(evt.id)}
          >
            <div className="flex items-center gap-2 flex-wrap">
              <StatusBadge status={evt.event_type} />
              <span className="text-[12px] text-secondary font-medium">{evt.actor}</span>
              <span className="text-[11px] text-muted ml-auto">{formatPT(evt.occurred_at)}</span>
              <code className="text-[10px] text-muted font-mono bg-[rgba(0,0,0,0.2)] px-1.5 py-0.5 rounded">
                {evt.hash.slice(0, 8)}
              </code>
            </div>
            {expanded.has(evt.id) && evt.payload && (
              <pre className="mt-2 text-[10px] text-muted font-mono bg-[rgba(0,0,0,0.15)] p-2 rounded overflow-x-auto max-h-[200px]">
                {JSON.stringify(evt.payload, null, 2)}
              </pre>
            )}
          </motion.div>
        ))}
        {events.length === 0 && (
          <div className="text-[12px] text-muted text-center py-4">No events</div>
        )}
      </motion.div>
    </div>
  );
}
