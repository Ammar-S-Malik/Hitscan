# Hitscan

Hitscan is a multiplayer 3D arena shooter that runs in the browser: TypeScript, Three.js and an
authoritative Node server with client-side prediction, interpolation and a built-in network simulator.
See the roadmap doc for the full plan.

**Play it: https://hitscan.pages.dev/** (free, no sign-up; open it in two tabs or send the link to a friend to play against them).
The game server runs on a free Render instance that sleeps when idle, so the first visit after a quiet period shows
"Waking the server up" for up to a minute. "Practice alone (offline)" works without the server.

**Status: Stage 7 (feature complete)** - movement and slide, multiplayer with an authoritative server, prediction and
lag-compensated hits, five guns with iron sights, a lobby with timed rounds, five validated maps, soldier models,
synthesized sound, a settings menu, a mini-map, a load test, CI, and deployment files (see `DEPLOY.md`).

## Classes

Pick a class in the lobby. Each is named for its primary gun, and every class also carries the pistol: **Shotgun**, **Rifle**, **SMG**
and **Sniper**. Key 1 is your primary, key 2 the pistol. The server enforces it (a gun outside your kit fires as the pistol),
and bots in Play vs AI are given random classes. Your class applies when you join a match. The definitions are `CLASSES` in `shared/src/config.ts`.

## Play vs AI

Accounts are optional: play as a guest (stats kept in your browser), or **Sign in** with Google or email to keep your
name, class and stats on any device (Firebase; see DEPLOY.md, section 3).

The lobby has a **Play vs AI** tab: pick a difficulty (Easy, Normal, Hard), 1 to 7 bots, a map, a score limit and a round length,
then press Start. The whole match runs inside the page, using the same `GameServer` and `Match` code as the real server, so it needs
no connection (it works while the Render server is still waking up) and has no lag. Pausing with Esc freezes the match.

Bots are ordinary players: they send inputs through the same movement and shot code as you, only see what has a clear line of sight,
and difficulty only changes reaction time, turn speed, aim error and gun choice. The code is `server/src/bot.ts` (the brain) and
`server/src/local.ts` (the in-page match); the tests are in `server/test/bots.test.ts`. The visual theme is `client/src/style.css`.

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

The game opens on a lobby: enter a nickname, then press Quick play, create a match, or join one from the list.
If the server isn't running the lobby says so and offers "Practise alone". The first player to the score limit,
or the best score when the timer runs out, wins; the scoreboard shows for a few seconds, then a new round starts.
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

A deployed build gets its server address from `VITE_SERVER_URL` at build time (`?server=` overrides it).

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
| Left click | Shoot (hold for automatic guns; click per shot for the others) |
| Right click | Aim down sights (hold) |
| 1 / 2 / mouse wheel | Your primary gun / your pistol (see Classes) |
| Tab | Hold to show the scoreboard |
| M | Mute / unmute (volume is under Settings, in the main menu and the pause screen) |
| R | Reload (also happens by itself when a magazine runs dry) |
| T | Respawn (free roam only) |
| Esc | Release the mouse. The pause screen has Leave match, volume, mouse sensitivity, field of view and toggles for the crosshair, mini-map and debug readout (saved in your browser) |

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

### The guns

| Key | Gun | Damage | Fire rate | Magazine / reload | Notes |
|---|---|---|---|---|---|
| 1 | Pistol | 22 | 6/s, click per shot | 12 / 1.5 s | Accurate, falls off slowly |
| 2 | SMG | 12 | 15/s, automatic | 32 / 2.0 s | Wide spread from the hip, strong when aimed |
| 3 | Shotgun | 8 pellets x 12 | 1.25/s, click per shot | 6 / 2.5 s | Devastating up close, weak beyond 25 m |
| 4 | Rifle | 28 | 8.6/s, automatic | 28 / 2.2 s | The all-rounder |
| 5 | Sniper | 90 | 0.77/s, click per shot | 5 / 2.75 s | One shot to the head, scope when aimed, wild from the hip |

Head shots multiply damage (double for most guns, 1.5x for the SMG and shotgun). Damage falls off with distance
(per gun). Aiming down sights narrows the random spread, zooms in, and slows the mouse to match. Taking a gun
out takes a moment. Reserve ammo is unlimited; each magazine empties, and swapping guns cancels a reload in progress (the magazine stays as it was). Respawning refills everything. All the numbers are in
`WEAPONS` in `shared/src/config.ts`.

The scatter is seeded from the input number and your player id, so the server and your own screen compute
exactly the same rays. Your tracers are the ones the server will really fire.

### Shooting and lag compensation

- **Hitscan:** a shot is an instant ray from your eye along where you are looking. It stops at the first wall or
  player it meets, so walls block shots. A hit in the top 30 cm of the body is a head shot (double damage).
- **The server decides.** The client sends only "trigger held" along with the look direction. The server finds the
  ray, the hit, the damage and the kill. Health, deaths and respawns (3 seconds, then 1.5 seconds of spawn shield)
  all live on the server.
- **Fire rate is part of the input stream.** The trigger rule (fire rate, click-per-shot, gun swap delay) is shared
  code that counts inputs, so your client knows exactly which of its inputs the server will count as shots. Your tracer appears the instant you click, and
  the hit marker follows when the server confirms it.
- **Lag compensation.** What you aim at on your screen is where players were about 100 ms plus your latency ago. Each
  input carries the server time your screen was showing. The server keeps the last 40 ticks of every player's position
  and rewinds the other players to that moment before testing your shot, so if you aimed at them on your screen, you hit
  them. The rewind is capped at 500 ms so a client can't claim an ancient view, and the shooter's own position is
  never rewound.
- **Trade-off:** with lag compensation the player who was shot can occasionally be hit just after getting behind a
  corner on their own screen. This is the standard trade in FPS games: the shooter's view wins.

## Tuning how it feels

Every movement number lives in `shared/src/config.ts` (speeds, jump, slide boost, slide length,
cooldown, gravity), the networking numbers (snapshot rate, jitter buffer, interpolation delay) are under `NET`, and
damage, fire rate, health, respawn time and the rewind limit are under `COMBAT`. Change a value and save; the dev server reloads on its own (restart the server for
`NET` changes that affect it).

## Testing

`npm test` runs, among others:

- **Wire format:** round trips, rejection of malformed packets, and 30,000 random byte strings thrown at the decoders.
- **Network simulator:** loss rate, delay range, ordering, and exact repeatability from a seed.
- **Full client + server runs on a virtual clock** with a simulated network: a perfect network gives zero
  corrections; 100 ms latency, 20 ms jitter and 5% loss gives rare, small ones; 40% loss still converges; other
  players are drawn smoothly and without extrapolation.
- **Weapons:** the gun table, falloff, the seeded spread (stays inside its cone, fills it evenly, repeats from the
  same seed), the trigger rule for each gun type, shotgun pellets, one-shot sniper head shots, and aiming tightening the spread.
- **Shooting:** ray geometry, walls blocking shots, head shots, fire rate, kills and respawns, the spawn shield, and a
  dead player being unable to move or shoot.
- **Lag compensation:** a moving target is hit when the shooter claims the right moment and missed when the claim is
  wrong, the rewind cap holds, and full client-plus-server duels at 0, 40, 100 and 150 ms latency (with jitter and
  loss at 100 ms) land nearly every shot, against about one in ten when the rewind is switched off.
- **Server rules:** inputs are applied once and in order, a client sending three times too fast gains nothing,
  extreme or garbage input is clamped or ignored, full servers turn players away, idle players are dropped.
- **Lobby and rounds:** nickname cleaning, create / join / quick play, score and time limits, end of round and the next
  round, rate limits and per-address caps.
- **Maps:** every map file passes the validator; the validator catches each kind of broken map; stairs can really be
  walked with the movement code.

## Layout

| Path | What it is |
|---|---|
| `shared/src/movement.ts` | Movement and collision: one pure function, shared by client and server |
| `shared/src/config.ts` | All tunable numbers |
| `shared/src/map.ts` | Map format and validation |
| `shared/src/protocol.ts` | The binary wire format and input quantization |
| `shared/src/predictor.ts` | Client-side prediction and reconciliation |
| `shared/src/interp.ts` | Interpolation of other players |
| `shared/src/hitscan.ts` | Shot geometry: the aim direction, ray against walls and player boxes |
| `shared/src/combat.ts` | The trigger rule shared by client and server |
| `shared/src/lobby.ts` | The lobby messages (JSON text frames) and nickname cleaning |
| `shared/src/mapcheck.ts` | The map validator |
| `client/src/viewmodel.ts` | The gun in your hands (hands, iron sights, sway, recoil, muzzle flash) |
| `client/src/guns.ts`, `humanoid.ts` | The gun models and the soldier model, built from boxes and cylinders |
| `client/src/audio.ts` | Synthesized sound (Web Audio) |
| `client/src/lobby.ts`, `settings.ts`, `minimap.ts` | The lobby screen, saved settings, the mini-map |
| `shared/src/netsim.ts` | Network simulator (delay, jitter, loss) and the virtual clock used by tests |
| `shared/maps/*.json` | The five maps (boxes + spawn points) |
| `server/src/game.ts` | The game server logic, with no networking in it |
| `server/src/hub.ts`, `match.ts`, `limits.ts` | Lobby and matches, rounds, rate limits |
| `server/src/main.ts` | The WebSocket front door, `/health` and `/stats` |
| `server/tools/loadtest.ts` | The load test bots |
| `server/src/loop.ts` | The fixed-rate tick loop |
| `client/src/` | Three.js renderer, input handling, networking, main loop |
| `shared/test/`, `server/test/` | Tests |

## Maps

Five maps live in `shared/maps/*.json`; the lobby's Create row lets you pick one (or a random one), and Quick play
starts a random map that is not already in use.

| Map | Size | Players | Character |
|---|---|---|---|
| Courtyard | medium | 8 | open arena, central platform, a slide-only tunnel |
| Skybridge | medium | 8 | two decks joined by a bridge, stairs up, cover below |
| The Pit | small | 6 | sunken centre with stairs down and a jumpable rim |
| Container Yard | small | 6 | rows of containers, narrow alleys |
| Warehouse | small | 6 | rooms with doorways, a slide tunnel and a mezzanine |

`shared/src/mapcheck.ts` is the map validator, and `npm test` runs it on every map file. It rejects a map where
a spawn is inside a wall or in the air, spawns are too close together, there are fewer spawns than players, anything
sticks out of the bounds, the floor has a hole, a platform cannot be climbed onto, a player can be trapped in a pit,
or a spawn cannot reach the others. It also warns when two nearby spawns can see each other. To add a map, drop a new
JSON file in `shared/maps/` (copy an existing one), run `npm test`, and fix whatever the validator reports. Boxes are
`floor`, `wall`, `cover`, `platform` or `ceiling`, with `min` and `max` corners in metres. Steps up to 0.4 m are walked,
a jump clears about 1.3 m, and small maps must fit in 34 m, medium in 56 m.

## How the maps look

Each map has its own theme (`client/src/world.ts`): brick, concrete, tiles, asphalt, corrugated shipping containers,
wooden crates, metal plate and grating, all drawn in code as textures (`client/src/textures.ts`, no image files). Maps
also get a sky with clouds and a sun, shadows, a skyline of distant buildings (or quarry walls in The Pit), signs, floor
markings, hazard stripes on high decks, lamps, and a roof in the Warehouse. Only the boxes in the map file are solid: the
rest is either flat on a surface or out of reach, so what looks solid is solid. Shadows can be switched off in Settings
for a slower computer.

## Models

Other players are drawn as soldiers (helmet, visor, vest, swinging legs, a slide pose) holding the gun they last
fired, with a muzzle flash when they shoot. Your own gun has hands and sleeves. Everything is built from boxes and
cylinders in code (`client/src/humanoid.ts`, `client/src/guns.ts`), so there are no art files. The shape stays inside
the same hit box the server uses.

## Server settings and limits

Environment variables for `npm run server`: `PORT`, `ALLOWED_ORIGINS`, `MAX_MATCHES`, `MAX_PER_IP`, `TRUST_PROXY`.
Per-connection message rate caps, a 1 KB message limit, nickname cleaning, a per-address connection cap and
lobby idle timeouts are built in. `GET /health` is available for uptime checks. Details and hosting steps are in
`DEPLOY.md`.

## Sound

All sound is synthesized in the browser with the Web Audio API (no audio files): per-gun shots, hit and kill
ticks, footsteps, landing, slide, round start and end. Other players' sounds are positional. Browsers only
allow sound after a click, so it starts when you click to play.

## Load test and performance

`npm run server` exposes `GET /stats` (players, matches, tick time, CPU, memory over the last 10 seconds) and prints the
same every 10 seconds while anyone is connected. `npm run loadtest` connects bots over real WebSockets; each sends 60
inputs a second, runs, jumps and fires:

```powershell
$env:MAX_MATCHES="40"; npm run server               # terminal 1 (the default is 8 matches)
npm run loadtest -- --bots 200 --seconds 20         # terminal 2
```

Measured in a Linux container with 2 cores, the bots and the server sharing them (so the server had less than a core):

| Bots | Matches | Tick time (avg / worst, budget 16.7 ms) | Server CPU | Snapshots per bot | Downstream |
|---|---|---|---|---|---|
| 64 | 10 | 1.5 ms / 6.2 ms | 17% of a core | 30.1 per second (all 30) | 4.2 Mbit/s |
| 200 | 31 | 4.2 ms / 12.6 ms | 44% of a core | 29.7 per second | 12.6 Mbit/s |

Every bot received the full 30 snapshots a second and none were dropped. Numbers on your machine and on a real network
will differ; the real limit is more likely to be bandwidth (about 60 kbit/s per player) than the simulation.

## Continuous integration

`.github/workflows/ci.yml` runs on every push and pull request: typecheck, the full test suite, and a production build.
