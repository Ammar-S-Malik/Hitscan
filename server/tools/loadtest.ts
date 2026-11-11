/**
 * Load test: connects many bots to a running server, has them run around and shoot, and reports what the server and
 * the bots saw. Start the server first (with a high MAX_MATCHES), then:
 *
 *   npm run loadtest -- --bots 64 --seconds 20 --url ws://localhost:8787
 *
 * Bots are real WebSocket clients sending 60 inputs a second each, so this measures the server, the wire format and the
 * rate limits together. The machine running the bots shares the CPU with the server if you run both on one computer.
 */
import { WebSocket } from 'ws';
import { encodeInputPacket, quantizeInput } from '@hitscan/shared';
import type { Input } from '@hitscan/shared';

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const BOTS = Number(arg('bots', '32'));
const SECONDS = Number(arg('seconds', '20'));
const URL = arg('url', 'ws://localhost:8787');
const HTTP = URL.replace(/^ws/, 'http');

interface Bot {
  ws: WebSocket;
  seq: number;
  yaw: number;
  joined: boolean;
  snapshots: number;
  events: number;
  bytes: number;
  closed: boolean;
}

const bots: Bot[] = [];
let refused = 0;

function makeBot(i: number): void {
  const ws = new WebSocket(URL, { headers: { 'x-forwarded-for': `10.0.${Math.floor(i / 200)}.${i % 200}` } });
  ws.binaryType = 'arraybuffer';
  const bot: Bot = { ws, seq: 0, yaw: Math.random() * 6.28, joined: false, snapshots: 0, events: 0, bytes: 0, closed: false };
  bots.push(bot);
  ws.on('open', () => {
    ws.send(JSON.stringify({ t: 'hello', name: `Bot${i}` }));
    ws.send(JSON.stringify({ t: 'quick' }));
  });
  ws.on('message', (data, isBinary) => {
    if (!isBinary) {
      const text = data.toString();
      if (text.includes('"joined"')) bot.joined = true;
      if (text.includes('"error"')) refused++;
      return;
    }
    const bytes = new Uint8Array(data as ArrayBuffer);
    bot.bytes += bytes.length;
    if (bytes[0] === 0x11) bot.snapshots++;
    else if (bytes[0] === 0x13) bot.events++;
  });
  ws.on('close', () => {
    bot.closed = true;
  });
  ws.on('error', () => {
    bot.closed = true;
  });
}

function botInput(bot: Bot, tick: number): Input {
  if (tick % 45 === 0) bot.yaw += (Math.random() - 0.5) * 2;
  return {
    forward: 1,
    strafe: Math.sin(tick / 30 + bot.seq) > 0.4 ? 1 : 0,
    yaw: bot.yaw,
    pitch: 0,
    jump: tick % 90 === 0,
    sprint: true,
    slide: false,
    fire: Math.random() < 0.4,
    weapon: Math.floor(tick / 300) % 5,
    aim: false,
    viewMs: 0,
  };
}

async function stats(): Promise<Record<string, number> | null> {
  try {
    const res = await fetch(`${HTTP}/stats`);
    return (await res.json()) as Record<string, number>;
  } catch {
    return null;
  }
}

function median(xs: number[]): number {
  const a = [...xs].sort((x, y) => x - y);
  return a.length === 0 ? 0 : a[Math.floor(a.length / 2)];
}

async function main(): Promise<void> {
  if ((await stats()) === null) {
    console.error(`No server answered at ${HTTP}/stats.`);
    console.error('Start the server in another terminal first (PowerShell):');
    console.error('  $env:MAX_MATCHES="40"; npm run server');
    console.error('then run the load test again. (The default of 8 matches only fits about 50 bots.)');
    process.exit(1);
  }
  console.log(`Connecting ${BOTS} bots to ${URL} ...`);
  for (let i = 0; i < BOTS; i++) {
    makeBot(i);
    if (i % 8 === 7) await new Promise((r) => setTimeout(r, 40)); // a gentle ramp, not one burst
  }
  await new Promise((r) => setTimeout(r, 1500));
  const joined = bots.filter((b) => b.joined);
  console.log(`${joined.length} joined a match, ${refused} refused, ${bots.filter((b) => b.closed).length} closed`);
  if (joined.length === 0) {
    console.error('No bot got into a match. Check the server window for errors (an Origin restriction, or the per-address limit).');
    process.exit(1);
  }

  let tick = 0;
  const sender = setInterval(() => {
    tick++;
    for (const bot of joined) {
      if (bot.closed || bot.ws.readyState !== WebSocket.OPEN) continue;
      bot.seq++;
      bot.ws.send(encodeInputPacket([{ seq: bot.seq, input: quantizeInput(botInput(bot, tick)) }]));
    }
  }, 1000 / 60);

  const t0 = performance.now();
  for (const b of joined) {
    b.snapshots = 0;
    b.events = 0;
    b.bytes = 0;
  }
  await new Promise((r) => setTimeout(r, SECONDS * 1000));
  const elapsed = (performance.now() - t0) / 1000;
  const server = await stats();
  clearInterval(sender);

  const live = joined.filter((b) => !b.closed);
  const rate = live.map((b) => b.snapshots / elapsed);
  const kbps = live.map((b) => (b.bytes * 8) / 1000 / elapsed);
  console.log('');
  console.log(`Result after ${elapsed.toFixed(0)} s with ${live.length} bots playing (${joined.length - live.length} dropped):`);
  console.log(`  snapshots per bot per second: median ${median(rate).toFixed(1)}, lowest ${Math.min(...rate).toFixed(1)} (the server sends 30)`);
  console.log(`  downstream per bot: median ${median(kbps).toFixed(0)} kbit/s, total ${(kbps.reduce((a, b) => a + b, 0) / 1000).toFixed(1)} Mbit/s`);
  console.log(`  shot events received in total: ${live.reduce((a, b) => a + b.events, 0)}`);
  if (server) {
    console.log(
      `  server: ${server.players} players in ${server.matches} matches, tick avg ${server.tickAvgMs.toFixed(3)} ms, worst ${server.tickWorstMs.toFixed(2)} ms (budget 16.7), ` +
        `${server.ticksPerSecond.toFixed(1)} ticks/s, cpu ${server.cpuPercent.toFixed(0)}% of one core, ${server.memoryMb.toFixed(0)} MB`,
    );
  } else {
    console.log('  (could not read /stats from the server)');
  }
  for (const b of bots) b.ws.close();
  setTimeout(() => process.exit(0), 300);
}

void main();
