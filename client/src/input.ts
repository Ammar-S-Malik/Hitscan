import type { Input } from '@hitscan/shared';

const SENSITIVITY = 0.0022; // radians per mouse pixel
const PITCH_LIMIT = Math.PI / 2 - 0.01;
// A single mouse event bigger than this (pixels) is treated as a bogus reading and ignored.
// Some browser and mouse combinations occasionally report one, and it whips the camera around.
const MAX_MOUSE_STEP = 1000;

/**
 * Collects keyboard and mouse state. The simulation runs at a fixed tick rate that
 * can differ from the frame rate, so presses that start and end between two ticks
 * are latched and still reach the next tick.
 */
export class InputState {
  yaw = 0;
  pitch = 0;
  /** Largest single mouse step (pixels) since the HUD last reset it. Diagnostics only. */
  peakStep = 0;
  /** How many bogus mouse readings have been thrown away. Diagnostics only. */
  ignoredSteps = 0;
  private keys = new Set<string>();
  private jumpLatch = false;
  private slideLatch = false;
  private respawnLatch = false;
  private fireHeld = false;
  private fireLatch = false;
  /** True while Tab is held: the scoreboard is shown. */
  showScores = false;
  private canvas: HTMLElement;

  constructor(canvas: HTMLElement) {
    this.canvas = canvas;

    window.addEventListener('keydown', (e) => {
      if (document.pointerLockElement !== this.canvas) return;
      if (e.code === 'Space' || e.code === 'Tab') e.preventDefault();
      if (e.code === 'Tab') this.showScores = true;
      if (e.repeat) return;
      this.keys.add(e.code);
      if (e.code === 'Space') this.jumpLatch = true;
      if (e.code === 'KeyC') this.slideLatch = true;
      if (e.code === 'KeyR') this.respawnLatch = true;
    });
    window.addEventListener('keyup', (e) => {
      this.keys.delete(e.code);
      if (e.code === 'Tab') this.showScores = false;
    });
    window.addEventListener('blur', () => {
      this.keys.clear();
      this.fireHeld = false;
      this.showScores = false;
    });

    // The trigger is the left mouse button. A press and release between two ticks is latched so a
    // quick click still fires once.
    window.addEventListener('mousedown', (e) => {
      if (e.button !== 0 || document.pointerLockElement !== this.canvas) return;
      this.fireHeld = true;
      this.fireLatch = true;
    });
    window.addEventListener('mouseup', (e) => {
      if (e.button === 0) this.fireHeld = false;
    });

    document.addEventListener('mousemove', (e) => {
      if (document.pointerLockElement !== this.canvas) return;
      const stepSize = Math.hypot(e.movementX, e.movementY);
      if (!(stepSize < MAX_MOUSE_STEP)) {
        this.ignoredSteps++;
        return;
      }
      if (stepSize > this.peakStep) this.peakStep = stepSize;
      this.yaw -= e.movementX * SENSITIVITY; // mouse right = turn right = yaw down
      this.pitch -= e.movementY * SENSITIVITY; // mouse up = look up
      this.pitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, this.pitch));
    });

    document.addEventListener('pointerlockchange', () => {
      if (document.pointerLockElement !== this.canvas) {
        this.keys.clear();
        this.fireHeld = false;
        this.showScores = false;
      }
    });
  }

  /** The input for the next simulation tick. */
  sample(): Input {
    const k = this.keys;
    const input: Input = {
      forward: (k.has('KeyW') ? 1 : 0) - (k.has('KeyS') ? 1 : 0),
      strafe: (k.has('KeyD') ? 1 : 0) - (k.has('KeyA') ? 1 : 0),
      yaw: this.yaw,
      jump: k.has('Space') || this.jumpLatch,
      sprint: k.has('ShiftLeft') || k.has('ShiftRight'),
      slide: k.has('KeyC') || this.slideLatch,
      pitch: this.pitch,
      fire: this.fireHeld || this.fireLatch,
      viewMs: 0, // filled in by the caller once it knows which moment of the server's time it is looking at
    };
    this.jumpLatch = false;
    this.slideLatch = false;
    this.fireLatch = false;
    return input;
  }

  /** True once per press of the respawn key. */
  takeRespawn(): boolean {
    const r = this.respawnLatch;
    this.respawnLatch = false;
    return r;
  }
}
