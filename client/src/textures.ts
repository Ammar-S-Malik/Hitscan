import * as THREE from 'three';

/**
 * Surface textures drawn with the canvas, so the maps need no image files. Each one is a seamless 256 px tile; the world
 * builder repeats it across a surface at a chosen size in metres. The random speckle is seeded, so every player sees the same walls.
 */

const SIZE = 256;

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Ctx = CanvasRenderingContext2D;

function canvas(w = SIZE, h = SIZE): { c: HTMLCanvasElement; g: Ctx } {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return { c, g: c.getContext('2d') as Ctx };
}

function finish(c: HTMLCanvasElement, repeat = true, color = true): THREE.CanvasTexture {
  const t = new THREE.CanvasTexture(c);
  if (repeat) {
    t.wrapS = THREE.RepeatWrapping;
    t.wrapT = THREE.RepeatWrapping;
  }
  if (color) t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

/** Random light and dark dots over what is already drawn: dirt, grain, worn paint. */
function speckle(g: Ctx, r: () => number, count: number, strength: number, size = 2): void {
  for (let i = 0; i < count; i++) {
    const v = r() > 0.5 ? 255 : 0;
    g.fillStyle = `rgba(${v},${v},${v},${(r() * strength).toFixed(3)})`;
    g.fillRect(Math.floor(r() * SIZE), Math.floor(r() * SIZE), 1 + Math.floor(r() * size), 1 + Math.floor(r() * size));
  }
}

function shade(hex: string, amount: number): string {
  const c = new THREE.Color(hex);
  c.offsetHSL(0, 0, amount);
  return `#${c.getHexString()}`;
}

export function concrete(base: string, seed = 1): THREE.CanvasTexture {
  const r = rng(seed);
  const { c, g } = canvas();
  g.fillStyle = base;
  g.fillRect(0, 0, SIZE, SIZE);
  for (let i = 0; i < 40; i++) {
    g.fillStyle = shade(base, (r() - 0.5) * 0.08);
    g.globalAlpha = 0.5;
    g.fillRect(r() * SIZE, r() * SIZE, 20 + r() * 60, 20 + r() * 60);
  }
  g.globalAlpha = 1;
  speckle(g, r, 5000, 0.18, 2);
  g.strokeStyle = 'rgba(0,0,0,0.22)'; // panel seams on two edges
  g.lineWidth = 3;
  g.beginPath();
  g.moveTo(0, 1.5);
  g.lineTo(SIZE, 1.5);
  g.moveTo(1.5, 0);
  g.lineTo(1.5, SIZE);
  g.stroke();
  g.strokeStyle = 'rgba(0,0,0,0.12)';
  g.lineWidth = 1;
  for (let i = 0; i < 3; i++) {
    g.beginPath();
    let x = r() * SIZE;
    let y = r() * SIZE;
    g.moveTo(x, y);
    for (let k = 0; k < 6; k++) {
      x += (r() - 0.5) * 30;
      y += r() * 18;
      g.lineTo(x, y);
    }
    g.stroke();
  }
  return finish(c);
}

export function tiles(base: string, grout: string, n = 4, seed = 2): THREE.CanvasTexture {
  const r = rng(seed);
  const { c, g } = canvas();
  const s = SIZE / n;
  g.fillStyle = grout;
  g.fillRect(0, 0, SIZE, SIZE);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      g.fillStyle = shade(base, (r() - 0.5) * 0.07);
      g.fillRect(i * s + 2, j * s + 2, s - 4, s - 4);
      g.fillStyle = 'rgba(255,255,255,0.06)';
      g.fillRect(i * s + 2, j * s + 2, s - 4, 3);
    }
  }
  speckle(g, r, 4000, 0.16, 2);
  return finish(c);
}

export function bricks(base: string, mortar: string, seed = 3): THREE.CanvasTexture {
  const r = rng(seed);
  const { c, g } = canvas();
  g.fillStyle = mortar;
  g.fillRect(0, 0, SIZE, SIZE);
  const rows = 8;
  const bh = SIZE / rows;
  const bw = SIZE / 4;
  for (let row = 0; row < rows; row++) {
    const off = row % 2 === 0 ? 0 : bw / 2;
    for (let i = -1; i < 5; i++) {
      g.fillStyle = shade(base, (r() - 0.5) * 0.12);
      g.fillRect(i * bw + off + 2, row * bh + 2, bw - 4, bh - 4);
    }
  }
  speckle(g, r, 5000, 0.22, 2);
  return finish(c);
}

export function planks(base: string, seed = 4): THREE.CanvasTexture {
  const r = rng(seed);
  const { c, g } = canvas();
  const n = 6;
  const pw = SIZE / n;
  for (let i = 0; i < n; i++) {
    g.fillStyle = shade(base, (r() - 0.5) * 0.1);
    g.fillRect(i * pw, 0, pw, SIZE);
    g.strokeStyle = 'rgba(0,0,0,0.35)';
    g.lineWidth = 2;
    g.strokeRect(i * pw + 1, -2, pw - 2, SIZE + 4);
    g.strokeStyle = 'rgba(0,0,0,0.1)';
    g.lineWidth = 1;
    for (let k = 0; k < 7; k++) {
      const x = i * pw + 4 + r() * (pw - 8);
      g.beginPath();
      g.moveTo(x, 0);
      g.lineTo(x + (r() - 0.5) * 6, SIZE);
      g.stroke();
    }
  }
  speckle(g, r, 2500, 0.15, 2);
  return finish(c);
}

/** A wooden shipping crate: frame, slats and a diagonal brace. Meant to be about a metre across. */
export function crate(base: string, seed = 5): THREE.CanvasTexture {
  const r = rng(seed);
  const { c, g } = canvas();
  g.fillStyle = shade(base, -0.05);
  g.fillRect(0, 0, SIZE, SIZE);
  for (let i = 0; i < 4; i++) {
    g.fillStyle = shade(base, (r() - 0.5) * 0.1);
    g.fillRect(14, 14 + i * 57, SIZE - 28, 53);
    g.strokeStyle = 'rgba(0,0,0,0.35)';
    g.strokeRect(14, 14 + i * 57, SIZE - 28, 53);
  }
  g.fillStyle = shade(base, 0.04); // frame
  g.fillRect(0, 0, SIZE, 16);
  g.fillRect(0, SIZE - 16, SIZE, 16);
  g.fillRect(0, 0, 16, SIZE);
  g.fillRect(SIZE - 16, 0, 16, SIZE);
  g.save();
  g.translate(SIZE / 2, SIZE / 2); // brace
  g.rotate(Math.PI / 4);
  g.fillStyle = shade(base, 0.02);
  g.fillRect(-SIZE * 0.62, -9, SIZE * 1.24, 18);
  g.strokeStyle = 'rgba(0,0,0,0.4)';
  g.strokeRect(-SIZE * 0.62, -9, SIZE * 1.24, 18);
  g.restore();
  g.fillStyle = 'rgba(30,20,10,0.8)';
  for (const [x, y] of [[8, 8], [SIZE - 8, 8], [8, SIZE - 8], [SIZE - 8, SIZE - 8]]) {
    g.beginPath();
    g.arc(x, y, 3, 0, Math.PI * 2);
    g.fill();
  }
  speckle(g, r, 2500, 0.18, 2);
  return finish(c);
}

export function corrugated(color: string, seed = 6, rust = 0.2): THREE.CanvasTexture {
  const r = rng(seed);
  const { c, g } = canvas();
  g.fillStyle = color;
  g.fillRect(0, 0, SIZE, SIZE);
  const ribs = 16;
  const w = SIZE / ribs;
  for (let i = 0; i < ribs; i++) {
    const grad = g.createLinearGradient(i * w, 0, (i + 1) * w, 0);
    grad.addColorStop(0, 'rgba(0,0,0,0.32)');
    grad.addColorStop(0.5, 'rgba(255,255,255,0.14)');
    grad.addColorStop(1, 'rgba(0,0,0,0.32)');
    g.fillStyle = grad;
    g.fillRect(i * w, 0, w, SIZE);
  }
  for (let i = 0; i < 90; i++) { // rust streaks and scuffs
    g.fillStyle = `rgba(${90 + r() * 40},${45 + r() * 25},20,${(r() * rust).toFixed(3)})`;
    g.fillRect(r() * SIZE, r() * SIZE, 2 + r() * 4, 6 + r() * 40);
  }
  speckle(g, r, 3500, 0.16, 2);
  return finish(c);
}

/** The door end of a shipping container; drawn to fit the face exactly, not tiled. */
export function containerDoor(color: string, seed = 7): THREE.CanvasTexture {
  const r = rng(seed);
  const { c, g } = canvas();
  g.fillStyle = color;
  g.fillRect(0, 0, SIZE, SIZE);
  for (let i = 0; i < 20; i++) {
    const x = (i * SIZE) / 20;
    g.fillStyle = i % 2 ? 'rgba(0,0,0,0.18)' : 'rgba(255,255,255,0.08)';
    g.fillRect(x, 0, SIZE / 20, SIZE);
  }
  g.strokeStyle = shade(color, -0.2);
  g.lineWidth = 8;
  g.strokeRect(4, 4, SIZE - 8, SIZE - 8);
  g.fillStyle = '#9aa0a8'; // locking bars
  for (const x of [SIZE * 0.3, SIZE * 0.44, SIZE * 0.56, SIZE * 0.7]) {
    g.fillRect(x - 3, 16, 6, SIZE - 32);
    g.fillStyle = '#2a2d31';
    g.fillRect(x - 6, SIZE * 0.45, 12, 18);
    g.fillStyle = '#9aa0a8';
  }
  g.fillStyle = 'rgba(0,0,0,0.3)';
  g.fillRect(SIZE / 2 - 1, 8, 2, SIZE - 16);
  speckle(g, r, 3000, 0.16, 2);
  return finish(c, false);
}

export function metalPlate(base: string, seed = 8): THREE.CanvasTexture {
  const r = rng(seed);
  const { c, g } = canvas();
  g.fillStyle = base;
  g.fillRect(0, 0, SIZE, SIZE);
  const n = 8;
  const s = SIZE / n;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const flip = (i + j) % 2 === 0;
      g.save();
      g.translate(i * s + s / 2, j * s + s / 2);
      g.rotate(flip ? Math.PI / 4 : -Math.PI / 4);
      g.fillStyle = 'rgba(255,255,255,0.2)';
      g.fillRect(-s * 0.32, -2, s * 0.64, 4);
      g.fillStyle = 'rgba(0,0,0,0.25)';
      g.fillRect(-s * 0.32, 2, s * 0.64, 2);
      g.restore();
    }
  }
  g.strokeStyle = 'rgba(0,0,0,0.35)';
  g.lineWidth = 3;
  g.strokeRect(1.5, 1.5, SIZE - 3, SIZE - 3);
  speckle(g, r, 3000, 0.16, 2);
  return finish(c);
}

export function grate(seed = 9): THREE.CanvasTexture {
  const r = rng(seed);
  const { c, g } = canvas();
  g.fillStyle = '#16181b';
  g.fillRect(0, 0, SIZE, SIZE);
  const n = 8;
  const s = SIZE / n;
  g.fillStyle = '#5b626b';
  for (let i = 0; i < n; i++) {
    g.fillRect(i * s, 0, 6, SIZE);
    g.fillRect(0, i * s, SIZE, 6);
  }
  g.fillStyle = 'rgba(255,255,255,0.12)';
  for (let i = 0; i < n; i++) {
    g.fillRect(i * s, 0, 2, SIZE);
    g.fillRect(0, i * s, SIZE, 2);
  }
  speckle(g, r, 1200, 0.2, 2);
  return finish(c);
}

export function asphalt(seed = 10): THREE.CanvasTexture {
  const r = rng(seed);
  const { c, g } = canvas();
  g.fillStyle = '#3b3e42';
  g.fillRect(0, 0, SIZE, SIZE);
  speckle(g, r, 12000, 0.35, 2);
  g.strokeStyle = 'rgba(0,0,0,0.3)';
  g.lineWidth = 2;
  for (let i = 0; i < 3; i++) {
    g.beginPath();
    let x = r() * SIZE;
    let y = r() * SIZE;
    g.moveTo(x, y);
    for (let k = 0; k < 8; k++) {
      x += (r() - 0.5) * 40;
      y += (r() - 0.5) * 40;
      g.lineTo(x, y);
    }
    g.stroke();
  }
  return finish(c);
}

/** A strip of yellow and black warning stripes, for the edge of a high deck. */
export function hazard(): THREE.CanvasTexture {
  const { c, g } = canvas(256, 64);
  g.fillStyle = '#e2b919';
  g.fillRect(0, 0, 256, 64);
  g.fillStyle = '#1a1a1a';
  for (let i = -4; i < 12; i++) {
    g.beginPath();
    g.moveTo(i * 32, 64);
    g.lineTo(i * 32 + 16, 64);
    g.lineTo(i * 32 + 16 + 64, 0);
    g.lineTo(i * 32 + 64, 0);
    g.closePath();
    g.fill();
  }
  return finish(c);
}

/** A painted sign: text on a coloured plate with a border. Not tiled. */
export function sign(text: string, bg: string, fg: string, w = 512, h = 128): THREE.CanvasTexture {
  const { c, g } = canvas(w, h);
  g.fillStyle = bg;
  g.fillRect(0, 0, w, h);
  g.strokeStyle = fg;
  g.lineWidth = 6;
  g.strokeRect(8, 8, w - 16, h - 16);
  g.fillStyle = fg;
  g.font = `bold ${Math.floor(h * 0.5)}px Arial, Helvetica, sans-serif`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(text, w / 2, h / 2 + 4);
  const r = rng(text.length * 77);
  for (let i = 0; i < 400; i++) {
    g.fillStyle = `rgba(0,0,0,${(r() * 0.2).toFixed(3)})`;
    g.fillRect(r() * w, r() * h, 2, 2);
  }
  return finish(c, false);
}

/** Painted lines on the floor: a dashed lane marking drawn along the texture's length. */
export function laneMarking(color = '#d9b92a'): THREE.CanvasTexture {
  const { c, g } = canvas(256, 32);
  g.clearRect(0, 0, 256, 32);
  g.fillStyle = color;
  g.globalAlpha = 0.85;
  for (let i = 0; i < 4; i++) g.fillRect(i * 64 + 6, 11, 40, 10);
  return finish(c);
}

/** A block of building windows for the skyline. `lit` is how much of it is lit. */
export function windows(wall: string, lit: number, seed = 11): THREE.CanvasTexture {
  const r = rng(seed);
  const { c, g } = canvas();
  g.fillStyle = wall;
  g.fillRect(0, 0, SIZE, SIZE);
  const cols = 8;
  const rows = 16;
  const w = SIZE / cols;
  const h = SIZE / rows;
  for (let i = 0; i < cols; i++) {
    for (let j = 0; j < rows; j++) {
      g.fillStyle = r() < lit ? `rgb(${230 + r() * 25},${190 + r() * 40},${110 + r() * 40})` : shade(wall, -0.04 + r() * 0.05);
      g.fillRect(i * w + 6, j * h + 4, w - 12, h - 8);
    }
  }
  return finish(c);
}
