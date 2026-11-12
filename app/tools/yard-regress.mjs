// The Yard (and Factory) regression check for the ZERO redesign: the Yard must stay pixel-identical.
// Two built webs (before = main, after = this branch) each run the built-in demo fleet under one
// frozen, stepped clock (Playwright's fake time: Date, performance.now, timers and frames), so both
// draw the same moment; the area under the top bar (whose tabs changed on purpose) is compared.
//   bun tools/yard-regress.mjs <before-dist> <after-dist> <outdir>
// Writes <view>-before.png, <view>-after.png, <view>-diff.png and prints one line per view:
//   yard: 0 of 1296000 px differ (0.000%)
import { chromium } from 'playwright-core';
import { existsSync, readdirSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, extname, resolve } from 'node:path';

function chrome() {
  if (process.env.CHROME) return process.env.CHROME;
  const base = join(homedir(), '.cache/ms-playwright');
  for (const d of readdirSync(base).filter((d) => d.startsWith('chromium_headless_shell')).sort().reverse())
    for (const sub of readdirSync(join(base, d))) { const c = join(base, d, sub, 'chrome-headless-shell'); if (existsSync(c)) return c; }
  throw new Error('no chrome-headless-shell');
}
const [beforeDist, afterDist, out = '/tmp/sy-preview/zero/yard-regress'] = process.argv.slice(2);
mkdirSync(out, { recursive: true });
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.wasm': 'application/wasm', '.ttf': 'font/ttf', '.png': 'image/png', '.svg': 'image/svg+xml' };
function serve(dist) {
  const root = resolve(dist);
  return Bun.serve({ port: 0, fetch(req) {
    const u = new URL(req.url);
    let p = join(root, decodeURIComponent(u.pathname));
    if (!p.startsWith(root) || !existsSync(p) || u.pathname.endsWith('/')) p = join(root, 'shell.html');
    try { return new Response(readFileSync(p), { headers: { 'content-type': types[extname(p)] ?? 'application/octet-stream' } }); }
    catch { return new Response(readFileSync(join(root, 'shell.html')), { headers: { 'content-type': 'text/html' } }); }
  } });
}
const T0 = Date.UTC(2026, 10, 11, 18, 0, 0);
const TOP = 33; // the top bar (32 px + its rule), whose tabs changed on purpose
const browser = await chromium.launch({ executablePath: chrome(), args: ['--disable-gpu', '--force-color-profile=srgb'] });
async function shot(dist, route, demoId, file) {
  const srv = serve(dist);
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, colorScheme: 'dark' });
  const page = await ctx.newPage();
  await page.clock.install({ time: T0 });
  await page.goto(`http://127.0.0.1:${srv.port}${route}`);
  const step = async (n) => { for (let i = 0; i < n; i++) { await page.clock.runFor(100); await page.waitForTimeout(25); } };
  await step(20);
  const demo = page.locator(`[data-testid="${demoId}"]`);
  if (await demo.count()) { await demo.first().click(); }
  await step(120); // 12 s of app time: the demo's fleet loaded and settled
  await page.screenshot({ path: file, clip: { x: 0, y: TOP, width: 1440, height: 900 - TOP } });
  await ctx.close();
  srv.stop(true);
}
// ROUTES="yard=/yard,live=/,factory=/factory" compares those routes instead, each the same on both
// builds (a branch that must leave them alone: FACTORY3.md).
const views = process.env.ROUTES
  ? process.env.ROUTES.split(',').map((r) => { const [name, route] = r.split('='); const demo = route.startsWith('/yard') ? 'yard-setup-demo' : 'setup-demo'; return [name, route, route, demo, demo]; })
  : [['yard', '/yard', '/yard', 'yard-setup-demo', 'yard-setup-demo'], ['factory', '/', '/factory', 'setup-demo', 'setup-demo']];
const lines = [];
for (const [name, rb, ra, db, da] of views) {
  const b = join(out, `${name}-before.png`), a = join(out, `${name}-after.png`);
  await shot(beforeDist, rb, db, b);
  await shot(afterDist, process.env.SAME ? rb : ra, da, a); // SAME=1: the before build twice (the check's own noise)
  // pixel diff in the page (canvas): differing pixels in red over a dimmed "after"
  const page = await (await browser.newContext()).newPage();
  const res = await page.evaluate(async ([ba, aa]) => {
    const load = (src) => new Promise((ok) => { const i = new Image(); i.onload = () => ok(i); i.src = src; });
    const [ib, ia] = await Promise.all([load(ba), load(aa)]);
    const W = ib.width, H = ib.height, c = document.createElement('canvas'); c.width = W; c.height = H;
    const g = c.getContext('2d');
    g.drawImage(ib, 0, 0); const pb = g.getImageData(0, 0, W, H).data;
    g.drawImage(ia, 0, 0); const img = g.getImageData(0, 0, W, H), pa = img.data;
    let n = 0;
    for (let i = 0; i < pa.length; i += 4) {
      const d = Math.abs(pa[i] - pb[i]) + Math.abs(pa[i + 1] - pb[i + 1]) + Math.abs(pa[i + 2] - pb[i + 2]);
      if (d > 0) { n++; pa[i] = 255; pa[i + 1] = 40; pa[i + 2] = 40; } else { pa[i] *= 0.3; pa[i + 1] *= 0.3; pa[i + 2] *= 0.3; }
    }
    g.putImageData(img, 0, 0);
    return { n, total: W * H, png: c.toDataURL('image/png') };
  }, [`data:image/png;base64,${readFileSync(b).toString('base64')}`, `data:image/png;base64,${readFileSync(a).toString('base64')}`]);
  await Bun.write(join(out, `${name}-diff.png`), Buffer.from(res.png.split(',')[1], 'base64'));
  await page.context().close();
  lines.push(`${name}: ${res.n} of ${res.total} px differ (${((100 * res.n) / res.total).toFixed(3)}%)`);
}
await browser.close();
for (const l of lines) console.log(l);
