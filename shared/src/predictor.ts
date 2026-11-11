/**
 * Client-side prediction and reconciliation.
 *
 * The client applies its own inputs immediately (prediction) and sends them to the server.
 * The server replies with snapshots that say "the last input I applied was number N, and the
 * state after it is S". The client then throws away inputs up to N, restarts from S, and replays
 * the inputs the server hasn't seen yet (reconciliation). Because the simulation is a pure
 * function of the inputs, a perfect network gives a correction of exactly zero; any nonzero
 * correction means an input was lost or the server saw something the client didn't.
 */
import { NET } from './config.ts';
import type { Box } from './map.ts';
import { step } from './movement.ts';
import { encodeInputPacket, quantizeInput } from './protocol.ts';
import type { SeqInput, Snapshot } from './protocol.ts';
import type { Input, PlayerState } from './types.ts';

export class Predictor {
  prev: PlayerState; // the state one tick ago, for smooth drawing between ticks
  cur: PlayerState; // the predicted state right now
  /** A correction is not shown at once: this offset is added to the drawn position and fades away. */
  errX = 0;
  errY = 0;
  errZ = 0;
  lastCorrection = 0; // metres the last snapshot moved the predicted position
  lastSeq = 0; // sequence number of the newest input sent
  private pending: SeqInput[] = [];
  private lastSnapshotTick = -1;
  private boxes: readonly Box[];

  constructor(boxes: readonly Box[], start: PlayerState) {
    this.boxes = boxes;
    this.prev = start;
    this.cur = start;
  }

  get pendingCount(): number {
    return this.pending.length;
  }

  /** Apply one input locally and return the packet to send to the server. */
  tick(raw: Input): Uint8Array {
    const input = quantizeInput(raw);
    this.lastSeq++;
    this.pending.push({ seq: this.lastSeq, input });
    if (this.pending.length > NET.maxPending) this.pending.shift();
    this.prev = this.cur;
    this.cur = step(this.cur, input, this.boxes);
    return encodeInputPacket(this.pending.slice(-NET.inputRedundancy));
  }

  /** Take the server's word for where we were, then replay what it hasn't processed yet. */
  onSnapshot(snap: Snapshot): void {
    if (snap.tick <= this.lastSnapshotTick) return; // old or duplicate: snapshots can arrive out of order
    this.lastSnapshotTick = snap.tick;

    let i = 0;
    while (i < this.pending.length && this.pending[i].seq <= snap.ack) i++;
    if (i > 0) this.pending.splice(0, i);

    const before = this.cur;
    let prev = snap.own;
    let s = snap.own;
    for (const p of this.pending) {
      prev = s;
      s = step(s, p.input, this.boxes);
    }
    this.prev = prev;
    this.cur = s;

    const dx = before.x - s.x;
    const dy = before.y - s.y;
    const dz = before.z - s.z;
    const dist = Math.hypot(dx, dy, dz);
    this.lastCorrection = dist;
    if (dist > NET.snapDistance) {
      this.errX = this.errY = this.errZ = 0; // too big to smooth: just snap
    } else {
      // Keep drawing where we were; the offset fades out over the next few frames.
      this.errX += dx;
      this.errY += dy;
      this.errZ += dz;
    }
  }

  /** Fade out the visual correction. Call once per frame. */
  smoothErrors(dt: number): void {
    const k = Math.exp(-dt * NET.errorDecay);
    this.errX *= k;
    this.errY *= k;
    this.errZ *= k;
    if (Math.hypot(this.errX, this.errY, this.errZ) < 1e-4) this.errX = this.errY = this.errZ = 0;
  }

  /** Where to draw the player: between the last two ticks, plus any fading correction. */
  renderPosition(alpha: number): { x: number; y: number; z: number } {
    const { prev, cur } = this;
    return {
      x: prev.x + (cur.x - prev.x) * alpha + this.errX,
      y: prev.y + (cur.y - prev.y) * alpha + this.errY,
      z: prev.z + (cur.z - prev.z) * alpha + this.errZ,
    };
  }
}
