import { env, runDurableObjectAlarm } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import { initializeNodes, getNodeStates, findLeader } from './helpers';
import type { BalanceCommand } from '../../src/types';

describe('RaftNode log replication', () => {
  it('replicates a command to followers', async () => {
    const stubs = await initializeNodes(['A', 'B', 'C']);

    // Elect a leader
    await runDurableObjectAlarm(stubs[0]);

    const states = await getNodeStates(stubs);
    const leader = findLeader(states);
    expect(leader).toBeDefined();

    // Find leader stub
    const leaderIdx = stubs.findIndex(
      (_, i) => states[i].role === 'leader',
    );
    const leaderStub = stubs[leaderIdx];

    // Submit a command
    const command: BalanceCommand = {
      type: 'deposit',
      amount: 100,
      clientId: 'test',
      timestamp: Date.now(),
    };
    const result = await (leaderStub as any).submitCommand(command);
    expect(result.success).toBe(true);

    // Trigger heartbeat to replicate
    await runDurableObjectAlarm(leaderStub);

    // Check all nodes have the entry
    const updatedStates = await getNodeStates(stubs);
    for (const state of updatedStates) {
      expect(state.logLength).toBeGreaterThanOrEqual(1);
    }
  });
});
