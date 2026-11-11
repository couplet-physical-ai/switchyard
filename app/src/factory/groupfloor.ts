// GROUPS AND TRENDS ON TODAY'S FLOOR (fab-w2, the first visible pass; FACTORY-SPEC §C, §B, §E).
// factory.ts calls in through a few `// fab-w2` hook lines (they move onto W0's layers at the
// merge); everything is drawn here, from groups.ts (lanes, aggregates, hues) and trendmarks.ts
// (ghost, curb, ember, notch):
//
//   - the org docks become GROUP docks, one per lane, back → front in §C order: footprint ∝
//     √repos (the lane's depth), height = pushes/h (√), the roof filled with the group's hue (the
//     bots' hatched), a door lamp lit red while the group has a main line red < 1 h, a curb on the
//     roof (the last 24 h: runs per hour faint, failures dark, red where over the 7-d threshold),
//     a ghost at the typical pushes/h, an ember under a dock whose failures run over p90;
//   - pushes leave from their repo's group dock and failures ride home to it (`dockV`);
//   - each stage title carries a notch (▲/▼ vs typical, red when worse) from the fleet trend;
//   - the worst stage (fleet trend, over its threshold) glows with an ember;
//   - PR stacks carry a base stripe of their groups' shares; a busy bay a stripe of its job's group.

import type { Gfx } from '../yard/gfx.ts';
import type { Pipeline, Trend } from '../wire.ts';
import type { Factory } from './factory.ts';
import type { FactoryFx } from './lens.ts';
import { C, withAlpha } from '../yard/theme.ts';
import { BOTS } from '../world.ts';
import { insights } from '../insights.ts';
import { normTeam } from '../../server/floor.ts';
import { PHASES } from './census.ts';
import { BOTS_LANE, OTHER_LANE, floorGroups, type Lane, type LaneStats } from './groups.ts';
import { curb, ember, emberAt, ghost, metricOf, notch, severity, typical, withDir, type MetricKey } from './trendmarks.ts';
import { baseline } from './agg/baseline.ts';

type Add = (u: number, v: number, fn: () => void, u1: number, v1: number, h: number) => void;
type Geo = { lane: Lane; v: number; v0: number; v1: number; hex: string };

/** The docks' zone (world v) and the collect belt's span (it stays where factory.ts draws it). */
const ZONE_V0 = 26, ZONE_V1 = 588, COLLECT_V0 = 66, COLLECT_V1 = 546;
const MIN_DEPTH = 32;
const SIDE = '#18181A', FRONT = '#141416', EDGE = '#3A3A3E', DOOR = '#0F0F10';

/** Stage number → the fleet metric its notch and ember read (none: no notch). */
const STAGE_METRIC: Record<string, MetricKey> = {
  '02': 'pr_age_ms', '04': 'red', '05': 'intake_ms', '06': 'run_ms', '07': 'pass_rate', '08': 'deploys',
};

export class GroupFloor {
  private geo: Geo[] = [];
  private geoKey = '';
  private byLane = new Map<string, Geo>();
  private sigAt = '';
  private sigVal = '';
  /** The stage the ember sits under ('' none) and its heat, for tests and the HUD. */
  worst = { stage: '', k: 0 };

  constructor(private f: Factory) {}

  private get fx(): FactoryFx { return this.f.fx; }

  /** On when the floor has a fleet with groups (else factory.ts draws its org docks). */
  get on(): boolean {
    const f = this.f;
    return !f.census.skeleton && f.world.loaded && floorGroups().lanes().length >= 2;
  }

  // ── geometry ──

  /** Lanes back → front, depth ∝ √repos (bots: a fixed share), at least MIN_DEPTH, filling the
   *  docks' zone. Recomputed only when the lanes change. */
  layout(): Geo[] {
    const lanes = floorGroups().lanes();
    const key = lanes.map((l) => `${l.id}:${l.repos}`).join('|');
    if (key === this.geoKey) return this.geo;
    this.geoKey = key;
    const wt = lanes.map((l) => Math.sqrt(Math.max(4, l.kind === 'bots' ? 30 : l.repos)));
    const span = ZONE_V1 - ZONE_V0;
    const depth = new Array<number>(lanes.length).fill(0);
    let fixed = new Set<number>();
    for (let pass = 0; pass < 4; pass++) {
      const free = span - fixed.size * MIN_DEPTH;
      const sw = wt.reduce((a, w, i) => a + (fixed.has(i) ? 0 : w), 0);
      const next = new Set(fixed);
      wt.forEach((w, i) => { if (!fixed.has(i)) { depth[i] = (free * w) / sw; if (depth[i]! < MIN_DEPTH) next.add(i); } else depth[i] = MIN_DEPTH; });
      if (next.size === fixed.size) break;
      fixed = next;
    }
    let v = ZONE_V0;
    this.geo = lanes.map((l, i) => {
      const d = depth[i]!;
      const g: Geo = { lane: l, v: v + d / 2, v0: v + 4, v1: v + d - 4, hex: floorGroups().hex(l.id) };
      v += d;
      return g;
    });
    this.byLane = new Map(this.geo.map((g) => [g.lane.id, g]));
    return this.geo;
  }

  /** The dock v (world) for a repo id, BOTS, or an org (its org lane, else the lane its group
   *  folds into); -1 when off (factory.ts then uses its own). */
  dockV(key: string): number {
    if (!this.on) return -1;
    this.layout();
    const G = floorGroups();
    const lane = key === BOTS ? BOTS_LANE : key.includes('/') ? G.laneOfRepo(key) : G.laneOfGroup(`org:${key}`);
    return this.byLane.get(lane)?.v ?? this.byLane.get(OTHER_LANE)?.v ?? -1;
  }

  /** The dock belts (one per lane, dock → collect belt), and the collect belt's stretch past
   *  its ends when the lanes reach beyond it. False when off. */
  belts(out: { id: string; pts: [number, number][]; n: number; label: string; at: [number, number] }[]): boolean {
    if (!this.on) return false;
    const P = this.f.plan, G = floorGroups();
    const geo = this.layout();
    geo.forEach((g, i) => {
      const s = G.stats(g.lane.id);
      out.push({ id: `dock${i}`, pts: [[P.DOCK_U1, g.v], [P.COLLECT_U, g.v]], n: s?.pushes1h ?? 0, label: '', at: [84, g.v] });
    });
    const first = geo[0]!.v, last = geo[geo.length - 1]!.v;
    if (first < COLLECT_V0) out.push({ id: 'collect0', pts: [[P.COLLECT_U, first], [P.COLLECT_U, COLLECT_V0]], n: 0, label: '', at: [P.COLLECT_U, first] });
    if (last > COLLECT_V1) out.push({ id: 'collect1', pts: [[P.COLLECT_U, COLLECT_V1], [P.COLLECT_U, last]], n: 0, label: '', at: [P.COLLECT_U, last] });
    return true;
  }

  /** A dock's height: pushes in the last hour, √ (a quiet dock stays a low slab). */
  private dockH(pushes: number): number { return Math.min(24, 4 + 2.6 * Math.sqrt(Math.max(0, pushes))); }

  /** The lane's pushes as a Metric (h1 now, d7 from the ring, the 24 h spark from the count). */
  private pushMetric(s: LaneStats | undefined): ReturnType<typeof withDir> | null {
    if (!s) return null;
    const sp = s.pushSpark;
    const h24 = sp.reduce((a, b) => a + b, 0) / 24;
    return withDir({ h1: s.pushes1h, h24: Math.round(h24 * 100) / 100, d7: baseline().d7(s.id, 'pushes'), dir: 0, spark: sp.slice() }, 'pushes');
  }

  // ── the floor layer ──

  /** The floor layer's key part: lanes, dock heights, curbs, door lamps, embers, stack shares
   *  (quantized so a count that changes nothing visible repaints nothing). */
  get sig(): string {
    if (!this.on) return '';
    const G = floorGroups();
    const cnt = G.counts();
    const ins = insights();
    const at = `${G.ver}|${ins.ver('trends')}|${this.f.budget.quality >= 3 ? 1 : 0}`;
    if (at === this.sigAt) return this.sigVal;
    this.sigAt = at;
    const parts: string[] = [this.layout().map((g) => g.lane.id).join(',')];
    for (const g of this.geo) {
      const s = cnt.lanes.get(g.lane.id);
      if (!s) { parts.push('-'); continue; }
      const t = s.trend;
      const fm = metricOf(t, 'failures');
      parts.push(`${Math.round(this.dockH(s.pushes1h))}.${s.freshRed ? 1 : 0}.${q(fm?.spark)}.${q(t?.pipelines.spark)}.${Math.round(severity(fm, g.lane.id, 'failures', cnt.at) * 10)}.${q(s.pushSpark)}`);
    }
    for (const row of cnt.stacks) for (const m of row) { let tot = 0; for (const n of m.values()) tot += n; const k: string[] = []; for (const [l, n] of m) k.push(`${l}${Math.round((n / Math.max(1, tot)) * 12)}`); parts.push(k.join('')); }
    const ft = ins.trend('fleet');
    parts.push(this.pickWorst(ft, cnt.at));
    this.sigVal = hash(parts.join(';'));
    return this.sigVal;
  }

  /** The worst stage by the fleet trend: the highest severity over its threshold. */
  private pickWorst(ft: Trend | null, at: number): string {
    let best = '', k = 0;
    for (const [n, m] of Object.entries(STAGE_METRIC)) {
      let s = severity(metricOf(ft, m), 'fleet', m, at);
      if (n === '07') s = Math.max(s, severity(metricOf(ft, 'failures'), 'fleet', 'failures', at));
      if (s > k + 0.01) { k = s; best = n; }
    }
    this.worst = { stage: best, k };
    return `${best}${Math.round(k * 10)}`;
  }

  /** Called where factory.ts paints its docks: the embers (the worst stage's, and under each
   *  dock whose failures run over p90), the dock belts' hue line, and the dock and stack-stripe
   *  items (queued with `add`, painted far to near with the rest). False when off. */
  floor(g: Gfx, add: Add): boolean {
    if (!this.on) return false;
    const f = this.f, P = f.plan, cam = f.cam, G = floorGroups();
    const cnt = G.counts();
    const lo = f.budget.quality >= 3;
    const geo = this.layout();
    this.sig; // the worst stage and the counts are current
    // the worst stage's ember: under everything on its zone
    const W = this.worst;
    if (W.stage && W.k > 0) {
      const z = stageZone(W.stage, P);
      if (z) ember(g, cam, z[0], z[1], z[2], z[3], W.k);
    }
    for (const gg of geo) {
      const s = cnt.lanes.get(gg.lane.id);
      const k = severity(metricOf(s?.trend, 'failures'), gg.lane.id, 'failures', cnt.at);
      if (k > 0) emberAt(g, cam, (P.DOCK_U0 + P.DOCK_U1) / 2 + 8, gg.v, Math.max(40, (gg.v1 - gg.v0) * 1.1), k);
    }
    // each dock belt carries its group's hue down its middle
    if (!lo) for (const gg of geo) {
      g.begin_(); g.move(cam.x(P.DOCK_U1, gg.v), cam.y(P.DOCK_U1, gg.v, 0.4)); g.line(cam.x(P.COLLECT_U - 3, gg.v), cam.y(P.COLLECT_U - 3, gg.v, 0.4));
      g.stroke(withAlpha(gg.hex, 0.55), Math.max(1, g.hair * 2));
    }
    for (const gg of geo) add(P.DOCK_U0, gg.v0, () => this.dock(g, gg, cnt.lanes.get(gg.lane.id), lo, cnt.at), P.DOCK_U1, gg.v1, 24);
    // the PR stacks' base stripes: each stack's groups by share, in lane order
    PHASES.forEach((_ph, r) => {
      P.AGE_V.forEach((v, b) => {
        const m = cnt.stacks[r]?.[b];
        const n = f.census.stacks[r]?.[b]?.n ?? 0;
        if (!m || !m.size || !n) return;
        const u0 = P.ROW_U[r]! - P.ROW_DU / 2;
        add(u0 + 0.02, v + 0.02, () => this.stackStripe(g, u0, v, m, geo), u0 + P.ROW_DU, v + P.STACK_DV, 4);
      });
    });
    return true;
  }

  /** One group dock: the box with its roof in the group's hue (bots hatched), the door and its
   *  lamp, the 24 h curb printed on the roof, and the ghost of its typical pushes/h. */
  private dock(g: Gfx, gg: Geo, s: LaneStats | undefined, lo: boolean, at: number): void {
    const f = this.f, P = f.plan, cam = f.cam, fx = this.fx;
    const u0 = P.DOCK_U0, u1 = P.DOCK_U1, v0 = gg.v0, v1 = gg.v1;
    const h = this.dockH(s?.pushes1h ?? 0);
    fx.box(g, u0, v0, u1 - u0, v1 - v0, h, gg.hex, SIDE, FRONT, EDGE);
    if (gg.lane.kind === 'bots' && !lo) {
      // shape = kind: the bots' roof is hatched
      const ctx = g.ctx;
      ctx.save();
      g.begin_(); fx.poly(g, [u0, v0, h, u1, v0, h, u1, v1, h, u0, v1, h]); ctx.clip();
      g.begin_();
      for (let k = -(v1 - v0); k < u1 - u0; k += 5) { g.move(cam.x(u0 + k, v0), cam.y(u0 + k, v0, h)); g.line(cam.x(u0 + k + (v1 - v0), v1), cam.y(u0 + k + (v1 - v0), v1, h)); }
      g.stroke(withAlpha('#0C0C0E', 0.55), Math.max(1, g.hair * 2));
      ctx.restore();
      g.ops += 2;
    }
    // the door on the right face, toward the belt; its lamp red while a main line of the group
    // has been red for less than an hour
    const dw = Math.min(10, (v1 - v0) / 2 - 3), dz = Math.max(2, Math.min(h - 1.5, 9));
    g.begin_(); fx.poly(g, [u1, gg.v - dw, 0.5, u1, gg.v + dw, 0.5, u1, gg.v + dw, dz, u1, gg.v - dw, dz]); g.fill(DOOR);
    if (s?.freshRed) {
      g.begin_(); fx.poly(g, [u1, gg.v - dw, dz + 0.4, u1, gg.v + dw, dz + 0.4, u1, gg.v + dw, Math.min(h, dz + 2.6), u1, gg.v - dw, Math.min(h, dz + 2.6)]);
      g.fill(C.red);
    }
    if (lo) return;
    // the curb on the roof: 24 h, a bar an hour, runs faint and failures dark (red: over p90)
    const t = s?.trend ?? null;
    const fm = metricOf(t, 'failures');
    const ink = '#0C0C0E';
    const common = { depth: Math.max(4, v1 - v0 - 7), plane: 'floor' as const, z: h, dir: [0, -1] as [number, number], at, rule: '', ink: withAlpha(ink, 0.6), now: withAlpha(ink, 0.78), dim: withAlpha(ink, 0.2), typicalInk: withAlpha(ink, 0.65) };
    if (fm) curb(g, cam, fm, [u0 + 3, v1 - 2.5], [u1 - 3, v1 - 2.5], { ...common, key: gg.lane.id, metric: 'failures', context: t?.pipelines ?? null, typical: false });
    else curb(g, cam, this.pushMetric(s), [u0 + 3, v1 - 2.5], [u1 - 3, v1 - 2.5], { ...common, key: gg.lane.id, metric: 'pushes', typical: false });
    // the ghost: the dock at its typical pushes/h (the ring's 7-d mean), dashed
    const pm = this.pushMetric(s);
    const ty = typical(pm, gg.lane.id, 'pushes');
    if (ty !== null) {
      const th = this.dockH(ty);
      if (Math.abs(th - h) >= 1.2) ghost(g, cam, u0, v0, u1 - u0, v1 - v0, th);
    }
  }

  /** A PR stack's base stripe: its groups' shares along the crates' front face and on the pallet
   *  in front of them, in lane order. */
  private stackStripe(g: Gfx, u0: number, v: number, m: Map<string, number>, geo: Geo[]): void {
    const P = this.f.plan, fx = this.fx;
    const ua = u0 + 7, ub = u0 + P.ROW_DU - 7, vb = v + P.STACK_DV - 7;
    let tot = 0;
    for (const n of m.values()) tot += n;
    if (!tot) return;
    let u = ua;
    for (const gg of geo) {
      const n = m.get(gg.lane.id);
      if (!n) continue;
      const du = ((ub - ua) * n) / tot;
      g.begin_();
      fx.poly(g, [u, vb, 2, u + du, vb, 2, u + du, vb, 4.6, u, vb, 4.6]);
      fx.quad(g, u, vb + 1.2, u + du, vb + 5.2, 2);
      g.fill(gg.hex);
      u += du;
    }
  }

  // ── the live layer ──

  /** After the crates, before the labels: busy bays' group stripes, the docks' names and hits;
   *  and it advances the group count one slice. */
  over(g: Gfx, _t: number): void {
    if (!this.on) return;
    const G = floorGroups();
    G.counts();
    const f = this.f, P = f.plan, cam = f.cam, fx = this.fx, w = f.world;
    const geo = this.layout();
    // bays: a stripe along the back of each busy bay, the job's group
    const byHex = new Map<string, number[]>();
    for (const b of fx.bays) {
      if (!b.pid) continue;
      const p = w.pipelines.get(b.pid) as Pipeline | undefined;
      if (!p) continue;
      const hex = G.hex(G.laneOfPipeline(p));
      let l = byHex.get(hex);
      if (!l) byHex.set(hex, (l = []));
      l.push(b.u + 1, b.v + 1, b.u + b.du - 1, b.v + Math.min(6, b.dv * 0.35));
    }
    for (const [hex, l] of byHex) {
      g.begin_();
      for (let i = 0; i < l.length; i += 4) fx.quad(g, l[i]!, l[i + 1]!, l[i + 2]!, l[i + 3]!, P.ENG_H);
      g.fill(hex);
    }
    // the docks: a name each (no numbers: height, curb and belt carry them) and a hit
    const c = f.census;
    for (const gg of geo) {
      const s = G.stats(gg.lane.id);
      const h = this.dockH(s?.pushes1h ?? 0);
      const xs = [cam.x(P.DOCK_U0, gg.v1), cam.x(P.DOCK_U1, gg.v0)], ys = [cam.y(P.DOCK_U0, gg.v0, h), cam.y(P.DOCK_U1, gg.v1, 0)];
      const hx = Math.min(...xs), hy = Math.min(...ys);
      const kind = gg.lane.kind;
      const team = kind === 'other' ? c.districts.find((d) => d.team === 'other teams') : kind === 'team' ? c.districts.find((d) => normTeam(d.team) === gg.lane.id.slice(5)) : undefined;
      if (kind === 'org') fx.hit(hx, hy, Math.max(...xs) - hx, Math.max(...ys) - hy, 'dock', gg.lane.id.slice(4), `${gg.lane.short} dock`);
      else if (kind === 'bots') fx.hit(hx, hy, Math.max(...xs) - hx, Math.max(...ys) - hy, 'dock', BOTS, 'bots dock');
      else if (team) fx.hit(hx, hy, Math.max(...xs) - hx, Math.max(...ys) - hy, 'district', team.team, `${team.team} ${team.apps.length}`);
      const name = gg.lane.short;
      const x = cam.x(P.DOCK_U0, gg.v1) - 5, y = cam.y(P.DOCK_U0, gg.v1) + 1;
      const wv = g.width(name, 12);
      const at = fx.placeAt(x - wv, y, wv, 12, 0, false);
      if (at) g.text(name, at[0], at[1], kind === 'bots' || kind === 'other' ? C.ink3 : C.ink2, 12);
    }
  }

  /** A stage title's notch (▲/▼ vs typical, red when worse), at the end of its title line. */
  notch(g: Gfx, n: string, x: number, y: number): void {
    if (!this.on) return;
    const m = STAGE_METRIC[n];
    if (!m) return;
    notch(g, x, y, metricOf(insights().trend('fleet'), m), m, 4.5);
  }
}

/** A stage's floor zone for its ember (world u0, v0, u1, v1). */
function stageZone(n: string, P: Factory['plan']): [number, number, number, number] | null {
  switch (n) {
    case '02': return [P.YARD_U0 - 6, 92, P.YARD_U1 + 4, 600];
    case '04': return [P.RAIL_U0 - 4, 98, P.RAIL_U1 + 6, 482];
    case '05': return [P.INTAKE_U0 - 8, 252, P.INTAKE_U1 + 6, 330];
    case '06': return [P.ENG_U0 - 8, 22, P.ENG_U1 + 40, 600];
    case '07': return [P.SCAN_U - 22, 26, P.SCAN_U + 10, 610];
    case '08': return [P.SCAN_U + 10, P.TRACK_V[0]! - 26, P.TRACK_U1, P.TRACK_V[2]! + 26];
    default: return null;
  }
}

/** A spark quantized to 8 levels (and nulls), as a short key. */
function q(sp: readonly (number | null)[] | undefined): string {
  if (!sp?.length) return '';
  let max = 0;
  for (const v of sp) if (v !== null && v > max) max = v;
  let s = '';
  for (const v of sp) s += v === null ? '_' : max > 0 ? String(Math.round((v / max) * 7)) : '0';
  return s;
}

function hash(s: string): string {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(36);
}
