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
let server = args.find((a, i) => !a.startsWith('--') && !['--zoom', '--frames', '--size', '--quality', '--warm', '--callers', '--floor-pixels'].includes(args[i - 1] ?? '')) ?? 'demo';
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
// --floor-group N / --floor-send N / --floor-budget N: floorcache's band size, factory's send ops and record budget a frame
{
  const FC = await import('../src/factory/floorcache.ts');
  const FF = (await import('../src/factory/factory.ts')).Factory as unknown as { floorSendOps: number; floorBudget: number };
  if (flag('--floor-group')) FC.FloorCache.groupTiles = Number(opt('--floor-group', '48'));
  if (flag('--floor-send')) FF.floorSendOps = Number(opt('--floor-send', '800'));
  if (flag('--floor-budget')) FF.floorBudget = Number(opt('--floor-budget', '8000'));
  // --floor-exact: every partial flush checks the diff's invariant exactly (floorcache verifyExact)
  // --pix-split: the cache replays every subpath as its own path (a rasteriser then draws each one
  // alike whatever its siblings are: see --floor-pixels)
  if (flag('--pix-split')) FC.FloorCache.split = true;
  if (flag('--floor-exact')) { FC.FloorCache.verifyExact = true; if (flag('--floor-exact-log')) FC.FloorCache.verify = true; }
  // --floor-whole: every data repaint sent whole (the control for --floor-pixels)
  if (flag('--floor-whole')) (FF as unknown as { floorWhole: boolean }).floorWhole = true;
}
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
// --floor-pixels [cpu|gpu|agent] (fab-w7c): every floor draw goes through Exact's recorder into a
// Chromium canvas that keeps it (tools/floorpix.ts), and after each repaint floorcache finishes,
// that canvas is compared with a fresh whole repaint of the list it claims to show ('F') and with
// a direct paint of the floor made the moment the list's recording ended ('D')
const PIXMODE = flag('--floor-pixels') ? (() => { const v = opt('--floor-pixels', 'cpu'); return v && !v.startsWith('--') ? v : 'cpu'; })() : '';
let pixFac: { fc: { paintShown: (c: unknown) => boolean; paintRecording: (c: unknown) => void }; paintFloor: (c: unknown, f: unknown) => void } | null = null;
const pixSeam = PIXMODE ? (await import(`${process.env.EXACT2 ?? '/home/farce/src/exact'}/canvas/recorder.js`)).canvasSeam((s: string, a: unknown[], c: unknown, f: unknown) => {
  if (s === 'floorRef') { pixFac!.fc.paintShown(c); return false; }
  if (s === 'floorDirect') { pixFac!.paintFloor(c, f); return false; }
  if (s === 'floorRec') { pixFac!.fc.paintRecording(c); return false; }
  return drawRaw(s, a, c, f);
}) : null;
const pix = PIXMODE ? await (await import('./floorpix.ts')).openPix(PIXMODE, W, H, 2, process.env.EXACT2 ?? '/home/farce/src/exact') : null;
if (pix) await pix.fresh('P');
const drawVia = (surface: string, a: unknown[], c: RecordingCtx, f: ReturnType<typeof frame>): boolean => {
  if (pixSeam && surface === 'factoryFloor') {
    const out = JSON.parse(pixSeam.draw({ canvas: 1, generation: 1, surface, args: a, frame: f }, measureHost)) as { lists: string[]; frame: boolean; error: string | null };
    if (out.error) console.log(`floor draw error: ${out.error}`);
    pix!.put('P', out.lists);
    let bytes = 0;
    for (const l of out.lists) bytes += l.length;
    c.counts.bytes = Math.round(bytes * 0.75);
    return out.frame;
  }
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
const floorAllMs: number[] = [];
let pixAfterFloor: () => void = () => {};
const floorStep = (cause: string) => {
  floorCtx.reset();
  const a = performance.now();
  floorAwake = drawVia('factoryFloor', [key, route, ZOOM], floorCtx, frame(t, cause));
  const ms = performance.now() - a;
  floorAllMs.push(ms);
  const n = REAL || PIXMODE ? (floorCtx.counts.bytes ?? 0) : floorCtx.total();
  pixAfterFloor();
  if (n > (REAL || PIXMODE ? 64 : 2)) { floorSent.push(n); floorSentMs.push(ms); floorDraws++; } else { floorOtherMs += ms; floorOtherN++; floorMaxOther = Math.max(floorMaxOther, ms); }
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
// --floor-pixels: the checks (see drawVia). Each repaint floorcache finishes (whole, partial, or
// nothing to send) queues one; the loops run it before the next frame. Per data repaint k:
//   stale  F(k) vs F(k-1) outside the tiles flush k repainted: what a full repaint changes must lie
//          in the repainted tiles (0 pixels, or a pixel the canvas keeps is stale);
//   kept   the canvas vs F(k) outside every tile repainted since the last whole one: 0 pixels;
//   AA     the canvas vs F(k) inside them: the clip's antialiasing (a clipped repaint rasterises
//          edges a few levels differently in Chromium; same geometry, same colours);
//   rec    a whole replay of the recording vs a direct paint of the floor the moment the recording
//          ended (floorcache's recorder vs the canvas: 0 pixels);
//   creep  F(k) vs that recording: items kept by the diff that moved under 1/64 px carry the
//          numbers the canvas shows (`carry`).
type PixStat = { n: number; bad: number; maxN: number; maxD: number; sumN: number; hist: number[]; worstAt: string };
const pixStat = (): PixStat => ({ n: 0, bad: 0, maxN: 0, maxD: 0, sumN: 0, hist: [0, 0, 0, 0], worstAt: '' });
const PIXS: Record<string, PixStat> = { stale: pixStat(), kept: pixStat(), aa: pixStat(), rec: pixStat(), creep: pixStat(), whole: pixStat() };
const PIXOUT = opt('--pix-out', '');
let pixFlushes = -1, pixEmpty = 0, pixGen = 1, pixChecks = 0, pixKinds: Record<string, number> = { partial: 0, empty: 0, whole: 0 };
type PixDue = { kind: string; ref: string[]; direct: string[] | null; recd: string[] | null; mask: number[] | null; tiles: number; at: number };
let pixDue: PixDue | null = null;
let pixDirect: { rec: number; lists: string[]; recd: string[] } | null = null;
/** Tiles repainted since the last whole repaint (null: none). */
let pixUnion: number[] | null = null;
let pixHaveF = false;
const await_FC = PIXMODE ? await import('../src/factory/floorcache.ts') : null;
if (PIXMODE) {
  pixFac = fac as unknown as typeof pixFac;
  const FF = fac as unknown as { paintSteps: (c: unknown, f: unknown, b: number) => Generator<void, void, void>; fc: { list: { rec: number } } };
  const ps0 = FF.paintSteps;
  // a data repaint recorded over frames: the moment its recording ends, the floor painted directly,
  // and the recording replayed whole (before the diff carries anything into it)
  FF.paintSteps = function* (this: unknown, c: unknown, f: unknown, b: number) {
    yield* ps0.call(this, c, f, b);
    if (b < Infinity) {
      const rec = FF.fc.list.rec;
      const lists = (JSON.parse(pixSeam!.draw({ canvas: 3, generation: ++pixGen, surface: 'floorDirect', args: [], frame: f }, measureHost)) as { lists: string[] }).lists;
      const recd = (JSON.parse(pixSeam!.draw({ canvas: 4, generation: ++pixGen, surface: 'floorRec', args: [], frame: f }, measureHost)) as { lists: string[] }).lists;
      pixDirect = { rec, lists, recd };
      if (flag('--pix-why-rec')) {
        // the floor recorded again now, all at once: which items moved while it was recorded in steps
        const FC = await_FC!;
        const r2 = new FC.FRec();
        r2.measurer = c as never;
        r2.begin(W, H);
        (fac as unknown as { paintFloor: (c: unknown, f: unknown) => void }).paintFloor(r2, f);
        const A = (fac.fc as unknown as { list: InstanceType<typeof FC.FList> }).list, B = r2.L;
        const out: string[] = [];
        const n = Math.max(A.n, B.n);
        for (let i = 0; i < n && out.length < 12; i++) {
          if (i < A.n && i < B.n && A.iKey[i] === B.iKey[i] && A.iF[i] === B.iF[i]) continue;
          const d = (L: typeof A, j: number) => { if (j >= L.n) return '-'; const st = L.states[L.iS[j]]; return `k${L.iK[j]} ${String(L.iK[j] === 2 || L.iK[j] === 4 ? st.stroke : st.fill)} box ${[0, 1, 2, 3].map((q) => L.iB[j * 4 + q].toFixed(2)).join(',')}${L.iT[j] ? ` "${L.iT[j]}"` : ''}`; };
          out.push(`#${i} ${d(A, i)} → ${d(B, i)}`);
        }
        if (out.length) console.log(`    stepped vs at once (${A.n} / ${B.n} items): ${out.join(' | ')}`);
      }
    }
  };
  pixAfterFloor = () => {
    const fc = fac.fc as unknown as { valid: boolean; pending: boolean; totals: { flushes: number; empty: number }; last: { whole: boolean; tiles: number }; shownList: { rec: number } | null; dirty: { d: Uint8Array } };
    if (!fc.valid) { if (!fc.pending) pixHaveF = false; return; }
    if (fc.pending || fc.totals.flushes === pixFlushes) return;
    const kind = fc.totals.empty !== pixEmpty ? 'empty' : fc.last.whole ? 'whole' : 'partial';
    pixFlushes = fc.totals.flushes; pixEmpty = fc.totals.empty;
    const ref = (JSON.parse(pixSeam!.draw({ canvas: 2, generation: ++pixGen, surface: 'floorRef', args: [], frame: frame(t, 'args') }, measureHost)) as { lists: string[] }).lists;
    const rec = fc.shownList!.rec, dd = pixDirect && pixDirect.rec === rec ? pixDirect : null;
    pixDue = { kind, ref, direct: dd?.lists ?? null, recd: dd?.recd ?? null, mask: kind === 'partial' ? Array.from(fc.dirty.d) : kind === 'empty' ? [] : null, tiles: fc.last.tiles, at: t };
  };
}
const pixNote = (S: PixStat, r: { n: number; max: number; hist: number[]; worst: number[]; box: number[] }, label: string) => {
  S.n++; S.sumN += r.n;
  if (r.n) S.bad++;
  for (let k = 0; k < 4; k++) S.hist[k] += r.hist[k];
  if (r.max > S.maxD) S.maxD = r.max;
  if (r.n > S.maxN) { S.maxN = r.n; S.worstAt = `${label} box ${r.box.join(',')} worst ${r.worst.join(',')}`; return true; }
  return false;
};
const pixCheck = async () => {
  const d = pixDue!;
  pixDue = null;
  pixChecks++; pixKinds[d.kind]++;
  const label = `t=${(d.at / 1000).toFixed(1)}s ${d.kind} tiles ${d.tiles}`;
  const P = pix!;
  if (pixHaveF) await P.keep('F', 'Fprev');
  await P.fresh('F'); P.put('F', d.ref);
  if (d.mask === null) {
    // a whole repaint: the canvas is exactly F
    const w = await P.cmp('P', 'F');
    pixNote(PIXS.whole, w, label);
    if (w.n) console.log(`  pixels: WHOLE ${label}: canvas ≠ F ${w.n} px max ${w.max}`);
    pixUnion = null;
  } else {
    if (pixHaveF) {
      const st = await P.cmp('F', 'Fprev', d.mask, true);
      if (pixNote(PIXS.stale, st, label) && PIXOUT) await P.savePng(`${PIXOUT}/worst-stale.png`, 'F', 'Fprev');
      if (st.n) console.log(`  pixels: STALE ${label}: ${st.n} px a full repaint changed outside the repainted tiles, max ${st.max}, box ${st.box.join(',')}`);
      if (st.n && flag('--pix-why')) pixWhere(st.pts);
    }
    if (d.mask.length) { if (!pixUnion) pixUnion = d.mask.slice(); else for (let i = 0; i < d.mask.length; i++) pixUnion[i] |= d.mask[i]; }
    const u = pixUnion ?? [];
    const kept = await P.cmp('P', 'F', u, true);
    if (pixNote(PIXS.kept, kept, label) && PIXOUT) await P.savePng(`${PIXOUT}/worst-kept.png`, 'P', 'F');
    if (kept.n) console.log(`  pixels: KEPT ${label}: canvas ≠ F outside the repainted tiles ${kept.n} px, max ${kept.max}, box ${kept.box.join(',')}`);
    if (u.length) {
      const aa = await P.cmp('P', 'F', u, false);
      if (pixNote(PIXS.aa, aa, label) && PIXOUT) await P.savePng(`${PIXOUT}/worst-aa.png`, 'P', 'F');
    }
    if (flag('--pix-why') && kept.n) pixWhy();
  }
  pixHaveF = true;
  if (d.direct && d.recd) {
    await P.fresh('D'); P.put('D', d.direct);
    await P.fresh('Rc'); P.put('Rc', d.recd);
    const rc = await P.cmp('Rc', 'D');
    if (pixNote(PIXS.rec, rc, label) && PIXOUT) { await P.savePng(`${PIXOUT}/worst-rec.png`, 'Rc', 'D'); await P.savePng(`${PIXOUT}/worst-rec-D.png`, 'D'); }
    if (rc.n) console.log(`  pixels: REC ${label}: recording ≠ direct paint ${rc.n} px max ${rc.max} hist ${rc.hist.join('/')} box ${rc.box.join(',')} worst ${rc.worst.join(',')}`);
    const cr = await P.cmp('F', 'Rc');
    pixNote(PIXS.creep, cr, label);
  }
};
const PIX_CHANGES = Number(opt('--pix-changes', '0'));
// --pix-why: the items under the pixels a full repaint changed outside the repainted tiles (both
// lists; = the other list has an item with the same key)
const pixWhere = (pts: number[]) => {
  const fc = fac.fc as unknown as { lists: { n: number; iKey: Float64Array; iS: Int32Array; iK: Int32Array; iB: Float64Array; iT: string[]; states: { fill: unknown; stroke: unknown; lw: number }[] }[]; shownList: unknown };
  const B = fc.shownList as (typeof fc.lists)[0], A = fc.lists[0] === B ? fc.lists[1] : fc.lists[0];
  const keys = (L: typeof A) => { const m = new Set<number>(); for (let i = 0; i < L.n; i++) m.add(L.iKey[i]); return m; };
  const kA = keys(A), kB = keys(B);
  const seen = new Set<string>();
  for (let k = 0; k < pts.length && seen.size < 10; k += 3) {
    const x = pts[k] / 2, y = pts[k + 1] / 2;
    for (const [nm, L, other] of [['old', A, kB], ['new', B, kA]] as const) {
      for (let i = 0; i < L.n; i++) {
        const o = i * 4;
        if (x < L.iB[o] - 3 || x > L.iB[o + 2] + 3 || y < L.iB[o + 1] - 3 || y > L.iB[o + 3] + 3) continue;
        if (other.has(L.iKey[i])) continue;
        const st = L.states[L.iS[i]], id = `${nm} #${i}`;
        if (seen.has(id)) continue;
        seen.add(id);
        console.log(`    at ${x},${y} (${pts[k + 2]}): ${id} k${L.iK[i]} ${String(L.iK[i] === 2 || L.iK[i] === 4 ? st.stroke : st.fill)} lw ${st.lw} box ${[0, 1, 2, 3].map((q) => L.iB[o + q].toFixed(1)).join(',')}${L.iT[i] ? ` "${L.iT[i]}"` : ''}`);
      }
    }
  }
};
// --pix-why: what differs, exactly, between the items the two lists share a key (1/64 px) for
const pixWhy = () => {
  const fc = fac.fc as unknown as { lists: { n: number; iKey: Float64Array; iS: Int32Array; iM: Int32Array; iP0: Int32Array; iP1: Int32Array; iA: Float64Array; iK: Int32Array; sg: Float64Array; mats: Float64Array; states: Record<string, unknown>[] }[]; shownList: unknown };
  const B = fc.shownList as (typeof fc.lists)[0], A = fc.lists[0] === B ? fc.lists[1] : fc.lists[0];
  const at = new Map<number, number>();
  for (let i = A.n - 1; i >= 0; i--) at.set(A.iKey[i], i);
  const tally = new Map<string, [number, number]>();
  const note = (k: string, d: number) => { const v = tally.get(k) ?? [0, 0]; v[0]++; if (d > v[1]) v[1] = d; tally.set(k, v); };
  for (let j = 0; j < B.n; j++) {
    const i = at.get(B.iKey[j]);
    if (i === undefined) continue;
    const sa = A.states[A.iS[i]], sb = B.states[B.iS[j]];
    for (const f of Object.keys(sb)) { const x = sa[f], y = sb[f]; if (typeof y === 'number' && x !== y) note(`state.${f}`, Math.abs((x as number) - y)); else if (typeof y === 'string' && x !== y) note(`state.${f} ${String(x)}→${y}`, 1); }
    for (let k = 0; k < 6; k++) { const d = Math.abs(A.mats[A.iM[i] * 6 + k] - B.mats[B.iM[j] * 6 + k]); if (d) note(`item matrix[${k}]`, d); }
    for (let k = 0; k < 4; k++) { const d = Math.abs(A.iA[i * 4 + k] - B.iA[j * 4 + k]); if (d) note(`args kind ${B.iK[j]}`, d); }
    const n = A.iP1[i] - A.iP0[i];
    if (n !== B.iP1[j] - B.iP0[j]) { note('segment count', 1); continue; }
    for (let k = 0; k < n;) {
      const a0 = A.iP0[i] + k, b0 = B.iP0[j] + k, op = B.sg[b0], m = [0, 2, 2, 4, 6, 6, 8, 4, 5, 0][op] ?? 0;
      for (let q = 0; q < 6; q++) { const d = Math.abs(A.mats[A.sg[a0 + 1] * 6 + q] - B.mats[B.sg[b0 + 1] * 6 + q]); if (d) note(`segment matrix[${q}]`, d); }
      for (let q = 2; q < m + 2; q++) { const d = Math.abs(A.sg[a0 + q] - B.sg[b0 + q]); if (d) note(`segment op ${op}`, d); }
      k += 2 + m;
    }
  }
  console.log(`    why (items with equal keys, A ${A.n} → B ${B.n}): ${[...tally].map(([k, [n, d]]) => `${k} ×${n} max ${d.toExponential(2)}`).join(' · ') || 'nothing differs'}`);
};
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
  if (pixDue) await pixCheck();
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
floorSent.length = 0; floorSentMs.length = 0; floorAllMs.length = 0; floorOtherMs = 0; floorOtherN = 0; floorMaxOther = 0;
liveBytes = 0; topBytes = 0;
const fl0 = { ...fac.ret.totals };
// --floor-debug: what the floor's partial repaints send, by paint (fab-w7b); --floor-time: the
// data repaint's record, diff and flush, timed
const FDBG = flag('--floor-debug');
const FT = { rec: [] as number[], diff: [] as number[], flush: [] as number[] };
if (flag('--floor-time')) {
  const FC = await import('../src/factory/floorcache.ts');
  const F = fac as unknown as { paintFloor: (c: unknown, f: unknown) => void; fc: { prepare: (w?: boolean) => boolean; list: InstanceType<typeof FC.FList>; shownList: InstanceType<typeof FC.FList> | null } };
  const p0 = F.paintFloor.bind(fac), f0 = F.fc.prepare.bind(F.fc);
  F.paintFloor = (c: unknown, f: unknown) => { const a = performance.now(); p0(c, f); if (c instanceof FC.FRec) FT.rec.push(performance.now() - a); };
  const TT = new FC.Tiles();
  F.fc.prepare = (w?: boolean) => {
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
    const a = performance.now(); const r = f0(w); FT.flush.push(performance.now() - a); return r;
  };
}
const fdbg = new Map<string, [number, number]>();
if (FDBG) {
  const FC = await import('../src/factory/floorcache.ts');
  const fc = fac.fc as unknown as { prepare: (w?: boolean) => boolean; step: (c: unknown, b: number) => boolean; list: InstanceType<typeof FC.FList> };
  const f0 = fc.prepare.bind(fc), s0 = fc.step.bind(fc);
  let A0: InstanceType<typeof FC.FList> | null = null;
  fc.prepare = (w?: boolean) => {
    FC.FloorReplay.dbg = [];
    A0 = (fac.fc as unknown as { shownList: InstanceType<typeof FC.FList> | null }).shownList;
    FC.diffDbg.on = flag('--floor-debug-each'); FC.diffDbg.marks = [];
    return f0(w);
  };
  fc.step = (c: unknown, b: number) => {
    const r = s0(c, b);
    if (!r) return r;
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
  if (pixDue) await pixCheck();
  if (PIX_CHANGES && pixKinds.partial + pixKinds.empty >= PIX_CHANGES) { console.log(`floor pixels: ${PIX_CHANGES} data repaints checked at frame ${i}`); break; }
  ops.push(REAL ? (ctx.counts.bytes ?? 0) : ctx.total()); if (REAL) ctx.counts.bytes = 0;
  tops.push(REAL ? (topCtx.counts.bytes ?? 0) : topCtx.total()); if (REAL) topCtx.counts.bytes = 0;
}
if (PIXMODE) {
  if (PIXOUT) await pix!.savePng(`${PIXOUT}/last-P.png`, 'P');
  const fmt = (S: PixStat) => `${S.n} checked, ${S.bad} with any pixel differing, max ${S.maxN} px (mean ${(S.sumN / Math.max(1, S.n)).toFixed(1)}), max level ${S.maxD}, by level 1-2/3-8/9-32/33+: ${S.hist.join('/')}${S.worstAt ? `; worst ${S.worstAt}` : ''}`;
  console.log(`floor pixels (${PIXMODE}, ${pix!.pw}x${pix!.ph}): ${pixChecks} repaints checked (${pixKinds.partial} partial, ${pixKinds.empty} with nothing to send, ${pixKinds.whole} whole)`);
  console.log(`  stale (a full repaint changed a pixel outside the repainted tiles): ${fmt(PIXS.stale)}`);
  console.log(`  kept (canvas vs full repaint, outside every tile repainted since the last whole): ${fmt(PIXS.kept)}`);
  console.log(`  AA (canvas vs full repaint, inside the repainted tiles): ${fmt(PIXS.aa)}`);
  console.log(`  whole (canvas vs full repaint after a whole one): ${fmt(PIXS.whole)}`);
  console.log(`  rec (the recording replayed whole vs a direct paint at its end): ${fmt(PIXS.rec)}`);
  console.log(`  creep (the full repaint vs the recording before the diff carried creep into it): ${fmt(PIXS.creep)}`);
  const V = (await import('../src/factory/floorcache.ts')).FloorCache.verified;
  if (V.n) console.log(`  exact (every piece on a kept tile painted bit for bit the same in both lists): ${V.n} flushes checked, ${V.bad} failed, ${V.pieces} pieces compared${V.first ? `; first: ${V.first}` : ''}`);
  console.log(JSON.stringify({ floorPixels: { mode: PIXMODE, exact: V, checks: pixChecks, kinds: pixKinds, ...PIXS, nanBoxes: (await import('../src/factory/floorcache.ts')).Tiles.nan, floorCache: fac.fc.totals } }));
  await pix!.close();
  process.exit(0);
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
// --floor-steps B: record the floor into floorcache in steps of B numbers (factory.ts paintSteps), time each step
if (flag('--floor-steps')) {
  const B = Number(opt('--floor-steps', '24000'));
  const F = fac as unknown as { paintSteps: (c: unknown, f: unknown, b: number) => Generator<void, void, void>; fc: { begin: (W: number, H: number, m: unknown) => unknown; list: { sn: number; n: number } } };
  for (let rep = 0; rep < 4; rep++) {
    const c = F.fc.begin(W, H, floorCtx);
    const g = F.paintSteps(c, frame(t, 'args'), B);
    const out: string[] = [];
    let done = false, sn = 0;
    while (!done) {
      const a = performance.now();
      done = !!g.next().done;
      out.push(`${(performance.now() - a).toFixed(1)}ms/${((F.fc.list.sn - sn) / 1000).toFixed(1)}k`);
      sn = F.fc.list.sn;
    }
    console.log(`floor steps (budget ${B}): ${out.join(' ')} · total ${(sn / 1000).toFixed(1)}k numbers, ${F.fc.list.n} items`);
  }
  process.exit(0);
}
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
  floorDrawMs: { n: floorAllMs.length, p50: floorAllMs.length ? +q(floorAllMs, 0.5).toFixed(3) : 0, p95: floorAllMs.length ? +q(floorAllMs, 0.95).toFixed(3) : 0, max: floorAllMs.length ? +Math.max(...floorAllMs).toFixed(3) : 0, top5: [...floorAllMs].sort((a, b) => b - a).slice(0, 5).map((v) => +v.toFixed(1)) },
  floorCache: { ...fac.fc.totals, last: fac.fc.last, exact: (await import('../src/factory/floorcache.ts')).FloorCache.verified, nanBoxes: (await import('../src/factory/floorcache.ts')).Tiles.nan }, quality: o.quality, stats: o.facStats ?? '', ...(REAL ? { real: true, sentKBPerFrame: +((liveBytes + topBytes) * 0.75 / 1024 / FRAMES).toFixed(1) } : {}),
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
  console.log(`floor repaint ms: whole records ${m(FT.rec)} · diff ${m(FT.diff)} · prepare (diff + plan) ${m(FT.flush)}`);
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
