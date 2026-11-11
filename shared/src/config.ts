/**
 * Every tunable number lives here. Units: metres, seconds, radians. Y is up.
 * The client and the (future) server import the same file, so they always agree.
 */

export const TICK_RATE = 60;
export const DT = 1 / TICK_RATE;

export const BODY = {
  radius: 0.35, // half-width of the collision box
  standHeight: 1.8,
  slideHeight: 1.0,
  standEye: 1.62, // camera height above the feet
  slideEye: 0.8,
  stepHeight: 0.4, // ledges up to this height are walked onto without jumping
} as const;

export const MOVE = {
  walkSpeed: 6,
  sprintSpeed: 9,
  crouchSpeed: 3, // only used while stuck sliding under a low ceiling
  accel: 10, // ground acceleration, scaled by the target speed
  airAccel: 2,
  friction: 8,
  stopSpeed: 1, // friction acts as if you were at least this fast, so you stop cleanly
  gravity: 24,
  jumpSpeed: 8.5, // apex = jumpSpeed^2 / (2 * gravity), about 1.5 m
  maxFallSpeed: 50,
  maxHorizontalSpeed: 13, // hard cap so strafe-jumping can't build unlimited speed
} as const;

export const SLIDE = {
  minSpeed: 6.5, // you need to be sprinting to start a slide
  boost: 1.45, // speed multiplier at the start of the slide (sprint 9 m/s -> about 13 m/s)
  maxSpeed: 13,
  duration: 0.8, // seconds of sliding
  decel: 9, // m/s lost per second while sliding
  cooldown: 1.0, // seconds before the next slide can start
} as const;

/**
 * Networking numbers shared by client and server.
 * The server runs the simulation at TICK_RATE and sends a snapshot every `snapshotEvery` ticks.
 */
export const NET = {
  snapshotEvery: 2, // 60 ticks/s / 2 = 30 snapshots/s
  inputRedundancy: 4, // each input packet repeats the newest unacknowledged inputs, so a lost packet costs nothing
  maxInputsPerPacket: 8, // the server rejects packets claiming more than this
  maxPacketBytes: 256, // the server ignores anything larger
  interpDelay: 0.1, // seconds: other players are drawn this far in the past so there is always a snapshot ahead
  snapDistance: 2, // metres: a correction bigger than this snaps instead of smoothing
  errorDecay: 12, // per second: how fast a smoothed correction fades out
  maxPending: 240, // client: unacknowledged inputs kept for replay (4 seconds)
  maxQueue: 20, // server: inputs waiting per player (a third of a second)
  inputBuffer: 2, // server: inputs to hold back before moving a player, so network jitter doesn't make them stall and lurch
  inputBufferMaxWait: 4, // server: but never hold a lone input longer than this many ticks
  budgetCap: 6, // server: most inputs one player may use in a single tick (catch-up after a stall)
  idleTimeoutTicks: 5 * TICK_RATE, // server: drop a player who sends nothing for 5 seconds
  fallLimit: -30, // server: below this height a player is respawned
} as const;
