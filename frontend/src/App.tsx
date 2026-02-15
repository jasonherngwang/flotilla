import { useCallback } from 'react';
import { WorldMap } from './components/WorldMap';
import { Sidebar } from './components/Sidebar';
import { ChaosControls } from './components/ChaosControls';
import { useClusterSocket } from './hooks/useClusterSocket';
import type { ClientMessage } from './types';

export function App() {
  const { nodes, faults, events, connected, sendMessage, drainNewEvents, logLines } = useClusterSocket();

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
      />
      <Sidebar logLines={logLines} />
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
