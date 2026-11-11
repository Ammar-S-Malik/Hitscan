import test from 'node:test';
import assert from 'node:assert/strict';
import { LOBBY, TICK_RATE } from '@hitscan/shared';
import { Link, Player, newHub, run } from './hubkit.ts';

test('hello: the name is cleaned and acknowledged, and the match list comes back', () => {
  const hub = newHub();
  const a = new Player(hub, '  <b>Ammar</b>  ');
  assert.equal(a.link.last('hello')!.name, 'bAmmarb');
  assert.deepStrictEqual(a.link.last('matches')!.list, []);
  const b = new Player(hub, '!!!');
  assert.equal(b.link.last('hello')!.name, `Player ${b.id}`);
});

test('nothing works before hello', () => {
  const hub = newHub();
  const link = new Link();
  const id = hub.connect(link, 'x')!;
  hub.onText(id, '{"t":"quick"}');
  assert.equal(link.last('error')!.message, 'Pick a nickname first.');
  assert.equal(hub.matchCount, 0);
});

test('create makes a match and puts you in it: joined, then the binary welcome, roster, clock, then snapshots', () => {
  const hub = newHub();
  const a = new Player(hub, 'Ann');
  a.say({ t: 'create', name: 'Fun room', scoreLimit: 10, timeLimit: 180 });
  const joined = a.link.last('joined')!;
  assert.equal(joined.match.name, 'Fun room');
  assert.equal(joined.match.scoreLimit, 10);
  assert.equal(joined.match.timeLimit, 180);
  assert.ok(a.link.binary.some((m) => m.kind === 'welcome'), 'the game welcome follows');
  assert.deepStrictEqual(a.link.last('roster')!.players.map((p) => p.name), ['Ann']);
  assert.equal(a.link.last('clock')!.phase, 'playing');
  run(hub, [a], 10);
  assert.ok(a.link.snapshots.length > 0, 'snapshots arrive');
  assert.equal(hub.matchCount, 1);
  assert.equal(hub.playerCount, 1);
  const b = new Player(hub, 'Bo', '2.2.2.2');
  b.say({ t: 'create', name: '', scoreLimit: 15, timeLimit: 300 });
  assert.equal(b.link.last('joined')!.match.name, "Bo's match");
});

test('quick play joins the fullest open match, and makes a new one when all are full', () => {
  const hub = newHub({ maxPlayers: 2 });
  const [a, b, c] = ['A', 'B', 'C'].map((n, i) => new Player(hub, n, `10.0.0.${i}`));
  a.say({ t: 'quick' });
  b.say({ t: 'quick' });
  assert.equal(a.link.last('joined')!.match.id, b.link.last('joined')!.match.id);
  assert.deepStrictEqual(b.link.last('roster')!.players.map((p) => p.name).sort(), ['A', 'B']);
  c.say({ t: 'quick' });
  assert.notEqual(c.link.last('joined')!.match.id, a.link.last('joined')!.match.id, 'the first match was full');
  assert.equal(hub.matchCount, 2);
  const d = new Player(hub, 'D', '10.0.0.9');
  d.say({ t: 'join', id: a.link.last('joined')!.match.id });
  assert.equal(d.link.last('error')!.message, 'That match is full.');
  d.say({ t: 'join', id: 9999 });
  assert.equal(d.link.last('error')!.message, 'That match no longer exists.');
});

test('the list shows the open matches with their player counts', () => {
  const hub = newHub();
  const a = new Player(hub, 'A');
  a.say({ t: 'create', name: 'One', scoreLimit: 5, timeLimit: 180 });
  const b = new Player(hub, 'B', '2.2.2.2');
  b.say({ t: 'list' });
  const list = b.link.last('matches')!.list;
  assert.equal(list.length, 1);
  assert.deepStrictEqual([list[0].name, list[0].players, list[0].max, list[0].phase, list[0].scoreLimit], ['One', 1, 4, 'playing', 5]);
  assert.ok(list[0].left > 170 && list[0].left <= 180);
});

test('the server runs only so many matches at once', () => {
  const hub = newHub({ maxMatches: 2 });
  for (let i = 0; i < 2; i++) new Player(hub, `P${i}`, `3.3.3.${i}`).say({ t: 'create', name: '', scoreLimit: 15, timeLimit: 300 });
  const late = new Player(hub, 'Late', '9.9.9.9');
  late.say({ t: 'create', name: '', scoreLimit: 15, timeLimit: 300 });
  assert.match(late.link.last('error')!.message, /busy/);
  assert.equal(hub.matchCount, 2);
});

test('leaving returns you to the lobby, others carry on, and an empty match disappears', () => {
  const hub = newHub();
  const a = new Player(hub, 'A');
  const b = new Player(hub, 'B', '2.2.2.2');
  a.say({ t: 'create', name: 'Room', scoreLimit: 15, timeLimit: 300 });
  b.say({ t: 'join', id: a.link.last('joined')!.match.id });
  run(hub, [a, b], 30);
  b.say({ t: 'leave' });
  assert.equal(b.link.last('left')!.reason, 'You left the match.');
  assert.deepStrictEqual(a.link.last('roster')!.players.map((p) => p.name), ['A'], 'the roster updates');
  run(hub, [a], 30);
  assert.equal(hub.matchCount, 1);
  const seen = a.link.snapshots.length;
  run(hub, [a], 10);
  assert.ok(a.link.snapshots.length > seen, 'the match carries on');
  a.say({ t: 'leave' });
  assert.equal(hub.matchCount, 0, 'an empty match is removed');
  b.say({ t: 'quick' });
  assert.ok(b.link.last('joined'));
});

test('a player who disconnects mid-match is removed cleanly', () => {
  const hub = newHub();
  const a = new Player(hub, 'A');
  const b = new Player(hub, 'B', '2.2.2.2');
  a.say({ t: 'quick' });
  b.say({ t: 'quick' });
  run(hub, [a, b], 30);
  hub.disconnect(b.id);
  run(hub, [a], 60);
  assert.equal(hub.clientCount, 1);
  assert.equal(hub.playerCount, 1);
  assert.equal(a.link.snapshots.at(-1)!.others.length, 0);
  hub.disconnect(b.id); // twice is harmless
  hub.onText(b.id, '{"t":"quick"}'); // and a ghost sending things is ignored
  hub.onBinary(b.id, new Uint8Array(5));
});

test('a player who stops sending input is moved back to the lobby with a reason, and can rejoin', () => {
  const hub = newHub();
  const a = new Player(hub, 'A');
  const b = new Player(hub, 'B', '2.2.2.2');
  a.say({ t: 'quick' });
  b.say({ t: 'quick' });
  run(hub, [a, b], 20);
  run(hub, [a], 6 * TICK_RATE); // B goes quiet
  assert.match(b.link.last('left')!.reason, /removed/);
  assert.equal(b.link.closed, null, 'the connection itself stays open');
  assert.equal(hub.playerCount, 1);
  b.say({ t: 'quick' });
  assert.equal(hub.playerCount, 2);
});

test('a lobby connection that says nothing for a minute is dropped; one that keeps listing is not', () => {
  const hub = newHub();
  const quiet = new Player(hub, 'Quiet', '5.5.5.5');
  const chatty = new Player(hub, 'Chatty', '6.6.6.6');
  for (let s = 0; s < LOBBY.lobbyIdleSeconds + 5; s++) {
    if (s % 2 === 0) chatty.say({ t: 'list' });
    for (let i = 0; i < TICK_RATE; i++) hub.update();
  }
  assert.ok(quiet.link.closed !== null);
  assert.equal(chatty.link.closed, null);
  assert.equal(hub.clientCount, 1);
});

test('flooding: a client sending thousands of messages a second is cut off and the others are unaffected', () => {
  const hub = newHub();
  const good = new Player(hub, 'Good', '7.7.7.7');
  const evil = new Player(hub, 'Evil', '8.8.8.8');
  const evil2 = new Player(hub, 'Evil2', '8.8.8.9');
  good.say({ t: 'quick' });
  evil.say({ t: 'quick' });
  run(hub, [good, evil], 10);
  for (let i = 0; i < 2000; i++) evil.input();
  assert.ok(evil.link.closed !== null, 'game packet flood: disconnected');
  for (let i = 0; i < 2000; i++) evil2.say({ t: 'list' });
  assert.ok(evil2.link.closed !== null, 'lobby message flood: disconnected');
  assert.equal(good.link.closed, null);
  run(hub, [good], 30);
  assert.equal(hub.playerCount, 1);
  assert.ok(good.link.snapshots.length > 0);
});

test('a normal client never trips the limits, even after a stall makes it send a burst', () => {
  const hub = newHub();
  const a = new Player(hub, 'A');
  a.say({ t: 'quick' });
  run(hub, [a], 5 * TICK_RATE);
  for (let i = 0; i < 40; i++) a.input();
  assert.equal(a.link.closed, null);
});

test('malformed, oversized and unknown text messages are ignored', () => {
  const hub = newHub();
  const a = new Player(hub, 'A');
  for (const bad of ['', '{', 'null', '{"t":"explode"}', '{"t":"join","id":"x"}', 'x'.repeat(5000)]) hub.onText(a.id, bad);
  assert.equal(a.link.closed, null);
  assert.equal(hub.matchCount, 0);
  a.input();
  assert.equal(hub.playerCount, 0);
});

test('too many connections from one address are refused', () => {
  const hub = newHub({ maxPerIp: 3 });
  for (let i = 0; i < 3; i++) assert.ok(hub.connect(new Link(), 'same') !== null);
  const refused = new Link();
  assert.equal(hub.connect(refused, 'same'), null);
  assert.ok(refused.closed !== null);
  assert.ok(hub.connect(new Link(), 'other') !== null);
});
