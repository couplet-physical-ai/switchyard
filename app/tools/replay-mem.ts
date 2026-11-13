// Drives the data module (app.ts) in Bun through a live last-hour replay and prints its JS heap,
// to find what grows (the native module has 64 MiB). Run:
//   SWITCHYARD_TOKEN_FILE=~/.config/switchyard/e2e-token bun app/tools/replay-mem.ts "$SWITCHYARD_URL" 60
import { heapStats } from 'bun:jsc';
import { sources, draw } from '../app.ts';

const server = process.argv[2] ?? 'http://127.0.0.1:8092';
const secs = Number(process.argv[3] ?? 30);
const token = process.env.SWITCHYARD_TOKEN_FILE ? (await Bun.file(process.env.SWITCHYARD_TOKEN_FILE.replace(/^~/, process.env.HOME ?? '')).text()).trim() : '';
const mb = () => { Bun.gc(true); return (heapStats().heapSize / 1048576).toFixed(1); };
const call = (name: string, args: unknown[]) => (sources as Record<string, (a: unknown[], s: unknown, st: unknown) => unknown>)[name](args, { get: () => token, set() {} }, {});
const noop = () => {};
const ctx = new Proxy({}, { get: (_t, k) => (k === 'measureText' ? () => ({ width: 7 }) : k === 'canvas' ? { width: 1440, height: 900 } : noop), set: () => true }) as never;
// Bun's fetch has no Exact ceiling: refuse a reply over `exactIndependentHttp.maxResponseBytes`
// as the hosts do, before the app reads it.
const realFetch = globalThis.fetch;
let biggest = 0;
globalThis.fetch = (async (input: string, init?: { exactIndependentHttp?: { maxResponseBytes: number } }) => {
  const r = await realFetch(input, init as RequestInit);
  const body = await r.arrayBuffer();
  const max = init?.exactIndependentHttp?.maxResponseBytes ?? (1 << 20);
  if (body.byteLength > max) throw Object.assign(new Error('Refused: a reply exceeds the response ceiling'), { kind: 'Refused' });
  if (String(input).includes('/history')) biggest = Math.max(biggest, body.byteLength);
  return new Response(body, { status: r.status, headers: r.headers });
}) as typeof fetch;
const epoch0 = Date.now();
let t = 0;
console.log('heap at start', mb(), 'MB');
const conn = await call('connect', [server, token, 1, epoch0, 0]) as { ok: boolean; status: string };
console.log('connect', conn.ok, conn.status, '· heap', mb(), 'MB');
await call('overview', [t]);
const rep = await call('replayHour', [t]) as { ok: boolean; status: string };
console.log('replay', rep.ok, rep.status, '· heap', mb(), 'MB');
const t0 = performance.now();
let n = 0, peak = 0;
while (performance.now() - t0 < secs * 1000) {
  t = performance.now() - t0 + 1;
  // the live canvas at 60 fps, the 250 ms pulse re-asking the overview
  draw('yardLive', ['full', ''], ctx, { time: t, width: 1440, height: 900, dpr: 2 } as never);
  if (n % 15 === 0) await call('overview', [t]);
  if (n % 60 === 0) { Bun.gc(true); peak = Math.max(peak, heapStats().heapSize); }
  if (n % 600 === 0) { const ov = await call('overview', [t]) as { mode: string; behind: string }; console.log(`t=${(t / 1000).toFixed(0)}s ${ov.mode} ${ov.behind} · heap ${mb()} MB`); }
  n++;
  await new Promise((r) => setTimeout(r, 16));
}
console.log('peak heap', (peak / 1048576).toFixed(1), 'MB');
console.log('heap at end', mb(), 'MB · biggest history reply', (biggest / 1048576).toFixed(2), 'MB');
process.exit(0);
