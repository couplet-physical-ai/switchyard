// FAILURES BY CLUSTER (fab-w2, for W3's return conveyor; overseer note 4): the parked failures
// grouped by their failure signature, so one cause shows as one bunch on the belt without a
// click. The signature is the server's (v0.5 `Step.cluster` → `Cluster`), or insights' v0.4
// approximation; a failure no cluster holds gets the signature of its folded step and guessed
// class (`step · class`), the same key the server would build without an error line.

import type { Cluster, FailClass, Pipeline } from '../wire.ts';
import { foldStep, guessClass, signatureOf } from '../../server/floor.ts';
import { insights } from '../insights.ts';
import type { ParkGroup, Parked } from './lenses.ts';

/** A parked failure: a failed pipeline's id, and what the floor already knows of it. */
export type ParkedFailure = { id: string; repo?: string; step?: string; at?: number };

export type ClusterRun = {
  /** The server's cluster id, or '~' + signature for a failure no cluster holds. */
  clusterId: string;
  signature: string;
  class: FailClass;
  /** The member failures' ids, newest first. */
  ids: string[];
  /** Distinct repos among the members. */
  repos: number;
  /** The newest member's time (0 when none says). */
  newest: number;
};

/** Orders failures by cluster: one run per signature, the run whose newest member is newest
 *  first (ties: the bigger run), members newest first. O(n) lookups, n = the failures given
 *  (the conveyor's last hour: tens). */
export function clusterOrder(failures: readonly ParkedFailure[]): ClusterRun[] {
  const ins = insights(), w = ins.world;
  const runs = new Map<string, ClusterRun & { at: Map<string, number>; repoSet: Set<string> }>();
  for (const f of failures) {
    if (!f?.id) continue;
    const c = ins.clusterOf(f.id, f.step || undefined);
    let id: string, sig: string, cls: FailClass;
    if (c) { id = c.id; sig = c.signature; cls = c.class; }
    else {
      const step = f.step || failedStepName(f.id) || 'unknown';
      cls = guessClass(step, '');
      sig = signatureOf(foldStep(step), cls);
      id = `~${sig}`;
    }
    let r = runs.get(id);
    if (!r) runs.set(id, (r = { clusterId: id, signature: sig, class: cls, ids: [], repos: 0, newest: 0, at: new Map(), repoSet: new Set() }));
    const at = f.at ?? w.pipelines.get(f.id)?.finished ?? 0;
    if (!r.at.has(f.id)) { r.ids.push(f.id); r.at.set(f.id, at); }
    const repo = f.repo ?? w.pipelines.get(f.id)?.repo;
    if (repo) r.repoSet.add(repo);
    if (at > r.newest) r.newest = at;
  }
  const out: ClusterRun[] = [];
  for (const r of runs.values()) {
    r.ids.sort((a, b) => (r.at.get(b) ?? 0) - (r.at.get(a) ?? 0) || (a < b ? -1 : 1));
    out.push({ clusterId: r.clusterId, signature: r.signature, class: r.class, ids: r.ids, repos: r.repoSet.size, newest: r.newest });
  }
  out.sort((a, b) => b.newest - a.newest || b.ids.length - a.ids.length || (a.clusterId < b.clusterId ? -1 : 1));
  return out;
}

// ───────────────────────────── heaps on the return conveyor ─────────────────────────────
//
// fx-engine (REVIEW-iter2 #9, wow 3): the conveyor shows ONE HEAP per failure signature, not a
// dotted line of crates: its height ∝ the failures it holds (this hour), its width ∝ the repos it
// reached, the biggest open one nearest the scanner. A heap is a stack of layers, one per failure
// (the newest on top), so its seams count them up close. v4 (REVIEW-iter3b #3): a cluster that
// holds no main red (`open` 0) keeps its heap in gray-red (failing flow, or healed: quiet), never
// red; one repo's crons failing the same way stand as one group of heaps under one label.

/** One heap: a cluster's run on the conveyor, from u0 (far end) to u1 (nearest the scanner). */
export type Heap = {
  /** Its index in the ParkGroup list (Parked.k). */
  k: number; cl: string; step: string;
  u0: number; u1: number;
  /** Height (world units) and a layer's (one failure's) height. */
  h: number; unit: number;
  /** Failures parked (this hour), repos it reached (the cluster's, else the parked ones'). */
  n: number; repos: number;
  /** The repos for its arcs (the cluster's, else the parked ones'), newest failure first. */
  repoList: string[];
  /** Member failure ids, newest first (layer 0 is the oldest, at the bottom). */
  ids: string[];
  flaky: Set<string>;
  newest: string;
  /** w2-engine2 (REVIEW-iter3 #6): the cluster is FLAKY (`flakyCluster`): its heap is drawn hatched
   *  in gray-red, never solid red. */
  flakyCl: boolean;
  /** v4-heaps (REVIEW-iter3b #3), optional for hand-made heaps: its merge key ('' alone), mains it
   *  holds red (the cluster's `open`), failures in the last hour (0: healed), its newest failure,
   *  its 24 h failures, its error shape, its one repo ('' several), its heat (`HeapHeat`). */
  grp?: string; ks?: number[]; open?: number; rate?: number; last?: number; count?: number; error?: string; repo?: string; heat?: HeapHeat;
};

/** w2-engine2 (REVIEW-iter3 #6): a failure cluster is FLAKY, not broken, when at least a quarter of
 *  its 24 h failures (and two) passed again on the same sha (the server's `Cluster.flaky`), or, with
 *  no cluster record, when at least half of the failures parked on its heap (and one) are flaky.
 *  One rule for the floor (the hatched heap) and the words (a callout says "flaky"). */
export function flakyCluster(cl: { count: number; flaky?: number } | null | undefined, parked?: { n: number; flaky: number }, flake?: { flips: number; failures: number } | null): boolean {
  if (cl && (cl.flaky ?? 0) > 0 && (cl.flaky ?? 0) >= Math.max(2, 0.25 * cl.count)) return true;
  // the flakes table (repo | workflow/step): the same step flipped on one sha all day (a cron)
  if (flake && flake.flips >= Math.max(2, 0.25 * flake.failures)) return true;
  if (cl && (cl.flaky ?? 0) > 0) return false;
  return !!parked && parked.flaky >= 1 && parked.flaky * 2 >= parked.n;
}

/** How flaky a heap's step has been today across its repos (flaky runs and failures in 24 h), or
 *  null: the flakes table (repo | workflow/step flips on one sha), and the sibling clusters of the
 *  same step on the same repos (the server splits a step's failures by their error line: a cron's
 *  cluster opened again today keeps the flakiness its step showed all day). */
export function flakeOf(step: string, repos: readonly string[]): { flips: number; failures: number } | null {
  const R = new Set(repos), ins = insights();
  let best: { flips: number; failures: number } | null = null;
  const take = (flips: number, failures: number) => { if (!best || flips / Math.max(1, failures) > best.flips / Math.max(1, best.failures)) best = { flips, failures }; };
  for (const f of ins.flakes()) {
    if (!R.has(f.repo) || !(f.step === step || step.includes(f.step) || f.step.includes(step))) continue;
    take(f.flips_24h, f.failures_24h);
  }
  for (const c of ins.clusters()) {
    if (!(c.flaky ?? 0) || c.step !== step || !c.repos?.some((r) => R.has(r))) continue;
    take(c.flaky ?? 0, c.count);
  }
  return best;
}

/** p3 (#5): the coffee check's flaky test (anomaly.ts `flakiest`, the gray-red callout): a cluster
 *  that holds no main line red, whose failures are a third or more flaky, or flaky at all while
 *  failing ≥ 10 times a day (the cron that fails every hour is not an incident). */
export function flakyCalled(c: { open: number; count: number; flaky?: number | null }): boolean {
  const fk = c.flaky ?? 0;
  return c.open <= 0 && fk > 0 && (fk >= c.count / 3 || c.count >= 10);
}

/** p3 (#5): whether the callouts call a step flaky on any of these repos (a cluster of that step,
 *  on one of them, passes `flakyCalled`): the belt's heap of that step says so too, so the callout
 *  and the belt never disagree (a cron's cluster opened again keeps its healed sibling's word). */
export function stepCalledFlaky(step: string, repos: readonly string[]): boolean {
  const R = new Set(repos);
  for (const c of insights().clusters()) if (c.step === step && flakyCalled(c) && c.repos?.some((r) => R.has(r))) return true;
  return false;
}

/** The heap is drawn hatched (a flaky cluster's). */
export function flakyHeap(h: Heap): boolean { return h.flakyCl; }

/** Heap width: a crate for one repo, a step wider for each more (world u), at most HEAP_W1. */
export const HEAP_W0 = 8, HEAP_WR = 6, HEAP_W1 = 74;
/** The tallest heap's height at most, and one failure's layer at most (world z). */
export const HEAP_H1 = 44, HEAP_UNIT = 6.4;
/** The gap between two heaps (world u); between two one-off failures (a heap of one) a short one,
 *  so the scattered one-offs read as a row of tiles apart from the heaps, not a dotted line. */
export const HEAP_GAP = 10, HEAP_GAP1 = 4;

const heapCache = new WeakMap<readonly Parked[], Heap[]>();

/** v4-heaps (REVIEW-iter3b #3): the merge key of a park group's failures: `crons:<repo>` when they
 *  are all one repo's crons, `err:<repo>|<shape>` when they are one repo's with one error shape
 *  (`HTTP 000`), else ''. Clusters with one key stand as one heap group with one label. */
export function mergeKeyOf(xs: readonly { id: string; repo: string }[], line: string | null | undefined, pipelines: ReadonlyMap<string, Pipeline>): string {
  if (!xs.length) return '';
  const repo = xs[0]!.repo;
  if (!repo || xs.some((x) => x.repo !== repo)) return '';
  if (xs.every((x) => pipelines.get(x.id)?.event === 'cron')) return `crons:${repo}`;
  const shape = errorShape(line);
  return shape ? `err:${repo}|${shape}` : '';
}

/** The heaps for the conveyor's parked failures (lenses.ts parkByCluster, in its order: open
 *  first, the most parked first), right edge at `u1 + 4`, stopping at `uMin`. Re-lays the parked
 *  failures IN PLACE so everything that reads them agrees with what the floor draws: each member
 *  at its heap's centre (the lens's threads, the coffee check's replay, the anchors), each group's
 *  u0..u1 the heap's extent inset by a crate's half (the brackets and glows pad by that).
 *  v4 (REVIEW-iter3b #3): a cluster that holds no main red keeps its heap (its height is the
 *  story), painted gray-red by the plant (`heat`); the clusters of one merge key (`mergeKeyOf`:
 *  one repo's crons, or one repo's failures with one error shape) are ONE heap, where the first
 *  of them stood, a layer per failure (`ks`: their park groups). Computed once per parked list. */
export function heapUp(parked: Parked[], groups: ParkGroup[], u1: number, uMin: number): Heap[] {
  const hit = heapCache.get(parked);
  if (hit) return hit;
  const ins = insights(), w = ins.world;
  const members = new Map<number, Parked[]>();
  for (const x of parked) { let l = members.get(x.k); if (!l) members.set(x.k, (l = [])); l.push(x); }
  const cls = groups.map((pg) => (pg.cl.startsWith('~') ? undefined : ins.cluster(pg.cl)));
  const keys = groups.map((_, k) => mergeKeyOf(members.get(k) ?? [], cls[k]?.line, w.pipelines));
  // the units on the belt, in its order: a park group, or a merge key's groups (at its first's place)
  const units: number[][] = [], seen = new Set<number>();
  groups.forEach((_, k) => {
    if (seen.has(k) || !members.get(k)?.length) return;
    seen.add(k);
    const ks = [k], mk = keys[k];
    if (mk) for (let j = k + 1; j < groups.length; j++) if (keys[j] === mk && !seen.has(j) && members.get(j)?.length) { seen.add(j); ks.push(j); }
    units.push(ks);
  });
  const xsOf = (ks: number[]): Parked[] => {
    const xs = ks.flatMap((k) => members.get(k) ?? []);
    if (ks.length > 1) xs.sort((a, b) => b.at - a.at || (a.id < b.id ? -1 : 1));
    return xs;
  };
  let nmax = 1;
  for (const ks of units) nmax = Math.max(nmax, xsOf(ks).length);
  const unit = Math.min(HEAP_UNIT, HEAP_H1 / nmax);
  const heaps: Heap[] = [];
  let uR = u1 + 4, lastN = 0;
  groups.forEach((pg, k) => { if (!seen.has(k)) pg.u0 = pg.u1 = uMin; });
  for (const ks of units) {
    const xs = xsOf(ks);
    if (lastN === 1 && xs.length === 1) uR += HEAP_GAP - HEAP_GAP1;
    lastN = xs.length;
    const k = ks[0]!, pg = groups[k]!, cl = cls[k];
    const parkedRepos = [...new Set(xs.map((x) => x.repo))];
    const cRepos = ks.flatMap((j) => cls[j]?.repos ?? []);
    const repoList = cRepos.length ? [...new Set([...parkedRepos, ...cRepos])] : parkedRepos;
    const repos = Math.max(1, cl ? Math.max(...ks.map((j) => cls[j]?.repo_count || 0), repoList.length) : parkedRepos.length);
    const wd = Math.min(HEAP_W1, HEAP_W0 + HEAP_WR * (repos - 1));
    // past the conveyor's far end: the rest pile, unseen, at its end (no heap)
    if (uR - wd < uMin) { for (const x of xs) x.u = uMin; for (const j of ks) groups[j]!.u0 = groups[j]!.u1 = uMin; continue; }
    const a = uR - wd, b = uR;
    const mid = (a + b) / 2;
    for (const x of xs) x.u = mid;
    for (const j of ks) { groups[j]!.u0 = Math.min(mid, a + 4); groups[j]!.u1 = Math.max(mid, b - 4); }
    uR = a - HEAP_GAP;
    const flaky = new Set(xs.filter((x) => x.flaky).map((x) => x.id));
    // the facts: summed over the merged clusters (one repo's: it holds at most its one main red)
    let open = 0, rate = 0, last = 0, count = 0, flakyCl = true, live = false;
    const shapes = new Map<string, number>();
    for (const j of ks) {
      const c = cls[j], n = members.get(j)!.length;
      const o = c ? Math.max(0, c.open) : groups[j]!.open ? 1 : 0;
      open = ks.length > 1 ? Math.max(open, Math.min(1, o)) : o;
      const healed = !!c && c.open <= 0 && c.count_1h <= 0;
      if (!healed) { rate += Math.max(c?.count_1h ?? 0, n); live = true; }
      last = Math.max(last, c?.last_seen ?? Math.max(...members.get(j)!.map((x) => x.at || 0)));
      count += Math.max(c?.count ?? 0, n);
      const sh = errorShape(c?.line);
      if (sh) shapes.set(sh, (shapes.get(sh) ?? 0) + n);
      const st = c?.step ?? groups[j]!.step;
      const fl = flakyCluster(c, { n, flaky: members.get(j)!.filter((x) => x.flaky).length }, flakeOf(st, repoList)) || stepCalledFlaky(st, repoList);
      flakyCl = flakyCl && fl;
    }
    let error = '', en = 0;
    for (const [sh, n] of shapes) if (n > en) { error = sh; en = n; }
    if (!error && keys[k]?.startsWith('err:')) error = keys[k]!.slice(keys[k]!.indexOf('|') + 1);
    heaps.push({
      k, cl: pg.cl, step: pg.step, u0: a, u1: b, h: xs.length * unit, unit, n: xs.length, repos, repoList,
      ids: xs.map((x) => x.id), flaky, newest: ks.length > 1 ? xs[0]!.id : pg.newest || xs[0]!.id, flakyCl,
      grp: ks.length > 1 ? keys[k]! : '', ks, open, rate, last, count, error, repo: parkedRepos.length === 1 ? parkedRepos[0]! : '',
      heat: open > 0 ? 'red' : !cl && ks.length === 1 ? 'red' : live ? 'flow' : 'quiet',
    });
  }
  heapCache.set(parked, heaps);
  return heaps;
}

/** The heaps already laid for this parked list (heapUp), or null. */
export function heapsOf(parked: readonly Parked[]): Heap[] | null { return heapCache.get(parked) ?? null; }

/** The heap the belt fires arcs from: the WIDEST repo spread (a shared cause tells more than one
 *  repo's pile; overseer, after the iter-2 reel), ties: most failures, then nearest the scanner;
 *  null when none. */
export function tallest(heaps: readonly Heap[]): Heap | null {
  let best: Heap | null = null;
  for (const h of heaps) if (!best || h.repos > best.repos || (h.repos === best.repos && (h.n > best.n || (h.n === best.n && h.u1 > best.u1)))) best = h;
  return best;
}

/** v4-heaps (REVIEW-iter3b #3): one heap GROUP on the belt: the heaps of one merge key (one repo's
 *  crons failing the same way), or one heap alone. What the belt names. */
export type HeapGroup = {
  key: string; heaps: Heap[];
  /** The biggest of its heaps (its arcs, its cluster for the callouts). */
  head: Heap;
  /** `legal-tracker crons` / `legal-tracker` (a merged group), '' for one heap (named by its step). */
  label: string; repo: string;
  /** The shared error shape (`HTTP 000`), '' none. */
  error: string;
  /** Failures on the belt, failures in the last hour, mains it holds red, its newest failure, its
   *  24 h failures. */
  n: number; rate: number; open: number; last: number; count: number;
  /** red: it holds a main red (open); flow: failing, holding none (gray-red); quiet: healed (open 0
   *  and none this hour: gray-red, never named red). */
  heat: HeapHeat;
  flaky: boolean;
};
export type HeapHeat = 'red' | 'flow' | 'quiet';

const groupCache = new WeakMap<readonly Heap[], HeapGroup[]>();

/** The heaps by group, in belt order (nearest the scanner first). Cached per heap list. */
export function heapGroups(heaps: readonly Heap[]): HeapGroup[] {
  const hit = groupCache.get(heaps);
  if (hit) return hit;
  const out: HeapGroup[] = [], by = new Map<string, HeapGroup>();
  for (const h of heaps) {
    const key = h.grp || `cl:${h.cl}`;
    let g = by.get(key);
    if (!g) {
      const repo = h.repo ?? '';
      const name = repo.slice(repo.lastIndexOf('/') + 1);
      by.set(key, (g = { key, heaps: [], head: h, label: h.grp ? (h.grp.startsWith('crons:') ? `${name} crons` : name) : '', repo, error: '', n: 0, rate: 0, open: 0, last: 0, count: 0, heat: 'quiet', flaky: true }));
      out.push(g);
    }
    g.heaps.push(h);
    if (h.n > g.head.n) g.head = h;
    g.n += h.n; g.rate += h.rate ?? h.n; g.count += h.count ?? h.n;
    // one repo's group holds at most its one main red
    g.open = h.grp ? Math.max(g.open, Math.min(1, h.open ?? 1)) : (h.open ?? 1);
    g.last = Math.max(g.last, h.last ?? 0);
    const heat = h.heat ?? 'red';
    if (heat === 'red' || (heat === 'flow' && g.heat === 'quiet')) g.heat = heat;
    g.flaky = g.flaky && h.flakyCl;
  }
  for (const g of out) {
    // the error shape most of its heaps share (by failures), else the members' one
    const sh = new Map<string, number>();
    for (const h of g.heaps) if (h.error) sh.set(h.error, (sh.get(h.error) ?? 0) + h.n);
    let best = '', n = 0;
    for (const [k, c] of sh) if (c > n) { best = k; n = c; }
    g.error = best || (g.key.startsWith('err:') ? g.key.slice(g.key.indexOf('|') + 1) : '');
  }
  groupCache.set(heaps, out);
  return out;
}

/** v4-heaps (REVIEW-iter3b #3): the heap group the belt NAMES. A solid (not flaky) group first;
 *  then the most failures in the LAST HOUR, then the most mains held red, then the newest failure,
 *  and only then the 24 h count (a cluster quiet for an hour never outranks a live one by its day);
 *  ties: nearest the scanner. Null: none. */
export function namedGroup(heaps: readonly Heap[]): HeapGroup | null {
  let best: HeapGroup | null = null;
  for (const g of heapGroups(heaps)) {
    if (!best) { best = g; continue; }
    const d = (best.flaky ? 1 : 0) - (g.flaky ? 1 : 0) || g.rate - best.rate || g.open - best.open || g.last - best.last || g.count - best.count;
    if (d > 0) best = g;
  }
  return best;
}

/** The heap the belt names (its group's biggest): glance.ts's callouts give way to its cluster. */
export function namedHeap(heaps: readonly Heap[]): Heap | null { return namedGroup(heaps)?.head ?? null; }

/** v4-heaps (REVIEW-iter3b #3): the ONE state fact after a heap group's name: `· 7 mains red` when
 *  it holds two or more mains red, else `· 8 / h` while it fails this hour, else `· 1 main red`,
 *  else `· quiet 2 h` (never `· 1 repo`). */
export function heapFact(g: Pick<HeapGroup, 'rate' | 'open' | 'last'>, now: number): string {
  if (g.open >= 2) return `${g.open} mains red`;
  if (g.rate > 0) return `${g.rate} / h`;
  if (g.open === 1) return '1 main red';
  const h = Math.max(1, Math.round((now - g.last) / 3_600_000));
  return g.last > 0 ? `quiet ${h} h` : 'quiet';
}

/** The first failed step of a pipeline (its name), '' when none. */
function failedStepName(pid: string): string {
  const p = insights().world.pipelines.get(pid);
  for (const wf of p?.workflows ?? []) for (const s of wf.steps ?? []) if (s.state === 'failure' || s.state === 'error') return s.name;
  return '';
}

// ───────────────────────────── failure CONCENTRATION (v4) ─────────────────────────────
//
// v4-heaps (REVIEW-iter3b #1–#3): failure concentration is a first-class signal. When most of a
// window's failures are ONE repo (or one repo's crons failing the same way), the news is that repo,
// not the fleet's pass rate: the verdict names it (v4-verdict, glance.ts), the chute shrinks to a
// rail and the belt names its heap group (plant.ts). Pure over the world: one pass over its
// pipelines, cached per (world, ver, now's second, window).

/** The window's failures concentrate on one repo (or one repo's crons): ≥ CONC_SHARE of them,
 *  and at least CONC_MIN. */
export const CONC_SHARE = 0.6, CONC_MIN = 2;

export type Concentration = {
  /** `repo:<owner/name>`, or `crons:<owner/name>` when its failures are mostly its crons. */
  key: string;
  /** What the floor and the verdict call it: `legal-tracker`, or `legal-tracker crons`. */
  label: string;
  /** The repo id (`Northwind-Labs/legal-tracker`). */
  repo: string;
  /** Its failures in the window, the fleet's failures in the window, fails / total. */
  fails: number; total: number; share: number;
  /** Its runs that finished in the window (fails included): `legal-tracker 0 / 12` = runs − fails passed. */
  runs: number;
  /** The fleet's finished runs in the window and its failures without this repo (the verdict's
   *  "steady but …" test: the fleet minus the repo against its usual). */
  fleetRuns: number;
  /** Its failures' shared error shape (`HTTP 000`), else their class (`exit`), else ''. */
  error: string;
  /** Failed jobs (distinct failed step names) among its failures: `3 jobs`. */
  jobs: number;
};

const FAILED = (s: string | undefined): boolean => s === 'failure' || s === 'error';
const DONE = (s: string | undefined): boolean => s === 'success' || s === 'failure' || s === 'error';

/** The short shape of a failure's error line: `HTTP 000`, `exit 137`, `timed out`, else ''. One
 *  shape for many endpoints (`…/admin/run-renewal-check returned HTTP 000` → `HTTP 000`). */
export function errorShape(line: string | null | undefined): string {
  if (!line) return '';
  let m = /\bHTTP[ /]?(\d{3})\b/i.exec(line);
  if (m) return `HTTP ${m[1]}`;
  m = /\bexit(?:ed)?(?: with)?(?: code| status)?[ :=]+(\d{1,3})\b/i.exec(line);
  if (m) return `exit ${m[1]}`;
  if (/\btimed? ?out\b|\btimeout\b|deadline exceeded/i.test(line)) return 'timed out';
  if (/\bconnection refused\b|ECONNREFUSED/i.test(line)) return 'conn refused';
  if (/\bnot found\b/i.test(line)) return 'not found';
  return '';
}

type ConcWorld = { at: number; ver?: number; pipelines: Map<string, Pipeline>; clusters?: Map<string, Cluster> };
const concCache = new WeakMap<object, { k: string; v: Concentration | null }>();

/** The repo (or one repo's crons) holding ≥ 60 % (and ≥ 2) of the failures that finished in
 *  (now − windowMs, now], else null. A run's time is finished ?? started ?? created. O(pipelines). */
export function concentration(world: ConcWorld, now: number, windowMs: number): Concentration | null {
  const ck = `${world.ver ?? -1}|${Math.floor(now / 1000)}|${windowMs}`;
  const hit = concCache.get(world);
  if (hit && hit.k === ck) return hit.v;
  const from = now - windowMs;
  let total = 0, fleetRuns = 0;
  const per = new Map<string, { fails: number; runs: number; crons: number; shapes: Map<string, number>; classes: Map<string, number>; steps: Set<string> }>();
  for (const p of world.pipelines.values()) {
    if (!DONE(p.state)) continue;
    const at = p.finished ?? p.started ?? p.created;
    if (!(at > from && at <= now)) continue;
    fleetRuns++;
    let r = per.get(p.repo);
    if (!r) per.set(p.repo, (r = { fails: 0, runs: 0, crons: 0, shapes: new Map(), classes: new Map(), steps: new Set() }));
    r.runs++;
    if (!FAILED(p.state)) continue;
    total++; r.fails++;
    if (p.event === 'cron') r.crons++;
    let shape = '', cls = '', step = '';
    for (const wf of p.workflows ?? []) for (const s of wf.steps ?? []) {
      if (step || !FAILED(s.state)) continue;
      step = s.name;
      const c = s.cluster ? world.clusters?.get(s.cluster) : undefined;
      if (c) { shape = errorShape(c.line); cls = c.class; }
    }
    if (!step) for (const wf of p.workflows ?? []) if (!step && FAILED(wf.state)) step = wf.name;
    if (shape) r.shapes.set(shape, (r.shapes.get(shape) ?? 0) + 1);
    if (cls) r.classes.set(cls, (r.classes.get(cls) ?? 0) + 1);
    if (step) r.steps.add(step);
  }
  let top: string | null = null;
  for (const [repo, r] of per) {
    const t = top ? per.get(top)! : null;
    if (!t || r.fails > t.fails || (r.fails === t.fails && repo < top!)) top = repo;
  }
  let v: Concentration | null = null;
  const r = top ? per.get(top)! : null;
  if (top && r && r.fails >= CONC_MIN && total > 0 && r.fails / total >= CONC_SHARE) {
    const most = (m: Map<string, number>): string => { let b = '', n = 0; for (const [k, c] of m) if (c > n || (c === n && k < b)) { b = k; n = c; } return b; };
    const crons = r.crons * 2 > r.fails;
    const name = top.slice(top.lastIndexOf('/') + 1);
    v = {
      key: `${crons ? 'crons' : 'repo'}:${top}`, label: crons ? `${name} crons` : name, repo: top,
      fails: r.fails, total, share: r.fails / total, runs: r.runs, fleetRuns,
      error: most(r.shapes) || most(r.classes), jobs: Math.max(1, r.steps.size),
    };
  }
  concCache.set(world, { k: ck, v });
  return v;
}
