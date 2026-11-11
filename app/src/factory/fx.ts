// THE ANOMALY PAINTERS (fab-w4; FACTORY-SPEC §B marks, §G motion): smoke, beacons, cracks, the
// jam's chevrons, embers, and the catch-up replay's rings. Each paints a whole kind in a handful
// of paths from screen-space numbers coffee.ts lays out when the census, the camera or the digest
// moved: per frame there is arithmetic and path calls only, no Map, no string, no array growth.
//
//   smoke    dark, red-tinged wisps ≤ 22 px rising 8 px/s from a base, as many as the cluster hits
//            repos, never over a word; bucketed by opacity, one stroke per bucket (fx-glance)
//   beacon   a mast and a lamp; ≤ 3 pulse: on the beat (1 Hz) while < 10 min old, breathing
//            (0.25 Hz, in phase) while < 1 h; the rest hold steady. All phase-locked to motion.ts
//   cracks   pale fractures (pre-shaped per spot), one stroke for all
//   ember    a warm floor glow (three concentric iso ellipses), breathing every 4 beats
//   rings    an event landing in the replay: a ring growing and fading where it happened
//   dodge    a beacon's lamp comes down its mast from under a word (fx-glance)
// Everything beat-driven reads ONE eased waveform (`pulse`, the beat's cosine; fx-glance).
//
// Colours come from a table of pre-built rgba strings (33 opacity steps per base colour).

import type { Gfx } from '../yard/gfx.ts';
import { TAU } from '../yard/theme.ts';
import { beat, breathe } from './motion.ts';
import { EMBER } from './trendmarks.ts'; // fx-glance: the floor's one ember colour (fx-engine's)

/** The master beat as a pulse, 1 on the beat (motion.ts `beat` is its phase). */
export function pulse(t: number): number { return 0.5 + 0.5 * Math.cos(TAU * beat(t)); }

export const K_RED = 0, K_WISP = 1, K_WISP_RED = 2, K_EMBER = 3, K_CRACK = 4, K_OK = 5, K_AMBER = 6, K_INK = 7, K_CARD = 8, K_BLACK = 9;
// fx-glance: smoke is dark and red-tinged (gray is the ok family), ok is green-gray; the ember
// is the floor's ONE ember (trendmarks.ts EMBER, fx-engine: a low-L red-brown)
const BASE = ['#E06464', '#3E1D1B', '#8E4038', EMBER, '#D9D3CF', '#9DB8A4', '#E5B567', '#F2F2F0', '#111112', '#050506'];
const STEPS = 32;
const LUT: string[][] = BASE.map((hex) => {
  const n = parseInt(hex.slice(1), 16);
  const r = (n >> 16) & 255, gg = (n >> 8) & 255, b = n & 255;
  return Array.from({ length: STEPS + 1 }, (_, q) => `rgba(${r}, ${gg}, ${b}, ${(q / STEPS).toFixed(3)})`);
});

/** A base colour at opacity `a` (0..1), from the table. */
export function tint(k: number, a: number): string {
  const q = a <= 0 ? 0 : a >= 1 ? STEPS : Math.round(a * STEPS);
  return LUT[k][q];
}

/** Reusable scratch: a growable list of numbers that keeps its storage between frames. */
export class Nums {
  a: number[] = [];
  n = 0;
  reset(): void { this.n = 0; }
  push2(x: number, y: number): void { const a = this.a; a[this.n++] = x; a[this.n++] = y; }
  push3(x: number, y: number, z: number): void { const a = this.a; a[this.n++] = x; a[this.n++] = y; a[this.n++] = z; }
}

const SMOKE_BINS = 6;
/** A wisp's opacity at its densest. */
const SMOKE_A = 0.62;
const smokeBins: Nums[] = Array.from({ length: SMOKE_BINS }, () => new Nums());
/** A wisp's height cap (screen px, any zoom): smoke is a hint over the broken stage, never fog. */
const WISP_H = 22;

/** A placed word's box (labels.ts: x, baseline y, width, height). */
export type LabelBox = { x: number; y: number; w: number; h: number };

/** Whether (x, y) ± (rx, ry) touches a placed word (its box grown by `m`). */
function onLabel(labels: readonly LabelBox[] | undefined, x: number, y: number, rx: number, ry: number, m: number): boolean {
  if (!labels) return false;
  for (let i = 0; i < labels.length; i++) {
    const l = labels[i];
    if (x + rx > l.x - m && x - rx < l.x + l.w + m && y + ry > l.y - l.h - m && y - ry < l.y + 3 + m) return true;
  }
  return false;
}

/** Smoke (fx-glance): plumes as [x, y, k, size, wisps, rise, base] septets. Each plume is `wisps`
 *  (∝ the repos its cluster hits) dark, red-tinged curls ≤ 22 px tall rising 8 px/s from (x, y)
 *  `rise` px and fading; `base` > 0 lays a dark red smoulder that many px below, on the floor.
 *  A wisp never draws over a placed word (`labels`, the previous frame's). One stroke per opacity
 *  bin for every plume on the floor. */
export function smoke(g: Gfx, pl: Nums, t: number, fade = 1, labels?: readonly LabelBox[]): void {
  if (!pl.n || fade <= 0) return;
  for (const b of smokeBins) b.reset();
  const a = pl.a;
  for (let i = 0; i < pl.n; i += 7) {
    const x = a[i], y = a[i + 1], k = a[i + 2] * fade, sz = Math.min(1.2, a[i + 3]), n = a[i + 4], rise = a[i + 5], base = a[i + 6];
    if (base > 0) { g.begin_(); g.ctx.ellipse(x, y + base, Math.min(12, 10 * sz), Math.min(4.5, 4 * sz), 0, 0, TAU); g.ops += 2; g.fill(tint(K_WISP_RED, 0.14 + 0.12 * k)); }
    const period = (rise / 8) * 1000; // 8 px a second
    for (let j = 0; j < n; j++) {
      const p = ((t / period) + j / n + (j * 0.37) % 0.2) % 1;
      const f = p < 0.18 ? p / 0.18 : 1 - (p - 0.18) / 0.82;
      const al = f * k;
      if (al < 0.05) continue;
      const h = Math.min(WISP_H, (8 + p * 14) * sz);
      const wx = x + (Math.sin(p * 5 + j * 1.9) * 5 + (j % 3 - 1) * 6) * sz, wy = y - (2 + p * rise) * sz;
      if (onLabel(labels, wx, wy - h / 2, 5, h / 2, 2)) continue;
      smokeBins[Math.min(SMOKE_BINS - 1, Math.floor(al * SMOKE_BINS))].push3(wx, wy, h);
    }
  }
  for (let b = 0; b < SMOKE_BINS; b++) {
    const s = smokeBins[b];
    if (!s.n) continue;
    const lvl = (b + 0.5) / SMOKE_BINS;
    // a wisp: an S-curl from its foot up, dark and red-tinged
    g.begin_();
    for (let i = 0; i < s.n; i += 3) {
      const x = s.a[i], y = s.a[i + 1], h = s.a[i + 2], d = h * 0.22;
      g.ctx.moveTo(x, y); g.ctx.quadraticCurveTo(x + d, y - h * 0.3, x, y - h * 0.55); g.ctx.quadraticCurveTo(x - d, y - h * 0.8, x + d * 0.4, y - h);
    }
    g.ops += s.n; g.arcs += s.n / 3;
    g.stroke(tint(K_WISP_RED, SMOKE_A * lvl), 3);
  }
}

/** Beacons whose lamp would sit under a placed word (`labels`, the previous frame's; `r` the
 *  lamp's reach) come down their mast until clear: a word never covers its own beacon. In place,
 *  on [x, yFloor, yLamp, mode, age] quintets. */
export function dodge(b: Nums, labels: readonly LabelBox[] | undefined, r: number): void {
  if (!labels || !labels.length) return;
  const a = b.a;
  for (let i = 0; i < b.n; i += 5) {
    const x = a[i], yf = a[i + 1];
    let yl = a[i + 2];
    for (let k = 0; k < 8 && onLabel(labels, x, yl, r, r, 0); k++) yl += (yf - 6 - a[i + 2]) / 8;
    a[i + 2] = yl;
  }
}

/** Beacons as [x, yFloor, yLamp, mode, age01] quintets: mode 0 steady, 1 on the beat, 2 breathing. */
export function beacons(g: Gfx, b: Nums, t: number, sz: number, fade = 1): void {
  if (!b.n || fade <= 0) return;
  const a = b.a;
  g.begin_();
  for (let i = 0; i < b.n; i += 5) { g.move(a[i], a[i + 1]); g.line(a[i], a[i + 2]); }
  g.stroke(tint(K_RED, 0.55 * fade), 1.5);
  const s = Math.min(1.6, sz);
  for (let mode = 0; mode < 3; mode++) {
    const live = mode === 1 ? pulse(t) : mode === 2 ? breathe(t, 4) : 0.45;
    let any = false;
    g.begin_();
    for (let i = 0; i < b.n; i += 5) if (a[i + 3] === mode) { any = true; const r = (8 + live * 7) * s; g.ctx.moveTo(a[i] + r, a[i + 2]); g.ctx.arc(a[i], a[i + 2], r, 0, TAU); g.ops += 2; g.arcs++; }
    if (!any) continue;
    g.fill(tint(K_RED, (0.1 + 0.16 * live) * fade));
    g.begin_();
    for (let i = 0; i < b.n; i += 5) if (a[i + 3] === mode) { const r = 3.2 + live; g.ctx.moveTo(a[i] + r, a[i + 2]); g.ctx.arc(a[i], a[i + 2], r, 0, TAU); g.ops += 2; g.arcs++; }
    g.fill(tint(K_RED, fade));
  }
}

/** Cracks: polylines as [n, x0, y0, x1, y1, …] runs (n points each). */
export function cracks(g: Gfx, c: Nums, fade = 1): void {
  if (!c.n || fade <= 0) return;
  const a = c.a;
  g.begin_();
  for (let i = 0; i < c.n;) {
    const n = a[i++];
    for (let j = 0; j < n; j++, i += 2) if (j) g.line(a[i], a[i + 1]); else g.move(a[i], a[i + 1]);
  }
  g.stroke(tint(K_CRACK, 0.5 * fade), 1);
}

/** A crack's shape at (x, y): a jagged main line and a branch, seeded by `seed`, scaled by `s`;
 *  `n` lines (1–4) for a worse one. Appends to `c` (layout time, not per frame). */
export function crackAt(c: Nums, x: number, y: number, s: number, seed: number, n = 1): void {
  let h = seed >>> 0;
  const rnd = () => { h = Math.imul(h ^ (h >>> 15), 2246822519) >>> 0; h ^= h >>> 13; return (h & 1023) / 1023; };
  for (let k = 0; k < n; k++) {
    const dir = (k % 2 ? -1 : 1) * (0.5 + rnd() * 0.6);
    const pts = 5;
    c.a[c.n++] = pts;
    let px = x + (rnd() - 0.5) * 6 * s, py = y + (rnd() - 0.5) * 3 * s;
    for (let j = 0; j < pts; j++) {
      c.push2(px, py);
      px += (3 + rnd() * 4) * s * dir; py += (rnd() - 0.4) * 4 * s;
    }
    // a short branch off the middle
    c.a[c.n++] = 2;
    c.push2(x + 5 * s * dir, y + (rnd() - 0.5) * 2 * s);
    c.push2(x + (8 + rnd() * 3) * s * dir, y - (2 + rnd() * 3) * s);
  }
}

/** Embers: [x, y, rx, k] quads: three concentric iso glows, breathing every 4 beats. */
export function embers(g: Gfx, e: Nums, t: number, fade = 1): void {
  if (!e.n || fade <= 0) return;
  const a = e.a, br = 0.75 + 0.25 * breathe(t, 4);
  for (let ring = 0; ring < 3; ring++) {
    const sc = 1 - ring * 0.3;
    // two opacity groups (warm and hot) per ring keep the fills few
    for (let hot = 0; hot < 2; hot++) {
      let any = false;
      g.begin_();
      for (let i = 0; i < e.n; i += 4) {
        if ((a[i + 3] >= 0.65 ? 1 : 0) !== hot) continue;
        any = true;
        const rx = a[i + 2] * sc;
        g.ctx.moveTo(a[i] + rx, a[i + 1]); g.ctx.ellipse(a[i], a[i + 1], rx, rx * 0.5, 0, 0, TAU); g.ops += 2;
      }
      // three rings stacked: ≈ 0.35 at the centre, as fx-engine's ember (a low-L red-brown) reads
      if (any) g.fill(tint(K_EMBER, (hot ? 0.14 : 0.09) * br * fade));
    }
  }
}

/** Replay rings: [x, y, r, age01, colourKind] quintets, eased out (one ring per event). */
export function rings(g: Gfx, r: Nums): void {
  const a = r.a;
  for (let i = 0; i < r.n; i += 5) {
    const e = a[i + 3], o = 1 - (1 - e) * (1 - e);
    g.begin_(); g.circle(a[i], a[i + 1], a[i + 2] + o * 18);
    g.stroke(tint(a[i + 4], 0.85 * (1 - e) * (1 - e * 0.5)), 1.4);
  }
}

/** The jam's chevrons pushing at the intake's mouth: [x, y] pairs, moving with the beat. */
export function chevrons(g: Gfx, c: Nums, k: number, ph: number, sz: number): void {
  if (!c.n) return;
  g.begin_();
  for (let i = 0; i < c.n; i += 2) {
    const x = c.a[i] + (0.5 - 0.5 * Math.cos(TAU * ph)) * 8 * sz, y = c.a[i + 1]; // the one eased waveform
    g.move(x - 3 * sz, y - 4 * sz); g.line(x + sz, y); g.line(x - 3 * sz, y + 4 * sz);
  }
  g.stroke(tint(K_AMBER, 0.65 * k), 1.4);
}
