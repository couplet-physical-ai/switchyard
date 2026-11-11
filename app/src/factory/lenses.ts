// LENS DEPTH (fab-w3, phase 2): the data behind the deeper lens stories, kept out of lens.ts so the
// lens stack stays small. Everything here reads v0.5 ONLY through src/insights.ts.
//
//   parkByCluster   the return conveyor's failures parked by CLUSTER (overseer note 4): the same
//                   signature together, the biggest open cluster nearest the scanner
//   clusterCard     a failure cluster's facts (signature, class, counts, repos, groups, open,
//                   flaky, first/last seen, examples) for the cluster lens
//   groupFor*       which Group (team:/org:) a dock, a district or a repo opens
//   history wrapper app / engine history: the server's (W2's insights.appHistoryAsync /
//                   engineHistoryAsync once merged), else the client seams
//
// Cost: parking runs when the census recounts (≤ 1/s), O(failures in the last hour); the group and
// cluster facts when a lens is pushed or the relation refreshes (≤ 1/s), O(entities).

import { appHistory, clusterOf, clusters, engineHistory, groupHue, groupOf, groups, insights, trend } from '../insights.ts';
import type { AppHistoryView, EngineHistoryView } from '../insights.ts';
import type { Cluster, FailClass, Group, Metric, Trend } from '../wire.ts';
import type { World } from '../world.ts';
import type { Gfx } from '../yard/gfx.ts';
import { normTeam } from '../../server/floor.ts';

const HOUR = 3_600_000;

// ───────────────────────────── the return conveyor, by cluster ─────────────────────────────

/** One failure parked on the return conveyor. `cl` is its cluster id (or `s:<step>` when the seam
 *  knows none), `k` the index of its group in `ParkGroup[]`. */
export type Parked = { id: string; u: number; repo: string; step: string; at: number; cl: string; k: number; flaky: boolean; open: boolean };
/** A cluster's run of crates on the conveyor, from u0 (far end) to u1 (nearest the scanner). */
export type ParkGroup = { cl: string; u0: number; u1: number; n: number; open: boolean; step: string; cls: FailClass | ''; flaky: number; repos: number; newest: string };

/** World units between two crates of one cluster, and the extra gap between clusters. */
export const PARK_PITCH = 9;
export const PARK_GAP = 15;

type Fail = { id: string; repo: string; at: number; step: string };
type Bucket = { key: string; cl: Cluster | null; xs: Fail[]; newest: number };

/** Open clusters first, then the most crates parked (this hour), then the most failures in 24 h,
 *  then the newest: the Insights order (server/floor.ts clusterOrder) by what is on the belt.
 *  (fab-w2 exports clusterOrder() in groups.ts: swap to it at merge if it lands.) */
export function parkOrder(a: Bucket, b: Bucket): number {
  const ao = a.cl ? (a.cl.open > 0 ? 1 : 0) : 1, bo = b.cl ? (b.cl.open > 0 ? 1 : 0) : 1;
  return bo - ao || b.xs.length - a.xs.length || (b.cl?.count ?? 1) - (a.cl?.count ?? 1) || b.newest - a.newest || (a.key < b.key ? -1 : 1);
}

/** The last hour's failures (newest first) parked by cluster along the return conveyor: each
 *  cluster a tight run of crates (newest nearest the scanner), clusters a gap apart, the biggest
 *  open one nearest the scanner at `u1`. Stops at `uMin` (the conveyor's far end). */
export function parkByCluster(failing: readonly Fail[], w: World, u1: number, uMin: number): { parked: Parked[]; groups: ParkGroup[] } {
  const by = new Map<string, Bucket>();
  for (const x of failing) {
    const c = x.id ? clusterOf(x.id) : null;
    const key = c?.id ?? `s:${x.step}`;
    let b = by.get(key);
    if (!b) by.set(key, (b = { key, cl: c, xs: [], newest: 0 }));
    b.xs.push(x);
    if (x.at > b.newest) b.newest = x.at;
  }
  const order = [...by.values()].sort(parkOrder);
  const parked: Parked[] = [], out: ParkGroup[] = [];
  let u = u1;
  for (const b of order) {
    if (u < uMin) break;
    const k = out.length;
    const repos = new Set<string>();
    let flaky = 0, n = 0, lo = u;
    const hi = u;
    const open = b.cl ? b.cl.open > 0 : true;
    for (const x of b.xs) {
      if (u < uMin) break;
      const fl = w.pipelines.get(x.id)?.flaky === true;
      if (fl) flaky++;
      repos.add(x.repo);
      parked.push({ id: x.id, u, repo: x.repo, step: b.cl?.step ?? x.step, at: x.at, cl: b.key, k, flaky: fl, open });
      lo = u; n++;
      u -= PARK_PITCH;
    }
    out.push({ cl: b.key, u0: lo, u1: hi, n, open, step: b.cl?.step ?? b.xs[0]?.step ?? '', cls: b.cl?.class ?? '', flaky, repos: repos.size, newest: b.xs[0]?.id ?? '' });
    u -= PARK_GAP;
  }
  return { parked, groups: out };
}

// ───────────────────────────── a failure cluster's facts ─────────────────────────────

export type ClusterFacts = {
  id: string; cl: Cluster | null; step: string; cls: FailClass | ''; signature: string; line: string;
  count: number; count1h: number; open: number; flaky: number; repos: string[]; repoCount: number; groups: string[];
  first: number; last: number; examples: string[];
  /** The failures of this cluster the world still holds (≈ 2 h): [pipeline id, repo, at], newest first. */
  held: [string, string, number][];
};

/** The cluster of a failed run, with what the world holds of it. v0.5: `Step.cluster` and the
 *  server's Cluster (24 h counts, `open`, `flaky`, the decisive log line); v0.4: the seam's
 *  approximation (≈ 2 h). O(pipelines held). */
export function clusterFacts(w: World, pid: string): ClusterFacts | null {
  const p = w.pipelines.get(pid);
  if (!p) return null;
  const cl = clusterOf(pid);
  const id = cl?.id ?? '';
  const held: [string, string, number][] = [];
  if (id) {
    for (const [qid, q] of w.pipelines) {
      if (q.state !== 'failure' && q.state !== 'error') continue;
      if (qid === pid || clusterOf(qid)?.id === id) held.push([qid, q.repo, q.finished ?? q.created]);
    }
  } else held.push([pid, p.repo, p.finished ?? p.created]);
  held.sort((a, b) => b[2] - a[2]);
  const repos = cl?.repos?.length ? [...cl.repos] : [...new Set(held.map((h) => h[1]))];
  for (const h of held) if (!repos.includes(h[1])) repos.push(h[1]);
  const at = p.finished ?? p.created;
  return {
    id, cl, step: cl?.step ?? '', cls: cl?.class ?? '', signature: cl?.signature ?? '', line: cl?.line ?? '',
    count: Math.max(cl?.count ?? 0, held.length), count1h: cl?.count_1h ?? held.filter((h) => h[2] > w.at - HOUR).length,
    open: cl?.open ?? 0, flaky: cl?.flaky ?? (p.flaky ? 1 : 0), repos, repoCount: Math.max(cl?.repo_count ?? 0, repos.length),
    groups: cl?.groups?.length ? cl.groups : [...new Set(repos.map((r) => groupOf(r)))],
    first: cl?.first_seen ?? at, last: cl?.last_seen ?? at, examples: cl?.examples ?? held.slice(0, 5).map((h) => h[0]), held,
  };
}

/** The cluster's rank in the Insights order (0: the worst), -1 when not listed. */
export function clusterRank(id: string): number { return id ? clusters().findIndex((c) => c.id === id) : -1; }

// ───────────────────────────── groups ─────────────────────────────

/** The Group an org's dock (or rail) opens: the org's own group (its repos without a team) when
 *  it has one, else the group most of the org's repos belong to. */
export function groupForOrg(w: World, org: string): Group | null {
  const own = insights().group(`org:${org}`);
  if (own) return own;
  const votes = new Map<string, number>();
  for (const r of w.repos.values()) if (r.org === org) { const g = groupOf(r.id); votes.set(g, (votes.get(g) ?? 0) + 1); }
  let best = '', n = 0;
  for (const [g, k] of votes) if (k > n) { best = g; n = k; }
  return best ? insights().group(best) ?? null : null;
}

/** The Group a district opens: the team most of its apps' repos belong to (null: "other teams"). */
export function groupForApps(w: World, apps: readonly string[]): Group | null {
  const votes = new Map<string, number>();
  for (const id of apps) {
    const a = w.apps.get(id);
    if (!a?.repo) continue;
    const g = groupOf(a.repo);
    if (g.startsWith('team:')) votes.set(g, (votes.get(g) ?? 0) + 1);
  }
  let best = '', n = 0;
  for (const [g, k] of votes) if (k > n) { best = g; n = k; }
  return best ? insights().group(best) ?? null : null;
}

/** A group's apps: those whose repo is in the group, and (a team) those its catalog names. */
export function groupApps(w: World, gid: string): string[] {
  const out: string[] = [];
  const slug = gid.startsWith('team:') ? gid.slice(5) : '';
  for (const [id, a] of w.apps) if ((a.repo && groupOf(a.repo) === gid) || (slug && normTeam(a.team) === slug)) out.push(id);
  return out;
}

/** Every group, for a name lookup. */
export function allGroups(): Group[] { return groups(); }
export function groupTrend(id: string): Trend | null { return trend(id); }

// ───────────────────────────── histories (H6 / H7): the server's, else the client seams ─────────────────────────────

/** GET /api/v1/app/{id} (sy-server 73ef168): 7 d of health and the last 10 deploys. */
export type AppHist7 = {
  id: string;
  deploys: { sha: string; via: string; state: string; started: number; at: number; finished?: number; duration_ms?: number }[];
  health: { from: string; to: string; at: number }[]; // 7 d, newest first
  health_ms?: { up: number; degraded: number; down: number; unknown: number };
  since: number; complete?: boolean;
};
/** GET /api/v1/engine/{id}/history: columnar, one sample a minute over 24 h, null = offline. */
export type EngineHist24 = {
  id: string; from: number; step_ms: number; n: number;
  busy: (number | null)[]; slots: (number | null)[]; cpu: (number | null)[]; mem: (number | null)[]; load: (number | null)[];
  repos: { repo: string; runs: number }[];
};

type Async<T> = { at: number; v: T | null; pending: boolean };
const appCache = new Map<string, Async<AppHist7>>();
const engCache = new Map<string, Async<EngineHist24>>();
const TTL = 60_000;

/** Asks for an app's / an engine's server history once a minute at most. Call ONLY from a source's
 *  answer (a pointer turn): a fetch started in a draw is never run. The insights seam's own async
 *  fetchers win when present (fab-w2, at merge); else the upstream's JSON getter; a 404 or an
 *  error leaves the client seam to answer. */
export function wantAppHistory(id: string, now: number): void { want(appCache, id, now, 'appHistoryAsync', `/api/v1/app/${encodeURIComponent(id)}`); }
export function wantEngineHistory(id: string, now: number): void { want(engCache, id, now, 'engineHistoryAsync', `/api/v1/engine/${encodeURIComponent(id)}/history`); }

function want<T>(cache: Map<string, Async<T>>, id: string, now: number, seam: string, path: string): void {
  if (!id) return;
  const c = cache.get(id);
  if (c && (c.pending || now - c.at < TTL)) return;
  const e: Async<T> = { at: now, v: c?.v ?? null, pending: true };
  cache.set(id, e);
  if (cache.size > 64) { const k = cache.keys().next().value; if (k !== undefined && k !== id) cache.delete(k); }
  const ins = insights() as unknown as Record<string, unknown> & { upstream?: () => unknown };
  let p: Promise<unknown> | null = null;
  try {
    const f = ins[seam];
    if (typeof f === 'function') p = (f as (id: string) => Promise<unknown>).call(ins, id);
    else {
      // until fab-w2's fetchers land: the HTTP upstream's bounded JSON getter (absent on the demo)
      const up = typeof ins.upstream === 'function' ? (ins.upstream as () => unknown).call(ins) as { kind?: string; get?: (p: string, t?: number, c?: number) => Promise<unknown> } | null : null;
      if (up?.kind === 'http' && typeof up.get === 'function') p = up.get.call(up, path, 15000, 4 << 20);
    }
  } catch { p = null; }
  if (!p) { e.pending = false; return; }
  p.then((v) => { e.pending = false; if (v && typeof v === 'object') e.v = v as T; }, () => { e.pending = false; });
}

/** The server's app history when it answered, else null (the lens then reads `appHist`). */
export function appHist7(id: string): AppHist7 | null { return appCache.get(id)?.v ?? null; }
export function engineHist24(id: string): EngineHist24 | null { return engCache.get(id)?.v ?? null; }
/** The client seams (since the app opened). */
export function appHist(id: string): AppHistoryView | null { return appHistory(id); }
export function engineHist(id: string): EngineHistoryView | null { return engineHistory(id); }

// ───────────────────────────── drawing helpers shared by the deeper stories ─────────────────────────────

/** A failure class's pictogram, ~10 px, centred on (x, y): the cluster's "what kind of broken". */
export function classGlyph(g: Gfx, cls: FailClass | '', x: number, y: number, col: string): void {
  g.begin_();
  switch (cls) {
    case 'security': g.move(x - 4.5, y - 4.5); g.line(x + 4.5, y - 4.5); g.line(x + 4.5, y); g.line(x, y + 5); g.line(x - 4.5, y); g.ctx.closePath(); g.stroke(col, 1.2); return;
    case 'test': g.rect(x - 4.5, y - 4.5, 9, 9); g.move(x - 2.5, y - 2.5); g.line(x + 2.5, y + 2.5); g.move(x + 2.5, y - 2.5); g.line(x - 2.5, y + 2.5); g.stroke(col, 1.1); return;
    case 'lint': g.move(x - 5, y - 3.5); g.line(x + 5, y - 3.5); g.move(x - 5, y); g.line(x + 2.5, y); g.move(x - 5, y + 3.5); g.line(x, y + 3.5); g.stroke(col, 1.3); return;
    case 'typecheck': g.move(x - 5, y - 4.5); g.line(x + 5, y - 4.5); g.move(x, y - 4.5); g.line(x, y + 5); g.stroke(col, 1.4); return;
    case 'compile': case 'build': g.rect(x - 4.5, y - 3, 9, 7.5); g.move(x - 4.5, y - 3); g.line(x - 2, y - 5.5); g.line(x + 6.5, y - 5.5); g.line(x + 4.5, y - 3); g.stroke(col, 1.1); return;
    case 'deps': g.circle(x - 2.5, y, 3); g.stroke(col, 1.1); g.begin_(); g.circle(x + 2.5, y, 3); g.stroke(col, 1.1); return;
    case 'deploy': g.move(x, y + 4.5); g.line(x, y - 4); g.move(x - 3.5, y - 0.5); g.line(x, y - 4.5); g.line(x + 3.5, y - 0.5); g.move(x - 5, y + 5); g.line(x + 5, y + 5); g.stroke(col, 1.2); return;
    case 'oom': g.rect(x - 3.5, y - 4.5, 7, 9); for (const k of [-2.5, 0, 2.5]) { g.move(x - 5.5, y + k); g.line(x - 3.5, y + k); g.move(x + 3.5, y + k); g.line(x + 5.5, y + k); } g.stroke(col, 1); return;
    case 'timeout': g.circle(x, y, 4.8); g.move(x, y); g.line(x, y - 3.2); g.move(x, y); g.line(x + 2.4, y + 1); g.stroke(col, 1.1); return;
    case 'network': g.move(x - 5, y + 2); g.line(x - 2.5, y - 3); g.line(x, y + 2); g.line(x + 2.5, y - 3); g.line(x + 5, y + 2); g.stroke(col, 1.2); return;
    case 'infra': for (const k of [-4, -0.5, 3]) g.rect(x - 4.5, y + k, 9, 2.6); g.stroke(col, 1); return;
    default: g.circle(x, y, 4.5); g.stroke(col, 1.1); g.begin_(); g.circle(x, y, 1.4); g.fill(col); return;
  }
}

/** A hatched chip (flaky: it passed on the same sha), w × h at (x, y). */
export function hatch(g: Gfx, x: number, y: number, w: number, h: number, col: string, ink: string): void {
  g.fillRect(x, y, w, h, col);
  g.begin_();
  for (let k = -h; k < w; k += 3.5) { g.move(x + Math.max(0, k), y + h - Math.max(0, -k)); g.line(x + Math.min(w, k + h), y + Math.max(0, h - (Math.min(w, k + h) - k))); }
  g.stroke(ink, 1);
}

/** A 24-value spark (nulls are gaps) in a w × h box at (x, y) (y = the box's top). `max` 0: the
 *  series' own max. Returns the last value (NaN: none). */
export function spark(g: Gfx, s: readonly (number | null)[], x: number, y: number, w: number, h: number, col: string, max = 0, min = 0): number {
  let mx = max, last = NaN;
  if (!mx) for (const v of s) if (v !== null && Number.isFinite(v) && v > mx) mx = v;
  if (!(mx > min)) mx = min + 1;
  g.hline(x, x + w, y + h + 0.5, '#2A2A2C', 1);
  if (s.length < 2) return last;
  g.begin_();
  let first = true;
  for (let i = 0; i < s.length; i++) {
    const v = s[i];
    if (v === null || !Number.isFinite(v)) { first = true; continue; }
    const px = x + (i / (s.length - 1)) * w, py = y + h - clamp((v - min) / (mx - min), 0, 1) * h;
    if (first) { g.move(px, py); first = false; } else g.line(px, py);
    last = v;
  }
  g.stroke(col, 1.2);
  if (Number.isFinite(last)) { const py = y + h - clamp((last - min) / (mx - min), 0, 1) * h; g.begin_(); g.circle(x + w, py, 1.8); g.fill(col); }
  return last;
}

/** Bars for a short series in a w × h box at (x, y): `cols` per value (one colour: a string). */
export function bars(g: Gfx, s: readonly number[], x: number, y: number, w: number, h: number, col: string | ((i: number) => string), max = 0): void {
  const mx = max || Math.max(1, ...s);
  const bw = w / Math.max(1, s.length);
  for (let i = 0; i < s.length; i++) {
    const v = s[i];
    if (!(v > 0)) continue;
    const bh = Math.max(1, (v / mx) * h);
    g.fillRect(x + i * bw, y + h - bh, Math.max(1, bw - 1), bh, typeof col === 'string' ? col : col(i));
  }
}

/** A group's identity hue as `#rrggbb` (FACTORY-SPEC §C). */
export function hueHex(groupId: string): string { return groupHue(groupId).hex; }

/** Words for a time ago. */
export function agoW(ms: number): string {
  if (!(ms > 0)) return 'now';
  const m = Math.round(ms / 60_000);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

export function clamp(v: number, a: number, b: number): number { return v < a ? a : v > b ? b : v; }

// ───────────────────────────── the cluster lens's card ─────────────────────────────

const INK = '#F2F2F0', INK2 = '#A3A3A3', INK3 = '#8A8A8A', RED = '#E06464', RED_T = '#E3858C', GREEN_T = '#9CC3A6', RULE = '#2A2A2C';

/** The cluster lens's card body at (x, y), width W (paint false: measure). Returns its height.
 *  Signature line, class, open / 1 h / 24 h / repos / groups, a 24 h timeline (first → last seen,
 *  the held failures as ticks), flaky, the repos, the groups in their hues, the latest examples. */
export function clusterBody(g: Gfx, cf: ClusterFacts | null | undefined, w: World, pid: string, x: number, y: number, W: number, paint: boolean, now: number): number {
  if (!cf) return 0;
  let h = 0;
  const S = 12;
  // class · exit code · signature id
  if (paint) {
    classGlyph(g, cf.cls, x + 5, y + h + 11, RED_T);
    const ex = cf.cl?.exit_code !== undefined ? ` · exit ${cf.cl.exit_code}` : '';
    g.runs([[cf.cls || 'failure', INK2, true], [ex, INK3], [cf.id ? `  ${cf.id}` : '', '#5E5E62']], x + 16, y + h + 15, S, W - 16);
  }
  h += 20;
  // the decisive log line (v0.5 Cluster.line), up to two lines
  if (cf.line) {
    const lines = wrap(g, `“${cf.line}”`, S, W);
    for (const s of lines.slice(0, 2)) { if (paint) g.text(s, x, y + h + 13, INK2, S); h += 16; }
    h += 2;
  }
  // the counts
  const cells: [string, string, string][] = [
    [String(cf.open), cf.open ? 'open' : 'healed', cf.open ? RED_T : GREEN_T],
    [String(cf.count1h), '1 h', cf.count1h ? INK : INK3],
    [String(cf.count), '24 h', INK],
    [String(cf.repoCount), cf.repoCount === 1 ? 'repo' : 'repos', cf.repoCount >= 3 ? RED_T : INK],
    [String(cf.groups.length), cf.groups.length === 1 ? 'group' : 'groups', INK],
  ];
  if (paint) {
    const cw = W / cells.length;
    cells.forEach(([n, word, col], i) => {
      const cx = x + i * cw;
      g.text(n, cx, y + h + 16, col, 13, true);
      g.text(word, cx, y + h + 31, INK3, S);
      if (i) g.vline(Math.round(cx - 6) + 0.5, y + h + 3, y + h + 33, '#232325', 1);
    });
  }
  h += 38;
  // when: 24 h, first → last seen as a faint span, the held failures as ticks
  if (paint) {
    const ty = y + h + 4, k = (t: number) => 1 - clamp((now - t) / (24 * HOUR), 0, 1);
    g.hline(x, x + W, ty + 14.5, RULE, 1);
    const a = k(cf.first), b = k(cf.last);
    g.fillRect(x + a * W, ty + 9, Math.max(2, (b - a) * W), 4, 'rgba(224,100,100,0.28)');
    for (const [id, , at] of cf.held) g.fillRect(x + k(at) * (W - 2), ty + 1, 2, 13, id === pid ? INK : RED);
    const old = now - cf.first > 24 * HOUR;
    g.text(old ? `since ${agoW(now - cf.first)}` : '24 h', x, ty + 29, INK3, S);
    g.text(`last ${agoW(now - cf.last)} ago`, x + W, ty + 29, INK3, S, false, 'right');
  }
  h += 34;
  // flaky: passed on the same sha
  if (cf.flaky > 0) {
    if (paint) { hatch(g, x, y + h + 5, 14, 10, '#4A3436', 'rgba(14,14,14,0.9)'); g.runs([[`${cf.flaky}`, INK, true], [` of ${cf.count} flaky · passed on the same sha`, INK3]], x + 20, y + h + 14, S, W - 20); }
    h += 18;
  }
  // the repos it hit (most recent first)
  const names = cf.repos.slice(0, 4).map((r) => r.split('/')[1] ?? r);
  const more = cf.repoCount - names.length;
  if (names.length) {
    if (paint) g.runs([[names.join(' · '), RED_T], [more > 0 ? `  +${more}` : '', INK3]], x, y + h + 14, S, W);
    h += 18;
  }
  // the groups, in their hues
  if (cf.groups.length) {
    if (paint) {
      let gx = x;
      for (const gid of cf.groups.slice(0, 4)) {
        const name = insights().group(gid)?.name ?? gid.slice(gid.indexOf(':') + 1);
        const ww = g.width(name, S) + 16;
        if (gx + ww > x + W) break;
        g.fillRect(gx, y + h + 6, 9, 9, hueHex(gid));
        g.text(name, gx + 13, y + h + 15, INK2, S);
        gx += ww + 6;
      }
    }
    h += 18;
  }
  // the latest examples (pipeline ids the world still holds)
  const ex: string[] = [];
  for (const id of cf.examples) { const p = w.pipelines.get(id); if (p) ex.push(`${p.repo.split('/')[1] ?? p.repo} #${p.number}`); if (ex.length >= 3) break; }
  if (ex.length) { if (paint) g.runs([['latest ', INK3], [ex.join(' · '), INK2]], x, y + h + 14, S, W); h += 18; }
  return h;
}

/** Words wrapped to `W` at spaces (a long token is cut with an ellipsis). */
export function wrap(g: Gfx, s: string, px: number, W: number): string[] {
  const out: string[] = [];
  let cur = '';
  for (const word of s.split(/\s+/)) {
    const next = cur ? `${cur} ${word}` : word;
    if (g.width(next, px) <= W) { cur = next; continue; }
    if (cur) out.push(cur);
    cur = g.width(word, px) <= W ? word : g.fit(word, px, W);
    if (out.length >= 3) break;
  }
  if (cur && out.length < 4) out.push(cur);
  if (out.length > 2) out[1] = g.fit(`${out[1]} ${out[2]}`, px, W);
  return out;
}

void INK; void GREEN_T;

// ───────────────────────────── the group lens: one coloured ribbon through every stage ─────────────────────────────

/** A group's flow against the fleet's, per stage (24 h unless said), for its ribbon. Per org
 *  (`byOrg`): its strand from that org's dock to the intake. */
export type GroupFlow = {
  gid: string; hue: string;
  commits: number; prs: number; merged: number; runs: number; failed: number; deploys: number;
  fleet: { commits: number; prs: number; merged: number; runs: number; deploys: number };
  byOrg: Map<string, { commits: number; prs: number; merged: number }>;
  /** Pushes per hour over the last 24 h (oldest first): the hover's spark. */
  pushes24: number[];
};

/** The group's flow (O(commits + PRs + pipelines + deploys), once per relation refresh). */
export function groupFlow(w: World, gid: string, repos: ReadonlySet<string>, apps: ReadonlySet<string>, now: number): GroupFlow {
  const fl: GroupFlow = {
    gid, hue: hueHex(gid), commits: 0, prs: 0, merged: 0, runs: 0, failed: 0, deploys: 0,
    fleet: { commits: 0, prs: 0, merged: 0, runs: 0, deploys: 0 }, byOrg: new Map(), pushes24: new Array<number>(24).fill(0),
  };
  const org = (repo: string) => { const o = w.orgOf(repo); let e = fl.byOrg.get(o); if (!e) fl.byOrg.set(o, (e = { commits: 0, prs: 0, merged: 0 })); return e; };
  for (const c of w.commits.values()) {
    if (c.at < now - 24 * HOUR || c.at > now) continue;
    fl.fleet.commits++;
    if (!repos.has(c.repo)) continue;
    fl.commits++; org(c.repo).commits++;
    fl.pushes24[clamp(23 - Math.floor((now - c.at) / HOUR), 0, 23)]++;
  }
  for (const p of w.prs.values()) {
    const open = p.phase !== 'merged' && p.phase !== 'closed' && p.phase !== 'deployed';
    const merged = !!p.merged_at && p.merged_at >= now - 24 * HOUR && p.merged_at <= now;
    if (open && !p.bot) fl.fleet.prs++;
    if (merged) fl.fleet.merged++;
    if (!repos.has(p.repo)) continue;
    if (open && !p.bot) { fl.prs++; org(p.repo).prs++; }
    if (merged) { fl.merged++; org(p.repo).merged++; }
  }
  for (const p of w.pipelines.values()) {
    if (!p.finished || p.finished < now - 24 * HOUR || p.finished > now) continue;
    fl.fleet.runs++;
    if (!repos.has(p.repo)) continue;
    fl.runs++;
    if (p.state === 'failure' || p.state === 'error') fl.failed++;
  }
  for (const d of w.deploys.values()) {
    if (d.started < now - 24 * HOUR || d.started > now) continue;
    fl.fleet.deploys++;
    if (apps.has(d.app) || repos.has(d.repo)) fl.deploys++;
  }
  return fl;
}

/** Ribbon width in screen px for a share of the fleet's flow at a stage. */
export function ribbonW(share: number, zoom: number): number { return (2 + 20 * Math.sqrt(clamp(share, 0, 1))) * clamp(Math.sqrt(zoom), 1, 2); }

/** One trend row: the metric's name, its 24 h spark, the last hour, ▲/▼ (red when worse). */
export function trendRow(g: Gfx, word: string, m: Metric | undefined, fmt: (v: number) => string, x: number, y: number, W: number, col: string, paint: boolean): number {
  if (!paint) return 17;
  g.text(word, x, y + 12, INK3, 12);
  const sx = x + 74, sw = W - 74 - 86;
  const s = m?.spark ?? [];
  if (s.some((v) => v !== null)) spark(g, s, sx, y + 2, sw, 11, col);
  else g.hline(sx, sx + sw, y + 13.5, RULE, 1);
  const v = m?.h1 ?? m?.h24 ?? null;
  g.text(v === null ? '–' : fmt(v), x + W - 14, y + 12, v === null ? INK3 : INK2, 12, false, 'right');
  if (m && m.dir) {
    const up = m.dir > 0, ac = m.bad ? RED_T : GREEN_T, ax = x + W - 5, ay = y + 7;
    g.begin_(); if (up) { g.move(ax - 4, ay + 3); g.line(ax, ay - 3); g.line(ax + 4, ay + 3); } else { g.move(ax - 4, ay - 3); g.line(ax, ay + 3); g.line(ax + 4, ay - 3); }
    g.ctx.closePath(); g.fill(ac);
  }
  return 17;
}

/** The group's Trend as seven small multiples (contract v0.5 Metric sparks: 24 hourly values). */
export function trendRows(g: Gfx, t: Trend | null, x: number, y: number, W: number, paint: boolean, hue: string): number {
  if (!t) { if (paint) g.text('no trend yet (the server rolls up hourly)', x, y + 13, INK3, 12); return 18; }
  const pct = (v: number) => `${Math.round(v * 100)}%`, per = (v: number) => `${v < 10 ? v.toFixed(1) : Math.round(v)}/h`, n = (v: number) => String(Math.round(v));
  let h = 0;
  h += trendRow(g, 'runs', t.pipelines, per, x, y + h, W, hue, paint);
  h += trendRow(g, 'pass', t.pass_rate, pct, x, y + h, W, GREEN_T, paint);
  h += trendRow(g, 'red mains', t.red, n, x, y + h, W, RED, paint);
  h += trendRow(g, 'queue', t.intake_ms, durW, x, y + h, W, '#D8BA92', paint);
  h += trendRow(g, 'build', t.run_ms, durW, x, y + h, W, INK2, paint);
  h += trendRow(g, 'deploys', t.deploys, per, x, y + h, W, hue, paint);
  h += trendRow(g, 'PR age', t.pr_age_ms, durW, x, y + h, W, INK2, paint);
  return h;
}

export function durW(ms: number): string {
  if (!(ms > 0)) return '0s';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h}h` : `${Math.round(h / 24)}d`;
}

// ───────────────────────────── histories as marks ─────────────────────────────

/** 7 days of health changes (newest first, `{from, to, at}`) as coloured segments on a 7 d axis. */
export function healthSegs(hist: { from: string; to: string; at: number }[], nowState: string, now: number, since = 0): [number, number, string][] {
  const span = 7 * 24 * HOUR, t0 = now - span;
  const asc = [...hist].sort((a, b) => a.at - b.at).filter((x) => x.at > t0);
  const out: [number, number, string][] = [];
  // before the history begins (the server's ledger, or the app opening): unknown, gray
  let at = Math.max(t0, Math.min(now, since || t0));
  if (at > t0) out.push([0, (at - t0) / span, '#38383C']);
  let state = asc.length ? asc[0].from : nowState;
  for (const x of asc) { if (x.at <= at) { state = x.to; continue; } out.push([(at - t0) / span, (x.at - t0) / span, hcol(state)]); state = x.to; at = x.at; }
  out.push([(at - t0) / span, 1, hcol(state)]);
  return out;
}
function hcol(h: string | undefined): string { return h === 'down' ? '#E06464' : h === 'degraded' ? '#E5B567' : h === 'up' ? '#6FA27C' : '#6A6A6A'; }

/** An engine group's busy share over time: the server's 24 h (per 15 min) when it answered, else
 *  the half hour the floor sampled since it opened. */
export function busySeries(hosts: { series(id: string, k: 'busy'): number[] }, gr: { id: string; slots: number; engines: string[] } | undefined): (number | null)[] | null {
  if (!gr) return null;
  const e24 = gr.engines.map((id) => engineHist24(id)).find((x) => x);
  if (e24?.busy?.length) {
    const s: (number | null)[] = [];
    for (let i = 0; i < e24.busy.length; i += 15) {
      let sum = 0, k = 0;
      for (let j = i; j < Math.min(e24.busy.length, i + 15); j++) { const v = e24.busy[j], sl = e24.slots[j] ?? gr.slots; if (v !== null && sl) { sum += v / sl; k++; } }
      s.push(k ? (sum / k) * 100 : null);
    }
    return s;
  }
  const s = hosts.series(gr.id, 'busy');
  return s.length >= 2 ? s : null;
}

/** An engine group's utilisation for its lens: the server's 24 h (15 min buckets) when it answered,
 *  else the half hour the floor sampled since it opened. `full`: a bucket where every slot was busy
 *  (work queued behind a full machine). */
export type EngSeries = { busy: (number | null)[]; cpu: (number | null)[]; mem: (number | null)[]; load: (number | null)[]; full: boolean[]; span: string; repos: { repo: string; runs: number }[] };
export function engineSeries(hosts: { series(id: string, k: 'busy' | 'cpu' | 'mem' | 'load'): number[] }, gr: { id: string; slots: number; engines: string[] } | undefined): EngSeries | null {
  if (!gr) return null;
  // the machine's own engine (a Dagger host: busy, slots, cpu, mem, load) before its agents
  const hs = gr.engines.map((id) => engineHist24(id)).filter((x): x is EngineHist24 => !!x && !!x.busy?.length);
  const e24 = hs.find((x) => x.cpu?.some((v) => v !== null)) ?? hs[0];
  if (e24) {
    const out: EngSeries = { busy: [], cpu: [], mem: [], load: [], full: [], span: '24 h', repos: e24.repos ?? [] };
    const avg = (a: (number | null)[], i: number, f: (v: number, j: number) => number | null) => { let s = 0, k = 0; for (let j = i; j < Math.min(a.length, i + 15); j++) { const v = a[j]; if (v === null || v === undefined) continue; const x = f(v, j); if (x === null) continue; s += x; k++; } return k ? s / k : null; };
    for (let i = 0; i < e24.busy.length; i += 15) {
      out.busy.push(avg(e24.busy, i, (v, j) => { const sl = e24.slots[j] ?? gr.slots; return sl ? (v / sl) * 100 : null; }));
      out.cpu.push(avg(e24.cpu, i, (v) => v));
      out.mem.push(avg(e24.mem, i, (v) => v));
      out.load.push(avg(e24.load, i, (v) => v));
      let full = false;
      for (let j = i; j < Math.min(e24.busy.length, i + 15); j++) { const v = e24.busy[j], sl = e24.slots[j]; if (v !== null && sl && v >= sl) { full = true; break; } }
      out.full.push(full);
    }
    return out;
  }
  const b = hosts.series(gr.id, 'busy');
  if (b.length < 2) return null;
  const nn = (s: number[]) => s.map((v) => (Number.isFinite(v) ? v : null));
  return { busy: nn(b), cpu: nn(hosts.series(gr.id, 'cpu')), mem: nn(hosts.series(gr.id, 'mem')), load: nn(hosts.series(gr.id, 'load')), full: b.map((v) => v >= 99.5), span: 'since open', repos: [] };
}
