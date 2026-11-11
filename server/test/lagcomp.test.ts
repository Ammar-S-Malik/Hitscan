import test from 'node:test';
import assert from 'node:assert/strict';
import { BODY } from '@hitscan/shared';
import type { GameMap, Input } from '@hitscan/shared';
import { IDLE, box } from '../../shared/test/helpers.ts';
import { SimWorld } from './harness.ts';
import type { SimClient } from './harness.ts';

function flat(): GameMap {
  return {
    name: 'Flat', size: 'small', maxPlayers: 4,
    bounds: { min: [-100, -1, -100], max: [100, 20, 100] },
    boxes: [box([-100, -1, -100], [100, 0, 100], 'floor')],
    spawns: [{ x: 0, y: 0, z: 0, yaw: 0 }, { x: 0, y: 0, z: -12, yaw: 0 }],
  };
}

/**
 * A is a bot that does what a real client does: it aims at the other player where it is DRAWN
 * (the interpolated position, 100 ms plus latency in the past) and tells the server which moment it
 * was looking at. B zig-zags sideways at sprint speed. Returns how many of A's shots hit B before B died.
 */
function duel(seed: number, link: { latencyMs: number; jitterMs: number; loss: number }, claimView: boolean) {
  const world = new SimWorld(flat(), seed);
  const wobble = (tick: number): Input => ({ ...IDLE, strafe: Math.floor(tick / 45) % 2 === 0 ? 1 : -1, sprint: true });
  let a!: SimClient;
  const b = world.addClient(link, wobble, 3);
  a = world.addClient(link, (tick) => {
    const view = a.interp.sample(world.clock.now());
    const target = view.players.find((p) => p.id === b.id);
    const me = a.predictor?.cur;
    if (!target || !me || tick < 130) return IDLE; // let the spawn shields wear off first
    const dx = target.x - me.x;
    const dz = target.z - me.z;
    const dy = target.y + BODY.standHeight * 0.5 - (me.y + BODY.standEye);
    return {
      ...IDLE,
      yaw: Math.atan2(-dx, -dz),
      pitch: Math.atan2(dy, Math.hypot(dx, dz)),
      fire: true,
      viewMs: claimView ? view.renderTime * 1000 : (a.lastSnapshot?.tick ?? 0) * (1000 / 60) + 1000 / 60 * 6,
    };
  });
  world.run(12);
  const mine = a.sentEvents.filter((e) => e.shooter === a.id);
  const untilKill = mine.slice(0, (mine.findIndex((e) => e.killed) + 1) || mine.length);
  return { shots: untilKill.length, hits: untilKill.filter((e) => e.victim === b.id).length, killed: mine.some((e) => e.killed) };
}

test('end to end at 100 ms latency, jitter and loss: shots aimed at the drawn position of a moving target land', () => {
  let shots = 0;
  let hits = 0;
  for (let seed = 1; seed <= 6; seed++) {
    const r = duel(seed, { latencyMs: 100, jitterMs: 20, loss: 0.02 }, true);
    assert.ok(r.killed, `seed ${seed}: the target was killed`);
    shots += r.shots;
    hits += r.hits;
  }
  assert.ok(hits / shots >= 0.85, `hit rate ${hits}/${shots}`);
});

test('the same duel without the rewind (claiming the newest snapshot time) mostly misses', () => {
  let shots = 0;
  let hits = 0;
  for (let seed = 1; seed <= 6; seed++) {
    const r = duel(seed, { latencyMs: 100, jitterMs: 20, loss: 0.02 }, false);
    shots += r.shots;
    hits += r.hits;
  }
  assert.ok(hits / shots < 0.5, `hit rate ${hits}/${shots}`);
});

test('and it works at low and high latency too', () => {
  for (const latencyMs of [0, 40, 150]) {
    const r = duel(3, { latencyMs, jitterMs: 5, loss: 0 }, true);
    assert.ok(r.killed, `${latencyMs} ms: killed`);
    assert.ok(r.hits / r.shots >= 0.8, `${latencyMs} ms: ${r.hits}/${r.shots}`);
  }
});
