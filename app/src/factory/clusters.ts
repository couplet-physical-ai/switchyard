// FAILURES BY CLUSTER (fab-w2, for W3's return conveyor; overseer note 4): the parked failures
// grouped by their failure signature, so one cause shows as one bunch on the belt without a
// click. The signature is the server's (v0.5 `Step.cluster` → `Cluster`), or insights' v0.4
// approximation; a failure no cluster holds gets the signature of its folded step and guessed
// class (`step · class`), the same key the server would build without an error line.

import type { FailClass } from '../wire.ts';
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
// (the newest on top), so its seams count them up close. A cluster that healed (`open` 0) is not
// failing now: it gets no heap (red is for failing now; the gray crates left the belt).

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
};

/** Heap width: a crate for one repo, a step wider for each more (world u), at most HEAP_W1. */
export const HEAP_W0 = 8, HEAP_WR = 6, HEAP_W1 = 74;
/** The tallest heap's height at most, and one failure's layer at most (world z). */
export const HEAP_H1 = 44, HEAP_UNIT = 6.4;
/** The gap between two heaps (world u); between two one-off failures (a heap of one) a short one,
 *  so the scattered one-offs read as a row of tiles apart from the heaps, not a dotted line. */
export const HEAP_GAP = 10, HEAP_GAP1 = 4;

const heapCache = new WeakMap<readonly Parked[], Heap[]>();

/** The heaps for the conveyor's parked failures (lenses.ts parkByCluster, in its order: open
 *  first, the most parked first), right edge at `u1 + 4`, stopping at `uMin`. Re-lays the parked
 *  failures IN PLACE so everything that reads them agrees with what the floor draws: each member
 *  at its heap's centre (the lens's threads, the coffee check's replay, the anchors), each group's
 *  u0..u1 the heap's extent inset by a crate's half (the brackets and glows pad by that). A healed
 *  cluster's failures LEAVE the list (nothing parks, rings or replays where no heap is); its group
 *  stays, at the conveyor's far end. Computed once per parked list. */
export function heapUp(parked: Parked[], groups: ParkGroup[], u1: number, uMin: number): Heap[] {
  const hit = heapCache.get(parked);
  if (hit) return hit;
  for (let i = parked.length - 1; i >= 0; i--) if (!groups[parked[i]!.k]?.open) parked.splice(i, 1);
  groups.forEach((pg) => { if (!pg.open) pg.u0 = pg.u1 = uMin; });
  const ins = insights();
  const members = new Map<number, Parked[]>();
  for (const x of parked) { let l = members.get(x.k); if (!l) members.set(x.k, (l = [])); l.push(x); }
  let nmax = 1;
  groups.forEach((pg) => { if (pg.open) nmax = Math.max(nmax, pg.n); });
  const unit = Math.min(HEAP_UNIT, HEAP_H1 / nmax);
  const heaps: Heap[] = [];
  let uR = u1 + 4, lastN = 0;
  groups.forEach((pg, k) => {
    const xs = members.get(k) ?? [];
    if (!xs.length) return;
    if (lastN === 1 && xs.length === 1) uR += HEAP_GAP - HEAP_GAP1;
    lastN = xs.length;
    const cl = pg.cl.startsWith('~') ? undefined : ins.cluster(pg.cl);
    const parkedRepos = [...new Set(xs.map((x) => x.repo))];
    const repoList = cl?.repos?.length ? [...new Set([...parkedRepos, ...cl.repos])] : parkedRepos;
    const repos = Math.max(1, cl ? Math.max(cl.repo_count || 0, repoList.length) : parkedRepos.length);
    const w = Math.min(HEAP_W1, HEAP_W0 + HEAP_WR * (repos - 1));
    // past the conveyor's far end: the rest pile, unseen, at its end (no heap)
    if (uR - w < uMin) { for (const x of xs) x.u = uMin; pg.u0 = pg.u1 = uMin; return; }
    const a = uR - w, b = uR;
    const mid = (a + b) / 2;
    for (const x of xs) x.u = mid;
    pg.u0 = Math.min(mid, a + 4); pg.u1 = Math.max(mid, b - 4);
    uR = a - HEAP_GAP;
    heaps.push({
      k, cl: pg.cl, step: pg.step, u0: a, u1: b, h: xs.length * unit, unit, n: xs.length, repos, repoList,
      ids: xs.map((x) => x.id), flaky: new Set(xs.filter((x) => x.flaky).map((x) => x.id)), newest: pg.newest || xs[0]!.id,
    });
  });
  heapCache.set(parked, heaps);
  return heaps;
}

/** The heaps already laid for this parked list (heapUp), or null. */
export function heapsOf(parked: readonly Parked[]): Heap[] | null { return heapCache.get(parked) ?? null; }

/** The tallest open heap (most failures; ties: nearest the scanner), or null. */
export function tallest(heaps: readonly Heap[]): Heap | null {
  let best: Heap | null = null;
  for (const h of heaps) if (!best || h.n > best.n || (h.n === best.n && h.u1 > best.u1)) best = h;
  return best;
}

/** The first failed step of a pipeline (its name), '' when none. */
function failedStepName(pid: string): string {
  const p = insights().world.pipelines.get(pid);
  for (const wf of p?.workflows ?? []) for (const s of wf.steps ?? []) if (s.state === 'failure' || s.state === 'error') return s.name;
  return '';
}
