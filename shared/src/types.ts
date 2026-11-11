export interface PlayerState {
  // Feet position (the centre of the bottom face of the collision box).
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  grounded: boolean;
  sliding: boolean;
  slideTimer: number; // seconds of slide left
  slideCooldown: number; // seconds until another slide may start
  slideHeld: boolean; // slide key state last tick, to detect a fresh press
}

/** One tick of player input. yaw 0 looks toward -Z; positive yaw turns left. */
export interface Input {
  forward: number; // -1..1
  strafe: number; // -1..1, positive is right
  yaw: number;
  jump: boolean;
  sprint: boolean;
  slide: boolean;
}
