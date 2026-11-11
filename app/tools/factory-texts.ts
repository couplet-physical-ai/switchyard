// The factory floor's TEXT BUDGET (FACTORY-SPEC §B "Text budget", §I W1): how many text runs one
// live frame draws at fleet zoom (Gfx `texts`, every fillText of the live canvas: the floor's
// words and the chrome over it), and which. The bar is ≤ 40 at the fit: 9 titles, the group
// names, ≤ 3 callouts; every number lives in an encoding or on hover.
//
//   bun tools/factory-texts.ts [demo|fixtures|<server url>] [--max N] [--zoom <wheel>] [--size 1440x900] [--list]
//
// It connects as the app does (sources.connect), lets the floor settle for a few seconds of
// frames, then records one live frame's fillText calls and joins a label's pieces into ITEMS (what a
// reader reads; below). `--max` exits 1 over N items; `--list` prints
// every run with its position.

const args = process.argv.slice(2);
const opt = (name: string, def: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : def; };
let server = args.find((a, i) => !a.startsWith('--') && !['--max', '--zoom', '--size'].includes(args[i - 1] ?? '')) ?? 'demo';
const MAX = Number(opt('--max', '0'));
const ZOOM = Number(opt('--zoom', '0'));
const [W, H] = opt('--size', '1440x900').split('x').map(Number);

const noop = () => {};
/** A 2D context that keeps the texts it was asked to fill. */
class TextCtx {
  texts: { s: string; x: number; y: number }[] = [];
  fillStyle: unknown = '#000'; strokeStyle: unknown = '#000'; lineWidth = 1; font = '12px mono'; textAlign = 'left'; textBaseline = 'alphabetic';
  globalAlpha = 1; letterSpacing = '0px'; lineJoin = 'miter'; lineCap = 'butt'; globalCompositeOperation = 'source-over'; imageSmoothingEnabled = true;
  canvas = { width: W, height: H };
  fillText(s: string, x: number, y: number) { this.texts.push({ s, x: Math.round(x), y: Math.round(y) }); }
  measureText(s: string) { return { width: 7.2 * String(s).length }; }
  getLineDash() { return []; }
  createLinearGradient() { return { addColorStop: noop }; }
  createRadialGradient() { return { addColorStop: noop }; }
}
const ctxProxy = (base: TextCtx) => new Proxy(base, { get: (t, k) => (k in t ? (t as never)[k] : noop), set: (t, k, v) => { (t as Record<string | symbol, unknown>)[k] = v; return true; } });

(globalThis as { scheduler?: unknown }).scheduler = { yield: () => new Promise<void>((r) => setTimeout(r, 0)) };
let mock: ReturnType<typeof Bun.spawn> | null = null;
if (server === 'fixtures') {
  const port = 4300 + Math.floor(process.pid % 500) + 500;
  mock = Bun.spawn(['bun', 'server/mock.ts', '--fixtures', '../contract/fixtures', '--frozen', '--port', String(port)], { cwd: new URL('..', import.meta.url).pathname, stdout: 'ignore', stderr: 'inherit' });
  server = `http://127.0.0.1:${port}`;
  for (let k = 0; k < 100; k++) {
    try { if ((await fetch(`${server}/api/v1/meta`)).ok) break; } catch { /* not up yet */ }
    await Bun.sleep(100);
  }
}
process.on('exit', () => mock?.kill());

const mod = await import('../app.ts');
const { sources, draw } = mod as unknown as { sources: Record<string, (a: unknown[], s?: unknown, st?: unknown) => unknown>; draw: (s: string, a: unknown[], c: unknown, f: unknown) => boolean };
const store = { get: () => '', set() {} };
const conn = (await sources.connect([server, '', 1, Date.UTC(2026, 10, 10, 20), 0], store, {})) as { ok: boolean; status: string; error?: string };
if (!conn.ok) { console.error(`connect: ${conn.status} ${conn.error ?? ''}`); process.exit(1); }
const frame = (time: number, cause = 'frame') => ({ time, mounted: 0, cause, causes: [cause], width: W, height: H, pixelWidth: W * 2, pixelHeight: H * 2, scale: 2 });
let t = 16, tick = 0, key = '';
const floorCtx = ctxProxy(new TextCtx());
let live = new TextCtx();
for (let i = 0; i < 4; i++) draw('factoryFloor', ['', '', ZOOM], floorCtx, frame(t, 'mount'));
// 12 s of frames (the coffee check's first 10 s glance has passed), the overview every 250 ms
for (let i = 0; i < 720; i++) {
  t += 1000 / 60;
  if (Math.floor(t / 250) !== tick) {
    tick = Math.floor(t / 250);
    const o = sources.overview([t, 0, true], store, {}) as { facKey: string };
    if (o.facKey !== key) { key = o.facKey; draw('factoryFloor', [key, '', ZOOM], floorCtx, frame(t, 'args')); }
  }
  live = new TextCtx();
  draw('factoryLive', ['full', '', ZOOM, Math.floor(t / 125)], ctxProxy(live), frame(t, 'frame'));
}
const runs = live.texts;
// ITEMS (what a reader reads): the runs of one label drawn in pieces (a chip's bold number and its
// words, "labs" + " · 10 red", "tests" + " · deploy") join into one item: same baseline (±2 px), the
// next piece starting within 18 px of where the last one ended (≈7.2 px a character at 12 px; a
// 15-px title or a chip's ▲ is wider).
const items: { s: string; x: number; y: number; end: number }[] = [];
for (const r of [...runs].sort((a, b) => a.x - b.x || a.y - b.y)) {
  const end = r.x + 7.2 * r.s.length;
  const prev = items.find((it) => Math.abs(it.y - r.y) <= 2 && r.x >= it.x && r.x <= it.end + 18);
  if (prev) { prev.s += r.s; prev.end = Math.max(prev.end, end); } else items.push({ s: r.s, x: r.x, y: r.y, end });
}
console.log(`factory texts: ${items.length} items (${runs.length} runs) in one live frame (zoom wheel ${ZOOM}, ${W}x${H}, ${server.startsWith('http') && mock ? 'fixtures' : server})`);
if (args.includes('--list')) for (const r of items.sort((a, b) => a.y - b.y || a.x - b.x)) console.log(`  ${String(r.x).padStart(5)},${String(r.y).padStart(4)}  ${r.s}`);
if (MAX && items.length > MAX) { console.log(`FAIL: over ${MAX}`); process.exit(1); }
process.exit(0);
