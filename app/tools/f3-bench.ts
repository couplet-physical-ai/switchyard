// The board (Factory 3) against a live stream, as the macOS runner drives it, in Bun: the data
// module's turns per display frame and per tick, to find what holds a frame (p5-board).
//
//   BUN_JSC_useJIT=0 bun tools/f3-bench.ts <server url> [--secs 60] [--size 1440x900] [--top factory]
//
// A small Contract runtime: connect, the stream (a Bun WebSocket handed to `exactStream`), the
// overview at the pulse / the `fed` wake / the ladder's wakes, `rk`, and a 60 Hz frame loop that
// draws f3Board and f3Live when their arguments changed or their last draw asked for another
// frame. Every turn is timed; a frame's work is the turns run in its 16.7 ms slot. Without the
// JIT, Bun's interpreter stands in for Hermes (Hermes is slower still: read the ratios, not the
// absolute numbers).

const args = process.argv.slice(2);
const opt = (n: string, d: string) => (args.includes(n) ? args[args.indexOf(n) + 1]! : d);
const server = args.find((a, i) => !a.startsWith('--') && !(args[i - 1] ?? '').startsWith('--')) ?? 'http://127.0.0.1:8396';
const secs = Number(opt('--secs', '60'));
const [W, H] = opt('--size', '1440x900').split('x').map(Number) as [number, number];
const topName = opt('--top', 'factory');

(globalThis as { scheduler?: unknown }).scheduler = { yield: () => new Promise<void>((r) => setTimeout(r, 0)) };
const { sources, draw } = await import('../app.ts');
// the board's parts, timed (--parts): its draw, paint, transits' departures, the world's frames
if (args.includes('--parts')) {
  const { Board3 } = await import('../src/factory3/board.ts');
  const P = Board3.prototype as unknown as Record<string, (...a: unknown[]) => unknown>;
  for (const m of ['drawBoard0', 'paint', 'depart']) { const f = P[m]!; P[m] = function (this: unknown, ...a: unknown[]) { return timed(`  board.${m}`, () => f.apply(this, a)); }; }
  const { Timeline } = await import('../src/timeline.ts');
  const T = Timeline.prototype as unknown as Record<string, (...a: unknown[]) => unknown>;
  for (const m of ['ingest', 'tick']) { const f = T[m]!; T[m] = function (this: unknown, ...a: unknown[]) { return timed(`  tl.${m}`, () => f.apply(this, a)); }; }
}

type Turn = { at: number; what: string; ms: number };
const turns: Turn[] = [];
const t0 = performance.now();
const now = () => performance.now() - t0;
function timed<T>(what: string, f: () => T): T {
  const s = performance.now();
  try { return f(); } finally { turns.push({ at: s - t0, what, ms: performance.now() - s }); }
}

// ---- the stream: a Bun WebSocket behind `fetch(…, { exactStream })`
let feed = { ok: false, status: 'idle', wake: 0 };
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: string, init?: RequestInit & { exactStream?: (ev: unknown) => typeof feed }) => {
  if (init?.exactStream) {
    const cb = init.exactStream;
    const ws = new WebSocket(String(input));
    ws.onopen = () => { feed = timed('stream open', () => cb({ type: 'open' })); };
    ws.onmessage = (m) => { feed = timed('stream message', () => cb({ type: 'message', data: String(m.data) })); };
    ws.onerror = () => { feed = timed('stream error', () => cb({ type: 'error', kind: 'Network', message: 'error' })); };
    ws.onclose = () => { feed = timed('stream close', () => cb({ type: 'close' })); };
    return new Promise(() => {}); // (Exact's stream answers through the callback)
  }
  return realFetch(input, init);
}) as typeof fetch;

const call = async (name: string, a: unknown[]) => {
  const s = performance.now();
  let v = (sources as Record<string, (a: unknown[], s: unknown, st: unknown) => unknown>)[name]!(a, { get: () => '', set() {} }, {});
  turns.push({ at: s - t0, what: `answer ${name}`, ms: performance.now() - s });
  if (v instanceof Promise) v = await v;
  return v as Record<string, unknown>;
};

const noop = () => {};
const ctx = new Proxy({}, {
  get: (_t, k) => (k === 'measureText' ? (s: string) => ({ width: 6.6 * String(s).length }) : k === 'canvas' ? { width: W, height: H } : k === 'createLinearGradient' || k === 'createRadialGradient' ? () => ({ addColorStop: noop }) : noop),
  set: () => true,
}) as never;

// ---- Contract's state
const epoch0 = Date.now() - performance.now();
let clockMs = 0, ovClock = 0;
const conn = await call('connect', [server, '', 1, epoch0, 0]);
if (!conn.ok) { console.log(`connect: ${conn.status} ${conn.error}`); process.exit(1); }
await call('viewOnTop', [topName]);
void call('liveFeed', [server, '', conn.seq, 1, true]);
let ov = await call('overview', [ovClock = now(), conn.seq, true, topName]);
const tick = async () => { clockMs = ovClock = now(); ov = await call('overview', [ovClock, conn.seq, true, topName]); };
const rk = () => (ov.pace === 1 ? (ov.tick as number) * 1e6 + (Math.floor(clockMs / 1000) % 1e6) : ov.tick);

// the tasks: pulse (pace 0, 250 ms), pulseSec (pace 1, 1 s: the clock only), fed (feed.wake, 250 ms), the wakes
let pulseAt = 0, secAt = 0, fedKey = 0, fedAt = 0, wakeKey = -1, wakeAt = 0;
function tasks(t: number): Promise<void> | void {
  if (feed.wake > 0 && feed.wake !== fedKey) { fedKey = feed.wake; fedAt = t + 250; }
  if (ov.pace !== 0 && ov.wakeKey !== wakeKey) { wakeKey = ov.wakeKey as number; wakeAt = t + (ov.wake as number) * 1000; }
  if (fedAt && t >= fedAt) { fedAt = 0; return tick(); }
  if (ov.pace !== 0 && wakeAt && t >= wakeAt) { wakeAt = 0; return tick(); }
  if (ov.pace === 0) { if (!pulseAt) pulseAt = t + 250; if (t >= pulseAt) { pulseAt = t + 250; return tick(); } } else pulseAt = 0;
  if (ov.pace === 1) { if (!secAt) secAt = t + 1000; if (t >= secAt) { secAt = t + 1000; clockMs = now(); } } else secAt = 0;
}

// ---- frames
let boardKey = '', liveKey = '', boardMore = true, liveMore = true, mounted = true;
const frameWork: { at: number; ms: number; what: string }[] = [];
const end = t0 + secs * 1000;
let frameN = 0;
while (performance.now() < end) {
  const ft = now();
  const n0 = turns.length;
  await tasks(ft);
  const bArgs = ['30m', '', ov.mode, false, false, '', rk()];
  const lArgs = [rk()];
  const fr = (cause: string) => ({ time: ft, width: W, height: H, dpr: 2, scale: 2, pixelWidth: W * 2, pixelHeight: H * 2, mounted: 0, cause, causes: [cause] }) as never;
  const bk = JSON.stringify(bArgs), lk = JSON.stringify(lArgs);
  if (bk !== boardKey || boardMore) { const c = mounted ? 'mount' : bk !== boardKey ? 'args' : 'frame'; boardKey = bk; boardMore = timed('draw f3Board', () => draw('f3Board', bArgs, ctx, fr(c))); }
  if (lk !== liveKey || liveMore) { const c = mounted ? 'mount' : lk !== liveKey ? 'args' : 'frame'; liveKey = lk; liveMore = timed('draw f3Live', () => draw('f3Live', lArgs, ctx, fr(c))); }
  mounted = false;
  frameN++;
  const mine = turns.slice(n0).filter((x) => !x.what.startsWith('  '));
  const ms = mine.reduce((a, b) => a + b.ms, 0);
  if (mine.length) frameWork.push({ at: ft, ms, what: mine.filter((x) => x.ms > 2).map((x) => `${x.what} ${x.ms.toFixed(1)}`).join(', ') });
  // the next display slot (the stream's messages land in between)
  const slot = Math.floor(ft / 16.667) + 1;
  while (now() < slot * 16.667) await new Promise((r) => setTimeout(r, Math.max(1, slot * 16.667 - now())));
}

// ---- report
const by = new Map<string, number[]>();
for (const t of turns) { const a = by.get(t.what) ?? []; a.push(t.ms); by.set(t.what, a); }
const q = (a: number[], p: number) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))] ?? 0; };
console.log(`${secs} s · ${frameN} display slots · ${frameWork.length} with work · JIT ${process.env.BUN_JSC_useJIT === '0' ? 'off' : 'on'}`);
for (const [k, a] of [...by].sort((x, y) => y[1].reduce((p, c) => p + c, 0) - x[1].reduce((p, c) => p + c, 0))) {
  console.log(`  ${k.padEnd(22)} n ${String(a.length).padStart(5)} · p50 ${q(a, 0.5).toFixed(2)} p99 ${q(a, 0.99).toFixed(2)} max ${q(a, 1).toFixed(2)} ms · total ${a.reduce((p, c) => p + c, 0).toFixed(0)} ms`);
}
const fw = frameWork.map((f) => f.ms);
console.log(`frame work: p50 ${q(fw, 0.5).toFixed(2)} p90 ${q(fw, 0.9).toFixed(2)} p99 ${q(fw, 0.99).toFixed(2)} max ${q(fw, 1).toFixed(2)} ms · over 8 ms ${fw.filter((x) => x > 8).length} · over 16 ms ${fw.filter((x) => x > 16).length}`);
for (const f of [...frameWork].sort((a, b) => b.ms - a.ms).slice(0, 12)) console.log(`  ${(f.at / 1000).toFixed(2)} s  ${f.ms.toFixed(1)} ms  ${f.what}`);
const st = (globalThis as { __f3stats?: unknown }).__f3stats;
if (st) console.log(st);
process.exit(0);
