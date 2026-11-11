import test from 'node:test';
import assert from 'node:assert/strict';
import { COMBAT, LOBBY, TICK_RATE } from '@hitscan/shared';
import type { Hub } from '../src/hub.ts';
import { Player, newHub, run } from './hubkit.ts';

function twoPlayers(scoreLimit: number, timeLimit: number) {
  const hub = newHub();
  const a = new Player(hub, 'Ace');
  a.say({ t: 'create', name: '', scoreLimit, timeLimit });
  const b = new Player(hub, 'Bee', '2.2.2.2');
  b.say({ t: 'join', id: a.link.last('joined')!.match.id });
  return { hub, a, b };
}

test('a round ends at the time limit with a scoreboard, then a new round starts with scores reset', () => {
  const { hub, a, b } = twoPlayers(25, 180);
  run(hub, [a, b], 180 * TICK_RATE - 5);
  assert.equal(a.link.last('ended'), undefined, 'not over yet');
  run(hub, [a, b], 10);
  const ended = a.link.last('ended')!;
  assert.deepStrictEqual(ended.rows.map((r) => r.name).sort(), ['Ace', 'Bee']);
  assert.equal(ended.nextIn, LOBBY.endScreenSeconds);
  assert.equal(ended.winner, 0, 'nobody scored, so nobody won');
  assert.equal(a.link.last('clock')!.phase, 'ended');
  run(hub, [a, b], LOBBY.endScreenSeconds * TICK_RATE);
  assert.equal(a.link.last('clock')!.phase, 'playing');
  assert.ok(a.link.last('clock')!.left > 170);
});

/** Ace kills Bee with the rifle from 10 m, over and over, until `done()` or `maxTicks`. */
function hunt(hub: Hub, a: Player, b: Player, done: () => boolean, maxTicks: number): void {
  const pitch = Math.atan2(0.9 - 1.62, 10);
  for (let i = 0; i < maxTicks && !done(); i++) {
    a.input({ weapon: 3, fire: true, pitch });
    b.input();
    hub.update();
  }
}

test('first to the score limit wins; the winner is named; nobody can shoot between rounds; then it restarts', () => {
  const { hub, a, b } = twoPlayers(5, 600);
  run(hub, [a, b], COMBAT.spawnShieldTicks + 5);
  hunt(hub, a, b, () => a.link.last('ended') !== undefined, 6000);
  const ended = a.link.last('ended');
  assert.ok(ended, 'the round ended');
  assert.equal(ended.rows[0].name, 'Ace');
  assert.equal(ended.rows[0].kills, 5);
  assert.equal(ended.winner, ended.rows[0].id);
  assert.ok(b.link.last('ended'), 'everyone is told');

  // Between rounds shooting does nothing.
  run(hub, [a, b], 4); // let the newest snapshots arrive
  const deathsBefore = b.link.snapshots.at(-1)!.deaths;
  const damageBefore = a.link.events.filter((e) => e.damage > 0).length;
  const pitch = Math.atan2(0.9 - 1.62, 10);
  run(hub, [a, b], 5 * TICK_RATE, (p) => (p === a ? { weapon: 3, fire: true, pitch } : {}));
  assert.equal(a.link.events.filter((e) => e.damage > 0).length, damageBefore, 'no damage on the end screen');
  assert.equal(b.link.snapshots.at(-1)!.deaths, deathsBefore);

  run(hub, [a, b], LOBBY.endScreenSeconds * TICK_RATE);
  run(hub, [a, b], 10);
  const snap = a.link.snapshots.at(-1)!;
  assert.deepStrictEqual([snap.kills, snap.deaths], [0, 0], 'the new round starts from zero');
  assert.equal(snap.alive, true);
  assert.equal(snap.health, COMBAT.maxHealth);
});

test('a player who joins during the end screen plays the next round; leaving during it is fine', () => {
  const { hub, a, b } = twoPlayers(25, 180);
  run(hub, [a, b], 180 * TICK_RATE + 5);
  assert.equal(a.link.last('clock')!.phase, 'ended');
  const c = new Player(hub, 'Cee', '3.3.3.3');
  c.say({ t: 'join', id: a.link.last('joined')!.match.id });
  assert.equal(c.link.last('clock')!.phase, 'ended');
  b.say({ t: 'leave' });
  run(hub, [a, c], LOBBY.endScreenSeconds * TICK_RATE + 10);
  assert.equal(c.link.last('clock')!.phase, 'playing');
  assert.equal(hub.playerCount, 2);
});
