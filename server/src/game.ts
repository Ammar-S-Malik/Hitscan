/**
 * The authoritative game server, with no networking in it. It talks to players through the small
 * `Connection` interface and is driven by calling `update()` once per tick, so tests can run it on
 * a virtual clock with a simulated network and the real server is just a thin adapter around it.
 *
 * The rule that keeps everything exact: a player's state is a pure function of the inputs the
 * server has applied, in order, one `step()` each. The server never moves a player on its own and
 * never takes a position from a client. Clients send only inputs.
 */
import {
  COMBAT, FireControl, NET, SECONDARY_WEAPON, TICK_RATE, createPlayer, pelletDamage, pelletDirections, shotSeed, weaponOf, decodeInputPacket, encodeEvents, encodeReject,
  encodeSnapshot, encodeWelcome, eyeHeight, step, traceShot, REJECT_FULL,
} from '@hitscan/shared';
import type { Box, GameMap, Input, PlayerState, RemotePlayer, SeqInput, ShotEvent, Spawn, Target } from '@hitscan/shared';

export interface Connection {
  send(data: Uint8Array): void;
  close(): void;
}

export interface ServerOptions {
  map: GameMap;
  maxPlayers?: number;
}

interface ServerPlayer {
  id: number;
  conn: Connection;
  state: PlayerState;
  yaw: number; // facing direction from the last applied input, shown to other players
  queue: SeqInput[]; // received, not yet applied
  lastQueuedSeq: number; // newest sequence number accepted, to drop duplicates and old packets
  lastSeq: number; // newest sequence number applied: this is the `ack` sent back
  budget: number; // inputs this player may still apply this tick
  buffering: boolean; // true while waiting for enough inputs to build up (see NET.inputBuffer)
  waited: number; // ticks spent buffering with something already queued
  lastMessageTick: number;
  processed: number;
  dropped: number;
  health: number;
  alive: boolean;
  respawnAt: number; // tick at which a dead player comes back
  shieldUntil: number; // tick until which the player can't be hurt
  kills: number;
  deaths: number;
  fire: FireControl;
  primary: number; // the gun this player's class carries besides the pistol; -1 means no limit
}

/** Where a player was at the end of one tick, for lag compensation. */
interface HistoryEntry {
  tick: number;
  players: Array<Target & { alive: boolean }>;
}

export interface PlayerInfo {
  state: PlayerState;
  lastSeq: number;
  processed: number; // inputs applied so far
  dropped: number; // inputs thrown away because the queue was full
  queued: number;
  health: number;
  alive: boolean;
  kills: number;
  deaths: number;
}

export class GameServer {
  tickCount = 0;
  /** When false (between rounds) nobody can shoot, but everyone can still move. */
  combatEnabled = true;
  private map: GameMap;
  private boxes: readonly Box[];
  private maxPlayers: number;
  private players = new Map<number, ServerPlayer>();
  private nextId = 1;
  private history: HistoryEntry[] = [];
  private events: ShotEvent[] = [];

  constructor(opts: ServerOptions) {
    this.map = opts.map;
    this.boxes = opts.map.boxes;
    this.maxPlayers = opts.maxPlayers ?? opts.map.maxPlayers;
  }

  get playerCount(): number {
    return this.players.size;
  }

  /** Test and diagnostics view of one player. */
  inspect(id: number): PlayerInfo | null {
    const p = this.players.get(id);
    if (!p) return null;
    return {
      state: p.state, lastSeq: p.lastSeq, processed: p.processed, dropped: p.dropped, queued: p.queue.length,
      health: p.health, alive: p.alive, kills: p.kills, deaths: p.deaths,
    };
  }

  /** Everyone's score, for the scoreboard. */
  scores(): Array<{ id: number; kills: number; deaths: number }> {
    return [...this.players.values()].map((p) => ({ id: p.id, kills: p.kills, deaths: p.deaths }));
  }

  /** Start a fresh round: scores to zero, everyone back at a spawn point with full health. */
  resetRound(): void {
    for (const p of this.players.values()) {
      p.kills = 0;
      p.deaths = 0;
      p.alive = true;
      this.respawn(p);
    }
  }

  /** A new connection. Returns the player id, or null if the server is full. */
  connect(conn: Connection): number | null {
    if (this.players.size >= this.maxPlayers) {
      conn.send(encodeReject(REJECT_FULL));
      conn.close();
      return null;
    }
    let id = this.nextId;
    while (id > 0xffff || this.players.has(id)) id = id >= 0xffff ? 1 : id + 1;
    this.nextId = id + 1;

    const spawn = this.pickSpawn(-1);
    this.players.set(id, {
      id,
      conn,
      state: createPlayer(spawn.x, spawn.y, spawn.z),
      yaw: spawn.yaw,
      queue: [],
      lastQueuedSeq: 0,
      lastSeq: 0,
      budget: 0,
      buffering: true,
      waited: 0,
      lastMessageTick: this.tickCount,
      processed: 0,
      dropped: 0,
      health: COMBAT.maxHealth,
      alive: true,
      respawnAt: 0,
      shieldUntil: this.tickCount + COMBAT.spawnShieldTicks,
      kills: 0,
      deaths: 0,
      fire: new FireControl(),
      primary: -1,
    });
    conn.send(encodeWelcome({
      playerId: id,
      tickRate: TICK_RATE,
      snapshotEvery: NET.snapshotEvery,
      tick: this.tickCount,
      yaw: spawn.yaw,
      mapName: this.map.name,
    }));
    return id;
  }

  /** Limit a player to the pistol and one primary gun (their class). Inputs naming any other gun are played as the pistol. */
  setPrimary(id: number, primary: number): void {
    const p = this.players.get(id);
    if (p) p.primary = primary;
  }

  disconnect(id: number): void {
    this.players.delete(id);
  }

  /** Bytes from a client. Anything malformed is ignored; nothing here may throw. */
  onMessage(id: number, data: Uint8Array): void {
    const p = this.players.get(id);
    if (!p || data.length > NET.maxPacketBytes) return;
    const inputs = decodeInputPacket(data);
    if (!inputs) return;
    p.lastMessageTick = this.tickCount;
    for (const si of inputs) {
      if (si.seq <= p.lastQueuedSeq) continue; // a repeat from the redundancy, or an old packet
      p.lastQueuedSeq = si.seq;
      if (p.queue.length >= NET.maxQueue) {
        p.queue.shift();
        p.dropped++;
      }
      p.queue.push(si);
    }
  }

  /** Advance the world by one tick. */
  update(): void {
    this.tickCount++;
    for (const p of [...this.players.values()]) {
      if (this.tickCount - p.lastMessageTick > NET.idleTimeoutTicks) {
        p.conn.close();
        this.players.delete(p.id);
        continue;
      }
      if (!p.alive && this.tickCount >= p.respawnAt) this.respawn(p);

      // Each player may apply one input per tick on average. The budget lets them catch up after a
      // late packet, but a client that sends inputs faster than real time simply gets them queued
      // (and the oldest thrown away), so it cannot run faster than everyone else.
      p.budget = Math.min(p.budget + 1, NET.budgetCap);

      // Jitter buffer: inputs arrive unevenly, but other players should see steady movement. So hold
      // back until a couple of inputs are queued, then apply one per tick. Without this, a late input
      // makes the player stall for a tick and then lurch forward two.
      if (p.buffering) {
        if (p.queue.length > 0) p.waited++;
        if (p.queue.length >= NET.inputBuffer || p.waited >= NET.inputBufferMaxWait) {
          p.buffering = false;
          p.waited = 0;
        }
      }
      if (!p.buffering) {
        let applied = 0;
        // One input per tick; extra ones only to drain a backlog down to the buffer depth.
        while (p.queue.length > 0 && p.budget >= 1 && (applied === 0 || p.queue.length > NET.inputBuffer + 1)) {
          const q = p.queue.shift()!;
          // A dead player can look around but not move or shoot (the client does the same).
          let input: Input = p.alive
            ? q.input
            : { ...q.input, forward: 0, strafe: 0, jump: false, sprint: false, slide: false, fire: false };
          if (p.primary >= 0 && input.weapon !== p.primary && input.weapon !== SECONDARY_WEAPON) input = { ...input, weapon: SECONDARY_WEAPON };
          p.state = step(p.state, input, this.boxes);
          p.lastSeq = q.seq;
          p.yaw = input.yaw;
          p.processed++;
          p.budget -= 1;
          applied++;
          if (p.fire.tick(input.fire && this.combatEnabled, p.alive, input.weapon)) this.shoot(p, input, q.seq);
        }
        if (p.queue.length === 0) p.buffering = true; // ran dry: let it refill before moving again
      }
      if (p.state.y < NET.fallLimit) {
        const sp = this.pickSpawn(p.id);
        p.state = createPlayer(sp.x, sp.y, sp.z);
      }
    }
    this.recordHistory();
    this.flushEvents();
    if (this.tickCount % NET.snapshotEvery === 0) this.broadcast();
  }

  // ------------------------------------------------------------------ combat

  private respawn(p: ServerPlayer): void {
    const sp = this.pickSpawn(p.id);
    p.state = createPlayer(sp.x, sp.y, sp.z);
    p.health = COMBAT.maxHealth;
    p.alive = true;
    p.shieldUntil = this.tickCount + COMBAT.spawnShieldTicks;
    p.fire.reset();
  }

  /**
   * Resolve one shot: one ray, or several for a shotgun. The rays start where the shooter is now; the
   * targets are rewound to what the shooter saw. The spread is seeded from the input, so the client can
   * draw exactly the same rays.
   */
  private shoot(shooter: ServerPlayer, input: Input, seq: number): void {
    const weapon = weaponOf(input.weapon);
    const origin: [number, number, number] = [
      shooter.state.x, shooter.state.y + eyeHeight(shooter.state), shooter.state.z,
    ];
    const rays = pelletDirections(weapon, input.yaw, input.pitch, input.aim, shotSeed(seq, shooter.id));
    const targets = this.targetsAt(input.viewMs, shooter.id);
    for (const dir of rays) {
      const r = traceShot(origin, dir, this.boxes, targets);
      let damage = 0;
      let killed = false;
      const victim = r.victim ? this.players.get(r.victim) : undefined;
      if (victim && victim.alive && this.tickCount >= victim.shieldUntil) {
        damage = pelletDamage(weapon, r.distance, r.headshot);
        victim.health -= damage;
        if (victim.health <= 0) {
          victim.health = 0;
          victim.alive = false;
          victim.respawnAt = this.tickCount + COMBAT.respawnTicks;
          victim.deaths++;
          shooter.kills++;
          killed = true;
        }
      }
      this.events.push({
        shooter: shooter.id,
        victim: victim ? victim.id : 0,
        headshot: r.headshot && damage > 0,
        killed,
        damage,
        weapon: input.weapon,
        origin,
        end: r.end,
      });
    }
  }

  private recordHistory(): void {
    this.history.push({
      tick: this.tickCount,
      players: [...this.players.values()].map((p) => ({
        id: p.id, x: p.state.x, y: p.state.y, z: p.state.z, sliding: p.state.sliding, alive: p.alive,
      })),
    });
    if (this.history.length > COMBAT.historyTicks) this.history.shift();
  }

  /**
   * Lag compensation. The shooter aimed at where other players were drawn on their screen, which was
   * in the past by their latency plus the interpolation delay. So find where everyone was at that
   * moment (blending between the two nearest recorded ticks, as the client does) and test the shot
   * against those positions instead of the current ones. The rewind is capped, so a client claiming
   * an old view can't reach further back than a legitimately laggy player could.
   */
  private targetsAt(viewMs: number, shooterId: number): Target[] {
    const hist = this.history;
    if (hist.length === 0) return [];
    const latest = hist[hist.length - 1].tick;
    const oldest = hist[0].tick;
    const maxBack = (COMBAT.maxRewindMs / 1000) * TICK_RATE;
    let tf = Number.isFinite(viewMs) ? (viewMs / 1000) * TICK_RATE : latest;
    tf = Math.max(Math.max(oldest, latest - maxBack), Math.min(latest, tf));
    const i0 = Math.floor(tf);
    const i1 = Math.min(latest, i0 + 1);
    const a = hist[i0 - oldest];
    const b = hist[i1 - oldest];
    if (!a || !b) return [];
    const alpha = tf - i0;

    const out: Target[] = [];
    const inB = new Map(b.players.map((t) => [t.id, t]));
    const seen = new Set<number>();
    for (const pa of a.players) {
      seen.add(pa.id);
      const pb = inB.get(pa.id);
      const t = pb ? blend(pa, pb, alpha) : pa;
      if (this.isHittable(t, shooterId)) out.push(t);
    }
    for (const pb of b.players) if (!seen.has(pb.id) && this.isHittable(pb, shooterId)) out.push(pb);
    return out;
  }

  private isHittable(t: Target & { alive: boolean }, shooterId: number): boolean {
    if (t.id === shooterId || !t.alive) return false; // not the shooter, and alive when the shooter saw them
    const now = this.players.get(t.id);
    return now !== undefined && now.alive && this.tickCount >= now.shieldUntil; // and still hittable now
  }

  private flushEvents(): void {
    if (this.events.length === 0) return;
    const bytes = encodeEvents(this.events);
    this.events = [];
    for (const p of this.players.values()) p.conn.send(bytes);
  }

  private broadcast(): void {
    const all: RemotePlayer[] = [];
    for (const p of this.players.values()) {
      all.push({
        id: p.id, x: p.state.x, y: p.state.y, z: p.state.z, yaw: p.yaw,
        sliding: p.state.sliding, grounded: p.state.grounded,
        alive: p.alive, kills: p.kills, deaths: p.deaths,
      });
    }
    for (const p of this.players.values()) {
      p.conn.send(encodeSnapshot({
        tick: this.tickCount,
        ack: p.lastSeq,
        own: p.state,
        health: p.health,
        alive: p.alive,
        respawnTicks: p.alive ? 0 : Math.max(0, p.respawnAt - this.tickCount),
        kills: p.kills,
        deaths: p.deaths,
        others: all.filter((r) => r.id !== p.id),
      }));
    }
  }

  /** The spawn point farthest from every other player. */
  private pickSpawn(excludeId: number): Spawn {
    const others = [...this.players.values()].filter((p) => p.id !== excludeId);
    let best = this.map.spawns[0];
    let bestDist = -1;
    for (const sp of this.map.spawns) {
      let nearest = Infinity;
      for (const o of others) nearest = Math.min(nearest, Math.hypot(sp.x - o.state.x, sp.z - o.state.z));
      if (nearest > bestDist) {
        bestDist = nearest;
        best = sp;
      }
    }
    return best;
  }
}

/** Blend two recorded positions of the same player. A jump bigger than a walk is a respawn: don't blend across it. */
function blend(a: Target & { alive: boolean }, b: Target & { alive: boolean }, alpha: number): Target & { alive: boolean } {
  const near = alpha < 0.5 ? a : b;
  if (a.alive !== b.alive || Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z) > COMBAT.teleportDistance) return near;
  return {
    id: a.id,
    x: a.x + (b.x - a.x) * alpha,
    y: a.y + (b.y - a.y) * alpha,
    z: a.z + (b.z - a.z) * alpha,
    sliding: near.sliding,
    alive: near.alive,
  };
}
