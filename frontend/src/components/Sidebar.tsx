import { useState, useEffect, useRef } from 'react';
import type { LogLine } from '../hooks/useClusterSocket';

interface SidebarProps {
  logLines: LogLine[];
  onOpenChange?: (open: boolean) => void;
}

const BREAKPOINT = 1024; // Simplified breakpoint

export function Sidebar({ logLines, onOpenChange }: SidebarProps) {
  // Desktop (>=1024px): right sidebar always visible (no toggle)
  // Mobile (<1024px): bottom drawer with toggle
  const [isDesktop, setIsDesktop] = useState(() => {
    if (typeof window !== 'undefined') {
      return window.innerWidth >= BREAKPOINT;
    }
    return true;
  });
  const [open, setOpen] = useState(false); // Only used for mobile drawer
  const scrollRef = useRef<HTMLDivElement>(null);

  // Detect viewport changes
  useEffect(() => {
    const checkViewport = () => {
      const desktop = window.innerWidth >= BREAKPOINT;
      const wasDesktop = isDesktop;
      setIsDesktop(desktop);
      // Close drawer when switching to mobile
      if (!desktop && wasDesktop) {
        setOpen(false);
        onOpenChange?.(false);
      }
      // Notify parent when switching to desktop (always open)
      if (desktop && !wasDesktop) {
        onOpenChange?.(true);
      }
    };
    window.addEventListener('resize', checkViewport);
    return () => window.removeEventListener('resize', checkViewport);
  }, [isDesktop, onOpenChange]);

  // Notify parent of open state changes
  const toggleOpen = () => {
    setOpen((v) => {
      const newOpen = !v;
      onOpenChange?.(newOpen);
      return newOpen;
    });
  };

  // Auto-scroll to bottom on new entries
  useEffect(() => {
    const el = scrollRef.current;
    if (el) {
      el.scrollTop = el.scrollHeight;
    }
  }, [logLines]);

  // Mobile (<1024px): Bottom drawer
  // Desktop (>=1024px): Right sidebar

  if (!isDesktop) {
    // Mobile: bottom drawer (doesn't cover map)
    return (
      <>
        {/* Toggle button - fixed in bottom-right */}
        <button
          onClick={toggleOpen}
          style={{
            position: 'absolute',
            bottom: 12,
            right: 12,
            zIndex: 20,
            padding: '6px 10px',
            background: 'rgba(10, 14, 23, 0.85)',
            border: '1px solid #1e293b',
            borderRadius: 6,
            color: '#94a3b8',
            cursor: 'pointer',
            fontSize: 11,
            fontWeight: 500,
            whiteSpace: 'nowrap',
            backdropFilter: 'blur(8px)',
          }}
        >
          {open ? 'Hide Log' : 'Show Log'}
        </button>

        {/* Bottom drawer */}
        <div
          style={{
            position: 'absolute',
            bottom: open ? 0 : '-50%',
            left: 0,
            right: 0,
            height: '50%',
            background: 'rgba(10, 14, 23, 0.95)',
            borderTop: '1px solid #1e293b',
            backdropFilter: 'blur(12px)',
            display: 'flex',
            flexDirection: 'column',
            transition: 'bottom 0.25s cubic-bezier(0.4, 0, 0.2, 1)',
            zIndex: 15,
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

        {/* Mobile overlay backdrop */}
        {open && (
          <div
            onClick={toggleOpen}
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              right: 0,
              bottom: 0,
              background: 'rgba(0, 0, 0, 0.5)',
              zIndex: 14,
            }}
          />
        )}
      </>
    );
  }

  // Desktop: right sidebar (always visible, no toggle)
  return (
    <>
      {/* Right sidebar panel - always visible on desktop */}
      <div
        style={{
          position: 'absolute',
          top: 0,
          right: 0,
          width: 340,
          height: '100vh',
          background: 'rgba(10, 14, 23, 0.95)',
          borderLeft: '1px solid #1e293b',
          backdropFilter: 'blur(12px)',
          display: 'flex',
          flexDirection: 'column',
          zIndex: 15,
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
