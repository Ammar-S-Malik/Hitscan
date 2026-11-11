import { BODY, MOVE } from './config.ts';
import { traceWorld } from './hitscan.ts';
import type { Box, GameMap, Vec3 } from './map.ts';

/**
 * Map validator. Run on every map in the tests, so a map with a spawn inside a wall, a platform nobody can
 * climb onto, a hole in the floor or a pit you cannot leave never gets shipped.
 *
 * Errors make a map unusable; warnings are things a designer should look at (spawns that can see each other).
 */
export interface MapReport {
  errors: string[];
  warnings: string[];
  stats: { cells: number; walkableNodes: number; boxes: number };
}

export const MAP_LIMITS = {
  small: { maxSpan: 34, maxPlayers: 6 },
  medium: { maxSpan: 56, maxPlayers: 8 },
  maxBoxes: 400,
  minSpawnGap: 4, // metres between any two spawns
  spawnClearance: 0.3, // extra room around the body at a spawn
  cell: 0.5, // walkability grid resolution
  maxClimb: 1.3, // the highest ledge a jump gets you onto (apex is about 1.5 m)
  spawnSightWarn: 14, // spawns closer than this that can see each other get a warning
} as const;

interface Node {
  ix: number;
  iz: number;
  h: number;
  clear: number; // free height above the surface
}

const EPS = 1e-6;

function overlapsXZ(b: Box, x0: number, z0: number, x1: number, z1: number): boolean {
  return b.min[0] < x1 - EPS && b.max[0] > x0 + EPS && b.min[2] < z1 - EPS && b.max[2] > z0 + EPS;
}

export function validateMap(map: GameMap): MapReport {
  const errors: string[] = [];
  const warnings: string[] = [];
  const { bounds, boxes, spawns } = map;
  const limits = MAP_LIMITS[map.size];
  const stats = (cells: number, walkableNodes: number): MapReport['stats'] => ({ cells, walkableNodes, boxes: boxes.length });

  // ---- size and counts
  const spanX = bounds.max[0] - bounds.min[0];
  const spanZ = bounds.max[2] - bounds.min[2];
  if (spanX > limits.maxSpan || spanZ > limits.maxSpan) {
    errors.push(`a ${map.size} map may span at most ${limits.maxSpan} m, this one spans ${spanX} x ${spanZ} m`);
  }
  if (map.maxPlayers > limits.maxPlayers) errors.push(`a ${map.size} map holds at most ${limits.maxPlayers} players`);
  if (boxes.length > MAP_LIMITS.maxBoxes) errors.push(`too many boxes (${boxes.length}, limit ${MAP_LIMITS.maxBoxes})`);
  if (spawns.length < map.maxPlayers) errors.push(`needs at least ${map.maxPlayers} spawns (one per player), has ${spawns.length}`);

  // ---- everything inside the bounds
  boxes.forEach((b, i) => {
    for (let a = 0; a < 3; a++) {
      if (b.min[a] < bounds.min[a] - EPS || b.max[a] > bounds.max[a] + EPS) {
        errors.push(`box ${i} (${b.kind}) sticks out of the map bounds`);
        break;
      }
    }
  });

  // ---- spawns: inside bounds, on something, with room to stand
  const R = BODY.radius + MAP_LIMITS.spawnClearance;
  spawns.forEach((s, i) => {
    const at = `spawn ${i} (${s.x}, ${s.y}, ${s.z})`;
    if (!Number.isFinite(s.yaw)) errors.push(`${at} has no facing`);
    if (s.x < bounds.min[0] || s.x > bounds.max[0] || s.z < bounds.min[2] || s.z > bounds.max[2] || s.y < bounds.min[1] || s.y + BODY.standHeight > bounds.max[1]) {
      errors.push(`${at} is outside the map bounds`);
      return;
    }
    let supported = false;
    for (const b of boxes) {
      const underFoot = b.min[0] < s.x + BODY.radius && b.max[0] > s.x - BODY.radius && b.min[2] < s.z + BODY.radius && b.max[2] > s.z - BODY.radius;
      if (underFoot && Math.abs(b.max[1] - s.y) < 0.05) supported = true;
      // Any solid the standing body (plus a margin) would be inside of.
      const inBody =
        b.min[0] < s.x + R && b.max[0] > s.x - R && b.min[2] < s.z + R && b.max[2] > s.z - R && b.min[1] < s.y + BODY.standHeight && b.max[1] > s.y + 0.05;
      if (inBody) {
        errors.push(`${at} has no room to stand: a ${b.kind} is in the way`);
        return;
      }
    }
    if (!supported) errors.push(`${at} is not standing on anything`);
  });
  for (let i = 0; i < spawns.length; i++) {
    for (let j = i + 1; j < spawns.length; j++) {
      const d = Math.hypot(spawns[i].x - spawns[j].x, spawns[i].z - spawns[j].z);
      if (d < MAP_LIMITS.minSpawnGap) {
        errors.push(`spawns ${i} and ${j} are only ${d.toFixed(1)} m apart`);
      } else if (d < MAP_LIMITS.spawnSightWarn) {
        const a: Vec3 = [spawns[i].x, spawns[i].y + BODY.standEye, spawns[i].z];
        const b: Vec3 = [spawns[j].x, spawns[j].y + BODY.standEye, spawns[j].z];
        const dir: Vec3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
        const len = Math.hypot(dir[0], dir[1], dir[2]);
        const unit: Vec3 = [dir[0] / len, dir[1] / len, dir[2] / len];
        if (traceWorld(a, unit, boxes, len) >= len - 1e-6) warnings.push(`spawns ${i} and ${j} are ${d.toFixed(1)} m apart and can see each other`);
      }
    }
  }
  if (errors.length > 0) return { errors, warnings, stats: stats(0, 0) };

  // ---- walkability grid: for each 0.5 m cell, every surface a player could stand on
  const c = MAP_LIMITS.cell;
  const nx = Math.ceil(spanX / c);
  const nz = Math.ceil(spanZ / c);
  const grid: Node[][] = new Array(nx * nz);
  let nodeCount = 0;
  const holes: string[] = [];
  for (let ix = 0; ix < nx; ix++) {
    for (let iz = 0; iz < nz; iz++) {
      const x0 = bounds.min[0] + ix * c;
      const z0 = bounds.min[2] + iz * c;
      const here = boxes.filter((b) => overlapsXZ(b, x0, z0, x0 + c, z0 + c));
      const nodes: Node[] = [];
      const tops = [...new Set(here.map((b) => Math.round(b.max[1] * 1000) / 1000))];
      for (const h of tops) {
        // Inside another solid? Then this top is buried and nobody can stand on it.
        if (here.some((b) => b.min[1] < h - 0.01 && b.max[1] > h + 0.01)) continue;
        let ceiling = Infinity;
        for (const b of here) if (b.min[1] >= h - 0.01) ceiling = Math.min(ceiling, b.min[1]);
        const clear = Math.min(ceiling - h, 10);
        if (clear < BODY.slideHeight) continue; // not even a slide fits
        nodes.push({ ix, iz, h, clear });
      }
      if (here.length === 0) holes.push(`(${(x0 + c / 2).toFixed(1)}, ${(z0 + c / 2).toFixed(1)})`);
      grid[ix * nz + iz] = nodes;
      nodeCount += nodes.length;
    }
  }
  if (holes.length > 0) {
    errors.push(`${holes.length} empty grid cells inside the bounds (a hole to fall through), first at ${holes.slice(0, 3).join(' ')}`);
  }

  // ---- movement graph: up to maxClimb, any drop
  const index = new Map<Node, number>();
  const all: Node[] = [];
  for (const list of grid) {
    for (const n of list) {
      index.set(n, all.length);
      all.push(n);
    }
  }
  const forward: number[][] = all.map(() => []);
  const backward: number[][] = all.map(() => []);
  const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  all.forEach((a, ai) => {
    for (const [dx, dz] of dirs) {
      const jx = a.ix + dx;
      const jz = a.iz + dz;
      if (jx < 0 || jz < 0 || jx >= nx || jz >= nz) continue;
      for (const b of grid[jx * nz + jz]) {
        const rise = b.h - a.h;
        if (rise > MAP_LIMITS.maxClimb) continue;
        // Stepping down, the space above the lower surface must reach up to where the body is.
        if (rise < 0 && b.h + b.clear < a.h + BODY.slideHeight) continue;
        const bi = index.get(b) as number;
        forward[ai].push(bi);
        backward[bi].push(ai);
      }
    }
  });

  const nodeAt = (x: number, z: number, y: number): number => {
    const ix = Math.min(nx - 1, Math.max(0, Math.floor((x - bounds.min[0]) / c)));
    const iz = Math.min(nz - 1, Math.max(0, Math.floor((z - bounds.min[2]) / c)));
    let best = -1;
    let bestDiff = 0.06;
    for (const n of grid[ix * nz + iz]) {
      const diff = Math.abs(n.h - y);
      if (diff < bestDiff) {
        bestDiff = diff;
        best = index.get(n) as number;
      }
    }
    return best;
  };
  const flood = (start: number, graph: number[][]): Uint8Array => {
    const seen = new Uint8Array(all.length);
    const stack = [start];
    seen[start] = 1;
    while (stack.length > 0) {
      const n = stack.pop() as number;
      for (const m of graph[n]) {
        if (!seen[m]) {
          seen[m] = 1;
          stack.push(m);
        }
      }
    }
    return seen;
  };

  const spawnNodes = spawns.map((s) => nodeAt(s.x, s.z, s.y));
  spawnNodes.forEach((n, i) => {
    if (n < 0) errors.push(`spawn ${i} is not on a walkable surface`);
  });
  if (spawnNodes.some((n) => n < 0)) return { errors, warnings, stats: stats(nx * nz, nodeCount) };

  // Every spawn reaches every other spawn.
  const from0 = flood(spawnNodes[0], forward);
  const to0 = flood(spawnNodes[0], backward);
  spawnNodes.forEach((n, i) => {
    if (!from0[n]) errors.push(`spawn ${i} cannot be reached from spawn 0`);
    if (!to0[n]) errors.push(`spawn ${i} cannot get to spawn 0`);
  });

  // Nobody gets trapped: from every place a player can reach, there is a way back to the spawns.
  const trapped: string[] = [];
  for (let i = 0; i < all.length; i++) {
    if (from0[i] && !to0[i]) {
      trapped.push(`(${(bounds.min[0] + all[i].ix * c).toFixed(1)}, ${all[i].h.toFixed(1)}, ${(bounds.min[2] + all[i].iz * c).toFixed(1)})`);
    }
  }
  if (trapped.length > 0) errors.push(`${trapped.length} reachable spots have no way back out (a trap), first at ${trapped.slice(0, 3).join(' ')}`);

  // Every platform should be somewhere a player can stand.
  boxes.forEach((b, i) => {
    if (b.kind !== 'platform') return;
    let reachable = false;
    const ix1 = Math.floor((b.max[0] - EPS - bounds.min[0]) / c);
    const iz1 = Math.floor((b.max[2] - EPS - bounds.min[2]) / c);
    for (let ix = Math.floor((b.min[0] - bounds.min[0]) / c); ix <= ix1 && !reachable; ix++) {
      for (let iz = Math.floor((b.min[2] - bounds.min[2]) / c); iz <= iz1; iz++) {
        for (const n of grid[ix * nz + iz]) {
          if (Math.abs(n.h - b.max[1]) < 0.01 && from0[index.get(n) as number]) reachable = true;
        }
      }
    }
    if (!reachable) errors.push(`platform ${i} at (${b.min[0]}, ${b.max[1]}, ${b.min[2]}) cannot be reached`);
  });

  return { errors, warnings, stats: stats(nx * nz, nodeCount) };
}

/** Checks things that need the whole set of maps. */
export function validateMapSet(maps: GameMap[]): string[] {
  const errors: string[] = [];
  const seen = new Set<string>();
  for (const m of maps) {
    if (seen.has(m.name)) errors.push(`two maps are called "${m.name}"`);
    seen.add(m.name);
  }
  return errors;
}

/** How high a standing jump goes; maxClimb in MAP_LIMITS is kept a little under this. */
export const JUMP_APEX = (MOVE.jumpSpeed * MOVE.jumpSpeed) / (2 * MOVE.gravity);
