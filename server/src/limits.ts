/**
 * A token bucket that refills once per server tick (so tests are exact and nothing depends on the
 * wall clock). `take()` spends one token: false means the sender is over its limit and the message
 * should be dropped.
 */
export class TickBucket {
  private tokens: number;
  private readonly capacity: number;
  private readonly perTick: number;

  constructor(capacity: number, perSecond: number, ticksPerSecond: number) {
    this.capacity = capacity;
    this.perTick = perSecond / ticksPerSecond;
    this.tokens = capacity;
  }

  refill(): void {
    this.tokens = Math.min(this.capacity, this.tokens + this.perTick);
  }

  take(): boolean {
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}

/** Abuse limits, in one place. */
export const LIMITS = {
  gameBurst: 180, // binary game packets a connection may send in a burst
  gamePerSecond: 90, // and per second sustained (a normal client sends 60)
  textBurst: 20, // lobby messages in a burst
  textPerSecond: 5, // and per second sustained
  strikesPerSecond: 120, // dropped messages in one second after which the connection is closed
  maxPerIp: 6, // connections from one address
} as const;
