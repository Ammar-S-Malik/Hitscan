/**
 * Entity interpolation for the other players.
 *
 * Snapshots arrive about 30 times a second, unevenly. Drawing each one the moment it arrives would
 * look jerky, so other players are drawn `delay` seconds in the past, blended between the two
 * snapshots on either side of that moment. There is then almost always a snapshot ahead to blend
 * toward, so the motion stays smooth. Nothing is extrapolated: if snapshots stop, players freeze.
 */
import type { RemotePlayer } from './protocol.ts';

interface Frame {
  time: number; // server time in seconds
  players: RemotePlayer[];
}

const MAX_FRAMES = 64;

function lerpAngle(a: number, b: number, t: number): number {
  const tau = Math.PI * 2;
  const d = ((((b - a + Math.PI) % tau) + tau) % tau) - Math.PI; // shortest way round
  return a + d * t;
}

export class Interpolator {
  readonly delay: number;
  private frames: Frame[] = [];
  /** Estimated (server time - local time) in seconds. */
  private offset = 0;
  private haveOffset = false;

  constructor(delay: number) {
    this.delay = delay;
  }

  /** Record a snapshot. `serverTime` is in seconds, `arrivalMs` is the local clock when it arrived. */
  push(serverTime: number, players: readonly RemotePlayer[], arrivalMs: number): void {
    const last = this.frames[this.frames.length - 1];
    if (last && serverTime <= last.time) return; // old or duplicate
    this.frames.push({ time: serverTime, players: players.slice() });
    if (this.frames.length > MAX_FRAMES) this.frames.shift();

    // A snapshot's delay is jitter plus the true latency, so the least-delayed snapshots show the
    // true clock offset: jump to a better estimate at once, and drift to a worse one slowly.
    const candidate = serverTime - arrivalMs / 1000;
    if (!this.haveOffset) {
      this.offset = candidate;
      this.haveOffset = true;
    } else if (candidate > this.offset) {
      this.offset = candidate;
    } else {
      this.offset += (candidate - this.offset) * 0.02;
    }
  }

  /** The other players as they should be drawn at local time `nowMs`. */
  sample(nowMs: number): { renderTime: number; players: RemotePlayer[] } {
    const frames = this.frames;
    if (frames.length === 0) return { renderTime: 0, players: [] };
    const first = frames[0];
    const last = frames[frames.length - 1];
    const rt = nowMs / 1000 + this.offset - this.delay;
    if (rt >= last.time) return { renderTime: last.time, players: last.players.slice() };
    if (rt <= first.time) return { renderTime: first.time, players: first.players.slice() };

    let b = 1;
    while (frames[b].time <= rt) b++;
    const fa = frames[b - 1];
    const fb = frames[b];
    if (b > 8) frames.splice(0, b - 8); // forget frames we will never need again

    const alpha = (rt - fa.time) / (fb.time - fa.time);
    const before = new Map<number, RemotePlayer>();
    for (const p of fa.players) before.set(p.id, p);
    const out: RemotePlayer[] = [];
    for (const q of fb.players) {
      const p = before.get(q.id);
      if (!p) {
        out.push({ ...q }); // just appeared: nothing to blend from
        continue;
      }
      out.push({
        id: q.id,
        x: p.x + (q.x - p.x) * alpha,
        y: p.y + (q.y - p.y) * alpha,
        z: p.z + (q.z - p.z) * alpha,
        yaw: lerpAngle(p.yaw, q.yaw, alpha),
        sliding: alpha < 0.5 ? p.sliding : q.sliding,
        grounded: alpha < 0.5 ? p.grounded : q.grounded,
      });
    }
    return { renderTime: rt, players: out };
  }
}
