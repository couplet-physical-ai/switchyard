// The floor plan (fab-w0; lanes and the accordion: fab-w1). Where every stage of the factory sits,
// in world units (u: left → right, v: back → front; the floor is LU × LV, iso.ts), and the TEAM
// LANES (FACTORY-SPEC §C) that run through its left third:
//
//   each group's lane, back → front in lane order, is one band of v that carries the group the
//   whole way: its dock → its belt → its four phase cells of the PR yard → its lintel on the
//   shared merge gate → its own main-line rail (signal posts on the back curb, red first) → its
//   stripe of the ribbon that converges into the intake. The bots siding is the front lane.
//
// `LaneMap` is the lanes' v: the base bands (depth ∝ √repos, ≥ 32 u, tiling LANE_V0..LANE_V1) and
// the semantic zoom's ACCORDION (§F): a focused lane takes 45 % of the floor's depth, the others
// shrink to 10-u stripes; `vmap` is the piecewise-linear map from a base v to where it is drawn
// now, eased over the 600 ms transition. `f.plan` (factory.ts) is PLAN; `RAIL_V` follows the
// lanes (rewritten in place: every module that destructured it sees the lanes' rails).

import { LV } from './iso.ts';
import type { Plan } from './types.ts';

export const PLAN: Plan = {
  DOCK_U0: 10, DOCK_U1: 64,
  COLLECT_U: 104,
  AISLE_V: 385,
  YARD_U0: 122, YARD_U1: 426,
  ROW_U: [153, 227, 301, 375],
  ROW_DU: 46,
  AGE_V: [470, 398, 326, 254, 182, 110],
  STACK_DV: 46,
  PALLET_V: 560,
  GATE_U: 442,
  RAIL_U0: 456, RAIL_U1: 640,
  RAIL_V: [130, 210, 290, 370, 450],
  INTAKE_U0: 662, INTAKE_U1: 748,
  LANE_V: [276, 306],
  DIST_U: 762,
  ENG_U0: 776, ENG_U1: 1052,
  ENG_V0: 34, ENG_STEP: 146, ENG_DV: 116, ENG_H: 30,
  SCAN_U: 1104,
  TRACK_V: [210, 330, 450],
  TRACK_U1: 1222,
  CITY_U0: 1232, CITY_U1: 1494, CITY_V0: 22, CITY_V1: 610,
  RETURN_V: 626,
  VIAS: ['roadrunner', 'gha', 'gha_fallback'],
};

/** A deploy track's name. */
export const VIA_WORDS: Record<string, string> = { roadrunner: 'roadrunner', gha: 'gha', gha_fallback: 'fallback' };

// ── the lanes (§C) ────────────────────────────────────────────────────────────────────────────

/** The lanes' zone (v): the back lane starts here, the bots siding ends here. */
export const LANE_V0 = 22, LANE_V1 = 616;
/** A lane's least depth (§C). */
export const MIN_LANE = 32;
/** The bots siding's depth (the front strip). */
export const SIDING_DV = 34;
/** The accordion: the focused lane's depth (45 % of v) and every other lane's (a stripe). */
export const FOCUS_DV = Math.round(0.45 * LV);
export const STRIPE_DV = 10;
/** The accordion's transition (ms) and its zoom thresholds with hysteresis (§F: group z 1.4–2.4,
 *  repo z 2.4–4). */
export const ACCORDION_MS = 600;
export const GROUP_Z_IN = 1.45, GROUP_Z_OUT = 1.32, REPO_Z_IN = 2.45, REPO_Z_OUT = 2.3;
/** Repo level: the focused lane's per-repo sub-rows (the busiest; the rest as "+N"). */
export const SUB_ROWS = 12;

/** The lanes' u stations, left → right (world u). */
export const LANE_U = {
  /** the belt leaves the dock here and runs to the gate */
  BELT_U0: PLAN.DOCK_U1, BELT_U1: PLAN.GATE_U,
  /** the PR yard's four phase cells (centres: ROW_U) and their width */
  CELL_DU: 50,
  /** the gate's lintel and the rail's span */
  GATE_U: PLAN.GATE_U, RAIL_U0: PLAN.RAIL_U0, RAIL_U1: PLAN.RAIL_U1,
  /** the ribbon: the rails' ends converge from RAIL_U1 to here, then run to the intake */
  MERGE_U: PLAN.RAIL_U1 + 16, INTAKE_V: 291,
} as const;

/** Ease in-out (the accordion's 600 ms). */
export function ease(k: number): number {
  const x = Math.min(1, Math.max(0, k));
  return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
}

export type LaneSpec = { id: string; /** weight (∝ √repos) */ w: number; /** a fixed depth (> 0: the bots siding) */ fixed: number };

/** The lanes' v: base bands, the accordion, and the map between them. Boundaries are n + 1 values
 *  back → front; lane i is [b[i], b[i + 1]]. */
export class LaneMap {
  ids: string[] = [];
  /** The base bands (no focus). */
  base: number[] = [LANE_V0, LANE_V1];
  /** The accordion's bands for the focus (equal to `base` without one). */
  acc: number[] = [LANE_V0, LANE_V1];
  /** The bands now: base → acc by the eased transition. */
  now: number[] = [LANE_V0, LANE_V1];
  /** The focused lane (-1 none) and how open the accordion is (0..1, before easing). */
  fi = -1;
  k = 0;
  /** Bumps whenever `now` moved (the static floor's key). */
  ver = 0;
  private key = '';
  /** A transition (`go`): from the bands at its start to the target's, over ACCORDION_MS. */
  private from: number[] = [];
  private t0 = 0;
  private goal = -1;
  /** True while a transition runs. */
  animating = false;

  get n(): number { return this.ids.length; }

  /** The lanes, back → front; recomputes the base bands when they changed. */
  setLanes(lanes: LaneSpec[]): void {
    const key = lanes.map((l) => `${l.id}:${l.w.toFixed(3)}:${l.fixed}`).join('|');
    if (key === this.key) return;
    this.key = key;
    this.ids = lanes.map((l) => l.id);
    const span = LANE_V1 - LANE_V0;
    const n = lanes.length;
    const depth = new Array<number>(n).fill(0);
    let rest = span;
    for (let i = 0; i < n; i++) if (lanes[i]!.fixed > 0) { depth[i] = lanes[i]!.fixed; rest -= lanes[i]!.fixed; }
    // ∝ weight, at least MIN_LANE (the small ones pinned, the rest shared again)
    let pinned = new Set<number>();
    for (let pass = 0; pass < 6; pass++) {
      const free = rest - pinned.size * MIN_LANE;
      let sw = 0;
      for (let i = 0; i < n; i++) if (!lanes[i]!.fixed && !pinned.has(i)) sw += Math.max(1e-6, lanes[i]!.w);
      const next = new Set(pinned);
      for (let i = 0; i < n; i++) {
        if (lanes[i]!.fixed) continue;
        if (pinned.has(i)) { depth[i] = MIN_LANE; continue; }
        depth[i] = (free * Math.max(1e-6, lanes[i]!.w)) / Math.max(1e-6, sw);
        if (depth[i]! < MIN_LANE) next.add(i);
      }
      if (next.size === pinned.size) break;
      pinned = next;
    }
    const b = [LANE_V0];
    for (let i = 0; i < n; i++) b.push(b[i]! + depth[i]!);
    b[n] = LANE_V1;
    this.base = b;
    if (this.fi >= n) { this.fi = -1; this.k = 0; }
    if (this.goal >= n) this.goal = -1;
    // new lanes mid-transition: land on the target at once
    this.animating = false;
    this.focus(this.goal >= 0 ? this.goal : this.fi, this.goal >= 0 ? 1 : this.k, true);
  }

  /** Eases from wherever the bands are now to lane `fi`'s accordion (-1: the base lanes), over
   *  ACCORDION_MS from `t`. */
  go(fi: number, t: number): void {
    if (fi === this.goal && (this.animating || (fi < 0 ? this.k === 0 : this.fi === fi && this.k === 1))) return;
    this.goal = fi;
    this.from = this.now.slice();
    this.t0 = t;
    this.animating = true;
    if (fi >= 0) { this.fi = -2; this.focus(fi, 0, true); this.now = this.from.slice(); }
  }

  /** Advances a transition to `t`; true when the bands moved. */
  tick(t: number): boolean {
    if (!this.animating) return false;
    const p = Math.min(1, Math.max(0, (t - this.t0) / ACCORDION_MS));
    const e = ease(p);
    const to = this.goal >= 0 ? this.acc : this.base;
    this.now = this.from.map((x, i) => x + ((to[i] ?? x) - x) * e);
    this.ver++;
    if (p >= 1 || t < this.t0) {
      this.animating = false;
      if (this.goal >= 0) { this.fi = this.goal; this.k = 1; } else { this.fi = -1; this.k = 0; this.acc = this.base.slice(); }
      this.now = to.slice();
    }
    return true;
  }

  /** The lane the accordion opens (or is opening; -1 none). */
  get target(): number { return this.animating ? this.goal : this.fi; }

  /** The accordion: lane `fi` focused (-1: none) and open by `k` (0..1). */
  focus(fi: number, k: number, force = false): void {
    if (!force && fi === this.fi && Math.abs(k - this.k) < 1e-6) return;
    const changed = fi !== this.fi || force;
    this.fi = fi; this.k = k;
    const n = this.n, b = this.base;
    if (changed) {
      if (fi < 0 || fi >= n) this.acc = b.slice();
      else {
        // the focus takes FOCUS_DV, the others a stripe each (narrower when there are many)
        const span = LANE_V1 - LANE_V0;
        const stripe = Math.min(STRIPE_DV, (span - FOCUS_DV) / Math.max(1, n - 1));
        const total = FOCUS_DV + stripe * (n - 1);
        // keep the focus where it was (its centre), inside the zone
        const c = (b[fi]! + b[fi + 1]!) / 2;
        const s = Math.min(Math.max(c - stripe * fi - FOCUS_DV / 2, LANE_V0), LANE_V1 - total);
        const a = [s];
        for (let i = 0; i < n; i++) a.push(a[i]! + (i === fi ? FOCUS_DV : stripe));
        this.acc = a;
      }
    }
    const e = ease(k);
    this.now = b.map((x, i) => x + (this.acc[i]! - x) * e);
    this.ver++;
  }

  /** A base v → where it is drawn now (piecewise-linear across the lanes). */
  vmap(v: number): number {
    const b = this.base, a = this.now, n = b.length - 1;
    if (v <= b[0]!) return v - b[0]! + a[0]!;
    if (v >= b[n]!) return v - b[n]! + a[n]!;
    let i = 0;
    while (i < n - 1 && v > b[i + 1]!) i++;
    const t = (v - b[i]!) / Math.max(1e-9, b[i + 1]! - b[i]!);
    return a[i]! + t * (a[i + 1]! - a[i]!);
  }

  /** Where a drawn v came from (the inverse of `vmap`). */
  unmap(v: number): number {
    const b = this.base, a = this.now, n = b.length - 1;
    if (v <= a[0]!) return v - a[0]! + b[0]!;
    if (v >= a[n]!) return v - a[n]! + b[n]!;
    let i = 0;
    while (i < n - 1 && v > a[i + 1]!) i++;
    const t = (v - a[i]!) / Math.max(1e-9, a[i + 1]! - a[i]!);
    return b[i]! + t * (b[i + 1]! - b[i]!);
  }

  /** The lane a drawn v falls in (-1 outside the zone). */
  laneAt(v: number): number {
    const a = this.now;
    if (v < a[0]! || v > a[a.length - 1]!) return -1;
    for (let i = 0; i < a.length - 1; i++) if (v <= a[i + 1]!) return i;
    return -1;
  }

  /** The lane a base v falls in. */
  baseLaneAt(v: number): number {
    const b = this.base;
    if (v < b[0]! || v > b[b.length - 1]!) return -1;
    for (let i = 0; i < b.length - 1; i++) if (v <= b[i + 1]!) return i;
    return -1;
  }

  v0(i: number): number { return this.now[i] ?? LANE_V0; }
  v1(i: number): number { return this.now[i + 1] ?? LANE_V1; }
  mid(i: number): number { return (this.v0(i) + this.v1(i)) / 2; }
  depth(i: number): number { return this.v1(i) - this.v0(i); }
  index(id: string): number { return this.ids.indexOf(id); }
}

/** Where things sit across a lane of depth d (offsets from its back edge, v): the posts' curb,
 *  the phase cells, the rail, the belt. A stripe (d < 20) keeps only the posts. */
export function laneSlots(v0: number, v1: number): { curb: number; cell0: number; cell1: number; rail: number; belt: number; beltHw: number; stripe: boolean } {
  const d = v1 - v0;
  if (d < 20) return { curb: (v0 + v1) / 2, cell0: v0, cell1: v0, rail: (v0 + v1) / 2, belt: (v0 + v1) / 2, beltHw: 0, stripe: true };
  const beltHw = Math.min(4.5, Math.max(2, d * 0.08));
  const belt = v1 - 3 - beltHw;
  const curb = v0 + 3.5;
  const cell0 = v0 + 7, cell1 = belt - beltHw - 2;
  const rail = Math.min(Math.max((v0 + v1) / 2 + 2, curb + 7), belt - 4);
  return { curb, cell0, cell1, rail, belt, beltHw, stripe: false };
}
