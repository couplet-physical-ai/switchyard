// THE FACTORY FLOOR (concept B; DESIGN.md "Factory"). The whole software factory as a 2.5-D
// isometric floor seen from above, flowing left → right through eight stages:
//
//   sources (org docks) → PR yard (stacks by phase × age, bot pallets) → merge gate → main-line
//   rails (one per org, merged commits as cars) → intake (a holding belt) → THE CONSUMPTION
//   ENGINE (one machine per host, its slots as lit bays) → the test scanner (failures kicked
//   onto the return conveyor along the front edge) → three deploy tracks → the city of apps.
//
// Two canvas layers: `factoryFloor` (the floor, belts, machines, stacks, the city: redrawn only
// when the camera or the fleet's shape moved) and `factoryLive` (belt motion, crates, bays,
// gauges, health lights, heat, labels, the journey, the drawer, the time strip: every frame
// while anything moves). Every word is drawn in screen space at a projected anchor.

import type { Ctx2D, Frame } from '../../app.contract.d.ts';
import type { Event, Journey, Pipeline } from '../wire.ts';
import type { Timeline } from '../timeline.ts';
import type { World } from '../world.ts';
import { BOTS } from '../world.ts';
import { Budget } from '../yard/budget.ts';
import { Gfx } from '../yard/gfx.ts';
import { C, TAU, clamp, font, withAlpha } from '../yard/theme.ts';
import { AGES, AGE_WORDS, Census, PHASES, failingStep, short } from './census.ts';
import { Cam, LU, LV } from './iso.ts';

// ---- palette (canvas-only shades of the app's ramp) ------------------------------------------
const F = {
  floor: '#0C0C0D',
  floorEdge: '#1E1E20',
  grid: '#141416',
  gridMajor: '#19191B',
  zone: '#232326',
  top: '#222224',
  topHi: '#29292C',
  side: '#18181A',
  front: '#141416',
  edge: '#3A3A3E',
  edgeHi: '#4E4E53',
  belt: '#121214',
  beltEdge: '#2B2B2F',
  slat: '#1F1F22',
  slatHot: '#2E2C28',
  rail: '#3A3A3E',
  sleeper: '#1D1D20',
  bay: '#0F0F10',
  bayLit: '#2A2216',
  crateTop: '#E5B567',
  crateFront: '#B48C4E',
  crateSide: '#8E6E3E',
  dockTop: '#8A7146',
  dockFront: '#6B5838',
  dockSide: '#56472E',
  redTop: '#E06464',
  redFront: '#B04848',
  redSide: '#8A3838',
  light: '#5A6E5F',
} as const;

const MONO = 12;
const SMALL = 12;
const TITLE = 15;

// ---- the floor plan (world units) ------------------------------------------------------------
const DOCK_U0 = 10, DOCK_U1 = 64;
const COLLECT_U = 104;
const AISLE_V = 385;
const YARD_U0 = 122, YARD_U1 = 426;
const ROW_U = [153, 227, 301, 375];
const ROW_DU = 46;
const AGE_V = [470, 398, 326, 254, 182, 110];
const STACK_DV = 46;
const PALLET_V = 560;
const GATE_U = 442;
const RAIL_U0 = 456, RAIL_U1 = 640;
const RAIL_V = [130, 210, 290, 370, 450];
const INTAKE_U0 = 662, INTAKE_U1 = 748;
const LANE_V = [276, 306];
const DIST_U = 762;
const ENG_U0 = 776, ENG_U1 = 1052;
const ENG_V0 = 34, ENG_STEP = 146, ENG_DV = 116, ENG_H = 30;
const SCAN_U = 1104;
const TRACK_V = [210, 330, 450];
const TRACK_U1 = 1222;
const CITY_U0 = 1232, CITY_U1 = 1494, CITY_V0 = 22, CITY_V1 = 610;
const RETURN_V = 626;

const VIAS = ['roadrunner', 'gha', 'gha_fallback'] as const;
const VIA_WORDS: Record<string, string> = { roadrunner: 'roadrunner', gha: 'gha', gha_fallback: 'fallback' };

type Pt = [number, number];
type Crate = {
  id: string; kind: 'commit' | 'pipeline' | 'pr' | 'deploy'; route: Pt[]; len: number; cum: number[];
  t0: number; dur: number; red: boolean; label: string; org: string; hold: number;
};
type HitBox = { x: number; y: number; w: number; h: number; kind: string; id: string; label: string };
type Label = { x: number; y: number; w: number; h: number };
type Bay = { u: number; v: number; du: number; dv: number; group: number; slot: number; pid: string };
type Block = { id: string; u: number; v: number; d: number; h: number; district: number };

export class Factory {
  readonly cam = new Cam();
  readonly census = new Census();
  readonly budget = new Budget();
  private gf = new Gfx();
  private gl = new Gfx();
  private crates: Crate[] = [];
  private pulses = new Map<string, { t: number; red: boolean }>();
  private bays: Bay[] = [];
  private blocks: Block[] = [];
  private blockAt = new Map<string, Block>();
  private districtBox: { team: string; u0: number; v0: number; u1: number; v1: number; n: number }[] = [];
  private hits: HitBox[] = [];
  private labels: Label[] = [];
  private floorSig = '';
  private cityKey = '';
  selected = '';
  selKind = '';
  journey: Journey | null = null;
  journeyFor = '';
  reduced = false;
  /** The last pointer position (screen px), the wheel's zoom anchor. */
  px = -1;
  py = -1;
  private wheelSeen = 0;
  private drag: { x: number; y: number; moved: boolean } | null = null;
  hoverId = '';
  offsetMin = 0;
  private lastT = 0;
  /** Logged once per layout for drivers (a busy bay's screen position). */
  private logged = '';
  span = 'live';

  constructor(public tl: Timeline) {}

  get world(): World { return this.tl.world; }

  // ---- events → crates -----------------------------------------------------------------------
  onEvent(e: Event, w: World, t: number): void {
    if (this.reduced) return;
    if (this.crates.length > 160) this.crates.splice(0, this.crates.length - 160);
    const orgOf = (repo: string) => w.orgOf(repo);
    switch (e.k) {
      case 'push': {
        const org = e.bot || e.author?.endsWith('[bot]') ? BOTS : orgOf(e.repo);
        const main = e.branch === (w.repos.get(e.repo)?.default_branch ?? 'main');
        const dv = this.dockV(org);
        const route: Pt[] = [[DOCK_U1 - 6, dv], [COLLECT_U, dv], [COLLECT_U, AISLE_V]];
        if (main) route.push([YARD_U1, AISLE_V], [GATE_U + 10, AISLE_V], [RAIL_U0 + 10, this.railV(orgOf(e.repo))]);
        else route.push([ROW_U[1], AISLE_V], [ROW_U[1], AGE_V[0]]);
        this.spawn(`${e.repo}@${e.sha}`, 'commit', route, t, main ? 4200 : 2600, false, '', org);
        break;
      }
      case 'merge': {
        const org = orgOf(e.repo);
        this.spawn(`${e.repo}@${e.sha}`, 'commit', [[ROW_U[3], AGE_V[1]], [ROW_U[3], AISLE_V], [YARD_U1, AISLE_V], [GATE_U + 10, AISLE_V], [RAIL_U0 + 10, this.railV(org)], [RAIL_U0 + 60, this.railV(org)]], t, 2600, false, '', org);
        this.pulses.set('gate', { t, red: false });
        break;
      }
      case 'enqueue': {
        const org = orgOf(e.repo);
        const lane = e.lane === 'gha' ? 1 : 0;
        const q = lane ? this.census.gha.length : this.census.rr.length;
        this.spawn(e.pipeline, 'pipeline', [[RAIL_U1 - 10, this.railV(org)], [RAIL_U1 + 12, this.railV(org)], [INTAKE_U0, LANE_V[lane]], [Math.max(INTAKE_U0 + 8, INTAKE_U1 - 8 - q * 11), LANE_V[lane]]], t, 1800, false, '', org);
        break;
      }
      case 'start': {
        const p = w.pipelines.get(e.pipeline);
        const bay = this.bayOf(e.pipeline, w);
        const lane = p?.lane === 'gha' ? 1 : 0;
        if (bay) this.spawn(e.pipeline, 'pipeline', [[INTAKE_U1 - 6, LANE_V[lane]], [DIST_U, LANE_V[lane]], [DIST_U, bay.v + bay.dv / 2], [bay.u + 6, bay.v + bay.dv / 2]], t, 1600, false, '', p ? orgOf(p.repo) : '');
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
        if (red) {
          route.push([SCAN_U, RETURN_V], [24, RETURN_V], [24, this.dockV(org)], [DOCK_U0 + 8, this.dockV(org)]);
          dur = 9000;
        } else route.push([SCAN_U + 14, v0]);
        this.spawn(e.pipeline, 'pipeline', route, t, dur, red, red ? `${p.repo.split('/')[1]} · ${failingStep(p)}` : '', org);
        this.pulses.set('scan', { t, red });
        break;
      }
      case 'deploy': {
        if (e.state !== 'running' && e.state !== 'success' && e.state !== 'failure') break;
        const b = this.blockAt.get(e.app);
        const vi = Math.max(0, VIAS.indexOf((e.via === 'manual' ? 'gha_fallback' : e.via) as typeof VIAS[number]));
        if (e.state === 'running' && b) {
          this.spawn(`${e.app}@${e.sha}`, 'deploy', [[SCAN_U + 14, TRACK_V[vi]], [TRACK_U1, TRACK_V[vi]], [CITY_U0 - 4, b.v + b.d / 2], [b.u + b.d / 2, b.v + b.d / 2]], t, 2400, false, '', '');
        }
        if (e.state !== 'running') this.pulses.set(`app:${e.app}`, { t: t + (e.state === 'success' ? 0 : 0), red: e.state === 'failure' });
        break;
      }
      case 'health':
        this.pulses.set(`app:${e.app}`, { t, red: e.to === 'down' || e.to === 'degraded' });
        break;
      default: break;
    }
  }

  private lastBay = new Map<string, Bay>();
  private flown = false;

  private spawn(id: string, kind: Crate['kind'], route: Pt[], t: number, dur: number, red: boolean, label: string, org: string): void {
    const cum = [0];
    let len = 0;
    for (let i = 1; i < route.length; i++) { len += Math.hypot(route[i][0] - route[i - 1][0], route[i][1] - route[i - 1][1]); cum.push(len); }
    // a crate waits its turn on the same route start so bursts read as a line, not a blob
    let hold = 0;
    for (const c of this.crates) if (c.route[0][0] === route[0][0] && c.route[0][1] === route[0][1] && t - c.t0 < 400) hold = Math.max(hold, c.t0 + 260 - t);
    this.crates.push({ id, kind, route, len, cum, t0: t + Math.max(0, hold), dur, red, label, org, hold: 0 });
  }

  private dockV(org: string): number {
    const i = this.census.docks.findIndex((d) => d.org === org);
    return 66 + (i < 0 ? this.census.docks.length - 1 : i) * 96;
  }

  private railV(org: string): number {
    const i = this.census.rails.findIndex((r) => r.org === org);
    return RAIL_V[i < 0 ? 0 : Math.min(RAIL_V.length - 1, i)];
  }

  private bayOf(pid: string, w: World): Bay | null {
    this.layoutBays(w);
    const b = this.bays.find((x) => x.pid === pid) ?? null;
    if (b) this.lastBay.set(pid, b);
    return b;
  }

  /** Bays: each machine's slots, the k-th running pipeline of a host in bay k. */
  private layoutBays(w: World): void {
    void w;
    const out: Bay[] = [];
    this.census.groups.forEach((g, gi) => {
      const v0 = ENG_V0 + gi * ENG_STEP;
      const n = Math.max(1, g.slots);
      const span = ENG_U1 - ENG_U0 - 28;
      const du = span / n;
      for (let k = 0; k < n; k++) {
        out.push({ u: ENG_U0 + 14 + k * du + 3, v: v0 + 16, du: du - 6, dv: ENG_DV - 40, group: gi, slot: k, pid: g.running[k] ?? '' });
      }
    });
    this.bays = out;
    for (const b of out) if (b.pid) this.lastBay.set(b.pid, b);
  }

  // ---- the city ------------------------------------------------------------------------------
  private layoutCity(): void {
    const c = this.census;
    const key = `${c.districts.map((d) => `${d.team}:${d.apps.length}`).join(',')}`;
    if (key === this.cityKey) return;
    this.cityKey = key;
    this.blocks = [];
    this.blockAt.clear();
    this.districtBox = [];
    // Districts fill columns of the city, back to front, then the next column; a street between.
    const pitch = 19, d = 13, street = 16;
    const cols = Math.floor((CITY_U1 - CITY_U0 + 6) / pitch);
    let u = CITY_U0, v = CITY_V0;
    let colW = 0;
    // Pack districts as rectangles: width in cells chosen so the district is about square.
    const rows = Math.floor((CITY_V1 - CITY_V0) / pitch);
    void rows;
    c.districts.forEach((dist, di) => {
      const n = dist.apps.length;
      let w = Math.max(2, Math.min(cols, Math.ceil(Math.sqrt(n * 1.1))));
      if (n > 60) w = Math.min(cols, 7);
      const h = Math.ceil(n / w);
      if (v + h * pitch > CITY_V1 + 4) { u += colW * pitch + street; v = CITY_V0; colW = 0; }
      const u0 = u, v0 = v;
      dist.apps.forEach((id, i) => {
        const bu = u0 + (i % w) * pitch, bv = v0 + Math.floor(i / w) * pitch;
        const deps = c.deploys24.get(id) ?? 0;
        const b: Block = { id, u: bu, v: bv, d, h: 4 + Math.min(16, deps * 2.2) + (hash(id) % 3), district: di };
        this.blocks.push(b);
        this.blockAt.set(id, b);
      });
      this.districtBox.push({ team: dist.team, u0, v0, u1: u0 + w * pitch - (pitch - d), v1: v0 + h * pitch - (pitch - d), n });
      v += h * pitch + street;
      colW = Math.max(colW, w);
    });
    // far first
    this.blocks.sort((a, b) => (a.u + a.v * 3.47) - (b.u + b.v * 3.47));
  }

  // ---- pointer, camera -------------------------------------------------------------------------
  pointer(kind: string, x: number, y: number, buttons: number, t: number): HitBox | null {
    this.px = x; this.py = y;
    if (kind === 'down') { this.drag = { x, y, moved: false }; return null; }
    if (kind === 'move') {
      if (this.drag && (buttons & 1)) {
        const dx = x - this.drag.x, dy = y - this.drag.y;
        if (this.drag.moved || Math.abs(dx) + Math.abs(dy) > 4) {
          this.drag.moved = true;
          this.cam.pan(dx, dy);
          this.drag.x = x; this.drag.y = y;
        }
        return null;
      }
      const h = this.hitAt(x, y);
      this.hoverId = h ? h.id : '';
      return h;
    }
    if (kind === 'up') {
      const d = this.drag;
      this.drag = null;
      if (d?.moved) return null;
      const h = this.hitAt(x, y);
      if (!h) { this.select('', ''); return null; }
      if (h.kind === 'zoomin') this.cam.zoomAt(1.5, this.cam.W / 2, this.cam.H / 2);
      else if (h.kind === 'zoomout') this.cam.zoomAt(1 / 1.5, this.cam.W / 2, this.cam.H / 2);
      else if (h.kind === 'fit') this.cam.reset(t);
      else if (h.kind === 'close') this.select('', '');
      else if (h.kind === 'district' || h.kind === 'engine' || h.kind === 'stage') {
        const [u, v, z] = h.id.split(',').map(Number);
        this.cam.flyToPoint(u, v, z || 2.2, t);
      } else if (h.kind === 'app') {
        // an app: fly down to its block (its name, health and deploys show at that zoom)
        const b = this.blockAt.get(h.id);
        if (b) this.cam.flyToPoint(b.u + b.d / 2, b.v + b.d / 2, Math.max(3.2, this.cam.zoom), t);
      } else if (h.kind === 'pipeline' || h.kind === 'commit') this.select(h.id, h.kind);
      return h;
    }
    return null;
  }

  select(id: string, kind: string): void {
    if (this.selected === id || !id) { if (this.flown) { this.flown = false; this.cam.flyTo(1, 0, 0, this.lastT); } this.selected = ''; this.selKind = ''; return; }
    this.selected = id; this.selKind = kind;
    if (id && !this.flown) { this.flown = true; this.cam.flyTo(0.8, -176, 10, this.lastT); }
    if (id !== this.journeyFor) this.journey = null;
  }

  wheel(total: number): void {
    const d = total - this.wheelSeen;
    this.wheelSeen = total;
    if (!d) return;
    const x = this.px >= 0 ? this.px : this.cam.W / 2, y = this.py >= 0 ? this.py : this.cam.H / 2;
    this.cam.zoomAt(Math.exp(-clamp(d, -400, 400) / 320), x, y);
  }

  hitAt(x: number, y: number): HitBox | null {
    let best: HitBox | null = null;
    for (let i = this.hits.length - 1; i >= 0; i--) {
      const h = this.hits[i];
      if (x >= h.x && x <= h.x + h.w && y >= h.y && y <= h.y + h.h) { best = h; break; }
    }
    return best;
  }

  /** The selection's pipeline (a commit selection: its newest pipeline). */
  selPipeline(): Pipeline | null {
    const w = this.world;
    if (!this.selected) return null;
    const p = w.pipelines.get(this.selected);
    if (p) return p;
    const c = w.commits.get(this.selected);
    if (c) for (let i = c.pipelines.length - 1; i >= 0; i--) { const q = w.pipelines.get(c.pipelines[i]); if (q) return q; }
    return null;
  }

  /** repo and sha of the selection (for the journey fetch). */
  selCommit(): { repo: string; sha: string } | null {
    const p = this.selPipeline();
    if (p) return { repo: p.repo, sha: p.sha };
    const at = this.selected.indexOf('@');
    if (at > 0) return { repo: this.selected.slice(0, at), sha: this.selected.slice(at + 1) };
    return null;
  }

  // ---- geometry primitives ---------------------------------------------------------------------
  private poly(g: Gfx, pts: number[]): void {
    const cam = this.cam;
    for (let i = 0; i < pts.length; i += 3) {
      const x = cam.x(pts[i], pts[i + 1]), y = cam.y(pts[i], pts[i + 1], pts[i + 2]);
      if (i === 0) g.move(x, y); else g.line(x, y);
    }
    g.ctx.closePath();
  }

  private quad(g: Gfx, u0: number, v0: number, u1: number, v1: number, z = 0): void {
    this.poly(g, [u0, v0, z, u1, v0, z, u1, v1, z, u0, v1, z]);
  }

  /** An extruded block: the faces the camera sees (front +v, right +u, top), dark, tone-shaded. */
  private box(g: Gfx, u0: number, v0: number, du: number, dv: number, h: number, top: string = F.top, side: string = F.side, front: string = F.front, edge: string = F.edge, lw?: number): void {
    const u1 = u0 + du, v1 = v0 + dv;
    g.begin_(); this.poly(g, [u0, v1, 0, u1, v1, 0, u1, v1, h, u0, v1, h]); g.fill(front);
    g.begin_(); this.poly(g, [u1, v0, 0, u1, v1, 0, u1, v1, h, u1, v0, h]); g.fill(side);
    g.begin_(); this.poly(g, [u0, v0, h, u1, v0, h, u1, v1, h, u0, v1, h]); g.fill(top);
    // edges: the silhouette and the two visible vertical corners
    const cam = this.cam, w = lw ?? g.hair * 1.5;
    g.begin_();
    g.move(cam.x(u0, v0), cam.y(u0, v0, h)); g.line(cam.x(u1, v0), cam.y(u1, v0, h)); g.line(cam.x(u1, v0), cam.y(u1, v0, 0));
    g.line(cam.x(u1, v1), cam.y(u1, v1, 0)); g.line(cam.x(u0, v1), cam.y(u0, v1, 0)); g.line(cam.x(u0, v1), cam.y(u0, v1, h)); g.ctx.closePath();
    g.move(cam.x(u0, v1), cam.y(u0, v1, h)); g.line(cam.x(u1, v1), cam.y(u1, v1, h)); g.line(cam.x(u1, v0), cam.y(u1, v0, h));
    g.move(cam.x(u1, v1), cam.y(u1, v1, h)); g.line(cam.x(u1, v1), cam.y(u1, v1, 0));
    g.stroke(edge, w);
  }

  /** A small crate (a cube) at floor point (u, v), side `d` world units. */
  private crate(g: Gfx, u: number, v: number, d: number, red: boolean, dim: boolean, z = 2): void {
    const h = d * 0.8, u0 = u - d / 2, v0 = v - d / 2;
    const top = red ? F.redTop : dim ? F.dockTop : F.crateTop;
    const front = red ? F.redFront : dim ? F.dockFront : F.crateFront;
    const side = red ? F.redSide : dim ? F.dockSide : F.crateSide;
    const cam = this.cam;
    const p = (uu: number, vv: number, zz: number) => { g.line(cam.x(uu, vv), cam.y(uu, vv, zz)); };
    g.begin_(); g.move(cam.x(u0, v0 + d), cam.y(u0, v0 + d, z)); p(u0 + d, v0 + d, z); p(u0 + d, v0 + d, z + h); p(u0, v0 + d, z + h); g.ctx.closePath(); g.fill(front);
    g.begin_(); g.move(cam.x(u0 + d, v0), cam.y(u0 + d, v0, z)); p(u0 + d, v0 + d, z); p(u0 + d, v0 + d, z + h); p(u0 + d, v0, z + h); g.ctx.closePath(); g.fill(side);
    g.begin_(); g.move(cam.x(u0, v0), cam.y(u0, v0, z + h)); p(u0 + d, v0, z + h); p(u0 + d, v0 + d, z + h); p(u0, v0 + d, z + h); g.ctx.closePath(); g.fill(top);
  }

  /** A belt (a flow band) along an axis-aligned polyline; `lanes` ∝ throughput. */
  private beltPath(g: Gfx, pts: Pt[], hw: number): void {
    for (let i = 1; i < pts.length; i++) {
      const [a, b] = [pts[i - 1], pts[i]];
      const u0 = Math.min(a[0], b[0]) - (a[1] === b[1] ? 0 : hw), u1 = Math.max(a[0], b[0]) + (a[1] === b[1] ? 0 : hw);
      const v0 = Math.min(a[1], b[1]) - (a[0] === b[0] ? 0 : hw), v1 = Math.max(a[1], b[1]) + (a[0] === b[0] ? 0 : hw);
      this.quad(g, u0, v0, u1, v1, 0.5);
    }
  }

  // ---- the plan: belts (polylines) and their last-hour throughput ------------------------------
  private belts(): { id: string; pts: Pt[]; n: number; label: string; at: Pt }[] {
    const c = this.census, f = c.flow;
    const out: { id: string; pts: Pt[]; n: number; label: string; at: Pt }[] = [];
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

  private laneW(n: number): number { return 5 + Math.min(4, Math.max(1, Math.ceil(n / 25))) * 4; }

  // ---- the floor layer -------------------------------------------------------------------------
  /** Fits the camera and recounts the census when due; true when it counted this turn (the
   *  count is the heavy part: a draw that counted leaves its painting to the next frame, so
   *  no turn does both). */
  ensure(f: Frame, t: number): boolean {
    this.cam.fit(f.width, f.height, 84, 58);
    const now = this.tl.playhead;
    const counted = this.census.update(this.world, now, t);
    this.layoutCity();
    this.layoutBays(this.world);
    return counted;
  }

  get floorKey(): string { return `${this.cam.key}|${this.census.sig}`; }

  drawFloor(ctx: Ctx2D, f: Frame, t: number): boolean {
    if (this.ensure(f, t)) return true;
    const g = this.gf, cam = this.cam;
    g.begin(ctx, f.scale);
    ctx.resetTransform();
    ctx.clearRect(0, 0, f.width, f.height);
    g.fillRect(0, 0, f.width, f.height, C.canvas);
    this.floorSig = this.floorKey;
    // the floor slab
    g.begin_(); this.poly(g, [0, 0, 0, LU, 0, 0, LU, LV, 0, 0, LV, 0]); g.fill(F.floor);
    // a faint isometric grid: every 20 units, a stronger line every 100
    const step = cam.s * 20 > 9 ? 20 : 40;
    g.begin_();
    for (let u = step; u < LU; u += step) if (u % 100) { g.move(cam.x(u, 0), cam.y(u, 0)); g.line(cam.x(u, LV), cam.y(u, LV)); }
    for (let v = step; v < LV; v += step) if (v % 100) { g.move(cam.x(0, v), cam.y(0, v)); g.line(cam.x(LU, v), cam.y(LU, v)); }
    g.stroke(F.grid, g.hair);
    g.begin_();
    for (let u = 100; u < LU; u += 100) { g.move(cam.x(u, 0), cam.y(u, 0)); g.line(cam.x(u, LV), cam.y(u, LV)); }
    for (let v = 100; v < LV; v += 100) { g.move(cam.x(0, v), cam.y(0, v)); g.line(cam.x(LU, v), cam.y(LU, v)); }
    g.stroke(F.gridMajor, g.hair);
    // the slab's front lip
    g.begin_(); this.poly(g, [0, LV, 0, LU, LV, 0, LU, LV, -6, 0, LV, -6]); g.fill('#0A0A0B');
    g.begin_(); this.poly(g, [LU, 0, 0, LU, LV, 0, LU, LV, -6, LU, 0, -6]); g.fill('#080809');
    g.begin_(); this.poly(g, [0, 0, 0, LU, 0, 0, LU, LV, 0, 0, LV, 0]); g.stroke(F.floorEdge, g.hair * 1.5);
    // painted zones (dashed), one per stage
    g.dash(true, 3, 4);
    const zones: [number, number, number, number][] = [[4, 24, 72, 588], [YARD_U0 - 6, 92, YARD_U1 + 4, 600], [RAIL_U0 - 4, 98, RAIL_U1 + 6, 482], [INTAKE_U0 - 8, 252, INTAKE_U1 + 6, 330], [ENG_U0 - 8, 22, ENG_U1 + 40, 600], [CITY_U0 - 8, CITY_V0 - 8, CITY_U1 + 4, CITY_V1 + 6]];
    g.begin_();
    for (const z of zones) this.quad(g, z[0], z[1], z[2], z[3], 0);
    g.stroke(F.zone, g.hair * 1.5);
    g.dash(false);
    // belts
    const belts = this.belts();
    for (const b of belts) {
      const hw = this.laneW(b.n) / 2;
      g.begin_(); this.beltPath(g, b.pts, hw); g.fill(F.belt);
      g.begin_(); this.beltPath(g, b.pts, hw); g.stroke(F.beltEdge, g.hair * 1.5);
    }
    // main-line rails and deploy tracks (two rails and sleepers)
    const railTrack = (u0: number, u1: number, v: number) => {
      g.begin_();
      for (let u = u0 + 4; u < u1; u += 8) { g.move(cam.x(u, v - 5), cam.y(u, v - 5)); g.line(cam.x(u, v + 5), cam.y(u, v + 5)); }
      g.stroke(F.sleeper, Math.max(1, cam.s * 1.6));
      g.begin_();
      g.move(cam.x(u0, v - 3), cam.y(u0, v - 3)); g.line(cam.x(u1, v - 3), cam.y(u1, v - 3));
      g.move(cam.x(u0, v + 3), cam.y(u0, v + 3)); g.line(cam.x(u1, v + 3), cam.y(u1, v + 3));
      g.stroke(F.rail, g.hair * 2);
    };
    for (let i = 0; i < this.census.rails.length; i++) railTrack(RAIL_U0, RAIL_U1, RAIL_V[i]);
    // rail ends converge into the intake funnel
    g.begin_();
    for (let i = 0; i < this.census.rails.length; i++) { g.move(cam.x(RAIL_U1, RAIL_V[i]), cam.y(RAIL_U1, RAIL_V[i])); g.line(cam.x(RAIL_U1 + 14, 291), cam.y(RAIL_U1 + 14, 291)); }
    g.stroke(F.beltEdge, g.hair * 1.5);
    for (let i = 0; i < 3; i++) railTrack(SCAN_U + 10, TRACK_U1, TRACK_V[i]);
    // the blocks, far to near
    const items: { k: number; f: () => void }[] = [];
    const add = (u: number, v: number, fn: () => void) => items.push({ k: u * 0.19 + v * 0.66, f: fn });
    // sources: docks
    this.census.docks.forEach((d, i) => {
      const v = 66 + i * 96;
      add(DOCK_U0, v, () => {
        this.box(g, DOCK_U0, v - 30, DOCK_U1 - DOCK_U0, 60, 14);
        // the dock's door: a dark slot on its right face
        g.begin_(); this.poly(g, [DOCK_U1, v - 12, 1, DOCK_U1, v + 12, 1, DOCK_U1, v + 12, 10, DOCK_U1, v - 12, 10]); g.fill(F.bay);
        if (d.org === BOTS) { g.begin_(); this.quad(g, DOCK_U0 + 6, v - 24, DOCK_U1 - 6, v + 24, 14); g.stroke(F.edgeHi, g.hair); }
      });
    });
    // the PR yard: a low slab with racks; stacks by phase (columns) × age (depth)
    add(YARD_U0, 92, () => {
      this.box(g, YARD_U0, 92, YARD_U1 - YARD_U0, 452, 2, '#141416', '#101011', '#0F0F10', F.floorEdge);
    });
    PHASES.forEach((_ph, r) => {
      AGE_V.forEach((v, b) => {
        const s = this.census.stacks[r][b];
        const u0 = ROW_U[r] - ROW_DU / 2;
        add(u0, v, () => this.stack(g, u0, v, s.n, s.stuck, s.red, b));
      });
    });
    this.census.pallets.forEach((p, i) => {
      const u0 = YARD_U0 + 8 + i * 76;
      add(u0, PALLET_V, () => this.pallet(g, u0, PALLET_V - 16, p.n));
    });
    // merge gate: two posts and a beam over the aisle
    add(GATE_U, AISLE_V - 30, () => {
      this.box(g, GATE_U, AISLE_V - 36, 8, 8, 40);
      this.box(g, GATE_U, AISLE_V + 28, 8, 8, 40);
      this.box(g, GATE_U, AISLE_V - 36, 8, 72, 6 + 0, F.topHi);
      g.begin_(); this.quad(g, GATE_U, AISLE_V - 36, GATE_U + 8, AISLE_V + 36, 40); g.fill(F.topHi);
      g.begin_(); this.quad(g, GATE_U, AISLE_V - 36, GATE_U + 8, AISLE_V + 36, 40); g.stroke(F.edgeHi, g.hair * 1.5);
    });
    // intake: the holding belt's frame (two rails along it)
    add(INTAKE_U0, 256, () => {
      this.box(g, INTAKE_U0, 258, INTAKE_U1 - INTAKE_U0, 4, 6);
      this.box(g, INTAKE_U0, 320, INTAKE_U1 - INTAKE_U0, 4, 6);
      g.begin_(); this.quad(g, INTAKE_U0, 291 - 1, INTAKE_U1, 291 + 1, 0.6); g.fill(F.beltEdge);
    });
    // the consumption engine: one big machine per host
    this.census.groups.forEach((gr, gi) => {
      const v0 = ENG_V0 + gi * ENG_STEP;
      add(ENG_U0, v0, () => this.engineBlock(g, gr.online, gr.hosted, v0, gi));
      // cpu / mem gauges: two towers at the machine's right end
      add(ENG_U1 + 10, v0 + 40, () => {
        this.box(g, ENG_U1 + 12, v0 + 34, 9, 9, 64, '#1B1B1D');
        this.box(g, ENG_U1 + 25, v0 + 34, 9, 9, 64, '#1B1B1D');
      });
    });
    // the test scanner: a tall frame across the floor
    add(SCAN_U - 4, 30, () => {
      this.box(g, SCAN_U - 4, 30, 8, 8, 56);
      this.box(g, SCAN_U - 4, 590, 8, 8, 56);
      g.begin_(); this.quad(g, SCAN_U - 4, 30, SCAN_U + 4, 598, 56); g.fill(F.topHi);
      g.begin_(); this.quad(g, SCAN_U - 4, 30, SCAN_U + 4, 598, 56); g.stroke(F.edgeHi, g.hair * 1.5);
    });
    // the city: one low block per app
    for (const b of this.blocks) add(b.u, b.v, () => this.box(g, b.u, b.v, b.d, b.d, b.h, '#202023', '#161618', '#121214', '#333337'));
    items.sort((a, b) => a.k - b.k);
    for (const it of items) it.f();
    return false;
  }

  private stack(g: Gfx, u0: number, v0: number, n: number, stuck: number, red: number, bucket: number): void {
    // a pallet on the floor, crates stacked by count (1 crate layer per 2 PRs, a cap with a break)
    this.box(g, u0, v0, ROW_DU, STACK_DV, 2, '#19191B', '#121214', '#101012', '#2A2A2E');
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
    this.box(g, u0 + inset, v0 + inset, ROW_DU - inset * 2, STACK_DV - inset * 2, 2 + layers * lh, top, side, front, edge);
    // layer seams on the front and right faces
    const cam = this.cam;
    g.begin_();
    const ua = u0 + inset, ub = u0 + ROW_DU - inset, va = v0 + inset, vb = v0 + STACK_DV - inset;
    for (let k = 1; k < layers; k++) {
      const z = 2 + k * lh;
      g.move(cam.x(ua, vb), cam.y(ua, vb, z)); g.line(cam.x(ub, vb), cam.y(ub, vb, z)); g.line(cam.x(ub, va), cam.y(ub, va, z));
    }
    g.stroke(withAlpha(edge, 0.55), g.hair);
    if (n > 48) {
      // the cap: more than the stack shows
      g.begin_(); this.quad(g, ua + 4, va + 4, ub - 4, vb - 4, 2 + layers * lh); g.stroke(edge, g.hair * 1.5);
    }
  }

  private pallet(g: Gfx, u0: number, v0: number, n: number): void {
    this.box(g, u0, v0, 64, 34, 3, '#1C1A16', '#141310', '#12110E', '#3A352B');
    // crates on it: a grid whose fill grows with the count (up to 4×2 × 6 high)
    const cols = 4, rows = 2;
    const per = Math.max(1, Math.ceil(n / (cols * rows)));
    const h = Math.min(30, 3 + Math.sqrt(per) * 4);
    this.box(g, u0 + 5, v0 + 5, 54, 24, 3 + h, '#2E2A22', '#221F19', '#1C1A15', '#4A4334');
    const cam = this.cam;
    g.begin_();
    for (let k = 1; k < cols; k++) { const u = u0 + 5 + k * 13.5; g.move(cam.x(u, v0 + 29), cam.y(u, v0 + 29, 3)); g.line(cam.x(u, v0 + 29), cam.y(u, v0 + 29, 3 + h)); g.line(cam.x(u, v0 + 5), cam.y(u, v0 + 5, 3 + h)); }
    g.move(cam.x(u0 + 5, v0 + 17), cam.y(u0 + 5, v0 + 17, 3 + h)); g.line(cam.x(u0 + 59, v0 + 17), cam.y(u0 + 59, v0 + 17, 3 + h));
    g.stroke('#4A4334', g.hair);
  }

  private engineBlock(g: Gfx, online: boolean, hosted: boolean, v0: number, gi: number): void {
    const edge = online ? F.edgeHi : F.edge;
    // the plinth, then the machine: a long block with recessed bays on its top
    this.box(g, ENG_U0 - 4, v0 - 4, ENG_U1 - ENG_U0 + 8, ENG_DV + 8, 3, '#141416', '#101012', '#0E0E10', F.floorEdge);
    this.box(g, ENG_U0, v0, ENG_U1 - ENG_U0, ENG_DV, ENG_H, hosted ? '#1F1F22' : '#252528', '#19191B', '#151517', edge, g.hair * 2);
    const cam = this.cam;
    // bays: dark recesses
    for (const b of this.bays) {
      if (b.group !== gi) continue;
      g.begin_(); this.quad(g, b.u, b.v, b.u + b.du, b.v + b.dv, ENG_H); g.fill(F.bay);
      // the recess's inner walls (the far and left walls show)
      g.begin_(); this.poly(g, [b.u, b.v, ENG_H, b.u + b.du, b.v, ENG_H, b.u + b.du, b.v, ENG_H - 5, b.u, b.v, ENG_H - 5]); g.fill('#0B0B0C');
      g.begin_(); this.quad(g, b.u, b.v, b.u + b.du, b.v + b.dv, ENG_H); g.stroke('#38383C', g.hair);
      // the progress rail along the bay's front lip
      g.begin_(); this.quad(g, b.u, b.v + b.dv + 4, b.u + b.du, b.v + b.dv + 9, ENG_H); g.fill('#101012');
    }
    // vents on the front face
    g.begin_();
    for (let u = ENG_U0 + 12; u < ENG_U1 - 10; u += 9) { g.move(cam.x(u, v0 + ENG_DV), cam.y(u, v0 + ENG_DV, 8)); g.line(cam.x(u, v0 + ENG_DV), cam.y(u, v0 + ENG_DV, ENG_H - 8)); }
    g.stroke('#1F1F22', g.hair * 1.5);
    if (hosted) {
      // hosted: dashed outline, a machine we do not own
      g.dash(true, 3, 3);
      g.begin_(); this.quad(g, ENG_U0 - 4, v0 - 4, ENG_U1 + 4, v0 + ENG_DV + 4, 3); g.stroke(F.edge, g.hair * 1.5);
      g.dash(false);
    }
  }

  // ---- the live layer ---------------------------------------------------------------------------
  drawLive(ctx: Ctx2D, f: Frame, t: number, wheel: number): boolean {
    this.budget.tick(t);
    this.wheel(wheel);
    const flying = this.cam.step(t);
    // a turn that recounted paints the previous frame's picture again next frame
    if (this.ensure(f, t)) return true;
    const g = this.gl, cam = this.cam, w = this.world, c = this.census;
    const now = this.tl.playhead;
    g.begin(ctx, f.scale);
    ctx.resetTransform();
    ctx.clearRect(0, 0, f.width, f.height);
    this.hits = [];
    this.labels = [];
    const z = cam.zoom;
    const detail = z >= 1.6;
    const q = this.budget.quality;
    // the floor moved under us (pan, zoom, a new shape): the floor layer redraws on its key;
    // until it does, nothing here depends on it.
    // 1. heat haze: a warm glow under the stage that backs up
    if (c.bottleneck && q < 3) {
      const at: Record<string, [number, number, number]> = { prs: [270, 300, 180], intake: [705, 291, 90], engines: [915, 300, 230], deploy: [1165, 330, 90] };
      const [u, v, r] = at[c.bottleneck] ?? [0, 0, 0];
      if (r) {
        const x = cam.x(u, v), y = cam.y(u, v), R = r * cam.s;
        const heat = clamp(c.heat[c.bottleneck], 0.3, 1.4);
        const gr = ctx.createRadialGradient(x, y, 0, x, y, R);
        gr.addColorStop(0, withAlpha('#E5934F', 0.16 * heat));
        gr.addColorStop(0.55, withAlpha('#E5934F', 0.06 * heat));
        gr.addColorStop(1, withAlpha('#E5934F', 0));
        ctx.save(); ctx.translate(x, y); ctx.scale(1, 0.55); ctx.translate(-x, -y);
        ctx.fillStyle = gr; ctx.beginPath(); ctx.arc(x, y, R, 0, TAU); ctx.fill(); ctx.restore();
      }
    }
    // 2. belts: slats drift at a speed set by the belt's last-hour throughput (rate, not decoration)
    if (q < 2 && !this.reduced) {
      g.begin_();
      for (const b of this.belts()) {
        if (!b.n) continue;
        const hw = this.laneW(b.n) / 2;
        const speed = 4 + Math.min(26, b.n / 4);
        const off = ((t / 1000) * speed) % 12;
        for (let i = 1; i < b.pts.length; i++) {
          const [a, e] = [b.pts[i - 1], b.pts[i]];
          const len = Math.hypot(e[0] - a[0], e[1] - a[1]);
          const du = (e[0] - a[0]) / len, dv = (e[1] - a[1]) / len;
          for (let s = off; s < len; s += 12) {
            const u = a[0] + du * s, v = a[1] + dv * s;
            g.move(cam.x(u - dv * hw, v - du * hw), cam.y(u - dv * hw, v - du * hw, 0.6));
            g.line(cam.x(u + dv * hw, v + du * hw), cam.y(u + dv * hw, v + du * hw, 0.6));
          }
        }
      }
      g.stroke(F.slat, Math.max(1, cam.s * 1.2));
    }
    // 3. cars on the main-line rails: the org's newest merged commits, newest at the right
    c.rails.forEach((r, i) => {
      const v = RAIL_V[i];
      const n = r.cars.length;
      r.cars.forEach((car, k) => {
        const u = RAIL_U1 - 12 - (n - 1 - k) * 10;
        if (u < RAIL_U0 + 4) return;
        const red = car.culprit;
        const run = car.state === 'running' || car.state === 'pending';
        this.car(g, u, v, red, !run && !red);
        if (run) this.lamp(g, u, v, 9, C.packet);
        const sel = this.selected === `${car.repo}@${car.sha}`;
        this.hit(cam.x(u, v) - 6, cam.y(u, v, 8) - 6, 12, 12, 'commit', `${car.repo}@${car.sha}`, `${car.repo.split('/')[1]} · ${car.title}`);
        if (sel) this.ring(g, u, v, 8);
      });
    });
    // 4. intake: queued crates in a visible line, the oldest nearest the engines
    [c.rr, c.gha].forEach((ids, lane) => {
      ids.slice(0, 8).forEach((id, k) => {
        const u = INTAKE_U1 - 10 - k * 11, v = LANE_V[lane];
        this.crate(g, u, v, 8, false, true);
        this.hit(cam.x(u, v) - 7, cam.y(u, v, 8) - 7, 14, 14, 'pipeline', id, this.pipeWords(w.pipelines.get(id)));
      });
    });
    // 5. the consumption engine: lit bays, progress along each bay, the job's crate inside
    for (const b of this.bays) {
      if (!b.pid) continue;
      const p = w.pipelines.get(b.pid);
      g.begin_(); this.quad(g, b.u, b.v, b.u + b.du, b.v + b.dv, ENG_H); g.fill(F.bayLit);
      g.begin_(); this.quad(g, b.u, b.v, b.u + b.du, b.v + b.dv, ENG_H); g.stroke(withAlpha(C.packet, 0.7), g.hair * 2);
      const exp = p?.expected_ms ?? w.repos.get(p?.repo ?? '')?.p50_build_ms ?? w.stats.p50_build_ms ?? 0;
      const el = p?.started ? Math.max(0, now - p.started) : 0;
      const u01 = exp > 0 ? clamp(el / exp, 0.03, 1) : 0.5;
      const over = exp > 0 && el > exp * 1.5;
      g.begin_(); this.quad(g, b.u, b.v + b.dv + 4, b.u + b.du * u01, b.v + b.dv + 9, ENG_H); g.fill(over ? C.red : C.packet);
      // the job's crate rides the bay with its progress
      this.crate(g, b.u + 6 + (b.du - 12) * u01, b.v + b.dv / 2, 10, false, false, ENG_H - 3);
      this.hit(cam.x(b.u, b.v + b.dv), cam.y(b.u, b.v, ENG_H) - 4, (b.du * 0.86 + b.dv * 0.4) * cam.s, (b.dv * 0.66 + b.du * 0.19) * cam.s + 10, 'pipeline', b.pid, this.pipeWords(p));
      if (this.selected === b.pid) this.ring(g, b.u + b.du / 2, b.v + b.dv / 2, 14, ENG_H);
    }
    // gauges: cpu and mem fill their towers (amber; red over 90 %)
    c.groups.forEach((gr, gi) => {
      const v0 = ENG_V0 + gi * ENG_STEP;
      const util = gr.slots ? gr.running.length / gr.slots : 0;
      const vals = [gr.cpu >= 0 ? gr.cpu : -1, gr.mem >= 0 ? gr.mem : -1];
      vals.forEach((val, k) => {
        const u0 = ENG_U1 + 12 + k * 13;
        if (val < 0) {
          // no reading: the tower shows the slots' utilization in gray instead
          if (k === 0) this.fill(g, u0, v0 + 34, 9, 9, 2 + 60 * util, '#3E3E42', '#2C2C30', '#262629');
          return;
        }
        const hot = val >= 90;
        const hh = 2 + 60 * clamp(val / 100, 0, 1);
        this.fill(g, u0, v0 + 34, 9, 9, hh, '#9A9A9E', '#6A6A6E', '#58585C');
        if (hot) { g.begin_(); this.quad(g, u0, v0 + 34, u0 + 9, v0 + 43, hh); g.fill(C.red); }
      });
    });
    // 6. the city: a health light on each app; deploys pulse, degraded and down glow
    {
      const lights: [string, string][] = [];
      for (const b of this.blocks) {
        const a = w.apps.get(b.id);
        const hl = a?.health ?? 'unknown';
        const col = hl === 'down' ? C.red : hl === 'degraded' ? C.packet : hl === 'up' ? '#6FA27C' : C.ink4;
        lights.push([b.id, col]);
      }
      const r = Math.max(1.1, Math.min(2.6, cam.s * 1.9));
      const byCol = new Map<string, Block[]>();
      for (const b of this.blocks) {
        const hl = w.apps.get(b.id)?.health ?? 'unknown';
        const col = hl === 'down' ? C.red : hl === 'degraded' ? C.packet : hl === 'up' ? '#6FA27C' : C.ink4;
        let l = byCol.get(col); if (!l) { l = []; byCol.set(col, l); } l.push(b);
      }
      for (const [col, list] of byCol) {
        if (col === C.red || col === C.packet) {
          // a glow under trouble
          for (const b of list) {
            const x = cam.x(b.u + b.d / 2, b.v + b.d / 2), y = cam.y(b.u + b.d / 2, b.v + b.d / 2, b.h + 2);
            g.begin_(); g.circle(x, y, r * 5); g.fill(withAlpha(col, 0.16));
          }
        }
        g.begin_();
        for (const b of list) g.circle(cam.x(b.u + b.d / 2, b.v + b.d / 2), cam.y(b.u + b.d / 2, b.v + b.d / 2, b.h + 1.5), r);
        g.fill(col);
      }
      void lights;
      for (const b of this.blocks) this.hit(cam.x(b.u, b.v + b.d), cam.y(b.u, b.v, b.h) - 2, b.d * 1.3 * cam.s, (b.d * 0.75 + b.h) * cam.s + 4, 'app', b.id, b.id);
    }
    // pulses: a ring expanding from what just landed
    let pulsing = false;
    for (const [k, p] of this.pulses) {
      const age = t - p.t;
      if (age > 1600) { this.pulses.delete(k); continue; }
      if (age < 0) { pulsing = true; continue; }
      pulsing = true;
      const e = age / 1600;
      let x = 0, y = 0;
      if (k.startsWith('app:')) {
        const b = this.blockAt.get(k.slice(4));
        if (!b) continue;
        x = cam.x(b.u + b.d / 2, b.v + b.d / 2); y = cam.y(b.u + b.d / 2, b.v + b.d / 2, b.h + 1.5);
      } else if (k === 'scan') { x = cam.x(SCAN_U, 320); y = cam.y(SCAN_U, 320, 56); }
      else if (k === 'gate') { x = cam.x(GATE_U + 4, AISLE_V); y = cam.y(GATE_U + 4, AISLE_V, 40); }
      g.begin_(); g.circle(x, y, 3 + e * 18 * Math.max(0.8, cam.s)); g.stroke(withAlpha(p.red ? C.red : k.startsWith('app:') ? C.green : C.packet, 0.8 * (1 - e)), 1.2);
    }
    // the scanner's beam: lit for a moment as a crate passes; red when it failed one
    const sc = this.pulses.get('scan');
    if (sc && t - sc.t < 700) {
      g.begin_(); this.quad(g, SCAN_U - 1, 36, SCAN_U + 1, 594, 54); g.fill(withAlpha(sc.red ? C.red : C.packet, 0.55 * (1 - (t - sc.t) / 700)));
    }
    // deploys in flight sit on their track, nearer the city the longer they have run
    const lanes = [0, 0, 0];
    for (const d of [...c.deploying].sort((a, b) => a.started - b.started)) {
      const b = this.blockAt.get(d.app);
      // the oldest leads; the ones behind it queue a crate's length back on the same track
      const k = clamp(Math.min((now - d.started) / 90_000, 0.92 - lanes[d.via]++ * 0.09), 0.05, 0.92);
      const v = TRACK_V[d.via];
      const u = SCAN_U + 16 + (TRACK_U1 - SCAN_U - 24) * k;
      this.crate(g, u, v, 8, false, false);
      this.hit(cam.x(u, v) - 7, cam.y(u, v, 8) - 7, 14, 14, 'commit', `${w.apps.get(d.app)?.repo ?? ''}@${d.sha}`, `deploy ${d.app}`);
      if (b) { g.begin_(); g.circle(cam.x(b.u + b.d / 2, b.v + b.d / 2), cam.y(b.u + b.d / 2, b.v + b.d / 2, b.h + 1.5), 3.2); g.stroke(withAlpha(C.packet, 0.9), 1); }
    }
    // 7. crates in motion
    let moving = false;
    for (let i = this.crates.length - 1; i >= 0; i--) {
      const cr = this.crates[i];
      const u = (t - cr.t0) / cr.dur;
      if (u > 1) { this.crates.splice(i, 1); continue; }
      moving = true;
      if (u < 0) continue;
      const [cu, cv] = this.along(cr, easeInOut(u));
      const red = cr.red && (cr.route.length < 4 || this.pastScanner(cr, u));
      this.crate(g, cu, cv, 8, red, false);
      this.hit(cam.x(cu, cv) - 7, cam.y(cu, cv, 8) - 7, 14, 14, cr.kind === 'pipeline' ? 'pipeline' : 'commit', cr.id, cr.label || cr.id);
    }
    // 8. the journey of the selection: its path lights across the floor, the rest dims to 25 %
    const selP = this.selPipeline();
    // 9. labels: stage titles in the band above the floor's back edge, with leader lines
    this.drawLabels(g, detail, now);
    if (this.selected) this.drawJourney(g, ctx, f, selP, t);
    // failures riding home are named (failure is the main character), under the conveyor
    for (const cr of this.crates) {
      if (!cr.red || !cr.label) continue;
      const u = (t - cr.t0) / cr.dur;
      if (u < 0 || u > 1 || !this.pastScanner(cr, u)) continue;
      const [cu, cv] = this.along(cr, easeInOut(u));
      const x = cam.x(cu, cv), y = cam.y(cu, cv);
      if (cv < RETURN_V - 4) continue;
      g.vline(x, y + 4, y + 16, withAlpha(C.red, 0.6));
      this.tag(g, cr.label, x - 4, y + 28, C.redText, C.red);
    }
    // 10. the drawer, the time strip, the camera controls
    if (this.selected) this.drawDrawer(g, f, selP, now);
    if (!this.selected && this.cam.zoom < 1.2) this.drawLegend(g, f);
    // hover: quick facts beside the pointer
    if (this.hoverId && !this.drag) {
      const h = this.hitAt(this.px, this.py);
      if (h && h.label && h.kind !== 'stage' && h.kind !== 'drawer') {
        const facts = this.facts(h);
        const wv = Math.max(...facts.map((l) => g.width(l, SMALL))) + 16;
        const bx = Math.min(this.px + 14, f.width - wv - 8), by = this.py + 18;
        g.fillRect(bx, by, wv, facts.length * 16 + 10, '#161618');
        g.begin_(); g.rect(bx + 0.5, by + 0.5, wv - 1, facts.length * 16 + 9); g.stroke('#3A3A3E', 1);
        facts.forEach((l, i) => g.text(l, bx + 8, by + 18 + i * 16, i ? C.ink2 : C.ink, SMALL, i === 0));
      }
    }
    this.drawStrip(g, f, now);
    this.drawControls(g, f);
    const b0 = this.bays.find((x) => x.pid);
    if (b0 && this.logged !== `${b0.pid}|${this.cam.key}`) {
      this.logged = `${b0.pid}|${this.cam.key}`;
      const b = b0;
      if (b && this.cam.zoom === 1) console.log(`factory: busy bay ${b.pid} at ${Math.round(cam.x(b.u + b.du / 2, b.v + b.dv / 2))},${Math.round(cam.y(b.u + b.du / 2, b.v + b.dv / 2, ENG_H))}`);
    }
    this.lastT = t;
    const est = this.budget.estimate(g.ops, g.arcs, g.texts, this.crates.length);
    this.budget.record(est, g.ops, g.texts, 16.7, () => est);
    return true || moving || pulsing || flying;
  }

  private pastScanner(cr: Crate, u: number): boolean {
    const [cu] = this.along(cr, easeInOut(u));
    return cu <= SCAN_U + 1 && this.along(cr, easeInOut(u))[1] > cr.route[0][1] + 2 || cu < SCAN_U - 2 && cr.route[0][0] > SCAN_U - 60;
  }

  private along(cr: Crate, u: number): Pt {
    const d = u * cr.len;
    let i = 1;
    while (i < cr.cum.length - 1 && cr.cum[i] < d) i++;
    const a = cr.route[i - 1], b = cr.route[i];
    const seg = cr.cum[i] - cr.cum[i - 1] || 1;
    const k = clamp((d - cr.cum[i - 1]) / seg, 0, 1);
    return [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k];
  }

  private fill(g: Gfx, u0: number, v0: number, du: number, dv: number, h: number, top: string, side: string, front: string): void {
    this.box(g, u0, v0, du, dv, h, top, side, front, withAlpha(top, 0.9), g.hair);
  }

  private car(g: Gfx, u: number, v: number, red: boolean, settled: boolean): void {
    this.box(g, u - 4, v - 4, 8, 8, 5, red ? F.redTop : settled ? '#6E6A62' : F.crateTop, red ? F.redSide : settled ? '#4A4844' : F.crateSide, red ? F.redFront : settled ? '#3E3C38' : F.crateFront, red ? '#E08088' : settled ? '#8A867E' : '#F0CC8A', this.gl.hair);
  }

  private lamp(g: Gfx, u: number, v: number, z: number, col: string): void {
    g.begin_(); g.circle(this.cam.x(u, v), this.cam.y(u, v, z), 1.6); g.fill(col);
  }

  private ring(g: Gfx, u: number, v: number, r: number, z = 0): void {
    const x = this.cam.x(u, v), y = this.cam.y(u, v, z);
    g.begin_(); g.ctx.ellipse(x, y, r * this.cam.s + 4, (r * this.cam.s + 4) * 0.6, 0, 0, TAU); g.stroke(C.ink, 1.5);
  }

  private hit(x: number, y: number, w: number, h: number, kind: string, id: string, label: string): void {
    if (x + w < 0 || y + h < 0 || x > this.cam.W || y > this.cam.H) return;
    this.hits.push({ x, y, w, h, kind, id, label });
  }

  private pipeWords(p: Pipeline | undefined): string {
    if (!p) return '';
    return `${p.repo.split('/')[1]} #${p.number}`;
  }

  // ---- labels ----------------------------------------------------------------------------------
  /** Reserve a label rect, nudged up in 15 px rows until it touches no other label. */
  private place(x: number, y: number, w: number, h: number, maxUp = 9): number {
    const r = this.placeAt(x, y, w, h, maxUp, false);
    return r ? r[1] : -1;
  }

  /** Greedy placement over candidate positions (rows up, and with `slide` shifts sideways),
   *  measured boxes, a 12 px gap; null when nothing is free. */
  private placeAt(x: number, y: number, w: number, h: number, maxUp: number, slide: boolean): [number, number] | null {
    const G = 12;
    const free = (xx: number, yy: number) => {
      if (yy - h < 40 || xx < 4 || xx + w > this.cam.W - 4) return false;
      for (const l of this.labels) if (xx < l.x + l.w + G && xx + w + G > l.x && yy - h - 3 < l.y && yy + 3 > l.y - l.h) return false;
      return true;
    };
    const shifts = slide ? [0, 28, -28, 56, -56, 90, -90] : [0];
    for (let k = 0; k <= maxUp; k++) {
      for (const dx of shifts) {
        const xx = x + dx, yy = y - k * 15;
        if (free(xx, yy)) { this.labels.push({ x: xx, y: yy, w, h }); return [xx, yy]; }
      }
    }
    if (maxUp === 0 && !slide) return null;
    return null;
  }

  /** A label with its leader line: from the object's anchor (ax, ay) up to a label band. */
  private leader(g: Gfx, ax: number, ay: number, lift: number, parts: [string, string, boolean?][], px = MONO): [number, number] {
    let wsum = 0;
    for (const [s, , b] of parts) wsum += g.width(s, px, !!b);
    const at = this.placeAt(Math.round(ax - 3), Math.round(ay - lift), wsum, px + 3, 8, true);
    if (!at) return [0, -1];
    const [x, y] = at;
    const lx = Math.min(Math.max(ax, x + 2), x + wsum - 2);
    g.begin_(); g.move(ax, ay - 1); g.line(lx, y + 4); g.stroke('#4A4A4E', g.hair * 1.5);
    g.begin_(); g.circle(ax, ay, 1.6); g.fill('#6A6A6E');
    // a dark band under the words so nothing behind them competes
    g.fillRect(x - 3, y - px, wsum + 6, px + 5, withAlpha(C.canvas, 0.86));
    g.runs(parts, x, y, px);
    return [x, y];
  }

  private tag(g: Gfx, s: string, x: number, y: number, ink: string, edge: string): void {
    // (x moves with the placement)
    const w = g.width(s, SMALL) + 10;
    const at = this.placeAt(x, y, w, 16, 3, true);
    if (!at) return;
    const [xt, yy] = at;
    x = xt;
    g.fillRect(x, yy - 12, w, 16, withAlpha(C.canvas, 0.9));
    g.begin_(); g.rect(x + 0.5, yy - 11.5, w - 1, 15); g.stroke(withAlpha(edge, 0.7), 1);
    g.text(s, x + 5, yy, ink, SMALL);
  }

  private drawLabels(g: Gfx, detail: boolean, now: number): void {
    const cam = this.cam, c = this.census, w = this.world, f = c.flow;
    const num = (n: number) => n.toLocaleString('en-US');
    // the stage titles: anchored at each stage's back edge, lifted into the band above it
    const stage = (n: string, title: string, u: number, v: number, z: number, stat: string, why: string, id: string, statCol: string = C.ink2) => {
      const ax = cam.x(u, v), ay = cam.y(u, v, z);
      const l1 = g.width(`${n} `, SMALL) + g.width(title, TITLE, true), sub = stat + (why ? ` · ${why}` : '');
      const wv = Math.max(l1, g.width(sub, SMALL));
      const x = Math.round(ax - 3);
      // two lines placed as one block, so a neighbour's second line never lands on ours
      const yb = this.place(x, Math.round(ay - 34), wv, 36, 8);
      if (yb < 60) return;
      const y = yb - 17;
      g.vline(g.crisp(ax), yb + 3, ay - 1, '#4A4A4E');
      g.begin_(); g.circle(ax, ay, 1.8); g.fill('#7A7A7E');
      g.fillRect(x - 4, y - TITLE, wv + 8, 38, withAlpha(C.canvas, 0.86));
      g.runs([[`${n} `, C.ink3], [title, C.ink, true]], x, y, TITLE);
      g.runs([[stat, statCol], [why ? ` · ${why}` : '', C.ink3]], x, y + 17, SMALL);
      this.hit(x - 3, y - 14, wv + 6, 36, 'stage', id, title);
    };
    const pushes = c.docks.reduce((a, d) => a + d.perHour, 0);
    const busiest = [...c.docks].sort((a, b) => b.perHour - a.perHour)[0];
    stage('01', 'sources', 36, 30, 14, `${pushes} pushes/h`, busiest && busiest.perHour ? `${busiest.short} busiest` : 'quiet hour', '36,300,2');
    const open = c.phaseN.reduce((a, b) => a + b, 0);
    const stuck = c.stacks.reduce((a, r) => a + r.reduce((b, s) => b + s.stuck, 0), 0);
    stage('02', 'pr yard', YARD_U0 + 30, 92, 2, `${num(open)} open`, `${num(c.botN)} bot · depth = age`, '270,330,2');
    stage('03', 'merge gate', GATE_U + 4, AISLE_V - 36, 40, `${f.merges} merged/h`, '', `${GATE_U},${AISLE_V},2.6`);
    stage('04', 'main lines', RAIL_U0 + 40, RAIL_V[0] - 8, 0, `${c.redLines} red`, `one rail per org`, '550,290,2.4', C.redText);
    const waiting = c.waiting;
    stage('05', 'intake', INTAKE_U0 + 10, 258, 6, `${waiting} queued`, c.oldestWait > 60_000 ? `oldest ${dur(c.oldestWait)}` : `p50 ${dur(w.stats.p50_queue_ms || 0)}`, '705,291,3');
    const slots = c.groups.reduce((a, gr) => a + (gr.hosted ? 0 : gr.slots), 0);
    const busy = c.groups.reduce((a, gr) => a + (gr.hosted ? 0 : gr.running.length), 0);
    stage('06', 'consumption engine', ENG_U0 + 10, ENG_V0, ENG_H, `${c.building} building · ${busy} of ${slots} bays`, `${f.started} jobs/h · p50 ${dur(w.stats.p50_build_ms || 0)}`, '915,300,1.9', C.amberText);
    const pass = f.finished ? Math.round(((f.finished - f.failed) / f.finished) * 100) : Math.round((w.stats.success_rate_24h || 0) * 100);
    stage('07', 'tests', SCAN_U, 30, 56, `${pass}% pass`, `${f.failed} failed/h`, `${SCAN_U},330,2.4`);
    stage('08', 'deploy', SCAN_U + 40, TRACK_V[0] - 6, 0, `${c.deploying.length} deploying · ${f.deploys}/h`, '', `1165,330,2.6`, c.deploying.length ? C.amberText : C.ink2);
    let up = 0;
    for (const a of w.apps.values()) if (a.health === 'up') up++;
    stage('09', 'apps', CITY_U0 + 20, CITY_V0, 6, `${up} of ${w.apps.size} up`, `${c.districts.length} districts`, '1360,320,2');
    // engines: one label per machine (host · platform · busy/slots · cpu mem)
    c.groups.forEach((gr, gi) => {
      const v0 = ENG_V0 + gi * ENG_STEP;
      const ax = cam.x(ENG_U1 - 6, v0 + ENG_DV), ay = cam.y(ENG_U1 - 6, v0 + ENG_DV, 0);
      void ax; void ay;
      // the machine's name on its front face, screen-aligned, left
      const x = cam.x(ENG_U0 + 6, v0 + ENG_DV) + 4, y = cam.y(ENG_U0 + 6, v0 + ENG_DV, 0) + 16;
      const util = gr.slots ? Math.round((gr.running.length / gr.slots) * 100) : 0;
      const gauges = gr.cpu >= 0 ? `cpu ${Math.round(gr.cpu)}% · mem ${Math.round(gr.mem)}%` : gr.hosted ? 'hosted' : 'no gauges';
      const parts: [string, string, boolean?][] = [[gr.name, gr.online ? C.ink : C.ink3, true], [`  ${gr.hosted ? `${gr.running.length} running` : `${gr.running.length}/${gr.slots} · ${util}%`}`, gr.running.length ? C.amberText : C.ink3], [`  ${gauges}`, C.ink3]];
      let wsum = 0; for (const [s, , b] of parts) wsum += g.width(s, SMALL, !!b);
      const at = this.placeAt(x, y, wsum, 14, 2, true);
      let xx = x, yy = y;
      if (at) [xx, yy] = at; else this.labels.push({ x, y, w: wsum, h: 14 });
      const x2 = xx;
      g.fillRect(x2 - 3, yy - 11, wsum + 6, 15, withAlpha(C.canvas, 0.82));
      g.runs(parts, x2, yy, SMALL);
      this.hit(x2 - 3, yy - 11, wsum + 6, 15, 'engine', `915,${v0 + ENG_DV / 2},2.4`, gr.name);
    });
    // busy bays: the job's repo and how long it has run (red over 1.5× typical). At fleet
    // zoom only the four that matter most are named (overruns, then the longest running).
    const busyBays = this.bays.filter((b) => b.pid && w.pipelines.get(b.pid));
    const el = (b: Bay) => { const p = w.pipelines.get(b.pid)!; return p.started ? Math.max(0, now - p.started) : 0; };
    const over = (b: Bay) => { const p = w.pipelines.get(b.pid)!; return p.expected_ms ? el(b) / p.expected_ms : 0; };
    busyBays.sort((a, b) => (over(b) > 1.5 ? 1 : 0) - (over(a) > 1.5 ? 1 : 0) || el(b) - el(a));
    const perMachine = new Map<number, number>();
    const named = busyBays.filter((b) => {
      if (b.pid === this.hoverId) return true;
      const n = perMachine.get(b.group) ?? 0;
      if (n >= (detail ? 3 : 2)) return false;
      perMachine.set(b.group, n + 1);
      return true;
    });
    named.sort((a, b) => a.group - b.group || a.slot - b.slot);
    for (const b of named) {
      const p = w.pipelines.get(b.pid)!;
      const e = el(b), exp = p.expected_ms ?? 0;
      const name = p.repo.split('/')[1] ?? p.repo;
      const ax = cam.x(b.u + b.du * 0.5, b.v), ay = cam.y(b.u + b.du * 0.5, b.v, ENG_H);
      const step = detail ? runningStep(p) : '';
      this.leader(g, ax, ay, 18 + (b.slot % 2) * 16, [[name, C.ink], [` ${dur(e)}`, exp && e > exp * 1.5 ? C.redText : C.amberText], [step.length >= 3 ? ` · ${step}` : '', C.ink3]], SMALL);
    }
    if (!detail && busyBays.length > named.length) {
      const gx = cam.x(ENG_U1 - 40, ENG_V0), gy = cam.y(ENG_U1 - 40, ENG_V0, ENG_H);
      void gx; void gy;
    }
    // PR yard: phase names along the front, counts on stacks when zoomed, pallet names
    PHASES.forEach((ph, r) => {
      const x = cam.x(ROW_U[r] - ROW_DU / 2, AGE_V[0] + STACK_DV + 14), y = cam.y(ROW_U[r] - ROW_DU / 2, AGE_V[0] + STACK_DV + 14) + 4;
      const s = `${ph} ${c.phaseN[r]}`;
      const yy = this.place(x, y, g.width(s, SMALL), 13, 0);
      if (yy >= 0) g.runs([[ph, C.ink2], [` ${c.phaseN[r]}`, C.ink]], x, yy, SMALL);
      if (detail) {
        AGE_V.forEach((v, b) => {
          const st = c.stacks[r][b];
          if (!st.n) return;
          const layers = Math.min(16, Math.ceil(st.n / 3));
          const sx = cam.x(ROW_U[r], v + STACK_DV / 2), sy = cam.y(ROW_U[r], v + STACK_DV / 2, 4 + layers * 2.6) - 4;
          const col = st.red >= st.n / 2 && st.red ? C.redText : st.stuck >= st.n / 2 ? C.ink : C.ink2;
          g.text(String(st.n), sx, sy, col, SMALL, true, 'center');
        });
      }
    });
    // the age axis along the yard's right edge (depth = age)
    {
      const ages = detail ? [0, 1, 2, 3, 4, 5] : [];
      for (const b of ages) {
        const x = cam.x(YARD_U0 + 4, AGE_V[b] + STACK_DV / 2) - 4, y = cam.y(YARD_U0 + 4, AGE_V[b] + STACK_DV / 2) + 4;
        g.fillRect(x - g.width(AGE_WORDS[b], SMALL) - 2, y - 10, g.width(AGE_WORDS[b], SMALL) + 4, 13, withAlpha(C.canvas, 0.8));
        g.text(AGE_WORDS[b], x, y, C.ink3, SMALL, false, 'right');
      }
    }
    c.pallets.forEach((p, i) => {
      const u0 = YARD_U0 + 8 + i * 76;
      const x = cam.x(u0, PALLET_V + 18) + 2, y = cam.y(u0, PALLET_V + 18) + 14;
      const yy = this.place(x, y, g.width(`${p.bot} ${p.n}`, SMALL), 13, 0);
      if (yy >= 0) g.runs([[p.bot, C.ink3], [` ${p.n}`, C.ink2]], x, yy, SMALL);
    });
    // sources: each dock's org and push rate
    c.docks.forEach((d, i) => {
      const v = 66 + i * 96;
      const x = cam.x(DOCK_U0, v + 30) - 4, y = cam.y(DOCK_U0, v + 30) + 14;
      const s = `${d.short} ${d.perHour}/h`;
      const wv = g.width(s, SMALL);
      const yy = this.place(x - wv, y, wv, 13, 0);
      if (yy >= 0) g.runs([[d.short, d.org === BOTS ? C.ink3 : C.ink2], [` ${d.perHour}/h`, C.ink]], x - wv, yy, SMALL);
    });
    // rails: the org at the rail's start
    c.rails.forEach((r, i) => {
      const x = cam.x(RAIL_U0 + 2, RAIL_V[i] - 18), y = cam.y(RAIL_U0 + 2, RAIL_V[i] - 18) - 2;
      const s = `${r.short}${r.red ? ` ${r.red} red` : ''}`;
      const yy = this.place(x, y, g.width(s, SMALL), 13, 0);
      if (yy >= 0) g.runs([[r.short, C.ink3], [r.red ? ` ${r.red} red` : '', C.redText]], x, yy, SMALL);
    });
    // deploy tracks
    VIAS.forEach((via, i) => {
      const x = cam.x(SCAN_U + 16, TRACK_V[i] - 30), y = cam.y(SCAN_U + 16, TRACK_V[i] - 30) - 2;
      const s = `${VIA_WORDS[via]} ${f.byVia[via] ?? 0}`;
      const yy = this.place(x, y, g.width(s, SMALL), 13, 0);
      if (yy >= 0) g.runs([[VIA_WORDS[via], C.ink3], [` ${f.byVia[via] ?? 0}/h`, C.ink2]], x, yy, SMALL);
    });
    // city districts: team names; zoomed, the apps' names too
    for (const d of this.districtBox) {
      const x = cam.x(d.u0, d.v1) - 2, y = cam.y(d.u0, d.v1) + 12;
      const s = `${d.team} ${d.n}`;
      const yy = this.place(x, y, g.width(s, SMALL), 13, 0);
      if (yy >= 0) {
        g.fillRect(x - 2, yy - 10, g.width(s, SMALL) + 4, 13, withAlpha(C.canvas, 0.75));
        g.runs([[d.team, C.ink2], [` ${d.n}`, C.ink3]], x, yy, SMALL);
        this.hit(x - 2, yy - 10, g.width(s, SMALL) + 4, 13, 'district', `${(d.u0 + d.u1) / 2},${(d.v0 + d.v1) / 2},3.2`, d.team);
      }
    }
    // the focal story: the newest commit that broke a main line, named over its car
    const fc = c.focal;
    if (fc && !this.selected) {
      const ri = c.rails.findIndex((r) => r.org === w.orgOf(fc.repo));
      const rail = c.rails[ri];
      const k = rail ? rail.cars.findIndex((x) => x.sha === fc.sha && x.repo === fc.repo) : -1;
      if (rail && k >= 0) {
        const u = RAIL_U1 - 12 - (rail.cars.length - 1 - k) * 10, v = RAIL_V[ri];
        const ax = cam.x(u, v), ay = cam.y(u, v, 6);
        const name = fc.repo.split('/')[1] ?? fc.repo;
        this.leader(g, ax, ay, 46, [[name, C.redText, true], [' broke main', C.redText], [` · ${fc.sha.slice(0, 7)} · ${fc.author} · ${dur(now - fc.at)} ago`, C.ink2]], SMALL);
      }
    }
    if (cam.zoom >= 2.6) {
      // apps by name, whole names only: those that deployed today first, then the rest while
      // the placer finds room (never a cut name)
      const order = [...this.blocks].sort((a, b) => (c.deploys24.get(b.id) ?? 0) - (c.deploys24.get(a.id) ?? 0));
      let n = 0;
      for (const b of order) {
        if (n >= 48) break;
        const x = cam.x(b.u + b.d, b.v + b.d / 2) + 3, y = cam.y(b.u + b.d, b.v + b.d / 2, b.h) + 4;
        if (x < 0 || x > cam.W - 380 * (this.selected ? 1 : 0) - 8 || y < 60 || y > cam.H - 70) continue;
        const wv = g.width(b.id, SMALL);
        if (this.place(x, y, wv, 13, 0) < 0) continue;
        g.fillRect(x - 2, y - 10, wv + 4, 13, withAlpha(C.canvas, 0.78));
        g.text(b.id, x, y, (c.deploys24.get(b.id) ?? 0) > 0 ? C.ink2 : C.ink3, SMALL);
        n++;
      }
    }
  }

  // ---- the journey -------------------------------------------------------------------------------
  private journeyPath(p: Pipeline | null): { pts: Pt[]; red: boolean; stops: [Pt, string][] } {
    const w = this.world;
    const cm = this.selCommit();
    const repo = p?.repo ?? cm?.repo ?? '';
    const org = w.orgOf(repo);
    const dv = this.dockV(org), rv = this.railV(org);
    const pts: Pt[] = [[DOCK_U0 + 20, dv], [COLLECT_U, dv], [COLLECT_U, AISLE_V]];
    const stops: [Pt, string][] = [[[DOCK_U0 + 20, dv], 'pushed']];
    const prN = p?.pr ?? w.commits.get(`${repo}@${cm?.sha ?? ''}`)?.pr;
    if (prN || p?.event === 'pull_request') {
      pts.push([ROW_U[1], AISLE_V], [ROW_U[1], AGE_V[0] + 10], [ROW_U[3], AGE_V[0] + 10], [ROW_U[3], AISLE_V]);
      stops.push([[ROW_U[1], AGE_V[0] + 10], `PR #${prN ?? ''}`]);
    }
    pts.push([YARD_U1, AISLE_V], [GATE_U + 4, AISLE_V], [RAIL_U0, rv], [RAIL_U1, rv], [INTAKE_U0, LANE_V[p?.lane === 'gha' ? 1 : 0]], [INTAKE_U1, LANE_V[p?.lane === 'gha' ? 1 : 0]]);
    stops.push([[GATE_U + 4, AISLE_V], 'merged']);
    stops.push([[INTAKE_U0 + 20, LANE_V[p?.lane === 'gha' ? 1 : 0]], 'queued']);
    const bay = p ? (this.bays.find((b) => b.pid === p.id) ?? this.lastBay.get(p.id ?? '')) : undefined;
    const gi = p?.lane === 'gha' ? this.census.groups.length - 1 : 0;
    const bv = bay ? bay.v + bay.dv / 2 : ENG_V0 + gi * ENG_STEP + ENG_DV / 2;
    const bu = bay ? bay.u + bay.du / 2 : (ENG_U0 + ENG_U1) / 2;
    pts.push([DIST_U, LANE_V[0]], [DIST_U, bv], [bu, bv]);
    stops.push([[bu, bv], p?.state === 'running' ? 'building' : 'built']);
    if (!p || p.state === 'running' || p.state === 'pending') return { pts, red: false, stops };
    pts.push([ENG_U1, bv], [SCAN_U, bv]);
    const red = p.state === 'failure' || p.state === 'error';
    stops.push([[SCAN_U, bv], red ? `failed · ${failingStep(p)}` : 'passed']);
    if (red) {
      pts.push([SCAN_U, RETURN_V], [24, RETURN_V], [24, dv]);
      return { pts, red, stops };
    }
    const dep = w.deploys.get(`${p.repo}@${p.sha}`);
    const app = dep?.app ?? w.repos.get(p.repo)?.app;
    const b = app ? this.blockAt.get(app) : undefined;
    if (b && (dep || p.deploy)) {
      const vi = Math.max(0, VIAS.indexOf(((dep?.via === 'manual' ? 'gha_fallback' : dep?.via) ?? 'roadrunner') as typeof VIAS[number]));
      pts.push([SCAN_U, TRACK_V[vi]], [TRACK_U1, TRACK_V[vi]], [b.u + b.d / 2, b.v + b.d / 2]);
      stops.push([[b.u + b.d / 2, b.v + b.d / 2], `${app} ${dep?.state === 'success' ? 'deployed' : dep?.state ?? 'deploying'}`]);
    }
    return { pts, red, stops };
  }

  private drawJourney(g: Gfx, ctx: Ctx2D, f: Frame, p: Pipeline | null, t: number): void {
    const cam = this.cam;
    // the rest of the floor dims to 25 %
    g.fillRect(0, 0, f.width, f.height, withAlpha(C.canvas, 0.75));
    const { pts, red, stops } = this.journeyPath(p);
    const col = red ? C.red : C.packet;
    const trace = () => { g.begin_(); pts.forEach(([u, v], i) => { const x = cam.x(u, v), y = cam.y(u, v, 1); if (i) g.line(x, y); else g.move(x, y); }); };
    ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    trace(); g.stroke(withAlpha(col, 0.18), 9);
    trace(); g.stroke(withAlpha(col, 0.35), 4);
    trace(); g.stroke(col, 1.5);
    // a travelling spark along the lit path (where the selection is now)
    let total = 0;
    for (let i = 1; i < pts.length; i++) total += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    const run = p?.state === 'running';
    if (run) {
      const bay = this.bays.find((b) => b.pid === p?.id);
      if (bay) this.crate(g, bay.u + bay.du / 2, bay.v + bay.dv / 2, 11, false, false, ENG_H - 3);
    }
    void total; void t;
    // stops: the stations it passed, named (the dimmed words below no longer claim space)
    this.labels = [];
    stops.forEach(([[u, v], s], i) => {
      const x = cam.x(u, v), y = cam.y(u, v, 1);
      g.begin_(); g.move(x, y - 4); g.line(x + 4, y); g.line(x, y + 4); g.line(x - 4, y); g.ctx.closePath(); g.fill(i === stops.length - 1 ? col : C.ink);
      const bad = s.startsWith('failed');
      this.tag(g, s, x + 7, y - 6, bad ? C.redText : C.ink2, bad ? C.red : '#5A5A5E');
    });
  }

  // ---- the drawer ----------------------------------------------------------------------------------
  private drawDrawer(g: Gfx, f: Frame, p: Pipeline | null, now: number): void {
    const w = this.world;
    const W = 372, x0 = f.width - W, y0 = 40, H = f.height - y0 - 66;
    g.fillRect(x0, y0, W, H, '#111112');
    g.vline(g.crisp(x0), y0, y0 + H, '#2E2E30');
    g.hline(x0, x0 + W, g.crisp(y0), '#2E2E30');
    this.hit(x0, y0, W, H, 'drawer', '', '');
    this.hit(x0 + W - 30, y0 + 6, 24, 22, 'close', '', 'close');
    g.text('×', x0 + W - 18, y0 + 22, C.ink3, 14, false, 'center');
    let y = y0 + 24;
    const j = this.journey && this.journeyFor === this.selected ? this.journey : null;
    // the world may no longer hold it (a replay, retention): the journey the server sent does
    if (!p && j?.pipelines?.length) p = j.pipelines.find((q) => q.id === this.selected) ?? j.pipelines[j.pipelines.length - 1];
    const cm = this.selCommit() ?? (j ? { repo: j.repo, sha: j.sha } : null);
    const commit = (cm ? w.commits.get(`${cm.repo}@${cm.sha}`) : undefined) ?? j?.commit ?? undefined;
    const repo = p?.repo ?? cm?.repo ?? '';
    const state = p?.state ?? commit?.ci ?? '';
    const stCol = state === 'failure' || state === 'error' ? C.redText : state === 'success' ? C.green : C.amberText;
    g.text(p ? `${p.lane === 'gha' ? 'github actions' : 'roadrunner'} #${p.number}` : 'commit', x0 + 16, y, C.ink3, SMALL);
    y += 20;
    g.text(g.fit(repo, 13, W - 40, true), x0 + 16, y, C.ink, 13, true);
    y += 18;
    const title = p?.title ?? commit?.title ?? '';
    g.text(g.fit(title, MONO, W - 32), x0 + 16, y, C.ink2, MONO);
    y += 16;
    const sha = (p?.sha ?? cm?.sha ?? '').slice(0, 7);
    g.runs([[sha, C.ink3], [` · ${p?.branch ?? commit?.branch ?? ''}`, C.ink3], [` · ${p?.author ?? commit?.author ?? ''}`, C.ink3]], x0 + 16, y, SMALL, W - 32);
    y += 22;
    const el = p?.started ? (p.finished ?? now) - p.started : 0;
    const exp = p?.expected_ms ?? 0;
    g.runs([[state || 'unknown', stCol, true], [el ? `  ${dur(el)}${state === 'running' && exp ? ` of ~${dur(exp)}` : ''}` : '', C.ink2], [p?.engine ? `  on ${p.engine}` : '', C.ink3]], x0 + 16, y, MONO, W - 32);
    y += 26;
    // timeline
    const eyebrow = (s: string) => { g.hline(x0 + 16, x0 + W - 16, g.crisp(y - 12), '#232325'); g.text(s, x0 + 16, y + 2, C.ink3, SMALL); y += 18; };
    eyebrow('TIMELINE');
    const tl: [number, string, string][] = [];
    if (j?.timeline?.length) for (const e of j.timeline.slice(-9)) tl.push([e.at, e.k, e.label]);
    else {
      if (commit) tl.push([commit.at, 'push', `pushed by ${commit.author}`]);
      if (p) {
        tl.push([p.created, 'enqueue', `queued on ${p.lane}`]);
        if (p.started) tl.push([p.started, 'start', `started${p.engine ? ` on ${p.engine}` : ''}`]);
        if (p.finished) tl.push([p.finished, 'finish', `${p.state}${p.state === 'failure' ? ` at ${failingStep(p)}` : ''}`]);
      }
      const d = w.deploys.get(`${repo}@${p?.sha ?? cm?.sha ?? ''}`);
      if (d) tl.push([d.started, 'deploy', `deploy ${d.app} via ${VIA_WORDS[d.via] ?? d.via} · ${d.state}`]);
    }
    tl.sort((a, b) => a[0] - b[0]);
    const t0 = tl[0]?.[0] ?? now;
    for (const [at, k, s] of tl) {
      const bad = /fail|error/.test(s);
      g.begin_(); g.circle(x0 + 20, y - 4, 2.5); g.fill(bad ? C.red : k === 'deploy' || k === 'deployed' ? C.green : C.packet);
      g.text(at === t0 ? clockWords(at, this.offsetMin) : `+${dur(at - t0)}`, x0 + 30, y, C.ink3, SMALL);
      g.text(g.fit(s, SMALL, W - 120), x0 + 104, y, bad ? C.redText : C.ink2, SMALL);
      y += 16;
      if (y > y0 + H * 0.45) break;
    }
    y += 12;
    // steps: each workflow's steps as a bar on a shared axis
    eyebrow('STEPS');
    const wfs = (j?.pipelines?.find((q) => q.id === p?.id) ?? p)?.workflows ?? [];
    let sMin = Infinity, sMax = 0;
    for (const wf of wfs) for (const s of wf.steps) { if (s.started) sMin = Math.min(sMin, s.started); sMax = Math.max(sMax, s.finished ?? (s.started ? now : 0)); }
    const axisW = W - 32 - 150;
    let shown = 0;
    for (const wf of wfs) {
      if (y > y0 + H - 90) break;
      g.text(g.fit(wf.name, SMALL, W - 40), x0 + 16, y, C.ink2, SMALL, true);
      y += 15;
      for (const s of wf.steps) {
        if (y > y0 + H - 80) { g.text(`… ${wf.steps.length - shown} more`, x0 + 16, y, C.ink3, SMALL); y += 15; break; }
        shown++;
        const bad = s.state === 'failure' || s.state === 'error';
        const run = s.state === 'running';
        g.text(g.fit(s.name, SMALL, 140), x0 + 22, y, bad ? C.redText : run ? C.amberText : C.ink3, SMALL);
        if (s.started && sMax > sMin) {
          const a = x0 + 166 + ((s.started - sMin) / (sMax - sMin)) * axisW;
          const b = x0 + 166 + (((s.finished ?? now) - sMin) / (sMax - sMin)) * axisW;
          g.fillRect(a, y - 7, Math.max(2, b - a), 6, bad ? C.red : run ? C.packet : s.cached ? '#3A3A3E' : '#5A6E5F');
        }
        y += 14;
      }
    }
    if (!wfs.length) { g.text('no steps reported for this run', x0 + 16, y, C.ink3, SMALL); y += 16; }
    y += 12;
    // deploys
    if (y < y0 + H - 40) {
      eyebrow('DEPLOYS');
      const deps = j?.deploys?.length ? j.deploys : [...w.deploys.values()].filter((d) => d.repo === repo && d.sha === (p?.sha ?? cm?.sha));
      if (!deps.length) g.text(p?.deploy ? 'deploys after it passes' : 'this run deploys nothing', x0 + 16, y, C.ink3, SMALL);
      for (const d of deps.slice(0, 3)) {
        g.runs([[d.app, C.ink, true], [`  via ${VIA_WORDS[d.via] ?? d.via}`, C.ink3], [`  ${d.state}`, d.state === 'success' ? C.green : d.state === 'failure' ? C.redText : C.amberText]], x0 + 16, y, SMALL, W - 32);
        y += 16;
      }
    }
  }

  // ---- the time strip and the fleet sentence ------------------------------------------------------
  private drawStrip(g: Gfx, f: Frame, now: number): void {
    const c = this.census, w = this.world, tl = this.tl;
    const y0 = f.height - 58, H = 58, W = f.width;
    g.fillRect(0, y0, W, H, withAlpha(C.canvas, 0.94));
    g.hline(0, W, g.crisp(y0), '#1F1F21');
    // the span control: live · last hour · 24 h
    const mode = tl.mode;
    const opts: [string, string][] = [['live', 'live'], [mode === 'replay' ? 'replaying the hour' : 'replay last hour', 'replay'], ['24 h at 60×', 'replay24']];
    let x = 16;
    g.fillRect(x, y0 + 13, 4 + opts.reduce((a, [s]) => a + g.width(s, 13) + 22, 0), 28, '#1A1A1C');
    x += 2;
    for (const [s, k] of opts) {
      const on = (k === 'live' && mode === 'live') || (k === 'replay' && mode === 'replay');
      const wv = g.width(s, 13) + 22;
      if (on) g.fillRect(x, y0 + 15, wv, 24, '#2C2C2E');
      if (k === 'live') { g.begin_(); g.circle(x + 10, y0 + 27, 3); g.fill(mode === 'live' ? C.green : C.ink4); }
      g.text(s, x + (k === 'live' ? 17 : 11), y0 + 31.5, on ? C.ink : C.ink2, 13);
      this.hit(x, y0 + 13, wv, 28, k, k, s);
      x += wv;
    }
    // the last 24 h: event density per 5 min, failures red, the playhead amber
    const sx = x + 20, sw = Math.min(460, W * 0.3), sh = 22, sy = y0 + 13;
    let mx = 1;
    for (let i = 0; i < 288; i++) mx = Math.max(mx, c.dens[i]);
    g.begin_();
    for (let i = 0; i < 288; i++) { const h = (c.dens[i] / mx) * sh; if (h > 0.3) g.rect(sx + (i / 288) * sw, sy + sh - h, Math.max(0.8, sw / 288 - 0.4), h); }
    g.fill('#3A3A3E');
    g.begin_();
    for (let i = 0; i < 288; i++) { const h = (c.densRed[i] / mx) * sh; if (h > 0.3) g.rect(sx + (i / 288) * sw, sy + sh - h, Math.max(0.8, sw / 288 - 0.4), h); }
    g.fill(C.red);
    g.hline(sx, sx + sw, g.crisp(sy + sh + 0.5), '#2A2A2C');
    const ph = mode === 'replay' ? 1 - (tl.liveNow() - now) / (24 * HOUR_MS) : 1;
    const px = sx + clamp(ph, 0, 1) * sw;
    g.vline(g.crisp(px), sy - 3, sy + sh + 3, C.packet, 1.5);
    g.text('24 h ago', sx, sy + sh + 15, C.ink3, 12);
    g.text(mode === 'live' ? 'now' : clockWords(now, this.offsetMin), sx + sw, sy + sh + 15, mode === 'live' ? C.ink3 : C.amberText, 12, false, 'right');
    // the fleet sentence: failure first
    const red = c.redLines;
    let up = 0, down = 0;
    for (const a of w.apps.values()) { if (a.health === 'up') up++; else if (a.health === 'down') down++; }
    const bx = sx + sw + 26;
    const head: [string, string, boolean?][] = red ? [[`${red} main ${red === 1 ? 'line' : 'lines'} red`, C.redText, true]] : [['every main line green', C.green, true]];
    if (down) head.push([` · ${down} ${down === 1 ? 'app' : 'apps'} down`, C.redText, true]);
    const slots = c.groups.reduce((a, gr) => a + (gr.hosted ? 0 : gr.slots), 0);
    const busy = c.groups.reduce((a, gr) => a + (gr.hosted ? 0 : gr.running.length), 0);
    // one count per thing, the same words the floor and the status line use
    const tail: string[] = [`${c.building} building (${busy} of ${slots} bays)`, `${c.waiting} queued`, `${c.deploying.length} deploying`, `${c.flow.finished} builds/h`, `${c.flow.failed} failed/h`, `${up} of ${w.apps.size} apps up`];
    if (c.bottleneck) tail.push(`bottleneck: ${({ prs: 'pr yard', intake: 'intake', engines: 'the engines', deploy: 'deploy' } as Record<string, string>)[c.bottleneck]}`);
    // whole fields only: drop from the end instead of cutting one
    let room = W - bx - 16 - head.reduce((a, [s, , b]) => a + g.width(s, 13, !!b), 0);
    let line = '';
    for (const t of tail) { const add = `  ·  ${t}`; if (g.width(line + add, 13) > room) break; line += add; }
    g.runs([...head.map(([s, col]) => [s, col, true] as [string, string, boolean]), [line, C.ink2]], bx, y0 + 26, 13);
    void room;
    const parts = [`${w.repos.size} repos`, `${c.docks.length - 1} orgs`, `${this.census.phaseN.reduce((a, b) => a + b, 0) + c.botN} PRs open`];
    if (c.redNames.length) parts.push(`newest red: ${c.redNames.join(', ')}`);
    let l2 = '';
    for (const t of parts) { const add = l2 ? ` · ${t}` : t; if (g.width(l2 + add, 12) > W - bx - 16) break; l2 += add; }
    g.text(l2, bx, y0 + 44, C.ink3, 12);
  }

  private facts(h: HitBox): string[] {
    const w = this.world, now = this.tl.playhead;
    if (h.kind === 'pipeline') {
      const p = w.pipelines.get(h.id);
      if (!p) return [h.label];
      const el = p.started ? (p.finished ?? now) - p.started : now - p.created;
      return [`${p.repo} #${p.number}`, `${p.state} · ${dur(el)}${p.expected_ms ? ` · typical ${dur(p.expected_ms)}` : ''}`, `${p.event} · ${p.branch}${p.engine ? ` · ${p.engine}` : ''}`, 'click: light its journey'];
    }
    if (h.kind === 'app') {
      const a = w.apps.get(h.id);
      return [h.id, `${a?.health ?? 'unknown'}${a?.latency_ms ? ` · ${a.latency_ms} ms` : ''}${a?.team ? ` · ${a.team}` : ''}`, `${this.census.deploys24.get(h.id) ?? 0} deploys in 24 h${a?.behind ? ` · ${a.behind} behind main` : ''}`];
    }
    if (h.kind === 'commit') return [h.label.slice(0, 60), 'click: light its journey'];
    return [h.label];
  }

  /** The key, in the floor's empty front-left corner: what each physical thing is. */
  private drawLegend(g: Gfx, f: Frame): void {
    const x = 18, y = f.height - 58 - 26;
    const items: [string, string][] = [['crate', 'a pipeline (amber: in flight)'], ['car', 'a merged commit on its org\'s main line'], ['stack', 'open PRs by phase; height = count, depth = age'], ['bay', 'an engine slot, lit while it builds']];
    let yy = y - (items.length - 1) * 17;
    for (const [k, s] of items) {
      g.runs([[k.padEnd(6, ' '), C.ink2, true], [s, C.ink3]], x, yy, SMALL);
      yy += 17;
    }
    g.text('failed crates turn red at the scanner and ride the return conveyor home', x, yy + 2, C.redText, SMALL);
  }

  private drawControls(g: Gfx, f: Frame): void {
    const x = 16, y = 46;
    const btn = (s: string, k: string, xx: number) => {
      g.fillRect(xx, y, 24, 22, '#1A1A1C');
      g.begin_(); g.rect(xx + 0.5, y + 0.5, 23, 21); g.stroke('#2E2E30', 1);
      g.text(s, xx + 12, y + 15, C.ink2, 12, false, 'center');
      this.hit(xx, y, 24, 22, k, k, s);
    };
    btn('+', 'zoomin', x); btn('−', 'zoomout', x + 26); btn('⌂', 'fit', x + 52);
    const lod = this.cam.zoom >= 2.6 ? 'apps' : this.cam.zoom >= 1.6 ? 'org districts' : 'fleet';
    const words: [string, string][] = [[`${Math.round(this.cam.zoom * 100)}%`, C.ink2], [`  ${lod}`, C.ink2], ['  drag to pan · wheel to zoom · click a crate', C.ink3]];
    const wv = words.reduce((a, [s]) => a + g.width(s, SMALL), 0);
    g.fillRect(x + 80, y, wv + 12, 22, withAlpha(C.canvas, 0.86));
    g.runs(words, x + 86, y + 15, SMALL);
    void f;
  }
}

const HOUR_MS = 3_600_000;

function runningStep(p: Pipeline): string {
  for (const wf of p.workflows ?? []) for (const s of wf.steps ?? []) if (s.state === 'running') return s.name;
  return '';
}

export function dur(ms: number): string {
  if (!(ms > 0)) return '0s';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`.replace(/ 0s$/, '');
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ${m % 60}m`.replace(/ 0m$/, '');
  return `${Math.floor(h / 24)}d`;
}

function clockWords(at: number, offsetMin: number): string {
  const d = new Date(at + offsetMin * 60_000);
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}:${String(d.getUTCSeconds()).padStart(2, '0')}`;
}

function easeInOut(u: number): number { return u <= 0 ? 0 : u >= 1 ? 1 : u < 0.5 ? 2 * u * u : 1 - Math.pow(-2 * u + 2, 2) / 2; }

function hash(s: string): number { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return Math.abs(h); }

void AGES; void short; void font;
