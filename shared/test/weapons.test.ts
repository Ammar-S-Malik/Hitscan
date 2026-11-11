import test from 'node:test';
import assert from 'node:assert/strict';
import { COMBAT, WEAPONS } from '../src/config.ts';
import { aimDirection, pelletDamage, pelletDirections, shotSeed, weaponOf } from '../src/hitscan.ts';

const angleBetween = (a: number[], b: number[]) => Math.acos(Math.max(-1, Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2])));

test('the weapon table is sane: five guns, aiming never worsens accuracy, only the sniper has a scope', () => {
  assert.equal(WEAPONS.length, 5);
  assert.deepStrictEqual(WEAPONS.map((w) => w.name), ['Pistol', 'SMG', 'Shotgun', 'Rifle', 'Sniper']);
  for (const w of WEAPONS) {
    assert.ok(w.damage > 0 && w.pellets >= 1 && w.intervalTicks >= 1, w.name);
    assert.ok(w.adsSpread <= w.spread, `${w.name}: aiming is at least as accurate`);
    assert.ok(w.falloffEnd > w.falloffStart && w.falloffMin > 0 && w.falloffMin <= 1, w.name);
    assert.ok(w.headMultiplier >= 1 && w.adsFov > 0 && w.adsFov < 75, w.name);
    assert.ok(w.damage * w.pellets * w.headMultiplier >= 1, w.name);
  }
  assert.deepStrictEqual(WEAPONS.filter((w) => w.scope).map((w) => w.name), ['Sniper']);
  assert.ok(WEAPONS[2].pellets > 1 && WEAPONS.filter((w) => w.pellets > 1).length === 1, 'only the shotgun has pellets');
});

test('every gun has a role: time to kill is distinct, the sniper one-shots to the head but not to the body', () => {
  const sniper = WEAPONS[4];
  assert.ok(pelletDamage(sniper, 20, true) >= COMBAT.maxHealth, 'a sniper head shot kills');
  assert.ok(pelletDamage(sniper, 20, false) < COMBAT.maxHealth, 'a sniper body shot does not');
  const shotgun = WEAPONS[2];
  const point = shotgun.pellets * pelletDamage(shotgun, 3, false);
  assert.ok(point >= COMBAT.maxHealth * 0.85, `a point-blank shotgun blast does ${point}`);
  assert.ok(shotgun.pellets * pelletDamage(shotgun, 40, false) < COMBAT.maxHealth * 0.3, 'but is weak from afar');
  const ttk = (i: number) => Math.ceil(COMBAT.maxHealth / pelletDamage(WEAPONS[i], 8, false)) * WEAPONS[i].intervalTicks;
  assert.ok(ttk(1) > 0 && ttk(3) > 0);
});

test('damage falls off with distance, never below the minimum, head shots multiply', () => {
  for (const w of WEAPONS) {
    let last = Infinity;
    for (let d = 0; d <= 200; d += 5) {
      const dmg = pelletDamage(w, d, false);
      assert.ok(dmg <= last, `${w.name} damage never rises with distance`);
      assert.ok(dmg >= Math.round(w.damage * w.falloffMin) - 1);
      last = dmg;
    }
    assert.equal(pelletDamage(w, 0, false), w.damage);
    assert.equal(pelletDamage(w, 0, true), Math.round(w.damage * w.headMultiplier));
  }
});

test('pellet directions: unit length, right count, repeatable from a seed, different for other seeds', () => {
  for (const w of WEAPONS) {
    const a = pelletDirections(w, 0.7, 0.2, false, 1234);
    const b = pelletDirections(w, 0.7, 0.2, false, 1234);
    const c = pelletDirections(w, 0.7, 0.2, false, 1235);
    assert.equal(a.length, w.pellets);
    assert.deepStrictEqual(a, b, `${w.name} is repeatable`);
    for (const d of a) assert.ok(Math.abs(Math.hypot(d[0], d[1], d[2]) - 1) < 1e-9);
    assert.notDeepStrictEqual(a, c, `${w.name} varies with the seed`);
  }
  const shotgun = pelletDirections(WEAPONS[2], 0, 0, false, 9);
  assert.equal(new Set(shotgun.map((d) => d.join(','))).size, 8, 'every pellet goes its own way');
});

test('pellets stay inside the cone, aiming narrows it, and zero spread is exactly where you look', () => {
  for (const [i, w] of WEAPONS.entries()) {
    const aim = aimDirection(1.1, -0.3);
    let worstHip = 0;
    let worstAds = 0;
    for (let seed = 1; seed <= 400; seed++) {
      for (const d of pelletDirections(w, 1.1, -0.3, false, seed)) worstHip = Math.max(worstHip, angleBetween(d, aim));
      for (const d of pelletDirections(w, 1.1, -0.3, true, seed)) worstAds = Math.max(worstAds, angleBetween(d, aim));
    }
    assert.ok(worstHip <= w.spread + 1e-9, `${w.name} hip ${worstHip}`);
    assert.ok(worstAds <= w.adsSpread + 1e-9, `${w.name} ads ${worstAds}`);
    if (w.adsSpread > 0 && w.adsSpread < w.spread) assert.ok(worstAds < worstHip, `${w.name}: aiming tightens the spread (${i})`);
    if (w.spread > 0.005) assert.ok(worstHip > w.spread * 0.8, `${w.name} actually uses its cone`);
  }
  const exact = pelletDirections(WEAPONS[4], 0.4, 0.1, true, 5)[0];
  assert.deepStrictEqual(exact, aimDirection(0.4, 0.1));
});

test('spread is spread out: pellets fill the cone rather than clumping at the edge or the middle', () => {
  const w = WEAPONS[2];
  const aim = aimDirection(0, 0);
  let inner = 0;
  let total = 0;
  for (let seed = 1; seed <= 2000; seed++) {
    for (const d of pelletDirections(w, 0, 0, false, seed)) {
      total++;
      if (angleBetween(d, aim) < w.spread / 2) inner++;
    }
  }
  const share = inner / total; // a uniform disc has a quarter of its area inside half the radius
  assert.ok(share > 0.2 && share < 0.3, `inner share ${share}`);
});

test('shot seeds differ by input number and by player', () => {
  const seeds = new Set<number>();
  for (let seq = 1; seq <= 500; seq++) for (let id = 1; id <= 4; id++) seeds.add(shotSeed(seq, id));
  assert.equal(seeds.size, 2000);
  assert.equal(weaponOf(99).name, 'Pistol');
});
