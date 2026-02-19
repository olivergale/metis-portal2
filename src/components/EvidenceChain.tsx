import { useState, useEffect } from 'react';
import { motion } from 'framer-motion';
import { fadeIn } from '../animations/index.ts';
import { supabase } from '../utils/supabase.ts';
import type { KernelEvent } from '../types/index.ts';

interface EvidenceChainProps {
  streamId: string;
}

export default function EvidenceChain({ streamId }: EvidenceChainProps) {
  const [events, setEvents] = useState<KernelEvent[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!streamId) return;
    setLoading(true);
    supabase
      .from('wo_event_stream')
      .select('id, stream_id, event_type, actor, occurred_at, hash, previous_hash, payload')
      .eq('stream_id', streamId)
      .order('id', { ascending: true })
      .then(({ data }) => {
        if (data) setEvents(data as KernelEvent[]);
        setLoading(false);
      });
  }, [streamId]);

  if (loading) {
    return (
      <div className="bg-surface border border-default rounded-lg p-4">
        <h3 className="text-[13px] font-semibold text-primary mb-3">Evidence Chain</h3>
        <div className="text-[12px] text-muted text-center py-4">Loading...</div>
      </div>
    );
  }

  return (
    <motion.div
      variants={fadeIn}
      initial="initial"
      animate="animate"
      className="bg-surface border border-default rounded-lg p-4"
    >
      <h3 className="text-[13px] font-semibold text-primary mb-3">
        Evidence Chain
        <span className="text-muted font-normal ml-2">({events.length} events)</span>
      </h3>
      <div className="flex flex-col gap-0">
        {events.map((evt, i) => {
          const prev = i > 0 ? events[i - 1] : null;
          const chainValid = i === 0 || evt.previous_hash === prev?.hash;

          return (
            <div key={evt.id} className="flex items-start gap-3">
              {/* Chain link indicator */}
              <div className="flex flex-col items-center min-w-[24px]">
                {i > 0 && (
                  <div className={`w-0.5 h-4 ${chainValid ? 'bg-success' : 'bg-error'}`} />
                )}
                <div className={`w-4 h-4 rounded-full border-2 flex items-center justify-center text-[8px] ${
                  chainValid
                    ? 'border-success text-success'
                    : 'border-error text-error'
                }`}>
                  {chainValid ? '✓' : '✗'}
                </div>
                {i < events.length - 1 && (
                  <div className="w-0.5 h-4 bg-[rgba(107,114,128,0.3)]" />
                )}
              </div>

              {/* Event detail */}
              <div className="flex-1 pb-2">
                <div className="flex items-center gap-2">
                  <span className="text-[11px] font-semibold text-secondary">{evt.event_type}</span>
                  <span className="text-[10px] text-muted">{evt.actor}</span>
                </div>
                <div className="flex items-center gap-1 mt-0.5">
                  <code className="text-[9px] font-mono text-muted">
                    {evt.previous_hash?.slice(0, 8) || 'genesis'}
                  </code>
                  <span className="text-[9px] text-muted">→</span>
                  <code className="text-[9px] font-mono text-accent">
                    {evt.hash.slice(0, 8)}
                  </code>
                </div>
              </div>
            </div>
          );
        })}
        {events.length === 0 && (
          <div className="text-[12px] text-muted text-center py-4">Select a stream to view chain</div>
        )}
      </div>
    </motion.div>
  );
}
