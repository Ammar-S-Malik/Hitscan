/**
 * A whole match running inside the page: the real `Match` (score limit, round timer, scoreboard,
 * respawns), the real `GameServer`, one human player and a handful of bots. "Play vs AI" uses this,
 * so it needs no server and works with no connection at all.
 *
 * The page talks to it through the same two things it uses for a WebSocket: `send()` takes the
 * binary input packets, and the callbacks you pass in receive the binary game messages and the
 * JSON lobby messages. Everything else in the game (prediction, interpolation, the HUD) cannot tell
 * the difference.
 */
import { CLASSES, DEFAULT_PRIMARY, DT, MSG, createRng, decodeServerMessage, encodeInputPacket } from '@hitscan/shared';
import type { GameMap, ServerMsg } from '@hitscan/shared';
import { Bot } from './bot.ts';
import type { Difficulty, Enemy } from './bot.ts';
import { Match } from './match.ts';

export interface LocalGameOptions {
  map: GameMap;
  difficulty: Difficulty;
  bots: number; // opponents, not counting the human
  scoreLimit: number;
  timeLimit: number; // seconds
  playerName: string;
  primary?: number; // the human's class, as its primary gun (default: rifle)
  seed?: number; // makes the bots' choices repeatable (tests)
}

export interface HumanLink {
  onBinary(bytes: Uint8Array): void;
  onText(text: string): void;
}

const BOT_NAMES = ['Rook', 'Vex', 'Kestrel', 'Nova', 'Bishop', 'Havoc', 'Ember', 'Jinx', 'Onyx', 'Sable'];

interface BotSlot {
  clientId: number;
  playerId: number;
  name: string;
  brain: Bot;
  seq: number;
}

const HUMAN_CLIENT = 1;

export class LocalGame {
  readonly match: Match;
  /** Time in the match so far, in milliseconds. It only moves while `advance()` is called, so pausing freezes it. */
  clockMs = 0;
  private acc = 0;
  private humanId = 0;
  private bots: BotSlot[] = [];
  private map: GameMap;
  private opts: LocalGameOptions;
  private human: HumanLink;

  constructor(opts: LocalGameOptions, human: HumanLink) {
    this.opts = opts;
    this.map = opts.map;
    this.human = human;
    this.match = new Match({
      id: 1,
      name: 'Play vs AI',
      map: opts.map,
      scoreLimit: opts.scoreLimit,
      timeLimit: opts.timeLimit,
      onKick: () => undefined, // the human sends input every tick, so nobody is ever idle
    });
  }

  /** Join the human, then the bots. The human's `joined` and `welcome` messages arrive before this returns. */
  start(): void {
    const seed = this.opts.seed ?? Math.floor(Math.random() * 0xffffffff);
    const picker = createRng(seed ^ 0x9e3779b9);
    const joined = this.match.join(HUMAN_CLIENT, this.opts.playerName || 'You', {
      send: (bytes) => {
        if (bytes[0] === MSG.welcome) {
          const m = decodeServerMessage(bytes);
          if (m && m.kind === 'welcome') this.humanId = m.welcome.playerId;
        }
        this.human.onBinary(bytes);
      },
      sendText: (msg: ServerMsg) => this.human.onText(JSON.stringify(msg)),
    }, this.opts.primary ?? DEFAULT_PRIMARY);
    if (!joined) return;

    const count = Math.max(0, Math.min(this.opts.bots, this.map.maxPlayers - 1));
    for (let i = 0; i < count; i++) {
      const clientId = HUMAN_CLIENT + 1 + i;
      const name = `${BOT_NAMES[i % BOT_NAMES.length]} [bot]`;
      const primary = CLASSES[Math.floor(picker() * CLASSES.length)].primary; // each bot is a random class
      const slot: BotSlot = { clientId, playerId: 0, name, brain: new Bot((seed + i * 7919) >>> 0, this.opts.difficulty, 0, primary), seq: 0 };
      const ok = this.match.join(clientId, name, {
        send: (bytes) => {
          if (bytes[0] === MSG.welcome) {
            const m = decodeServerMessage(bytes);
            if (m && m.kind === 'welcome') slot.playerId = m.welcome.playerId;
          }
        },
        sendText: () => undefined,
      }, primary);
      if (ok) this.bots.push(slot);
    }
  }

  /** Input packets from the human player (the same bytes a client sends over the WebSocket). */
  send(bytes: Uint8Array): void {
    this.match.onBinary(HUMAN_CLIENT, bytes);
  }

  /** Lobby messages from the page. Nothing to answer: the match is already running. */
  sendText(_msg: object): void {
    // intentionally empty
  }

  /** The match's clock in milliseconds, including the part of the next tick that has elapsed. */
  now(): number {
    return this.clockMs + this.acc * 1000;
  }

  /** Move the match forward by `dt` seconds of real time, in fixed ticks. */
  advance(dt: number): void {
    this.acc += Math.min(dt, 0.25);
    while (this.acc >= DT) {
      this.acc -= DT;
      this.clockMs += DT * 1000;
      this.tick();
    }
  }

  /** One tick: every bot decides and sends its input, then the match advances. */
  tick(): void {
    const server = this.match.server;
    const everyone = [this.humanId, ...this.bots.map((b) => b.playerId)];
    const viewMs = Math.round((server.tickCount * 1000) / 60); // bots shoot at where everyone is right now
    for (const bot of this.bots) {
      const me = server.inspect(bot.playerId);
      if (!me) continue;
      const enemies: Enemy[] = [];
      for (const id of everyone) {
        if (id === bot.playerId || id === 0) continue;
        const o = server.inspect(id);
        if (o && o.alive) enemies.push({ id, x: o.state.x, y: o.state.y, z: o.state.z, sliding: o.state.sliding });
      }
      const input = bot.brain.think(me.state, me.alive, enemies, this.map.boxes, this.map.spawns, viewMs);
      bot.seq++;
      this.match.onBinary(bot.clientId, encodeInputPacket([{ seq: bot.seq, input }]));
    }
    this.match.update();
  }
}
