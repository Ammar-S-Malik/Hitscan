import test from 'node:test';
import assert from 'node:assert/strict';
import { COMBAT } from '../src/config.ts';
import { FireControl } from '../src/combat.ts';
import { aimDirection, rayBox, traceShot, traceWorld } from '../src/hitscan.ts';
import type { Target } from '../src/hitscan.ts';
import { box } from './helpers.ts';

const near = (a: number, b: number, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} vs ${b}`);

test('aimDirection: yaw 0 looks toward -Z, positive yaw turns left, positive pitch looks up, always unit length', () => {
  const [x, y, z] = aimDirection(0, 0);
  near(x, 0); near(y, 0); near(z, -1);
  const left = aimDirection(Math.PI / 2, 0);
  near(left[0], -1); near(left[2], 0, 1e-9);
  const up = aimDirection(0, Math.PI / 4);
  assert.ok(up[1] > 0.7);
  for (const [yaw, pitch] of [[0.3, 0.2], [-2, 1.2], [5, -0.7]]) {
    const d = aimDirection(yaw, pitch);
    near(Math.hypot(d[0], d[1], d[2]), 1);
  }
  const bad = aimDirection(NaN, NaN);
  near(bad[0], 0); near(bad[1], 0); near(bad[2], -1);
});

test('rayBox: hits, misses, parallel rays, rays pointing away and rays starting inside', () => {
  const min: [number, number, number] = [-1, 0, -6];
  const max: [number, number, number] = [1, 2, -4];
  near(rayBox([0, 1, 0], [0, 0, -1], min, max, 100)!, 4);
  assert.equal(rayBox([0, 1, 0], [0, 0, 1], min, max, 100), null, 'pointing away');
  assert.equal(rayBox([5, 1, 0], [0, 0, -1], min, max, 100), null, 'parallel and outside');
  assert.equal(rayBox([0, 1, 0], [0, 0, -1], min, max, 3), null, 'out of range');
  assert.equal(rayBox([0, 1, -5], [0, 0, -1], min, max, 100), 0, 'starts inside');
  near(rayBox([0, 5, 0], [0, -0.7071067811865476, -0.7071067811865476], min, max, 100)!, 5.657, 0.01);
});

test('walls stop a shot: a player behind a wall cannot be hit, one in front can', () => {
  const wall = [box([-5, 0, -10.5], [5, 5, -10], 'wall')];
  const eye: [number, number, number] = [0, 1.62, 0];
  const dir = aimDirection(0, 0);
  const front: Target = { id: 1, x: 0, y: 0, z: -6, sliding: false };
  const behind: Target = { id: 2, x: 0, y: 0, z: -14, sliding: false };
  assert.equal(traceShot(eye, dir, wall, [front]).victim, 1);
  assert.equal(traceShot(eye, dir, wall, [behind]).victim, 0);
  near(traceShot(eye, dir, wall, [behind]).distance, 10);
  near(traceWorld(eye, dir, [], COMBAT.maxRange), COMBAT.maxRange);
});

test('the nearest player is hit, a head shot is the top of the body, and a sliding player is shorter', () => {
  const eye: [number, number, number] = [0, 1.62, 0];
  const dir = aimDirection(0, 0);
  const a: Target = { id: 1, x: 0, y: 0, z: -5, sliding: false };
  const b: Target = { id: 2, x: 0, y: 0, z: -9, sliding: false };
  assert.equal(traceShot(eye, dir, [], [b, a]).victim, 1, 'order in the list does not matter');
});

test('head shots: aiming above 1.5 m on a standing player is a head shot, below it is body', () => {
  const t: Target = { id: 1, x: 0, y: 0, z: -10, sliding: false };
  assert.equal(traceShot([0, 1.7, 0], [0, 0, -1], [], [t]).headshot, true);
  assert.equal(traceShot([0, 1.0, 0], [0, 0, -1], [], [t]).headshot, false);
  assert.equal(traceShot([0, 1.7, 0], [0, 0, -1], [], [{ ...t, sliding: true }]).victim, 0, 'a sliding player is only 1 m tall');
  assert.equal(traceShot([0, 0.9, 0], [0, 0, -1], [], [{ ...t, sliding: true }]).headshot, true);
});

test('a shot at a player to the side (any yaw) lands where the maths says', () => {
  for (const yaw of [0, 1, 2.5, -1.3, 4]) {
    const d = aimDirection(yaw, 0);
    const t: Target = { id: 1, x: d[0] * 12, y: 0, z: d[2] * 12, sliding: false };
    const r = traceShot([0, 1.0, 0], d, [], [t]);
    assert.equal(r.victim, 1, `yaw ${yaw}`);
    assert.ok(r.distance > 11 && r.distance < 12.01);
  }
});

test('FireControl fires once per interval while the trigger is held, never while dead, and restarts on release', () => {
  const f = new FireControl();
  const fired: number[] = [];
  for (let i = 0; i < 40; i++) if (f.tick(true, true)) fired.push(i);
  assert.deepStrictEqual(fired, [0, COMBAT.fireIntervalTicks, COMBAT.fireIntervalTicks * 2, COMBAT.fireIntervalTicks * 3]);
  const g = new FireControl();
  for (let i = 0; i < 30; i++) assert.equal(g.tick(true, false), false);
  assert.equal(g.tick(true, true), true, 'dead time does not build up a delay');
  const h = new FireControl();
  assert.equal(h.tick(true, true), true);
  assert.equal(h.tick(false, true), false);
  assert.equal(h.tick(true, true), false, 'tapping faster than the fire rate does not help');
});
