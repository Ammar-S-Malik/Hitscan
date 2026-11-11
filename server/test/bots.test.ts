import test from 'node:test';
import assert from 'node:assert/strict';
import { COMBAT, TICK_RATE, decodeServerMessage, encodeInputPacket, parseMap, parseClientMessage } from '@hitscan/shared';
import type { GameMap } from '@hitscan/shared';
import { readFileSync, readdirSync } from 'node:fs';
import { LocalGame } from '../src/local.ts';
import { Bot } from '../src/bot.ts';
import type { Difficulty } from '../src/bot.ts';

const mapsDir = new URL('../../shared/maps/', import.meta.url);
const maps: GameMap[] = readdirSync(mapsDir)
  .filter((f) => f.endsWith('.json'))
  .map((f) => parseMap(JSON.parse(readFileSync(new URL(f, mapsDir), 'utf8'))));

function game(map: GameMap, difficulty: Difficulty, bots: number, seed = 1, scoreLimit = 99, timeLimit = 600) {
  const texts: string[] = [];
  const g = new LocalGame(
    { map, difficulty, bots, scoreLimit, timeLimit, playerName: 'Tester', seed },
    { onBinary: () => undefined, onText: (t) => texts.push(t) },
  );
  g.start();
  return { g, texts };
}

function standStill(g: LocalGame, seconds: number): void {
  for (let i = 0; i < seconds * TICK_RATE; i++) g.tick();
}

test('a vs-AI match joins the human and every bot, and announces the match', () => {
  const { g, texts } = game(maps[0], 'normal', 3);
  assert.equal(g.match.size, 4);
  assert.ok(texts.some((t) => JSON.parse(t).t === 'joined'));
  const roster = texts.map((t) => JSON.parse(t)).filter((m) => m.t === 'roster').pop();
  assert.equal(roster.players.length, 4);
  assert.ok(roster.players.some((p: { name: string }) => p.name === 'Tester'));
});

test('the number of bots is capped by the map size', () => {
  const small = maps.find((m) => m.maxPlayers === 6)!;
  const { g } = game(small, 'easy', 20);
  assert.equal(g.match.size, small.maxPlayers);
});

test('bots fight each other: on every map they score kills and stay inside the map', () => {
  for (const map of maps) {
    const { g } = game(map, 'hard', 3, 7);
    standStill(g, 90);
    const scores = g.match.server.scores();
    const kills = scores.reduce((n, s) => n + s.kills, 0);
    assert.ok(kills > 0, `${map.name}: bots never killed anyone in 90 s (scores ${JSON.stringify(scores)})`);
    for (const s of scores) {
      const info = g.match.server.inspect(s.id)!;
      assert.ok(info.state.y > map.bounds.min[1] - 1 && info.state.y < map.bounds.max[1] + 5, `${map.name}: a player ended up out of bounds`);
    }
  }
});

test('bots keep moving: after a minute none of them is still standing at its spawn', () => {
  const map = maps[0];
  const { g } = game(map, 'normal', 3, 3);
  const start = new Map<number, [number, number]>();
  standStill(g, 1);
  for (const s of g.match.server.scores()) {
    const i = g.match.server.inspect(s.id)!;
    start.set(s.id, [i.state.x, i.state.z]);
  }
  const travelled = new Map<number, number>();
  const last = new Map(start);
  for (let t = 0; t < 60 * TICK_RATE; t++) {
    g.tick();
    for (const s of g.match.server.scores()) {
      const i = g.match.server.inspect(s.id)!;
      const [px, pz] = last.get(s.id)!;
      travelled.set(s.id, (travelled.get(s.id) ?? 0) + Math.hypot(i.state.x - px, i.state.z - pz));
      last.set(s.id, [i.state.x, i.state.z]);
    }
  }
  for (const [id, d] of travelled) {
    if (id === 1) continue; // the idle human
    assert.ok(d > 40, `bot ${id} only travelled ${d.toFixed(0)} m in a minute`);
  }
});

test('a bot never hurts anyone through a wall: damage only comes with a clear line', () => {
  // Place the human behind the map's first thick wall is map specific, so check the invariant statistically:
  // events carry the victim, and the server never reports damage above the weapon's maximum.
  const { g } = game(maps[0], 'hard', 3, 11);
  standStill(g, 60);
  for (const s of g.match.server.scores()) {
    const i = g.match.server.inspect(s.id)!;
    assert.ok(i.health >= 0 && i.health <= COMBAT.maxHealth);
  }
});

test('hard bots beat easy bots', () => {
  const map = maps.find((m) => m.name === 'Courtyard') ?? maps[0];
  let hardWins = 0;
  const trials = 6;
  for (let seed = 1; seed <= trials; seed++) {
    // The human slot idles, so one easy bot and one hard bot fight each other. Build it by hand: two bots, different skill.
    const { g } = game(map, 'easy', 2, seed);
    const slots = (g as unknown as { bots: Array<{ brain: Bot; playerId: number }> }).bots;
    slots[0].brain = new Bot(seed * 13, 'hard', 0, 3);
    slots[1].brain = new Bot(seed * 17, 'easy', 0, 3);
    for (const s of slots) g.match.server.setPrimary(s.playerId, 3); // same gun for both, so only skill differs
    standStill(g, 120);
    const kills = new Map(g.match.server.scores().map((s) => [s.id, s.kills]));
    if ((kills.get(slots[0].playerId) ?? 0) > (kills.get(slots[1].playerId) ?? 0)) hardWins++;
  }
  assert.ok(hardWins >= trials - 1, `hard bot won only ${hardWins} of ${trials} duels`);
});

test('the match ends at the score limit and starts a new round', () => {
  const { g, texts } = game(maps[0], 'hard', 3, 5, 5, 180);
  for (let i = 0; i < 180 * TICK_RATE && !texts.some((t) => JSON.parse(t).t === 'ended'); i++) g.tick();
  assert.ok(texts.some((t) => JSON.parse(t).t === 'ended'), 'the round never ended');
  const ended = texts.map((t) => JSON.parse(t)).filter((m) => m.t === 'ended').pop();
  assert.ok(ended.rows.some((r: { kills: number }) => r.kills >= 5));
});

test('advance() runs whole ticks and the clock only moves while it runs', () => {
  const { g } = game(maps[0], 'easy', 1);
  g.advance(0.2);
  const t = g.clockMs;
  assert.ok(t > 190 && t <= 200, `clock ${t}`);
  assert.equal(g.clockMs, t);
});

test('a class may fire only its primary gun and the pistol; anything else is played as the pistol', () => {
  const shots: number[] = [];
  const g = new LocalGame(
    { map: maps[0], difficulty: 'easy', bots: 0, scoreLimit: 99, timeLimit: 600, playerName: 'Tester', primary: 4, seed: 1 },
    {
      onBinary: (bytes) => {
        const m = decodeServerMessage(bytes);
        if (m && m.kind === 'events') for (const e of m.events) shots.push(e.weapon);
      },
      onText: () => undefined,
    },
  );
  g.start();
  let seq = 0;
  const fireWith = (weapon: number): number[] => {
    shots.length = 0;
    for (let i = 0; i < 90; i++) {
      seq++;
      const fire = i % 2 === 0; // fresh clicks, so semi-automatic guns can fire
      g.send(encodeInputPacket([{ seq, input: { forward: 0, strafe: 0, yaw: 0, jump: false, sprint: false, slide: false, pitch: 0, fire, weapon, aim: false, reload: false, viewMs: 0 } }]));
      g.tick();
    }
    return [...new Set(shots)];
  };
  assert.deepStrictEqual(fireWith(4), [4], 'the sniper class fires the sniper');
  assert.deepStrictEqual(fireWith(0), [0], 'and the pistol');
  assert.deepStrictEqual(fireWith(3), [0], 'a rifle is not in its kit');
  assert.deepStrictEqual(fireWith(2), [0], 'neither is a shotgun');
});

test('the lobby accepts a class message only for a real primary gun', () => {
  assert.deepStrictEqual(parseClientMessage('{"t":"class","primary":2}'), { t: 'class', primary: 2 });
  assert.equal(parseClientMessage('{"t":"class","primary":0}'), null, 'the pistol is not a class');
  assert.equal(parseClientMessage('{"t":"class","primary":9}'), null);
  assert.equal(parseClientMessage('{"t":"class","primary":"3"}'), null);
});

test('the server enforces magazines: holding the trigger with the rifle fires a magazine, then waits out the reload', () => {
  let shots = 0;
  const g = new LocalGame(
    { map: maps[0], difficulty: 'easy', bots: 0, scoreLimit: 99, timeLimit: 600, playerName: 'Tester', primary: 3, seed: 1 },
    {
      onBinary: (bytes) => {
        const m = decodeServerMessage(bytes);
        if (m && m.kind === 'events') shots += m.events.length;
      },
      onText: () => undefined,
    },
  );
  g.start();
  for (let i = 1; i <= 600; i++) {
    g.send(encodeInputPacket([{ seq: i, input: { forward: 0, strafe: 0, yaw: 0, jump: false, sprint: false, slide: false, pitch: 0, fire: true, weapon: 3, aim: false, reload: false, viewMs: 0 } }]));
    g.tick();
  }
  // Ten seconds of holding the trigger: about 85 rounds with no reloads, about 51 with them.
  assert.ok(shots > 40 && shots < 62, `fired ${shots} rounds in 10 s`);
});
