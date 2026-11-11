// The day replay (fx-day), measured: drives the data module (app.ts) in Bun through "24 h in 2 min"
// against a server, at real time, with the factory's layers drawn at ~60 fps and the 250 ms pulse
// asking the overview, as the app runs it. Prints the streaming (requests, bytes over the wire,
// refusals, jumps, the waits and the real time from start to end) and the JS heap (peak), and
// fails when the playhead stalled longer than --max-stall ms in all or the heap passed --max-heap MB.
//   bun app/tools/replay-day.ts http://127.0.0.1:8131 [--max-stall 5000] [--max-heap 60]
//   (the live server through tools/live-proxy.ts, which adds the token; or demo, or a local server;
//   SWITCHYARD_TOKEN_FILE for a server that wants one directly)
// Bun's fetch has no Exact ceiling: a reply over `exactIndependentHttp.maxResponseBytes` is refused
// as the hosts do, before the app reads it (here after it arrived: its bytes count as fetched).
import { heapStats } from 'bun:jsc';

const args = process.argv.slice(2);
const opt = (k: string, d: number) => (args.includes(k) ? Number(args[args.indexOf(k) + 1]) : d);
const server = args.find((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--')) ?? 'demo';
const maxStall = opt('--max-stall', Infinity), maxHeap = opt('--max-heap', Infinity), cap = opt('--secs', 200);
const token = process.env.SWITCHYARD_TOKEN_FILE ? (await Bun.file(process.env.SWITCHYARD_TOKEN_FILE.replace(/^~/, process.env.HOME ?? '')).text()).trim() : '';
const mb = (b: number) => (b / 1048576).toFixed(1);
const heap = () => { Bun.gc(true); return heapStats().heapSize; };

const realFetch = globalThis.fetch;
const wire = { requests: 0, bytes: 0, refused: 0, snapshots: 0, snapBytes: 0, history: 0, histBytes: 0 };
globalThis.fetch = (async (input: string, init?: RequestInit & { exactIndependentHttp?: { maxResponseBytes: number }; exactStream?: unknown }) => {
  if (init?.exactStream) return new Response('', { status: 200 }); // the live stream: not this tool's
  const r = await realFetch(input, init as RequestInit);
  const body = await r.arrayBuffer();
  const url = String(input);
  // (a refused reply: the hosts read up to the ceiling and cancel the rest)
  wire.requests++; wire.bytes += Math.min(body.byteLength, init?.exactIndependentHttp?.maxResponseBytes ?? Infinity);
  if (url.includes("/api/v1/history?")) { wire.history++; wire.histBytes += Math.min(body.byteLength, init?.exactIndependentHttp?.maxResponseBytes ?? Infinity); if (process.env.DBG) { const m = /from=(\d+)&to=(\d+)/.exec(url); if (m) log0(`  hist ${new Date(+m[1]).toISOString().slice(11, 19)} +${((+m[2] - +m[1]) / 60000).toFixed(1)} min ${(body.byteLength / 1024).toFixed(0)} KB at ${(now() / 1000).toFixed(1)} s ${+m[2] - +m[1] < 60000 ? `${url.replace(/^.*\?/, "")} → ${new TextDecoder().decode(body.slice(0, 70))}` : ""}`); } }
  if (url.includes('/snapshot?at=')) { wire.snapshots++; wire.snapBytes += body.byteLength; }
  const max = init?.exactIndependentHttp?.maxResponseBytes ?? (1 << 20);
  if (body.byteLength > max) { wire.refused++; throw Object.assign(new Error('Refused: a reply exceeds the response ceiling'), { kind: 'Refused' }); }
  return new Response(body, { status: r.status, headers: r.headers });
}) as typeof fetch;
const logs: string[] = [];
const log0 = console.log;
console.log = (...a: unknown[]) => { const s = a.join(' '); if (s.startsWith('replay:')) { logs.push(s); log0(s); } };

const { sources, draw } = await import('../app.ts');
const call = (name: string, a: unknown[]) => (sources as Record<string, (a: unknown[], s: unknown, st: unknown) => unknown>)[name](a, { get: () => token, set() {} }, {});
const noop = () => {};
const ctx = new Proxy({}, {
  get: (_t, k) => (k === 'measureText' ? (s: string) => ({ width: 7.2 * String(s).length }) : k === 'canvas' ? { width: 1440, height: 900 } : k === 'createLinearGradient' || k === 'createRadialGradient' ? () => ({ addColorStop: noop }) : noop),
  set: () => true,
}) as never;
const frame = (t: number) => ({ time: t, width: 1440, height: 900, dpr: 1, scale: 1, pixelWidth: 1440, pixelHeight: 900, mounted: 0, cause: 'frame', causes: ['frame'] }) as never;

const t0 = performance.now();
const now = () => performance.now() - t0 + 1;
const conn = (await call('connect', [server, token ? 'v' : '', 1, Date.now() - now(), 0])) as { ok: boolean; status: string; error: string };
if (!conn.ok) { log0('connect failed', conn.status, conn.error); process.exit(1); }
// draw times per frame (the floor and the live layer, Bun), live first, then in the replay
const pct = (xs: number[], q: number) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(q * s.length))]! : 0; };
const drawn = (xs: number[]) => `p50 ${pct(xs, 0.5).toFixed(2)} · p99 ${pct(xs, 0.99).toFixed(2)} · max ${pct(xs, 1).toFixed(2)} ms (${xs.length} frames)`;
const pair = (n: number, into: number[]) => { const a = performance.now(); draw('factoryFloor', ['', '', 0], ctx, frame(now())); draw('factoryLive', ['full', '', 0, n], ctx, frame(now())); into.push(performance.now() - a); };
const liveDraws: number[] = [];
{ let last0 = 0; for (let i = 0; i < 600; i++) { if (now() - last0 >= 250) { last0 = now(); await call('overview', [now()]); } pair(i, i > 120 ? liveDraws : []); await Bun.sleep(16); } }
const before = heap();
log0(`connected (${conn.status}) · heap ${mb(before)} MB`);
const ts = performance.now();
const rep = (await call(args.includes('--hour') ? 'replayHour' : 'replayDay', [now()])) as { ok: boolean; status: string };
log0(`replayDay ${rep.ok ? 'ok' : 'failed'} at ${rep.status}× · ${(performance.now() - ts).toFixed(0)} ms to start`);
if (!rep.ok) process.exit(1);
let peak = 0, n = 0, mode = 'replay', last = 0, worstDraw = 0, worstAnswer = 0;
const replayDraws: number[] = [];
while (performance.now() - ts < cap * 1000) {
  pair(n, replayDraws);
  worstDraw = Math.max(worstDraw, replayDraws[replayDraws.length - 1]!);
  if (now() - last >= 250) {
    last = now();
    const b = performance.now();
    const ov = (await call('overview', [now()])) as { mode: string; dial: string; sentence: string };
    worstAnswer = Math.max(worstAnswer, performance.now() - b);
    mode = ov.mode;
    if (n % 300 === 0) log0(`t=${((performance.now() - ts) / 1000).toFixed(0)}s ${ov.mode} · ${ov.dial} · ${ov.sentence} · heap ${mb(heapStats().heapSize)} MB`);
    if (mode === 'live') break;
  }
  if (n % 60 === 0) peak = Math.max(peak, heap());
  n++;
  await Bun.sleep(16);
}
for (let i = 0; i < 4; i++) { await call('overview', [now()]); await Bun.sleep(260); }
peak = Math.max(peak, heap());
log0(`ended ${mode} after ${((performance.now() - ts) / 1000).toFixed(1)} s · wire: ${wire.requests} requests, ${mb(wire.bytes)} MB (history ${wire.history} = ${mb(wire.histBytes)} MB, ${wire.refused} refused; snapshots at= ${wire.snapshots} = ${mb(wire.snapBytes)} MB)`);
log0(`heap: before ${mb(before)} MB · peak ${mb(peak)} MB (Bun, after GC) · worst overview ${worstAnswer.toFixed(1)} ms`);
log0(`draws (floor + live layer, a frame): live ${drawn(liveDraws)} · in the replay ${drawn(replayDraws)}`);
const end = logs.find((s) => / ended after| left after/.test(s));
const stall = end ? Number(/(\d+) stalls?, (\d+) ms/.exec(end)?.[2] ?? 0) : Infinity;
if (mode !== 'live' || stall > maxStall || peak / 1048576 > maxHeap) { log0(`FAIL: ${mode !== 'live' ? 'not back to live' : stall > maxStall ? `stalled ${stall} ms > ${maxStall}` : `heap ${mb(peak)} MB > ${maxHeap}`}`); process.exit(1); }
process.exit(0);
