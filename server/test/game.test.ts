import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MSG, NET, TICK_RATE, decodeServerMessage, encodeInputPacket, quantizeInput,
} from '@hitscan/shared';
import type { GameMap, Input, ServerMessage } from '@hitscan/shared';
import { createRng } from '@hitscan/shared';
import { GameServer } from '../src/game.ts';
import type { Connection } from '../src/game.ts';
import { IDLE, input, loadMap } from '../../shared/test/helpers.ts';

const arena = loadMap('arena1.json');

class FakeConn implements Connection {
  received: ServerMessage[] = [];
  closed = false;
  send(data: Uint8Array): void {
    const m = decodeServerMessage(data);
    if (m) this.received.push(m);
  }
  close(): void {
    this.closed = true;
  }
  get snapshots() {
    return this.received.flatMap((m) => (m.kind === 'snapshot' ? [m.snapshot] : []));
  }
}

function packet(seqs: number[], patch: Partial<Input> = {}): Uint8Array {
  return encodeInputPacket(seqs.map((seq) => ({ seq, input: quantizeInput({ ...IDLE, ...patch }) })));
}

function join(server: GameServer): { id: number; conn: FakeConn } {
  const conn = new FakeConn();
  const id = server.connect(conn);
  assert.ok(id !== null);
  return { id, conn };
}

test('a joining player gets a welcome with the right settings', () => {
  const server = new GameServer({ map: arena });
  const { id, conn } = join(server);
  const m = conn.received[0];
  assert.ok(m.kind === 'welcome');
  assert.equal(m.welcome.playerId, id);
  assert.equal(m.welcome.tickRate, TICK_RATE);
  assert.equal(m.welcome.snapshotEvery, NET.snapshotEvery);
  assert.equal(m.welcome.mapName, arena.name);
});

test('the server is full at maxPlayers and the extra connection is turned away', () => {
  const server = new GameServer({ map: arena, maxPlayers: 3 });
  for (let i = 0; i < 3; i++) join(server);
  const extra = new FakeConn();
  assert.equal(server.connect(extra), null);
  assert.ok(extra.closed);
  assert.deepStrictEqual(extra.received, [{ kind: 'reject', reason: 1 }]);
  assert.equal(server.playerCount, 3);
});

test('players start at the spawn farthest from everyone else', () => {
  const server = new GameServer({ map: arena });
  const a = join(server);
  const first = server.inspect(a.id)!.state;
  const b = join(server);
  const second = server.inspect(b.id)!.state;
  const nearest = (x: number, z: number) => Math.hypot(x - first.x, z - first.z);
  const best = Math.max(...arena.spawns.map((s) => nearest(s.x, s.z)));
  assert.ok(Math.abs(nearest(second.x, second.z) - best) < 1e-9);
});

test('the server never moves a player who sends nothing, and applies inputs exactly once, in order', () => {
  const server = new GameServer({ map: arena });
  const { id } = join(server);
  const start = server.inspect(id)!.state;
  for (let i = 0; i < 100; i++) server.update();
  assert.deepStrictEqual(server.inspect(id)!.state, start, 'no inputs, no movement');

  server.onMessage(id, packet([1, 2, 3], { forward: 1 }));
  server.onMessage(id, packet([2, 3, 4], { forward: 1 })); // overlapping redundancy: 2 and 3 are repeats
  for (let i = 0; i < 10; i++) server.update(); // inputs are applied one per tick, behind a small buffer
  const info = server.inspect(id)!;
  assert.equal(info.processed, 4, 'seq 1..4 applied once each');
  assert.equal(info.lastSeq, 4);
});

test('late and reordered packets are harmless', () => {
  const server = new GameServer({ map: arena });
  const { id } = join(server);
  server.onMessage(id, packet([5, 6, 7, 8]));
  server.onMessage(id, packet([1, 2, 3, 4])); // an old packet arriving late
  for (let i = 0; i < 10; i++) server.update();
  assert.equal(server.inspect(id)!.lastSeq, 8);
  assert.equal(server.inspect(id)!.processed, 4);
});

test('SPEED HACK: sending inputs faster than real time does not make the player faster', () => {
  const server = new GameServer({ map: arena });
  const { id } = join(server);
  let seq = 0;
  const ticks = 600; // ten seconds
  for (let t = 0; t < ticks; t++) {
    for (let k = 0; k < 3; k++) {
      // three inputs per tick: three times the legal rate
      server.onMessage(id, packet([++seq], { forward: 1, sprint: true }));
    }
    server.update();
  }
  const info = server.inspect(id)!;
  assert.ok(info.processed <= ticks + NET.budgetCap, `applied ${info.processed} inputs in ${ticks} ticks`);
  assert.ok(info.dropped > 0, 'the excess should be thrown away, not saved up');
  assert.ok(info.queued <= NET.maxQueue);
});

test('an honest player after a stall catches up, but only by the budget', () => {
  const server = new GameServer({ map: arena });
  const { id } = join(server);
  for (let i = 0; i < 100; i++) server.update(); // a long gap with no packets
  server.onMessage(id, packet([1, 2, 3, 4, 5, 6, 7, 8]));
  let before = 0;
  let biggestBurst = 0;
  for (let i = 0; i < 12; i++) {
    server.update();
    const now = server.inspect(id)!.processed;
    biggestBurst = Math.max(biggestBurst, now - before);
    before = now;
  }
  assert.equal(before, 8, 'everything is applied eventually');
  assert.ok(biggestBurst > 1, 'a backlog is drained faster than one per tick');
  assert.ok(biggestBurst <= NET.budgetCap, `but never more than the budget (${biggestBurst})`);
});

test('IMPOSSIBLE INPUTS: crafted extreme values are clamped to what a keyboard could do', () => {
  const server = new GameServer({ map: arena });
  const { id } = join(server);
  const buf = packet([1], { forward: 1, sprint: true });
  const v = new DataView(buf.buffer);
  v.setInt8(6, -128);
  v.setInt8(7, 127);
  v.setFloat32(8, Infinity, true);
  for (let n = 0; n < 200; n++) {
    const b = new Uint8Array(buf);
    new DataView(b.buffer).setUint32(2, n + 1, true);
    server.onMessage(id, b);
    server.update();
  }
  const s = server.inspect(id)!.state;
  for (const val of [s.x, s.y, s.z, s.vx, s.vy, s.vz]) assert.ok(Number.isFinite(val));
  assert.ok(Math.hypot(s.vx, s.vz) <= 13 + 1e-9, 'horizontal speed cap holds');
});

test('garbage from a client is ignored and cannot crash the server (fuzz)', () => {
  const server = new GameServer({ map: arena });
  const { id, conn } = join(server);
  const rand = createRng(31337);
  const types = [MSG.input, MSG.snapshot, MSG.welcome, 0, 255];
  for (let n = 0; n < 12000; n++) {
    const len = Math.floor(rand() * 300);
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) bytes[i] = Math.floor(rand() * 256);
    if (len > 0 && rand() < 0.8) bytes[0] = types[Math.floor(rand() * types.length)];
    server.onMessage(id, bytes);
    server.onMessage(9999, bytes); // and for a player who does not exist
    if (n % 50 === 0) server.update();
  }
  const s = server.inspect(id)!.state;
  for (const val of Object.values(s)) if (typeof val === 'number') assert.ok(Number.isFinite(val));
  assert.ok(conn.snapshots.length > 0);
});

test('garbage does not keep a connection alive: only valid inputs reset the idle timer', () => {
  const server = new GameServer({ map: arena });
  const { id, conn } = join(server);
  for (let t = 0; t < NET.idleTimeoutTicks + 10; t++) {
    server.onMessage(id, new Uint8Array([MSG.input, 3, 1, 2, 3])); // looks like an input packet but is not
    server.update();
  }
  assert.equal(server.inspect(id), null);
  assert.ok(conn.closed);
});

test('a player who goes silent for five seconds is dropped; one who keeps sending stays', () => {
  const server = new GameServer({ map: arena });
  const quiet = join(server);
  const active = join(server);
  for (let t = 0; t < NET.idleTimeoutTicks + 10; t++) {
    if (t % 30 === 0) server.onMessage(active.id, packet([t / 30 + 1]));
    server.update();
  }
  assert.equal(server.inspect(quiet.id), null);
  assert.ok(quiet.conn.closed);
  assert.ok(server.inspect(active.id));
});

test('snapshots go out every snapshotEvery ticks, list the others but not yourself, and carry your ack', () => {
  const server = new GameServer({ map: arena });
  const a = join(server);
  const b = join(server);
  server.onMessage(a.id, packet([1, 2], { forward: 1 }));
  for (let t = 0; t < 10; t++) server.update();
  assert.equal(a.conn.snapshots.length, 10 / NET.snapshotEvery);
  const last = a.conn.snapshots[a.conn.snapshots.length - 1];
  assert.equal(last.ack, 2);
  assert.deepStrictEqual(last.others.map((o) => o.id), [b.id]);
  assert.deepStrictEqual(b.conn.snapshots[0].others.map((o) => o.id), [a.id]);
  assert.equal(b.conn.snapshots[0].ack, 0);
});

test('a player who falls out of the world is put back at a spawn', () => {
  const hole: GameMap = { ...arena, boxes: [] }; // no floor at all
  const server = new GameServer({ map: hole });
  const { id } = join(server);
  server.onMessage(id, packet(Array.from({ length: 8 }, (_, i) => i + 1)));
  let fell = false;
  let respawned = false;
  let seq = 8;
  for (let t = 0; t < 600 && !respawned; t++) {
    server.onMessage(id, packet([++seq]));
    server.update();
    const y = server.inspect(id)!.state.y;
    if (y < -25) fell = true;
    if (fell && y > -5) respawned = true;
  }
  assert.ok(fell, 'the player should have fallen');
  assert.ok(respawned, 'and then been put back');
});

test('disconnect removes the player', () => {
  const server = new GameServer({ map: arena });
  const { id } = join(server);
  server.disconnect(id);
  assert.equal(server.playerCount, 0);
  server.onMessage(id, packet([1])); // late packet from a gone player: ignored
  server.update();
});

// keep the helper import used even if a future edit removes a test
void input;
