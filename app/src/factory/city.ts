// THE APP CITY (fab-w5; FACTORY-SPEC §B, §C, §D, §G, §I-W5). One building per app, in districts
// that ARE the floor's group lanes, every mark a measured fact:
//
//   districts    one per group lane that has apps, in lane order back → front (groups.ts lanes():
//                the hued teams, "other teams", the orgs; the bots siding has no apps), each a
//                plate tinted with its group's hue, as big as its app count, packed edge to edge.
//                The census's districts are replaced by these (`census` hook), so the lens, the
//                coffee check and the labels all read the same districts.
//   storeys      a building is a ground floor plus ONE STOREY PER SUCCESSFUL DEPLOY in the last
//                7 d (≤ 10: the server lists an app's last 10), from `GET /api/v1/app/{id}`
//                through insights.appHistoryAsync (fetched by `pump` from a data turn, never from
//                a draw), merged with the world's 24 h of deploys and the deploy events seen.
//   ghost        App.behind (or main_sha ≠ live_sha) as hollow, faint storeys stacked on the
//   storeys      roof, one per undeployed commit (≤ 5, then a "+N" notch); on hover or the app
//                lens, an amber tether from its group's main-line rail. NEVER a crane.
//   health ring  on the roof: the app lens's 7 d health ring in small (lenses.ts healthSegs): from
//                the back, clockwise, a week ago → now, up green-gray, degraded amber, down red,
//                before the history begins gray; quiet (shown only zoomed in) when the week holds
//                no incident. Down: a red building with dark windows (a beacon anchor for
//                W4: `buildingAnchor`); degraded: amber flicker on the beat; idle (no deploy
//                known in 30 d): desaturated, no lit windows.
//   tracks       the deploy stage fans out to the city: a ladder along the city's edge, one spur
//                per district down its main street, the spur's bed as wide as the group's deploys
//                (the v0.5 trend, 7 d); a deploy's crate rides via → ladder → spur → its building,
//                and the building's ring flashes when it arrives (§G: deploy → track → building).
//
//   fleet zoom   (fx-city, review #11) below the group zoom the city is calm unless something is
//                wrong: each district a skyline in its lane's hue (idle grey, down red, degraded
//                amber on the beat), named once at its front edge (≤ 10, through the placer); ghost storeys only from 3 commits behind (1–2: a
//                roof tick); no green "up" lights and no past-incident rings. Every app up (held a
//                minute): the city packs compact, its districts start ~30 % of the plot further
//                from the ladder, and the spurs take that ground: each district's band, its spur
//                bed and its last 24 h of deploys as hourly ticks along the approach.
//   night        (w2-chrome, REVIEW-iter3 #10, WOW #2) at the fleet zoom the city is at night:
//                each district's buildings stand sorted tall to short from its back corner (one
//                skyline), and a building's storeys deployed in the last 24 h are LIT windows,
//                the newest brightest (the window of a deploy dims with its age, by the hour);
//                a building that shipped nothing today stands dark in its hue, and a district
//                that shipped nothing today goes dark grey. Calm also needs no deploy in the last
//                hour: a city that is deploying keeps the whole plot. Named at the front edge
//                (≤ DISTRICT_NAMES_MAX: trouble first, then today's busiest).
//
// LOD by a building's size on screen (DESIGN.md "LOD"): LOD0 faces, edges, rings, storeys or
// windows by zoom; LOD1 faces, rings; LOD2 silhouettes, a light only where not up; LOD3 a
// district's run of a row as one strip. Rows off screen are skipped. No height is ever invented:
// a building with no data stands one floor high.

import type { Event } from '../wire.ts';
import type { World } from '../world.ts';
import type { Gfx } from '../yard/gfx.ts';
import { C, TAU, clamp, withAlpha } from '../yard/theme.ts';
import { appHistoryAsync, insights, type AppHistoryResult } from '../insights.ts';
import { healthSegs } from './lenses.ts';
import { normTeam, teamGroupId } from '../../server/floor.ts';
import type { Factory } from './factory.ts';
import { BOTS_LANE, OTHER_LANE, floorGroups, type Lane } from './groups.ts';
import { UX, UY, VX, VY } from './iso.ts';
import { GROUP_Z_IN, PLAN } from './layout.ts';
import { R_RING, breathe, flash } from './motion.ts';
import { F, flushLights, poly, quad } from './prims.ts';
import type { Block, DistrictBox, FloorPass, Layer, Lens, LiveFrame, Pt } from './types.ts';

const { SCAN_U, TRACK_V, TRACK_U1, CITY_U1, CITY_V0, CITY_V1, VIAS, RAIL_U0, RAIL_U1, RAIL_V } = PLAN;

const DAY = 86_400_000;
/** One successful deploy in the last 7 d (world units of height). */
export const STOREY = 3.2;
/** The ground floor every app has. */
export const BASE = 1.8;
/** The server lists an app's last 10 deploys: a building tops out there. */
export const STOREY_CAP = 10;
/** Ghost storeys shown; more commits behind than this put a "+N" notch on the top one. */
export const GHOST_CAP = 5;
/** The ladder the deploy tracks join, along the city's edge, and where the districts start. */
export const LADDER_U = TRACK_U1 + 6;
export const DIST_U0 = LADDER_U + 10;
/** A district's main street (its spur runs down the middle) and the gap between districts. */
const SPUR_ST = 10, GAP = 3;
/** A building's footprint over its lot: ≤ 0.705 keeps a row's buildings apart on screen, so one
 *  batch paints a whole row. Static sites stand on a smaller lot. */
const LOT = 0.68, STATIC_LOT = 0.74;
/** App histories: refetched every SWEEP of the module clock, IN_FLIGHT at a time, ≤ PER_TURN
 *  started per data turn. */
const SWEEP_MS = 15 * 60_000, IN_FLIGHT = 3, PER_TURN = 2;
/** The ring's colours (lenses.ts healthSegs): degraded, down. */
const RING_DEG = '#E5B567', RING_DOWN = '#E06464';
/** A degraded or down run on a small ring is drawn at least this much of the way round. */
const RING_MIN = 0.06;
/** Quiet colours first, so an incident's run lies on top. */
const RING_ORDER = ['#38383C', '#6A6A6A', '#6FA27C', RING_DEG, RING_DOWN];
/** fx-city (#11). At the fleet zoom (below the group zoom) a building stands as part of its
 *  district's skyline in the lane's hue; ghost storeys only from this many commits behind (fewer:
 *  a thin roof tick); no green "up" lights and no past-incident rings (red is for down now). */
export const FLEET_GHOSTS = 3;
/** The district names the fleet zoom shows (one each, at the front edge), at most; the first
 *  DISTRICT_NAMES_SURE (trouble first, then the biggest) may step aside to find room, the tail
 *  only takes its own corner, so the placer drops it first when space (or the text budget) is
 *  tight. */
export const DISTRICT_NAMES_MAX = 4; // w2-chrome: trouble, then today's busiest (the fleet text budget: ≤ 40 items, with room for the other layers)
export const DISTRICT_NAMES_SURE = 4;
/** A calm city (every app up, held CALM_MS): its districts start this much of the plot's width
 *  further from the ladder, and the deploy spurs (the groups' deploy rates) take that ground. */
export const CALM_SHIFT = 0.3;
const CALM_MS = 60_000;
/** A district name's spots: [second column gap (0: at the corner), dy], tried in order. */
const NAME_SPOTS: [number, number][] = [[0, 0], [0, 5], [0, -5], [16, 0], [16, 6], [16, -6], [0, 12], [16, 14]];
/** The painted city's sig changes at most this often (each floor repaint is ~44 ms on macOS). */
const SIG_MS = 2000;
/** w2-chrome: the districts' tall-to-short order is adopted at most this often. */
const ORDER_MS = 30_000;

/** `a` over `b` at `t` (hex in, hex out). */
function mixHex(a: string, b: string, t: number): string {
  const x = parseInt(a.slice(1, 7), 16), y = parseInt(b.slice(1, 7), 16);
  const ch = (s: number) => Math.round(((x >> s) & 255) * t + ((y >> s) & 255) * (1 - t));
  return `#${((ch(16) << 16) | (ch(8) << 8) | ch(0)).toString(16).padStart(6, '0').toUpperCase()}`;
}
/** w2-chrome (WOW #2): a building that shipped nothing today, at night: its hue, nearly dark. */
export function nightOf(hex: string): { top: string; side: string; front: string; edge: string } {
  return { top: mixHex(hex, '#121214', 0.24), side: mixHex(hex, '#0E0E10', 0.16), front: mixHex(hex, '#0B0B0D', 0.11), edge: mixHex(hex, '#18181A', 0.34) };
}
/** w2-chrome (WOW #2): a lit window's light (a warm white leaning to the district's hue; never
 *  amber, which is in flight) and its strength by the deploy's age in hours: this hour the
 *  brightest, fading through the day. */
export function windowLight(hex: string): string { return mixHex(hex, '#FFF6E6', 0.22); }
export const WINDOW_AGE: readonly [number, number][] = [[1, 1], [4, 0.66], [12, 0.4], [24, 0.24]];
/** A deploy's window bucket (0 newest … 3) from its age in hours. */
export function windowBucket(ageH: number): number { for (let k = 0; k < WINDOW_AGE.length; k++) if (ageH < WINDOW_AGE[k]![0]) return k; return WINDOW_AGE.length - 1; }
/** A district's skyline faces (top, side, front, edge) and its name's ink, from its lane hue. */
export function skyline(hex: string): { top: string; side: string; front: string; edge: string; ink: string } {
  return { top: mixHex(hex, '#141416', 0.46), side: mixHex(hex, '#0F0F11', 0.3), front: mixHex(hex, '#0C0C0E', 0.2), edge: mixHex(hex, '#18181A', 0.62), ink: mixHex(hex, '#F2F2F0', 0.62) };
}

/** A building: the shared Block (h = its solid height: ground floor + storeys) and what it shows. */
export type CityBlock = Block & {
  /** successful deploys in the last 7 d (≤ STOREY_CAP) */
  storeys: number;
  /** commits main has that the app does not (App.behind), and the ghost storeys drawn (≤ 5) */
  behind: number; ghosts: number;
  /** no deploy known in 30 d: desaturated */
  idle: boolean;
  /** 0 lxc (a service), 1 static, 2 external */
  kind: number;
  /** 7 d of health as [from, to (fractions of the week, back → clockwise), colour] runs (the
   *  app lens's); null until known. `loud`: it holds a degraded or down run. */
  ring: [number, number, string][] | null; loud: boolean;
  /** the lane it belongs to, and its lot's v (its row) */
  lane: string; row: number;
  /** w2-chrome (WOW #2): successful deploys in the last 24 h, and each one's age in whole hours,
   *  newest first (the lit windows of its top storeys) */
  day: number; ages: number[];
};
/** A district: the shared DistrictBox (team = its lane's short name) and its lane, hue and spur. */
export type CityDistrict = DistrictBox & { lane: string; hex: string; spurV: number; bed: number; rows: number; cols: number;
  /** fx-city: its apps' successful deploys per hour over the last 24 h (oldest first): a calm
   *  city draws them along the spur's approach, the hour's tick nearer the district the newer */
  day: number[] };

type Hist = { at: number; shas: Map<string, number>; newest: number; health: { from: string; to: string; at: number }[] | null; since: number };

let bound: City | null = null;
/** W4's anchor on a building (world units): its footprint's centre, its roof and the top of its
 *  ghost storeys; null for an app with no building. */
export function buildingAnchor(appId: string): { u: number; v: number; roof: number; top: number } | null {
  return bound?.buildingAnchor(appId) ?? null;
}

export class City implements Layer {
  readonly name = 'city';
  blocks: CityBlock[] = [];
  readonly blockAt = new Map<string, CityBlock>();
  districtBox: CityDistrict[] = [];
  /** What the static floor shows of the city (heights, ghosts, rings, health): factory.ts's
   *  floor key carries it, so the floor repaints when a building changed. */
  sig = '';
  cityPitch = 19;
  /** fx-city: every app up (held CALM_MS): the city packs compact, the spurs take the ground. */
  calm = false;
  /** Where the districts start (u): DIST_U0, further right when calm. */
  cityU0 = DIST_U0;
  private loudAt = -1e12;
  private calmU0 = DIST_U0;
  private cityKey = '';
  private skyOf = new Map<string, ReturnType<typeof skyline>>();
  /** w2-chrome (#10): each app's height rank (7 d storeys, then today's deploys) from the last
   *  heights, the order the districts were packed in, and when that order last changed (the
   *  order is adopted at most every ORDER_MS: histories stream in for minutes, and a re-pack
   *  moves buildings). */
  private rank = new Map<string, number>();
  private orderSig = '';
  private orderAt = -1e12;
  private nightFaces = new Map<string, ReturnType<typeof nightOf>>();
  /** w2-chrome: each district shipped something in the last 24 h (lit at night). */
  private distLit: boolean[] = [];
  private cityRows: CityBlock[][] = [];
  private adopted: unknown = null;
  private laneOfDistrict: string[] = [];
  private trouble: CityBlock[] = [];
  private troubleAt = '';
  private hKey = '';
  private hAt = -1e12;
  // app histories (H7), by app id
  private hist = new Map<string, Hist>();
  private histVer = 0;
  private histEpoch = -1;
  private asked = new Map<string, number>();
  private queue: string[] = [];
  private qi = 0;
  private inflight = 0;
  // deploys whose crate was sent (app@sha → when it arrives), landed deploys waiting for their
  // crate (their storey is built on arrival; their sha is held out of the world's count till then)
  private sent = new Map<string, number>();
  private landing: { id: string; sha: string; at: number; t: number }[] = [];
  private pending = new Set<string>();
  // ring flashes as deploys arrive: app, when (frame clock), 0 amber · 1 ok · 2 red
  private flashes: { id: string; at: number; k: number }[] = [];
  // the projection of a roof circle (an ellipse): its axes per world unit, rotation, phase
  private ell = { s: -1, a: 0, b: 0, rot: 0, ph: 0 };

  constructor(readonly f: Factory) { bound = this; }

  /** Pack the city again at the next census check (stress mode toggled). */
  invalidate(): void { this.cityKey = ''; this.adopted = null; this.hKey = ''; }

  census(w: World): void {
    if (this.landing.length) this.landDue(this.f.tl.clock - 6000);
    this.adoptDistricts(w);
    this.calmStep(w);
    this.layoutCity();
    this.layoutHeights(w);
    // w2-chrome (#10): heights known, the districts' tall-to-short order may be due: adopted in
    // the same turn (a re-pack, then its heights), so one census leaves the city settled
    const k = this.cityKey;
    this.layoutCity();
    if (this.cityKey !== k) this.layoutHeights(w);
  }

  // ---- data: app histories, a few per data turn (app.ts's overview source calls this) ----

  /** Starts at most PER_TURN history fetches (IN_FLIGHT at a time): every app once, then each
   *  again every SWEEP_MS, the ones that deployed today first. Never from a draw. */
  pump(clock: number): void {
    const w = this.f.world, tl = this.f.tl;
    if (!w.loaded || this.f.census.skeleton) return;
    if (this.histEpoch !== tl.epoch) {
      // a new world (a reload, a replay): app histories are the server's and outlive it (the 7 d
      // window follows the playhead); another server's apps are forgotten
      this.histEpoch = tl.epoch;
      for (const id of [...this.hist.keys()]) if (!w.apps.has(id)) { this.hist.delete(id); this.asked.delete(id); }
      this.queue = []; this.qi = 0; this.sent.clear(); this.landing.length = 0; this.pending.clear(); this.histVer++;
    }
    let started = 0;
    while (this.inflight < IN_FLIGHT && started < PER_TURN) {
      if (this.qi >= this.queue.length) {
        // a new sweep: every app not asked within SWEEP_MS, today's deployers first
        const d24 = this.f.census.deploys24;
        const due: string[] = [];
        for (const a of w.apps.values()) { const id = a.id ?? ''; const at = this.asked.get(id); if (id && (at === undefined || clock - at >= SWEEP_MS || clock < at)) due.push(id); }
        if (!due.length) return;
        if (this.queue.length) console.log(`fab-w5: city histories ${this.hist.size} of ${w.apps.size} apps (sweep done)`);
        due.sort((x, y) => (d24.get(y) ?? 0) - (d24.get(x) ?? 0) || (x < y ? -1 : 1));
        this.queue = due; this.qi = 0;
      }
      const id = this.queue[this.qi++]!;
      if (!w.apps.has(id)) continue;
      this.asked.set(id, clock);
      this.inflight++; started++;
      const epoch = tl.epoch;
      appHistoryAsync(id).then((r) => { if (r && this.histEpoch === epoch && w.apps.has(id)) this.take(id, r, clock); }, () => {}).finally(() => { this.inflight--; });
    }
  }

  /** An app's history landed: its successful deploys (sha → when) and its health time. */
  take(id: string, r: AppHistoryResult, clock: number): void {
    const h = this.histOf(id);
    h.at = clock;
    for (const d of r.deploys) {
      const at = d.at || d.finished || d.started;
      if (at > h.newest) h.newest = at;
      if (d.state === 'success') h.shas.set(d.sha, at);
    }
    if (Array.isArray(r.health)) { h.health = r.health; h.since = r.since || 0; }
    this.histVer++;
  }

  private histOf(id: string): Hist {
    let h = this.hist.get(id);
    if (!h) { h = { at: -1, shas: new Map(), newest: 0, health: null, since: 0 }; this.hist.set(id, h); }
    return h;
  }

  // ---- events: a deploy's crate rides via → ladder → its district's spur → its building, whose
  // ring flashes as it arrives; a landed deploy adds its storey; a health change rings at once ----
  onEvent(e: Event, w: World, t: number): void {
    const R = this.f.reactions.rp;
    switch (e.k) {
      case 'deploy': {
        if (e.state !== 'running' && e.state !== 'success' && e.state !== 'failure') break;
        const b = this.blockAt.get(e.app);
        const vi = Math.max(0, VIAS.indexOf((e.via === 'manual' ? 'gha_fallback' : e.via) as typeof VIAS[number]));
        const key = `${e.app}@${e.sha}`;
        if (!b) { if (e.state === 'success') this.land(e.app, e.sha, e.at); break; }
        const top = b.h + 1.5, ok = e.state === 'success', bad = e.state === 'failure';
        // the crate rides from the deploy stage to the building: sent when the deploy starts, or
        // with its verdict when its start was never seen; everything at the building happens as
        // it ARRIVES (§G: deploy → track → building)
        let arrive = this.sent.get(key);
        if (e.state === 'running' || arrive === undefined) {
          const route = this.route(e.app, vi);
          let len = 0;
          for (let i = 1; i < route.length; i++) len += Math.abs(route[i]![0] - route[i - 1]![0]) + Math.abs(route[i]![1] - route[i - 1]![1]);
          const cr = this.f.crates.spawn(`${w.apps.get(e.app)?.repo ?? e.app}@${e.sha}`, 'deploy', route, t, clamp(len * 4.2, 2400, 4600), bad, '', '');
          arrive = this.f.crates.arrives(cr, route.length - 1);
          this.sent.set(key, arrive);
          if (this.sent.size > 64) { const k0 = this.sent.keys().next().value; if (k0 !== undefined) this.sent.delete(k0); }
          if (e.state === 'running') { R.add(R_RING, b.u + b.d / 2, b.v + b.d / 2, top, arrive, false, 1200); this.flashAt(e.app, arrive, 0); break; }
        }
        const at = Math.max(t, arrive);
        R.add(R_RING, b.u + b.d / 2, b.v + b.d / 2, top, at, bad, 1600, ok);
        this.flashAt(e.app, at, bad ? 2 : 1);
        // a landed deploy is a new storey, built when its crate arrives
        if (ok) { this.landing.push({ id: e.app, sha: e.sha, at: e.at, t: at }); this.pending.add(e.sha); }
        break;
      }
      case 'health': {
        const b = this.blockAt.get(e.app);
        if (b) R.add(R_RING, b.u + b.d / 2, b.v + b.d / 2, b.h + 1.5, t, e.to === 'down' || e.to === 'degraded', 1600, e.to === 'up');
        break;
      }
      default: break;
    }
  }

  /** A successful deploy's storey: into the app's history now. */
  private land(id: string, sha: string, at: number): void {
    const h = this.histOf(id);
    h.shas.set(sha, at);
    h.newest = Math.max(h.newest, at);
    this.histVer++;
    this.hAt = -1e12;
  }

  /** Builds the storeys of the deploys whose crate has arrived by `t` (the frame clock). */
  private landDue(t: number): void {
    for (let i = this.landing.length - 1; i >= 0; i--) {
      const x = this.landing[i]!;
      if (x.t > t) continue;
      this.landing.splice(i, 1);
      this.pending.delete(x.sha);
      this.land(x.id, x.sha, x.at);
    }
  }

  private flashAt(id: string, at: number, k: number): void {
    this.flashes.push({ id, at, k });
    if (this.flashes.length > 24) this.flashes.splice(0, this.flashes.length - 24);
  }

  /** A deploy's way from the scanner to an app's building: its via's track, the ladder, the
   *  district's spur down its main street, then across to the building. */
  route(appId: string, vi: number): Pt[] {
    const tv = TRACK_V[vi] ?? TRACK_V[0]!;
    const b = this.blockAt.get(appId);
    const d = b ? this.districtBox[b.district] : undefined;
    if (!b || !d) return [[SCAN_U + 14, tv], [TRACK_U1, tv]];
    const cu = b.u + b.d / 2, cv = b.v + b.d / 2, sv = d.spurV;
    const out: Pt[] = [[SCAN_U + 14, tv], [TRACK_U1, tv], [LADDER_U, tv]];
    if (Math.abs(sv - tv) > 7) out.push([LADDER_U, sv + (sv < tv ? 6 : -6)]);
    out.push([DIST_U0 - 2, sv], [cu, sv], [cu, cv]);
    return out;
  }

  /** W4's anchor: a building's footprint centre, roof and top of its ghost storeys. */
  buildingAnchor(appId: string): { u: number; v: number; roof: number; top: number } | null {
    const b = this.blockAt.get(appId);
    if (!b) return null;
    return { u: b.u + b.d / 2, v: b.v + b.d / 2, roof: b.h, top: b.h + this.shownGhosts(b, this.fleet) * STOREY };
  }

  /** fx-city: the fleet zoom (below the group zoom): skylines, names, fewer ghosts. */
  get fleet(): boolean { return this.f.cam.zoom < GROUP_Z_IN; }

  /** The ghost storeys a building shows: at the fleet zoom only from FLEET_GHOSTS commits behind
   *  (fewer: a roof tick, `ghosts` draws it); from the group zoom on, and in the app lens, all. */
  shownGhosts(b: CityBlock, fleet: boolean): number { return fleet && b.behind < FLEET_GHOSTS ? 0 : b.ghosts; }

  // ---- districts = the group lanes ----

  /** The lane an app belongs to: its team's group (folded teams: "other teams"), else its repo's
   *  group, else "other teams". */
  laneOfApp(id: string, w: World): string {
    const a = w.apps.get(id);
    if (!a) return OTHER_LANE;
    const G = floorGroups();
    const t = normTeam(a.team);
    if (t) return G.laneOfGroup(teamGroupId(t));
    if (a.repo && w.repos.has(a.repo)) { const l = G.laneOfRepo(a.repo); return l === BOTS_LANE ? OTHER_LANE : l; }
    return OTHER_LANE;
  }

  /** Replaces the census's districts (by team) with the city's: one per lane that has apps, in
   *  lane order. Runs when the census recounted (a new districts array). Stress copies
   *  (`<id>~<k>`) go where their app goes; the idle skeleton keeps its shape. */
  private adoptDistricts(w: World): void {
    const c = this.f.census;
    if (c.districts === this.adopted) return;
    if (c.skeleton) { this.adopted = c.districts; this.laneOfDistrict = c.districts.map(() => ''); return; }
    const lanes = floorGroups().lanes();
    const by = new Map<string, string[]>();
    for (const d of c.districts) for (const id of d.apps) {
      const k = id.indexOf('~');
      const lane = this.laneOfApp(k > 0 ? id.slice(0, k) : id, w);
      let l = by.get(lane);
      if (!l) by.set(lane, (l = []));
      l.push(id);
    }
    const out: { team: string; apps: string[] }[] = [];
    const ids: string[] = [];
    for (const l of lanes) {
      const apps = by.get(l.id);
      if (!apps?.length) continue;
      by.delete(l.id);
      apps.sort();
      out.push({ team: l.short, apps });
      ids.push(l.id);
    }
    // a lane the lane list does not hold yet (a group that just appeared): after the rest
    for (const [lane, apps] of by) { apps.sort(); out.push({ team: floorGroups().lane(lane)?.short ?? lane.replace(/^(team|org):/, ''), apps }); ids.push(lane); }
    c.districts = out;
    this.adopted = out;
    this.laneOfDistrict = ids;
  }

  /** fx-city (#11): calm = every app up (none degraded or down, stress copies included) and
   *  (w2-chrome, REVIEW-iter3 #10) no deploy started in the last hour. A
   *  trouble makes the city loud at once (full plot); calm returns once it held CALM_MS of the
   *  module clock, so a flapping app never re-packs the city back and forth. The first look is
   *  calm at once when everything is up. */
  private calmStep(w: World): void {
    const c = this.f.census, clk = this.f.tl.clock;
    if (c.skeleton || !w.loaded) return;
    const [, deg = '0', down = '0'] = c.healthSig.split('.');
    const sh = this.f.stress.health;
    let up = +deg === 0 && +down === 0;
    if (up && c.factor > 1) for (let i = 0; i < sh.length; i++) if (sh[i] === 1 || sh[i] === 2) { up = false; break; }
    // w2-chrome (#10): and nothing deployed in the last hour (a city that is deploying keeps the
    // whole plot: its lit windows are the news)
    if (up && c.flow.deploys > 0) up = false;
    if (!up) { this.loudAt = clk; this.calm = false; return; }
    if (!this.calm && (this.loudAt < -1e11 || clk - this.loudAt >= CALM_MS || clk < this.loudAt)) this.calm = true;
  }

  /** The districts' order as lane ids (tests). */
  get districtLanes(): string[] { return this.laneOfDistrict.slice(); }

  private layoutCity(): void {
    const c = this.f.census;
    // w2-chrome (#10): the districts' tall-to-short order is part of the layout (adopted at most
    // every ORDER_MS of the module clock, at once the first time heights are known)
    const clk = this.f.tl.clock;
    if (this.rank.size && (this.orderAt < -1e11 || clk - this.orderAt >= ORDER_MS || clk < this.orderAt)) {
      let h = 0;
      for (const d of c.districts) for (const id of d.apps) h = (Math.imul(h, 31) + (this.rank.get(id) ?? 0)) | 0;
      const sig = String(h >>> 0);
      if (sig !== this.orderSig) { this.orderSig = sig; this.orderAt = clk; }
    }
    const key = `${this.calm ? 'calm' : 'loud'}|${c.districts.map((d) => `${d.team}:${d.apps.length}`).join(',')}|${this.orderSig}`;
    if (key === this.cityKey) return;
    this.cityKey = key;
    this.hKey = '';
    this.troubleAt = '';
    // the biggest pitch at which every district fits the plot (stress mode's 2,400 apps too)
    // (a small fleet grows its lots until the plot is full: no dead space at the fleet zoom)
    const fit = (): [number, number] => {
      let p = 44, end = -1;
      for (; p > 4; p -= p > 10 ? 0.5 : 0.25) if ((end = this.pack(p, true)) >= 0) break;
      return [p, end];
    };
    // fx-city: a calm city starts further from the ladder (its spurs run across the ground it
    // gave): about CALM_SHIFT of the plot's width, the shift whose packing fills the plot's depth
    // best (a column fewer can leave a row's worth of floor bare in front)
    let pitch = 0;
    if (this.calm) {
      let best = -1;
      for (let k = -4; k <= 4; k++) {
        const u0 = Math.round(DIST_U0 + (CALM_SHIFT + k * 0.02) * (CITY_U1 - DIST_U0));
        this.cityU0 = u0;
        const [p, end] = fit();
        const score = end - Math.abs(k) * 2;
        if (end >= 0 && score > best) { best = score; pitch = p; this.calmU0 = u0; }
      }
      this.cityU0 = this.calmU0;
    } else this.cityU0 = DIST_U0;
    if (!pitch) pitch = fit()[0];
    this.pack(pitch, false);
    this.cityPitch = pitch;
    // the rows (one lot v each), far to near: the floor's batches
    const rows = new Map<number, CityBlock[]>();
    for (const b of this.blocks) { let r = rows.get(b.row); if (!r) { r = []; rows.set(b.row, r); } r.push(b); }
    this.cityRows = [...rows.entries()].sort((a, b) => a[0] - b[0]).map((e) => e[1].sort((x, y) => x.u - y.u));
  }

  /** The city at `pitch`; `dry`: only whether it fits the plot. Districts are bands across the
   *  plot, back to front in lane order: their rows of lots, a main street with the spur after
   *  half of them, the rest in front. */
  private pack(pitch: number, dry: boolean): number {
    const c = this.f.census, w = this.f.world;
    const d = Math.max(3, Math.round(pitch * LOT * 2) / 2);
    const street = pitch - d;
    const U0 = this.cityU0;
    const cols = Math.max(1, Math.floor((CITY_U1 - U0 + street) / pitch));
    const extra = Math.max(0, SPUR_ST - street);
    let v = CITY_V0;
    if (!dry) { this.blocks = []; this.blockAt.clear(); this.districtBox = []; }
    let virt = 0;
    const G = floorGroups();
    for (let di = 0; di < c.districts.length; di++) {
      const dist = c.districts[di]!;
      const n = dist.apps.length;
      const rows = Math.max(1, Math.ceil(n / cols));
      const back = Math.ceil(rows / 2);
      const v0 = v;
      const rowV = (r: number) => v0 + r * pitch + (r >= back ? extra : 0);
      const spurV = v0 + (back - 1) * pitch + d + Math.max(SPUR_ST, street) / 2;
      const lastFront = rows > back ? rowV(rows - 1) + d : spurV + Math.max(SPUR_ST, street) / 2;
      const v1 = Math.max(lastFront, spurV + SPUR_ST / 2);
      if (v1 > CITY_V1 + 2) return -1;
      v = v1 + GAP + street;
      if (dry) continue;
      const lane = this.laneOfDistrict[di] ?? '';
      const hex = lane ? G.hex(lane) : '#55555A';
      // w2-chrome (#10): tall to short from the district's back corner (one skyline)
      const rk = this.rank;
      const order = rk.size ? dist.apps.slice().sort((x, y) => (rk.get(y) ?? 0) - (rk.get(x) ?? 0) || (x < y ? -1 : x > y ? 1 : 0)) : dist.apps;
      order.forEach((id, i) => {
        const r = Math.floor(i / cols), col = i % cols;
        const lu = U0 + col * pitch, lv = rowV(r);
        const tilde = id.indexOf('~');
        const idleSk = id.startsWith('~idle');
        const real = tilde > 0 ? id.slice(0, tilde) : id;
        const a = idleSk ? undefined : w.apps.get(real);
        const kind = a?.runtime === 'static' ? 1 : a?.runtime === 'external' ? 2 : 0;
        const bd = kind ? Math.round(d * STATIC_LOT * 2) / 2 : d;
        const off = (d - bd) / 2;
        const hv = idleSk ? 4 : tilde > 0 ? -2 - virt++ : -1;
        const b: CityBlock = { id, u: lu + off, v: lv + off, d: bd, h: BASE, district: di, hv, storeys: 0, behind: 0, ghosts: 0, idle: idleSk, kind, ring: null, loud: false, lane, row: lv, day: 0, ages: [] };
        this.blocks.push(b);
        this.blockAt.set(id, b);
      });
      const cu = Math.min(n, cols);
      this.districtBox.push({ team: dist.team, u0: U0, v0, u1: U0 + (cu - 1) * pitch + d, v1, n, lane, hex, spurV, bed: 3, rows, cols, day: new Array<number>(24).fill(0) });
      if (!this.skyOf.has(hex)) this.skyOf.set(hex, skyline(hex));
      if (!this.nightFaces.has(hex)) this.nightFaces.set(hex, nightOf(hex));
    }
    if (!dry) this.f.stress.ensureHealth(virt);
    return v - GAP - street;
  }

  /** Heights, ghosts, rings and health from the data, when it changed (at most every SIG_MS of
   *  the module clock while app histories stream in: `sig` never churns). O(apps + deploys). */
  private layoutHeights(w: World): void {
    const c = this.f.census;
    const now = this.f.tl.playhead || w.at;
    const key = `${this.cityKey}|${c.sig}|${c.healthSig}|${w.kv.app}|${w.kv.deploy}|${w.kv.trend}|${this.histVer}|${Math.floor(now / 600_000)}|${c.skeleton ? 1 : 0}`;
    if (key === this.hKey) return;
    const clk = this.f.tl.clock;
    if (this.hKey && this.hKey.startsWith(`${this.cityKey}|`) && clk - this.hAt < SIG_MS && clk >= this.hAt) return;
    this.hKey = key; this.hAt = clk;
    const from7 = now - 7 * DAY, from30 = now - 30 * DAY;
    // the world's successful deploys (24 h) by app
    const live = new Map<string, Map<string, number>>();
    for (const d of w.deploys.values()) {
      if (d.state !== 'success' || this.pending.has(d.sha)) continue;
      const at = d.finished ?? d.started;
      let m = live.get(d.app);
      if (!m) live.set(d.app, (m = new Map()));
      m.set(d.sha, at);
    }
    // the layout (calm or loud, the districts' sizes) is painted too
    let sig = 0;
    const rank = new Map<string, number>();
    for (let i = 0; i < this.cityKey.length; i++) sig = (Math.imul(sig, 31) + this.cityKey.charCodeAt(i)) | 0;
    for (const b of this.blocks) {
      if (b.hv === 4) { b.storeys = 0; b.ghosts = 0; b.behind = 0; b.h = BASE; b.ring = null; b.loud = false; b.day = 0; b.ages = []; continue; }
      if (b.hv <= -2) {
        // a stress copy: the census's synthesized deploys (stress mode is the renderer's test)
        const n = Math.min(STOREY_CAP, c.deploys24.get(b.id) ?? 0);
        b.storeys = n; b.h = BASE + n * STOREY; b.idle = n === 0; b.ghosts = 0; b.behind = 0; b.ring = null; b.loud = false;
        b.day = n; b.ages = Array.from({ length: n }, (_, k) => k * 3);
        rank.set(b.id, n * 100 + n);
        continue;
      }
      const a = w.apps.get(b.id);
      const h = this.hist.get(b.id);
      const wl = live.get(b.id);
      let n = 0, newest = h?.newest ?? 0;
      if (h) for (const [sha, at] of h.shas) if (at >= from7 && at <= now && !(wl?.has(sha))) n++;
      if (wl) for (const at of wl.values()) { if (at >= from7 && at <= now) n++; if (at > newest) newest = at; }
      b.storeys = Math.min(STOREY_CAP, n);
      b.h = BASE + b.storeys * STOREY;
      // w2-chrome (WOW #2): today's deploys, each one's age by the hour (newest first): the lit
      // windows of the top storeys
      const ages: number[] = [];
      if (wl) for (const at of wl.values()) if (at > now - DAY && at <= now) ages.push(Math.floor((now - at) / 3_600_000));
      ages.sort((x, y) => x - y);
      b.day = ages.length; b.ages = ages.slice(0, b.storeys);
      rank.set(b.id, b.storeys * 100 + Math.min(99, b.day));
      for (const x of b.ages) sig = (Math.imul(sig, 31) + windowBucket(x) + 7) | 0;
      const behind = a?.behind ?? (a?.main_sha && a.live_sha && a.main_sha !== a.live_sha ? 1 : 0);
      b.behind = Math.max(0, behind | 0);
      b.ghosts = Math.min(GHOST_CAP, b.behind);
      // idle: no deploy known in 30 d (once its history is known; until then, today's deploys)
      b.idle = (h && h.at >= 0) ? newest < from30 : !wl?.size;
      // the week's health, as the app lens draws it (from the back, a week ago → now)
      b.ring = h?.health ? healthSegs(h.health, a?.health ?? 'unknown', now, h.since) : null;
      b.loud = !!b.ring?.some((x) => x[2] === RING_DOWN || x[2] === RING_DEG);
      let q = b.ring ? b.ring.length * 7 : 99;
      if (b.ring) for (const x of b.ring) if (x[2] === RING_DOWN || x[2] === RING_DEG) q = (Math.imul(q, 31) + Math.round(x[0] * 336) * 3 + Math.round(x[1] * 336)) | 0;
      sig = (Math.imul(sig, 31) + b.storeys * 977 + b.ghosts * 131 + (b.behind > GHOST_CAP ? b.behind : 0) * 17 + (b.idle ? 5 : 0) + q) | 0;
    }
    // fx-city: each district's day of deploys, by the hour (the approach's ticks)
    for (const d of this.districtBox) d.day.fill(0);
    for (const dp of w.deploys.values()) {
      if (dp.state !== 'success' || this.pending.has(dp.sha)) continue;
      const at = dp.finished ?? dp.started, b = this.blockAt.get(dp.app);
      const d = b ? this.districtBox[b.district] : undefined;
      if (!d || at > now || at <= now - DAY) continue;
      d.day[Math.min(23, Math.floor((at - (now - DAY)) / 3_600_000))]!++;
    }
    for (const d of this.districtBox) for (let h = 0; h < 24; h++) sig = (Math.imul(sig, 31) + d.day[h]! * (h + 1)) | 0;
    this.rank = rank;
    this.distLit = this.districtBox.map(() => false);
    for (const b of this.blocks) if (b.day > 0) this.distLit[b.district] = true;
    for (let i = 0; i < this.distLit.length; i++) sig = (Math.imul(sig, 31) + (this.distLit[i] ? i + 1 : 0)) | 0;
    // the districts' spurs: the bed as wide as the group's deploys (the v0.5 trend, per hour over
    // 7 d; the last 24 h until 7 d are known); "other teams" sums its members
    const ins = insights();
    for (const d of this.districtBox) {
      const l = d.lane ? floorGroups().lane(d.lane) : undefined;
      let rate = 0;
      for (const id of l?.members ?? []) { const m = ins.trend(id)?.deploys; rate += m?.d7 ?? m?.h24 ?? 0; }
      d.bed = 3 + 1.8 * Math.log2(1 + 2 * rate);
      sig = (Math.imul(sig, 31) + Math.round(d.bed * 4)) | 0;
    }
    this.sig = String(sig >>> 0);
  }

  /** A block's health light: 0 up, 1 degraded, 2 down, 3 unknown, 4 none (the idle floor). */
  healthOf(b: Block): number {
    if (b.hv === -1) {
      const h = this.f.world.apps.get(b.id)?.health;
      return h === 'up' ? 0 : h === 'degraded' ? 1 : h === 'down' ? 2 : 3;
    }
    if (b.hv >= 0) return b.hv;
    return this.f.stress.health[-2 - b.hv] ?? 0;
  }

  // ---- the static floor: plates and tracks now (flat), the buildings after every extruded thing ----

  floor(fp: FloorPass): void {
    const g = fp.g, lo = fp.lo, idle = fp.idle;
    const fleet = this.fleet;
    this.ellipse();
    this.drawPlates(g, idle, fleet);
    this.drawTracks(g, lo, idle);
    fp.after(() => this.drawCity(g, lo, idle, fleet));
  }

  /** The districts' plates: each tinted with its group's hue, edged in it (at the fleet zoom the
   *  skyline carries the hue: the plate is its quiet ground). */
  private drawPlates(g: Gfx, idle: boolean, fleet: boolean): void {
    const cam = this.f.cam;
    for (const d of this.districtBox) {
      g.begin_(); quad(cam, g, d.u0 - 3, d.v0 - 3, d.u1 + 3, d.v1 + 2, 0.2);
      g.fill(withAlpha(d.hex, idle ? 0.05 : fleet ? 0.1 : 0.19));
      g.begin_(); quad(cam, g, d.u0 - 3, d.v0 - 3, d.u1 + 3, d.v1 + 2, 0.2);
      g.stroke(withAlpha(d.hex, idle ? 0.18 : 0.62), g.hair * 1.5);
      // fx-city: a calm city's approach, ladder → district, is the group's band, faintly (its
      // spur and its day of deploys run on it)
      if (!idle && d.u0 - DIST_U0 > 20) { g.begin_(); quad(cam, g, DIST_U0 - 2, d.v0 - 3, d.u0 - 4, d.v1 + 2, 0.15); g.fill(withAlpha(d.hex, 0.05)); }
    }
  }

  /** The deploy tracks fan out: the three via tracks join a ladder along the city's edge, and
   *  one spur per district leaves it down the district's main street; a spur's bed is as wide as
   *  the group's deploys. Beds, then sleepers, then rails: three paths for the whole fan. */
  private drawTracks(g: Gfx, lo: boolean, idle: boolean): void {
    const cam = this.f.cam, ds = this.districtBox;
    if (!ds.length) return;
    let va = TRACK_V[0]!, vb = TRACK_V[2]!;
    for (const d of ds) { va = Math.min(va, d.spurV); vb = Math.max(vb, d.spurV); }
    const mid = TRACK_V[1]!;
    const P = (u: number, v: number) => { g.line(cam.x(u, v), cam.y(u, v, 0.4)); };
    const M = (u: number, v: number) => { g.move(cam.x(u, v), cam.y(u, v, 0.4)); };
    // beds
    g.begin_();
    quad(cam, g, LADDER_U - 4, va - 4, LADDER_U + 4, vb + 4, 0.3);
    for (const tv of TRACK_V) quad(cam, g, TRACK_U1 - 1, tv - 4, LADDER_U, tv + 4, 0.3);
    for (const d of ds) {
      const hw = d.bed / 2, side = d.spurV < mid ? 1 : -1, sv = d.spurV;
      quad(cam, g, DIST_U0 - 2, sv - hw, d.u1 + 4, sv + hw, 0.3);
      M(LADDER_U, sv + side * 6 - hw); P(DIST_U0 - 2, sv - hw); P(DIST_U0 - 2, sv + hw); P(LADDER_U, sv + side * 6 + hw); g.ctx.closePath();
    }
    g.fill(idle ? '#101012' : '#09090A');
    // fx-city: each spur's bed in its group's hue (its width is the group's deploy rate): a calm
    // city's freed ground reads as the groups' deploy tracks
    if (!idle) for (const d of ds) {
      const hw = d.bed / 2, side = d.spurV < mid ? 1 : -1, sv = d.spurV;
      g.begin_();
      quad(cam, g, DIST_U0 - 2, sv - hw, d.u0 - 1, sv + hw, 0.32);
      M(LADDER_U + 4, sv + side * 6 - hw); P(DIST_U0 - 2, sv - hw); P(DIST_U0 - 2, sv + hw); P(LADDER_U + 4, sv + side * 6 + hw); g.ctx.closePath();
      g.fill(withAlpha(d.hex, 0.3));
    }
    // fx-city: a calm city's approach carries each district's last 24 h of deploys, one tick per
    // hour that had any (taller: more), the newest next to the district
    if (!idle) this.drawDays(g);
    // sleepers
    if (!lo && cam.s * 8 > 5) {
      g.begin_();
      for (let v = va; v <= vb; v += 8) { M(LADDER_U - 4, v); P(LADDER_U + 4, v); }
      for (const d of ds) for (let u = DIST_U0 + 2; u < d.u1 + 2; u += 8) { M(u, d.spurV - 3.6); P(u, d.spurV + 3.6); }
      g.stroke(F.sleeper, Math.max(1, cam.s * 1.4));
    }
    // rails
    g.begin_();
    for (const k of [-2.2, 2.2]) {
      M(LADDER_U + k, va); P(LADDER_U + k, vb);
      for (const tv of TRACK_V) { M(TRACK_U1, tv + k); P(LADDER_U, tv + k); }
      for (const d of ds) { const side = d.spurV < mid ? 1 : -1; M(LADDER_U, d.spurV + side * 6 + k); P(DIST_U0 - 2, d.spurV + k); P(d.u1 + 4, d.spurV + k); }
    }
    g.stroke(idle ? F.rail : '#55555B', g.hair * 1.7);
  }

  /** The approach's day of deploys (fx-city): only where a calm city left room (≥ 24 u). */
  private drawDays(g: Gfx): void {
    const cam = this.f.cam;
    for (const d of this.districtBox) {
      const ua = DIST_U0 + 1, ub = d.u0 - 5;
      if (ub - ua < 24 || !d.day.some((x) => x > 0)) continue;
      const step = (ub - ua) / 24;
      g.begin_();
      for (let h = 0; h < 24; h++) {
        const n = d.day[h]!;
        if (!n) continue;
        const u = ua + (h + 0.5) * step, z = 1.5 + 2.6 * Math.sqrt(Math.min(n, 16));
        g.move(cam.x(u, d.spurV), cam.y(u, d.spurV, 0.4)); g.line(cam.x(u, d.spurV), cam.y(u, d.spurV, z));
      }
      const sky = this.skyOf.get(d.hex) ?? skyline(d.hex);
      g.stroke(withAlpha(sky.ink, 0.8), Math.max(1.2, Math.min(3, step * cam.s * 0.55)));
    }
  }

  /** The buildings, a row (one lot v) at a time, far to near, batched per colour class
   *  (DESIGN.md "LOD"); each row's storeys or windows, ghost storeys and roof rings over it
   *  before the next row. The ladder's low detail takes one step coarser. */
  private drawCity(g: Gfx, lo: boolean, idle: boolean, fleet: boolean): void {
    const cam = this.f.cam;
    const lot = this.cityPitch * LOT;
    const px = lot * cam.s;
    let lod = px >= 10 ? 0 : px >= 5 ? 1 : px >= 4 ? 2 : 3;
    if (lo) lod = Math.min(3, lod + 1);
    const hist = this.f.stat.lod;
    hist[0] = hist[1] = hist[2] = hist[3] = 0;
    const act = this.f.bA, dim = this.f.bB, red = this.f.bC, night = this.f.bD;
    // w2-chrome (WOW #2): at the fleet zoom the city is at night: a building that shipped today
    // stands in its district's hue, one that did not nearly dark in it, a district that shipped
    // nothing today dark grey
    const atNight = fleet && !idle;
    const sPx = STOREY * cam.s;
    const windows = lod === 0 && sPx >= 4.2 && !idle;
    const lines = lod === 0 && !windows && sPx >= 2.4 && !idle;
    const LIGHT = [C.up, C.packet, C.red];
    const dotR = Math.max(1.1, Math.min(2.6, cam.s * 1.9));
    for (const row of this.cityRows) {
      const v = row[0]!.row;
      const yTop = cam.y(CITY_U1, v, BASE + (STOREY_CAP + GHOST_CAP) * STOREY), yBot = cam.y(DIST_U0, v + lot, 0);
      if (yBot < -20 || yTop > cam.H + 20) { hist[3] += row.length; continue; }
      let n = 0;
      // LOD3: a district's run of buildings in this row is one low strip (a heatmap row)
      let runU0 = 0, runU1 = -1, runH = 0, runK = 0, runD = -1;
      for (const b of row) {
        const x0 = cam.x(b.u, b.v + b.d), x1 = cam.x(b.u + b.d, b.v);
        if (x1 < -10 || x0 > cam.W + 10) { hist[3]++; continue; }
        n++;
        if (lod < 3) {
          const hl = b.hv === 4 || idle ? -1 : this.healthOf(b);
          const lit = atNight ? this.distLit[b.district] : true;
          (hl < 0 ? dim : hl === 2 ? red : b.idle || !lit ? dim : atNight && !b.day ? night : act).add(b.u, b.v, b.d, b.d, b.h);
          continue;
        }
        if (runU1 >= 0 && b.district === runD && b.u - runU1 <= this.cityPitch) { runU1 = b.u + b.d; runH += b.h; runK++; continue; }
        const strip = atNight && this.distLit[b.district] ? act : dim;
        if (runU1 >= 0) strip.add(runU0, v, runU1 - runU0, lot, runH / runK);
        runU0 = b.u; runU1 = b.u + b.d; runH = b.h; runK = 1; runD = b.district;
      }
      if (lod === 3 && runU1 >= 0) (atNight && this.distLit[runD] ? act : dim).add(runU0, v, runU1 - runU0, lot, runH / runK);
      if (!n) continue;
      hist[Math.min(2, lod)] += n;
      const faces = lod === 0 ? 3 : lod === 1 ? 3 : 2;
      const ew = lod === 0 ? g.hair * 1.5 : 1;
      dim.flush(g, cam, '#1C1C1E', '#141416', '#111113', lod === 0 ? '#28282B' : '', ew, faces);
      // fx-city: at the fleet zoom a row is its district's skyline, in the lane's hue
      const sky = fleet && !idle ? this.skyOf.get(this.districtBox[row[0]!.district]?.hex ?? '') : undefined;
      if (sky) act.flush(g, cam, sky.top, sky.side, sky.front, lod === 0 ? sky.edge : '', ew, faces);
      else act.flush(g, cam, '#2B2B2F', '#1D1D20', '#171719', lod === 0 ? '#3C3C41' : '', ew, faces);
      const nf = atNight ? this.nightFaces.get(this.districtBox[row[0]!.district]?.hex ?? '') : undefined;
      if (nf) night.flush(g, cam, nf.top, nf.side, nf.front, '', ew, faces); // (no edge: the lights are off, it recedes)
      else night.flush(g, cam, '#1C1C1E', '#141416', '#111113', '', ew, faces);
      red.flush(g, cam, '#C25252', '#7E3434', '#682C2C', lod === 0 ? '#E06464' : '', ew, faces);
      if (idle) continue;
      if (atNight && lod <= 2) this.litWindows(g, row);
      if (lines) this.storeyLines(g, row);
      if (windows) this.windows(g, row);
      if (lod <= 1) {
        this.ghosts(g, row, lod, false, fleet);
        this.rings(g, row, fleet);
      } else {
        // LOD2: a light only where an app is not up
        const lights = [this.f.bB, this.f.bC, this.f.bD];
        for (const b of row) {
          const hl = this.healthOf(b);
          if (hl === 0 || hl > 2) continue;
          lights[hl]!.add(b.u + b.d / 2, b.v + b.d / 2, 0, 0, 0, b.h + 1.5);
        }
        for (let k = 1; k < 3; k++) flushLights(cam, g, lights[k]!, LIGHT[k]!, dotR * 1.3, false);
      }
    }
  }

  /** w2-chrome (WOW #2): the fleet zoom's night: a building's storeys deployed in the last 24 h
   *  are lit windows (its top storeys, the newest on top and brightest, dimmer by the hour), one
   *  band on the front and the side each; a down building's stay dark. One path per strength. */
  private litWindows(g: Gfx, row: CityBlock[]): void {
    const cam = this.f.cam, hex = this.districtBox[row[0]!.district]?.hex ?? '#888888';
    const light = windowLight(hex);
    for (let k = 0; k < WINDOW_AGE.length; k++) {
      g.begin_();
      let n = 0;
      for (const b of row) {
        if (!b.ages.length || b.hv === 4 || this.healthOf(b) === 2) continue;
        const u0 = b.u, u1 = b.u + b.d, v0 = b.v, v1 = b.v + b.d, ins = b.d * 0.14;
        b.ages.forEach((age, j) => {
          if (windowBucket(age) !== k) return;
          const zf = BASE + (b.storeys - 1 - j) * STOREY, za = zf + STOREY * 0.28, zb = zf + STOREY * 0.78;
          poly(cam, g, [u0 + ins, v1, za, u1 - ins, v1, za, u1 - ins, v1, zb, u0 + ins, v1, zb]);
          poly(cam, g, [u1, v1 - ins, za, u1, v0 + ins, za, u1, v0 + ins, zb, u1, v1 - ins, zb]);
          n++;
        });
      }
      if (n) g.fill(withAlpha(light, WINDOW_AGE[k]![1]));
    }
  }

  /** Mid zoom: a hairline between storeys on each building's front and side (count the deploys). */
  private storeyLines(g: Gfx, row: CityBlock[]): void {
    const cam = this.f.cam;
    g.begin_();
    let any = false;
    for (const b of row) {
      if (b.storeys < 1 || b.idle) continue;
      const u0 = b.u, u1 = b.u + b.d, v0 = b.v, v1 = b.v + b.d;
      for (let k = 0; k < b.storeys; k++) {
        const z = BASE + k * STOREY;
        g.move(cam.x(u0, v1), cam.y(u0, v1, z)); g.line(cam.x(u1, v1), cam.y(u1, v1, z)); g.line(cam.x(u1, v0), cam.y(u1, v0, z));
      }
      any = true;
    }
    if (any) g.stroke('#0C0C0D', g.hair * 1.2);
  }

  /** Zoomed in: a window band per floor on the front and side; lit while the app is up (green
   *  gray), dark when it is down; an idle building has none. */
  private windows(g: Gfx, row: CityBlock[]): void {
    const cam = this.f.cam;
    for (const dark of [false, true]) {
      g.begin_();
      let any = false;
      for (const b of row) {
        if (b.idle || b.hv === 4) continue;
        if ((this.healthOf(b) === 2) !== dark) continue;
        const u0 = b.u, u1 = b.u + b.d, v0 = b.v, v1 = b.v + b.d, ins = b.d * 0.16;
        for (let k = -1; k < b.storeys; k++) {
          const zf = k < 0 ? 0 : BASE + k * STOREY, fh = k < 0 ? BASE : STOREY;
          const za = zf + fh * 0.34, zb = zf + fh * 0.74;
          poly(cam, g, [u0 + ins, v1, za, u1 - ins, v1, za, u1 - ins, v1, zb, u0 + ins, v1, zb]);
          poly(cam, g, [u1, v1 - ins, za, u1, v0 + ins, za, u1, v0 + ins, zb, u1, v1 - ins, zb]);
        }
        any = true;
      }
      if (any) g.fill(dark ? '#0A0A0B' : '#4A5A4E');
    }
  }

  /** Ghost storeys: one hollow, faint floor per commit main has that the app does not, stacked
   *  on the roof (≤ GHOST_CAP; a notch on the top one past that). Never dashed: dashes are the
   *  7-d baselines', and those are never drawn on a building. */
  private ghosts(g: Gfx, row: CityBlock[], lod: number, lit = false, fleet = false): void {
    const cam = this.f.cam;
    let any = false;
    const P = (u: number, v: number, z: number) => g.line(cam.x(u, v), cam.y(u, v, z));
    const M = (u: number, v: number, z: number) => g.move(cam.x(u, v), cam.y(u, v, z));
    if (fleet) {
      // fx-city: at the fleet zoom 1–2 commits behind is a thin tick on the roof, one per commit
      g.begin_();
      for (const b of row) {
        if (!b.behind || b.behind >= FLEET_GHOSTS) continue;
        any = true;
        for (let k = 0; k < b.behind; k++) {
          const u = b.u + b.d * (b.behind === 1 ? 0.5 : 0.36 + 0.28 * k), v = b.v + b.d * 0.5;
          M(u, v, b.h); P(u, v, b.h + STOREY * 0.8);
        }
      }
      if (any) g.stroke(withAlpha('#D6D6D0', 0.55), 1);
      any = false;
    }
    // a faint glass fill, then the outlines
    for (const pass of [0, 1]) {
      g.begin_();
      for (const b of row) {
        const gn = this.shownGhosts(b, fleet);
        if (!gn) continue;
        any = true;
        const ins = b.d * 0.07, u0 = b.u + ins, u1 = b.u + b.d - ins, v0 = b.v + ins, v1 = b.v + b.d - ins;
        for (let k = 0; k < gn; k++) {
          const z0 = b.h + k * STOREY + 0.35, z1 = z0 + STOREY - 0.7;
          if (pass === 0) {
            poly(cam, g, [u0, v1, z0, u1, v1, z0, u1, v1, z1, u0, v1, z1]);
            poly(cam, g, [u1, v1, z0, u1, v0, z0, u1, v0, z1, u1, v1, z1]);
          } else {
            M(u0, v1, z0); P(u1, v1, z0); P(u1, v0, z0); P(u1, v0, z1); P(u1, v1, z1); P(u0, v1, z1); g.ctx.closePath();
            M(u1, v1, z0); P(u1, v1, z1);
            if (k === gn - 1) { M(u0, v1, z1); P(u0, v0, z1); P(u1, v0, z1); }
          }
        }
        if (pass === 1 && b.behind > GHOST_CAP) {
          // the "+N" notch: a short mast and flag on the top ghost's far corner
          const zt = b.h + b.ghosts * STOREY;
          M(u0, v0, zt); P(u0, v0, zt + 5); P(u0 + b.d * 0.3, v0, zt + 4); P(u0, v0, zt + 3);
        }
      }
      if (!any) return;
      if (pass === 0) g.fill(withAlpha('#E8E8E2', lit ? 0.12 : lod === 0 ? 0.07 : 0.05));
      else g.stroke(withAlpha('#D6D6D0', lit ? 0.9 : lod === 0 ? 0.5 : 0.36), lit ? 1.4 : lod === 0 ? g.hair * 1.4 : 1);
    }
  }

  /** The roof's health ring, the app lens's in small: 7 d of health from the back, clockwise (a
   *  week ago → now), one path per colour for the row. A week with no incident is quiet: its
   *  ring shows only once a roof is big enough to read; an incident's run is drawn at least
   *  RING_MIN of the way round. No history yet: a light for the health now. */
  private rings(g: Gfx, row: CityBlock[], fleet = false): void {
    const cam = this.f.cam;
    const R0 = (row[0]?.d ?? 0) * 0.34;
    const big = R0 * this.ell.b >= 3.2;
    const cols = this.ringCols;
    cols.clear();
    for (const b of row) {
      const r = b.ring;
      if (!r || b.hv === 4 || (!b.loud && !big)) continue;
      // fx-city: at the fleet zoom only an app in trouble now wears its week (red is for down)
      if (fleet && this.healthOf(b) !== 1 && this.healthOf(b) !== 2) continue;
      const cu = b.u + b.d / 2, cv = b.v + b.d / 2, x = cam.x(cu, cv), y = cam.y(cu, cv, b.h + 0.2);
      for (const [k0, k1, col] of r) {
        let a0 = k0, a1 = k1;
        if ((col === RING_DOWN || col === RING_DEG) && a1 - a0 < RING_MIN) { const m = (a0 + a1) / 2; a0 = Math.max(0, m - RING_MIN / 2); a1 = Math.min(1, a0 + RING_MIN); }
        if (a1 - a0 < 0.003) continue;
        let list = cols.get(col);
        if (!list) cols.set(col, (list = []));
        list.push(x, y, b.d * 0.34, a0, a1);
      }
    }
    for (const col of RING_ORDER) {
      const list = cols.get(col);
      if (!list?.length) continue;
      g.begin_();
      for (let i = 0; i < list.length; i += 5) this.arc(g, list[i]!, list[i + 1]!, list[i + 2]!, list[i + 3]!, list[i + 4]!);
      const loud = col === RING_DOWN || col === RING_DEG;
      g.stroke(loud ? col : withAlpha(col, 0.8), loud ? Math.max(1.4, g.hair * 2.2) : Math.max(1, g.hair * 1.3));
    }
    // no history yet: the light for the health now (green-gray, amber, red)
    const lights = [this.f.bB, this.f.bC, this.f.bD];
    for (const b of row) {
      if (b.ring || b.hv === 4) continue;
      const hl = this.healthOf(b);
      if (hl > 2 || (fleet && hl === 0)) continue;
      lights[hl]!.add(b.u + b.d / 2, b.v + b.d / 2, 0, 0, 0, b.h + 0.4);
    }
    const r = Math.max(1.1, Math.min(2.4, cam.s * 1.7));
    flushLights(cam, g, lights[0]!, C.up, r, true);
    flushLights(cam, g, lights[1]!, C.packet, r, true);
    flushLights(cam, g, lights[2]!, C.red, r, true);
  }
  private ringCols = new Map<string, number[]>();

  /** The projection of a roof circle of radius 1 (an ellipse): its axes, rotation and phase,
   *  once per zoom (iso.ts: x = s(UX u + VX v), y = s(UY u + VY v)). */
  private ellipse(): void {
    const s = this.f.cam.s, E = this.ell;
    if (E.s === s) return;
    const a = UX * s, b = VX * s, c = UY * s, d = VY * s;
    const e = (a + d) / 2, f = (a - d) / 2, gg = (c + b) / 2, h = (c - b) / 2;
    const q = Math.hypot(e, h), r = Math.hypot(f, gg);
    const a1 = Math.atan2(gg, f), a2 = Math.atan2(h, e);
    E.s = s; E.a = q + r; E.b = Math.abs(q - r); E.rot = (a2 + a1) / 2; E.ph = (a2 - a1) / 2;
  }

  /** A stretch of a roof circle (fractions f0..f1 of the way round, from its back corner,
   *  clockwise) of radius R world units centred on screen point (x, y), into the open path. */
  private arc(g: Gfx, x: number, y: number, R: number, f0: number, f1: number): void {
    const E = this.ell;
    const t0 = -Math.PI / 2 + f0 * TAU + E.ph, t1 = -Math.PI / 2 + f1 * TAU + E.ph;
    const A = E.a * R, B = E.b * R, cr = Math.cos(E.rot), sr = Math.sin(E.rot);
    g.ctx.moveTo(x + A * Math.cos(t0) * cr - B * Math.sin(t0) * sr, y + A * Math.cos(t0) * sr + B * Math.sin(t0) * cr);
    g.ctx.ellipse(x, y, A, B, E.rot, t0, t1);
    g.ops += 2; g.arcs++;
  }

  // ---- the live layer: a hit per building, the trouble, rings flashing as deploys land, the
  // tether of an app behind main while it is pointed at ----

  live(g: Gfx, fr: LiveFrame): boolean {
    const cam = this.f.cam, t = fr.t, q = fr.q;
    const offX = (x: number) => x < -24 || x > cam.W + 24;
    if (this.landing.length) this.landDue(t);
    // a hit per building big enough to point at (LOD0/1), its ghost storeys included
    const fleet = this.fleet;
    if (this.cityPitch * LOT * cam.s >= 5) {
      // a column through the building's middle, ghost storeys included: a row's columns never
      // overlap, and a nearer building's (pushed later) wins where it stands in front
      for (const b of this.blocks) {
        const cu = b.u + b.d / 2, cv = b.v + b.d / 2, x = cam.x(cu, cv);
        if (offX(x)) continue;
        const top = b.h + this.shownGhosts(b, fleet) * STOREY, hw = b.d * 0.42 * cam.s, y0 = cam.y(cu, cv, top) - b.d * 0.3 * cam.s;
        this.f.hit(x - hw, y0, hw * 2, cam.y(cu, cv, 0) + b.d * 0.3 * cam.s - y0, 'app', b.id, b.id);
      }
    }
    if (cam.zoom === 1) this.logAnchors();
    if (q < 4) this.drawTrouble(g, t);
    const moving = this.drawFlashes(g, t, q) || this.landing.length > 0;
    // the tether: an app behind main, pointed at or under the app lens
    const top = this.f.lens.topLens;
    const hb = this.f.hoverId ? this.blockAt.get(this.f.hoverId) : undefined;
    if (hb?.behind) this.tether(g, hb, 0.85, !fleet || (top?.kind === 'app' && top.id === hb.id));
    if (top?.kind === 'app' && top.id !== hb?.id) { const b = this.blockAt.get(top.id); if (b?.behind) this.tether(g, b, 0.85); }
    // fx-city: the fleet zoom names each district once, at its front edge (the group zoom's
    // labels.ts names take over from there)
    if (fleet && this.f.floor.level === 0 && q < 3 && !this.f.census.skeleton) this.drawNames(g);
    // zoomed in, the "+N" past the ghost storeys' cap
    if (cam.zoom >= 2 && q < 3) {
      for (const b of this.blocks) {
        if (b.behind <= GHOST_CAP) continue;
        const u = b.u + b.d * 0.07, v = b.v + b.d * 0.07, zt = b.h + b.ghosts * STOREY;
        const x = cam.x(u + b.d * 0.3, v) + 3, y = cam.y(u, v, zt + 4) + 4;
        if (offX(x) || y < 50 || y > cam.H - 60) continue;
        const s = `+${b.behind - GHOST_CAP}`, wv = g.width(s, 12);
        const at = this.f.placeAt(x, y, wv, 12, 0, false);
        if (at) g.text(s, at[0], at[1], C.ink2, 12);
      }
    }
    return moving;
  }

  /** fx-city: the districts the fleet zoom names (≤ DISTRICT_NAMES_MAX), in placing order:
   *  those with an app down or degraded first, then the biggest (the placer is greedy: the
   *  first placed wins its spot). */
  fleetNames(): CityDistrict[] {
    const trouble = new Set<number>();
    for (const b of this.troubleBlocks()) trouble.add(b.district);
    // w2-chrome (#10): trouble first, then the districts that shipped most today (their lit
    // skyline), then the biggest; a district that shipped nothing and is all up stays unnamed
    // (its lane's name on the left names it), within the fleet's text budget
    const today = (d: CityDistrict) => d.day.reduce((a, x) => a + x, 0);
    const order = this.districtBox.map((d, i) => ({ d, i, n: today(d) })).sort((a, b) => (trouble.has(b.i) ? 1 : 0) - (trouble.has(a.i) ? 1 : 0) || b.n - a.n || b.d.n - a.d.n || a.i - b.i);
    return order.filter((x) => trouble.has(x.i) || x.n > 0).slice(0, DISTRICT_NAMES_MAX).map((x) => x.d);
  }

  /** Each named district's name, in its lane's light hue, just outside its front-left corner
   *  (right-aligned to it), through the shared placer; when that spot is taken one of the first
   *  DISTRICT_NAMES_SURE steps aside (a staggered second column, a hairline back to the corner),
   *  the tail is dropped. Clicking a name flies to the district. */
  private drawNames(g: Gfx): void {
    const cam = this.f.cam, PX = 12, H = 13;
    const names = this.fleetNames();
    for (let k = 0; k < names.length; k++) {
      const d = names[k]!;
      const ax = cam.x(d.u0 - 2, d.v1), ay = cam.y(d.u0 - 2, d.v1);
      if (ax < 60 || ax > cam.W - 4 || ay < 60 || ay > cam.H - 60) continue;
      const wv = g.width(d.team, PX);
      let at: [number, number] | null = null;
      for (const [dx, dy] of k < DISTRICT_NAMES_SURE ? NAME_SPOTS : NAME_SPOTS.slice(0, 1)) {
        // at the corner, nudged; else one column further out (a staggered second column)
        at = this.f.placeAt(Math.round(ax - 6 - wv - (dx ? dx + wv : 0)), Math.round(ay + 5 + dy), wv, H, 0, false);
        if (at) break;
      }
      if (!at) continue;
      const [x, y] = at;
      const sky = this.skyOf.get(d.hex) ?? skyline(d.hex);
      if (Math.abs(x + wv + 6 - ax) > 3 || Math.abs(y - 5 - ay) > 3) {
        g.begin_(); g.move(x + wv + 2, y - 4); g.line(ax, ay); g.stroke(withAlpha(sky.ink, 0.45), 1);
      }
      g.fillRect(x - 2, y - 10, wv + 4, H, withAlpha(C.canvas, 0.78));
      g.text(d.team, x, y, sky.ink, PX);
      this.f.hit(x - 2, y - 10, wv + 4, H, 'district', `${(d.u0 + d.u1) / 2},${(d.v0 + d.v1) / 2},3.2`, d.team);
    }
  }

  /** For drivers (tools/factory-shots.mjs, as lens.ts logs its anchors): at the fit zoom, once
   *  per layout, a building of each story (the most ghost storeys, the tallest, a down, a
   *  degraded, an idle one) and each district's plate, in screen px. */
  private logAnchors(): void {
    const cam = this.f.cam;
    const key = `${cam.key}|${this.sig}|${this.f.census.healthSig}`;
    if (key === this.logged || !this.blocks.length) return;
    this.logged = key;
    // the footprint's centre on the floor: a wheel zoom about it keeps it under the pointer
    const at = (b: CityBlock | undefined) => b ? [Math.round(cam.x(b.u + b.d / 2, b.v + b.d / 2)), Math.round(cam.y(b.u + b.d / 2, b.v + b.d / 2, 0))] : undefined;
    const best = (k: (b: CityBlock) => number) => { let o: CityBlock | undefined, v = 0; for (const b of this.blocks) { const x = k(b); if (x > v) { v = x; o = b; } } return o; };
    const out: Record<string, unknown> = {
      behind: at(best((b) => b.behind)), behindId: best((b) => b.behind)?.id ?? '',
      tallest: at(best((b) => b.storeys)), tallestId: best((b) => b.storeys)?.id ?? '',
      down: at(this.blocks.find((b) => this.healthOf(b) === 2)), degraded: at(this.blocks.find((b) => this.healthOf(b) === 1)),
      idle: at(this.blocks.find((b) => b.idle && b.hv === -1)),
    };
    this.districtBox.forEach((d, i) => { out[`district${i}`] = [Math.round(cam.x((d.u0 + d.u1) / 2, (d.v0 + d.v1) / 2)), Math.round(cam.y((d.u0 + d.u1) / 2, (d.v0 + d.v1) / 2, 0)), d.team]; });
    console.log(`fab-w5: city anchors ${JSON.stringify(out)}`);
  }
  private logged = '';

  /** Degraded: the building's faces flicker amber on the beat; down: a red glow breathing under
   *  the red building (W4's beacon stands on its roof). */
  private drawTrouble(g: Gfx, t: number): void {
    const cam = this.f.cam;
    const trouble = this.troubleBlocks();
    if (!trouble.length) return;
    const fl = flash(t), br = breathe(t, 2);
    for (const b of trouble) {
      const x = cam.x(b.u + b.d / 2, b.v + b.d / 2);
      if (x < -24 || x > cam.W + 24) continue;
      const hl = this.healthOf(b);
      const y = cam.y(b.u + b.d / 2, b.v + b.d / 2, b.h / 2);
      g.begin_(); g.circle(x, y, Math.max(6, cam.s * (b.d * 0.9 + b.h * 0.4)));
      g.fill(withAlpha(hl === 2 ? C.red : C.packet, hl === 2 ? 0.06 + 0.1 * br : 0.05 + 0.08 * fl));
      if (hl === 1) {
        const u0 = b.u, u1 = b.u + b.d, v0 = b.v, v1 = b.v + b.d, h = b.h;
        g.begin_();
        poly(cam, g, [u0, v1, 0, u1, v1, 0, u1, v1, h, u0, v1, h]);
        poly(cam, g, [u1, v1, 0, u1, v0, 0, u1, v0, h, u1, v1, h]);
        g.fill(withAlpha(C.packet, 0.12 + 0.5 * fl));
      }
    }
  }

  /** A building's ring flashing as a deploy arrives (amber: it starts; green-gray: it landed;
   *  red: it failed): the roof ring, bright, growing as it fades. True while one shows. */
  private drawFlashes(g: Gfx, t: number, q: number): boolean {
    const fl = this.flashes;
    if (!fl.length) return false;
    const cam = this.f.cam;
    this.ellipse();
    let live = false;
    for (let i = fl.length - 1; i >= 0; i--) {
      const x = fl[i]!;
      const age = t - x.at;
      if (age > 1400) { fl.splice(i, 1); continue; }
      live = true;
      if (age < 0 || q >= 4) continue;
      const b = this.blockAt.get(x.id);
      if (!b) continue;
      const e = age / 1400;
      const cu = b.u + b.d / 2, cv = b.v + b.d / 2, px = cam.x(cu, cv), py = cam.y(cu, cv, b.h + 0.2);
      const col = x.k === 2 ? C.red : x.k === 1 ? C.green : C.packet;
      g.begin_(); this.arc(g, px, py, b.d * 0.34, 0, 1); g.stroke(withAlpha(col, 1 - e * 0.7), 2.2);
      g.begin_(); this.arc(g, px, py, b.d * (0.34 + 1.6 * e), 0, 1); g.stroke(withAlpha(col, 0.85 * (1 - e)), 1.6);
    }
    return live;
  }

  /** The amber tether from an app's main line (its repo's newest car on its org's rail, else the
   *  rail's end) to its ghost storeys: the commits it has not deployed. The live commit's car,
   *  still on the rail, is ringed green-gray (as the app lens does). */
  tether(g: Gfx, b: CityBlock, alpha: number, full = true): void {
    const cam = this.f.cam, w = this.f.world, c = this.f.census;
    const a = w.apps.get(b.id);
    if (!a?.repo) return;
    const org = w.orgOf(a.repo);
    const ri = c.rails.findIndex((r) => r.org === org);
    const rv = ri >= 0 ? (RAIL_V[ri] ?? this.f.railV(org)) : this.f.railV(org);
    let ru = RAIL_U1 - 6, live = -1;
    const rail = ri >= 0 ? c.rails[ri] : undefined;
    if (rail) {
      const n = rail.cars.length;
      rail.cars.forEach((car, k) => {
        if (car.repo !== a.repo) return;
        const u = RAIL_U1 - 12 - (n - 1 - k) * 10;
        if (u < RAIL_U0 + 4) return;
        ru = u;
        if (car.sha === a.live_sha) live = u;
      });
    }
    this.ellipse();
    if (live >= 0) { g.begin_(); this.arc(g, cam.x(live, rv), cam.y(live, rv, 4), 6, 0, 1); g.stroke(withAlpha(C.green, alpha), 1.4); }
    const x0 = cam.x(ru, rv), y0 = cam.y(ru, rv, 5);
    const cu = b.u + b.d / 2, cv = b.v + b.d / 2;
    const x1 = cam.x(cu, cv), y1 = cam.y(cu, cv, b.h + (full ? b.ghosts : this.shownGhosts(b, true)) * STOREY + 0.5);
    const lift = Math.max(60, Math.abs(x1 - x0) * 0.22);
    g.begin_(); g.move(x0, y0); g.ctx.quadraticCurveTo((x0 + x1) / 2, Math.min(y0, y1) - lift, x1, y1); g.ops++;
    g.stroke(withAlpha(C.packet, alpha), 1.5);
    g.begin_(); g.circle(x0, y0, 2.6); g.fill(withAlpha(C.packet, alpha));
  }

  /** The app lens's building (lens.ts appStory asks first): its ghost storeys, crisp, and the
   *  amber tether to its main line. True when the app is behind (the city drew them); false
   *  leaves the lens its own "fed by" line. Never dashed, never a crane. */
  appStory(g: Gfx, id: string): boolean {
    const b = this.blockAt.get(id);
    if (!b?.behind) return false;
    this.ellipse();
    this.ghosts(g, [b], 0, true);
    this.tether(g, b, 0.9);
    return true;
  }

  /** Layer.overlay: the app lens's building, as `appStory`. */
  overlay(g: Gfx, lens: Lens, fr: LiveFrame): boolean {
    void fr;
    return lens.kind === 'app' && this.appStory(g, lens.id);
  }

  /** The city's buildings that are degraded or down (recomputed when the health or the city moved). */
  private troubleBlocks(): CityBlock[] {
    const key = `${this.f.census.healthSig}|${this.cityKey}|${this.blocks.length}`;
    if (key !== this.troubleAt) {
      this.troubleAt = key;
      this.trouble = this.blocks.filter((b) => { const h = this.healthOf(b); return h === 1 || h === 2; });
    }
    return this.trouble;
  }
}

/** The lane list's order of the districts that have apps (tests): the lanes that hold apps. */
export function laneOrderWithApps(lanes: Lane[], has: (laneId: string) => boolean): string[] {
  return lanes.filter((l) => l.id !== BOTS_LANE && has(l.id)).map((l) => l.id);
}
