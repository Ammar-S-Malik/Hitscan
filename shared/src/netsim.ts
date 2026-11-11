/**
 * A network simulator: delays, jitters and drops messages. It works on any clock through the
 * small `Scheduler` interface, so tests run on a virtual clock (fast and exactly repeatable)
 * and the browser runs it on real timers (`?lag=100&jitter=20&loss=5` in the address).
 */

export interface LinkConfig {
  latencyMs: number; // base one-way delay
  jitterMs: number; // each message's delay varies by up to this much either way
  loss: number; // 0..1, chance that a message is dropped
  ordered?: boolean; // true: messages never overtake each other (like TCP). Default false (like UDP)
}

export interface Scheduler {
  now(): number; // milliseconds
  after(ms: number, fn: () => void): void;
}

/** Small deterministic random generator, so a test can replay the exact same bad network. */
export function createRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A clock you move by hand. Events run in time order, ties in the order they were scheduled. */
export class VirtualClock implements Scheduler {
  private time = 0;
  private counter = 0;
  private events: { time: number; order: number; fn: () => void }[] = [];

  now(): number {
    return this.time;
  }

  at(time: number, fn: () => void): void {
    const e = { time: Math.max(time, this.time), order: this.counter++, fn };
    let i = this.events.length;
    while (i > 0 && this.events[i - 1].time > e.time) i--;
    this.events.splice(i, 0, e);
  }

  after(ms: number, fn: () => void): void {
    this.at(this.time + ms, fn);
  }

  /** Run everything scheduled up to `time`, then leave the clock there. */
  advanceTo(time: number): void {
    while (this.events.length > 0 && this.events[0].time <= time) {
      const e = this.events.shift()!;
      this.time = e.time;
      e.fn();
    }
    if (time > this.time) this.time = time;
  }
}

/** One direction of a link. Messages go in with `send` and come out of `deliver` later, or never. */
export class DelayLine<T> {
  config: LinkConfig; // change it while running to improve or worsen the network
  sent = 0;
  dropped = 0;
  delivered = 0;
  private lastArrival = 0;
  private rand: () => number;
  private scheduler: Scheduler;
  private deliver: (msg: T) => void;

  constructor(config: LinkConfig, rand: () => number, scheduler: Scheduler, deliver: (msg: T) => void) {
    this.config = config;
    this.rand = rand;
    this.scheduler = scheduler;
    this.deliver = deliver;
  }

  send(msg: T): void {
    this.sent++;
    const c = this.config;
    if (this.rand() < c.loss) {
      this.dropped++;
      return;
    }
    const now = this.scheduler.now();
    let arrival = now + Math.max(0, c.latencyMs + (this.rand() * 2 - 1) * c.jitterMs);
    if (c.ordered && arrival < this.lastArrival) arrival = this.lastArrival;
    this.lastArrival = arrival;
    this.scheduler.after(arrival - now, () => {
      this.delivered++;
      this.deliver(msg);
    });
  }
}
