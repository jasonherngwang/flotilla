import { useRef, useEffect, useCallback, useState } from 'react';
import type { NodeId, NodeState, Fault, ClusterEvent, ClientMessage } from '../types';
import { NODES } from '../types';
import { useAnimationLoop } from '../hooks/useAnimationLoop';
import { latLngToCanvas } from '../lib/map-projection';
import { interpolateGreatCircle } from '../lib/great-circle';
import { COLORS } from '../lib/colors';
import type { Particle } from './MessageParticle';
import { createParticleFromEvent, updateParticle, isParticleAlive } from './MessageParticle';

// ─── Coastline data loaded once ───
type CoastlineData = { rings: number[][][] };
let coastlineCache: CoastlineData | null = null;
let coastlineLoading = false;

function loadCoastline(cb: (data: CoastlineData) => void) {
  if (coastlineCache) { cb(coastlineCache); return; }
  if (coastlineLoading) return;
  coastlineLoading = true;
  fetch('/world.json')
    .then((r) => r.json())
    .then((data: CoastlineData) => {
      coastlineCache = data;
      cb(data);
    })
    .catch(() => { coastlineLoading = false; });
}

// ─── Weather effect state ───
interface WeatherFx {
  type: 'lightning';
  target: string;
  startTime: number;
  duration: number;
}

// ─── Node transition effect state ───
interface NodeFx {
  type: 'role_change' | 'crash' | 'heal';
  nodeId: NodeId;
  startTime: number;
  duration: number;
  color: string;
}

const ARC_SEGMENTS = 24;

interface WorldMapProps {
  nodes: NodeState[];
  faults: Fault[];
  events: ClusterEvent[];
  drainNewEvents: () => ClusterEvent[];
  mode: 'observe' | 'chaos';
  onAction: (msg: ClientMessage) => void;
  sidebarOpen: boolean;
}

// Helper: get node position (map projection on desktop, circular layout on mobile)
function getNodePosition(nodeId: NodeId, w: number, h: number, isMobile: boolean): { x: number; y: number } {
  const config = NODES[nodeId];
  if (!config) return { x: 0, y: 0 };

  if (isMobile) {
    // Circular layout for mobile - evenly spaced around a circle
    const nodeIds: NodeId[] = ['A', 'B', 'C', 'D', 'E'];
    const index = nodeIds.indexOf(nodeId);
    const total = nodeIds.length;
    const angle = (index / total) * Math.PI * 2 - Math.PI / 2; // Start at top
    const radius = Math.min(w, h) * 0.28; // 28% to keep nodes visible with labels
    const centerX = w / 2;
    const centerY = h / 2;
    return {
      x: centerX + Math.cos(angle) * radius,
      y: centerY + Math.sin(angle) * radius,
    };
  }

  // Desktop: use geographic projection
  return latLngToCanvas(config.lat, config.lng, w, h);
}

export function WorldMap({ nodes, faults, events, drainNewEvents, mode, onAction, sidebarOpen }: WorldMapProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const coastlineRef = useRef<CoastlineData | null>(coastlineCache);
  const particlesRef = useRef<Particle[]>([]);
  const drainRef = useRef(drainNewEvents);
  drainRef.current = drainNewEvents;
  const weatherFxRef = useRef<WeatherFx[]>([]);
  const nodeFxRef = useRef<NodeFx[]>([]);
  const prevFaultIdsRef = useRef(new Set<string>());
  const prevNodeRolesRef = useRef(new Map<NodeId, string>());
  const prevCrashedRef = useRef(new Set<NodeId>());
  const BREAKPOINT = 1024;
  const [isDesktop, setIsDesktop] = useState(() => {
    if (typeof window !== 'undefined') {
      return window.innerWidth >= BREAKPOINT;
    }
    return true;
  });

  // Detect viewport changes
  useEffect(() => {
    const checkViewport = () => {
      setIsDesktop(window.innerWidth >= BREAKPOINT);
    };
    window.addEventListener('resize', checkViewport);
    return () => window.removeEventListener('resize', checkViewport);
  }, []);

  // Load coastline data on mount
  useEffect(() => {
    loadCoastline((data) => { coastlineRef.current = data; });
  }, []);

  // Track node role changes and crash/heal transitions for visual effects
  useEffect(() => {
    const now = performance.now() / 1000;
    for (const node of nodes) {
      const prevRole = prevNodeRolesRef.current.get(node.id);
      const wasCrashed = prevCrashedRef.current.has(node.id);

      if (prevRole && prevRole !== node.role) {
        // Role change flash
        const color = node.role === 'leader' ? COLORS.leader
          : node.role === 'candidate' ? COLORS.candidate
          : COLORS.follower;
        nodeFxRef.current.push({
          type: 'role_change',
          nodeId: node.id,
          startTime: now,
          duration: 1.5,
          color,
        });
      }

      if (node.faultState.crashed && !wasCrashed) {
        nodeFxRef.current.push({
          type: 'crash',
          nodeId: node.id,
          startTime: now,
          duration: 1.0,
          color: '#ef4444',
        });
      } else if (!node.faultState.crashed && wasCrashed) {
        nodeFxRef.current.push({
          type: 'heal',
          nodeId: node.id,
          startTime: now,
          duration: 1.5,
          color: '#22c55e',
        });
      }

      prevNodeRolesRef.current.set(node.id, node.role);
      if (node.faultState.crashed) prevCrashedRef.current.add(node.id);
      else prevCrashedRef.current.delete(node.id);
    }
  }, [nodes]);

  // Create weather effects from new faults
  useEffect(() => {
    const currentIds = new Set(faults.map((f) => f.id));
    for (const fault of faults) {
      if (!prevFaultIdsRef.current.has(fault.id)) {
        if (fault.type === 'thunderstorm') {
          weatherFxRef.current.push({
            type: 'lightning',
            target: fault.target,
            startTime: performance.now() / 1000,
            duration: 1.5,
          });
        }
      }
    }
    prevFaultIdsRef.current = currentIds;
  }, [faults]);

  const draw = useCallback((dt: number, elapsed: number) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const w = canvas.width;
    const h = canvas.height;
    const dpr = devicePixelRatio;
    const mobile = window.innerWidth < 1024;

    // ─── Clear ───
    ctx.fillStyle = COLORS.ocean;
    ctx.fillRect(0, 0, w, h);

    // ─── Coastlines (desktop only) ───
    if (!mobile) {
      const coastline = coastlineRef.current;
      if (coastline) {
        ctx.fillStyle = COLORS.land;
        for (const ring of coastline.rings) {
          if (ring.length < 3) continue;
          // Skip rings that cross the antimeridian (cause horizontal streaks)
          let crossesAntimeridian = false;
          for (let i = 1; i < ring.length; i++) {
            if (Math.abs(ring[i][0] - ring[i - 1][0]) > 180) {
              crossesAntimeridian = true;
              break;
            }
          }
          if (crossesAntimeridian) continue;

          ctx.beginPath();
          const first = latLngToCanvas(ring[0][1], ring[0][0], w, h);
          ctx.moveTo(first.x, first.y);
          for (let i = 1; i < ring.length; i++) {
            const pt = latLngToCanvas(ring[i][1], ring[i][0], w, h);
            ctx.lineTo(pt.x, pt.y);
          }
          ctx.closePath();
          ctx.fill();
        }
      }
    }

    // ─── Partition visualization: soft gradient blobs per group ───
    const partitionGroupColors = ['#ec4899', '#14b8a6']; // pink, teal

    for (const fault of faults) {
      if (fault.type !== 'earthquake') continue;
      const groups = fault.target.split('|').map((g) => g.split(',') as NodeId[]);

      for (let gi = 0; gi < groups.length; gi++) {
        const color = partitionGroupColors[gi % partitionGroupColors.length];
        const groupNodeIds = groups[gi];

        // Draw a large soft blob at each node — nearby nodes merge naturally
        for (const nodeId of groupNodeIds) {
          const pos = getNodePosition(nodeId, w, h, mobile);
          const blobRadius = 80 * dpr;
          const gradient = ctx.createRadialGradient(pos.x, pos.y, 0, pos.x, pos.y, blobRadius);
          gradient.addColorStop(0, `${color}20`);   // ~12% at center
          gradient.addColorStop(0.6, `${color}12`); // ~7% mid
          gradient.addColorStop(1, `${color}00`);   // transparent edge
          ctx.fillStyle = gradient;
          ctx.beginPath();
          ctx.arc(pos.x, pos.y, blobRadius, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }

    // ─── Connection lines (both desktop and mobile) ───
    const nodeIds: NodeId[] = ['A', 'B', 'C', 'D', 'E'];
    ctx.strokeStyle = '#ffffff18'; // Faint white
    ctx.lineWidth = 1 * dpr;
    ctx.setLineDash([3 * dpr, 3 * dpr]); // Dashed line

    for (let i = 0; i < nodeIds.length; i++) {
      for (let j = i + 1; j < nodeIds.length; j++) {
        if (mobile) {
          // Mobile: simple straight lines between circular layout positions
          const posA = getNodePosition(nodeIds[i], w, h, mobile);
          const posB = getNodePosition(nodeIds[j], w, h, mobile);

          ctx.beginPath();
          ctx.moveTo(posA.x, posA.y);
          ctx.lineTo(posB.x, posB.y);
          ctx.stroke();
        } else {
          // Desktop: curved great circle arcs (with wraparound support)
          const configA = NODES[nodeIds[i]];
          const configB = NODES[nodeIds[j]];
          if (!configA || !configB) continue;

          // Interpolate along great circle arc with wraparound detection
          const segments = 30;
          const points: { x: number; y: number }[] = [];

          for (let seg = 0; seg <= segments; seg++) {
            const t = seg / segments;
            const pt = interpolateGreatCircle(
              configA.lat, configA.lng,
              configB.lat, configB.lng,
              t
            );
            const pos = latLngToCanvas(pt.lat, pt.lng, w, h);
            points.push(pos);
          }

          // Draw the path, breaking into segments when it wraps
          ctx.beginPath();
          ctx.moveTo(points[0].x, points[0].y);

          for (let seg = 1; seg < points.length; seg++) {
            const prevPos = points[seg - 1];
            const currPos = points[seg];

            // Detect wraparound: large horizontal jump indicates crossing edge
            const dx = Math.abs(currPos.x - prevPos.x);
            const isWrap = dx > w / 2; // Jump more than half the screen width

            if (isWrap) {
              // Finish current segment
              ctx.stroke();
              // Start new segment at current point
              ctx.beginPath();
              ctx.moveTo(currPos.x, currPos.y);
            } else {
              ctx.lineTo(currPos.x, currPos.y);
            }
          }

          ctx.stroke();
        }
      }
    }

    ctx.setLineDash([]); // Reset dash

    // ─── Weather effects ───
    const now = performance.now() / 1000;
    weatherFxRef.current = weatherFxRef.current.filter((fx) => {
      const age = now - fx.startTime;
      return age < fx.duration;
    });

    for (const fx of weatherFxRef.current) {
      const age = now - fx.startTime;

      if (fx.type === 'lightning') {
        drawLightning(ctx, w, h, fx.target as NodeId, age, fx.duration, dpr, mobile);
      }
    }

    // ─── Create new particles from event queue ───
    const newEvents = drainRef.current();
    for (const event of newEvents) {
      // Skip heartbeat_sent to crashed nodes (only show rpc_dropped)
      if (event.type === 'heartbeat_sent') {
        const destNode = nodes.find((n) => n.id === event.to);
        if (destNode?.faultState.crashed) {
          continue; // Skip - the rpc_dropped event will create a red particle
        }
      }

      const particle = createParticleFromEvent(event);
      if (particle) {
        particlesRef.current.push(particle);
      }
    }

    // ─── Update & cull particles ───
    const pNow = Date.now();
    particlesRef.current = particlesRef.current
      .map((p) => updateParticle(p, pNow))
      .filter(isParticleAlive);

    for (const particle of particlesRef.current) {
      const fromPos = getNodePosition(particle.from, w, h, mobile);
      const toPos = getNodePosition(particle.to, w, h, mobile);

      // Interpolate position (straight line on mobile, arc on desktop)
      let pos: { x: number; y: number };
      if (mobile) {
        // Simple linear interpolation on mobile
        pos = {
          x: fromPos.x + (toPos.x - fromPos.x) * particle.progress,
          y: fromPos.y + (toPos.y - fromPos.y) * particle.progress,
        };
      } else {
        // Geographic interpolation on desktop
        const fromConfig = NODES[particle.from];
        const toConfig = NODES[particle.to];
        if (!fromConfig || !toConfig) continue;
        const pt = interpolateGreatCircle(
          fromConfig.lat, fromConfig.lng,
          toConfig.lat, toConfig.lng,
          particle.progress,
        );
        pos = latLngToCanvas(pt.lat, pt.lng, w, h);
      }

      // Make particles more distinct - moderate size with glow
      const alpha = particle.dropped
        ? Math.max(0, 1 - particle.progress * 0.3) // Slower fade for errors, stay visible longer
        : Math.max(0, 0.9 - particle.progress * 0.3); // Much brighter, slower fade

      const coreSize = particle.dropped ? 2.5 * dpr : 2.5 * dpr; // Moderate size, same for both
      const glowSize = particle.dropped ? 6 * dpr : 5 * dpr; // Glow halo

      // Outer glow for better visibility
      const gradient = ctx.createRadialGradient(pos.x, pos.y, 0, pos.x, pos.y, glowSize);
      gradient.addColorStop(0, particle.color + 'ff'); // Full opacity at center
      gradient.addColorStop(0.5, particle.color + '66'); // 40% opacity mid
      gradient.addColorStop(1, particle.color + '00'); // Transparent edge

      ctx.globalAlpha = alpha * 0.6;
      ctx.beginPath();
      ctx.arc(pos.x, pos.y, glowSize, 0, Math.PI * 2);
      ctx.fillStyle = gradient;
      ctx.fill();

      // Core particle (bright and solid)
      ctx.globalAlpha = alpha;
      ctx.beginPath();
      ctx.arc(pos.x, pos.y, coreSize, 0, Math.PI * 2);
      ctx.fillStyle = particle.color;
      ctx.fill();

      // Extra pulse effect for error particles
      if (particle.dropped) {
        const pulseAlpha = alpha * 0.4 * (1 + Math.sin(elapsed * 8));
        ctx.globalAlpha = pulseAlpha;
        ctx.beginPath();
        ctx.arc(pos.x, pos.y, coreSize * 1.5, 0, Math.PI * 2);
        ctx.fillStyle = particle.color;
        ctx.fill();
      }

      ctx.globalAlpha = 1;
    }

    // ─── Nodes ───
    const maxCommitIndex = Math.max(...nodes.map((n) => n.commitIndex), 0);
    for (const node of nodes) {
      const pos = getNodePosition(node.id, w, h, mobile);

      const radius = (node.faultState.crashed ? 8 : node.role === 'leader' ? 16 : 11) * dpr;
      const color =
        node.faultState.crashed ? COLORS.crashed
        : node.role === 'leader' ? COLORS.leader
        : node.role === 'candidate' ? COLORS.candidate
        : COLORS.follower;

      // Outer glow for leader
      if (node.role === 'leader' && !node.faultState.crashed) {
        const glowR = radius + (10 + Math.sin(elapsed * 3) * 3) * dpr;
        const gradient = ctx.createRadialGradient(pos.x, pos.y, radius, pos.x, pos.y, glowR);
        gradient.addColorStop(0, `${COLORS.leader}66`);
        gradient.addColorStop(1, `${COLORS.leader}00`);
        ctx.beginPath();
        ctx.arc(pos.x, pos.y, glowR, 0, Math.PI * 2);
        ctx.fillStyle = gradient;
        ctx.fill();
      }

      // Crashed node X overlay
      if (node.faultState.crashed) {
        ctx.globalAlpha = 0.3 + 0.1 * Math.sin(elapsed * 2);
      }

      // Node circle
      ctx.beginPath();
      ctx.arc(pos.x, pos.y, radius, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
      ctx.strokeStyle = node.faultState.crashed ? '#ef444444' : '#ffffff33';
      ctx.lineWidth = 1.5 * dpr;
      ctx.stroke();

      if (node.faultState.crashed) {
        // Draw X mark
        ctx.strokeStyle = '#ef4444';
        ctx.lineWidth = 2 * dpr;
        const xSize = radius * 0.6;
        ctx.beginPath();
        ctx.moveTo(pos.x - xSize, pos.y - xSize);
        ctx.lineTo(pos.x + xSize, pos.y + xSize);
        ctx.moveTo(pos.x + xSize, pos.y - xSize);
        ctx.lineTo(pos.x - xSize, pos.y + xSize);
        ctx.stroke();
        ctx.globalAlpha = 1;
      }

      // Node letter (big, bold, above node)
      ctx.textAlign = 'center';
      const letterSize = Math.round(18 * dpr);
      ctx.font = `700 ${letterSize}px -apple-system, BlinkMacSystemFont, sans-serif`;
      ctx.fillStyle = '#ffffff';
      ctx.fillText(node.id, pos.x, pos.y - radius - 18 * dpr);

      // Role (small, colored, just above node)
      const roleSize = Math.round(9 * dpr);
      ctx.font = `600 ${roleSize}px -apple-system, BlinkMacSystemFont, sans-serif`;
      ctx.fillStyle = color;
      ctx.fillText(
        node.faultState.crashed ? 'CRASHED' : node.role.toUpperCase(),
        pos.x,
        pos.y - radius - 5 * dpr,
      );

      // City name (below node)
      const config = NODES[node.id];
      if (config) {
        const citySize = Math.round(11 * dpr);
        ctx.font = `500 ${citySize}px -apple-system, BlinkMacSystemFont, sans-serif`;
        ctx.fillStyle = COLORS.textMuted;
        ctx.fillText(config.city, pos.x, pos.y + radius + 16 * dpr);
      }

      // Commit index
      const commitSize = Math.round(10 * dpr);
      ctx.font = `600 ${commitSize}px ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace`;
      const commitColor = node.faultState.crashed ? COLORS.textMuted
        : node.commitIndex === maxCommitIndex ? '#22c55e' : '#f59e0b';
      ctx.fillStyle = commitColor;
      ctx.fillText(`commit ${node.commitIndex}`, pos.x, pos.y + radius + 30 * dpr);
      // Log index
      ctx.fillStyle = COLORS.textMuted;
      ctx.fillText(`log ${node.logLength}`, pos.x, pos.y + radius + 44 * dpr);

    }

    // ─── Partition group labels (above every node in the group) ───
    for (const fault of faults) {
      if (fault.type !== 'earthquake') continue;
      const groups = fault.target.split('|').map((g) => g.split(',') as NodeId[]);
      for (let gi = 0; gi < groups.length; gi++) {
        const color = partitionGroupColors[gi % partitionGroupColors.length];
        const labelSize = Math.round(10 * dpr);
        ctx.font = `600 ${labelSize}px -apple-system, BlinkMacSystemFont, sans-serif`;
        ctx.textAlign = 'center';
        ctx.globalAlpha = 0.5;
        ctx.fillStyle = color;
        for (const id of groups[gi]) {
          const pos = getNodePosition(id, w, h, mobile);
          ctx.fillText(`Partition ${gi + 1}`, pos.x, pos.y - 56 * dpr);
        }
        ctx.globalAlpha = 1;
      }
    }

    // ─── Node transition effects ───
    nodeFxRef.current = nodeFxRef.current.filter((fx) => {
      const age = now - fx.startTime;
      return age < fx.duration;
    });

    for (const fx of nodeFxRef.current) {
      const pos = getNodePosition(fx.nodeId, w, h, mobile);
      const age = now - fx.startTime;
      const progress = age / fx.duration;

      if (fx.type === 'role_change') {
        // Expanding ring
        const ringRadius = (20 + progress * 40) * dpr;
        const alpha = Math.max(0, 1 - progress);
        ctx.globalAlpha = alpha * 0.6;
        ctx.strokeStyle = fx.color;
        ctx.lineWidth = 2 * dpr;
        ctx.beginPath();
        ctx.arc(pos.x, pos.y, ringRadius, 0, Math.PI * 2);
        ctx.stroke();
        ctx.globalAlpha = 1;
      } else if (fx.type === 'crash') {
        // Red flash expanding
        const flashRadius = (15 + progress * 50) * dpr;
        const alpha = Math.max(0, 1 - progress) * 0.5;
        const gradient = ctx.createRadialGradient(pos.x, pos.y, 0, pos.x, pos.y, flashRadius);
        gradient.addColorStop(0, `rgba(239, 68, 68, ${alpha})`);
        gradient.addColorStop(1, 'transparent');
        ctx.fillStyle = gradient;
        ctx.beginPath();
        ctx.arc(pos.x, pos.y, flashRadius, 0, Math.PI * 2);
        ctx.fill();
      } else if (fx.type === 'heal') {
        // Green pulse
        const pulseRadius = (15 + progress * 35) * dpr;
        const alpha = Math.max(0, 1 - progress) * 0.5;
        const gradient = ctx.createRadialGradient(pos.x, pos.y, 0, pos.x, pos.y, pulseRadius);
        gradient.addColorStop(0, `rgba(34, 197, 94, ${alpha})`);
        gradient.addColorStop(1, 'transparent');
        ctx.fillStyle = gradient;
        ctx.beginPath();
        ctx.arc(pos.x, pos.y, pulseRadius, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }, [nodes, faults, events]);

  useAnimationLoop(draw);

  // Resize handler
  useEffect(() => {
    const handleResize = () => {
      const canvas = canvasRef.current;
      const container = containerRef.current;
      if (!canvas || !container) return;
      canvas.width = container.clientWidth * devicePixelRatio;
      canvas.height = container.clientHeight * devicePixelRatio;
      canvas.style.width = `${container.clientWidth}px`;
      canvas.style.height = `${container.clientHeight}px`;
    };
    handleResize();
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  // Click handler
  const handleClick = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    if (mode !== 'chaos') return;
    const canvas = canvasRef.current;
    if (!canvas) return;

    const rect = canvas.getBoundingClientRect();
    const x = (e.clientX - rect.left) * devicePixelRatio;
    const y = (e.clientY - rect.top) * devicePixelRatio;
    const mobile = window.innerWidth < 1024;

    for (const node of nodes) {
      const pos = getNodePosition(node.id, canvas.width, canvas.height, mobile);
      const dist = Math.sqrt((x - pos.x) ** 2 + (y - pos.y) ** 2);
      if (dist < 30 * devicePixelRatio) {
        if (node.faultState.crashed) {
          onAction({ type: 'heal_node', nodeId: node.id });
        } else {
          onAction({ type: 'crash_node', nodeId: node.id });
        }
        return;
      }
    }
  }, [mode, nodes, onAction]);

  // Desktop (>=1024px): always adjust width for sidebar (always visible)
  // Mobile (<1024px): full width, adjust height for bottom drawer when open
  const containerWidth = isDesktop ? 'calc(100% - 340px)' : '100%';
  const containerHeight = isDesktop ? '100vh' : (sidebarOpen ? 'calc(100vh - 50vh)' : '100vh');

  return (
    <div
      ref={containerRef}
      style={{
        width: containerWidth,
        height: containerHeight,
        position: 'relative',
        transition: 'width 0.25s cubic-bezier(0.4, 0, 0.2, 1), height 0.25s cubic-bezier(0.4, 0, 0.2, 1)',
      }}
    >
      <canvas
        ref={canvasRef}
        onClick={handleClick}
        style={{ cursor: mode === 'chaos' ? 'crosshair' : 'default' }}
      />
    </div>
  );
}

// ─── Weather drawing helpers ───

function drawLightning(
  ctx: CanvasRenderingContext2D,
  w: number, h: number,
  nodeId: NodeId,
  age: number,
  duration: number,
  dpr: number,
  mobile: boolean,
) {
  const pos = getNodePosition(nodeId, w, h, mobile);
  const alpha = age < 0.1 ? 1 : Math.max(0, 1 - (age - 0.1) / (duration - 0.1));

  // White flash
  if (age < 0.15) {
    ctx.globalAlpha = (0.15 - age) / 0.15 * 0.3;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, w, h);
    ctx.globalAlpha = 1;
  }

  // Lightning bolt from top of canvas to node
  ctx.globalAlpha = alpha;
  ctx.strokeStyle = COLORS.lightning;
  ctx.lineWidth = 3 * dpr;
  ctx.shadowColor = COLORS.lightning;
  ctx.shadowBlur = 15 * dpr;

  const startX = pos.x + (Math.sin(age * 50) * 30 * dpr);
  const startY = 0;

  ctx.beginPath();
  ctx.moveTo(startX, startY);

  // Zigzag path to node
  const steps = 6;
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const x = startX + (pos.x - startX) * t + (Math.random() - 0.5) * 40 * dpr * (1 - t);
    const y = startY + (pos.y - startY) * t;
    ctx.lineTo(x, y);
  }
  ctx.stroke();

  ctx.shadowBlur = 0;
  ctx.globalAlpha = 1;
}

