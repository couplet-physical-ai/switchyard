// Stills and motion of the factory floor against a served build (the live proxy):
//   bun tools/factory-shots.mjs <url> <outdir> <prefix> [stills|motion|lens]
// Stills at 1440×900 @2× (2880×1800): the whole factory, a zoom, a journey. Motion: a 1440×900
// recordVideo of the live floor and a click → journey, for ffmpeg to encode. Lens: one still per
// lens kind (<prefix>-<kind>.png: a click on one target of each kind, from the anchors the floor
// logs), a shift-click compare, the key, and the coffee glance against a seeded last visit
// (SEED_VISIT=<hours ago>, default 3: that visit's red set is today's minus a few, so the glance
// shows new reds and fixes as a returning visit would).
import { chromium } from 'playwright-core';
import { existsSync, readdirSync, mkdirSync, renameSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

function chrome() {
  if (process.env.CHROME) return process.env.CHROME;
  const base = join(homedir(), '.cache/ms-playwright');
  for (const d of readdirSync(base).filter((d) => d.startsWith('chromium_headless_shell')).sort().reverse()) {
    for (const sub of readdirSync(join(base, d))) { const c = join(base, d, sub, 'chrome-headless-shell'); if (existsSync(c)) return c; }
  }
  throw new Error('no chrome-headless-shell');
}

const [url = 'http://127.0.0.1:8102/', out = '/tmp/sy-preview/concepts', X = 'B', what = 'stills'] = process.argv.slice(2);
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ executablePath: chrome(), args: ['--enable-gpu-rasterization', '--ignore-gpu-blocklist'] });
const motion = what === 'motion';
const lensMode = what === 'lens';
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: motion ? 1 : 2, ...(motion ? { recordVideo: { dir: join(out, '.video'), size: { width: 1440, height: 900 } } } : {}) });
const page = await ctx.newPage();
let bay = null;
let anchors = null;
if (lensMode) await seedVisit(page, url);
page.on('console', (m) => {
  const t = m.text();
  const a = /factory-lens: anchors (\{.*\})/.exec(t);
  if (a) anchors = JSON.parse(a[1]);
  const g = /factory: busy bay (\S+) at (\d+),(\d+)/.exec(t);
  if (g) bay = { id: g[1], x: +g[2], y: +g[3] };
  if (/draw |error|Error/.test(t)) console.log('console:', t.slice(0, 300));
});
await page.goto(url, { waitUntil: 'load' });
const canvas = page.getByTestId('factory-live');
await canvas.waitFor({ timeout: 60000 });
await page.waitForTimeout(motion ? 3000 : 9000);
const box = await canvas.boundingBox();
const shot = async (name) => { await page.screenshot({ path: join(out, `${X}-${name}.png`) }); console.log('wrote', join(out, `${X}-${name}.png`)); };
if (lensMode) {
  await lensShots(page, box, shot, () => anchors);
} else if (!motion) {
  await shot('1-factory');
  // zoom into the consumption engine
  await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.42);
  for (let i = 0; i < 4; i++) { await page.mouse.wheel(0, -160); await page.waitForTimeout(120); }
  await page.waitForTimeout(1200);
  await shot('2-zoom');
  // back to the fit, then a busy bay → its journey and the drawer
  await page.mouse.click(box.x + 16 + 52 + 12, box.y + 46 + 11);
  await page.waitForTimeout(1500);
  if (bay) {
    await page.mouse.click(box.x + bay.x, box.y + bay.y - 4);
    await page.waitForTimeout(2500);
    await shot('3-journey');
  } else console.log('no busy bay logged');
  // the city zoomed (apps by district): close the drawer, back to the fit
  await page.mouse.click(box.x + box.width - 18, box.y + 40 + 17);
  await page.waitForTimeout(1300);
  await page.mouse.click(box.x + 16 + 52 + 12, box.y + 46 + 11);
  await page.waitForTimeout(1300);
  await page.mouse.move(box.x + box.width * 0.86, box.y + box.height * 0.55);
  for (let i = 0; i < 4; i++) { await page.mouse.wheel(0, -160); await page.waitForTimeout(120); }
  await page.waitForTimeout(1200);
  await shot('4-city');
} else {
  await page.waitForTimeout(5000);
  if (bay) { await page.mouse.click(box.x + bay.x, box.y + bay.y - 4); await page.waitForTimeout(5000); await page.mouse.click(box.x + box.width - 18, box.y + 40 + 17); }
  await page.waitForTimeout(1200);
  // the last hour at 60×: the floor busy
  await page.getByTestId('replay').click({ force: true }).catch(() => {});
  await page.waitForTimeout(11000);
}
const v = page.video();
await ctx.close();
if (v) { const p = await v.path(); renameSync(p, join(out, `${X}-motion.webm`)); console.log('video', join(out, `${X}-motion.webm`)); }
await browser.close();

/** A returning visit, seeded in the page's storage (Contract's persisted `visits`) before the app
 *  reads it: `SEED_VISIT` hours ago, the red main lines then = now's minus three, plus two green
 *  ones that were red (so the glance has new reds and fixes to show). */
async function seedVisit(page, url) {
  const hours = Number(process.env.SEED_VISIT ?? 3);
  if (!(hours > 0)) return;
  const snap = await (await fetch(new URL('/api/v1/snapshot', url))).json();
  const repos = Array.isArray(snap.repos) ? snap.repos : Object.values(snap.repos);
  const red = repos.filter((r) => r.main?.state === 'failure' || r.main?.state === 'error').map((r) => r.id);
  const green = repos.filter((r) => r.main?.state === 'success').map((r) => r.id);
  const was = [...red.slice(3), ...green.slice(0, 2)];
  const h36 = (s) => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0).toString(36); };
  const visits = JSON.stringify({ origin: { at: snap.at - hours * 3_600_000, r: was.map(h36).join(','), d: '' } });
  await page.addInitScript((v) => { try { localStorage.setItem('exact.state.visits', v); } catch {} }, JSON.stringify(visits));
}

async function lensShots(page, box, shot, anchorsNow) {
  const at = (k) => anchorsNow()?.[k];
  const click = async (k, opts = {}) => {
    const p = at(k) ?? (k === 'appBehind' ? at('app') : null);
    if (!p) { console.log('no anchor for', k); return false; }
    if (opts.shift) await page.keyboard.down('Shift');
    await page.mouse.click(box.x + p[0], box.y + p[1]);
    if (opts.shift) await page.keyboard.up('Shift');
    await page.waitForTimeout(opts.wait ?? 1400);
    return true;
  };
  const out = async () => { await page.keyboard.press('Escape'); await page.keyboard.press('Escape'); await page.keyboard.press('Escape'); await page.mouse.move(box.x + 6, box.y + box.height - 80); await page.waitForTimeout(700); };
  console.log('anchors', JSON.stringify(anchorsNow()));
  await page.mouse.move(box.x + 6, box.y + box.height - 80);
  await shot('coffee');
  const lenses = [
    ['org', 'dock0'], ['repo', 'commit'], ['red-car', 'culprit'], ['cluster', 'failure'], ['stack', 'stack'], ['bay', 'bay'], ['gate', 'gate'],
    ['machine', 'machine'], ['intake', 'intake'], ['tests', 'scanner'], ['track', 'track0'], ['app', 'appBehind'], ['district', 'district0'], ['fresh', 'fresh'],
  ];
  for (const [name, k] of lenses) {
    if (await click(k)) { await page.mouse.move(box.x + 6, box.y + box.height - 80); await page.waitForTimeout(300); await shot(name); }
    await out();
  }
  // a crate's journey from the engine: the bay, then the bay again
  if (await click('bay')) { await click('bay', { wait: 2500 }); await shot('journey'); }
  await out();
  // compare two orgs (shift-click the second)
  if (await click('dock0')) { await click('dock1', { shift: true }); await page.mouse.move(box.x + 6, box.y + box.height - 80); await shot('compare'); }
  await out();
  // hover previews and the key
  const p = at('machine');
  if (p) { await page.mouse.move(box.x + p[0], box.y + p[1]); await page.waitForTimeout(500); }
  await page.keyboard.press('?');
  await page.waitForTimeout(600);
  await shot('legend');
  await page.keyboard.press('Escape');
}
