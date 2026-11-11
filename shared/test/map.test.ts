import test from 'node:test';
import assert from 'node:assert/strict';
import { parseMap } from '../src/map.ts';
import { loadMap } from './helpers.ts';

test('the first map parses and has what a match needs', () => {
  const m = loadMap('arena1.json');
  assert.ok(m.boxes.length > 0);
  assert.ok(m.spawns.length >= m.maxPlayers, 'at least one spawn per player');
});

test('parseMap rejects malformed maps with a readable message', () => {
  const good = JSON.parse(JSON.stringify(loadMap('arena1.json')));
  assert.throws(() => parseMap(null), /map/);
  assert.throws(() => parseMap({ ...good, size: 'huge' }), /size/);
  assert.throws(() => parseMap({ ...good, boxes: [{ kind: 'wall', min: [0, 0, 0], max: [0, 1, 1] }] }), /max must be greater/);
  assert.throws(() => parseMap({ ...good, boxes: [{ kind: 'lava', min: [0, 0, 0], max: [1, 1, 1] }] }), /kind/);
  assert.throws(() => parseMap({ ...good, spawns: [] }), /spawns/);
});
