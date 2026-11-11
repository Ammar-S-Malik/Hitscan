/**
 * Runs the real GameServer and the real client-side Predictor/Interpolator against each other over
 * a simulated network, on a virtual clock. Nothing here is mocked except the wire and time.
 */
import {
  DT, DelayLine, Interpolator, NET, Predictor, VirtualClock, createRng, decodeServerMessage,
} from '@hitscan/shared';
import type { GameMap, Input, LinkConfig } from '@hitscan/shared';
import { GameServer } from '../src/game.ts';

export const TICK_MS = 1000 / 60;

export class SimClient {
  id = -1;
  predictor: Predictor | null = null;
  interp = new Interpolator(NET.interpDelay);
  corrections: number[] = [];
  snapshotsSeen = 0;
  up: DelayLine<Uint8Array>;
  down: DelayLine<Uint8Array>;
  inputFor: (tick: number) => Input;
  ticks = 0;
  /** Set false to make the client stop sending (and predicting). */
  active = true;

  private world: SimWorld;

  constructor(world: SimWorld, link: LinkConfig, rand: () => number, inputFor: (tick: number) => Input) {
    this.world = world;
    this.inputFor = inputFor;
    this.down = new DelayLine<Uint8Array>({ ...link }, rand, world.clock, (bytes) => this.receive(bytes));
    this.up = new DelayLine<Uint8Array>({ ...link }, rand, world.clock, (bytes) => world.server.onMessage(this.id, bytes));
    const id = world.server.connect({
      send: (bytes) => this.down.send(bytes),
      close: () => undefined,
    });
    if (id === null) throw new Error('server full');
    this.id = id;
  }

  setLink(link: Partial<LinkConfig>): void {
    Object.assign(this.up.config, link);
    Object.assign(this.down.config, link);
  }

  private receive(bytes: Uint8Array): void {
    const m = decodeServerMessage(bytes);
    if (!m || m.kind !== 'snapshot') return;
    const snap = m.snapshot;
    this.snapshotsSeen++;
    if (!this.predictor) {
      this.predictor = new Predictor(this.world.map.boxes, snap.own);
    } else {
      this.predictor.onSnapshot(snap);
      this.corrections.push(this.predictor.lastCorrection);
    }
    this.interp.push(snap.tick * DT, snap.others, this.world.clock.now());
  }

  tick(): void {
    if (!this.active || !this.predictor) return;
    const pkt = this.predictor.tick(this.inputFor(this.ticks++));
    this.up.send(pkt);
  }
}

export class SimWorld {
  clock = new VirtualClock();
  map: GameMap;
  server: GameServer;
  clients: SimClient[] = [];
  /** Every client tick and the server tick run on their own offsets, like real unsynchronised clocks. */
  private serverOffset: number;
  rand: () => number;

  constructor(map: GameMap, seed = 1, serverOffsetMs = 5) {
    this.map = map;
    this.server = new GameServer({ map });
    this.rand = createRng(seed);
    this.serverOffset = serverOffsetMs;
    const loop = (k: number): void => {
      this.server.update();
      this.clock.at(this.serverOffset + (k + 1) * TICK_MS, () => loop(k + 1));
    };
    this.clock.at(this.serverOffset, () => loop(0));
  }

  addClient(link: LinkConfig, inputFor: (tick: number) => Input, startOffsetMs = 0): SimClient {
    const c = new SimClient(this, link, this.rand, inputFor);
    this.clients.push(c);
    const loop = (k: number): void => {
      c.tick();
      this.clock.at(startOffsetMs + (k + 1) * TICK_MS, () => loop(k + 1));
    };
    this.clock.at(startOffsetMs, () => loop(0));
    return c;
  }

  run(seconds: number): void {
    this.clock.advanceTo(this.clock.now() + seconds * 1000);
  }
}
