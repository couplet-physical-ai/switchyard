// The contract reducer: applies a Frame's ops to a Snapshot. Pure and portable.
// upsert replaces the entity under (kind, id); remove deletes it; event ops never touch
// state. Singletons: `watcher` (id "outage") replaces Snapshot.watcher, and the mock's
// extension kind `stats` (id "stats") replaces Snapshot.stats. Unknown kinds are skipped.

import type { Frame, Op, Snapshot } from '../src/wire.ts';

const COLLECTION: Record<string, keyof Snapshot> = {
  org: 'orgs', repo: 'repos', commit: 'commits', pipeline: 'pipelines', pr: 'prs', deploy: 'deploys',
  app: 'apps', engine: 'engines', queue: 'queues', lane: 'lanes',
};

export function applyOp(state: Snapshot, op: Op): void {
  if (op.op === 'event') return;
  const kind = op.kind as string;
  if (kind === 'watcher') {
    if (op.op === 'upsert') state.watcher = op.v as Snapshot['watcher'];
    return;
  }
  if (kind === 'stats') {
    if (op.op === 'upsert') state.stats = op.v as Snapshot['stats'];
    return;
  }
  const key = COLLECTION[kind];
  if (!key) return;
  const coll = state[key] as Record<string, unknown>;
  if (op.op === 'upsert') coll[op.id] = op.v;
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
