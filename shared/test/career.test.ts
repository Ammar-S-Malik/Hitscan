import test from 'node:test';
import assert from 'node:assert/strict';
import { careerXp, mergeCareer, rankOf, toCareer } from '../../client/src/career.ts';

test('cloud stats are cleaned before use', () => {
  assert.deepEqual(toCareer({ kills: 5.7, deaths: -2, wins: 'lots', headshots: 3, extra: 1 }), { kills: 5, deaths: 0, headshots: 3, wins: 0, rounds: 0 });
  assert.deepEqual(toCareer(null), { kills: 0, deaths: 0, headshots: 0, wins: 0, rounds: 0 });
});

test('merging two copies of an account keeps the larger of each total, so nothing is lost or counted twice', () => {
  const cloud = { kills: 10, deaths: 4, headshots: 2, wins: 1, rounds: 3 };
  const here = { kills: 12, deaths: 4, headshots: 1, wins: 1, rounds: 4 };
  assert.deepEqual(mergeCareer(cloud, here), { kills: 12, deaths: 4, headshots: 2, wins: 1, rounds: 4 });
  assert.deepEqual(mergeCareer(here, here), here);
});

test('ranks start at 1 and each takes 1000 more experience than the last', () => {
  assert.deepEqual(rankOf(0), { rank: 1, into: 0, span: 1000 });
  assert.equal(rankOf(999).rank, 1);
  assert.equal(rankOf(1000).rank, 2);
  assert.equal(rankOf(2999).rank, 2);
  assert.equal(rankOf(3000).rank, 3);
  assert.equal(careerXp({ kills: 2, deaths: 0, headshots: 1, wins: 1, rounds: 1 }), 750);
});
