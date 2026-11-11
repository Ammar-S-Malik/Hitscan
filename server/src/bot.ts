/**
 * The brain of one AI opponent. It is a pure function of what it can see, run once per tick: it
 * looks at the world the same way a player would (walls block its line of sight), decides where to
 * look, where to move and whether to pull the trigger, and returns an ordinary `Input`.
 *
 * The bot never gets any special powers. Its input goes through the same `step()` and the same
 * shot resolution as a human's, so it is limited by the same speeds, spread and fire rates.
 * Difficulty only changes how quickly it reacts, how fast it can turn, how much it misses by and
 * how smartly it picks guns and moves.
 */
import { WEAPONS, createRng, eyeHeight, traceWorld } from '@hitscan/shared';
import type { Box, Input, PlayerState, Spawn, Vec3 } from '@hitscan/shared';

export type Difficulty = 'easy' | 'normal' | 'hard';
export const DIFFICULTIES: readonly Difficulty[] = ['easy', 'normal', 'hard'];

interface Skill {
  reaction: number; // ticks between spotting an enemy and the first shot
  turnRate: number; // fastest the view may turn, radians per second
  snap: number; // share of the remaining angle closed every tick while tracking
  aimError: number; // radians of aim wobble, re-rolled every few ticks
  headBias: number; // 0..1: how often it goes for the head
  sight: number; // metres it can pick out an enemy at
  hunt: number; // chance that a patrol leg heads for the nearest enemy
  burst: boolean; // automatic guns fire in short bursts instead of one long spray
  ads: boolean; // aims down sights at range
  hop: number; // chance per tick of a hop mid-fight
  memory: number; // ticks it keeps chasing where it last saw someone
}

const SKILLS: Record<Difficulty, Skill> = {
  easy: { reaction: 38, turnRate: 3.2, snap: 0.06, aimError: 0.075, headBias: 0, sight: 35, hunt: 0.25, burst: true, ads: false, hop: 0, memory: 120 },
  normal: { reaction: 20, turnRate: 6, snap: 0.11, aimError: 0.04, headBias: 0.25, sight: 55, hunt: 0.5, burst: true, ads: true, hop: 0.004, memory: 240 },
  hard: { reaction: 9, turnRate: 11, snap: 0.2, aimError: 0.016, headBias: 0.6, sight: 85, hunt: 0.75, burst: false, ads: true, hop: 0.008, memory: 360 },
};

/** What a bot knows about another player that is alive. */
export interface Enemy {
  id: number;
  x: number;
  y: number;
  z: number; // feet
  sliding: boolean;
}

/** Gun indexes, as in WEAPONS. */
const SHOTGUN = 2;
const SNIPER = 4;

const IDEAL_RANGE = [15, 12, 6, 22, 40]; // where the bot likes to stand for each gun
const MAX_RANGE = [50, 40, 22, 80, 150]; // it won't pull the trigger beyond this

function wrap(a: number): number {
  const tau = Math.PI * 2;
  return ((((a + Math.PI) % tau) + tau) % tau) - Math.PI;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/** True if nothing solid is between the two points. */
function clearLine(from: Vec3, to: Vec3, boxes: readonly Box[]): boolean {
  const dx = to[0] - from[0];
  const dy = to[1] - from[1];
  const dz = to[2] - from[2];
  const d = Math.hypot(dx, dy, dz);
  if (d < 0.05) return true;
  return traceWorld(from, [dx / d, dy / d, dz / d], boxes, d) >= d - 0.05;
}

export class Bot {
  private yaw: number;
  private pitch = 0;
  private rand: () => number;
  private skill: Skill;
  private difficulty: Difficulty;
  private ticks = 0;

  private weapon: number; // its class's primary gun; a bot never swaps

  private targetId = 0;
  private lostFor = 999; // ticks since we last saw anybody
  private reaction = 0;
  private aimHeight = 1.1;
  private errYaw = 0;
  private errPitch = 0;
  private errTimer = 0;
  private burst = 0; // >0: firing for this many more ticks; <0: resting
  private click = false;
  private lastSeen: { x: number; z: number } | null = null;
  private lastSeenAge = 0;

  private strafe = 1;
  private strafeTimer = 0;
  private steer = 1; // which way round an obstacle we prefer, so we don't dither
  private goal: { x: number; z: number; hunting: boolean } | null = null;
  private goalAge = 0;
  private stuckAt = { x: 0, z: 0, tick: 0 };
  private stuckCount = 0;
  private unstick = 0;
  private unstickAngle = 0;

  constructor(seed: number, difficulty: Difficulty, startYaw: number, primary: number) {
    this.weapon = primary;
    this.rand = createRng(seed);
    this.difficulty = difficulty;
    this.skill = SKILLS[difficulty];
    this.yaw = startYaw;
  }

  /**
   * The input for the next tick.
   * `enemies` are the other players that are alive; the bot only reacts to the ones it has a clear line to.
   */
  think(me: PlayerState, alive: boolean, enemies: readonly Enemy[], boxes: readonly Box[], spawns: readonly Spawn[], viewMs: number): Input {
    this.ticks++;
    const s = this.skill;
    if (!alive) {
      this.targetId = 0;
      this.goal = null;
      this.lastSeen = null;
      this.lostFor = 999;
      this.unstick = 0;
      this.burst = 0;
      return this.build(0, 0, false, false, false, false, viewMs);
    }

    const eye: Vec3 = [me.x, me.y + eyeHeight(me), me.z];

    // ---- who can we see?
    let best: Enemy | null = null;
    let bestScore = Infinity;
    for (const e of enemies) {
      const d = Math.hypot(e.x - me.x, e.y - me.y, e.z - me.z);
      if (d > s.sight) continue;
      const chest: Vec3 = [e.x, e.y + (e.sliding ? 0.5 : 1.1), e.z];
      const head: Vec3 = [e.x, e.y + (e.sliding ? 0.8 : 1.6), e.z];
      if (!clearLine(eye, chest, boxes) && !clearLine(eye, head, boxes)) continue;
      const score = e.id === this.targetId ? d * 0.6 : d; // stick with the current target unless another is much closer
      if (score < bestScore) {
        bestScore = score;
        best = e;
      }
    }

    let moveX = 0;
    let moveZ = 0;
    let jump = false;
    let sprint = false;
    let fire = false;
    let aim = false;
    let faceYaw: number | null = null; // where to look when nobody is in sight

    if (best) {
      // ---- fight
      if (best.id !== this.targetId || this.lostFor > 12) {
        this.targetId = best.id;
        this.reaction = s.reaction + Math.floor(this.rand() * 10);
        this.aimHeight = best.sliding ? 0.5 : this.rand() < s.headBias ? 1.6 : 1.1;
      } else if (this.reaction > 0) {
        this.reaction--;
      }
      this.lostFor = 0;
      this.lastSeen = { x: best.x, z: best.z };
      this.lastSeenAge = 0;
      this.goal = null;

      if (--this.errTimer <= 0) {
        this.errYaw = (this.rand() - 0.5) * 2 * s.aimError;
        this.errPitch = (this.rand() - 0.5) * 1.2 * s.aimError;
        this.errTimer = 8 + Math.floor(this.rand() * 14);
      }

      const ax = best.x - eye[0];
      const ay = best.y + this.aimHeight - eye[1];
      const az = best.z - eye[2];
      const flat = Math.hypot(ax, az);
      const dist = Math.hypot(ax, ay, az);

      const wantYaw = Math.atan2(-ax, -az) + this.errYaw;
      const wantPitch = Math.atan2(ay, flat) + this.errPitch;
      this.turnTo(wantYaw, wantPitch, s.snap, s.turnRate);

      const tol = Math.atan2(0.28, Math.max(dist, 1)) + 0.012;
      const aligned = Math.abs(wrap(wantYaw - this.yaw)) < tol && Math.abs(wantPitch - this.pitch) < tol;
      const inRange = dist < MAX_RANGE[this.weapon];
      let trigger = this.reaction <= 0 && aligned && inRange;
      if (trigger && s.burst && this.weapon !== SNIPER) {
        // Short bursts and pauses rather than holding the trigger down.
        if (this.burst === 0) this.burst = 6 + Math.floor(this.rand() * 12);
        const firing = this.burst > 0;
        if (this.burst > 0) {
          this.burst--;
          if (this.burst === 0) this.burst = -(this.difficulty === 'easy' ? 14 + Math.floor(this.rand() * 18) : 5 + Math.floor(this.rand() * 10));
        } else {
          this.burst++;
        }
        trigger = firing;
      }
      this.click = !this.click; // a gun that is not automatic needs a fresh click each shot
      fire = trigger && (WEAPONS[this.weapon].auto || this.click);
      aim = s.ads && dist > 16 && this.weapon !== SHOTGUN;

      // Movement: strafe, and close in or back off to the gun's comfortable range.
      if (--this.strafeTimer <= 0) {
        if (this.rand() < 0.65) this.strafe = -this.strafe;
        this.strafeTimer = 22 + Math.floor(this.rand() * 45);
      }
      const ux = ax / Math.max(flat, 1e-6);
      const uz = az / Math.max(flat, 1e-6);
      const ideal = IDEAL_RANGE[this.weapon];
      let fwd = 0;
      if (flat > ideal * 1.3) fwd = 1;
      else if (flat < ideal * 0.5) fwd = -0.8;
      let mx = -uz * this.strafe * 0.8;
      let mz = ux * this.strafe * 0.8;
      if (fwd > 0) {
        const r = this.route(me, best.x, best.z, boxes);
        mx += r.mx * fwd;
        mz += r.mz * fwd;
        jump = r.jump;
      } else {
        mx += ux * fwd;
        mz += uz * fwd;
      }
      const len = Math.hypot(mx, mz);
      if (len > 1e-6) {
        mx /= len;
        mz /= len;
        if (!this.passable(me, mx, mz, 1.3, boxes)) {
          this.strafe = -this.strafe; // blocked: go the other way
          mx = -uz * this.strafe;
          mz = ux * this.strafe;
          if (!this.passable(me, mx, mz, 1.3, boxes)) {
            mx = 0;
            mz = 0;
          }
        }
        moveX = mx;
        moveZ = mz;
      }
      if (s.hop > 0 && me.grounded && this.rand() < s.hop) jump = true;
    } else {
      // ---- nobody in sight
      this.lostFor++;
      if (this.lostFor > 12) this.targetId = 0;
      this.burst = 0;

      let gx: number;
      let gz: number;
      if (this.lastSeen && this.lastSeenAge < s.memory) {
        this.lastSeenAge++;
        gx = this.lastSeen.x;
        gz = this.lastSeen.z;
        if (Math.hypot(gx - me.x, gz - me.z) < 1.6) this.lastSeen = null;
      } else {
        this.lastSeen = null;
        this.goalAge++;
        const refresh = this.goal?.hunting ? 150 : 700;
        if (!this.goal || this.goalAge > refresh || Math.hypot(this.goal.x - me.x, this.goal.z - me.z) < 1.5) this.pickGoal(me, enemies, spawns);
        gx = this.goal!.x;
        gz = this.goal!.z;
      }
      const r = this.route(me, gx, gz, boxes);
      moveX = r.mx;
      moveZ = r.mz;
      jump = r.jump;
      sprint = true;
      if (moveX !== 0 || moveZ !== 0) faceYaw = Math.atan2(-moveX, -moveZ);
    }

    // ---- getting unstuck: if we are trying to move but going nowhere, shove off in a random direction
    if ((moveX !== 0 || moveZ !== 0) && this.ticks - this.stuckAt.tick >= 40) {
      const moved = Math.hypot(me.x - this.stuckAt.x, me.z - this.stuckAt.z);
      this.stuckAt = { x: me.x, z: me.z, tick: this.ticks };
      if (moved < 0.7 && !best) {
        this.stuckCount++;
        this.unstick = 30;
        this.unstickAngle = (this.rand() < 0.5 ? -1 : 1) * (1.2 + this.rand() * 1.6);
        if (this.stuckCount >= 3) {
          this.goal = null;
          this.lastSeen = null;
          this.stuckCount = 0;
        }
      } else if (moved >= 0.7) {
        this.stuckCount = 0;
      }
    }
    if (this.unstick > 0 && !best) {
      this.unstick--;
      const c = Math.cos(this.unstickAngle);
      const sn = Math.sin(this.unstickAngle);
      const rx = moveX * c - moveZ * sn;
      const rz = moveX * sn + moveZ * c;
      moveX = rx;
      moveZ = rz;
      if (this.unstick % 12 === 0) jump = true;
    }

    // Look where we are going (when not fighting), then turn the world-space move into forward / strafe.
    if (faceYaw !== null) this.turnTo(faceYaw, 0, 0.12, 6);
    const f = moveX * -Math.sin(this.yaw) + moveZ * -Math.cos(this.yaw);
    const sd = moveX * Math.cos(this.yaw) + moveZ * -Math.sin(this.yaw);
    return this.build(clamp(f, -1, 1), clamp(sd, -1, 1), jump && me.grounded, sprint, fire, aim, viewMs);
  }

  private build(forward: number, strafe: number, jump: boolean, sprint: boolean, fire: boolean, aim: boolean, viewMs: number): Input {
    return { forward, strafe, yaw: this.yaw, jump, sprint, slide: false, pitch: this.pitch, fire, weapon: this.weapon, aim, viewMs };
  }

  private turnTo(wantYaw: number, wantPitch: number, snap: number, maxRate: number): void {
    const maxStep = maxRate / 60;
    this.yaw = wrap(this.yaw + clamp(wrap(wantYaw - this.yaw) * snap, -maxStep, maxStep));
    this.pitch = clamp(this.pitch + clamp((wantPitch - this.pitch) * snap, -maxStep, maxStep), -1.3, 1.3);
  }

  private pickGoal(me: PlayerState, enemies: readonly Enemy[], spawns: readonly Spawn[]): void {
    this.goalAge = 0;
    if (enemies.length > 0 && this.rand() < this.skill.hunt) {
      let near = enemies[0];
      let nearD = Infinity;
      for (const e of enemies) {
        const d = Math.hypot(e.x - me.x, e.z - me.z);
        if (d < nearD) {
          nearD = d;
          near = e;
        }
      }
      this.goal = { x: near.x, z: near.z, hunting: true };
      return;
    }
    for (let i = 0; i < 6; i++) {
      const sp = spawns[Math.floor(this.rand() * spawns.length)];
      if (Math.hypot(sp.x - me.x, sp.z - me.z) > 6) {
        this.goal = { x: sp.x, z: sp.z, hunting: false };
        return;
      }
    }
    const sp = spawns[Math.floor(this.rand() * spawns.length)];
    this.goal = { x: sp.x, z: sp.z, hunting: false };
  }

  /** Can we walk `len` metres along (ux, uz) without hitting something or dropping off a ledge? */
  private passable(me: PlayerState, ux: number, uz: number, len: number, boxes: readonly Box[]): boolean {
    const waist: Vec3 = [me.x, me.y + 0.7, me.z];
    if (traceWorld(waist, [ux, 0, uz], boxes, len) < len * 0.98) return false;
    const ahead: Vec3 = [me.x + ux * Math.min(len, 1.2), me.y + 0.5, me.z + uz * Math.min(len, 1.2)];
    return traceWorld(ahead, [0, -1, 0], boxes, 3.2) < 3.2; // there is ground within about 2.7 m below
  }

  /** The direction to walk to get toward (gx, gz): straight if clear, else round the obstacle, hopping low ones. */
  private route(me: PlayerState, gx: number, gz: number, boxes: readonly Box[]): { mx: number; mz: number; jump: boolean } {
    const dx = gx - me.x;
    const dz = gz - me.z;
    if (Math.hypot(dx, dz) < 0.8) return { mx: 0, mz: 0, jump: false };
    const base = Math.atan2(dz, dx);
    const offsets = [0, 0.6, -0.6, 1.2, -1.2, 2.0, -2.0];
    for (const o of offsets) {
      const off = o * this.steer;
      const ux = Math.cos(base + off);
      const uz = Math.sin(base + off);
      if (this.passable(me, ux, uz, 1.8, boxes)) {
        if (o !== 0) this.steer = Math.sign(off) || 1;
        return { mx: ux, mz: uz, jump: false };
      }
      if (o === 0) {
        // Blocked at waist height but open at head height: a low crate, so hop onto it.
        const waist: Vec3 = [me.x, me.y + 0.7, me.z];
        const headO: Vec3 = [me.x, me.y + 1.75, me.z];
        const dir: Vec3 = [ux, 0, uz];
        const wallAt = traceWorld(waist, dir, boxes, 1.8);
        const headAt = traceWorld(headO, dir, boxes, 1.8);
        if (wallAt < 1.4 && headAt > wallAt + 0.7) return { mx: ux, mz: uz, jump: true };
      }
    }
    return { mx: Math.cos(base), mz: Math.sin(base), jump: true };
  }
}
