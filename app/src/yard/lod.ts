// Semantic level of detail (DESIGN.md, "Level of detail"). Every element of the yard is drawn
// at one of four levels, picked from the pixels it gets on screen and how many siblings share
// its region:
//
//   LOD0  focused or roomy: a full machine with ports, rings, step chips, labels, every packet
//   LOD1  compact: one ring, counts instead of chips, short labels
//   LOD2  a dense pill: state colour + a count; main-line dots as time-bucket bars
//   LOD3  heatmap cells (repo, org × lane, app)
//
// A level only changes when the size crosses its threshold by a hysteresis band (12 %), so a
// window resized across a boundary does not flicker, and every change crossfades over 150 ms
// (both levels drawn, alphas eased) instead of popping. A hovered or focused element is
// promoted to LOD0 (drawn by the live layer as a lens over its neighbours).

import { clamp, easeOut } from './theme.ts';

export type Level = 0 | 1 | 2 | 3;
/** The smallest size (yard px per element) for LOD0, LOD1 and LOD2; below the last is LOD3. */
export type Thresholds = readonly [number, number, number];

export const FADE_MS = 150;
export const HYSTERESIS = 0.12;

/** Siblings beyond this many make each element's effective size smaller: a region with 400
 *  rows reads as texture sooner than one with 8, at the same row height. */
const CROWD = 8;

export function effective(px: number, siblings: number): number {
  return px / (1 + 0.12 * Math.log2(Math.max(1, siblings / CROWD)));
}

function levelFor(px: number, th: Thresholds): Level {
  return px >= th[0] ? 0 : px >= th[1] ? 1 : px >= th[2] ? 2 : 3;
}

type Fade = { from: Level; to: Level; t0: number };

export class LodBook {
  private cur = new Map<string, Level>();
  private fades = new Map<string, Fade>();
  private caps = new Map<string, number>();
  /** Elements per level in the scene last built (the HUD's histogram). */
  histogram: [number, number, number, number] = [0, 0, 0, 0];
  /** When anything last changed level (the info layer animates until FADE_MS after). */
  lastChange = -1e9;

  /** The level for `key`, from its size and sibling count, with hysteresis. */
  pick(key: string, px: number, siblings: number, th: Thresholds, t: number): Level {
    const eff = effective(px, siblings);
    const raw = levelFor(eff, th);
    const old = this.cur.get(key);
    if (old === undefined) { this.cur.set(key, raw); return raw; }
    let next: Level = old;
    if (raw < old) {
      const l = levelFor(eff / (1 + HYSTERESIS), th);
      if (l < old) next = l;
    } else if (raw > old) {
      const l = levelFor(eff / (1 - HYSTERESIS), th);
      if (l > old) next = l;
    }
    if (next !== old) this.set(key, next, t);
    return next;
  }

  /** Forces a level (a promotion, a stress switch), crossfading from the old one. */
  set(key: string, l: Level, t: number): void {
    const old = this.cur.get(key);
    this.cur.set(key, l);
    if (old !== undefined && old !== l) {
      this.fades.set(key, { from: old, to: l, t0: t });
      this.lastChange = t;
    }
  }

  level(key: string): Level {
    return this.cur.get(key) ?? 0;
  }

  /** The crossfade of `key` at `t`: the level it comes from and the new level's alpha (1: settled). */
  fade(key: string, t: number): { from: Level; a: number } {
    const f = this.fades.get(key);
    if (!f) return NO_FADE;
    const u = (t - f.t0) / FADE_MS;
    if (u >= 1) { this.fades.delete(key); return NO_FADE; }
    FADING.from = f.from;
    FADING.a = easeOut(clamp(u, 0, 1));
    return FADING;
  }

  animating(t: number): boolean {
    return t - this.lastChange < FADE_MS + 20;
  }

  /** An integer that only moves when the new value is `band` or more away, or has stayed
   *  different for a while (row counts per tier: no row toggling on every resize step). */
  sticky(key: string, v: number, band = 1): number {
    const old = this.caps.get(key);
    if (old === undefined || Math.abs(v - old) >= band) { this.caps.set(key, v); return v; }
    return old;
  }

  clear(): void {
    this.cur.clear();
    this.fades.clear();
    this.caps.clear();
  }
}

const NO_FADE = { from: 0 as Level, a: 1 };
const FADING = { from: 0 as Level, a: 1 };
