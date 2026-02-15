import { useState, useEffect, useRef, useCallback } from 'react';
import type { NodeState, Fault, ClusterEvent, ServerMessage, ClientMessage } from '../types';

export interface ElectionInfo {
  term: number;
  candidate: string;
  votes: { voter: string; votedFor: string }[];
  timestamp: number;
}

export interface LogLine {
  id: number;
  text: string;
  color: string;
  timestamp: number;
}

const MAX_EVENTS = 100;
const MAX_LOG_LINES = 50;
const RECONNECT_DELAYS = [1000, 2000, 4000, 8000, 16000, 30000];

export function useClusterSocket() {
  const [nodes, setNodes] = useState<NodeState[]>([]);
  const [faults, setFaults] = useState<Fault[]>([]);
  const [events, setEvents] = useState<ClusterEvent[]>([]);
  const [connected, setConnected] = useState(false);
  const [latestElection, setLatestElection] = useState<ElectionInfo | null>(null);
  const [logLines, setLogLines] = useState<LogLine[]>([]);
  const logIdRef = useRef(0);

  const addLog = useCallback((text: string, color: string) => {
    const id = ++logIdRef.current;
    setLogLines((prev) => {
      const next = [...prev, { id, text, color, timestamp: Date.now() }];
      return next.length > MAX_LOG_LINES ? next.slice(-MAX_LOG_LINES) : next;
    });
  }, []);

  // Batch follower replications: collect per-index, flush after 200ms
  const replicationBatchRef = useRef<Map<number, { nodes: string[]; catchUp: boolean }>>(new Map());
  const replicationTimerRef = useRef<number>(0);

  const flushReplicationBatch = useCallback(() => {
    const batch = replicationBatchRef.current;
    // Sort by index so logs appear in order
    const entries = Array.from(batch.entries()).sort((a, b) => a[0] - b[0]);
    for (const [index, { nodes: nodeIds, catchUp }] of entries) {
      const names = nodeIds.join(', ');
      if (catchUp) {
        addLog(`  ↑ ${names} catching up → ${index}`, '#38bdf8');
      } else {
        addLog(`  └ ${names} replicated index ${index}`, '#64748b');
      }
    }
    batch.clear();
  }, [addLog]);

  const batchFollowerReplication = useCallback((nodeId: string, index: number, catchUp: boolean) => {
    const batch = replicationBatchRef.current;
    const existing = batch.get(index);
    if (existing) {
      existing.nodes.push(nodeId);
      // If mixed catch-up and normal for same index, prefer catch-up label
      if (catchUp) existing.catchUp = true;
    } else {
      batch.set(index, { nodes: [nodeId], catchUp });
    }
    clearTimeout(replicationTimerRef.current);
    replicationTimerRef.current = window.setTimeout(flushReplicationBatch, 200);
  }, [flushReplicationBatch]);

  // Buffer for new events that WorldMap can drain for particle creation.
  // This avoids the bug where particle tracking by array index breaks
  // when events are trimmed at MAX_EVENTS.
  const newEventBufferRef = useRef<ClusterEvent[]>([]);

  const wsRef = useRef<WebSocket | null>(null);
  const reconnectAttemptRef = useRef(0);
  const reconnectTimerRef = useRef<number>(0);

  const connect = useCallback(() => {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/ws`;

    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      setConnected(true);
      reconnectAttemptRef.current = 0;
    };

    ws.onmessage = (event) => {
      try {
        const msg: ServerMessage = JSON.parse(event.data);

        switch (msg.type) {
          case 'snapshot':
            setNodes(msg.nodes);
            setFaults(msg.faults);
            break;

          case 'event':
            setEvents((prev) => {
              const next = [...prev, msg.event];
              return next.length > MAX_EVENTS ? next.slice(-MAX_EVENTS) : next;
            });
            newEventBufferRef.current.push(msg.event);
            // Persist election info (survives event buffer trimming)
            if (msg.event.type === 'election_start') {
              setLatestElection({
                term: msg.event.term,
                candidate: msg.event.nodeId,
                votes: [],
                timestamp: msg.event.timestamp,
              });
            } else if (msg.event.type === 'vote_granted') {
              const { from: voter, to: votedFor, term: voteTerm } = msg.event;
              setLatestElection((prev) => {
                if (prev && prev.term === voteTerm) {
                  return {
                    ...prev,
                    votes: [...prev.votes, { voter, votedFor }],
                  };
                }
                return prev;
              });
            }
            // Update node state from events for real-time responsiveness
            if (msg.event.type === 'role_change') {
              const e = msg.event;
              setNodes((prev) => prev.map((n) =>
                n.id === e.nodeId ? { ...n, role: e.to, term: e.term } : n,
              ));
              if (e.to === 'leader') {
                addLog(`  ✓ Node ${e.nodeId} won election → leader`, '#f59e0b');
              } else if (e.to === 'candidate') {
                addLog(`Node ${e.nodeId} started election (term ${e.term})`, '#a855f7');
              }
            } else if (msg.event.type === 'log_appended') {
              const e = msg.event;
              // Show appended-but-not-yet-committed writes (visible during partitions)
              setNodes((prev) => {
                const node = prev.find((n) => n.id === e.nodeId);
                if (node?.role === 'leader') {
                  addLog(`Node ${e.nodeId} appended index ${e.index} (uncommitted)`, '#94a3b8');
                }
                return prev.map((n) =>
                  n.id === e.nodeId
                    ? { ...n, logLength: Math.max(n.logLength, e.index) }
                    : n,
                );
              });
            } else if (msg.event.type === 'log_committed') {
              const e = msg.event;
              setNodes((prev) => {
                const committingNode = prev.find((n) => n.id === e.nodeId);
                const isLeader = committingNode?.role === 'leader';
                if (isLeader) {
                  // Flush any pending follower batch before logging leader commit
                  if (replicationBatchRef.current.size > 0) {
                    clearTimeout(replicationTimerRef.current);
                    flushReplicationBatch();
                  }
                  addLog(`Node ${e.nodeId} committed index ${e.index}`, '#22c55e');
                } else {
                  // Compare against highest leader commit (handles split-brain with multiple leaders)
                  const maxLeaderCommit = Math.max(
                    ...prev.filter((n) => n.role === 'leader').map((n) => n.commitIndex),
                    0,
                  );
                  const isCatchUp = e.index < maxLeaderCommit - 1; // 2+ behind = catching up
                  batchFollowerReplication(e.nodeId, e.index, isCatchUp);
                }
                return prev.map((n) =>
                  n.id === e.nodeId
                    ? { ...n, commitIndex: e.index, logLength: Math.max(n.logLength, e.index) }
                    : n,
                );
              });
            } else if (msg.event.type === 'vote_granted') {
              const { from, to } = msg.event;
              addLog(`  └ Node ${from} voted for Node ${to}`, '#94a3b8');
            }
            break;

          case 'fault_injected':
            setFaults((prev) => [...prev, msg.fault]);
            // Update node faultState for immediate click-to-crash feedback
            if (msg.fault.type === 'thunderstorm') {
              setNodes((prev) => prev.map((n) =>
                n.id === msg.fault.target
                  ? { ...n, faultState: { ...n.faultState, crashed: true } }
                  : n,
              ));
              addLog(`Node ${msg.fault.target} crashed`, '#ef4444');
            } else if (msg.fault.type === 'earthquake') {
              addLog(`Network partition injected`, '#ef4444');
              // Log group membership with roles
              const groups = msg.fault.target.split('|').map((g) => g.split(','));
              setNodes((prev) => {
                groups.forEach((group, gi) => {
                  const members = group.map((id) => {
                    const n = prev.find((node) => node.id === id);
                    const role = n?.faultState.crashed ? 'crashed' : n?.role ?? '?';
                    return `${id} (${role})`;
                  });
                  const pColors = ['#ec4899', '#14b8a6']; // match map partition colors
                  addLog(`  P${gi + 1}: ${members.join(', ')}`, pColors[gi % pColors.length]);
                });
                return prev; // no state change
              });
            }
            break;

          case 'fault_healed':
            setFaults((prev) => {
              const healedFault = prev.find((f) => f.id === msg.faultId);
              // If the healed fault was a thunderstorm, uncrash the node
              if (healedFault?.type === 'thunderstorm') {
                addLog(`Node ${healedFault.target} healed`, '#22c55e');
                const remaining = prev.filter((f) => f.id !== msg.faultId);
                const stillCrashed = remaining.some(
                  (f) => f.type === 'thunderstorm' && f.target === healedFault.target,
                );
                if (!stillCrashed) {
                  setNodes((prevNodes) => prevNodes.map((n) =>
                    n.id === healedFault.target
                      ? {
                          ...n,
                          role: 'follower', // Healed nodes always restart as followers
                          faultState: { ...n.faultState, crashed: false },
                        }
                      : n,
                  ));
                }
              } else if (healedFault?.type === 'earthquake') {
                addLog(`Network partition healed — all nodes reconnected`, '#22c55e');
              }
              return prev.filter((f) => f.id !== msg.faultId);
            });
            break;
        }
      } catch {
        // Malformed message
      }
    };

    ws.onclose = () => {
      setConnected(false);
      wsRef.current = null;

      // Reconnect with exponential backoff
      const attempt = reconnectAttemptRef.current;
      const delay = RECONNECT_DELAYS[Math.min(attempt, RECONNECT_DELAYS.length - 1)];
      reconnectAttemptRef.current++;
      reconnectTimerRef.current = window.setTimeout(connect, delay);
    };

    ws.onerror = () => {
      ws.close();
    };
  }, []);

  useEffect(() => {
    connect();
    return () => {
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      if (wsRef.current) wsRef.current.close();
    };
  }, [connect]);

  const sendMessage = useCallback((msg: ClientMessage) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(msg));
    }
    if (msg.type === 'reset') {
      setEvents([]);
      setLogLines([]);
      setLatestElection(null);
      newEventBufferRef.current = [];
      replicationBatchRef.current.clear();
      clearTimeout(replicationTimerRef.current);
    }
  }, []);

  // Drain buffered events for particle creation (called by WorldMap draw loop)
  const drainNewEvents = useCallback((): ClusterEvent[] => {
    const buf = newEventBufferRef.current;
    if (buf.length === 0) return buf;
    newEventBufferRef.current = [];
    return buf;
  }, []);

  return { nodes, faults, events, connected, sendMessage, drainNewEvents, latestElection, logLines };
}
