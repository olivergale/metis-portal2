import { motion } from 'framer-motion';
import { fadeIn } from '../animations/index.ts';
import type { KernelState, KernelTransition } from '../types/index.ts';

interface StateGraphProps {
  states: Record<string, KernelState>;
  transitions: KernelTransition[];
}

// Layout positions for WO statuses in a logical flow
const STATE_POSITIONS: Record<string, { x: number; y: number }> = {
  draft:            { x: 80,  y: 60  },
  ready:            { x: 240, y: 60  },
  in_progress:      { x: 400, y: 60  },
  review:           { x: 560, y: 60  },
  done:             { x: 720, y: 60  },
  failed:           { x: 400, y: 180 },
  cancelled:        { x: 240, y: 180 },
  blocked:          { x: 560, y: 180 },
  blocked_on_input: { x: 80,  y: 180 },
  pending_approval: { x: 720, y: 180 },
};

const STATE_COLORS: Record<string, string> = {
  draft:       '#9ca3af',
  ready:       '#60a5fa',
  in_progress: '#3b82f6',
  review:      '#a78bfa',
  done:        '#22c55e',
  failed:      '#ef4444',
  cancelled:   '#6b7280',
  blocked:     '#f87171',
  blocked_on_input: '#f59e0b',
  pending_approval: '#f59e0b',
};

export default function StateGraph({ states, transitions }: StateGraphProps) {
  const stateNames = Object.keys(states);
  const width = 840;
  const height = 260;

  return (
    <motion.div
      variants={fadeIn}
      initial="initial"
      animate="animate"
      className="bg-surface border border-default rounded-lg p-4 overflow-x-auto"
    >
      <h3 className="text-[13px] font-semibold text-primary mb-3">State Machine</h3>
      <svg viewBox={`0 0 ${width} ${height}`} className="w-full" style={{ minWidth: 600 }}>
        <defs>
          <marker id="arrow" viewBox="0 0 10 7" refX="10" refY="3.5"
            markerWidth="8" markerHeight="6" orient="auto-start-reverse">
            <polygon points="0 0, 10 3.5, 0 7" fill="#6b7280" />
          </marker>
        </defs>

        {/* Transition edges */}
        {transitions.map((t, i) => {
          const from = STATE_POSITIONS[t.from_status];
          const to = STATE_POSITIONS[t.to_status];
          if (!from || !to) return null;

          // Offset for parallel edges
          const parallelIdx = transitions
            .slice(0, i)
            .filter(tt => tt.from_status === t.from_status && tt.to_status === t.to_status).length;
          const offset = parallelIdx * 12;

          const midX = (from.x + to.x) / 2;
          const midY = (from.y + to.y) / 2 - 20 - offset;

          // Self-loops
          if (t.from_status === t.to_status) {
            return (
              <g key={`edge-${i}`}>
                <path
                  d={`M ${from.x + 30} ${from.y - 15} C ${from.x + 60} ${from.y - 50}, ${from.x - 20} ${from.y - 50}, ${from.x - 30} ${from.y - 15}`}
                  fill="none" stroke="#4b5563" strokeWidth="1" markerEnd="url(#arrow)"
                  strokeDasharray="4,2"
                />
              </g>
            );
          }

          return (
            <g key={`edge-${i}`}>
              <path
                d={`M ${from.x} ${from.y} Q ${midX} ${midY}, ${to.x} ${to.y}`}
                fill="none" stroke="#4b5563" strokeWidth="1" markerEnd="url(#arrow)"
              />
              <text x={midX} y={midY - 4} textAnchor="middle"
                className="fill-[#9ca3af]" fontSize="8" fontFamily="monospace">
                {t.event}
              </text>
            </g>
          );
        })}

        {/* State nodes */}
        {stateNames.map((name) => {
          const pos = STATE_POSITIONS[name] || { x: 400, y: 120 };
          const color = STATE_COLORS[name] || '#6b7280';
          const isTerminal = states[name]?.is_terminal;

          return (
            <g key={name}>
              <rect
                x={pos.x - 45} y={pos.y - 16} width={90} height={32}
                rx={6} ry={6}
                fill={`${color}22`} stroke={color} strokeWidth={isTerminal ? 2 : 1}
              />
              <text x={pos.x} y={pos.y + 4} textAnchor="middle"
                fill={color} fontSize="10" fontWeight="600" fontFamily="Inter, sans-serif">
                {name.replace(/_/g, ' ')}
              </text>
            </g>
          );
        })}
      </svg>
    </motion.div>
  );
}
