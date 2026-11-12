// Stale state (Felipe's phantoms, Nov 12): what the stream says replaces or removes, everywhere.
//   bun app/tools/stale.test.ts
//
// 1. An `upsert` REPLACES the entity: a Woodpecker number the server reuses (a phantom
//    wp:<repo>:65 left waiting, then the real PR #99 run under the same id) keeps none of the
//    phantom's fields (state, created, event, pr, workflows, finished…), in the world and in
//    every view that reads it: Live's job panel and rows, the board's berths, the Yard's slots.
// 2. A `remove` takes it out of every view: Live's rows and its waiting count, the board's
//    waiting line (the intake) and berths, the Yard's busy slots, even while an engine's
//    `running` list or the queue's `items` still name it (the server may patch those later).
import { readFileSync } from 'node:fs';
import { World } from '../src/world.ts';
import type { Frame as WireFrame, Pipeline, Snapshot } from '../src/wire.ts';
import { flowJob, flowOf } from '../src/flow/model.ts';
import { SlotBook, boardOf, windowMs } from '../src/factory3/model.ts';
import { buildingIds } from '../src/yard/select.ts';

let fails = 0;
const ok = (c: unknown, m: string) => { if (c) console.log('ok  ', m); else { fails++; console.log('FAIL', m); } };
const eq = (a: unknown, b: unknown, m: string) => {
  const x = JSON.stringify(a), y = JSON.stringify(b);
  if (x === y) console.log('ok  ', m); else { fails++; console.log('FAIL', m, x, '!=', y); }
};
const here = new URL('.', import.meta.url).pathname;
const snap = JSON.parse(readFileSync(`${here}../../contract/fixtures/snapshot.json`, 'utf8')) as Snapshot & { at: number };
const now = snap.at;
const agent = snap.engines.find((e) => e.kind === 'wp_agent')!;
const repo = snap.repos[0].id;
const ID = `wp:${repo}:65`;
const allText = (v: unknown) => JSON.stringify(v);

const phantom: Pipeline = {
  id: ID, lane: 'roadrunner', repo, number: 65, sha: 'a'.repeat(40), branch: 'phantom-branch', event: 'push',
  state: 'pending', created: now - 3 * 3600_000, queue_pos: 1, expected_ms: 999_000, title: 'PHANTOM title', author: 'ghost',
  pr: 12, deploy: true, flaky: true, finished: now - 3600_000,
  workflows: [{ name: 'phantom-wf', state: 'pending', steps: [{ name: 'phantom-step', state: 'pending' }] }],
  url: 'https://phantom.example/65',
} as unknown as Pipeline;
const real: Pipeline = {
  id: ID, lane: 'roadrunner', repo, number: 65, sha: 'b'.repeat(40), branch: 'feature-99', event: 'pull_request',
  state: 'running', created: now - 60_000, started: now - 50_000, engine: agent.label ?? agent.id, title: 'Real PR 99', author: 'felipe',
  pr: 99, workflows: [{ name: 'test', state: 'running', started: now - 50_000, steps: [{ name: 'build', state: 'running', started: now - 50_000 }] }],
  url: 'https://ci.example/65',
} as unknown as Pipeline;

let seq = snap.seq;
const frame = (ops: unknown[]): WireFrame => ({ t: 'delta', seq: ++seq, at: now, ops } as unknown as WireFrame);
const w = new World();
w.load(JSON.parse(JSON.stringify(snap)) as Snapshot);
const q0 = Array.from(w.queues.values())[0];
const board = () => boardOf(w, now, windowMs('30m'), new SlotBook());

// ---- the phantom, waiting in the queue ----
ok(w.apply(frame([
  { op: 'upsert', kind: 'pipeline', id: ID, v: phantom },
  { op: 'patch', kind: 'queue', id: q0.id, v: { items: [ID, ...q0.items], pending: q0.pending + 1 } },
])), 'the phantom applies');
ok(allText(flowOf(w, now)).includes('PHANTOM') || board().waiting.items.some((r) => allText(r).includes(ID)), 'the phantom shows (Live or the board\'s waiting line)');

const busy0 = board().busy;
// ---- 1. the real run upserts under the same id: a replace, not a merge ----
ok(w.apply(frame([
  { op: 'upsert', kind: 'pipeline', id: ID, v: real },
  { op: 'patch', kind: 'queue', id: q0.id, v: { items: q0.items, pending: q0.pending } },
  { op: 'patch', kind: 'engine', id: agent.id, v: { running: [...agent.running, ID], busy: agent.busy + 1 } },
])), 'the real run applies');
eq(w.pipelines.get(ID), real, 'upsert: the world holds exactly the real run (no phantom field kept)');
const held = w.pipelines.get(ID) as unknown as Record<string, unknown>;
for (const f of ['finished', 'queue_pos', 'expected_ms', 'deploy', 'flaky']) ok(!(f in held), `upsert: no stale '${f}'`);
const job = flowJob(w, ID, now);
ok(job != null, 'Live: the job panel finds the run');
const jt = allText(job);
ok(!/PHANTOM|phantom-wf|phantom-step|phantom-branch|ghost/.test(jt), 'Live: the open job panel shows nothing of the phantom');
ok(/Real PR 99|feature-99/.test(jt), 'Live: the open job panel shows the real run');
ok(!/PHANTOM|phantom-wf|phantom-branch/.test(allText(flowOf(w, now))), 'Live: no row shows the phantom');
const b1 = board();
ok(!b1.waiting.items.some((r) => allText(r).includes(ID)), 'board: the run is not in the waiting line');
ok(b1.where.has(ID), 'board: the run sits in a berth');
eq(b1.busy, busy0 + 1, 'board: the run takes one berth');
ok(buildingIds(w).has(ID), 'Yard: the run holds a busy slot');

// ---- 2. remove: gone everywhere, though the engine still names it ----
const hostOfAgent = () => flowOf(w, now).machines.find((m) => m.host === (agent.host ?? '') || m.label === (agent.host ?? ''));
const busyWith = hostOfAgent()?.busy ?? -1;
ok(w.apply(frame([{ op: 'remove', kind: 'pipeline', id: ID }])), 'the remove applies');
ok(!w.pipelines.has(ID), 'remove: the world drops it');
ok(Array.from(w.engines.get(agent.id)!.running).includes(ID), '(the engine\'s running list still names it: the server patches that separately)');
ok(flowJob(w, ID, now) == null, 'Live: an open job panel on it finds nothing');
const fv = flowOf(w, now);
ok(!allText(fv.events).includes(ID) && !/Real PR 99/.test(allText(fv)), 'Live: no row shows it');
const b2 = board();
ok(!b2.where.has(ID), 'board: no berth holds it');
ok(!b2.waiting.items.some((r) => allText(r).includes(ID)), 'board: the waiting line (intake) does not count it');
ok(!buildingIds(w).has(ID), 'Yard: no busy slot for it');
eq(b2.busy, busy0, 'board: removed, its berth is free again');
if (agent.host) eq(hostOfAgent()?.busy, busyWith - 1, `Live: its machine's busy drops by the removed run (${busyWith} → ${hostOfAgent()?.busy}), though the engine still names it`);

// ---- 2b. the phantom removed while still queued: the intake counts it no longer ----
const ID2 = `wp:${repo}:66`;
const base = board().waiting.total;
w.apply(frame([
  { op: 'upsert', kind: 'pipeline', id: ID2, v: { ...phantom, id: ID2, number: 66 } },
  { op: 'patch', kind: 'queue', id: q0.id, v: { items: [ID2, ...q0.items], pending: q0.pending + 1 } },
]));
const before = board().waiting.total;
w.apply(frame([{ op: 'remove', kind: 'pipeline', id: ID2 }]));
const after = board();
ok(!after.waiting.items.some((r) => allText(r).includes(ID2)), 'board: a removed queued run leaves the waiting line, though the queue\'s items still name it');
eq(before, base + 1, `board: the queued phantom counts in the intake (${base} → ${before})`);
eq(after.waiting.total, base, `board: removed, it counts no longer, though the queue's items and pending still do (${before} → ${after.waiting.total})`);
ok(!/PHANTOM/.test(allText(flowOf(w, now))), 'Live: no row shows the removed queued phantom');

if (fails) { console.log(`${fails} failed`); process.exit(1); }
console.log('stale: ok');
