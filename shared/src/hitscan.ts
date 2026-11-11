/**
 * Hitscan: a shot is an instant ray, not a flying bullet. This file is pure geometry, with no
 * state, so the server (for the truth) and the client (for the tracer it draws) agree.
 */
import { BODY, COMBAT, WEAPONS } from './config.ts';
import type { WeaponDef } from './config.ts';
import type { Box, Vec3 } from './map.ts';
import { createRng } from './netsim.ts';

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

export function weaponOf(index: number): WeaponDef {
  return WEAPONS[index] ?? WEAPONS[0];
}

/**
 * The seed for one shot's random spread. Both the server and the client work it out from the
 * input's sequence number and the player's id, so the client can draw exactly the rays the server
 * will fire without being told.
 */
export function shotSeed(seq: number, playerId: number): number {
  return (Math.imul(seq >>> 0, 2654435761) ^ Math.imul(playerId + 1, 40503)) >>> 0;
}

/**
 * The rays for one shot: the aim direction, scattered inside a cone for each pellet. The cone is
 * narrower when aiming down sights. Pure and seeded, so identical on the server and the client.
 */
export function pelletDirections(weapon: WeaponDef, yaw: number, pitch: number, aiming: boolean, seed: number): Vec3[] {
  const f = aimDirection(yaw, pitch);
  const spread = aiming ? weapon.adsSpread : weapon.spread;
  if (spread <= 0) return Array.from({ length: weapon.pellets }, () => [f[0], f[1], f[2]] as Vec3);
  const rand = createRng(seed);
  const y = Number.isFinite(yaw) ? yaw : 0;
  const right: Vec3 = [Math.cos(y), 0, -Math.sin(y)];
  // up = right x forward
  const up: Vec3 = [
    right[1] * f[2] - right[2] * f[1],
    right[2] * f[0] - right[0] * f[2],
    right[0] * f[1] - right[1] * f[0],
  ];
  const out: Vec3[] = [];
  for (let i = 0; i < weapon.pellets; i++) {
    const r = Math.tan(spread) * Math.sqrt(rand()); // uniform over the disc
    const a = rand() * Math.PI * 2;
    const ox = Math.cos(a) * r;
    const oy = Math.sin(a) * r;
    const d: Vec3 = [f[0] + right[0] * ox + up[0] * oy, f[1] + right[1] * ox + up[1] * oy, f[2] + right[2] * ox + up[2] * oy];
    const len = Math.hypot(d[0], d[1], d[2]);
    out.push([d[0] / len, d[1] / len, d[2] / len]);
  }
  return out;
}

/** Damage of one pellet that travelled `distance` metres: full up to falloffStart, fading to falloffMin at falloffEnd. */
export function pelletDamage(weapon: WeaponDef, distance: number, headshot: boolean): number {
  let scale = 1;
  if (distance > weapon.falloffStart) {
    const t = Math.min(1, (distance - weapon.falloffStart) / (weapon.falloffEnd - weapon.falloffStart));
    scale = 1 - (1 - weapon.falloffMin) * t;
  }
  return Math.max(1, Math.round(weapon.damage * scale * (headshot ? weapon.headMultiplier : 1)));
}
