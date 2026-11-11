/**
 * Player movement and collision. This is the one piece of code that the client
 * (for prediction) and the server (for the truth) both run, so it must stay a pure
 * function: same state + same input + same map => the exact same next state.
 * No clock, no randomness, no hidden state.
 */
import { BODY, DT, MOVE, SLIDE } from './config.ts';
import type { Box } from './map.ts';
import type { Input, PlayerState } from './types.ts';

const EPS = 1e-4;

export function createPlayer(x: number, y: number, z: number): PlayerState {
  return {
    x, y, z,
    vx: 0, vy: 0, vz: 0,
    grounded: false,
    sliding: false,
    slideTimer: 0,
    slideCooldown: 0,
    slideHeld: false,
  };
}

export function playerHeight(s: Pick<PlayerState, 'sliding'>): number {
  return s.sliding ? BODY.slideHeight : BODY.standHeight;
}

export function eyeHeight(s: Pick<PlayerState, 'sliding'>): number {
  return s.sliding ? BODY.slideEye : BODY.standEye;
}

// ---------------------------------------------------------------- collision

/** Strict overlap: touching faces do not count, so standing on a floor is not a collision. */
function overlaps(x: number, y: number, z: number, h: number, b: Box): boolean {
  return (
    x + BODY.radius > b.min[0] && x - BODY.radius < b.max[0] &&
    y + h > b.min[1] && y < b.max[1] &&
    z + BODY.radius > b.min[2] && z - BODY.radius < b.max[2]
  );
}

function anyHit(x: number, y: number, z: number, h: number, boxes: readonly Box[]): boolean {
  for (const b of boxes) if (overlaps(x, y, z, h, b)) return true;
  return false;
}

/** True if the player's box is inside any map box. Used by tests and validators. */
export function isColliding(s: PlayerState, boxes: readonly Box[]): boolean {
  return anyHit(s.x, s.y, s.z, playerHeight(s), boxes);
}

/** Would the player fit at full standing height where they are now? */
export function canStand(s: PlayerState, boxes: readonly Box[]): boolean {
  return !anyHit(s.x, s.y, s.z, BODY.standHeight, boxes);
}

/**
 * Move along one horizontal axis (exactly one of dx, dz is non-zero).
 * Walks up small ledges, otherwise stops flush against the face so the player
 * slides along walls instead of sticking to them.
 */
function moveHorizontal(s: PlayerState, dx: number, dz: number, h: number, boxes: readonly Box[]): void {
  if (dx === 0 && dz === 0) return;
  const nx = s.x + dx;
  const nz = s.z + dz;
  if (!anyHit(nx, s.y, nz, h, boxes)) {
    s.x = nx;
    s.z = nz;
    return;
  }

  if (s.grounded) {
    let top = -Infinity;
    for (const b of boxes) if (overlaps(nx, s.y, nz, h, b) && b.max[1] > top) top = b.max[1];
    const rise = top - s.y;
    if (rise > 0 && rise <= BODY.stepHeight && !anyHit(nx, top, nz, h, boxes)) {
      s.x = nx;
      s.z = nz;
      s.y = top;
      return;
    }
  }

  if (dx !== 0) {
    let limit = dx > 0 ? Infinity : -Infinity;
    for (const b of boxes) {
      if (!overlaps(nx, s.y, nz, h, b)) continue;
      limit = dx > 0
        ? Math.min(limit, b.min[0] - BODY.radius - EPS)
        : Math.max(limit, b.max[0] + BODY.radius + EPS);
    }
    s.x = limit;
    s.vx = 0;
  } else {
    let limit = dz > 0 ? Infinity : -Infinity;
    for (const b of boxes) {
      if (!overlaps(nx, s.y, nz, h, b)) continue;
      limit = dz > 0
        ? Math.min(limit, b.min[2] - BODY.radius - EPS)
        : Math.max(limit, b.max[2] + BODY.radius + EPS);
    }
    s.z = limit;
    s.vz = 0;
  }
}

function moveVertical(s: PlayerState, h: number, boxes: readonly Box[]): void {
  const ny = s.y + s.vy * DT;
  if (!anyHit(s.x, ny, s.z, h, boxes)) {
    s.y = ny;
    s.grounded = false;
    return;
  }
  if (s.vy <= 0) {
    // Landed: stand on the highest surface we dropped into.
    let top = -Infinity;
    for (const b of boxes) if (overlaps(s.x, ny, s.z, h, b) && b.max[1] > top) top = b.max[1];
    s.y = top;
    s.vy = 0;
    s.grounded = true;
  } else {
    // Bumped our head on a ceiling.
    let bottom = Infinity;
    for (const b of boxes) if (overlaps(s.x, ny, s.z, h, b) && b.min[1] < bottom) bottom = b.min[1];
    s.y = bottom - h - EPS;
    s.vy = 0;
    s.grounded = false;
  }
}

// ----------------------------------------------------------------- movement

function sane(v: number): number {
  return Number.isFinite(v) ? Math.max(-1, Math.min(1, v)) : 0;
}

function applyFriction(s: PlayerState): void {
  const speed = Math.hypot(s.vx, s.vz);
  if (speed === 0) return;
  const drop = Math.max(speed, MOVE.stopSpeed) * MOVE.friction * DT;
  const k = Math.max(0, speed - drop) / speed;
  s.vx *= k;
  s.vz *= k;
}

/** Push velocity toward wishSpeed along (dx, dz), never past it. */
function accelerate(s: PlayerState, dx: number, dz: number, wishSpeed: number, accel: number): void {
  if (wishSpeed <= 0) return;
  const add = wishSpeed - (s.vx * dx + s.vz * dz);
  if (add <= 0) return;
  const a = Math.min(add, accel * wishSpeed * DT);
  s.vx += dx * a;
  s.vz += dz * a;
}

function endSlide(s: PlayerState): void {
  s.sliding = false;
  s.slideTimer = 0;
  s.slideCooldown = SLIDE.cooldown;
}

/** Advance one player by one fixed tick (DT seconds). Returns a new state; the old one is untouched. */
export function step(prev: PlayerState, input: Input, boxes: readonly Box[]): PlayerState {
  const s: PlayerState = { ...prev };
  const forward = sane(input.forward);
  const strafe = sane(input.strafe);
  const yaw = Number.isFinite(input.yaw) ? input.yaw : 0;

  s.slideCooldown = Math.max(0, s.slideCooldown - DT);

  // Where the player wants to go, in world space. Forward at yaw 0 is -Z.
  const wx = -Math.sin(yaw) * forward + Math.cos(yaw) * strafe;
  const wz = -Math.cos(yaw) * forward - Math.sin(yaw) * strafe;
  const wl = Math.hypot(wx, wz);
  const wishDirX = wl > 0 ? wx / wl : 0;
  const wishDirZ = wl > 0 ? wz / wl : 0;
  const wishScale = Math.min(wl, 1); // partial stick or key input moves you slower

  // Start a slide on a fresh key press, while grounded and moving fast enough.
  const slidePressed = input.slide && !s.slideHeld;
  s.slideHeld = input.slide;
  if (slidePressed && s.grounded && !s.sliding && s.slideCooldown <= 0) {
    const speed = Math.hypot(s.vx, s.vz);
    if (speed >= SLIDE.minSpeed) {
      const k = Math.min(speed * SLIDE.boost, SLIDE.maxSpeed) / speed;
      s.vx *= k;
      s.vz *= k;
      s.sliding = true;
      s.slideTimer = SLIDE.duration;
    }
  }

  // Jump (a slide-jump keeps your speed). Not allowed if there's no room to stand up.
  if (input.jump && s.grounded && (!s.sliding || canStand(s, boxes))) {
    s.vy = MOVE.jumpSpeed;
    s.grounded = false;
    if (s.sliding) endSlide(s);
  }

  // Horizontal velocity.
  if (s.sliding && s.slideTimer > 0) {
    const speed = Math.hypot(s.vx, s.vz);
    if (speed > 0) {
      const k = Math.max(0, speed - SLIDE.decel * DT) / speed;
      s.vx *= k;
      s.vz *= k;
    }
    s.slideTimer = Math.max(0, s.slideTimer - DT);
  } else if (s.grounded) {
    applyFriction(s);
    const target = s.sliding ? MOVE.crouchSpeed : input.sprint ? MOVE.sprintSpeed : MOVE.walkSpeed;
    accelerate(s, wishDirX, wishDirZ, target * wishScale, MOVE.accel);
  } else {
    const target = input.sprint ? MOVE.sprintSpeed : MOVE.walkSpeed;
    accelerate(s, wishDirX, wishDirZ, target * wishScale, MOVE.airAccel);
  }
  const hs = Math.hypot(s.vx, s.vz);
  if (hs > MOVE.maxHorizontalSpeed) {
    const k = MOVE.maxHorizontalSpeed / hs;
    s.vx *= k;
    s.vz *= k;
  }

  s.vy = Math.max(-MOVE.maxFallSpeed, s.vy - MOVE.gravity * DT);

  // Move one axis at a time so players slide along walls.
  const h = playerHeight(s);
  moveHorizontal(s, s.vx * DT, 0, h, boxes);
  moveHorizontal(s, 0, s.vz * DT, h, boxes);
  moveVertical(s, h, boxes);

  // End the slide when it runs out or the player leaves the ground, but only if
  // there is headroom. Under a low ceiling the player stays crouched until clear.
  if (s.sliding && (s.slideTimer <= 0 || !s.grounded) && canStand(s, boxes)) endSlide(s);

  return s;
}
