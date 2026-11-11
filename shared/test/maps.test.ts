import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import test from 'node:test';
import { validateMap, validateMapSet } from '../src/mapcheck.ts';
import type { GameMap } from '../src/map.ts';
import { createPlayer, step } from '../src/movement.ts';
import { box, input, loadMap } from './helpers.ts';

const files = readdirSync(new URL('../maps/', import.meta.url)).filter((f) => f.endsWith('.json'));
const maps = files.map((f) => loadMap(f));

test('there are five maps: two medium and three small', () => {
  assert.equal(maps.length, 5);
  assert.equal(maps.filter((m) => m.size === 'medium').length, 2);
  assert.equal(maps.filter((m) => m.size === 'small').length, 3);
  assert.deepStrictEqual(validateMapSet(maps), []);
});

for (const [i, m] of maps.entries()) {
  test(`map "${m.name}" (${files[i]}) passes the validator with no errors or warnings`, () => {
    const r = validateMap(m);
    assert.deepStrictEqual(r.errors, []);
    assert.deepStrictEqual(r.warnings, [], 'spawns that can see each other make for cheap kills');
  });
}

/** A flat 20 x 20 map to break one thing at a time. */
function base(): GameMap {
  return {
    name: 'T', size: 'small', maxPlayers: 4,
    bounds: { min: [-10, -1, -10], max: [10, 10, 10] },
    boxes: [box([-10, -1, -10], [10, 0, 10], 'floor')],
    spawns: [{ x: -6, y: 0, z: -6, yaw: 0 }, { x: 6, y: 0, z: -6, yaw: 0 }, { x: -6, y: 0, z: 6, yaw: 0 }, { x: 6, y: 0, z: 6, yaw: 0 }],
  };
}

test('the validator accepts a plain flat map', () => {
  assert.deepStrictEqual(validateMap(base()).errors, []);
});

test('the validator rejects a spawn inside a wall, a spawn in the air, and spawns too close together', () => {
  const inWall = base();
  inWall.boxes.push(box([5, 0, -7], [7, 3, -5]));
  assert.ok(validateMap(inWall).errors.some((e) => e.includes('spawn 1') && e.includes('no room')));

  const air = base();
  air.spawns[0].y = 2;
  assert.ok(validateMap(air).errors.some((e) => e.includes('spawn 0') && e.includes('not standing')));

  const close = base();
  close.spawns[1] = { x: -5, y: 0, z: -6, yaw: 0 };
  assert.ok(validateMap(close).errors.some((e) => e.includes('only')));
});

test('the validator rejects too few spawns, boxes outside the bounds, and a map that is too big for its size', () => {
  const few = base();
  few.spawns.pop();
  assert.ok(validateMap(few).errors.some((e) => e.includes('at least 4 spawns')));

  const out = base();
  out.boxes.push(box([9, 0, 0], [12, 2, 1]));
  assert.ok(validateMap(out).errors.some((e) => e.includes('sticks out')));

  const big = base();
  big.bounds = { min: [-30, -1, -10], max: [30, 10, 10] };
  big.boxes = [box([-30, -1, -10], [30, 0, 10], 'floor')];
  assert.ok(validateMap(big).errors.some((e) => e.includes('may span at most')));
});

test('the validator finds a hole in the floor, a platform nobody can climb onto, and a walled-off spawn', () => {
  const hole = base();
  hole.boxes = [box([-10, -1, -10], [10, 0, -1], 'floor'), box([-10, -1, 1], [10, 0, 10], 'floor')];
  assert.ok(validateMap(hole).errors.some((e) => e.includes('hole')));

  const high = base();
  high.boxes.push(box([-2, 0, -2], [2, 3, 2], 'platform'));
  assert.ok(validateMap(high).errors.some((e) => e.includes('platform') && e.includes('cannot be reached')));

  const walled = base();
  walled.boxes.push(box([-1, 0, -10], [0, 5, 10]));
  const errors = validateMap(walled).errors;
  assert.ok(errors.some((e) => e.includes('cannot be reached')), errors.join('\n'));
});

test('the validator finds a trap: a pit too deep to jump out of', () => {
  const m = base();
  m.bounds.min[1] = -6;
  m.boxes = [
    box([-10, -6, -10], [10, 0, -2], 'floor'), box([-10, -6, 2], [10, 0, 10], 'floor'),
    box([-10, -6, -2], [-2, 0, 2], 'floor'), box([2, -6, -2], [10, 0, 2], 'floor'),
    box([-2, -6, -2], [2, -3, 2], 'floor'), // a 3 m deep pit with no stairs
  ];
  assert.ok(validateMap(m).errors.some((e) => e.includes('no way back')));
});

/** Walks with the real movement code: forward for `seconds`, returning the highest and lowest feet height seen. */
function walk(map: GameMap, x: number, y: number, z: number, yaw: number, seconds: number) {
  let s = createPlayer(x, y, z);
  let high = s.y;
  let low = s.y;
  for (let i = 0; i < seconds * 60; i++) {
    s = step(s, input({ forward: 1, yaw }), map.boxes);
    high = Math.max(high, s.y);
    low = Math.min(low, s.y);
  }
  return { s, high, low };
}

test('the stairs really can be walked up with the real movement code (Skybridge deck)', () => {
  const m = maps.find((x) => x.name === 'Skybridge') as GameMap;
  const { high } = walk(m, -19, 0, 15.5, 0, 6); // yaw 0 faces -z, up the left stairs
  assert.ok(high > 3.0, `reached ${high.toFixed(2)} m`);
});

test('the Warehouse mezzanine stairs can be walked up', () => {
  const m = maps.find((x) => x.name === 'Warehouse') as GameMap;
  const { high } = walk(m, 9, 0, 0, 0, 5);
  assert.ok(high > 2.2, `reached ${high.toFixed(2)} m`);
});

test('in The Pit you can walk down the stairs into the pit and back out again', () => {
  const m = maps.find((x) => x.name === 'The Pit') as GameMap;
  const down = walk(m, 0, 0, -8, Math.PI, 1.6); // yaw pi faces +z
  assert.ok(down.low < -1.0, `got down to ${down.low.toFixed(2)} m`);
  const out = walk(m, 0, -1.2, -3, 0, 2); // from the pit floor, facing -z, up the north stairs
  assert.ok(out.s.y > -0.1, `climbed back to ${out.s.y.toFixed(2)} m`);
});
