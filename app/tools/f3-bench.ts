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
  const why: Record<string, number> = {};
  (globalThis as { __why?: unknown }).__why = why;
  const paint0 = P.paint!;
  (globalThis as { __paint0?: unknown }).__paint0 = paint0;
  P.paint = function (this: { shown: unknown[] | null; shownAt: string }, ...a: unknown[]) {
    const scene = a[2] as { ops: unknown[] }, fresh = a[4] as boolean;
    const k = fresh ? 'fresh' : !this.shown ? 'first' : this.shown.length !== scene.ops.length ? `count ${scene.ops.length - this.shown.length > 0 ? '+' : ''}${scene.ops.length - this.shown.length}` : 'same count';
    const r = paint0.apply(this, a);
    if (PIX) lastPaint = { scene: a[2], L: a[3], f: a[1], whole: (this as unknown as { stats: { dirty: number } }).stats.dirty === 1 };
    const kk = `${k}: ${(this as unknown as { stats: { dirty: number } }).stats.dirty === 1 ? 'whole' : 'part'}`;
    why[kk] = (why[kk] ?? 0) + 1;
    return r;
  };
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

// --real: the draws go through Exact's own recorder (canvas/recorder.js: the list, base64 and the
// JSON a native draw hands the host), as factory-bench --real does
const REAL = args.includes('--real');
const seam = REAL ? (await import(`${process.env.EXACT2 ?? '/home/farce/src/exact'}/canvas/recorder.js`)).canvasSeam((s: string, a: unknown[], c: unknown, f: unknown) => draw(s, a, c as never, f as never)) : null;
// (with --pixels, each font's advance is the replayer page's own: asked once, then the board re-measures)
const adv = new Map<string, number>(), wanted = new Set<string>();
const measureHost = { measure: (j: string) => { const r = JSON.parse(j); const a = adv.get(r.css); if (a === undefined) wanted.add(r.css); const w = (a ?? 6.6) * String(r.text).length; return JSON.stringify([w, 0, w, 9, 3, 11, 3, 9, 3, 0, 0]); }, image: () => '' };
// --pixels: the board's lists also go to a canvas that keeps them (Exact's web replayer in headless
// Chromium, tools/floorpix.ts), and after each paint a whole repaint of the same scene goes to a
// fresh one: the pixels that differ are counted (the partial repaints' proof)
const PIX = args.includes('--pixels');
const pix = PIX ? await (await import('./floorpix.ts')).openPix('cpu', W, H, 2, process.env.EXACT2 ?? '/home/farce/src/exact') : null;
const pixRuns: { at: number; kind: string; n: number; max: number }[] = [];
let lastPaint: { scene: unknown; L: unknown; f: unknown; whole: boolean } | null = null;
if (pix) await pix.fresh('P');
const listKB: number[] = [];
const lastKB: Record<string, number> = {};
const drawVia = (surface: string, a: unknown[], c: never, f: never): boolean => {
  if (!seam) return draw(surface, a, c, f);
  const out = JSON.parse(seam.draw({ canvas: surface === 'f3Board' ? 1 : 2, generation: 1, surface, args: a, frame: f }, measureHost)) as { lists: string[]; frame: boolean };
  let bytes = 0;
  for (const l of out.lists) bytes += l.length;
  if (bytes) listKB.push((bytes * 0.75) / 1024);
  if (pix && surface === 'f3Board') pix.put('P', out.lists);
  lastKB[surface] = (bytes * 0.75) / 1024;
  return out.frame;
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
let boardKey = '', liveKey = '', boardMore = true, liveMore = true, mounted = true, refont = false;
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
  if (pix && wanted.size && !mounted) {
    const fs = [...wanted]; wanted.clear();
    const a = await pix.advances(fs);
    fs.forEach((f, i) => adv.set(f, a[i]!));
    boardMore = true; refont = true;
  }
  if (bk !== boardKey || boardMore) { const c = mounted ? 'mount' : refont ? 'font' : bk !== boardKey ? 'args' : 'frame'; refont = false; boardKey = bk; boardMore = timed('draw f3Board', () => drawVia('f3Board', bArgs, ctx, fr(c))); }
  if (lk !== liveKey || liveMore) { const c = mounted ? 'mount' : lk !== liveKey ? 'args' : 'frame'; liveKey = lk; liveMore = timed('draw f3Live', () => drawVia('f3Live', lArgs, ctx, fr(c))); }
  mounted = false;
  frameN++;
  if (pix && lastPaint) {
    // the reference: a fresh canvas, the same scene painted whole by a board of its own
    const lp = lastPaint; lastPaint = null;
    const { Board3 } = await import('../src/factory3/board.ts');
    const ref = new Board3();
    const paint0 = (globalThis as { __paint0?: (...a: unknown[]) => void }).__paint0!;
    // (the reference paints the marks in the scene's own order: the words' grouping is checked too)
    const { setGroupWords } = await import('../src/factory3/board.ts');
    const refSeam = (await import(`${process.env.EXACT2 ?? '/home/farce/src/exact'}/canvas/recorder.js`)).canvasSeam((_s: string, _a: unknown[], c: unknown) => { setGroupWords(false); try { paint0.call(ref, c, lp.f, lp.scene, lp.L, true); } finally { setGroupWords(true); } return false; });
    const out = JSON.parse(refSeam.draw({ canvas: 7, generation: 1, surface: 'ref', args: [], frame: lp.f }, measureHost)) as { lists: string[] };
    await pix.fresh('F');
    pix.put('F', out.lists);
    const d = await pix.cmp('P', 'F');
    pixRuns.push({ at: ft, kind: lp.whole ? 'whole' : 'part', n: d.n, max: d.max });
    if (d.n && pixRuns.filter((x) => x.n).length <= 3) await pix.savePng(`/tmp/p5board/pix-${pixRuns.length}.png`, 'P', 'F');
  }
  const mine = turns.slice(n0).filter((x) => !x.what.startsWith('  '));
  const ms = mine.reduce((a, b) => a + b.ms, 0);
  const kb = REAL ? ` · board ${(lastKB.f3Board ?? 0).toFixed(1)} KB, live ${(lastKB.f3Live ?? 0).toFixed(1)} KB` : '';
  if (mine.length) frameWork.push({ at: ft, ms, what: mine.filter((x) => x.ms > 2).map((x) => `${x.what} ${x.ms.toFixed(1)}`).join(', ') + kb });
  lastKB.f3Board = 0; lastKB.f3Live = 0;
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
console.log(`board: ${((sources as unknown as { f3Stats: (a: unknown[]) => { work: string } }).f3Stats([])).work}`);
if (pixRuns.length) {
  const part = pixRuns.filter((x) => x.kind === 'part'), whole = pixRuns.filter((x) => x.kind === 'whole');
  const bad = pixRuns.filter((x) => x.n);
  console.log(`pixels: ${pixRuns.length} board paints compared with a whole repaint of their scene (${part.length} partial, ${whole.length} whole) · ${bad.length} differ${bad.length ? `: ${bad.slice(0, 8).map((x) => `${x.kind} ${x.n} px (max ${x.max})`).join(', ')}` : ''}`);
  await pix!.close();
}
if ((globalThis as { __why?: unknown }).__why) console.log('paints by kind', JSON.stringify((globalThis as { __why?: unknown }).__why));
if (listKB.length) console.log(`lists sent: ${listKB.length} · KB p50 ${q(listKB, 0.5).toFixed(1)} p90 ${q(listKB, 0.9).toFixed(1)} max ${q(listKB, 1).toFixed(1)}`);
process.exit(0);
