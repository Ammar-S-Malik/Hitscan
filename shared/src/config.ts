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

/** Combat rules that are the same for every gun. Per-gun numbers are in WEAPONS below. */
export const COMBAT = {
  maxHealth: 100,
  headHeight: 0.3, // a hit in the top 30 cm of the body is a head shot
  maxRange: 200,
  respawnTicks: 3 * TICK_RATE, // how long a dead player waits
  spawnShieldTicks: 90, // a freshly respawned player can't be hurt for this long
  maxRewindMs: 500, // lag compensation never looks further back than this
  historyTicks: 40, // how many ticks of player positions the server remembers (must cover maxRewindMs)
  teleportDistance: 3, // positions further apart than this between two ticks are a respawn, not movement
} as const;

export interface WeaponDef {
  name: string;
  damage: number; // per pellet, before head shots and distance falloff
  pellets: number; // rays per shot (the shotgun fires several)
  headMultiplier: number;
  intervalTicks: number; // ticks between shots (60 ticks = 1 second)
  auto: boolean; // true: hold to keep firing. false: one shot per click
  spread: number; // radians of random cone when firing from the hip
  adsSpread: number; // the same while aiming down sights
  falloffStart: number; // metres: full damage up to here
  falloffEnd: number; // metres: from here on, only `falloffMin` of the damage
  falloffMin: number;
  switchTicks: number; // delay before firing after switching to this gun
  adsFov: number; // degrees while aiming down sights (the normal view is 75)
  scope: boolean; // draw a scope instead of the gun when aiming
  recoil: number; // radians the view kicks up per shot (client only)
}

/** The five guns, in key order (1 to 5). The index is what travels over the network. */
export const WEAPONS: readonly WeaponDef[] = [
  {
    name: 'Pistol', damage: 22, pellets: 1, headMultiplier: 2, intervalTicks: 10, auto: false,
    spread: 0.006, adsSpread: 0.0015, falloffStart: 30, falloffEnd: 80, falloffMin: 0.7,
    switchTicks: 10, adsFov: 62, scope: false, recoil: 0.012,
  },
  {
    name: 'SMG', damage: 12, pellets: 1, headMultiplier: 1.5, intervalTicks: 4, auto: true,
    spread: 0.03, adsSpread: 0.012, falloffStart: 15, falloffEnd: 45, falloffMin: 0.5,
    switchTicks: 12, adsFov: 64, scope: false, recoil: 0.006,
  },
  {
    name: 'Shotgun', damage: 12, pellets: 8, headMultiplier: 1.5, intervalTicks: 48, auto: false,
    spread: 0.07, adsSpread: 0.05, falloffStart: 8, falloffEnd: 25, falloffMin: 0.15,
    switchTicks: 20, adsFov: 66, scope: false, recoil: 0.04,
  },
  {
    name: 'Rifle', damage: 28, pellets: 1, headMultiplier: 2, intervalTicks: 7, auto: true,
    spread: 0.012, adsSpread: 0.002, falloffStart: 40, falloffEnd: 100, falloffMin: 0.7,
    switchTicks: 15, adsFov: 52, scope: false, recoil: 0.01,
  },
  {
    name: 'Sniper', damage: 90, pellets: 1, headMultiplier: 2, intervalTicks: 78, auto: false,
    spread: 0.04, adsSpread: 0, falloffStart: 1000, falloffEnd: 1001, falloffMin: 1,
    switchTicks: 30, adsFov: 18, scope: true, recoil: 0.05,
  },
];
export const WEAPON_COUNT = WEAPONS.length;
