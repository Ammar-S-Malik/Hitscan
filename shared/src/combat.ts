import { WEAPONS } from './config.ts';

/**
 * The trigger rule, shared by the server and the client so they always agree on which input fires.
 * Everything here counts applied inputs, not wall-clock time, so it is a pure function of the input
 * stream just like movement: the client can tell exactly which of its inputs the server will treat
 * as a shot.
 */
export class FireControl {
  cooldown = 0;
  weapon = 0;
  private prevFire = false;

  /** Call once per applied input. Returns true if this input fires a shot. */
  tick(fireHeld: boolean, alive: boolean, weaponIndex: number): boolean {
    const weapon = WEAPONS[weaponIndex] !== undefined ? weaponIndex : 0;
    if (this.cooldown > 0) this.cooldown--;
    if (weapon !== this.weapon) {
      // Taking a gun out takes a moment, and swapping can't be used to skip a gun's own wait.
      this.weapon = weapon;
      this.cooldown = Math.max(this.cooldown, WEAPONS[weapon].switchTicks);
    }
    const pressed = fireHeld && !this.prevFire;
    this.prevFire = fireHeld;
    if (!alive || !fireHeld || this.cooldown > 0) return false;
    const w = WEAPONS[weapon];
    if (!w.auto && !pressed) return false; // semi-automatic guns need a fresh click for every shot
    this.cooldown = w.intervalTicks;
    return true;
  }

  reset(): void {
    this.cooldown = 0;
  }
}
