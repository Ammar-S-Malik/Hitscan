import * as THREE from 'three';
import { GUNS, buildGun } from './guns.ts';

/**
 * Small side-on pictures of every gun, drawn once from the real gun models, for the menu and the
 * gun slots. Returns one image address per gun (an index into WEAPONS), or an empty list if the
 * pictures cannot be drawn, in which case the interface shows names only.
 */
export function renderGunIcons(width = 360, height = 150): string[] {
  try {
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
    renderer.setPixelRatio(1);
    renderer.setSize(width, height, false);
    renderer.setClearColor(0x000000, 0);
    const out: string[] = [];
    for (let i = 0; i < GUNS.length; i++) {
      const scene = new THREE.Scene();
      scene.add(new THREE.HemisphereLight(0xffffff, 0x8890b0, 2.6));
      const sun = new THREE.DirectionalLight(0xffffff, 2.2);
      sun.position.set(1, 1.2, 0.4);
      scene.add(sun);
      const { group } = buildGun(i);
      scene.add(group);
      group.updateMatrixWorld(true);
      const box = new THREE.Box3().setFromObject(group);
      const centre = box.getCenter(new THREE.Vector3());
      const size = box.getSize(new THREE.Vector3());
      // Looking along -x the barrel (which points down -z) runs to the right; fit the gun's length and height.
      const aspect = width / height;
      let halfW = (size.z / 2) * 1.08;
      let halfH = (size.y / 2) * 1.12;
      if (halfW / halfH < aspect) halfW = halfH * aspect;
      else halfH = halfW / aspect;
      const camera = new THREE.OrthographicCamera(-halfW, halfW, halfH, -halfH, 0.01, 10);
      camera.position.set(centre.x + 3, centre.y, centre.z);
      camera.lookAt(centre);
      renderer.render(scene, camera);
      out.push(renderer.domElement.toDataURL('image/png'));
    }
    renderer.dispose();
    renderer.forceContextLoss();
    return out;
  } catch {
    return [];
  }
}
