import { useCallback, useState } from 'react';
import { WorldMap } from './components/WorldMap';
import { Sidebar } from './components/Sidebar';
import { ChaosControls } from './components/ChaosControls';
import { useClusterSocket } from './hooks/useClusterSocket';
import type { ClientMessage } from './types';

export function App() {
  const { nodes, faults, events, connected, sendMessage, drainNewEvents, logLines } = useClusterSocket();
  // Start closed on mobile (drawer is hidden by default); open on desktop (sidebar always visible)
  const [sidebarOpen, setSidebarOpen] = useState(() =>
    typeof window !== 'undefined' ? window.innerWidth >= 1024 : true,
  );

  const handleAction = useCallback((msg: ClientMessage) => {
    sendMessage(msg);
  }, [sendMessage]);

  return (
    <div style={{ width: '100%', height: '100%', position: 'relative' }}>
      <WorldMap
        nodes={nodes}
        faults={faults}
        events={events}
        drainNewEvents={drainNewEvents}
        mode="chaos"
        onAction={handleAction}
        sidebarOpen={sidebarOpen}
      />
      <Sidebar logLines={logLines} onOpenChange={setSidebarOpen} />
      <ChaosControls
        nodes={nodes}
        faults={faults}
        onAction={handleAction}
      />
      {!connected && (
        <div style={{
          position: 'absolute', top: 16, left: '50%', transform: 'translateX(-50%)',
          background: 'rgba(220, 38, 38, 0.9)', padding: '8px 16px', borderRadius: 8,
          fontSize: 14, fontWeight: 500,
        }}>
          Reconnecting...
        </div>
      )}
    </div>
  );
}
