// TREND MARKS (fab-w2; FACTORY-SPEC §B channel rules, §E "trends without text"). Reusable
// painters that read a trend WITHOUT words, each taking a `Metric` from `insights.trend(id)`
// (h1 / h24 / d7 / dir / bad / a 24 h spark):
//
//   ghost   a dashed outline at the 7-d typical value (a box's typical height): solid above it =
//           worse. Always dashed, never on buildings (so it is never read as a ghost storey).
//   curb    a 24 h sparkline rail along a lane or a stage edge: a bar per hour, red where that
//           hour was worse than the threshold (the 7-d p90 / typical × 1.25), the typical level
//           dashed along it.
//   ember   a warm floor glow under a stage or a group that is worse than its 7-d p90 (or the
//           24 h value worse than 7 d by > 25 %, or the server's `bad`). Better shows nothing.
//   notch   ▲ / ▼ beside a title or on a plate: the direction vs typical (red when that
//           direction is worse, a quiet green-gray when better, nothing when flat).
//
// Plus the metric helpers every painter shares: which way is worse per metric (POLARITY), the
// derived failures/h metric, merging member trends into a lane's, and the severity that decides
// an ember. Painters batch into a few paths; nothing allocates per frame beyond a small array.

import type { Ctx2D } from '../../app.contract.d.ts';
import type { Metric, Trend } from '../wire.ts';
import type { Gfx } from '../yard/gfx.ts';
import { C, clamp, withAlpha } from '../yard/theme.ts';
import { insights } from '../insights.ts';
import type { Cam } from './iso.ts';
import type { Lane } from './groups.ts';
import { baseline } from './agg/baseline.ts';

/** The metrics a Trend carries, plus `failures` (derived: pipelines/h × (1 − pass rate)). */
export type MetricKey = 'intake_ms' | 'run_ms' | 'pass_rate' | 'pipelines' | 'deploys' | 'pr_age_ms' | 'red' | 'failures' | 'pushes';

/** Which direction is worse: +1 up is worse (slower, older, more red, more failures), −1 down is
 *  worse (fewer passes), 0 neither (throughput). */
export const POLARITY: Record<MetricKey, -1 | 0 | 1> = {
  intake_ms: 1, run_ms: 1, pass_rate: -1, pipelines: 0, deploys: 0, pr_age_ms: 1, red: 1, failures: 1, pushes: 0,
};
/** The smallest change that counts (a red main more, 5 s slower, 3 points of pass rate, one
 *  failure an hour): a zero baseline still has a threshold. */
const MIN_DELTA: Record<MetricKey, number> = {
  intake_ms: 5000, run_ms: 10_000, pass_rate: 0.03, pipelines: 2, deploys: 1, pr_age_ms: 6 * 3_600_000, red: 1, failures: 1, pushes: 3,
};

/** The trend's metric `key` (`failures` derived). Null when the trend is. */
export function metricOf(t: Trend | null | undefined, key: MetricKey): Metric | null {
  if (!t) return null;
  if (key === 'failures') return failuresOf(t);
  if (key === 'pushes') return null;
  return t[key] ?? null;
}

const r2 = (v: number) => Math.round(v * 100) / 100;

/** Failures per hour: pipelines/h × (1 − pass rate), per window and per spark hour. `bad` when
 *  it rose beyond 15 % (and one failure an hour) of the typical. */
export function failuresOf(t: Trend): Metric {
  const p = t.pipelines, r = t.pass_rate;
  const f = (n: number | null | undefined, pr: number | null | undefined): number | null => (n === null || n === undefined ? null : n === 0 ? 0 : pr === null || pr === undefined ? null : r2(n * (1 - pr)));
  const spark = p.spark.map((n, i) => f(n, r.spark[i]));
  return withDir({ h1: f(p.h1, r.h1), h24: f(p.h24, r.h24), d7: f(p.d7, r.d7), dir: 0, spark }, 'failures');
}

/** `dir` and `bad` the server's way: h1 against d7 (h24 while d7 is null), beyond ±15 % (pass
 *  rate: ±3 points; and at least MIN_DELTA), `bad` when that direction is worse. */
export function withDir(m: Metric, key: MetricKey): Metric {
  const a = m.h1, b = m.d7 ?? m.h24;
  let dir: -1 | 0 | 1 = 0;
  if (a !== null && b !== null) {
    const d = a - b;
    if (key === 'pass_rate') dir = d > 0.03 ? 1 : d < -0.03 ? -1 : 0;
    else if (Math.abs(d) >= MIN_DELTA[key] * 0.5) dir = a > b * 1.15 ? 1 : a < b * 0.85 ? -1 : 0;
  }
  const out: Metric = { h1: m.h1, h24: m.h24, d7: m.d7, dir, spark: m.spark };
  const w = POLARITY[key];
  if (dir !== 0 && w !== 0 && dir === w) out.bad = true;
  return out;
}

/** One trend from several (a lane that folds many groups: "other teams"): rates and counts add
 *  up, the pass rate and durations are weighted by pipelines, PR age is the members' mean. */
export function mergeTrends(id: string, ts: Trend[]): Trend | null {
  if (!ts.length) return null;
  if (ts.length === 1) return { ...ts[0]!, id };
  const sum = (xs: (number | null)[]) => { let s = 0, any = false; for (const x of xs) if (x !== null && x !== undefined) { s += x; any = true; } return any ? r2(s) : null; };
  const wmean = (xs: (number | null)[], ws: (number | null)[]) => {
    let s = 0, n = 0;
    xs.forEach((x, i) => { const w = ws[i] ?? 0; if (x !== null && x !== undefined && w > 0) { s += x * w; n += w; } });
    return n > 0 ? s / n : null;
  };
  const mean = (xs: (number | null)[]) => { const ys = xs.filter((x): x is number => x !== null && x !== undefined); return ys.length ? ys.reduce((a, b) => a + b, 0) / ys.length : null; };
  const win = ['h1', 'h24', 'd7'] as const;
  const pipesW = (k: 'h1' | 'h24' | 'd7') => ts.map((t) => t.pipelines[k]);
  const merge = (key: Exclude<MetricKey, 'failures' | 'pushes'>): Metric => {
    const ms = ts.map((t) => t[key]);
    const kind = key === 'pipelines' || key === 'deploys' || key === 'red' ? 'sum' : key === 'pr_age_ms' ? 'mean' : 'weighted';
    const one = (vals: (number | null)[], ws: (number | null)[]) => (kind === 'sum' ? sum(vals) : kind === 'mean' ? mean(vals) : wmean(vals, ws));
    const m: Metric = { h1: null, h24: null, d7: null, dir: 0, spark: [] };
    for (const k of win) { const v = one(ms.map((x) => x[k]), pipesW(k)); m[k] = v === null ? null : key === 'pass_rate' ? Math.round(v * 1000) / 1000 : kind === 'sum' ? v : Math.round(v); }
    const n = Math.max(...ms.map((x) => x.spark.length));
    for (let i = 0; i < n; i++) {
      const v = one(ms.map((x) => x.spark[i] ?? null), ts.map((t) => t.pipelines.spark[i] ?? null));
      m.spark.push(v === null ? null : key === 'pass_rate' ? Math.round(v * 1000) / 1000 : kind === 'sum' ? v : Math.round(v));
    }
    return withDir(m, key);
  };
  return {
    id, at: Math.max(...ts.map((t) => t.at)), hours_7d: Math.min(...ts.map((t) => t.hours_7d)),
    intake_ms: merge('intake_ms'), run_ms: merge('run_ms'), pass_rate: merge('pass_rate'), pipelines: merge('pipelines'),
    deploys: merge('deploys'), pr_age_ms: merge('pr_age_ms'), red: merge('red'),
  };
}

/** A lane's trend: its group's (the server's on v0.5, insights' approximation on v0.4), "other
 *  teams" merged from its members', none for the bots siding. */
export function trendOfLane(l: Lane): Trend | null {
  if (l.kind === 'bots' || !l.members.length) return null;
  const ins = insights();
  if (l.members.length === 1) return ins.trend(l.members[0]!);
  const ts: Trend[] = [];
  for (const id of l.members) { const t = ins.trend(id); if (t) ts.push(t); }
  return mergeTrends(l.id, ts);
}

/** The 7-d typical value: the server's d7, else the persisted ring's (agg/baseline.ts, a v0.4
 *  server), else null. `key`: 'fleet' or a lane / group id. */
export function typical(m: Metric | null, key: string, metric: MetricKey): number | null {
  if (!m) return null;
  return m.d7 ?? baseline().d7(key, metric);
}

/** The threshold above which (in the worse direction) a value is anomalous: the persisted ring's
 *  same-hour 7-d p90 when it has one, else typical × 1.25 (FACTORY-SPEC §E), at least
 *  typical + MIN_DELTA. For a "down is worse" metric (pass rate) it is a floor. Null: no basis. */
export function threshold(m: Metric | null, key: string, metric: MetricKey, at = 0): number | null {
  const w = POLARITY[metric];
  if (!m || !w) return null;
  const p90 = baseline().p90(key, metric, at);
  if (p90 !== null) return p90;
  const ty = typical(m, key, metric);
  if (ty === null) return null;
  return w > 0 ? Math.max(ty * 1.25, ty + MIN_DELTA[metric]) : Math.min(ty - (1 - ty) * 0.25, ty - MIN_DELTA[metric]);
}

/** Is `v` worse than `thr` for this metric? */
export function worse(v: number | null | undefined, thr: number | null, metric: MetricKey): boolean {
  if (v === null || v === undefined || thr === null) return false;
  const w = POLARITY[metric];
  return w > 0 ? v > thr : w < 0 ? v < thr : false;
}

/** How hot an ember burns, 0..1 (0: none). The last hour against the threshold, and the 24 h
 *  value against 7 d (§E: worse by > 25 %); the server's `bad` alone gives a faint one (0.3). */
export function severity(m: Metric | null, key: string, metric: MetricKey, at = 0): number {
  const w = POLARITY[metric];
  if (!m || !w) return 0;
  const thr = threshold(m, key, metric, at);
  const ty = typical(m, key, metric);
  const over = (v: number | null, t: number | null): number => {
    if (v === null || t === null || !worse(v, t, metric)) return 0;
    // how far past the threshold, in units of the threshold's own margin over typical
    const margin = Math.max(MIN_DELTA[metric], Math.abs(t - (ty ?? t)) || Math.abs(t) * 0.25);
    return clamp(0.4 + (0.6 * Math.abs(v - t)) / margin, 0.4, 1);
  };
  const t24 = ty === null ? null : w > 0 ? Math.max(ty * 1.25, ty + MIN_DELTA[metric]) : ty - Math.max((1 - ty) * 0.25, MIN_DELTA[metric]);
  const s = Math.max(over(m.h1, thr), over(m.h24, t24));
  return s > 0 ? s : m.bad ? 0.3 : 0;
}

// ───────────────────────────── the painters ─────────────────────────────

export type Pt = [number, number];
/** The ember's warm glow: between amber (in flight) and red (failing), at low alpha only. */
export const EMBER = '#E2733F';
const CURB = '#6E6E74';
const CURB_NOW = '#A3A3A8';
const CURB_RULE = '#34343A';
/** "Better than typical": a quiet green-gray (never a state colour). */
export const BETTER = '#86A891';
const GHOST = '#A0A0A6';

/** A dashed wireframe box (u0, v0, du × dv) from z0 up `h`: the top and the three corners the
 *  camera sees. The 7-d typical volume; the caller draws the actual solid. */
export function ghost(g: Gfx, cam: Cam, u0: number, v0: number, du: number, dv: number, h: number, z0 = 0, col = GHOST, alpha = 0.85): void {
  if (!(h > 0.3)) return;
  const u1 = u0 + du, v1 = v0 + dv, z1 = z0 + h;
  const X = (u: number, v: number) => cam.x(u, v), Y = (u: number, v: number, z: number) => cam.y(u, v, z);
  g.dash(true, 3, 2.5);
  g.begin_();
  g.move(X(u0, v0), Y(u0, v0, z1)); g.line(X(u1, v0), Y(u1, v0, z1)); g.line(X(u1, v1), Y(u1, v1, z1)); g.line(X(u0, v1), Y(u0, v1, z1)); g.line(X(u0, v0), Y(u0, v0, z1));
  g.move(X(u0, v1), Y(u0, v1, z0)); g.line(X(u0, v1), Y(u0, v1, z1));
  g.move(X(u1, v1), Y(u1, v1, z0)); g.line(X(u1, v1), Y(u1, v1, z1));
  g.move(X(u1, v0), Y(u1, v0, z0)); g.line(X(u1, v0), Y(u1, v0, z1));
  g.stroke(withAlpha(col, alpha), Math.max(1, g.hair * 1.5));
  g.dash(false);
}

/** The ghost of a metric's typical value on a box whose height is `scale(value)`: drawn when the
 *  typical is known. Returns the typical height (or -1). */
export function ghostOf(g: Gfx, cam: Cam, m: Metric | null, key: string, metric: MetricKey, u0: number, v0: number, du: number, dv: number, scale: (v: number) => number, z0 = 0): number {
  const ty = typical(m, key, metric);
  if (ty === null) return -1;
  const h = scale(ty);
  ghost(g, cam, u0, v0, du, dv, h, z0);
  return h;
}

export type CurbOpts = {
  /** 'fleet' or a lane / group id (the baseline ring's key). */
  key: string; metric: MetricKey;
  /** Bar length (world units) at the curb's max. */
  depth: number;
  /** 'floor': bars lie on the plane z, pointing `dir` from the a→b line (a chart printed on a roof
   *  or the floor); 'wall': bars rise from z (a rail standing along an edge). */
  plane?: 'floor' | 'wall'; z?: number; dir?: Pt;
  /** The value at full length (default: the spark's max, the typical and the threshold's). */
  max?: number;
  /** The world time (the same-hour baseline). */
  at?: number;
  /** Draw the dashed typical level along the curb (default true). */
  typical?: boolean;
  /** A context series drawn first, faint, on the same scale (a dock's pipelines/h under its
   *  failures/h): the bars then read as "the failing part of each hour". */
  context?: Metric | null;
  /** Colours (defaults for the dark floor; a light roof passes darker ones). */
  ink?: string; now?: string; dim?: string; rule?: string; typicalInk?: string;
};

/** A 24 h sparkline rail along a → b (floor points): a bar per hour, oldest at `a`; red where
 *  that hour was worse than the threshold (and the current hour when the server says `bad`),
 *  the current hour lighter, a hairline rule under it, and the typical level dashed. */
export function curb(g: Gfx, cam: Cam, m: Metric | null, a: Pt, b: Pt, o: CurbOpts): void {
  const z = o.z ?? 0, plane = o.plane ?? 'floor';
  const dir = o.dir ?? [0, -1];
  const P = (u: number, v: number, zz: number): [number, number] => [cam.x(u, v), cam.y(u, v, zz)];
  // the rule: a curb with nothing on it still reads as a rail
  if (o.rule !== '') {
    g.begin_();
    { const [x0, y0] = P(a[0], a[1], z), [x1, y1] = P(b[0], b[1], z); g.move(x0, y0); g.line(x1, y1); }
    g.stroke(o.rule ?? CURB_RULE, Math.max(1, g.hair * 2));
  }
  const sp = m?.spark ?? [];
  if (!m || !sp.length) return;
  const thr = threshold(m, o.key, o.metric, o.at ?? 0);
  const ty = typical(m, o.key, o.metric);
  const ctx = o.context?.spark ?? [];
  let max = o.max ?? 0;
  if (!o.max) {
    for (const v of sp) if (v !== null && v > max) max = v;
    for (const v of ctx) if (v !== null && v > max) max = v;
    if (ty !== null) max = Math.max(max, ty * 1.15);
  }
  if (!(max > 0)) return;
  const n = sp.length, du = (b[0] - a[0]) / n, dv = (b[1] - a[1]) / n, gap = 0.18;
  const lists: number[][] = [[], [], [], []]; // normal, red, now, context
  for (let i = 0; i < n; i++) {
    const c = ctx[i];
    if (c !== null && c !== undefined && c > 0) lists[3]!.push(i, Math.max(0.8, (Math.min(c, max) / max) * o.depth));
    const v = sp[i];
    if (v === null || v === undefined || v <= 0) continue;
    const len = Math.max(0.8, (Math.min(v, max) / max) * o.depth);
    const red = worse(v, thr, o.metric) || (i === n - 1 && !!m.bad);
    lists[red ? 1 : i === n - 1 ? 2 : 0]!.push(i, len);
  }
  const paint = (list: number[], col: string) => {
    if (!list.length) return;
    g.begin_();
    for (let k = 0; k < list.length; k += 2) {
      const i = list[k]!, len = list[k + 1]!;
      const ua = a[0] + du * (i + gap), va = a[1] + dv * (i + gap), ub = a[0] + du * (i + 1 - gap), vb = a[1] + dv * (i + 1 - gap);
      let p0: [number, number], p1: [number, number], p2: [number, number], p3: [number, number];
      if (plane === 'wall') { p0 = P(ua, va, z); p1 = P(ub, vb, z); p2 = P(ub, vb, z + len); p3 = P(ua, va, z + len); }
      else { p0 = P(ua, va, z); p1 = P(ub, vb, z); p2 = P(ub + dir[0] * len, vb + dir[1] * len, z); p3 = P(ua + dir[0] * len, va + dir[1] * len, z); }
      g.ctx.moveTo(p0[0], p0[1]); g.ctx.lineTo(p1[0], p1[1]); g.ctx.lineTo(p2[0], p2[1]); g.ctx.lineTo(p3[0], p3[1]); g.ctx.closePath();
      g.ops += 5;
    }
    g.fill(col);
  };
  paint(lists[3]!, o.dim ?? '#38383D');
  paint(lists[0]!, o.ink ?? CURB);
  paint(lists[2]!, o.now ?? CURB_NOW);
  paint(lists[1]!, C.red);
  // the typical level, dashed along the curb
  if (o.typical !== false && ty !== null && ty > 0) {
    const len = (Math.min(ty, max) / max) * o.depth;
    const q0 = plane === 'wall' ? P(a[0], a[1], z + len) : P(a[0] + dir[0] * len, a[1] + dir[1] * len, z);
    const q1 = plane === 'wall' ? P(b[0], b[1], z + len) : P(b[0] + dir[0] * len, b[1] + dir[1] * len, z);
    g.dash(true, 2, 2);
    g.begin_(); g.move(q0[0], q0[1]); g.line(q1[0], q1[1]); g.stroke(o.typicalInk ?? withAlpha(GHOST, 0.9), Math.max(1, g.hair * 1.5));
    g.dash(false);
  }
}

/** A warm glow on the floor quad (u0, v0)–(u1, v1) at height z, `k` 0..1 (severity): a radial
 *  gradient from the quad's centre and a faint hot rim. Static (the floor layer paints it). */
export function ember(g: Gfx, cam: Cam, u0: number, v0: number, u1: number, v1: number, k: number, z = 0, rim = true): void {
  if (!(k > 0)) return;
  const ctx = g.ctx as Ctx2D;
  const cu = (u0 + u1) / 2, cv = (v0 + v1) / 2;
  const cx = cam.x(cu, cv), cy = cam.y(cu, cv, z);
  const corners: [number, number][] = [[u0, v0], [u1, v0], [u1, v1], [u0, v1]];
  let R = 1;
  for (const [u, v] of corners) R = Math.max(R, Math.hypot(cam.x(u, v) - cx, cam.y(u, v, z) - cy));
  const a = clamp(k, 0, 1);
  const gr = ctx.createRadialGradient(cx, cy, 0, cx, cy, R);
  gr.addColorStop(0, withAlpha(EMBER, 0.34 * a));
  gr.addColorStop(0.5, withAlpha(EMBER, 0.15 * a));
  gr.addColorStop(1, withAlpha(EMBER, 0.04 * a));
  g.begin_();
  corners.forEach(([u, v], i) => { const x = cam.x(u, v), y = cam.y(u, v, z); if (i) g.line(x, y); else g.move(x, y); });
  g.ctx.closePath();
  ctx.fillStyle = gr as unknown as string;
  ctx.fill();
  g.ops += 4; g.arcs++;
  if (rim) g.stroke(withAlpha(EMBER, 0.18 + 0.4 * a), Math.max(1, g.hair * 2));
}

/** A soft round glow on the floor around (u, v), `r` world units, no edge: the ember under one
 *  object (a dock, a district) rather than a stage's zone. */
export function emberAt(g: Gfx, cam: Cam, u: number, v: number, r: number, k: number, z = 0): void {
  if (!(k > 0)) return;
  const ctx = g.ctx as Ctx2D;
  const x = cam.x(u, v), y = cam.y(u, v, z), R = r * cam.s;
  const a = clamp(k, 0, 1);
  const gr = ctx.createRadialGradient(x, y, 0, x, y, R);
  gr.addColorStop(0, withAlpha(EMBER, 0.42 * a));
  gr.addColorStop(0.45, withAlpha(EMBER, 0.2 * a));
  gr.addColorStop(1, withAlpha(EMBER, 0));
  ctx.save(); ctx.translate(x, y); ctx.scale(1, 0.62); ctx.translate(-x, -y);
  ctx.fillStyle = gr as unknown as string; ctx.beginPath(); ctx.arc(x, y, R, 0, Math.PI * 2); ctx.fill(); ctx.restore();
  g.ops += 12; g.arcs++;
}

/** ▲ / ▼ at screen (x, baseline y), `s` px half-width: up/down vs typical (`dir`), red when that
 *  direction is worse (`bad`), green-gray when better, ink when the metric has no worse side;
 *  nothing when flat. Returns the width it took (0 when nothing). */
export function notch(g: Gfx, x: number, y: number, m: Metric | null, metric: MetricKey, s = 4.5): number {
  if (!m || !m.dir) return 0;
  const w = POLARITY[metric];
  const col = m.bad ? C.red : w ? BETTER : C.ink3;
  const top = y - 2 * s - 1, bot = y - 1;
  g.begin_();
  if (m.dir > 0) { g.move(x, bot); g.line(x + 2 * s, bot); g.line(x + s, top); }
  else { g.move(x, top); g.line(x + 2 * s, top); g.line(x + s, bot); }
  g.ctx.closePath();
  g.fill(col);
  return 2 * s + 3;
}
