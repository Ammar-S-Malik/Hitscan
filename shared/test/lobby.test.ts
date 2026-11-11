import test from 'node:test';
import assert from 'node:assert/strict';
import { LOBBY, parseClientMessage, parseServerMessage, sanitizeName } from '../src/lobby.ts';

test('sanitizeName keeps ordinary names, strips markup and control characters, limits the length', () => {
  assert.equal(sanitizeName('Ammar', 'x'), 'Ammar');
  assert.equal(sanitizeName('  Cool   Player_1  ', 'x'), 'Cool Player_1');
  assert.equal(sanitizeName('<script>alert(1)</script>', 'x'), 'scriptalert1scri', 'markup characters are gone, then cut to 16');
  assert.equal(sanitizeName('a\u0000b‮c\nd', 'x'), 'abcd');
  assert.equal(sanitizeName('Z' + String.fromCharCode(0x361, 0x489) + 'al' + String.fromCharCode(0x334) + 'go', 'x'), 'Zalgo', 'combining marks are removed');
  assert.equal(sanitizeName('x'.repeat(100), 'y').length, LOBBY.nameMax);
  assert.equal(sanitizeName('Renée Ñandú 山田', 'x'), 'Renée Ñandú 山田', 'letters from other languages are fine');
  assert.equal(sanitizeName('', 'Player 4'), 'Player 4');
  assert.equal(sanitizeName('!!!???', 'Player 4'), 'Player 4');
  assert.equal(sanitizeName(42, 'Player 4'), 'Player 4');
  assert.equal(sanitizeName(null, 'Player 4'), 'Player 4');
  assert.equal(sanitizeName('a'.repeat(15) + ' ' + 'b', 'x'), 'a'.repeat(15), 'trimmed again after cutting');
});

test('parseClientMessage accepts the lobby messages and clamps settings to the allowed choices', () => {
  assert.deepStrictEqual(parseClientMessage('{"t":"hello","name":"  Bob "}'), { t: 'hello', name: 'Bob' });
  assert.deepStrictEqual(parseClientMessage('{"t":"list"}'), { t: 'list' });
  assert.deepStrictEqual(parseClientMessage('{"t":"quick"}'), { t: 'quick' });
  assert.deepStrictEqual(parseClientMessage('{"t":"leave"}'), { t: 'leave' });
  assert.deepStrictEqual(parseClientMessage('{"t":"join","id":3}'), { t: 'join', id: 3 });
  assert.deepStrictEqual(
    parseClientMessage('{"t":"create","name":"Fun","scoreLimit":10,"timeLimit":600}'),
    { t: 'create', name: 'Fun', scoreLimit: 10, timeLimit: 600 },
  );
  assert.deepStrictEqual(
    parseClientMessage('{"t":"create","name":"x","scoreLimit":99999,"timeLimit":-5}'),
    { t: 'create', name: 'x', scoreLimit: LOBBY.defaultScoreLimit, timeLimit: LOBBY.defaultTimeLimit },
    'a made-up score or time limit falls back to the default',
  );
});

test('parseClientMessage rejects garbage without throwing', () => {
  for (const bad of ['', 'nope', '{', '[]', 'null', '42', '{"t":5}', '{"t":"fly"}', '{"t":"join"}', '{"t":"join","id":-1}', '{"t":"join","id":1.5}', '{"t":"join","id":"3"}']) {
    assert.equal(parseClientMessage(bad), null, JSON.stringify(bad));
  }
  assert.equal(parseClientMessage('{"t":"hello","name":"' + 'x'.repeat(LOBBY.maxTextBytes) + '"}'), null, 'too long');
});

test('parseClientMessage survives random junk (fuzz)', () => {
  let s = 1;
  const rand = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const pieces = ['{', '}', '"t"', ':', '"join"', '"hello"', ',', '"id"', '1', '"name"', '[', ']', 'null', '-', '"create"'];
  for (let i = 0; i < 20000; i++) {
    let text = '';
    for (let k = Math.floor(rand() * 12); k > 0; k--) text += pieces[Math.floor(rand() * pieces.length)];
    assert.doesNotThrow(() => parseClientMessage(text));
  }
});

test('parseServerMessage reads known messages and drops malformed ones', () => {
  const info = { id: 2, name: 'Test', map: 'Arena', players: 3, max: 8, phase: 'playing', scoreLimit: 15, timeLimit: 300, left: 120 };
  const m = parseServerMessage(JSON.stringify({ t: 'matches', list: [info, 5, null] }));
  assert.ok(m && m.t === 'matches');
  assert.deepStrictEqual(m.list, [info]);
  assert.deepStrictEqual(parseServerMessage('{"t":"left","reason":"bye"}'), { t: 'left', reason: 'bye' });
  assert.deepStrictEqual(parseServerMessage('{"t":"roster","players":[{"id":1,"name":"A"},3]}'), { t: 'roster', players: [{ id: 1, name: 'A' }] });
  assert.deepStrictEqual(parseServerMessage('{"t":"clock","phase":"ended","left":4,"scoreLimit":10}'), { t: 'clock', phase: 'ended', left: 4, scoreLimit: 10 });
  const ended = parseServerMessage('{"t":"ended","winner":2,"nextIn":12,"rows":[{"id":2,"name":"B","kills":5,"deaths":1}]}');
  assert.ok(ended && ended.t === 'ended' && ended.rows[0].kills === 5);
  for (const bad of ['', '{', '{"t":"matches"}', '{"t":"ended"}', '{"t":"joined"}', '{"t":"nope"}', '7']) assert.equal(parseServerMessage(bad), null, bad);
});
