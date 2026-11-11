// Web Chromium numbers for PERF.md, outside the agent (whose platform timing paces a headless
// page at ~24 fps whatever it draws). Serves target/web-dist (build first: `bun exact.mjs web-build`),
// opens it in Playwright's Chromium on a normal requestAnimationFrame loop, starts the built-in demo
// or connects to a server, optionally turns stress mode on, then over a window reads:
//   - frames: requestAnimationFrame intervals (fps, median, p95)
//   - CDP Performance metrics: ScriptDuration and TaskDuration per frame (all JS / all main-thread work)
// Usage, from app/:
//   EXACT2=… bun tools/perf-web.mjs [--server http://127.0.0.1:8090] [--stress] [--size 1440x900] [--ms 8000] [--headed] [--gpu] [--scale 2] [--shot out.png]
import { createRequire } from 'node:module';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';

const exact2 = process.env.EXACT2;
if (!exact2) { console.error('EXACT2 names the exact checkout'); process.exit(1); }
const require = createRequire(join(exact2, 'package.json'));
const { chromium } = require('playwright-core');

const arg = (name, def) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : def; };
const flag = (name) => process.argv.includes(name);
const [W, H] = arg('--size', '1440x900').split('x').map(Number);
const ms = Number(arg('--ms', '8000'));
const server = arg('--server', '');
const dist = resolve('target/web-dist');
if (!existsSync(join(dist, 'index.html'))) { console.error('no target/web-dist: run bun exact.mjs web-build'); process.exit(1); }

const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.wasm': 'application/wasm', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.svg': 'image/svg+xml', '.png': 'image/png' };
const http = Bun.serve({
  port: 0,
  fetch(req) {
    let p = decodeURIComponent(new URL(req.url).pathname);
    let f = join(dist, p);
    if (!f.startsWith(dist) || !existsSync(f) || statSync(f).isDirectory()) f = join(dist, 'index.html');
    return new Response(readFileSync(f), { headers: { 'content-type': types[extname(f)] ?? 'application/octet-stream' } });
  },
});

const args = flag('--gpu') ? ['--enable-gpu', '--use-angle=metal', '--enable-unsafe-swiftshader'] : [];
const browser = await chromium.launch({ headless: !flag('--headed'), executablePath: process.env.CHROME || undefined, args });
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: Number(arg('--scale', '1')) });
const tid = (id) => page.locator(`[data-testid="${id}"]`);
await page.goto(`http://127.0.0.1:${http.port}/`);
await tid('setup-demo').waitFor({ timeout: 30000 });
if (server) {
  await tid('open-settings').click();
  await tid('server-field').locator('input').or(tid('server-field')).first().fill(server);
  await tid('settings-save').click();
} else await tid('setup-demo').click();
await page.waitForTimeout(4000);
if (flag('--stress')) {
  await tid('open-settings').click();
  await tid('settings-stress').click();
  await tid('settings-cancel').click();
  await page.waitForTimeout(3000);
}
await page.waitForTimeout(1500);
const cdp = await page.context().newCDPSession(page);
await cdp.send('Performance.enable');
const metrics = async () => Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map((m) => [m.name, m.value]));
const m0 = await metrics();
const frames = await page.evaluate((span) => new Promise((done) => {
  const out = []; let last = 0; const end = performance.now() + span;
  const tick = (t) => { if (last) out.push(t - last); last = t; if (t < end) requestAnimationFrame(tick); else done(out); };
  requestAnimationFrame(tick);
}), ms);
const m1 = await metrics();
const sorted = frames.slice().sort((a, b) => a - b);
const q = (p) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
const n = frames.length;
const span = (m1.Timestamp - m0.Timestamp) * 1000;
const script = (m1.ScriptDuration - m0.ScriptDuration) * 1000, task = (m1.TaskDuration - m0.TaskDuration) * 1000;
const gpu = await page.evaluate(() => { const c = document.createElement('canvas'); const g = c.getContext('webgl'); const d = g?.getExtension('WEBGL_debug_renderer_info'); return d ? g.getParameter(d.UNMASKED_RENDERER_WEBGL) : 'unknown'; });
console.log(JSON.stringify({
  size: `${W}x${H}@${arg('--scale', '1')}x`, stress: flag('--stress'), source: server || 'demo', renderer: gpu,
  frames: n, fps: +(n / (span / 1000)).toFixed(1), frameMedianMs: +q(0.5).toFixed(2), frameP95Ms: +q(0.95).toFixed(2), frameMaxMs: +sorted[n - 1].toFixed(2),
  scriptMsPerFrame: +(script / n).toFixed(2), taskMsPerFrame: +(task / n).toFixed(2), windowMs: Math.round(span),
}));
const shot = arg('--shot', '');
if (shot) await page.screenshot({ path: shot });
await browser.close();
http.stop(true);
