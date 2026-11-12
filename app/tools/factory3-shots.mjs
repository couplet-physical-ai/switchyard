// Factory 3 (/factory?v=3): stills, the idle proof, the reel and the numbers, against a served
// web build (tools/live-proxy.ts in front of the live server, or of a frozen one).
//   NODE_PATH=$EXACT2/node_modules bun tools/factory3-shots.mjs stills <base-url> <outdir>
//     → wide.png (2880×1800), laptop.png (1440×900 @2×), inspect.png (a failed run opened)
//   … idle <base-url> <outdir> [seconds=25]
//     → idle-a.png, idle-b.png (the same board `seconds` apart, inside one minute), idle.json
//       (differing pixels, what the board painted between them)
//   … reel <base-url> <outdir> <script>
//     → raw.webm (1440×900). script: comma list of wait:ms | replay | live | failed | red | chip | esc
//   … perf <base-url> <outdir> [seconds=20] [replay]
//     → perf.json: requestAnimationFrame fps, JS heap at the start and the end, what the board painted
//   … freeze <server-url> <header-file> <dir>
//     → dir/snapshot.json + dir/hour.jsonl: the server's snapshot now, with the work that is
//       running, waiting or deploying removed (an idle fleet), for `bun server/mock.ts --frozen
//       --fixtures dir`. The header file holds "Authorization: Bearer …" (never printed).
import { chromium } from 'playwright-core';
import { existsSync, readdirSync, readFileSync, renameSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

function chrome() {
  if (process.env.CHROME) return process.env.CHROME;
  const base = join(homedir(), '.cache/ms-playwright');
  for (const d of readdirSync(base).filter((d) => d.startsWith('chromium_headless_shell')).sort().reverse())
    for (const sub of readdirSync(join(base, d))) { const c = join(base, d, sub, 'chrome-headless-shell'); if (existsSync(c)) return c; }
  throw new Error('no chrome-headless-shell');
}
const [mode, base, out, a3, a4] = process.argv.slice(2);
if (!mode || !base || !out) { console.error('usage: factory3-shots.mjs stills|idle|reel|perf|freeze <base-url> <outdir> …'); process.exit(1); }
mkdirSync(out, { recursive: true });
const URL3 = `${base.replace(/\/+$/, '')}/factory?v=3`;

if (mode === 'freeze') {
  const hdr = readFileSync(a3, 'utf8').trim();
  const i = hdr.indexOf(':');
  const res = await fetch(`${base.replace(/\/+$/, '')}/api/v1/snapshot`, { headers: { [hdr.slice(0, i).trim()]: hdr.slice(i + 1).trim(), accept: 'application/json' } });
  if (!res.ok) { console.error('snapshot', res.status); process.exit(1); }
  const s = await res.json();
  const before = s.pipelines.length;
  s.pipelines = s.pipelines.filter((p) => p.state !== 'running' && p.state !== 'pending' && p.state !== 'blocked');
  for (const e of s.engines ?? []) { e.running = []; e.busy = 0; }
  for (const q of s.queues ?? []) { q.items = []; q.pending = 0; q.running = 0; q.waiting = 0; q.oldest_wait_ms = 0; q.pipelines_running = 0; }
  const deploys = s.deploys.length;
  s.deploys = s.deploys.filter((d) => d.state === 'success' || d.state === 'failure');
  for (const c of s.commits ?? []) if (c.stage === 'pushed') c.stage = 'merged';
  writeFileSync(join(out, 'snapshot.json'), JSON.stringify(s));
  // (the mock wants one delta frame; this one changes nothing)
  writeFileSync(join(out, 'hour.jsonl'), `${JSON.stringify({ t: 'delta', seq: s.seq + 1, at: s.at + 1000, ops: [] })}\n`);
  console.log(`froze the fleet at ${new Date(s.at).toISOString()}: ${s.repos.length} repos, ${s.apps.length} apps, ${s.pipelines.length} runs (${before - s.pipelines.length} live ones removed), ${s.deploys.length} deploys (${deploys - s.deploys.length} live removed)`);
  process.exit(0);
}

const browser = await chromium.launch({ executablePath: chrome(), args: ['--enable-gpu-rasterization', '--ignore-gpu-blocklist'] });
const said = {};
function listen(page) {
  page.on('console', (m) => {
    const t = m.text();
    const k = /factory3: (newest failed|newest red) \S+ (\d+),(\d+)/.exec(t) ?? /factory3: (window 2h at) (\d+),(\d+)/.exec(t);
    if (k) said[k[1]] = [+k[2], +k[3]];
  });
  page.on('pageerror', (e) => console.log('pageerror:', String(e).slice(0, 400)));
}
const canvasBox = (page) => page.locator('[data-testid="factory-live"]').last().boundingBox();
async function press(page, at) {
  if (!at) return false;
  const box = await canvasBox(page);
  await page.mouse.move(box.x + at[0], box.y + at[1], { steps: 14 });
  await page.waitForTimeout(300);
  await page.mouse.click(box.x + at[0], box.y + at[1]);
  return true;
}
/** What the board painted so far: the developer HUD's line, read and put away. */
async function work(page) {
  await page.locator('[data-testid="hud-toggle"]').click();
  await page.waitForTimeout(700);
  const t = await page.locator('[data-testid="f3-hud"]').innerText().catch(() => '');
  await page.locator('[data-testid="hud-toggle"]').click();
  await page.waitForTimeout(300);
  const n = (re) => Number(re.exec(t)?.[1] ?? -1);
  return { line: t, boardPaints: n(/board paints (\d+)/), movingPaints: n(/moving-layer paints (\d+)/), transits: n(/transits (\d+)/), builds: n(/scene builds (\d+)/) };
}

if (mode === 'stills') {
  for (const [name, w, h, scale] of [['wide', 2880, 1800, 1], ['laptop', 1440, 900, 2]]) {
    const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: scale, colorScheme: 'dark' });
    const page = await ctx.newPage();
    listen(page);
    await page.goto(URL3); await page.waitForTimeout(7000);
    await page.screenshot({ path: join(out, `${name}.png`) });
    console.log('wrote', join(out, `${name}.png`));
    if (name === 'laptop') {
      // a failed run, opened: the bin's newest; with none in the window, the widest window first
      if (!said['newest failed']) { await press(page, said['window 2h at']); await page.waitForTimeout(1200); }
      if (await press(page, said['newest failed'])) {
        await page.waitForTimeout(4500);
        await page.mouse.move(700, 30);
        await page.waitForTimeout(400);
        await page.screenshot({ path: join(out, 'inspect.png') });
        console.log('wrote', join(out, 'inspect.png'));
      } else console.log('no failed run in the last 2 h: no inspect.png');
    }
    await ctx.close();
  }
} else if (mode === 'idle') {
  const secs = Number(a3 ?? 25);
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, colorScheme: 'dark' });
  const page = await ctx.newPage();
  listen(page);
  await page.goto(URL3); await page.waitForTimeout(6000);
  // both frames inside one minute of the clock (the ages turn on the minute)
  const into = Date.now() % 60_000;
  if (into > 60_000 - (secs + 6) * 1000) await page.waitForTimeout(60_000 - into + 1500);
  const w0 = await work(page);
  await page.mouse.move(700, 30);
  await page.waitForTimeout(2500);
  const tA = new Date().toISOString();
  const A = await page.screenshot({ path: join(out, 'idle-a.png') });
  // sample the page while it sits: how many animation frames did it ask for, and did any DOM change
  const frames = await page.evaluate((ms) => new Promise((done) => {
    let muts = 0;
    const mo = new MutationObserver((l) => { muts += l.length; });
    mo.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true });
    setTimeout(() => { mo.disconnect(); done({ mutations: muts }); }, ms);
  }), secs * 1000);
  const tB = new Date().toISOString();
  const B = await page.screenshot({ path: join(out, 'idle-b.png') });
  const w1 = await work(page);
  const res = { url: URL3, frameA: tA, frameB: tB, seconds: secs, identicalBytes: Buffer.compare(A, B) === 0, domMutations: frames.mutations, before: w0, after: w1,
    boardPaintsBetween: w1.boardPaints - w0.boardPaints, movingPaintsBetween: w1.movingPaints - w0.movingPaints, transitsBetween: w1.transits - w0.transits };
  writeFileSync(join(out, 'idle.json'), JSON.stringify(res, null, 2));
  console.log(JSON.stringify(res, null, 2));
  await ctx.close();
} else if (mode === 'reel') {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, colorScheme: 'dark', recordVideo: { dir: out, size: { width: 1440, height: 900 } } });
  const page = await ctx.newPage();
  listen(page);
  const t0 = Date.now();
  await page.goto(URL3); await page.waitForTimeout(6000);
  console.log('lead-in ms', Date.now() - t0);
  for (const step of (a3 ?? 'wait:4000').split(',')) {
    const [k, v] = step.split(':');
    if (k === 'wait') await page.waitForTimeout(+v);
    else if (k === 'replay') await page.locator('[data-testid="replay"]').click();
    else if (k === 'live') await page.locator('[data-testid="go-live"]').click().catch(() => {});
    else if (k === 'failed') await press(page, said['newest failed']);
    else if (k === 'red') await press(page, said['newest red']);
    else if (k === 'chip') await press(page, said['window 2h at']);
    else if (k === 'esc') await page.keyboard.press('Escape');
    else if (k === 'park') await page.mouse.move(700, 30, { steps: 10 });
    console.log(step, Date.now() - t0);
  }
  const w = await work(page);
  console.log(w.line);
  const v = page.video();
  await ctx.close();
  if (v) renameSync(await v.path(), join(out, 'raw.webm'));
} else if (mode === 'perf') {
  const secs = Number(a3 ?? 20);
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, colorScheme: 'dark' });
  const page = await ctx.newPage();
  listen(page);
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('Performance.enable');
  await cdp.send('HeapProfiler.enable');
  const metrics = async () => { await cdp.send('HeapProfiler.collectGarbage'); const m = (await cdp.send('Performance.getMetrics')).metrics; const g = (n) => m.find((x) => x.name === n)?.value ?? 0; return { heapMB: +(g('JSHeapUsedSize') / 1048576).toFixed(2), script: g('ScriptDuration'), task: g('TaskDuration'), nodes: g('Nodes') }; };
  await page.goto(URL3); await page.waitForTimeout(7000);
  if (a4 === 'replay') { await page.locator('[data-testid="replay"]').click(); await page.waitForTimeout(1500); }
  const w0 = await work(page);
  const m0 = await metrics();
  const fr = await page.evaluate((ms) => new Promise((done) => {
    const dts = []; let last = performance.now(); const end = last + ms;
    const tick = (t) => { dts.push(t - last); last = t; if (t < end) requestAnimationFrame(tick); else done(dts); };
    requestAnimationFrame(tick);
  }), secs * 1000);
  const m1 = await metrics();
  const w1 = await work(page);
  const sorted = [...fr].sort((a, b) => a - b);
  const res = {
    url: URL3, mode: a4 === 'replay' ? 'replay 60×' : 'live', seconds: secs, size: '1440x900@2',
    fps: +(1000 * fr.length / fr.reduce((a, b) => a + b, 0)).toFixed(1), frameMsMedian: +sorted[Math.floor(sorted.length / 2)].toFixed(2), frameMsP95: +sorted[Math.floor(sorted.length * 0.95)].toFixed(2), frameMsMax: +sorted[sorted.length - 1].toFixed(2),
    longFrames: fr.filter((d) => d > 34).length, frames: fr.length,
    heapStartMB: m0.heapMB, heapEndMB: m1.heapMB, heapGrowthMB: +(m1.heapMB - m0.heapMB).toFixed(2),
    scriptMsPerSecond: +(1000 * (m1.script - m0.script) / secs).toFixed(2), taskMsPerSecond: +(1000 * (m1.task - m0.task) / secs).toFixed(2),
    boardPaints: w1.boardPaints - w0.boardPaints, movingPaints: w1.movingPaints - w0.movingPaints, transits: w1.transits - w0.transits, sceneBuilds: w1.builds - w0.builds,
  };
  writeFileSync(join(out, `perf-${a4 === 'replay' ? 'replay' : 'live'}.json`), JSON.stringify(res, null, 2));
  console.log(JSON.stringify(res, null, 2));
  await ctx.close();
}
await browser.close();
