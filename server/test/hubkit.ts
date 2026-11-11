/** Shared helpers for the hub tests: a fake connection, a scripted player, and a tick runner. */
import { decodeServerMessage, encodeInputPacket, parseServerMessage, quantizeInput } from '@hitscan/shared';
import type { GameMap, Input, ServerMessage, ServerMsg } from '@hitscan/shared';
import { Hub } from '../src/hub.ts';
import type { HubConnection } from '../src/hub.ts';
import { IDLE, box } from '../../shared/test/helpers.ts';

export function flat(maxPlayers = 4, gap = 10): GameMap {
  return {
    name: 'Flat', size: 'small', maxPlayers,
    bounds: { min: [-100, -1, -300], max: [100, 20, 100] },
    boxes: [box([-100, -1, -300], [100, 0, 100], 'floor')],
    spawns: [{ x: 0, y: 0, z: 0, yaw: 0 }, { x: 0, y: 0, z: -gap, yaw: 0 }, { x: 8, y: 0, z: 0, yaw: 0 }, { x: -8, y: 0, z: 0, yaw: 0 }],
  };
}

export class Link implements HubConnection {
  texts: ServerMsg[] = [];
  binary: ServerMessage[] = [];
  closed: string | null = null;
  send(b: Uint8Array): void {
    const m = decodeServerMessage(b);
    if (m) this.binary.push(m);
  }
  sendText(t: string): void {
    const m = parseServerMessage(t);
    if (m) this.texts.push(m);
  }
  close(reason?: string): void {
    this.closed = reason ?? '';
  }
  last<T extends ServerMsg['t']>(t: T): Extract<ServerMsg, { t: T }> | undefined {
    for (let i = this.texts.length - 1; i >= 0; i--) if (this.texts[i].t === t) return this.texts[i] as Extract<ServerMsg, { t: T }>;
    return undefined;
  }
  get snapshots() {
    return this.binary.flatMap((m) => (m.kind === 'snapshot' ? [m.snapshot] : []));
  }
  get events() {
    return this.binary.flatMap((m) => (m.kind === 'events' ? m.events : []));
  }
}

export class Player {
  link = new Link();
  id: number;
  seq = 0;
  hub: Hub;
  constructor(hub: Hub, name: string, ip = '1.1.1.1') {
    this.hub = hub;
    const id = hub.connect(this.link, ip);
    if (id === null) throw new Error('connection refused');
    this.id = id;
    this.say({ t: 'hello', name });
  }
  say(msg: object): void {
    this.hub.onText(this.id, JSON.stringify(msg));
  }
  input(patch: Partial<Input> = {}): void {
    this.seq++;
    this.hub.onBinary(this.id, encodeInputPacket([{ seq: this.seq, input: quantizeInput({ ...IDLE, ...patch }) }]));
  }
}

/** Run the hub for n ticks, every listed player sending one input per tick. */
export function run(hub: Hub, players: Player[], n: number, patch: (p: Player, tick: number) => Partial<Input> = () => ({})): void {
  for (let i = 0; i < n; i++) {
    for (const p of players) p.input(patch(p, i));
    hub.update();
  }
}

export const newHub = (opts: { maxPlayers?: number; maxMatches?: number; maxPerIp?: number } = {}) =>
  new Hub({ maps: [flat(opts.maxPlayers)], maxMatches: opts.maxMatches, maxPerIp: opts.maxPerIp });
