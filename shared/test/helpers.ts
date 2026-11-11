import { readFileSync } from 'node:fs';
import { parseMap } from '../src/map.ts';
import type { Box, BoxKind, GameMap, Vec3 } from '../src/map.ts';
import { createPlayer, step } from '../src/movement.ts';
import type { Input, PlayerState } from '../src/types.ts';

export function loadMap(file: string): GameMap {
  const raw = JSON.parse(readFileSync(new URL(`../maps/${file}`, import.meta.url), 'utf8'));
  return parseMap(raw);
}

export function box(min: Vec3, max: Vec3, kind: BoxKind = 'wall'): Box {
  return { min, max, kind };
}

export const IDLE: Input = { forward: 0, strafe: 0, yaw: 0, jump: false, sprint: false, slide: false };

export function input(patch: Partial<Input> = {}): Input {
  return { ...IDLE, ...patch };
}

/** Small deterministic random generator so fuzz tests are reproducible. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A player dropped at (x, y, z) and given a few ticks to land. */
export function landed(x: number, y: number, z: number, boxes: readonly Box[]): PlayerState {
  let s = createPlayer(x, y, z);
  for (let i = 0; i < 10; i++) s = step(s, IDLE, boxes);
  return s;
}

export function randomInput(rand: () => number, yaw: number): Input {
  return {
    forward: rand() < 0.8 ? 1 : rand() < 0.5 ? 0 : -1,
    strafe: rand() < 0.6 ? 0 : rand() < 0.5 ? 1 : -1,
    yaw,
    jump: rand() < 0.04,
    sprint: rand() < 0.9,
    slide: rand() < 0.08,
  };
}
