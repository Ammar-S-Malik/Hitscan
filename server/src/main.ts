/** The real server: a WebSocket front door around GameServer. Run with `npm run server`. */
import { readFileSync } from 'node:fs';
import { WebSocketServer } from 'ws';
import { TICK_RATE, parseMap } from '@hitscan/shared';
import { GameServer } from './game.ts';
import { startTickLoop } from './loop.ts';

const PORT = Number(process.env.PORT ?? 8787);
const map = parseMap(JSON.parse(readFileSync(new URL('../../shared/maps/arena1.json', import.meta.url), 'utf8')));

const game = new GameServer({ map });
const loop = startTickLoop(() => game.update(), TICK_RATE);

const wss = new WebSocketServer({ port: PORT, maxPayload: 1024 });

wss.on('connection', (ws) => {
  const id = game.connect({
    send: (data) => {
      if (ws.readyState === ws.OPEN) ws.send(data);
    },
    close: () => ws.close(),
  });
  if (id === null) return;
  console.log(`player ${id} joined (${game.playerCount} online)`);

  ws.on('message', (data, isBinary) => {
    if (!isBinary) return;
    const bytes = Array.isArray(data) ? Buffer.concat(data) : data instanceof ArrayBuffer ? new Uint8Array(data) : data;
    game.onMessage(id, bytes);
  });
  ws.on('close', () => {
    game.disconnect(id);
    console.log(`player ${id} left (${game.playerCount} online)`);
  });
  ws.on('error', () => ws.close());
});

console.log(`Hitscan server listening on ws://localhost:${PORT}  (map: ${map.name}, ${TICK_RATE} ticks/s)`);

// Every 10 seconds, report how long ticks take. A tick has 16.7 ms to finish.
setInterval(() => {
  const s = loop.stats;
  if (s.ticks > 0) {
    console.log(`${game.playerCount} players | tick avg ${(s.totalMs / s.ticks).toFixed(3)} ms, worst ${s.worstMs.toFixed(2)} ms`);
  }
  s.ticks = 0;
  s.totalMs = 0;
  s.worstMs = 0;
}, 10_000).unref();
