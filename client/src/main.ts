import * as THREE from 'three';
import {
  BODY, DT, Interpolator, NET, Predictor, createPlayer, decodeServerMessage, eyeHeight, parseMap, step,
} from '@hitscan/shared';
import type { PlayerState, RemotePlayer, Snapshot } from '@hitscan/shared';
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
          input.yaw = msg.welcome.yaw;
          input.pitch = 0;
          if (msg.welcome.mapName !== map.name) note = `server map "${msg.welcome.mapName}" differs from "${map.name}"`;
        } else if (msg.kind === 'reject') {
          goOffline('the server is full: playing offline');
          net?.close();
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
      prev = cur;
      cur = step(cur, input.sample(), boxes);
      acc -= DT;
    }
  } else if (mode === 'online' && predictor && net) {
    acc += frameDt;
    while (acc >= DT) {
      const packet = predictor.tick(input.sample());
      sentAt.set(predictor.lastSeq, performance.now());
      if (sentAt.size > 300) sentAt.delete(sentAt.keys().next().value as number);
      net.send(packet);
      acc -= DT;
    }
    predictor.smoothErrors(frameDt);
    updateRemotes(interp.sample(performance.now()).players);
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

  renderer.render(scene, camera);

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
    hud.textContent =
      `speed  ${speed.toFixed(1)} m/s\n` +
      `slide  ${slide}\n` +
      `${drawCur.grounded ? 'on ground' : 'airborne'}   height ${drawCur.y.toFixed(2)} (body ${drawCur.sliding ? BODY.slideHeight : BODY.standHeight} m)\n` +
      netText +
      `${fps.toFixed(0)} fps   worst frame ${(shownWorstFrame * 1000).toFixed(0)} ms\n` +
      `mouse  biggest step ${shownPeakStep.toFixed(0)} px   dropped ${input.ignoredSteps}`;
  }

  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
