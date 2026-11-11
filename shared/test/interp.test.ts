import test from 'node:test';
import assert from 'node:assert/strict';
import { Interpolator } from '../src/interp.ts';
import type { RemotePlayer } from '../src/protocol.ts';

function at(id: number, x: number, yaw = 0, sliding = false): RemotePlayer {
  return { id, x, y: 0, z: 0, yaw, sliding, grounded: true, alive: true, kills: 0, deaths: 0 };
}

/** A player running at 10 m/s, snapshots every 1/30 s, each arriving `latency` ms after it was sent. */
function feed(interp: Interpolator, upToSeconds: number, latencyMs: number, jitter = (_: number) => 0): void {
  for (let k = 0; k * (1 / 30) <= upToSeconds; k++) {
    const t = k / 30;
    interp.push(t, [at(1, t * 10)], t * 1000 + latencyMs + jitter(k));
  }
}

test('players are drawn between the two snapshots around the render time, smoothly', () => {
  const interp = new Interpolator(0.1);
  feed(interp, 2, 50);
  let previous = -Infinity;
  for (let ms = 1000; ms <= 1900; ms += 5) {
    const s = interp.sample(ms + 50);
    const x = s.players[0].x;
    assert.ok(Math.abs(x - s.renderTime * 10) < 1e-3, `off the true path at ${ms}: ${x} vs ${s.renderTime * 10}`);
    assert.ok(x >= previous, 'moved backwards');
    previous = x;
  }
});

test('render time trails the newest snapshot, so there is always one to blend toward', () => {
  const interp = new Interpolator(0.1);
  feed(interp, 2, 50);
  const s = interp.sample(1500 + 50);
  assert.ok(Math.abs(1.5 - s.renderTime - 0.1) < 0.02, `render time ${s.renderTime}`);
});

test('jittery arrival times do not make the picture jitter', () => {
  const interp = new Interpolator(0.1);
  let seed = 1;
  const jitter = () => { seed = (seed * 16807) % 2147483647; return (seed / 2147483647) * 30; };
  feed(interp, 3, 60, jitter);
  let lastRender = -Infinity;
  for (let ms = 1500; ms <= 2500; ms += 4) {
    const s = interp.sample(ms);
    assert.ok(s.renderTime >= lastRender - 1e-9, 'render time went backwards');
    lastRender = s.renderTime;
  }
});

test('never extrapolates: when snapshots stop, the player holds the last known position', () => {
  const interp = new Interpolator(0.1);
  feed(interp, 1, 50);
  const frozen = interp.sample(60_000).players[0].x;
  assert.ok(Math.abs(frozen - 10) < 0.4);
  assert.equal(interp.sample(120_000).players[0].x, frozen);
});

test('old or duplicate snapshots are ignored, and a player who left disappears', () => {
  const interp = new Interpolator(0.1);
  interp.push(1, [at(1, 0), at(2, 5)], 1000);
  interp.push(1.0333, [at(1, 1), at(2, 6)], 1033);
  interp.push(0.5, [at(1, 999)], 1040);
  interp.push(1.0667, [at(1, 2)], 1067); // player 2 has left
  interp.push(1.1, [at(1, 3)], 1100);
  interp.push(1.1333, [at(1, 4)], 1133);
  const early = interp.sample(1000 + 100);
  assert.ok(early.players.every((p) => p.x < 100), 'the old snapshot leaked in');
  const late = interp.sample(1133 + 100);
  assert.deepStrictEqual(late.players.map((p) => p.id), [1]);
});

test('turning takes the short way round the circle', () => {
  const interp = new Interpolator(0);
  interp.push(0, [at(1, 0, Math.PI - 0.1)], 0);
  interp.push(1, [at(1, 0, -Math.PI + 0.1)], 1000);
  const s = interp.sample(500 + 0);
  const yaw = s.players[0].yaw;
  assert.ok(Math.abs(Math.abs(yaw) - Math.PI) < 1e-6, `went the long way: ${yaw}`);
});
