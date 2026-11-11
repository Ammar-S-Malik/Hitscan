import test from 'node:test';
import assert from 'node:assert/strict';
import { NET } from '../src/config.ts';
import {
  MSG, decodeInputPacket, decodeServerMessage, encodeInputPacket, encodeReject, encodeSnapshot, encodeWelcome,
  quantizeInput,
} from '../src/protocol.ts';
import type { Snapshot } from '../src/protocol.ts';
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
    others: [
      { id: 7, x: 1.1, y: 0, z: -2.2, yaw: 0.5, sliding: true, grounded: false },
      { id: 65535, x: -300.5, y: 1.25, z: 80, yaw: -3, sliding: false, grounded: true },
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
});

test('welcome and reject round-trip', () => {
  const w = { playerId: 12, tickRate: 60, snapshotEvery: 2, tick: 77, yaw: Math.fround(1.5), mapName: 'Test Arena' };
  assert.deepStrictEqual(decodeServerMessage(encodeWelcome(w)), { kind: 'welcome', welcome: w });
  assert.deepStrictEqual(decodeServerMessage(encodeReject(1)), { kind: 'reject', reason: 1 });
});

test('random garbage never makes a decoder throw (fuzz)', () => {
  const rand = createRng(77);
  const types = [MSG.input, MSG.welcome, MSG.snapshot, MSG.reject, 0, 255];
  for (let n = 0; n < 30000; n++) {
    const len = Math.floor(rand() * 130);
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) bytes[i] = Math.floor(rand() * 256);
    if (len > 0 && rand() < 0.8) bytes[0] = types[Math.floor(rand() * types.length)];
    decodeInputPacket(bytes);
    decodeServerMessage(bytes);
  }
});
