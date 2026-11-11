/**
 * The reload animations, as pure functions: given a gun and how far through its reload you are
 * (0 to 1), say where everything is. The view model applies the result to the gun model and the
 * hands, so this file has no drawing code and can be tested on its own.
 *
 * Offsets are in metres, in the gun's own space: x right, y up, z toward the shooter (the guns point
 * down -z, so +z is "back"). Every pose starts and ends at NEUTRAL, so there is no jump when a reload
 * begins or ends.
 */

export interface Pose {
  /** The whole gun: tilt and shift. */
  rotX: number;
  rotZ: number;
  x: number;
  y: number;
  z: number;
  /** How far each hand is from where it rests on the gun. */
  left: [number, number, number];
  right: [number, number, number];
  /** The magazine: pulled down by magDy and hidden while a fresh one is fetched. */
  magDy: number;
  magShown: boolean;
  /** Slide / charging handle / bolt, pulled toward the shooter, and lifted for a bolt-action. */
  boltBack: number;
  boltLift: number;
  /** The shotgun's pump, pulled toward the shooter. */
  pumpBack: number;
  /** A shell or round is in the left hand (shotgun and sniper). */
  shell: boolean;
}

export const NEUTRAL: Pose = {
  rotX: 0, rotZ: 0, x: 0, y: 0, z: 0,
  left: [0, 0, 0], right: [0, 0, 0],
  magDy: 0, magShown: true, boltBack: 0, boltLift: 0, pumpBack: 0, shell: false,
};

const clamp01 = (v: number): number => Math.max(0, Math.min(1, v));
/** 0 before `a`, 1 after `b`, a smooth ramp between. */
const seg = (p: number, a: number, b: number): number => {
  const t = clamp01((p - a) / (b - a));
  return t * t * (3 - 2 * t);
};
/** Ramps up over a..b, holds, ramps down over c..d. */
const trap = (p: number, a: number, b: number, c: number, d: number): number => seg(p, a, b) * (1 - seg(p, c, d));
/** Up over a..b and back down over b..c. */
const pulse = (p: number, a: number, b: number, c: number): number => seg(p, a, b) * (1 - seg(p, b, c));
const scale = (v: [number, number, number], k: number): [number, number, number] => [v[0] * k, v[1] * k, v[2] * k];

/** Where the magazine is relative to the left hand's resting place, for the guns that take a magazine. */
const MAG_REACH: Record<number, [number, number, number]> = {
  0: [0.02, -0.02, 0.05], // pistol
  1: [0, -0.04, 0.14], // SMG
  3: [0, -0.08, 0.29], // rifle
};
/** Where the left hand goes to load a shell or a round, relative to its resting place. */
const PORT_REACH: Record<number, [number, number, number]> = {
  2: [0, 0.0, 0.26], // shotgun: the loading port under the receiver
  4: [0, 0.02, 0.33], // sniper: the open action
};

/** Pistol, SMG and rifle: tilt the gun, pull the magazine, fetch a new one, seat it, work the slide. */
function magazineGun(weapon: number, p: number): Pose {
  const tilt = trap(p, 0, 0.16, 0.82, 0.98);
  const reach = MAG_REACH[weapon] ?? MAG_REACH[3];
  const hold = trap(p, 0.06, 0.2, 0.7, 0.82); // the left hand is on the magazine

  let magDy: number;
  if (p < 0.2) magDy = 0;
  else if (p < 0.38) magDy = -0.22 * seg(p, 0.2, 0.38); // pulled out
  else if (p < 0.52) magDy = -0.22 - 0.1 * seg(p, 0.38, 0.52); // thrown away, hand goes for a new one
  else magDy = -0.32 * (1 - seg(p, 0.52, 0.7)); // the new one comes up
  const slap = pulse(p, 0.68, 0.72, 0.8); // seating it
  const rack = pulse(p, 0.82, 0.88, 0.94); // working the slide or charging handle

  return {
    rotX: 0.18 * tilt - 0.05 * slap,
    rotZ: -0.32 * tilt,
    x: -0.02 * tilt,
    y: -0.03 * tilt,
    z: 0.025 * slap + 0.015 * rack,
    left: [reach[0] * hold, (reach[1] + magDy) * hold, reach[2] * hold],
    right: [0, 0.008 * slap, 0],
    magDy,
    magShown: !(p > 0.38 && p < 0.52),
    boltBack: 0.045 * rack,
    boltLift: 0,
    pumpBack: 0,
    shell: false,
  };
}

/** Shotgun: cant the gun, push six shells into the port one at a time, then pump it. */
function shotgun(p: number): Pose {
  const tilt = trap(p, 0, 0.1, 0.8, 0.92);
  const port = PORT_REACH[2];
  const load = trap(p, 0.04, 0.12, 0.7, 0.78);
  const inWindow = p > 0.12 && p < 0.72;
  const ph = inWindow ? (((p - 0.12) / 0.6) * 6) % 1 : 0; // 0 at the port, 0.5 down at the shells, 1 back at the port
  const dip = inWindow ? Math.sin(Math.PI * ph) : 0;
  const pump = pulse(p, 0.78, 0.86, 0.94);
  const gripPump = trap(p, 0.72, 0.78, 0.94, 1.0);
  return {
    rotX: 0.2 * tilt,
    rotZ: -0.5 * tilt,
    x: -0.03 * tilt,
    y: -0.02 * tilt,
    z: 0.02 * pump,
    left: [
      port[0] * load,
      port[1] * load - 0.12 * dip * load,
      port[2] * load + 0.1 * pump * gripPump,
    ],
    right: [0, 0, 0],
    magDy: 0,
    magShown: true,
    boltBack: 0,
    boltLift: 0,
    pumpBack: 0.1 * pump,
    shell: load > 0.5 && inWindow && ph > 0.45,
  };
}

/** Sniper: open the bolt, feed in rounds one at a time, close the bolt. */
function sniper(p: number): Pose {
  const tilt = trap(p, 0, 0.1, 0.85, 0.97);
  const lift = seg(p, 0.12, 0.22) * (1 - seg(p, 0.84, 0.92));
  const back = seg(p, 0.22, 0.34) * (1 - seg(p, 0.76, 0.86));
  const onBolt = trap(p, 0.04, 0.12, 0.92, 0.98); // the right hand works the bolt
  const port = PORT_REACH[4];
  const load = trap(p, 0.3, 0.38, 0.72, 0.8);
  const inWindow = p > 0.38 && p < 0.72;
  const ph = inWindow ? (((p - 0.38) / 0.34) * 4) % 1 : 0;
  const dip = inWindow ? Math.sin(Math.PI * ph) : 0;
  return {
    rotX: 0.12 * tilt,
    rotZ: -0.28 * tilt,
    x: -0.015 * tilt,
    y: -0.02 * tilt,
    z: 0,
    left: [port[0] * load, port[1] * load - 0.1 * dip * load, port[2] * load],
    right: [0.05 * onBolt, (0.12 + 0.035 * lift) * onBolt, (-0.03 + 0.09 * back) * onBolt],
    magDy: 0,
    magShown: true,
    boltBack: 0.09 * back,
    boltLift: 0.035 * lift,
    pumpBack: 0,
    shell: load > 0.5 && inWindow && ph > 0.45,
  };
}

/** The pose of `weapon` (an index into WEAPONS) at `progress` (0 = reload just started, 1 = done). */
export function reloadPose(weapon: number, progress: number): Pose {
  const p = clamp01(progress);
  if (weapon === 2) return shotgun(p);
  if (weapon === 4) return sniper(p);
  return magazineGun(weapon, p);
}

/**
 * The moments (as fractions of the reload) at which each gun makes a sound, so the audio lines up with the animation.
 * `kind` picks the sound: out (magazine release), in (seated), rack (slide or pump), shell (a round dropping in), bolt.
 */
export function reloadCues(weapon: number): Array<{ at: number; kind: 'out' | 'in' | 'rack' | 'shell' | 'bolt' }> {
  if (weapon === 2) {
    const cues: Array<{ at: number; kind: 'shell' | 'rack' }> = [];
    for (let i = 0; i < 6; i++) cues.push({ at: 0.12 + (i + 0.95) * 0.1, kind: 'shell' });
    cues.push({ at: 0.82, kind: 'rack' }, { at: 0.9, kind: 'rack' });
    return cues;
  }
  if (weapon === 4) {
    const cues: Array<{ at: number; kind: 'shell' | 'bolt' }> = [{ at: 0.17, kind: 'bolt' }, { at: 0.3, kind: 'bolt' }];
    for (let i = 0; i < 4; i++) cues.push({ at: 0.38 + (i + 0.95) * 0.085, kind: 'shell' });
    cues.push({ at: 0.8, kind: 'bolt' }, { at: 0.9, kind: 'bolt' });
    return cues;
  }
  return [
    { at: 0.3, kind: 'out' },
    { at: 0.7, kind: 'in' },
    { at: 0.85, kind: 'rack' },
    { at: 0.93, kind: 'rack' },
  ];
}
