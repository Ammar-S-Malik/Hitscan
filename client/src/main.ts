import * as THREE from 'three';
import { BODY, DT, createPlayer, eyeHeight, parseMap, step } from '@shooter/shared';
import type { PlayerState } from '@shooter/shared';
import arena from '../../shared/maps/arena1.json';
import { InputState } from './input.ts';
import { buildWorld } from './world.ts';

const BASE_FOV = 75;
const SLIDE_FOV_KICK = 10;

const map = parseMap(arena);
const boxes = map.boxes;

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

// ---- player
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

// ---- main loop: fixed-timestep simulation, interpolated rendering
let acc = 0;
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

function frame(now: number): void {
  const rawDt = (now - last) / 1000;
  const frameDt = Math.min(0.1, rawDt);
  last = now;
  windowWorstFrame = Math.max(windowWorstFrame, rawDt);
  windowLeft -= frameDt;
  if (windowLeft <= 0) {
    shownWorstFrame = windowWorstFrame;
    shownPeakStep = input.peakStep;
    windowWorstFrame = 0;
    input.peakStep = 0;
    windowLeft = 1;
  }
  fps += (1 / Math.max(frameDt, 1e-6) - fps) * 0.05;

  if (input.takeRespawn() || cur.y < -30) {
    prev = cur = spawn();
    acc = 0;
  }

  acc += frameDt;
  while (acc >= DT) {
    prev = cur;
    cur = step(cur, input.sample(), boxes);
    acc -= DT;
  }

  // Draw between the last two ticks so motion stays smooth at any frame rate.
  const a = acc / DT;
  const x = prev.x + (cur.x - prev.x) * a;
  const y = prev.y + (cur.y - prev.y) * a;
  const z = prev.z + (cur.z - prev.z) * a;

  eye += (eyeHeight(cur) - eye) * (1 - Math.exp(-frameDt * 18));
  camera.position.set(x, y + eye, z);
  camera.rotation.set(input.pitch, input.yaw, 0);

  const targetFov = BASE_FOV + (cur.sliding ? SLIDE_FOV_KICK : 0);
  fov += (targetFov - fov) * (1 - Math.exp(-frameDt * 10));
  camera.fov = fov;
  camera.updateProjectionMatrix();

  renderer.render(scene, camera);

  hudTimer -= frameDt;
  if (hudTimer <= 0) {
    hudTimer = 0.1;
    const speed = Math.hypot(cur.vx, cur.vz);
    const slide = cur.sliding ? 'SLIDING' : cur.slideCooldown > 0 ? `cooldown ${cur.slideCooldown.toFixed(1)}s` : 'ready';
    hud.textContent =
      `speed  ${speed.toFixed(1)} m/s\n` +
      `slide  ${slide}\n` +
      `${cur.grounded ? 'on ground' : 'airborne'}   height ${(cur.y).toFixed(2)} (body ${cur.sliding ? BODY.slideHeight : BODY.standHeight} m)\n` +
      `${fps.toFixed(0)} fps   worst frame ${(shownWorstFrame * 1000).toFixed(0)} ms\n` +
      `mouse  biggest step ${shownPeakStep.toFixed(0)} px   dropped ${input.ignoredSteps}`;
  }

  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
