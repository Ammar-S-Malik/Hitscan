import test from 'node:test';
import assert from 'node:assert/strict';
import { NET } from '../src/config.ts';
import {
  MSG, decodeInputPacket, decodeServerMessage, encodeEvents, encodeInputPacket, encodeReject, encodeSnapshot, encodeWelcome,
  quantizeInput,
} from '../src/protocol.ts';
import type { ShotEvent, Snapshot } from '../src/protocol.ts';
import { createPlayer } from '../src/movement.ts';
import { createRng } from '../src/netsim.ts';
import { input } from './helpers.ts';

test('quantizeInput is idempotent, clamps, and never produces -0 or NaN', () => {
  const q = quantizeInput(input({ forward: 0.333333, strafe: -1.7, yaw: 1.2345678901234, jump: true }));
  assert.deepStrictEqual(quantizeInput(q), q);
  assert.equal(q.strafe, -1);
  assert.ok(Math.abs(q.forward - 0.333333) < 1 / 127);
  assert.equal(q.yaw, Math.fround(1.2345678901234));
  for (const bad of [NaN, Infinity, -Infinity]) {
    const r = quantizeInput(input({ forward: bad, strafe: bad, yaw: bad }));
    assert.deepStrictEqual([r.forward, r.strafe, r.yaw], [0, 0, 0]);
  }
  const z = quantizeInput(input({ forward: -0, strafe: -1e-9 }));
  assert.ok(Object.is(z.forward, 0) && Object.is(z.strafe, 0), 'zero must be +0');
});

test('an input survives the wire exactly as quantizeInput says it will (what prediction relies on)', () => {
  const rand = createRng(5);
  for (let n = 0; n < 500; n++) {
    const raw = input({
      forward: rand() * 2 - 1, strafe: rand() * 2 - 1, yaw: (rand() - 0.5) * 20,
      jump: rand() < 0.5, sprint: rand() < 0.5, slide: rand() < 0.5,
      pitch: (rand() - 0.5) * 4, fire: rand() < 0.5, viewMs: Math.floor(rand() * 4e9),
      weapon: Math.floor(rand() * 5), aim: rand() < 0.5,
    });
    const decoded = decodeInputPacket(encodeInputPacket([{ seq: 4000000000 + n, input: raw }]));
    assert.ok(decoded);
    assert.equal(decoded[0].seq, 4000000000 + n);
    assert.deepStrictEqual(decoded[0].input, quantizeInput(raw));
  }
});

test('input packets carry several inputs and reject anything malformed', () => {
  const inputs = [1, 2, 3, 4].map((seq) => ({ seq, input: quantizeInput(input({ forward: 1, yaw: seq })) }));
  assert.deepStrictEqual(decodeInputPacket(encodeInputPacket(inputs)), inputs);

  const good = encodeInputPacket(inputs.slice(0, 2));
  assert.equal(decodeInputPacket(new Uint8Array(0)), null);
  assert.equal(decodeInputPacket(good.slice(0, good.length - 1)), null, 'truncated');
  assert.equal(decodeInputPacket(new Uint8Array([...good, 0])), null, 'trailing byte');
  assert.equal(decodeInputPacket(new Uint8Array([MSG.snapshot, ...good.slice(1)])), null, 'wrong type');
  const empty = new Uint8Array([MSG.input, 0]);
  assert.equal(decodeInputPacket(empty), null, 'zero inputs');
  const many = encodeInputPacket(Array.from({ length: NET.maxInputsPerPacket + 1 }, (_, i) => ({ seq: i + 1, input: quantizeInput(input()) })));
  assert.equal(decodeInputPacket(many), null, 'more inputs than allowed');
});

test('hostile input bytes decode to harmless values', () => {
  const buf = encodeInputPacket([{ seq: 1, input: quantizeInput(input()) }]);
  const v = new DataView(buf.buffer);
  v.setInt8(6, -128); // forward
  v.setInt8(7, 127); // strafe
  v.setFloat32(8, NaN, true); // yaw
  const d = decodeInputPacket(buf)!;
  assert.equal(d[0].input.forward, -1);
  assert.equal(d[0].input.strafe, 1);
  assert.equal(d[0].input.yaw, 0);
});

test('snapshots round-trip: own state exactly, other players to float32 precision', () => {
  const own = { ...createPlayer(1.123456789012345, 2.5, -3.000000000001), vx: 4.1, vy: -0.7, vz: 9.99, grounded: true, sliding: true, slideTimer: 0.3333333333, slideCooldown: 0.125, slideHeld: true };
  const snap: Snapshot = {
    tick: 123456, ack: 99,
    own,
    health: 65, alive: false, respawnTicks: 120, kills: 4, deaths: 9,
    others: [
      { id: 7, x: 1.1, y: 0, z: -2.2, yaw: 0.5, sliding: true, grounded: false, alive: true, kills: 3, deaths: 1 },
      { id: 65535, x: -300.5, y: 1.25, z: 80, yaw: -3, sliding: false, grounded: true, alive: false, kills: 65535, deaths: 0 },
    ],
  };
  const msg = decodeServerMessage(encodeSnapshot(snap));
  assert.ok(msg && msg.kind === 'snapshot');
  assert.equal(msg.snapshot.tick, 123456);
  assert.equal(msg.snapshot.ack, 99);
  assert.deepStrictEqual(msg.snapshot.own, own);
  assert.equal(msg.snapshot.others.length, 2);
  assert.equal(msg.snapshot.others[1].id, 65535);
  assert.equal(msg.snapshot.others[0].x, Math.fround(1.1));
  assert.equal(msg.snapshot.others[0].sliding, true);
  assert.equal(msg.snapshot.others[1].grounded, true);
  assert.equal(msg.snapshot.health, 65);
  assert.equal(msg.snapshot.alive, false);
  assert.equal(msg.snapshot.respawnTicks, 120);
  assert.deepStrictEqual([msg.snapshot.kills, msg.snapshot.deaths], [4, 9]);
  assert.deepStrictEqual(msg.snapshot.others.map((o) => [o.alive, o.kills, o.deaths]), [[true, 3, 1], [false, 65535, 0]]);
});

test('welcome and reject round-trip', () => {
  const w = { playerId: 12, tickRate: 60, snapshotEvery: 2, tick: 77, yaw: Math.fround(1.5), mapName: 'Test Arena' };
  assert.deepStrictEqual(decodeServerMessage(encodeWelcome(w)), { kind: 'welcome', welcome: w });
  assert.deepStrictEqual(decodeServerMessage(encodeReject(1)), { kind: 'reject', reason: 1 });
});

test('random garbage never makes a decoder throw (fuzz)', () => {
  const rand = createRng(77);
  const types = [MSG.input, MSG.welcome, MSG.snapshot, MSG.reject, MSG.events, 0, 255];
  for (let n = 0; n < 30000; n++) {
    const len = Math.floor(rand() * 130);
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) bytes[i] = Math.floor(rand() * 256);
    if (len > 0 && rand() < 0.8) bytes[0] = types[Math.floor(rand() * types.length)];
    decodeInputPacket(bytes);
    decodeServerMessage(bytes);
  }
});

test('shot events round-trip and reject a wrong length or non-finite positions', () => {
  const events: ShotEvent[] = [
    { shooter: 3, victim: 9, headshot: true, killed: false, damage: 50, weapon: 4, origin: [1.5, 1.625, -2.25], end: [10, 1.5, -20] },
    { shooter: 65535, victim: 0, headshot: false, killed: false, damage: 0, weapon: 0, origin: [0, 0, 0], end: [-0.5, 3, 8] },
    { shooter: 1, victim: 2, headshot: false, killed: true, damage: 25, weapon: 2, origin: [0, 0, 0], end: [1, 1, 1] },
  ];
  const bytes = encodeEvents(events);
  assert.deepStrictEqual(decodeServerMessage(bytes), { kind: 'events', events });
  assert.equal(decodeServerMessage(bytes.slice(0, bytes.length - 1)), null, 'truncated');
  assert.equal(decodeServerMessage(new Uint8Array([...bytes, 0])), null, 'trailing byte');
  const bad = bytes.slice();
  new DataView(bad.buffer).setFloat32(2 + 7, NaN, true);
  assert.equal(decodeServerMessage(bad), null, 'NaN position');
});

test('aim and trigger fields quantize safely: pitch is clamped, view time is a whole non-negative number', () => {
  const q = quantizeInput(input({ pitch: 99, fire: true, viewMs: -5 }));
  assert.equal(q.pitch, Math.fround(Math.PI / 2));
  assert.equal(q.viewMs, 0);
  const r = quantizeInput(input({ pitch: NaN, viewMs: Infinity }));
  assert.equal(r.pitch, 0);
  assert.equal(r.viewMs, 0);
  assert.equal(quantizeInput(input({ viewMs: 1234.6 })).viewMs, 1235);
});

test('weapon and aim travel in the input flags, and a hostile weapon number falls back to the pistol', () => {
  for (let weapon = 0; weapon < 5; weapon++) {
    const d = decodeInputPacket(encodeInputPacket([{ seq: 1, input: quantizeInput(input({ weapon, aim: weapon % 2 === 0, fire: true })) }]))!;
    assert.equal(d[0].input.weapon, weapon);
    assert.equal(d[0].input.aim, weapon % 2 === 0);
    assert.equal(d[0].input.fire, true);
  }
  const buf = encodeInputPacket([{ seq: 1, input: quantizeInput(input({ jump: true })) }]);
  buf[2 + 14] |= 7 << 5; // weapon 7 does not exist
  const bad = decodeInputPacket(buf)!;
  assert.equal(bad[0].input.weapon, 0);
  assert.equal(bad[0].input.jump, true, 'the other flags are untouched');
  assert.equal(quantizeInput(input({ weapon: 99 })).weapon, 0);
  assert.equal(quantizeInput(input({ weapon: 2.5 })).weapon, 0);
  assert.equal(quantizeInput(input({ weapon: NaN })).weapon, 0);
});
