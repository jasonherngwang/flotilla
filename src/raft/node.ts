import { DurableObject } from 'cloudflare:workers';
import type {
  NodeId,
  Role,
  RequestVoteArgs,
  RequestVoteResult,
  AppendEntriesArgs,
  AppendEntriesResult,
  LogEntry,
  Command,
  Fault,
  FaultState,
  NodeState,
  NodeMeta,
  ClusterEvent,
} from '../types';

const HEARTBEAT_INTERVAL_MS = 2000;
const ELECTION_TIMEOUT_MIN_MS = 5000;
const ELECTION_TIMEOUT_MAX_MS = 15000;
const RPC_TIMEOUT_MS = 8000;

function randomElectionTimeout(): number {
  return ELECTION_TIMEOUT_MIN_MS + Math.floor(Math.random() * (ELECTION_TIMEOUT_MAX_MS - ELECTION_TIMEOUT_MIN_MS));
}

export class RaftNode extends DurableObject<Env> {
  // Volatile state (lost on eviction)
  private role: Role = 'follower';
  private commitIndex = 0;
  private lastApplied = 0;
  private nextIndex = new Map<NodeId, number>();
  private matchIndex = new Map<NodeId, number>();
  private peerStubs = new Map<NodeId, DurableObjectStub>();
  private managerStub: DurableObjectStub | null = null;
  private faultState: FaultState = { crashed: false, partitionedFrom: new Set(), latencyMs: 0 };
  private nodeId: NodeId = 'A';
  private peerIds: NodeId[] = [];
  private initialized = false;

  // DO metadata tracking
  private readonly instantiatedAt = Date.now();
  private rpcCount = 0;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => this.migrate());
  }

  private migrate() {
    // Use CREATE TABLE IF NOT EXISTS for idempotent migration
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS raft_state (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS raft_log (
        idx INTEGER PRIMARY KEY,
        term INTEGER NOT NULL,
        command TEXT NOT NULL
      );
    `);
  }

  // -- Persistent state helpers --

  // checkIfCrashed removed - replaced by isFaulted() which returns boolean instead of throwing

  private getCurrentTerm(): number {
    const row = this.ctx.storage.sql
      .exec<{ value: string }>("SELECT value FROM raft_state WHERE key = 'currentTerm'")
      .toArray();
    return row.length > 0 ? parseInt(row[0].value, 10) : 0;
  }

  private setCurrentTerm(term: number) {
    this.ctx.storage.sql.exec(
      "INSERT OR REPLACE INTO raft_state (key, value) VALUES ('currentTerm', ?)",
      String(term),
    );
  }

  private getVotedFor(): NodeId | null {
    const row = this.ctx.storage.sql
      .exec<{ value: string }>("SELECT value FROM raft_state WHERE key = 'votedFor'")
      .toArray();
    return row.length > 0 && row[0].value !== '' ? (row[0].value as NodeId) : null;
  }

  private setVotedFor(nodeId: NodeId | null) {
    this.ctx.storage.sql.exec(
      "INSERT OR REPLACE INTO raft_state (key, value) VALUES ('votedFor', ?)",
      nodeId ?? '',
    );
  }

  private getLastLogIndex(): number {
    const row = this.ctx.storage.sql
      .exec<{ idx: number }>('SELECT MAX(idx) as idx FROM raft_log')
      .toArray();
    return row.length > 0 && row[0].idx != null ? row[0].idx : 0;
  }

  private getLastLogTerm(): number {
    const lastIdx = this.getLastLogIndex();
    if (lastIdx === 0) return 0;
    const row = this.ctx.storage.sql
      .exec<{ term: number }>('SELECT term FROM raft_log WHERE idx = ?', lastIdx)
      .toArray();
    return row.length > 0 ? row[0].term : 0;
  }

  private getLogEntry(idx: number): LogEntry | null {
    const row = this.ctx.storage.sql
      .exec<{ idx: number; term: number; command: string }>('SELECT idx, term, command FROM raft_log WHERE idx = ?', idx)
      .toArray();
    if (row.length === 0) return null;
    return { idx: row[0].idx, term: row[0].term, command: JSON.parse(row[0].command) };
  }

  private getLogEntries(fromIdx: number): LogEntry[] {
    return this.ctx.storage.sql
      .exec<{ idx: number; term: number; command: string }>('SELECT idx, term, command FROM raft_log WHERE idx >= ? ORDER BY idx', fromIdx)
      .toArray()
      .map((r) => ({ idx: r.idx, term: r.term, command: JSON.parse(r.command) }));
  }

  private appendLogEntry(entry: LogEntry) {
    this.ctx.storage.sql.exec(
      'INSERT OR REPLACE INTO raft_log (idx, term, command) VALUES (?, ?, ?)',
      entry.idx,
      entry.term,
      JSON.stringify(entry.command),
    );
  }

  private deleteLogFrom(fromIdx: number) {
    this.ctx.storage.sql.exec('DELETE FROM raft_log WHERE idx >= ?', fromIdx);
  }

  private getLogLength(): number {
    const row = this.ctx.storage.sql
      .exec<{ cnt: number }>('SELECT COUNT(*) as cnt FROM raft_log')
      .toArray();
    return row.length > 0 ? row[0].cnt : 0;
  }

  // -- Fault checking --

  /** Returns true if the node should reject the request (crashed or partitioned) */
  private isFaulted(senderId?: NodeId): boolean {
    if (this.faultState.crashed) return true;
    if (senderId && this.faultState.partitionedFrom.has(senderId)) return true;
    return false;
  }

  /** Simulate cross-datacenter network latency */
  private async applyLatency(): Promise<void> {
    // Base simulated latency: real cross-continent RTTs are 50-200ms,
    // inflated here for visual effect on the map
    const networkDelay = 150 + Math.floor(Math.random() * 250);
    const totalDelay = networkDelay + this.faultState.latencyMs;
    await new Promise((resolve) => setTimeout(resolve, totalDelay));
  }

  // -- Event push helper --

  private pushEvent(event: ClusterEvent) {
    if (this.managerStub) {
      (this.managerStub as any).pushEvent(event).catch((err: unknown) => {
        console.warn(JSON.stringify({ message: 'event_push_failed', nodeId: this.nodeId, error: String(err) }));
      });
    }
  }

  // -- Role transitions --

  private becomeFollower(term: number) {
    const prevRole = this.role;
    this.role = 'follower';
    this.setCurrentTerm(term);
    this.setVotedFor(null);
    if (prevRole !== 'follower') {
      this.pushEvent({
        type: 'role_change',
        nodeId: this.nodeId,
        from: prevRole,
        to: 'follower',
        term,
        timestamp: Date.now(),
      });
    }
  }

  private becomeCandidate() {
    const newTerm = this.getCurrentTerm() + 1;
    this.role = 'candidate';
    // Persist term and self-vote atomically (no await between)
    this.setCurrentTerm(newTerm);
    this.setVotedFor(this.nodeId);
    this.pushEvent({
      type: 'role_change',
      nodeId: this.nodeId,
      from: 'follower',
      to: 'candidate',
      term: newTerm,
      timestamp: Date.now(),
    });
    this.pushEvent({
      type: 'election_start',
      nodeId: this.nodeId,
      term: newTerm,
      timestamp: Date.now(),
    });
  }

  private becomeLeader() {
    const term = this.getCurrentTerm();
    const prevRole = this.role;
    this.role = 'leader';
    const lastIdx = this.getLastLogIndex();
    for (const peerId of this.peerIds) {
      this.nextIndex.set(peerId, lastIdx + 1);
      this.matchIndex.set(peerId, 0);
    }
    this.pushEvent({
      type: 'role_change',
      nodeId: this.nodeId,
      from: prevRole,
      to: 'leader',
      term,
      timestamp: Date.now(),
    });
  }

  // -- Apply committed entries --

  private applyCommitted() {
    while (this.lastApplied < this.commitIndex) {
      this.lastApplied++;
      const entry = this.getLogEntry(this.lastApplied);
      if (entry) {
        this.pushEvent({
          type: 'log_committed',
          nodeId: this.nodeId,
          index: entry.idx,
          term: entry.term,
          timestamp: Date.now(),
        });
      }
    }
  }

  // -- Advance commit index (leader only) --

  private advanceCommitIndex() {
    const currentTerm = this.getCurrentTerm();
    for (let n = this.getLastLogIndex(); n > this.commitIndex; n--) {
      const entry = this.getLogEntry(n);
      if (!entry || entry.term !== currentTerm) continue;
      let replicatedCount = 1; // self
      for (const peerId of this.peerIds) {
        if ((this.matchIndex.get(peerId) ?? 0) >= n) {
          replicatedCount++;
        }
      }
      if (replicatedCount > Math.floor((this.peerIds.length + 1) / 2)) {
        this.commitIndex = n;
        this.applyCommitted();
        break;
      }
    }
  }

  // -- Schedule alarm --

  private async scheduleElectionTimeout() {
    await this.ctx.storage.setAlarm(Date.now() + randomElectionTimeout());
  }

  private async scheduleHeartbeat() {
    await this.ctx.storage.setAlarm(Date.now() + HEARTBEAT_INTERVAL_MS);
  }

  // -- Public RPC methods --

  async initialize(nodeId: NodeId, peerIds: NodeId[], managerId: string): Promise<void> {
    this.nodeId = nodeId;
    this.peerIds = peerIds;

    // Always clear crash state on init (handles recovery after triggerCrash)
    this.faultState.crashed = false;
    this.faultState.partitionedFrom.clear();
    this.faultState.latencyMs = 0;
    this.ctx.storage.sql.exec("DELETE FROM raft_state WHERE key = 'crashed'");

    // Create stubs
    for (const peerId of peerIds) {
      this.peerStubs.set(peerId, this.env.RAFT_NODE.getByName(peerId));
    }
    this.managerStub = this.env.CLUSTER_MANAGER.getByName(managerId);

    // Clear all persistent state for a fresh start each session
    this.ctx.storage.sql.exec('DELETE FROM raft_log');
    this.ctx.storage.sql.exec('DELETE FROM raft_state');
    this.commitIndex = 0;
    this.lastApplied = 0;
    this.role = 'follower';

    this.initialized = true;
    await this.scheduleElectionTimeout();

    console.log(JSON.stringify({
      message: 'node_initialized',
      nodeId: this.nodeId,
      term: this.getCurrentTerm(),
      logLength: this.getLogLength(),
    }));
  }

  async requestVote(args: RequestVoteArgs): Promise<RequestVoteResult> {
    this.rpcCount++;
    if (this.isFaulted(args.candidateId)) {
      return { term: 0, voteGranted: false };
    }
    await this.applyLatency();

    return await this.ctx.blockConcurrencyWhile(async () => {
      const currentTerm = this.getCurrentTerm();

      if (args.term > currentTerm) {
        this.becomeFollower(args.term);
      }

      const updatedTerm = this.getCurrentTerm();
      if (args.term < updatedTerm) {
        return { term: updatedTerm, voteGranted: false };
      }

      const votedFor = this.getVotedFor();
      const canVote = votedFor === null || votedFor === args.candidateId;

      // Log up-to-date check (Section 5.4.1)
      const lastLogTerm = this.getLastLogTerm();
      const lastLogIndex = this.getLastLogIndex();
      const logOk =
        args.lastLogTerm > lastLogTerm ||
        (args.lastLogTerm === lastLogTerm && args.lastLogIndex >= lastLogIndex);

      if (canVote && logOk) {
        this.setVotedFor(args.candidateId);
        await this.scheduleElectionTimeout(); // reset election timer
        this.pushEvent({
          type: 'vote_granted',
          from: this.nodeId,
          to: args.candidateId,
          term: updatedTerm,
          timestamp: Date.now(),
        });
        return { term: updatedTerm, voteGranted: true };
      }

      return { term: updatedTerm, voteGranted: false };
    });
  }

  async appendEntries(args: AppendEntriesArgs): Promise<AppendEntriesResult> {
    this.rpcCount++;
    if (this.isFaulted(args.leaderId)) {
      return { term: 0, success: false };
    }
    await this.applyLatency();

    return await this.ctx.blockConcurrencyWhile(async () => {
      const currentTerm = this.getCurrentTerm();

      if (args.term < currentTerm) {
        return { term: currentTerm, success: false };
      }

      if (args.term >= currentTerm) {
        if (this.role !== 'follower' || args.term > currentTerm) {
          this.becomeFollower(args.term);
        }
      }

      // Reset election timeout on valid AppendEntries
      await this.scheduleElectionTimeout();

      const updatedTerm = this.getCurrentTerm();

      // Log matching: check prevLogIndex/prevLogTerm
      if (args.prevLogIndex > 0) {
        const prevEntry = this.getLogEntry(args.prevLogIndex);
        if (!prevEntry || prevEntry.term !== args.prevLogTerm) {
          return { term: updatedTerm, success: false };
        }
      }

      // Conflict resolution + append new entries
      let truncated = false;
      const truncatedEntries: LogEntry[] = [];
      for (const entry of args.entries) {
        const existing = this.getLogEntry(entry.idx);
        if (existing && existing.term !== entry.term) {
          // Conflict: delete this and all following
          const toDelete = this.getLogEntries(entry.idx);
          truncatedEntries.push(...toDelete);
          this.deleteLogFrom(entry.idx);
          truncated = true;
        }
        if (!existing || truncated) {
          this.appendLogEntry(entry);
          truncated = false; // only need to delete once
        }
      }

      if (truncatedEntries.length > 0) {
        this.pushEvent({
          type: 'log_truncated',
          nodeId: this.nodeId,
          fromIndex: truncatedEntries[0].idx,
          count: truncatedEntries.length,
          timestamp: Date.now(),
        });
      }

      // Update commit index
      if (args.leaderCommit > this.commitIndex) {
        const lastNewIdx = args.entries.length > 0 ? args.entries[args.entries.length - 1].idx : this.getLastLogIndex();
        this.commitIndex = Math.min(args.leaderCommit, lastNewIdx);
        this.applyCommitted();
      }

      return { term: updatedTerm, success: true };
    });
  }

  async submitCommand(command: Command): Promise<{ success: boolean; leaderId?: NodeId }> {
    this.rpcCount++;
    if (this.isFaulted()) {
      return { success: false };
    }

    return await this.ctx.blockConcurrencyWhile(async () => {
      if (this.role !== 'leader') {
        return { success: false, leaderId: undefined };
      }

      const term = this.getCurrentTerm();
      const idx = this.getLastLogIndex() + 1;
      const entry: LogEntry = { idx, term, command };
      this.appendLogEntry(entry);

      this.pushEvent({
        type: 'log_appended',
        nodeId: this.nodeId,
        index: idx,
        term,
        timestamp: Date.now(),
      });

      return { success: true };
    });
  }

  async injectFault(fault: Fault): Promise<void> {
    if (fault.type === 'thunderstorm') {
      this.faultState.crashed = true;
      // Persist crash state so it survives DO restarts
      this.ctx.storage.sql.exec(
        "INSERT OR REPLACE INTO raft_state (key, value) VALUES ('crashed', '1')",
      );
      await this.ctx.storage.deleteAlarm();
    } else if (fault.type === 'earthquake') {
      // target field contains comma-separated node IDs to partition from
      const targets = fault.target.split(',') as NodeId[];
      for (const t of targets) {
        this.faultState.partitionedFrom.add(t);
      }
    }

    console.log(JSON.stringify({
      message: 'fault_injected',
      nodeId: this.nodeId,
      fault,
    }));
  }

  /** Recover from a crash: restore in-memory state without wiping persistent log/term */
  async recover(nodeId: NodeId, peerIds: NodeId[], managerId: string): Promise<void> {
    this.nodeId = nodeId;
    this.peerIds = peerIds;

    // Clear crash state only — preserve partition state
    this.faultState.crashed = false;
    this.faultState.latencyMs = 0;
    this.ctx.storage.sql.exec("DELETE FROM raft_state WHERE key = 'crashed'");

    // Restore stubs (DO may have been evicted while crashed)
    for (const peerId of peerIds) {
      this.peerStubs.set(peerId, this.env.RAFT_NODE.getByName(peerId));
    }
    this.managerStub = this.env.CLUSTER_MANAGER.getByName(managerId);

    // Volatile state resets on recovery (Raft spec),
    // but persistent state (log, currentTerm, votedFor) is preserved.
    // Leader will bring commitIndex back up via AppendEntries.leaderCommit.
    this.commitIndex = 0;
    this.lastApplied = 0;
    this.role = 'follower';

    this.initialized = true;
    await this.scheduleElectionTimeout();

    console.log(JSON.stringify({
      message: 'node_recovered',
      nodeId: this.nodeId,
      term: this.getCurrentTerm(),
      logLength: this.getLogLength(),
    }));
  }

  /** Remove specific nodes from partition set (targeted earthquake heal) */
  async healPartition(nodeIds: NodeId[]): Promise<void> {
    for (const id of nodeIds) {
      this.faultState.partitionedFrom.delete(id as NodeId);
    }
    console.log(JSON.stringify({
      message: 'partition_healed',
      nodeId: this.nodeId,
      removedPartitions: nodeIds,
      remainingPartitions: Array.from(this.faultState.partitionedFrom),
    }));
  }

  async healFault(faultId: string): Promise<void> {
    // Legacy: clear all fault state. Only used during boot startup-clear.
    this.faultState.crashed = false;
    this.faultState.partitionedFrom.clear();
    this.faultState.latencyMs = 0;
    this.ctx.storage.sql.exec(
      "DELETE FROM raft_state WHERE key = 'crashed'",
    );

    if (this.initialized) {
      if (this.role === 'leader') {
        await this.scheduleHeartbeat();
      } else {
        await this.scheduleElectionTimeout();
      }
    }
  }

  async triggerCrash(): Promise<void> {
    // Stop all activity - node will reject all RPCs via isFaulted()
    console.log(JSON.stringify({
      message: 'node_crash_triggered',
      nodeId: this.nodeId,
      term: this.getCurrentTerm(),
    }));

    // Clear any pending alarms so the node stops participating
    await this.ctx.storage.deleteAlarm();
  }

  async getState(): Promise<NodeState> {
    // Check both in-memory and persisted crash state
    const isCrashed = this.isFaulted();

    // Gather DO metadata
    const logEntries = this.getLogLength();
    let storageKb = 0;
    try {
      const pageCount = this.ctx.storage.sql
        .exec<{ page_count: number }>('PRAGMA page_count')
        .toArray()[0]?.page_count ?? 0;
      const pageSize = this.ctx.storage.sql
        .exec<{ page_size: number }>('PRAGMA page_size')
        .toArray()[0]?.page_size ?? 4096;
      storageKb = Math.round((pageCount * pageSize) / 1024 * 10) / 10;
    } catch {
      // PRAGMAs may not be authorized in test environments
    }

    const meta: NodeMeta = {
      doId: this.ctx.id.toString().slice(0, 12),
      storageKb,
      logEntries,
      uptimeMs: Date.now() - this.instantiatedAt,
      rpcCount: this.rpcCount,
    };

    const state: NodeState = {
      id: this.nodeId,
      role: this.role,
      term: this.getCurrentTerm(),
      commitIndex: this.commitIndex,
      logLength: this.getLastLogIndex(),
      faultState: {
        crashed: isCrashed,
        partitionedFrom: Array.from(this.faultState.partitionedFrom),
        latencyMs: this.faultState.latencyMs,
      },
      votedFor: this.getVotedFor(),
      lastApplied: this.lastApplied,
      meta,
    };

    // Include leader-specific state
    if (this.role === 'leader') {
      state.matchIndex = new Map(this.matchIndex);
      state.nextIndex = new Map(this.nextIndex);
    }

    return state;
  }

  async getHeartbeat(): Promise<{ role: Role; term: number; commitIndex: number }> {
    return {
      role: this.role,
      term: this.getCurrentTerm(),
      commitIndex: this.commitIndex,
    };
  }

  async shutdown(): Promise<void> {
    await this.ctx.storage.deleteAlarm();
    this.initialized = false;
    console.log(JSON.stringify({ message: 'node_shutdown', nodeId: this.nodeId }));
  }

  // -- Alarm handler --

  async alarm(): Promise<void> {
    if (!this.initialized || this.isFaulted()) return;

    if (this.role === 'leader') {
      await this.sendHeartbeats();
      await this.scheduleHeartbeat();
    } else {
      // Election timeout expired
      await this.startElection();
    }
  }

  // -- Leader heartbeat / AppendEntries --

  private async sendHeartbeats() {
    const currentTerm = this.getCurrentTerm();
    const promises: Promise<void>[] = [];

    for (const peerId of this.peerIds) {
      if (this.faultState.partitionedFrom.has(peerId)) {
        this.pushEvent({
          type: 'rpc_dropped',
          from: this.nodeId,
          to: peerId,
          rpcType: 'appendEntries',
          reason: 'partitioned',
          timestamp: Date.now(),
        });
        continue;
      }

      const stub = this.peerStubs.get(peerId);
      if (!stub) continue;

      const nextIdx = this.nextIndex.get(peerId) ?? 1;
      const prevLogIndex = nextIdx - 1;
      const prevEntry = prevLogIndex > 0 ? this.getLogEntry(prevLogIndex) : null;
      const prevLogTerm = prevEntry?.term ?? 0;
      const entries = this.getLogEntries(nextIdx);

      const startTime = Date.now();
      const promise = Promise.race([
        (stub as unknown as { appendEntries: (args: AppendEntriesArgs) => Promise<AppendEntriesResult> })
          .appendEntries({
            term: currentTerm,
            leaderId: this.nodeId,
            prevLogIndex,
            prevLogTerm,
            entries,
            leaderCommit: this.commitIndex,
          })
          .then((result) => {
            const latencyMs = Date.now() - startTime;
            if (result.term > currentTerm) {
              this.becomeFollower(result.term);
              return;
            }
            // Sentinel: term=0 means the peer is faulted (crashed/partitioned)
            if (result.term === 0 && !result.success) {
              this.pushEvent({
                type: 'rpc_dropped',
                from: this.nodeId,
                to: peerId,
                rpcType: 'appendEntries',
                reason: 'node_faulted',
                timestamp: Date.now(),
              });
              return;
            }
            if (result.success) {
              this.nextIndex.set(peerId, nextIdx + entries.length);
              this.matchIndex.set(peerId, nextIdx + entries.length - 1);
              this.pushEvent({
                type: 'heartbeat_ack',
                from: peerId,
                to: this.nodeId,
                term: currentTerm,
                success: true,
                latencyMs,
                timestamp: Date.now(),
              });
            } else {
              // Decrement nextIndex on failure (log mismatch)
              this.nextIndex.set(peerId, Math.max(1, nextIdx - 1));
              this.pushEvent({
                type: 'heartbeat_ack',
                from: peerId,
                to: this.nodeId,
                term: currentTerm,
                success: false,
                latencyMs,
                timestamp: Date.now(),
              });
            }
          }),
        new Promise<void>((_, reject) => setTimeout(() => reject(new Error('timeout')), RPC_TIMEOUT_MS)),
      ]).catch(() => {
        this.pushEvent({
          type: 'rpc_dropped',
          from: this.nodeId,
          to: peerId,
          rpcType: 'appendEntries',
          reason: 'timeout_or_error',
          timestamp: Date.now(),
        });
      });

      this.pushEvent({
        type: 'heartbeat_sent',
        from: this.nodeId,
        to: peerId,
        term: currentTerm,
        latencyMs: 0, // actual measured on ack
        timestamp: Date.now(),
      });

      promises.push(promise);
    }

    await Promise.allSettled(promises);
    this.advanceCommitIndex();
  }

  // -- Election --

  private async startElection() {
    this.becomeCandidate();
    const currentTerm = this.getCurrentTerm();
    let votesReceived = 1; // self-vote
    const majority = Math.floor((this.peerIds.length + 1) / 2) + 1;

    const promises: Promise<void>[] = [];

    for (const peerId of this.peerIds) {
      if (this.faultState.partitionedFrom.has(peerId)) continue;

      const stub = this.peerStubs.get(peerId);
      if (!stub) continue;

      const promise = Promise.race([
        (stub as unknown as { requestVote: (args: RequestVoteArgs) => Promise<RequestVoteResult> })
          .requestVote({
            term: currentTerm,
            candidateId: this.nodeId,
            lastLogIndex: this.getLastLogIndex(),
            lastLogTerm: this.getLastLogTerm(),
          })
          .then((result) => {
            if (result.term > currentTerm) {
              this.becomeFollower(result.term);
              return;
            }
            if (result.voteGranted && this.role === 'candidate') {
              votesReceived++;
              if (votesReceived >= majority) {
                this.becomeLeader();
                // Send immediate heartbeats (fire-and-forget with error logging)
                this.sendHeartbeats().catch((err) => {
                  console.error(JSON.stringify({ message: 'post_election_heartbeat_failed', nodeId: this.nodeId, error: String(err) }));
                });
              }
            }
          }),
        new Promise<void>((_, reject) => setTimeout(() => reject(new Error('timeout')), RPC_TIMEOUT_MS)),
      ]).catch(() => {
        // Vote request failed -- continue election
      });

      promises.push(promise);
    }

    await Promise.allSettled(promises);

    // If still candidate after all votes processed, schedule another election
    if (this.role === 'candidate') {
      await this.scheduleElectionTimeout();
    } else if (this.role === 'leader') {
      await this.scheduleHeartbeat();
    }
  }
}
