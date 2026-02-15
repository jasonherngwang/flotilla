# Flotilla

Raft consensus visualization running on geo-distributed Cloudflare Durable Objects. 5 nodes across 5 continents elect leaders, replicate logs, and handle failures. You can manually inject faults via the UI.

## How to Use It

**Watch:** Green particles flowing between nodes are heartbeats. The amber node is the leader. Auto-write submits log entries every 3s.

**Break things:** Click nodes on the map to crash/heal them. Use toolbar buttons to partition the network. Crash the majority and watch the cluster halt.

**Observe Raft:** Leader crashes trigger elections (candidates are purple). Red particles indicate dropped RPCs. Partitions split the cluster into colored regions — only the majority side can elect a leader. When partitions heal, minority nodes roll back uncommitted entries.

## Real vs Simulated

**Real:** Cross-continent latency (90-200ms), independent DO instances with no shared memory, SQLite persistence, Raft election/replication/commit logic.

**Simulated:** Crashes and process termination (we use a flag instead of killing the process), partitions (we reject RPCs at the app layer instead of blocking network traffic).

## Infrastructure

### Durable Objects as Raft Nodes

Each node is a separate Cloudflare DO. We use `locationHint` to try to place each one on a different continent:

```
A: { locationHint: 'wnam', city: 'Los Angeles' },
B: { locationHint: 'enam', city: 'Virginia' },
C: { locationHint: 'weur', city: 'Frankfurt' },
D: { locationHint: 'apac', city: 'Tokyo' },
E: { locationHint: 'oc',   city: 'Sydney' },
```

Each DO has independent memory, storage, and lifecycle. They talk to each other via direct RPC method calls.

### Persistence

Each DO persists Raft state to SQLite. When a crashed node recovers, it reads `currentTerm`, `votedFor`, and the full log from SQLite — same as a server reboot. The cluster starts fresh each session, but crash recovery within a session preserves persistent state.

### WebSocket Hibernation

A singleton ClusterManager DO handles all client connections using the WebSocket Hibernation API. It boots the cluster on first connection and broadcasts events in real time.

The cluster shuts down 30 seconds after the last client disconnects.

## Architecture

```
Browser (React + Canvas)
    │
    │ GET /    → Workers Assets
    │ GET /ws  → WebSocket upgrade
    ▼
┌──────────────────────────────────────────┐
│  Entry Worker (src/index.ts)             │
│  Routes /ws → ClusterManager DO          │
│  Routes /*  → ASSETS binding             │
└────────────────────┬─────────────────────┘
                     ▼
         ┌───────────────────────┐
         │  ClusterManager DO    │
         │  (Singleton)          │
         │  WebSocket hub        │
         │  Event reorder buffer │
         │  Fault injection      │
         └───────────┬───────────┘
                     │ Poll & RPC
    ┌────────┬───────┼───────┬────────┐
    ▼        ▼       ▼       ▼        ▼
 Node A   Node B   Node C   Node D   Node E
  (LA)     (VA)    (FRA)   (Tokyo)  (Sydney)
  wnam     enam    weur     apac      oc
    │        │       │       │        │
  SQLite   SQLite  SQLite  SQLite   SQLite

         Raft RPC: requestVote, appendEntries
```