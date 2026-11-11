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
// the floor as the host runs it (fab-w7b): on a new key, and every frame while its draw asks;
// each draw's list bytes (--real) or calls, the ones that sent anything
let floorAwake = false;
const floorSent: number[] = [];
const floorSentMs: number[] = [];
let floorOtherMs = 0, floorOtherN = 0, floorMaxOther = 0;
const floorStep = (cause: string) => {
  floorCtx.reset();
  const a = performance.now();
  floorAwake = drawVia('factoryFloor', [key, route, ZOOM], floorCtx, frame(t, cause));
  const ms = performance.now() - a;
  const n = REAL ? (floorCtx.counts.bytes ?? 0) : floorCtx.total();
  if (n > (REAL ? 64 : 2)) { floorSent.push(n); floorSentMs.push(ms); floorDraws++; } else { floorOtherMs += ms; floorOtherN++; floorMaxOther = Math.max(floorMaxOther, ms); }
};
const step = (measure: boolean): number => {
  t += 1000 / 60;
  let floorDone = false;
  if (Math.floor(t / 250) !== tick) { tick = Math.floor(t / 250); const o = ov(); if (o.facKey !== key) { key = o.facKey; floorStep('args'); floorDone = true; } }
  if (!floorDone && floorAwake) floorStep('frame');
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
// --floor-phases: the static floor's repaint by layer: each layer's own pass (its flat ground),
// its depth-sorted items and its `after`s, ms and (with --real) list KB (fab-w7b)
const FP: Record<string, [number, number, number]> = {};
if (flag('--floor-phases')) {
  const bytesOf = (c: unknown): number => (Factory.probe ? Factory.probe(c as never) : 0);
  const tally = (k: string, ms: number, b: number) => { const a = (FP[k] ??= [0, 0, 0]); a[0] += ms; a[1] += b; a[2]++; };
  const timed = (k: string, fn: () => void, ctxOf: () => unknown) => () => { const b0 = bytesOf(ctxOf()), t0 = performance.now(); fn(); tally(k, performance.now() - t0, bytesOf(ctxOf()) - b0); };
  for (const L of fac.order as unknown as { name: string; floor?: (fp: { g: { ctx: unknown }; add: (...a: unknown[]) => void; after: (fn: () => void) => void }) => void }[]) {
    const f0 = L.floor;
    if (!f0) continue;
    L.floor = function (fp) {
      const ctxOf = () => fp.g.ctx;
      const add0 = fp.add, after0 = fp.after;
      const fp2 = { ...fp, add: (u: unknown, v: unknown, fn: () => void, ...rest: unknown[]) => add0(u, v, timed(`${L.name}.items`, fn, ctxOf), ...rest), after: (fn: () => void) => after0(timed(`${L.name}.after`, fn, ctxOf)) };
      const b0 = bytesOf(ctxOf()), t0 = performance.now();
      f0.call(L, fp2 as never);
      tally(`${L.name}.pass`, performance.now() - t0, bytesOf(ctxOf()) - b0);
    };
  }
  // and by method (inclusive; nested calls count in both)
  const F = fac as unknown as Record<string, Record<string, unknown>>;
  const gfx = () => (F.gf as unknown as { ctx: unknown }).ctx;
  const meth = (obj: Record<string, unknown>, names: string[], label: string) => {
    for (const n of names) {
      const fn = obj[n] as ((...a: unknown[]) => unknown) | undefined;
      if (typeof fn !== 'function') continue;
      obj[n] = function (this: unknown, ...a: unknown[]) { const b0 = bytesOf(gfx()), t0 = performance.now(); try { return fn.apply(this, a); } finally { tally(`  ${label}.${n}`, performance.now() - t0, bytesOf(gfx()) - b0); } };
    }
  };
  meth(F.floor, ['wall', 'roads', 'ribbon', 'belts', 'stack', 'ageBays', 'posts', 'gate', 'siding', 'subRows', 'drawCars'], 'floor');
  meth(F.w2, ['floor', 'dock'], 'w2');
  meth(F.city, ['ellipse', 'drawPlates', 'drawTracks', 'drawCity'], 'city');
  meth(F.plant, ['engineBlock', 'returnBeds'], 'plant');
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
floorSent.length = 0; floorSentMs.length = 0; floorOtherMs = 0; floorOtherN = 0; floorMaxOther = 0;
liveBytes = 0; topBytes = 0;
const fl0 = { ...fac.ret.totals };
// --floor-debug: what the floor's partial repaints send, by paint (fab-w7b); --floor-time: the
// data repaint's record, diff and flush, timed
const FDBG = flag('--floor-debug');
const FT = { rec: [] as number[], diff: [] as number[], flush: [] as number[] };
if (flag('--floor-time')) {
  const FC = await import('../src/factory/floorcache.ts');
  const F = fac as unknown as { paintFloor: (c: unknown, f: unknown) => void; fc: { flush: (c: unknown, w?: boolean) => number; list: InstanceType<typeof FC.FList>; shownList: InstanceType<typeof FC.FList> | null } };
  const p0 = F.paintFloor.bind(fac), f0 = F.fc.flush.bind(F.fc);
  F.paintFloor = (c: unknown, f: unknown) => { const a = performance.now(); p0(c, f); if (c instanceof FC.FRec) FT.rec.push(performance.now() - a); };
  const TT = new FC.Tiles();
  F.fc.flush = (c: unknown, w?: boolean) => {
    const A = F.fc.shownList, B = F.fc.list;
    if (A) {
      const a = performance.now(); TT.reset(B.W, B.H); FC.diff(A, B, TT); FT.diff.push(performance.now() - a);
      if (flag('--floor-verify') && TT.count <= TT.total * 0.55) { const v = FC.verifyDiff(A, B, TT); console.log(`  verify t=${(t / 1000).toFixed(1)}s tiles ${TT.count}: ${v || 'ok'}`); }
      if (flag('--floor-drift')) {
        // items equal by key: do their numbers differ at all (under the hash's 1/64 px)?
        const at = new Map<number, number>();
        for (let i = 0; i < A.n; i++) at.set(A.iKey[i], i);
        let worst = 0, wi = -1, nDrift = 0;
        for (let j = 0; j < B.n; j++) {
          const i = at.get(B.iKey[j]);
          if (i === undefined) continue;
          const la = A.iP1[i] - A.iP0[i];
          if (la !== B.iP1[j] - B.iP0[j]) continue;
          let m = 0;
          for (let k = 0; k < la; k++) m = Math.max(m, Math.abs(A.sg[A.iP0[i] + k] - B.sg[B.iP0[j] + k]));
          if (m > 0) nDrift++;
          if (m > worst) { worst = m; wi = j; }
        }
        const st = wi >= 0 ? B.states[B.iS[wi]] : null;
        console.log(`  drift t=${(t / 1000).toFixed(1)}s: ${nDrift} equal-key items moved, worst ${worst.toExponential(2)}${st ? ` (${String(B.iK[wi] === 1 ? st.fill : st.stroke)})` : ''}`);
      }
    }
    const a = performance.now(); const r = f0(c, w); FT.flush.push(performance.now() - a); return r;
  };
}
const fdbg = new Map<string, [number, number]>();
if (FDBG) {
  const FC = await import('../src/factory/floorcache.ts');
  const fc = fac.fc as unknown as { flush: (c: unknown, w?: boolean) => number; list: InstanceType<typeof FC.FList> };
  const f0 = fc.flush.bind(fc);
  fc.flush = (c: unknown, w?: boolean) => {
    FC.FloorReplay.dbg = [];
    const A0 = (fac.fc as unknown as { shownList: InstanceType<typeof FC.FList> | null }).shownList;
    FC.diffDbg.on = flag('--floor-debug-each'); FC.diffDbg.marks = [];
    const r = f0(c, w);
    if (FC.diffDbg.on) {
      const per = new Map<string, number>();
      for (const [kd, i, qq] of FC.diffDbg.marks) {
        const LL = kd === 'old' ? A0! : fc.list, st = LL.states[LL.iS[i]], kind = LL.iK[i] === 1 ? 'fill' : LL.iK[i] === 2 ? 'stroke' : `k${LL.iK[i]}`;
        const bb = qq >= 0 ? [LL.qB[qq * 4], LL.qB[qq * 4 + 1], LL.qB[qq * 4 + 2], LL.qB[qq * 4 + 3]] : [0, 0, 0, 0];
        const nm = `${kd} ${kind} ${String(kind === 'stroke' ? st.stroke : st.fill)} @${Math.round(bb[0])},${Math.round(bb[1])} ${Math.round(bb[2] - bb[0])}x${Math.round(bb[3] - bb[1])}`;
        per.set(nm, (per.get(nm) ?? 0) + 1);
      }
      console.log('     dirty: ' + [...per].slice(0, 40).map(([k, v]) => `${v > 1 ? v + '× ' : ''}${k}`).join(' | '));
    }
    const L = fc.list, d = FC.FloorReplay.dbg;
    for (let k = 0; k < d.length; k += 2) {
      const i = d[k], st = L.states[L.iS[i]], kind = L.iK[i] === 1 ? 'fill' : 'stroke';
      const B = L.iB, w2 = Math.round(B[i * 4 + 2] - B[i * 4]), h2 = Math.round(B[i * 4 + 3] - B[i * 4 + 1]);
      const name = `${kind} ${String(kind === 'fill' ? st.fill : st.stroke)} lw${st.lw.toFixed(1)} pieces${L.iQ1[i] - L.iQ0[i]} box${w2}x${h2}`;
      const a = fdbg.get(name) ?? [0, 0]; a[0] += d[k + 1]; a[1]++; fdbg.set(name, a);
    }
    FC.FloorReplay.dbg = null;
    const ls = (fac.fc as unknown as { last: Record<string, number> }).last;
    console.log(`  flush t=${(t / 1000).toFixed(1)}s ${ls.whole ? 'WHOLE' : 'partial'} tiles ${ls.tiles}/${ls.of} items ${ls.drawn}/${ls.items} segs ${ls.segs} ops ${ls.ops} key ${key.slice(-60)}`);
    if (flag('--floor-debug-each') && !ls.whole) {
      const per = new Map<string, number>();
      for (let k = 0; k < d.length; k += 2) { const i = d[k], st = L.states[L.iS[i]], kind = L.iK[i] === 1 ? 'fill' : 'stroke'; const nm = `${kind} ${String(kind === 'fill' ? st.fill : st.stroke)} lw${st.lw.toFixed(1)}`; per.set(nm, (per.get(nm) ?? 0) + d[k + 1]); }
      console.log('     ' + [...per].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([k, v]) => `${v} ${k}`).join(' | '));
    }
    return r;
  };
}
for (let i = 0; i < FRAMES; i++) {
  live.push(step(true));
  ops.push(REAL ? (ctx.counts.bytes ?? 0) : ctx.total()); if (REAL) ctx.counts.bytes = 0;
  tops.push(REAL ? (topCtx.counts.bytes ?? 0) : topCtx.total()); if (REAL) topCtx.counts.bytes = 0;
}
const fl = { flushes: fac.ret.totals.flushes - fl0.flushes, empty: fac.ret.totals.empty - fl0.empty, drawn: fac.ret.totals.drawn - fl0.drawn };
// the floor redrawn as a camera move would (a forced key change)
const floor: number[] = [];
for (const k in FP) delete FP[k];
for (let i = 0; i < 30; i++) {
  floorCtx.reset();
  const a = performance.now();
  drawVia('factoryFloor', [`bench${i}`, route, ZOOM], floorCtx, frame(t, 'size'));
  floor.push(performance.now() - a);
}
const q = (a: number[], p: number) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
// --floor-rec-loop N: record the floor into floorcache N times and exit (for --cpu-prof)
if (flag('--floor-rec-loop')) {
  const N = Number(opt('--floor-rec-loop', '20'));
  const F = fac as unknown as { paintFloor: (c: unknown, f: unknown) => void; fc: { begin: (W: number, H: number, m: unknown) => unknown } };
  const a = performance.now();
  for (let i = 0; i < N; i++) { const c = F.fc.begin(W, H, floorCtx); F.paintFloor(c, frame(t, "args")); }
  console.log(`floor record loop: ${((performance.now() - a) / N).toFixed(2)} ms each`);
  process.exit(0);
}
// --floor-retained: the same forced repaints recorded into a plain-JS retained list (cache.ts)
// instead of a canvas: what recording the floor costs without the bytes (fab-w7b)
if (flag('--floor-retained')) {
  const { Retained } = await import('../src/factory/cache.ts');
  const R = new Retained();
  R.measurer = floorCtx as never;
  const rt: number[] = [];
  for (let i = 0; i < 30; i++) {
    const a = performance.now();
    R.begin(W, H);
    (fac as unknown as { drawFloor: (c: unknown, f: unknown, t: number) => boolean }).drawFloor(R, frame(t, 'size'), t);
    R.end();
    rt.push(performance.now() - a);
  }
  console.log(`floor into Retained: median ${q(rt, 0.5).toFixed(3)} ms, max ${Math.max(...rt).toFixed(3)} ms`);
}
const o = ov() as unknown as { quality: number; facStats?: string };
const top = Object.entries(ctx.counts).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, v]) => `${k} ${v}`).join(', ');
const ftop = Object.entries(floorCtx.counts).sort((a, b) => b[1] - a[1]).slice(0, 14).map(([k, v]) => `${k} ${v}`).join(', ');
console.log(JSON.stringify({
  source: server.startsWith('http') && mock ? 'fixtures' : server, stress: flag('--stress'), zoom: ZOOM, size: `${W}x${H}`, frames: FRAMES,
  liveMs: { median: +q(live, 0.5).toFixed(3), p95: +q(live, 0.95).toFixed(3), max: +Math.max(...live).toFixed(3) },
  [REAL ? 'liveBytes' : 'liveCalls']: { median: q(ops, 0.5), max: Math.max(...ops), mean: Math.round(ops.reduce((a, b) => a + b, 0) / ops.length), framesDrawn: ops.filter((n) => n > 0).length },
  [REAL ? 'topBytes' : 'topCalls']: { median: q(tops, 0.5), max: Math.max(...tops), mean: Math.round(tops.reduce((a, b) => a + b, 0) / tops.length), framesSent: tops.filter((n) => n > 0).length, flushes: fl.flushes, nothingChanged: fl.empty, itemsDrawn: fl.drawn },
  floorMs: { median: +q(floor, 0.5).toFixed(3), max: +Math.max(...floor).toFixed(3) }, floorCalls: floorCtx.total(),
  floorRedrawsInWindow: floorDraws, [REAL ? 'floorSentBytes' : 'floorSentCalls']: { n: floorSent.length, median: floorSent.length ? q(floorSent, 0.5) : 0, max: floorSent.length ? Math.max(...floorSent) : 0, mean: floorSent.length ? Math.round(floorSent.reduce((a, b) => a + b, 0) / floorSent.length) : 0 },
  floorSentMs: { median: floorSentMs.length ? +q(floorSentMs, 0.5).toFixed(3) : 0, max: floorSentMs.length ? +Math.max(...floorSentMs).toFixed(3) : 0 }, floorQuietDraws: { n: floorOtherN, meanMs: +(floorOtherMs / Math.max(1, floorOtherN)).toFixed(3), maxMs: +floorMaxOther.toFixed(3) },
  floorCache: { ...fac.fc.totals, last: fac.fc.last }, quality: o.quality, stats: o.facStats ?? '', ...(REAL ? { real: true, sentKBPerFrame: +((liveBytes + topBytes) * 0.75 / 1024 / FRAMES).toFixed(1) } : {}),
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
if (flag('--floor-time')) {
  const m = (a: number[]) => (a.length ? `median ${q(a, 0.5).toFixed(2)} max ${Math.max(...a).toFixed(2)} (n ${a.length})` : '-');
  console.log(`floor data repaint ms: record ${m(FT.rec)} · diff ${m(FT.diff)} · flush (diff+replay+recorder) ${m(FT.flush)}`);
}
if (FDBG) {
  console.log('floor partial repaints: segments sent by paint (sum over the window, times):');
  for (const [k, [n, c]] of [...fdbg].sort((a, b) => b[1][0] - a[1][0]).slice(0, 40)) console.log(`  ${String(n).padStart(6)} ${String(c).padStart(4)}×  ${k}`);
}
if (flag('--floor-phases')) {
  console.log('floor phases (ms, KB a repaint; items):');
  for (const [k, [ms, b, n]] of Object.entries(FP).sort((a, b) => b[1][0] - a[1][0])) console.log(`  ${(ms / 30).toFixed(3).padStart(8)} ms  ${(b / 30 / 1024).toFixed(1).padStart(7)} KB  ${String(Math.round(n / 30)).padStart(5)}  ${k}`);
}
process.exit(0);
