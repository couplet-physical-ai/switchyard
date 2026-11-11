// The factory floor's draws, timed in Bun (JIT) against a recording 2D context: what one frame of
// `factoryLive` and one redraw of `factoryFloor` cost, how many canvas calls each records, and
// where the quality ladder settles. Hermes (macOS, the data module) runs the same code ~10-25×
// slower than Bun's JIT, so a frame that costs 0.3 ms here is a few ms there (PERF.md "Factory").
//
//   bun tools/factory-bench.ts [demo|fixtures|<server url>] [--stress] [--zoom <wheel>] [--frames N] [--size 1440x900] [--quality q]
//
// It connects as the app does (sources.connect), lets the fleet move for a few seconds, then
// draws N frames 16.7 ms apart, calling `overview` every 250 ms as Contract's tick does.

type Counts = Record<string, number>;

/** A 2D context that records nothing but how often each call was made. */
class RecordingCtx {
  counts: Counts = {};
  fillStyle: unknown = '#000'; strokeStyle: unknown = '#000'; lineWidth = 1; font = '12px mono'; textAlign = 'left'; textBaseline = 'alphabetic';
  globalAlpha = 1; letterSpacing = '0px'; lineJoin = 'miter'; lineCap = 'butt'; globalCompositeOperation = 'source-over'; imageSmoothingEnabled = true;
  canvas = { width: 1440, height: 900 };
  private n(k: string) { this.counts[k] = (this.counts[k] ?? 0) + 1; }
  beginPath() { this.n('beginPath'); } closePath() { this.n('closePath'); }
  moveTo(_x: number, _y: number) { this.n('moveTo'); } lineTo(_x: number, _y: number) { this.n('lineTo'); }
  arc(..._a: number[]) { this.n('arc'); } ellipse(..._a: number[]) { this.n('ellipse'); } arcTo(..._a: number[]) { this.n('arcTo'); }
  bezierCurveTo(..._a: number[]) { this.n('bezier'); } quadraticCurveTo(..._a: number[]) { this.n('quad'); }
  rect(..._a: number[]) { this.n('rect'); } roundRect(..._a: unknown[]) { this.n('roundRect'); }
  fill() { this.n('fill'); } stroke() { this.n('stroke'); } clip() { this.n('clip'); }
  fillRect(..._a: number[]) { this.n('fillRect'); } strokeRect(..._a: number[]) { this.n('strokeRect'); } clearRect(..._a: number[]) { this.n('clearRect'); }
  fillText(_s: string, _x: number, _y: number) { this.n('fillText'); } strokeText() { this.n('strokeText'); }
  measureText(s: string) { this.n('measureText'); return { width: 7.2 * String(s).length }; }
  save() { this.n('save'); } restore() { this.n('restore'); }
  translate() { this.n('translate'); } scale() { this.n('scale'); } rotate() { this.n('rotate'); }
  setTransform() { this.n('setTransform'); } resetTransform() { this.n('resetTransform'); } transform() { this.n('transform'); }
  setLineDash() { this.n('setLineDash'); } getLineDash() { return []; }
  createLinearGradient() { this.n('gradient'); return { addColorStop() {} }; }
  createRadialGradient() { this.n('gradient'); return { addColorStop() {} }; }
  drawImage() { this.n('drawImage'); }
  total(): number { let t = 0; for (const k in this.counts) t += this.counts[k]; return t; }
  reset() { this.counts = {}; }
}

const args = process.argv.slice(2);
const opt = (name: string, def: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : def; };
const flag = (name: string) => args.includes(name);
let server = args.find((a, i) => !a.startsWith('--') && !['--zoom', '--frames', '--size', '--quality'].includes(args[i - 1] ?? '')) ?? 'demo';
//   --hermes prices the frame budget as the macOS data module does (the ladder decides as there)
const FRAMES = Number(opt('--frames', '600'));
const [W, H] = opt('--size', '1440x842').split('x').map(Number);
const ZOOM = Number(opt('--zoom', '0'));
const QPIN = Number(opt('--quality', '-1'));

(globalThis as { scheduler?: unknown }).scheduler = { yield: () => new Promise<void>((r) => setTimeout(r, 0)) };
let mock: ReturnType<typeof Bun.spawn> | null = null;
if (server === 'fixtures') {
  const port = 4300 + Math.floor(process.pid % 500);
  mock = Bun.spawn(['bun', 'server/mock.ts', '--fixtures', '../contract/fixtures', '--frozen', '--port', String(port)], { cwd: new URL('..', import.meta.url).pathname, stdout: 'ignore', stderr: 'inherit' });
  server = `http://127.0.0.1:${port}`;
  for (let k = 0; k < 100; k++) {
    try { if ((await fetch(`${server}/api/v1/meta`)).ok) break; } catch { /* not up yet */ }
    await Bun.sleep(100);
  }
}
process.on('exit', () => mock?.kill());

// --hermes: the budget prices the draws as the macOS data module does (budget.ts PRICES.hermes)
if (flag('--hermes')) (globalThis as { HermesInternal?: unknown }).HermesInternal = {};
const mod = await import('../app.ts');
const { sources, draw } = mod as unknown as { sources: Record<string, (a: unknown[], s?: unknown, st?: unknown) => unknown>; draw: (s: string, a: unknown[], c: unknown, f: unknown) => boolean };
const store = { get: () => '', set() {} };
const epoch0 = Date.UTC(2026, 10, 10, 20);
const conn = (await sources.connect([server, '', 1, epoch0, 0], store, {})) as { ok: boolean; status: string; error?: string };
if (!conn.ok) { console.error(`connect: ${conn.status} ${conn.error ?? ''}`); process.exit(1); }
if (flag('--stress')) sources.devToggle(['stress', 1]);
if (flag('--hud')) sources.devToggle(['hud', 1]);

const ctx = new RecordingCtx();
const floorCtx = new RecordingCtx();
let t = 16;
let tick = 0;
let route = '';
const frame = (time: number, cause = 'frame') => ({ time, mounted: 0, cause, causes: [cause], width: W, height: H, pixelWidth: W * 2, pixelHeight: H * 2, scale: 2 });
const ov = () => (sources.overview([t, 0, true], store, {}) as { facKey: string; quality: number; tick: number });

// a few seconds of the fleet moving (the demo's events spawn crates), drawn as the app would
let key = '';
let floorDraws = 0;
// the live layer as the host runs it: every frame while its draw asks for one, else only when an
// argument changes (app.contract's 125 ms `facPulse`, the calm cadence)
let awake = true;
let pulse = 0;
const step = (measure: boolean): number => {
  t += 1000 / 60;
  if (Math.floor(t / 250) !== tick) { tick = Math.floor(t / 250); const o = ov(); if (o.facKey !== key) { key = o.facKey; draw('factoryFloor', [key, route, ZOOM], floorCtx, frame(t, 'args')); floorDraws++; } }
  ctx.reset();
  const p = Math.floor(t / 125);
  const woken = p !== pulse;
  pulse = p;
  if (!awake && !woken) return 0;
  const a = performance.now();
  awake = draw('factoryLive', ['full', route, ZOOM, p], ctx, frame(t, awake ? 'frame' : 'args'));
  const ms = performance.now() - a;
  return measure ? ms : 0;
};
for (let i = 0; i < 4; i++) draw('factoryFloor', ['', route, ZOOM], floorCtx, frame(t, 'mount'));
if (QPIN >= 0) (mod as unknown as { factoryForBench?: () => { budget: { pinned: number } } }).factoryForBench?.().budget && ((mod as unknown as { factoryForBench: () => { budget: { pinned: number } } }).factoryForBench().budget.pinned = QPIN);
for (let i = 0; i < 360; i++) step(false);
const live: number[] = [];
const ops: number[] = [];
floorDraws = 0;
for (let i = 0; i < FRAMES; i++) { live.push(step(true)); ops.push(ctx.total()); }
// the floor redrawn as a camera move would (a forced key change)
const floor: number[] = [];
for (let i = 0; i < 30; i++) {
  floorCtx.reset();
  const a = performance.now();
  draw('factoryFloor', [`bench${i}`, route, ZOOM], floorCtx, frame(t, 'size'));
  floor.push(performance.now() - a);
}
const q = (a: number[], p: number) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
const o = ov() as unknown as { quality: number; facStats?: string };
const top = Object.entries(ctx.counts).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, v]) => `${k} ${v}`).join(', ');
const ftop = Object.entries(floorCtx.counts).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, v]) => `${k} ${v}`).join(', ');
console.log(JSON.stringify({
  source: server.startsWith('http') && mock ? 'fixtures' : server, stress: flag('--stress'), zoom: ZOOM, size: `${W}x${H}`, frames: FRAMES,
  liveMs: { median: +q(live, 0.5).toFixed(3), p95: +q(live, 0.95).toFixed(3), max: +Math.max(...live).toFixed(3) },
  liveCalls: { median: q(ops, 0.5), max: Math.max(...ops), mean: Math.round(ops.reduce((a, b) => a + b, 0) / ops.length), framesDrawn: ops.filter((n) => n > 0).length },
  floorMs: { median: +q(floor, 0.5).toFixed(3), max: +Math.max(...floor).toFixed(3) }, floorCalls: floorCtx.total(),
  floorRedrawsInWindow: floorDraws, quality: o.quality, stats: o.facStats ?? '',
}));
console.log(`live calls (last frame): ${top}`);
console.log(`floor calls: ${ftop}`);
process.exit(0);
