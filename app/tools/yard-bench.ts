// The Yard's draws, timed in Bun through Exact's own recorder (canvas/recorder.js: the context a
// native draw records into, base64'd for the host): per canvas, how often it draws, its ms, its
// list's bytes and ops, as the host would run it. Real time: the server's stream plays at its own
// pace (Bun has no Exact stream, so `fetch(…, { exactStream })` is answered with a WebSocket).
//
//   bun tools/yard-bench.ts [<server url>] [--frames N] [--warm s] [--size 1440x900] [--hermes]
//       [--hud] [--ops] [--phases]
//
// `--hermes` prices the frame budget as the macOS data module does; BUN_JSC_useJIT=0 gives an
// interpreter's proportions (Hermes is one). `--ops` breaks each canvas's bytes down by list op.
// `--phases` times yardLive's phases (Yard.phase).
const args = process.argv.slice(2);
const opt = (name: string, def: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : def; };
const flag = (name: string) => args.includes(name);
const server = args.find((a, i) => !a.startsWith('--') && !['--frames', '--warm', '--size'].includes(args[i - 1] ?? '')) ?? 'http://127.0.0.1:8361';
const FRAMES = Number(opt('--frames', '600'));
const WARM = Number(opt('--warm', '8'));
const [W, H] = opt('--size', '1440x868').split('x').map(Number);
const SCALE = Number(opt('--scale', '1'));
if (flag('--hermes')) (globalThis as { HermesInternal?: unknown }).HermesInternal = {};
(globalThis as { scheduler?: unknown }).scheduler = { yield: () => new Promise<void>((r) => setTimeout(r, 0)) };

// Exact's stream, over a Bun WebSocket
let streamN = 0, streamLast = '';
// --fed: the overview is asked as the app's `fed` task asks it (app.contract: 250 ms after a
// stream message, at most 4 times a second), besides the pulse; T0 is set before any message
let fedAt = -1;
const T0 = performance.now();
const streamMs: number[] = [];
const realFetch = globalThis.fetch;
globalThis.fetch = ((url: string, init?: { exactStream?: (ev: Record<string, unknown>) => unknown }) => {
  if (!init?.exactStream) return realFetch(url as never, init as never);
  const cb = init.exactStream;
  return new Promise((resolve) => {
    const ws = new WebSocket(String(url).replace(/^http/, 'ws'));
    ws.onopen = () => cb({ type: 'open' });
    ws.onmessage = (m) => { const a = performance.now(); const r = cb({ type: 'message', data: String(m.data) }) as { status: string }; streamN++; streamLast = r?.status ?? ''; streamMs.push(performance.now() - a); if (fedAt < 0) fedAt = performance.now() - T0 + 1000 + 250; };
    ws.onerror = () => cb({ type: 'error', kind: 'Network', message: 'ws error' });
    ws.onclose = () => { cb({ type: 'close' }); resolve(new Response('')); };
  });
}) as typeof fetch;

const mod = await import('../app.ts');
// the info layer (its stats: panels asked, unchanged, in parts, whole)
let infoLayer: { stats: Record<string, number> } | null = null;
{
  const { InfoLayer } = await import('../src/yard/info.ts');
  const IP = InfoLayer.prototype as unknown as { draw: (...a: unknown[]) => boolean };
  const d0 = IP.draw;
  IP.draw = function (this: { stats: Record<string, number> }, ...a: unknown[]) { infoLayer = this; return d0.apply(this, a); };
  if (flag('--debug')) (InfoLayer as unknown as { debug: boolean }).debug = true;
  if (flag('--no-gate')) { (InfoLayer as unknown as { gate: boolean }).gate = false; const { Yard } = await import('../src/yard/draw.ts'); (Yard as unknown as { gateStatic: boolean }).gateStatic = false; }
}
// --phases: yardLive's bytes by phase (Yard's private draw steps, timed through the recorder's writer)
const phaseB: Record<string, number> = {};
let phaseFrames = 0;
if (flag('--phases')) {
  const { Yard } = await import('../src/yard/draw.ts');
  const YP = Yard.prototype as unknown as Record<string, (...a: unknown[]) => unknown>;
  for (const name of ['rings', 'packets', 'effects', 'nowBob', 'dial', 'strip', 'labels', 'drawTrains']) {
    const f0 = YP[name];
    if (typeof f0 !== 'function') continue;
    YP[name] = function (this: unknown, ...a: unknown[]) {
      const g = a[0] as { ctx: { _?: { writer?: { len: number } } } };
      const wr = () => g.ctx?._?.writer?.len ?? 0;
      const b0 = wr();
      const r = f0.apply(this, a);
      phaseB[name] = (phaseB[name] ?? 0) + wr() - b0;
      return r;
    };
  }
}
// --paint: each info panel's paint (its hash pass, and its repaint when one is needed), timed
const paintMs: Record<string, number[]> = {};
if (flag('--paint')) {
  const { InfoLayer } = await import('../src/yard/info.ts');
  const P = InfoLayer.prototype as unknown as { paint: (g: unknown, v: unknown, p: { id: string }, full: boolean) => void; panels: (v: unknown) => unknown };
  const pa = P.paint, pn = P.panels;
  P.paint = function (this: unknown, g: unknown, v: unknown, p: { id: string }, full: boolean) { const a = performance.now(); pa.call(this, g, v, p, full); (paintMs[p.id] ??= []).push(performance.now() - a); };
  P.panels = function (this: unknown, v: unknown) { const a = performance.now(); const r = pn.call(this, v); (paintMs['(panels)'] ??= []).push(performance.now() - a); return r; };
}
// --panels: which info panels each info draw repainted, and their ops
const panelLog: string[] = [];
if (flag('--panels')) {
  const { InfoLayer } = await import('../src/yard/info.ts');
  const P = InfoLayer.prototype as unknown as { panels: (v: unknown) => { id: string; draw: (g: { ops: number; texts: number }, v: unknown, r: unknown) => void }[] };
  const orig = P.panels;
  P.panels = function (this: unknown, v: unknown) {
    const ps = orig.call(this, v);
    for (const p of ps) { const d = p.draw; p.draw = (g, vv, r) => { const o = g.ops, tx = g.texts, a = performance.now(); d(g, vv, r); panelLog.push(`${p.id}:${g.ops - o}/${g.texts - tx}t/${(performance.now() - a).toFixed(1)}`); }; }
    return ps;
  };
}
// --alloc: bytes allocated per call (run with the collector held off: BUN_JSC_largeHeapSize=8000000000
// BUN_JSC_smallHeapSize=8000000000), as the growth of JSC's heap blocks plus mimalloc's (strings,
// buffers) across each overview and each canvas draw: what Hermes would have to collect
const allocKB: Record<string, number[]> = {};
const jsc = flag('--alloc') ? await import('bun:jsc') : null;
const heapNow = () => (jsc ? jsc.heapStats().heapCapacity + jsc.memoryUsage().current : 0);
const { sources, draw } = mod as unknown as { sources: Record<string, (a: unknown[], s?: unknown, st?: unknown) => unknown>; draw: (s: string, a: unknown[], c: unknown, f: unknown) => boolean };
const store = { get: () => '', set() {} };
const now = () => performance.now() - T0 + 1000;
const epoch0 = Date.now() - now();
const conn = (await sources.connect([server, '', 1, epoch0, 0], store, {})) as { ok: boolean; status: string; seq: number; error?: string };
if (!conn.ok) { console.error(`connect: ${conn.status} ${conn.error ?? ''}`); process.exit(1); }
void sources.liveFeed([server, '', conn.seq, 1, true], store, {});
sources.viewOnTop(['yard'], store, {});
if (flag('--hud')) sources.devToggle(['hud', 1]);

const EXACT = process.env.EXACT2 ?? '/home/farce/src/exact';
const seam = (await import(`${EXACT}/canvas/recorder.js`)).canvasSeam((s: string, a: unknown[], c: unknown, f: unknown) => draw(s, a, c, f));
const measureHost = { measure: (j: string) => { const r = JSON.parse(j); const w = 7.2 * String(r.text).length; return JSON.stringify([w, 0, w, 9, 3, 11, 3, 9, 3, 0, 0]); }, image: () => '' };

const OPN: Record<number, string> = { 1: 'save', 2: 'restore', 3: 'reset', 4: 'setTransform', 10: 'fillColor', 12: 'strokeColor', 14: 'lineWidth', 15: 'lineCap', 16: 'lineJoin', 18: 'lineDash', 20: 'globalAlpha', 40: 'beginPath', 41: 'moveTo', 42: 'lineTo', 43: 'quadTo', 44: 'cubicTo', 45: 'closePath', 50: 'fill', 51: 'stroke', 52: 'clip', 53: 'fillRect', 54: 'strokeRect', 55: 'clearRect', 60: 'font', 61: 'fillText' };
type Stat = { draws: number; asked: number; ms: number[]; bytes: number[]; ops: number[]; byOp: Record<string, number> };
const stat = (): Stat => ({ draws: 0, asked: 0, ms: [], bytes: [], ops: [], byOp: {} });
const CAN = ['yardStatic', 'yardInfo', 'yardLive', 'yardTop'] as const;
const S: Record<string, Stat> = Object.fromEntries(CAN.map((c) => [c, stat()]));
const ids: Record<string, number> = { yardStatic: 1, yardInfo: 2, yardLive: 3, yardTop: 4 };
const gen: Record<string, number> = { yardStatic: 1, yardInfo: 1, yardLive: 1, yardTop: 1 };
const frame = (time: number, cause: string) => ({ time, mounted: 0, cause, causes: [cause], width: W, height: H, pixelWidth: W * SCALE, pixelHeight: H * SCALE, scale: SCALE });

function ops(b64: string, st: Stat | null): number {
  const buf = Buffer.from(b64, 'base64');
  let at = 8, n = 0;
  while (at + 8 <= buf.length) {
    const code = buf.readUInt32LE(at), count = buf.readUInt32LE(at + 4);
    at += 8 + count * 8; n++;
    if (st) { const k = OPN[code] ?? `op${code}`; st.byOp[k] = (st.byOp[k] ?? 0) + 8 + count * 8; }
  }
  return n;
}

function drawOne(c: string, a: unknown[], time: number, cause: string, measure: boolean): boolean {
  const m0 = jsc && measure ? heapNow() : 0;
  const t0 = performance.now();
  const out = JSON.parse(seam.draw({ canvas: ids[c], generation: gen[c], surface: c, args: a, frame: frame(time, cause) }, measureHost)) as { lists: string[]; frame: boolean; error: string | null };
  const ms = performance.now() - t0;
  if (jsc && measure) (allocKB[c] ??= []).push((heapNow() - m0) / 1024);
  if (out.error) console.log(`${c}: ${out.error}`);
  if (measure) {
    const st = S[c];
    st.draws++; if (out.frame) st.asked++;
    st.ms.push(ms);
    let bytes = 0, n = 0;
    for (const l of out.lists) { bytes += l.length * 0.75; n += ops(l, flag('--ops') ? st : null); }
    st.bytes.push(bytes); st.ops.push(n);
    if (flag('--log-live') && c === 'yardLive') console.log(`  ${(time / 1000).toFixed(2)}s yardLive ${cause} → ${out.frame ? 'asks' : 'still'} ${(bytes / 1024).toFixed(1)} KB`);
    if (flag('--log') && c !== 'yardLive') console.log(`  ${(time / 1000).toFixed(2)}s ${c} ${cause} ${ms.toFixed(2)} ms ${(bytes / 1024).toFixed(1)} KB ${n} ops ${c === 'yardInfo' ? panelLog.join(' ') : ''}`);
    panelLog.length = 0;
  }
  return out.frame;
}

type Ov = { layoutKey: string; stress: boolean; tick: number; hud: boolean; pace: number; quality: number; status: string };
const last: Record<string, string> = {};
const wants: Record<string, boolean> = {};
let ov = sources.overview([now()], store, {}) as Ov;
let lastOv = now();
const frameMs: number[] = [];
const ovMs: number[] = [];
let mounted = false;
async function run(n: number, measure: boolean): Promise<void> {
  let next = now();
  for (let i = 0; i < n; i++) {
    next += 1000 / 60;
    const wait = next - now();
    if (wait > 0) await Bun.sleep(wait); else await Bun.sleep(0);
    const t = now();
    const fed = flag('--fed') && fedAt >= 0 && t >= fedAt;
    if (fed) fedAt = -1;
    if (fed || t - lastOv >= (ov.pace ? 1000 : 250)) { const m0 = jsc && measure ? heapNow() : 0; const o0 = performance.now(); ov = sources.overview([t], store, {}) as Ov; lastOv = t; if (measure) ovMs.push(performance.now() - o0); if (jsc && measure) (allocKB.overview ??= []).push((heapNow() - m0) / 1024); }
    const argv: Record<string, unknown[]> = {
      yardStatic: [ov.layoutKey, ov.stress], yardInfo: [ov.layoutKey, ov.tick], yardLive: ['full', '', ov.tick], yardTop: [ov.hud, ''],
    };
    let work = 0;
    for (const c of CAN) {
      const k = JSON.stringify(argv[c]);
      const cause = !mounted ? 'mount' : k !== last[c] ? 'args' : wants[c] ? 'frame' : '';
      if (!cause) continue;
      last[c] = k;
      const a = performance.now();
      if (c === 'yardLive' && measure) phaseFrames++;
      wants[c] = drawOne(c, argv[c], t, cause, measure);
      work += performance.now() - a;
    }
    mounted = true;
    if (measure && work > 0) frameMs.push(work);
  }
}

const q = (xs: number[], p: number) => { if (!xs.length) return 0; const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
await run(WARM * 60, false);
await run(FRAMES, true);
console.log(`yard-bench ${server} ${W}x${H}@${SCALE} ${FRAMES} frames${flag('--hermes') ? ' --hermes' : ''}${process.env.BUN_JSC_useJIT === '0' ? ' (no JIT)' : ''} · quality q${ov.quality}`);
console.log(`stream: ${streamN} messages, last ${streamLast} · overview ${ovMs.length} calls, ms p50 ${q(ovMs, 0.5).toFixed(2)} p99 ${q(ovMs, 0.99).toFixed(2)} max ${q(ovMs, 1).toFixed(2)}`);
console.log(`stream messages: ms ${streamMs.map((x) => x.toFixed(1)).join(' ')}`);
console.log(`frames with work ${frameMs.length}/${FRAMES} · work ms p50 ${q(frameMs, 0.5).toFixed(2)} p90 ${q(frameMs, 0.9).toFixed(2)} p99 ${q(frameMs, 0.99).toFixed(2)} max ${q(frameMs, 1).toFixed(2)}`);
if (flag('--phases')) console.log(`yardLive bytes a frame by phase: ${Object.entries(phaseB).map(([k, v]) => `${k} ${(v / Math.max(1, phaseFrames) / 1024).toFixed(2)}K`).join(' · ')}`);
if (jsc) { const all = heapNow(); void all; for (const [k, xs] of Object.entries(allocKB)) console.log(`  alloc ${k}: ${xs.length} calls · KB a call p50 ${q(xs, 0.5).toFixed(1)} mean ${(sum(xs) / xs.length).toFixed(1)} max ${q(xs, 1).toFixed(1)} · ${(sum(xs) / 1024 / (FRAMES / 60)).toFixed(2)} MB/s`); }
if (infoLayer) console.log(`info panels: ${JSON.stringify((infoLayer as { stats: unknown }).stats)}`);
if (flag('--paint')) for (const [id, xs] of Object.entries(paintMs).sort((a, b) => sum(b[1]) - sum(a[1]))) console.log(`  paint ${id}: ${xs.length}× · ms p50 ${q(xs, 0.5).toFixed(2)} p90 ${q(xs, 0.9).toFixed(2)} max ${q(xs, 1).toFixed(2)} sum ${sum(xs).toFixed(1)}`);
for (const c of CAN) {
  const st = S[c];
  if (!st.draws) { console.log(`  ${c}: 0 draws`); continue; }
  console.log(`  ${c}: ${st.draws} draws (${st.asked} asked) · ms p50 ${q(st.ms, 0.5).toFixed(2)} p99 ${q(st.ms, 0.99).toFixed(2)} sum ${sum(st.ms).toFixed(0)} · KB p50 ${(q(st.bytes, 0.5) / 1024).toFixed(1)} max ${(q(st.bytes, 1) / 1024).toFixed(1)} sum ${(sum(st.bytes) / 1024).toFixed(0)} · ops p50 ${q(st.ops, 0.5)}`);
  if (flag('--ops')) console.log(`     ${Object.entries(st.byOp).sort((a, b) => b[1] - a[1]).slice(0, 12).map(([k, v]) => `${k} ${(v / 1024 / st.draws).toFixed(1)}K`).join(' · ')}`);
}
process.exit(0);
