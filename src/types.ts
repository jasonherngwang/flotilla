// -- Node identity + geography --
export type NodeId = 'A' | 'B' | 'C' | 'D' | 'E';
export type Role = 'follower' | 'candidate' | 'leader';

export interface NodeConfig {
  id: NodeId;
  locationHint: string;
  city: string;
  lat: number;
  lng: number;
}

export const NODES: Record<NodeId, NodeConfig> = {
  A: { id: 'A', locationHint: 'wnam', city: 'Los Angeles', lat: 34.05, lng: -118.25 },
  B: { id: 'B', locationHint: 'sam', city: 'São Paulo', lat: -23.55, lng: -46.63 },
  C: { id: 'C', locationHint: 'weur', city: 'Frankfurt', lat: 50.11, lng: 8.68 },
  D: { id: 'D', locationHint: 'apac', city: 'Tokyo', lat: 35.68, lng: 139.69 },
  E: { id: 'E', locationHint: 'oc', city: 'Sydney', lat: -33.87, lng: 151.21 },
};

export const NODE_IDS: NodeId[] = ['A', 'B', 'C', 'D', 'E'];

// -- Raft RPC types --
export interface RequestVoteArgs {
  term: number;
  candidateId: NodeId;
  lastLogIndex: number;
  lastLogTerm: number;
}

export interface RequestVoteResult {
  term: number;
  voteGranted: boolean;
}

export interface AppendEntriesArgs {
  term: number;
  leaderId: NodeId;
  prevLogIndex: number;
  prevLogTerm: number;
  entries: LogEntry[];
  leaderCommit: number;
}

export interface AppendEntriesResult {
  term: number;
  success: boolean;
  lastLogIndex?: number; // Follower's actual last log index (for fast nextIndex rollback)
}

export interface LogEntry {
  idx: number;
  term: number;
  command: Command;
}

export interface Command {
  type: 'noop' | 'data';
  clientId: string;
  timestamp: number;
}

// -- Fault types --
export interface FaultState {
  crashed: boolean;
  partitionedFrom: Set<NodeId>;
  latencyMs: number;
}

export type FaultType = 'thunderstorm' | 'earthquake';

export interface Fault {
  id: string;
  type: FaultType;
  target: string;
  source: 'weather' | `manual:${string}`;
  startedAt: number;
}

// -- Cluster events (Raft nodes push to Cluster Manager) --
export type ClusterEvent =
  | { type: 'role_change'; nodeId: NodeId; from: Role; to: Role; term: number; timestamp: number }
  | { type: 'election_start'; nodeId: NodeId; term: number; timestamp: number }
  | { type: 'vote_granted'; from: NodeId; to: NodeId; term: number; timestamp: number }
  | { type: 'log_appended'; nodeId: NodeId; index: number; term: number; timestamp: number }
  | { type: 'log_committed'; nodeId: NodeId; index: number; term: number; timestamp: number }
  | { type: 'log_truncated'; nodeId: NodeId; fromIndex: number; count: number; timestamp: number }
  | { type: 'heartbeat_sent'; from: NodeId; to: NodeId; term: number; latencyMs: number; timestamp: number }
  | { type: 'heartbeat_ack'; from: NodeId; to: NodeId; term: number; success: boolean; latencyMs: number; timestamp: number }
  | { type: 'rpc_dropped'; from: NodeId; to: NodeId; rpcType: string; reason: string; timestamp: number };

// -- Durable Object metadata --
export interface NodeMeta {
  doId: string;         // First 12 chars of hex DO ID
  storageKb: number;    // SQLite DB size in KB
  logEntries: number;   // Number of raft_log rows
  uptimeMs: number;     // Time since DO instantiation
  rpcCount: number;     // Total RPC calls handled
}

// -- Node state snapshot --
export interface NodeState {
  id: NodeId;
  role: Role;
  term: number;
  commitIndex: number;
  logLength: number;
  faultState: { crashed: boolean; partitionedFrom: NodeId[]; latencyMs: number };
  // Detailed Raft internals
  votedFor: NodeId | null;
  lastApplied: number;
  // Leader-specific state (null for followers)
  matchIndex?: Map<NodeId, number>;
  nextIndex?: Map<NodeId, number>;
  // Durable Object metadata
  meta?: NodeMeta;
}

// -- WebSocket protocol --
export type ServerMessage =
  | { type: 'snapshot'; nodes: NodeState[]; faults: Fault[] }
  | { type: 'event'; event: ClusterEvent }
  | { type: 'fault_injected'; fault: Fault }
  | { type: 'fault_healed'; faultId: string }
  | { type: 'user_action'; action: string; target?: string; clientIp: string; timestamp: number }
  | { type: 'error'; message: string };

export type ClientMessage =
  | { type: 'crash_node'; nodeId: NodeId }
  | { type: 'heal_node'; nodeId: NodeId }
  | { type: 'partition'; groups: NodeId[][] }
  | { type: 'heal_partition' }
  | { type: 'heal_all' }
  | { type: 'submit_write' }
  | { type: 'reset' };

// -- RPC interfaces --
export interface RaftNodeRPC {
  initialize(nodeId: NodeId, peerIds: NodeId[], managerId: string): Promise<void>;
  requestVote(args: RequestVoteArgs): Promise<RequestVoteResult>;
  appendEntries(args: AppendEntriesArgs): Promise<AppendEntriesResult>;
  injectFault(fault: Fault): Promise<void>;
  healFault(faultId: string): Promise<void>;
  getState(): Promise<NodeState>;
  getHeartbeat(): Promise<{ role: Role; term: number; commitIndex: number }>;
  submitCommand(command: Command): Promise<{ success: boolean; leaderId?: NodeId }>;
  shutdown(): Promise<void>;
}

export interface ClusterManagerRPC {
  pushEvent(event: ClusterEvent): Promise<void>;
  injectFault(fault: Fault): Promise<void>;
  healFault(faultId: string): Promise<void>;
}
