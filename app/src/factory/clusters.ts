// FAILURES BY CLUSTER (fab-w2, for W3's return conveyor; overseer note 4): the parked failures
// grouped by their failure signature, so one cause shows as one bunch on the belt without a
// click. The signature is the server's (v0.5 `Step.cluster` → `Cluster`), or insights' v0.4
// approximation; a failure no cluster holds gets the signature of its folded step and guessed
// class (`step · class`), the same key the server would build without an error line.

import type { FailClass } from '../wire.ts';
import { foldStep, guessClass, signatureOf } from '../../server/floor.ts';
import { insights } from '../insights.ts';

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

/** The first failed step of a pipeline (its name), '' when none. */
function failedStepName(pid: string): string {
  const p = insights().world.pipelines.get(pid);
  for (const wf of p?.workflows ?? []) for (const s of wf.steps ?? []) if (s.state === 'failure' || s.state === 'error') return s.name;
  return '';
}
