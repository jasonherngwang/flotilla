import { env, runDurableObjectAlarm } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import { initializeNodes, getNodeStates, findLeader } from './helpers';

describe('RaftNode election', () => {
  it('initializes nodes as followers', async () => {
    const stubs = await initializeNodes(['A', 'B', 'C']);
    const states = await getNodeStates(stubs);

    for (const state of states) {
      expect(state.role).toBe('follower');
      expect(state.term).toBe(0);
    }
  });

  it('elects a leader after election timeout', async () => {
    const stubs = await initializeNodes(['A', 'B', 'C']);

    // Trigger election timeout on first node
    await runDurableObjectAlarm(stubs[0]);

    const states = await getNodeStates(stubs);
    const leader = findLeader(states);

    expect(leader).toBeDefined();
    expect(leader!.term).toBeGreaterThanOrEqual(1);
  });

  it('only one leader exists at a time', async () => {
    const stubs = await initializeNodes(['A', 'B', 'C']);

    // Trigger election on first node
    await runDurableObjectAlarm(stubs[0]);

    const states = await getNodeStates(stubs);
    const leaders = states.filter((s) => s.role === 'leader');

    expect(leaders.length).toBe(1);
  });
});
