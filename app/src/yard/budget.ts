// The frame budget and the quality ladder (DESIGN.md, "Frame budget"). A frame is 16.6 ms; the
// yard's own drawing should stay under ~6 ms of it.
//
// The data module has no clock but `frame.time`, so a draw cannot time itself. Two signals
// stand in for a stopwatch:
//   1. A cost model. Every draw counts what it records (Gfx: ops, arcs, texts); each count has
//      a per-host price in µs (Hermes interprets, a browser JIT-compiles; text is a host round
//      trip on both). The sum is the frame's draw estimate. It is deterministic, so the ladder
//      decides the same way under the test runner's clock as on a desk.
//   2. Frame-time deltas. Successive `frame.time`s give the real frame interval. Missed frames
//      while the model says "cheap" mean the model is low here: its gain rises until the
//      misses stop, and decays back when they do.
//
// The ladder: when the estimate stays over budget (or frames are being missed) it steps DOWN
// one level; after N good frames whose next-better level is predicted to fit with headroom it
// steps back UP. A step up that is undone soon doubles the wait before the next try.

export const FRAME_MS = 1000 / 60;
export const DRAW_BUDGET_MS = 6;
/** Step up only if the better level is predicted under this (headroom against flapping). */
const UP_HEADROOM_MS = 4.5;
/** Below this much drawing (ms) missed frames are not the yard's doing. */
const SHARE_MS = DRAW_BUDGET_MS * 0.35;
/** Frames over budget in a row before stepping down. */
const DOWN_AFTER = 3;
/** Good frames before trying a step up (doubles when a step up is undone, up to 640). */
const UP_AFTER = 90;

export const QUALITY_NAMES = ['full', 'lean', 'flat', 'trains', 'survival'] as const;
export const Q_MAX = QUALITY_NAMES.length - 1;

/**
 * What each quality level does (read by the layers):
 *   0 full      every packet a rounded sprite, amber glow on lead packets, fast-move trails,
 *               6 labels, dots as circles, full static detail
 *   1 lean      no glow, no trails, 3 labels
 *   2 flat      packets as flat rects (1 op), progress tracks dropped, dots as squares
 *   3 trains    packets on the same wire stretch merge into trains with a ×N badge,
 *               the static layer at low detail (straight wires, square corners, no port slits)
 *   4 survival  trains with at most 60 sprites and 6 badges, no effects, rings as counts
 */
export type Quality = 0 | 1 | 2 | 3 | 4;

/** µs per counted thing, by executor. Calibrated from PERF.md runs (mini, Chromium). */
const PRICES = {
  hermes: { op: 1.6, arc: 7, text: 22, packet: 0.9 },
  jit: { op: 0.35, arc: 1.4, text: 5, packet: 0.15 },
} as const;

export function executor(): 'hermes' | 'jit' {
  return typeof (globalThis as { HermesInternal?: unknown }).HermesInternal !== 'undefined' ? 'hermes' : 'jit';
}

const N = 120;

export class Budget {
  readonly host = executor();
  private price = PRICES[this.host];
  /** Real frame intervals (ms), newest at `i - 1`. */
  private intervals = new Float32Array(N);
  /** Estimated draw ms per frame. */
  private draws = new Float32Array(N);
  private scratch = new Float32Array(N);
  private i = 0;
  private n = 0;
  private lastT = -1;
  quality: Quality = 0;
  /** A level pinned from the HUD (-1: automatic). */
  pinned = -1;
  /** Step up only if the better level is predicted under this (ms; a layer may set its own). */
  upHeadroom = UP_HEADROOM_MS;
  /** The model's correction from observed misses (1 = trust the prices). */
  gain = 1;
  private over = 0;
  private good = 0;
  private upAfter = UP_AFTER;
  private lastUp = -1e9;
  private frameNo = 0;
  private missing = false;
  /** The first frame whose 30-frame window holds only frames after the last step down. */
  private missFrom = 0;
  /** The last frame's estimate (ms) and counts, for the HUD. */
  est = 0;
  ops = 0;
  texts = 0;
  missed = 0;

  /** Notes a live frame at `t` (the frame clock); returns its interval, or 0 after a gap. */
  tick(t: number): number {
    const dt = this.lastT < 0 ? 0 : t - this.lastT;
    this.lastT = t;
    if (dt <= 0 || dt > 250) return 0; // a pause, a clock jump, a hidden window: not a frame
    this.intervals[this.i] = dt;
    return dt;
  }

  /** The estimated ms of what a draw recorded. */
  estimate(ops: number, arcs: number, texts: number, packets: number): number {
    const p = this.price;
    return ((ops * p.op + arcs * p.arc + texts * p.text + packets * p.packet) / 1000) * this.gain;
  }

  /** Records the frame's cost and decides the ladder. `predictUp(q)`: the estimate at level q. */
  record(estMs: number, ops: number, texts: number, interval: number, predictUp: (q: Quality) => number): void {
    this.est = estMs;
    this.ops = ops;
    this.texts = texts;
    this.draws[this.i] = estMs;
    if (interval <= 0) this.intervals[this.i] = FRAME_MS;
    this.i = (this.i + 1) % N;
    if (this.n < N) this.n++;
    this.frameNo++;
    const miss = interval > FRAME_MS * 1.5;
    if (miss) this.missed++;
    // The model's gain: missed frames while the yard's share is real (over a third of the
    // budget) but the model says "fits" mean it is low on this machine. Misses while the yard
    // draws next to nothing are someone else's (the host, the compositor, a headless runner):
    // degrading the yard would not bring those frames back.
    const share = estMs / this.gain;
    if (miss && share > SHARE_MS && estMs < DRAW_BUDGET_MS) this.gain = Math.min(2.5, this.gain * 1.03);
    else if (!miss && this.gain > 1) this.gain = Math.max(1, this.gain * 0.998);
    if (this.pinned >= 0) { this.quality = this.pinned as Quality; return; }
    // Missed frames are judged on a window of 30 that began after the last step down, so one
    // hitch (a tap, a mount, a recount) steps the ladder once, not all the way to the bottom.
    if (this.frameNo % 8 === 0) this.missing = this.n >= 30 && this.frameNo >= this.missFrom && this.p(this.intervals, 30, 0.9) > FRAME_MS * 1.25;
    const missing = this.missing;
    const isOver = estMs > DRAW_BUDGET_MS || (missing && estMs > SHARE_MS);
    if (isOver) {
      this.over++;
      this.good = 0;
      if ((this.over >= DOWN_AFTER || estMs > DRAW_BUDGET_MS * 2) && this.quality < Q_MAX) {
        // A step up undone within two seconds: wait twice as long before the next one.
        if (this.frameNo - this.lastUp < 120) this.upAfter = Math.min(640, this.upAfter * 2);
        this.quality = (this.quality + 1) as Quality;
        this.over = 0;
        this.missFrom = this.frameNo + 30;
        this.missing = false;
      }
      return;
    }
    this.over = 0;
    this.good++;
    if (this.good >= this.upAfter && this.quality > 0) {
      const better = (this.quality - 1) as Quality;
      if (predictUp(better) < this.upHeadroom && !(missing && estMs > SHARE_MS)) {
        this.quality = better;
        this.lastUp = this.frameNo;
      }
      this.good = 0;
    }
    if (this.good > 600) this.upAfter = UP_AFTER;
  }

  /** Quantile `q` of the last `k` samples of `a` (sorted in a preallocated scratch). */
  private p(a: Float32Array, k: number, q: number): number {
    const m = Math.min(k, this.n);
    if (!m) return 0;
    const s = this.scratch;
    for (let j = 0; j < N; j++) s[j] = j < m ? a[(this.i - 1 - j + N * 2) % N] : Infinity;
    s.sort();
    return s[Math.min(m - 1, Math.floor(q * m))];
  }

  private avg(a: Float32Array, k: number): number {
    const m = Math.min(k, this.n);
    if (!m) return 0;
    let t = 0;
    for (let j = 0; j < m; j++) t += a[(this.i - 1 - j + N * 2) % N];
    return t / m;
  }

  /** The HUD's numbers. */
  stats(): { fps: number; frameAvg: number; frameP95: number; drawAvg: number; drawP95: number } {
    const fa = this.avg(this.intervals, 60);
    return {
      fps: fa > 0 ? 1000 / fa : 0,
      frameAvg: fa,
      frameP95: this.p(this.intervals, 60, 0.95),
      drawAvg: this.avg(this.draws, 60),
      drawP95: this.p(this.draws, 60, 0.95),
    };
  }
}
