/**
 * The hub: every connected client, the lobby conversation, and the matches. Like GameServer it has no
 * networking of its own (the thin adapter in main.ts feeds it bytes and text), so tests drive it directly.
 */
import { LOBBY, TICK_RATE, parseClientMessage, sanitizeName } from '@hitscan/shared';
import type { GameMap, MatchInfo, ServerMsg } from '@hitscan/shared';
import { LIMITS, TickBucket } from './limits.ts';
import { Match } from './match.ts';

export interface HubConnection {
  send(bytes: Uint8Array): void;
  sendText(text: string): void;
  close(reason?: string): void;
}

export interface HubOptions {
  maps: GameMap[];
  maxMatches?: number;
  maxPerIp?: number;
}

interface Client {
  id: number;
  conn: HubConnection;
  ip: string;
  name: string | null; // null until the client has said hello
  match: Match | null;
  gameBucket: TickBucket;
  textBucket: TickBucket;
  strikes: number;
  lastSpokeTick: number;
}

export class Hub {
  tickCount = 0;
  private maps: GameMap[];
  private maxMatches: number;
  private maxPerIp: number;
  private clients = new Map<number, Client>();
  private matches = new Map<number, Match>();
  private nextClientId = 1;
  private nextMatchId = 1;

  constructor(opts: HubOptions) {
    if (opts.maps.length === 0) throw new Error('the hub needs at least one map');
    this.maps = opts.maps;
    this.maxMatches = opts.maxMatches ?? LOBBY.maxMatches;
    this.maxPerIp = opts.maxPerIp ?? LIMITS.maxPerIp;
  }

  get clientCount(): number {
    return this.clients.size;
  }

  get matchCount(): number {
    return this.matches.size;
  }

  get playerCount(): number {
    let n = 0;
    for (const m of this.matches.values()) n += m.size;
    return n;
  }

  /** A new connection. Returns its id, or null if this address already has too many. */
  connect(conn: HubConnection, ip = 'unknown'): number | null {
    let fromIp = 0;
    for (const c of this.clients.values()) if (c.ip === ip) fromIp++;
    if (fromIp >= this.maxPerIp) {
      conn.close('Too many connections from your address.');
      return null;
    }
    const id = this.nextClientId++;
    this.clients.set(id, {
      id, conn, ip, name: null, match: null,
      gameBucket: new TickBucket(LIMITS.gameBurst, LIMITS.gamePerSecond, TICK_RATE),
      textBucket: new TickBucket(LIMITS.textBurst, LIMITS.textPerSecond, TICK_RATE),
      strikes: 0,
      lastSpokeTick: this.tickCount,
    });
    return id;
  }

  disconnect(id: number): void {
    const c = this.clients.get(id);
    if (!c) return;
    this.leaveMatch(c);
    this.clients.delete(id);
  }

  /** Game packets (binary). Dropped unless the sender is in a match and within its rate limit. */
  onBinary(id: number, bytes: Uint8Array): void {
    const c = this.clients.get(id);
    if (!c) return;
    c.lastSpokeTick = this.tickCount;
    if (!c.gameBucket.take()) {
      this.strike(c);
      return;
    }
    c.match?.onBinary(id, bytes);
  }

  /** A lobby message (text). Anything malformed or over the rate limit is ignored. */
  onText(id: number, text: string): void {
    const c = this.clients.get(id);
    if (!c) return;
    c.lastSpokeTick = this.tickCount;
    if (!c.textBucket.take()) {
      this.strike(c);
      return;
    }
    const msg = parseClientMessage(text);
    if (!msg) return;

    if (msg.t === 'hello') {
      c.name = sanitizeName(msg.name, `Player ${c.id}`);
      this.say(c, { t: 'hello', name: c.name });
      this.say(c, { t: 'matches', list: this.list() });
      return;
    }
    if (c.name === null) {
      this.say(c, { t: 'error', message: 'Pick a nickname first.' });
      return;
    }
    switch (msg.t) {
      case 'list':
        this.say(c, { t: 'matches', list: this.list() });
        break;
      case 'leave':
        this.leaveMatch(c, 'You left the match.');
        break;
      case 'join': {
        const m = this.matches.get(msg.id);
        if (!m) this.say(c, { t: 'error', message: 'That match no longer exists.' });
        else if (m.isFull) this.say(c, { t: 'error', message: 'That match is full.' });
        else this.enter(c, m);
        break;
      }
      case 'quick': {
        const open = [...this.matches.values()].filter((m) => !m.isFull).sort((a, b) => b.size - a.size)[0];
        if (open) this.enter(c, open);
        else this.createAndEnter(c, '', LOBBY.defaultScoreLimit, LOBBY.defaultTimeLimit, '');
        break;
      }
      case 'create':
        this.createAndEnter(c, msg.name, msg.scoreLimit, msg.timeLimit, msg.map);
        break;
    }
  }

  /** Advance everything by one tick. */
  update(): void {
    this.tickCount++;
    for (const m of [...this.matches.values()]) m.update();
    for (const c of [...this.clients.values()]) {
      c.gameBucket.refill();
      c.textBucket.refill();
    }
    if (this.tickCount % TICK_RATE === 0) {
      for (const c of [...this.clients.values()]) {
        c.strikes = 0;
        // Someone sitting in the lobby saying nothing is probably gone; players in a match are watched by the game server.
        if (!c.match && this.tickCount - c.lastSpokeTick > LOBBY.lobbyIdleSeconds * TICK_RATE) {
          c.conn.close('Disconnected for inactivity.');
          this.disconnect(c.id);
        }
      }
    }
  }

  // ------------------------------------------------------------------ internals

  private strike(c: Client): void {
    c.strikes++;
    if (c.strikes >= LIMITS.strikesPerSecond) {
      c.conn.close('Disconnected: too many messages.');
      this.disconnect(c.id);
    }
  }

  private say(c: Client, msg: ServerMsg): void {
    c.conn.sendText(JSON.stringify(msg));
  }

  private list(): MatchInfo[] {
    return [...this.matches.values()].map((m) => m.info());
  }

  private createAndEnter(c: Client, name: string, scoreLimit: number, timeLimit: number, mapName: string): void {
    if (this.matches.size >= this.maxMatches) {
      this.say(c, { t: 'error', message: 'The server is busy: every match slot is taken. Try again in a minute.' });
      return;
    }
    // The map asked for, or a random one (preferring one that is not already being played).
    let map = this.maps.find((m) => m.name === mapName);
    if (!map) {
      const inUse = new Set([...this.matches.values()].map((m) => m.info().map));
      const fresh = this.maps.filter((m) => !inUse.has(m.name));
      const pool = fresh.length > 0 ? fresh : this.maps;
      map = pool[Math.floor(Math.random() * pool.length)];
    }
    const id = this.nextMatchId++;
    const match = new Match({
      id,
      name: name !== '' ? name : `${c.name}'s match`,
      map,
      scoreLimit,
      timeLimit,
      onKick: (clientId, reason) => {
        const k = this.clients.get(clientId);
        if (k) this.leaveMatch(k, reason);
      },
    });
    this.matches.set(id, match);
    this.enter(c, match);
  }

  private enter(c: Client, m: Match): void {
    this.leaveMatch(c); // switching matches: leave quietly first
    const joined = m.join(c.id, c.name ?? `Player ${c.id}`, {
      send: (bytes) => c.conn.send(bytes),
      sendText: (msg) => this.say(c, msg),
    });
    if (joined) c.match = m;
    else this.say(c, { t: 'error', message: 'Could not join that match.' });
    if (m.size === 0) this.matches.delete(m.id);
  }

  private leaveMatch(c: Client, reason?: string): void {
    const m = c.match;
    if (!m) return;
    c.match = null;
    m.leave(c.id);
    if (m.size === 0) this.matches.delete(m.id); // an empty match is thrown away
    if (reason !== undefined) {
      this.say(c, { t: 'left', reason });
      this.say(c, { t: 'matches', list: this.list() });
    }
  }
}
