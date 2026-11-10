#!/usr/bin/env bun
// Web performance probe: serves a built `dist/`, opens it in Chromium (Playwright's
// headless shell, the one `exact setup` installs) on real time, and reports
// cold start (navigation → first fleet frame drawn), frame pacing over a window,
// and the data module's per-frame draw cost (it records `sy:draw` measures).
// Usage: bun tools/webperf.mjs [--dist dist] [--url /] [--seconds 10] [--size 1440x900] [--server URL]
import { chromium } from 'playwright-core';
import { existsSync, readdirSync } from 'node:fs';
import { join, extname, resolve } from 'node:path';
import { homedir } from 'node:os';

const arg = (name, dflt) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : dflt; };
const dist = resolve(arg('dist', 'dist'));
const seconds = Number(arg('seconds', '10'));
const [w, h] = arg('size', '1440x900').split('x').map(Number);
const route = arg('url', '/');
const server = arg('server', '');

const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.plan': 'application/octet-stream', '.wasm': 'application/wasm' };
const srv = Bun.serve({ port: 0, fetch(req) {
  const u = new URL(req.url); let p = join(dist, decodeURIComponent(u.pathname));
  if (!existsSync(p) || u.pathname === '/') p = join(dist, existsSync(join(dist, u.pathname)) && u.pathname !== '/' ? u.pathname : 'shell.html');
  return new Response(Bun.file(p), { headers: { 'content-type': types[extname(p)] ?? 'application/octet-stream' } });
} });

function chrome() {
  if (process.env.CHROME) return process.env.CHROME;
  const base = join(homedir(), process.platform === 'darwin' ? 'Library/Caches/ms-playwright' : '.cache/ms-playwright');
  for (const d of readdirSync(base).filter((d) => d.startsWith('chromium_headless_shell')).sort().reverse()) {
    for (const sub of readdirSync(join(base, d))) { const c = join(base, d, sub, 'chrome-headless-shell'); if (existsSync(c)) return c; }
  }
  throw new Error('no chrome-headless-shell; run exact setup or set CHROME');
}

const browser = await chromium.launch({ executablePath: chrome(), args: ['--enable-gpu-rasterization', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: w, height: h } });
await page.addInitScript(() => {
  globalThis.__syFrames = []; globalThis.__syLong = [];
  globalThis.__syFirstPaint = null;
  const probe = document.createElement('canvas'); probe.width = probe.height = 1; const pctx = probe.getContext('2d', { willReadFrequently: true });
  const painted = () => { for (const c of document.querySelectorAll('canvas')) { if (c.width < 8) continue; pctx.clearRect(0, 0, 1, 1); pctx.drawImage(c, 0, 0, c.width, c.height, 0, 0, 1, 1); const d = pctx.getImageData(0, 0, 1, 1).data; if (d[3] > 0 && d[0] + d[1] + d[2] > 3) return true; } return false; };
  const loop = (t) => { globalThis.__syFrames.push(t); if (globalThis.__syFirstPaint === null && painted()) globalThis.__syFirstPaint = performance.now(); requestAnimationFrame(loop); }; requestAnimationFrame(loop);
  try { new PerformanceObserver((l) => { for (const e of l.getEntries()) globalThis.__syLong.push(e.duration); }).observe({ type: 'longtask', buffered: true }); } catch {}
});
const base = arg('base', `http://127.0.0.1:${srv.port}`);
const url = `${base}${route}${server ? (route.includes('?') ? '&' : '?') + 'server=' + encodeURIComponent(server) : ''}`;
const logs = []; page.on('console', (m) => logs.push(m.text())); page.on('pageerror', (e) => logs.push('pageerror ' + e.message));
const t0 = Date.now();
await page.goto(url);
await page.waitForFunction(() => globalThis.__syFirstPaint !== null, null, { timeout: 15000 }).catch(() => {});
const marks = { firstCanvasPaint: await page.evaluate(() => globalThis.__syFirstPaint) };
const cdp = await page.context().newCDPSession(page); await cdp.send('Performance.enable');
const metric = async () => Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map((m) => [m.name, m.value]));
await page.waitForTimeout(1000);
await page.evaluate(() => { globalThis.__syFrames.length = 0; globalThis.__syLong.length = 0; });
const m0 = await metric();
await page.waitForTimeout(seconds * 1000);
const m1 = await metric();
const r = await page.evaluate(() => {
  const f = globalThis.__syFrames; const iv = []; for (let i = 1; i < f.length; i++) iv.push(f[i] - f[i - 1]);
  const q = (a, p) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return +s[Math.min(s.length - 1, Math.floor(p * s.length))].toFixed(2); };
  const nav = performance.getEntriesByType('navigation')[0];
  const fcp = performance.getEntriesByName('first-contentful-paint')[0]?.startTime ?? null;
  return { frames: f.length, fps: +(1000 * iv.length / iv.reduce((a, b) => a + b, 0)).toFixed(1), interval: { p50: q(iv, 0.5), p95: q(iv, 0.95), p99: q(iv, 0.99), max: q(iv, 1) }, over20ms: iv.filter((x) => x > 20).length, longTasks: globalThis.__syLong.length, fcp, domContentLoaded: nav?.domContentLoadedEventEnd ?? null, transfer: performance.getEntriesByType('resource').reduce((a, e) => a + (e.transferSize || 0), 0) + (nav?.transferSize ?? 0) };
});
const busy = { scriptMsPerFrame: +((m1.ScriptDuration - m0.ScriptDuration) * 1000 / Math.max(1, r.frames)).toFixed(2), taskMsPerFrame: +((m1.TaskDuration - m0.TaskDuration) * 1000 / Math.max(1, r.frames)).toFixed(2), layoutMsPerFrame: +((m1.LayoutDuration - m0.LayoutDuration) * 1000 / Math.max(1, r.frames)).toFixed(2), jsHeapMB: +(m1.JSHeapUsedSize / 1048576).toFixed(1) };
console.log(JSON.stringify({ url: route, size: `${w}x${h}`, seconds, marks, ...r, mainThread: busy }, null, 1));
if (arg('shot', '')) await page.screenshot({ path: arg('shot', '') });
if (process.argv.includes('--logs')) console.log(logs.slice(0, 40).join('\n'));
await browser.close(); srv.stop(true);
