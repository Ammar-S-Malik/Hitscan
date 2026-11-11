/**
 * Hitscan: a shot is an instant ray, not a flying bullet. This file is pure geometry, with no
 * state, so the server (for the truth) and the client (for the tracer it draws) agree.
 */
import { BODY, COMBAT } from './config.ts';
import type { Box, Vec3 } from './map.ts';

/** The unit vector a player looks along. Yaw 0 looks toward -Z, positive yaw turns left, positive pitch looks up. */
export function aimDirection(yaw: number, pitch: number): Vec3 {
  const y = Number.isFinite(yaw) ? yaw : 0;
  const p = Number.isFinite(pitch) ? Math.max(-Math.PI / 2, Math.min(Math.PI / 2, pitch)) : 0;
  const c = Math.cos(p);
  return [-Math.sin(y) * c, Math.sin(p), -Math.cos(y) * c];
}

/**
 * Distance along the ray at which it enters the box, or null for a miss.
 * A ray that starts inside the box returns 0. `maxDist` limits how far we look.
 */
export function rayBox(o: Vec3, d: Vec3, min: Vec3, max: Vec3, maxDist: number): number | null {
  let tMin = 0;
  let tMax = maxDist;
  for (let a = 0; a < 3; a++) {
    if (Math.abs(d[a]) < 1e-12) {
      if (o[a] < min[a] || o[a] > max[a]) return null; // parallel to this pair of faces and outside them
    } else {
      let t1 = (min[a] - o[a]) / d[a];
      let t2 = (max[a] - o[a]) / d[a];
      if (t1 > t2) [t1, t2] = [t2, t1];
      if (t1 > tMin) tMin = t1;
      if (t2 < tMax) tMax = t2;
      if (tMin > tMax) return null;
    }
  }
  return tMin;
}

/** How far a ray travels before it hits the map (or `maxDist` if it hits nothing). */
export function traceWorld(o: Vec3, d: Vec3, boxes: readonly Box[], maxDist: number = COMBAT.maxRange): number {
  let best = maxDist;
  for (const b of boxes) {
    const t = rayBox(o, d, b.min, b.max, best);
    if (t !== null && t < best) best = t;
  }
  return best;
}

export interface Target {
  id: number;
  x: number;
  y: number;
  z: number; // feet
  sliding: boolean;
}

export function targetBox(t: Pick<Target, 'x' | 'y' | 'z' | 'sliding'>): { min: Vec3; max: Vec3 } {
  const h = t.sliding ? BODY.slideHeight : BODY.standHeight;
  return {
    min: [t.x - BODY.radius, t.y, t.z - BODY.radius],
    max: [t.x + BODY.radius, t.y + h, t.z + BODY.radius],
  };
}

export interface ShotResult {
  distance: number; // how far the shot travelled
  end: Vec3;
  victim: number; // id of the player hit, or 0
  headshot: boolean;
}

/**
 * Fire a ray from `origin` along `dir` (unit length). It stops at the first thing it meets: a wall
 * or a player. Walls win ties, so you cannot shoot through them.
 */
export function traceShot(origin: Vec3, dir: Vec3, boxes: readonly Box[], targets: readonly Target[]): ShotResult {
  const wall = traceWorld(origin, dir, boxes, COMBAT.maxRange);
  let bestT = wall;
  let victim = 0;
  let headshot = false;
  for (const t of targets) {
    const b = targetBox(t);
    const hit = rayBox(origin, dir, b.min, b.max, bestT);
    if (hit !== null && hit < bestT) {
      bestT = hit;
      victim = t.id;
      const hy = origin[1] + dir[1] * hit;
      headshot = hy >= b.max[1] - COMBAT.headHeight;
    }
  }
  return {
    distance: bestT,
    end: [origin[0] + dir[0] * bestT, origin[1] + dir[1] * bestT, origin[2] + dir[2] * bestT],
    victim,
    headshot,
  };
}
