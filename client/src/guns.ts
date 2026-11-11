import * as THREE from 'three';

/**
 * The five gun models, built from boxes and cylinders so no art files are needed. Every gun points down -Z,
 * with the origin near the grip. The same models are used for the gun in your hands and the guns other players carry.
 */

export interface GunPart {
  size: [number, number, number]; // box: width, height, depth. Cylinder: radius, (unused), length along z
  pos: [number, number, number];
  color: number;
  rotX?: number;
  rotZ?: number;
  shape?: 'box' | 'cyl';
  glow?: number; // emissive colour, for lenses and sights
  shiny?: boolean;
}

export interface GunSpec {
  parts: GunPart[];
  muzzle: [number, number, number];
  hip: [number, number, number]; // where the gun sits at the hip, in first person
  adsY: number; // height of the gun when aiming, so the sights line up with the crosshair
  adsZ: number;
  rightHand: [number, number, number];
  leftHand: [number, number, number];
}

const DARK = 0x23272d;
const MID = 0x3a414b;
const WOOD = 0x6b4a2f;
const LIGHT = 0x59616d;
const STEEL = 0x8b939e;
const LENS = 0x3fd0ff;
const ORANGE = 0xe8793a;

const cyl = (r: number, len: number, pos: [number, number, number], color: number, extra: Partial<GunPart> = {}): GunPart => ({
  shape: 'cyl', size: [r, r, len], pos, color, ...extra,
});

const SIGHT = 0x121417;
const TIP = 0xff7a2e;

/**
 * Iron sights: a rear sight (a peep ring, or a notch) and a front post with a bright tip. `y` is the height of the sight
 * line: the middle of the ring, or the top of the notch blocks, and the tip of the front post. When you aim, the gun is moved
 * so that this line sits exactly at the centre of the screen, which is where the shots go.
 */
function ironSights(y: number, baseY: number, rearZ: number, frontZ: number, peep: boolean): GunPart[] {
  const parts: GunPart[] = [];
  if (peep) {
    const t = 0.011; // ring thickness; the hole is 14 mm
    parts.push(
      { size: [0.036, t, 0.01], pos: [0, y + 0.0125, rearZ], color: SIGHT },
      { size: [0.036, t, 0.01], pos: [0, y - 0.0125, rearZ], color: SIGHT },
      { size: [t, 0.014, 0.01], pos: [-0.0125, y, rearZ], color: SIGHT },
      { size: [t, 0.014, 0.01], pos: [0.0125, y, rearZ], color: SIGHT },
      { size: [0.018, Math.max(0.004, y - 0.018 - baseY), 0.012], pos: [0, baseY + Math.max(0.004, y - 0.018 - baseY) / 2, rearZ], color: SIGHT },
    );
  } else {
    parts.push(
      { size: [0.011, 0.016, 0.01], pos: [-0.0105, y - 0.008, rearZ], color: SIGHT },
      { size: [0.011, 0.016, 0.01], pos: [0.0105, y - 0.008, rearZ], color: SIGHT },
    );
  }
  const post = Math.max(0.006, y - baseY - 0.004);
  parts.push(
    { size: [0.006, post, 0.006], pos: [0, y - 0.004 - post / 2, frontZ], color: SIGHT },
    { size: [0.006, 0.006, 0.006], pos: [0, y - 0.003, frontZ], color: TIP, glow: 0x7a2e00 },
    { size: [0.016, 0.008, 0.02], pos: [0, baseY + 0.004, frontZ], color: SIGHT },
  );
  return parts;
}

export const GUNS: GunSpec[] = [
  { // Pistol
    parts: [
      { size: [0.05, 0.06, 0.24], pos: [0, 0, -0.12], color: MID },
      { size: [0.052, 0.012, 0.22], pos: [0, 0.034, -0.12], color: STEEL, shiny: true }, // slide top
      { size: [0.045, 0.12, 0.06], pos: [0, -0.085, -0.02], color: DARK, rotX: 0.2 },
      { size: [0.046, 0.02, 0.07], pos: [0, -0.15, -0.002], color: LIGHT, rotX: 0.2 }, // magazine base
      { size: [0.012, 0.03, 0.06], pos: [0, -0.05, -0.1], color: DARK }, // trigger guard
      cyl(0.011, 0.04, [0, 0.003, -0.255], DARK),
      ...ironSights(0.05, 0.04, -0.015, -0.225, false),
    ],
    muzzle: [0, 0.005, -0.27], hip: [0.2, -0.2, -0.38], adsY: -0.05, adsZ: -0.3,
    rightHand: [0, -0.09, -0.02], leftHand: [-0.02, -0.08, -0.07],
  },
  { // SMG
    parts: [
      { size: [0.06, 0.09, 0.34], pos: [0, 0, -0.15], color: DARK },
      { size: [0.05, 0.012, 0.3], pos: [0, 0.05, -0.15], color: MID }, // top rail
      { size: [0.04, 0.15, 0.05], pos: [0, -0.115, -0.12], color: MID, rotX: 0.1 },
      { size: [0.042, 0.02, 0.06], pos: [0, -0.2, -0.105], color: LIGHT, rotX: 0.1 },
      { size: [0.045, 0.1, 0.06], pos: [0, -0.085, 0.0], color: MID, rotX: 0.2 },
      cyl(0.017, 0.22, [0, 0.01, -0.4], LIGHT), // suppressor
      cyl(0.019, 0.02, [0, 0.01, -0.5], DARK),
      { size: [0.05, 0.07, 0.2], pos: [0, -0.01, 0.15], color: MID },
      { size: [0.012, 0.012, 0.16], pos: [0, 0.02, 0.28], color: STEEL }, // wire stock
      ...ironSights(0.088, 0.056, 0.02, -0.31, true),
    ],
    muzzle: [0, 0.01, -0.51], hip: [0.2, -0.2, -0.4], adsY: -0.088, adsZ: -0.28,
    rightHand: [0, -0.1, 0.0], leftHand: [0, -0.1, -0.26],
  },
  { // Shotgun
    parts: [
      cyl(0.023, 0.62, [0, 0.025, -0.3], LIGHT, { shiny: true }), // barrel
      cyl(0.02, 0.5, [0, -0.02, -0.25], DARK), // magazine tube
      cyl(0.024, 0.03, [0, -0.02, -0.52], STEEL), // tube cap
      { size: [0.075, 0.06, 0.18], pos: [0, -0.04, -0.34], color: WOOD }, // pump
      { size: [0.078, 0.012, 0.18], pos: [0, -0.07, -0.34], color: 0x4f3622 },
      { size: [0.07, 0.1, 0.3], pos: [0, -0.005, 0.0], color: DARK },
      { size: [0.012, 0.03, 0.05], pos: [0, -0.06, -0.06], color: DARK }, // trigger guard
      { size: [0.055, 0.12, 0.3], pos: [0, -0.03, 0.27], color: WOOD, rotX: -0.12 },
      { size: [0.058, 0.13, 0.02], pos: [0, -0.04, 0.43], color: DARK, rotX: -0.12 }, // butt pad
      ...ironSights(0.082, 0.05, -0.02, -0.58, true),
    ],
    muzzle: [0, 0.025, -0.62], hip: [0.2, -0.2, -0.3], adsY: -0.082, adsZ: -0.25,
    rightHand: [0, -0.05, 0.03], leftHand: [0, -0.07, -0.34],
  },
  { // Rifle
    parts: [
      { size: [0.065, 0.09, 0.5], pos: [0, 0, -0.2], color: DARK },
      { size: [0.05, 0.012, 0.46], pos: [0, 0.05, -0.2], color: MID }, // rail
      { size: [0.06, 0.07, 0.24], pos: [0, 0.0, -0.5], color: LIGHT }, // handguard
      cyl(0.014, 0.12, [0, 0.015, -0.7], DARK), // barrel tip
      cyl(0.02, 0.05, [0, 0.015, -0.76], STEEL, { shiny: true }), // flash hider
      { size: [0.05, 0.17, 0.07], pos: [0, -0.125, -0.15], color: MID, rotX: 0.2 }, // magazine
      { size: [0.052, 0.02, 0.075], pos: [0, -0.215, -0.185], color: DARK, rotX: 0.2 },
      { size: [0.045, 0.1, 0.06], pos: [0, -0.085, 0.02], color: MID, rotX: 0.2 },
      { size: [0.055, 0.1, 0.27], pos: [0, -0.01, 0.27], color: MID, rotX: -0.08 },
      ...ironSights(0.092, 0.056, -0.04, -0.42, true),
    ],
    muzzle: [0, 0.015, -0.79], hip: [0.2, -0.2, -0.36], adsY: -0.092, adsZ: -0.27,
    rightHand: [0, -0.1, 0.02], leftHand: [0, -0.07, -0.45],
  },
  { // Sniper
    parts: [
      { size: [0.06, 0.09, 0.55], pos: [0, 0, -0.2], color: DARK },
      cyl(0.017, 0.6, [0, 0.012, -0.76], LIGHT, { shiny: true }), // long barrel
      cyl(0.024, 0.07, [0, 0.012, -1.07], STEEL, { shiny: true }), // muzzle brake
      cyl(0.03, 0.26, [0, 0.095, -0.18], MID), // scope tube
      cyl(0.04, 0.05, [0, 0.095, -0.33], DARK), // front bell
      cyl(0.034, 0.04, [0, 0.095, -0.03], DARK), // rear bell
      cyl(0.03, 0.006, [0, 0.095, -0.357], LENS, { glow: 0x0a4a66 }), // front lens
      { size: [0.02, 0.04, 0.03], pos: [0, 0.055, -0.1], color: DARK }, // scope mounts
      { size: [0.02, 0.04, 0.03], pos: [0, 0.055, -0.26], color: DARK },
      { size: [0.05, 0.12, 0.34], pos: [0, -0.02, 0.32], color: WOOD, rotX: -0.1 },
      { size: [0.045, 0.1, 0.06], pos: [0, -0.085, 0.02], color: MID, rotX: 0.2 },
      { size: [0.03, 0.012, 0.012], pos: [0.045, 0.02, 0.0], color: STEEL }, // bolt handle
      { size: [0.016, 0.016, 0.016], pos: [0.065, 0.02, 0.0], color: STEEL },
      { size: [0.01, 0.1, 0.01], pos: [-0.03, -0.12, -0.5], color: DARK, rotZ: 0.4 }, // bipod legs
      { size: [0.01, 0.1, 0.01], pos: [0.03, -0.12, -0.5], color: DARK, rotZ: -0.4 },
    ],
    muzzle: [0, 0.012, -1.1], hip: [0.2, -0.2, -0.3], adsY: -0.095, adsZ: -0.25,
    rightHand: [0, -0.1, 0.03], leftHand: [0, -0.05, -0.38],
  },
];

const materials = new Map<string, THREE.MeshStandardMaterial>();
function materialFor(p: GunPart): THREE.MeshStandardMaterial {
  const key = `${p.color}:${p.glow ?? 0}:${p.shiny ? 1 : 0}`;
  let m = materials.get(key);
  if (!m) {
    m = new THREE.MeshStandardMaterial({
      color: p.color,
      roughness: p.shiny ? 0.35 : 0.7,
      metalness: p.shiny ? 0.7 : 0.3,
      emissive: p.glow ?? 0x000000,
    });
    materials.set(key, m);
  }
  return m;
}

export interface GunModel {
  group: THREE.Group;
  flash: THREE.Mesh;
}

/** Builds one gun. The muzzle flash starts hidden; the caller turns it on for a few frames per shot. */
export function buildGun(index: number): GunModel {
  const spec = GUNS[index];
  const group = new THREE.Group();
  for (const p of spec.parts) {
    const geometry =
      p.shape === 'cyl'
        ? new THREE.CylinderGeometry(p.size[0], p.size[0], p.size[2], 10).rotateX(Math.PI / 2)
        : new THREE.BoxGeometry(...p.size);
    const mesh = new THREE.Mesh(geometry, materialFor(p));
    mesh.position.set(...p.pos);
    if (p.rotX) mesh.rotation.x = p.rotX;
    if (p.rotZ) mesh.rotation.z = p.rotZ;
    group.add(mesh);
  }
  const flash = new THREE.Mesh(
    new THREE.BoxGeometry(0.07, 0.07, 0.05),
    new THREE.MeshBasicMaterial({ color: 0xffd27a, transparent: true, opacity: 0.95 }),
  );
  flash.position.set(...spec.muzzle);
  flash.visible = false;
  flash.userData.own = true;
  group.add(flash);
  return { group, flash };
}
