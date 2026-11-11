import * as THREE from 'three';
import { BODY } from '@hitscan/shared';
import { GUNS, buildGun } from './guns.ts';
import type { GunModel } from './guns.ts';

/**
 * The model for another player: a soldier made of boxes, with a visor, vest, boots and the gun they last fired.
 * The origin is at the feet and it faces -Z (yaw 0), like the simulation. It is drawn inside the player's hit box,
 * which is what the server actually checks shots against.
 */

const PANTS = 0x2c3037;
const BOOT = 0x17191c;
const SKIN = 0xc79a76;
const VEST = 0x2b2f36;
const VISOR = 0x3fd0ff;
const GRIP: [number, number, number] = [0.17, 0.52, -0.46]; // where the right hand holds the gun, relative to the waist

function box(w: number, h: number, d: number, color: number, y = 0, x = 0, z = 0, emissive = 0x000000): THREE.Mesh {
  const mesh = new THREE.Mesh(
    new THREE.BoxGeometry(w, h, d),
    new THREE.MeshStandardMaterial({ color, roughness: 0.8, emissive }),
  );
  mesh.position.set(x, y, z);
  mesh.userData.own = true; // this model's own material, freed with it
  return mesh;
}

export class Humanoid {
  readonly root = new THREE.Group();
  private pelvis = new THREE.Group(); // everything above the legs lives here, so a slide can lower and tilt it
  private upper = new THREE.Group(); // torso, head, arms and gun
  private legL = new THREE.Group();
  private legR = new THREE.Group();
  private armL = new THREE.Group();
  private armR = new THREE.Group();
  private guns: GunModel[] = [];
  private gun = 0;
  private phase = Math.random() * 6;
  private swing = 0; // how strongly the legs are swinging
  private slide = 0; // 0 standing, 1 sliding
  private flashTime = 0;

  constructor(hue: number) {
    const team = new THREE.Color().setHSL(hue, 0.6, 0.5);
    const teamDark = new THREE.Color().setHSL(hue, 0.5, 0.32);

    // Legs hang from the hip at y 0.9 and swing about it.
    for (const [leg, side] of [[this.legL, -1], [this.legR, 1]] as const) {
      leg.position.set(side * 0.1, 0.9, 0);
      leg.add(box(0.15, 0.78, 0.17, PANTS, -0.39));
      leg.add(box(0.17, 0.12, 0.25, BOOT, -0.84, 0, -0.03));
      this.pelvis.add(leg);
    }
    this.root.add(this.pelvis);
    this.pelvis.position.y = 0;

    // Upper body.
    this.upper.position.set(0, 0.9, 0);
    this.upper.add(box(0.36, 0.14, 0.22, PANTS, 0.05)); // waist
    this.upper.add(box(0.4, 0.5, 0.24, teamDark.getHex(), 0.38)); // shirt
    this.upper.add(box(0.34, 0.34, 0.06, VEST, 0.42, 0, -0.14)); // vest plate
    this.upper.add(box(0.34, 0.2, 0.06, VEST, 0.4, 0, 0.14));
    this.upper.add(box(0.1, 0.1, 0.1, SKIN, 0.69)); // neck
    this.upper.add(box(0.22, 0.22, 0.22, SKIN, 0.82)); // head
    this.upper.add(box(0.25, 0.1, 0.25, team.getHex(), 0.93)); // helmet
    this.upper.add(box(0.25, 0.14, 0.05, team.getHex(), 0.84, 0, 0.1)); // back of the helmet
    this.upper.add(box(0.2, 0.07, 0.04, VISOR, 0.84, 0, -0.115, 0x0a4a66)); // visor, shows which way they face
    this.root.add(this.upper);

    // Arms: the right one holds the gun forward, the left one supports it.
    this.armR.position.set(0.27, 0.62, 0);
    this.armR.add(box(0.11, 0.5, 0.11, teamDark.getHex(), -0.22));
    this.armR.add(box(0.09, 0.09, 0.09, SKIN, -0.5));
    this.armL.position.set(-0.27, 0.62, 0);
    this.armL.add(box(0.11, 0.5, 0.11, teamDark.getHex(), -0.22));
    this.armL.add(box(0.09, 0.09, 0.09, SKIN, -0.5));
    this.upper.add(this.armR, this.armL);

    for (let i = 0; i < GUNS.length; i++) {
      const g = buildGun(i);
      g.group.visible = i === 0;
      const rh = GUNS[i].rightHand; // the grip sits at the right hand
      g.group.position.set(GRIP[0] - rh[0], GRIP[1] - rh[1], GRIP[2] - rh[2]);
      this.upper.add(g.group);
      this.guns.push(g);
    }
    this.root.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) o.castShadow = true;
    });
    this.root.scale.setScalar(0.96); // the helmet would otherwise poke above the 1.8 m hit box
    this.poseArms();
  }

  /** Point both arms at the gun: the right at its grip, the left at the front hold. */
  private poseArms(): void {
    const spec = GUNS[this.gun];
    const g = this.guns[this.gun].group.position;
    const point = (arm: THREE.Group, target: THREE.Vector3): void => {
      const dir = target.clone().sub(arm.position).normalize();
      arm.quaternion.setFromUnitVectors(new THREE.Vector3(0, -1, 0), dir);
    };
    point(this.armR, new THREE.Vector3(...GRIP));
    point(this.armL, new THREE.Vector3(g.x + spec.leftHand[0], g.y + spec.leftHand[1], g.z + spec.leftHand[2]));
  }

  setWeapon(i: number): void {
    if (i === this.gun || i < 0 || i >= this.guns.length) return;
    this.guns[this.gun].group.visible = false;
    this.gun = i;
    this.guns[i].group.visible = true;
    this.poseArms();
  }

  /** A muzzle flash for a moment, when this player fires. */
  fire(): void {
    this.flashTime = 0.06;
  }

  /** `speed` is the horizontal speed in m/s, measured from how far they moved since the last frame. */
  update(dt: number, speed: number, sliding: boolean, grounded: boolean): void {
    const target = grounded && !sliding ? Math.min(1, speed / 6) : 0;
    this.swing += (target - this.swing) * (1 - Math.exp(-dt * 12));
    this.phase += dt * (4 + speed * 1.1);
    this.slide += ((sliding ? 1 : 0) - this.slide) * (1 - Math.exp(-dt * 14));

    const s = Math.sin(this.phase) * 0.55 * this.swing;
    const lean = this.slide;
    this.legL.rotation.x = s + lean * 1.3;
    this.legR.rotation.x = -s + lean * 1.3;
    // The legs drop with the slide, the upper body leans back, and the whole thing sits low to the ground.
    this.pelvis.position.y = -0.5 * lean;
    this.upper.position.y = 0.9 - 0.55 * lean;
    this.upper.rotation.x = lean * 0.9 + Math.sin(this.phase * 2) * 0.012 * this.swing;
    this.upper.position.z = lean * 0.12;

    this.flashTime = Math.max(0, this.flashTime - dt);
    this.guns[this.gun].flash.visible = this.flashTime > 0;
  }

  dispose(): void {
    this.root.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (mesh.geometry) mesh.geometry.dispose();
      if (mesh.userData.own && mesh.material) (mesh.material as THREE.Material).dispose();
    });
  }

  /** The hit box height is BODY.standHeight; this just documents that the model fits inside it. */
  static readonly height = BODY.standHeight;
}
