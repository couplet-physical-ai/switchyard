// THE ANOMALY PAINTERS (fab-w4; FACTORY-SPEC §B marks, §G motion): smoke, beacons, cracks, the
// jam's chevrons, embers, and the catch-up replay's rings. Each paints a whole kind in a handful
// of paths from screen-space numbers coffee.ts lays out when the census, the camera or the digest
// moved: per frame there is arithmetic and path calls only, no Map, no string, no array growth.
//
//   smoke    grey puffs rising 8 px/s from a base, density ∝ the cluster's reach (k); puffs are
//            bucketed by opacity, one fill per bucket for every plume on the floor
//   beacon   a mast and a lamp; ≤ 3 pulse: on the beat (1 Hz) while < 10 min old, breathing
//            (0.25 Hz, in phase) while < 1 h; the rest hold steady. All phase-locked to motion.ts
//   cracks   pale fractures (pre-shaped per spot), one stroke for all
//   ember    a warm floor glow (three concentric iso ellipses), breathing every 4 beats
//   rings    an event landing in the replay: a ring growing and fading where it happened
//
// Colours come from a table of pre-built rgba strings (33 opacity steps per base colour).

import type { Gfx } from '../yard/gfx.ts';
import { TAU } from '../yard/theme.ts';
import { beat, breathe } from './motion.ts';

/** The master beat as a pulse, 1 on the beat (motion.ts `beat` is its phase). */
export function pulse(t: number): number { return 0.5 + 0.5 * Math.cos(TAU * beat(t)); }

export const K_RED = 0, K_SMOKE = 1, K_SMOKE2 = 2, K_EMBER = 3, K_CRACK = 4, K_OK = 5, K_AMBER = 6, K_INK = 7, K_CARD = 8;
const BASE = ['#E06464', '#9A9AA0', '#BDBDC3', '#C47A48', '#D9D3CF', '#7FC48F', '#E5B567', '#F2F2F0', '#111112'];
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
/** A puff's opacity at its densest. */
const SMOKE_A = 0.36;
const smokeBins: Nums[] = Array.from({ length: SMOKE_BINS * 2 }, () => new Nums());

/** Smoke: plumes as [x, y, k, size, puffs, rise, base] septets: (x, y) where it rises from; `base`
 *  > 0 draws a red-tinted haze that many px below it, on the floor (the scanner's: something
 *  burns there). */
export function smoke(g: Gfx, pl: Nums, t: number, fade = 1): void {
  if (!pl.n || fade <= 0) return;
  for (const b of smokeBins) b.reset();
  const a = pl.a;
  for (let i = 0; i < pl.n; i += 7) {
    const x = a[i], y = a[i + 1], k = a[i + 2] * fade, sz = a[i + 3], puffs = a[i + 4], rise = a[i + 5], base = a[i + 6];
    if (base > 0) { g.begin_(); g.ctx.ellipse(x, y + base, 18 * sz, 8 * sz, 0, 0, TAU); g.ops += 2; g.fill(tint(K_RED, 0.1 + 0.12 * k)); }
    const period = (rise / 8) * 1000; // 8 px a second at the fitted zoom
    for (let j = 0; j < puffs; j++) {
      const p = ((t / period) + j / puffs) % 1;
      const f = p < 0.12 ? p / 0.12 : 1 - (p - 0.12) / 0.88;
      const al = SMOKE_A * f * k;
      if (al < 0.02) continue;
      const bin = Math.min(SMOKE_BINS - 1, Math.floor((al / SMOKE_A) * SMOKE_BINS)) + (j % 3 ? 0 : SMOKE_BINS);
      smokeBins[bin].push3(x + (Math.sin(p * 4 + j * 1.7) * 7 + p * 26) * sz, y - (4 + p * rise) * sz, (5 + p * 17 * (rise / 56)) * sz);
    }
  }
  for (let b = 0; b < SMOKE_BINS * 2; b++) {
    const s = smokeBins[b];
    if (!s.n) continue;
    g.begin_();
    for (let i = 0; i < s.n; i += 3) { g.ctx.moveTo(s.a[i] + s.a[i + 2], s.a[i + 1]); g.ctx.arc(s.a[i], s.a[i + 1], s.a[i + 2], 0, TAU); }
    g.ops += s.n / 3; g.arcs += s.n / 3;
    const lvl = ((b % SMOKE_BINS) + 0.5) / SMOKE_BINS;
    g.fill(tint(b < SMOKE_BINS ? K_SMOKE2 : K_SMOKE, SMOKE_A * lvl));
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
      if (any) g.fill(tint(K_EMBER, (hot ? 0.06 : 0.04) * br * fade));
    }
  }
}

/** Replay rings: [x, y, r, age01, colourKind] quintets. */
export function rings(g: Gfx, r: Nums): void {
  const a = r.a;
  for (let i = 0; i < r.n; i += 5) {
    const e = a[i + 3];
    g.begin_(); g.circle(a[i], a[i + 1], a[i + 2] + e * 18);
    g.stroke(tint(a[i + 4], 0.85 * (1 - e)), 1.4);
  }
}

/** The jam's chevrons pushing at the intake's mouth: [x, y] pairs, moving with the beat. */
export function chevrons(g: Gfx, c: Nums, k: number, ph: number, sz: number): void {
  if (!c.n) return;
  g.begin_();
  for (let i = 0; i < c.n; i += 2) {
    const x = c.a[i] + ph * 8 * sz, y = c.a[i + 1];
    g.move(x - 3 * sz, y - 4 * sz); g.line(x + sz, y); g.line(x - 3 * sz, y + 4 * sz);
  }
  g.stroke(tint(K_AMBER, 0.65 * k), 1.4);
}
