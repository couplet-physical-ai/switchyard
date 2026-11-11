// Stills and a ≤ 30 s reel of the Live view (and the Factory / Yard tabs in the new nav) from a
// served web build — the LIVE server through tools/live-proxy.ts:
//   bun tools/now-reel.mjs <base-url> <outdir> [stills|reel|both]
// Stills at 1440×900 @2× (2880×1800) dark + light, 430 px @2× (narrow), a job's detail with its
// log, the Factory and the Yard. The reel: 1440×900 recordVideo, encoded to H.264 by ffmpeg.
import { chromium } from 'playwright-core';
import { existsSync, readdirSync, mkdirSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

function chrome() {
  if (process.env.CHROME) return process.env.CHROME;
  const base = join(homedir(), '.cache/ms-playwright');
  for (const d of readdirSync(base).filter((d) => d.startsWith('chromium_headless_shell')).sort().reverse())
    for (const sub of readdirSync(join(base, d))) { const c = join(base, d, sub, 'chrome-headless-shell'); if (existsSync(c)) return c; }
  throw new Error('no chrome-headless-shell');
}
const [base = 'http://127.0.0.1:8192', out = '/tmp/sy-preview/zero/v1', what = 'both'] = process.argv.slice(2);
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ executablePath: chrome() });
const T = (page, id) => page.locator(`[data-testid="${id}"]`);
async function ready(page) {
  await T(page, 'now-status').waitFor({ timeout: 30000 });
  await page.waitForFunction(() => /\d/.test(document.querySelector('[data-testid="now-running"]')?.textContent ?? ''), null, { timeout: 30000 });
  await page.waitForTimeout(2500);
}
async function firstJob(page) {
  const running = page.locator('[data-testid^="now-ev-"] [data-testid^="now-jobpress-"]');
  if (await running.count()) return running.first();
  await page.locator('[data-testid^="now-donepress-"]').first().click();
  await page.waitForTimeout(600);
  return page.locator('[data-testid^="now-jobpress-"]').first();
}

if (what === 'stills' || what === 'both') {
  for (const [name, w, h, scheme] of [['live-dark', 1440, 900, 'dark'], ['live-light', 1440, 900, 'light'], ['live-narrow', 430, 932, 'dark']]) {
    const page = await (await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 2, colorScheme: scheme })).newPage();
    await page.goto(`${base}/`);
    await ready(page);
    await page.screenshot({ path: join(out, `${name}.png`) });
    if (name === 'live-dark') {
      // a failed job's detail when there is one, else a running one: its steps and log tail
      const failed = page.locator('[data-testid^="now-done-"]').filter({ has: page.locator('[aria-label="fail"]') }).first();
      if (await failed.count()) {
        await failed.locator('[data-testid^="now-donepress-"]').click();
        await page.waitForTimeout(500);
        await failed.locator('[data-testid^="now-jobpress-"]').first().click();
      } else {
        await (await firstJob(page)).click();
      }
      await T(page, 'now-detail').waitFor({ timeout: 10000 });
      await page.waitForTimeout(4000);
      await T(page, 'now-detail').evaluate((el) => el.scrollIntoView({ block: 'center' }));
      await page.waitForTimeout(800);
      await page.screenshot({ path: join(out, 'live-detail.png') });
      await T(page, 'now-detail-close').click();
      await page.waitForTimeout(400);
      await page.locator('[data-testid="now-h-just"]').evaluate((el) => el.scrollIntoView({ block: 'start' }));
      await page.waitForTimeout(800);
      await page.screenshot({ path: join(out, 'live-finished.png') });
      await page.evaluate(() => document.querySelector('[data-testid="now-scroll"]')?.scrollTo(0, 0));
      await T(page, 'tab-factory').click();
      await page.waitForTimeout(6000);
      await page.screenshot({ path: join(out, 'factory.png') });
      await T(page, 'tab-yard').click();
      await page.waitForTimeout(6000);
      await page.screenshot({ path: join(out, 'yard.png') });
    }
    await page.context().close();
  }
  console.log('stills ok');
}

if (what === 'reel' || what === 'both') {
  const vdir = join(out, '.video');
  rmSync(vdir, { recursive: true, force: true });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, colorScheme: 'dark', recordVideo: { dir: vdir, size: { width: 1440, height: 900 } } });
  const page = await ctx.newPage();
  const t0 = Date.now();
  await page.goto(`${base}/`);
  await ready(page);
  const since = Date.now();
  await page.waitForTimeout(5000);                           // live: timers tick, LIVE beats
  const job = await firstJob(page);
  await job.hover(); await page.waitForTimeout(400);
  await job.click();                                         // its steps + log tail, inline
  await T(page, 'now-detail').waitFor({ timeout: 10000 });
  await page.waitForTimeout(4500);
  await T(page, 'now-detail-close').click();
  await page.waitForTimeout(700);
  await T(page, 'now-mach-0').click();                       // what runs on VM 153
  await page.waitForTimeout(3000);
  await T(page, 'now-mach-0').click();
  await page.waitForTimeout(500);
  const repo = page.locator('[data-testid^="now-repo-"]').first();
  if (await repo.count()) { await repo.click(); await page.waitForTimeout(3000); await T(page, 'now-filter-clear').click(); await page.waitForTimeout(1200); }
  await page.mouse.wheel(0, 700); await page.waitForTimeout(1600);   // just finished, earlier
  await page.mouse.wheel(0, -700); await page.waitForTimeout(800);
  await T(page, 'tab-factory').click(); await page.waitForTimeout(2200);
  await T(page, 'tab-yard').click(); await page.waitForTimeout(2200);
  await T(page, 'tab-now').click(); await page.waitForTimeout(1500);
  const video = page.video();
  await ctx.close();
  const webm = await video.path();
  const skip = Math.max(0, (since - t0) / 1000 - 0.5);
  const mp4 = join(out, 'live-reel.mp4');
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-ss', skip.toFixed(2), '-i', webm, '-t', '30', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '20', '-preset', 'medium', '-movflags', '+faststart', mp4], { timeout: 180000 });
  const dur = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', mp4]).toString().trim();
  console.log(`reel ok ${mp4} ${dur} s`);
}
await browser.close();
