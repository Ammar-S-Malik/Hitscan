import * as THREE from 'three';
import type { Box, GameMap } from '@hitscan/shared';
import * as tex from './textures.ts';

/**
 * Builds the look of a map: textured surfaces, a sky, lighting with shadows, a skyline, signs, floor markings and lamps.
 * Everything is made in code. The collision boxes in the map file are the only things that are solid; everything added
 * here that is not a box from the map file is out of reach or flat on a surface, so what you see is what you can touch.
 */

export interface World {
  group: THREE.Group;
  sky: number; // the fog colour; also the background behind the sky dome
  fog: { color: number; near: number; far: number };
  sun: THREE.DirectionalLight;
  /** Call every frame with the camera position so the sky stays around you. */
  follow(position: THREE.Vector3): void;
  textures: THREE.Texture[];
}

export const DEFAULT_SKY = 0x9fb4c8;

interface Skyline {
  count: number;
  wall: string;
  lit: number; // fraction of windows lit
  rock?: boolean; // quarry walls instead of buildings
  heights: [number, number];
}

interface Theme {
  skyTop: number;
  skyHorizon: number;
  sunColor: number;
  sunDir: [number, number, number];
  sunIntensity: number;
  clouds: number; // 0 = none
  hemi: [number, number, number]; // sky colour, ground colour, intensity
  fog: [number, number, number]; // colour, near, far
  floor: () => { map: THREE.Texture; tile: number; rough?: number };
  wall: () => { map: THREE.Texture; tile: number; bump?: boolean };
  cap: string; // colour of the top of the outer walls
  barrier: string; // tall cover that is not a container or a crate
  crate: string;
  containers: string[];
  platformTop: string;
  roof: boolean;
  skyline: Skyline | null;
  lamps: 'strips' | 'hanging' | 'none';
  marks: 'plaza' | 'yard' | 'warehouse' | 'none';
  signs: string[];
  signColors: [string, string];
}

const THEMES: Record<string, Theme> = {
  Courtyard: {
    skyTop: 0x3b78c8, skyHorizon: 0xc3dbee, sunColor: 0xfff0d8, sunDir: [0.5, 0.8, 0.35], sunIntensity: 1.7, clouds: 0.8,
    hemi: [0xdcebff, 0x6a6258, 1.7], fog: [0xc3dbee, 35, 105],
    floor: () => ({ map: tex.tiles('#8d9299', '#575b62', 2, 21), tile: 4 }),
    wall: () => ({ map: tex.bricks('#9a5a44', '#c4b9a8', 22), tile: 2, bump: true }),
    cap: '#5a5d63', barrier: '#8c8f93', crate: '#a8783f',
    containers: ['#b5442f', '#2f5f9e'], platformTop: '#7b8189', roof: false,
    skyline: { count: 46, wall: '#56657a', lit: 0.12, heights: [14, 38] },
    lamps: 'none', marks: 'plaza', signs: ['COURTYARD', 'NORTH GATE', 'PLAZA'], signColors: ['#1d3b5c', '#f0f3f6'],
  },
  Skybridge: {
    skyTop: 0x2a2d68, skyHorizon: 0xf2a56e, sunColor: 0xff9a55, sunDir: [-0.8, 0.22, 0.45], sunIntensity: 1.55, clouds: 0.5,
    hemi: [0xf0b896, 0x4d3b55, 1.5], fog: [0xd9946a, 28, 100],
    floor: () => ({ map: tex.concrete('#6f6d6b', 31), tile: 3 }),
    wall: () => ({ map: tex.bricks('#5d3a37', '#8a7a72', 32), tile: 2, bump: true }),
    cap: '#3f3a3e', barrier: '#6d6b6a', crate: '#8d6a3a',
    containers: ['#8d3a2c'], platformTop: '#7d838b', roof: false,
    skyline: { count: 60, wall: '#1e2140', lit: 0.5, heights: [16, 46] },
    lamps: 'strips', marks: 'none', signs: ['SKYBRIDGE', 'DECK A', 'DECK B'], signColors: ['#2b1c2e', '#ffb36b'],
  },
  'The Pit': {
    skyTop: 0x76828f, skyHorizon: 0xc6cdd3, sunColor: 0xf2f4f6, sunDir: [0.3, 0.9, 0.2], sunIntensity: 1.1, clouds: 1,
    hemi: [0xd5dce4, 0x4a4d52, 1.75], fog: [0xb4bcc4, 25, 80],
    floor: () => ({ map: tex.tiles('#5c6168', '#2f3237', 4, 41), tile: 4 }),
    wall: () => ({ map: tex.concrete('#7a7f86', 42), tile: 3, bump: false }),
    cap: '#4b4e54', barrier: '#85888d', crate: '#9a7040',
    containers: ['#6a737b'], platformTop: '#8a9097', roof: false,
    skyline: { count: 40, wall: '#4e545a', lit: 0, rock: true, heights: [10, 24] },
    lamps: 'strips', marks: 'none', signs: ['THE PIT', 'LEVEL -1', 'ARENA'], signColors: ['#26292d', '#e6e9ec'],
  },
  'Container Yard': {
    skyTop: 0x4a8bd4, skyHorizon: 0xdfe9ef, sunColor: 0xffefd0, sunDir: [0.4, 0.75, -0.5], sunIntensity: 1.75, clouds: 0.9,
    hemi: [0xe0ecfa, 0x6b6558, 1.7], fog: [0xdbe6ee, 35, 105],
    floor: () => ({ map: tex.asphalt(51), tile: 5 }),
    wall: () => ({ map: tex.corrugated('#4d6070', 52, 0.3), tile: 2.4, bump: true }),
    cap: '#3c4650', barrier: '#7e8286', crate: '#a5763c',
    containers: ['#b5442f', '#2f5f9e', '#3d7a4a', '#c79a2b', '#7a3a8a', '#8a8d91'], platformTop: '#777d84', roof: false,
    skyline: { count: 44, wall: '#5a666e', lit: 0.1, heights: [12, 34] },
    lamps: 'none', marks: 'yard', signs: ['CONTAINER YARD', 'BAY 4', 'NO ENTRY'], signColors: ['#d4a017', '#1a1a1a'],
  },
  Warehouse: {
    skyTop: 0x20242a, skyHorizon: 0x2c3138, sunColor: 0xffe9c8, sunDir: [0.2, 1, 0.1], sunIntensity: 0.9, clouds: 0,
    hemi: [0xd0d6e0, 0x3b3a3e, 1.55], fog: [0x23272d, 22, 70],
    floor: () => ({ map: tex.concrete('#74767a', 61), tile: 3 }),
    wall: () => ({ map: tex.bricks('#7a5748', '#b0a595', 62), tile: 2, bump: true }),
    cap: '#3e4249', barrier: '#6e7176', crate: '#9b6f3b',
    containers: ['#3d7a4a'], platformTop: '#80868e', roof: true,
    skyline: null, lamps: 'hanging', marks: 'warehouse', signs: ['WAREHOUSE 3', 'EXIT', 'LOADING'], signColors: ['#c7a017', '#1a1a1a'],
  },
};

function themeFor(map: GameMap): Theme {
  return THEMES[map.name] ?? THEMES.Courtyard;
}

// ---- face skins

interface Face {
  m: THREE.Material;
  tile: number; // metres per texture repeat; 0 = stretch one copy over the whole face
}

function hash(x: number, y: number, z: number): number {
  let h = Math.imul(Math.floor(x * 7) + 101, 73856093) ^ Math.imul(Math.floor(y * 7) + 53, 19349663) ^ Math.imul(Math.floor(z * 7) + 17, 83492791);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

export function buildWorld(scene: THREE.Scene, map: GameMap): World {
  const theme = themeFor(map);
  const group = new THREE.Group();
  scene.add(group);
  const owned: THREE.Texture[] = [];
  const own = <T extends THREE.Texture>(t: T): T => {
    owned.push(t);
    return t;
  };
  const mats = new Map<string, THREE.MeshStandardMaterial>();
  const material = (key: string, make: () => THREE.MeshStandardMaterial): THREE.MeshStandardMaterial => {
    let m = mats.get(key);
    if (!m) {
      m = make();
      mats.set(key, m);
    }
    return m;
  };
  const std = (map_: THREE.Texture, opts: { rough?: number; metal?: number; bump?: boolean; emissive?: number; color?: number } = {}): THREE.MeshStandardMaterial => {
    own(map_);
    const m = new THREE.MeshStandardMaterial({ map: map_, roughness: opts.rough ?? 0.85, metalness: opts.metal ?? 0.05, color: opts.color ?? 0xffffff });
    if (opts.bump) {
      m.bumpMap = map_;
      m.bumpScale = 1.5;
    }
    if (opts.emissive !== undefined) m.emissive = new THREE.Color(opts.emissive);
    return m;
  };

  const floor = theme.floor();
  const wall = theme.wall();
  const floorMat = material('floor', () => std(floor.map, { rough: floor.rough ?? 0.92 }));
  const wallMat = material('wall', () => std(wall.map, { bump: wall.bump, rough: 0.9 }));
  const capMat = material('cap', () => std(tex.concrete(theme.cap, 71)));
  const barrierMat = material('barrier', () => std(tex.concrete(theme.barrier, 72), { rough: 0.85 }));
  const crateMat = material('crate', () => std(tex.crate(theme.crate, 73), { bump: true, rough: 0.8 }));
  const plateMat = material('plate', () => std(tex.metalPlate(theme.platformTop, 74), { metal: 0.45, rough: 0.5 }));
  const stepMat = material('step', () => std(tex.grate(75), { metal: 0.5, rough: 0.5 }));
  const deckSideMat = material('deckside', () => std(tex.concrete('#6a6e74', 76)));
  const ceilMat = material('ceil', () => std(tex.metalPlate('#3a3f46', 77), { metal: 0.4, rough: 0.6 }));
  const containerMats = theme.containers.map((color, i) => ({
    side: material(`cside${i}`, () => std(tex.corrugated(color, 80 + i), { bump: true, metal: 0.25, rough: 0.6 })),
    door: material(`cdoor${i}`, () => std(tex.containerDoor(color, 90 + i), { metal: 0.25, rough: 0.6 })),
    roof: material(`croof${i}`, () => std(tex.corrugated(color, 100 + i, 0.4), { bump: true, metal: 0.25, rough: 0.7, color: 0xb0b0b0 })),
  }));

  const same = (m: THREE.Material, tile: number): Face[] => Array.from({ length: 6 }, () => ({ m, tile }));
  const isBoundary = (b: Box): boolean =>
    b.min[0] <= map.bounds.min[0] + 1e-6 || b.max[0] >= map.bounds.max[0] - 1e-6 || b.min[2] <= map.bounds.min[2] + 1e-6 || b.max[2] >= map.bounds.max[2] - 1e-6;

  function skin(b: Box): { faces: Face[]; shadow: boolean } {
    const sx = b.max[0] - b.min[0];
    const sy = b.max[1] - b.min[1];
    const sz = b.max[2] - b.min[2];
    switch (b.kind) {
      case 'floor':
        return { faces: same(floorMat, floor.tile), shadow: false };
      case 'wall': {
        const faces = same(wallMat, wall.tile);
        if (isBoundary(b) && sy >= 5) faces[2] = { m: capMat, tile: 3 };
        return { faces, shadow: true };
      }
      case 'ceiling':
        return { faces: same(ceilMat, 2), shadow: true };
      case 'platform': {
        const step = Math.min(sx, sz) <= 1.01 && Math.max(sx, sz) >= 2;
        const faces = same(deckSideMat, 3);
        faces[2] = step ? { m: stepMat, tile: 1.5 } : { m: plateMat, tile: 1.5 };
        return { faces, shadow: true };
      }
      case 'cover': {
        const long = Math.max(sx, sz);
        if (long >= 4.5 && sy >= 2.3 && containerMats.length > 0) {
          const set = containerMats[Math.floor(hash(b.min[0], 0, b.min[2]) * containerMats.length)];
          const faces = same(set.side, 2.4);
          const endAxis = sx >= sz ? [0, 1] : [4, 5]; // the short faces are the doors
          for (const f of endAxis) faces[f] = { m: set.door, tile: 0 };
          faces[2] = { m: set.roof, tile: 2.4 };
          return { faces, shadow: true };
        }
        if (sy <= 1.7 && sx <= 3.2 && sz <= 3.2) return { faces: same(crateMat, 1), shadow: true };
        return { faces: same(barrierMat, 2.5), shadow: true };
      }
    }
  }

  function box(b: Box, faces: Face[], shadow: boolean): THREE.Mesh {
    const sx = b.max[0] - b.min[0];
    const sy = b.max[1] - b.min[1];
    const sz = b.max[2] - b.min[2];
    const cx = (b.min[0] + b.max[0]) / 2;
    const cy = (b.min[1] + b.max[1]) / 2;
    const cz = (b.min[2] + b.max[2]) / 2;
    const geometry = new THREE.BoxGeometry(sx, sy, sz);
    const pos = geometry.attributes.position;
    const uv = geometry.attributes.uv;
    // Texture coordinates come from world position, so two boxes whose faces line up share one continuous texture and
    // the seams between stacked boxes (stairs, for example) do not show.
    for (let v = 0; v < pos.count; v++) {
      const f = Math.floor(v / 4);
      const tile = faces[f].tile;
      if (tile === 0) continue; // keep 0..1
      const wx = pos.getX(v) + cx;
      const wy = pos.getY(v) + cy;
      const wz = pos.getZ(v) + cz;
      if (f < 2) uv.setXY(v, wz / tile, wy / tile);
      else if (f < 4) uv.setXY(v, wx / tile, wz / tile);
      else uv.setXY(v, wx / tile, wy / tile);
    }
    const mesh = new THREE.Mesh(geometry, faces.map((f) => f.m));
    mesh.position.set(cx, cy, cz);
    mesh.castShadow = shadow;
    mesh.receiveShadow = true;
    group.add(mesh);
    return mesh;
  }

  for (const b of map.boxes) {
    const s = skin(b);
    box(b, s.faces, s.shadow);
  }

  // ---- sky
  const span = Math.max(map.bounds.max[0] - map.bounds.min[0], map.bounds.max[2] - map.bounds.min[2]);
  const cx = (map.bounds.min[0] + map.bounds.max[0]) / 2;
  const cz = (map.bounds.min[2] + map.bounds.max[2]) / 2;
  const dome = new THREE.Mesh(
    new THREE.SphereGeometry(150, 32, 16),
    new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
      uniforms: {
        top: { value: new THREE.Color(theme.skyTop) },
        horizon: { value: new THREE.Color(theme.skyHorizon) },
        sunColor: { value: new THREE.Color(theme.sunColor) },
        sunDir: { value: new THREE.Vector3(...theme.sunDir).normalize() },
        clouds: { value: theme.clouds },
      },
      vertexShader: 'varying vec3 vDir; void main() { vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
      fragmentShader: `
        uniform vec3 top; uniform vec3 horizon; uniform vec3 sunColor; uniform vec3 sunDir; uniform float clouds;
        varying vec3 vDir;
        void main() {
          vec3 d = normalize(vDir);
          float h = clamp(d.y, 0.0, 1.0);
          vec3 col = mix(horizon, top, pow(h, 0.55));
          if (d.y < 0.0) col = horizon * 0.7;
          float s = max(dot(d, normalize(sunDir)), 0.0);
          col += sunColor * (pow(s, 900.0) * 2.5 + pow(s, 10.0) * 0.22);
          vec2 p = d.xz / (d.y + 0.3) * 1.7;
          float n = sin(p.x * 1.7 + sin(p.y * 2.3)) * 0.5 + sin(p.x * 3.1 - p.y * 1.3) * 0.25 + sin(p.y * 4.3 + p.x * 0.7) * 0.125;
          float cl = smoothstep(0.1, 0.75, n + 0.25) * smoothstep(0.02, 0.3, d.y) * clouds;
          col = mix(col, mix(horizon, vec3(1.0), 0.6), cl * 0.55);
          gl_FragColor = vec4(col, 1.0);
          #include <colorspace_fragment>
        }`,
    }),
  );
  dome.frustumCulled = false;
  dome.renderOrder = -10;
  group.add(dome);

  // ---- light
  group.add(new THREE.HemisphereLight(theme.hemi[0], theme.hemi[1], theme.hemi[2]));
  const sun = new THREE.DirectionalLight(theme.sunColor, theme.sunIntensity);
  const dir = new THREE.Vector3(...theme.sunDir).normalize();
  sun.position.set(cx + dir.x * 70, dir.y * 70, cz + dir.z * 70);
  sun.target.position.set(cx, 0, cz);
  sun.castShadow = true;
  const reach = span * 0.75;
  sun.shadow.camera.left = -reach;
  sun.shadow.camera.right = reach;
  sun.shadow.camera.top = reach;
  sun.shadow.camera.bottom = -reach;
  sun.shadow.camera.near = 5;
  sun.shadow.camera.far = 170;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.03;
  group.add(sun, sun.target);

  // ---- skyline: a ring of far buildings (or quarry walls) beyond the arena
  if (theme.skyline) {
    const sk = theme.skyline;
    const windowTex = own(tex.windows(sk.wall, sk.lit, 111));
    const sideMat = sk.rock
      ? new THREE.MeshStandardMaterial({ map: own(tex.concrete(sk.wall, 112)), roughness: 1 })
      : new THREE.MeshStandardMaterial({ map: windowTex, emissiveMap: windowTex, emissive: new THREE.Color(0xffffff), emissiveIntensity: sk.lit > 0.3 ? 0.55 : 0.18, roughness: 0.9 });
    const roofMat = new THREE.MeshStandardMaterial({ color: new THREE.Color(sk.wall).multiplyScalar(0.8), roughness: 1 });
    const inner = span * 0.5 + 24;
    for (let i = 0; i < sk.count; i++) {
      const a = (i / sk.count) * Math.PI * 2 + hash(i, 1, 2) * 0.1;
      const r = inner + hash(i, 3, 4) * 22;
      const w = 7 + hash(i, 5, 6) * 9;
      const d = 7 + hash(i, 7, 8) * 9;
      const h = sk.heights[0] + hash(i, 9, 10) * (sk.heights[1] - sk.heights[0]);
      const geometry = new THREE.BoxGeometry(w, h, d);
      const pos = geometry.attributes.position;
      const uv = geometry.attributes.uv;
      for (let v = 0; v < pos.count; v++) {
        if (Math.floor(v / 4) === 2 || Math.floor(v / 4) === 3) continue;
        const horizontal = Math.floor(v / 4) < 2 ? pos.getZ(v) + d / 2 : pos.getX(v) + w / 2;
        uv.setXY(v, horizontal / 8, (pos.getY(v) + h / 2) / 12);
      }
      const mesh = new THREE.Mesh(geometry, [sideMat, sideMat, roofMat, roofMat, sideMat, sideMat]);
      mesh.position.set(cx + Math.cos(a) * r, h / 2 - 0.5, cz + Math.sin(a) * r);
      mesh.rotation.y = hash(i, 11, 12) * Math.PI;
      group.add(mesh);
    }
    // a ground plane out to the horizon so the buildings do not float
    const ground = new THREE.Mesh(new THREE.CircleGeometry(160, 32), new THREE.MeshBasicMaterial({ color: new THREE.Color(theme.fog[0]).multiplyScalar(0.55) }));
    ground.rotation.x = -Math.PI / 2;
    ground.position.set(cx, Math.min(...map.boxes.map((b) => b.min[1])) - 0.05, cz);
    group.add(ground);
  }

  // ---- signs on the outer walls
  const signMats: THREE.MeshBasicMaterial[] = [];
  const addSign = (text: string, x: number, y: number, z: number, rotY: number, w = 4.4): void => {
    const t = own(tex.sign(text, theme.signColors[0], theme.signColors[1]));
    const m = new THREE.MeshBasicMaterial({ map: t, color: 0xdddddd });
    signMats.push(m);
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, w / 4), m);
    mesh.position.set(x, y, z);
    mesh.rotation.y = rotY;
    group.add(mesh);
  };
  const north = map.bounds.min[2] + 1.02;
  const south = map.bounds.max[2] - 1.02;
  const west = map.bounds.min[0] + 1.02;
  addSign(theme.signs[0], cx - span * 0.18, 3.6, north, 0);
  addSign(theme.signs[1], cx + span * 0.22, 3.6, south, Math.PI);
  addSign(theme.signs[2], west, 3.6, cz, Math.PI / 2);

  // ---- floor markings
  const decalMat = (map_: THREE.Texture, color = 0xffffff): THREE.MeshBasicMaterial =>
    new THREE.MeshBasicMaterial({ map: own(map_), color, transparent: true, polygonOffset: true, polygonOffsetFactor: -2, depthWrite: false });
  const lane = (x0: number, z0: number, x1: number, z1: number, width = 0.22): void => {
    const len = Math.hypot(x1 - x0, z1 - z0);
    const t = tex.laneMarking();
    t.repeat.set(len / 4, 1);
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(len, width), decalMat(t));
    mesh.rotation.x = -Math.PI / 2;
    mesh.rotation.z = Math.atan2(z1 - z0, x1 - x0) * -1;
    mesh.position.set((x0 + x1) / 2, 0.012, (z0 + z1) / 2);
    group.add(mesh);
  };
  if (theme.marks === 'yard') {
    lane(map.bounds.min[0] + 2, -3.2, map.bounds.max[0] - 2, -3.2);
    lane(map.bounds.min[0] + 2, 3.2, map.bounds.max[0] - 2, 3.2);
  } else if (theme.marks === 'warehouse') {
    lane(map.bounds.min[0] + 2, 0, map.bounds.max[0] - 2, 0, 0.3);
    lane(0, map.bounds.min[2] + 2, 0, map.bounds.max[2] - 2, 0.3);
  } else if (theme.marks === 'plaza') {
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(5.9, 6.15, 64),
      new THREE.MeshBasicMaterial({ color: 0xe9e2c8, transparent: true, opacity: 0.8, polygonOffset: true, polygonOffsetFactor: -2, depthWrite: false }),
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(0, 0.012, 0);
    group.add(ring);
  }

  // ---- hazard stripes around the top edge of high decks
  const hazardTex = own(tex.hazard());
  hazardTex.wrapS = THREE.RepeatWrapping;
  for (const b of map.boxes) {
    if (b.kind !== 'platform' || b.max[1] < 2) continue;
    const sx = b.max[0] - b.min[0];
    const sz = b.max[2] - b.min[2];
    if (Math.min(sx, sz) < 3) continue; // stairs have no stripe
    const top = b.max[1] + 0.012;
    const strip = (x: number, z: number, w: number, d: number): void => {
      const t = hazardTex.clone();
      t.needsUpdate = true;
      t.repeat.set(Math.max(w, d) / 1.6, 1);
      own(t);
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, d), new THREE.MeshBasicMaterial({ map: t, color: 0xdddddd, polygonOffset: true, polygonOffsetFactor: -2 }));
      mesh.rotation.x = -Math.PI / 2;
      mesh.position.set(x, top, z);
      group.add(mesh);
    };
    // Along the two long edges only; the short ends are where stairs and bridges join.
    strip((b.min[0] + b.max[0]) / 2, b.min[2] + 0.2, sx - 0.4, 0.3);
    strip((b.min[0] + b.max[0]) / 2, b.max[2] - 0.2, sx - 0.4, 0.3);
  }

  // ---- lamps and the roof (all out of reach)
  const lampMat = new THREE.MeshBasicMaterial({ color: 0xfff3d0 });
  if (theme.lamps === 'strips') {
    const y = 5.3;
    for (const [x0, z0, x1, z1] of [
      [map.bounds.min[0] + 1.1, map.bounds.min[2] + 1.15, map.bounds.max[0] - 1.1, map.bounds.min[2] + 1.15],
      [map.bounds.min[0] + 1.1, map.bounds.max[2] - 1.15, map.bounds.max[0] - 1.1, map.bounds.max[2] - 1.15],
    ]) {
      const len = Math.abs(x1 - x0);
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(len, 0.12, 0.12), lampMat);
      mesh.position.set((x0 + x1) / 2, y, (z0 + z1) / 2);
      group.add(mesh);
    }
  }
  if (theme.roof) {
    const roofTex = own(tex.metalPlate('#2f343b', 120));
    roofTex.repeat.set(span / 3, span / 3);
    const roofMat = new THREE.MeshStandardMaterial({ map: roofTex, roughness: 0.7, metalness: 0.4 });
    const roofMesh = new THREE.Mesh(new THREE.BoxGeometry(span + 2, 0.4, span + 2), roofMat);
    roofMesh.position.set(cx, 7.2, cz);
    roofMesh.receiveShadow = false;
    group.add(roofMesh);
    const beamMat = new THREE.MeshStandardMaterial({ color: 0x1f2328, roughness: 0.6, metalness: 0.5 });
    for (let i = -2; i <= 2; i++) {
      const beam = new THREE.Mesh(new THREE.BoxGeometry(span, 0.4, 0.4), beamMat);
      beam.position.set(cx, 6.8, cz + i * (span / 5));
      group.add(beam);
    }
    for (let i = -1; i <= 1; i += 2) {
      for (let j = -1; j <= 1; j += 2) {
        const lamp = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.7, 0.35, 12), new THREE.MeshStandardMaterial({ color: 0x2b2f35, roughness: 0.5, metalness: 0.5 }));
        lamp.position.set(cx + i * span * 0.25, 6.2, cz + j * span * 0.25);
        const bulb = new THREE.Mesh(new THREE.CircleGeometry(0.62, 16), lampMat);
        bulb.rotation.x = Math.PI / 2;
        bulb.position.y = -0.18;
        lamp.add(bulb);
        const chain = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 0.6, 4), beamMat);
        chain.position.y = 0.45;
        lamp.add(chain);
        group.add(lamp);
      }
    }
  }

  const fogColor = new THREE.Color(theme.fog[0]).getHex();
  return {
    group,
    sky: fogColor,
    fog: { color: fogColor, near: theme.fog[1], far: theme.fog[2] },
    sun,
    follow: (p) => dome.position.copy(p),
    textures: [...owned, ...Array.from(mats.values()).flatMap((m) => [m.map, m.bumpMap].filter((t): t is THREE.Texture => !!t))],
  };
}

/** Removes a world built by buildWorld and frees its GPU memory. */
export function disposeWorld(scene: THREE.Scene, world: World): void {
  scene.remove(world.group);
  const materials = new Set<THREE.Material>();
  world.group.traverse((o) => {
    const obj = o as THREE.Mesh;
    if (obj.geometry) obj.geometry.dispose();
    const m = obj.material;
    if (Array.isArray(m)) m.forEach((x) => materials.add(x));
    else if (m) materials.add(m);
  });
  materials.forEach((m) => m.dispose());
  world.sun.shadow.map?.dispose();
  new Set(world.textures).forEach((t) => t.dispose());
}
