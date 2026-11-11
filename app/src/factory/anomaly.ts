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
//                       or ≥ 3 repos): over the scanner, wisps over the docks of the repos it
//                       hits; with failures inside the window it burns (a red base, denser)
//               beacon  acute: a main line red < 1 h, an app down < 1 h, the outage watcher.
//                       ≤ 3 pulse (severity × recency), the rest hold steady
//               cracks  chronic: a main line red > 24 h, an app down > 24 h
//               jam     the intake's wait trend is bad, the queue grows, every slot is busy
//               ember   a stage's or a group's v0.5 trend is `bad` (worse than its 7 d): a warm
//                       glow under it. The 1 h view reads the server's h1 verdict; the 24 h and
//                       7 d views compare h24 with d7 by the same rule, and (w2-glance2) only
//                       while the last hour does not disagree (an h1 on the better side of d7 is
//                       what the wall's arrow shows: an ember never contradicts it)
//   verdict     (w2-glance2, REVIEW-iter3 #1) NOW against USUAL, never the window's news (the
//               chips carry that):
//                 broken   an app down now, the outage watcher, or a main line that turned red
//                          in the last 60 min and is still red;
//                 worse    ("worse than usual") the red main lines over their 7-d same-hour p90,
//                          the last hour's failures over theirs, the pass rate 5 points under
//                          its 7 d (or the server's `bad`), or a jam;
//                 steady   none of that, but not all calm;
//                 flowing  red at or under its typical, the pass rate at or over its 7 d.
//               `fact` is the one fact that decided it ("pass 69% (usual 76%)", "40 red (usual
//               36)", "net-control-plane red 12m"); `pct` is the needle: where now sits in the
//               7-d distribution (the worst of red, failures/h and the fail share; -1 none)
//               (v4-verdict, REVIEW-iter3b #1) CONCENTRATION: when ≥ 60 % of the last hour's
//               failures are one repo (or one repo's crons; clusters.ts `concentration`) and the
//               failures decided "worse", the fact names it, not the rate: "8 of 8 fails
//               legal-tracker crons"; and when the fleet WITHOUT it passes at or over its usual,
//               the verdict is "steady · but legal-tracker crons 0 / 8" (`factRed`: the repo's
//               words in red). The rate stays in the needle's hover (`why`).
//               A main line red < 1 h that FLAPS (it failed on its default branch earlier in
//               the 24 h before this red began: a cron failing all day) is not a break: it
//               gets its beacon, but not "broken" nor "broke main".
//               (#7) A replay runs the same verdict over the replayed hour (`moment`): its
//               pass rate and failures counted from the replayed world's runs, against the
//               same 7-d usual (the same-hour p90 of the replayed hour)
//   usual       (fx-glance) the last hour's failures, the red main lines and the pass rate now
//               against the 7-d same-hour p90 (agg/baseline.ts; the trend's typical × 1.25 while
//               the ring holds too little): `worse` than usual, `usual`, or '' with no basis;
//               and the window's failures against the typical for a window that long
//   hotspots    (w2-glance2, #4 #6) the callouts' candidates, each a name and ONE state fact, in
//               slot order: a main line red < 1 h ("x broke main · 12m"), an app down ("· down
//               3h"), an open cluster by the main lines it holds red ("security-scan · 7 mains
//               red · 13h"), the worst group by red SHARE ("couplet · 10 of 17 red ▲"), the
//               jam, then a flaky cluster ("esign-sync · flaky · 68 / 24h", gray-red), never
//               first (the floor draws ≤ 3, glance.ts)
//   totals      (fx-glance) red main lines, building, queued, apps down: ONE count, which the
//               status line (app.ts overview) and the coffee header both show; stress mode's
//               are the 10× fleet's own (every count × FACTOR, the city's hashed copies' health)
//
// A healthy factory is quiet: an all-green world yields no marks at all (tools/coffee.test.ts).

import type { Changes, Cluster, Metric, Trend } from '../wire.ts';
import type { World } from '../world.ts';
import { buildingIds, queueTruth } from '../yard/select.ts';
import { failuresOf, threshold, typical } from './trendmarks.ts';
// p3 (#5): one flaky test for the callout and the belt; v4 (REVIEW-iter3b #1): one concentration
// for the verdict, the chute and the belt (v4-heaps')
import { concentration, flakyCalled, type Concentration } from './clusters.ts';
import { baseline } from './agg/baseline.ts';

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

/** w2-glance2: an age in one unit, for a callout ("12m", "13h", "3d"; "now" under a minute). */
export function age(ms: number): string {
  if (!(ms >= 60_000)) return 'now';
  const m = Math.floor(ms / 60_000);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60); // 13.97 h reads 14h, as the server's 14.0 does
  return h < 48 ? `${h}h` : `${Math.round(h / 24)}d`;
}

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

export type Verdict = 'flowing' | 'steady' | 'worse' | 'broken';
export const VERDICTS: readonly Verdict[] = ['flowing', 'steady', 'worse', 'broken'];
/** The verdict as the header says it. */
export const VERDICT_WORD: Record<Verdict, string> = { flowing: 'flowing', steady: 'steady', worse: 'worse than usual', broken: 'broken' };
/** What decided the verdict (the verdict lens opens on it). */
export type FactKey = '' | 'watcher' | 'down' | 'acute' | 'pass' | 'red' | 'fails' | 'jam' | 'conc';

export type Smoke = { id: string; step: string; repos: readonly string[]; repoN: number; n1h: number; fresh: boolean; k: number; at: number };
export type Beacon = { kind: 'red' | 'down' | 'watcher'; id: string; at: number; sev: number };
export type Crack = { kind: 'red' | 'down'; id: string; since: number };
/** A stage of the floor (its fleet metric) or a group (any of its metrics). */
export type Stage = 'prs' | 'mains' | 'intake' | 'engines' | 'tests' | 'deploy';
export type Ember = { kind: 'stage' | 'group'; id: string; metrics: string[]; k: number };
export type Jam = { waiting: number; oldest: number; k: number };
/** A callout's candidate (w2-glance2): a name (`lead`) and one state fact (`rest`); `tone` its
 *  colour (red: broken now; flaky: gray-red, a flake is not an incident; amber: the jam; ink),
 *  `tri` a drawn ▲ after the words (the group's red trend rising). */
export type Hotspot = { kind: 'red' | 'conc' | 'cluster' | 'flaky' | 'group' | 'jam' | 'down'; id: string; lead: string; rest: string; red: boolean; tone?: 'red' | 'flaky' | 'amber' | 'ink'; tri?: 0 | 1 };
/** Against the usual (fx-glance; w2-glance2: + the pass rate, the typicals, the percentile):
 *  `rel` worse / usual ('' no basis); the last hour's failures and the red main lines now with
 *  their thresholds (the 7-d same-hour p90) and typicals (7 d); the pass rate now (h1) and its
 *  7 d; the window's failures typical for its length (null: no basis) and its threshold; `pct`
 *  where now sits in the 7-d distribution (0..1, the worst of red, failures/h and the fail share;
 *  -1 none) and which one that was. */
export type Usual = {
  rel: '' | 'worse' | 'usual'; fails1h: number | null; failsThr: number | null; failsTyp: number | null;
  red: number; redThr: number | null; redTyp: number | null;
  pass: number | null; passTyp: number | null; passBad: boolean;
  winUsual: number | null; winThr: number | null;
  pct: number; pctOf: '' | 'red' | 'fails' | 'pass';
};
export type Marks = {
  smoke: Smoke[]; beacons: Beacon[]; cracks: Crack[]; jam: Jam | null; embers: Ember[];
  verdict: Verdict; why: string; sev: number; hot: Hotspot[]; usual: Usual;
  /** w2-glance2: the one fact that decided the verdict ('' none), and which */
  fact: string; factKey: FactKey;
  /** v4-verdict (#1): the fact's words after `factLead` are the concentrated repo's, in red
   *  ("but " + "legal-tracker crons 0 / 8"); '' none */
  factLead: string; factRed: string;
  /** v4-verdict (#1): the last hour's failure concentration (null: none, spread out) */
  conc: Concentration | null;
};

export function noUsual(): Usual {
  return { rel: '', fails1h: null, failsThr: null, failsTyp: null, red: 0, redThr: null, redTyp: null, pass: null, passTyp: null, passBad: false, winUsual: null, winThr: null, pct: -1, pctOf: '' };
}

export function noMarks(): Marks {
  return { smoke: [], beacons: [], cracks: [], jam: null, embers: [], verdict: 'flowing', why: '', sev: 0.04, hot: [], usual: noUsual(), fact: '', factKey: '', factLead: '', factRed: '', conc: null };
}

/** How the fleet reads against its usual at `now` (pure; fx-glance): worse when the last hour's
 *  failures are over their same-hour 7-d p90 or the red main lines are over theirs; usual when
 *  either has a basis and neither is over; '' when neither has one. `hours`: the window's length
 *  (its failures' typical = the 7-d hourly typical × hours). */
export function usualOf(fleet: Trend | null, red: number, now: number, hours: number, moment: Moment | null = null): Usual {
  const u = noUsual();
  u.red = red;
  if (!fleet) return u;
  const fm = failuresOf(fleet);
  // v4-verdict (#7): a replayed hour's own failures and pass rate (the replayed world's runs), the
  // trend's 7 d as the usual; the server's `bad` was said of its own hour, not this one (too few
  // runs held: the trend recorded then, CONTRACT "Past states")
  const mo = moment && moment.runs >= MOMENT_MIN ? moment : null;
  u.fails1h = mo ? mo.fails : fm.h1;
  // the 7-d same-hour p90 (or typical × 1.25); a server holding a day but no week yet: the day's
  // hourly p90; one holding less (a v0.4 server: hours_7d 0, sparks of the 2 h the world holds)
  // has no usual at all, and says so by saying nothing
  const day = fleet.hours_7d >= 24;
  u.failsThr = threshold(fm, 'fleet', 'failures', now) ?? (day ? sparkP90(fm.spark) : null);
  u.redThr = threshold(fleet.red, 'fleet', 'red', now) ?? (day ? sparkP90(fleet.red.spark) : null);
  const typ = typical(fm, 'fleet', 'failures') ?? (day ? sparkMean(fm.spark) : null);
  u.failsTyp = typ;
  u.redTyp = typical(fleet.red, 'fleet', 'red') ?? (day ? sparkMean(fleet.red.spark) : null);
  // w2-glance2: the pass rate, the one fleet metric the server flags `bad` (#1): the last hour
  // against its 7 d, worse 5 points under it (or the server's own `bad`)
  const pr = fleet.pass_rate;
  u.pass = mo ? 1 - mo.fails / mo.runs : pr.h1 ?? null;
  u.passTyp = pr.d7 ?? (day ? sparkMean(pr.spark) : null);
  u.passBad = u.pass !== null && u.passTyp !== null && (u.pass <= u.passTyp - 0.05 || (!mo && !!pr.bad && u.pass < u.passTyp));
  if (typ !== null && hours > 0) { u.winUsual = Math.round(typ * hours); u.winThr = u.failsThr !== null ? Math.round(u.failsThr * hours) : Math.round(typ * 1.25 * hours); }
  const fWorse = u.fails1h !== null && u.failsThr !== null && u.fails1h > u.failsThr;
  const rWorse = u.redThr !== null && red > u.redThr;
  if (fWorse || rWorse || u.passBad) u.rel = 'worse';
  else if ((u.fails1h !== null && u.failsThr !== null) || u.redThr !== null || u.passTyp !== null) u.rel = 'usual';
  // the needle: where now sits among the 7 d's hours (the persisted ring, else the 24 h spark),
  // the worst of the three (the fail share for the pass rate: high is bad for all three)
  const dist = (metric: 'red' | 'failures' | 'pass_rate', spark: readonly (number | null)[]): number[] => {
    const xs = ringValues(metric, now);
    if (xs.length >= 12) return xs;
    const out: number[] = [];
    for (const v of spark) if (v !== null && v !== undefined && Number.isFinite(v)) out.push(v);
    return out;
  };
  const cand: [number, 'red' | 'fails' | 'pass'][] = [];
  if (day) {
    cand.push([midRank(dist('red', fleet.red.spark), red), 'red']);
    if (u.fails1h !== null) cand.push([midRank(dist('failures', fm.spark), u.fails1h), 'fails']);
    if (u.pass !== null) cand.push([midRank(dist('pass_rate', pr.spark).map((v) => 1 - v), 1 - u.pass), 'pass']);
  }
  for (const [p, k] of cand) if (p >= 0 && p > u.pct) { u.pct = p; u.pctOf = k; }
  return u;
}

/** v4-verdict (#7): a replayed hour, counted from the replayed world: its finished runs and their
 *  failures. Under MOMENT_MIN runs it says nothing (no pass rate from three runs). */
export type Moment = { runs: number; fails: number };
export const MOMENT_MIN = 5;

/** The runs that finished in (now − 1 h, now] and how many failed (a run's time: finished, else
 *  started, else created; the same window `concentration` counts). O(pipelines). */
export function momentOf(w: World, now: number): Moment {
  let runs = 0, fails = 0;
  for (const p of w.pipelines.values()) {
    const s = p.state;
    if (s !== 'success' && s !== 'failure' && s !== 'error') continue;
    const at = p.finished ?? p.started ?? p.created;
    if (!(at > now - HOUR && at <= now)) continue;
    runs++;
    if (s !== 'success') fails++;
  }
  return { runs, fails };
}

/** v4-verdict (#1): whether a main line red since `since` FLAPS: it failed on its default branch
 *  (a red dot, or a failed run on it the world holds) in the 24 h before this red began, more
 *  than a minute before it. A cron failing all day turns its main red again and again; that is
 *  not a break. `failedOn` (repo → its default-branch failures' times) is built once per pass. */
export function flapping(recent: readonly { at: number; state: string }[] | undefined, since: number, failedOn: readonly number[] | undefined): boolean {
  const lo = since - DAY, hi = since - 60_000;
  for (const d of recent ?? []) if (isRedMain(d.state) && d.at >= lo && d.at < hi) return true;
  for (const at of failedOn ?? []) if (at >= lo && at < hi) return true;
  return false;
}

/** The persisted ring's fleet hours for a metric (the needle's week), read once a minute (672
 *  map reads a digest otherwise; the slot that moves is the current hour's). */
const ringCache = { at: -1, xs: new Map<string, number[]>() };
function ringValues(metric: 'red' | 'failures' | 'pass_rate', now: number): number[] {
  const at = Math.floor(now / 60_000);
  if (ringCache.at !== at) { ringCache.at = at; ringCache.xs.clear(); }
  let xs = ringCache.xs.get(metric);
  if (!xs) { xs = baseline().values('fleet', metric); ringCache.xs.set(metric, xs); }
  return xs;
}

/** Where `v` sits among `xs` (0..1, ties counted half: a flat week puts now in the middle);
 *  -1 with fewer than 6 values. */
export function midRank(xs: readonly number[], v: number): number {
  if (xs.length < 6 || !Number.isFinite(v)) return -1;
  let lo = 0, eq = 0;
  for (const x of xs) { if (x < v - 1e-9) lo++; else if (Math.abs(x - v) <= 1e-9) eq++; }
  return (lo + 0.5 * eq) / xs.length;
}

/** The 90th percentile of a 24 h spark's hours (≥ 6 of them, the current one left out: it is
 *  the value compared), else null. */
function sparkP90(sp: readonly (number | null)[]): number | null {
  const xs: number[] = [];
  for (let i = 0; i < sp.length - 1; i++) { const v = sp[i]; if (v !== null && v !== undefined && Number.isFinite(v)) xs.push(v); }
  if (xs.length < 6) return null;
  xs.sort((a, b) => a - b);
  return xs[Math.min(xs.length - 1, Math.round(0.9 * (xs.length - 1)))];
}
function sparkMean(sp: readonly (number | null)[]): number | null {
  let n = 0, s = 0;
  for (let i = 0; i < sp.length - 1; i++) { const v = sp[i]; if (v !== null && v !== undefined && Number.isFinite(v)) { n++; s += v; } }
  return n >= 6 ? s / n : null;
}

// ───────────────────────────── the totals ─────────────────────────────

/** What the status line and the coffee header say about the fleet now (fx-glance): one count. */
export type Totals = { repos: number; red: number; building: number; queued: number; down: number; up: number; apps: number; factor: number };

export function noTotals(): Totals { return { repos: 0, red: 0, building: 0, queued: 0, down: 0, up: 0, apps: 0, factor: 1 }; }

/** The fleet's totals now: O(repos + pipelines + apps), the same truths the yard and the floor
 *  count with (select.ts: building, the queue). Stress mode (`factor` > 1) is the 10× fleet the
 *  floor draws: every count × factor, the apps the city's hashed copies (`copies`: their up and
 *  down counts and how many) beside the real ones. */
export function totals(w: World, factor = 1, copies: { up: number; down: number; n: number } | null = null): Totals {
  const t = noTotals();
  if (!w.loaded) return t;
  for (const r of w.repos.values()) if (isRedMain(r.main?.state)) t.red++;
  for (const a of w.apps.values()) { if (a.health === 'up') t.up++; else if (a.health === 'down') t.down++; }
  t.repos = w.repos.size; t.apps = w.apps.size;
  t.building = buildingIds(w).size;
  t.queued = queueTruth(w).waiting;
  if (factor > 1) {
    t.factor = factor;
    t.repos *= factor; t.red *= factor; t.building *= factor; t.queued *= factor;
    if (copies && copies.n > 0) { t.apps += copies.n; t.up += copies.up; t.down += copies.down; }
    else { t.apps *= factor; t.up *= factor; t.down *= factor; }
  }
  return t;
}

/** The header's totals in words (the status line's numbers, the same order every time). */
export function totalsWords(t: Totals): string { return `${t.red} red · ${t.building} building · ${t.queued} queued · ${t.down} down`; }

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
  /** the groups (the seam's: v0.5 tables, approximated on v0.4), with their red main lines now
   *  (and how many repos they hold: the red SHARE ranks them) */
  groups: readonly { id: string; red: number; repos?: number }[];
  /** group id → its display word (`labs`, `software`) */
  groupWord: (id: string) => string;
  /** a repo's group id ('' unknown): a group's main lines red in the last hour rank it */
  groupOf?: (repo: string) => string;
  /** v4-verdict (#7): `now` is a replayed moment: the verdict reads the replayed hour's runs */
  replay?: boolean;
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
  let bad: boolean;
  if (key === 'pass_rate') bad = d < -0.05;
  else if (key === 'red') bad = d >= Math.max(1, 0.15 * b);
  else if (key === 'pr_age_ms') bad = d > Math.max(0.15 * b, HOUR);
  else bad = d > Math.max(0.15 * b, 5000);
  // w2-glance2 (#10): the last hour must not disagree. An h1 on the better side of d7 (the wall's
  // arrow shows it) wins over the day's: the engine glowing "slower" (24 h 45 s vs 39 s) under a
  // green ▼ (the last hour 21 s) was two trend marks contradicting each other
  const h1 = m.h1 ?? null;
  if (bad && h1 !== null && (key === 'pass_rate' ? h1 >= b : h1 <= b)) return false;
  return bad;
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
    // still burning: it smokes whatever the window; failing inside the window it burns (a red
    // base, denser) and rises in the replay when its last failure does
    const fresh = c.last_seen > since || inWin.has(c.id);
    out.smoke.push({ id: c.id, step: c.step, repos: c.repos, repoN: c.repo_count, n1h: c.count_1h, fresh, k: clamp01(0.4 + c.repo_count / 10 + c.count_1h / 20 + (fresh ? 0.15 : 0)), at: fresh ? Math.max(since, c.last_seen) : since });
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
  let down = 0, downApp = '', downAt = -1;
  for (const a of w.apps.values()) {
    if (a.health !== 'down') continue;
    down++;
    const id = a.id ?? '', s = inp.downSince(id);
    if (s > downAt) { downAt = s; downApp = id; }
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
  // against the usual (fx-glance): the red main lines now, the last hour's failures, the pass rate
  // (w2-glance2) and the main lines red in the last hour, in the same pass
  let redNow = 0;
  const acute: { id: string; at: number }[] = [];
  for (const r of w.repos.values()) {
    if (!isRedMain(r.main?.state)) continue;
    redNow++;
    const s = r.main.since ?? 0;
    if (s > 0 && s >= now - HOUR && s <= now) acute.push({ id: r.id, at: s });
  }
  // v4-verdict (#1): a main line that flaps (it failed on its default branch in the 24 h before this
  // red began) is not a break: no "broken", no "broke main" (its beacon stays)
  if (acute.length) {
    const failedOn = new Map<string, number[]>();
    for (const a of acute) failedOn.set(a.id, []);
    for (const p of w.pipelines.values()) {
      const l = failedOn.get(p.repo);
      if (!l || (p.state !== 'failure' && p.state !== 'error') || p.event === 'pull_request' || p.branch !== w.repos.get(p.repo)?.default_branch) continue;
      l.push(p.finished ?? p.started ?? p.created);
    }
    for (let i = acute.length - 1; i >= 0; i--) if (flapping(w.repos.get(acute[i].id)?.main?.recent, acute[i].at, failedOn.get(acute[i].id))) acute.splice(i, 1);
  }
  const conc = (out.conc = concentration(w, now, HOUR));
  const u = (out.usual = usualOf(fleet, redNow, now, Math.max(0, now - since) / HOUR, inp.replay ? momentOf(w, now) : null));
  // v4-verdict (#1): the fleet WITHOUT the concentrated repo, this hour: its pass rate (null: under
  // MOMENT_MIN runs left) and whether it is at or over its usual (the pass rate's 7 d, the failures'
  // same-hour p90)
  let cx: { pass: number | null; ok: boolean } | null = null;
  if (conc) {
    const exRuns = conc.fleetRuns - conc.runs, exFails = conc.total - conc.fails;
    const pass = exRuns >= MOMENT_MIN ? 1 - exFails / exRuns : null;
    cx = { pass, ok: pass !== null && u.passTyp !== null && pass >= u.passTyp - 0.005 && (u.failsThr === null || exFails <= u.failsThr) };
  }
  // the verdict (w2-glance2, #1): NOW against USUAL; the window's news is the chips'
  acute.sort((a, b) => b.at - a.at || (a.id < b.id ? -1 : 1));
  const why: string[] = [];
  const pctW = (v: number | null) => (v === null ? '?' : `${Math.round(v * 100)}%`);
  const redFact = `${redNow} red${u.redTyp !== null ? ` (usual ${Math.round(u.redTyp)})` : ''}`;
  const passFact = u.pass !== null ? `pass ${pctW(u.pass)}${u.passTyp !== null ? ` (usual ${pctW(u.passTyp)})` : ''}` : '';
  const failsFact = u.fails1h !== null ? `${Math.round(u.fails1h)} fails this hour${u.failsTyp !== null ? ` (usual ${Math.round(u.failsTyp)})` : ''}` : '';
  if (down || w.watcher?.tripped || acute.length) {
    out.verdict = 'broken';
    if (w.watcher?.tripped) { out.fact = 'outage watcher tripped'; out.factKey = 'watcher'; }
    else if (down) { out.fact = down === 1 ? `${appWord(downApp)} down${downAt > 0 && now - downAt < 7 * DAY ? ` ${age(now - downAt)}` : ''}` : `${down} apps down`; out.factKey = 'down'; }
    else { out.fact = acute.length === 1 ? `${repoWord(acute[0].id)} red ${age(now - acute[0].at)}` : `${acute.length} mains red in the last hour`; out.factKey = 'acute'; }
    if (acute.length) why.push(`${acute.length} main ${acute.length === 1 ? 'line' : 'lines'} red in the last hour`);
    if (down) why.push(`${down} ${down === 1 ? 'app' : 'apps'} down`);
    if (w.watcher?.tripped) why.push('outage watcher');
    out.sev = 0.76 + 0.24 * clamp01((acute.length + 3 * down + (w.watcher?.tripped ? 4 : 0)) / 12);
  } else {
    // worse than usual: the fact that is furthest past its line decides (each scored in units of
    // its own margin: a red main line, a failure an hour, 5 points of pass rate)
    const over: [number, FactKey, string][] = [];
    if (u.redThr !== null && redNow > u.redThr) over.push([(redNow - u.redThr) / Math.max(1, u.redThr - (u.redTyp ?? u.redThr)), 'red', redFact]);
    if (u.fails1h !== null && u.failsThr !== null && u.fails1h > u.failsThr) over.push([(u.fails1h - u.failsThr) / Math.max(1, u.failsThr - (u.failsTyp ?? u.failsThr)), 'fails', failsFact]);
    if (u.passBad && u.pass !== null && u.passTyp !== null) over.push([(u.passTyp - u.pass) / 0.05, 'pass', passFact]);
    if (out.jam) over.push([0.5 + out.jam.k, 'jam', `${q.waiting} waiting, every slot busy`]);
    over.sort((a, b) => b[0] - a[0]);
    if (over.length) {
      out.verdict = 'worse';
      out.fact = over[0][2]; out.factKey = over[0][1];
      for (const o of over) why.push(o[2]);
      out.sev = 0.62 + 0.13 * clamp01(over[0][0] / 3);
      // v4-verdict (#1): the failures decided it and one repo holds ≥ 60 % of them: the news is that
      // repo. Without it the fleet at or over its usual (and no other line crossed): "steady · but
      // legal-tracker crons 0 / 8"; else "worse than usual · 8 of 8 fails legal-tracker crons"
      if (conc && cx && (over[0][1] === 'pass' || over[0][1] === 'fails')) {
        const others = over.some((o) => o[1] === 'red' || o[1] === 'jam');
        why.unshift(`${conc.fails} of ${conc.total} fails ${conc.label}`);
        if (cx.pass !== null) why.push(`without ${conc.label} pass ${pctW(cx.pass)}`);
        out.factKey = 'conc';
        if (cx.ok && !others) { out.verdict = 'steady'; concBut(out, conc); out.sev = 0.3 + 0.2 * clamp01(u.pct); }
        else out.fact = `${conc.fails} of ${conc.total} fails ${conc.label}`;
      }
    } else {
      // steady or flowing: red at or under its typical and the pass rate at or over its 7 d flows
      const redHigh = u.redTyp !== null ? redNow > u.redTyp + 0.5 : redNow > 0;
      const passLow = u.pass !== null && u.passTyp !== null && u.pass < u.passTyp - 0.005;
      if (!redHigh && !passLow) {
        out.verdict = 'flowing';
        if (passFact && u.passTyp !== null) { out.fact = passFact; out.factKey = 'pass'; }
        else if (u.redTyp !== null) { out.fact = redFact; out.factKey = 'red'; }
      } else {
        out.verdict = 'steady';
        if (redHigh) { out.fact = redFact; out.factKey = 'red'; } else { out.fact = passFact; out.factKey = 'pass'; }
      }
      // v4-verdict (#1): the pass rate under its usual is one repo's doing (the fleet without it at or
      // over its usual): that is the news, "steady · but legal-tracker crons 0 / 8"
      if (out.verdict === 'steady' && passLow && conc && cx?.ok) {
        why.push(`${conc.fails} of ${conc.total} fails ${conc.label}`);
        if (out.fact) why.push(out.fact);
        if (passFact && out.factKey !== 'pass') why.push(passFact);
        if (cx.pass !== null) why.push(`without ${conc.label} pass ${pctW(cx.pass)}`);
        out.factKey = 'conc'; concBut(out, conc);
      } else if (out.fact) why.push(out.fact);
      out.sev = out.verdict === 'flowing' ? 0.04 + 0.16 * clamp01(fresh.failed.length / 20) : 0.3 + 0.2 * clamp01(u.pct);
    }
  }
  out.why = why.join(' · ');
  // hotspots (w2-glance2, #4 #6), in slot order: a main line red < 1 h, an app down, the open
  // clusters by the main lines they hold red, the worst group by red share, the jam, then a flaky
  // cluster (never first)
  if (acute.length) {
    const a = acute[0];
    out.hot.push({ kind: 'red', id: a.id, lead: repoWord(a.id), rest: ` broke main · ${age(now - a.at)}${acute.length > 1 ? ` · ${acute.length - 1} more` : ''}`, red: true, tone: 'red' });
  }
  if (downApp) out.hot.push({ kind: 'down', id: downApp, lead: appWord(downApp), rest: ` · down${downAt > 0 && now - downAt < 7 * DAY ? ` ${age(now - downAt)}` : ''}${down > 1 ? ` · ${down - 1} more` : ''}`, red: true, tone: 'red' });
  // v4-verdict (#1): the repo the verdict names, at its rail, in the belt's words ("legal-tracker
  // crons · HTTP 000 · 8 / h"; glance.ts gives way when the belt names the same repo)
  if (conc && out.factKey === 'conc') out.hot.push({ kind: 'conc', id: conc.repo, lead: conc.label, rest: ` · ${conc.error ? `${conc.error} · ` : ''}${conc.fails} / h`, red: true, tone: 'red' });
  const open = inp.clusters.filter((c) => c.open > 0).sort((a, b) => b.open - a.open || b.count - a.count || (a.id < b.id ? -1 : 1));
  for (const c of open.slice(0, 1)) out.hot.push({ kind: 'cluster', id: c.id, lead: c.step, rest: ` · ${c.open} ${c.open === 1 ? 'main' : 'mains'} red · ${age(Math.max(0, now - c.last_seen))}`, red: true, tone: 'red' });
  const g0 = worstGroup(inp, acute);
  if (g0) out.hot.push(g0);
  if (out.jam) out.hot.push({ kind: 'jam', id: 'intake', lead: 'jam', rest: ` · ${out.jam.waiting} waiting`, red: false, tone: 'amber' });
  const fl = flakiest(inp.clusters, w);
  if (fl && out.hot.length) out.hot.push(fl);
  return out;
}

/** v4-verdict (#1): "but " + the concentrated repo's passes of its runs, in red ("legal-tracker
 *  crons 0 / 8"). */
function concBut(out: Marks, c: Concentration): void {
  out.factLead = 'but '; out.factRed = `${c.label} ${c.runs - c.fails} / ${c.runs}`;
  out.fact = out.factLead + out.factRed;
}

/** An app's short name ("org/name" → "name"). */
function appWord(id: string): string { const i = id.lastIndexOf('/'); return i >= 0 ? id.slice(i + 1) : id; }
/** A repo's short name ("org/name" → "name"). */
export function repoWord(id: string): string { const i = id.lastIndexOf('/'); return i >= 0 ? id.slice(i + 1) : id; }

/** A flaky cluster (w2-glance2, #6): one that holds no main line red and whose failures are a
 *  third or more flaky (or flaky at all, failing ≥ 10 times a day): the cron that fails every
 *  hour is not an incident. The one failing most. Its words say so, in gray-red. */
function flakiest(cls: readonly Cluster[], w: World): Hotspot | null {
  let best: Cluster | null = null;
  for (const c of cls) {
    if (!flakyCalled(c)) continue; // p3 (#5): clusters.ts's test, the belt's too
    if (!best || c.count > best.count) best = c;
  }
  if (!best) return null;
  const cron = best.examples.some((id) => w.pipelines.get(id)?.event === 'cron');
  return { kind: 'flaky', id: best.id, lead: best.step, rest: ` · flaky${cron ? ' cron' : ''} · ${best.count} / 24h`, red: false, tone: 'flaky' };
}

/** The worst group (w2-glance2, #4): by red SHARE × log(1 + red) + its main lines red in the last
 *  hour, so a team with 10 of its 17 main lines red outranks one with 18 of 131. Its words: "couplet
 *  · 10 of 17 red", a ▲ when its red trend is rising. Without red anywhere: the server's ranking
 *  of the window's failures. Null when nothing is red or failing. */
function worstGroup(inp: MarkInput, acute: readonly { id: string }[]): Hotspot | null {
  const fresh = new Map<string, number>();
  if (inp.groupOf) for (const a of acute) { const g = inp.groupOf(a.id); if (g) fresh.set(g, (fresh.get(g) ?? 0) + 1); }
  let best: { id: string; red: number; repos: number; score: number } | null = null;
  for (const g of inp.groups) {
    if (!(g.red > 0)) continue;
    const repos = Math.max(g.red, g.repos ?? 0);
    const score = (repos > 0 ? g.red / repos : 0) * Math.log(1 + g.red) + (fresh.get(g.id) ?? 0);
    if (!best || score > best.score + 1e-9 || (Math.abs(score - best.score) <= 1e-9 && g.red > best.red)) best = { id: g.id, red: g.red, repos, score };
  }
  if (best) {
    const rt = inp.trend(best.id)?.red;
    const rising = !!rt && (!!rt.bad || rt.dir > 0);
    const known = (inp.groups.find((x) => x.id === best!.id)?.repos ?? 0) > 0;
    return { kind: 'group', id: best.id, lead: inp.groupWord(best.id), rest: known ? ` · ${best.red} of ${best.repos} red` : ` · ${best.red} red`, red: true, tone: 'red', tri: rising ? 1 : 0 };
  }
  const g = inp.srv?.groups.find((x) => x.failed > 0);
  return g ? { kind: 'group', id: g.id, lead: inp.groupWord(g.id), rest: ` · ${g.failed} failed`, red: false, tone: 'ink' } : null;
}

/** How far a bad metric is from its typical (0.3..1): the ember's warmth. */
function emberK(key: MetricKey, m: Metric, short: boolean): number {
  const a = (short ? m.h1 : m.h24) ?? m.h24 ?? null, b = m.d7 ?? m.h24 ?? null;
  if (a === null || b === null) return 0.5;
  if (key === 'pass_rate') return clamp01(0.3 + (b - a) * 4);
  return clamp01(0.3 + (b > 0 ? (a - b) / b : 1) * 0.7);
}

function clamp01(x: number): number { return x < 0 ? 0 : x > 1 ? 1 : x; }
