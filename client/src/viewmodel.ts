import * as THREE from 'three';
import { WEAPONS } from '@hitscan/shared';
import { GUNS, buildGun } from './guns.ts';
import type { GunModel } from './guns.ts';
import { NEUTRAL, reloadPose } from './reloadpose.ts';

/**
 * The gun you hold, drawn in its own small scene on top of the world so it never sinks into walls.
 * The gun models live in guns.ts; the hands are drawn here.
 */

const GLOVE = 0x2a2e34;
const SLEEVE = 0x3f5a4a;

/** A hand in a glove, with a sleeve running back toward the camera. */
function buildHand(at: [number, number, number], sideways: number): THREE.Group {
  const g = new THREE.Group();
  const glove = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.07, 0.1), new THREE.MeshStandardMaterial({ color: GLOVE, roughness: 0.9 }));
  glove.position.set(...at);
  g.add(glove);
  const dir = new THREE.Vector3(sideways, -0.45, 1).normalize();
  const sleeve = new THREE.Mesh(new THREE.BoxGeometry(0.075, 0.075, 0.5), new THREE.MeshStandardMaterial({ color: SLEEVE, roughness: 0.9 }));
  sleeve.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), dir);
  sleeve.position.set(at[0], at[1], at[2]).addScaledVector(dir, 0.3);
  g.add(sleeve);
  return g;
}

export class ViewModel {
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(60, 1, 0.01, 10);
  private guns: THREE.Group[] = [];
  private hands: THREE.Group[][] = [];
  private flashes: THREE.Mesh[] = [];
  private roles: GunModel['roles'][] = [];
  private shells: THREE.Mesh[] = [];
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

    GUNS.forEach((spec, i) => {
      const { group: g, flash, roles } = buildGun(i);
      const hands = [buildHand(spec.rightHand, 0.25), buildHand(spec.leftHand, -0.4)];
      g.add(...hands);
      // A shell or round that rides in the left hand while loading.
      const shell = new THREE.Mesh(new THREE.CylinderGeometry(0.009, 0.009, 0.04, 8), new THREE.MeshStandardMaterial({ color: 0xc9a227, metalness: 0.6, roughness: 0.4 }));
      shell.rotation.x = Math.PI / 2;
      shell.position.set(spec.leftHand[0], spec.leftHand[1] + 0.045, spec.leftHand[2] - 0.03);
      shell.visible = false;
      hands[1].add(shell);
      this.shells.push(shell);
      this.roles.push(roles);
      this.hands.push(hands);
      g.visible = false;
      this.scene.add(g);
      this.guns.push(g);
      this.flashes.push(flash);
    });
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

  /** `reload` is how far through a reload you are (0 to 1), or a negative number when you are not reloading. */
  update(dt: number, adsIn: number, horizontalSpeed: number, grounded: boolean, visible: boolean, reload = -1): void {
    const reloading = reload >= 0;
    const ads = reloading ? 0 : adsIn;
    this.ads = ads;
    const spec = GUNS[this.current];
    const g = this.guns[this.current];
    const scopeHides = WEAPONS[this.current].scope && ads > 0.8;
    g.visible = visible && !scopeHides;
    for (const h of this.hands[this.current]) h.visible = ads < 0.35; // looking down the sights, you see the sights, not your arms

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
    const pose = reloading ? reloadPose(this.current, reload) : NEUTRAL;
    g.position.set(x + pose.x, y + pose.y, z + pose.z);
    g.rotation.set(this.kickBack * 0.1 + (1 - this.swap) * 0.6 + pose.rotX, 0, pose.rotZ);
    this.applyPose(this.current, pose);
  }

  /** Move the hands, magazine, slide and pump to the reload pose (the neutral pose puts everything back). */
  private applyPose(i: number, pose: typeof NEUTRAL): void {
    const [right, left] = this.hands[i];
    right.position.set(...pose.right);
    left.position.set(...pose.left);
    this.shells[i].visible = pose.shell;
    const roles = this.roles[i];
    for (const m of roles.mag) {
      const base = m.userData.base as THREE.Vector3;
      m.position.set(base.x, base.y + pose.magDy, base.z);
      m.visible = pose.magShown;
    }
    for (const m of roles.bolt) {
      const base = m.userData.base as THREE.Vector3;
      m.position.set(base.x, base.y + pose.boltLift, base.z + pose.boltBack);
    }
    for (const m of roles.pump) {
      const base = m.userData.base as THREE.Vector3;
      m.position.set(base.x, base.y, base.z + pose.pumpBack);
    }
  }

  render(renderer: THREE.WebGLRenderer): void {
    renderer.clearDepth();
    renderer.render(this.scene, this.camera);
  }
}
