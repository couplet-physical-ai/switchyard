// Stills and motion of the factory floor against a served build (the live proxy):
//   bun tools/factory-shots.mjs <url> <outdir> <prefix> [stills|motion]
// Stills at 1440×900 @2× (2880×1800): the whole factory, a zoom, a journey. Motion: a 1440×900
// recordVideo of the live floor and a click → journey, for ffmpeg to encode.
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
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: motion ? 1 : 2, ...(motion ? { recordVideo: { dir: join(out, '.video'), size: { width: 1440, height: 900 } } } : {}) });
const page = await ctx.newPage();
let bay = null;
page.on('console', (m) => {
  const t = m.text();
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
if (!motion) {
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
