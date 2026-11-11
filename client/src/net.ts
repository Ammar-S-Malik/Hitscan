import { DelayLine } from '@hitscan/shared';

export interface NetOptions {
  offline: boolean; // ?offline  - skip the server and play alone, like Stage 1
  url: string; // ?server=ws://host:port  - default is port 8787 on the page's own host
  lagMs: number; // ?lag=100     - extra delay added to every message, each way
  jitterMs: number; // ?jitter=20  - each message's delay varies by up to this much
  lossPct: number; // ?loss=5     - percent of messages thrown away, each way
}

export function parseNetOptions(search: string, hostname: string): NetOptions {
  const q = new URLSearchParams(search);
  const num = (key: string): number => {
    const v = Number(q.get(key));
    return Number.isFinite(v) && v > 0 ? v : 0;
  };
  return {
    offline: q.has('offline'),
    url: q.get('server') ?? `ws://${hostname || 'localhost'}:8787`,
    lagMs: num('lag'),
    jitterMs: num('jitter'),
    lossPct: Math.min(100, num('loss')),
  };
}

export interface NetHandlers {
  onOpen(): void;
  onClose(): void;
  onMessage(bytes: Uint8Array): void;
}

/** A WebSocket to the game server, with an optional simulated bad network in both directions. */
export class NetClient {
  private ws: WebSocket | null = null;
  private up: DelayLine<Uint8Array> | null = null;
  private simulated: boolean;

  constructor(options: NetOptions, handlers: NetHandlers) {
    this.simulated = options.lagMs > 0 || options.jitterMs > 0 || options.lossPct > 0;
    const scheduler = {
      now: () => performance.now(),
      after: (ms: number, fn: () => void) => {
        setTimeout(fn, ms);
      },
    };
    const link = { latencyMs: options.lagMs, jitterMs: options.jitterMs, loss: options.lossPct / 100 };
    const down = new DelayLine<Uint8Array>(link, Math.random, scheduler, (bytes) => handlers.onMessage(bytes));
    this.up = new DelayLine<Uint8Array>(link, Math.random, scheduler, (bytes) => this.sendNow(bytes));

    try {
      this.ws = new WebSocket(options.url);
    } catch {
      setTimeout(() => handlers.onClose(), 0); // a malformed address: report it like any failed connection
      return;
    }
    const ws = this.ws;
    ws.binaryType = 'arraybuffer';
    ws.onopen = () => handlers.onOpen();
    ws.onclose = () => handlers.onClose();
    ws.onerror = () => undefined; // a close event always follows
    ws.onmessage = (ev: MessageEvent) => {
      if (!(ev.data instanceof ArrayBuffer)) return;
      const bytes = new Uint8Array(ev.data);
      if (this.simulated) down.send(bytes);
      else handlers.onMessage(bytes);
    };
  }

  send(bytes: Uint8Array): void {
    if (this.simulated && this.up) this.up.send(bytes);
    else this.sendNow(bytes);
  }

  private sendNow(bytes: Uint8Array): void {
    // Our packets are always built on a plain ArrayBuffer, which is what send() wants.
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(bytes as Uint8Array<ArrayBuffer>);
  }

  close(): void {
    this.ws?.close();
  }
}
