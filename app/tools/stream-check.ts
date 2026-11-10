// Proves the client's World follows a real server exactly: load /api/v1/snapshot, apply the
// WebSocket stream (upsert/patch/dot/remove) for N seconds, then compare every entity with a
// fresh snapshot at the same seq. Run: bun app/tools/stream-check.ts http://127.0.0.1:8092 90
import { World } from '../src/world.ts';
import type { Snapshot } from '../src/wire.ts';

const base = process.argv[2] ?? 'http://127.0.0.1:8090';
const secs = Number(process.argv[3] ?? 60);
const get = async (p: string) => (await fetch(base + p)).json();
const w = new World();
w.load(await get('/api/v1/snapshot') as Snapshot);
console.log(`snapshot seq ${w.seq} · ${w.repos.size} repos · protocol ${w.protocol}`);
const counts: Record<string, number> = {};
let bytes = 0, frames = 0, buffering = false;
const held: { seq: number; f: unknown }[] = [];
const take = (f: { seq?: number; t: string; ops?: { op: string }[] }) => {
  frames++;
  for (const op of f.ops ?? []) counts[op.op] = (counts[op.op] ?? 0) + 1;
  if (!w.apply(f as never)) { console.log('reset/gap at', f.seq); process.exit(2); }
};
const ws = new WebSocket(base.replace(/^http/, 'ws') + `/api/v1/stream?since=${w.seq}`);
ws.onmessage = (m) => {
  const text = String(m.data);
  bytes += text.length;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    const f = JSON.parse(line);
    if (buffering) held.push({ seq: f.seq ?? 0, f }); else take(f);
  }
};
await new Promise((r) => setTimeout(r, secs * 1000));
// Hold the stream, take a snapshot, then apply the held frames up to the snapshot's seq.
buffering = true;
await new Promise((r) => setTimeout(r, 1500)); // the snapshot is refreshed at most every second
const snap = await get('/api/v1/snapshot') as Snapshot;
const deadline = Date.now() + 8000;
while (w.seq < snap.seq && Date.now() < deadline) {
  while (held.length && held[0].seq <= snap.seq) take(held.shift()!.f as never);
  if (w.seq < snap.seq) await new Promise((r) => setTimeout(r, 200));
}
ws.close();
console.log(`streamed ${frames} frames, ${(bytes / 1e6).toFixed(2)} MB in ${secs}s · ops ${JSON.stringify(counts)} · world seq ${w.seq} · snapshot seq ${snap.seq}`);
if (snap.seq !== w.seq) { console.log('the world never reached the snapshot seq (merged frames?); rerun'); process.exit(3); }
const ref = new World();
ref.load(snap);
let bad = 0;
const norm = (v: unknown) => JSON.stringify(v, (_k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => a.localeCompare(b))) : x));
for (const k of ['orgs', 'repos', 'commits', 'pipelines', 'prs', 'deploys', 'apps', 'engines', 'queues', 'lanes'] as const) {
  const a = w[k] as Map<string, unknown>, b = ref[k] as Map<string, unknown>;
  for (const [id, v] of b) if (norm(a.get(id)) !== norm(v)) { if (bad++ < 5) console.log(`DIFF ${k} ${id}\n client ${norm(a.get(id)).slice(0, 400)}\n server ${norm(v).slice(0, 400)}`); }
  for (const id of a.keys()) if (!b.has(id)) { if (bad++ < 5) console.log(`EXTRA ${k} ${id}`); }
}
console.log(bad ? `FAIL: ${bad} entities differ` : 'OK: the world equals the server snapshot');
process.exit(bad ? 1 : 0);
