# Hitscan

Hitscan is a multiplayer 3D arena shooter that runs in the browser: TypeScript, Three.js and an
authoritative Node server with client-side prediction, interpolation and a built-in network simulator.
See the roadmap doc for the full plan.

**Status: Stage 2** - movement, slide, the first map, and multiplayer: several browser tabs can join
one server and move around each other (no shooting yet; that is Stage 3).

## Setup (Windows PowerShell)

Needs Node 22.18 or newer (Node 24 LTS is fine). Check with `node -v`.

```powershell
npm install
```

## Run

Two terminals, both in the project folder:

```powershell
npm run server    # the game server, listens on ws://localhost:8787
npm run dev       # the game; open the address it prints in Chrome (open it in two tabs to see each other)
```

If the server isn't running the game falls back to playing alone (the same as Stage 1).
The first time the server starts, Windows may ask to allow Node through the firewall: allow it.

Other commands:

```powershell
npm test          # all tests (shared logic, wire format, netcode, server rules)
npm run typecheck # TypeScript check of shared, client and server
```

### Testing with a bad network

Add these to the game's address to simulate a bad connection, in both directions:

| Parameter | Example | Effect |
|---|---|---|
| `lag` | `?lag=100` | Adds 100 ms to every message each way (200 ms round trip) |
| `jitter` | `&jitter=20` | Each message's delay varies by up to 20 ms |
| `loss` | `&loss=5` | Throws away 5% of messages |
| `server` | `&server=ws://192.168.1.20:8787` | Connect to a server on another machine |
| `offline` | `?offline` | Skip the server and play alone |

For example `http://localhost:5173/?lag=100&jitter=20&loss=5`. The on-screen readout shows the round
trip, how many snapshots arrive per second, how many of your inputs are still unacknowledged, and how far the
last server correction moved you.

## Controls

| Key | Action |
|---|---|
| W A S D | Move |
| Mouse | Look (click the page first to capture the mouse) |
| Space | Jump |
| Shift | Sprint |
| C | Slide: sprint first, then tap C. Jumping out of a slide keeps your speed |
| R | Respawn (offline only) |
| Esc | Release the mouse |

The slide needs a fast run-up and then has a cooldown. The tunnel at the south end of the map
is only slide-high: slide in, and you stay crouched until you are clear of the ceiling.

## How the multiplayer works

- **The server owns the truth.** Clients send only their inputs (keys and look direction), never positions.
  The server runs the same `step()` function as the client, one input at a time, at 60 ticks per second.
- **Prediction.** Your own movement is applied immediately on your machine, so it feels instant at any ping.
- **Reconciliation.** About 30 times a second the server sends the state after the last input it applied.
  The client restarts from that state and replays the inputs the server hasn't seen yet. The simulation is
  deterministic, so on a good network the correction is exactly zero. Small corrections fade in over a few
  frames instead of jumping.
- **Interpolation.** Other players are drawn 100 ms in the past, blended between two snapshots, so their
  motion is smooth even though snapshots arrive unevenly.
- **Lost packets.** Every input packet repeats the newest unacknowledged inputs, so one lost packet costs nothing.
- **A small jitter buffer** on the server holds a couple of inputs back so that uneven arrival times don't make
  other players stall and lurch.
- **Cheating limits.** The server applies at most one input per tick per player on average (with a small burst
  allowance), so a client can't run faster by sending inputs faster; oversized, truncated or garbage packets are
  ignored; and a connection that stops sending valid inputs for five seconds is dropped.

## Tuning how it feels

Every movement number lives in `shared/src/config.ts` (speeds, jump, slide boost, slide length,
cooldown, gravity), and the networking numbers (snapshot rate, jitter buffer, interpolation delay) are in the
same file under `NET`. Change a value and save; the dev server reloads on its own (restart the server for
`NET` changes that affect it).

## Testing

`npm test` runs, among others:

- **Wire format:** round trips, rejection of malformed packets, and 30,000 random byte strings thrown at the decoders.
- **Network simulator:** loss rate, delay range, ordering, and exact repeatability from a seed.
- **Full client + server runs on a virtual clock** with a simulated network: a perfect network gives zero
  corrections; 100 ms latency, 20 ms jitter and 5% loss gives rare, small ones; 40% loss still converges; other
  players are drawn smoothly and without extrapolation.
- **Server rules:** inputs are applied once and in order, a client sending three times too fast gains nothing,
  extreme or garbage input is clamped or ignored, full servers turn players away, idle players are dropped.

## Layout

| Path | What it is |
|---|---|
| `shared/src/movement.ts` | Movement and collision: one pure function, shared by client and server |
| `shared/src/config.ts` | All tunable numbers |
| `shared/src/map.ts` | Map format and validation |
| `shared/src/protocol.ts` | The binary wire format and input quantization |
| `shared/src/predictor.ts` | Client-side prediction and reconciliation |
| `shared/src/interp.ts` | Interpolation of other players |
| `shared/src/netsim.ts` | Network simulator (delay, jitter, loss) and the virtual clock used by tests |
| `shared/maps/arena1.json` | The first map (boxes + spawn points) |
| `server/src/game.ts` | The game server logic, with no networking in it |
| `server/src/main.ts` | The WebSocket front door (the only file that uses `ws`) |
| `server/src/loop.ts` | The fixed-rate tick loop |
| `client/src/` | Three.js renderer, input handling, networking, main loop |
| `shared/test/`, `server/test/` | Tests |
