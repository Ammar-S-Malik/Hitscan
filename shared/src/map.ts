export type Vec3 = [number, number, number];
export type BoxKind = 'floor' | 'wall' | 'cover' | 'platform' | 'ceiling';

export interface Box {
  min: Vec3;
  max: Vec3;
  kind: BoxKind;
}

export interface Spawn {
  x: number;
  y: number;
  z: number;
  yaw: number;
}

export interface GameMap {
  name: string;
  size: 'small' | 'medium';
  maxPlayers: number;
  sky?: string; // sky and fog colour as #rrggbb; the client has a default
  bounds: { min: Vec3; max: Vec3 };
  boxes: Box[];
  spawns: Spawn[];
}

const KINDS: readonly string[] = ['floor', 'wall', 'cover', 'platform', 'ceiling'];

function fail(path: string, what: string): never {
  throw new Error(`invalid map: ${path} ${what}`);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function num(v: unknown, path: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) fail(path, 'must be a finite number');
  return v;
}

function vec3(v: unknown, path: string): Vec3 {
  if (!Array.isArray(v) || v.length !== 3) fail(path, 'must be [x, y, z]');
  return [num(v[0], `${path}[0]`), num(v[1], `${path}[1]`), num(v[2], `${path}[2]`)];
}

/** Checks the structure of a map loaded from JSON and returns it typed. Throws a readable error. */
export function parseMap(raw: unknown): GameMap {
  if (!isRecord(raw)) fail('map', 'must be an object');
  if (typeof raw.name !== 'string' || raw.name === '') fail('name', 'must be a non-empty string');
  if (raw.size !== 'small' && raw.size !== 'medium') fail('size', 'must be "small" or "medium"');
  const maxPlayers = num(raw.maxPlayers, 'maxPlayers');
  if (!Number.isInteger(maxPlayers) || maxPlayers < 1) fail('maxPlayers', 'must be a positive integer');

  if (!isRecord(raw.bounds)) fail('bounds', 'must be an object');
  const bounds = { min: vec3(raw.bounds.min, 'bounds.min'), max: vec3(raw.bounds.max, 'bounds.max') };

  if (!Array.isArray(raw.boxes)) fail('boxes', 'must be an array');
  const boxes: Box[] = raw.boxes.map((b: unknown, i: number) => {
    if (!isRecord(b)) fail(`boxes[${i}]`, 'must be an object');
    if (typeof b.kind !== 'string' || !KINDS.includes(b.kind)) fail(`boxes[${i}].kind`, `must be one of ${KINDS.join(', ')}`);
    const min = vec3(b.min, `boxes[${i}].min`);
    const max = vec3(b.max, `boxes[${i}].max`);
    for (let a = 0; a < 3; a++) if (max[a] <= min[a]) fail(`boxes[${i}]`, 'max must be greater than min on every axis');
    return { kind: b.kind as BoxKind, min, max };
  });

  if (!Array.isArray(raw.spawns) || raw.spawns.length === 0) fail('spawns', 'must be a non-empty array');
  const spawns: Spawn[] = raw.spawns.map((s: unknown, i: number) => {
    if (!isRecord(s)) fail(`spawns[${i}]`, 'must be an object');
    return {
      x: num(s.x, `spawns[${i}].x`),
      y: num(s.y, `spawns[${i}].y`),
      z: num(s.z, `spawns[${i}].z`),
      yaw: num(s.yaw, `spawns[${i}].yaw`),
    };
  });

  if (raw.sky !== undefined && (typeof raw.sky !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(raw.sky))) fail('sky', 'must look like #a1b2c3');
  return { name: raw.name, size: raw.size, maxPlayers, sky: raw.sky as string | undefined, bounds, boxes, spawns };
}
