/**
 * The real server: HTTP + WebSocket front door around the Hub. Run with `npm run server`.
 *
 * Settings come from environment variables, all optional:
 *   PORT              port to listen on (default 8787)
 *   ALLOWED_ORIGINS   comma-separated page addresses allowed to connect, e.g. https://hitscan.example.com
 *                     (default: any, which is what you want while developing)
 *   MAX_MATCHES       most matches at once (default 8)
 *   MAX_PER_IP        most connections from one address (default 6)
 *   TRUST_PROXY       set to 1 when behind a proxy that sets X-Forwarded-For
 */
import { createServer } from 'node:http';
import type { IncomingMessage } from 'node:http';
import { readdirSync, readFileSync } from 'node:fs';
import { WebSocketServer } from 'ws';
import type { WebSocket } from 'ws';
import { LOBBY, TICK_RATE, parseMap } from '@hitscan/shared';
import { Hub } from './hub.ts';
import { startTickLoop } from './loop.ts';

const PORT = Number(process.env.PORT ?? 8787);
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const MAX_MATCHES = Number(process.env.MAX_MATCHES ?? LOBBY.maxMatches);
const MAX_PER_IP = Number(process.env.MAX_PER_IP ?? 6);
const TRUST_PROXY = process.env.TRUST_PROXY === '1';

const mapsDir = new URL('../../shared/maps/', import.meta.url);
const maps = readdirSync(mapsDir)
  .filter((f) => f.endsWith('.json'))
  .sort()
  .map((f) => parseMap(JSON.parse(readFileSync(new URL(f, mapsDir), 'utf8'))));

const hub = new Hub({ maps, maxMatches: MAX_MATCHES, maxPerIp: MAX_PER_IP });
const loop = startTickLoop(() => hub.update(), TICK_RATE);

/** The address a client really comes from. Behind a local proxy (such as Cloudflare Tunnel) that is in a header. */
function clientIp(req: IncomingMessage): string {
  const remote = req.socket.remoteAddress ?? 'unknown';
  const local = remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1';
  if (TRUST_PROXY || local) {
    const cf = req.headers['cf-connecting-ip'];
    if (typeof cf === 'string' && cf) return cf;
    const fwd = req.headers['x-forwarded-for'];
    if (typeof fwd === 'string' && fwd) return fwd.split(',')[0].trim();
  }
  return remote;
}

const http = createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'text/plain' }).end('ok');
  } else if (req.url === '/stats') {
    // Load numbers for the last ~10 seconds. The load test tool reads this.
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(currentStats()));
  } else {
    res.writeHead(404, { 'content-type': 'text/plain' }).end('Hitscan game server. Connect with the game page.');
  }
});
const wss = new WebSocketServer({ server: http, maxPayload: 1024 });
const alive = new WeakMap<WebSocket, boolean>();

wss.on('connection', (ws, req) => {
  const origin = req.headers.origin;
  if (ALLOWED_ORIGINS.length > 0 && (typeof origin !== 'string' || !ALLOWED_ORIGINS.includes(origin))) {
    ws.close(1008, 'Origin not allowed');
    return;
  }
  const id = hub.connect(
    {
      send: (bytes) => {
        if (ws.readyState === ws.OPEN) ws.send(bytes);
      },
      sendText: (text) => {
        if (ws.readyState === ws.OPEN) ws.send(text);
      },
      close: (reason) => ws.close(1008, reason?.slice(0, 120)),
    },
    clientIp(req),
  );
  if (id === null) return;
  alive.set(ws, true);

  ws.on('pong', () => alive.set(ws, true));
  ws.on('message', (data, isBinary) => {
    if (isBinary) {
      const bytes = Array.isArray(data) ? Buffer.concat(data) : data instanceof ArrayBuffer ? new Uint8Array(data) : data;
      hub.onBinary(id, bytes);
    } else {
      hub.onText(id, data.toString());
    }
  });
  ws.on('close', () => hub.disconnect(id));
  ws.on('error', () => ws.close());
});

// Ping every connection; one that doesn't answer is dead (a closed laptop, a dropped network) and is cleared out.
setInterval(() => {
  for (const ws of wss.clients) {
    if (alive.get(ws) === false) {
      ws.terminate();
      continue;
    }
    alive.set(ws, false);
    ws.ping();
  }
}, 20_000).unref();

http.listen(PORT, () => {
  console.log(`Hitscan server listening on port ${PORT}  (${maps.length} map${maps.length === 1 ? '' : 's'}, ${TICK_RATE} ticks/s, up to ${MAX_MATCHES} matches)`);
  if (ALLOWED_ORIGINS.length > 0) console.log(`only accepting connections from: ${ALLOWED_ORIGINS.join(', ')}`);
});

// Load numbers. Once a second the tick loop's counters are moved into a window of the last 10 seconds.
// A tick has 16.7 ms to finish.
const window: Array<{ ticks: number; totalMs: number; worstMs: number; cpuMs: number }> = [];
let lastCpu = process.cpuUsage();
setInterval(() => {
  const s = loop.stats;
  const cpu = process.cpuUsage(lastCpu);
  lastCpu = process.cpuUsage();
  window.push({ ticks: s.ticks, totalMs: s.totalMs, worstMs: s.worstMs, cpuMs: (cpu.user + cpu.system) / 1000 });
  if (window.length > 10) window.shift();
  s.ticks = 0;
  s.totalMs = 0;
  s.worstMs = 0;
}, 1000).unref();

function currentStats() {
  const ticks = window.reduce((a, w) => a + w.ticks, 0);
  const totalMs = window.reduce((a, w) => a + w.totalMs, 0);
  const cpuMs = window.reduce((a, w) => a + w.cpuMs, 0);
  return {
    connected: hub.clientCount,
    players: hub.playerCount,
    matches: hub.matchCount,
    seconds: window.length,
    ticksPerSecond: window.length > 0 ? ticks / window.length : 0,
    tickAvgMs: ticks > 0 ? totalMs / ticks : 0,
    tickWorstMs: Math.max(0, ...window.map((w) => w.worstMs)),
    cpuPercent: window.length > 0 ? (cpuMs / (window.length * 1000)) * 100 : 0, // of one core
    memoryMb: process.memoryUsage().rss / 1048576,
  };
}

setInterval(() => {
  if (hub.clientCount === 0 && hub.matchCount === 0) return;
  const s = currentStats();
  console.log(
    `${s.connected} connected, ${s.players} playing in ${s.matches} matches | tick avg ${s.tickAvgMs.toFixed(3)} ms, worst ${s.tickWorstMs.toFixed(2)} ms | cpu ${s.cpuPercent.toFixed(0)}% of one core, ${s.memoryMb.toFixed(0)} MB`,
  );
}, 10_000).unref();

function shutdown(): void {
  loop.stop();
  wss.close();
  http.close();
  setTimeout(() => process.exit(0), 500).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
