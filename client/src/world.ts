import * as THREE from 'three';
import type { BoxKind, GameMap } from '@shooter/shared';

const COLORS: Record<BoxKind, number> = {
  floor: 0x4a5663,
  wall: 0x6b7b8f,
  cover: 0xa37f45,
  platform: 0x5a8a66,
  ceiling: 0x7d5f93,
};

/** Builds the gray-box scene for a map: one mesh per collision box, plus outlines and a floor grid. */
export function buildWorld(scene: THREE.Scene, map: GameMap): void {
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
    scene.add(mesh);

    const outline = new THREE.LineSegments(new THREE.EdgesGeometry(geometry), edgeMaterial);
    outline.position.copy(mesh.position);
    scene.add(outline);
  }

  // A grid on the floor makes speed and distance easier to judge.
  const width = map.bounds.max[0] - map.bounds.min[0];
  const grid = new THREE.GridHelper(width, width, 0x000000, 0x000000);
  grid.position.set((map.bounds.min[0] + map.bounds.max[0]) / 2, 0.01, (map.bounds.min[2] + map.bounds.max[2]) / 2);
  const gridMaterial = grid.material as THREE.Material;
  gridMaterial.transparent = true;
  gridMaterial.opacity = 0.18;
  scene.add(grid);

  scene.add(new THREE.HemisphereLight(0xffffff, 0x556677, 1.6));
  const sun = new THREE.DirectionalLight(0xffffff, 1.4);
  sun.position.set(0.4, 1, 0.3);
  scene.add(sun);
}
