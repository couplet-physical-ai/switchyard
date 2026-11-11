// oom: the data module (app.ts) on a live stream for a while, as a session on the factory floor
// runs it, with its JS heap and the size of everything that could accumulate logged every
// `--every` seconds. Finds what grows over a live session (macOS 0.1.3 died of a Hermes OOM after
// ~18 min live: the native data module has a 64 MiB heap).
//
//   bun tools/soak.ts <server url | demo> [--minutes 10] [--every 30] [--real] [--walk]
//       [--rate 1] [--interact] [--json out.json] [--token-file f]
//
// The stream is a real WebSocket (Exact's `exactStream` fetch, emulated). Draws run as the host
// runs them: the floor on a new key and while it asks, the live and top layers every frame while
// they ask, else on the 125 ms pulse; `overview` and `coffeeOpen` on the 250 ms tick; the coffee
// check's visit marks every minute. `--real` draws through Exact's own recorder (its state is in
// the same heap on macOS). `--rate k` runs the module clock k× real time (with a server at
// `--speed k`, an hour of fleet in 60/k minutes with every clock in step). `--walk` adds a census
// of the module's objects by path (src/memlog.ts) and prints what grew. `--interact` hovers and
// clicks the floor now and then (the lenses, the hover card).
import { heapStats } from 'bun:jsc';
import { Census, biggest, grew } from '../src/memlog.ts';

const args = process.argv.slice(2);
const opt = (name: string, def: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] ?? def : def; };
const flag = (name: string) => args.includes(name);
const server = args.find((a, i) => !a.startsWith('--') && !(args[i - 1] ?? '').startsWith('--') ) ?? 'demo';
const MINUTES = Number(opt('--minutes', '10'));
const EVERY = Number(opt('--every', '30'));
const RATE = Number(opt('--rate', '1'));
const W = 1440, H = 842;
const tokenFile = opt('--token-file', '');
const token = tokenFile ? (await Bun.file(tokenFile.replace(/^~/, process.env.HOME ?? '')).text()).trim() : '';

(globalThis as { scheduler?: unknown }).scheduler = { yield: () => new Promise<void>((r) => setTimeout(r, 0)) };

// ---- fetch as Exact's: a reply over its ceiling is refused; `exactStream` is a WebSocket ----
const realFetch = globalThis.fetch;
let streamMsgs = 0, streamBytes = 0, sockets = 0;
let lastFeed: { ok: boolean; status: string } = { ok: false, status: 'idle' };
let openWs: WebSocket | null = null;
globalThis.fetch = (async (input: string, init?: RequestInit & { exactStream?: (ev: unknown) => { ok: boolean; status: string }; exactIndependentHttp?: { maxResponseBytes: number } }) => {
  if (init?.exactStream) {
    const cb = init.exactStream;
    openWs?.close();
    const ws = new WebSocket(String(input));
    openWs = ws;
    sockets++;
    ws.onopen = () => { lastFeed = cb({ type: 'open' }); };
    ws.onmessage = (m) => { if (ws !== openWs) return; streamMsgs++; const d = typeof m.data === 'string' ? m.data : new TextDecoder().decode(m.data as ArrayBuffer); streamBytes += d.length; lastFeed = cb({ type: 'message', data: d }); };
    ws.onerror = () => { if (ws === openWs) lastFeed = cb({ type: 'error', kind: 'Network', message: 'socket error' }); };
    ws.onclose = () => { if (ws === openWs) lastFeed = cb({ type: 'close' }); };
    return new Promise(() => {}); // the stream's answer: its callback's, as it goes
  }
  const r = await realFetch(input, init as RequestInit);
  const body = await r.arrayBuffer();
  const max = init?.exactIndependentHttp?.maxResponseBytes ?? (1 << 20);
  if (body.byteLength > max) throw Object.assign(new Error('Refused: a reply exceeds the response ceiling'), { kind: 'Refused' });
  return new Response(body, { status: r.status, headers: r.headers });
}) as typeof fetch;

// --hermes: the frame budget prices the draws as the macOS data module does (yard/budget.ts), so
// the quality ladder moves as it does there
if (flag('--hermes')) (globalThis as { HermesInternal?: unknown }).HermesInternal = {};
const mod = await import('../app.ts');
const { Factory } = await import('../src/factory/factory.ts');
const { sources, draw: drawRaw } = mod as unknown as { sources: Record<string, (a: unknown[], s?: unknown, st?: unknown, n?: unknown) => unknown>; draw: (s: string, a: unknown[], c: unknown, f: unknown) => boolean };
const memStats = (mod as unknown as { memStats?: () => Record<string, number> }).memStats;
const store = { get: () => '', set() {} };
const call = <T>(name: string, a: unknown[]) => sources[name]!(a, store, {}) as T;

// ---- canvases: a context that records nothing, or Exact's recorder (--real) ----
const noop = () => {};
const nullCtx = new Proxy({}, {
  get: (_t, k) => (k === 'measureText' ? (s: string) => ({ width: 7.2 * String(s).length }) : k === 'canvas' ? { width: W, height: H } : k === 'createLinearGradient' || k === 'createRadialGradient' ? () => ({ addColorStop: noop }) : k === 'getLineDash' ? () => [] : noop),
  set: () => true,
}) as never;
const seam = flag('--real') ? (await import(`${process.env.EXACT2 ?? '/home/farce/src/exact'}/canvas/recorder.js`)).canvasSeam((s: string, a: unknown[], c: unknown, f: unknown) => drawRaw(s, a, c, f)) : null;
const measureHost = { measure: (j: string) => { const r = JSON.parse(j); const w = 7.2 * String(r.text).length; return JSON.stringify([w, 0, w, 9, 3, 11, 3, 9, 3, 0, 0]); }, image: () => '' };
const ids: Record<string, number> = { factoryFloor: 1, factoryLive: 2, factoryTop: 3 };
let listBytes = 0;
// a spike: a draw that takes long or grows the process by much (the macOS OOMs were a draw turn
// going from a 16 MB heap past 64 MiB at once)
let rssWas = process.memoryUsage.rss(), spikes = 0;
const drawTimed = (surface: string, a: unknown[], f: { time: number }): boolean => {
  const t0 = performance.now();
  const more = drawOne(surface, a, f);
  const ms = performance.now() - t0, rss = process.memoryUsage.rss();
  if (ms > 25 || rss - rssWas > (16 << 20)) { spikes++; console.log(`spike: ${surface} ${ms.toFixed(1)} ms · rss ${(rssWas / 1048576).toFixed(0)} → ${(rss / 1048576).toFixed(0)} MB at t=${(f.time / 1000).toFixed(1)} s`); }
  rssWas = rss;
  return more;
};
const draw = drawTimed;
const drawOne = (surface: string, a: unknown[], f: unknown): boolean => {
  if (!seam) return drawRaw(surface, a, nullCtx, f);
  const out = JSON.parse(seam.draw({ canvas: ids[surface], generation: 1, surface, args: a, frame: f }, measureHost)) as { lists: string[]; frame: boolean; error: string | null };
  if (out.error) console.log(`${surface}: ${out.error}`);
  for (const l of out.lists) listBytes += l.length;
  return out.frame;
};

// ---- connect as the app does ----
const t00 = performance.now();
let t = 16;
const now = () => 16 + (performance.now() - t00) * RATE;
if (token) await call('saveToken', [token, true]);
await call('loadToken', [0, '']);
const epoch0 = Date.now();
let conn = await call<{ ok: boolean; status: string; error?: string; seq: number }>('connect', [server, 'v', 1, epoch0, 0]);
if (!conn.ok) { console.error(`connect: ${conn.status} ${conn.error ?? ''}`); process.exit(1); }
call('baselineBind', ['']);
let gen = 1;
const feed = () => { lastFeed = { ok: false, status: 'connecting' }; void call('liveFeed', [server, 'v', conn.seq, gen, true]); };
feed();
if (opt('--quality', '') !== '') { (Factory.last as unknown as { budget: { pinned: number } }).budget.pinned = Number(opt('--quality', '-1')); }

const heapMB = () => { Bun.gc(true); return heapStats().heapSize / 1048576; };
const frame = (time: number, cause: string) => ({ time, mounted: 0, cause, causes: [cause], width: W, height: H, pixelWidth: W * 2, pixelHeight: H * 2, scale: 2, dpr: 2 });
const rows: Record<string, number | string>[] = [];
let census0: Census | null = null, censusPrev: Census | null = null;
const roots = () => ({ factory: Factory.last, tl: (Factory.last as unknown as { tl: unknown }).tl });

let key = '', route = '', tick = -1, pulse = 0, floorAwake = false, liveAwake = true, topAwake = true, frames = 0, nextLog = 0, visits = '', looking = -1, nextMark = 0, resets = 0, calm = true;
let ov: { facKey: string; tick: number; facCalm: boolean; seq: number; mode: string; repos: number } = { facKey: '', tick: 0, facCalm: true, seq: 0, mode: 'live', repos: 0 };
const END = MINUTES * 60_000 * RATE;
const t0 = now();
const log = () => {
  const ms = memStats?.() ?? {};
  const mb = heapMB();
  const w = (Factory.last as unknown as { tl: { world: { commits: Map<string, unknown>; pipelines: Map<string, unknown>; prs: Map<string, unknown>; deploys: Map<string, unknown>; repos: Map<string, unknown> } } }).tl.world;
  const row: Record<string, number | string> = { min: +((t - t0) / 60_000).toFixed(2), heapMB: +mb.toFixed(1), frames, msgs: streamMsgs, streamMB: +(streamBytes / 1048576).toFixed(1), seq: ov.seq, mode: ov.mode, commits: w.commits.size, pipelines: w.pipelines.size, prs: w.prs.size, deploys: w.deploys.size, ...ms };
  rows.push(row);
  console.log(`heap: ${mb.toFixed(1)} MB · frames ${frames} · ${Object.entries(row).filter(([k]) => k !== 'heapMB' && k !== 'frames').map(([k, v]) => `${k} ${v}`).join(' · ')}`);
  if (flag('--walk')) {
    const c = new Census(roots()).run();
    if (!census0) { census0 = c; console.log(`  census: ${c.objects} objects; biggest: ${biggest(c, 12).map((b) => `${b.path} ${b.entries}`).join(', ')}`); }
    else {
      const g = grew(censusPrev!, c, 12), g0 = grew(census0, c, 12);
      console.log(`  census: ${c.objects} objects (${c.objects - census0.objects >= 0 ? '+' : ''}${c.objects - census0.objects} since start)`);
      console.log(`  grew since last: ${g.map((x) => `${x.path} +${x.d}→${x.to}`).join(', ') || '-'}`);
      console.log(`  grew since start: ${g0.map((x) => `${x.path} +${x.d}→${x.to}`).join(', ') || '-'}`);
    }
    censusPrev = c;
  }
};

const interact = flag('--interact');
let nextPoke = 5000, poke = 0;
while ((t = now()) - t0 < END) {
  const f0 = performance.now();
  // the 250 ms tick: overview (advance, the plant's and the city's fetches), coffeeOpen
  const tk = Math.floor(t / 250);
  if (tk !== tick) {
    tick = tk;
    ov = call('overview', [t, conn.seq, true]);
    calm = ov.facCalm;
    call('coffeeOpen', [server, visits, conn.seq, true, ov.tick]);
    if (ov.facKey !== key) { key = ov.facKey; floorAwake = draw('factoryFloor', [key, route, 0], frame(t, frames ? 'args' : 'mount')); }
    if (lastFeed.status === 'reset' || lastFeed.status === 'closed' || lastFeed.status === 'error') {
      // Contract's resync / reconnect: a new connect (gen), then the stream from its seq
      resets++;
      gen++;
      conn = await call('connect', [server, 'v', gen, epoch0, 0]);
      if (conn.ok) feed();
    }
  }
  if (floorAwake) floorAwake = draw('factoryFloor', [key, route, 0], frame(t, 'frame'));
  const p = Math.floor(t / 125);
  const woken = calm && p !== pulse;
  pulse = p;
  if (liveAwake || woken) liveAwake = draw('factoryLive', ['full', route, 0, p], frame(t, liveAwake ? 'frame' : 'args'));
  if (topAwake || woken) topAwake = draw('factoryTop', ['full', route, 0, p], frame(t, topAwake ? 'frame' : 'args'));
  frames++;
  // the coffee check's visit: marked once 20 s of looking count, every minute after
  if (looking < 0 && t - t0 > 20_000) { looking = t; nextMark = t; }
  if (looking >= 0 && t >= nextMark) {
    nextMark = t + 60_000;
    const v = call<{ ok: boolean; status: string }>('coffeeMark', [server, visits]);
    if (v.ok) visits = v.status;
    call('baselineSave', []);
  }
  if (interact && t - t0 > nextPoke) {
    // a hover somewhere on the floor, now and then a press (a lens), then Escape out of it
    nextPoke = t - t0 + 3000;
    poke++;
    const x = 120 + ((poke * 397) % (W - 240)), y = 120 + ((poke * 251) % (H - 240));
    const h = call<{ route: string }>('facPointer', ['move', x, y, 0]);
    if (poke % 4 === 0) { call('facPointer', ['down', x, y, 1]); const u = call<{ route: string }>('facPointer', ['up', x, y, 0]); route = u.route; }
    else if (poke % 4 === 2) { const e = call<{ route: string }>('facPointer', ['key:Escape', 0, 0, 0]); route = e.route; }
    else route = h.route;
  }
  if (t - t0 >= nextLog) { nextLog += EVERY * 1000 * RATE; log(); }
  // ~60 frames a second of real time
  const spent = performance.now() - f0;
  await Bun.sleep(Math.max(1, 1000 / 60 - spent));
}
log();
const first = rows[0]!, last = rows.at(-1)!;
const hrs = (Number(last.min) - Number(first.min)) / 60;
console.log(`soak: ${(Number(last.min)).toFixed(1)} min · heap ${first.heapMB} → ${last.heapMB} MB (${((Number(last.heapMB) - Number(first.heapMB)) / Math.max(1e-9, hrs)).toFixed(1)} MB/h of module clock) · ${frames} frames · ${streamMsgs} stream messages · ${resets} reconnects · ${listBytes ? `${(listBytes / 1048576).toFixed(0)} MB of lists` : ''}`);
if (opt('--json', '')) await Bun.write(opt('--json', ''), JSON.stringify(rows, null, 1));
openWs?.close();
process.exit(0);
