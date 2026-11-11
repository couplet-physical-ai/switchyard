// The factory floor's motion (FACTORY-SPEC §G): one clock, causal ripples, calm frames skipped.
//
//   - ONE master beat at 1 Hz. Every blink, pulse and breathing glow on the floor reads its phase
//     here (`beat`, `blink`, `breathe`), so beacons blink together and a replay keeps the rhythm.
//   - Causal ripples. An event's crate travels its path; each reaction along it (the gate's flash,
//     the rail's, the scanner's beam, a dock's red door, a building's ring) is scheduled for the
//     moment the crate ARRIVES there (`arrival` inverts the crate's easing), never when the event
//     lands. Under each travelling crate the belt brightens (its wake).
//   - Belts move at a speed set by their rate, logarithmically: 6 + 10·log₂(1 + rate/min) px/s
//     at the fitted zoom; a belt with nothing on it stands still.
//   - Calm frames skip. With nothing travelling, the live layer redraws only when what it shows
//     moved by a visible step (a slat by a pixel, the beat by an eighth), at most 9 times a second (CALM_MS).
//
// Reactions live in a fixed ring (no allocation per event or frame).

export const BEAT_MS = 1000;
/** The calm cadence: a calm frame at most every 110 ms (about 9 a second, ~15 % of a loud 60). */
export const CALM_MS = 110;

/** The master beat's phase at `t` (ms), 0 → 1 once a second. */
export function beat(t: number): number {
  const p = t / BEAT_MS;
  return p - Math.floor(p);
}

/** On for the first half of every beat. */
export function blink(t: number): boolean {
  return beat(t) < 0.5;
}

/** 0 → 1 → 0 once a beat (a cosine), or once every `beats` beats (a slower breath, in phase). */
export function breathe(t: number, beats = 1): number {
  const p = t / (BEAT_MS * beats);
  return 0.5 - 0.5 * Math.cos((p - Math.floor(p)) * Math.PI * 2);
}

/** A flash at every beat, decaying through it (1 at the beat, ~0 by its middle). */
export function flash(t: number): number {
  return Math.exp(-7 * beat(t));
}

/** A belt's slat speed in screen px a second at the fitted zoom, for `perHour` crates an hour. */
export function beltSpeedPx(perHour: number): number {
  return perHour > 0 ? 6 + 10 * Math.log2(1 + perHour / 60) : 0;
}

/** Inverse of the crates' easeInOut: when (0..1 of its trip) a crate reaches fraction `f` of its route. */
export function arrival(f: number): number {
  if (f <= 0) return 0;
  if (f >= 1) return 1;
  return f < 0.5 ? Math.sqrt(f / 2) : 1 - Math.sqrt((1 - f) / 2);
}

/** What a reaction looks like: a ring on the floor, the scanner's beam, a door's flash. */
export const R_RING = 0, R_BEAM = 1, R_DOOR = 2, R_LIP = 3;

const N = 96;

/** Scheduled reactions: where (floor u, v, z), when, how long, red or not, which kind. */
export class Ripples {
  readonly u = new Float32Array(N);
  readonly v = new Float32Array(N);
  readonly z = new Float32Array(N);
  readonly at = new Float64Array(N);
  readonly dur = new Float32Array(N);
  readonly red = new Uint8Array(N);
  readonly kind = new Uint8Array(N);
  readonly green = new Uint8Array(N);
  private next = 0;

  /** Schedules a reaction at time `at` (ms, the frame clock). */
  add(kind: number, u: number, v: number, z: number, at: number, red: boolean, dur = 1200, green = false): void {
    const i = this.next;
    this.next = (i + 1) % N;
    this.kind[i] = kind; this.u[i] = u; this.v[i] = v; this.z[i] = z; this.at[i] = at; this.dur[i] = dur; this.red[i] = red ? 1 : 0; this.green[i] = green ? 1 : 0;
  }

  /** Whether any reaction is pending or showing at `t` (the live layer stays awake for it). */
  busy(t: number): boolean {
    for (let i = 0; i < N; i++) if (this.dur[i] > 0 && t < this.at[i] + this.dur[i]) return true;
    return false;
  }

  /** The newest showing reaction of `kind` at `t`: its index, or -1. */
  showing(kind: number, t: number): number {
    let best = -1;
    for (let i = 0; i < N; i++) {
      if (this.kind[i] !== kind || this.dur[i] <= 0) continue;
      const age = t - this.at[i];
      if (age < 0 || age > this.dur[i]) continue;
      if (best < 0 || this.at[i] > this.at[best]) best = i;
    }
    return best;
  }

  clear(): void { this.dur.fill(0); }
}

/** Decides whether a calm frame (nothing travelling) needs drawing: only when a slat moved a
 *  pixel or the beat an eighth since the last drawn one, and not more than 9 times a second. */
export class CalmGate {
  private lastSig = -1;
  private lastT = -1e9;

  /** `pxMoved`: how far (screen px) the fastest belt's slats have travelled by `t`. */
  wants(t: number, pxMoved: number, loud: boolean): boolean {
    if (loud) { this.lastT = t; this.lastSig = -1; return true; }
    const sig = Math.floor(pxMoved) * 8 + Math.floor(beat(t) * 8);
    if (sig === this.lastSig) return false;
    if (t - this.lastT < CALM_MS) return false;
    this.lastSig = sig;
    this.lastT = t;
    return true;
  }

  reset(): void { this.lastSig = -1; this.lastT = -1e9; }
}
