// Idle and busy numbers per view on the web (Chromium), for "idle = still" (mac-perf, worker idle):
// over a window, how many browser frames painted any canvas (canvas frames/s), canvas calls/s,
// and the main thread's script and task time per second (the data module and the host run there).
// A still view paints 0 frames and spends ~0 ms of script a second.
// Serves target/web-dist (build first: `bun exact.mjs web-build`). From app/:
//   EXACT2=… bun tools/idle-web.mjs --server http://127.0.0.1:8331 [--tab factory|yard|now] [--route /factory] [--ms 10000] [--size 1440x900] [--shot out.png]
//   (a frozen fleet: `bun server/mock.ts --port 8331 --fixtures ../contract/fixtures --frozen`; busy: drop --frozen,
//   or no --server for the built-in demo)
import { createRequire } from 'node:module';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';

const exact2 = process.env.EXACT2;
if (!exact2) { console.error('EXACT2 names the exact checkout'); process.exit(1); }
const require = createRequire(join(exact2, 'package.json'));
const { chromium } = require('playwright-core');

const arg = (name, def) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : def; };
const [W, H] = arg('--size', '1440x900').split('x').map(Number);
const ms = Number(arg('--ms', '10000'));
const server = arg('--server', '');
const dist = resolve(arg('--dist', 'target/web-dist'));
if (!existsSync(join(dist, 'index.html'))) { console.error('no target/web-dist: run bun exact.mjs web-build'); process.exit(1); }
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.wasm': 'application/wasm', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.svg': 'image/svg+xml', '.png': 'image/png' };
const http = Bun.serve({
  port: 0,
  fetch(req) {
    const p = decodeURIComponent(new URL(req.url).pathname);
    let f = join(dist, p);
    if (!f.startsWith(dist) || !existsSync(f) || statSync(f).isDirectory()) f = join(dist, 'index.html');
    return new Response(readFileSync(f), { headers: { 'content-type': types[extname(f)] ?? 'application/octet-stream' } });
  },
});

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: W, height: H } });
// every 2D call on a page canvas counts; a browser frame in which any happened is a painted frame
await page.addInitScript(() => {
  const st = (window.__idle = { calls: 0, frames: 0, dirty: false, by: {} });
  const P = CanvasRenderingContext2D.prototype;
  for (const k of ['clearRect', 'fillRect', 'strokeRect', 'fillText', 'strokeText', 'fill', 'stroke', 'drawImage', 'putImageData']) {
    const f = P[k];
    if (typeof f !== 'function') continue;
    P[k] = function (...a) {
      st.calls++; st.dirty = true;
      const id = this.canvas?.closest?.('[data-testid]')?.getAttribute('data-testid') ?? this.canvas?.getAttribute?.('data-testid') ?? '?';
      st.by[id] = (st.by[id] ?? 0) + 1;
      return f.apply(this, a);
    };
  }
  const loop = () => { if (st.dirty) { st.frames++; st.dirty = false; } requestAnimationFrame(loop); };
  requestAnimationFrame(loop);
});
if (process.env.CON) page.on('console', (m) => { if (m.text().includes(process.env.CON)) console.log(m.text().slice(0, 300)); });
const tid = (id) => page.locator(`[data-testid="${id}"]`);
await page.goto(`http://127.0.0.1:${http.port}/`);
await tid('now-setup-demo').or(tid('setup-demo')).first().waitFor({ timeout: 30000 });
if (server) {
  await tid('now-setup-connect').or(tid('open-settings')).first().click();
  await tid('server-field').locator('input').or(tid('server-field')).first().fill(server);
  await tid('settings-save').click();
} else await tid('now-setup-demo').or(tid('setup-demo')).first().click();
await page.waitForTimeout(4000);
const tab = arg('--tab', '');
const route = arg('--route', '');
if (route) { await page.evaluate((r) => { history.pushState({}, '', r); dispatchEvent(new PopStateEvent('popstate')); }, route); }
else if (tab) await tid(`tab-${tab}`).click();
if (process.argv.includes('--pause')) { await page.waitForTimeout(1500); await tid('pause').click(); }
await page.waitForTimeout(Number(arg('--settle', '4000')));
const cdp = await page.context().newCDPSession(page);
await cdp.send('Performance.enable');
const metrics = async () => Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map((m) => [m.name, m.value]));
const s0 = await page.evaluate(() => ({ ...window.__idle, by: { ...window.__idle.by } }));
const profile = process.argv.includes('--profile');
if (profile) { await cdp.send('Profiler.enable'); await cdp.send('Profiler.setSamplingInterval', { interval: 200 }); await cdp.send('Profiler.start'); }
const reqs = {};
page.on('request', (r) => { const u = new URL(r.url()); if (u.port === String(http.port)) return; const k = u.pathname.replace(/[0-9a-f]{7,}/g, '…'); reqs[k] = (reqs[k] ?? 0) + 1; });
const m0 = await metrics();
await page.waitForTimeout(ms);
const m1 = await metrics();
if (profile) {
  // --profile: the functions the window's script time went to (self time, top 25)
  const { profile: p } = await cdp.send('Profiler.stop');
  const self = new Map(), byId = new Map(p.nodes.map((n) => [n.id, n]));
  const dt = p.timeDeltas ?? [];
  p.samples.forEach((id, i) => { const n = byId.get(id); const k = `${n.callFrame.functionName || '(anon)'} ${n.callFrame.url.split('/').pop()}:${n.callFrame.lineNumber}`; self.set(k, (self.get(k) ?? 0) + (dt[i] ?? 0) / 1000); });
  for (const [k, v] of [...self].sort((a, b) => b[1] - a[1]).slice(0, 25)) console.log(`${v.toFixed(1).padStart(8)} ms  ${k}`);
}
const s1 = await page.evaluate(() => ({ ...window.__idle, by: { ...window.__idle.by } }));
const sec = (m1.Timestamp - m0.Timestamp);
const by = {};
for (const [k, v] of Object.entries(s1.by)) { const d = v - (s0.by[k] ?? 0); if (d) by[k] = +(d / sec).toFixed(1); }
console.log(JSON.stringify({
  tab: route || tab || 'now', source: server || 'demo', windowS: +sec.toFixed(1),
  canvasFramesPerS: +((s1.frames - s0.frames) / sec).toFixed(2), canvasCallsPerS: +((s1.calls - s0.calls) / sec).toFixed(1),
  scriptMsPerS: +(((m1.ScriptDuration - m0.ScriptDuration) * 1000) / sec).toFixed(2), taskMsPerS: +(((m1.TaskDuration - m0.TaskDuration) * 1000) / sec).toFixed(2),
  layoutsPerS: +((m1.LayoutCount - m0.LayoutCount) / sec).toFixed(2), recalcStylesPerS: +((m1.RecalcStyleCount - m0.RecalcStyleCount) / sec).toFixed(2),
  byCanvas: by, requests: reqs,
}));
const shot = arg('--shot', '');
if (shot) await page.screenshot({ path: shot });
await browser.close();
http.stop(true);
