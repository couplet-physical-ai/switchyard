// The floor itself (fab-w0; TEAM LANES and the accordion: fab-w1, FACTORY-SPEC §B, §C, §F). The
// slab, the stage zones, every belt (a flow band: width = the last hour's throughput, slats that
// drift at a speed set by it), all the steel, and the floor's left third as GROUP LANES: each
// group (team, org, "other teams", the bots siding) is one band of v, back → front, that carries
// its hue the whole way:
//
//   dock (groupfloor.ts, W2) → its belt → its four PR cells (stacks by phase: height = open PRs,
//   a layer per 5; a red top = CI failing, a crack = conflict, an amber rim = checks, dusty
//   layers = stale) → its lintel on the shared merge gate (ticks = merges) → its own main-line
//   rail (cars = merged commits; signal posts on the back curb, one per active repo, red first,
//   height = time in state) → its stripe of the ribbon that converges into the intake.
//
// The bots siding is the front lane: pallets per bot (height = log PRs, footprint = repos
// touched, hatched; a red strap when most fail). The heat haze still glows under the stage that
// backs up.
//
// SEMANTIC ZOOM (§F). `lanes` (layout.ts LaneMap) eases every band: at fleet zoom the base lanes;
// a dock or district lens, or a zoom of 1.4–2.4 over a lane, opens the ACCORDION (the lane takes
// 45 % of v, the others shrink to 10-u stripes of posts) over 600 ms; past 2.4 the open lane
// splits into per-repo sub-rows (the 12 busiest, then "+N"): each repo's PRs as single crates in
// their phase, its post and its last 12 main-line results.

import type { Event } from '../wire.ts';
import type { World } from '../world.ts';
import { BOTS } from '../world.ts';
import type { Gfx } from '../yard/gfx.ts';
import { C, TAU, clamp, withAlpha } from '../yard/theme.ts';
import { normTeam } from '../../server/floor.ts';
import type { Factory } from './factory.ts';
import { BOTS_LANE, OTHER_LANE, floorGroups, isBot } from './groups.ts';
import { LU, LV } from './iso.ts';
import { LaneData, type Cell, type LaneCount, type LaneInfo, type LaneRepo } from './lanes.ts';
import { STAGES } from './grammar.ts';
import { GROUP_Z_IN, GROUP_Z_OUT, LANE_U, LANE_V0, LANE_V1, LaneMap, PLAN, REPO_Z_IN, REPO_Z_OUT, ROAD_DU, SIDING_DV, SUB_ROWS, WALL_Z, laneSlots } from './layout.ts';
import { R_DOOR, R_RING, beltSpeedPx, blink, flash } from './motion.ts';
import { F, box, flushLights, poly, quad, ring } from './prims.ts';
import type { FloorPass, HitBox, Layer, LiveFrame, Lens, Pt } from './types.ts';
import { phaseRow } from './census.ts';

const {
  DOCK_U0, DOCK_U1, YARD_U0, ROW_U, GATE_U, RAIL_U0, RAIL_U1, INTAKE_U0, INTAKE_U1, DIST_U, ENG_U0, ENG_U1, ENG_V0, ENG_STEP, ENG_DV,
  SCAN_U, TRACK_V, TRACK_U1, CITY_U0, CITY_U1, CITY_V0, CITY_V1, RETURN_V, VIAS,
} = PLAN;
const { CELL_DU, MERGE_U, INTAKE_V } = LANE_U;
/** The lanes' u span (dock to rail end). */
const LANE_UA = DOCK_U0 - 4, LANE_UB = RAIL_U1 + 6;
/** The back wall's boards (u spans along v = 0; layout.ts WALL_Z high), one per stage group:
 *  each the fleet's last 24 h, an hour a bar (oldest at the left). */
const BOARDS: { id: string; stage: string; u0: number; u1: number }[] = [
  { id: 'pushes', stage: '01', u0: DOCK_U0, u1: YARD_U0 - 8 },
  { id: 'opened', stage: '02', u0: YARD_U0, u1: PLAN.YARD_U1 },
  { id: 'landed', stage: '04', u0: GATE_U - 6, u1: RAIL_U1 },
  { id: 'runs', stage: '06', u0: INTAKE_U0, u1: ENG_U1 },
  { id: 'fails', stage: '07', u0: ENG_U1 + 14, u1: SCAN_U + 4 },
  { id: 'deploys', stage: '08', u0: SCAN_U + 14, u1: TRACK_U1 },
  { id: 'apps', stage: '09', u0: CITY_U0, u1: CITY_U1 },
];
const HOUR = 3_600_000;

/** A belt: its polyline, its last hour's throughput, its half width (default: from n) and where
 *  its label would sit. */
export type Belt = { id: string; pts: Pt[]; n: number; label: string; at: Pt; hw?: number; hue?: string };

/** How a lane is drawn now: its index, id, hue, its band (now) and slots; its base band (b0, b1:
 *  the docks and the approach roads stay on it, the index the accordion never moves) and slots. */
type LaneGeo = { i: number; id: string; hex: string; kind: string; v0: number; v1: number; s: ReturnType<typeof laneSlots>; b0: number; b1: number; bs: ReturnType<typeof laneSlots> };
/** Where a lane's belt jogs from its dock's band onto its open band (u). */
const JOG_U = DOCK_U1 + 14;

export class Floor implements Layer {
  readonly name = 'floor';
  /** The lanes' v (base bands, the accordion, `vmap`). */
  readonly lanes = new LaneMap();
  /** What each lane carries (cells, posts, cars, sub-rows, pallets), counted in slices. */
  readonly data = new LaneData();
  /** The lane the accordion opens (or is opening) and whether a lens pinned it. */
  focusId = '';
  private pinned = false;
  /** The semantic zoom's level by the camera (hysteresis): 0 fleet, 1 group, 2 repo. */
  level = 0;
  /** Hover lines for the hits this layer made this frame (drawer.ts asks `hoverFor`). */
  private hov = new Map<HitBox, string[]>();
  private geoAt = -1;
  private geo: LaneGeo[] = [];

  constructor(readonly f: Factory) {}

  // ---- the lanes ------------------------------------------------------------------------------

  /** True when the floor shows group lanes (a fleet with groups); else the idle floor. */
  get on(): boolean {
    const f = this.f;
    return !f.census.skeleton && f.world.loaded && floorGroups().lanes().length >= 2;
  }

  /** The static floor's key part: the bands, the lane counts, the zoom level, the focus. */
  get sig(): string { return `${this.lanes.ver}|${this.data.ver}|${this.level}|${this.focusId}|${this.on ? 1 : 0}`; }

  /** True while the accordion moves (the static floor keeps redrawing). */
  get animating(): boolean { return this.lanes.animating; }

  census(w: World): void {
    const f = this.f;
    if (this.on) {
      const ls = floorGroups().lanes();
      this.lanes.setLanes(ls.map((l) => ({ id: l.id, w: l.kind === 'bots' ? 0 : Math.sqrt(Math.max(4, l.repos)), fixed: l.kind === 'bots' ? SIDING_DV : 0 })));
      this.data.step(w, f.tl.playhead || w.at);
    } else {
      const docks = f.census.docks;
      this.lanes.setLanes(docks.map((d) => ({ id: d.org === BOTS ? BOTS_LANE : `org:${d.org}`, w: 1, fixed: d.org === BOTS ? SIDING_DV : 0 })));
    }
    this.focusStep(f.tl.clock);
    if (this.lanes.tick(f.tl.clock) || this.geoAt !== this.lanes.ver) this.relayout();
  }

  /** Lane geometry now (and the plan's RAIL_V for the org rails the lens system still reads). */
  private relayout(): void {
    const L = this.lanes, G = floorGroups(), on = this.on;
    this.geoAt = L.ver;
    this.geo = L.ids.map((id, i) => {
      const v0 = L.v0(i), v1 = L.v1(i), b0 = L.base[i]!, b1 = L.base[i + 1]!;
      const lane = on ? G.lane(id) : undefined;
      return { i, id, hex: on ? G.hex(id) : '#3A3A3E', kind: lane?.kind ?? (id === BOTS_LANE ? 'bots' : 'org'), v0, v1, s: laneSlots(v0, v1), b0, b1, bs: laneSlots(b0, b1) };
    });
    // the census's org rails (lens.ts, coffee.ts read them by index): each onto its org's lane
    const RV = PLAN.RAIL_V as number[];
    this.f.census.rails.forEach((r, k) => { if (k < RV.length) { const gi = this.laneIndex(r.org); if (gi >= 0) RV[k] = this.geo[gi]!.s.rail; } });
  }

  get lanesNow(): LaneGeo[] { if (this.geoAt !== this.lanes.ver) this.relayout(); return this.geo; }

  /** A repo id ('org/name'), an org, BOTS or a lane id → its lane's index (-1 none). */
  laneIndex(key: string): number {
    const L = this.lanes;
    if (!key) return -1;
    let i = L.index(key);
    if (i >= 0) return i;
    if (!this.on) return L.index(key === BOTS ? BOTS_LANE : `org:${key.split('/')[0]}`);
    const G = floorGroups();
    const id = key === BOTS ? BOTS_LANE : key.includes('/') ? G.laneOfRepo(key) : G.laneOfGroup(`org:${key}`);
    i = L.index(id);
    return i >= 0 ? i : L.index(OTHER_LANE);
  }

  /** The v of a repo's / an org's / the bots' dock (its lane's base middle: docks never move). */
  dockV(key: string): number {
    const i = this.laneIndex(key);
    return i >= 0 ? (this.lanes.base[i]! + this.lanes.base[i + 1]!) / 2 : (LANE_V0 + LANE_V1) / 2;
  }

  /** The v of a repo's / an org's main-line rail (its lane's rail, now). */
  railV(key: string): number {
    const i = this.laneIndex(key);
    const g = this.lanesNow[i];
    return g ? g.s.rail : INTAKE_V;
  }

  /** The v of a lane's belt. */
  beltV(key: string): number {
    const g = this.lanesNow[this.laneIndex(key)];
    return g ? g.s.belt : INTAKE_V;
  }

  // ---- the accordion (§F) ------------------------------------------------------------------------

  /** The lane a lens on top pins: a dock (org, bots) or a district (team) lens. */
  private lensLane(): string {
    const top: Lens | null = this.f.lens?.topLens ?? null;
    if (!top || !this.on) return '';
    const G = floorGroups();
    // W3's group lens (a dock, a district, a lane's rail or cells): its group's lane
    if (top.kind === 'group') { const id = G.laneOfGroup(top.id); return G.lane(id) ? id : ''; }
    if (top.kind === 'org') return top.id === BOTS ? BOTS_LANE : (G.lane(`org:${top.id}`) ? `org:${top.id}` : '');
    if (top.kind === 'district') {
      if (top.id === 'other teams') return OTHER_LANE;
      const slug = normTeam(top.id);
      const l = G.lanes().find((x) => x.kind === 'team' && (x.id === `team:${slug}` || x.short === slug));
      return l ? l.id : '';
    }
    return '';
  }

  /** The zoom level (hysteresis), the focus (a lens, else the lane under the pointer at group
   *  zoom) and the camera's flight to a pinned lane. */
  private focusStep(t: number): void {
    const cam = this.f.cam, z = cam.zoom, L = this.lanes;
    this.level = this.level === 2 ? (z < REPO_Z_OUT ? (z < GROUP_Z_OUT ? 0 : 1) : 2)
      : this.level === 1 ? (z >= REPO_Z_IN ? 2 : z < GROUP_Z_OUT ? 0 : 1)
        : z >= REPO_Z_IN ? 2 : z >= GROUP_Z_IN ? 1 : 0;
    const pin = this.lensLane();
    let want = '';
    if (pin) want = pin;
    else if (this.level >= 1 && this.on) {
      const px = this.f.px >= 0 && this.f.px <= cam.W ? this.f.px : cam.W / 2, py = this.f.py >= 0 && this.f.py <= cam.H ? this.f.py : cam.H / 2;
      const [u, v] = cam.unproject(px, py);
      const i = u >= -ROAD_DU && u < JOG_U ? L.baseLaneAt(v) : u >= JOG_U && u <= MERGE_U + 40 ? L.laneAt(v) : -1;
      const cur = !this.pinned ? L.index(this.focusId) : -1;
      if (cur >= 0) {
        // hysteresis: keep the open lane until the pointer is well inside another one
        const away = v < L.v0(cur) - 14 || v > L.v1(cur) + 14;
        want = i >= 0 && i !== cur && away ? L.ids[i]! : L.ids[cur]!;
      } else want = i >= 0 ? L.ids[i]! : '';
    }
    if (want !== this.focusId) { this.focusId = want; L.go(L.index(want), t); }
    // a pinned lane opens where the camera is (the lens's ribbon stays whole at the fit)
    this.pinned = !!pin;
  }

  // ---- events: a push leaves its group's dock along its lane's belt for its PR cells or, on main,
  // through the gate onto its lane's rail; a merge rolls from the lane's approved cell through the
  // gate onto the rail ----
  onEvent(e: Event, w: World, t: number): void {
    const R = this.f.reactions.rp;
    switch (e.k) {
      case 'push': {
        const bot = !!(e.bot || e.author?.endsWith('[bot]'));
        const key = bot ? BOTS : e.repo;
        const main = e.branch === (w.repos.get(e.repo)?.default_branch ?? 'main');
        const dv = this.dockV(key), bv = this.beltV(key), rv = this.railV(e.repo);
        const g = this.lanesNow[this.laneIndex(key)];
        const cellV = g ? (g.s.cell0 + g.s.cell1) / 2 : bv;
        const route: Pt[] = [[DOCK_U1 - 6, dv], [DOCK_U1 + 4, bv]];
        if (main && !bot) route.push([GATE_U - 6, bv], [GATE_U + 10, rv], [RAIL_U0 + 12, rv]);
        else route.push([ROW_U[1], bv], [ROW_U[1], cellV]);
        const cr = this.f.crates.spawn(`${e.repo}@${e.sha}`, 'commit', route, t, main ? 4200 : 2600, false, '', bot ? BOTS : w.orgOf(e.repo));
        R.add(R_DOOR, DOCK_U1, dv, 6, cr.t0, false, 700);
        if (main && !bot) { R.add(R_RING, GATE_U + 4, bv, 12, this.f.crates.arrives(cr, 3), false); R.add(R_RING, RAIL_U0 + 12, rv, 4, this.f.crates.arrives(cr, 4), false); }
        else R.add(R_RING, ROW_U[1], cellV, 4, this.f.crates.arrives(cr, 3), false, 900);
        break;
      }
      case 'merge': {
        const bv = this.beltV(e.repo), rv = this.railV(e.repo);
        const g = this.lanesNow[this.laneIndex(e.repo)];
        const cellV = g ? (g.s.cell0 + g.s.cell1) / 2 : bv;
        const cr = this.f.crates.spawn(`${e.repo}@${e.sha}`, 'commit', [[ROW_U[3], cellV], [ROW_U[3], bv], [GATE_U - 6, bv], [GATE_U + 10, rv], [RAIL_U0 + 60, rv]], t, 2600, false, '', w.orgOf(e.repo));
        R.add(R_RING, GATE_U + 4, bv, 12, this.f.crates.arrives(cr, 2), false);
        R.add(R_RING, RAIL_U0 + 12, rv, 4, this.f.crates.arrives(cr, 3), false);
        break;
      }
      default: break;
    }
  }

  /** A belt (a flow band) along an axis-aligned polyline, `hw` half wide. */
  private beltPath(g: Gfx, pts: Pt[], hw: number): void {
    const cam = this.f.cam;
    for (let i = 1; i < pts.length; i++) {
      const [a, b] = [pts[i - 1], pts[i]];
      const u0 = Math.min(a[0], b[0]) - (a[1] === b[1] ? 0 : hw), u1 = Math.max(a[0], b[0]) + (a[1] === b[1] ? 0 : hw);
      const v0 = Math.min(a[1], b[1]) - (a[0] === b[0] ? 0 : hw), v1 = Math.max(a[1], b[1]) + (a[0] === b[0] ? 0 : hw);
      quad(cam, g, u0, v0, u1, v1, 0.5);
    }
  }

  // ---- the plan: belts (polylines) and their last-hour throughput ------------------------------
  belts(): Belt[] {
    const c = this.f.census, f = c.flow, G = floorGroups(), on = this.on;
    const out: Belt[] = [];
    // each lane's belt: its dock → the gate, width = its pushes in the last hour (log)
    for (const g of this.lanesNow) {
      if (g.s.stripe) continue;
      const n = on ? (G.stats(g.id)?.pushes1h ?? 0) : 0;
      const hw = Math.min(g.s.beltHw, g.bs.beltHw, 1.4 + 0.7 * Math.log2(1 + n));
      const pts: Pt[] = Math.abs(g.bs.belt - g.s.belt) < 0.5 ? [[LANE_U.BELT_U0, g.s.belt], [LANE_U.BELT_U1, g.s.belt]] : [[LANE_U.BELT_U0, g.bs.belt], [JOG_U, g.bs.belt], [JOG_U, g.s.belt], [LANE_U.BELT_U1, g.s.belt]];
      out.push({ id: `lane${g.i}`, pts, n, label: '', at: [DOCK_U1 + 4, g.bs.belt], hw, hue: g.hex });
    }
    out.push({ id: 'intake', pts: [[MERGE_U, INTAKE_V], [INTAKE_U0, INTAKE_V]], n: f.enqueued, label: `${f.enqueued} queued/h`, at: [MERGE_U, INTAKE_V] });
    out.push({ id: 'feed', pts: [[INTAKE_U1, INTAKE_V], [DIST_U, INTAKE_V]], n: f.started, label: '', at: [INTAKE_U1, INTAKE_V] });
    const gv0 = ENG_V0 + ENG_DV / 2, gv1 = ENG_V0 + (c.groups.length - 1) * ENG_STEP + ENG_DV / 2;
    out.push({ id: 'dist', pts: [[DIST_U, gv0], [DIST_U, gv1]], n: f.started, label: `${f.started} started/h`, at: [DIST_U, gv0] });
    c.groups.forEach((_g, i) => {
      const v = ENG_V0 + i * ENG_STEP + ENG_DV / 2;
      out.push({ id: `out${i}`, pts: [[ENG_U1, v], [SCAN_U, v]], n: Math.round(f.finished / Math.max(1, c.groups.length)), label: '', at: [ENG_U1, v] });
    });
    VIAS.forEach((via, i) => {
      out.push({ id: `track${i}`, pts: [[SCAN_U + 10, TRACK_V[i]], [TRACK_U1, TRACK_V[i]]], n: f.byVia[via] ?? 0, label: '', at: [SCAN_U + 14, TRACK_V[i]] });
    });
    out.push({ id: 'return', pts: [[SCAN_U, RETURN_V], [24, RETURN_V]], n: f.failed, label: '', at: [SCAN_U, RETURN_V] });
    return out;
  }

  laneW(n: number): number { return 5 + Math.min(4, Math.max(1, Math.ceil(n / 25))) * 4; }
  private hwOf(b: Belt): number { return b.hw ?? this.laneW(b.n) / 2; }

  // ---- the static floor ----------------------------------------------------------------------------
  floor(fp: FloorPass): void {
    const g = fp.g, cam = this.f.cam, lo = fp.lo, add = fp.add;
    const lanes = this.lanesNow, on = this.on;
    const cnt = this.data.last;
    // the floor slab
    g.begin_(); poly(cam, g, [0, 0, 0, LU, 0, 0, LU, LV, 0, 0, LV, 0]); g.fill(F.floor);
    // a faint grid: every 20 units zoomed in, a stronger line every 100
    const step = cam.s * 20 > 9 ? 20 : 40;
    if (!lo && cam.s * 20 > 14) {
      g.begin_();
      for (let u = step; u < LU; u += step) if (u % 100) { g.move(cam.x(u, 0), cam.y(u, 0)); g.line(cam.x(u, LV), cam.y(u, LV)); }
      for (let v = step; v < LV; v += step) if (v % 100) { g.move(cam.x(0, v), cam.y(0, v)); g.line(cam.x(LU, v), cam.y(LU, v)); }
      g.stroke(F.grid, g.hair);
    }
    g.begin_();
    for (let u = 100; u < LU; u += 100) { g.move(cam.x(u, 0), cam.y(u, 0)); g.line(cam.x(u, LV), cam.y(u, LV)); }
    for (let v = 100; v < LV; v += 100) { g.move(cam.x(0, v), cam.y(0, v)); g.line(cam.x(LU, v), cam.y(LU, v)); }
    g.stroke(F.gridMajor, g.hair);
    // the slab's front lip
    g.begin_(); poly(cam, g, [0, LV, 0, LU, LV, 0, LU, LV, -6, 0, LV, -6]); g.fill('#0A0A0B');
    g.begin_(); poly(cam, g, [LU, 0, 0, LU, LV, 0, LU, LV, -6, LU, 0, -6]); g.fill('#080809');
    g.begin_(); poly(cam, g, [0, 0, 0, LU, 0, 0, LU, LV, 0, 0, LV, 0]); g.stroke(F.floorEdge, g.hair * 1.5);
    // the back wall's boards and the lanes' approach roads (off the slab: the fleet's day, and each
    // group's)
    if (on) { this.wall(g); this.roads(g, lanes); }
    // painted zones (dashed): the plant's and the city's (the lanes are their own zones)
    g.dash(true, 3, 4);
    const zones: [number, number, number, number][] = [[INTAKE_U0 - 8, 252, INTAKE_U1 + 6, 330], [ENG_U0 - 8, 22, ENG_U1 + 40, 600], [CITY_U0 - 8, CITY_V0 - 8, CITY_U1 + 4, CITY_V1 + 6]];
    g.begin_();
    for (const z of zones) quad(cam, g, z[0], z[1], z[2], z[3], 0);
    g.stroke(F.zone, g.hair * 1.5);
    g.dash(false);
    // the lanes: a faint plate in the group's hue, its back curb a line of it (a stripe: solid)
    for (const L of lanes) {
      g.begin_();
      if (Math.abs(L.b0 - L.v0) < 0.5 && Math.abs(L.b1 - L.v1) < 0.5) quad(cam, g, LANE_UA, L.v0 + 0.6, LANE_UB, L.v1 - 0.6, 0.1);
      else poly(cam, g, [LANE_UA, L.b0 + 0.6, 0.1, JOG_U - 6, L.b0 + 0.6, 0.1, JOG_U + 6, L.v0 + 0.6, 0.1, LANE_UB, L.v0 + 0.6, 0.1, LANE_UB, L.v1 - 0.6, 0.1, JOG_U + 6, L.v1 - 0.6, 0.1, JOG_U - 6, L.b1 - 0.6, 0.1, LANE_UA, L.b1 - 0.6, 0.1]);
      g.fill(withAlpha(L.hex, L.s.stripe ? 0.22 : L.kind === 'bots' ? 0.035 : 0.05));
      if (!L.s.stripe) {
        g.begin_(); g.move(cam.x(JOG_U + 6, L.v0 + 0.8), cam.y(JOG_U + 6, L.v0 + 0.8, 0.2)); g.line(cam.x(LANE_UB, L.v0 + 0.8), cam.y(LANE_UB, L.v0 + 0.8, 0.2));
        g.stroke(withAlpha(L.hex, L.kind === 'bots' || L.kind === 'other' ? 0.36 : 0.42), Math.max(1, g.hair * 1.5));
      }
    }
    // belts: one path for every belt's bed, one for their edges; a lane's belt carries its hue
    const belts = this.belts();
    g.begin_();
    for (const b of belts) this.beltPath(g, b.pts, this.hwOf(b));
    g.fill(F.belt);
    g.begin_();
    for (const b of belts) this.beltPath(g, b.pts, this.hwOf(b));
    g.stroke(F.beltEdge, g.hair * 1.5);
    if (!lo) for (const b of belts) {
      if (!b.hue) continue;
      g.begin_();
      b.pts.forEach(([u, v], k) => (k ? g.line(cam.x(u - (k === b.pts.length - 1 ? 2 : 0), v), cam.y(u - (k === b.pts.length - 1 ? 2 : 0), v, 0.6)) : g.move(cam.x(u, v), cam.y(u, v, 0.6))));
      g.stroke(withAlpha(b.hue, 0.6), Math.max(1, g.hair * 2));
    }
    // the ribbon: every lane's rail end converges into the intake, one stripe each (width = its
    // share of the jobs: running, queued, finished in the last hour)
    this.ribbon(g, lanes, on);
    // main-line rails (per lane) and deploy tracks: two rails and sleepers, every track in two paths
    const tracks: [number, number, number][] = [];
    for (const L of lanes) if (!L.s.stripe && L.kind !== 'bots') tracks.push([RAIL_U0, RAIL_U1, L.s.rail]);
    for (let i = 0; i < 3; i++) tracks.push([SCAN_U + 10, TRACK_U1, TRACK_V[i]]);
    if (!lo) {
      g.begin_();
      for (const [u0, u1, v] of tracks) for (let u = u0 + 4; u < u1; u += 8) { g.move(cam.x(u, v - 4.5), cam.y(u, v - 4.5)); g.line(cam.x(u, v + 4.5), cam.y(u, v + 4.5)); }
      g.stroke(F.sleeper, Math.max(1, cam.s * 1.6));
    }
    g.begin_();
    for (const [u0, u1, v] of tracks) {
      g.move(cam.x(u0, v - 3), cam.y(u0, v - 3)); g.line(cam.x(u1, v - 3), cam.y(u1, v - 3));
      g.move(cam.x(u0, v + 3), cam.y(u0, v + 3)); g.line(cam.x(u1, v + 3), cam.y(u1, v + 3));
    }
    g.stroke(F.rail, g.hair * 2);
    // each rail's underframe: the group's hue between its rails
    for (const L of lanes) {
      if (L.s.stripe || L.kind === 'bots') continue;
      g.begin_(); g.move(cam.x(RAIL_U0, L.s.rail), cam.y(RAIL_U0, L.s.rail, 0.3)); g.line(cam.x(RAIL_U1, L.s.rail), cam.y(RAIL_U1, L.s.rail, 0.3));
      g.stroke(withAlpha(L.hex, 0.5), Math.max(1, g.hair * 2));
    }
    // the blocks, far to near (every layer's, sorted together); each culled by its floor box
    this.f.w2.floor(g, add); // fab-w2: group docks (on the lanes' bands), embers
    if (fp.idle) return;
    const focusI = this.lanes.index(this.focusId);
    for (const L of lanes) {
      if (L.s.stripe) continue;
      const info = cnt.lanes.get(L.id);
      if (L.kind === 'bots') { this.siding(g, add, L, cnt); continue; }
      const repoLevel = L.i === focusI && this.level >= 2 && L.v1 - L.v0 > 120;
      if (repoLevel) { this.subRows(g, add, L, info); continue; }
      const bays = L.i === focusI && L.v1 - L.v0 > 90;
      for (let r = 0; r < 4; r++) {
        const C = info?.cells[r];
        const u0 = ROW_U[r] - CELL_DU / 2;
        const hgt = C ? stackH(C.n) : 2;
        add(u0, L.s.cell0, () => (bays && C ? this.ageBays(g, u0, L, C) : this.stack(g, u0, L.s.cell0, CELL_DU, L.s.cell1 - L.s.cell0, C, L.hex, lo)), u0 + CELL_DU, L.s.cell1, hgt);
      }
    }
    // the posts: one per active repo on each lane's back curb, red first
    for (const L of lanes) {
      const info = cnt.lanes.get(L.id);
      if (!info?.posts.length) continue;
      add(RAIL_U0, L.s.curb - 1.5, () => this.posts(g, L, info, lo), RAIL_U1, L.s.curb + 1.5, 18);
    }
    // the merge gate: a low gantry over every lane, a lintel per lane in its hue, ticks = merges
    add(GATE_U, LANE_V0, () => this.gate(g, lanes, cnt), GATE_U + 8, LANE_V1, 26);
    // the main lines' cars: they change at a merge or a run's end, which redraws this layer
    fp.after(() => this.drawCars(g, lo));
  }

  /** The back wall along v = 0: a board per stage, its last 24 h as bars (an hour each, the
   *  oldest at the left; red = of them failed). Apps: a bar per district (height = its apps, red =
   *  down). One path per colour. */
  private wall(g: Gfx): void {
    const cam = this.f.cam, W = this.data.last.wall, c = this.f.census, w = this.f.world;
    const z0 = 5, z1 = WALL_Z - 6;
    const gray: number[] = [], red: number[] = [], ok: number[] = [];
    for (const b of BOARDS) {
      // the board: a dark plate on the wall's face, its top edge lit
      g.begin_(); poly(cam, g, [b.u0, 0, 0, b.u1, 0, 0, b.u1, 0, WALL_Z, b.u0, 0, WALL_Z]); g.fill('#121214');
      g.begin_(); g.move(cam.x(b.u0, 0), cam.y(b.u0, 0, WALL_Z)); g.line(cam.x(b.u1, 0), cam.y(b.u1, 0, WALL_Z)); g.stroke('#3A3A3E', Math.max(1, g.hair * 1.4));
      if (b.id === 'apps') {
        const ds = c.districts, tot = ds.reduce((a, d) => a + d.apps.length, 0) || 1, mx = Math.max(1, ...ds.map((d) => d.apps.length));
        let u = b.u0 + 4;
        const span = b.u1 - b.u0 - 8;
        for (const d of ds) {
          const du = (span * d.apps.length) / tot, um = u + du / 2;
          const h = (z1 - z0) * Math.sqrt(d.apps.length / mx);
          let down = 0;
          for (const id of d.apps) if (w.apps.get(id)?.health === 'down') down++;
          const hr = h * (down / Math.max(1, d.apps.length));
          ok.push(um, z0, z0 + h - hr, Math.max(1, du - 3));
          if (hr > 0) red.push(um, z0 + h - hr, z0 + h, Math.max(1, du - 3));
          u += du;
        }
        continue;
      }
      const [all, bad] = b.id === 'pushes' ? [W.pushes, null] : b.id === 'opened' ? [W.opened, W.openedRed] : b.id === 'landed' ? [W.landed, W.landedRed] : b.id === 'runs' ? [W.runs, null] : b.id === 'fails' ? [W.runsRed, W.runsRed] : [W.deploys, W.deploysRed];
      let mx = 1;
      for (let k = 0; k < 24; k++) mx = Math.max(mx, all[k]!);
      const pitch = (b.u1 - b.u0 - 6) / 24, bw = Math.max(1, pitch * 0.62);
      for (let k = 0; k < 24; k++) {
        const n = all[k]!;
        if (!n) continue;
        const u = b.u0 + 3 + (k + 0.5) * pitch;
        const h = (z1 - z0) * Math.sqrt(n / mx), r = bad ? h * (bad[k]! / n) : 0;
        if (h - r > 0.2) gray.push(u, z0, z0 + h - r, bw);
        if (r > 0) red.push(u, z0 + h - r, z0 + h, bw);
      }
    }
    const bars = (a: number[], col: string) => {
      if (!a.length) return;
      // bars of one width per board would be one path each; widths differ little: per bar
      for (let i = 0; i < a.length; i += 4) {
        const u = a[i]!, za = a[i + 1]!, zb = a[i + 2]!, bw = a[i + 3]!;
        g.begin_(); poly(cam, g, [u - bw / 2, 0, za, u + bw / 2, 0, za, u + bw / 2, 0, zb, u - bw / 2, 0, zb]); g.fill(col);
      }
    };
    bars(gray, '#4E4E53'); bars(ok, withAlpha(C.up, 0.55)); bars(red, F.redTop);
  }

  /** The lanes' approach roads, off the slab to the left of the docks: each group's last 24 h
   *  along its road (oldest far out, this hour at the dock), a bar an hour as tall as its pushes,
   *  topped in its hue, red for its main-line runs that failed. */
  private roads(g: Gfx, lanes: LaneGeo[]): void {
    const cam = this.f.cam, cnt = this.data.last;
    const u0 = -ROAD_DU, u1 = LANE_UA - 1;
    let mx = 1;
    for (const L of lanes) { const i = cnt.lanes.get(L.id); if (i) for (let k = 0; k < 24; k++) mx = Math.max(mx, i.push24[k]!); }
    const pitch = (u1 - u0 - 6) / 24;
    for (const L of lanes) {
      // the road: a plate in the lane's hue, on its base band (the accordion leaves it be)
      const b0 = L.b0, b1 = L.b1;
      g.begin_(); quad(cam, g, u0, b0 + 0.8, u1, b1 - 0.8, 0); g.fill(withAlpha(L.hex, 0.07));
      if (L.kind === 'bots') continue;
      g.begin_(); g.move(cam.x(u0, b0 + 0.8), cam.y(u0, b0 + 0.8)); g.line(cam.x(u1, b0 + 0.8), cam.y(u1, b0 + 0.8)); g.stroke(withAlpha(L.hex, 0.3), Math.max(1, g.hair * 1.2));
      const info = cnt.lanes.get(L.id);
      if (!info) continue;
      const v = (b0 + b1) / 2, dv = Math.min(10, (b1 - b0) * 0.36), bu = Math.max(1.2, pitch * 0.6);
      const zMax = Math.min(26, (b1 - b0) * 0.8);
      for (let k = 0; k < 24; k++) {
        const n = info.push24[k]!, bad = info.fail24[k]!;
        if (!n && !bad) continue;
        const u = u0 + 3 + (k + 0.5) * pitch;
        const h = n ? 1.5 + zMax * Math.sqrt(n / mx) : 0, r = bad ? Math.min(zMax, 2 + 2.5 * bad) : 0;
        if (h) box(cam, g, u - bu / 2, v - dv / 2, bu, dv, h, withAlpha(L.hex, 0.95), '#2A2A2E', '#333337', '');
        if (r) box(cam, g, u - bu / 2, v - dv / 2, bu, dv / 3, h + r, F.redTop, F.redSide, F.redFront, '');
      }
    }
  }

  /** The ribbon of group stripes from the rails' ends into the intake. */
  private ribbon(g: Gfx, lanes: LaneGeo[], on: boolean): void {
    const cam = this.f.cam, G = floorGroups();
    const share = lanes.map((L) => {
      if (!on) return 1;
      const s = G.stats(L.id);
      return s ? s.running + s.queued + s.finished1h : 0;
    });
    const tot = share.reduce((a, b) => a + b, 0);
    const W = 12;
    let off = -W / 2;
    lanes.forEach((L, i) => {
      const w = tot > 0 ? (W * share[i]!) / tot : W / lanes.length;
      if (w <= 0.05) return;
      const v = INTAKE_V + off + w / 2;
      off += w;
      const v0 = L.s.stripe || L.kind === 'bots' ? (L.v0 + L.v1) / 2 : L.s.rail;
      g.begin_();
      g.move(cam.x(RAIL_U1, v0), cam.y(RAIL_U1, v0, 0.4));
      g.line(cam.x(MERGE_U, v), cam.y(MERGE_U, v, 0.4));
      g.line(cam.x(INTAKE_U0, v), cam.y(INTAKE_U0, v, 0.4));
      g.stroke(withAlpha(L.hex, L.kind === 'bots' ? 0.4 : 0.55), Math.max(1, w * cam.s * 0.85));
    });
  }

  /** A PR stack: a cell plate with the group's base stripe; on it the open PRs (a layer per 5),
   *  stale layers dusty at the bottom, a red band on top for CI failing, a crack for conflicts, an
   *  amber rim while most wait on checks. */
  private stack(g: Gfx, u0: number, v0: number, du: number, dv: number, C: Cell | undefined, hex: string, lo: boolean): void {
    const cam = this.f.cam;
    if (dv < 4) return;
    box(cam, g, u0 + 2, v0, du - 4, dv, 1.2, '#161618', '#111113', '#0F0F11', '#232326');
    g.begin_(); quad(cam, g, u0 + 2, v0 + dv - 1.6, u0 + du - 2, v0 + dv, 1.25); g.fill(withAlpha(hex, 0.9));
    if (!C || !C.n) return;
    const layers = Math.min(16, Math.ceil(C.n / 5));
    const lh = 2.4, inset = Math.min(5, dv * 0.18);
    const ua = u0 + 2 + inset, ub = u0 + du - 2 - inset, va = v0 + inset * 0.6, vb = v0 + dv - inset;
    const dusty = Math.min(layers, Math.round((layers * C.stale) / C.n));
    const amber = C.checks >= C.n / 2;
    const edge = amber ? '#B48C4E' : '#3E3E43';
    const h0 = 1.2;
    if (dusty) box(cam, g, ua, va, ub - ua, vb - va, dusty * lh, '#3A3936', '#26251F', '#211F1B', '#4A4840');
    const fresh = layers - dusty;
    if (fresh) {
      // the fresh layers stand on the dusty ones
      const z0 = h0 + dusty * lh;
      g.begin_(); poly(cam, g, [ua, vb, z0, ub, vb, z0, ub, vb, z0 + fresh * lh, ua, vb, z0 + fresh * lh]); g.fill('#1D1D20');
      g.begin_(); poly(cam, g, [ub, va, z0, ub, vb, z0, ub, vb, z0 + fresh * lh, ub, va, z0 + fresh * lh]); g.fill('#18181B');
      g.begin_(); quad(cam, g, ua, va, ub, vb, z0 + fresh * lh); g.fill('#2C2C30');
    }
    const top = h0 + layers * lh;
    g.begin_(); quad(cam, g, ua, va, ub, vb, top); g.stroke(edge, g.hair * (amber ? 1.6 : 1));
    if (!lo && layers > 1) {
      g.begin_();
      for (let k = 1; k < layers; k++) { const z = h0 + k * lh; g.move(cam.x(ua, vb), cam.y(ua, vb, z)); g.line(cam.x(ub, vb), cam.y(ub, vb, z)); g.line(cam.x(ub, va), cam.y(ub, va, z)); }
      g.stroke(withAlpha('#4A4A50', 0.5), g.hair);
    }
    // CI failing: a red band across the top, as deep as its share (all red: the whole top)
    if (C.red) {
      const k = clamp(C.red / C.n, 0.18, 1);
      g.begin_(); quad(cam, g, ua, vb - (vb - va) * k, ub, vb, top + 0.05); g.fill(C.red / C.n >= 0.5 ? F.redTop : withAlpha(F.redTop, 0.85));
    }
    // a conflict: a crack down the front face
    if (C.conflict) {
      const n = Math.min(3, C.conflict);
      g.begin_();
      for (let j = 0; j < n; j++) {
        const u = ua + ((ub - ua) * (j + 1)) / (n + 1);
        g.move(cam.x(u, vb), cam.y(u, vb, top)); g.line(cam.x(u + 1.2, vb), cam.y(u + 1.2, vb, top * 0.66)); g.line(cam.x(u - 0.8, vb), cam.y(u - 0.8, vb, top * 0.36)); g.line(cam.x(u + 0.6, vb), cam.y(u + 0.6, vb, h0));
      }
      g.stroke('#E3858C', Math.max(1, g.hair * 1.3));
    }
    if (C.n > 80) { g.begin_(); quad(cam, g, ua + 3, va + 2, ub - 3, vb - 2, top); g.stroke(edge, g.hair * 1.5); }
  }

  /** Group zoom: a cell split into age bays (newest at the back, the oldest in front, where it
   *  shows), each a stack of its own. */
  private ageBays(g: Gfx, u0: number, L: LaneGeo, C: Cell): void {
    const cam = this.f.cam;
    const v0 = L.s.cell0, v1 = L.s.cell1, n = C.ages.length;
    box(cam, g, u0 + 2, v0, CELL_DU - 4, v1 - v0, 1.2, '#161618', '#111113', '#0F0F11', '#232326');
    g.begin_(); quad(cam, g, u0 + 2, v1 - 1.6, u0 + CELL_DU - 2, v1, 1.25); g.fill(withAlpha(L.hex, 0.9));
    const bay = (v1 - v0 - 2) / n;
    for (let b = 0; b < n; b++) {
      const k = C.ages[b]!;
      if (!k) continue;
      const vb = v0 + 1 + b * bay;
      const layers = Math.min(16, Math.ceil(k / 2));
      const old = b >= 4;
      box(cam, g, u0 + 6, vb + 1, CELL_DU - 12, bay - 2, 1.2 + layers * 1.6, old ? '#3A3936' : '#2C2C30', old ? '#26251F' : '#18181B', old ? '#211F1B' : '#1D1D20', old ? '#4A4840' : '#3E3E43');
    }
    if (C.red) {
      const top = 1.2 + Math.min(16, Math.ceil(Math.max(...C.ages) / 2)) * 1.6;
      void top;
    }
  }

  /** Repo level: the open lane's per-repo sub-rows (the 12 busiest), each repo's PRs as single
   *  crates in their phase cells, red when CI fails. */
  private subRows(g: Gfx, add: FloorPass['add'], L: LaneGeo, info: LaneInfo | undefined): void {
    const cam = this.f.cam;
    if (!info) return;
    const rows = this.rowsOf(L, info);
    for (const r of rows) {
      add(ROW_U[0] - CELL_DU / 2, r.v0, () => {
        g.begin_(); g.move(cam.x(DOCK_U1 + 2, r.v0), cam.y(DOCK_U1 + 2, r.v0, 0.2)); g.line(cam.x(RAIL_U1, r.v0), cam.y(RAIL_U1, r.v0, 0.2));
        g.stroke(withAlpha(L.hex, 0.22), g.hair);
        if (!r.repo) return;
        const lr = r.repo;
        for (let p = 0; p < 4; p++) {
          const n = lr.prs[p];
          if (!n) continue;
          const u0 = ROW_U[p] - CELL_DU / 2 + 6, k = Math.min(n, 6);
          const reds = Math.min(k, p === 1 || p === 2 ? lr.red : 0);
          for (let j = 0; j < k; j++) {
            const red = j < reds;
            box(cam, g, u0 + j * 6.4, r.v0 + 3, 5, Math.min(6, r.v1 - r.v0 - 5), 3.6, red ? F.redTop : '#55555A', red ? F.redSide : '#36363A', red ? F.redFront : '#2E2E32', red ? '#E08088' : '#6A6A70', g.hair);
          }
        }
        // the main line, oldest → newest: a dot per run (red failing, amber running, gray ok)
        const mid = (r.v0 + r.v1) / 2;
        lr.dots.forEach((d, j) => {
          const u = RAIL_U0 + 14 + j * 13;
          const red = d.state === 'failure' || d.state === 'error', run = d.state === 'running' || d.state === 'pending';
          box(cam, g, u - 2.5, mid - 2.5, 5, 5, d.culprit ? 5 : 3, red ? F.redTop : run ? F.crateTop : '#6E6A62', red ? F.redSide : run ? F.crateSide : '#4A4844', red ? F.redFront : run ? F.crateFront : '#3E3C38', '', g.hair);
        });
      }, RAIL_U1, r.v1, 6);
    }
  }

  /** The open lane's sub-rows (v bands): the busiest 12 repos, then the "+N" row. */
  rowsOf(L: LaneGeo, info: LaneInfo): { v0: number; v1: number; repo: LaneRepo | null; more: number }[] {
    const top = L.s.rail + 7, bot = L.s.cell1;
    const n = Math.min(SUB_ROWS, info.repos.length);
    const more = info.repos.length - n;
    const k = n + (more > 0 ? 1 : 0);
    if (k <= 0 || bot - top < 20) return [];
    const h = (bot - top) / k;
    const out: { v0: number; v1: number; repo: LaneRepo | null; more: number }[] = [];
    for (let j = 0; j < n; j++) out.push({ v0: top + j * h, v1: top + (j + 1) * h, repo: info.repos[j]!, more: 0 });
    if (more > 0) out.push({ v0: top + n * h, v1: bot, repo: null, more });
    return out;
  }

  /** The bots siding: a pallet per bot (height = log PRs, footprint = repos touched), hatched; a
   *  red strap when most of its PRs fail CI. */
  private siding(g: Gfx, add: FloorPass['add'], L: LaneGeo, cnt: LaneCount): void {
    const cam = this.f.cam;
    let u = YARD_U0 + 8;
    const v0 = L.v0 + 5, v1 = L.v1 - 4;
    for (const p of cnt.pallets) {
      const du = Math.min(84, 22 + 9 * Math.sqrt(p.repos));
      const h = Math.min(28, 3 + 4.2 * Math.log2(1 + p.n));
      const u0 = u;
      add(u0, v0, () => {
        box(cam, g, u0, v0, du, v1 - v0, 2, '#1C1A16', '#141310', '#12110E', '#3A352B');
        box(cam, g, u0 + 3, v0 + 3, du - 6, v1 - v0 - 6, h, '#3A3A3E', '#26262A', '#202023', '#55555A');
        // shape = kind: hatched like the bots' dock
        const ctx = g.ctx;
        ctx.save();
        g.begin_(); quad(cam, g, u0 + 3, v0 + 3, u0 + du - 3, v1 - 3, h); ctx.clip();
        g.begin_();
        for (let k = -(v1 - v0); k < du; k += 4) { g.move(cam.x(u0 + k, v0), cam.y(u0 + k, v0, h)); g.line(cam.x(u0 + k + (v1 - v0), v1), cam.y(u0 + k + (v1 - v0), v1, h)); }
        g.stroke(withAlpha('#0C0C0E', 0.6), Math.max(1, g.hair * 1.6));
        ctx.restore();
        g.ops += 2;
        if (p.red > p.n / 2) { g.begin_(); quad(cam, g, u0 + du / 2 - 2.5, v0 + 3, u0 + du / 2 + 2.5, v1 - 3, h + 0.1); g.fill(F.redTop); }
        if (p.stale > p.n / 2) { g.begin_(); quad(cam, g, u0 + 3, v0 + 3, u0 + du - 3, v1 - 3, h + 0.05); g.fill(withAlpha('#8A8678', 0.18)); }
      }, u0 + du, v1, h);
      u += du + 10;
    }
  }

  /** Posts on a lane's back curb: one per active repo, red first. A red post is a red cube on a
   *  stem as tall as its time in state (log); running amber; ok a small green-gray lamp. */
  private posts(g: Gfx, L: LaneGeo, info: LaneInfo, lo: boolean): void {
    const cam = this.f.cam, now = this.f.tl.playhead;
    const span = RAIL_U1 - RAIL_U0 - 8;
    const max = Math.floor(span / 3.6);
    const list = info.posts.length > max ? info.posts.slice(0, max) : info.posts;
    const pitch = Math.min(7, span / Math.max(1, list.length));
    const v = L.s.curb;
    const stems = new Path(), red = this.f.bC, run = this.f.bB;
    const okLamps: number[] = [], unk: number[] = [];
    list.forEach((p, j) => {
      const u = RAIL_U0 + 4 + j * pitch;
      if (p.st === 0) {
        const h = Math.min(14, 4 + 2.4 * Math.log2(1 + Math.max(0, now - p.since) / HOUR));
        stems.add(u, v, h);
        red.add(u - 1.6, v - 1.6, 3.2, 3.2, 2.6, h);
      } else if (p.st === 1) { stems.add(u, v, 4); run.add(u - 1.3, v - 1.3, 2.6, 2.6, 2.2, 4); }
      else if (p.st === 2) okLamps.push(u, v);
      else unk.push(u, v);
    });
    if (stems.n) {
      g.begin_();
      for (let k = 0; k < stems.n; k++) { const [u, vv, h] = stems.at(k); g.move(cam.x(u, vv), cam.y(u, vv, 0)); g.line(cam.x(u, vv), cam.y(u, vv, h)); }
      g.stroke('#6A4A4C', Math.max(1, g.hair * 1.5));
    }
    const r = Math.max(1.1, 1.25 * cam.s);
    if (okLamps.length) {
      g.begin_();
      for (let k = 0; k < okLamps.length; k += 2) { const x = cam.x(okLamps[k]!, okLamps[k + 1]!), y = cam.y(okLamps[k]!, okLamps[k + 1]!, 1); g.ctx.moveTo(x + r, y); g.ctx.arc(x, y, r, 0, TAU); }
      g.ops += okLamps.length; g.fill(withAlpha(C.up, 0.95));
    }
    if (unk.length && !lo) {
      g.begin_();
      for (let k = 0; k < unk.length; k += 2) { const x = cam.x(unk[k]!, unk[k + 1]!), y = cam.y(unk[k]!, unk[k + 1]!, 1); g.ctx.moveTo(x + r, y); g.ctx.arc(x, y, r, 0, TAU); }
      g.ops += unk.length; g.stroke('#55555A', 1);
    }
    run.flush(g, cam, F.crateTop, F.crateSide, F.crateFront, '', g.hair, 3);
    red.flush(g, cam, F.redTop, F.redSide, F.redFront, lo ? '' : '#F08A90', g.hair, 3);
  }

  /** The merge gate: a low gantry over every lane; each lane's lintel in its hue, a tick per merge
   *  in the last 24 h (≤ 12; the last hour's bright). */
  private gate(g: Gfx, lanes: LaneGeo[], cnt: LaneCount): void {
    const cam = this.f.cam;
    const z0 = 20, z1 = 24, u0 = GATE_U, u1 = GATE_U + 6;
    box(cam, g, u0, LANE_V0 - 4, u1 - u0, 6, z1, F.topHi, F.side, F.front, F.edgeHi);
    box(cam, g, u0, LANE_V1 - 2, u1 - u0, 6, z1, F.topHi, F.side, F.front, F.edgeHi);
    // the beam
    g.begin_(); poly(cam, g, [u1, LANE_V0, z0, u1, LANE_V1, z0, u1, LANE_V1, z1, u1, LANE_V0, z1]); g.fill('#1A1A1D');
    g.begin_(); quad(cam, g, u0, LANE_V0, u1, LANE_V1, z1); g.fill('#26262A');
    for (const L of lanes) {
      const a = L.v0 + 0.8, b = L.v1 - 0.8;
      // the lintel: the lane's hue on the beam's face
      g.begin_(); poly(cam, g, [u1, a, z0 + 0.4, u1, b, z0 + 0.4, u1, b, z1 - 0.4, u1, a, z1 - 0.4]); g.fill(withAlpha(L.hex, L.s.stripe ? 0.55 : 0.8));
      const info = cnt.lanes.get(L.id);
      const m = Math.min(12, info?.merges24 ?? 0);
      if (!m || L.s.stripe) continue;
      const hot = Math.min(m, info?.merges1h ?? 0);
      g.begin_();
      for (let k = 0; k < m; k++) { const v = b - 1.2 - k * Math.min(2.6, (b - a - 2) / 12); g.move(cam.x(u0 + 0.5, v), cam.y(u0 + 0.5, v, z1)); g.line(cam.x(u1 - 0.5, v), cam.y(u1 - 0.5, v, z1)); if (k + 1 === hot) { g.stroke(C.ink, Math.max(1, g.hair * 1.4)); g.begin_(); } }
      g.stroke(withAlpha(C.ink, 0.45), Math.max(1, g.hair * 1.2));
    }
    g.begin_(); quad(cam, g, u0, LANE_V0, u1, LANE_V1, z1); g.stroke(F.edgeHi, g.hair);
  }

  /** Each lane's cars: its newest merged commits, newest at the right; one path per face and state
   *  (settled gray, running amber, red culprit), edges only zoomed in. */
  private drawCars(g: Gfx, lo: boolean): void {
    const cam = this.f.cam, cnt = this.data.last;
    const carG = this.f.bA, carA = this.f.bB, carR = this.f.bC;
    let cars = 0;
    const focusI = this.lanes.index(this.focusId);
    for (const L of this.lanesNow) {
      if (L.s.stripe || L.kind === 'bots' || (L.i === focusI && this.level >= 2)) continue;
      const list = cnt.lanes.get(L.id)?.cars ?? [];
      const n = list.length, v = L.s.rail;
      list.forEach((car, k) => {
        const u = RAIL_U1 - 12 - (n - 1 - k) * 10;
        if (u < RAIL_U0 + 4) return;
        const x = cam.x(u, v), y = cam.y(u, v);
        if (x < -24 || x > cam.W + 24 || y < -24 || y > cam.H + 24) return;
        const run = car.state === 'running' || car.state === 'pending';
        (car.culprit ? carR : run ? carA : carG).add(u - 4, v - 3.5, 8, 7, car.culprit ? 7.5 : 5);
        cars++;
      });
    }
    const carPx = 8 * cam.s;
    const edge = !lo && carPx >= 6;
    carG.flush(g, cam, '#6E6A62', '#4A4844', '#3E3C38', edge ? '#8A867E' : '', g.hair, 3);
    carA.flush(g, cam, F.crateTop, F.crateSide, F.crateFront, edge ? '#F0CC8A' : '', g.hair, 3);
    carR.flush(g, cam, F.redTop, F.redSide, F.redFront, edge ? '#E08088' : '', g.hair, 3);
    this.f.stat.cars = cars;
  }

  // ---- hits: the lanes' cells, posts, rails and the gate (hover lines for drawer.ts) -------------
  hits(fr: LiveFrame): void {
    this.hov.clear();
    if (!this.on) return;
    void fr;
    const f = this.f, cam = f.cam, cnt = this.data.last, G = floorGroups(), c = f.census;
    const focusI = this.lanes.index(this.focusId);
    const rect = (u0: number, v0: number, u1: number, v1: number, h: number): [number, number, number, number] => {
      const x0 = cam.x(u0, v1), x1 = cam.x(u1, v0), y0 = cam.y(u0, v0, h), y1 = cam.y(u1, v1, 0);
      return [x0, y0, x1 - x0, y1 - y0];
    };
    const push = (r: [number, number, number, number], kind: string, id: string, label: string, lines: string[]) => {
      const before = f.fx.hits.length;
      f.hit(r[0], r[1], r[2], r[3], kind, id, label);
      const h = f.fx.hits[f.fx.hits.length - 1];
      if (f.fx.hits.length > before && h) this.hov.set(h, lines);
    };
    // a long band along u, in ≤ 40-u pieces (a slanted band's bounding box would claim its neighbours)
    const band = (u0: number, v0: number, u1: number, v1: number, h: number, kind: string, id: string, label: string, lines: string[]) => {
      for (let u = u0; u < u1 - 0.5; u += 40) push(rect(u, v0, Math.min(u1, u + 40), v1, h), kind, id, label, lines);
    };
    // the group lens a lane's things open: an org's dock, a team's district, the bots' dock
    const lensOf = (L: LaneGeo): [string, string, string] => {
      const lane = G.lane(L.id);
      if (!lane) return ['', '', ''];
      if (lane.kind === 'org') return ['dock', L.id.slice(4), `${lane.short} dock`];
      if (lane.kind === 'bots') return ['dock', BOTS, 'bots dock'];
      const team = lane.kind === 'other' ? c.districts.find((d) => d.team === 'other teams') : c.districts.find((d) => normTeam(d.team) === L.id.slice(5));
      return team ? ['district', team.team, `${team.team} ${team.apps.length}`] : ['', '', ''];
    };
    const PH = ['draft', 'checks', 'review', 'approved'];
    for (const L of this.lanesNow) {
      const info = cnt.lanes.get(L.id);
      const lane = G.lane(L.id);
      const name = lane?.short ?? L.id;
      const [k, id, label] = lensOf(L);
      if (L.s.stripe) {
        if (k) band(JOG_U, L.v0, RAIL_U1, L.v1, 2, k, id, label, [name, `${info?.red ?? 0} red · ${info?.posts.length ?? 0} active repos`, 'zoom or click: open the lane']);
        continue;
      }
      // the rail (a group lens) and the posts (a repo each: its main's newest commit)
      if (L.kind !== 'bots' && k) band(RAIL_U0, L.s.rail - 5, RAIL_U1, L.s.rail + 5, 6, k, id, label, [`${name} main lines`, `${info?.red ?? 0} red · ${info?.merges1h ?? 0} merged/h · ${info?.cars.length ?? 0} merges 24 h`, 'click: the group across the floor']);
      if (info?.posts.length) {
        const span = RAIL_U1 - RAIL_U0 - 8, max = Math.floor(span / 3.6);
        const list = info.posts.slice(0, max);
        const pitch = Math.min(7, span / Math.max(1, list.length));
        const tgt = Math.max(1, pitch * cam.s);
        list.forEach((p, j) => {
          if (!p.head) return;
          const u = RAIL_U0 + 4 + j * pitch, v = L.s.curb;
          const x = cam.x(u, v), y = cam.y(u, v, p.st === 0 ? 8 : 3);
          const st = ['red', 'running', 'ok', 'unknown'][p.st];
          push([x - tgt / 2, y - 7, tgt, 12], 'commit', `${p.repo}@${p.head}`, `${p.name} · ${st}`, [p.name, `main ${st}${p.st === 0 && p.since ? ` · ${ago(f.tl.playhead - p.since)}` : ''}`, 'click: its main line']);
        });
      }
      if (L.kind === 'bots') {
        let u = YARD_U0 + 8;
        for (const p of cnt.pallets) {
          const du = Math.min(84, 22 + 9 * Math.sqrt(p.repos));
          push(rect(u, L.v0 + 5, u + du, L.v1 - 4, Math.min(28, 3 + 4.2 * Math.log2(1 + p.n))), 'pallet', p.bot, `${p.bot} ${p.n}`, [`${p.bot}`, `${p.n} PRs in ${p.repos} repos`, `${p.stale} stale · ${p.red} failing CI`]);
          u += du + 10;
        }
        continue;
      }
      // the cells: the group's lens; hover tells the cell
      if (!info || !k) continue;
      if (L.i === focusI && this.level >= 2) {
        for (const r of this.rowsOf(L, info)) {
          if (!r.repo) continue;
          const lr = r.repo;
          band(ROW_U[0] - CELL_DU / 2, r.v0, RAIL_U1, r.v1, 4, 'commit', `${lr.repo}@${lr.post.head}`, `${lr.name}`, [lr.name, `${lr.prs.reduce((a, b) => a + b, 0)} open PRs (${lr.prs.join(' · ')})${lr.red ? ` · ${lr.red} failing` : ''}`, `main ${['red', 'running', 'ok', 'unknown'][lr.post.st]}`]);
        }
        continue;
      }
      for (let r = 0; r < 4; r++) {
        const C = info.cells[r];
        const u0 = ROW_U[r] - CELL_DU / 2;
        push(rect(u0, L.s.cell0, u0 + CELL_DU, L.s.cell1, stackH(C.n)), k, id, label, [`${name} · ${PH[r]}`, `${C.n} open PRs${C.red ? ` · ${C.red} failing CI` : ''}${C.conflict ? ` · ${C.conflict} conflicted` : ''}`, `${C.stale} stale${C.oldest ? ` · oldest ${ago(C.oldest)}` : ''}`]);
      }
    }
    // the back wall's boards (the stage's numbers on hover, its day as the chart) and the roads
    const sum = (a: Int16Array) => a.reduce((x, y) => x + y, 0);
    for (const b of BOARDS) {
      const st = STAGES.find((x) => x.n === b.stage);
      if (!st) continue;
      const lines = f.words.stageHover(b.stage);
      for (let ua = b.u0; ua < b.u1; ua += 40) {
        const ub = Math.min(b.u1, ua + 40);
        const x0 = cam.x(ua, 0), x1 = cam.x(ub, 0), y0 = Math.min(cam.y(ua, 0, WALL_Z), cam.y(ub, 0, WALL_Z)), y1 = Math.max(cam.y(ua, 0, 0), cam.y(ub, 0, 0));
        push([x0, y0, x1 - x0, y1 - y0], 'stage', f.words.stageFly(b.stage), st.title, lines);
      }
    }
    for (const L of this.lanesNow) {
      const info = cnt.lanes.get(L.id);
      const [k, id, label] = lensOf(L);
      if (!info || !k) continue;
      const name = G.lane(L.id)?.short ?? L.id;
      band(-ROAD_DU, L.b0, LANE_UA, L.b1, 12, k, id, label, [`${name} · the last 24 h`, `${sum(info.push24)} pushes · ${sum(info.fail24)} failed on main`, 'click: the group across the floor']);
    }
    // for drivers (the evidence shots), once per layout at the fit: each lane's dock, cells and road
    const lk = `${cam.key}|${this.lanes.ver}|${this.data.ver}`;
    if (cam.zoom === 1 && !this.focusId && lk !== this.loggedLanes) {
      this.loggedLanes = lk;
      const pt = (u: number, v: number, z = 0) => [Math.round(cam.x(u, v)), Math.round(cam.y(u, v, z))];
      console.log(`factory-lanes: ${JSON.stringify(this.lanesNow.map((L) => ({ id: L.id, dock: pt((DOCK_U0 + DOCK_U1) / 2, (L.b0 + L.b1) / 2, 6), cell: pt(ROW_U[1], (L.s.cell0 + L.s.cell1) / 2), road: pt(-ROAD_DU / 2, (L.v0 + L.v1) / 2) })))}`);
    }
    // the gate: one hit along it, in pieces
    for (let v = LANE_V0; v < LANE_V1; v += 40) push(rect(GATE_U - 2, v, GATE_U + 8, Math.min(LANE_V1, v + 40), 24), 'gate', 'gate', 'merge gate', ['merge gate', `${c.flow.merges} merged/h`, 'click: 24 h of merges']);
  }

  private loggedLanes = '';

  /** The hover card's lines for a hit this layer made (null: not ours). */
  hoverFor(h: HitBox): string[] | null { return this.hov.get(h) ?? null; }

  // ---- the live layer: the haze, the belts' slats, the cars' hits, lamps and the culprit ----
  live(g: Gfx, fr: LiveFrame): void {
    const cam = this.f.cam, c = this.f.census, ctx = fr.ctx, t = fr.t, q = fr.q;
    const offX = (x: number) => x < -24 || x > cam.W + 24;
    const offY = (y: number) => y < -24 || y > cam.H + 24;
    // 1. heat haze: a warm glow under the stage that backs up
    if (c.bottleneck && q < 3) {
      const at: Record<string, [number, number, number]> = { prs: [270, 300, 180], intake: [705, 291, 90], engines: [915, 300, 230], deploy: [1165, 330, 90] };
      const [u, v, r] = at[c.bottleneck] ?? [0, 0, 0];
      if (r) {
        const x = cam.x(u, v), y = cam.y(u, v), R = r * cam.s;
        const heat = clamp(c.heat[c.bottleneck], 0.3, 1.4) * 0.9;
        const gr = ctx.createRadialGradient(x, y, 0, x, y, R);
        gr.addColorStop(0, withAlpha('#E5934F', 0.16 * heat));
        gr.addColorStop(0.55, withAlpha('#E5934F', 0.06 * heat));
        gr.addColorStop(1, withAlpha('#E5934F', 0));
        ctx.save(); ctx.translate(x, y); ctx.scale(1, 0.55); ctx.translate(-x, -y);
        ctx.fillStyle = gr; ctx.beginPath(); ctx.arc(x, y, R, 0, TAU); ctx.fill(); ctx.restore();
        g.ops += 12; g.arcs++;
      }
    }
    // 2. belts: slats drift at a speed set by the belt's last-hour throughput, logarithmically
    //    (motion.ts: 6 + 10·log₂(1 + rate/min) px/s at the fit; a belt with nothing on it stands)
    if (q < 2 && !this.f.reduced) {
      g.begin_();
      for (const b of this.belts()) {
        if (!b.n) continue;
        const hw = this.hwOf(b);
        const speed = beltSpeedPx(b.n) / cam.fitS;
        const pitch = b.hw !== undefined ? 9 : 12;
        const off = ((t / 1000) * speed) % pitch;
        for (let i = 1; i < b.pts.length; i++) {
          const [a, e] = [b.pts[i - 1], b.pts[i]];
          const len = Math.hypot(e[0] - a[0], e[1] - a[1]);
          const du = (e[0] - a[0]) / len, dv = (e[1] - a[1]) / len;
          for (let s = off; s < len; s += pitch) {
            const u = a[0] + du * s, v = a[1] + dv * s;
            const x = cam.x(u, v);
            if (offX(x)) continue;
            g.move(cam.x(u - dv * hw, v - du * hw), cam.y(u - dv * hw, v - du * hw, 0.6));
            g.line(cam.x(u + dv * hw, v + du * hw), cam.y(u + dv * hw, v + du * hw, 0.6));
          }
        }
      }
      g.stroke(F.slat, Math.max(1, cam.s * 1.4));
    }
    // 3. the cars (the static floor paints them): their hits, running lamps on the beat, the
    //    newest culprit's beacon, the selection's ring
    let selCar: Pt | null = null;
    const lamps = this.f.bD, cnt = this.data.last;
    const focusI = this.lanes.index(this.focusId);
    let focal: Pt | null = null;
    const fc = c.focal;
    for (const L of this.lanesNow) {
      if (L.s.stripe || L.kind === 'bots' || (L.i === focusI && this.level >= 2)) continue;
      const list = cnt.lanes.get(L.id)?.cars ?? [];
      const n = list.length, v = L.s.rail;
      list.forEach((car, k) => {
        const u = RAIL_U1 - 12 - (n - 1 - k) * 10;
        if (u < RAIL_U0 + 4) return;
        const x = cam.x(u, v), y = cam.y(u, v);
        if (offX(x) || offY(y)) return;
        const id = `${car.repo}@${car.sha}`;
        this.f.hit(x - 6, cam.y(u, v, 8) - 6, 12, 12, 'commit', id, `${car.repo.split('/')[1]} · ${car.title}`);
        if (this.f.selected === id) selCar = [u, v];
        if (fc && car.sha === fc.sha && car.repo === fc.repo) focal = [u, v];
        if (car.state === 'running' || car.state === 'pending') lamps.add(u, v, 0, 0, 0, 9);
      });
    }
    if (blink(t)) flushLights(cam, g, lamps, C.packet, 1.8, q < 2); else lamps.n = 0;
    this.focalAt = focal;
    if (focal && !this.f.selected) {
      const [u, v] = focal as Pt;
      const x = cam.x(u, v), y = cam.y(u, v, 11), fx = flash(t);
      g.begin_(); g.circle(x, y, (3 + 5 * fx) * Math.max(1, cam.s)); g.fill(withAlpha(C.red, 0.12 + 0.3 * fx));
      g.begin_(); g.circle(x, y, 1.8 * Math.max(1, cam.s)); g.fill(C.red);
    }
    if (selCar) ring(cam, g, selCar[0], selCar[1], 8);
  }

  /** Where the newest culprit's car sits on its lane's rail this frame (labels.ts names it). */
  focalAt: Pt | null = null;

  /** Each car's spot, each repo's newest car (else its post) and newest culprit, for the coffee
   *  check's beacons and rings (coffee.ts `carSpots`); null while the lanes are off. */
  carSpots(): { carAt: Map<string, [number, number]>; repoAt: Map<string, [number, number]>; culpritAt: Map<string, [number, number]> } | null {
    if (!this.on) return null;
    const key = `${this.lanes.ver}|${this.data.ver}|${this.level}|${this.focusId}`;
    if (this.spotsKey === key && this.spots) return this.spots;
    const carAt = new Map<string, [number, number]>(), repoAt = new Map<string, [number, number]>(), culpritAt = new Map<string, [number, number]>();
    const cnt = this.data.last;
    for (const L of this.lanesNow) {
      const info = cnt.lanes.get(L.id);
      if (!info) continue;
      // posts first (a car, below, wins for its repo)
      const span = RAIL_U1 - RAIL_U0 - 8, max = Math.floor(span / 3.6);
      const list = info.posts.slice(0, max), pitch = Math.min(7, span / Math.max(1, list.length));
      list.forEach((p, j) => { const at: [number, number] = [RAIL_U0 + 4 + j * pitch, L.s.curb]; repoAt.set(p.repo, at); if (p.st === 0) culpritAt.set(p.repo, at); });
      if (L.s.stripe) continue;
      const n = info.cars.length;
      info.cars.forEach((car, k) => {
        const u = RAIL_U1 - 12 - (n - 1 - k) * 10;
        if (u < RAIL_U0 + 4) return;
        const at: [number, number] = [u, L.s.rail];
        carAt.set(`${car.repo}@${car.sha}`, at);
        repoAt.set(car.repo, at);
        if (car.culprit) culpritAt.set(car.repo, at);
      });
    }
    this.spotsKey = key; this.spots = { carAt, repoAt, culpritAt };
    return this.spots;
  }
  private spotsKey = '';
  private spots: { carAt: Map<string, [number, number]>; repoAt: Map<string, [number, number]>; culpritAt: Map<string, [number, number]> } | null = null;

  // ---- for the lenses (lens.ts, W3): where things stand on the lanes ---------------------------

  /** A car's spot ('repo@sha'), else null. */
  carSpot(id: string): [number, number] | null { return this.carSpots()?.carAt.get(id) ?? null; }
  /** A repo's newest car, else its post. */
  repoSpot(repo: string): [number, number] | null { return this.carSpots()?.repoAt.get(repo) ?? null; }
  /** A repo's newest culprit car (else its red post). */
  culpritSpot(repo: string): [number, number] | null { return this.carSpots()?.culpritAt.get(repo) ?? null; }

  /** A bot's pallet on the siding: its floor box (u0, v0, du, dv, h), else null. */
  palletBox(bot: string): [number, number, number, number, number] | null {
    const L = this.lanesNow[this.lanes.index(BOTS_LANE)];
    if (!L || L.s.stripe) return null;
    let u = YARD_U0 + 8;
    for (const p of this.data.last.pallets) {
      const du = Math.min(84, 22 + 9 * Math.sqrt(p.repos));
      if (p.bot === bot) return [u, L.v0 + 5, du, L.v1 - 4 - (L.v0 + 5), Math.min(28, 3 + 4.2 * Math.log2(1 + p.n))];
      u += du + 10;
    }
    return null;
  }

  /** A lane's way across the floor (dock → its belt → the gate → its rail → the intake), for a
   *  lens's route and ribbon: [dock → gate (the PRs' leg), gate → intake (the merges' leg)]. */
  lanePath(key: string): [Pt[], Pt[]] | null {
    const L = this.lanesNow[this.laneIndex(key)];
    if (!L) return null;
    const mid = (L.v0 + L.v1) / 2;
    const rail = L.s.stripe || L.kind === 'bots' ? mid : L.s.rail, belt = L.s.stripe ? mid : L.s.belt;
    return [[[DOCK_U1, (L.b0 + L.b1) / 2], [JOG_U, L.s.stripe ? mid : L.bs.belt], [JOG_U + 4, belt], [GATE_U - 2, belt]], [[GATE_U - 2, belt], [GATE_U + 10, rail], [RAIL_U1, rail], [MERGE_U, INTAKE_V], [INTAKE_U0, INTAKE_V]]];
  }

  /** A lens's relation lit over the veil, on the lanes: in each lane's phase cells the lit share
   *  of its open PRs as a core (as tall as that share, its outline heavier the more it holds, its
   *  CI-failing part red on the front, the count over it), the lit bots' pallets outlined, the lit
   *  lanes' rails traced and their lit cars redrawn. `num` writes a count. */
  lit(g: Gfx, repos: Set<string>, cars: Set<string>, bots: Map<string, number>, tint: string, hw: number, num: (s: string, x: number, y: number, red: boolean) => void): void {
    const cam = this.f.cam, w = this.f.world;
    const key = `${this.data.ver}|${repos.size}|${[...repos].slice(0, 4).join(',')}`;
    if (key !== this.litKey) {
      this.litKey = key;
      const G = floorGroups(), m = new Map<string, Int16Array>();
      for (const p of w.prs.values()) {
        if (!repos.has(p.repo) || p.phase === 'merged' || p.phase === 'closed' || p.phase === 'deployed') continue;
        if (isBot(p.author, p.bot)) continue;
        const r = phaseRow(p);
        if (r < 0) continue;
        const lane = G.laneOfRepo(p.repo);
        let a = m.get(lane);
        if (!a) m.set(lane, (a = new Int16Array(8)));
        a[r]++;
        if (p.ci === 'failure' || p.ci === 'error') a[4 + r]++;
      }
      this.litN = m;
    }
    let maxN = 1;
    for (const a of this.litN.values()) for (let r = 0; r < 4; r++) maxN = Math.max(maxN, a[r]!);
    const cnt = this.data.last;
    for (const L of this.lanesNow) {
      if (L.s.stripe) continue;
      const a = this.litN.get(L.id);
      if (a) for (let r = 0; r < 4; r++) {
        const n = a[r]!;
        if (!n) continue;
        const all = Math.max(n, cnt.lanes.get(L.id)?.cells[r]?.n ?? n);
        const full = stackH(all), z = Math.max(3, full * (n / all)), k = Math.sqrt(n / maxN);
        const u0 = ROW_U[r] - CELL_DU / 2 + 7, du = CELL_DU - 14, v0 = L.s.cell0 + 3, dv = Math.max(3, L.s.cell1 - L.s.cell0 - 6);
        box(cam, g, u0, v0, du, dv, z, '#3E3E42', '#2C2C2F', '#252528', withAlpha(tint, 0.55 + 0.45 * k), hw * (0.6 + 1.8 * k));
        g.begin_(); quad(cam, g, u0, v0, u0 + du, v0 + dv, z); g.fill(withAlpha(tint, 0.08 + 0.42 * k));
        const red = a[4 + r]!;
        if (red) { g.begin_(); poly(cam, g, [u0, v0 + dv, 0, u0 + du, v0 + dv, 0, u0 + du, v0 + dv, z * (red / n), u0, v0 + dv, z * (red / n)]); g.fill(withAlpha(C.red, 0.8)); }
        num(String(n), cam.x(u0 + du / 2, v0 + dv / 2), cam.y(u0 + du / 2, v0 + dv / 2, Math.max(z, full)) - 5, red > 0);
      }
      // the lane's rail, traced, and its lit cars
      if (L.kind === 'bots') continue;
      const list = cnt.lanes.get(L.id)?.cars ?? [];
      const mine = list.some((c) => repos.has(c.repo));
      if (!mine) continue;
      const v = L.s.rail;
      g.begin_();
      g.move(cam.x(RAIL_U0, v - 3), cam.y(RAIL_U0, v - 3)); g.line(cam.x(RAIL_U1, v - 3), cam.y(RAIL_U1, v - 3));
      g.move(cam.x(RAIL_U0, v + 3), cam.y(RAIL_U0, v + 3)); g.line(cam.x(RAIL_U1, v + 3), cam.y(RAIL_U1, v + 3));
      g.stroke(withAlpha(tint, 0.55), g.hair * 2);
      const n = list.length;
      list.forEach((car, k) => {
        if (!cars.has(`${car.repo}@${car.sha}`) && !repos.has(car.repo)) return;
        const u = RAIL_U1 - 12 - (n - 1 - k) * 10;
        if (u < RAIL_U0 + 4) return;
        const run = car.state === 'running' || car.state === 'pending';
        this.car(g, u, v, car.culprit, !run && !car.culprit, g.hair);
      });
    }
    for (const [bot, n] of bots) {
      const b = this.palletBox(bot);
      if (!b || !n) continue;
      g.begin_(); quad(cam, g, b[0], b[1], b[0] + b[2], b[1] + b[3], b[4]); g.stroke(tint, hw);
      num(String(n), cam.x(b[0] + b[2] / 2, b[1] + b[3] / 2), cam.y(b[0] + b[2] / 2, b[1] + b[3] / 2, b[4]) - 4, false);
    }
  }
  private litKey = '';
  private litN = new Map<string, Int16Array>();

  /** One car (a lens draws a lit one over the floor's batched cars). */
  car(g: Gfx, u: number, v: number, red: boolean, settled: boolean, hair: number): void {
    box(this.f.cam, g, u - 4, v - 4, 8, 8, 5, red ? F.redTop : settled ? '#6E6A62' : F.crateTop, red ? F.redSide : settled ? '#4A4844' : F.crateSide, red ? F.redFront : settled ? '#3E3C38' : F.crateFront, red ? '#E08088' : settled ? '#8A867E' : '#F0CC8A', hair);
  }
}

/** A stack's height (world z) for `n` open PRs (a layer per 5, at most 16). */
export function stackH(n: number): number { return 1.2 + Math.min(16, Math.ceil(n / 5)) * 2.4; }

/** A short "how long" (2h 10m, 3 d). */
export function ago(ms: number): string {
  if (!(ms > 0)) return 'now';
  const m = Math.round(ms / 60_000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)} d`;
}

/** Stems for the posts (u, v, h triples), reused. */
class Path {
  private a: number[] = [];
  n = 0;
  add(u: number, v: number, h: number): void { this.a[this.n * 3] = u; this.a[this.n * 3 + 1] = v; this.a[this.n * 3 + 2] = h; this.n++; }
  at(k: number): [number, number, number] { return [this.a[k * 3]!, this.a[k * 3 + 1]!, this.a[k * 3 + 2]!]; }
}
