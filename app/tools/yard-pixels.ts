// The info layer's change gate (p3-yard), checked in pixels: the Yard runs on a server's live
// stream in real time, and every yardInfo draw is made twice into two real 2D canvases (Skia,
// @napi-rs/canvas): once as the app draws it (a panel whose key moved repaints only what its
// calls changed, in boxes), once by a twin InfoLayer with the gate off (the whole panel, as before
// p3-yard). After every draw the two bitmaps must be identical, pixel for pixel.
//
//   NAPI_CANVAS=/path/to/node_modules/@napi-rs/canvas bun tools/yard-pixels.ts [<server>] [--secs N] [--scale 2]
//
// Prints the draws compared, how many repainted in parts, and the first differing draws (with
// PNGs of both canvases in /tmp/yard-pixels/ when they differ).
const args = process.argv.slice(2);
const opt = (name: string, def: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : def; };
const server = args.find((a, i) => !a.startsWith('--') && !['--secs', '--scale', '--size'].includes(args[i - 1] ?? '')) ?? 'http://127.0.0.1:8361';
const SECS = Number(opt('--secs', '60'));
const SCALE = Number(opt('--scale', '1'));
const [W, H] = opt('--size', '1440x868').split('x').map(Number);
const napi = await import(process.env.NAPI_CANVAS ?? '@napi-rs/canvas');
(globalThis as { scheduler?: unknown }).scheduler = { yield: () => new Promise<void>((r) => setTimeout(r, 0)) };
const realFetch = globalThis.fetch;
globalThis.fetch = ((url: string, init?: { exactStream?: (ev: Record<string, unknown>) => unknown }) => {
  if (!init?.exactStream) return realFetch(url as never, init as never);
  const cb = init.exactStream;
  return new Promise((resolve) => {
    const ws = new WebSocket(String(url).replace(/^http/, 'ws'));
    ws.onopen = () => cb({ type: 'open' });
    ws.onmessage = (m) => cb({ type: 'message', data: String(m.data) });
    ws.onerror = () => cb({ type: 'error', kind: 'Network', message: 'ws error' });
    ws.onclose = () => { cb({ type: 'close' }); resolve(new Response('')); };
  });
}) as typeof fetch;

const { InfoLayer } = await import('../src/yard/info.ts');
const { Yard } = await import('../src/yard/draw.ts');
const { Gfx } = await import('../src/yard/gfx.ts');
type Ctx = CanvasRenderingContext2D;
const A = napi.createCanvas(W * SCALE, H * SCALE), B = napi.createCanvas(W * SCALE, H * SCALE);
const ctxA = A.getContext('2d') as unknown as Ctx, ctxB = B.getContext('2d') as unknown as Ctx;
const twin = new InfoLayer(); twin.gate = false;
// --slices (p4): the twin keeps the gate and draws every dirty panel at once: checks the slicing alone
if (args.includes('--slices')) { twin.gate = true; twin.sliceOps = 0; }
if (args.includes('--debug')) (InfoLayer as unknown as { debug: boolean }).debug = true;
const twinG = new Gfx();
let compared = 0, differ = 0, firstDiff = '', sliced = 0;
const YP = Yard.prototype as unknown as { drawInfo: (ctx: Ctx, f: unknown, t: number) => boolean };
const draw0 = YP.drawInfo;
let yardRef: { info: unknown; gi: unknown; stats?: unknown } | null = null;
YP.drawInfo = function (this: { info: unknown; gi: unknown }, ctx: Ctx, f: unknown, t: number): boolean {
  yardRef = this;
  const r = draw0.call(this, ctx, f, t);
  // the twin: the same draw, the same frame and time, the gate off, into canvas B
  const info = this.info, gi = this.gi;
  this.info = twin; this.gi = twinG;
  // --clipB: the twin draws under a whole-canvas clip (a rasteriser may antialias differently
  // under a clip: then the gate's clipped repaints differ from a whole one by that alone)
  const clipB = args.includes('--clipB');
  if (clipB) { ctxB.save(); ctxB.resetTransform(); ctxB.beginPath(); ctxB.rect(0, 0, W * SCALE, H * SCALE); ctxB.clip(); }
  try { draw0.call(this, ctxB, f, t); } finally { this.info = info; this.gi = gi; if (clipB) ctxB.restore(); }
  // p4: a sliced draw left dirty panels to the next frames: compare once it has drawn them
  if ((info as { waiting?: boolean }).waiting) { sliced++; return r; }
  const a = ctxA.getImageData(0, 0, W * SCALE, H * SCALE).data, b = ctxB.getImageData(0, 0, W * SCALE, H * SCALE).data;
  let n = 0, x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1;
  for (let i = 0; i < a.length; i += 4) {
    if (a[i] !== b[i] || a[i + 1] !== b[i + 1] || a[i + 2] !== b[i + 2] || a[i + 3] !== b[i + 3]) {
      n++; const p = i >> 2, x = p % (W * SCALE), y = (p / (W * SCALE)) | 0;
      if (x < x0) x0 = x; if (y < y0) y0 = y; if (x > x1) x1 = x; if (y > y1) y1 = y;
    }
  }
  compared++;
  if (n) {
    differ++;
    const line = `draw ${compared} at ${(t / 1000).toFixed(2)} s: ${n} px differ in [${x0},${y0}..${x1},${y1}]`;
    console.log(line);
    if (differ <= 30) {
      if (!firstDiff) firstDiff = line;
      const { mkdirSync, writeFileSync } = require('node:fs');
      mkdirSync('/tmp/yard-pixels', { recursive: true });
      writeFileSync(`/tmp/yard-pixels/gate-${differ}.png`, A.toBuffer('image/png'));
      writeFileSync(`/tmp/yard-pixels/whole-${differ}.png`, B.toBuffer('image/png'));
    }
    // carry on from the same pixels: B's
    ctxA.putImageData(ctxB.getImageData(0, 0, W * SCALE, H * SCALE), 0, 0);
  }
  return r;
};

const mod = await import('../app.ts');
const { sources, draw } = mod as unknown as { sources: Record<string, (a: unknown[], s?: unknown, st?: unknown) => unknown>; draw: (s: string, a: unknown[], c: unknown, f: unknown) => boolean };
const store = { get: () => '', set() {} };
const T0 = performance.now();
const now = () => performance.now() - T0 + 1000;
const conn = (await sources.connect([server, '', 1, Date.now() - now(), 0], store, {})) as { ok: boolean; status: string; seq: number };
if (!conn.ok) { console.error(`connect: ${conn.status}`); process.exit(1); }
void sources.liveFeed([server, '', conn.seq, 1, true], store, {});
sources.viewOnTop(['yard'], store, {});
type Ov = { layoutKey: string; tick: number; pace: number };
let ov = sources.overview([now()], store, {}) as Ov, lastOv = now(), last = '', wants = false, mounted = false;
const frame = (time: number, cause: string) => ({ time, mounted: 0, cause, causes: [cause], width: W, height: H, pixelWidth: W * SCALE, pixelHeight: H * SCALE, scale: SCALE });
const liveCtx = napi.createCanvas(8, 8).getContext('2d');
const end = now() + SECS * 1000;
while (now() < end) {
  await Bun.sleep(1000 / 60);
  const t = now();
  if (t - lastOv >= (ov.pace ? 1000 : 250)) { ov = sources.overview([t], store, {}) as Ov; lastOv = t; }
  const a = [ov.layoutKey, ov.tick], k = JSON.stringify(a);
  const cause = !mounted ? 'mount' : k !== last ? 'args' : wants ? 'frame' : '';
  if (!cause) continue;
  last = k; mounted = true;
  wants = draw('yardInfo', a, ctxA, frame(t, cause));
  // keep the live layer's state moving as the app's does (it picks the focus, steps packets)
  draw('yardLive', ['full', '', ov.tick], liveCtx, frame(t, 'frame'));
}
const st = (yardRef as unknown as { info: { stats: unknown } } | null)?.info.stats;
console.log(`yard-pixels: ${compared} info draws compared over ${SECS} s at ${W}x${H}@${SCALE}: ${differ} differ · ${sliced} sliced draws (panels left to the next frame) not compared · gate ${JSON.stringify(st)}`);
process.exit(differ ? 1 : 0);
