const PHASES = ['spec', 'plan', 'scaffold', 'build', 'verify', 'harden', 'integrate'];

interface PhaseTrackProps {
  currentPhase: string;
  completedPhases: string[];
  status: string;
}

export default function PhaseTrack({ currentPhase, completedPhases, status }: PhaseTrackProps) {
  const currentIndex = PHASES.indexOf(currentPhase);

  return (
    <div style={styles.track}>
      {PHASES.map((phase, index) => {
        const isCompleted = completedPhases.includes(phase);
        const isCurrent = index === currentIndex && status === 'active';
        const isPending = index > currentIndex;

        let dotBg = 'var(--bg-elevated)';
        let dotBorder = 'var(--border-strong)';
        let labelColor = 'var(--text-muted)';
        let boxShadow = 'none';

        if (isCompleted) {
          dotBg = 'var(--status-done)';
          dotBorder = 'var(--status-done)';
          labelColor = 'var(--status-done)';
        } else if (isCurrent) {
          dotBg = 'var(--accent)';
          dotBorder = 'var(--accent)';
          labelColor = 'var(--accent)';
          boxShadow = '0 0 8px var(--accent)';
        }

        return (
          <div key={phase} style={styles.item}>
            {index > 0 && (
              <div style={{
                ...styles.connector,
                background: isCompleted || (isCurrent && index <= currentIndex) ? 'var(--accent)' : 'var(--border-strong)',
              }} />
            )}
            <div style={{
              ...styles.dot,
              background: dotBg,
              borderColor: dotBorder,
              boxShadow,
              animation: isCurrent ? 'pulse 2s ease-in-out infinite' : 'none',
            }} />
            <div style={{
              ...styles.label,
              color: labelColor,
              fontWeight: isCurrent ? 600 : 400,
            }}>
              {phase.toUpperCase()}
            </div>
          </div>
        );
      })}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  track: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: 0,
    padding: '16px 0',
  },
  item: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: 8,
    position: 'relative',
  },
  connector: {
    position: 'absolute',
    top: 7,
    right: '50%',
    width: '100%',
    height: 2,
    zIndex: 0,
  },
  dot: {
    width: 16,
    height: 16,
    borderRadius: '50%',
    border: '2px solid',
    zIndex: 1,
    position: 'relative',
  },
  label: {
    fontSize: 10,
    letterSpacing: '0.5px',
  },
};
