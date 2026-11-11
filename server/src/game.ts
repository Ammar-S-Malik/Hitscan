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
  NET, TICK_RATE, createPlayer, decodeInputPacket, encodeReject, encodeSnapshot, encodeWelcome, step,
  REJECT_FULL,
} from '@hitscan/shared';
import type { Box, GameMap, PlayerState, RemotePlayer, SeqInput, Spawn } from '@hitscan/shared';

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
}

export interface PlayerInfo {
  state: PlayerState;
  lastSeq: number;
  processed: number; // inputs applied so far
  dropped: number; // inputs thrown away because the queue was full
  queued: number;
}

export class GameServer {
  tickCount = 0;
  private map: GameMap;
  private boxes: readonly Box[];
  private maxPlayers: number;
  private players = new Map<number, ServerPlayer>();
  private nextId = 1;

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
    return { state: p.state, lastSeq: p.lastSeq, processed: p.processed, dropped: p.dropped, queued: p.queue.length };
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
          p.state = step(p.state, q.input, this.boxes);
          p.lastSeq = q.seq;
          p.yaw = q.input.yaw;
          p.processed++;
          p.budget -= 1;
          applied++;
        }
        if (p.queue.length === 0) p.buffering = true; // ran dry: let it refill before moving again
      }
      if (p.state.y < NET.fallLimit) {
        const sp = this.pickSpawn(p.id);
        p.state = createPlayer(sp.x, sp.y, sp.z);
      }
    }
    if (this.tickCount % NET.snapshotEvery === 0) this.broadcast();
  }

  private broadcast(): void {
    const all: RemotePlayer[] = [];
    for (const p of this.players.values()) {
      all.push({
        id: p.id, x: p.state.x, y: p.state.y, z: p.state.z, yaw: p.yaw,
        sliding: p.state.sliding, grounded: p.state.grounded,
      });
    }
    for (const p of this.players.values()) {
      p.conn.send(encodeSnapshot({
        tick: this.tickCount,
        ack: p.lastSeq,
        own: p.state,
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
