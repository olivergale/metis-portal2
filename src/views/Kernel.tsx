import { useState, useMemo } from 'react';
import { motion } from 'framer-motion';
import { pageTransition } from '../animations/index.ts';
import { useKernel } from '../hooks/useKernel.ts';
import MetricCard from '../components/MetricCard.tsx';
import StateGraph from '../components/StateGraph.tsx';
import EventTimeline from '../components/EventTimeline.tsx';
import EvidenceChain from '../components/EvidenceChain.tsx';

export default function Kernel() {
  const { data, loading, error } = useKernel();
  const [selectedStream, setSelectedStream] = useState<string>('');

  // Extract unique stream IDs from recent events
  const streamIds = useMemo(() => {
    if (!data?.recent_events) return [];
    const ids = [...new Set(data.recent_events.map(e => e.stream_id))];
    return ids.slice(0, 20); // limit dropdown
  }, [data?.recent_events]);

  // Compute active WO total
  const activeWOs = useMemo(() => {
    if (!data?.wo_counts) return 0;
    return data.wo_counts.reduce((sum, c) => sum + c.count, 0);
  }, [data?.wo_counts]);

  if (loading) {
    return (
      <motion.div variants={pageTransition} initial="initial" animate="animate"
        className="p-6">
        <div className="text-[13px] text-muted">Loading kernel data...</div>
      </motion.div>
    );
  }

  if (error) {
    return (
      <motion.div variants={pageTransition} initial="initial" animate="animate"
        className="p-6">
        <div className="text-[13px] text-error">Error: {error}</div>
      </motion.div>
    );
  }

  if (!data) return null;

  return (
    <motion.div
      variants={pageTransition}
      initial="initial"
      animate="animate"
      className="p-6 flex flex-col gap-5"
    >
      {/* Header */}
      <div>
        <h1 className="text-[18px] font-bold text-primary">Kernel Dashboard</h1>
        <p className="text-[12px] text-muted mt-1">Open Manifold Kernel — state machine, event stream, evidence chains</p>
      </div>

      {/* Metric Cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <MetricCard label="Spec Version" value={data.spec_version} />
        <MetricCard label="Events" value={data.recent_events.length} />
        <MetricCard label="Active WOs" value={activeWOs} />
        <MetricCard label="Invariants" value={data.invariants.length} />
      </div>

      {/* State Machine Graph */}
      <StateGraph states={data.states} transitions={data.transitions} />

      {/* Bottom grid: Events + Evidence */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <EventTimeline events={data.recent_events} />

        <div className="flex flex-col gap-3">
          {/* Stream selector */}
          <div className="bg-surface border border-default rounded-lg p-3">
            <label className="text-[11px] text-muted uppercase tracking-wide block mb-1.5">
              Evidence Chain Stream
            </label>
            <select
              value={selectedStream}
              onChange={(e) => setSelectedStream(e.target.value)}
              className="w-full bg-[rgba(0,0,0,0.2)] border border-default rounded px-2.5 py-1.5 text-[12px] text-primary font-mono"
            >
              <option value="">Select a stream...</option>
              {streamIds.map(id => (
                <option key={id} value={id}>{id.slice(0, 8)}...</option>
              ))}
            </select>
          </div>

          {selectedStream && <EvidenceChain streamId={selectedStream} />}
        </div>
      </div>

      {/* WO Status Breakdown */}
      {data.wo_counts.length > 0 && (
        <div className="bg-surface border border-default rounded-lg p-4">
          <h3 className="text-[13px] font-semibold text-primary mb-3">Active Work Orders by Status</h3>
          <div className="flex flex-wrap gap-3">
            {data.wo_counts.map(({ status, count }) => (
              <div key={status} className="flex items-center gap-2 bg-[rgba(0,0,0,0.15)] rounded px-3 py-1.5">
                <span className="text-[12px] text-secondary capitalize">{status.replace(/_/g, ' ')}</span>
                <span className="text-[14px] font-bold text-primary">{count}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </motion.div>
  );
}
