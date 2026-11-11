import type { GameMap } from '@hitscan/shared';

/**
 * A top-down map in the corner. It shows the layout (higher ground is lighter), you and which way you face.
 * Other players are not shown, because that would be a wallhack. They show up as a red ping where they fired from,
 * for a moment after they shoot.
 */
const SIZE = 168;

export interface Ping {
  x: number;
  z: number;
  born: number; // performance.now() when it appeared
}

export class MiniMap {
  private ctx: CanvasRenderingContext2D;
  private layer = document.createElement('canvas');
  private scale = 1;
  private offX = 0;
  private offZ = 0;
  private dpr = Math.min(window.devicePixelRatio || 1, 2);

  constructor(private canvas: HTMLCanvasElement, map: GameMap) {
    canvas.width = Math.round(SIZE * this.dpr);
    canvas.height = Math.round(SIZE * this.dpr);
    canvas.style.width = `${SIZE}px`;
    canvas.style.height = `${SIZE}px`;
    this.ctx = canvas.getContext('2d') as CanvasRenderingContext2D;
    this.setMap(map);
  }

  /** Draws the map's walls and platforms once; every frame after that just copies it. */
  setMap(map: GameMap): void {
    const w = map.bounds.max[0] - map.bounds.min[0];
    const d = map.bounds.max[2] - map.bounds.min[2];
    this.scale = (SIZE - 8) / Math.max(w, d);
    this.offX = (SIZE - w * this.scale) / 2 - map.bounds.min[0] * this.scale;
    this.offZ = (SIZE - d * this.scale) / 2 - map.bounds.min[2] * this.scale;

    this.layer.width = this.canvas.width;
    this.layer.height = this.canvas.height;
    const g = this.layer.getContext('2d') as CanvasRenderingContext2D;
    g.scale(this.dpr, this.dpr);
    g.fillStyle = 'rgba(14,17,22,0.72)';
    g.fillRect(0, 0, SIZE, SIZE);
    g.fillStyle = 'rgba(60,70,84,0.9)';
    g.fillRect(this.offX + map.bounds.min[0] * this.scale, this.offZ + map.bounds.min[2] * this.scale, w * this.scale, d * this.scale);

    // Lowest first, so higher things are drawn over lower ones. A pit's floor is darker than the ground.
    const boxes = map.boxes.filter((b) => b.kind !== 'floor' || b.max[1] < -0.5).sort((a, b) => a.max[1] - b.max[1]);
    for (const b of boxes) {
      const height = b.max[1];
      const tall = b.kind === 'wall' && height - b.min[1] > 2.5;
      const shade = tall ? 215 : Math.round(Math.max(40, Math.min(190, 100 + height * 32)));
      g.fillStyle = `rgb(${shade},${shade + (b.kind === 'cover' ? -20 : 0)},${shade + (b.kind === 'platform' ? -10 : 8)})`;
      g.fillRect(
        this.offX + b.min[0] * this.scale,
        this.offZ + b.min[2] * this.scale,
        Math.max(1, (b.max[0] - b.min[0]) * this.scale),
        Math.max(1, (b.max[2] - b.min[2]) * this.scale),
      );
    }
    g.strokeStyle = 'rgba(255,255,255,0.35)';
    g.strokeRect(0.5, 0.5, SIZE - 1, SIZE - 1);
  }

  /** `me` is where you are and which way you look (yaw 0 faces -Z, like the game). */
  draw(me: { x: number; z: number; yaw: number }, pings: Ping[], now: number): void {
    const g = this.ctx;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, this.canvas.width, this.canvas.height);
    g.drawImage(this.layer, 0, 0);
    g.scale(this.dpr, this.dpr);

    for (const p of pings) {
      const age = (now - p.born) / 1500;
      if (age >= 1) continue;
      g.fillStyle = `rgba(255,70,60,${(1 - age).toFixed(2)})`;
      g.beginPath();
      g.arc(this.offX + p.x * this.scale, this.offZ + p.z * this.scale, 2.5 + age * 5, 0, Math.PI * 2);
      g.fill();
    }

    const cx = this.offX + me.x * this.scale;
    const cz = this.offZ + me.z * this.scale;
    const dx = -Math.sin(me.yaw);
    const dz = -Math.cos(me.yaw);
    g.fillStyle = '#ffffff';
    g.beginPath();
    g.moveTo(cx + dx * 7, cz + dz * 7);
    g.lineTo(cx - dx * 4 - dz * 4.5, cz - dz * 4 + dx * 4.5);
    g.lineTo(cx - dx * 4 + dz * 4.5, cz - dz * 4 - dx * 4.5);
    g.closePath();
    g.fill();
  }
}
