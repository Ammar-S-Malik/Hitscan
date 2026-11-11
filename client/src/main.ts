import * as THREE from 'three';
import {
  BODY, DT, FireControl, Interpolator, NET, Predictor, aimDirection, createPlayer, decodeServerMessage, eyeHeight,
  parseMap, step, traceShot,
} from '@hitscan/shared';
import type { Input, PlayerState, RemotePlayer, ShotEvent, Snapshot, Target, Vec3 } from '@hitscan/shared';
import arena from '../../shared/maps/arena1.json';
import { InputState } from './input.ts';
import { NetClient, parseNetOptions } from './net.ts';
import { buildWorld } from './world.ts';

const BASE_FOV = 75;
const SLIDE_FOV_KICK = 10;

const map = parseMap(arena);
const boxes = map.boxes;
const options = parseNetOptions(window.location.search, window.location.hostname);

// ---- renderer and scene
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
document.body.prepend(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x9fb4c8);
scene.fog = new THREE.Fog(0x9fb4c8, 30, 90);
buildWorld(scene, map);

const camera = new THREE.PerspectiveCamera(BASE_FOV, window.innerWidth / window.innerHeight, 0.05, 200);
camera.rotation.order = 'YXZ';

window.addEventListener('resize', () => {
  renderer.setSize(window.innerWidth, window.innerHeight);
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
});

// ---- input, pointer lock and overlay
const input = new InputState(renderer.domElement);
const overlay = document.getElementById('overlay') as HTMLElement;
const hud = document.getElementById('hud') as HTMLElement;

overlay.addEventListener('click', () => {
  const canvas = renderer.domElement;
  // Ask for raw mouse movement (no Windows pointer acceleration or smoothing), which is
  // steadier for aiming. Browsers that don't support the option get the normal lock.
  const lock = canvas.requestPointerLock.bind(canvas) as (options?: { unadjustedMovement?: boolean }) => Promise<void> | void;
  const result = lock({ unadjustedMovement: true });
  if (result && typeof result.catch === 'function') result.catch(() => canvas.requestPointerLock());
});
document.addEventListener('pointerlockchange', () => {
  overlay.style.display = document.pointerLockElement === renderer.domElement ? 'none' : 'flex';
});

// ---- local player (used offline, and as a placeholder while connecting)
let spawnIndex = 0;
function spawn(): PlayerState {
  const sp = map.spawns[spawnIndex % map.spawns.length];
  spawnIndex++;
  input.yaw = sp.yaw;
  input.pitch = 0;
  return createPlayer(sp.x, sp.y, sp.z);
}

let prev = spawn();
let cur = prev;

// ---- networking
type Mode = 'connecting' | 'online' | 'offline' | 'disconnected';
let mode: Mode = options.offline ? 'offline' : 'connecting';
let note = options.offline ? 'offline (?offline in the address)' : `connecting to ${options.url}`;
let predictor: Predictor | null = null;
const interp = new Interpolator(NET.interpDelay);
const sentAt = new Map<number, number>(); // input number -> when it was sent, to measure the round trip
let roundTripMs = 0;
let snapshotCount = 0;
let acc = 0;

// ---- combat state
let myId = 0;
const fireControl = new FireControl(); // the same trigger rule the server uses, so we know which input fires
let health = 100;
let alive = true;
let respawnTicks = 0;
let kills = 0;
let deaths = 0;
let scoreRows: Array<{ id: number; kills: number; deaths: number }> = [];
let lastRemotes: RemotePlayer[] = []; // what is drawn right now, for aiming the local tracer
const el = (id: string): HTMLElement => document.getElementById(id) as HTMLElement;
const hitEl = el('hitmarker');
const damageEl = el('damage');
const hpEl = el('hp');
const healthFill = el('healthfill');
const killfeedEl = el('killfeed');
const scoresEl = el('scores');
const deadEl = el('dead');
let hitFlash = 0;
let damageFlash = 0;
const feed: Array<{ text: string; until: number }> = [];

const TRACER_SECONDS = 0.14;
const tracers: Array<{ line: THREE.Line; born: number }> = [];

function spawnTracer(from: Vec3, to: Vec3, color: number): void {
  const geometry = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(...from), new THREE.Vector3(...to)]);
  const material = new THREE.LineBasicMaterial({ color, transparent: true, opacity: 1 });
  const line = new THREE.Line(geometry, material);
  line.frustumCulled = false;
  scene.add(line);
  tracers.push({ line, born: performance.now() });
}

function updateTracers(nowMs: number): void {
  for (let i = tracers.length - 1; i >= 0; i--) {
    const t = tracers[i];
    const age = (nowMs - t.born) / 1000;
    if (age >= TRACER_SECONDS) {
      scene.remove(t.line);
      t.line.geometry.dispose();
      (t.line.material as THREE.Material).dispose();
      tracers.splice(i, 1);
    } else {
      (t.line.material as THREE.LineBasicMaterial).opacity = 1 - age / TRACER_SECONDS;
    }
  }
}

/** Our own shot, drawn the moment we fire instead of waiting a round trip for the server to echo it. */
function fireLocal(state: PlayerState, aim: { yaw: number; pitch: number }): void {
  const eyePos: Vec3 = [state.x, state.y + eyeHeight(state), state.z];
  const dir = aimDirection(aim.yaw, aim.pitch);
  const targets: Target[] = lastRemotes
    .filter((r) => r.alive)
    .map((r) => ({ id: r.id, x: r.x, y: r.y, z: r.z, sliding: r.sliding }));
  const end = traceShot(eyePos, dir, boxes, targets).end;
  // Start the visible line at the gun, low and to the right, so it does not hide the crosshair.
  const right: Vec3 = [Math.cos(aim.yaw), 0, -Math.sin(aim.yaw)];
  const muzzle: Vec3 = [
    eyePos[0] + right[0] * 0.2 + dir[0] * 0.6,
    eyePos[1] - 0.18 + dir[1] * 0.6,
    eyePos[2] + right[2] * 0.2 + dir[2] * 0.6,
  ];
  spawnTracer(muzzle, end, 0xfff1b0);
}

function name(id: number): string {
  return id === myId ? 'You' : `Player ${id}`;
}

function onEvents(events: ShotEvent[]): void {
  const now = performance.now();
  for (const e of events) {
    if (e.shooter !== myId) spawnTracer(e.origin, e.end, 0xffc27a);
    if (e.shooter === myId && e.victim !== 0 && e.damage > 0) {
      hitFlash = 0.18;
      hitEl.style.setProperty('--c', e.killed ? '#ff4545' : e.headshot ? '#ffb02e' : '#ffffff');
    }
    if (e.victim === myId && e.damage > 0) damageFlash = 0.7;
    if (e.killed) {
      feed.push({ text: `${name(e.shooter)}  \u25B8  ${name(e.victim)}${e.headshot ? '  (head)' : ''}`, until: now + 5000 });
      if (feed.length > 6) feed.shift();
    }
  }
}

function goOffline(reason: string): void {
  mode = 'offline';
  note = reason;
  prev = cur = spawn();
  acc = 0;
}

function onSnapshot(snap: Snapshot): void {
  if (!predictor) {
    predictor = new Predictor(boxes, snap.own);
    mode = 'online';
    note = 'online';
  } else {
    predictor.onSnapshot(snap);
  }
  const sent = sentAt.get(snap.ack);
  if (sent !== undefined) {
    const rtt = performance.now() - sent;
    roundTripMs = roundTripMs === 0 ? rtt : roundTripMs * 0.8 + rtt * 0.2;
  }
  snapshotCount++;
  health = snap.health;
  alive = snap.alive;
  respawnTicks = snap.respawnTicks;
  kills = snap.kills;
  deaths = snap.deaths;
  scoreRows = [{ id: myId, kills: snap.kills, deaths: snap.deaths }, ...snap.others.map((o) => ({ id: o.id, kills: o.kills, deaths: o.deaths }))];
  interp.push(snap.tick * DT, snap.others, performance.now());
}

const net: NetClient | null = options.offline
  ? null
  : new NetClient(options, {
      onOpen: () => {
        note = `connected to ${options.url}, waiting for the world`;
      },
      onClose: () => {
        if (mode === 'connecting') goOffline(`no server at ${options.url}: playing offline`);
        else if (mode === 'online') {
          mode = 'disconnected';
          note = 'disconnected from the server (refresh the page to rejoin)';
        }
      },
      onMessage: (bytes) => {
        const msg = decodeServerMessage(bytes);
        if (!msg) return;
        if (msg.kind === 'welcome') {
          myId = msg.welcome.playerId;
          input.yaw = msg.welcome.yaw;
          input.pitch = 0;
          if (msg.welcome.mapName !== map.name) note = `server map "${msg.welcome.mapName}" differs from "${map.name}"`;
        } else if (msg.kind === 'reject') {
          goOffline('the server is full: playing offline');
          net?.close();
        } else if (msg.kind === 'events') {
          onEvents(msg.events);
        } else {
          onSnapshot(msg.snapshot);
        }
      },
    });

// ---- other players: one box each, facing the way they face
const remoteMeshes = new Map<number, THREE.Mesh>();

function disposeMesh(m: THREE.Mesh): void {
  m.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (mesh.geometry) mesh.geometry.dispose();
    const mat = mesh.material;
    if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
    else if (mat) mat.dispose();
  });
}

function createRemote(id: number): THREE.Mesh {
  const geometry = new THREE.BoxGeometry(BODY.radius * 2, BODY.standHeight, BODY.radius * 2);
  geometry.translate(0, BODY.standHeight / 2, 0); // origin at the feet, like the simulation
  const color = new THREE.Color().setHSL((id * 0.618) % 1, 0.6, 0.55);
  const body = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ color, roughness: 0.8 }));
  const nose = new THREE.Mesh(
    new THREE.BoxGeometry(0.18, 0.18, 0.3),
    new THREE.MeshStandardMaterial({ color: 0x1b1f24, roughness: 0.8 }),
  );
  nose.position.set(0, 1.5, -BODY.radius - 0.1); // yaw 0 faces -Z
  body.add(nose);
  scene.add(body);
  remoteMeshes.set(id, body);
  return body;
}

function updateRemotes(players: RemotePlayer[]): void {
  const seen = new Set<number>();
  for (const r of players) {
    seen.add(r.id);
    const m = remoteMeshes.get(r.id) ?? createRemote(r.id);
    m.visible = r.alive; // a dead player's body disappears
    m.position.set(r.x, r.y, r.z);
    m.rotation.y = r.yaw;
    m.scale.y = r.sliding ? BODY.slideHeight / BODY.standHeight : 1;
  }
  for (const [id, m] of remoteMeshes) {
    if (seen.has(id)) continue;
    scene.remove(m);
    disposeMesh(m);
    remoteMeshes.delete(id);
  }
}

// ---- main loop: fixed-timestep simulation, interpolated rendering
let last = performance.now();
let eye = eyeHeight(cur);
let fov = BASE_FOV;
let hudTimer = 0;
let fps = 0;
// Diagnostics: the worst frame time and biggest mouse step seen in the last full second.
let windowLeft = 1;
let windowWorstFrame = 0;
let shownWorstFrame = 0;
let shownPeakStep = 0;
let shownSnapshots = 0;

function frame(now: number): void {
  const rawDt = (now - last) / 1000;
  const frameDt = Math.min(0.1, rawDt);
  last = now;
  windowWorstFrame = Math.max(windowWorstFrame, rawDt);
  windowLeft -= frameDt;
  if (windowLeft <= 0) {
    shownWorstFrame = windowWorstFrame;
    shownPeakStep = input.peakStep;
    shownSnapshots = snapshotCount;
    windowWorstFrame = 0;
    input.peakStep = 0;
    snapshotCount = 0;
    windowLeft = 1;
  }
  fps += (1 / Math.max(frameDt, 1e-6) - fps) * 0.05;

  const respawnPressed = input.takeRespawn();
  if (mode === 'offline') {
    if (respawnPressed || cur.y < -30) {
      prev = cur = spawn();
      acc = 0;
    }
    acc += frameDt;
    while (acc >= DT) {
      const raw = input.sample();
      prev = cur;
      cur = step(cur, raw, boxes);
      if (fireControl.tick(raw.fire, true)) fireLocal(cur, raw);
      acc -= DT;
    }
  } else if (mode === 'online' && predictor && net) {
    acc += frameDt;
    while (acc >= DT) {
      const raw: Input = input.sample();
      // Tell the server which moment of its time our screen was showing other players at, so it can
      // check the shot against where they were then (lag compensation).
      raw.viewMs = Math.round(interp.sample(performance.now()).renderTime * 1000);
      const packet = predictor.tick(raw);
      const used = predictor.lastInput;
      if (used && fireControl.tick(used.fire, predictor.alive)) fireLocal(predictor.cur, used);
      sentAt.set(predictor.lastSeq, performance.now());
      if (sentAt.size > 300) sentAt.delete(sentAt.keys().next().value as number);
      net.send(packet);
      acc -= DT;
    }
    predictor.smoothErrors(frameDt);
    lastRemotes = interp.sample(performance.now()).players;
    updateRemotes(lastRemotes);
  }

  // Which state to draw: the predictor's once online, otherwise the local one.
  const live = (mode === 'online' || mode === 'disconnected') && predictor !== null;
  const drawPrev = live ? predictor!.prev : prev;
  const drawCur = live ? predictor!.cur : cur;
  const a = acc / DT;
  const offX = live ? predictor!.errX : 0;
  const offY = live ? predictor!.errY : 0;
  const offZ = live ? predictor!.errZ : 0;
  const x = drawPrev.x + (drawCur.x - drawPrev.x) * a + offX;
  const y = drawPrev.y + (drawCur.y - drawPrev.y) * a + offY;
  const z = drawPrev.z + (drawCur.z - drawPrev.z) * a + offZ;

  eye += (eyeHeight(drawCur) - eye) * (1 - Math.exp(-frameDt * 18));
  camera.position.set(x, y + eye, z);
  camera.rotation.set(input.pitch, input.yaw, 0);

  const targetFov = BASE_FOV + (drawCur.sliding ? SLIDE_FOV_KICK : 0);
  fov += (targetFov - fov) * (1 - Math.exp(-frameDt * 10));
  camera.fov = fov;
  camera.updateProjectionMatrix();

  updateTracers(now);
  renderer.render(scene, camera);

  // Combat HUD
  hitFlash = Math.max(0, hitFlash - frameDt);
  damageFlash = Math.max(0, damageFlash - frameDt * 1.6);
  hitEl.style.opacity = String(Math.min(1, hitFlash / 0.1));
  damageEl.style.opacity = String(Math.min(1, damageFlash));

  hudTimer -= frameDt;
  if (hudTimer <= 0) {
    hudTimer = 0.1;
    const speed = Math.hypot(drawCur.vx, drawCur.vz);
    const slide = drawCur.sliding ? 'SLIDING' : drawCur.slideCooldown > 0 ? `cooldown ${drawCur.slideCooldown.toFixed(1)}s` : 'ready';
    let netText: string;
    if (mode === 'online' && predictor) {
      const sim = options.lagMs || options.jitterMs || options.lossPct
        ? `   [simulated: +${options.lagMs} ms, ${options.jitterMs} ms jitter, ${options.lossPct}% loss each way]`
        : '';
      netText =
        `net    online   ${roundTripMs.toFixed(0)} ms round trip   ${shownSnapshots}/s snapshots   others ${remoteMeshes.size}${sim}\n` +
        `sync   ${predictor.pendingCount} unacknowledged inputs   last correction ${(predictor.lastCorrection * 100).toFixed(1)} cm\n`;
    } else {
      netText = `net    ${note}\n`;
    }
    const wallNow = performance.now();
    while (feed.length > 0 && feed[0].until < wallNow) feed.shift();
    killfeedEl.textContent = feed.map((f) => f.text).join('\n');
    const online = mode === 'online';
    hpEl.textContent = online ? `${health}` : '';
    healthFill.style.width = `${online ? health : 100}%`;
    healthFill.style.background = health > 60 ? '#5ad17a' : health > 30 ? '#e6c449' : '#e5533d';
    deadEl.style.display = online && !alive ? 'block' : 'none';
    if (online && !alive) deadEl.textContent = `Eliminated. Respawning in ${(respawnTicks / 60).toFixed(1)} s`;
    scoresEl.style.display = online && input.showScores ? 'block' : 'none';
    if (online && input.showScores) {
      const rows = [...scoreRows].sort((a, b) => b.kills - a.kills || a.deaths - b.deaths);
      scoresEl.textContent =
        'PLAYER            KILLS  DEATHS\n' +
        rows.map((r) => `${name(r.id).padEnd(16)}  ${String(r.kills).padStart(5)}  ${String(r.deaths).padStart(6)}`).join('\n');
    }
    hud.textContent =
      `speed  ${speed.toFixed(1)} m/s\n` +
      `slide  ${slide}\n` +
      (online ? `score  ${kills} kills   ${deaths} deaths\n` : '') +
      `${drawCur.grounded ? 'on ground' : 'airborne'}   height ${drawCur.y.toFixed(2)} (body ${drawCur.sliding ? BODY.slideHeight : BODY.standHeight} m)\n` +
      netText +
      `${fps.toFixed(0)} fps   worst frame ${(shownWorstFrame * 1000).toFixed(0)} ms\n` +
      `mouse  biggest step ${shownPeakStep.toFixed(0)} px   dropped ${input.ignoredSteps}`;
  }

  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
