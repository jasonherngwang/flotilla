import { DurableObject } from 'cloudflare:workers';
import type {
  NodeId,
  NodeState,
  ClusterEvent,
  Fault,
  ClientMessage,
  ServerMessage,
} from '../types';
import { NODE_IDS as ALL_NODE_IDS, NODES } from '../types';
import type { DurableObjectLocationHint } from '@cloudflare/workers-types';
import { ReorderBuffer } from './reorder-buffer';

const FLUSH_INTERVAL_MS = 500;
const POLL_EVERY_N_TICKS = 40; // ~20s (reduced for cost optimization)
const SHUTDOWN_GRACE_MS = 30_000;
const MAX_CONNECTIONS = 50;
const GLOBAL_FAULT_RATE_LIMIT = 10; // max fault actions/sec across all connections

export class ClusterManager extends DurableObject<Env> {
  private nodeStubs = new Map<NodeId, DurableObjectStub>();
  private reorderBuffer = new ReorderBuffer();
  private activeFaults: Fault[] = [];
  private latestNodeStates = new Map<NodeId, NodeState>();
  private tickCount = 0;
  private booted = false;
  private wsActionTimestamps = new Map<WebSocket, number[]>();
  private globalFaultTimestamps: number[] = [];
  private shutdownGracePeriodEnd: number | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => this.migrate());
  }

  private migrate() {
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS nodes (id TEXT PRIMARY KEY, location_hint TEXT, city TEXT);
      CREATE TABLE IF NOT EXISTS active_faults (id TEXT PRIMARY KEY, type TEXT, target TEXT, source TEXT, started_at INTEGER);
      CREATE TABLE IF NOT EXISTS config (key TEXT PRIMARY KEY, value TEXT);
    `);
  }

  // -- WebSocket Hub (Hibernation API) --

  async fetch(request: Request): Promise<Response> {
    const upgradeHeader = request.headers.get('Upgrade');
    if (upgradeHeader !== 'websocket') {
      return new Response('Expected WebSocket', { status: 426 });
    }

    // Cap concurrent connections to prevent abuse
    if (this.ctx.getWebSockets().length >= MAX_CONNECTIONS) {
      return new Response('Too many connections', { status: 503 });
    }

    const pair = new WebSocketPair();
    const clientIp = request.headers.get('CF-Connecting-IP') ?? 'unknown';
    const connectionId = crypto.randomUUID();
    this.ctx.acceptWebSocket(pair[1], [connectionId, clientIp]);

    // Clear shutdown grace period since we have a new connection
    this.shutdownGracePeriodEnd = null;

    // Boot cluster on first connection
    if (!this.booted) {
      await this.boot();
    }

    // Send initial snapshot
    const snapshot = await this.buildSnapshot();
    pair[1].send(JSON.stringify(snapshot));

    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    try {
      const msg: ClientMessage = JSON.parse(message as string);

      // Rate limit: 2 actions/second per connection
      if (!this.checkRateLimit(ws)) {
        ws.send(JSON.stringify({ type: 'error', message: 'Rate limited: max 2 actions/second' }));
        return;
      }

      await this.handleClientMessage(msg, ws);
    } catch (e) {
      console.error(JSON.stringify({
        message: 'ws_message_error',
        error: e instanceof Error ? e.message : String(e),
      }));
    }
  }

  private checkRateLimit(ws: WebSocket): boolean {
    const now = Date.now();
    // Per-connection limit: 2 actions/sec
    const timestamps = this.wsActionTimestamps.get(ws) || [];
    const recent = timestamps.filter((t) => now - t < 1000);
    if (recent.length >= 2) return false;
    recent.push(now);
    this.wsActionTimestamps.set(ws, recent);
    // Global fault rate limit across all connections
    this.globalFaultTimestamps = this.globalFaultTimestamps.filter((t) => now - t < 1000);
    if (this.globalFaultTimestamps.length >= GLOBAL_FAULT_RATE_LIMIT) return false;
    this.globalFaultTimestamps.push(now);
    return true;
  }

  private getClientIp(ws: WebSocket): string {
    const tags = this.ctx.getTags(ws);
    return tags[1] ?? 'unknown';
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string) {
    // WebSocket is already closed when this handler is called - don't try to close it again
    this.wsActionTimestamps.delete(ws);
    if (this.ctx.getWebSockets().length === 0) {
      // Set shutdown grace period - alarm will check this before shutting down
      this.shutdownGracePeriodEnd = Date.now() + SHUTDOWN_GRACE_MS;
    }
  }

  async webSocketError(ws: WebSocket, error: unknown) {
    console.error(JSON.stringify({
      message: 'ws_error',
      error: error instanceof Error ? error.message : String(error),
    }));
    ws.close(1011, 'WebSocket error');
  }

  // -- Client message handling --

  private async handleClientMessage(msg: ClientMessage, ws: WebSocket) {
    const clientIp = this.getClientIp(ws);
    const VALID_NODE_IDS = new Set(ALL_NODE_IDS);

    // Validate node IDs in fault-related messages
    if (('nodeId' in msg) && !VALID_NODE_IDS.has(msg.nodeId)) {
      ws.send(JSON.stringify({ type: 'error', message: `Invalid node ID: ${msg.nodeId}` }));
      return;
    }
    if (msg.type === 'partition') {
      const allIds = msg.groups.flat();
      if (!allIds.every((id) => VALID_NODE_IDS.has(id))) {
        ws.send(JSON.stringify({ type: 'error', message: 'Invalid node ID in partition groups' }));
        return;
      }
    }

    switch (msg.type) {
      case 'crash_node': {
        console.log(JSON.stringify({ message: 'fault_action', action: 'crash', target: msg.nodeId, clientIp }));
        this.broadcast({ type: 'user_action', action: 'crash', target: msg.nodeId, clientIp, timestamp: Date.now() });
        const fault: Fault = {
          id: crypto.randomUUID(),
          type: 'thunderstorm',
          target: msg.nodeId,
          source: `manual:${crypto.randomUUID().slice(0, 8)}`,
          startedAt: Date.now(),
        };
        await this.injectFault(fault);
        break;
      }
      case 'heal_node': {
        console.log(JSON.stringify({ message: 'fault_action', action: 'heal', target: msg.nodeId, clientIp }));
        this.broadcast({ type: 'user_action', action: 'heal', target: msg.nodeId, clientIp, timestamp: Date.now() });
        const faultsToHeal = this.activeFaults.filter(
          (f) => f.type === 'thunderstorm' && f.target === msg.nodeId,
        );
        for (const fault of faultsToHeal) {
          await this.healFault(fault.id);
        }
        break;
      }
      case 'partition': {
        console.log(JSON.stringify({ message: 'fault_action', action: 'partition', groups: msg.groups, clientIp }));
        this.broadcast({ type: 'user_action', action: 'partition', target: msg.groups.map(g => g.join(',')).join(' | '), clientIp, timestamp: Date.now() });
        const fault: Fault = {
          id: crypto.randomUUID(),
          type: 'earthquake',
          target: msg.groups.map((g) => g.join(',')).join('|'),
          source: `manual:${crypto.randomUUID().slice(0, 8)}`,
          startedAt: Date.now(),
        };
        await this.injectFault(fault);
        break;
      }
      case 'heal_partition': {
        console.log(JSON.stringify({ message: 'fault_action', action: 'heal_partition', clientIp }));
        this.broadcast({ type: 'user_action', action: 'heal partition', clientIp, timestamp: Date.now() });
        const partitionFaults = this.activeFaults.filter((f) => f.type === 'earthquake');
        for (const f of partitionFaults) {
          await this.healFault(f.id);
        }
        break;
      }
      case 'heal_all': {
        console.log(JSON.stringify({ message: 'fault_action', action: 'heal_all', clientIp }));
        this.broadcast({ type: 'user_action', action: 'heal all', clientIp, timestamp: Date.now() });
        const allFaults = [...this.activeFaults];
        for (const f of allFaults) {
          await this.healFault(f.id);
        }
        break;
      }
      case 'submit_write': {
        this.broadcast({ type: 'user_action', action: 'submit write', clientIp, timestamp: Date.now() });
        // Send to ALL leaders — in a partition there may be two.
        // The one with majority replication can commit; the isolated
        // one accepts but the entry stays uncommitted (correct Raft).
        const command = { type: 'data' as const, clientId: 'manual', timestamp: Date.now() };
        for (const [nodeId, state] of this.latestNodeStates) {
          if (state.role === 'leader' && !state.faultState.crashed) {
            const stub = this.nodeStubs.get(nodeId);
            if (stub) {
              (stub as any).submitCommand(command).catch((err: unknown) => {
                console.warn(JSON.stringify({ message: 'submit_command_failed', nodeId, error: String(err) }));
              });
            }
          }
        }
        break;
      }
      case 'reset': {
        this.broadcast({ type: 'user_action', action: 'reset cluster', clientIp, timestamp: Date.now() });
        await this.shutdownCluster();
        this.activeFaults = [];
        this.latestNodeStates.clear();
        this.reorderBuffer = new ReorderBuffer();
        await this.boot();
        break;
      }
    }
  }

  // -- Boot / Shutdown --

  private async boot() {
    // Initialize node stubs with locationHint
    for (const nodeId of ALL_NODE_IDS) {
      const config = NODES[nodeId];
      const id = this.env.RAFT_NODE.idFromName(nodeId);
      const stub = this.env.RAFT_NODE.get(id, { locationHint: config.locationHint as DurableObjectLocationHint });
      this.nodeStubs.set(nodeId, stub);
      console.log(JSON.stringify({
        message: 'node_stub_created',
        nodeId,
        locationHint: config.locationHint,
        city: config.city,
      }));
    }

    // Initialize all Raft nodes
    const initErrors: NodeId[] = [];
    for (const nodeId of ALL_NODE_IDS) {
      const stub = this.nodeStubs.get(nodeId)!;
      const peers = ALL_NODE_IDS.filter((id) => id !== nodeId);
      try {
        await (stub as any).initialize(nodeId, peers, 'singleton');
      } catch (e) {
        initErrors.push(nodeId);
        console.error(JSON.stringify({
          message: 'node_init_failed',
          nodeId,
          error: e instanceof Error ? e.message : String(e),
        }));
      }
    }
    if (initErrors.length > 0) {
      this.broadcast({ type: 'error', message: `Failed to init nodes: ${initErrors.join(', ')}` });
    }

    // Clear any persisted crash states from previous sessions
    for (const nodeId of ALL_NODE_IDS) {
      const stub = this.nodeStubs.get(nodeId);
      if (stub) {
        try {
          await (stub as any).healFault('startup-clear');
        } catch (e) {
          // Ignore errors - node might already be clear
        }
      }
    }

    this.booted = true;

    // Start the flush/poll alarm
    await this.ctx.storage.setAlarm(Date.now() + FLUSH_INTERVAL_MS);

    console.log(JSON.stringify({ message: 'cluster_booted' }));
  }

  private async shutdownCluster() {
    for (const [_, stub] of this.nodeStubs) {
      try {
        await (stub as any).shutdown();
      } catch {
        // Node may already be gone
      }
    }

    this.booted = false;
    await this.ctx.storage.deleteAlarm();

    console.log(JSON.stringify({ message: 'cluster_shutdown' }));
  }

  // -- Alarm handler --

  async alarm() {
    // If no WebSocket connections and grace period has expired, shut down
    if (this.ctx.getWebSockets().length === 0 && this.booted) {
      if (this.shutdownGracePeriodEnd !== null && Date.now() >= this.shutdownGracePeriodEnd) {
        await this.shutdownCluster();
        return;
      }
      // Still in grace period, schedule next tick
      await this.ctx.storage.setAlarm(Date.now() + FLUSH_INTERVAL_MS);
      return;
    }

    if (!this.booted) return;

    // Flush reorder buffer
    const events = this.reorderBuffer.flush();
    for (const event of events) {
      this.broadcast({ type: 'event', event });
    }

    // Periodic node polling
    this.tickCount++;
    if (this.tickCount % POLL_EVERY_N_TICKS === 0) {
      await this.pollNodes();
    }

    // Schedule next tick
    await this.ctx.storage.setAlarm(Date.now() + FLUSH_INTERVAL_MS);
  }

  // -- Node polling --

  private async pollNodes() {
    for (const nodeId of ALL_NODE_IDS) {
      const stub = this.nodeStubs.get(nodeId);
      if (!stub) continue;
      try {
        const state: NodeState = await (stub as any).getState();
        this.latestNodeStates.set(nodeId, state);
      } catch {
        // Node is crashed or evicted - mark it as crashed in our cached state
        const existing = this.latestNodeStates.get(nodeId);
        if (existing) {
          this.latestNodeStates.set(nodeId, {
            ...existing,
            faultState: { ...existing.faultState, crashed: true },
          });
        } else {
          this.latestNodeStates.set(nodeId, {
            id: nodeId,
            role: 'follower',
            term: 0,
            commitIndex: 0,
            logLength: 0,
            faultState: { crashed: true, partitionedFrom: [], latencyMs: 0 },
            votedFor: null,
            lastApplied: 0,
          });
        }
      }
    }

    // Broadcast updated snapshot to all connected clients
    const snapshot = await this.buildSnapshot();
    this.broadcast(snapshot);
  }

  // -- Public RPC methods (called by Raft nodes) --

  async pushEvent(event: ClusterEvent): Promise<void> {
    this.reorderBuffer.insert(event);
  }

  async injectFault(fault: Fault): Promise<void> {
    this.activeFaults.push(fault);

    // Persist
    this.ctx.storage.sql.exec(
      'INSERT OR REPLACE INTO active_faults (id, type, target, source, started_at) VALUES (?, ?, ?, ?, ?)',
      fault.id, fault.type, fault.target, fault.source, fault.startedAt,
    );

    // Apply fault to target nodes
    if (fault.type === 'thunderstorm') {
      const stub = this.nodeStubs.get(fault.target as NodeId);
      if (stub) {
        // Set crash state and stop alarms - node will reject all RPCs via isFaulted()
        await (stub as any).injectFault(fault).catch((err: unknown) => {
          console.warn(JSON.stringify({ message: 'inject_fault_failed', target: fault.target, error: String(err) }));
        });
        await (stub as any).triggerCrash().catch((err: unknown) => {
          console.warn(JSON.stringify({ message: 'trigger_crash_failed', target: fault.target, error: String(err) }));
        });
      }
    } else if (fault.type === 'earthquake') {
      // Parse partition groups
      const groups = fault.target.split('|').map((g) => g.split(',') as NodeId[]);
      // Each group is partitioned from all other groups
      for (let i = 0; i < groups.length; i++) {
        for (let j = 0; j < groups.length; j++) {
          if (i === j) continue;
          for (const nodeId of groups[i]) {
            const partitionedFrom = groups[j].join(',');
            const stub = this.nodeStubs.get(nodeId);
            if (stub) {
              await (stub as any).injectFault({
                ...fault,
                target: partitionedFrom,
              }).catch((err: unknown) => {
                console.warn(JSON.stringify({ message: 'partition_inject_failed', nodeId, error: String(err) }));
              });
            }
          }
        }
      }
    }

    this.broadcast({ type: 'fault_injected', fault });
  }

  async healFault(faultId: string): Promise<void> {
    const fault = this.activeFaults.find((f) => f.id === faultId);
    console.log(JSON.stringify({
      message: 'heal_fault_called',
      faultId,
      faultType: fault?.type,
      faultSource: fault?.source,
      faultTarget: fault?.target,
    }));

    this.activeFaults = this.activeFaults.filter((f) => f.id !== faultId);

    // Remove from SQLite
    this.ctx.storage.sql.exec('DELETE FROM active_faults WHERE id = ?', faultId);

    if (fault?.type === 'thunderstorm') {
      // Only recover the crashed node — preserves its log and term
      const targetNodeId = fault.target as NodeId;
      const stub = this.nodeStubs.get(targetNodeId);
      if (stub) {
        const peers = ALL_NODE_IDS.filter((id) => id !== targetNodeId);
        try {
          await (stub as any).recover(targetNodeId, peers, 'singleton');
        } catch (e) {
          console.error(JSON.stringify({
            message: 'node_recover_failed',
            nodeId: targetNodeId,
            error: e instanceof Error ? e.message : String(e),
          }));
        }
      }
    } else if (fault?.type === 'earthquake') {
      // Only clear the specific partition — don't touch crash state
      const groups = fault.target.split('|').map((g) => g.split(',') as NodeId[]);
      for (let i = 0; i < groups.length; i++) {
        for (let j = 0; j < groups.length; j++) {
          if (i === j) continue;
          for (const nodeId of groups[i]) {
            const stub = this.nodeStubs.get(nodeId);
            if (stub) {
              await (stub as any).healPartition(groups[j]).catch((err: unknown) => {
                console.warn(JSON.stringify({ message: 'heal_partition_failed', nodeId, faultId, error: String(err) }));
              });
            }
          }
        }
      }
    }

    this.broadcast({ type: 'fault_healed', faultId });
  }

  // -- Broadcast + snapshot --

  private broadcast(msg: ServerMessage) {
    const data = JSON.stringify(msg);
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(data);
      } catch {
        // WebSocket may have closed
      }
    }
  }

  private async buildSnapshot(): Promise<ServerMessage> {
    const nodes: NodeState[] = [];
    for (const nodeId of ALL_NODE_IDS) {
      const cached = this.latestNodeStates.get(nodeId);
      if (cached) {
        nodes.push(cached);
      } else {
        nodes.push({
          id: nodeId,
          role: 'follower',
          term: 0,
          commitIndex: 0,
          logLength: 0,
          faultState: { crashed: false, partitionedFrom: [], latencyMs: 0 },
          votedFor: null,
          lastApplied: 0,
        });
      }
    }

    return {
      type: 'snapshot',
      nodes,
      faults: this.activeFaults,
    };
  }
}
