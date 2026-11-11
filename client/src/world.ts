import * as THREE from 'three';
import type { BoxKind, GameMap } from '@hitscan/shared';

const COLORS: Record<BoxKind, number> = {
  floor: 0x4a5663,
  wall: 0x6b7b8f,
  cover: 0xa37f45,
  platform: 0x5a8a66,
  ceiling: 0x7d5f93,
};

export interface World {
  group: THREE.Group;
  sky: number;
}

export const DEFAULT_SKY = 0x9fb4c8;

/** Builds the gray-box scene for a map: one mesh per collision box, plus outlines and a floor grid. */
export function buildWorld(scene: THREE.Scene, map: GameMap): World {
  const group = new THREE.Group();
  scene.add(group);
  const materials = new Map<BoxKind, THREE.MeshStandardMaterial>();
  const edgeMaterial = new THREE.LineBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.35 });

  for (const b of map.boxes) {
    let material = materials.get(b.kind);
    if (!material) {
      material = new THREE.MeshStandardMaterial({ color: COLORS[b.kind], roughness: 0.9, metalness: 0 });
      materials.set(b.kind, material);
    }
    const sx = b.max[0] - b.min[0];
    const sy = b.max[1] - b.min[1];
    const sz = b.max[2] - b.min[2];
    const geometry = new THREE.BoxGeometry(sx, sy, sz);
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set((b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2);
    group.add(mesh);

    const outline = new THREE.LineSegments(new THREE.EdgesGeometry(geometry), edgeMaterial);
    outline.position.copy(mesh.position);
    group.add(outline);
  }

  // A grid on the floor makes speed and distance easier to judge.
  const width = Math.max(map.bounds.max[0] - map.bounds.min[0], map.bounds.max[2] - map.bounds.min[2]);
  const grid = new THREE.GridHelper(width, width, 0x000000, 0x000000);
  grid.position.set((map.bounds.min[0] + map.bounds.max[0]) / 2, 0.01, (map.bounds.min[2] + map.bounds.max[2]) / 2);
  const gridMaterial = grid.material as THREE.Material;
  gridMaterial.transparent = true;
  gridMaterial.opacity = 0.18;
  group.add(grid);

  group.add(new THREE.HemisphereLight(0xffffff, 0x556677, 1.6));
  const sun = new THREE.DirectionalLight(0xffffff, 1.4);
  sun.position.set(0.4, 1, 0.3);
  group.add(sun);
  return { group, sky: map.sky ? parseInt(map.sky.slice(1), 16) : DEFAULT_SKY };
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
}
