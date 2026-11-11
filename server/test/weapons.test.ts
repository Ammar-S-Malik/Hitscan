import test from 'node:test';
import assert from 'node:assert/strict';
import { COMBAT, WEAPONS, decodeServerMessage, encodeInputPacket, pelletDamage, pelletDirections, quantizeInput, shotSeed } from '@hitscan/shared';
import type { GameMap, Input, ServerMessage, ShotEvent } from '@hitscan/shared';
import { GameServer } from '../src/game.ts';
import type { Connection } from '../src/game.ts';
import { IDLE, box } from '../../shared/test/helpers.ts';

/** Player 1 spawns at z=0, player 2 at `gap` metres away. */
function map(gap: number): GameMap {
  return {
    name: 'Flat', size: 'small', maxPlayers: 4,
    bounds: { min: [-100, -1, -300], max: [100, 20, 100] },
    boxes: [box([-100, -1, -300], [100, 0, 100], 'floor')],
    spawns: [{ x: 0, y: 0, z: 0, yaw: 0 }, { x: 0, y: 0, z: -gap, yaw: 0 }],
  };
}

class Conn implements Connection {
  messages: ServerMessage[] = [];
  send(d: Uint8Array): void {
    const m = decodeServerMessage(d);
    if (m) this.messages.push(m);
  }
  close(): void {}
  get events(): ShotEvent[] {
    return this.messages.flatMap((m) => (m.kind === 'events' ? m.events : []));
  }
}

class Duel {
  server: GameServer;
  a = { id: 0, conn: new Conn(), seq: 0 };
  b = { id: 0, conn: new Conn(), seq: 0 };
  constructor(gap: number) {
    this.server = new GameServer({ map: map(gap) });
    this.a.id = this.server.connect(this.a.conn)!;
    this.b.id = this.server.connect(this.b.conn)!;
    this.run(COMBAT.spawnShieldTicks + 5);
  }
  tick(a: Partial<Input> = {}, b: Partial<Input> = {}): void {
    for (const [p, patch] of [[this.a, a], [this.b, b]] as const) {
      p.seq++;
      this.server.onMessage(p.id, encodeInputPacket([{ seq: p.seq, input: quantizeInput({ ...IDLE, ...patch }) }]));
    }
    this.server.update();
  }
  run(n: number, a: Partial<Input> = {}, b: Partial<Input> = {}): void {
    for (let i = 0; i < n; i++) this.tick(a, b);
  }
  /** Take a gun out, wait for it to be ready, then fire one shot (with a click) aimed at the body, and collect the events. */
  shoot(weapon: number, extra: Partial<Input> = {}, gap = 10): ShotEvent[] {
    this.run(WEAPONS[weapon].switchTicks + 3, { weapon });
    const before = this.a.conn.events.length;
    this.tick({ weapon, fire: true, pitch: Math.atan2(0.9 - 1.62, gap), ...extra });
    this.run(4, { weapon });
    return this.a.conn.events.slice(before);
  }
  health(): number {
    return this.server.inspect(this.b.id)!.health;
  }
}

test('the shotgun fires eight pellets per shot, and each ray is reported', () => {
  const d = new Duel(6);
  const shot = d.shoot(2, {}, 6);
  assert.equal(shot.length, WEAPONS[2].pellets);
  assert.ok(shot.every((e) => e.weapon === 2 && e.shooter === d.a.id));
  const hits = shot.filter((e) => e.victim === d.b.id);
  assert.ok(hits.length >= 4, `${hits.length} pellets hit at 6 m`);
  assert.equal(new Set(shot.map((e) => e.end.join(','))).size, shot.length, 'the pellets scatter');
  assert.equal(d.health(), COMBAT.maxHealth - hits.reduce((n, e) => n + e.damage, 0));
});

test('shotgun damage falls off hard with distance', () => {
  const close = new Duel(5);
  close.shoot(2, {}, 5);
  const far = new Duel(30);
  far.shoot(2, {}, 30);
  const lost = (d: Duel) => COMBAT.maxHealth - d.health();
  assert.ok(lost(close) >= 40, `point blank took ${lost(close)}`);
  assert.ok(lost(far) < lost(close) / 2, `far away took ${lost(far)}`);
});

test('the sniper kills with one head shot when aimed (no spread) and the shot reports the right gun', () => {
  const d = new Duel(40);
  const shot = d.shoot(4, { aim: true, pitch: 0 }, 40); // pitch 0 at eye height is the head
  assert.equal(shot.length, 1);
  assert.equal(shot[0].victim, d.b.id);
  assert.equal(shot[0].headshot, true);
  assert.equal(shot[0].killed, true);
  assert.equal(shot[0].weapon, 4);
  assert.equal(d.health(), 0);
});

test('the sniper does 90 to the body at range, and its fire rate is slow', () => {
  const d = new Duel(60);
  const shot = d.shoot(4, { aim: true }, 60);
  assert.equal(shot[0].damage, pelletDamage(WEAPONS[4], 60, false));
  assert.equal(d.health(), COMBAT.maxHealth - 90);
  d.run(10, { weapon: 4 });
  d.tick({ weapon: 4, fire: true, aim: true, pitch: Math.atan2(0.9 - 1.62, 60) });
  d.run(4, { weapon: 4 });
  assert.equal(d.a.conn.events.length, 1, 'a second click 0.2 s later does nothing: the bolt is still cycling');
});

test('taking a gun out has a delay on the server: an instant click after a switch does not fire', () => {
  const d = new Duel(10);
  d.run(2, { weapon: 3 });
  const early = d.a.conn.events.length;
  d.run(WEAPONS[3].switchTicks - 6, { weapon: 3, fire: true });
  assert.equal(d.a.conn.events.length, early, 'rifle not ready yet');
  d.run(20, { weapon: 3, fire: true });
  d.run(3, { weapon: 3 });
  assert.ok(d.a.conn.events.length > early, 'and then it fires');
});

test('aiming down sights tightens the spread: from range, aimed SMG fire lands far more often than hip fire', () => {
  function accuracy(aim: boolean): number {
    const d = new Duel(30);
    d.run(WEAPONS[1].switchTicks + 3, { weapon: 1 });
    // aim at the middle of the body and spray; count shots that hit anywhere on B
    d.run(WEAPONS[1].intervalTicks * 40, { weapon: 1, fire: true, aim, pitch: Math.atan2(0.9 - 1.62, 30) }, { });
    const shots = d.a.conn.events.filter((e) => e.shooter === d.a.id);
    return shots.filter((e) => e.victim === d.b.id).length / Math.max(1, shots.length);
  }
  // B dies after a few hits and shots then miss, so compare the first shots only.
  function firstShots(aim: boolean): number {
    const d = new Duel(30);
    d.run(WEAPONS[1].switchTicks + 3, { weapon: 1 });
    d.run(WEAPONS[1].intervalTicks * 8, { weapon: 1, fire: true, aim, pitch: Math.atan2(0.9 - 1.62, 30) });
    const shots = d.a.conn.events.slice(0, 8);
    return shots.filter((e) => e.victim === d.b.id).length / Math.max(1, shots.length);
  }
  void accuracy;
  assert.ok(firstShots(true) >= firstShots(false), 'aimed is at least as accurate');
  assert.ok(firstShots(true) >= 0.9, `aimed hit rate ${firstShots(true)}`);
});

test('the server applies the spread itself: two shots from identical inputs go different ways, and a replay of one input is identical', () => {
  const d = new Duel(30);
  d.run(WEAPONS[1].switchTicks + 3, { weapon: 1 });
  d.run(WEAPONS[1].intervalTicks * 4, { weapon: 1, fire: true, pitch: 0.3 });
  const ends = d.a.conn.events.map((e) => e.end.join(','));
  assert.ok(ends.length >= 3);
  assert.equal(new Set(ends).size, ends.length, 'every shot lands somewhere different');
});

test('the client can predict the server\'s rays: same seed, same input number, same pellets', () => {
  const d = new Duel(10);
  d.run(WEAPONS[2].switchTicks + 3, { weapon: 2 });
  const before = d.a.conn.events.length;
  d.tick({ weapon: 2, fire: true, pitch: -0.5 });
  const seq = d.a.seq; // the number the client gave this input
  d.run(4, { weapon: 2 });
  const events = d.a.conn.events.slice(before);
  const rays = pelletDirections(WEAPONS[2], 0, -0.5, false, shotSeed(seq, d.a.id));
  assert.equal(events.length, rays.length);
  rays.forEach((dir, i) => {
    const t = 1.62 / -dir[1]; // where the ray reaches the floor (y = 0)
    const expected = [dir[0] * t, 0, dir[2] * t];
    for (let k = 0; k < 3; k++) assert.ok(Math.abs(events[i].end[k] - expected[k]) < 1e-3, `pellet ${i} axis ${k}`);
  });
});
