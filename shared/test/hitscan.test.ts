import test from 'node:test';
import assert from 'node:assert/strict';
import { COMBAT, WEAPONS } from '../src/config.ts';
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

test('FireControl: automatic guns repeat at their rate, semi-automatic ones need a new click', () => {
  const rifle = 3;
  const pistol = 0;
  const f = new FireControl();
  f.tick(false, true, rifle); // take the rifle out
  for (let i = 0; i < WEAPONS[rifle].switchTicks; i++) f.tick(false, true, rifle);
  const fired: number[] = [];
  for (let i = 0; i < 30; i++) if (f.tick(true, true, rifle)) fired.push(i);
  const r = WEAPONS[rifle].intervalTicks;
  assert.deepStrictEqual(fired, [0, r, r * 2, r * 3, r * 4]);

  const g = new FireControl();
  for (let i = 0; i < 40; i++) g.tick(false, true, pistol);
  let shots = 0;
  for (let i = 0; i < 100; i++) if (g.tick(true, true, pistol)) shots++;
  assert.equal(shots, 1, 'holding a pistol fires once');
  for (let i = 0; i < 20; i++) g.tick(false, true, pistol);
  assert.equal(g.tick(true, true, pistol), true, 'a new click fires again once the gun is ready');
});

test('FireControl: dead players do not fire, tapping faster than the fire rate does not help, bad weapon numbers mean the pistol', () => {
  const g = new FireControl();
  for (let i = 0; i < 30; i++) assert.equal(g.tick(true, false, 0), false);
  g.tick(false, true, 0);
  assert.equal(g.tick(true, true, 0), true);
  assert.equal(g.tick(false, true, 0), false);
  assert.equal(g.tick(true, true, 0), false, 'still cooling down');
  const h = new FireControl();
  for (let i = 0; i < 40; i++) h.tick(false, true, 99);
  assert.equal(h.weapon, 0);
  assert.equal(h.tick(true, true, 99), true);
});

test('taking a gun out has a delay, and swapping cannot skip the wait after a shot', () => {
  /** Ticks until a gun fires when clicking on every other tick, starting with `f` in its current state. */
  const ticksToFire = (f: FireControl, weapon: number): number => {
    for (let t = 0; t < 400; t++) if (f.tick(t % 2 === 1, true, weapon)) return t;
    return -1;
  };
  const f = new FireControl();
  for (let i = 0; i < 40; i++) f.tick(false, true, 0);
  const first = ticksToFire(f, 4); // sniper just taken out
  assert.ok(first >= WEAPONS[4].switchTicks - 1, `sniper fired after ${first} ticks`);

  const g = new FireControl();
  for (let i = 0; i < 100; i++) g.tick(false, true, 4);
  assert.equal(g.tick(true, true, 4), true); // a sniper shot, then a 78 tick recovery
  const wait = ticksToFire(g, 0); // swap to the pistol straight away
  assert.ok(wait >= WEAPONS[4].intervalTicks - 6, `the pistol had to wait ${wait} ticks for the sniper's recovery`);
});
