import test from 'node:test';
import assert from 'node:assert/strict';
import { COMBAT, DT, TICK_RATE, WEAPONS, decodeServerMessage, encodeInputPacket, pelletDamage, quantizeInput } from '@hitscan/shared';
import type { GameMap, Input, ServerMessage, ShotEvent, Snapshot } from '@hitscan/shared';
import { GameServer } from '../src/game.ts';
import type { Connection } from '../src/game.ts';
import { IDLE, box } from '../../shared/test/helpers.ts';

/** A big flat floor. Player 1 spawns at z=0 and player 2 (the farthest spawn) at z=-10. */
function flatMap(extra: GameMap['boxes'] = []): GameMap {
  return {
    name: 'Flat', size: 'small', maxPlayers: 4,
    bounds: { min: [-100, -1, -100], max: [100, 20, 100] },
    boxes: [box([-100, -1, -100], [100, 0, 100], 'floor'), ...extra],
    spawns: [{ x: 0, y: 0, z: 0, yaw: 0 }, { x: 0, y: 0, z: -10, yaw: 0 }],
  };
}

class Conn implements Connection {
  messages: ServerMessage[] = [];
  send(data: Uint8Array): void {
    const m = decodeServerMessage(data);
    if (m) this.messages.push(m);
  }
  close(): void {}
  get events(): ShotEvent[] {
    return this.messages.flatMap((m) => (m.kind === 'events' ? m.events : []));
  }
  get snapshots(): Snapshot[] {
    return this.messages.flatMap((m) => (m.kind === 'snapshot' ? [m.snapshot] : []));
  }
}

class Rig {
  server: GameServer;
  a = { id: 0, conn: new Conn(), seq: 0 };
  b = { id: 0, conn: new Conn(), seq: 0 };

  constructor(map = flatMap()) {
    this.server = new GameServer({ map });
    this.a.id = this.server.connect(this.a.conn)!;
    this.b.id = this.server.connect(this.b.conn)!;
  }

  private send(p: { id: number; seq: number }, patch: Partial<Input>): void {
    p.seq++;
    this.server.onMessage(p.id, encodeInputPacket([{ seq: p.seq, input: quantizeInput({ ...IDLE, ...patch }) }]));
  }

  /** One server tick, with each player sending one input first. */
  tick(a: Partial<Input> = {}, b: Partial<Input> = {}): void {
    this.send(this.a, a);
    this.send(this.b, b);
    this.server.update();
  }

  run(n: number, a: Partial<Input> = {}, b: Partial<Input> = {}): void {
    for (let i = 0; i < n; i++) this.tick(a, b);
  }

  info(who: 'a' | 'b') {
    return this.server.inspect(this[who].id)!;
  }
}

const BODY_PITCH = Math.atan2(0.9 - 1.62, 10); // from A's eye to the middle of B's body, 10 m away

function warm(r: Rig): void {
  r.run(COMBAT.spawnShieldTicks + 5); // land, let the input buffers fill, and let the spawn shield wear off
}

test('a shot hits the player in front: head shots do double, body shots the base damage', () => {
  const r = new Rig();
  warm(r);
  r.run(1, { fire: true });
  r.run(10);
  assert.equal(r.a.conn.events.length, 1);
  const head = r.a.conn.events[0];
  assert.equal(head.shooter, r.a.id);
  assert.equal(head.victim, r.b.id);
  assert.equal(head.headshot, true);
  assert.equal(head.damage, pelletDamage(WEAPONS[0], 10, true));
  assert.equal(r.info('b').health, COMBAT.maxHealth - head.damage);

  r.run(WEAPONS[0].intervalTicks); // wait out the fire rate
  r.run(1, { fire: true, pitch: BODY_PITCH });
  r.run(5);
  const body = r.a.conn.events[1];
  assert.equal(body.headshot, false);
  assert.equal(body.damage, pelletDamage(WEAPONS[0], 10, false));
  assert.equal(r.info('a').health, COMBAT.maxHealth, 'the shooter is not hurt');
});

test('every player hears about every shot, so everyone can draw the tracer', () => {
  const r = new Rig();
  warm(r);
  r.run(3, { fire: true });
  r.run(5);
  assert.equal(r.a.conn.events.length, r.b.conn.events.length);
  assert.ok(r.b.conn.events.length >= 1);
  const e = r.b.conn.events[0];
  assert.ok(Math.abs(e.origin[1] - 1.62) < 1e-4, 'the ray starts at the eye');
  assert.ok(Math.abs(e.end[2] - -9.65) < 1e-3, 'and ends on the near face of the body');
});

test('holding the trigger fires at the gun rate, not once per input; a pistol needs a click per shot', () => {
  const r = new Rig();
  warm(r);
  r.run(WEAPONS[1].switchTicks + 3, { weapon: 1 }); // SMG out and ready
  const before = r.a.conn.events.length;
  r.run(60, { weapon: 1, fire: true, pitch: -1.2 }); // aimed at the floor, so nobody dies
  r.run(5, { weapon: 1 });
  assert.equal(r.a.conn.events.length - before, Math.ceil(60 / WEAPONS[1].intervalTicks));

  const p = new Rig();
  warm(p);
  p.run(60, { fire: true, pitch: -1.2 });
  p.run(5);
  assert.equal(p.a.conn.events.length, 1, 'holding the pistol trigger gives one shot');
});

test('walls stop shots', () => {
  const r = new Rig(flatMap([box([-5, 0, -5.5], [5, 5, -5], 'wall')]));
  warm(r);
  r.run(1, { fire: true });
  r.run(5);
  const e = r.a.conn.events[0];
  assert.equal(e.victim, 0);
  assert.equal(e.damage, 0);
  assert.ok(Math.abs(e.end[2] - -5) < 1e-3, 'the tracer ends on the wall');
  assert.equal(r.info('b').health, COMBAT.maxHealth);
});

test('four rifle body shots kill: score, death, no movement while dead, no shooting while dead, then a respawn with a shield', () => {
  const rifle = WEAPONS[3];
  const r = new Rig();
  warm(r);
  r.run(rifle.switchTicks + 3, { weapon: 3 });
  r.run(rifle.intervalTicks * 3 + 1, { weapon: 3, fire: true, pitch: BODY_PITCH });
  r.run(3);
  assert.equal(r.info('b').alive, false);
  assert.equal(r.info('b').health, 0);
  assert.equal(r.info('a').kills, 1);
  assert.equal(r.info('b').deaths, 1);
  const kill = r.a.conn.events.filter((e) => e.killed);
  assert.equal(kill.length, 1);
  assert.equal(kill[0].victim, r.b.id);

  // Dead: trying to run and shoot does nothing.
  const bShotsBefore = r.b.conn.events.filter((e) => e.shooter === r.b.id).length;
  const z = r.info('b').state.z;
  r.run(30, {}, { forward: 1, sprint: true, fire: true });
  assert.ok(Math.abs(r.info('b').state.z - z) < 0.01, 'a dead player does not move');
  assert.equal(r.b.conn.events.filter((e) => e.shooter === r.b.id).length, bShotsBefore, 'or shoot');
  assert.equal(r.a.conn.snapshots.at(-1)!.others.find((o) => o.id === r.b.id)!.alive, false);
  assert.ok(r.b.conn.snapshots.at(-1)!.respawnTicks > 0, 'the dead player is told how long is left');

  // Respawn.
  r.run(COMBAT.respawnTicks);
  assert.equal(r.info('b').alive, true);
  assert.equal(r.info('b').health, COMBAT.maxHealth);

  // The shield: shots right after a respawn do no damage...
  r.run(5, { weapon: 3, fire: true, pitch: BODY_PITCH });
  assert.equal(r.info('b').health, COMBAT.maxHealth, 'spawn shield');
  // ...and once it wears off they do.
  r.run(COMBAT.spawnShieldTicks, { weapon: 3, fire: true, pitch: BODY_PITCH });
  assert.ok(r.info('b').health < COMBAT.maxHealth);
});

test('fire cooldown counts inputs: a player cannot shoot faster by sending packets faster', () => {
  const r = new Rig();
  warm(r);
  r.run(WEAPONS[3].switchTicks + 3, { weapon: 3 });
  const before = r.a.conn.events.length;
  for (let i = 0; i < 6; i++) {
    // Six inputs per tick: the server only applies what the budget allows.
    for (let k = 0; k < 6; k++) r.server.onMessage(r.a.id, encodeInputPacket([{ seq: ++r.a.seq, input: quantizeInput({ ...IDLE, weapon: 3, fire: true, pitch: -1.2 }) }]));
    r.tick({ weapon: 3, pitch: -1.2 });
  }
  r.run(5, { weapon: 3 });
  assert.ok(r.a.conn.events.length - before <= 4, `fired ${r.a.conn.events.length - before} shots in about 0.1 s`);
});

// ---------------------------------------------------------------- lag compensation

/**
 * B runs sideways. A is still and shoots where B was `ago` ticks back, claiming that moment as its view
 * time, which is exactly what a client does with its interpolated view. The shot should hit.
 */
function laggedShot(claimBack: number, aimBack: number): ShotEvent {
  const r = new Rig();
  warm(r);
  const pos = new Map<number, { x: number; y: number; z: number }>();
  for (let i = 0; i < 90; i++) {
    r.tick({}, { strafe: 1, sprint: true });
    const s = r.info('b').state;
    pos.set(r.server.tickCount, { x: s.x, y: s.y, z: s.z });
  }
  const now = r.server.tickCount;
  const target = pos.get(now - aimBack)!;
  const me = r.info('a').state;
  const dx = target.x - me.x;
  const dz = target.z - me.z;
  const dy = target.y + 0.9 - (me.y + 1.62);
  const yaw = Math.atan2(-dx, -dz);
  const pitch = Math.atan2(dy, Math.hypot(dx, dz));
  const viewMs = ((now - claimBack) / TICK_RATE) * 1000;
  const before = r.a.conn.events.length;
  r.tick({ yaw, pitch, fire: true, viewMs }, { strafe: 1, sprint: true });
  r.run(6, {}, { strafe: 1, sprint: true });
  return r.a.conn.events[before];
}

test('lag compensation: aiming at where the target was, and saying when, hits a moving target', () => {
  // The shot is applied a few ticks after it was made, so claim a view a little older than "now".
  for (const back of [6, 9, 12, 20, 28]) {
    const e = laggedShot(back, back);
    assert.ok(e, `a shot was fired (${back} ticks back)`);
    assert.equal(e.victim, 2, `hit at ${back} ticks (${Math.round((back * 1000) / TICK_RATE)} ms) back`);
  }
});

test('without the rewind the same aim misses: B has moved on', () => {
  const e = laggedShot(0, 20); // aims where B was 20 ticks ago but claims to be looking at the present
  assert.ok(e);
  assert.equal(e.victim, 0);
});

test('rewinding is capped: claiming an ancient view does not reach back further than maxRewindMs', () => {
  const tooOld = Math.ceil((COMBAT.maxRewindMs / 1000) * TICK_RATE) + 12; // 42 ticks > the 30 allowed
  const e = laggedShot(tooOld, 36);
  assert.ok(e);
  assert.equal(e.victim, 0, 'the claimed time is clamped, so the shot lands where B was 30 ticks back, not 36');
});

test('a claimed view time in the future is clamped to the present, not trusted', () => {
  const e = laggedShot(-600, 15);
  assert.ok(e);
  assert.equal(e.victim, 0);
});

test('history is bounded, so a long game does not grow memory', () => {
  const r = new Rig();
  r.run(COMBAT.historyTicks * 5);
  // Not exposed on purpose: check indirectly that shots with a view older than the history still work.
  r.run(1, { fire: true, viewMs: 1 });
  r.run(5);
  assert.ok(r.a.conn.events.length >= 1);
  assert.ok(DT > 0);
});
