import test from 'node:test';
import assert from 'node:assert/strict';
import { NET } from '../src/config.ts';
import { step } from '../src/movement.ts';
import { Predictor } from '../src/predictor.ts';
import { decodeInputPacket, quantizeInput } from '../src/protocol.ts';
import type { Snapshot } from '../src/protocol.ts';
import { box, input, landed } from './helpers.ts';

const FLAT = [box([-500, -1, -500], [500, 0, 500], 'floor')];
const run = input({ forward: 1, sprint: true });

function snapshot(tick: number, ack: number, own: Snapshot['own']): Snapshot {
  return { tick, ack, own, health: 100, alive: true, respawnTicks: 0, kills: 0, deaths: 0, others: [] };
}

test('tick() predicts immediately and sends the newest inputs, numbered from 1', () => {
  const p = new Predictor(FLAT, landed(0, 0, 0, FLAT));
  const first = decodeInputPacket(p.tick(run))!;
  assert.deepStrictEqual(first.map((x) => x.seq), [1]);
  assert.ok(p.cur.z < 0, 'moved forward at once, without waiting for the server');
  for (let i = 0; i < 9; i++) p.tick(run);
  const last = decodeInputPacket(p.tick(run))!;
  assert.equal(NET.inputRedundancy, 4);
  assert.deepStrictEqual(last.map((x) => x.seq), [8, 9, 10, 11], 'the newest 4 unacknowledged inputs ride along');
});

test('a snapshot that agrees with the prediction corrects nothing', () => {
  const start = landed(0, 0, 0, FLAT);
  const p = new Predictor(FLAT, start);
  const sent = [];
  let server = start;
  for (let i = 1; i <= 8; i++) {
    p.tick(run);
    sent.push(quantizeInput(run));
  }
  for (let i = 0; i < 5; i++) server = step(server, sent[i], FLAT); // the server has applied 5 of the 8
  const before = p.cur;
  p.onSnapshot(snapshot(1, 5, server));
  assert.equal(p.lastCorrection, 0);
  assert.deepStrictEqual(p.cur, before, 'replaying the 3 unacknowledged inputs lands on the same state');
  assert.equal(p.pendingCount, 3);
});

test('a disagreeing snapshot moves the state but not the picture, which then fades into place', () => {
  const start = landed(0, 0, 0, FLAT);
  const p = new Predictor(FLAT, start);
  for (let i = 0; i < 6; i++) p.tick(run);
  const drawnBefore = p.renderPosition(1);
  const wrong = { ...p.cur, x: p.cur.x + 0.5 };
  p.onSnapshot(snapshot(1, 6, wrong)); // every input acknowledged, but the server says we are 0.5 m off
  assert.ok(Math.abs(p.lastCorrection - 0.5) < 1e-9);
  assert.ok(Math.abs(p.cur.x - wrong.x) < 1e-9, 'the true state is now the server\'s');
  const drawnAfter = p.renderPosition(1);
  assert.ok(Math.abs(drawnAfter.x - drawnBefore.x) < 1e-9, 'the picture did not jump');
  p.smoothErrors(1);
  assert.ok(Math.abs(p.renderPosition(1).x - p.cur.x) < 1e-4, 'and it settles onto the true position');
});

test('a huge disagreement snaps instead of sliding', () => {
  const p = new Predictor(FLAT, landed(0, 0, 0, FLAT));
  p.tick(run);
  p.onSnapshot(snapshot(1, 1, { ...p.cur, x: 50 }));
  assert.ok(p.lastCorrection > NET.snapDistance);
  assert.ok(Math.abs(p.renderPosition(1).x - 50) < 1e-9);
});

test('old and duplicate snapshots are ignored', () => {
  const p = new Predictor(FLAT, landed(0, 0, 0, FLAT));
  for (let i = 0; i < 4; i++) p.tick(run);
  p.onSnapshot(snapshot(10, 4, p.cur));
  const after = p.cur;
  p.onSnapshot(snapshot(8, 2, { ...after, x: 99 })); // older tick: must not rewind us
  p.onSnapshot(snapshot(10, 4, { ...after, x: 99 })); // same tick again
  assert.deepStrictEqual(p.cur, after);
});

test('inputs the server never acknowledges are capped, not kept forever', () => {
  const p = new Predictor(FLAT, landed(0, 0, 0, FLAT));
  for (let i = 0; i < NET.maxPending + 100; i++) p.tick(run);
  assert.equal(p.pendingCount, NET.maxPending);
});
