// Re-export shared types for the frontend
export type {
  NodeId,
  Role,
  NodeConfig,
  NodeMeta,
  Fault,
  FaultType,
  ClusterEvent,
  ClientMessage,
  LogEntry,
} from '../../src/types';

export { NODES, NODE_IDS } from '../../src/types';

// Frontend-specific NodeState with serialized types (Maps become plain objects over JSON)
import type {
  NodeState as BackendNodeState,
  Fault,
  ClusterEvent,
} from '../../src/types';

export interface NodeState extends Omit<BackendNodeState, 'matchIndex' | 'nextIndex'> {
  matchIndex?: Record<string, number>;
  nextIndex?: Record<string, number>;
}

// Frontend-specific ServerMessage with serialized NodeState
export type ServerMessage =
  | { type: 'snapshot'; nodes: NodeState[]; faults: Fault[] }
  | { type: 'event'; event: ClusterEvent }
  | { type: 'fault_injected'; fault: Fault }
  | { type: 'fault_healed'; faultId: string }
  | { type: 'user_action'; action: string; target?: string; clientIp: string; timestamp: number }
  | { type: 'error'; message: string };
