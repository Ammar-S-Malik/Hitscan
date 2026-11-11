import { COMBAT } from './config.ts';

/**
 * The trigger rule, shared by the server and the client so they always agree on which input fires.
 * The cooldown counts applied inputs, not wall-clock time, so it is a pure function of the input
 * stream just like movement: the client can tell exactly which of its inputs the server will treat
 * as a shot.
 */
export class FireControl {
  cooldown = 0;

  /** Call once per applied input. Returns true if this input fires a shot. */
  tick(fireHeld: boolean, alive: boolean): boolean {
    if (this.cooldown > 0) this.cooldown--;
    if (!alive || !fireHeld || this.cooldown > 0) return false;
    this.cooldown = COMBAT.fireIntervalTicks;
    return true;
  }

  reset(): void {
    this.cooldown = 0;
  }
}
