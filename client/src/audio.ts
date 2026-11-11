import type { Vec3 } from '@hitscan/shared';

/**
 * All the game's sound, made in the browser with the Web Audio API: no sound files. Each effect is a
 * short burst of filtered noise and/or a swept tone, shaped by a volume envelope. Sounds from other
 * players are placed in 3D, so a shot behind you is heard behind you and gets quieter with distance.
 *
 * Browsers only allow audio after the player has clicked or pressed something, so `unlock()` is called
 * from the first click; until then every call here quietly does nothing.
 */

const STORAGE_KEY = 'hitscan.volume';
const MAX_VOICES = 40;

interface NoiseSpec {
  dur: number;
  filter: BiquadFilterType;
  freq: number;
  freqEnd?: number;
  q?: number;
  gain: number;
  delay?: number;
}

interface ToneSpec {
  type?: OscillatorType;
  f0: number;
  f1?: number;
  dur: number;
  gain: number;
  delay?: number;
}

type Sound = { noise?: NoiseSpec[]; tone?: ToneSpec[] };

/** One sound per gun, in the order of WEAPONS. */
const SHOTS: Sound[] = [
  { // pistol: a sharp crack with a short thump
    noise: [{ dur: 0.09, filter: 'bandpass', freq: 2200, q: 0.8, gain: 0.55 }],
    tone: [{ type: 'sine', f0: 220, f1: 70, dur: 0.09, gain: 0.5 }],
  },
  { // SMG: shorter and lighter, because it fires so often
    noise: [{ dur: 0.05, filter: 'bandpass', freq: 3000, q: 0.9, gain: 0.4 }],
    tone: [{ type: 'sine', f0: 180, f1: 85, dur: 0.05, gain: 0.3 }],
  },
  { // shotgun: a crack, then a long low boom
    noise: [
      { dur: 0.04, filter: 'highpass', freq: 3000, gain: 0.4 },
      { dur: 0.35, filter: 'lowpass', freq: 1800, freqEnd: 300, gain: 0.9 },
    ],
    tone: [{ type: 'sine', f0: 110, f1: 38, dur: 0.3, gain: 0.8 }],
  },
  { // rifle: a solid mid-weight bang
    noise: [{ dur: 0.12, filter: 'bandpass', freq: 1700, q: 0.7, gain: 0.6 }],
    tone: [{ type: 'sine', f0: 140, f1: 50, dur: 0.14, gain: 0.5 }],
  },
  { // sniper: a crack, a deep boom, and an echo rolling away
    noise: [
      { dur: 0.03, filter: 'highpass', freq: 2500, gain: 0.6 },
      { dur: 0.6, filter: 'lowpass', freq: 1000, freqEnd: 200, gain: 0.8 },
      { dur: 0.5, filter: 'lowpass', freq: 600, freqEnd: 150, gain: 0.25, delay: 0.18 },
    ],
    tone: [{ type: 'sine', f0: 80, f1: 28, dur: 0.45, gain: 0.9 }],
  },
];

export class GameAudio {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private noiseBuffer: AudioBuffer | null = null;
  private voices = 0;
  volume = 0.5;
  muted = false;

  constructor() {
    try {
      const saved = Number(localStorage.getItem(STORAGE_KEY));
      if (Number.isFinite(saved) && saved >= 0 && saved <= 1 && localStorage.getItem(STORAGE_KEY) !== null) this.volume = saved;
    } catch {
      // storage can be unavailable (private mode); the default is fine
    }
  }

  /** Start the audio engine. Call from a click or key press. Safe to call repeatedly. */
  unlock(): void {
    if (!this.ctx) {
      const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return;
      this.ctx = new Ctor();
      const compressor = this.ctx.createDynamicsCompressor(); // keeps a loud moment from clipping
      compressor.connect(this.ctx.destination);
      this.master = this.ctx.createGain();
      this.master.connect(compressor);
      this.applyVolume();

      const length = this.ctx.sampleRate; // one second of noise, reused by every effect
      this.noiseBuffer = this.ctx.createBuffer(1, length, this.ctx.sampleRate);
      const data = this.noiseBuffer.getChannelData(0);
      for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1;
    }
    if (this.ctx.state === 'suspended') void this.ctx.resume();
  }

  setVolume(v: number): void {
    this.volume = Math.max(0, Math.min(1, v));
    this.applyVolume();
    try {
      localStorage.setItem(STORAGE_KEY, String(this.volume));
    } catch {
      // not saved: fine
    }
  }

  toggleMute(): boolean {
    this.muted = !this.muted;
    this.applyVolume();
    return this.muted;
  }

  private applyVolume(): void {
    if (this.master) this.master.gain.value = this.muted ? 0 : this.volume * this.volume; // squared: slider feels even
  }

  /** Keep the 3D sound field lined up with the camera. Call every frame. */
  updateListener(pos: Vec3, forward: Vec3): void {
    const l = this.ctx?.listener;
    if (!l || !this.ctx) return;
    if (l.positionX) {
      const t = this.ctx.currentTime;
      l.positionX.setValueAtTime(pos[0], t);
      l.positionY.setValueAtTime(pos[1], t);
      l.positionZ.setValueAtTime(pos[2], t);
      l.forwardX.setValueAtTime(forward[0], t);
      l.forwardY.setValueAtTime(forward[1], t);
      l.forwardZ.setValueAtTime(forward[2], t);
      l.upX.setValueAtTime(0, t);
      l.upY.setValueAtTime(1, t);
      l.upZ.setValueAtTime(0, t);
    }
  }

  // ---------------------------------------------------------------- effects

  /** A gun going off. With a position it is heard in 3D (another player's shot); without, it is your own. */
  shot(weapon: number, at?: Vec3): void {
    this.play(SHOTS[weapon] ?? SHOTS[0], at);
  }

  hit(headshot: boolean, killed: boolean): void {
    if (killed) {
      this.play({ tone: [{ f0: 880, dur: 0.18, gain: 0.3 }, { f0: 1320, dur: 0.3, gain: 0.3, delay: 0.09 }] });
    } else if (headshot) {
      this.play({ tone: [{ f0: 2200, dur: 0.05, gain: 0.28 }, { f0: 2800, dur: 0.06, gain: 0.28, delay: 0.045 }] });
    } else {
      this.play({ tone: [{ f0: 1500, dur: 0.05, gain: 0.25 }] });
    }
  }

  damaged(): void {
    this.play({
      noise: [{ dur: 0.15, filter: 'lowpass', freq: 500, gain: 0.5 }],
      tone: [{ f0: 100, f1: 50, dur: 0.15, gain: 0.5 }],
    });
  }

  died(): void {
    this.play({ tone: [{ type: 'sawtooth', f0: 320, f1: 60, dur: 0.9, gain: 0.22 }], noise: [{ dur: 0.5, filter: 'lowpass', freq: 400, gain: 0.3 }] });
  }

  respawned(): void {
    this.play({ tone: [{ f0: 400, f1: 900, dur: 0.25, gain: 0.2 }] });
  }

  switched(): void {
    this.play({ noise: [{ dur: 0.03, filter: 'bandpass', freq: 4000, gain: 0.3 }], tone: [{ type: 'square', f0: 500, dur: 0.03, gain: 0.05 }] });
  }

  slid(): void {
    this.play({ noise: [{ dur: 0.5, filter: 'bandpass', freq: 600, freqEnd: 1800, q: 0.6, gain: 0.22 }] });
  }

  landed(): void {
    this.play({ noise: [{ dur: 0.15, filter: 'lowpass', freq: 300, gain: 0.5 }], tone: [{ f0: 70, f1: 40, dur: 0.12, gain: 0.4 }] });
  }

  /** A footstep. `at` places another player's step in the world. */
  step(at?: Vec3): void {
    const f = 380 + Math.random() * 160; // every step a little different
    this.play({ noise: [{ dur: 0.06, filter: 'lowpass', freq: f, gain: at ? 0.6 : 0.4 }] }, at);
  }

  roundStart(): void {
    this.play({ tone: [{ f0: 520, dur: 0.12, gain: 0.25 }, { f0: 780, dur: 0.25, gain: 0.25, delay: 0.1 }] });
  }

  roundEnd(won: boolean): void {
    const notes = won ? [523, 659, 784, 1047] : [392, 330, 262];
    this.play({ tone: notes.map((f0, i) => ({ f0, dur: 0.3, gain: 0.25, delay: i * 0.14 })) });
  }

  // ---------------------------------------------------------------- engine

  private play(sound: Sound, at?: Vec3): void {
    const ctx = this.ctx;
    const master = this.master;
    if (!ctx || !master || ctx.state !== 'running' || this.voices >= MAX_VOICES) return;

    let out: AudioNode = master;
    let panner: PannerNode | null = null;
    if (at) {
      panner = ctx.createPanner();
      panner.panningModel = 'HRTF';
      panner.distanceModel = 'inverse';
      panner.refDistance = 4;
      panner.rolloffFactor = 1.3;
      panner.maxDistance = 90;
      panner.positionX.value = at[0];
      panner.positionY.value = at[1];
      panner.positionZ.value = at[2];
      panner.connect(master);
      out = panner;
    }

    const now = ctx.currentTime;
    let latest = 0;
    for (const n of sound.noise ?? []) {
      this.noise(ctx, out, now + (n.delay ?? 0), n);
      latest = Math.max(latest, (n.delay ?? 0) + n.dur);
    }
    for (const t of sound.tone ?? []) {
      this.tone(ctx, out, now + (t.delay ?? 0), t);
      latest = Math.max(latest, (t.delay ?? 0) + t.dur);
    }
    if (panner) {
      const p = panner;
      window.setTimeout(() => p.disconnect(), (latest + 0.2) * 1000);
    }
  }

  private noise(ctx: AudioContext, out: AudioNode, start: number, s: NoiseSpec): void {
    if (!this.noiseBuffer) return;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    src.loop = true;
    const filter = ctx.createBiquadFilter();
    filter.type = s.filter;
    filter.Q.value = s.q ?? 0.7;
    filter.frequency.setValueAtTime(s.freq, start);
    if (s.freqEnd) filter.frequency.exponentialRampToValueAtTime(s.freqEnd, start + s.dur);
    const gain = this.envelope(ctx, start, s.dur, s.gain);
    src.connect(filter).connect(gain).connect(out);
    this.voices++;
    src.onended = () => {
      this.voices--;
    };
    src.start(start, Math.random() * 0.5);
    src.stop(start + s.dur + 0.02);
  }

  private tone(ctx: AudioContext, out: AudioNode, start: number, s: ToneSpec): void {
    const osc = ctx.createOscillator();
    osc.type = s.type ?? 'sine';
    osc.frequency.setValueAtTime(s.f0, start);
    if (s.f1) osc.frequency.exponentialRampToValueAtTime(s.f1, start + s.dur);
    const gain = this.envelope(ctx, start, s.dur, s.gain);
    osc.connect(gain).connect(out);
    this.voices++;
    osc.onended = () => {
      this.voices--;
    };
    osc.start(start);
    osc.stop(start + s.dur + 0.02);
  }

  /** A quick rise and an exponential fade: sounds that start and stop without a click. */
  private envelope(ctx: AudioContext, start: number, dur: number, peak: number): GainNode {
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, start);
    g.gain.exponentialRampToValueAtTime(Math.max(peak, 0.0002), start + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0001, start + dur);
    return g;
  }
}
