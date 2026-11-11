import * as THREE from 'three';
import './style.css';
import {
  BODY, DT, FireControl, Interpolator, NET, Predictor, WEAPONS, aimDirection, createPlayer, decodeServerMessage,
  eyeHeight, isColliding, parseMap, parseServerMessage, pelletDirections, sanitizeName, shotSeed, step, traceShot, weaponOf,
} from '@hitscan/shared';
import type { Input, MatchInfo, MatchPhase, PlayerState, RemotePlayer, ShotEvent, Snapshot, Target, Vec3 } from '@hitscan/shared';
import { GameAudio } from './audio.ts';
import { Humanoid } from './humanoid.ts';
import { MiniMap } from './minimap.ts';
import type { Ping } from './minimap.ts';
import { Settings } from './settings.ts';
import { InputState } from './input.ts';
import { LobbyUI, MatchHud, scoreTable } from './lobby.ts';
import type { VsAiConfig } from './lobby.ts';
import { NetClient, parseNetOptions } from './net.ts';
import { LocalGame } from '../../server/src/local.ts';
import { ViewModel } from './viewmodel.ts';
import { reloadCues } from './reloadpose.ts';
import { buildWorld, disposeWorld } from './world.ts';
import type { World } from './world.ts';

const settings = new Settings(); // saved in the browser; edited on the pause screen
const SLIDE_FOV_KICK = 10;

// Every map the server can run is bundled, so joining a match just switches to the one it names.
const allMaps = Object.values(import.meta.glob('../../shared/maps/*.json', { eager: true, import: 'default' }))
  .map((raw) => parseMap(raw))
  .sort((a, b) => a.name.localeCompare(b.name));
let map = allMaps.find((m) => m.name === 'Courtyard') ?? allMaps[0];
let boxes = map.boxes;
const options = parseNetOptions(
  window.location.search,
  window.location.hostname,
  import.meta.env.VITE_SERVER_URL as string | undefined, // set when the game page is built for deployment
);

// ---- renderer and scene
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.autoClear = false; // each frame clears once by hand, then draws the world and the gun on top
document.body.prepend(renderer.domElement);

const scene = new THREE.Scene();
let world: World = buildWorld(scene, map);
world.sun.castShadow = settings.values.shadows;
const minimapEl = document.getElementById('minimap') as HTMLCanvasElement;
const minimap = new MiniMap(minimapEl, map);
const pings: Ping[] = []; // where other players recently fired from, shown on the mini-map

/** Switch the scene to another map (its walls, lights and sky). Nothing in the old one is kept. */
function setMap(next: typeof map): void {
  if (next === map && world) {
    scene.background = new THREE.Color(world.sky);
    return;
  }
  disposeWorld(scene, world);
  map = next;
  boxes = map.boxes;
  world = buildWorld(scene, map);
  world.sun.castShadow = settings.values.shadows;
  minimap.setMap(map);
  scene.background = new THREE.Color(world.sky);
  scene.fog = new THREE.Fog(world.fog.color, world.fog.near, world.fog.far);
  spawnIndex = 0;
}
scene.background = new THREE.Color(world.sky);
scene.fog = new THREE.Fog(world.fog.color, world.fog.near, world.fog.far);

const camera = new THREE.PerspectiveCamera(settings.values.fov, window.innerWidth / window.innerHeight, 0.05, 200);
camera.rotation.order = 'YXZ';
const viewmodel = new ViewModel();
viewmodel.resize(camera.aspect);
let adsAmount = 0; // 0 = from the hip, 1 = fully aimed

window.addEventListener('resize', () => {
  renderer.setSize(window.innerWidth, window.innerHeight);
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  viewmodel.resize(camera.aspect);
});

// ---- input, pointer lock and overlay
const input = new InputState(renderer.domElement);
const overlay = document.getElementById('overlay') as HTMLElement;
const hud = document.getElementById('hud') as HTMLElement;
settings.bind(() => {
  hud.style.display = settings.values.debug ? '' : 'none';
  camera.fov = settings.values.fov;
  camera.updateProjectionMatrix();
  world.sun.castShadow = settings.values.shadows;
});

const audio = new GameAudio();

function lockPointer(): void {
  audio.unlock(); // browsers allow sound only after a click, and this is called from one
  const canvas = renderer.domElement;
  // Ask for raw mouse movement (no Windows pointer acceleration or smoothing), which is
  // steadier for aiming. Browsers that don't support the option get the normal lock.
  const lock = canvas.requestPointerLock.bind(canvas) as (options?: { unadjustedMovement?: boolean }) => Promise<void> | void;
  try {
    const result = lock({ unadjustedMovement: true });
    if (result && typeof result.catch === 'function') result.catch(() => canvas.requestPointerLock());
  } catch {
    // Not allowed right now (no recent click): the pause screen stays up and a click will lock it.
  }
}

overlay.addEventListener('click', lockPointer);
const leaveButton = document.getElementById('leave') as HTMLButtonElement;
const pauseVolume = document.getElementById('volume2') as HTMLInputElement;
pauseVolume.value = String(Math.round(audio.volume * 100));
const volumeLabel = document.getElementById('volume2-v') as HTMLElement;
volumeLabel.textContent = `${pauseVolume.value}%`;
pauseVolume.addEventListener('input', () => {
  audio.setVolume(Number(pauseVolume.value) / 100);
  volumeLabel.textContent = `${pauseVolume.value}%`;
});
// The pause screen has two views: the two buttons, and the settings. Clicking the dim background gets you back in the game.
const pauseMenu = document.getElementById('pause-menu') as HTMLElement;
const settingsPanel = document.getElementById('settings-panel') as HTMLElement;
function showSettings(open: boolean): void {
  pauseMenu.style.display = open ? 'none' : '';
  settingsPanel.style.display = open ? '' : 'none';
}
document.getElementById('open-settings')?.addEventListener('click', () => showSettings(true));
document.getElementById('resume')?.addEventListener('click', lockPointer);
const pauseEyebrow = document.getElementById('pause-eyebrow') as HTMLElement;
const pauseHint = document.getElementById('pause-hint') as HTMLElement;
document.getElementById('close-settings')?.addEventListener('click', () => showSettings(false));
for (const part of [pauseMenu, settingsPanel]) part.addEventListener('click', (e) => e.stopPropagation());
document.addEventListener('pointerlockchange', () => {
  if (document.pointerLockElement) showSettings(false); // next time it opens, start on the two buttons
  updateScreens();
});
window.addEventListener('keydown', (e) => {
  if (e.code === 'KeyM' && !(e.target instanceof HTMLInputElement)) audio.toggleMute();
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
type Mode = 'connecting' | 'lobby' | 'joining' | 'online' | 'offline' | 'disconnected';
let mode: Mode = options.offline ? 'offline' : 'connecting';
let note = options.offline ? 'offline (?offline in the address)' : `connecting to ${options.url}`;
let netOpen = false; // is the connection to the server up?
let local: LocalGame | null = null; // a match running inside the page (Play vs AI); null when playing online or offline
/** The clock the other players are interpolated against: the match's own clock for a local match, so pausing freezes them too. */
const arrivalClock = (): number => (local ? local.clockMs : performance.now());
const viewClock = (): number => (local ? local.now() : performance.now());
let predictor: Predictor | null = null;
let interp = new Interpolator(NET.interpDelay);
const sentAt = new Map<number, number>(); // input number -> when it was sent, to measure the round trip
let roundTripMs = 0;
let snapshotCount = 0;
let acc = 0;
let matchPhase: MatchPhase = 'playing';
const names = new Map<number, string>(); // player id -> nickname, for the current match
let wasAlive = true;

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
const kdEl = el('kd');
const scoresEl = el('scores');
const deadEl = el('dead');
const deadBig = document.createElement('div');
deadBig.className = 'big';
deadBig.textContent = 'Eliminated';
const deadSub = document.createElement('div');
deadSub.className = 'sub';
deadEl.append(deadBig, deadSub);
const scopeEl = el('scope');
const crosshairEl = el('crosshair');
const vignetteEl = el('vignette');
const weaponsEl = el('weapons');
const ammoEl = el('ammo');
const ammoNowEl = el('ammoNow');
const ammoMaxEl = el('ammoMax');
const reloadFillEl = el('reloadbar').firstElementChild as HTMLElement;
let cueProgress = -1; // how far through the reload the sound cues have been played
let shownWeapon = -1;
let offlineTicks = 0;
let hitFlash = 0;
let damageFlash = 0;
interface FeedEntry {
  killer: string;
  victim: string;
  weapon: string;
  head: boolean;
  mine: boolean; // we got the kill
  died: boolean; // we were the victim
  until: number;
}
const feed: FeedEntry[] = [];
let feedShown = ''; // which entries the kill feed is showing, so it is only rebuilt when it changes
const stepTracks = new Map<number, { x: number; z: number; dist: number }>(); // footstep sounds for other players
let myStepDist = 0;
let lastWeaponHeard = 0;
let wasSliding = false;
let wasGrounded = true;

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

/**
 * Our own shot, drawn the moment we fire instead of waiting a round trip for the server to echo it.
 * The scatter comes from the same seeded function the server uses, so the rays are the same ones.
 */
function fireLocal(state: PlayerState, used: Input, seq: number): void {
  const weapon = weaponOf(used.weapon);
  const eyePos: Vec3 = [state.x, state.y + eyeHeight(state), state.z];
  const targets: Target[] = lastRemotes
    .filter((r) => r.alive)
    .map((r) => ({ id: r.id, x: r.x, y: r.y, z: r.z, sliding: r.sliding }));
  const rays = pelletDirections(weapon, used.yaw, used.pitch, used.aim, shotSeed(seq, myId));
  const right: Vec3 = [Math.cos(used.yaw), 0, -Math.sin(used.yaw)];
  const aimDir = aimDirection(used.yaw, used.pitch);
  // Start the visible line at the gun, low and to the right, so it does not hide the crosshair.
  const lower = 0.18 * (1 - adsAmount);
  const side = 0.2 * (1 - adsAmount);
  const muzzle: Vec3 = [
    eyePos[0] + right[0] * side + aimDir[0] * 0.6,
    eyePos[1] - lower + aimDir[1] * 0.6,
    eyePos[2] + right[2] * side + aimDir[2] * 0.6,
  ];
  for (const dir of rays) spawnTracer(muzzle, traceShot(eyePos, dir, boxes, targets).end, 0xfff1b0);
  audio.shot(used.weapon);
  viewmodel.kick();
  input.kick(weapon.recoil * (used.aim ? 0.6 : 1));
}

function name(id: number): string {
  return id === myId ? 'You' : (names.get(id) ?? `Player ${id}`);
}

function onEvents(events: ShotEvent[]): void {
  const now = performance.now();
  const heard = new Set<number>(); // a shotgun blast is many rays but one sound
  for (const e of events) {
    if (e.shooter !== myId) {
      spawnTracer(e.origin, e.end, 0xffc27a);
      remoteWeapon.set(e.shooter, e.weapon);
      if (!heard.has(e.shooter)) pings.push({ x: e.origin[0], z: e.origin[2], born: now });
      remotes.get(e.shooter)?.model.fire();
      if (!heard.has(e.shooter)) {
        heard.add(e.shooter);
        audio.shot(e.weapon, e.origin);
      }
    }
    if (e.shooter === myId && e.victim !== 0 && e.damage > 0) {
      audio.hit(e.headshot, e.killed);
      hitFlash = 0.18;
      hitEl.style.setProperty('--c', e.killed ? '#ff4545' : e.headshot ? '#ffb02e' : '#ffffff');
    }
    if (e.victim === myId && e.damage > 0) {
      damageFlash = 0.7;
      audio.damaged();
    }
    if (e.killed) {
      feed.push({
        killer: name(e.shooter),
        victim: name(e.victim),
        weapon: weaponOf(e.weapon).name,
        head: e.headshot,
        mine: e.shooter === myId,
        died: e.victim === myId,
        until: now + 5000,
      });
      if (feed.length > 6) feed.shift();
    }
  }
}

// ---- screens: the lobby, the "click to play" pause screen, or the game itself
const lobbyUI = new LobbyUI(
  {
    onQuick: () => net?.sendText({ t: 'quick' }),
    onCreate: (matchName, scoreLimit, timeLimit, mapName) => net?.sendText({ t: 'create', name: matchName, scoreLimit, timeLimit, map: mapName }),
    onJoin: (id) => net?.sendText({ t: 'join', id }),
    onOffline: (mapName) => goOffline('free roam (no enemies)', mapName),
    onVsAi: (config) => goVsAi(config),
    onNameChange: (n) => net?.sendText({ t: 'hello', name: n }),
    onClass: (primary) => net?.sendText({ t: 'class', primary }),
    onVolume: (v) => {
      audio.setVolume(v);
      pauseVolume.value = String(Math.round(v * 100));
      volumeLabel.textContent = `${pauseVolume.value}%`;
    },
  },
  audio.volume,
  allMaps.map((m) => ({ name: m.name, size: m.size, players: m.maxPlayers })),
);
lobbyUI.onJoin((id) => net?.sendText({ t: 'join', id }));
const matchHud = new MatchHud();

function updateScreens(): void {
  const showLobby = mode === 'connecting' || mode === 'lobby' || mode === 'disconnected';
  const locked = document.pointerLockElement === renderer.domElement;
  if (showLobby) lobbyUI.show();
  else lobbyUI.hide();
  overlay.style.display = !showLobby && !locked ? 'flex' : 'none';
  lobbyUI.setConnected(netOpen && mode === 'lobby');
  pauseEyebrow.textContent = local ? 'Paused' : 'Menu';
  pauseHint.textContent = local
    ? 'The match is frozen while you are here. Click outside this box, or press Resume.'
    : 'The match keeps running while this menu is open. Click outside this box to get back in.';
}

function setMode(next: Mode): void {
  mode = next;
  updateScreens();
}

/** Forget everything about the match we were in (or were joining). */
function resetGameState(): void {
  predictor = null;
  interp = new Interpolator(NET.interpDelay);
  sentAt.clear();
  roundTripMs = 0;
  fireControl.reset();
  for (const v of remotes.values()) removeRemote(v);
  remotes.clear();
  remoteWeapon.clear();
  for (const t of tracers) {
    scene.remove(t.line);
    t.line.geometry.dispose();
    (t.line.material as THREE.Material).dispose();
  }
  tracers.length = 0;
  stepTracks.clear();
  names.clear();
  scoreRows = [];
  lastRemotes = [];
  feed.length = 0;
  pings.length = 0;
  health = 100;
  alive = true;
  wasAlive = true;
  respawnTicks = 0;
  kills = 0;
  deaths = 0;
  matchPhase = 'playing';
  matchHud.hide();
}

/** Take up the class picked in the lobby: its primary gun on key 1 and the pistol on key 2. */
function applyLoadout(): void {
  input.setLoadout(lobbyUI.primary);
  shownWeapon = -1; // redraw the gun slots
}

function stopLocal(): void {
  local = null;
  matchHud.setTag('');
}

function backToLobby(message: string, isError = false): void {
  stopLocal();
  resetGameState();
  if (document.pointerLockElement) document.exitPointerLock();
  setMode(netOpen ? 'lobby' : 'disconnected');
  lobbyUI.setStatus(message, isError);
  if (netOpen) net?.sendText({ t: 'list' });
}

function goOffline(reason: string, mapName = ''): void {
  stopLocal();
  resetGameState();
  setMap(allMaps.find((m) => m.name === mapName) ?? allMaps[Math.floor(Math.random() * allMaps.length)]);
  note = reason;
  applyLoadout();
  prev = cur = spawn();
  acc = 0;
  setMode('offline');
  lockPointer();
}

/** Start a match against bots, entirely inside the page. */
function goVsAi(config: VsAiConfig): void {
  stopLocal();
  resetGameState();
  const roomy = allMaps.filter((m) => m.maxPlayers > config.bots);
  const pool = roomy.length > 0 ? roomy : allMaps;
  const chosen = allMaps.find((m) => m.name === config.map) ?? pool[Math.floor(Math.random() * pool.length)];
  setMap(chosen);
  note = `vs AI (${config.difficulty})`;
  acc = 0;
  applyLoadout();
  local = new LocalGame(
    {
      map: chosen,
      difficulty: config.difficulty,
      bots: config.bots,
      scoreLimit: config.scoreLimit,
      timeLimit: config.timeLimit,
      playerName: sanitizeName(lobbyUI.name, 'Player'),
      primary: lobbyUI.primary,
    },
    { onBinary: onGameBytes, onText: onLobbyText },
  );
  matchHud.setTag(`vs AI \u00b7 ${config.difficulty}`);
  local.start(); // sends 'joined' and the welcome straight away, which switches to the joining screen and grabs the mouse
}

function leaveMatch(): void {
  if (local) {
    backToLobby(netOpen ? 'Pick a match.' : 'Not connected to a server.', !netOpen);
    return;
  }
  if (mode === 'offline') {
    backToLobby(netOpen ? 'Pick a match.' : 'Not connected to a server.', !netOpen);
    return;
  }
  if (netOpen) net?.sendText({ t: 'leave' });
  backToLobby('Pick a match.');
}
leaveButton.addEventListener('click', leaveMatch);

function onSnapshot(snap: Snapshot): void {
  if (!predictor) {
    predictor = new Predictor(boxes, snap.own);
    note = 'online';
    setMode('online');
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
  if (wasAlive && !alive) audio.died();
  else if (!wasAlive && alive) {
    audio.respawned();
    fireControl.reset(); // a fresh life starts with full magazines, as on the server
  }
  wasAlive = alive;
  respawnTicks = snap.respawnTicks;
  kills = snap.kills;
  deaths = snap.deaths;
  scoreRows = [{ id: myId, kills: snap.kills, deaths: snap.deaths }, ...snap.others.map((o) => ({ id: o.id, kills: o.kills, deaths: o.deaths }))];
  interp.push(snap.tick * DT, snap.others, arrivalClock());
}

function onLobbyText(text: string): void {
  const msg = parseServerMessage(text);
  if (!msg) return;
  switch (msg.t) {
    case 'matches':
      if (mode === 'lobby') lobbyUI.setMatches(msg.list, netOpen);
      break;
    case 'joined':
      resetGameState();
      {
        const next = allMaps.find((m) => m.name === msg.match.map);
        if (next) setMap(next);
        else note = `this build has no map called "${msg.match.map}"`;
      }
      matchPhase = msg.match.phase;
      if (!local) matchHud.setTag('');
      matchHud.setClock(msg.match.phase, msg.match.left, msg.match.scoreLimit);
      note = `joined "${msg.match.name}", waiting for the world`;
      applyLoadout();
      setMode('joining');
      lockPointer(); // works if the click that joined is still recent; otherwise the pause screen asks for a click
      break;
    case 'left':
      if (mode === 'joining' || mode === 'online') backToLobby(msg.reason || 'You left the match.');
      break;
    case 'roster':
      names.clear();
      for (const p of msg.players) names.set(p.id, p.name);
      break;
    case 'clock':
      if (mode !== 'joining' && mode !== 'online') break;
      if (matchPhase === 'ended' && msg.phase === 'playing') {
        matchHud.hideEnd();
        fireControl.reset();
        audio.roundStart();
      }
      matchPhase = msg.phase;
      matchHud.setClock(msg.phase, msg.left, msg.scoreLimit);
      if (msg.phase === 'ended') matchHud.updateEndCountdown(msg.left);
      break;
    case 'ended': {
      if (mode !== 'joining' && mode !== 'online') break;
      matchPhase = 'ended';
      matchHud.showEnd(msg.rows, msg.winner, myId, msg.nextIn);
      audio.roundEnd(msg.winner === myId);
      break;
    }
    case 'error':
      lobbyUI.setStatus(msg.message, true);
      if (mode === 'joining') setMode('lobby');
      break;
    case 'hello':
      break;
  }
}

/** Binary game messages from the server, or from the match running in this page. */
function onGameBytes(bytes: Uint8Array): void {
  if (mode !== 'joining' && mode !== 'online') return;
  const msg = decodeServerMessage(bytes);
  if (!msg) return;
  if (msg.kind === 'welcome') {
    myId = msg.welcome.playerId;
    input.yaw = msg.welcome.yaw;
    input.pitch = 0;
    if (msg.welcome.mapName !== map.name) note = `server map "${msg.welcome.mapName}" differs from "${map.name}"`;
  } else if (msg.kind === 'reject') {
    backToLobby('That match is full.', true);
  } else if (msg.kind === 'events') {
    onEvents(msg.events);
  } else {
    onSnapshot(msg.snapshot);
  }
}

// Free hosts (Render) sleep when idle and take about a minute to wake, so a first connection that
// fails is retried every 5 seconds for about two minutes before giving up.
let connectAttempts = 0;
const MAX_CONNECT_ATTEMPTS = 24;
const makeNet = (): NetClient =>
  new NetClient(options, {
      onOpen: () => {
        netOpen = true;
        const saved = (document.getElementById('nick') as HTMLInputElement).value;
        net?.sendText({ t: 'hello', name: saved });
        net?.sendText({ t: 'class', primary: lobbyUI.primary });
        net?.sendText({ t: 'list' });
        if (mode === 'connecting' || mode === 'disconnected') {
          note = 'connected';
          lobbyUI.setStatus('Connected. Pick a match or press Quick play.');
          setMode('lobby');
        }
      },
      onClose: () => {
        const wasConnected = netOpen;
        netOpen = false;
        const playingHere = mode === 'offline' || local !== null; // a match in this page does not need the server
        const canRetry = !wasConnected && connectAttempts < MAX_CONNECT_ATTEMPTS;
        if (canRetry && (mode === 'connecting' || mode === 'disconnected' || playingHere)) {
          connectAttempts++;
          if (!playingHere) {
            lobbyUI.setStatus(`Waking the server up (free hosting sleeps when idle, this can take a minute). Try ${connectAttempts} of ${MAX_CONNECT_ATTEMPTS}...`);
          }
          setTimeout(() => {
            net = makeNet();
          }, 5000);
          updateScreens();
          return;
        }
        if (playingHere) {
          updateScreens();
          return;
        }
        resetGameState();
        if (document.pointerLockElement) document.exitPointerLock();
        setMode('disconnected');
        lobbyUI.setStatus(
          wasConnected ? 'Lost the connection to the server. Refresh the page to reconnect.' : `Cannot reach the server at ${options.url}. You can still play vs AI.`,
          true,
        );
        lobbyUI.setMatches([], false);
      },
      onText: onLobbyText,
      onMessage: onGameBytes,
    });
let net: NetClient | null = options.offline ? null : makeNet();

// Keep the match list fresh while the lobby is open.
setInterval(() => {
  if (netOpen && mode === 'lobby') net?.sendText({ t: 'list' });
}, 2000);
updateScreens();

// ---- other players: a soldier model each, facing the way they face
interface RemoteView {
  model: Humanoid;
  x: number;
  y: number;
  z: number;
  speed: number; // smoothed horizontal speed, which drives the walk animation
}
const remotes = new Map<number, RemoteView>();
const remoteWeapon = new Map<number, number>(); // the gun each player last fired (the snapshot doesn't carry it)

function removeRemote(v: RemoteView): void {
  scene.remove(v.model.root);
  v.model.dispose();
}

function createRemote(id: number, r: RemotePlayer): RemoteView {
  const model = new Humanoid((id * 0.618) % 1);
  scene.add(model.root);
  const view: RemoteView = { model, x: r.x, y: r.y, z: r.z, speed: 0 };
  remotes.set(id, view);
  return view;
}

function updateRemotes(players: RemotePlayer[], dt: number): void {
  const seen = new Set<number>();
  for (const r of players) {
    seen.add(r.id);
    const v = remotes.get(r.id) ?? createRemote(r.id, r);
    const step = Math.max(dt, 1e-3);
    const raw = Math.hypot(r.x - v.x, r.z - v.z) / step;
    const grounded = Math.abs(r.y - v.y) / step < 1.5;
    v.speed += (Math.min(raw, 14) - v.speed) * (1 - Math.exp(-dt * 10));
    v.x = r.x;
    v.y = r.y;
    v.z = r.z;
    v.model.root.visible = r.alive; // a dead player's body disappears
    v.model.root.position.set(r.x, r.y, r.z);
    v.model.root.rotation.y = r.yaw;
    v.model.setWeapon(remoteWeapon.get(r.id) ?? 0);
    v.model.update(dt, v.speed, r.sliding, grounded);
  }
  for (const [id, v] of remotes) {
    if (seen.has(id)) continue;
    removeRemote(v);
    remotes.delete(id);
    remoteWeapon.delete(id);
  }
}

// ---- main loop: fixed-timestep simulation, interpolated rendering
let last = performance.now();
let eye = eyeHeight(cur);
let fov = settings.values.fov;
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

  // A match running in this page pauses along with the menu: nothing moves while the mouse is free.
  const frozen = local !== null && document.pointerLockElement !== renderer.domElement;
  const respawnPressed = input.takeRespawn();
  if (mode === 'offline') {
    if (respawnPressed || cur.y < -30) {
      prev = cur = spawn();
      acc = 0;
      fireControl.reset();
    }
    acc += frameDt;
    while (acc >= DT) {
      const raw = input.sample();
      prev = cur;
      cur = step(cur, raw, boxes);
      offlineTicks++;
      if (fireControl.tick(raw.fire, true, raw.weapon, raw.reload)) fireLocal(cur, raw, offlineTicks);
      acc -= DT;
    }
  } else if (mode === 'online' && predictor && (local || net)) {
    if (!frozen) acc += frameDt;
    while (acc >= DT) {
      const raw: Input = input.sample();
      // Tell the server which moment of its time our screen was showing other players at, so it can
      // check the shot against where they were then (lag compensation).
      raw.viewMs = Math.round(interp.sample(viewClock()).renderTime * 1000);
      const packet = predictor.tick(raw);
      const used = predictor.lastInput;
      if (used && fireControl.tick(used.fire && matchPhase === 'playing', predictor.alive, used.weapon, used.reload)) fireLocal(predictor.cur, used, predictor.lastSeq);
      sentAt.set(predictor.lastSeq, performance.now());
      if (sentAt.size > 300) sentAt.delete(sentAt.keys().next().value as number);
      (local ?? net)?.send(packet);
      acc -= DT;
    }
    predictor.smoothErrors(frozen ? 0 : frameDt);
    lastRemotes = interp.sample(viewClock()).players;
    updateRemotes(lastRemotes, frozen ? 0 : frameDt);
  }
  if (local && !frozen) local.advance(frameDt);

  // Which state to draw: the predictor's once online, otherwise the local one.
  const live = (mode === 'online' || mode === 'disconnected') && predictor !== null;
  const drawPrev = live ? predictor!.prev : prev;
  const drawCur = live ? predictor!.cur : cur;
  const a = acc / DT;
  const offX = live ? predictor!.errX : 0;
  const offY = live ? predictor!.errY : 0;
  const offZ = live ? predictor!.errZ : 0;
  let x = drawPrev.x + (drawCur.x - drawPrev.x) * a + offX;
  let y = drawPrev.y + (drawCur.y - drawPrev.y) * a + offY;
  let z = drawPrev.z + (drawCur.z - drawPrev.z) * a + offZ;
  // The smoothed correction offset can briefly push the drawn camera into a wall; if so, draw the true position instead.
  if ((offX !== 0 || offY !== 0 || offZ !== 0) && isColliding({ ...drawCur, x, y, z }, boxes)) {
    x -= offX;
    y -= offY;
    z -= offZ;
  }

  eye += (eyeHeight(drawCur) - eye) * (1 - Math.exp(-frameDt * 18));
  camera.position.set(x, y + eye, z);
  world.follow(camera.position);
  camera.rotation.set(input.pitch, input.yaw, 0);

  // Sound: listener follows the camera; footsteps, landing, sliding and weapon switches for us and others.
  if (mode === 'online' || mode === 'offline') {
    audio.updateListener([x, y + eye, z], aimDirection(input.yaw, input.pitch));
    if (input.weapon !== lastWeaponHeard) {
      lastWeaponHeard = input.weapon;
      audio.switched();
    }
    if (drawCur.sliding && !wasSliding) audio.slid();
    if (drawCur.grounded && !wasGrounded && drawCur.vy < -5) audio.landed();
    if (drawCur.grounded && !drawCur.sliding && (mode === 'offline' || alive)) {
      myStepDist += Math.hypot(drawCur.vx, drawCur.vz) * frameDt;
      if (myStepDist > 2.2) {
        myStepDist = 0;
        audio.step();
      }
    }
    wasSliding = drawCur.sliding;
    wasGrounded = drawCur.grounded;
    for (const r of lastRemotes) {
      const tr = stepTracks.get(r.id) ?? { x: r.x, z: r.z, dist: 0 };
      tr.dist += Math.hypot(r.x - tr.x, r.z - tr.z);
      tr.x = r.x;
      tr.z = r.z;
      if (tr.dist > 2.4 && r.alive && !r.sliding && Math.hypot(r.x - x, r.z - z) < 25) {
        tr.dist = 0;
        audio.step([r.x, r.y, r.z]);
      } else if (tr.dist > 2.4) tr.dist = 0;
      stepTracks.set(r.id, tr);
    }
  }

  // Aiming down sights: zoom in, slow the mouse to match, and hold the gun at the centre.
  const weaponNow = weaponOf(input.weapon);
  const wantAim = input.aimHeld && (mode === 'offline' || (mode === 'online' && alive));
  adsAmount += ((wantAim ? 1 : 0) - adsAmount) * (1 - Math.exp(-frameDt * 16));
  if (Math.abs((wantAim ? 1 : 0) - adsAmount) < 0.002) adsAmount = wantAim ? 1 : 0;
  const targetFov = (settings.values.fov + (drawCur.sliding ? SLIDE_FOV_KICK : 0)) * (1 - adsAmount) + weaponNow.adsFov * adsAmount;
  fov += (targetFov - fov) * (1 - Math.exp(-frameDt * 18));
  camera.fov = fov;
  camera.updateProjectionMatrix();
  input.sensitivityScale = (Math.tan((fov * Math.PI) / 360) / Math.tan((settings.values.fov * Math.PI) / 360)) * settings.values.sensitivity;

  const showMap = settings.values.minimap && (mode === 'online' || mode === 'offline');
  if (minimapEl.style.display !== (showMap ? 'block' : 'none')) minimapEl.style.display = showMap ? 'block' : 'none';
  if (showMap) {
    while (pings.length > 0 && now - pings[0].born > 1500) pings.shift();
    minimap.draw({ x, z, yaw: input.yaw }, pings, now);
  }

  viewmodel.setWeapon(input.weapon);
  const showGun = mode === 'offline' || (mode === 'online' && alive);
  const wDef = WEAPONS[input.weapon];
  const reloadProgress = fireControl.reloading ? 1 - fireControl.reloadLeft / wDef.reloadTicks : -1;
  viewmodel.update(frameDt, adsAmount, Math.hypot(drawCur.vx, drawCur.vz), drawCur.grounded, showGun, reloadProgress);
  if (reloadProgress < 0) cueProgress = -1;
  else {
    if (cueProgress < 0) cueProgress = Math.max(0, reloadProgress - 0.001);
    if (!frozen) for (const c of reloadCues(input.weapon)) if (c.at > cueProgress && c.at <= reloadProgress) audio.reloadCue(c.kind);
    cueProgress = reloadProgress;
  }
  ammoNowEl.textContent = String(fireControl.ammo);
  ammoMaxEl.textContent = `/ ${wDef.magSize}`;
  ammoEl.className = fireControl.reloading ? 'reloading' : fireControl.ammo <= Math.ceil(wDef.magSize * 0.25) ? 'low' : '';
  reloadFillEl.style.width = `${Math.max(0, reloadProgress) * 100}%`;
  ammoEl.style.display = showGun ? '' : 'none';
  const scoped = weaponNow.scope && adsAmount > 0.9;
  scopeEl.style.display = scoped ? 'block' : 'none';
  crosshairEl.style.display = scoped || !settings.values.crosshair ? 'none' : 'block';
  crosshairEl.style.opacity = String(Math.max(0, 1 - adsAmount * 1.3)); // the sights are the crosshair when aiming
  vignetteEl.style.opacity = String(scoped ? 0 : adsAmount * 0.9);

  if (shownWeapon !== input.weapon) {
    shownWeapon = input.weapon;
    weaponsEl.replaceChildren(
      ...input.slots.map((w, i) => {
        const slot = document.createElement('div');
        slot.className = w === input.weapon ? 'slot on' : 'slot';
        const key = document.createElement('b');
        key.textContent = String(i + 1);
        slot.append(key, WEAPONS[w].name);
        return slot;
      }),
    );
  }

  updateTracers(now);
  renderer.clear();
  renderer.render(scene, camera);
  viewmodel.render(renderer);

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
        `net    online   ${roundTripMs.toFixed(0)} ms round trip   ${shownSnapshots}/s snapshots   others ${remotes.size}${sim}\n` +
        `sync   ${predictor.pendingCount} unacknowledged inputs   last correction ${(predictor.lastCorrection * 100).toFixed(1)} cm\n`;
    } else {
      netText = `net    ${note}\n`;
    }
    if (local && mode === 'online') netText = `net    vs AI, running in this page (no network)\n`;
    const wallNow = performance.now();
    while (feed.length > 0 && feed[0].until < wallNow) feed.shift();
    const feedKey = feed.map((f) => f.until).join(',');
    if (feedKey !== feedShown) {
      feedShown = feedKey;
      killfeedEl.replaceChildren(
        ...feed.map((f) => {
          const row = document.createElement('div');
          row.className = `kf${f.mine ? ' mine' : ''}${f.died ? ' died' : ''}`;
          const add = (cls: string, text: string): void => {
            const s = document.createElement('span');
            if (cls) s.className = cls;
            s.textContent = text;
            row.append(s);
          };
          add(f.mine ? 'me' : '', f.killer);
          add('w', f.weapon);
          add('arrow', '\u25B8');
          add(f.died ? 'me' : '', f.victim);
          if (f.head) add('head', 'HEAD');
          return row;
        }),
      );
    }
    const online = mode === 'online';
    hpEl.textContent = online ? `${health}` : '';
    kdEl.replaceChildren();
    if (online) {
      const k = document.createElement('b');
      k.textContent = String(kills);
      const d = document.createElement('b');
      d.textContent = String(deaths);
      kdEl.append('KILLS ', k, '   DEATHS ', d);
    }
    healthFill.style.width = `${online ? health : 100}%`;
    healthFill.style.background = health > 60 ? '#4ade80' : health > 30 ? '#ffc533' : '#ff4d4d';
    deadEl.style.display = online && !alive ? 'block' : 'none';
    if (online && !alive) deadSub.textContent = `Respawning in ${(respawnTicks / 60).toFixed(1)} s`;
    scoresEl.style.display = online && input.showScores ? 'block' : 'none';
    if (online && input.showScores) {
      const rows = [...scoreRows].sort((a, b) => b.kills - a.kills || a.deaths - b.deaths);
      const title = document.createElement('div');
      title.className = 'sb-title';
      title.textContent = 'Scoreboard';
      scoresEl.replaceChildren(title, scoreTable(rows.map((r) => ({ name: name(r.id), kills: r.kills, deaths: r.deaths, me: r.id === myId }))));
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
