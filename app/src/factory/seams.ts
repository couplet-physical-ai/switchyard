// fab-lens SEAMS: the few things the lens system and the coffee check read that another module
// owns, each one small function here so a swap is one import:
//   beat          → src/factory/motion.ts (fab-base's shared 1 Hz beat), when it lands
//   groupOf       → src/insights.ts groupOf/group (contract v0.5 `Repo.group`, approximated on 0.4)
//   clusterKey    → src/insights.ts clusterOf (v0.5 `Step.cluster`, approximated on 0.4)
//   changesSince  → src/insights.ts changesSince (v0.5 `/api/v1/changes?since`, approximated on 0.4)
//   appHistory    → src/insights.ts appHistory (H7, client-side)

import type { Changes as WireChanges, Pipeline } from '../wire.ts';
import type { World } from '../world.ts';
import { appHistory as insAppHistory, changesSince as insChangesSince, clusterOf, insights, type AppHistoryView } from '../insights.ts';

// ---- the beat ---------------------------------------------------------------------------------
/** THE shared 1 Hz beat, 0..1 (1 on the beat): every pulse, glow and blink reads it, so they are
 *  all in phase (FACTORY-SPEC §G). `t` is the module clock (ms). */
export function beat(t: number): number { return 0.5 + 0.5 * Math.cos((2 * Math.PI * t) / 1000); }
/** Where in the current beat we are, 0..1 (0 = on the beat): rings that expand once a beat. */
export function beatPhase(t: number): number { return ((t % 1000) + 1000) % 1000 / 1000; }

// ---- groups -----------------------------------------------------------------------------------
export type GroupRef = { id: string; kind: 'team' | 'org'; name: string };

/** The group a repo belongs to (FACTORY-SPEC §C): its team, else its org. */
export function groupOf(w: World, repo: string): GroupRef {
  void w;
  const id = insights().groupOf(repo);
  const g = insights().group(id);
  const kind = id.startsWith('team:') ? 'team' : 'org';
  return { id, kind, name: g?.name ?? id.slice(id.indexOf(':') + 1) };
}

// ---- failure clusters -------------------------------------------------------------------------
/** A failed run's cluster id (its failure signature, FACTORY-SPEC §E: `test-web-1/2/3` →
 *  `test-web`), '' when it names no failing step. */
export function clusterKey(p: Pipeline): string { return p.id ? clusterOf(p.id)?.id ?? '' : ''; }

/** A cluster's step words (for labels). */
export function clusterStep(key: string): string {
  if (!key) return '';
  const c = insights().cluster(key);
  return c ? c.step : key;
}

export type Cluster = { key: string; n: number; repos: Set<string>; ids: string[]; last: number };
/** Failure clusters among the runs finished in (from, to], counted from the world (the hour's
 *  repos per signature: smoke needs ≥ 3 within 1 h), keyed by the seam's cluster id. */
export function clusters(w: World, from: number, to: number): Cluster[] {
  const m = new Map<string, Cluster>();
  for (const p of w.pipelines.values()) {
    if (p.state !== 'failure' && p.state !== 'error') continue;
    const at = p.finished ?? p.created;
    if (at <= from || at > to) continue;
    const k = clusterKey(p);
    if (!k) continue;
    let c = m.get(k); if (!c) m.set(k, (c = { key: k, n: 0, repos: new Set(), ids: [], last: 0 }));
    c.n++; c.repos.add(p.repo); if (c.ids.length < 64) c.ids.push(p.id ?? ''); c.last = Math.max(c.last, at);
  }
  return [...m.values()].sort((a, b) => b.repos.size - a.repos.size || b.n - a.n);
}

// ---- changes since the last visit -------------------------------------------------------------
export type Changes = WireChanges;
/** What changed since `ms` (the server's own `/changes` on v0.5 and the demo; approximated on 0.4). */
export function changesSince(ms: number): Promise<Changes> { return insChangesSince(ms); }

// ---- an app's history -------------------------------------------------------------------------
export function appHistory(id: string): AppHistoryView | null { return insAppHistory(id); }
