import test from 'node:test';
import assert from 'node:assert/strict';
import { WEAPONS } from '../src/config.ts';
import { NEUTRAL, reloadCues, reloadPose } from '../../client/src/reloadpose.ts';
import type { Pose } from '../../client/src/reloadpose.ts';

const near = (a: Pose, b: Pose): boolean => JSON.stringify(a, (_k, v) => (typeof v === 'number' ? Math.round(v * 1e6) / 1e6 : v)) === JSON.stringify(b, (_k, v) => (typeof v === 'number' ? Math.round(v * 1e6) / 1e6 : v));

test('every gun\'s reload starts and ends at the neutral pose, so nothing jumps', () => {
  for (let w = 0; w < WEAPONS.length; w++) {
    assert.ok(near(reloadPose(w, 0), NEUTRAL), `${WEAPONS[w].name} at 0`);
    assert.ok(near(reloadPose(w, 1), NEUTRAL), `${WEAPONS[w].name} at 1`);
  }
});

test('poses move smoothly and stay within a reasonable reach', () => {
  for (let w = 0; w < WEAPONS.length; w++) {
    let last = reloadPose(w, 0);
    for (let i = 1; i <= 400; i++) {
      const pose = reloadPose(w, i / 400);
      const nums = [pose.rotX, pose.rotZ, pose.x, pose.y, pose.z, ...pose.left, ...pose.right, pose.magDy, pose.boltBack, pose.boltLift, pose.pumpBack];
      for (const n of nums) assert.ok(Number.isFinite(n) && Math.abs(n) < 0.6, `${WEAPONS[w].name} at ${i / 400}: ${n}`);
      // Between neighbouring samples nothing moves more than a few centimetres (the magazine going out of sight excepted).
      for (const k of [0, 1, 2] as const) {
        assert.ok(Math.abs(pose.left[k] - last.left[k]) < 0.04, `${WEAPONS[w].name} left hand jumps at ${i / 400}`);
        assert.ok(Math.abs(pose.right[k] - last.right[k]) < 0.04, `${WEAPONS[w].name} right hand jumps at ${i / 400}`);
      }
      assert.ok(Math.abs(pose.rotZ - last.rotZ) < 0.05 && Math.abs(pose.rotX - last.rotX) < 0.05);
      last = pose;
    }
  }
});

test('each kind of gun does its own thing', () => {
  // Magazine guns pull the magazine out of sight and bring a new one up; the pistol, SMG and rifle all do.
  for (const w of [0, 1, 3]) {
    assert.equal(reloadPose(w, 0.45).magShown, false, `${WEAPONS[w].name} magazine is out`);
    assert.equal(reloadPose(w, 0.1).magShown, true);
    assert.ok(reloadPose(w, 0.3).magDy < -0.05, `${WEAPONS[w].name} magazine is being pulled`);
    assert.ok(Math.max(...Array.from({ length: 101 }, (_, i) => reloadPose(w, i / 100).boltBack)) > 0.03, `${WEAPONS[w].name} works its slide`);
  }
  // The shotgun carries shells and pumps; the sniper carries rounds and works the bolt.
  const shells = (w: number): number => Array.from({ length: 401 }, (_, i) => reloadPose(w, i / 400).shell).filter(Boolean).length;
  assert.ok(shells(2) > 20 && shells(4) > 10);
  assert.ok(Math.max(...Array.from({ length: 101 }, (_, i) => reloadPose(2, i / 100).pumpBack)) > 0.08);
  assert.ok(Math.max(...Array.from({ length: 101 }, (_, i) => reloadPose(4, i / 100).boltLift)) > 0.03);
});

test('sound cues are inside the reload and in order', () => {
  for (let w = 0; w < WEAPONS.length; w++) {
    const cues = reloadCues(w);
    assert.ok(cues.length >= 4);
    for (let i = 0; i < cues.length; i++) {
      assert.ok(cues[i].at > 0 && cues[i].at < 1);
      if (i > 0) assert.ok(cues[i].at > cues[i - 1].at, `${WEAPONS[w].name} cue ${i} is out of order`);
    }
  }
  assert.equal(reloadCues(2).filter((c) => c.kind === 'shell').length, WEAPONS[2].magSize, 'one click per shotgun shell');
});
