import { env } from 'cloudflare:test';
import type { NodeId, NodeState } from '../../src/types';

export const TEST_NODE_IDS: NodeId[] = ['A', 'B', 'C'];

export function getNodeStub(nodeId: string) {
  return env.RAFT_NODE.getByName(nodeId);
}

export function getManagerStub() {
  return env.CLUSTER_MANAGER.getByName('test-manager');
}

export async function initializeNodes(nodeIds: NodeId[], managerId = 'test-manager') {
  const stubs = nodeIds.map((id) => getNodeStub(id));
  await Promise.all(
    stubs.map((stub, i) => {
      const peers = nodeIds.filter((_, j) => j !== i);
      return (stub as any).initialize(nodeIds[i], peers, managerId);
    }),
  );
  return stubs;
}

export async function getNodeStates(stubs: DurableObjectStub[]): Promise<NodeState[]> {
  return Promise.all(stubs.map((s) => (s as any).getState()));
}

export function findLeader(states: NodeState[]): NodeState | undefined {
  return states.find((s) => s.role === 'leader');
}

export function findFollowers(states: NodeState[]): NodeState[] {
  return states.filter((s) => s.role === 'follower');
}
