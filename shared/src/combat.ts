import { WEAPONS } from './config.ts';

/**
 * The trigger rule, shared by the server and the client so they always agree on which input fires.
 * Everything here counts applied inputs, not wall-clock time, so it is a pure function of the input
 * stream just like movement: the client can tell exactly which of its inputs the server will treat
 * as a shot, and how many rounds are left in the magazine.
 *
 * Each gun has its own magazine (reserve ammo is unlimited). A reload starts when the reload key is
 * pressed with a magazine that is not full, or by itself when a magazine runs empty. It cannot fire
 * while reloading, and swapping guns cancels the reload (the magazine stays as it was).
 */
export class FireControl {
  cooldown = 0;
  weapon = 0;
  /** Rounds left in each gun's magazine, by weapon index. */
  mags: number[] = WEAPONS.map((w) => w.magSize);
  /** Ticks left in the reload in progress; 0 when not reloading. */
  reloadLeft = 0;
  private prevFire = false;
  private prevReload = false;

  /** Rounds in the magazine of the gun that is out. */
  get ammo(): number {
    return this.mags[this.weapon];
  }

  get reloading(): boolean {
    return this.reloadLeft > 0;
  }

  /** Call once per applied input. Returns true if this input fires a shot. */
  tick(fireHeld: boolean, alive: boolean, weaponIndex: number, reloadHeld = false): boolean {
    const weapon = WEAPONS[weaponIndex] !== undefined ? weaponIndex : 0;
    if (this.cooldown > 0) this.cooldown--;
    if (weapon !== this.weapon) {
      // Taking a gun out takes a moment, and swapping can't be used to skip a gun's own wait.
      this.weapon = weapon;
      this.cooldown = Math.max(this.cooldown, WEAPONS[weapon].switchTicks);
      this.reloadLeft = 0; // a reload in progress is abandoned
    }
    const pressed = fireHeld && !this.prevFire;
    this.prevFire = fireHeld;
    const reloadPressed = reloadHeld && !this.prevReload;
    this.prevReload = reloadHeld;
    if (!alive) return false;
    const w = WEAPONS[weapon];

    if (this.reloadLeft > 0) {
      this.reloadLeft--;
      if (this.reloadLeft === 0) this.mags[weapon] = w.magSize;
      return false; // no shooting while reloading
    }
    if ((reloadPressed && this.mags[weapon] < w.magSize) || this.mags[weapon] <= 0) {
      this.reloadLeft = w.reloadTicks;
      return false;
    }
    if (!fireHeld || this.cooldown > 0) return false;
    if (!w.auto && !pressed) return false; // semi-automatic guns need a fresh click for every shot
    this.cooldown = w.intervalTicks;
    this.mags[weapon]--;
    return true;
  }

  /** A fresh start: full magazines, nothing cooling down or reloading. */
  reset(): void {
    this.cooldown = 0;
    this.reloadLeft = 0;
    for (let i = 0; i < this.mags.length; i++) this.mags[i] = WEAPONS[i].magSize;
  }
}
