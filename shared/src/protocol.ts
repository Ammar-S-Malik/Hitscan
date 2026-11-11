/**
 * The wire format. Everything is little-endian binary, and every decoder returns null on
 * malformed input instead of throwing: the server must survive any bytes a client sends.
 *
 * Client -> server
 *   input packet:  u8 type(1) | u8 count | count x { u32 seq, i8 forward, i8 strafe, f32 yaw, f32 pitch, u8 flags, u32 viewMs, u8 flags2 }
 *                  flags: 1 jump, 2 sprint, 4 slide, 8 fire, 16 aim, bits 5-7 the weapon index
 *                  flags2: 1 reload
 * Server -> client
 *   welcome:   u8 type(16) | u16 playerId | u8 tickRate | u8 snapshotEvery | u32 tick | f32 yaw | u8 nameLen | name
 *   snapshot:  u8 type(17) | u32 tick | u32 ack | 8 x f64 own state | u8 flags | u8 health | u8 respawnTicks |
 *              u16 kills | u16 deaths | u8 count | count x other player
 *   reject:    u8 type(18) | u8 reason
 *   events:    u8 type(19) | u8 count | count x shot event
 *
 * The client's own state is sent as f64 so that after a snapshot the client holds exactly the state
 * the server holds. Other players only need to be drawn, so they use f32.
 */
import { NET, WEAPON_COUNT } from './config.ts';
import type { Vec3 } from './map.ts';
import type { Input, PlayerState } from './types.ts';

export const MSG = { input: 0x01, welcome: 0x10, snapshot: 0x11, reject: 0x12, events: 0x13 } as const;
export const REJECT_FULL = 1;

export interface SeqInput {
  seq: number;
  input: Input;
}

export interface Welcome {
  playerId: number;
  tickRate: number;
  snapshotEvery: number;
  tick: number;
  yaw: number; // the direction the player starts out facing
  mapName: string; // ASCII only
}

export interface RemotePlayer {
  id: number;
  x: number;
  y: number;
  z: number;
  yaw: number;
  sliding: boolean;
  grounded: boolean;
  alive: boolean;
  kills: number;
  deaths: number;
}

export interface Snapshot {
  tick: number; // the server tick this snapshot describes
  ack: number; // the newest input of yours the server has applied
  own: PlayerState;
  health: number;
  alive: boolean;
  respawnTicks: number; // while dead: ticks until you respawn
  kills: number;
  deaths: number;
  others: RemotePlayer[];
}

/** One shot, as the server resolved it. Sent to everyone, so every client can draw the tracer. */
export interface ShotEvent {
  shooter: number;
  victim: number; // 0 if nothing was hit
  headshot: boolean;
  killed: boolean;
  damage: number;
  weapon: number;
  origin: Vec3;
  end: Vec3;
}

export type ServerMessage =
  | { kind: 'welcome'; welcome: Welcome }
  | { kind: 'snapshot'; snapshot: Snapshot }
  | { kind: 'events'; events: ShotEvent[] }
  | { kind: 'reject'; reason: number };

// ------------------------------------------------------------------ inputs

const AXIS_SCALE = 127;
const INPUT_BYTES = 20;
const MAX_PITCH = Math.fround(Math.PI / 2); // as a float32, so a clamped value survives the wire unchanged

function quantAxis(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.round(Math.max(-1, Math.min(1, v)) * AXIS_SCALE);
}

/**
 * The input exactly as the server will see it after a round trip through the wire format.
 * The client must simulate with this, not with the raw input, or its prediction would drift
 * from the server's result by the rounding error.
 */
export function quantizeInput(i: Input): Input {
  const f = quantAxis(i.forward);
  const s = quantAxis(i.strafe);
  return {
    forward: f === 0 ? 0 : f / AXIS_SCALE, // never -0, which would break exact comparisons
    strafe: s === 0 ? 0 : s / AXIS_SCALE,
    yaw: Number.isFinite(i.yaw) ? Math.fround(i.yaw) : 0,
    jump: Boolean(i.jump),
    sprint: Boolean(i.sprint),
    slide: Boolean(i.slide),
    pitch: quantPitch(i.pitch),
    fire: Boolean(i.fire),
    weapon: quantWeapon(i.weapon),
    aim: Boolean(i.aim),
    reload: Boolean(i.reload),
    viewMs: quantViewMs(i.viewMs),
  };
}

function quantWeapon(v: number): number {
  return Number.isInteger(v) && v >= 0 && v < WEAPON_COUNT ? v : 0;
}

function quantPitch(v: number): number {
  if (!Number.isFinite(v)) return 0;
  const p = Math.fround(Math.max(-MAX_PITCH, Math.min(MAX_PITCH, v)));
  return p === 0 ? 0 : p; // never -0
}

function quantViewMs(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(0xffffffff, Math.round(v)));
}

export function encodeInputPacket(inputs: readonly SeqInput[]): Uint8Array {
  const n = Math.min(inputs.length, 255);
  const buf = new Uint8Array(2 + n * INPUT_BYTES);
  const v = new DataView(buf.buffer);
  buf[0] = MSG.input;
  buf[1] = n;
  let o = 2;
  for (let i = 0; i < n; i++) {
    const { seq, input } = inputs[i];
    v.setUint32(o, seq >>> 0, true);
    v.setInt8(o + 4, quantAxis(input.forward));
    v.setInt8(o + 5, quantAxis(input.strafe));
    v.setFloat32(o + 6, input.yaw, true);
    v.setFloat32(o + 10, quantPitch(input.pitch), true);
    v.setUint8(
      o + 14,
      (input.jump ? 1 : 0) | (input.sprint ? 2 : 0) | (input.slide ? 4 : 0) | (input.fire ? 8 : 0) |
        (input.aim ? 16 : 0) | (quantWeapon(input.weapon) << 5),
    );
    v.setUint32(o + 15, quantViewMs(input.viewMs), true);
    v.setUint8(o + 19, input.reload ? 1 : 0);
    o += INPUT_BYTES;
  }
  return buf;
}

/** Returns the inputs in the packet, or null if it is not a well-formed input packet. */
export function decodeInputPacket(bytes: Uint8Array): SeqInput[] | null {
  if (bytes.length < 2 || bytes[0] !== MSG.input) return null;
  const n = bytes[1];
  if (n === 0 || n > NET.maxInputsPerPacket) return null;
  if (bytes.length !== 2 + n * INPUT_BYTES) return null;
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out: SeqInput[] = [];
  let o = 2;
  for (let i = 0; i < n; i++) {
    const f = v.getInt8(o + 4);
    const s = v.getInt8(o + 5);
    const yaw = v.getFloat32(o + 6, true);
    const pitch = v.getFloat32(o + 10, true);
    const flags = v.getUint8(o + 14);
    out.push({
      seq: v.getUint32(o, true),
      input: {
        forward: f === 0 ? 0 : Math.max(-1, f / AXIS_SCALE),
        strafe: s === 0 ? 0 : Math.max(-1, s / AXIS_SCALE),
        yaw: Number.isFinite(yaw) ? yaw : 0,
        jump: (flags & 1) !== 0,
        sprint: (flags & 2) !== 0,
        slide: (flags & 4) !== 0,
        pitch: Number.isFinite(pitch) ? Math.max(-MAX_PITCH, Math.min(MAX_PITCH, pitch)) : 0,
        fire: (flags & 8) !== 0,
        aim: (flags & 16) !== 0,
        weapon: quantWeapon(flags >> 5),
        reload: (v.getUint8(o + 19) & 1) !== 0,
        viewMs: v.getUint32(o + 15, true),
      },
    });
    o += INPUT_BYTES;
  }
  return out;
}

// ------------------------------------------------------------- server messages

export function encodeWelcome(w: Welcome): Uint8Array {
  const name: number[] = [];
  for (let i = 0; i < w.mapName.length && name.length < 255; i++) name.push(w.mapName.charCodeAt(i) & 0x7f);
  const buf = new Uint8Array(14 + name.length);
  const v = new DataView(buf.buffer);
  buf[0] = MSG.welcome;
  v.setUint16(1, w.playerId, true);
  buf[3] = w.tickRate;
  buf[4] = w.snapshotEvery;
  v.setUint32(5, w.tick >>> 0, true);
  v.setFloat32(9, w.yaw, true);
  buf[13] = name.length;
  buf.set(name, 14);
  return buf;
}

export function encodeReject(reason: number): Uint8Array {
  return new Uint8Array([MSG.reject, reason]);
}

const OWN_BYTES = 8 * 8 + 1 + 1 + 1 + 2 + 2;
const OTHER_BYTES = 2 + 4 * 4 + 1 + 2 + 2;
const EVENT_BYTES = 2 + 2 + 1 + 1 + 1 + 6 * 4;

export function encodeSnapshot(s: Snapshot): Uint8Array {
  const n = Math.min(s.others.length, 255);
  const buf = new Uint8Array(1 + 4 + 4 + OWN_BYTES + 1 + n * OTHER_BYTES);
  const v = new DataView(buf.buffer);
  let o = 0;
  buf[o++] = MSG.snapshot;
  v.setUint32(o, s.tick >>> 0, true);
  o += 4;
  v.setUint32(o, s.ack >>> 0, true);
  o += 4;
  const p = s.own;
  for (const f of [p.x, p.y, p.z, p.vx, p.vy, p.vz, p.slideTimer, p.slideCooldown]) {
    v.setFloat64(o, f, true);
    o += 8;
  }
  buf[o++] = (p.grounded ? 1 : 0) | (p.sliding ? 2 : 0) | (p.slideHeld ? 4 : 0) | (s.alive ? 8 : 0);
  buf[o++] = clampByte(s.health);
  buf[o++] = clampByte(s.respawnTicks);
  v.setUint16(o, clampU16(s.kills), true);
  v.setUint16(o + 2, clampU16(s.deaths), true);
  o += 4;
  buf[o++] = n;
  for (let i = 0; i < n; i++) {
    const r = s.others[i];
    v.setUint16(o, r.id, true);
    o += 2;
    for (const f of [r.x, r.y, r.z, r.yaw]) {
      v.setFloat32(o, f, true);
      o += 4;
    }
    buf[o++] = (r.sliding ? 1 : 0) | (r.grounded ? 2 : 0) | (r.alive ? 4 : 0);
    v.setUint16(o, clampU16(r.kills), true);
    v.setUint16(o + 2, clampU16(r.deaths), true);
    o += 4;
  }
  return buf;
}

function clampByte(n: number): number {
  return Number.isFinite(n) ? Math.max(0, Math.min(255, Math.round(n))) : 0;
}

function clampU16(n: number): number {
  return Number.isFinite(n) ? Math.max(0, Math.min(65535, Math.round(n))) : 0;
}

export function encodeEvents(events: readonly ShotEvent[]): Uint8Array {
  const n = Math.min(events.length, 255);
  const buf = new Uint8Array(2 + n * EVENT_BYTES);
  const v = new DataView(buf.buffer);
  buf[0] = MSG.events;
  buf[1] = n;
  let o = 2;
  for (let i = 0; i < n; i++) {
    const e = events[i];
    v.setUint16(o, e.shooter, true);
    v.setUint16(o + 2, e.victim, true);
    buf[o + 4] = (e.headshot ? 1 : 0) | (e.killed ? 2 : 0);
    buf[o + 5] = clampByte(e.damage);
    buf[o + 6] = quantWeapon(e.weapon);
    for (let k = 0; k < 3; k++) {
      v.setFloat32(o + 7 + k * 4, e.origin[k], true);
      v.setFloat32(o + 19 + k * 4, e.end[k], true);
    }
    o += EVENT_BYTES;
  }
  return buf;
}

/** Returns the decoded message, or null if the bytes are not a valid server message. */
export function decodeServerMessage(bytes: Uint8Array): ServerMessage | null {
  try {
    if (bytes.length < 1) return null;
    const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    switch (bytes[0]) {
      case MSG.welcome: {
        if (bytes.length < 14) return null;
        const nameLen = bytes[13];
        if (bytes.length !== 14 + nameLen) return null;
        let mapName = '';
        for (let i = 0; i < nameLen; i++) mapName += String.fromCharCode(bytes[14 + i]);
        return {
          kind: 'welcome',
          welcome: {
            playerId: v.getUint16(1, true),
            tickRate: bytes[3],
            snapshotEvery: bytes[4],
            tick: v.getUint32(5, true),
            yaw: v.getFloat32(9, true),
            mapName,
          },
        };
      }
      case MSG.reject:
        return bytes.length === 2 ? { kind: 'reject', reason: bytes[1] } : null;
      case MSG.snapshot: {
        if (bytes.length < 1 + 4 + 4 + OWN_BYTES + 1) return null;
        let o = 1;
        const tick = v.getUint32(o, true);
        o += 4;
        const ack = v.getUint32(o, true);
        o += 4;
        const f: number[] = [];
        for (let i = 0; i < 8; i++) {
          f.push(v.getFloat64(o, true));
          o += 8;
        }
        const flags = bytes[o++];
        const health = bytes[o++];
        const respawnTicks = bytes[o++];
        const kills = v.getUint16(o, true);
        const deaths = v.getUint16(o + 2, true);
        o += 4;
        const n = bytes[o++];
        if (bytes.length !== o + n * OTHER_BYTES) return null;
        const others: RemotePlayer[] = [];
        for (let i = 0; i < n; i++) {
          const id = v.getUint16(o, true);
          const x = v.getFloat32(o + 2, true);
          const y = v.getFloat32(o + 6, true);
          const z = v.getFloat32(o + 10, true);
          const yaw = v.getFloat32(o + 14, true);
          const fl = bytes[o + 18];
          others.push({
            id, x, y, z, yaw,
            sliding: (fl & 1) !== 0,
            grounded: (fl & 2) !== 0,
            alive: (fl & 4) !== 0,
            kills: v.getUint16(o + 19, true),
            deaths: v.getUint16(o + 21, true),
          });
          o += OTHER_BYTES;
        }
        const own: PlayerState = {
          x: f[0], y: f[1], z: f[2],
          vx: f[3], vy: f[4], vz: f[5],
          slideTimer: f[6], slideCooldown: f[7],
          grounded: (flags & 1) !== 0,
          sliding: (flags & 2) !== 0,
          slideHeld: (flags & 4) !== 0,
        };
        return {
          kind: 'snapshot',
          snapshot: { tick, ack, own, health, alive: (flags & 8) !== 0, respawnTicks, kills, deaths, others },
        };
      }
      case MSG.events: {
        if (bytes.length < 2) return null;
        const n = bytes[1];
        if (bytes.length !== 2 + n * EVENT_BYTES) return null;
        const events: ShotEvent[] = [];
        let o = 2;
        for (let i = 0; i < n; i++) {
          const origin: Vec3 = [0, 0, 0];
          const end: Vec3 = [0, 0, 0];
          for (let k = 0; k < 3; k++) {
            origin[k] = v.getFloat32(o + 7 + k * 4, true);
            end[k] = v.getFloat32(o + 19 + k * 4, true);
          }
          if (!origin.every(Number.isFinite) || !end.every(Number.isFinite)) return null;
          events.push({
            shooter: v.getUint16(o, true),
            victim: v.getUint16(o + 2, true),
            headshot: (bytes[o + 4] & 1) !== 0,
            killed: (bytes[o + 4] & 2) !== 0,
            damage: bytes[o + 5],
            weapon: quantWeapon(bytes[o + 6]),
            origin,
            end,
          });
          o += EVENT_BYTES;
        }
        return { kind: 'events', events };
      }
      default:
        return null;
    }
  } catch {
    return null;
  }
}
