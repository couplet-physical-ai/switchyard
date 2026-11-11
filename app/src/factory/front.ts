// THE FLOOR'S EDGES (fx-front; FACTORY-SPEC §B, §E; review iter-2 #4, #7, #8): everything the
// factory shows around the slab rather than on it. Each is a day of real data, an hour a step,
// the oldest at the far end and NOW at the near one:
//
//   the back wall    one board per stage along v = 0 (bars on a base rule, no plate): sources
//                    (pushes), pr yard (PRs opened, the CI-failing part red), main lines (commits
//                    landed, the failed part red), intake (the wait for a slot, p50, an hour; it
//                    stands behind the engine, whose own board is cut: its machine walls carry its
//                    tide), tests · deploy (one butterfly: runs up, their
//                    failures red; deploys down), apps (deploys by the team they landed on, in its
//                    hue). The right three stand tall, into the top band. Every board carries YESTERDAY's same
//                    hours dashed (the persisted hourly ring, agg/baseline.ts); while the ring has
//                    no yesterday, the 7-d typical hour, flat; and hours nobody recorded are a
//                    dotted base, never a box.
//   the now seams    (live, on the 1 Hz beat) every board's NOW edge, joined along the wall's top
//                    into one seam; and one across the lane curbs' ends.
//   approach roads   each lane's road leaves its dock and fans out into the dark left and lower
//                    left (the back lane straight out, the front one forward-left), every road the
//                    same length (24 h), as wide as its day's volume (√). Its hours are bars across
//                    the road in the lane's hue; an hour whose failures ran over the lane's p90
//                    gets red tips (≤ 30 % of the bar): bright for the last hour, desaturated after.
//                    fx-polish (overseer note 10): the fan runs on its own APRON, the dark band
//                    left of the slab (the roads' hull, edged like the slab), and every road
//                    starts 24 h back at an ORIGIN MARK inside it: a curb stub across the road
//                    and a post, in the lane's hue. Nothing runs off into the void.
//   lane curbs       §E: along the front strip, in front of the PR yard, the main lines and the
//                    engine, one row per lane in its hue and in lane order: the lane's failures an
//                    hour as a step profile, red only above its p90 (dashed). fx-polish (note 11):
//                    each row's left end is capped by its dock's hue chip, and every row is a
//                    hover (the lane, its failures an hour over 24 h) and the group's lens.
//
// STATIC: all of it paints on the static floor from data that changes only when the lanes' count
// does (floor.ts `data.ver`, at most every 2 s of fleet time), or the group counts, or the trends:
// all of which are already in the floor's key (groupfloor's `sig` carries floor.sig, G.ver and the
// trends' version). `sig` here says the same. Only the now seams are live.

import type { Metric } from '../wire.ts';
import type { Gfx } from '../yard/gfx.ts';
import { C, clamp, withAlpha } from '../yard/theme.ts';
import { insights } from '../insights.ts';
import { normTeam } from '../../server/floor.ts';
import { BOTS } from '../world.ts';
import { baseline, type BaseMetric } from './agg/baseline.ts';
import type { Factory } from './factory.ts';
import { floorGroups } from './groups.ts';
import { LV, UY, VY } from './iso.ts';
import { PLAN } from './layout.ts';
import { breathe } from './motion.ts';
import { F, box, poly } from './prims.ts';
import { failuresOf, threshold, trendOfLane } from './trendmarks.ts';
import type { FloorPass, HitBox, Layer, LiveFrame } from './types.ts';

const { DOCK_U0, YARD_U0, YARD_U1, GATE_U, RAIL_U1, INTAKE_U0, ENG_U1, TRACK_U1, CITY_U0, CITY_U1 } = PLAN;
const HOUR = 3_600_000;
/** A failure before the current hour: a muted, darker red (red itself means failing now). */
const RUST = '#8E5A5C';
type Series = (number | null)[];
type Pt = [number, number];

/** A back-wall board: its stage, title, span along the wall (u) and height (z0 → z1). */
export type Board = { id: 'pushes' | 'opened' | 'landed' | 'intake' | 'tests' | 'apps'; stage: string; title: string; u0: number; u1: number; z0: number; z1: number };

/** The boards, left → right. Each is as tall as the band over it allows (the titles' row stays
 *  clear: labels.ts `titleRow`); the apps board stands over the city's back row. */
export const BOARDS: readonly Board[] = [
  { id: 'pushes', stage: '01', title: 'sources', u0: DOCK_U0, u1: YARD_U0 - 8, z0: 4, z1: 60 },
  { id: 'opened', stage: '02', title: 'pr yard', u0: YARD_U0, u1: YARD_U1, z0: 4, z1: 82 },
  { id: 'landed', stage: '04', title: 'main lines', u0: GATE_U + 12, u1: RAIL_U1 - 12, z0: 4, z1: 122 },
  { id: 'intake', stage: '05', title: 'intake', u0: INTAKE_U0 - 14, u1: ENG_U1 - 72, z0: 10, z1: 176 },
  { id: 'tests', stage: '07', title: 'tests · deploy', u0: ENG_U1 + 14, u1: TRACK_U1, z0: 6, z1: 244 },
  { id: 'apps', stage: '09', title: 'apps', u0: CITY_U0 + 4, u1: CITY_U1 - 4, z0: 30, z1: 272 },
];
/** The tests · deploy board's split: runs stand above it, deploys hang below (share of height). */
const SPLIT = 0.36;
/** The titles' row: its baseline is the screen height of (0, 0, TITLE_Z) (≈ y 92 on the factory
 *  canvas at the fit, 1440 × 900: y 118 on the page). */
export const TITLE_Z = 80;

/** The lane curbs: their span (u), the first row's v, the rows' pitch and depth (v), the
 *  profile's full height (z). */
export const CURB = { U0: YARD_U0 + 18, U1: ENG_U1, V0: LV + 10, PITCH: 14, FAN: 20, DV: 4, Z: 12 } as const;
/** Curb row i's v at u: the rows converge on NOW (their right end, `PITCH` apart) and fan out
 *  toward their oldest hour (`PITCH + FAN` apart), into the dark lower left, which the
 *  projection leaves deep in front of the PR yard and shallow in front of the engine. */
export function curbV(i: number, u: number): number { return CURB.V0 + i * (CURB.PITCH + (CURB.FAN * (CURB.U1 - u)) / (CURB.U1 - CURB.U0)); }
/** The approach roads: the stub's end (u, back lane → front lane), the fan's angles (world, from
 *  −u toward +v), the roads' length, their half width (min, max). */
const ROAD = { U1A: -10, U1B: -58, A0: (-8 * Math.PI) / 180, A1: (113 * Math.PI) / 180, LEN: 420, HW0: 2.5, HW1: 11 } as const;
/** The nominal fit the roads are kept on screen at (iso.ts at 1440 × 840: s, ox, oy); x0 leaves
 *  the apron's rim and the origin posts inside the screen. */
const FIT = { s: 0.848, ox: 305.5, oy: 160.1, x0: 30, y0: 52, y1: 768 } as const;
/** fx-polish: the apron's rim beyond the roads (u), the origin mark (stub depth, post side and
 *  height, u / z), the curbs' end cap (u long, z high). */
const APRON = { RIM: 9 } as const;
const ORIGIN = { DEPTH: 2.6, POST: 3.2, Z: 9 } as const;
const CAP = { DU: 7, Z: 4.5 } as const;

/** One lane's road and curb for this count. */
type LaneEdge = {
  id: string; hex: string; name: string; i: number;
  /** the road's hours (oldest first) and what they count; failures an hour */
  vol: Series; volWhat: string; fail: number[];
  /** the failures/h threshold for red (the lane's p90 or 1.25 × typical), and its source */
  thr: number; thrWhy: string;
  /** the road (dock → stub end → far end), its half width (its curb row: `curbV(i, u)`) */
  road: Pt[]; hw: number;
};

/** A board's series for this count. */
type BoardData = {
  b: Board;
  up: Series; upBad: Series | null; upWhat: string;
  down?: Series; downBad?: Series | null;
  /** apps: per hour, per lane (stacked in lane order) */
  stack?: { hex: string; n: Series }[];
  /** yesterday's same hours (null: none), else a flat typical; for the deploys too */
  ghost: Series | null; flat: number | null; dGhost?: Series | null; dFlat?: number | null;
  mx: number; dmx: number;
  /** intake: the wait above which an hour is worse than usual (s), null when unknown */
  over?: number | null;
  /** how a series was approximated (hover), '' when it was not */
  note?: string;
};

export class Front implements Layer {
  readonly name = 'front';
  private key = '';
  private lanes: LaneEdge[] = [];
  private boards: BoardData[] = [];
  /** fx-polish: the roads' apron (the dark band they run on), floor polygons off the slab. */
  private apron: Pt[][] = [];
  private hov = new Map<HitBox, string[]>();
  /** fx-polish: the curbs' hit boxes → their lane (hover's chart; lens.ts `part`). */
  private curbHits = new Map<HitBox, LaneEdge>();
  private seeded = -1;

  constructor(readonly f: Factory) {}

  /** What the static floor shows of this layer, as a key: it changes with the lanes' count (every
   *  ≥ 2 s of fleet time), the group counts and the trends, all of which the floor's key already
   *  carries (floor.sig, groupfloor's sig). */
  get sig(): string { return this.key; }

  private get on(): boolean { return this.f.floor.on; }

  // ---- the count (O(lanes × 24 + commits), redone when the lanes' count is) ----------------------
  census(): void {
    if (!this.on) { if (this.key) { this.key = ''; this.lanes = []; this.boards = []; } return; }
    const fl = this.f.floor, G = floorGroups(), ins = insights();
    const key = `${fl.data.ver}|${fl.lanes.ver}|${G.ver}|${ins.ver('trends')}`;
    if (key === this.key) return;
    this.key = key;
    const cov = this.coverage();
    this.record();
    this.lanes = this.laneEdges(cov);
    this.boards = BOARDS.map((b) => this.board(b, cov));
  }

  /** The first hour slot (0 = 24 h ago … 23) the world's commits cover: a store at its cap (the
   *  built-in demo keeps 1,200) holds only the last few hours, and the hours before its oldest
   *  commit are "no record", not zero. */
  private coverage(): number {
    const w = this.f.world, at = this.f.floor.data.last.at;
    if (w.commits.size < 1000 || !(at > 0)) return 0;
    let old = at;
    for (const c of w.commits.values()) if (c.at < old) old = c.at;
    return old <= at - 23 * HOUR ? 0 : clamp(23 - Math.floor((at - old) / HOUR), 0, 23);
  }

  /** Feeds the persisted hourly ring with what the boards count and no server trend carries (the
   *  fleet's PRs opened, commits landed, deploys), seeding a fresh ring with today's 24 h, so
   *  tomorrow's boards have a yesterday. */
  private record(): void {
    const ins = insights(), cnt = this.f.floor.data.last, W = cnt.wall;
    if (ins.tl.mode !== 'live' || !(cnt.at > 0)) return;
    const b = baseline();
    const ft = ins.trend('fleet');
    const dep = ft?.deploys.spark.length === 24 ? ft.deploys.spark : Array.from(W.deploys);
    if (this.seeded !== ins.tl.epoch) {
      this.seeded = ins.tl.epoch;
      b.seed('fleet', 'opened', Array.from(W.opened), cnt.at);
      b.seed('fleet', 'landed', Array.from(W.landed), cnt.at);
      b.seed('fleet', 'deploys', dep, cnt.at);
      if (ft) b.seed('fleet', 'intake_s', ft.intake_ms.spark.map((x) => (x === null ? null : x / 1000)), cnt.at);
    }
    b.record('fleet', 'opened', cnt.at, W.opened[23]);
    b.record('fleet', 'landed', cnt.at, W.landed[23]);
    b.record('fleet', 'deploys', cnt.at, ft ? ft.deploys.h1 : W.deploys[23]);
    if (ft?.intake_ms.h1 !== null && ft?.intake_ms.h1 !== undefined) b.record('fleet', 'intake_s', cnt.at, ft.intake_ms.h1 / 1000);
  }

  /** Each hued lane's road (a fan from the docks) and curb (a row along the front strip). */
  private laneEdges(cov: number): LaneEdge[] {
    const fl = this.f.floor, G = floorGroups(), cnt = fl.data.last;
    const geo = fl.lanesNow.filter((L) => L.kind !== 'bots');
    const n = geo.length, v05 = this.f.world.v05;
    const out = geo.map((L, i): LaneEdge => {
      const info = cnt.lanes.get(L.id);
      const t = trendOfLane(G.lane(L.id) ?? { id: L.id, kind: 'bots', members: [] } as never);
      // the road's volume: its pushes when the world holds the day, else its runs (the trend's)
      // (a trend's day only from a v0.5 server: v0.4's approximations hold the last ~2 h)
      const runs = v05 ? full(t?.pipelines.spark) : null;
      const push: Series = info ? Array.from(info.push24, (x, k) => (k < cov ? null : x)) : new Array<number | null>(24).fill(null);
      const [vol, volWhat] = cov > 4 && runs ? [runs, 'runs'] : [push, 'pushes'];
      // failures an hour: the lane's trend (runs × fail rate), else its main lines' failed commits
      const fm: Metric | null = t ? failuresOf(t) : null;
      const fs = v05 ? full(fm?.spark) : null;
      const fail = Array.from({ length: 24 }, (_, k) => Math.max(0, (fs ? fs[k] : info?.fail24[k]) ?? 0));
      const [thr, thrWhy] = laneThreshold(fm, L.id, fail, cnt.at);
      // the road: the stub along the lane, then the fan (kept off the slab and the curbs, and on
      // screen at the fit), every road the same length so an hour is the same arc on all of them
      const vm = (L.b0 + L.b1) / 2, k = n > 1 ? i / (n - 1) : 0;
      const p1: Pt = [ROAD.U1A + (ROAD.U1B - ROAD.U1A) * k, vm];
      const aMax = Math.PI / 2 + Math.atan2(-p1[0] - 6, LV + 8 - vm);
      const a = Math.min(ROAD.A0 + (ROAD.A1 - ROAD.A0) * k, aMax);
      const d: Pt = [-Math.cos(a), Math.sin(a)];
      const p2: Pt = [p1[0] + d[0] * ROAD.LEN, p1[1] + d[1] * ROAD.LEN];
      return { id: L.id, hex: L.hex, name: G.lane(L.id)?.short ?? L.id, i, vol, volWhat, fail, thr, thrWhy, road: [[DOCK_U0 - 4, vm], p1, p2], hw: 0 };
    });
    // widths: √ of each road's day against the busiest road's (same unit only)
    let mx = 1;
    const sums = out.map((e) => e.vol.reduce<number>((s, x) => s + (x ?? 0), 0));
    out.forEach((e, i) => { if (e.volWhat === out[0]?.volWhat) mx = Math.max(mx, sums[i]!); });
    out.forEach((e, i) => { e.hw = ROAD.HW0 + (ROAD.HW1 - ROAD.HW0) * Math.sqrt(Math.min(1, sums[i]! / mx)); });
    // shorten any road that would leave the screen at the fit (all keep the shortest's length)
    let len: number = ROAD.LEN;
    for (const e of out) {
      const [p1, p2] = [e.road[1]!, e.road[2]!];
      for (let t = 40; t <= ROAD.LEN; t += 5) {
        const u = p1[0] + ((p2[0] - p1[0]) * t) / ROAD.LEN, v = p1[1] + ((p2[1] - p1[1]) * t) / ROAD.LEN;
        const x = FIT.ox + FIT.s * (0.86 * u - 0.36 * v), y = FIT.oy + FIT.s * (0.19 * u + 0.66 * v);
        if (x < FIT.x0 + e.hw || y < FIT.y0 || y > FIT.y1) { len = Math.min(len, t - 5); break; }
      }
    }
    for (const e of out) { const [p1, p2] = [e.road[1]!, e.road[2]!]; e.road[2] = [p1[0] + ((p2[0] - p1[0]) * len) / ROAD.LEN, p1[1] + ((p2[1] - p1[1]) * len) / ROAD.LEN]; }
    this.apron = apronOf(out);
    return out;
  }

  /** A board's series, yesterday's ghost and scale. */
  private board(b: Board, cov: number): BoardData {
    const cnt = this.f.floor.data.last, W = cnt.wall, ins = insights(), G = floorGroups();
    const A = (x: Int16Array, from = 0): Series => Array.from(x, (v, k) => (k < from ? null : v));
    const ft = ins.trend('fleet'), v05 = this.f.world.v05;
    const typ = (m: Metric | undefined) => (ft && m && m.d7 !== null && ft.hours_7d >= 24 ? m.d7 : null);
    const out: BoardData = { b, up: [], upBad: null, upWhat: '', ghost: null, flat: null, mx: 1, dmx: 1 };
    const ghost = (metric: BaseMetric, t: number | null): [Series | null, number | null] => {
      const y = yesterday(metric, cnt.at);
      return y ? [y, null] : [null, t];
    };
    switch (b.id) {
      case 'pushes': out.up = A(W.pushes, cov); out.upWhat = 'pushes'; [out.ghost, out.flat] = ghost('pushes', null); break;
      case 'opened': out.up = A(W.opened); out.upBad = A(W.openedRed); out.upWhat = 'PRs opened'; [out.ghost, out.flat] = ghost('opened', null); break;
      case 'landed': out.up = A(W.landed); out.upBad = A(W.landedRed); out.upWhat = 'commits landed'; [out.ghost, out.flat] = ghost('landed', null); break;
      case 'intake': {
        // the wait for a slot (p50, seconds) an hour: the trend's (v0.5: the server's day)
        // (v0.4: the approximation covers the held runs only, ~2 h: before them, no record)
        const sp = ft?.intake_ms.spark ?? [], from = v05 ? 0 : this.runsFrom(cnt.at)[0];
        out.up = Array.from({ length: 24 }, (_, k) => { const v = sp.length === 24 && k >= from ? sp[k] : null; return v === null || v === undefined ? null : Math.round(v / 100) / 10; });
        out.upWhat = 'wait (s, p50)';
        // worse than usual: over the ring's same-hour p90 (7 d) and the typical hour × 1.25
        const ring = baseline().p90('fleet', 'intake_s', cnt.at);
        const day = (out.up.filter((x) => x !== null) as number[]).sort((a, b) => a - b);
        const typ = ft ? threshold(ft.intake_ms, 'fleet', 'intake_ms', cnt.at) : null;
        // (and always over the day's own p90: at most the day's few worst hours are marked)
        out.over = day.length >= 6 ? Math.max(ring ?? 0, day[Math.round(0.9 * (day.length - 1))]!, typ === null ? 0 : typ / 1000) : ring;
        [out.ghost, out.flat] = ghost('intake_s', ft && ft.intake_ms.d7 !== null && ft.hours_7d >= 24 ? Math.round(ft.intake_ms.d7 / 100) / 10 : null);
        break;
      }
      case 'tests': {
        // the server's day (the trend's sparks) when it has one; else the held runs (a v0.4 world
        // keeps ~2 h of them) and, before the oldest, one run per commit by its CI (as insights'
        // "since" approximation counts them)
        const runs = v05 ? full(ft?.pipelines.spark) : null, fails = ft ? full(failuresOf(ft).spark) : null, deps = v05 ? full(ft?.deploys.spark) : null;
        if (runs) { out.up = runs; out.upBad = fails; }
        else { [out.up, out.upBad] = this.runsOfWorld(cnt.at); if (this.runsFrom(cnt.at)[0] > 0) out.note = 'older hours: a run per commit, by its CI'; }
        out.upWhat = 'runs';
        out.down = deps ?? A(W.deploys); out.downBad = A(W.deploysRed);
        [out.ghost, out.flat] = ghost('pipelines', typ(ft?.pipelines));
        [out.dGhost, out.dFlat] = ghost('deploys', typ(ft?.deploys));
        break;
      }
      case 'apps': {
        // deploys an hour, stacked by the team (lane) they landed on: the lanes' trends
        const stack: { hex: string; n: Series }[] = [];
        const tot: Series = new Array<number | null>(24).fill(null);
        for (const l of G.lanes()) {
          if (l.kind === 'bots') continue;
          const sp = full(trendOfLane(l)?.deploys.spark);
          if (!sp || !sp.some((x) => (x ?? 0) > 0)) continue;
          stack.push({ hex: G.hex(l.id), n: sp });
          sp.forEach((x, k) => { if (x !== null) tot[k] = (tot[k] ?? 0) + x; });
        }
        if (stack.length) { out.stack = stack; out.up = tot; }
        else out.up = A(W.deploys);
        out.upBad = A(W.deploysRed); out.upWhat = 'deploys';
        [out.ghost, out.flat] = ghost('deploys', typ(ft?.deploys));
        break;
      }
    }
    const mxOf = (...xs: (Series | null | undefined | number)[]) => {
      let m = 1;
      for (const s of xs) { if (typeof s === 'number') m = Math.max(m, s); else if (s) for (const v of s) if (v !== null && v > m) m = v; }
      return m;
    };
    out.mx = mxOf(out.up, out.ghost, out.flat ?? 0);
    if (out.down) out.dmx = mxOf(out.down, out.dGhost, out.dFlat ?? 0);
    return out;
  }

  /** Runs and failed runs an hour from the world: the held runs (finished), and before the
   *  oldest of them one per commit's pipeline by its combined CI (null where neither covers). */
  /** Where the world's held runs start: the hour slot and time of their 5th percentile (a few
   *  old ones linger past the rest). */
  private runsFrom(at: number): [number, number] {
    const cr: number[] = [];
    for (const p of this.f.world.pipelines.values()) cr.push(p.created);
    cr.sort((a, b) => a - b);
    const oldest = cr.length ? cr[Math.floor(cr.length * 0.05)]! : at;
    return [oldest <= at - 23 * HOUR ? 0 : clamp(23 - Math.floor((at - oldest) / HOUR), 0, 23), oldest];
  }

  private runsOfWorld(at: number): [Series, Series] {
    const w = this.f.world, W = this.f.floor.data.last.wall;
    const [from, oldest] = this.runsFrom(at);
    const up: Series = Array.from(W.runs, (v, k) => (k < from ? null : v)), bad: Series = Array.from(W.runsRed, (v, k) => (k < from ? null : v));
    if (!from) return [up, bad];
    for (const c of w.commits.values()) {
      if (c.at >= oldest || c.at <= at - 24 * HOUR || c.ci === 'pending' || c.ci === 'running' || c.ci === 'none' || c.ci === 'skipped') continue;
      const k = 23 - Math.min(23, Math.floor((at - c.at) / HOUR));
      if (k >= from) continue;
      up[k] = (up[k] ?? 0) + Math.max(1, c.pipelines?.length ?? 1);
      if (c.ci === 'failure' || c.ci === 'error') bad[k] = (bad[k] ?? 0) + 1;
    }
    return [up, bad];
  }

  // ---- the static floor ----------------------------------------------------------------------
  floor(fp: FloorPass): void {
    if (!this.on || fp.idle) return;
    if (!this.key) this.census();
    const g = fp.g;
    for (const d of this.boards) this.paintBoard(g, d, fp.lo);
    this.paintRoads(g, fp.lo);
    this.paintCurbs(g, fp.lo);
  }

  /** A board: a faint plate (only when its day has data), the base rule (dotted over hours nobody
   *  recorded), the bars (one path per colour), yesterday dashed. */
  private paintBoard(g: Gfx, d: BoardData, lo: boolean): void {
    const cam = this.f.cam, b = d.b;
    const pitch = (b.u1 - b.u0 - 6) / 24, bw = Math.max(1, pitch * 0.66);
    const uAt = (k: number) => b.u0 + 3 + (k + 0.5) * pitch;
    const P = (u: number, z: number): Pt => [cam.x(u, 0), cam.y(u, 0, z)];
    const tests = !!d.down;
    const zBase = tests ? b.z0 + (b.z1 - b.z0) * SPLIT : b.z0;
    const H = b.z1 - zBase, Hd = zBase - b.z0;
    const sc = (n: number, mx: number, h: number) => h * Math.sqrt(Math.max(0, n) / mx);
    const any = d.up.some((x) => (x ?? 0) > 0) || (d.down?.some((x) => (x ?? 0) > 0) ?? false);
    if (any) { g.begin_(); const q = [P(b.u0, b.z0), P(b.u1, b.z0), P(b.u1, b.z1), P(b.u0, b.z1)]; g.move(q[0]![0], q[0]![1]); for (const p of q.slice(1)) g.line(p[0], p[1]); g.ctx.closePath(); g.fill('#0F0F11'); }
    // the base rule: solid over recorded hours, dotted over the rest (a board with nothing in its
    // day is only this line, dotted)
    const solid: number[] = [], dotted: number[] = [];
    for (let k = 0; k < 24; k++) ((d.up[k] ?? null) === null || !any ? dotted : solid).push(k);
    const rule = (ks: number[], col: string, dash: boolean) => {
      if (!ks.length) return;
      if (dash) g.dash(true, 2, 3);
      g.begin_();
      for (const k of ks) { const [xa, ya] = P(b.u0 + 3 + k * pitch, zBase), [xb, yb] = P(b.u0 + 3 + (k + 1) * pitch, zBase); g.move(xa, ya); g.line(xb, yb); }
      g.stroke(col, Math.max(1, g.hair * 1.4));
      if (dash) g.dash(false);
    };
    rule(solid, '#46464B', false);
    rule(dotted, withAlpha('#A4A4AA', 0.8), true);
    const bars = (path: number[], u: number, za: number, zb: number) => { if (Math.abs(zb - za) > 0.2) path.push(u, za, zb); };
    const flush = (path: number[], col: string) => {
      if (!path.length) return;
      g.begin_();
      for (let i = 0; i < path.length; i += 3) {
        const u = path[i]!, za = path[i + 1]!, zb = path[i + 2]!;
        const [x0, y0] = P(u - bw / 2, za), [x1, y1] = P(u + bw / 2, za), [x2, y2] = P(u + bw / 2, zb), [x3, y3] = P(u - bw / 2, zb);
        g.ctx.moveTo(x0, y0); g.ctx.lineTo(x1, y1); g.ctx.lineTo(x2, y2); g.ctx.lineTo(x3, y3); g.ctx.closePath();
      }
      g.ops += (path.length / 3) * 5;
      g.fill(col);
    };
    // the failed share: red only in the current hour (red is "failing now"); before it, rust
    const gray: number[] = [], red: number[] = [], rust: number[] = [], ok: number[] = [];
    const hue: number[][] = (d.stack ?? []).map(() => []);
    for (let k = 0; k < 24; k++) {
      const u = uAt(k), n = d.up[k] ?? 0;
      if (n > 0) {
        const h = sc(n, d.mx, H), r = d.upBad ? Math.min(h, h * ((d.upBad[k] ?? 0) / n)) : 0;
        if (d.over !== undefined) {
          // intake: the wait, gray; an hour worse than usual rust (red in the current hour)
          const bad = d.over !== null && n > d.over;
          bars(bad ? (k === 23 ? red : rust) : gray, u, zBase, zBase + h);
          continue;
        }
        if (d.stack) {
          let z = zBase;
          d.stack.forEach((s, j) => { const m = s.n[k] ?? 0; if (m <= 0) return; const dz = ((h - r) * m) / n; bars(hue[j]!, u, z, z + dz); z += dz; });
        } else bars(gray, u, zBase, zBase + h - r);
        if (r > 0) bars(k === 23 ? red : rust, u, zBase + h - r, zBase + h);
      }
      const m = d.down?.[k] ?? 0;
      if (m > 0) {
        const h = sc(m, d.dmx, Hd), r = d.downBad ? Math.min(h, h * ((d.downBad[k] ?? 0) / m)) : 0;
        bars(ok, u, zBase - h + r, zBase);
        if (r > 0) bars(k === 23 ? red : rust, u, zBase - h, zBase - h + r);
      }
    }
    d.stack?.forEach((s, j) => flush(hue[j]!, withAlpha(s.hex, 0.92)));
    flush(gray, '#5A5A60'); flush(ok, '#6F8A76'); flush(rust, RUST); flush(red, F.redTop);
    // yesterday's same hours (a dashed step line), else the typical hour (flat), on the bars' scale
    if (lo) return;
    const ghostLine = (ys: Series | null | undefined, flat: number | null | undefined, mx: number, h: number, down: boolean) => {
      const zOf = (v: number) => (down ? zBase - sc(v, mx, h) : zBase + sc(v, mx, h));
      g.dash(true, 3, 2.5);
      g.begin_();
      let drew = false;
      if (ys) {
        let pen = false;
        for (let k = 0; k < 24; k++) {
          const v = ys[k];
          if (v === null || v === undefined) { pen = false; continue; }
          const z = zOf(v), [xa, ya] = P(b.u0 + 3 + k * pitch, z), [xb, yb] = P(b.u0 + 3 + (k + 1) * pitch, z);
          if (pen) g.line(xa, ya); else g.move(xa, ya);
          g.line(xb, yb);
          pen = true; drew = true;
        }
      } else if (flat !== null && flat !== undefined && flat > 0) {
        const z = zOf(flat), [xa, ya] = P(b.u0 + 3, z), [xb, yb] = P(b.u1 - 3, z);
        g.move(xa, ya); g.line(xb, yb); drew = true;
      }
      if (drew) g.stroke(withAlpha('#C4C4CA', 0.85), Math.max(1, g.hair * 1.4));
      g.dash(false);
    };
    ghostLine(d.ghost, d.flat, d.mx, H, false);
    if (d.down) ghostLine(d.dGhost, d.dFlat, d.dmx, Hd, true);
  }

  /** The approach roads: each lane's band (its hue, faint), then its hours as bars across it
   *  (oldest at the far end, this hour at the dock), the bar's length the hour's volume against
   *  the lane's busiest; red tips where its failures ran over the lane's p90. */
  private paintRoads(g: Gfx, lo: boolean): void {
    const cam = this.f.cam;
    const capNow: number[] = [], capOld: number[] = [];
    // fx-polish: the apron first (the dark band the fan runs on), edged like the slab, its rim
    // along the slab's left edge left open (the slab's own edge is there)
    for (const A of this.apron) {
      if (A.length < 3) continue;
      // a seam with the slab (u 0 or v LV, both ends on it) is no edge
      const seam = (a: Pt, b: Pt) => (Math.abs(a[0]) < 0.5 && Math.abs(b[0]) < 0.5) || (Math.abs(a[1] - LV) < 0.5 && Math.abs(b[1] - LV) < 0.5);
      // its lip: the edges facing the camera drop 4 units, as the slab's front lip does
      g.begin_();
      for (let k = 0; k < A.length; k++) {
        const a = A[k]!, b = A[(k + 1) % A.length]!;
        if (seam(a, b) || (b[1] - a[1]) * UY - (b[0] - a[0]) * VY <= 0) continue;
        poly(cam, g, [a[0], a[1], 0, b[0], b[1], 0, b[0], b[1], -4, a[0], a[1], -4]);
      }
      g.fill('#0A0A0B');
      g.begin_(); A.forEach(([u, v], k) => (k ? g.line(cam.x(u, v), cam.y(u, v)) : g.move(cam.x(u, v), cam.y(u, v)))); g.ctx.closePath(); g.fill(F.floor);
      g.begin_();
      let pen = false;
      for (let k = 0; k < A.length; k++) {
        const a = A[k]!, b = A[(k + 1) % A.length]!;
        if (seam(a, b)) { pen = false; continue; }
        if (!pen) g.move(cam.x(a[0], a[1]), cam.y(a[0], a[1]));
        g.line(cam.x(b[0], b[1]), cam.y(b[0], b[1])); pen = true;
      }
      g.stroke('#2A2A2E', g.hair * 1.5);
      g.ops += A.length * 7;
    }
    for (const L of this.lanes) {
      const pts = L.road;
      g.begin_(); ribbon(cam, g, pts, L.hw + 1); g.fill(withAlpha(L.hex, 0.09));
      if (!lo) { g.begin_(); edges(cam, g, pts, L.hw + 1); g.stroke(withAlpha(L.hex, 0.32), Math.max(1, g.hair)); }
      // the hours: quads across the fan segment (p1 → p2), symmetric about its centre line
      const [p1, p2] = [pts[1]!, pts[2]!];
      const du = p2[0] - p1[0], dv = p2[1] - p1[1], len = Math.hypot(du, dv) || 1;
      const tu = du / len, tv = dv / len, nu = -tv, nv = tu;
      let mx = 1;
      for (const x of L.vol) if (x !== null && x > mx) mx = x;
      const slot = len / 24, th = slot * 0.42;
      const body: number[] = [], none: number[] = [];
      for (let k = 0; k < 24; k++) {
        const s = (23 - k + 0.5) * slot, cu = p1[0] + tu * s, cv = p1[1] + tv * s;
        const x = L.vol[k];
        if (x === null || x === undefined) { none.push(cu, cv, L.hw * 0.25); continue; }
        if (x <= 0 && !(L.fail[k]! > L.thr)) continue;
        const w = Math.max(0.9, (L.hw * Math.max(0, x)) / mx);
        const over = L.fail[k]! > L.thr;
        const cap = over ? w * Math.min(0.3, 0.14 + 0.05 * (L.fail[k]! - L.thr)) : 0;
        body.push(cu, cv, w - cap);
        if (over) (k === 23 ? capNow : capOld).push(cu, cv, w - cap, w);
      }
      const across = (list: number[], col: string) => {
        if (!list.length) return;
        g.begin_();
        for (let i = 0; i < list.length; i += 3) {
          const cu = list[i]!, cv = list[i + 1]!, w = list[i + 2]!;
          quadAt(cam, g, cu, cv, tu, tv, nu, nv, th, -w, w);
        }
        g.ops += (list.length / 3) * 5;
        g.fill(col);
      };
      across(body, withAlpha(L.hex, 0.95));
      across(none, withAlpha(L.hex, 0.3));
      void th;
      if (capNow.length || capOld.length) {
        // the red tips, both ends of the bar (this lane's; flushed per lane: the tangent differs)
        const tips = (list: number[], col: string) => {
          if (!list.length) return;
          g.begin_();
          for (let i = 0; i < list.length; i += 4) {
            const cu = list[i]!, cv = list[i + 1]!, a = list[i + 2]!, b = list[i + 3]!;
            quadAt(cam, g, cu, cv, tu, tv, nu, nv, th, a, b);
            quadAt(cam, g, cu, cv, tu, tv, nu, nv, th, -b, -a);
          }
          g.ops += (list.length / 4) * 10;
          g.fill(col);
          list.length = 0;
        };
        tips(capOld, RUST);
        tips(capNow, F.redTop);
      }
      this.origin(g, L, tu, tv, nu, nv);
    }
  }

  /** fx-polish (note 10): where a road starts, 24 h back: a low curb stub across its far end and a
   *  post at its middle, in the lane's hue (lit top, shaded faces), inside the apron. */
  private origin(g: Gfx, L: LaneEdge, tu: number, tv: number, nu: number, nv: number): void {
    const cam = this.f.cam, p2 = L.road[2]!, w = L.hw + 2.5, d = ORIGIN.DEPTH;
    const [cu, cv] = [p2[0] + tu * d * 0.5, p2[1] + tv * d * 0.5];
    const P = (s: number, n: number, z: number): Pt => [cam.x(cu + tu * s + nu * n, cv + tv * s + nv * n), cam.y(cu + tu * s + nu * n, cv + tv * s + nv * n, z)];
    const face = (pts: Pt[], col: string) => { g.begin_(); pts.forEach(([x, y], k) => (k ? g.line(x, y) : g.move(x, y))); g.ctx.closePath(); g.fill(col); };
    const dark = mixDark(L.hex), mid = withAlpha(L.hex, 0.55);
    // the stub: its two faces toward the camera (+v), then its top
    const zs = 2.2;
    face([P(-d / 2, -w, 0), P(-d / 2, w, 0), P(-d / 2, w, zs), P(-d / 2, -w, zs)], dark);
    face([P(d / 2, -w, 0), P(d / 2, w, 0), P(d / 2, w, zs), P(d / 2, -w, zs)], dark);
    face([P(-d / 2, -w, zs), P(-d / 2, w, zs), P(d / 2, w, zs), P(d / 2, -w, zs)], withAlpha(L.hex, 0.9));
    // the post (axis-aligned, so its faces read as the docks' do)
    const q = ORIGIN.POST;
    box(cam, g, cu - q / 2, cv - q / 2, q, q, ORIGIN.Z, L.hex, dark, mid, withAlpha(L.hex, 0.9), Math.max(1, g.hair));
    g.ops += 24;
  }

  /** The lane curbs: per lane a row along the front strip, far rows first (a near row's profile
   *  stands over the one behind it, a ridgeline): a faint hue plate and rule, its failures an hour
   *  as a step profile (a translucent face, its outline in the lane's hue), the part over the
   *  lane's p90 red (rust before the current hour), the p90 dashed. */
  private paintCurbs(g: Gfx, lo: boolean): void {
    const cam = this.f.cam;
    let mx = 2;
    for (const L of this.lanes) for (const v of L.fail) mx = Math.max(mx, v);
    const pitch = (CURB.U1 - CURB.U0) / 24;
    const zOf = (v: number) => (v <= 0 ? 0 : 1.2 + (CURB.Z - 1.2) * Math.sqrt(v / mx));
    for (const L of this.lanes) {
      const va = curbV(L.i, CURB.U0), vb = curbV(L.i, CURB.U1);
      g.begin_(); poly(cam, g, [CURB.U0, va, 0, CURB.U1, vb, 0, CURB.U1, vb + CURB.DV, 0, CURB.U0, va + CURB.DV, 0]); g.fill(withAlpha(L.hex, 0.1));
      const P = (u: number, z: number): Pt => { const v = curbV(L.i, u) + CURB.DV; return [cam.x(u, v), cam.y(u, v, z)]; };
      const any = L.fail.some((x) => x > 0);
      // the profile: its face (under the dark of the row behind), then its outline
      const outline = () => {
        let [x, y] = P(CURB.U0, 0); g.move(x, y);
        for (let k = 0; k < 24; k++) {
          const z = zOf(L.fail[k]!), ua = CURB.U0 + k * pitch, ub = ua + pitch;
          [x, y] = P(ua, z); g.line(x, y); [x, y] = P(ub, z); g.line(x, y);
        }
        [x, y] = P(CURB.U1, 0); g.line(x, y);
      };
      if (any) { g.begin_(); outline(); g.ctx.closePath(); g.fill(withAlpha(mixDark(L.hex), 0.92)); g.begin_(); outline(); g.ctx.closePath(); g.fill(withAlpha(L.hex, 0.26)); }
      g.begin_(); outline(); g.stroke(withAlpha(L.hex, any ? 0.95 : 0.55), Math.max(1, g.hair * (any ? 1.6 : 1.2)));
      g.ops += 150;
      // fx-polish (note 11): the row's end cap, its dock's hue chip (a low block before its oldest hour)
      box(cam, g, CURB.U0 - CAP.DU - 1, va - 0.6, CAP.DU, CURB.DV + 1.2, CAP.Z, L.hex, mixDark(L.hex), withAlpha(L.hex, 0.55), withAlpha(L.hex, 0.9), Math.max(1, g.hair));
      if (!any) continue;
      // over p90: the part above the threshold, red in the current hour, rust before it
      const zt = zOf(L.thr);
      const redPath = (pick: (k: number) => boolean, col: string) => {
        let n = 0;
        g.begin_();
        for (let k = 0; k < 24; k++) {
          const v = L.fail[k]!;
          if (v <= L.thr || !pick(k)) continue;
          const z = zOf(v), ua = CURB.U0 + k * pitch, ub = ua + pitch;
          const [xa, ya] = P(ua, zt), [xb, yb] = P(ub, zt), [xc, yc] = P(ub, z), [xd, yd] = P(ua, z);
          g.ctx.moveTo(xa, ya); g.ctx.lineTo(xb, yb); g.ctx.lineTo(xc, yc); g.ctx.lineTo(xd, yd); g.ctx.closePath(); n++;
        }
        g.ops += n * 5;
        if (n) g.fill(col);
      };
      redPath((k) => k < 23, RUST);
      redPath((k) => k === 23, F.redTop);
      if (!lo && zt < CURB.Z) {
        const [xa, ya] = P(CURB.U0, zt), [xb, yb] = P(CURB.U1, zt);
        g.dash(true, 2, 3); g.begin_(); g.move(xa, ya); g.line(xb, yb); g.stroke(withAlpha('#C4C4CA', 0.35), 1); g.dash(false);
      }
    }
  }

  // ---- hits and hover --------------------------------------------------------------------------
  hits(fr: LiveFrame): void {
    this.hov.clear();
    this.curbHits.clear();
    if (!this.on) return;
    void fr;
    const f = this.f, cam = f.cam, G = floorGroups(), c = f.census;
    const push = (x: number, y: number, w: number, h: number, kind: string, id: string, label: string, lines: string[]) => {
      const before = f.fx.hits.length;
      f.hit(x, y, w, h, kind, id, label);
      const hb = f.fx.hits[f.fx.hits.length - 1];
      if (f.fx.hits.length > before && hb) this.hov.set(hb, lines);
    };
    const sum = (a: Series) => a.reduce<number>((x, y) => x + (y ?? 0), 0);
    // the boards: a stage hit each (a click flies there), the day's numbers on hover
    for (const d of this.boards) {
      const b = d.b, lines = this.boardLines(d);
      for (let ua = b.u0; ua < b.u1; ua += 40) {
        const ub = Math.min(b.u1, ua + 40);
        const x0 = cam.x(ua, 0), x1 = cam.x(ub, 0), y0 = Math.min(cam.y(ua, 0, b.z1), cam.y(ub, 0, b.z1)), y1 = Math.max(cam.y(ua, 0, b.z0), cam.y(ub, 0, b.z0));
        push(x0, y0, x1 - x0, y1 - y0, 'stage', f.words.stageFly(b.stage), b.title, lines);
      }
    }
    // the roads and curbs: the lane's group lens
    const lensOf = (id: string): [string, string, string] => {
      const lane = G.lane(id);
      if (!lane) return ['', '', ''];
      if (lane.kind === 'org') return ['dock', id.slice(4), `${lane.short} dock`];
      if (lane.kind === 'bots') return ['dock', BOTS, 'bots dock'];
      const team = lane.kind === 'other' ? c.districts.find((d) => d.team === 'other teams') : c.districts.find((d) => normTeam(d.team) === id.slice(5));
      return team ? ['district', team.team, `${team.team} ${team.apps.length}`] : ['', '', ''];
    };
    for (const L of this.lanes) {
      // fx-polish (note 11): a lane with no lens to open still names itself on hover (kind 'roadx' /
      // 'curbx': no click), so every road and every curb answers
      const [k0, id0, label0] = lensOf(L.id);
      const [k, id, label] = k0 ? [k0, id0, label0] : ['roadx', L.id, L.name];
      const over = L.fail.filter((x) => x > L.thr).length;
      const vmax = Math.max(0, ...L.vol.map((x) => x ?? 0));
      const roadLines = [`${L.name} · ${L.volWhat} an hour, 24 h`, `${Math.round(sum(L.vol)).toLocaleString('en-US')} ${L.volWhat} · busiest hour ${Math.round(vmax)}`, over ? `${over} h of failures over ${L.thrWhy} (red tips)` : `failures stayed under ${L.thrWhy}`];
      const [p1, p2] = [L.road[1]!, L.road[2]!];
      for (let j = 0; j < 8; j++) {
        const a = j / 8, bb = (j + 1) / 8;
        const ua = p1[0] + (p2[0] - p1[0]) * a, va = p1[1] + (p2[1] - p1[1]) * a, ub = p1[0] + (p2[0] - p1[0]) * bb, vb = p1[1] + (p2[1] - p1[1]) * bb;
        const xs = [cam.x(ua, va), cam.x(ub, vb)], ys = [cam.y(ua, va), cam.y(ub, vb)];
        const pad = Math.max(3, L.hw * cam.s * 0.6);
        const x0 = Math.min(...xs) - pad, y0 = Math.min(...ys) - pad, x1 = Math.max(...xs) + pad, y1 = Math.max(...ys) + pad;
        push(x0, y0, x1 - x0, y1 - y0, k, id, label, roadLines);
      }
      const curbLines = [`${L.name} · failures an hour, 24 h`, `${Math.round(sum(L.fail))} failed · this hour ${Math.round(L.fail[23]!)} · ${L.thrWhy}`, over ? `${over} h over it (red)` : 'no hour over it'];
      // (the end cap first: its chip is the row's handle)
      for (let u = CURB.U0 - CAP.DU - 1; u < CURB.U1 - 0.5; u = u < CURB.U0 ? CURB.U0 : u + 40) {
        const u2 = u < CURB.U0 ? CURB.U0 : Math.min(CURB.U1, u + 40);
        const va = curbV(L.i, Math.max(CURB.U0, u)), vb = curbV(L.i, u2);
        const x0 = cam.x(u, va + CURB.DV), x1 = cam.x(u2, vb), y0 = cam.y(u, va, CURB.Z), y1 = cam.y(u2, vb + CURB.DV, 0);
        const before = f.fx.hits.length;
        push(x0, y0, x1 - x0, Math.max(6, y1 - y0), k0 ? k : 'curbx', id, label, curbLines);
        const hb = f.fx.hits[f.fx.hits.length - 1];
        if (f.fx.hits.length > before && hb) this.curbHits.set(hb, L);
      }
    }
  }

  /** fx-polish: the lane curb a hit is (its lane's id, failures an hour and red threshold), null
   *  when it is not one (lens.ts `part` tells a curb from the lane's other parts by this). */
  curbOf(h: { x: number; y: number; w: number; h: number }): { id: string; name: string; fail: number[]; thr: number } | null {
    const e = this.curbHits.get(h as HitBox);
    if (e) return e;
    for (const [b, L] of this.curbHits) if (b.x === h.x && b.y === h.y && b.w === h.w && b.h === h.h) return L;
    return null;
  }

  /** A board's hover lines (≤ 3). */
  private boardLines(d: BoardData): string[] {
    const sum = (a: Series | null | undefined) => (a ?? []).reduce<number>((x, y) => x + (y ?? 0), 0);
    const num = (x: number) => Math.round(x).toLocaleString('en-US');
    const intake = d.b.id === 'intake';
    const why = d.ghost ? (intake ? 'yesterday, same hours (dashed)' : `yesterday ${num(sum(d.ghost))} (dashed)`) : d.flat !== null ? `typical ${intake ? `${Math.round(d.flat * 10) / 10} s` : `${num(d.flat)}/h`} (dashed)` : 'no yesterday on record yet';
    const now = (s: Series) => num(s[23] ?? 0);
    switch (d.b.id) {
      case 'pushes': return ['sources · pushes an hour', `${num(sum(d.up))} in 24 h${d.up.some((x) => x === null) ? ' (recorded hours)' : ''} · this hour ${now(d.up)}`, why];
      case 'opened': return ['pr yard · PRs opened an hour', `${num(sum(d.up))} opened · ${num(sum(d.upBad))} failing CI (red)`, why];
      case 'landed': return ['main lines · commits landed an hour', `${num(sum(d.up))} landed · ${num(sum(d.upBad))} failed (red)`, why];
      case 'intake': return ['intake · the wait for a slot (p50), an hour', `now ${d.up[23] ?? '—'} s · worst ${Math.max(0, ...d.up.map((x) => x ?? 0))} s${d.over !== null && d.over !== undefined ? ` · usual ≤ ${Math.round(d.over)} s` : ''}`, d.up.some((x) => x === null) ? `${d.up.filter((x) => x === null).length} h not on record (dotted) · ${why}` : why];
      case 'tests': return ['tests ↑ runs · deploy ↓ deploys, an hour', `${num(sum(d.up))} runs, ${num(sum(d.upBad))} failed · ${num(sum(d.down))} deploys`, d.note && !d.ghost && d.flat === null ? d.note : why];
      case 'apps': return ['apps · deploys an hour, by team', `${num(sum(d.up))} deploys · ${d.stack?.length ?? 0} teams${sum(d.upBad) ? ` · ${num(sum(d.upBad))} failed (red)` : ''}`, why];
    }
  }

  hoverFor(h: HitBox): string[] | null { return this.hov.get(h) ?? null; }

  /** fx-polish (note 11): the key's curb row (legend.ts reaches it by the layer's name). */
  legendRow(g: Gfx, x: number, y: number, W: number, H: number, yy: number): number { return this.on && this.lanes.length ? legendCurbRow(g, this.f, x, y, W, H, yy) : yy; }

  /** A board's day for the hover card's chart (by its title or stage), null when none. */
  spark(id: string): (number | null)[] | null {
    const d = this.boards.find((x) => x.b.title === id || x.b.stage === id);
    return d && d.up.some((x) => (x ?? 0) > 0) ? d.up : null;
  }

  // ---- the live layer: the now seams on the beat ------------------------------------------------
  live(g: Gfx, fr: LiveFrame): boolean {
    if (!this.on || !this.boards.length) return false;
    const cam = this.f.cam;
    const k = this.f.reduced ? 0.5 : breathe(fr.t);
    const a = 0.3 + 0.6 * k;
    const col = '#F2EEE4';
    // the wall: every board's NOW edge, joined along the boards' tops into one seam
    const P = (u: number, z: number): Pt => [cam.x(u, 0), cam.y(u, 0, z)];
    const edgesNow = this.boards.map((d) => [d.b.u1 - 3, d.b.z0, d.b.z1] as const);
    g.begin_();
    for (const [u, za, zb] of edgesNow) { const [xa, ya] = P(u, za), [xb, yb] = P(u, zb); g.move(xa, ya); g.line(xb, yb); }
    g.stroke(withAlpha(col, 0.07 + 0.2 * k), 8);
    g.begin_();
    for (const [u, za, zb] of edgesNow) { const [xa, ya] = P(u, za), [xb, yb] = P(u, zb); g.move(xa, ya); g.line(xb, yb); }
    g.stroke(withAlpha(col, 0.18 + 0.2 * k), 4);
    g.begin_();
    for (const [u, za, zb] of edgesNow) { const [xa, ya] = P(u, za), [xb, yb] = P(u, zb); g.move(xa, ya); g.line(xb, yb); }
    g.stroke(withAlpha(col, a), 1.6);
    // the joint: one hairline along the wall's foot through every board's NOW edge (the seam)
    g.begin_();
    { const b0 = this.boards[0]!.b, bl = this.boards[this.boards.length - 1]!.b; const [xa, ya] = P(b0.u0, 1), [xb, yb] = P(bl.u1, 1); g.move(xa, ya); g.line(xb, yb); }
    g.stroke(withAlpha(col, 0.1 + 0.2 * k), 1);
    // the curbs' ends: one seam across every row
    if (this.lanes.length) {
      const u = CURB.U1, va = curbV(0, u) - 1, vb = curbV(this.lanes[this.lanes.length - 1]!.i, u) + CURB.DV + 1;
      const seam = () => { g.begin_(); g.move(cam.x(u, va), cam.y(u, va, CURB.Z + 2)); g.line(cam.x(u, vb), cam.y(u, vb, CURB.Z + 2)); g.line(cam.x(u, vb), cam.y(u, vb, 0)); };
      seam(); g.stroke(withAlpha(col, 0.06 + 0.18 * k), 7);
      seam(); g.stroke(withAlpha(col, a * 0.9), 1.6);
    }
    g.ops += 4 * edgesNow.length + 6;
    return false;
  }

  // ---- for the titles (labels.ts) and the lane labels --------------------------------------------
  /** The board a stage title stands over (u span, top z), null when the stage has none. */
  boardOf(stage: string): Board | null { return BOARDS.find((b) => b.stage === stage) ?? null; }
  /** A lane's road (dock → stub end → far end), null when it has none. */
  roadOf(laneId: string): Pt[] | null { return this.lanes.find((l) => l.id === laneId)?.road ?? null; }
  roadHw(laneId: string): number { return this.lanes.find((l) => l.id === laneId)?.hw ?? 0; } // w2-red: a lane's road half width (floor.ts draws a rising-red group's red road edge)
  /** The midpoint of a lane's road (half its length along it), for the lane's label. */
  roadMid(laneId: string): Pt | null {
    const r = this.roadOf(laneId);
    if (!r) return null;
    const seg = r.slice(1).map((p, i) => Math.hypot(p[0] - r[i]![0], p[1] - r[i]![1]));
    let half = seg.reduce((a, b) => a + b, 0) / 2;
    for (let i = 0; i < seg.length; i++) {
      if (half <= seg[i]!) { const t = half / (seg[i]! || 1), a = r[i]!, b = r[i + 1]!; return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]; }
      half -= seg[i]!;
    }
    return r[r.length - 1]!;
  }
}

/** A lane hue pulled most of the way to the canvas: a curb's face, so the row behind it reads as
 *  hidden where the near profile stands. */
function mixDark(hex: string): string {
  const n = parseInt(hex.slice(1, 7), 16), k = 0.18;
  const c = (sh: number) => Math.round(((n >> sh) & 255) * k + 12 * (1 - k)).toString(16).padStart(2, '0');
  return `#${c(16)}${c(8)}${c(0)}`;
}

/** fx-polish: the roads' apron, the dark band the fan runs on: the convex hull of every road's
 *  band (its half width plus a rim) and its origin mark, less the slab: the part left of it
 *  (u ≤ 0) and, when the front road reaches past the slab's front edge, the part in front (v ≥ LV,
 *  u ≥ 0). Their seams (u 0, v LV) are not edges. */
function apronOf(lanes: readonly LaneEdge[]): Pt[][] {
  const pts: Pt[] = [];
  for (const L of lanes) {
    const [p0, p1, p2] = [L.road[0]!, L.road[1]!, L.road[2]!];
    const du = p2[0] - p1[0], dv = p2[1] - p1[1], len = Math.hypot(du, dv) || 1;
    const tu = du / len, tv = dv / len, nu = -tv, nv = tu, r = L.hw + APRON.RIM, e = APRON.RIM + ORIGIN.DEPTH;
    const end: Pt = [p2[0] + tu * e, p2[1] + tv * e];
    for (const s of [-1, 1]) {
      pts.push([p1[0] + nu * r * s, p1[1] + nv * r * s], [end[0] + nu * r * s, end[1] + nv * r * s]);
      pts.push([0, p0[1] + r * s]);
    }
  }
  // the hull less the slab: its part left of the slab (u ≤ 0) and its part in front of it (v ≥ LV)
  const H = hull(pts), left = clipHalf(H, (p) => p[0]), front = clipHalf(clipHalf(H, (p) => LV - p[1]), (p) => -p[0]);
  return front.length > 2 ? [left, front] : [left];
}

/** The convex hull of floor points (Andrew's monotone chain), counter-clockwise. */
function hull(ps: Pt[]): Pt[] {
  const p = ps.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (p.length < 3) return p;
  const cross = (o: Pt, a: Pt, b: Pt) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo: Pt[] = [], up: Pt[] = [];
  for (const q of p) { while (lo.length >= 2 && cross(lo[lo.length - 2]!, lo[lo.length - 1]!, q) <= 0) lo.pop(); lo.push(q); }
  for (let i = p.length - 1; i >= 0; i--) { const q = p[i]!; while (up.length >= 2 && cross(up[up.length - 2]!, up[up.length - 1]!, q) <= 0) up.pop(); up.push(q); }
  return lo.slice(0, -1).concat(up.slice(0, -1));
}

/** A polygon clipped to the half-plane d(p) ≤ 0 (d linear: the crossing is interpolated). */
function clipHalf(poly: Pt[], d: (p: Pt) => number): Pt[] {
  const out: Pt[] = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]!, b = poly[(i + 1) % poly.length]!, da = d(a), db = d(b);
    if (da <= 0) out.push(a);
    if ((da <= 0) !== (db <= 0)) { const t = da / (da - db); out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]); }
  }
  return out;
}

/** A 24-value spark with every hour present, else null. */
function full(sp: (number | null)[] | null | undefined): Series | null {
  if (!sp || sp.length !== 24) return null;
  let n = 0;
  for (const x of sp) if (x !== null && x !== undefined) n++;
  return n >= 20 ? sp : null;
}

/** A lane's red threshold for failures an hour: the trend's (the ring's same-hour 7-d p90, else
 *  1.25 × the typical hour), else the p90 of its own 24 h; never under 2. */
function laneThreshold(m: Metric | null, key: string, fail: number[], at: number): [number, string] {
  const t = m ? threshold(m, key, 'failures', at) : null;
  if (t !== null) return [Math.max(2, Math.round(t * 10) / 10), `p90 ${Math.round(t * 10) / 10}/h`];
  const s = fail.slice().sort((a, b) => a - b);
  const p = s[Math.round(0.9 * (s.length - 1))] ?? 0;
  return [Math.max(2, p), `p90 ${Math.max(2, p)}/h (24 h)`];
}

/** Yesterday's same 24 hours of a fleet metric from the persisted ring (slot k ↔ the hour 47 − k
 *  hours back), null when the ring holds fewer than 6 of them. */
function yesterday(metric: BaseMetric, at: number): Series | null {
  const b = baseline(), h = Math.floor(at / HOUR);
  let n = 0;
  const out = Array.from({ length: 24 }, (_, k) => { const v = b.get('fleet', metric, h - (47 - k)); if (v !== null) n++; return v; });
  return n >= 6 ? out : null;
}

/** The floor quad centred on (cu, cv): ±th along the tangent (tu, tv), a → b along the normal. */
function quadAt(cam: Factory['cam'], g: Gfx, cu: number, cv: number, tu: number, tv: number, nu: number, nv: number, th: number, a: number, b: number): void {
  const c = g.ctx;
  const p = (s: number, w: number) => [cam.x(cu + tu * s + nu * w, cv + tv * s + nv * w), cam.y(cu + tu * s + nu * w, cv + tv * s + nv * w)] as const;
  let q = p(-th, a); c.moveTo(q[0], q[1]);
  q = p(th, a); c.lineTo(q[0], q[1]);
  q = p(th, b); c.lineTo(q[0], q[1]);
  q = p(-th, b); c.lineTo(q[0], q[1]);
  c.closePath();
}

/** The unit normal (left of travel) of a polyline at vertex k (the joint's bisector, scaled so
 *  the band keeps its width through the bend). */
function normalAt(pts: Pt[], k: number): Pt {
  const n = (a: Pt, b: Pt): Pt => { const du = b[0] - a[0], dv = b[1] - a[1], l = Math.hypot(du, dv) || 1; return [-dv / l, du / l]; };
  if (k === 0) return n(pts[0]!, pts[1]!);
  if (k === pts.length - 1) return n(pts[k - 1]!, pts[k]!);
  const a = n(pts[k - 1]!, pts[k]!), b = n(pts[k]!, pts[k + 1]!);
  const m: Pt = [a[0] + b[0], a[1] + b[1]], l = Math.hypot(m[0], m[1]) || 1, cos = Math.max(0.35, (m[0] * a[0] + m[1] * a[1]) / l);
  return [m[0] / l / cos, m[1] / l / cos];
}

/** A band `hw` either side of a polyline on the floor, as one closed path. */
function ribbon(cam: Factory['cam'], g: Gfx, pts: Pt[], hw: number): void {
  const n = pts.length;
  for (let k = 0; k < n; k++) { const [nu, nv] = normalAt(pts, k), p = pts[k]!; const x = cam.x(p[0] + nu * hw, p[1] + nv * hw), y = cam.y(p[0] + nu * hw, p[1] + nv * hw); if (k) g.line(x, y); else g.move(x, y); }
  for (let k = n - 1; k >= 0; k--) { const [nu, nv] = normalAt(pts, k), p = pts[k]!; g.line(cam.x(p[0] - nu * hw, p[1] - nv * hw), cam.y(p[0] - nu * hw, p[1] - nv * hw)); }
  g.ctx.closePath();
}

/** The band's two edges (open paths). */
function edges(cam: Factory['cam'], g: Gfx, pts: Pt[], hw: number): void {
  for (const s of [-1, 1]) pts.forEach((p, k) => { const [nu, nv] = normalAt(pts, k); const x = cam.x(p[0] + nu * hw * s, p[1] + nv * hw * s), y = cam.y(p[0] + nu * hw * s, p[1] + nv * hw * s); if (k) g.line(x, y); else g.move(x, y); });
}

/** fx-polish (note 11): the key's row for the lane curbs (legend.ts calls it after its grammar
 *  rows; one row, 21 px): the card grows by the row (its bottom edge redrawn lower), a small
 *  profile behind its hue chip, the word and what it says. Returns the next row's baseline. */
function legendCurbRow(g: Gfx, f: Factory, x: number, y: number, W: number, H: number, yy: number): number {
  const ROW = 21, CARD = '#111112', EDGE = '#2E2E30', hue = '#96C7D6';
  g.fillRect(x + 1, y + H - 1.5, W - 2, ROW + 1.5, withAlpha(CARD, 0.96));
  g.begin_(); g.move(x + 0.5, y + H - 1); g.line(x + 0.5, y + H + ROW - 0.5); g.line(x + W - 0.5, y + H + ROW - 0.5); g.line(x + W - 0.5, y + H - 1); g.stroke(EDGE, 1);
  f.hit(x, y + H, W, ROW, 'legendpanel', '', '');
  // the glyph: the hue chip, then a step profile in the hue, its last step red (over its p90)
  const cx = x + 34, cy = yy - 4;
  g.fillRect(cx - 16, cy - 1, 5, 6, hue);
  const st = [2, 4, 3, 6, 4, 9];
  g.begin_(); g.move(cx - 10, cy + 5);
  st.forEach((h, k) => { g.line(cx - 10 + k * 4.4, cy + 5 - h); g.line(cx - 10 + (k + 1) * 4.4, cy + 5 - h); });
  g.line(cx + 16.4, cy + 5); g.stroke(hue, 1.2);
  g.fillRect(cx + 12, cy - 4, 4.4, 3, F.redTop);
  g.runs([['curb', C.ink, true], ['  a lane\'s fails/h, 24 h', C.ink3]], x + 70, yy, 12, W - 80);
  return yy + ROW;
}

/** The front layer of a factory (labels.ts reaches it for the titles and hover lines). */
export function frontOf(f: Factory): Front | null {
  for (const L of f.order) if (L.name === 'front') return L as Front;
  return null;
}

