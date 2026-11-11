// The factory floor's DEAD CELLS (FACTORY-SPEC §A "every pixel informs"): the share of the 30-px
// cells (CSS px, at 1440×900) between y 60 and 815 whose brightest pixel is no brighter than the
// floor's grid (max luma < 45 of 255, Rec. 709 on the sRGB values). B-1 measured 53 %; phase 2's
// bar (§I W1) is ≤ 25 %. Two numbers:
//   ON THE SLAB  the cells whose centre lies inside the floor's parallelogram at the fitted camera
//                (the acceptance bar: what the floor itself wastes)
//   FULL BAND    every cell of the band (the honest whole-screen number; the projection leaves
//                the corners above and below the slab off it)
// The slab is computed from iso.ts's projection and fit (Cam.fit(W, H, 84, 58) at zoom 1, no
// pan) and the factory canvas's box; for a png, the canvas is assumed at (0, 33) 1440 × 840
// (`--canvas x,y,w,h` to say otherwise).
//
//   node factory-deadcells.mjs <url | png> [--wait ms] [--shot out.png] [--overlay out.png] [--max pct] [--fixtures] [--canvas x,y,w,h]
//
// A url is opened at 1440×900 @2× in headless Chromium (the factory tab is the default route;
// `--fixtures` connects it to the recorded fleet through Settings first, as the tests do), waited
// on, and shot; a png (any 1440×900 multiple, e.g. a 2880×1800 still) is measured as it is.
// `--overlay` writes the shot with every dead cell tinted (on the slab magenta, off it gray) and
// the slab outlined; `--max` exits 1 when the on-slab share is over it.
// Run it with node from a directory that has playwright-core (e.g. /tmp/synqa), like
// factory-shots.mjs.
import { chromium } from 'playwright-core';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
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

const args = process.argv.slice(2);
const opt = (name, def = '') => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] ?? def : def; };
const src = args.find((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--') && args[i - 1] !== '--fixtures'));
if (!src) { console.error('usage: node factory-deadcells.mjs <url | png> [--wait ms] [--shot out.png] [--overlay out.png] [--max pct] [--fixtures]'); process.exit(2); }
const WAIT = Number(opt('wait', '9000'));
const CELL = 30, Y0 = 60, Y1 = 815, LUMA = 45;
// iso.ts: the projection, the floor's extent, Cam.fit's margins
const UX = 0.86, UY = 0.19, VX = -0.36, VY = 0.66, LU = 1500, LV = 640;
function slabOf([cx, cy, W, H]) {
  const minX = LV * VX, maxX = LU * UX, minY = -64, maxY = LU * UY + LV * VY;
  const availW = W - 150, availH = H - 84 - 58;
  const s = Math.min(availW / (maxX - minX), availH / (maxY - minY));
  const fx = 110 + (availW - (maxX - minX) * s) / 2 - minX * s, fy = 84 + (availH - (maxY - minY) * s) / 2 - minY * s;
  return [[0, 0], [LU, 0], [LU, LV], [0, LV]].map(([u, v]) => [cx + fx + s * (u * UX + v * VX), cy + fy + s * (u * UY + v * VY)]);
}
let canvasBox = (opt('canvas') || '0,33,1440,840').split(',').map(Number);

const browser = await chromium.launch({ executablePath: chrome() });
try {
  let png;
  if (/^https?:/.test(src)) {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
    const page = await ctx.newPage();
    await page.goto(src, { waitUntil: 'load' });
    if (args.includes('--fixtures')) {
      await page.getByTestId('open-settings').click();
      await page.getByTestId('server-field').fill('fixtures');
      await page.getByTestId('settings-save').click();
    }
    await page.getByTestId('factory-live').waitFor({ timeout: 60000 });
    const bb = await page.getByTestId('factory-live').boundingBox();
    if (bb) canvasBox = [bb.x, bb.y, bb.width, bb.height];
    await page.mouse.move(2, 880);
    await page.waitForTimeout(WAIT);
    png = await page.screenshot();
    await ctx.close();
  } else png = readFileSync(src);
  if (opt('shot')) writeFileSync(opt('shot'), png);
  const page = await browser.newPage();
  const slab = slabOf(canvasBox);
  const r = await page.evaluate(async ({ b64, CELL, Y0, Y1, LUMA, overlay, slab }) => {
    const img = new Image();
    img.src = `data:image/png;base64,${b64}`;
    await img.decode();
    const W = img.naturalWidth, H = img.naturalHeight, k = W / 1440;
    const cv = document.createElement('canvas');
    cv.width = W; cv.height = H;
    const c = cv.getContext('2d');
    c.drawImage(img, 0, 0);
    const d = c.getImageData(0, 0, W, H).data;
    const cs = Math.round(CELL * k);
    const P = slab.map(([x, y]) => [x * k, y * k]);
    const inside = (x, y) => { let c = false; for (let i = 0, j = P.length - 1; i < P.length; j = i++) { const [xi, yi] = P[i], [xj, yj] = P[j]; if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c; } return c; };
    const dead = [];
    let n = 0, nIn = 0, deadIn = 0;
    for (let y = Math.round(Y0 * k); y + cs <= Math.round(Y1 * k) + 1; y += cs) {
      for (let x = 0; x + cs <= W; x += cs) {
        n++;
        const on = inside(x + cs / 2, y + cs / 2);
        if (on) nIn++;
        let max = 0;
        for (let yy = y; yy < y + cs && max < LUMA; yy++) {
          let i = (yy * W + x) * 4;
          for (let xx = 0; xx < cs; xx++, i += 4) {
            const l = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
            if (l > max) { max = l; if (max >= LUMA) break; }
          }
        }
        if (max < LUMA) { dead.push([x, y, on]); if (on) deadIn++; }
      }
    }
    let out = '';
    if (overlay) {
      for (const [x, y, on] of dead) { c.fillStyle = on ? 'rgba(255, 40, 160, 0.34)' : 'rgba(150, 150, 160, 0.18)'; c.fillRect(x + 1, y + 1, cs - 2, cs - 2); }
      c.strokeStyle = 'rgba(80, 220, 255, 0.7)'; c.lineWidth = 2 * k;
      c.beginPath(); P.forEach(([x, y], i) => (i ? c.lineTo(x, y) : c.moveTo(x, y))); c.closePath(); c.stroke();
      c.strokeStyle = 'rgba(255,255,255,0.25)';
      c.strokeRect(0, Math.round(Y0 * k), W, Math.round((Y1 - Y0) * k));
      out = cv.toDataURL('image/png').split(',')[1];
    }
    return { cells: n, dead: dead.length, cellsIn: nIn, deadIn, out };
  }, { b64: png.toString('base64'), CELL, Y0, Y1, LUMA, overlay: !!opt('overlay'), slab });
  if (opt('overlay')) writeFileSync(opt('overlay'), Buffer.from(r.out, 'base64'));
  const pctIn = (r.deadIn / Math.max(1, r.cellsIn)) * 100, pctAll = (r.dead / r.cells) * 100;
  console.log(`dead cells on the slab: ${r.deadIn} of ${r.cellsIn} = ${pctIn.toFixed(1)} %`);
  console.log(`dead cells, full band: ${r.dead} of ${r.cells} = ${pctAll.toFixed(1)} % (30-px cells, y ${Y0}–${Y1}, max luma < ${LUMA})`);
  const pct = pctIn;
  const max = opt('max');
  if (max && pct > Number(max)) { console.log(`FAIL: over ${max} %`); process.exitCode = 1; }
} finally {
  await browser.close();
}
