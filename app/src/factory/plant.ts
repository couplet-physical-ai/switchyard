// THE CONSUMPTION ENGINE (fab-w6; FACTORY-SPEC §B engine rows, §D, §F job level, §I-W6). The
// plant between the main lines and the city, each part an encoding rather than a caption:
//
//   intake    a queue RIBBON per lane: one crate per waiting run (count ∝ pending, a pile past
//             16), the ribbon under them coloured by how long each has waited (dim amber → red
//             at 8× the usual wait), and the mouth's GATE: shut (a raised amber bar) while every
//             self-hosted slot is taken and something waits; W4's jam mark (crates bunching,
//             chevrons) presses against it.
//   machine   one per host. Its idle bays RECEDE (flat, dark, no rim); a busy bay is lit in its
//             job's GROUP hue (groups.ts `hex`), recessed, its front lip the progress rail (amber,
//             red past 1.5× the expected time) and the job's crate riding it. Offline: a red edge.
//   wall      on each machine's back, its last 24 h (planthist.ts, the server's per-minute
//             history): the TIDE (busy/slots, filled), a bright cap where every slot was taken,
//             the cpu ribbon (red ≥ 90 %) and the mem ribbon (dashed); offline minutes and the
//             time before the record are GAPS. The label is just the machine's name.
//   gauges    cpu and mem towers at the machine's end: the wall's ribbons, now.
//   GHA       a ghost machine (dashed: not ours). With no runners reported we know of no slots: a
//             bay for each RUNNING job only, never an empty one, and no wall; runners the fleet
//             reports (census folds them in) bring their real slots and their wall.
//   scanner   a SPLIT BEAM: its crossbar lit in two parts, pass (green-gray, back) and fail (red,
//             front, over the return conveyor), each ∝ its share of the last hour's finishes.
//   return    failures ride the front edge to the RISER beside the docks and up a SPUR into their
//             group dock's door (f.w2's lanes); a spur glows red with its group's last-hour returns.
//             W3 parks the last hour's failures on the conveyor (lens.ts `drawParked`).
//   job zoom  z ≥ 4 over a machine: its busy bay OPENS over the machine's top, everything else
//             dimmed to ~15 %: the run's workflows as conveyors, its steps as chips on one time
//             axis (state colour; amber running, growing to now; red with its exit code; cached
//             hollow; pending dashed), the expected and 1.5× marks, and the run's progress rail.

import type { Event, Pipeline, Step } from '../wire.ts';
import type { World } from '../world.ts';
import type { Gfx } from '../yard/gfx.ts';
import { C, clamp, withAlpha } from '../yard/theme.ts';
import { BoxBatch } from './batch.ts';
import { failingStep } from './census.ts';
import type { Group } from './census.ts';
import type { Factory } from './factory.ts';
import { UX, UY, VX } from './iso.ts';
import { floorGroups } from './groups.ts';
import { PLAN } from './layout.ts';
import { R_BEAM, R_DOOR, R_RING, beltSpeedPx, breathe } from './motion.ts';
import { DAY_MS, PlantHist, dataRuns, historyIds, type Tide } from './planthist.ts';
import { F, SMALL, box, dur, pipeWords, poly, quad, ring } from './prims.ts';
import type { Bay, FloorPass, Layer, LiveFrame, Pt } from './types.ts';

const {
  DOCK_U1, RAIL_U1, INTAKE_U0, INTAKE_U1, LANE_V, DIST_U, ENG_U0, ENG_U1, ENG_V0, ENG_STEP, ENG_DV, ENG_H,
  SCAN_U, TRACK_V, TRACK_U1, RETURN_V,
} = PLAN;

/** The wall: a slab WALL_V deep on the machine's back edge, WALL_H over its top. Under 23.6 it
 *  never hides the machine behind it (only that one's front face). */
const WALL_V = 2, WALL_H = 22;
/** A machine name's box height (px). */
const NAME_H = 13;
/** The return riser: beside the docks' doors, between them and the collect belt. */
export const RISER_U = DOCK_U1 + 7;
/** The intake's mouth gate (u), at the distributor: W4's jam crates bunch behind it. */
const GATE_U = DIST_U - 3;
/** Machine paint: calm, so the lit bays and the queue carry the plant. */
const M_TOP = '#212124', M_SIDE = '#19191B', M_FRONT = '#151517', M_EDGE = '#38383C', M_OFF = '#6B3A3F', IDLE_BAY = '#18181A';
// the wall's chart speaks the machine lens's language (lens.ts vmStory): busy an amber tide, cpu an
// ink line, mem a blue-gray one, a red tick under every stretch with every slot taken
const WALL_FACE = '#18181B', WALL_TOP = '#2C2C30', WALL_EDGE = '#3A3A3F', GAP = '#3A3A3F', MEM_LINE = '#7E8FA6';
/** The wall's scale (ticks at 50 % / 100 %), its baseline under data, and the typical's ghost. */
const SCALE = '#4A4A50', BASE = '#46464C', GHOST = 'rgba(216, 186, 146, 0.72)'; // C.amberText ghosted: the tide's own colour
const OK_BEAM = '#7E9784';
const typicals = new WeakMap<Tide, number>();
/** A tide's typical busy/slots: the median of its buckets with data (NaN: none). Cached per fold. */
export function typical(t: Tide): number {
  let m = typicals.get(t);
  if (m !== undefined) return m;
  const xs: number[] = [];
  for (let i = 0; i < t.n; i++) { const v = t.busy[i]!; if (v === v) xs.push(v); }
  xs.sort((a, b) => a - b);
  const k = xs.length >> 1;
  m = !xs.length ? NaN : xs.length % 2 ? xs[k]! : (xs[k - 1]! + xs[k]!) / 2;
  typicals.set(t, m);
  return m;
}
const STEP_OK = '#5E7363';

/** The lit look of a bay for a group hue: the recess floor (the hue over the machine) and the rim. */
function lit(hex: string): { floor: string; rim: string } {
  return { floor: mix(hex, '#141416', 0.5), rim: hex };
}

/** `a` over `b` at `t` (hex in, hex out). */
export function mix(a: string, b: string, t: number): string {
  const x = parseInt(a.slice(1), 16), y = parseInt(b.slice(1), 16);
  const ch = (s: number) => Math.round(((x >> s) & 255) * t + ((y >> s) & 255) * (1 - t));
  return `#${((ch(16) << 16) | (ch(8) << 8) | ch(0)).toString(16).padStart(6, '0').toUpperCase()}`;
}

/** A wait's colour: dim amber when usual, red at 8× the usual wait (log ramp). */
export function waitColour(age: number, p50: number): string {
  const a = Math.max(2 * p50, 60_000), b = Math.max(8 * a, 30 * 60_000);
  const k = clamp(Math.log(Math.max(1, age) / a) / Math.log(b / a), 0, 1);
  return mix(C.red, '#9A7C48', k);
}

export class Plant implements Layer {
  readonly name = 'plant';
  /** Every machine's slots this frame (rebuilt when the census recounts). */
  bays: Bay[] = [];
  /** The bay each run was last seen in (a finished run leaves from there). */
  readonly lastBay = new Map<string, Bay>();
  /** The walls' 24 h histories (asked from the overview source, `pump`). */
  readonly hist = new PlantHist();
  private layGroups: Group[] | null = null;
  private layAt = -1;
  private layF = 0;
  private litCache = new Map<string, { floor: string; rim: string }>();
  private epoch = -1;
  /** The job zoom's subject this frame ('' none), for tests and the HUD. */
  job = '';

  constructor(readonly f: Factory) {}

  /** The static floor's key part: the walls' histories. */
  get sig(): string { return `h${this.hist.ver}`; }

  /** From a source (app.ts's overview tick, never a draw): asks the machines' 24 h histories
   *  when due (once a minute each). */
  pump(clock: number): void {
    const c = this.f.census, w = this.f.world;
    if (this.epoch !== this.f.tl.epoch) { this.epoch = this.f.tl.epoch; this.hist.clear(); } // a new server or a reset: forget the walls
    if (c.skeleton || !w.loaded) return;
    const ms: { key: string; ids: string[] }[] = [];
    for (const g of c.groups) if (g.engines.length) ms.push({ key: g.id, ids: historyIds(w, g.id, g.engines) });
    this.hist.pump(ms, clock);
  }

  census(w: World): void { this.layoutBays(w); }

  // ---- events: a run queues at the intake, starts in its bay, finishes through the scanner
  // (a failure turns red there and rides the return conveyor up its spur to its group dock) ----
  onEvent(e: Event, w: World, t: number): void {
    const orgOf = (repo: string) => w.orgOf(repo);
    const R = this.f.reactions.rp;
    switch (e.k) {
      case 'enqueue': {
        const org = orgOf(e.repo);
        const lane = e.lane === 'gha' ? 1 : 0;
        const q = lane ? this.f.census.gha.length : this.f.census.rr.length;
        const end = Math.max(INTAKE_U0 + 8, INTAKE_U1 - 8 - Math.min(16, q) * 11 * (q > 7 ? 7 / q : 1));
        const cr = this.f.crates.spawn(e.pipeline, 'pipeline', [[RAIL_U1 - 10, this.f.railV(e.repo)], [RAIL_U1 + 12, this.f.railV(e.repo)], /* fab-w1: its lane's rail */ [INTAKE_U0, LANE_V[lane]], [end, LANE_V[lane]]], t, 1800, false, '', org);
        R.add(R_RING, end, LANE_V[lane], 4, this.f.crates.arrives(cr, 3), false, 900);
        break;
      }
      case 'start': {
        const p = w.pipelines.get(e.pipeline);
        const bay = this.bayOf(e.pipeline, w);
        const lane = p?.lane === 'gha' ? 1 : 0;
        if (bay) {
          const cr = this.f.crates.spawn(e.pipeline, 'pipeline', [[INTAKE_U1 - 6, LANE_V[lane]], [DIST_U, LANE_V[lane]], [DIST_U, bay.v + bay.dv / 2], [bay.u + 6, bay.v + bay.dv / 2]], t, 1600, false, '', p ? orgOf(p.repo) : '');
          R.add(R_RING, bay.u + bay.du / 2, bay.v + bay.dv / 2, ENG_H, this.f.crates.arrives(cr, 3), false, 1000);
        }
        break;
      }
      case 'finish': {
        const p = w.pipelines.get(e.pipeline);
        if (!p) break;
        const red = e.state === 'failure' || e.state === 'error';
        if (e.state === 'canceled' || e.state === 'skipped') break;
        const from = this.lastBay.get(e.pipeline);
        const v0 = from ? from.v + from.dv / 2 : ENG_V0 + ENG_DV / 2;
        const u0 = from ? from.u + from.du / 2 : ENG_U1 - 20;
        const org = orgOf(p.repo);
        const route: Pt[] = [[u0, v0], [ENG_U1 + 6, v0], [SCAN_U, v0]];
        let dur = 1600;
        const sv = this.spurV(p.repo);
        if (red) {
          // home: the front edge, the riser, its group's spur into the dock's door
          route.push([SCAN_U, RETURN_V], [RISER_U, RETURN_V], [RISER_U, sv], [DOCK_U1 - 2, sv]);
          dur = 9000;
        } else route.push([SCAN_U + 14, v0]);
        const cr = this.f.crates.spawn(e.pipeline, 'pipeline', route, t, dur, red, red ? `${p.repo.split('/')[1]} · ${failingStep(p)}` : '', org);
        R.add(R_BEAM, SCAN_U, v0, 56, this.f.crates.arrives(cr, 2), red, 700);
        if (red) { R.add(R_DOOR, DOCK_U1, this.f.dockV(p.repo), 6, this.f.crates.arrives(cr, 6), true, 1400); R.add(R_RING, DOCK_U1, sv, 6, this.f.crates.arrives(cr, 6), true, 1400); }
        break;
      }
      default: break;
    }
  }

  /** Where a repo's returns enter its dock: the front half of its door (the dock belt leaves
   *  from the door's middle). */
  spurV(repo: string): number {
    const v = this.f.dockV(repo);
    const gg = this.lanes().find((l) => Math.abs(l.v - v) < 0.5);
    return gg ? Math.min(gg.v1 - 2, v + Math.max(4, (gg.v1 - gg.v) * 0.55)) : v + 8;
  }

  /** The docks' lanes (f.w2's when it is on, else the org docks'). */
  private lanes(): { id: string; v: number; v1: number; hex: string }[] {
    if (this.f.w2.on) return this.f.w2.layout().map((g) => ({ id: g.lane.id, v: g.v, v1: g.v1, hex: g.hex }));
    return this.f.census.docks.map((d, i) => ({ id: d.org, v: 66 + i * 96, v1: 66 + i * 96 + 30, hex: '#606468' }));
  }

  bayOf(pid: string, w: World): Bay | null {
    this.layoutBays(w);
    const b = this.bays.find((x) => x.pid === pid) ?? null;
    if (b) this.lastBay.set(pid, b);
    return b;
  }

  /** Bays: each self-hosted machine's slots, the k-th running pipeline of a host in bay k. GitHub
   *  Actions: its runners' slots when the fleet reports runners (census folds them in); with none
   *  we know of no slots, so a bay for each running job only, packed from the left (honest
   *  capacity: never an invented empty hosted bay). */
  private layoutBays(w: World): void {
    void w;
    const c = this.f.census;
    if (this.layGroups === c.groups && this.layAt === c.at && this.layF === c.factor) return;
    this.layGroups = c.groups; this.layAt = c.at; this.layF = c.factor;
    const out: Bay[] = [];
    const span = ENG_U1 - ENG_U0 - 28;
    c.groups.forEach((g, gi) => {
      const v0 = ENG_V0 + gi * ENG_STEP;
      const ghost = g.hosted && !g.engines.length;
      const n = ghost ? g.running.length : Math.max(1, g.slots, g.running.length);
      const du = ghost ? Math.min(span / 6, span / Math.max(1, n)) : span / n;
      for (let k = 0; k < n; k++) {
        out.push({ u: ENG_U0 + 14 + k * du + 3, v: v0 + 16, du: du - 6, dv: ENG_DV - 40, group: gi, slot: k, pid: g.running[k] ?? '' });
      }
    });
    this.bays = out;
    for (const b of out) if (b.pid) this.lastBay.set(b.pid, b);
  }

  // ---- the static floor: the intake's frame, the machines and their walls, the gauges' bases,
  // the scanner, the return riser and spurs ----
  floor(fp: FloorPass): void {
    const g = fp.g, cam = this.f.cam, lo = fp.lo, add = fp.add;
    // intake: the holding belt's frame (two rails along it), the gate's posts at the mouth
    add(INTAKE_U0, 256, () => {
      box(cam, g, INTAKE_U0, 258, INTAKE_U1 - INTAKE_U0, 4, 6);
      box(cam, g, INTAKE_U0, 320, INTAKE_U1 - INTAKE_U0, 4, 6);
      g.begin_(); quad(cam, g, INTAKE_U0, 291 - 1, INTAKE_U1, 291 + 1, 0.6); g.fill(F.beltEdge);
    }, INTAKE_U1, 324, 6);
    add(GATE_U - 1, 276, () => {
      box(cam, g, GATE_U - 1, 276, 3, 3, 10, '#232326', '#19191B', '#151517');
      box(cam, g, GATE_U - 1, 303, 3, 3, 10, '#232326', '#19191B', '#151517');
    }, GATE_U + 2, 306, 10);
    // the consumption engine: one machine per host, its wall on its back
    this.f.census.groups.forEach((gr, gi) => {
      const v0 = ENG_V0 + gi * ENG_STEP;
      add(ENG_U0, v0, () => this.engineBlock(g, gr, v0, gi, lo), ENG_U1 + 4, v0 + ENG_DV + 4, ENG_H + (gr.engines.length ? WALL_H : 0));
      if (gr.hosted) return;
      // cpu / mem gauges: two towers at the machine's right end
      add(ENG_U1 + 10, v0 + 40, () => {
        box(cam, g, ENG_U1 + 12, v0 + 34, 9, 9, 64, '#1B1B1D');
        box(cam, g, ENG_U1 + 25, v0 + 34, 9, 9, 64, '#1B1B1D');
      }, ENG_U1 + 34, v0 + 43, 64);
    });
    // the test scanner: a tall frame across the floor
    add(SCAN_U - 4, 30, () => {
      box(cam, g, SCAN_U - 4, 30, 8, 8, 56);
      box(cam, g, SCAN_U - 4, 590, 8, 8, 56);
      g.begin_(); quad(cam, g, SCAN_U - 4, 30, SCAN_U + 4, 598, 56); g.fill(F.topHi);
      g.begin_(); quad(cam, g, SCAN_U - 4, 30, SCAN_U + 4, 598, 56); g.stroke(F.edgeHi, g.hair * 1.5);
    }, SCAN_U + 4, 598, 56);
    if (!fp.idle) this.returnBeds(g, lo);
  }

  /** The return conveyor's riser beside the docks and a spur into each group dock's door, its
   *  stripe in the group's hue (the bed of the front run is the floor's belt, floor.ts). */
  private returnBeds(g: Gfx, lo: boolean): void {
    const cam = this.f.cam, lanes = this.lanes();
    if (!lanes.length) return;
    const top = Math.min(...lanes.map((l) => this.spurAt(l)));
    const hw = 2.6;
    g.begin_();
    quad(cam, g, RISER_U - hw, top - hw, RISER_U + hw, RETURN_V + 4, 0.3);
    for (const l of lanes) { const sv = this.spurAt(l); quad(cam, g, DOCK_U1, sv - 1.8, RISER_U - hw, sv + 1.8, 0.3); }
    g.fill(F.belt);
    g.begin_();
    quad(cam, g, RISER_U - hw, top - hw, RISER_U + hw, RETURN_V + 4, 0.3);
    for (const l of lanes) { const sv = this.spurAt(l); quad(cam, g, DOCK_U1, sv - 1.8, RISER_U - hw, sv + 1.8, 0.3); }
    g.stroke(F.beltEdge, g.hair * 1.5);
    if (lo) return;
    // each spur's stripe in its group's hue: follow the colour home
    for (const l of lanes) {
      const sv = this.spurAt(l);
      g.begin_(); g.move(cam.x(DOCK_U1, sv), cam.y(DOCK_U1, sv, 0.5)); g.line(cam.x(RISER_U - hw, sv), cam.y(RISER_U - hw, sv, 0.5));
      g.stroke(withAlpha(l.hex, 0.7), Math.max(1, g.hair * 1.5));
    }
  }

  private spurAt(l: { v: number; v1: number }): number { return Math.min(l.v1 - 2, l.v + Math.max(4, (l.v1 - l.v) * 0.55)); }

  private engineBlock(g: Gfx, gr: Group, v0: number, gi: number, lo = false): void {
    const cam = this.f.cam;
    if (gr.hosted) {
      // hosted runners: a ghost machine (we know of no slots): dark, unfilled, a dashed outline;
      // its bays are its running jobs only (the live layer)
      box(cam, g, ENG_U0, v0, ENG_U1 - ENG_U0, ENG_DV, ENG_H, '#121214', '#0F0F11', '#0E0E10', '#1E1E21', g.hair);
      g.dash(true, 4, 4);
      g.begin_(); quad(cam, g, ENG_U0, v0, ENG_U1, v0 + ENG_DV, ENG_H); g.stroke('#4A4A4F', g.hair * 1.5);
      g.begin_();
      g.move(cam.x(ENG_U0, v0 + ENG_DV), cam.y(ENG_U0, v0 + ENG_DV, ENG_H)); g.line(cam.x(ENG_U0, v0 + ENG_DV), cam.y(ENG_U0, v0 + ENG_DV, 0));
      g.line(cam.x(ENG_U1, v0 + ENG_DV), cam.y(ENG_U1, v0 + ENG_DV, 0)); g.line(cam.x(ENG_U1, v0), cam.y(ENG_U1, v0, 0)); g.line(cam.x(ENG_U1, v0), cam.y(ENG_U1, v0, ENG_H));
      g.move(cam.x(ENG_U1, v0 + ENG_DV), cam.y(ENG_U1, v0 + ENG_DV, 0)); g.line(cam.x(ENG_U1, v0 + ENG_DV), cam.y(ENG_U1, v0 + ENG_DV, ENG_H));
      g.stroke('#38383C', g.hair * 1.5);
      g.dash(false);
      // runners the fleet reports: their slots are real, idle ones recede as anywhere; and a wall
      if (gr.engines.length) {
        const rec = this.f.bA;
        for (const b of this.bays) if (b.group === gi) rec.add(b.u, b.v, b.du, b.dv, 0, ENG_H);
        rec.flushQuads(g, cam, '#131315');
        this.wall(g, gr, v0, lo);
      }
      return;
    }
    // the plinth, then the machine: calm faces, a red edge when the host is offline
    box(cam, g, ENG_U0 - 4, v0 - 4, ENG_U1 - ENG_U0 + 8, ENG_DV + 8, 3, '#131315', '#101012', '#0E0E10', F.floorEdge);
    box(cam, g, ENG_U0, v0, ENG_U1 - ENG_U0, ENG_DV, ENG_H, M_TOP, M_SIDE, M_FRONT, gr.online ? M_EDGE : M_OFF, g.hair * (gr.online ? 1.5 : 2.5));
    // idle bays recede: flat, a shade under the top, no rim, no walls (a busy one is lit live)
    const rec = this.f.bA;
    for (const b of this.bays) if (b.group === gi) rec.add(b.u, b.v, b.du, b.dv, 0, ENG_H);
    rec.flushQuads(g, cam, IDLE_BAY);
    this.wall(g, gr, v0, lo);
  }

  /** The machine's wall: a slab on its back edge, its face the last 24 h (planthist.ts). */
  private wall(g: Gfx, gr: Group, v0: number, lo: boolean): void {
    const cam = this.f.cam;
    const vf = v0 + WALL_V, z0 = ENG_H, z1 = ENG_H + WALL_H;
    // the slab: its top edge and right end, then the face
    g.begin_(); poly(cam, g, [ENG_U0, v0, z1, ENG_U1, v0, z1, ENG_U1, vf, z1, ENG_U0, vf, z1]); g.fill(WALL_TOP);
    g.begin_(); poly(cam, g, [ENG_U1, v0, z0, ENG_U1, vf, z0, ENG_U1, vf, z1, ENG_U1, v0, z1]); g.fill('#141416');
    g.begin_(); poly(cam, g, [ENG_U0, vf, z0, ENG_U1, vf, z0, ENG_U1, vf, z1, ENG_U0, vf, z1]); g.fill(WALL_FACE);
    g.begin_(); poly(cam, g, [ENG_U0, vf, z0, ENG_U1, vf, z0, ENG_U1, vf, z1, ENG_U0, vf, z1]); g.stroke(gr.online ? WALL_EDGE : M_OFF, g.hair * (gr.online ? 1.2 : 2.2));
    const t = this.hist.tide(gr.id);
    // the chart takes the whole face (the slab cannot grow: past WALL_H it would hide the top of
    // the machine behind it)
    const ua = ENG_U0 + 3, ub = ENG_U1 - 3, za = z0 + 1.1, zb = z1 - 1.1;
    const U = (x: number) => ua + (ub - ua) * x, Z = (y: number) => za + (zb - za) * y;
    const P = (x: number, y: number): [number, number] => [cam.x(U(x), vf), cam.y(U(x), vf, Z(y))];
    // the time axis: a tick every 6 h (the right end is now); the base solid under data, dotted
    // across a gap (offline, or before the record began)
    g.begin_();
    for (let h = 0; h <= 4; h++) { const [x, y] = P(h / 4, 0); g.move(x, y); g.line(x, y - Math.max(2, 1.4 * cam.s)); }
    g.stroke(GAP, g.hair);
    const n = t ? t.n : 1;
    const runs = t ? dataRuns(t.busy) : [];
    g.dash(true, 2, 3);
    g.begin_();
    let at = 0;
    for (const [s, e] of runs) { if (s > at) { g.move(...P(at / n, 0)); g.line(...P(s / n, 0)); } at = e; }
    if (at < n) { g.move(...P(at / n, 0)); g.line(...P(1, 0)); }
    g.stroke(GAP, Math.max(1, g.hair * 1.2));
    g.dash(false);
    // the scale at the wall's left edge: a faint tick at half and at every slot busy
    g.begin_();
    for (const k of [0.5, 1]) { const [x, y] = P(0, k); g.move(x - Math.max(3, 2.2 * cam.s), y); g.line(x, y); }
    g.stroke(SCALE, Math.max(1, g.hair));
    if (!t) return;
    // the baseline: solid under the stretches with data (the gaps keep their dots)
    g.begin_();
    for (const [s, e] of runs) { g.move(...P(s / n, 0)); g.line(...P(e / n, 0)); }
    g.stroke(BASE, Math.max(1, g.hair * 1.2));
    // the wall's width on screen sets the detail: ~2 px a point at least
    const wpx = Math.abs(cam.x(ub, vf) - cam.x(ua, vf));
    const stride = lo ? 3 : wpx < 260 ? 2 : 1;
    const X = (i: number) => (i + 0.5) / n;
    // the tide: busy/slots filled from the base, one shape per run of data (gaps stay empty);
    // behind it, faint, the bucket's peak (how busy it got at its busiest minute)
    const area = (a: Float32Array, col: string) => {
      g.begin_();
      for (const [s, e] of runs) {
        g.move(...P(s / n, 0));
        if (e - s === 1) g.line(...P(s / n, a[s]!));
        else for (let i = s; i < e; i += stride) g.line(...P(i === s ? s / n : X(i), a[i]!));
        g.line(...P(e / n, a[e - 1]!));
        g.line(...P(e / n, 0));
        g.ctx.closePath();
      }
      g.fill(col);
    };
    if (!lo) area(t.peak, withAlpha(C.packet, 0.14));
    area(t.busy, withAlpha(C.packet, 0.42));
    g.begin_();
    for (const [s, e] of runs) {
      g.move(...P(s / n, t.busy[s]!));
      for (let i = s; i < e; i += stride) g.line(...P(X(i), t.busy[i]!));
      g.line(...P(e / n, t.busy[e - 1]!));
    }
    g.stroke(withAlpha(C.packet, 0.9), Math.max(1, g.hair * 1.3));
    // the usual: a dashed ghost at the machine's typical busy/slots (the median of its 24 h), so the
    // tide reads as busier or quieter than usual; across the span the record holds, not its gaps' lead
    const typ = typical(t);
    if (typ === typ && runs.length) {
      g.dash(true, 4, 3);
      g.begin_(); g.move(...P(runs[0]![0] / n, typ)); g.line(...P(runs[runs.length - 1]![1] / n, typ));
      g.stroke(GHOST, Math.max(1, g.hair * 1.2));
      g.dash(false);
    }
    // saturated: every slot taken at some minute of the stretch, a red tick along the base
    // (as the machine lens marks it): the machine was the bottleneck then
    g.begin_();
    let caps = 0;
    for (let i = 0; i < n; i++) {
      if (!(t.peak[i]! >= 0.999)) continue;
      let j = i;
      while (j + 1 < n && t.peak[j + 1]! >= 0.999) j++;
      g.move(...P(i / n, -0.04)); g.line(...P((j + 1) / n, -0.04));
      caps++; i = j;
    }
    if (caps) g.stroke(C.red, Math.max(1.5, g.hair * 3));
    if (lo) return;
    // the ribbons: mem (blue-gray), cpu (ink; red where ≥ 90 %)
    const ribbon = (a: Float32Array, col: string, w: number, dash: boolean, hot: boolean) => {
      const rs = dataRuns(a);
      if (!rs.length) return;
      if (dash) g.dash(true, 3, 2);
      g.begin_();
      for (const [s, e] of rs) {
        if (e - s === 1) { g.move(...P(s / n, a[s]!)); g.line(...P(e / n, a[s]!)); continue; }
        g.move(...P(X(s), a[s]!));
        for (let i = s + stride; i < e; i += stride) g.line(...P(X(i), a[i]!));
        g.line(...P(X(e - 1), a[e - 1]!));
      }
      g.stroke(col, w);
      if (dash) g.dash(false);
      if (!hot) return;
      g.begin_();
      let any = 0;
      for (let i = 0; i + 1 < n; i++) {
        const y0 = a[i]!, y1 = a[i + 1]!;
        if (!(y0 >= 0.9 || y1 >= 0.9) || y0 !== y0 || y1 !== y1) continue;
        g.move(...P(X(i), y0)); g.line(...P(X(i + 1), y1)); any++;
      }
      if (any) g.stroke(C.red, w + 0.4);
    };
    ribbon(t.mem, MEM_LINE, Math.max(1, g.hair * 1.2), false, false);
    ribbon(t.cpu, withAlpha(C.ink, 0.85), Math.max(1, g.hair * 1.3), false, true);
  }

  // ---- the live layer: hits on the walls ----
  hits(fr: LiveFrame): void {
    void fr;
    const cam = this.f.cam, c = this.f.census;
    if (c.skeleton) return;
    c.groups.forEach((gr, gi) => {
      if (!gr.engines.length) return;
      const vf = ENG_V0 + gi * ENG_STEP + WALL_V;
      // the wall as 8 boxes along it (a sheared panel: one box would cover the machine behind)
      for (let k = 0; k < 8; k++) {
        const ua = ENG_U0 + ((ENG_U1 - ENG_U0) * k) / 8, ub = ENG_U0 + ((ENG_U1 - ENG_U0) * (k + 1)) / 8;
        const x0 = cam.x(ua, vf), x1 = cam.x(ub, vf), y0 = cam.y(ua, vf, ENG_H + WALL_H), y1 = cam.y(ub, vf, ENG_H);
        this.f.hit(x0, Math.min(y0, y1), x1 - x0, Math.abs(y1 - y0), 'machine', String(gi), `${gr.name} · 24 h`);
      }
    });
  }

  // ---- the live layer: the intake's queue and gate, the lit bays, the gauges, the split beam,
  // the spurs' returns ----
  private litB = new Map<string, { floor: BoxBatch; rim: BoxBatch }>();
  private spurKey = -1;
  private spurN = new Map<string, number>();

  live(g: Gfx, fr: LiveFrame): void {
    const cam = this.f.cam, w = this.f.world, c = this.f.census, st = this.f.stat, t = fr.t, q = fr.q, now = fr.now;
    const offX = (x: number) => x < -24 || x > cam.W + 24;
    this.drawIntake(g, fr);
    // the consumption engine: busy bays lit in their job's group hue, their progress along the
    // front lip (red past 1.5× expected), the job's crate riding it. A stress copy's slots are
    // busy by a hash of (slot, 3 s); bays narrower than 6 px drop their rims and crates (LOD1).
    const prog = this.f.bC, crates = this.f.bD, lips = this.f.bB;
    const progRed: number[] = [];
    let selBay: Bay | null = null;
    st.bays = 0;
    const F_ = c.factor;
    const G = this.f.w2.on ? floorGroups() : null;
    for (const v of this.litB.values()) { v.floor.n = 0; v.rim.n = 0; }
    for (const b of this.bays) {
      const gr = c.groups[b.group];
      const virtual = F_ > 1 && !b.pid && !gr?.hosted && b.slot >= Math.round((gr?.slots ?? 0) / F_) && this.f.stress.busy(b.group, b.slot, t);
      if (!b.pid && !virtual) continue;
      if (offX(cam.x(b.u + b.du / 2, b.v + b.dv / 2))) continue;
      st.bays++;
      const p = b.pid ? w.pipelines.get(b.pid) : undefined;
      const hex = p && G ? G.hex(G.laneOfPipeline(p)) : '#8A7146';
      let L = this.litB.get(hex);
      if (!L) this.litB.set(hex, (L = { floor: new BoxBatch(), rim: new BoxBatch() }));
      L.floor.add(b.u, b.v, b.du, b.dv, 0, ENG_H);
      L.rim.add(b.u, b.v, b.du, b.dv, 0, ENG_H);
      let u01: number, over = false;
      if (virtual) u01 = this.f.stress.progress(b.group, b.slot, t);
      else {
        const exp = p?.expected_ms ?? w.repos.get(p?.repo ?? '')?.p50_build_ms ?? w.stats.p50_build_ms ?? 0;
        const el = p?.started ? Math.max(0, now - p.started) : 0;
        u01 = exp > 0 ? clamp(el / exp, 0.03, 1) : 0.5;
        over = exp > 0 && el > exp * 1.5;
      }
      if (over) { progRed.push(b.u, b.v + b.dv + 4, b.du * u01); lips.add(b.u, b.v + b.dv - 1.2, b.du, 1.2, 0, ENG_H); }
      else if (!virtual || q < 4) prog.add(b.u, b.v + b.dv + 4, b.du * u01, 5, 0, ENG_H);
      // the job's crate rides the bay with its progress
      crates.crate(b.u + 6 + (b.du - 12) * u01, b.v + b.dv / 2, Math.min(10, b.du * 0.8), ENG_H - 3);
      if (!virtual) {
        this.f.hit(cam.x(b.u, b.v + b.dv), cam.y(b.u, b.v, ENG_H) - 4, (b.du * 0.86 + b.dv * 0.4) * cam.s, (b.dv * 0.66 + b.du * 0.19) * cam.s + 10, 'pipeline', b.pid, pipeWords(p));
        if (this.f.selected === b.pid) selBay = b;
      }
    }
    const bayFine = (this.bays[0]?.du ?? 0) * cam.s >= 6;
    const rimA = 0.72 + 0.2 * breathe(t);
    for (const [hex, L] of this.litB) {
      if (!L.floor.n) continue;
      let lt = this.litCache.get(hex);
      if (!lt) this.litCache.set(hex, (lt = lit(hex)));
      L.floor.flushQuads(g, cam, lt.floor);
      if (bayFine) L.rim.flushQuads(g, cam, withAlpha(lt.rim, rimA), true, g.hair * 2); else L.rim.n = 0;
    }
    // the progress rails: a dark track under each busy bay's lip, amber elapsed / expected, red over
    prog.flushQuads(g, cam, C.packet);
    for (let i = 0; i < progRed.length; i += 3) prog.add(progRed[i], progRed[i + 1], progRed[i + 2], 5, 0, ENG_H);
    prog.flushQuads(g, cam, C.red);
    lips.flushQuads(g, cam, C.red);
    if (bayFine) crates.flush(g, cam, F.crateTop, F.crateSide, F.crateFront, '', 1, q >= 2 ? 1 : 3); else crates.n = 0;
    if (selBay) ring(cam, g, selBay.u + selBay.du / 2, selBay.v + selBay.dv / 2, 14, ENG_H);
    // gauges: the engines' cpu and mem towers (a sample every few seconds; a few boxes)
    this.drawGauges(g);
    this.drawBeam(g);
    this.drawReturns(g, q, t);
  }

  /** The intake: a ribbon per lane under its queued crates (one per waiting run, the oldest at
   *  the mouth), each crate's stretch coloured by its wait; a pile past 16; the mouth's gate shut
   *  while every self-hosted slot is busy and the roadrunner lane waits. */
  private drawIntake(g: Gfx, fr: LiveFrame): void {
    const cam = this.f.cam, w = this.f.world, c = this.f.census, now = fr.now, q = fr.q;
    const p50 = w.stats.p50_queue_ms || 0;
    const extra = Math.max(0, c.waiting - c.rr.length - c.gha.length);
    const span = INTAKE_U1 - INTAKE_U0 - 14;
    const crates = this.f.bA;
    for (let lane = 0; lane < 2; lane++) {
      const ids = lane ? c.gha : c.rr;
      const n = ids.length + (lane ? 0 : extra);
      if (!n) continue;
      const v = LANE_V[lane];
      const row = Math.min(n, 16);
      const step = row <= 7 ? 11 : span / row;
      const head = INTAKE_U1 - 8;
      for (let k = 0; k < row; k++) {
        const id = ids[k];
        const p = id ? w.pipelines.get(id) : undefined;
        const age = p ? Math.max(0, now - p.created) : c.oldestWait;
        const u = head - k * step;
        g.begin_(); quad(cam, g, u - step / 2, v - 6.5, u + step / 2, v + 6.5, 0.4); g.fill(withAlpha(waitColour(age, p50), 0.62));
        crates.crate(u, v, Math.min(8, step * 0.82));
        if (id) this.f.hit(cam.x(u, v) - 7, cam.y(u, v, 8) - 7, 14, 14, 'pipeline', id, pipeWords(p));
      }
      // past 16: the rest piled on the last crate, a layer per doubling
      if (n > 16) {
        const tail = head - (row - 1) * step, layers = Math.min(6, Math.ceil(Math.log2(n - 15)));
        for (let j = 1; j <= layers; j++) crates.crate(tail, v, 7, 2 + j * 5.8);
      }
    }
    crates.flush(g, cam, F.dockTop, F.dockSide, F.dockFront, '', 1, q >= 2 ? 1 : 3);
    // the mouth's gate: shut (raised, amber) while every self-hosted slot is taken and runs wait
    let slots = 0, busy = 0;
    for (const gr of c.groups) if (!gr.hosted) { slots += gr.slots; busy += gr.running.length; }
    const shut = slots > 0 && busy >= slots && c.rr.length + extra > 0;
    if (shut) box(cam, g, GATE_U - 0.6, 278, 1.8, 26, 8, '#C99A52', '#8E6E3E', '#B48C4E', '#E5B567', g.hair);
    else { g.begin_(); quad(cam, g, GATE_U - 0.6, 279, GATE_U + 1.2, 303, 0.6); g.fill('#2E2E32'); }
  }

  /** cpu and mem fill each machine's two towers (gray; a red cap over 90 %); no reading: the
   *  slots' utilization in a darker gray. */
  private drawGauges(g: Gfx): void {
    const cam = this.f.cam, c = this.f.census;
    const gauge = this.f.bA, util = this.f.bB, cap = this.f.bC;
    c.groups.forEach((gr, gi) => {
      if (gr.hosted) return;
      const v0 = ENG_V0 + gi * ENG_STEP;
      const used = gr.slots ? gr.running.length / gr.slots : 0;
      const vals = [gr.cpu >= 0 ? gr.cpu : -1, gr.mem >= 0 ? gr.mem : -1];
      vals.forEach((val, k) => {
        const u0 = ENG_U1 + 12 + k * 13;
        if (val < 0) {
          if (k === 0) util.add(u0, v0 + 34, 9, 9, 2 + 60 * used);
          return;
        }
        const hh = 2 + 60 * clamp(val / 100, 0, 1);
        gauge.add(u0, v0 + 34, 9, 9, hh);
        if (val >= 90) cap.add(u0, v0 + 34, 9, 9, 0, hh);
      });
    });
    util.flush(g, cam, '#3E3E42', '#2C2C30', '#262629', '', 1, 3);
    gauge.flush(g, cam, '#9A9A9E', '#6A6A6E', '#58585C', '', 1, 3);
    cap.flushQuads(g, cam, C.red);
  }

  /** The scanner's split beam: its crossbar lit pass (green-gray, from the back) and fail (red,
   *  the front, over the return conveyor), each ∝ its share of the last hour's finishes, a faint
   *  light curtain under each part. Nothing finished this hour: the bar stays dark. */
  private drawBeam(g: Gfx): void {
    const cam = this.f.cam, fl = this.f.census.flow;
    const fin = fl.finished, failed = Math.min(fl.failed, fl.finished);
    if (fin <= 0) return;
    const L0 = 32, L1 = 596, vs = L0 + (L1 - L0) * ((fin - failed) / fin);
    g.begin_(); poly(cam, g, [SCAN_U, L0, 3, SCAN_U, vs, 3, SCAN_U, vs, 55, SCAN_U, L0, 55]); g.fill(withAlpha(OK_BEAM, 0.07));
    if (failed) { g.begin_(); poly(cam, g, [SCAN_U, vs, 3, SCAN_U, L1, 3, SCAN_U, L1, 55, SCAN_U, vs, 55]); g.fill(withAlpha(C.red, 0.13)); }
    g.begin_(); quad(cam, g, SCAN_U - 1.8, L0, SCAN_U + 1.8, vs, 56.4); g.fill(withAlpha(OK_BEAM, 0.5));
    if (failed) {
      g.begin_(); quad(cam, g, SCAN_U - 2.6, vs, SCAN_U + 2.6, L1, 56.4); g.fill(C.red);
      // the split: a bright line down the curtain where the beam divides
      g.begin_(); g.move(cam.x(SCAN_U, vs), cam.y(SCAN_U, vs, 56)); g.line(cam.x(SCAN_U, vs), cam.y(SCAN_U, vs, 3)); g.stroke(withAlpha(C.ink, 0.5), 1);
    }
  }

  /** The riser's slats drift up toward the docks while failures came home this hour (as the
   *  floor's belts do, floor.ts); the spurs that carried them glow red, brighter with more. */
  private drawReturns(g: Gfx, q: number, t: number): void {
    if (q >= 4) return;
    const c = this.f.census, w = this.f.world, cam = this.f.cam;
    const lanes = this.lanes();
    if (c.flow.failed > 0 && q < 2 && lanes.length) {
      const top = Math.min(...lanes.map((l) => this.spurAt(l)));
      const off = this.f.reduced ? 0 : ((t / 1000) * beltSpeedPx(c.flow.failed) / cam.fitS) % 12;
      g.begin_();
      for (let v = RETURN_V - off; v > top; v -= 12) { g.move(cam.x(RISER_U - 2.2, v), cam.y(RISER_U - 2.2, v, 0.6)); g.line(cam.x(RISER_U + 2.2, v), cam.y(RISER_U + 2.2, v, 0.6)); }
      g.stroke(F.slat, Math.max(1, cam.s * 1.4));
    }
    if (this.spurKey !== c.at) {
      this.spurKey = c.at;
      this.spurN.clear();
      const G = this.f.w2.on ? floorGroups() : null;
      for (const x of c.failing) {
        const p = w.pipelines.get(x.id);
        const k = G ? (p ? G.laneOfPipeline(p) : G.laneOfRepo(x.repo)) : w.orgOf(x.repo);
        this.spurN.set(k, (this.spurN.get(k) ?? 0) + 1);
      }
    }
    if (!this.spurN.size) return;
    for (const l of lanes) {
      const n = this.spurN.get(l.id);
      if (!n) continue;
      const sv = this.spurAt(l);
      g.begin_(); quad(cam, g, DOCK_U1, sv - 1.6, RISER_U + 2.6, sv + 1.6, 0.6); g.fill(withAlpha(C.red, clamp(0.35 + 0.12 * n, 0.35, 0.9)));
    }
  }

  // ---- the machine's name (labels.ts calls in: one line) ----
  /** The machine's label: its name only (its numbers are the wall, the lit bays and the gauges),
   *  red when the host is offline, ON ITS OWN SHELL at the left end of its front edge (`nameSpots`).
   *  The placer may only slide it along that edge; with no free spot there it is dropped, never
   *  floated. True: handled (drawn or dropped). */
  label(g: Gfx, gr: Group, gi: number): boolean {
    const v0 = ENG_V0 + gi * ENG_STEP;
    const name = gr.hosted ? 'GitHub Actions' : gr.name;
    const wv = g.width(name, SMALL, true);
    const at = this.nameSpots(gi, wv, NAME_H).find(([x, y]) => this.f.placeAt(x, y, wv, NAME_H, 0, false));
    if (!at) return true;
    const [x, y] = at;
    g.fillRect(x - 3, y - 11, wv + 6, 15, withAlpha(C.canvas, 0.82));
    g.text(name, x, y, !gr.online ? C.redText : gr.running.length ? C.ink : C.ink2, SMALL, true);
    this.f.hit(x - 3, y - 11, wv + 6, 15, 'engine', `915,${v0 + ENG_DV / 2},2.4`, name);
    return true;
  }

  /** Where machine `gi`'s name (a `w` × `h` px box; [x, baseline y] each) may sit, best first:
   *  the left end of its shell's FRONT edge, in screen space after the projection, then a few
   *  steps right along that edge. The front FACE when enough of it shows (the bottom-left of the
   *  face, inside it); else (the next machine's wall rises in front of it: the view's geometry
   *  hides a walled neighbour's front face at every zoom) the shell's TOP, just inside its front
   *  edge. Every box stays on the shell and inside the floor's visible area; none: []. */
  nameSpots(gi: number, w: number, h: number): [number, number][] {
    const cam = this.f.cam, c = this.f.census;
    const v0 = ENG_V0 + gi * ENG_STEP, vf = v0 + ENG_DV;
    const slope = UY / UX; // the front edges fall this much (px per px) to the right
    const xl = cam.x(ENG_U0, vf), xr = cam.x(ENG_U1, vf);
    const faceTop = cam.y(ENG_U0, vf, ENG_H);
    let faceBot = cam.y(ENG_U0, vf, 0);
    // what stands in front: the next machine's top (and its wall), at our front-left's column
    const nx = c.groups[gi + 1];
    if (nx) {
      const vn = v0 + ENG_STEP, un = ENG_U0 + ((vf - vn) * VX) / UX;
      faceBot = Math.min(faceBot, cam.y(un, vn, ENG_H + (nx.engines.length ? WALL_H : 0)));
    }
    const pad = 3;
    // the face: a box whose bottom-left sits on the face's lowest visible line and whose top-right
    // clears the face's top edge (both fall to the right)
    const onFace = faceBot - faceTop >= h + pad * 2 + slope * (w + 6);
    const x0 = Math.round(xl + (onFace ? 6 : 0.55 * (h + pad) + 6));
    const y0 = Math.round(onFace ? faceBot - pad - 1 : faceTop - pad);
    const top = 72, bottom = cam.H - 58 - 4, right = cam.W - 4; // under the top row, over the time strip
    const out: [number, number][] = [];
    for (const dx of [0, 36, 72, 108]) {
      const x = x0 + dx, y = Math.round(y0 + slope * dx);
      if (x + w + 3 > xr - 4 || x - 3 < 4 || x + w + 3 > right) continue;
      if (y - h < top || y + 4 > bottom) continue;
      out.push([x, y]);
    }
    return out;
  }

  // ---- the job zoom (FACTORY-SPEC §F "job": z ≥ 4 on the plant) ----
  /** A layer of its own after the labels (layers.ts): at z ≥ 4 over a machine with a busy bay,
   *  that bay OPENS over the machine's top (the lens's bay when it is one of the machine's, else
   *  the busy bay nearest the screen's centre) and the rest of the floor dims to ~15 %. */
  jobLive(g: Gfx, fr: LiveFrame): void {
    const cam = this.f.cam, c = this.f.census, w = this.f.world;
    this.job = '';
    if (cam.zoom < 4 || c.skeleton) return;
    // the point of the machines' top plane under the screen's centre
    const [cu, cv] = cam.unproject(cam.W / 2, cam.H / 2 + ENG_H * cam.s);
    if (cu < ENG_U0 - 40 || cu > ENG_U1 + 40) return;
    let gi = -1;
    c.groups.forEach((_g, i) => { const v0 = ENG_V0 + i * ENG_STEP; if (cv >= v0 - 16 && cv <= v0 + ENG_DV + 16) gi = i; });
    if (gi < 0) return;
    const top = this.f.lens.topLens;
    let bay: Bay | null = null;
    if (top?.kind === 'bay') {
      const [lg, ls] = top.id.split(',').map(Number);
      bay = this.bays.find((b) => b.group === lg && b.slot === ls && !!b.pid) ?? null;
      if (bay && bay.group !== gi) bay = null;
    }
    if (!bay) {
      let best = 1e9;
      for (const b of this.bays) {
        if (b.group !== gi || !b.pid) continue;
        const d = Math.abs(b.u + b.du / 2 - cu);
        if (d < best) { best = d; bay = b; }
      }
    }
    const p = bay ? w.pipelines.get(bay.pid) : undefined;
    if (!bay || !p) return;
    this.job = bay.pid;
    this.drawJob(g, fr, p, gi);
  }

  private drawJob(g: Gfx, fr: LiveFrame, p: Pipeline, gi: number): void {
    const cam = this.f.cam, c = this.f.census, now = fr.now, t = fr.t;
    const v0 = ENG_V0 + gi * ENG_STEP, gr = c.groups[gi]!;
    // everything else dims to ~15 %; the machine's wall comes back crisp
    g.fillRect(0, 0, cam.W, cam.H, withAlpha(C.canvas, 0.85));
    if (gr.engines.length) this.wall(g, gr, v0, false);
    // the opened bay: the machine's top as one panel, edged and banded in the job's group hue
    const hex = this.f.w2.on ? floorGroups().hex(floorGroups().laneOfPipeline(p)) : '#8A7146';
    // the time axis: the run's start → now (or its expected end, or its last step), a margin
    const t0 = p.started ?? p.created, exp = p.expected_ms ?? 0;
    const wfs = (p.workflows ?? []).filter((wf) => (wf.steps ?? []).length);
    let tEnd = Math.max(now, t0 + 5000);
    let pending = 0;
    for (const wf of wfs) for (const s of wf.steps) { if (s.finished) tEnd = Math.max(tEnd, s.finished); if (!s.started) pending++; }
    if (exp > 0) tEnd = Math.max(tEnd, t0 + exp * 1.12);
    if (pending) tEnd = Math.max(tEnd, now + (now - t0) * 0.06 * Math.min(pending, 5));
    tEnd += (tEnd - t0) * 0.03;
    const nom = (tEnd - t0) * 0.035;
    // rows: each workflow's steps packed into sub-rows by overlap (parallel steps stack)
    type Chip = { s: Step; wf: string; a: number; b: number; row: number; run: boolean };
    const lanes: { name: string; state: string; rows: number; chips: Chip[] }[] = [];
    let rows = 0;
    for (const wf of wfs) {
      const ends: number[] = [];
      const chips: Chip[] = [];
      let cursor = Math.max(now, t0);
      const sorted = wf.steps.slice().sort((x, y) => (x.started ?? 9e15) - (y.started ?? 9e15));
      for (const s of sorted) {
        const run = s.state === 'running';
        let a: number, b: number;
        if (s.started) { a = s.started; b = s.finished ?? (run ? Math.max(now, a) : a + nom); }
        else { a = cursor; b = a + nom; cursor = b + nom * 0.15; }
        let row = ends.findIndex((e) => e <= a + 1);
        if (!s.started) row = 0;
        if (row < 0) { row = ends.length; ends.push(b); } else ends[row] = Math.max(ends[row]!, b);
        chips.push({ s, wf: wf.name, a, b, row, run });
      }
      const n = Math.max(1, ends.length);
      lanes.push({ name: wf.name, state: wf.state, rows: n, chips });
      rows += n;
    }
    // the panel: as deep as its conveyors need (a bay of the machine's depth at most)
    const titleV = 12, gap = 3, foot = 9;
    const pv0 = v0 + 5, gaps = gap * Math.max(0, lanes.length - 1);
    const rh = Math.min(18, Math.max(4, (ENG_DV - 8 - titleV - foot - gaps) / Math.max(1, rows)));
    const pv1 = Math.min(v0 + ENG_DV - 3, pv0 + titleV + rows * rh + gaps + foot);
    // …spanning the machine's top where it is on screen (at 5× the machine is wider than it)
    const uAt = (x: number, v: number) => ((x - cam.ox) / cam.s - VX * v) / UX;
    const pu0 = Math.max(ENG_U0 + 3, Math.min(ENG_U1 - 60, uAt(24, pv1))), pu1 = Math.min(ENG_U1 - 3, Math.max(pu0 + 60, uAt(cam.W - 24, pv0)));
    box(cam, g, pu0, pv0, pu1 - pu0, pv1 - pv0, ENG_H, '#141416', M_SIDE, M_FRONT, withAlpha(hex, 0.9), Math.max(1, g.hair * 2));
    g.begin_(); quad(cam, g, pu0, pv0, pu1, pv0 + 2.4, ENG_H); g.fill(hex);
    // the workflow names' column (screen-aligned words, so its width is in px)
    let nameW = 0;
    for (const wf of wfs) nameW = Math.max(nameW, g.width(wf.name, SMALL, true));
    const ua = pu0 + 8 + (nameW + 16) / (UX * cam.s), ub = pu1 - 8;
    const U = (ms: number) => ua + ((ub - ua) * (ms - t0)) / (tEnd - t0);
    const va = pv0 + titleV, vb = pv1 - foot;
    // the title: the run, its elapsed time against its expected one
    const el = Math.max(0, now - t0), over = exp > 0 && el > exp * 1.5;
    {
      const x = cam.x(pu0 + 6, pv0 + 9), y = cam.y(pu0 + 6, pv0 + 9, ENG_H) + 4;
      g.fillRect(x - 4, y - 13, Math.min(cam.x(pu1, pv0) - x, 520), 18, withAlpha('#141416', 0.9));
      g.runs([[p.repo.split('/')[1] ?? p.repo, C.ink, true], [` #${p.number}`, C.ink3], [p.branch ? `  ${p.branch}` : '', C.ink3], [`  ${dur(el)}`, over ? C.redText : C.amberText, true], [exp ? ` of ~${dur(exp)}` : '', C.ink3]], x, y, SMALL, Math.max(80, cam.x(pu1, pv0) - x - 8));
    }
    // the conveyors: one bed per workflow; a running one's slats move
    let v = va;
    const beds: [number, number, boolean][] = [];
    for (const L of lanes) { beds.push([v, v + L.rows * rh, L.state === 'running']); v += L.rows * rh + gap; }
    g.begin_();
    for (const [a, b] of beds) quad(cam, g, ua - 2, a - 0.6, ub + 2, b + 0.6, ENG_H + 0.1);
    g.fill('#0D0D0F');
    g.begin_();
    for (const [a, b] of beds) quad(cam, g, ua - 2, a - 0.6, ub + 2, b + 0.6, ENG_H + 0.1);
    g.stroke('#2E2E33', g.hair * 1.2);
    const off = this.f.reduced ? 0 : ((t / 1000) * 5) % 6;
    g.begin_();
    for (const [a, b, run] of beds) {
      if (!run) continue;
      for (let u = ua + off; u < ub; u += 6) { g.move(cam.x(u, a), cam.y(u, a, ENG_H + 0.15)); g.line(cam.x(u, b), cam.y(u, b, ENG_H + 0.15)); }
    }
    g.stroke('#202024', g.hair * 1.2);
    // markers across the beds: expected (dashed), 1.5× expected (red dashed), now (amber)
    const mark = (ms: number, col: string, dash: boolean, w = 1) => {
      const u = U(ms);
      if (u < ua - 0.5 || u > ub + 0.5) return;
      if (dash) g.dash(true, 3, 3);
      g.begin_(); g.move(cam.x(u, va - 3), cam.y(u, va - 3, ENG_H + 0.3)); g.line(cam.x(u, vb + 2), cam.y(u, vb + 2, ENG_H + 0.3)); g.stroke(col, w);
      if (dash) g.dash(false);
    };
    if (exp > 0) { mark(t0 + exp, C.ink3, true); mark(t0 + exp * 1.5, withAlpha(C.red, 0.8), true); }
    mark(now, withAlpha(C.packet, 0.8), false, 1.2);
    // the chips: on the time axis, state-coloured; running amber (to now), failed red with its
    // exit code, cached hollow, pending dashed
    const ok = this.f.bA, run = this.f.bB, bad = this.f.bC;
    const hollow: [number, number, number, number, string, boolean][] = [];
    const words: [string, number, number, string, number][] = [];
    v = va;
    for (const L of lanes) {
      // the workflow's name at its conveyor's start, its state as a square
      const mid = v + Math.min(L.rows, 1) * rh * 0.5;
      const nx = cam.x(pu0 + 6, mid), ny = cam.y(pu0 + 6, mid, ENG_H) + 4;
      const scol = L.state === 'failure' || L.state === 'error' ? C.red : L.state === 'running' ? C.packet : L.state === 'success' ? STEP_OK : '#55555A';
      g.fillRect(nx, ny - 8, 7, 7, scol);
      g.text(L.name, nx + 11, ny, L.state === 'pending' ? C.ink3 : C.ink2, SMALL, true);
      for (const ch of L.chips) {
        const u0 = Math.max(ua, U(ch.a)), u1 = Math.max(u0 + 1.4, Math.min(ub, U(ch.b)));
        const r0 = v + ch.row * rh + 0.9, r1 = r0 + rh - 1.8;
        const st = ch.s.state, red = st === 'failure' || st === 'error';
        if (ch.s.cached || st === 'pending' || st === 'skipped' || st === 'canceled' || st === 'blocked') {
          hollow.push([u0, r0, u1, r1, red ? C.red : ch.s.cached ? (st === 'success' ? '#8FA894' : C.ink3) : '#55555A', !ch.s.cached]);
        } else (red ? bad : ch.run ? run : ok).add(u0, r0, u1 - u0, r1 - r0, 1.4, ENG_H + 0.2);
        // its hit: the step's facts on hover, the run's journey on click
        const xs = [cam.x(u0, r1), cam.x(u1, r0)], ys = [cam.y(u0, r0, ENG_H + 1.6), cam.y(u1, r1, ENG_H)];
        const ex = ch.s.exit_code;
        const took = ch.s.started ? dur((ch.s.finished ?? now) - ch.s.started) : '';
        this.f.hit(Math.min(...xs), Math.min(...ys), Math.abs(xs[1]! - xs[0]!), Math.abs(ys[1]! - ys[0]!), 'pipeline', p.id ?? '', `${ch.wf} › ${ch.s.name} · ${st}${ex !== undefined && ex !== 0 ? ` · exit ${ex}` : ''}${took ? ` · ${took}` : ''}`);
        // words: the step's name inside when it fits; a non-zero exit code beside a failure
        const cx = cam.x(u0 + 0.8, (r0 + r1) / 2), cy = cam.y(u0 + 0.8, (r0 + r1) / 2, ENG_H + 1.6) + 4;
        const room = (u1 - u0 - 1.6) * UX * cam.s;
        const label = ch.run && ch.s.started ? `${ch.s.name} ${dur(now - ch.s.started)}` : ch.s.name;
        if (rh * 0.66 * cam.s >= 13 && g.width(label, SMALL) <= room) words.push([label, cx, cy, red ? C.ink : ch.run ? '#241A0A' : st === 'success' && !ch.s.cached ? C.ink : C.ink2, 0]);
        if (red && ex !== undefined && ex !== 0) words.push([`exit ${ex}`, cam.x(u1 + 1, (r0 + r1) / 2) + 3, cy, C.redText, 1]);
      }
      v += L.rows * rh + gap;
    }
    ok.flush(g, cam, STEP_OK, '#3E4D42', '#4A5B4E', '', 1, 3);
    run.flush(g, cam, C.packet, F.crateSide, F.crateFront, '', 1, 3);
    bad.flush(g, cam, C.red, F.redSide, F.redFront, '', 1, 3);
    for (const [u0, r0, u1, r1, col, dash] of hollow) {
      if (dash) g.dash(true, 3, 2);
      g.begin_(); quad(cam, g, u0, r0, u1, r1, ENG_H + 0.4); g.stroke(col, Math.max(1, g.hair * 1.6));
      if (dash) g.dash(false);
    }
    for (const [s, x, y, col, bold] of words) g.text(s, x, y, col, SMALL, bold === 1);
    // the run's progress rail along the panel's front lip: elapsed / expected, red past 1.5×
    const pu = Math.min(ub, U(now));
    g.begin_(); quad(cam, g, ua, pv1 - 4.5, ub, pv1 - 1.5, ENG_H + 0.2); g.fill('#0D0D0F');
    g.begin_(); quad(cam, g, ua, pv1 - 4.5, pu, pv1 - 1.5, ENG_H + 0.25); g.fill(over ? C.red : C.packet);
  }
}

/** The deploy tracks' traffic: deploys in flight sit on their track, nearer the city the longer
 *  they have run, a ring on the building they head for. */
export class Tracks implements Layer {
  readonly name = 'tracks';

  constructor(readonly f: Factory) {}

  live(g: Gfx, fr: LiveFrame): void {
    const cam = this.f.cam, w = this.f.world, c = this.f.census, q = fr.q, now = fr.now;
    // deploys in flight sit on their track, nearer the city the longer they have run
    const lanes = [0, 0, 0];
    const dep = this.f.bA;
    g.begin_();
    let rings = 0;
    for (const d of [...c.deploying].sort((a, b) => a.started - b.started)) {
      const b = this.f.blockAt.get(d.app);
      // the oldest leads; the ones behind it queue a crate's length back on the same track
      const k = clamp(Math.min((now - d.started) / 90_000, 0.92 - lanes[d.via]++ * 0.09), 0.05, 0.92);
      const v = TRACK_V[d.via];
      const u = SCAN_U + 16 + (TRACK_U1 - SCAN_U - 24) * k;
      dep.crate(u, v, 8);
      if (d.sha.charCodeAt(0) !== 126) this.f.hit(cam.x(u, v) - 7, cam.y(u, v, 8) - 7, 14, 14, 'commit', `${w.apps.get(d.app)?.repo ?? ''}@${d.sha}`, `deploy ${d.app}`);
      if (b) { g.circle(cam.x(b.u + b.d / 2, b.v + b.d / 2), cam.y(b.u + b.d / 2, b.v + b.d / 2, b.h + 1.5), 3.2); rings++; }
    }
    if (rings) g.stroke(withAlpha(C.packet, 0.9), 1);
    dep.flush(g, cam, F.crateTop, F.crateSide, F.crateFront, '', 1, q >= 2 ? 1 : 3);
  }
}

/** The plant's 24 h histories reach back this far (the wall's span). */
export const WALL_SPAN_MS = DAY_MS;
export type { Tide };
