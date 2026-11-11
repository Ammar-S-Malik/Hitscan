import test from 'node:test';
import assert from 'node:assert/strict';
import { DT, NET } from '@hitscan/shared';
import type { GameMap, Input } from '@hitscan/shared';
import { IDLE, box, input, loadMap, mulberry32, randomInput } from '../../shared/test/helpers.ts';
import { SimWorld, TICK_MS } from './harness.ts';
import type { SimClient } from './harness.ts';

const arena = loadMap('arena1.json');

/** A huge empty floor, so a player can run in a straight line for a long time. */
const flat: GameMap = {
  name: 'Flat',
  size: 'medium',
  maxPlayers: 8,
  bounds: { min: [-500, -1, -500], max: [500, 10, 500] },
  boxes: [box([-500, -1, -500], [500, 0, 500], 'floor')],
  spawns: [
    { x: 0, y: 0, z: 0, yaw: 0 },
    { x: 20, y: 0, z: 0, yaw: 0 },
    { x: -20, y: 0, z: 0, yaw: 0 },
  ],
};

/** Looks around, runs, jumps and slides at random, the same way every time for the same seed. */
function wanderer(seed: number): (tick: number) => Input {
  const rand = mulberry32(seed);
  let yaw = 0;
  return (tick) => {
    if (tick % 45 === 0) yaw += (rand() - 0.5) * 3;
    return randomInput(rand, yaw);
  };
}

function summarize(c: SimClient) {
  const sorted = [...c.corrections].sort((a, b) => a - b);
  const n = sorted.length;
  return {
    snapshots: n,
    max: sorted[n - 1] ?? 0,
    p99: sorted[Math.floor(n * 0.99)] ?? 0,
    nonzero: sorted.filter((v) => v > 1e-9).length,
    big: sorted.filter((v) => v > 0.05).length,
  };
}

test('PERFECT NETWORK: the prediction is exactly the server, so every correction is zero', () => {
  const world = new SimWorld(arena, 11);
  const a = world.addClient({ latencyMs: 80, jitterMs: 0, loss: 0 }, wanderer(1));
  world.run(20);
  const s = summarize(a);
  console.log('  perfect network:', JSON.stringify(s));
  assert.ok(s.snapshots > 400);
  assert.equal(s.max, 0, 'prediction and server disagreed even though nothing was lost');
});

test('BAD NETWORK (100 ms latency each way, 20 ms jitter, 5% loss): corrections stay rare and small', () => {
  const world = new SimWorld(arena, 12);
  const a = world.addClient({ latencyMs: 100, jitterMs: 20, loss: 0.05 }, wanderer(2));
  const b = world.addClient({ latencyMs: 100, jitterMs: 20, loss: 0.05 }, wanderer(3), 7);
  world.run(30);
  for (const c of [a, b]) {
    const s = summarize(c);
    console.log('  bad network:', JSON.stringify(s), `up dropped ${c.up.dropped}/${c.up.sent}, down dropped ${c.down.dropped}/${c.down.sent}`);
    assert.ok(s.snapshots > 500);
    assert.ok(c.up.dropped > 0 && c.down.dropped > 0, 'the simulated network should really be losing packets');
    assert.ok(s.big / s.snapshots < 0.01, `${s.big} of ${s.snapshots} snapshots moved the player more than 5 cm`);
    assert.ok(s.max < NET.snapDistance, `worst correction ${s.max} m`);
  }
  assert.ok(world.server.inspect(a.id)!.processed > 1500, 'the server kept applying a steady stream of inputs');
});

test('HEAVY LOSS (40% each way): corrections happen, and the client still converges on the server', () => {
  const world = new SimWorld(arena, 13);
  const a = world.addClient({ latencyMs: 120, jitterMs: 40, loss: 0.4 }, wanderer(4));
  world.run(12);
  const rough = summarize(a);
  console.log('  heavy loss:', JSON.stringify(rough));
  assert.ok(rough.nonzero > 0, 'with this much loss some inputs must go missing');

  // The player now stands still and the network heals. Both sides should end up in the same place.
  a.inputFor = () => ({ ...IDLE, yaw: 0 });
  a.setLink({ loss: 0, jitterMs: 0 });
  world.run(8);
  const server = world.server.inspect(a.id)!.state;
  const client = a.predictor!.cur;
  // About 240 ms round trip is 15 ticks of inputs legitimately in flight, plus a snapshot interval.
  assert.ok(a.predictor!.pendingCount <= 20, `${a.predictor!.pendingCount} inputs still unacknowledged`);
  assert.ok(Math.hypot(server.x - client.x, server.y - client.y, server.z - client.z) < 1e-6, 'client and server ended apart');
  assert.deepStrictEqual(client, server);
});

test('OTHER PLAYERS look smooth and follow the truth, drawn a little in the past, never extrapolated', () => {
  const world = new SimWorld(flat, 14);
  const runner = world.addClient({ latencyMs: 60, jitterMs: 10, loss: 0.02 }, () => input({ forward: 1, sprint: true, yaw: 0 }));
  const watcher = world.addClient({ latencyMs: 60, jitterMs: 10, loss: 0.02 }, () => ({ ...IDLE }), 3);

  // What the server really did, tick by tick, for the runner.
  const truth = new Map<number, number>();
  world.clock.at(0, function record(): void {
    truth.set(world.server.tickCount, world.server.inspect(runner.id)!.state.z);
    world.clock.after(TICK_MS / 4, record);
  });

  let worst = 0;
  let lag = 0;
  let samples = 0;
  let lastZ = Infinity;
  for (let ms = 4000; ms <= 9000; ms += 7) {
    world.clock.advanceTo(ms);
    const view = watcher.interp.sample(world.clock.now());
    const seen = view.players.find((p) => p.id === runner.id);
    if (!seen) continue;
    const tick = view.renderTime / DT;
    const lo = Math.floor(tick);
    const frac = tick - lo;
    const z = truth.get(lo)! + (truth.get(lo + 1)! - truth.get(lo)!) * frac;
    worst = Math.max(worst, Math.abs(seen.z - z));
    lag += world.server.tickCount * DT - view.renderTime;
    samples++;
    assert.ok(seen.z <= lastZ + 1e-3, 'the runner (moving toward -Z) appeared to jump backwards');
    lastZ = seen.z;
  }
  const meanLag = lag / samples;
  console.log(`  interpolation: worst error ${(worst * 100).toFixed(2)} cm, drawn ${(meanLag * 1000).toFixed(0)} ms behind the server`);
  assert.ok(samples > 600);
  assert.ok(worst < 0.05, `drawn ${worst} m from where the server had them`);
  assert.ok(meanLag > NET.interpDelay && meanLag < 0.4, `drawn ${meanLag}s behind`);
});

test('SPEED HACK over the full stack: a client sending three inputs per tick covers no more ground than an honest one', () => {
  const honestWorld = new SimWorld(flat, 15);
  const honest = honestWorld.addClient({ latencyMs: 50, jitterMs: 0, loss: 0 }, () => input({ forward: 1, sprint: true }));
  honestWorld.run(10);
  const honestZ = honestWorld.server.inspect(honest.id)!.state.z;

  const cheatWorld = new SimWorld(flat, 15);
  const cheat = cheatWorld.addClient({ latencyMs: 50, jitterMs: 0, loss: 0 }, () => input({ forward: 1, sprint: true }));
  // Cheat: also fire two extra inputs into the server every client tick.
  const realTick = cheat.tick.bind(cheat);
  cheat.tick = () => {
    for (let k = 0; k < 3; k++) realTick();
  };
  cheatWorld.run(10);
  const cheatInfo = cheatWorld.server.inspect(cheat.id)!;
  const ticks = cheatWorld.server.tickCount;
  console.log(`  speed hack: honest z=${honestZ.toFixed(1)}, cheater z=${cheatInfo.state.z.toFixed(1)}, cheater inputs applied ${cheatInfo.processed} in ${ticks} ticks, dropped ${cheatInfo.dropped}`);
  assert.ok(cheatInfo.processed <= ticks + NET.budgetCap);
  assert.ok(cheatInfo.dropped > 0);
  assert.ok(Math.abs(cheatInfo.state.z) <= Math.abs(honestZ) * 1.05 + 1, 'the cheater got ahead');
});

test('DISCONNECT: when a player leaves, the others stop seeing them', () => {
  const world = new SimWorld(flat, 16);
  const a = world.addClient({ latencyMs: 30, jitterMs: 0, loss: 0 }, () => ({ ...IDLE }));
  const b = world.addClient({ latencyMs: 30, jitterMs: 0, loss: 0 }, () => ({ ...IDLE }));
  world.run(2);
  assert.equal(a.interp.sample(world.clock.now()).players.length, 1);
  world.server.disconnect(b.id);
  b.active = false;
  world.run(2);
  assert.equal(a.interp.sample(world.clock.now()).players.length, 0);
});
