// Live's retained heap, headless: drives the REAL data module (app.ts) in Bun against a live
// server the way the Mac's Live tab does (app.contract + views/now.contract), and samples the
// POST-GC heap (Bun.gc(true) + bun:jsc heapStats) every 30 s, with the object types that grew
// since the first sample. It settles whether Live's heap creeps or the Mac's slopes (Hermes's
// js_allocatedBytes, which counts garbage) are the GC sawtooth.
//
//   bun tools/live-heap.ts [--server URL] [--min 60] [--no-live] [--out FILE] [--every 30] [--snap] [--no-token]
//   bun tools/live-heap.ts --server demo --sim --min 480 --every 600 [--no-live]   (8 h of the demo fleet, virtual clock)
//
// What it asks, as Contract would with Live on top:
//   conn = connect(server, tok.ver, gen)            once, and again on a reset / failed connect
//   feed = liveFeed(server, tok.ver, conn.seq, gen, conn.ok, fgen)
//          (Exact's streaming fetch, shimmed with a real WebSocket: open / message / error / close)
//   ov   = overview(ovClock, conn.seq, conn.ok, 'now')   at every tick (the clock's ticks that ask it)
//   nowData     = nowFeed(ov.tick, '', '', '')      when ov.tick moves          (Live's)
//   nowTickData = nowTick(floor(clockMs/1000), nowFed, clockMs)  when clockMs moves (Live's)
// and the tasks that move the clock: pulse (pace 0, 250 ms), pulseSec (pace 1, 1 s, clockMs
// only), fed (a stream frame: a tick 250 ms later), the wake ladder (ov.wake s after each
// overview), nowFedTake (1 ms), and resync / reconnect / steady (the stream's ladder).
// --no-live: Live's own sources are never asked (the stream, the world and the overview only).
//
// The token: SWITCHYARD_TOKEN_FILE or ~/.config/switchyard/e2e-token. It is read here, handed to
// the module through its saveToken source (no native module: this session only), and never
// printed, put in argv, or logged (the stream's URL carries it: never logged either).
import { heapStats } from 'bun:jsc';
import { generateHeapSnapshot } from 'bun';
import { sources } from '../app.ts';

const argv = process.argv.slice(2);
const flag = (k: string) => argv.includes(k);
const opt = (k: string, d: string) => { const i = argv.indexOf(k); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const SERVER = opt('--server', 'https://switchyard.apps.example.com');
const MINUTES = Number(opt('--min', '60'));
const LIVE = !flag('--no-live');
const OUT = opt('--out', `/tmp/live-heap-${LIVE ? 'live' : 'nolive'}-${Date.now()}.jsonl`);
const SAMPLE_MS = Number(opt('--every', '30')) * 1000;
const home = process.env.HOME ?? '';
const tokenPath = (process.env.SWITCHYARD_TOKEN_FILE ?? `${home}/.config/switchyard/e2e-token`).replace(/^~/, home);
// (--no-token: a local server in open auth, e.g. `switchyard-server --demo --speed 10 --auth open`)
const TOKEN = flag('--no-token') ? '' : (await Bun.file(tokenPath).text()).trim();
if (!TOKEN && !flag('--no-token')) throw new Error(`no token in ${tokenPath}`);

type Fn = (a: unknown[], s: unknown, st: unknown, n?: unknown) => unknown;
const store = { get: () => '', set() {} };
const ask = (name: string, args: unknown[]) => (sources as unknown as Record<string, Fn>)[name](args, store, {}, undefined);
// --sim: the built-in demo fleet (--server demo) on a virtual clock, hours of it in minutes: no
// timers, a 250 ms tick (the demo's pulse, ov.pace 0) at a time, the module's async turns let land
// between (a leak test of the module's own paths, independent of a live fleet's workday). The
// demo's simulation keeps a day of commits, so its world grows for 24 h, Live or not: read Live's
// share against a --no-live run.
const SIM = flag('--sim');
let virt = 0;
const now = () => (SIM ? virt : performance.now());
const log = (s: string) => console.log(`[${(now() / 60_000).toFixed(1).padStart(5)} min] ${s}`);

// ---- Exact's streaming fetch, in Bun: a real WebSocket to the same URL ----------------------
type StreamEv = { type: 'open' } | { type: 'message'; data: string } | { type: 'error'; kind: string; message: string } | { type: 'close'; code?: number };
type Mapper = (ev: StreamEv) => unknown;
let sock: WebSocket | null = null;
let onStream: ((answer: unknown) => void) | null = null;
const stats = { frames: 0, bytes: 0, opens: 0, closes: 0, errors: 0, connects: 0, overviews: 0, feeds: 0, ticks: 0, panels: 0, ovBytes: 0, feedBytes: 0, tickBytes: 0 };
const realFetch = globalThis.fetch;
globalThis.fetch = ((input: string | URL, init?: { exactStream?: Mapper; exactIndependentHttp?: { maxResponseBytes: number } }) => {
  if (!init?.exactStream) {
    // the hosts refuse a reply over its ceiling before the app reads it (replay-mem.ts)
    return (async () => {
      const r = await realFetch(input, init as RequestInit);
      const body = await r.arrayBuffer();
      const max = init?.exactIndependentHttp?.maxResponseBytes ?? (1 << 20);
      if (body.byteLength > max) throw Object.assign(new Error('Refused: a reply exceeds the response ceiling'), { kind: 'Refused' });
      return new Response(body, { status: r.status, headers: r.headers });
    })();
  }
  // A resource's stream: Exact lets the previous one go when the resource is asked again.
  const map = init.exactStream;
  if (sock) { const s = sock; sock = null; try { s.close(); } catch { /* gone */ } }
  const ws = new WebSocket(String(input));
  sock = ws;
  let first: ((v: unknown) => void) | null = null;
  const firstAnswer = new Promise((res) => { first = res; });
  const deliver = (ev: StreamEv) => {
    if (sock !== ws) return; // let go
    const a = map(ev);
    if (first) { const f = first; first = null; f(a); } else onStream?.(a);
  };
  let ended = false;
  ws.onopen = () => { stats.opens++; deliver({ type: 'open' }); };
  ws.onmessage = (m) => {
    const data = typeof m.data === 'string' ? m.data : new TextDecoder().decode(m.data as ArrayBuffer);
    stats.frames++; stats.bytes += data.length;
    deliver({ type: 'message', data });
  };
  ws.onerror = () => { if (ended) return; ended = true; stats.errors++; deliver({ type: 'error', kind: 'Network', message: 'the stream failed' }); };
  ws.onclose = (c) => { if (ended) return; ended = true; stats.closes++; deliver({ type: 'close', code: c.code }); };
  return firstAnswer;
}) as typeof fetch;

// ---- the slice of Contract that Live on top runs --------------------------------------------
type Conn = { ok: boolean; status: string; seq: number; error?: string };
type Feed = { ok: boolean; status: string; wake: number };
type Ov = { pace: number; tick: number; wake: number; wakeKey: number; mode: string; sentence: string; seq: number; status: string };
type NowData = { ok: boolean; tick: number; earlier?: unknown[] };
let clockMs = 0, ovClock = 0, gen = 0, fgen = 0, retries = 0, nowFed = 0;
let ver = '';
let conn: Conn = { ok: false, status: 'connecting', seq: 0 };
let feed: Feed = { ok: false, status: 'idle', wake: 0 };
let ov: Ov = { pace: 2, tick: 0, wake: 0, wakeKey: 0, mode: 'live', sentence: '', seq: 0, status: '' };
let nowData: NowData = { ok: false, tick: 0 };
const asked: Record<string, string> = {};
/** one per resource: an answer that lands after a newer ask is let go */
const askSeq: Record<string, number> = {};
const changed = (name: string, key: string) => { if (asked[name] === key) return false; asked[name] = key; return true; };
const size = (v: unknown) => { try { return JSON.stringify(v)?.length ?? 0; } catch { return 0; } };
function land<T>(name: string, v: unknown, set: (a: T) => void): void {
  const mine = askSeq[name] = (askSeq[name] ?? 0) + 1;
  if (v instanceof Promise) v.then((a) => { if (askSeq[name] === mine) { set(a as T); commit(); } }, (e) => log(`${name} failed: ${e}`));
  else set(v as T);
}

let committing = false, again = false;
function commit(): void {
  if (committing) { again = true; return; }
  committing = true;
  try {
    do { again = false; settle(); tasks(); } while (again);
  } finally { committing = false; }
}

function settle(): void {
  if (changed('conn', `${ver}|${gen}`)) {
    stats.connects++;
    land<Conn>('conn', ask('connect', [SERVER, ver, gen, Date.now() - now(), -new Date().getTimezoneOffset(), false]), (a) => {
      conn = a;
      log(`connect ${a.ok ? 'ok' : 'failed'}: ${a.status}${a.ok ? '' : ` ${a.error ?? ''}`} (seq ${a.seq})`);
    });
  }
  if (changed('feed', `${ver}|${conn.seq}|${gen}|${conn.ok}|${fgen}`)) {
    land<Feed>('feed', ask('liveFeed', [SERVER, ver, conn.seq, gen, conn.ok, fgen]), (a) => { feed = a; });
  }
  if (changed('ov', `${ovClock}|${conn.seq}|${conn.ok}|now`)) {
    stats.overviews++;
    const a = ask('overview', [ovClock, conn.seq, conn.ok, 'now']) as Ov;
    stats.ovBytes += size(a);
    ov = a;
  }
  if (!LIVE) return;
  if (changed('nowFeed', `${ov.tick}`)) {
    stats.feeds++;
    land<NowData>('nowFeed', ask('nowFeed', [ov.tick, '', '', '']), (a) => { stats.feedBytes += size(a); nowData = a; });
  }
  const sec = Math.floor(clockMs / 1000);
  if (changed('nowTick', `${sec}|${nowFed}|${clockMs}`)) {
    stats.ticks++;
    const a = ask('nowTick', [sec, nowFed, clockMs]);
    stats.tickBytes += size(a);
  }
  // nothing selected: asked once, as Contract asks them with Live mounted
  if (changed('nowPanel', '|0|0')) { stats.panels++; ask('nowPanel', ['', 0, 0]); ask('nowLog', ['', '', '', 0, false, false]); }
}

// tasks: `when` + key → one timer; a new key (or the condition coming back) restarts it
const timers = new Map<string, { key: string; h: ReturnType<typeof setTimeout>; every: boolean; fired: boolean }>();
function task(name: string, on: boolean, key: string, ms: number, fn: () => void, every = false): void {
  const t = timers.get(name);
  if (!on) { if (t) { (t.every ? clearInterval : clearTimeout)(t.h); timers.delete(name); } return; }
  if (t && t.key === key) return;
  if (t) (t.every ? clearInterval : clearTimeout)(t.h);
  const h = every ? setInterval(() => { fn(); commit(); }, ms) : setTimeout(() => { fn(); commit(); }, ms);
  timers.set(name, { key, h, every, fired: false });
}
const tick = () => { const t = now(); clockMs = t; ovClock = t; };
const tickSec = () => { clockMs = now(); };
function tasks(): void {
  if (SIM) return; // (the virtual clock ticks itself)
  task('pulse', ov.pace === 0, '', 250, tick, true);
  task('pulseSec', ov.pace === 1, '', 1000, tickSec, true);
  task('fed', feed.wake > 0, `${feed.wake}`, 250, tick);
  const wakes = [1, 2, 4, 8, 16, 32];
  task('wake', ov.pace !== 0 && wakes.includes(ov.wake), `${ov.wake}|${ov.wakeKey}`, ov.wake * 1000, tick);
  if (LIVE) task('nowFedTake', true, `${nowData.tick}`, 1, () => { nowFed = nowData.tick; });
  task('resync', feed.status === 'reset', `${retries}`, 250, () => { retries++; gen++; log('stream reset: the snapshot again'); });
  const dropped = feed.status === 'closed' || feed.status === 'error' || conn.status === 'offline';
  const ladder = [2000, 4000, 8000, 16000, 30000][Math.min(retries, 4)];
  task('reconnect', dropped, `${Math.min(retries, 4) === 4 ? retries : Math.min(retries, 4)}`, ladder, () => {
    retries++;
    if (conn.ok) fgen++; else gen++;
    log(`stream ${feed.status}: open again (retries ${retries})`);
  });
  task('steady', feed.status === 'live' && retries > 0, '', 20000, () => { retries = 0; });
}
onStream = (a) => { feed = a as Feed; commit(); };

// ---- the heap ---------------------------------------------------------------------------------
type Sample = { utc: string; min: number; heapMB: number; objects: number; extraMB: number; rssMB: number; types: Record<string, number>; mode: string; pace: number; seq: number; frames: number };
const samples: Sample[] = [];
function sample(): Sample {
  Bun.gc(true);
  Bun.gc(true);
  const h = heapStats();
  const s: Sample = {
    utc: new Date().toISOString().slice(11, 19), min: now() / 60_000, heapMB: h.heapSize / 1048576, objects: h.objectCount, extraMB: h.extraMemorySize / 1048576, rssMB: process.memoryUsage().rss / 1048576,
    types: { ...h.objectTypeCounts }, mode: ov.mode, pace: ov.pace, seq: ov.seq, frames: stats.frames,
  };
  // (the tool's own retention stays flat: a sample's ~100-key type census is kept only for the
  // samples compared against (the third, the first warm one) and the newest)
  const prev = samples[samples.length - 1];
  if (prev && samples.length - 1 !== 2 && prev !== firstWarm()) prev.types = {};
  samples.push(s);
  return s;
}
const WARM_MIN = MINUTES >= 10 ? 2 : 1; // (after the connect's first feeds)
const firstWarm = () => samples.find((x) => x.min >= WARM_MIN);
function slope(xs: Sample[]): number {
  const n = xs.length;
  if (n < 2) return NaN;
  const mx = xs.reduce((a, s) => a + s.min, 0) / n, my = xs.reduce((a, s) => a + s.heapMB, 0) / n;
  let num = 0, den = 0;
  for (const s of xs) { num += (s.min - mx) * (s.heapMB - my); den += (s.min - mx) ** 2; }
  return num / den;
}
function grown(a: Sample, b: Sample, top = 10): [string, number, number][] {
  const keys = new Set([...Object.keys(a.types), ...Object.keys(b.types)]);
  return [...keys].map((k): [string, number, number] => [k, (b.types[k] ?? 0) - (a.types[k] ?? 0), b.types[k] ?? 0])
    .filter(([, d]) => d !== 0).sort((x, y) => Math.abs(y[1]) - Math.abs(x[1])).slice(0, top);
}
const fmtG = (g: [string, number, number][]) => g.map(([k, d, n]) => `${k} ${d > 0 ? '+' : ''}${d} (${n})`).join(', ');
const out = Bun.file(OUT).writer();

// ---- run ----------------------------------------------------------------------------------------
log(`live-heap: ${SERVER} · ${MINUTES} min · ${LIVE ? "Live's sources asked" : "Live's sources NOT asked (stream + overview)"} · samples → ${OUT}`);
ask('viewOnTop', ['now']);
// (never loadToken: with no native module its read answers 'none' and would drop the saved token;
// `tok.ver` only re-asks conn/feed when the token changes, and it never does here)
if (TOKEN) {
  const saved = await (ask('saveToken', [TOKEN, true]) as Promise<{ ok: boolean; status: string }>);
  ver = 'saved';
  log(`token: ${saved.status}`);
}
tick();
commit();

const s0 = sample();
log(`heap ${s0.heapMB.toFixed(2)} MB at start (${s0.objects} objects)`);
const end = MINUTES * 60_000;
function report(): Sample {
  const s = sample();
  const base = samples[Math.min(samples.length - 1, 2)]; // (the first sample once the fleet is in: 1 min)
  out.write(JSON.stringify({ ...s, types: undefined, grown: grown(base, s, 25), stats: { ...stats } }) + '\n');
  out.flush();
  const last = samples.filter((x) => x.min >= s.min - 10);
  log(`heap ${s.heapMB.toFixed(2)} MB · ${s.objects} obj · ${ov.mode} pace ${ov.pace} seq ${ov.seq} · ${stats.frames} frames ${(stats.bytes / 1048576).toFixed(1)} MB · ov ${stats.overviews} feed ${stats.feeds} tick ${stats.ticks} · slope(all) ${slope(samples.slice(2)).toFixed(3)} slope(10 min) ${slope(last).toFixed(3)} MB/min · ${fmtG(grown(base, s, 6))}`);
  return s;
}
if (SIM) {
  let next = SAMPLE_MS;
  const turns = async () => { for (let i = 0; i < 4; i++) await new Promise((r) => setImmediate(r)); };
  while (virt < end) {
    virt += 250;
    tick();
    commit();
    await turns(); // (nowFeed's second turn, a connect's fetches)
    if (LIVE && nowFed !== nowData.tick) { nowFed = nowData.tick; commit(); } // nowFedTake
    if (virt >= next) { next += SAMPLE_MS; report(); }
  }
} else {
  await new Promise<void>((done) => {
    const h = setInterval(() => { if (report().min * 60_000 >= end) { clearInterval(h); done(); } }, SAMPLE_MS);
  });
}

// ---- the verdict ------------------------------------------------------------------------------------
const warm = samples.filter((s) => s.min >= WARM_MIN).length >= 2 ? samples.filter((s) => s.min >= WARM_MIN) : samples;
const lastHalf = warm.filter((s) => s.min >= MINUTES - 30);
const first = warm[0], fin = samples[samples.length - 1];
const half = Math.floor(warm.length / 2);
const mean = (xs: Sample[]) => xs.reduce((a, s) => a + s.heapMB, 0) / Math.max(1, xs.length);
const summary = {
  server: SERVER, live: LIVE, minutes: MINUTES, samples: samples.length,
  startMB: +s0.heapMB.toFixed(3), firstWarmMB: +first.heapMB.toFixed(3), endMB: +fin.heapMB.toFixed(3),
  minMB: +Math.min(...warm.map((s) => s.heapMB)).toFixed(3), maxMB: +Math.max(...warm.map((s) => s.heapMB)).toFixed(3),
  halfMeans: [+mean(warm.slice(0, half)).toFixed(3), +mean(warm.slice(half)).toFixed(3)],
  slopeAll: +slope(warm).toFixed(4), slopeLast30: +slope(lastHalf).toFixed(4), slopeLastHalf: +slope(warm.slice(half)).toFixed(4),
  objects: [first.objects, fin.objects], grown: grown(first, fin, 20), stats,
};
out.write(JSON.stringify({ summary }) + '\n');
await out.end();
log(`summary: ${JSON.stringify({ ...summary, grown: undefined })}`);
log(`object types, first warm sample → end: ${fmtG(summary.grown)}`);
if (flag('--snap')) {
  const f = OUT.replace(/\.jsonl$/, '') + '.heapsnapshot';
  await Bun.write(f, JSON.stringify(generateHeapSnapshot()));
  log(`heap snapshot → ${f}`);
}
try { sock?.close(); } catch { /* gone */ }
process.exit(0);
