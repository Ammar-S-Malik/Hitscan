/**
 * One match: a GameServer plus the rules around it (score limit, round timer, end-of-round scoreboard,
 * and starting the next round). The Hub creates these and routes players into them.
 */
import { LOBBY, TICK_RATE } from '@hitscan/shared';
import type { GameMap, MatchInfo, MatchPhase, ScoreRow, ServerMsg } from '@hitscan/shared';
import { GameServer } from './game.ts';

export interface MemberLink {
  send(bytes: Uint8Array): void;
  sendText(msg: ServerMsg): void;
}

interface Member {
  clientId: number;
  playerId: number;
  name: string;
  link: MemberLink;
}

export interface MatchOptions {
  id: number;
  name: string;
  map: GameMap;
  scoreLimit: number;
  timeLimit: number; // seconds
  /** Called when the game server drops a player (for example, they stopped sending): the hub puts them back in the lobby. */
  onKick(clientId: number, reason: string): void;
}

export class Match {
  readonly id: number;
  readonly name: string;
  readonly map: GameMap;
  readonly scoreLimit: number;
  readonly timeLimit: number;
  readonly server: GameServer;
  phase: MatchPhase = 'playing';
  private ticksLeft: number;
  private endTicksLeft = 0;
  private tick = 0;
  private members = new Map<number, Member>(); // by client id
  private onKick: MatchOptions['onKick'];

  constructor(opts: MatchOptions) {
    this.id = opts.id;
    this.name = opts.name;
    this.map = opts.map;
    this.scoreLimit = opts.scoreLimit;
    this.timeLimit = opts.timeLimit;
    this.onKick = opts.onKick;
    this.server = new GameServer({ map: opts.map });
    this.ticksLeft = opts.timeLimit * TICK_RATE;
  }

  get size(): number {
    return this.members.size;
  }

  get isFull(): boolean {
    return this.members.size >= this.map.maxPlayers;
  }

  info(): MatchInfo {
    const left = this.phase === 'playing' ? this.ticksLeft : this.endTicksLeft;
    return {
      id: this.id, name: this.name, map: this.map.name, players: this.members.size, max: this.map.maxPlayers,
      phase: this.phase, scoreLimit: this.scoreLimit, timeLimit: this.timeLimit, left: Math.ceil(left / TICK_RATE),
    };
  }

  /** Add a player. The caller has checked the match is not full. */
  join(clientId: number, name: string, link: MemberLink, primary = -1): boolean {
    if (this.isFull || this.members.has(clientId)) return false;
    link.sendText({ t: 'joined', match: this.info() }); // first, so the client is ready for the binary welcome that follows
    const playerId = this.server.connect({
      send: (bytes) => link.send(bytes),
      close: () => this.onKick(clientId, 'You were removed from the match (no input received).'),
    });
    if (playerId === null) return false;
    if (primary >= 0) this.server.setPrimary(playerId, primary);
    this.members.set(clientId, { clientId, playerId, name, link });
    this.broadcastRoster();
    this.sendClock();
    return true;
  }

  leave(clientId: number): void {
    const m = this.members.get(clientId);
    if (!m) return;
    this.server.disconnect(m.playerId);
    this.members.delete(clientId);
    this.broadcastRoster();
  }

  /** Game packets from a member's connection. */
  onBinary(clientId: number, bytes: Uint8Array): void {
    const m = this.members.get(clientId);
    if (m) this.server.onMessage(m.playerId, bytes);
  }

  update(): void {
    this.server.update();
    this.tick++;
    if (this.phase === 'playing') {
      this.ticksLeft--;
      const reached = this.server.scores().some((s) => s.kills >= this.scoreLimit);
      if (reached || this.ticksLeft <= 0) this.endRound();
    } else {
      this.endTicksLeft--;
      if (this.endTicksLeft <= 0) this.startRound();
    }
    if (this.tick % TICK_RATE === 0) this.sendClock();
  }

  private nameOf(playerId: number): string {
    for (const m of this.members.values()) if (m.playerId === playerId) return m.name;
    return `Player ${playerId}`;
  }

  private endRound(): void {
    this.phase = 'ended';
    this.server.combatEnabled = false;
    this.endTicksLeft = LOBBY.endScreenSeconds * TICK_RATE;
    const rows: ScoreRow[] = this.server
      .scores()
      .map((s) => ({ id: s.id, name: this.nameOf(s.id), kills: s.kills, deaths: s.deaths }))
      .sort((a, b) => b.kills - a.kills || a.deaths - b.deaths);
    const [first, second] = rows;
    const clear = first !== undefined && first.kills > 0 && (second === undefined || second.kills < first.kills || second.deaths > first.deaths);
    this.broadcast({ t: 'ended', winner: clear ? first.id : 0, rows, nextIn: LOBBY.endScreenSeconds });
    this.sendClock();
  }

  private startRound(): void {
    this.phase = 'playing';
    this.ticksLeft = this.timeLimit * TICK_RATE;
    this.server.resetRound();
    this.server.combatEnabled = true;
    this.sendClock();
  }

  private sendClock(): void {
    const left = this.phase === 'playing' ? this.ticksLeft : this.endTicksLeft;
    this.broadcast({ t: 'clock', phase: this.phase, left: Math.ceil(left / TICK_RATE), scoreLimit: this.scoreLimit });
  }

  private broadcastRoster(): void {
    this.broadcast({ t: 'roster', players: [...this.members.values()].map((m) => ({ id: m.playerId, name: m.name })) });
  }

  private broadcast(msg: ServerMsg): void {
    for (const m of this.members.values()) m.link.sendText(msg);
  }
}
