# Shooter

A multiplayer 3D shooter that runs in the browser. TypeScript, Three.js, an authoritative server
(coming in Stage 2). See the roadmap doc for the full plan.

**Status: Stage 1** - movement, slide and the first map, played locally (no server yet).

## Setup (Windows PowerShell)

Needs Node 22.18 or newer (Node 24 LTS is fine). Check with `node -v`.

```powershell
npm install three -w client
npm install -D vite typescript @types/three @types/node
```

## Run

```powershell
npm test          # shared game logic tests (Node's built-in test runner)
npm run typecheck # TypeScript check of shared and client
npm run dev       # starts the game; open the address it prints in Chrome
```

## Controls

| Key | Action |
|---|---|
| W A S D | Move |
| Mouse | Look (click the page first to capture the mouse) |
| Space | Jump |
| Shift | Sprint |
| C | Slide: sprint first, then tap C. Jumping out of a slide keeps your speed |
| R | Respawn |
| Esc | Release the mouse |

The slide needs a fast run-up and then has a cooldown. The tunnel at the south end of the map
is only slide-high: slide in, and you stay crouched until you are clear of the ceiling.

## Tuning how it feels

Every movement number lives in `shared/src/config.ts` (speeds, jump, slide boost, slide length,
cooldown, gravity). Change a value and save; the dev server reloads on its own.

## Layout

| Path | What it is |
|---|---|
| `shared/src/movement.ts` | Movement and collision: one pure function, shared by client and server |
| `shared/src/config.ts` | All tunable numbers |
| `shared/src/map.ts` | Map format and validation |
| `shared/maps/arena1.json` | The first map (boxes + spawn points) |
| `shared/test/` | Tests: determinism, replay, collision fuzzing, slide rules |
| `client/src/` | Three.js renderer, input handling, main loop |
