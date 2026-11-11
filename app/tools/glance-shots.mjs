// The coffee check's first 10 seconds (fab-w4), against a served build (the live proxy):
//   node tools/glance-shots.mjs <url> <outdir> <prefix> [stills|motion]
// A returning visit is seeded in the page's storage first (SEED_VISIT hours ago, default 3; the
// red main lines then = today's minus three, plus two green ones that were red), as
// tools/factory-shots.mjs does. Stills (1440×900 @2×): <prefix>-glance-{0,3,7,10}s.png, timed
// from the floor's "coffee: open" log line. Motion (1440×900 recordVideo → <prefix>-motion.webm):
// the load, the first 10 s after open, then a window switch (the since chip → last hour).
// Run it with node from a directory that has playwright-core.
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

const [url = 'http://127.0.0.1:8114/', out = '/tmp/sy-preview/b-iter-2', X = 'w4', what = 'stills'] = process.argv.slice(2);
mkdirSync(out, { recursive: true });
const motion = what === 'motion';
const browser = await chromium.launch({ executablePath: chrome(), args: ['--enable-gpu-rasterization', '--ignore-gpu-blocklist'] });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: motion ? 1 : 2, ...(motion ? { recordVideo: { dir: join(out, '.video'), size: { width: 1440, height: 900 } } } : {}) });
const page = await ctx.newPage();
const t0 = Date.now(); // the recorded video starts with the page
await seedVisit(page, url);
let openAt = 0, chip = null, words = '';
page.on('console', (m) => {
  const t = m.text();
  const o = /coffee: open at \d+ · (.*)/.exec(t);
  if (o && !openAt) { openAt = Date.now(); words = o[1]; console.log('open:', words, `(video +${((openAt - t0) / 1000).toFixed(2)} s)`); }
  const c = /coffee: since chip at (\d+),(\d+) rows (\d+) step (\d+)/.exec(t);
  if (c) chip = { x: +c[1], y: +c[2], row: +c[3], step: +c[4] };
  if (/error|Error/.test(t)) console.log('console:', t.slice(0, 300));
});
await page.goto(url, { waitUntil: 'load' });
const canvas = page.getByTestId('factory-live');
await canvas.waitFor({ timeout: 60000 });
const box = await canvas.boundingBox();
for (let i = 0; i < 600 && !openAt; i++) await page.waitForTimeout(50);
if (!openAt) { console.log('the floor never opened'); await browser.close(); process.exit(1); }
const at = async (ms) => { const w = openAt + ms - Date.now(); if (w > 0) await page.waitForTimeout(w); };
const shot = async (name) => { const p = join(out, `${X}-${name}.png`); await page.screenshot({ path: p }); console.log('wrote', p, `(+${((Date.now() - openAt) / 1000).toFixed(2)} s)`); };
if (!motion) {
  for (const s of [0, 3, 7, 10]) { await at(s * 1000); await shot(`glance-${s}s`); }
  // the window menu open, then the last hour picked
  if (chip) {
    await page.mouse.click(box.x + chip.x, box.y + chip.y);
    await page.waitForTimeout(400);
    await page.mouse.move(box.x + chip.x, box.y + chip.row + chip.step);
    await page.waitForTimeout(300);
    await shot('glance-menu');
    await page.mouse.click(box.x + chip.x, box.y + chip.row + chip.step);
    await page.mouse.move(box.x + 6, box.y + box.height - 80);
    await page.waitForTimeout(2500);
    await shot('glance-1h');
  }
} else {
  await at(11_000);
  if (chip) {
    await page.mouse.click(box.x + chip.x, box.y + chip.y);
    await page.waitForTimeout(900);
    await page.mouse.click(box.x + chip.x, box.y + chip.row + chip.step);
    await page.mouse.move(box.x + 6, box.y + box.height - 80);
    await page.waitForTimeout(3000);
    // S replays the hour
    await canvas.focus().catch(() => {});
    await page.keyboard.press('s');
    await page.waitForTimeout(8000);
  }
}
const v = page.video();
await ctx.close();
if (v) { const p = await v.path(); renameSync(p, join(out, `${X}-motion.webm`)); console.log('video', join(out, `${X}-motion.webm`)); }
await browser.close();

/** A returning visit `SEED_VISIT` hours ago (Contract's persisted `visits`): the red main lines
 *  then = now's minus three, plus two green ones that were red. */
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
