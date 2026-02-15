import { env } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import type { ClusterEvent } from '../../src/types';

describe('ClusterManager', () => {
  it('accepts push events', async () => {
    const stub = env.CLUSTER_MANAGER.getByName('test-manager');
    const event: ClusterEvent = {
      type: 'role_change',
      nodeId: 'A',
      from: 'follower',
      to: 'candidate',
      term: 1,
      timestamp: Date.now(),
    };

    // Should not throw
    await (stub as any).pushEvent(event);
  });
});
