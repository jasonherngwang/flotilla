import type { ClusterEvent } from '../types';

const BUFFER_DELAY_MS = 500;

export class ReorderBuffer {
  private buffer: ClusterEvent[] = [];

  insert(event: ClusterEvent) {
    this.buffer.push(event);
  }

  flush(): ClusterEvent[] {
    const now = Date.now();
    const cutoff = now - BUFFER_DELAY_MS;

    // Extract events older than the buffer delay
    const ready: ClusterEvent[] = [];
    const remaining: ClusterEvent[] = [];

    for (const event of this.buffer) {
      if (event.timestamp <= cutoff) {
        ready.push(event);
      } else {
        remaining.push(event);
      }
    }

    this.buffer = remaining;

    // Sort by timestamp
    ready.sort((a, b) => a.timestamp - b.timestamp);

    return ready;
  }

  clear() {
    this.buffer = [];
  }

  get size(): number {
    return this.buffer.length;
  }
}
