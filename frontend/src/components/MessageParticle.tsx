// Message particle system - used by WorldMap canvas draw
// Particles animate along great-circle arcs between nodes.

import type { ClusterEvent, NodeId } from '../types';
import { COLORS } from '../lib/colors';

export interface Particle {
  id: string;
  from: NodeId;
  to: NodeId;
  progress: number; // 0 to 1
  color: string;
  startTime: number;
  duration: number; // ms
  dropped: boolean;
}

export function createParticleFromEvent(event: ClusterEvent): Particle | null {
  const now = Date.now();

  switch (event.type) {
    case 'heartbeat_sent':
      return {
        id: `hb-${now}-${event.from}-${event.to}`,
        from: event.from,
        to: event.to,
        progress: 0,
        color: COLORS.heartbeatParticle,
        startTime: now,
        duration: 2000,
        dropped: false,
      };

    case 'vote_granted':
      return {
        id: `vote-${now}-${event.from}-${event.to}`,
        from: event.from,
        to: event.to,
        progress: 0,
        color: COLORS.voteParticle,
        startTime: now,
        duration: 1200,
        dropped: false,
      };

    case 'heartbeat_ack':
      return {
        id: `ack-${now}-${event.from}-${event.to}`,
        from: event.from,
        to: event.to,
        progress: 0,
        color: event.success ? COLORS.heartbeatParticle : COLORS.droppedParticle,
        startTime: now,
        duration: 1800,
        dropped: !event.success,
      };

    case 'rpc_dropped':
      return {
        id: `drop-${now}-${event.from}-${event.to}`,
        from: event.from,
        to: event.to,
        progress: 0,
        color: COLORS.droppedParticle,
        startTime: now,
        duration: 2000, // Same speed as regular heartbeats
        dropped: true,
      };

    default:
      return null;
  }
}

export function updateParticle(particle: Particle, now: number): Particle {
  const elapsed = now - particle.startTime;
  const progress = elapsed / particle.duration;

  // Let all particles complete their journey (no stopping at 50%)
  return { ...particle, progress: Math.min(progress, 1) };
}

export function isParticleAlive(particle: Particle): boolean {
  return particle.progress < 1;
}

// Not a React component -- canvas drawing helpers
export const MessageParticle = { createParticleFromEvent, updateParticle, isParticleAlive };
