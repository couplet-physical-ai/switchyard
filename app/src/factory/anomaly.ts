// THE COFFEE CHECK's data (fab-w4; FACTORY-SPEC §E): what changed in the chosen window, and the
// anomaly marks the floor shows for it. Pure functions over plain data (a World, the v0.5 seam's
// clusters and trends, the server's /changes answer, the queue's state), so a test can build each
// input and check each output; coffee.ts runs them (sliced), fx.ts paints them, glance.ts reads.
//
//   window      since your last visit · 1 h · 24 h · 7 d (rolling). The glance's numbers, the
//               fresh set and the floor's marks all follow it.
//   fingerprint what a visit saw (≈ 1–3 KB in the persisted `visits`): the red main lines with
//               their culprit, the apps down, the open failure clusters, a few counts. A visit
//               counts after 20 s of looking (app.contract), so "new red", "fixed", "down",
//               "recovered" and "new cluster" are exact against it on any server.
//   marks       smoke   an OPEN failure cluster hot enough to matter (≥ 2 failures in the last hour
//                       or ≥ 3 repos) with failures inside the window: over the scanner, wisps
//                       over the docks of the repos it hits
//               beacon  acute: a main line red < 1 h, an app down < 1 h, the outage watcher.
//                       ≤ 3 pulse (severity × recency), the rest hold steady
//               cracks  chronic: a main line red > 24 h, an app down > 24 h
//               jam     the intake's wait trend is bad, the queue grows, every slot is busy
//               ember   a stage's or a group's v0.5 trend is `bad` (worse than its 7 d): a warm
//                       glow under it. The 1 h view reads the server's h1 verdict; the 24 h and
//                       7 d views compare h24 with d7 by the same rule
//   verdict     broken (an app down, the watcher, a main line turned red in the window and still
//               red) · jammed · slowed (a bad pass-rate / wait / run-time trend, or smoke) ·
//               flowing; `sev` 0..1 places the dial's needle inside its sector
//   hotspots    ≤ 3 callouts: the worst cluster, the worst group, the jam
//
// A healthy factory is quiet: an all-green world yields no marks at all (tools/coffee.test.ts).

import type { Changes, Cluster, Metric, Trend } from '../wire.ts';
import type { World } from '../world.ts';

export const HOUR = 3_600_000;
export const DAY = 24 * HOUR;

// ───────────────────────────── the window ─────────────────────────────

export type Win = 'visit' | '1h' | '24h' | '7d';
export const WINS: readonly Win[] = ['visit', '1h', '24h', '7d'];
const WIN_MS: Record<Win, number> = { visit: 0, '1h': HOUR, '24h': DAY, '7d': 7 * DAY };

/** Where the window starts at `now`: the last visit (24 h ago without one), else now − its span. */
export function windowStart(win: Win, now: number, visitAt: number): number {
  if (win === 'visit') return visitAt > 0 && visitAt < now ? visitAt : now - DAY;
  return now - WIN_MS[win];
}

/** The window's span in ms (the visit's: how long ago it was). */
export function windowSpan(win: Win, now: number, visitAt: number): number { return now - windowStart(win, now, visitAt); }

/** Whether the window reads the last hour's trend verdict (h1) or the day's (h24 vs d7). */
export function shortWindow(win: Win, now: number, visitAt: number): boolean { return windowSpan(win, now, visitAt) <= 3 * HOUR; }

/** "3h", "12m", "2d": how long ago. */
export function ago(ms: number): string {
  if (!(ms > 0)) return '0s';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h${m % 60 ? ` ${m % 60}m` : ''}`;
  return `${Math.floor(h / 24)}d`;
}

// ───────────────────────────── the fingerprint ─────────────────────────────

/** What a visit saw. Ids are kept as short hashes (h36), never names. */
export type Fingerprint = {
  at: number;
  /** red main lines → their culprit's short sha ('' unknown) */
  red: Map<string, string>;
  /** apps down or degraded */
  down: Set<string>;
  /** open failure clusters (their ids) */
  cl: Set<string>;
  /** counts then: red mains, apps not up, open PRs, open clusters */
  n: [number, number, number, number];
};

/** The stored form (one server's entry in the persisted `visits`). `r`/`d` keep the shape the
 *  phase-1 visits had, so an old visit still reads. */
export type VisitRec = { at: number; r: string; d: string; k?: string; n?: number[] };

/** A short stable hash (base 36) of an id. */
export function h36(s: string): string {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(36);
}

export const isRedMain = (state: string | undefined): boolean => state === 'failure' || state === 'error';

/** The world's fingerprint now: O(repos + apps + clusters). */
export function fingerprint(w: World, clusters: readonly Cluster[], at: number): Fingerprint {
  const red = new Map<string, string>(), down = new Set<string>(), cl = new Set<string>();
  for (const r of w.repos.values()) if (isRedMain(r.main?.state)) red.set(h36(r.id), (r.main?.culprit ?? '').slice(0, 7));
  for (const a of w.apps.values()) if (a.health === 'down' || a.health === 'degraded') down.add(h36(a.id ?? ''));
  for (const c of clusters) if (c.open > 0) cl.add(c.id);
  let prs = 0;
  for (const p of w.prs.values()) if (p.phase !== 'merged' && p.phase !== 'closed' && p.phase !== 'deployed') prs++;
  return { at, red, down, cl, n: [red.size, down.size, prs, cl.size] };
}

export function packVisit(fp: Fingerprint): VisitRec {
  const r: string[] = [];
  for (const [k, c] of fp.red) r.push(c ? `${k}:${c}` : k);
  return { at: Math.round(fp.at), r: r.join(','), d: [...fp.down].join(','), k: [...fp.cl].map((id) => id.replace(/^f:/, '')).join(','), n: [...fp.n] };
}

export function unpackVisit(v: VisitRec | undefined | null): Fingerprint | null {
  if (!v || !(v.at > 0)) return null;
  const red = new Map<string, string>();
  for (const x of (v.r ?? '').split(',')) { if (!x) continue; const i = x.indexOf(':'); if (i < 0) red.set(x, ''); else red.set(x.slice(0, i), x.slice(i + 1)); }
  const down = new Set((v.d ?? '').split(',').filter(Boolean));
  const cl = new Set((v.k ?? '').split(',').filter(Boolean).map((x) => `f:${x}`));
  const n = Array.isArray(v.n) ? v.n : [];
  return { at: v.at, red, down, cl, n: [n[0] ?? red.size, n[1] ?? down.size, n[2] ?? 0, n[3] ?? cl.size] };
}

// ───────────────────────────── the fresh set ─────────────────────────────

/** What changed in the window, by id (where to rim it on the floor) and by count (the glance).
 *  `at` holds when each thing happened (the catch-up replay plays them in order). */
export type Fresh = {
  newRed: string[]; fixed: string[]; acute: string[]; failed: string[]; down: string[]; recovered: string[];
  deployApps: string[]; deploys: number; deployFails: number; merged: string[]; newClusters: string[];
  /** counts from the server when they reach further than the world's lists (-1: the lists') */
  failCount: number; mergedCount: number;
  at: Map<string, number>;
};

export function emptyFresh(): Fresh {
  return { newRed: [], fixed: [], acute: [], failed: [], down: [], recovered: [], deployApps: [], deploys: 0, deployFails: 0, merged: [], newClusters: [], failCount: -1, mergedCount: -1, at: new Map() };
}

/** What changed in (since, now]: against the fingerprint when the window starts at it (exact on
 *  any server), else from the server's /changes for that window (`srv`, whose `since` must be
 *  the window's) blended with what the world holds. Three slices (yields), O(entities) in all. */
export function* freshSince(w: World, since: number, now: number, fp: Fingerprint | null, srv: Changes | null, clusters: readonly Cluster[]): Generator<void, Fresh, void> {
  const d = emptyFresh(), at = d.at;
  const base = fp && Math.abs(fp.at - since) < 1000 ? fp : null;
  for (const r of w.repos.values()) {
    const red = isRedMain(r.main?.state), rs = r.main?.since ?? 0;
    if (red && rs >= now - HOUR && rs <= now) d.acute.push(r.id);
    if (base) {
      const k = h36(r.id), was = base.red.get(k);
      if (red && (was === undefined || (was && r.main?.culprit && !r.main.culprit.startsWith(was)))) { d.newRed.push(r.id); at.set(`red:${r.id}`, rs > since ? rs : since); }
      else if (!red && was !== undefined) { d.fixed.push(r.id); at.set(`fix:${r.id}`, fixedAt(r.main?.recent, since, now)); }
    } else if (!srv) {
      if (red) { if (rs > since && rs <= now) { d.newRed.push(r.id); at.set(`red:${r.id}`, rs); } }
      else for (const dot of r.main?.recent ?? []) if (dot.at > since && dot.at <= now && isRedMain(dot.state)) { d.fixed.push(r.id); at.set(`fix:${r.id}`, fixedAt(r.main?.recent, since, now)); break; }
    }
  }
  if (!base && srv) {
    for (const x of srv.red) if (isRedMain(w.repos.get(x.repo)?.main?.state) && !at.has(`red:${x.repo}`)) { d.newRed.push(x.repo); at.set(`red:${x.repo}`, x.at); }
    for (const x of srv.recovered) if (!isRedMain(w.repos.get(x.repo)?.main?.state) && !at.has(`fix:${x.repo}`)) { d.fixed.push(x.repo); at.set(`fix:${x.repo}`, x.at); }
  }
  for (const p of w.pipelines.values()) {
    if ((p.state !== 'failure' && p.state !== 'error') || !p.finished || p.finished <= since || p.finished > now) continue;
    const id = p.id ?? '';
    d.failed.push(id); at.set(`fail:${id}`, p.finished);
  }
  yield;
  const apps = new Set<string>();
  for (const dp of w.deploys.values()) {
    if (dp.started <= since || dp.started > now) continue;
    d.deploys++;
    if (dp.state === 'failure') d.deployFails++;
    if (!apps.has(dp.app)) { apps.add(dp.app); at.set(`dep:${dp.app}`, dp.finished ?? dp.started); }
  }
  if (srv) for (const x of srv.deploys) if (!apps.has(x.app) && x.at > since) { apps.add(x.app); at.set(`dep:${x.app}`, x.at); }
  d.deployApps = [...apps];
  for (const p of w.prs.values()) if (p.merged_at && p.merged_at > since && p.merged_at <= now) { const k = `${p.repo}@${p.merge_sha ?? ''}`; d.merged.push(k); at.set(`mrg:${k}`, p.merged_at); }
  yield;
  const last = new Map<string, { to: string; at: number }>();
  for (const h of w.health) if (h.at > since && h.at <= now) last.set(h.app, h);
  if (srv) for (const x of srv.apps) { const l = last.get(x.app); if (!l || l.at < x.at) last.set(x.app, x); }
  for (const a of w.apps.values()) {
    const id = a.id ?? '';
    const bad = a.health === 'down' || a.health === 'degraded';
    const l = last.get(id);
    if (base) {
      const was = base.down.has(h36(id));
      if (bad && !was) { d.down.push(id); at.set(`app:${id}`, l?.at ?? since); }
      else if (!bad && was && a.health === 'up') { d.recovered.push(id); at.set(`app:${id}`, l?.at ?? since); }
    } else if (l) {
      if (bad && l.to !== 'up') { d.down.push(id); at.set(`app:${id}`, l.at); }
      else if (a.health === 'up' && l.to === 'up') { d.recovered.push(id); at.set(`app:${id}`, l.at); }
    }
  }
  // clusters that opened in the window: not open at the visit, or new by the server's count
  const isNew = new Set<string>();
  if (base) { for (const c of clusters) if (c.open > 0 && !base.cl.has(c.id) && c.last_seen > since) isNew.add(c.id); }
  else if (srv) { for (const c of srv.clusters) if (c.new) isNew.add(c.id); }
  else for (const c of clusters) if (c.open > 0 && c.first_seen > since) isNew.add(c.id);
  d.newClusters = [...isNew];
  if (srv) {
    d.failCount = Math.max(d.failed.length, srv.counts.failed);
    d.deploys = Math.max(d.deploys, srv.counts.deploys);
    d.deployFails = Math.max(d.deployFails, srv.counts.deploys_failed);
    d.mergedCount = Math.max(d.merged.length, srv.counts.prs_merged);
  }
  return d;
}

/** When a main line that was red turned green (its first green dot after its last red one). */
function fixedAt(recent: readonly { at: number; state: string }[] | undefined, since: number, now: number): number {
  let red = -1;
  const r = recent ?? [];
  for (let i = 0; i < r.length; i++) if (isRedMain(r[i].state)) red = i;
  for (let i = red + 1; i < r.length; i++) if (r[i].state === 'success' && r[i].at > since && r[i].at <= now) return r[i].at;
  return since;
}

// ───────────────────────────── the marks ─────────────────────────────

export type Verdict = 'flowing' | 'slowed' | 'jammed' | 'broken';
export const VERDICTS: readonly Verdict[] = ['flowing', 'slowed', 'jammed', 'broken'];

export type Smoke = { id: string; step: string; repos: readonly string[]; repoN: number; n1h: number; k: number; at: number };
export type Beacon = { kind: 'red' | 'down' | 'watcher'; id: string; at: number; sev: number };
export type Crack = { kind: 'red' | 'down'; id: string; since: number };
/** A stage of the floor (its fleet metric) or a group (any of its metrics). */
export type Stage = 'prs' | 'mains' | 'intake' | 'engines' | 'tests' | 'deploy';
export type Ember = { kind: 'stage' | 'group'; id: string; metrics: string[]; k: number };
export type Jam = { waiting: number; oldest: number; k: number };
export type Hotspot = { kind: 'cluster' | 'group' | 'jam'; id: string; lead: string; rest: string; red: boolean };
export type Marks = {
  smoke: Smoke[]; beacons: Beacon[]; cracks: Crack[]; jam: Jam | null; embers: Ember[];
  verdict: Verdict; why: string; sev: number; hot: Hotspot[];
};

export function noMarks(): Marks {
  return { smoke: [], beacons: [], cracks: [], jam: null, embers: [], verdict: 'flowing', why: '', sev: 0.04, hot: [] };
}

/** The queue as the floor counts it (census.ts) plus its growth over the last 5 minutes. */
export type QueueState = { waiting: number; oldestWait: number; slots: number; busy: number; growing: boolean; p50: number };

export type MarkInput = {
  w: World; now: number; since: number; short: boolean;
  clusters: readonly Cluster[];
  trend: (id: string) => Trend | null;
  srv: Changes | null;
  fresh: Fresh;
  queue: QueueState;
  /** when an app went down (ms), or 0 when unknown */
  downSince: (app: string) => number;
  /** the groups (the seam's: v0.5 tables, approximated on v0.4), with their red main lines now */
  groups: readonly { id: string; red: number }[];
  /** group id → its display word (`labs`, `software`) */
  groupWord: (id: string) => string;
};

/** The metrics where up is worse (pass rate is the other way); `pipelines` and `deploys` have no
 *  "worse" direction. Each → the floor stage it ember-glows. */
const STAGE_OF: Record<string, Stage> = { pass_rate: 'tests', intake_ms: 'intake', run_ms: 'engines', pr_age_ms: 'prs', red: 'mains' };
const METRICS = ['pass_rate', 'intake_ms', 'run_ms', 'pr_age_ms', 'red'] as const;
type MetricKey = (typeof METRICS)[number];

/** Whether a metric reads worse than usual in this window: the server's own verdict (h1 against
 *  d7) for a short window, else h24 against d7 by the server's rule (a move both relative, 15 %,
 *  and absolute: pass rate 5 points, red 1 main line, waits and runs 5 s, PR age 1 h), once
 *  there are more than 25 hours of history behind d7 (`hours`). */
export function metricBad(key: MetricKey, m: Metric | undefined | null, short: boolean, hours = 168): boolean {
  if (!m) return false;
  if (short) return !!m.bad;
  const a = m.h24 ?? null, b = m.d7 ?? null;
  if (a === null || b === null || hours <= 25) return false;
  const d = a - b;
  if (key === 'pass_rate') return d < -0.05;
  if (key === 'red') return d >= Math.max(1, 0.15 * b);
  if (key === 'pr_age_ms') return d > Math.max(0.15 * b, HOUR);
  return d > Math.max(0.15 * b, 5000);
}

/** The marks for this window. O(repos + apps + clusters + groups); no allocation per repo. */
export function marks(inp: MarkInput): Marks {
  const { w, now, since, short, fresh } = inp;
  const out = noMarks();
  // smoke: open clusters, hot enough, failing inside the window
  const inWin = new Set<string>();
  if (inp.srv) for (const c of inp.srv.clusters) if (c.count > 0) inWin.add(c.id);
  for (const c of inp.clusters) {
    if (c.open <= 0 || !(c.count_1h >= 2 || c.repo_count >= 3)) continue;
    if (!(c.last_seen > since || inWin.has(c.id))) continue;
    out.smoke.push({ id: c.id, step: c.step, repos: c.repos, repoN: c.repo_count, n1h: c.count_1h, k: clamp01(0.45 + c.repo_count / 10 + c.count_1h / 20), at: Math.max(since, c.last_seen) });
  }
  out.smoke.sort((a, b) => b.repoN - a.repoN || b.n1h - a.n1h || (a.id < b.id ? -1 : 1));
  if (out.smoke.length > 3) out.smoke.length = 3;
  // beacons (acute) and cracks (chronic): main lines, apps; the outage watcher
  for (const r of w.repos.values()) {
    if (!isRedMain(r.main?.state)) continue;
    const s = r.main?.since ?? 0;
    if (s > 0 && s >= now - HOUR && s <= now) out.beacons.push({ kind: 'red', id: r.id, at: s, sev: 0.6 + 0.4 * (1 - (now - s) / HOUR) + (s > since ? 0.3 : 0) });
    else if (s > 0 && s < now - DAY) out.cracks.push({ kind: 'red', id: r.id, since: s });
  }
  let down = 0;
  for (const a of w.apps.values()) {
    if (a.health !== 'down') continue;
    down++;
    const id = a.id ?? '', s = inp.downSince(id);
    if (s > 0 && s >= now - HOUR) out.beacons.push({ kind: 'down', id, at: s, sev: 1.2 + 0.4 * (1 - (now - s) / HOUR) });
    else if (s > 0 && s < now - DAY) out.cracks.push({ kind: 'down', id, since: s });
  }
  if (w.watcher?.tripped) out.beacons.push({ kind: 'watcher', id: 'outage', at: w.watcher.since ?? now, sev: 1.5 });
  out.beacons.sort((a, b) => b.sev - a.sev || b.at - a.at);
  out.cracks.sort((a, b) => a.since - b.since);
  // the jam: the wait trend is bad (or, with no trend, the oldest waits over 2× its p50), the
  // queue grows, every slot is busy
  const q = inp.queue, fleet = inp.trend('fleet');
  const waitBad = fleet ? metricBad('intake_ms', fleet.intake_ms, true) : q.oldestWait > 2 * q.p50;
  if (q.waiting > 0 && q.slots > 0 && q.busy >= q.slots && q.growing && waitBad) out.jam = { waiting: q.waiting, oldest: q.oldestWait, k: clamp01(0.5 + q.waiting / 12) };
  // embers: the stages (the fleet's metrics), then the groups
  const stageBad: string[] = [];
  if (fleet) for (const key of METRICS) if (metricBad(key, fleet[key], short, fleet.hours_7d)) { stageBad.push(key); out.embers.push({ kind: 'stage', id: STAGE_OF[key], metrics: [key], k: emberK(key, fleet[key], short) }); }
  for (const { id: g } of inp.groups) {
    const t = inp.trend(g);
    if (!t) continue;
    const bad: string[] = [];
    let k = 0;
    for (const key of METRICS) if (metricBad(key, t[key], short, t.hours_7d)) { bad.push(key); k = Math.max(k, emberK(key, t[key], short)); }
    if (bad.length) out.embers.push({ kind: 'group', id: g, metrics: bad, k: clamp01(k + 0.15 * (bad.length - 1)) });
  }
  // the verdict
  const smokeN = out.smoke.length;
  const passBad = stageBad.includes('pass_rate'), waitSlow = stageBad.includes('intake_ms'), runSlow = stageBad.includes('run_ms');
  const pass = fleet?.pass_rate[short ? 'h1' : 'h24'] ?? null, passTyp = fleet?.pass_rate.d7 ?? fleet?.pass_rate.h24 ?? null;
  if (down || w.watcher?.tripped || fresh.newRed.length) {
    out.verdict = 'broken';
    const why: string[] = [];
    if (fresh.newRed.length) why.push(`${fresh.newRed.length} newly red`);
    if (down) why.push(`${down} ${down === 1 ? 'app' : 'apps'} down`);
    if (w.watcher?.tripped) why.push('outage watcher');
    out.why = why.join(' · ');
    out.sev = 0.76 + 0.24 * clamp01((fresh.newRed.length + 3 * down + (w.watcher?.tripped ? 4 : 0)) / 12);
  } else if (out.jam) {
    out.verdict = 'jammed';
    out.why = `${q.waiting} waiting · every slot busy`;
    out.sev = 0.51 + 0.22 * out.jam.k;
  } else if (passBad || waitSlow || runSlow || smokeN) {
    out.verdict = 'slowed';
    const why: string[] = [];
    if (passBad && pass !== null) why.push(`pass ${Math.round(pass * 100)}%${passTyp !== null ? ` (typ ${Math.round(passTyp * 100)}%)` : ''}`);
    if (waitSlow) why.push('waits longer');
    if (runSlow) why.push('builds slower');
    if (smokeN && !why.length) why.push(`${out.smoke[0].step} failing${out.smoke[0].repoN > 1 ? ` in ${out.smoke[0].repoN} repos` : ''}`);
    out.why = why.join(' · ');
    out.sev = 0.27 + 0.21 * clamp01(((passBad ? 1 : 0) + (waitSlow ? 1 : 0) + (runSlow ? 1 : 0) + smokeN * 0.5) / 3);
  } else {
    out.sev = 0.04 + 0.16 * clamp01(fresh.failed.length / 20);
  }
  // hotspots: the worst cluster, the worst group, the jam
  const s0 = out.smoke[0];
  if (s0) out.hot.push({ kind: 'cluster', id: s0.id, lead: s0.step, rest: s0.repoN > 1 ? ` · ${s0.repoN} repos` : ` · ${s0.n1h} failed in 1 h`, red: true });
  const g0 = worstGroup(inp);
  if (g0) out.hot.push(g0);
  if (out.jam) out.hot.push({ kind: 'jam', id: 'intake', lead: 'jam', rest: ` · ${out.jam.waiting} waiting`, red: false });
  return out;
}

/** The group where most went wrong in the window: the server's ranking (failures and new reds
 *  there), else the world's groups by red main lines. Null when nothing is red or failing. */
function worstGroup(inp: MarkInput): Hotspot | null {
  if (inp.srv?.groups.length) {
    const g = inp.srv.groups.find((x) => x.red > 0 || x.failed > 0);
    if (g) {
      const red = inp.groups.find((x) => x.id === g.id)?.red ?? g.red;
      return { kind: 'group', id: g.id, lead: inp.groupWord(g.id), rest: red ? ` · ${red} red` : ` · ${g.failed} failed`, red: red > 0 };
    }
  }
  let best: { id: string; red: number } | null = null;
  for (const g of inp.groups) if (g.red > 0 && (!best || g.red > best.red)) best = { id: g.id, red: g.red };
  return best ? { kind: 'group', id: best.id, lead: inp.groupWord(best.id), rest: ` · ${best.red} red`, red: true } : null;
}

/** How far a bad metric is from its typical (0.3..1): the ember's warmth. */
function emberK(key: MetricKey, m: Metric, short: boolean): number {
  const a = (short ? m.h1 : m.h24) ?? m.h24 ?? null, b = m.d7 ?? m.h24 ?? null;
  if (a === null || b === null) return 0.5;
  if (key === 'pass_rate') return clamp01(0.3 + (b - a) * 4);
  return clamp01(0.3 + (b > 0 ? (a - b) / b : 1) * 0.7);
}

function clamp01(x: number): number { return x < 0 ? 0 : x > 1 ? 1 : x; }
