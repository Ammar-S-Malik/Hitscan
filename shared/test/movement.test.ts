import test from 'node:test';
import assert from 'node:assert/strict';
import { DT, MOVE, SLIDE } from '../src/config.ts';
import { createPlayer, isColliding, step } from '../src/movement.ts';
import type { PlayerState } from '../src/types.ts';
import { IDLE, box, input, landed, loadMap, mulberry32, randomInput } from './helpers.ts';

const arena = loadMap('arena1.json');
const hspeed = (s: PlayerState) => Math.hypot(s.vx, s.vz);

// A big flat floor with nothing in the way, for tests about speed and timing.
const FLAT = [box([-500, -1, -500], [500, 0, 500], 'floor')];

/** Sprint straight ahead (toward -Z) until at full speed. */
function sprinting(): PlayerState {
  let s = landed(0, 0, 0, FLAT);
  for (let i = 0; i < 60; i++) s = step(s, input({ forward: 1, sprint: true }), FLAT);
  return s;
}

// ------------------------------------------------------------- determinism

test('the same inputs always give byte-identical states', () => {
  const run = () => {
    const rand = mulberry32(42);
    let s = createPlayer(arena.spawns[0].x, arena.spawns[0].y, arena.spawns[0].z);
    let yaw = arena.spawns[0].yaw;
    const states: PlayerState[] = [];
    for (let i = 0; i < 3000; i++) {
      if (i % 40 === 0) yaw += (rand() - 0.5) * 2;
      s = step(s, randomInput(rand, yaw), arena.boxes);
      states.push(s);
    }
    return states;
  };
  assert.deepStrictEqual(run(), run());
});

test('replaying inputs from any saved state reproduces the same result (what reconciliation relies on)', () => {
  const rand = mulberry32(7);
  const inputs = [];
  let yaw = 0;
  for (let i = 0; i < 1200; i++) {
    if (i % 30 === 0) yaw += (rand() - 0.5) * 3;
    inputs.push(randomInput(rand, yaw));
  }
  const snapshots: PlayerState[] = [];
  let s = createPlayer(-17, 0, 0);
  for (const inp of inputs) {
    snapshots.push(s);
    s = step(s, inp, arena.boxes);
  }
  for (const k of [0, 137, 599, 1001]) {
    let r = snapshots[k];
    for (let i = k; i < inputs.length; i++) r = step(r, inputs[i], arena.boxes);
    assert.deepStrictEqual(r, s, `replay from tick ${k} diverged`);
  }
});

test('step never modifies the state it is given', () => {
  const s = landed(0, 0, 0, FLAT);
  const copy = structuredClone(s);
  step(s, input({ forward: 1, jump: true, slide: true }), FLAT);
  assert.deepStrictEqual(s, copy);
});

test('garbage input (NaN, huge values) cannot corrupt the state', () => {
  let s = landed(0, 0, 0, FLAT);
  s = step(s, { forward: NaN, strafe: Infinity, yaw: NaN, jump: false, sprint: true, slide: false, pitch: 0, fire: false, weapon: 0, aim: false, viewMs: 0 }, FLAT);
  s = step(s, { forward: 1e9, strafe: -1e9, yaw: 1e9, jump: false, sprint: true, slide: false, pitch: 0, fire: false, weapon: 0, aim: false, viewMs: 0 }, FLAT);
  for (const v of Object.values(s)) if (typeof v === 'number') assert.ok(Number.isFinite(v));
  assert.ok(hspeed(s) <= MOVE.maxHorizontalSpeed + 1e-9);
});

// ----------------------------------------------------------------- collision

test('the player never ends up inside the map or outside it, even at slide speed (fuzz)', () => {
  // Thin 0.1 m walls are the worst case for tunnelling.
  const thin = [
    box([-11, -1, -11], [11, 0, 11], 'floor'),
    box([-10.1, 0, -10.1], [10.1, 5, -10], 'wall'),
    box([-10.1, 0, 10], [10.1, 5, 10.1], 'wall'),
    box([-10.1, 0, -10], [-10, 5, 10], 'wall'),
    box([10, 0, -10], [10.1, 5, 10], 'wall'),
    box([-3, 0, -0.05], [3, 5, 0.05], 'wall'),
    box([4, 0, -6], [4.1, 5, 6], 'wall'),
  ];
  const rand = mulberry32(2024);
  let s = createPlayer(-6, 0, 6);
  let yaw = 0;
  for (let i = 0; i < 60000; i++) {
    if (i % 25 === 0) yaw = rand() * Math.PI * 2;
    s = step(s, randomInput(rand, yaw), thin);
    assert.ok(!isColliding(s, thin), `inside geometry at tick ${i}: ${JSON.stringify(s)}`);
    assert.ok(Math.abs(s.x) < 10 && Math.abs(s.z) < 10, `escaped the arena at tick ${i}`);
    assert.ok(s.y >= -0.001, `fell through the floor at tick ${i}`);
  }
});

test('random play on the real map stays inside the geometry rules', () => {
  const rand = mulberry32(99);
  for (const sp of arena.spawns) {
    let s = createPlayer(sp.x, sp.y, sp.z);
    let yaw = sp.yaw;
    for (let i = 0; i < 6000; i++) {
      if (i % 30 === 0) yaw += (rand() - 0.5) * 3;
      s = step(s, randomInput(rand, yaw), arena.boxes);
      assert.ok(!isColliding(s, arena.boxes), `inside geometry from spawn ${JSON.stringify(sp)} at tick ${i}`);
      assert.ok(s.x > -20 && s.x < 20 && s.z > -20 && s.z < 20 && s.y >= -0.001);
    }
  }
});

test('every spawn point is clear of geometry and lands on the floor', () => {
  for (const sp of arena.spawns) {
    const s = landed(sp.x, sp.y, sp.z, arena.boxes);
    assert.ok(!isColliding(createPlayer(sp.x, sp.y, sp.z), arena.boxes));
    assert.ok(s.grounded);
    assert.ok(Math.abs(s.y) < 1e-9);
  }
});

test('walking into a wall stops you; strafing along it keeps you moving', () => {
  const wall = [...FLAT, box([-50, 0, -5], [50, 5, -4])];
  let s = landed(0, 0, 0, wall);
  for (let i = 0; i < 120; i++) s = step(s, input({ forward: 1 }), wall);
  assert.ok(s.z >= -4 + 0.35 - 1e-3, 'pushed into the wall');
  const z = s.z;
  for (let i = 0; i < 60; i++) s = step(s, input({ forward: 1, strafe: 1 }), wall);
  assert.ok(s.x > 3, 'should slide along the wall');
  assert.ok(Math.abs(s.z - z) < 1e-3);
});

test('small ledges are walked up, bigger ones need a jump', () => {
  const stairs = [...FLAT, box([-2, 0, -4], [2, 0.3, -3], 'platform'), box([-2, 0, -8], [2, 0.8, -7], 'platform')];
  let s = landed(0, 0, 0, stairs);
  let stoodOnLedge = false;
  for (let i = 0; i < 40; i++) {
    s = step(s, input({ forward: 1 }), stairs);
    if (s.z < -3.4 && s.z > -3.6 && s.grounded && Math.abs(s.y - 0.3) < 1e-9) stoodOnLedge = true;
  }
  assert.ok(stoodOnLedge, 'should walk up onto the 0.3 m ledge without jumping');
  s = landed(0, 0, -6, stairs);
  for (let i = 0; i < 60; i++) s = step(s, input({ forward: 1 }), stairs);
  assert.ok(s.z > -7 + 0.35 - 1e-3, 'a 0.8 m wall should block a plain walk');
  assert.equal(s.y, 0);
});

test('a jump clears a 1.2 m platform and lands on top', () => {
  const ledge = [...FLAT, box([-4, 0, -12], [4, 1.2, -4], 'platform')];
  let s = landed(0, 0, -3.6, ledge);
  for (let i = 0; i < 90; i++) s = step(s, input({ forward: 1, jump: i < 2 }), ledge);
  assert.ok(s.grounded);
  assert.ok(Math.abs(s.y - 1.2) < 1e-9, `ended at y=${s.y}`);
});

// ---------------------------------------------------------------------- slide

test('a slide cannot start from standing still or while walking', () => {
  let s = landed(0, 0, 0, FLAT);
  s = step(s, input({ slide: true }), FLAT);
  assert.equal(s.sliding, false);
  s = landed(0, 0, 0, FLAT);
  for (let i = 0; i < 60; i++) s = step(s, input({ forward: 1 }), FLAT); // walk speed is below the slide minimum
  s = step(s, input({ forward: 1, slide: true }), FLAT);
  assert.equal(s.sliding, false);
});

test('sprinting then pressing slide gives a speed boost that fades out', () => {
  let s = sprinting();
  assert.ok(Math.abs(hspeed(s) - MOVE.sprintSpeed) < 0.05, `sprint speed ${hspeed(s)}`);
  s = step(s, input({ forward: 1, sprint: true, slide: true }), FLAT);
  assert.equal(s.sliding, true);
  assert.ok(hspeed(s) > MOVE.sprintSpeed, 'no boost');
  assert.ok(hspeed(s) <= SLIDE.maxSpeed + 1e-9);
  let ticks = 1;
  while (s.sliding && ticks < 500) {
    s = step(s, input({ forward: 1, sprint: true, slide: true }), FLAT);
    ticks++;
  }
  assert.equal(s.sliding, false);
  assert.ok(Math.abs(ticks * DT - SLIDE.duration) < 3 * DT, `slide lasted ${ticks * DT}s`);
  assert.ok(hspeed(s) < MOVE.sprintSpeed, 'speed should have faded');
});

test('slides cannot be chained: starts are at least duration + cooldown apart', () => {
  let s = sprinting();
  const starts: number[] = [];
  for (let i = 0; i < 1200; i++) {
    const was = s.sliding;
    // Hammer the slide key every other tick while sprinting.
    s = step(s, input({ forward: 1, sprint: true, slide: i % 2 === 0 }), FLAT);
    if (!was && s.sliding) starts.push(i);
  }
  assert.ok(starts.length >= 3, `expected several slides, got ${starts.length}`);
  for (let i = 1; i < starts.length; i++) {
    const gap = (starts[i] - starts[i - 1]) * DT;
    assert.ok(gap >= SLIDE.duration + SLIDE.cooldown - 3 * DT, `slides only ${gap}s apart`);
  }
});

test('holding the slide key does not restart the slide on its own', () => {
  let s = sprinting();
  let starts = 0;
  for (let i = 0; i < 600; i++) {
    const was = s.sliding;
    s = step(s, input({ forward: 1, sprint: true, slide: true }), FLAT);
    if (!was && s.sliding) starts++;
  }
  assert.equal(starts, 1);
});

test('jumping out of a slide ends it, starts the cooldown and keeps your speed', () => {
  let s = sprinting();
  s = step(s, input({ forward: 1, sprint: true, slide: true }), FLAT);
  const before = hspeed(s);
  s = step(s, input({ forward: 1, sprint: true, slide: true, jump: true }), FLAT);
  assert.equal(s.sliding, false);
  assert.ok(s.slideCooldown > 0);
  assert.ok(s.vy > 0);
  assert.ok(hspeed(s) > before - 1, 'a slide-jump should carry momentum');
});

test('under a low ceiling you stay crouched and never clip, then stand up once clear', () => {
  const tunnel = [...FLAT, box([-3, 1.2, -60], [3, 3, -30], 'ceiling')];
  let s = landed(0, 0, 0, tunnel);
  let pressed = false;
  let crouchedInside = false;
  let stoodAfter = false;
  for (let i = 0; i < 2000; i++) {
    const press = !pressed && s.z <= -26.5 && hspeed(s) >= SLIDE.minSpeed;
    if (press) pressed = true;
    s = step(s, input({ forward: 1, sprint: true, slide: press }), tunnel);
    assert.ok(!isColliding(s, tunnel), `clipped into the ceiling at tick ${i}`);
    if (s.z < -33 && s.z > -57 && s.slideTimer === 0 && s.sliding) crouchedInside = true;
    if (s.z < -62 && !s.sliding) {
      stoodAfter = true;
      break;
    }
  }
  assert.ok(pressed, 'never started the slide');
  assert.ok(crouchedInside, 'should stay crouched under the ceiling after the slide runs out');
  assert.ok(stoodAfter, 'should stand up once clear of the ceiling');
});

test('a standing player cannot walk into a tunnel that is only slide-high', () => {
  const tunnel = [...FLAT, box([-3, 1.2, -60], [3, 3, -30], 'ceiling')];
  let s = landed(0, 0, 0, tunnel);
  for (let i = 0; i < 900; i++) s = step(s, input({ forward: 1 }), tunnel);
  assert.ok(s.z > -30 + 0.35 - 1e-3, `walked in to z=${s.z}`);
});
