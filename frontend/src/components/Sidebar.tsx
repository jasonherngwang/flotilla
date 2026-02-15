import { useState, useEffect, useRef } from 'react';
import type { LogLine } from '../hooks/useClusterSocket';

const WIDTH = 340;

interface SidebarProps {
  logLines: LogLine[];
}

export function Sidebar({ logLines }: SidebarProps) {
  const [open, setOpen] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom on new entries
  useEffect(() => {
    const el = scrollRef.current;
    if (el) {
      el.scrollTop = el.scrollHeight;
    }
  }, [logLines]);

  return (
    <>
      {/* Toggle tab - always visible */}
      <button
        onClick={() => setOpen((v) => !v)}
        style={{
          position: 'absolute',
          top: 12,
          right: open ? WIDTH + 8 : 8,
          zIndex: 10,
          padding: '6px 10px',
          background: 'rgba(10, 14, 23, 0.85)',
          border: '1px solid #1e293b',
          borderRadius: 6,
          color: '#94a3b8',
          cursor: 'pointer',
          fontSize: 11,
          fontWeight: 500,
          transition: 'right 0.25s cubic-bezier(0.4, 0, 0.2, 1)',
          whiteSpace: 'nowrap',
        }}
      >
        {open ? 'Hide Log' : 'Show Log'}
      </button>

      {/* Sliding panel */}
      <div
        style={{
          position: 'absolute',
          top: 0,
          right: open ? 0 : -WIDTH,
          width: WIDTH,
          height: '100vh',
          background: 'rgba(10, 14, 23, 0.95)',
          borderLeft: '1px solid #1e293b',
          backdropFilter: 'blur(12px)',
          display: 'flex',
          flexDirection: 'column',
          transition: 'right 0.25s cubic-bezier(0.4, 0, 0.2, 1)',
        }}
      >
        <div
          style={{
            padding: '12px 16px',
            fontSize: 11,
            fontWeight: 600,
            color: '#64748b',
            textTransform: 'uppercase',
            letterSpacing: '0.5px',
            borderBottom: '1px solid #1e293b',
            flexShrink: 0,
          }}
        >
          Log
        </div>
        <div
          ref={scrollRef}
          style={{
            flex: 1,
            overflow: 'auto',
            padding: '8px 16px',
            fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace',
            fontSize: 11,
            lineHeight: 1.7,
          }}
        >
          {logLines.length === 0 ? (
            <div style={{ color: '#64748b' }}>Waiting for events...</div>
          ) : (
            logLines.map((line) => (
              <div key={line.id} style={{ color: line.color }}>
                {line.text}
              </div>
            ))
          )}
        </div>
      </div>
    </>
  );
}
