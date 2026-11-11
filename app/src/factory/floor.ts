// The floor itself (fab-w0, from factory.ts): the slab and its grid, the painted stage zones,
// every belt (a flow band whose width is the last hour's throughput; its slats drift at a speed
// set by it), all the steel (the orgs' main-line rails and the deploy tracks' beds), the sources'
// docks, the PR yard's stacks (phase × age) and bot pallets, the merge gate, the main lines' cars
// with their lamps and the culprit's beacon, and the heat haze under the stage that backs up.
// Pushes and merges send their crates from here.

import type { Event } from '../wire.ts';
import type { World } from '../world.ts';
import { BOTS } from '../world.ts';
import type { Gfx } from '../yard/gfx.ts';
import { C, TAU, clamp, withAlpha } from '../yard/theme.ts';
import { PHASES } from './census.ts';
import type { Factory } from './factory.ts';
import { LU, LV } from './iso.ts';
import { PLAN } from './layout.ts';
import { R_DOOR, R_RING, beltSpeedPx, blink, breathe, flash } from './motion.ts';
import { F, box, flushLights, poly, quad, ring } from './prims.ts';
import type { FloorPass, Layer, LiveFrame, Pt } from './types.ts';

const {
  DOCK_U0, DOCK_U1, COLLECT_U, AISLE_V, YARD_U0, YARD_U1, ROW_U, ROW_DU, AGE_V, STACK_DV, PALLET_V, GATE_U,
  RAIL_U0, RAIL_U1, RAIL_V, INTAKE_U0, INTAKE_U1, DIST_U, ENG_U0, ENG_U1, ENG_V0, ENG_STEP, ENG_DV,
  SCAN_U, TRACK_V, TRACK_U1, CITY_U0, CITY_U1, CITY_V0, CITY_V1, RETURN_V, VIAS,
} = PLAN;

/** A belt: its polyline, its last hour's throughput and where its label would sit. */
export type Belt = { id: string; pts: Pt[]; n: number; label: string; at: Pt };

export class Floor implements Layer {
  readonly name = 'floor';

  constructor(readonly f: Factory) {}

  // ---- events: a push leaves its dock (its door flaps) for the yard or, on main, the gate and
  // its org's rail; a merge rolls from the approved stacks through the gate onto the rail ----
  onEvent(e: Event, w: World, t: number): void {
    const orgOf = (repo: string) => w.orgOf(repo);
    const R = this.f.reactions.rp;
    switch (e.k) {
      case 'push': {
        const org = e.bot || e.author?.endsWith('[bot]') ? BOTS : orgOf(e.repo);
        const main = e.branch === (w.repos.get(e.repo)?.default_branch ?? 'main');
        const dv = this.dockV(org);
        const route: Pt[] = [[DOCK_U1 - 6, dv], [COLLECT_U, dv], [COLLECT_U, AISLE_V]];
        if (main) route.push([YARD_U1, AISLE_V], [GATE_U + 10, AISLE_V], [RAIL_U0 + 10, this.railV(orgOf(e.repo))]);
        else route.push([ROW_U[1], AISLE_V], [ROW_U[1], AGE_V[0]]);
        const cr = this.f.crates.spawn(`${e.repo}@${e.sha}`, 'commit', route, t, main ? 4200 : 2600, false, '', org);
        R.add(R_DOOR, DOCK_U1, dv, 6, cr.t0, false, 700);
        if (main) { R.add(R_RING, GATE_U + 4, AISLE_V, 40, this.f.crates.arrives(cr, 4), false); R.add(R_RING, RAIL_U0 + 10, this.railV(orgOf(e.repo)), 4, this.f.crates.arrives(cr, 5), false); }
        else R.add(R_RING, ROW_U[1], AGE_V[0] + STACK_DV / 2, 4, this.f.crates.arrives(cr, 4), false, 900);
        break;
      }
      case 'merge': {
        const org = orgOf(e.repo);
        const cr = this.f.crates.spawn(`${e.repo}@${e.sha}`, 'commit', [[ROW_U[3], AGE_V[1]], [ROW_U[3], AISLE_V], [YARD_U1, AISLE_V], [GATE_U + 10, AISLE_V], [RAIL_U0 + 10, this.railV(org)], [RAIL_U0 + 60, this.railV(org)]], t, 2600, false, '', org);
        R.add(R_RING, GATE_U + 4, AISLE_V, 40, this.f.crates.arrives(cr, 3), false);
        R.add(R_RING, RAIL_U0 + 10, this.railV(org), 4, this.f.crates.arrives(cr, 4), false);
        break;
      }
      default: break;
    }
  }

  /** The v of an org's dock (the bots' dock, last, for an org without one). */
  dockV(org: string): number {
    const i = this.f.census.docks.findIndex((d) => d.org === org);
    return 66 + (i < 0 ? this.f.census.docks.length - 1 : i) * 96;
  }

  railV(org: string): number {
    const i = this.f.census.rails.findIndex((r) => r.org === org);
    return RAIL_V[i < 0 ? 0 : Math.min(RAIL_V.length - 1, i)];
  }

  /** A belt (a flow band) along an axis-aligned polyline; `lanes` ∝ throughput. */
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
    const c = this.f.census, f = c.flow;
    const out: Belt[] = [];
    c.docks.forEach((d, i) => {
      const v = 66 + i * 96;
      out.push({ id: `dock${i}`, pts: [[DOCK_U1, v], [COLLECT_U, v]], n: d.perHour, label: '', at: [84, v] });
    });
    const v0 = 66, v1 = 66 + (c.docks.length - 1) * 96;
    out.push({ id: 'collect', pts: [[COLLECT_U, v0], [COLLECT_U, v1]], n: f.pushes, label: '', at: [COLLECT_U, 200] });
    out.push({ id: 'aisle', pts: [[COLLECT_U, AISLE_V], [YARD_U1, AISLE_V]], n: f.pushes, label: `${f.pushes} pushes/h`, at: [116, AISLE_V] });
    out.push({ id: 'gate', pts: [[YARD_U1, AISLE_V], [RAIL_U0 - 6, AISLE_V]], n: f.merges, label: `${f.merges} merged/h`, at: [YARD_U1 + 4, AISLE_V] });
    out.push({ id: 'intake', pts: [[RAIL_U1 + 14, 291], [INTAKE_U0, 291]], n: f.enqueued, label: `${f.enqueued} queued/h`, at: [RAIL_U1 + 16, 291] });
    out.push({ id: 'feed', pts: [[INTAKE_U1, 291], [DIST_U, 291]], n: f.started, label: '', at: [INTAKE_U1, 291] });
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

  // ---- the static floor: paints the ground now, hands its extruded things to the depth sort,
  // and the cars after them ----
  floor(fp: FloorPass): void {
    const g = fp.g, cam = this.f.cam, lo = fp.lo, idle = fp.idle, add = fp.add;
    // the floor slab
    g.begin_(); poly(cam, g, [0, 0, 0, LU, 0, 0, LU, LV, 0, 0, LV, 0]); g.fill(F.floor);
    // a faint isometric grid: every 20 units, a stronger line every 100 (low detail: only those)
    const step = cam.s * 20 > 9 ? 20 : 40;
    if (!lo) {
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
    // painted zones (dashed), one per stage
    g.dash(true, 3, 4);
    const zones: [number, number, number, number][] = [[4, 24, 72, 588], [YARD_U0 - 6, 92, YARD_U1 + 4, 600], [RAIL_U0 - 4, 98, RAIL_U1 + 6, 482], [INTAKE_U0 - 8, 252, INTAKE_U1 + 6, 330], [ENG_U0 - 8, 22, ENG_U1 + 40, 600], [CITY_U0 - 8, CITY_V0 - 8, CITY_U1 + 4, CITY_V1 + 6]];
    g.begin_();
    for (const z of zones) quad(cam, g, z[0], z[1], z[2], z[3], 0);
    g.stroke(F.zone, g.hair * 1.5);
    g.dash(false);
    // belts: one path for every belt's bed, one for their edges
    const belts = this.belts();
    g.begin_();
    for (const b of belts) this.beltPath(g, b.pts, this.laneW(b.n) / 2);
    g.fill(F.belt);
    g.begin_();
    for (const b of belts) this.beltPath(g, b.pts, this.laneW(b.n) / 2);
    g.stroke(F.beltEdge, g.hair * 1.5);
    // main-line rails and deploy tracks (two rails and sleepers), every track in two paths
    const tracks: [number, number, number][] = [];
    for (let i = 0; i < this.f.census.rails.length; i++) tracks.push([RAIL_U0, RAIL_U1, RAIL_V[i]]);
    for (let i = 0; i < 3; i++) tracks.push([SCAN_U + 10, TRACK_U1, TRACK_V[i]]);
    if (!lo) {
      g.begin_();
      for (const [u0, u1, v] of tracks) for (let u = u0 + 4; u < u1; u += 8) { g.move(cam.x(u, v - 5), cam.y(u, v - 5)); g.line(cam.x(u, v + 5), cam.y(u, v + 5)); }
      g.stroke(F.sleeper, Math.max(1, cam.s * 1.6));
    }
    g.begin_();
    for (const [u0, u1, v] of tracks) {
      g.move(cam.x(u0, v - 3), cam.y(u0, v - 3)); g.line(cam.x(u1, v - 3), cam.y(u1, v - 3));
      g.move(cam.x(u0, v + 3), cam.y(u0, v + 3)); g.line(cam.x(u1, v + 3), cam.y(u1, v + 3));
    }
    g.stroke(F.rail, g.hair * 2);
    // rail ends converge into the intake funnel
    g.begin_();
    for (let i = 0; i < this.f.census.rails.length; i++) { g.move(cam.x(RAIL_U1, RAIL_V[i]), cam.y(RAIL_U1, RAIL_V[i])); g.line(cam.x(RAIL_U1 + 14, 291), cam.y(RAIL_U1 + 14, 291)); }
    g.stroke(F.beltEdge, g.hair * 1.5);
    // the blocks, far to near (every layer's, sorted together); each culled by its floor box
    // sources: docks
    this.f.census.docks.forEach((d, i) => {
      const v = 66 + i * 96;
      add(DOCK_U0, v, () => {
        box(cam, g, DOCK_U0, v - 30, DOCK_U1 - DOCK_U0, 60, 14);
        // the dock's door: a dark slot on its right face
        g.begin_(); poly(cam, g, [DOCK_U1, v - 12, 1, DOCK_U1, v + 12, 1, DOCK_U1, v + 12, 10, DOCK_U1, v - 12, 10]); g.fill(F.bay);
        if (d.org === BOTS) { g.begin_(); quad(cam, g, DOCK_U0 + 6, v - 24, DOCK_U1 - 6, v + 24, 14); g.stroke(F.edgeHi, g.hair); }
      }, DOCK_U1, v + 30, 14);
    });
    // the PR yard: a low slab with racks; stacks by phase (columns) × age (depth)
    add(YARD_U0, 92, () => {
      box(cam, g, YARD_U0, 92, YARD_U1 - YARD_U0, 452, 2, '#141416', '#101011', '#0F0F10', F.floorEdge);
    }, YARD_U1, 544, 2);
    PHASES.forEach((_ph, r) => {
      AGE_V.forEach((v, b) => {
        const s = this.f.census.stacks[r][b];
        const u0 = ROW_U[r] - ROW_DU / 2;
        add(u0, v, () => this.stack(g, u0, v, s.n, s.stuck, s.red, b, lo), u0 + ROW_DU, v + STACK_DV, 48);
      });
    });
    this.f.census.pallets.forEach((p, i) => {
      const u0 = YARD_U0 + 8 + i * 76;
      add(u0, PALLET_V, () => this.pallet(g, u0, PALLET_V - 16, p.n), u0 + 64, PALLET_V + 18, 34);
    });
    // merge gate: two posts and a beam over the aisle
    add(GATE_U, AISLE_V - 30, () => {
      box(cam, g, GATE_U, AISLE_V - 36, 8, 8, 40);
      box(cam, g, GATE_U, AISLE_V + 28, 8, 8, 40);
      box(cam, g, GATE_U, AISLE_V - 36, 8, 72, 6 + 0, F.topHi);
      g.begin_(); quad(cam, g, GATE_U, AISLE_V - 36, GATE_U + 8, AISLE_V + 36, 40); g.fill(F.topHi);
      g.begin_(); quad(cam, g, GATE_U, AISLE_V - 36, GATE_U + 8, AISLE_V + 36, 40); g.stroke(F.edgeHi, g.hair * 1.5);
    }, GATE_U + 8, AISLE_V + 36, 40);
    // the main lines' cars: they change at a merge or a run's end, which redraws this layer
    // (`floorKey`), not every frame
    if (!idle) fp.after(() => this.drawCars(g, lo));
  }

  /** The main lines' cars: the org's newest merged commits, newest at the right; one path per
   *  face and state (settled gray, running amber, red), edges only zoomed in. */
  private drawCars(g: Gfx, lo: boolean): void {
    const cam = this.f.cam, c = this.f.census;
    const carG = this.f.bA, carA = this.f.bB, carR = this.f.bC;
    let cars = 0;
    c.rails.forEach((r, i) => {
      const v = RAIL_V[i];
      const n = r.cars.length;
      r.cars.forEach((car, k) => {
        const u = RAIL_U1 - 12 - (n - 1 - k) * 10;
        if (u < RAIL_U0 + 4) return;
        const x = cam.x(u, v), y = cam.y(u, v);
        if (x < -24 || x > cam.W + 24 || y < -24 || y > cam.H + 24) return;
        const run = car.state === 'running' || car.state === 'pending';
        (car.culprit ? carR : run ? carA : carG).add(u - 4, v - 4, 8, 8, 5);
        cars++;
      });
    });
    const carPx = 8 * cam.s;
    const edge = !lo && carPx >= 6;
    carG.flush(g, cam, '#6E6A62', '#4A4844', '#3E3C38', edge ? '#8A867E' : '', g.hair, 3);
    carA.flush(g, cam, F.crateTop, F.crateSide, F.crateFront, edge ? '#F0CC8A' : '', g.hair, 3);
    carR.flush(g, cam, F.redTop, F.redSide, F.redFront, edge ? '#E08088' : '', g.hair, 3);
    this.f.stat.cars = cars;
  }

  private stack(g: Gfx, u0: number, v0: number, n: number, stuck: number, red: number, bucket: number, lo = false): void {
    const cam = this.f.cam;
    // a pallet on the floor, crates stacked by count (1 crate layer per 2 PRs, a cap with a break)
    box(cam, g, u0, v0, ROW_DU, STACK_DV, 2, '#19191B', '#121214', '#101012', '#2A2A2E');
    if (!n) return;
    const layers = Math.min(16, Math.ceil(n / 3));
    const lh = 2.6;
    // neutral cargo: a conflict-majority stack gets one red mark (its edge), a stale-majority
    // one a brighter edge (red is for failures, amber for what is in flight)
    const hot = red > 0 && red >= n / 2 ? 'red' : stuck >= n / 2 ? 'stale' : '';
    void bucket;
    const top = hot === 'stale' ? '#323235' : '#2B2B2E';
    const side = '#1E1E21';
    const front = '#19191B';
    const edge = hot === 'red' ? '#A04A50' : hot === 'stale' ? '#77777C' : '#3C3C40';
    const inset = 7;
    box(cam, g, u0 + inset, v0 + inset, ROW_DU - inset * 2, STACK_DV - inset * 2, 2 + layers * lh, top, side, front, edge);
    const ua = u0 + inset, ub = u0 + ROW_DU - inset, va = v0 + inset, vb = v0 + STACK_DV - inset;
    // layer seams on the front and right faces (not on the low-detail floor)
    if (!lo) {
      g.begin_();
      for (let k = 1; k < layers; k++) {
        const z = 2 + k * lh;
        g.move(cam.x(ua, vb), cam.y(ua, vb, z)); g.line(cam.x(ub, vb), cam.y(ub, vb, z)); g.line(cam.x(ub, va), cam.y(ub, va, z));
      }
      g.stroke(withAlpha(edge, 0.55), g.hair);
    }
    if (n > 48) {
      // the cap: more than the stack shows
      g.begin_(); quad(cam, g, ua + 4, va + 4, ub - 4, vb - 4, 2 + layers * lh); g.stroke(edge, g.hair * 1.5);
    }
  }

  private pallet(g: Gfx, u0: number, v0: number, n: number): void {
    const cam = this.f.cam;
    box(cam, g, u0, v0, 64, 34, 3, '#1C1A16', '#141310', '#12110E', '#3A352B');
    // crates on it: a grid whose fill grows with the count (up to 4×2 × 6 high)
    const cols = 4, rows = 2;
    const per = Math.max(1, Math.ceil(n / (cols * rows)));
    const h = Math.min(30, 3 + Math.sqrt(per) * 4);
    box(cam, g, u0 + 5, v0 + 5, 54, 24, 3 + h, '#2E2A22', '#221F19', '#1C1A15', '#4A4334');
    g.begin_();
    for (let k = 1; k < cols; k++) { const u = u0 + 5 + k * 13.5; g.move(cam.x(u, v0 + 29), cam.y(u, v0 + 29, 3)); g.line(cam.x(u, v0 + 29), cam.y(u, v0 + 29, 3 + h)); g.line(cam.x(u, v0 + 5), cam.y(u, v0 + 5, 3 + h)); }
    g.move(cam.x(u0 + 5, v0 + 17), cam.y(u0 + 5, v0 + 17, 3 + h)); g.line(cam.x(u0 + 59, v0 + 17), cam.y(u0 + 59, v0 + 17, 3 + h));
    g.stroke('#4A4334', g.hair);
  }

  // ---- the live layer: the haze, the belts' slats, the cars' hits, lamps and the culprit ----
  live(g: Gfx, fr: LiveFrame): void {
    const cam = this.f.cam, w = this.f.world, c = this.f.census, ctx = fr.ctx, t = fr.t, q = fr.q;
    const offX = (x: number) => x < -24 || x > cam.W + 24;
    const offY = (y: number) => y < -24 || y > cam.H + 24;
    // 1. heat haze: a warm glow under the stage that backs up
    if (c.bottleneck && q < 3) {
      const at: Record<string, [number, number, number]> = { prs: [270, 300, 180], intake: [705, 291, 90], engines: [915, 300, 230], deploy: [1165, 330, 90] };
      const [u, v, r] = at[c.bottleneck] ?? [0, 0, 0];
      if (r) {
        const x = cam.x(u, v), y = cam.y(u, v), R = r * cam.s;
        const heat = clamp(c.heat[c.bottleneck], 0.3, 1.4) * (0.8 + 0.2 * breathe(t, 4));
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
        const hw = this.laneW(b.n) / 2;
        const speed = beltSpeedPx(b.n) / cam.fitS;
        const off = ((t / 1000) * speed) % 12;
        for (let i = 1; i < b.pts.length; i++) {
          const [a, e] = [b.pts[i - 1], b.pts[i]];
          const len = Math.hypot(e[0] - a[0], e[1] - a[1]);
          const du = (e[0] - a[0]) / len, dv = (e[1] - a[1]) / len;
          for (let s = off; s < len; s += 12) {
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
    // 3. cars on the main-line rails (the static floor paints them, redrawn when one changes):
    //    here, their hits and the selection's ring
    let selCar: Pt | null = null;
    const lamps = this.f.bD;
    c.rails.forEach((r, i) => {
      const v = RAIL_V[i];
      const n = r.cars.length;
      r.cars.forEach((car, k) => {
        const u = RAIL_U1 - 12 - (n - 1 - k) * 10;
        if (u < RAIL_U0 + 4 || car.sha.charCodeAt(0) === 126) return; // a stress copy: nothing to open
        const x = cam.x(u, v), y = cam.y(u, v);
        if (offX(x) || offY(y)) return;
        const id = `${car.repo}@${car.sha}`;
        this.f.hit(x - 6, cam.y(u, v, 8) - 6, 12, 12, 'commit', id, `${car.repo.split('/')[1]} · ${car.title}`);
        if (this.f.selected === id) selCar = [u, v];
        if (car.state === 'running' || car.state === 'pending') lamps.add(u, v, 0, 0, 0, 9);
      });
    });
    // a running car's lamp blinks on the beat; the newest culprit's beacon flashes on it
    if (blink(t)) flushLights(cam, g, lamps, C.packet, 1.8, q < 2); else lamps.n = 0;
    if (c.focal && !this.f.selected) {
      const ri = c.rails.findIndex((r) => r.org === w.orgOf(c.focal!.repo));
      const rail = c.rails[ri];
      const k = rail ? rail.cars.findIndex((x) => x.sha === c.focal!.sha && x.repo === c.focal!.repo) : -1;
      if (rail && k >= 0) {
        const u = RAIL_U1 - 12 - (rail.cars.length - 1 - k) * 10, v = RAIL_V[ri];
        const x = cam.x(u, v), y = cam.y(u, v, 11), fx = flash(t);
        g.begin_(); g.circle(x, y, (3 + 5 * fx) * Math.max(1, cam.s)); g.fill(withAlpha(C.red, 0.12 + 0.3 * fx));
        g.begin_(); g.circle(x, y, 1.8 * Math.max(1, cam.s)); g.fill(C.red);
      }
    }
    if (selCar) ring(cam, g, selCar[0], selCar[1], 8);
  }

  /** One car (a lens draws a lit one over the floor's batched cars). */
  car(g: Gfx, u: number, v: number, red: boolean, settled: boolean, hair: number): void {
    box(this.f.cam, g, u - 4, v - 4, 8, 8, 5, red ? F.redTop : settled ? '#6E6A62' : F.crateTop, red ? F.redSide : settled ? '#4A4844' : F.crateSide, red ? F.redFront : settled ? '#3E3C38' : F.crateFront, red ? '#E08088' : settled ? '#8A867E' : '#F0CC8A', hair);
  }
}
