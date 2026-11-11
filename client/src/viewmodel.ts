import * as THREE from 'three';
import { WEAPONS } from '@hitscan/shared';

/**
 * The gun you hold, drawn in its own small scene on top of the world so it never sinks into walls.
 * The guns are simple blocks: no art files are needed, and they are easy to restyle later.
 */

interface GunSpec {
  parts: Array<{ size: [number, number, number]; pos: [number, number, number]; color: number; rotX?: number }>;
  muzzle: [number, number, number];
  hip: [number, number, number]; // where the gun sits at the hip
  adsY: number; // height of the gun when aiming, so the sights line up with the crosshair
  adsZ: number;
}

const DARK = 0x23272d;
const MID = 0x3a414b;
const WOOD = 0x6b4a2f;
const LIGHT = 0x59616d;

const GUNS: GunSpec[] = [
  { // Pistol
    parts: [
      { size: [0.05, 0.06, 0.24], pos: [0, 0, -0.12], color: MID },
      { size: [0.045, 0.12, 0.06], pos: [0, -0.085, -0.02], color: DARK, rotX: 0.2 },
      { size: [0.012, 0.014, 0.014], pos: [0, 0.037, -0.22], color: LIGHT },
    ],
    muzzle: [0, 0.005, -0.25], hip: [0.2, -0.2, -0.38], adsY: -0.095, adsZ: -0.3,
  },
  { // SMG
    parts: [
      { size: [0.06, 0.09, 0.34], pos: [0, 0, -0.15], color: DARK },
      { size: [0.04, 0.15, 0.05], pos: [0, -0.115, -0.12], color: MID, rotX: 0.1 },
      { size: [0.045, 0.1, 0.06], pos: [0, -0.085, 0.0], color: MID, rotX: 0.2 },
      { size: [0.03, 0.03, 0.14], pos: [0, 0.01, -0.39], color: LIGHT },
      { size: [0.05, 0.07, 0.2], pos: [0, -0.01, 0.15], color: MID },
      { size: [0.015, 0.025, 0.015], pos: [0, 0.057, -0.3], color: LIGHT },
    ],
    muzzle: [0, 0.01, -0.47], hip: [0.2, -0.2, -0.4], adsY: -0.11, adsZ: -0.28,
  },
  { // Shotgun
    parts: [
      { size: [0.045, 0.045, 0.62], pos: [0, 0.025, -0.3], color: LIGHT },
      { size: [0.04, 0.04, 0.5], pos: [0, -0.02, -0.25], color: DARK },
      { size: [0.075, 0.06, 0.18], pos: [0, -0.04, -0.34], color: WOOD },
      { size: [0.07, 0.1, 0.3], pos: [0, -0.005, 0.0], color: DARK },
      { size: [0.055, 0.12, 0.3], pos: [0, -0.03, 0.27], color: WOOD, rotX: -0.12 },
      { size: [0.012, 0.02, 0.012], pos: [0, 0.058, -0.58], color: LIGHT },
    ],
    muzzle: [0, 0.025, -0.62], hip: [0.2, -0.2, -0.3], adsY: -0.1, adsZ: -0.25,
  },
  { // Rifle
    parts: [
      { size: [0.065, 0.09, 0.5], pos: [0, 0, -0.2], color: DARK },
      { size: [0.03, 0.03, 0.26], pos: [0, 0.015, -0.58], color: LIGHT },
      { size: [0.05, 0.17, 0.07], pos: [0, -0.125, -0.15], color: MID, rotX: 0.2 },
      { size: [0.045, 0.1, 0.06], pos: [0, -0.085, 0.02], color: MID, rotX: 0.2 },
      { size: [0.055, 0.1, 0.27], pos: [0, -0.01, 0.27], color: MID, rotX: -0.08 },
      { size: [0.03, 0.04, 0.05], pos: [0, 0.065, -0.05], color: LIGHT },
      { size: [0.012, 0.03, 0.012], pos: [0, 0.07, -0.42], color: LIGHT },
    ],
    muzzle: [0, 0.015, -0.72], hip: [0.2, -0.2, -0.36], adsY: -0.135, adsZ: -0.27,
  },
  { // Sniper
    parts: [
      { size: [0.06, 0.09, 0.55], pos: [0, 0, -0.2], color: DARK },
      { size: [0.035, 0.035, 0.6], pos: [0, 0.012, -0.76], color: LIGHT },
      { size: [0.055, 0.055, 0.24], pos: [0, 0.095, -0.18], color: MID },
      { size: [0.075, 0.075, 0.04], pos: [0, 0.095, -0.31], color: LIGHT },
      { size: [0.05, 0.12, 0.34], pos: [0, -0.02, 0.32], color: WOOD, rotX: -0.1 },
      { size: [0.045, 0.1, 0.06], pos: [0, -0.085, 0.02], color: MID, rotX: 0.2 },
    ],
    muzzle: [0, 0.012, -1.07], hip: [0.2, -0.2, -0.3], adsY: -0.16, adsZ: -0.25,
  },
];

export class ViewModel {
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(60, 1, 0.01, 10);
  private guns: THREE.Group[] = [];
  private flashes: THREE.Mesh[] = [];
  private current = 0;
  private kickBack = 0; // how far the gun is thrown back by the last shots
  private flashTime = 0;
  private bobPhase = 0;
  private bobAmount = 0;
  private swap = 1; // 0 while a gun is being taken out, rising to 1: the gun rises into view
  private ads = 0;

  constructor() {
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x556677, 2.2));
    const sun = new THREE.DirectionalLight(0xffffff, 1.6);
    sun.position.set(0.5, 1, 0.8);
    this.scene.add(sun);

    for (const spec of GUNS) {
      const g = new THREE.Group();
      for (const p of spec.parts) {
        const m = new THREE.Mesh(
          new THREE.BoxGeometry(...p.size),
          new THREE.MeshStandardMaterial({ color: p.color, roughness: 0.7, metalness: 0.3 }),
        );
        m.position.set(...p.pos);
        if (p.rotX) m.rotation.x = p.rotX;
        g.add(m);
      }
      const flash = new THREE.Mesh(
        new THREE.BoxGeometry(0.07, 0.07, 0.05),
        new THREE.MeshBasicMaterial({ color: 0xffd27a, transparent: true, opacity: 0.95 }),
      );
      flash.position.set(...spec.muzzle);
      flash.visible = false;
      g.add(flash);
      g.visible = false;
      this.scene.add(g);
      this.guns.push(g);
      this.flashes.push(flash);
    }
    this.guns[0].visible = true;
  }

  resize(aspect: number): void {
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
  }

  setWeapon(i: number): void {
    if (i === this.current) return;
    this.guns[this.current].visible = false;
    this.current = i;
    this.guns[i].visible = true;
    this.swap = 0;
  }

  /** Call when a shot is fired. */
  kick(): void {
    this.kickBack = Math.min(1, this.kickBack + 0.6);
    this.flashTime = 0.045;
  }

  update(dt: number, ads: number, horizontalSpeed: number, grounded: boolean, visible: boolean): void {
    this.ads = ads;
    const spec = GUNS[this.current];
    const g = this.guns[this.current];
    const scopeHides = WEAPONS[this.current].scope && ads > 0.8;
    g.visible = visible && !scopeHides;

    this.kickBack *= Math.exp(-dt * 14);
    this.swap = Math.min(1, this.swap + dt * 4.5);
    this.flashTime = Math.max(0, this.flashTime - dt);
    this.flashes[this.current].visible = this.flashTime > 0;

    // Walking sway, weaker when aiming.
    const moving = grounded ? Math.min(1, horizontalSpeed / 9) : 0;
    this.bobAmount += (moving - this.bobAmount) * (1 - Math.exp(-dt * 8));
    this.bobPhase += dt * (6 + horizontalSpeed * 0.7);
    const bob = this.bobAmount * (1 - ads * 0.85);
    const bx = Math.sin(this.bobPhase) * 0.008 * bob;
    const by = Math.abs(Math.cos(this.bobPhase)) * 0.01 * bob;

    const hip = spec.hip;
    const x = hip[0] * (1 - ads) + bx;
    const y = hip[1] * (1 - ads) + spec.adsY * ads - by - (1 - this.swap) * 0.25;
    const z = hip[2] * (1 - ads) + spec.adsZ * ads + this.kickBack * 0.07;
    g.position.set(x, y, z);
    g.rotation.set(this.kickBack * 0.1 + (1 - this.swap) * 0.6, 0, 0);
  }

  render(renderer: THREE.WebGLRenderer): void {
    renderer.clearDepth();
    renderer.render(this.scene, this.camera);
  }
}
