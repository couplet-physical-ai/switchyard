// The contract reducer: applies a Frame's ops to a Snapshot. Pure and portable.
// upsert replaces the entity under (kind, id); remove deletes it; event ops never touch
// state. Singletons: `watcher` (id "outage") replaces Snapshot.watcher, and the mock's
// extension kind `stats` (id "stats") replaces Snapshot.stats. The v0.5 kinds (group, cluster,
// flake, trend) are collections like the others. Unknown kinds are skipped.

import type { Frame, Op, DemoSnapshot as Snapshot, Repo } from '../src/wire.ts';
import { mergePatch } from '../src/world.ts';

const COLLECTION: Record<string, keyof Snapshot> = {
  org: 'orgs', repo: 'repos', commit: 'commits', pipeline: 'pipelines', pr: 'prs', deploy: 'deploys',
  app: 'apps', engine: 'engines', queue: 'queues', lane: 'lanes',
  group: 'groups', cluster: 'clusters', flake: 'flakes', trend: 'trends',
};

export function applyOp(state: Snapshot, op: Op): void {
  if (op.op === 'event') return;
  if (op.op === 'dot') {
    // v0.4: same sha out, this dot in, sorted by (at, sha), the newest 12 kept.
    const r = (state.repos as Record<string, Repo>)[op.id];
    if (!r) return;
    const recent = (r.main?.recent ?? []).filter((d) => d.sha !== op.v.sha).concat([op.v]);
    recent.sort((a, b) => a.at - b.at || (a.sha < b.sha ? -1 : a.sha > b.sha ? 1 : 0));
    (state.repos as Record<string, Repo>)[op.id] = { ...r, main: { ...r.main, recent: recent.slice(-12) } as Repo['main'] };
    return;
  }
  const kind = op.kind as string;
  if (kind === 'watcher') {
    if (op.op === 'upsert') state.watcher = op.v as Snapshot['watcher'];
    else if (op.op === 'patch') state.watcher = mergePatch(state.watcher, op.v) as Snapshot['watcher'];
    return;
  }
  if (kind === 'stats') {
    if (op.op === 'upsert') state.stats = op.v as Snapshot['stats'];
    else if (op.op === 'patch') state.stats = mergePatch(state.stats, op.v) as Snapshot['stats'];
    return;
  }
  const key = COLLECTION[kind];
  if (!key) return;
  const coll = ((state as unknown as Record<string, unknown>)[key] ??= {}) as Record<string, unknown>;
  if (op.op === 'upsert') coll[op.id] = op.v;
  else if (op.op === 'patch') { if (op.id in coll) coll[op.id] = mergePatch(coll[op.id], op.v); }
  else delete coll[op.id];
}

/** Applies a frame in place and returns the same state. `hb`/`reset` frames are no-ops. */
export function applyFrame(state: Snapshot, frame: Frame): Snapshot {
  if (frame.t !== 'delta') return state;
  for (const op of frame.ops) applyOp(state, op);
  state.seq = frame.seq;
  state.at = frame.at;
  return state;
}
