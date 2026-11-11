// The factory floor's draws, timed in Bun (JIT) against a recording 2D context: what one frame of
// `factoryLive` (and `factoryTop`, the words and chrome sent as changes) and one redraw of
// `factoryFloor` cost, how many canvas calls each records, and where the quality ladder settles.
//
//   bun tools/factory-bench.ts [demo|fixtures|<server url>] [--stress] [--zoom <wheel>] [--frames N]
//       [--size 1440x900] [--quality q] [--warm s] [--hud] [--hermes] [--no-top]
//       [--real [--opbytes]] [--phases] [--callers]
//
// It connects as the app does (sources.connect), lets the fleet move for `--warm` seconds (15: past
// the coffee check's 10 s intro), then draws N frames 16.7 ms apart, calling `overview` every
// 250 ms as Contract's tick does. What a native frame costs is its list's BYTES (PERF.md, "Where the
// native frame goes": Hermes runs Exact's recorder and base64s the list, ~0.05 ms a KB on the mini):
// `--real` draws through Exact's own recorder (canvas/recorder.js) and reports the bytes a frame
// sends, per canvas and per phase (`--opbytes`: by list op). `--no-top` draws as before the top
// canvas (everything on the live one). `--phases` times each phase (run with BUN_JSC_useJIT=0 for
// an interpreter's proportions).

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
/** True while a live draw runs (--callers --live-only counts only those). */
let inLive = false;
const opt = (name: string, def: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : def; };
const flag = (name: string) => args.includes(name);
let server = args.find((a, i) => !a.startsWith('--') && !['--zoom', '--frames', '--size', '--quality', '--warm', '--callers'].includes(args[i - 1] ?? '')) ?? 'demo';
const TOP = !flag('--no-top');
//   --hermes prices the frame budget as the macOS data module does (the ladder decides as there)
const FRAMES = Number(opt('--frames', '600'));
const [W, H] = opt('--size', '1440x842').split('x').map(Number);
const ZOOM = Number(opt('--zoom', '0'));
const QPIN = Number(opt('--quality', '-1'));
// seconds of the fleet moving before the window (the coffee check's 10 s intro draws every frame)
const WARM = Number(opt('--warm', '15'));

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
const { Factory } = await import('../src/factory/factory.ts');
const { sources, draw } = mod as unknown as { sources: Record<string, (a: unknown[], s?: unknown, st?: unknown) => unknown>; draw: (s: string, a: unknown[], c: unknown, f: unknown) => boolean };
const store = { get: () => '', set() {} };
const epoch0 = Date.UTC(2026, 10, 10, 20);
const conn = (await sources.connect([server, '', 1, epoch0, 0], store, {})) as { ok: boolean; status: string; error?: string };
if (!conn.ok) { console.error(`connect: ${conn.status} ${conn.error ?? ''}`); process.exit(1); }
if (flag('--stress')) sources.devToggle(['stress', 1]);
if (flag('--hud')) sources.devToggle(['hud', 1]);

// --real: the draws go through Exact's own recorder (canvas/recorder.js, the context a native
// draw records into, then base64 + JSON for the host): with BUN_JSC_useJIT=0 its per-frame ms is the
// closest Bun gets to the macOS data module's (Hermes, an interpreter)
const REAL = flag('--real');
let liveBytes = 0;
let topBytes = 0;
const seam = REAL ? (await import(`${process.env.EXACT2 ?? '/home/farce/src/exact'}/canvas/recorder.js`)).canvasSeam((s: string, a: unknown[], c: unknown, f: unknown) => drawRaw(s, a, c, f)) : null;
const measureHost = { measure: (j: string) => { const r = JSON.parse(j); const w = 7.2 * String(r.text).length; return JSON.stringify([w, 0, w, 9, 3, 11, 3, 9, 3, 0, 0]); }, image: () => '' };
const drawRaw = draw;
const ids: Record<string, number> = { factoryFloor: 1, factoryLive: 2, factoryTop: 3 };
const drawVia = (surface: string, a: unknown[], c: RecordingCtx, f: ReturnType<typeof frame>): boolean => {
  if (!seam) return drawRaw(surface, a, c, f);
  const out = JSON.parse(seam.draw({ canvas: ids[surface], generation: 1, surface, args: a, frame: f }, measureHost)) as { lists: string[]; frame: boolean };
  let bytes = 0;
  for (const l of out.lists) bytes += l.length;
  if (surface === 'factoryLive') liveBytes += bytes;
  if (surface === 'factoryTop') topBytes += bytes;
  c.counts.bytes = Math.round(bytes * 0.75); // the raw list (base64 is 4/3 of it)
  return out.frame;
};
const ctx = new RecordingCtx();
const floorCtx = new RecordingCtx();
const topCtx = new RecordingCtx();
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
let topAwake = true;
let pulse = 0;
let topMs = 0;
const step = (measure: boolean): number => {
  t += 1000 / 60;
  if (Math.floor(t / 250) !== tick) { tick = Math.floor(t / 250); const o = ov(); if (o.facKey !== key) { key = o.facKey; drawVia('factoryFloor', [key, route, ZOOM], floorCtx, frame(t, 'args')); floorDraws++; } }
  ctx.reset(); topCtx.reset();
  const p = Math.floor(t / 125);
  const woken = p !== pulse;
  pulse = p;
  let ms = 0;
  if (awake || woken) {
    const a = performance.now();
    inLive = true;
    awake = drawVia('factoryLive', ['full', route, ZOOM, p], ctx, frame(t, awake ? 'frame' : 'args'));
    inLive = false;
    ms += performance.now() - a;
  }
  // the top canvas, after the live one in the tree (as the host draws them)
  topMs = 0;
  if (TOP && (topAwake || woken)) {
    const a = performance.now();
    topAwake = drawVia('factoryTop', ['full', route, ZOOM, p], topCtx, frame(t, topAwake ? 'frame' : 'args'));
    topMs = performance.now() - a;
  }
  return measure ? ms + topMs : 0;
};
for (let i = 0; i < 4; i++) drawVia('factoryFloor', ['', route, ZOOM], floorCtx, frame(t, 'mount'));
const fac = Factory.last!;
const CALLERS = new Map<string, number>();
const LIVE_ONLY = flag('--live-only');
// --callers [ops] [--depth N] [--live-only]: who calls the given ctx methods (default
// arc,ellipse,font) a drawn frame, N stack frames deep (2), only in live draws
if (flag('--callers')) {
  const want = opt('--callers', '');
  const names = (want && !want.startsWith('--') ? want : 'arc,ellipse,font').split(',');
  const proto = RecordingCtx.prototype as unknown as Record<string, unknown>;
  for (const n of names) {
    const desc = Object.getOwnPropertyDescriptor(proto, n);
    const tally = (k: string) => { if (LIVE_ONLY && !inLive) return; const st = (new Error().stack ?? '').split('\n').slice(3, 3 + Number(opt('--depth', '2'))).map((l) => l.trim().replace(/^at /, '').replace(/\(.*\/src\//, '(').replace(/:\d+\)$/, ')')).join(' < '); CALLERS.set(`${k} ${st}`, (CALLERS.get(`${k} ${st}`) ?? 0) + 1); };
    if (desc?.set) Object.defineProperty(proto, n, { ...desc, set(this: unknown, v: unknown) { tally(n); desc.set!.call(this, v); } });
    else if (typeof desc?.value === 'function') { const fn = desc.value as (...a: unknown[]) => unknown; proto[n] = function (this: unknown, ...a: unknown[]) { tally(n); return fn.apply(this, a); }; }
  }
}
// --opbytes: which list ops the bytes are, per phase (needs --real)
const OPB: Record<string, Record<number, number>> = {};
let opTally: Record<number, number> = {};
let patched = false;
if (REAL) Factory.probe = (c: unknown) => {
  const i = (c as { _?: { writer: { len: number; op: (code: number, o: number[]) => void }; sealed: Uint8Array[] } })._;
  if (!i) return 0;
  if (flag('--opbytes')) {
    if (!patched) {
      patched = true;
      const proto = Object.getPrototypeOf(i.writer) as { op: (code: number, o: number[]) => void };
      const op0 = proto.op;
      proto.op = function (code: number, o: number[]) { opTally[code] = (opTally[code] ?? 0) + 8 + o.length * 8; return op0.call(this, code, o); };
    }
    const F = fac as unknown as { profNames: string[]; pi: number };
    const name = F.profNames[F.pi] ?? 'hud+after';
    const acc = (OPB[name] ??= {});
    for (const k in opTally) acc[+k] = (acc[+k] ?? 0) + opTally[+k];
    opTally = {};
  }
  let n = i.writer.len; for (const x of i.sealed) n += x.length; return n;
};
if (QPIN >= 0) fac.budget.pinned = QPIN;
// --phases: every phase of the live frame timed (run with BUN_JSC_useJIT=0 for an interpreter's
// proportions, near Hermes'; a draw cannot read a clock on the hosts, so this is where the JS goes)
const T: Record<string, number> = {};
const wrap = (obj: unknown, name: string, label: string) => {
  const o = obj as Record<string, (...a: unknown[]) => unknown>;
  const fn = o?.[name];
  if (typeof fn !== 'function') return;
  o[name] = function (this: unknown, ...a: unknown[]) { const t0 = performance.now(); try { return fn.apply(this, a); } finally { T[label] = (T[label] ?? 0) + performance.now() - t0; } };
};
if (flag('--phases')) {
  const F = fac as unknown as Record<string, unknown>;
  const lens = F.lens as Record<string, unknown>;
  wrap(F, 'drawLive', 'TOTAL live');
  wrap(F, 'ensure', 'ensure (census)');
  for (const L of fac.order as unknown as Record<string, unknown>[]) { wrap(L, 'hits', `${L.name}.hits`); wrap(L, 'live', `${L.name}.live`); }
  wrap(lens, 'under', 'lens.under');
  wrap(lens.hosts, 'sample', ' under: hosts.sample');
  wrap(lens, 'park', ' under: park');
  wrap(lens, 'floorHits', ' under: floorHits');
  wrap(lens, 'drawParked', ' under: drawParked');
  wrap(F.coffee, 'under', ' under: coffee.under');
  wrap(F.coffee, 'update', '  coffee: update');
  wrap(F.coffee, 'layout', '  coffee: layout');
  wrap(F.coffee, 'freshGlows', '  coffee: freshGlows');
  wrap(lens, 'draw', 'lens.draw');
  wrap(lens, 'top', 'lens.top');
  wrap(F.crates, 'tags', 'crates.tags');
  wrap(F.drawer, 'draw', 'drawer.draw'); wrap(F.drawer, 'hover', 'drawer.hover'); wrap(F.drawer, 'journey', 'drawer.journey');
  wrap(F.strip, 'draw', 'strip.draw'); wrap(F.strip, 'controls', 'strip.controls');
  wrap(F, 'drawHud', 'hud'); wrap(F, 'logAnchors', 'logAnchors'); wrap(F, 'selPipeline', 'selPipeline');
  wrap(fac.budget, 'record', 'budget.record');
  wrap(F.w2, 'over', ' groups: w2.over');
}
// --trace: the ladder second by second through the warm-up (the coffee check's intro included)
for (let i = 0; i < WARM * 60; i++) {
  step(false);
  if (flag('--trace') && i % 60 === 59) { const b = fac.budget; console.log(`t=${((i + 1) / 60).toFixed(0)}s q${b.quality} est ${b.est.toFixed(2)}ms gain ${b.gain.toFixed(2)} ops ${b.ops} busy ${fac.coffee.busy(t)}`); }
}
fac.profReset();
CALLERS.clear();
for (const k in T) delete T[k];
for (const k in OPB) delete OPB[k];
const live: number[] = [];
const ops: number[] = [];
const tops: number[] = [];
floorDraws = 0;
liveBytes = 0; topBytes = 0;
const fl0 = { ...fac.ret.totals };
for (let i = 0; i < FRAMES; i++) {
  live.push(step(true));
  ops.push(REAL ? (ctx.counts.bytes ?? 0) : ctx.total()); if (REAL) ctx.counts.bytes = 0;
  tops.push(REAL ? (topCtx.counts.bytes ?? 0) : topCtx.total()); if (REAL) topCtx.counts.bytes = 0;
}
const fl = { flushes: fac.ret.totals.flushes - fl0.flushes, empty: fac.ret.totals.empty - fl0.empty, drawn: fac.ret.totals.drawn - fl0.drawn };
// the floor redrawn as a camera move would (a forced key change)
const floor: number[] = [];
for (let i = 0; i < 30; i++) {
  floorCtx.reset();
  const a = performance.now();
  drawVia('factoryFloor', [`bench${i}`, route, ZOOM], floorCtx, frame(t, 'size'));
  floor.push(performance.now() - a);
}
const q = (a: number[], p: number) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
const o = ov() as unknown as { quality: number; facStats?: string };
const top = Object.entries(ctx.counts).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, v]) => `${k} ${v}`).join(', ');
const ftop = Object.entries(floorCtx.counts).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, v]) => `${k} ${v}`).join(', ');
console.log(JSON.stringify({
  source: server.startsWith('http') && mock ? 'fixtures' : server, stress: flag('--stress'), zoom: ZOOM, size: `${W}x${H}`, frames: FRAMES,
  liveMs: { median: +q(live, 0.5).toFixed(3), p95: +q(live, 0.95).toFixed(3), max: +Math.max(...live).toFixed(3) },
  [REAL ? 'liveBytes' : 'liveCalls']: { median: q(ops, 0.5), max: Math.max(...ops), mean: Math.round(ops.reduce((a, b) => a + b, 0) / ops.length), framesDrawn: ops.filter((n) => n > 0).length },
  [REAL ? 'topBytes' : 'topCalls']: { median: q(tops, 0.5), max: Math.max(...tops), mean: Math.round(tops.reduce((a, b) => a + b, 0) / tops.length), framesSent: tops.filter((n) => n > 0).length, flushes: fl.flushes, nothingChanged: fl.empty, itemsDrawn: fl.drawn },
  floorMs: { median: +q(floor, 0.5).toFixed(3), max: +Math.max(...floor).toFixed(3) }, floorCalls: floorCtx.total(),
  floorRedrawsInWindow: floorDraws, quality: o.quality, stats: o.facStats ?? '', ...(REAL ? { real: true, sentKBPerFrame: +((liveBytes + topBytes) * 0.75 / 1024 / FRAMES).toFixed(1) } : {}),
}));
console.log(`live calls (last frame): ${top}`);
console.log(`live phases (ops/arcs/texts a drawn frame): ${fac.profLine()}`);
if (flag('--callers')) {
  const drawn = ops.filter((n) => n > 0).length || 1;
  for (const [k, v] of [...CALLERS].sort((a, b) => b[1] - a[1]).slice(0, 30)) console.log(`  ${(v / drawn).toFixed(1).padStart(6)}  ${k}`);
}
if (flag('--opbytes')) {
  const drawn = ops.filter((n) => n > 0).length || 1;
  const NAMES: Record<number, string> = { 3: 'reset', 46: 'arc?', 47: 'rect', 54: 'strokeRect', 62: 'strokeText', 1: 'save', 2: 'restore', 4: 'setTransform', 10: 'fillColor', 11: 'fillGrad', 12: 'strokeColor', 14: 'lineWidth', 15: 'lineCap', 16: 'lineJoin', 18: 'lineDash', 20: 'alpha', 30: 'linGrad', 31: 'radGrad', 32: 'colorStop', 40: 'begin', 41: 'moveTo', 42: 'lineTo', 43: 'quadTo', 44: 'cubicTo', 45: 'close', 50: 'fill', 51: 'stroke', 52: 'clip', 53: 'fillRect', 55: 'clearRect', 60: 'font', 61: 'fillText' };
  for (const [ph, m] of Object.entries(OPB)) {
    const tot = Object.values(m).reduce((a, b) => a + b, 0) / drawn;
    if (tot < 200) continue;
    console.log(`  ${ph} ${(tot / 1024).toFixed(1)}K: ${Object.entries(m).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, v]) => `${NAMES[+k] ?? k} ${(v / drawn / 1024).toFixed(1)}K`).join(', ')}`);
  }
}
if (flag('--phases')) {
  const drawn = ops.filter((n) => n > 0).length || 1;
  console.log(`live phase ms a drawn frame (${drawn} drawn):`);
  for (const [k, v] of Object.entries(T).sort((a, b) => b[1] - a[1])) console.log(`  ${(v / drawn).toFixed(3).padStart(8)}  ${k}`);
}
console.log(`floor calls: ${ftop}`);
process.exit(0);
