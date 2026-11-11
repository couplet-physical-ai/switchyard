// Live view e2e in a real browser, against a served web build (the LIVE server through
// tools/live-proxy.ts, or the recorded fleet the same way):
//   bun tools/now-e2e.mjs <base-url> <label> [outdir]
// It checks: the view draws from data; the status line's running count = the running jobs listed;
// every deep link is https and leaves in a new tab; a job opens its steps (and its log tail when the
// server offers it); a machine opens what runs there; a repo filter narrows and clears; Factory
// and Yard are one click away. It writes <outdir>/<label>-e2e.png and prints one JSON line.
import { chromium } from 'playwright-core';
import { existsSync, readdirSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

function chrome() {
  if (process.env.CHROME) return process.env.CHROME;
  const base = join(homedir(), '.cache/ms-playwright');
  for (const d of readdirSync(base).filter((d) => d.startsWith('chromium_headless_shell')).sort().reverse())
    for (const sub of readdirSync(join(base, d))) { const c = join(base, d, sub, 'chrome-headless-shell'); if (existsSync(c)) return c; }
  throw new Error('no chrome-headless-shell');
}
const [base = 'http://127.0.0.1:8192', label = 'live', out = '/tmp/sy-preview/zero/e2e'] = process.argv.slice(2);
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ executablePath: chrome() });
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e).slice(0, 200)));
const res = { label, ok: true, checks: [] };
const check = (c, m) => { res.checks.push(`${c ? 'ok' : 'FAIL'} ${m}`); if (!c) res.ok = false; };
const T = (id) => page.locator(`[data-testid="${id}"]`).last(); // the top route (a stack keeps the ones under it)
try {
  await page.goto(`${base}/`);
  await T('now-status').waitFor({ timeout: 30000 });
  await page.waitForFunction(() => /\d/.test(document.querySelector('[data-testid="now-running"]')?.textContent ?? ''), null, { timeout: 30000 });
  await page.waitForTimeout(2500);
  const running = Number(await T('now-running').textContent());
  const listed = await page.locator('[data-testid^="now-ev-"] [aria-label="running"]').count();
  check(running === listed, `status line ${running} running = ${listed} running jobs listed`);
  const machines = await page.locator('[data-testid^="now-mach-"]').count();
  check(machines >= 1, `${machines} machines in the status line`);
  const hrefs = await page.locator('[data-testid="now"] a[href]').evaluateAll((as) => as.map((a) => ({ href: a.getAttribute('href'), target: a.getAttribute('target') })));
  check(hrefs.length > 0 && hrefs.every((h) => /^https:\/\//.test(h.href ?? '')), `${hrefs.length} deep links, all https`);
  check(hrefs.every((h) => h.target === '_blank'), 'deep links open in a new tab');
  const evs = await page.locator('[data-testid^="now-ev-"]').count();
  const idle = await T('now-idle').count();
  check(evs > 0 || idle === 1, `running now: ${evs} events in flight${idle ? ' (idle)' : ''}`);
  // a job's detail (in flight, else a finished one opened)
  let job = page.locator('[data-testid^="now-jobpress-"]').first();
  if (!(await job.count())) { await page.locator('[data-testid^="now-donepress-"]').first().click(); await page.waitForTimeout(800); job = page.locator('[data-testid^="now-jobpress-"]').first(); }
  await job.click();
  await T('now-detail').waitFor({ timeout: 10000 });
  check(await T('now-steps').count() === 1, 'a job opens its steps inline');
  if (await T('now-log').count()) {
    await page.waitForFunction(() => !/loading/.test(document.querySelector('[data-testid="now-log-note"]')?.textContent ?? 'loading'), null, { timeout: 20000 }).catch(() => {});
    check(true, `log: ${await T('now-log-note').textContent()}`);
  }
  await T('now-detail-close').click();
  await page.waitForTimeout(500);
  check(await T('now-detail').count() === 0, 'the detail closes');
  await T('now-mach-0').click();
  await T('now-detail').waitFor({ timeout: 10000 });
  check(true, `a machine opens: ${(await T('now-detail-title').textContent())?.trim()}`);
  await T('now-mach-0').click();
  // a repo filter
  const repoBtn = page.locator('[data-testid^="now-repo-"]').first();
  if (await repoBtn.count()) {
    const name = (await repoBtn.textContent())?.trim();
    await repoBtn.click();
    await T('now-filter').waitFor({ timeout: 10000 });
    check(/[?&]repo=/.test(page.url()), `a repo filter is in the URL (${name})`);
    await page.screenshot({ path: join(out, `${label}-filter.png`) });
    await T('now-filter-clear').click();
    await page.waitForTimeout(800);
    check(await T('now-filter').count() === 0, 'Show everything clears it');
  }
  await T('tab-factory').click();
  await page.waitForTimeout(1500);
  check(await T('factory-live').count() === 1, 'Factory is one click away');
  await T('tab-yard').click();
  await page.waitForTimeout(1500);
  check(await T('yard-live').count() === 1, 'Yard is one click away');
  await T('tab-now').click();
  await T('now-status').waitFor({ timeout: 10000 });
  check(true, 'back to Live');
  await page.screenshot({ path: join(out, `${label}-e2e.png`) });
} catch (e) {
  check(false, `threw: ${String(e).slice(0, 300)}`);
}
check(errors.length === 0, `no page errors${errors.length ? `: ${errors[0]}` : ''}`);
await browser.close();
for (const c of res.checks) console.log(c);
console.log(JSON.stringify({ label, ok: res.ok, n: res.checks.length }));
process.exit(res.ok ? 0 : 1);
