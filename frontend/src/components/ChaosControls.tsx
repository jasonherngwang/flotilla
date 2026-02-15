import { useCallback, useState, useRef, useEffect } from 'react';
import type { NodeState, NodeId, Fault, ClientMessage } from '../types';
import { NODE_IDS } from '../types';

interface ChaosControlsProps {
  nodes: NodeState[];
  faults: Fault[];
  onAction: (msg: ClientMessage) => void;
}

export function ChaosControls({ nodes, faults, onAction }: ChaosControlsProps) {
  const [autoWrite, setAutoWrite] = useState(true);
  const [writeClicks, setWriteClicks] = useState(0);
  const [healClicks, setHealClicks] = useState(0);
  const [resetClicks, setResetClicks] = useState(0);
  const [isMobile, setIsMobile] = useState(false);

  const hasPartition = faults.some((f) => f.type === 'earthquake');

  // Detect mobile viewport (< 1024px)
  useEffect(() => {
    const checkMobile = () => {
      setIsMobile(window.innerWidth < 1024);
    };
    checkMobile();
    window.addEventListener('resize', checkMobile);
    return () => window.removeEventListener('resize', checkMobile);
  }, []);

  // Auto-write: submit a write every 3 seconds
  useEffect(() => {
    if (!autoWrite) return;
    const interval = setInterval(() => {
      onAction({ type: 'submit_write' });
    }, 3000);
    return () => clearInterval(interval);
  }, [autoWrite, onAction]);

  const handleSubmitWrite = useCallback(() => {
    onAction({ type: 'submit_write' });
    setWriteClicks((c) => c + 1);
  }, [onAction]);

  const handleHealAll = useCallback(() => {
    onAction({ type: 'heal_all' });
    setHealClicks((c) => c + 1);
  }, [onAction]);

  const handleReset = useCallback(() => {
    onAction({ type: 'reset' });
    setAutoWrite(false);
    setResetClicks((c) => c + 1);
  }, [onAction]);

  const handlePartition = useCallback(() => {
    if (hasPartition) {
      onAction({ type: 'heal_partition' });
      return;
    }
    // Isolate the current leader (classic split-brain scenario).
    // If no leader, split into [A,B] | [C,D,E].
    const leader = nodes.find((n) => n.role === 'leader' && !n.faultState.crashed);
    if (leader) {
      const others = NODE_IDS.filter((id) => id !== leader.id);
      onAction({ type: 'partition', groups: [[leader.id], others as NodeId[]] });
    } else {
      onAction({ type: 'partition', groups: [['A', 'B'], ['C', 'D', 'E']] });
    }
  }, [nodes, faults, hasPartition, onAction]);

  return (
    <div
      style={{
        position: 'absolute',
        top: isMobile ? 12 : 20,
        left: isMobile ? 12 : 20,
        display: 'flex',
        flexDirection: isMobile ? 'column' : 'row',
        gap: isMobile ? 6 : 8,
        alignItems: isMobile ? 'flex-start' : 'center',
        zIndex: 5,
        maxWidth: isMobile ? 'calc(100vw - 120px)' : 'none',
      }}
    >
      <div style={{ display: 'flex', gap: isMobile ? 6 : 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <ToggleButton
          label="Auto Write"
          active={autoWrite}
          onClick={() => setAutoWrite((v) => !v)}
          color="#3b82f6"
          compact={isMobile}
        />
        <ActionButton
          label="Write"
          onClick={handleSubmitWrite}
          clickCount={writeClicks}
          color="#3b82f6"
          compact={isMobile}
        />
      </div>
      {!isMobile && <Separator />}
      <div style={{ display: 'flex', gap: isMobile ? 6 : 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <ToggleButton
          label={hasPartition ? 'Partitioned' : 'Split Network'}
          active={hasPartition}
          onClick={handlePartition}
          color="#ec4899"
          compact={isMobile}
        />
      </div>
      {!isMobile && <Separator />}
      <div style={{ display: 'flex', gap: isMobile ? 6 : 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <ActionButton
          label="Heal All"
          onClick={handleHealAll}
          clickCount={healClicks}
          color="#22c55e"
          compact={isMobile}
        />
        <ActionButton
          label="Reset"
          onClick={handleReset}
          clickCount={resetClicks}
          color="#64748b"
          compact={isMobile}
        />
      </div>
    </div>
  );
}

function Separator() {
  return <div style={{ width: 1, height: 20, background: '#334155' }} />;
}

function ActionButton({
  label,
  onClick,
  clickCount,
  color,
  compact = false,
}: {
  label: string;
  onClick: () => void;
  clickCount: number;
  color: string;
  compact?: boolean;
}) {
  const [hovered, setHovered] = useState(false);
  const [animating, setAnimating] = useState(false);
  const prevCount = useRef(clickCount);

  if (clickCount !== prevCount.current) {
    prevCount.current = clickCount;
    requestAnimationFrame(() => {
      setAnimating(false);
      requestAnimationFrame(() => setAnimating(true));
      setTimeout(() => setAnimating(false), 150);
    });
  }

  const bg = animating
    ? `${color}80`
    : hovered
      ? `${color}40`
      : `${color}20`;

  return (
    <button
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        padding: compact ? '5px 10px' : '6px 12px',
        background: bg,
        border: `1px solid ${color}`,
        borderRadius: 6,
        color: animating ? '#ffffff' : '#e0e6ed',
        cursor: 'pointer',
        fontSize: compact ? 11 : 12,
        fontWeight: 500,
        transition: 'background 0.08s, color 0.08s',
        whiteSpace: 'nowrap',
      }}
    >
      {label}
    </button>
  );
}

function ToggleButton({
  label,
  active,
  onClick,
  color,
  compact = false,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
  color: string;
  compact?: boolean;
}) {
  const [hovered, setHovered] = useState(false);

  const bg = active
    ? `${color}60`
    : hovered
      ? `${color}30`
      : `${color}15`;

  return (
    <button
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        padding: compact ? '5px 10px' : '6px 12px',
        background: bg,
        border: `1px solid ${active ? color : `${color}80`}`,
        borderRadius: 6,
        color: active ? '#ffffff' : '#e0e6ed',
        cursor: 'pointer',
        fontSize: compact ? 11 : 12,
        fontWeight: 500,
        transition: 'background 0.12s, color 0.12s, border-color 0.12s',
        whiteSpace: 'nowrap',
      }}
    >
      {active ? `■ ${label}` : label}
    </button>
  );
}
