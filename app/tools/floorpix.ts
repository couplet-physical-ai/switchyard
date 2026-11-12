// The static floor's pixel check (fab-w7c; factory-bench --floor-pixels, PERF.md "The static floor
// by dirty tiles"): Exact's own web replayer (host/web/canvas2d-glue.js `Replayer`, the class the
// web host replays every canvas list with) in headless Chromium, fed the lists Exact's own recorder
// (canvas/recorder.js `canvasSeam`) makes of the bench's draws. One canvas keeps every floor draw,
// as the app's floor canvas does (dirty-tile flushes and all); reference canvases are made fresh
// for each full repaint, and `cmp` counts the pixels that differ.
//
// Modes: `cpu` (Skia on the CPU: --disable-gpu, no accelerated 2D canvas), `gpu` (the flags
// factory-shots uses: GPU rasterization on SwiftShader) and `agent` (the Exact agent's own launch:
// no GPU flags).
import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

function chrome(): string {
  if (process.env.CHROME) return process.env.CHROME;
  const base = join(homedir(), '.cache/ms-playwright');
  for (const d of readdirSync(base).filter((d) => d.startsWith('chromium_headless_shell')).sort().reverse()) {
    for (const sub of readdirSync(join(base, d))) { const c = join(base, d, sub, 'chrome-headless-shell'); if (existsSync(c)) return c; }
  }
  throw new Error('no chrome-headless-shell under ~/.cache/ms-playwright');
}

export type PixDiff = { n: number; max: number; box: number[]; hist: number[]; worst: number[]; pts: number[] };

export async function openPix(mode: string, W: number, H: number, scale: number, exact2: string) {
  const { chromium } = await import('playwright-core');
  const args = mode === 'cpu' ? ['--disable-gpu', '--disable-accelerated-2d-canvas', '--disable-gpu-compositing']
    : mode === 'gpu' ? ['--enable-gpu-rasterization', '--ignore-gpu-blocklist'] : [];
  const browser = await chromium.launch({ executablePath: chrome(), args });
  const page = await browser.newPage();
  page.on('console', (m) => { const t = m.text(); if (/error|unreadable/i.test(t)) console.log(`floorpix console: ${t.slice(0, 300)}`); });
  await page.setContent('<!doctype html><html><body style="margin:0"></body></html>');
  const glue = readFileSync(join(exact2, 'host/web/canvas2d-glue.js'), 'utf8');
  await page.addScriptTag({ content: `window.exact = { fontAliases: {} };\n${glue}\nwindow.ExactReplayer = Replayer;` });
  const pw = Math.round(W * scale), ph = Math.round(H * scale);
  await page.evaluate(([pw, ph, scale]) => {
    const w = window as unknown as Record<string, unknown>;
    const R: Record<string, { ctx: CanvasRenderingContext2D; el: HTMLCanvasElement; apply: (v: DataView) => boolean }> = {};
    const Rep = w.ExactReplayer as new (el: HTMLCanvasElement, op: unknown) => (typeof R)[string];
    w.R = R;
    w.mk = (name: string) => {
      R[name]?.el.remove();
      const el = document.createElement('canvas');
      document.body.appendChild(el);
      R[name] = new Rep(el, { w: pw, h: ph, scale, lifetime: 0, generation: 1, p3: false, float16: false });
    };
    w.put = (batches: [string, string[]][]) => {
      let bad = 0;
      for (const [name, lists] of batches) {
        for (const b64 of lists) {
          const s = atob(b64), u = new Uint8Array(s.length);
          for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i);
          if (!R[name].apply(new DataView(u.buffer))) bad++;
        }
      }
      return bad;
    };
    // pixels that differ (any channel), the largest channel difference, their box, a histogram of
    // the differences (1-2, 3-8, 9-32, 33+) and the worst pixel (x, y, its difference)
    // with `mask` (a flag per 16 CSS px tile, row by row): only the pixels outside the flagged tiles
    // (`outside`), or only those inside them
    w.keep = (a: string, b: string) => { R[b]?.el.remove(); R[b] = R[a]; delete R[a]; };
    w.cmp = (a: string, b: string, mask: number[] | null, outside: boolean) => {
      const A = R[a].ctx.getImageData(0, 0, pw, ph).data, B = R[b].ctx.getImageData(0, 0, pw, ph).data;
      const T = 16 * scale, cols = Math.ceil(pw / T);
      let n = 0, max = 0, x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1, wi = -1;
      const hist = [0, 0, 0, 0], pts: number[] = [];
      for (let i = 0; i < A.length; i += 4) {
        const d = Math.max(Math.abs(A[i] - B[i]), Math.abs(A[i + 1] - B[i + 1]), Math.abs(A[i + 2] - B[i + 2]), Math.abs(A[i + 3] - B[i + 3]));
        if (!d) continue;
        const p = i >> 2, x = p % pw, y = (p / pw) | 0;
        if (mask) { const m = mask[((y / T) | 0) * cols + ((x / T) | 0)] ? 1 : 0; if (outside ? m : !m) continue; }
        n++;
        if (pts.length < 120) pts.push(x, y, d);
        if (x < x0) x0 = x; if (y < y0) y0 = y; if (x > x1) x1 = x; if (y > y1) y1 = y;
        if (d > max) { max = d; wi = p; }
        hist[d <= 2 ? 0 : d <= 8 ? 1 : d <= 32 ? 2 : 3]++;
      }
      return { n, max, box: n ? [x0, y0, x1, y1] : [], hist, worst: wi >= 0 ? [wi % pw, (wi / pw) | 0, max] : [], pts };
    };
    // a picture of a comparison: the reference dimmed, the pixels that differ in red (brighter = more)
    w.diffPng = (a: string, b: string) => {
      const A = R[a].ctx.getImageData(0, 0, pw, ph), B = R[b].ctx.getImageData(0, 0, pw, ph).data, D = A.data;
      for (let i = 0; i < D.length; i += 4) {
        const d = Math.max(Math.abs(D[i] - B[i]), Math.abs(D[i + 1] - B[i + 1]), Math.abs(D[i + 2] - B[i + 2]), Math.abs(D[i + 3] - B[i + 3]));
        if (d) { D[i] = 128 + Math.min(127, d * 8); D[i + 1] = 0; D[i + 2] = 0; D[i + 3] = 255; } else { D[i] = D[i] >> 2; D[i + 1] = D[i + 1] >> 2; D[i + 2] = D[i + 2] >> 2; D[i + 3] = 255; }
      }
      const c = document.createElement('canvas'); c.width = pw; c.height = ph;
      c.getContext('2d')!.putImageData(A, 0, 0);
      return c.toDataURL('image/png');
    };
    w.png = (a: string) => R[a].el.toDataURL('image/png');
  }, [pw, ph, scale] as [number, number, number]);
  const pending = new Map<string, string[]>();
  return {
    pw, ph,
    /** A fresh canvas `name` (the lists queued for it before are dropped). */
    async fresh(name: string) { await this.sync(); await page.evaluate((n) => (window as unknown as { mk: (n: string) => void }).mk(n), name); },
    /** Queues lists for canvas `name` (sent, in order, at the next sync). */
    put(name: string, lists: string[]) {
      if (!lists.length) return;
      let q = pending.get(name);
      if (!q) { q = []; pending.set(name, q); }
      for (const l of lists) q.push(l);
    },
    async sync(): Promise<number> {
      if (!pending.size) return 0;
      // in queue order per canvas (canvases are independent)
      const batches: [string, string[]][] = [...pending].map(([k, v]) => [k, v]);
      pending.clear();
      return page.evaluate((b) => (window as unknown as { put: (b: [string, string[]][]) => number }).put(b), batches);
    },
    /** Pixels of `a` and `b` that differ (with `mask`: outside its tiles, or inside them). */
    async cmp(a: string, b: string, mask: number[] | null = null, outside = true): Promise<PixDiff> {
      await this.sync();
      return page.evaluate(([a, b, m, o]) => (window as unknown as { cmp: (a: string, b: string, m: number[] | null, o: boolean) => PixDiff }).cmp(a, b, m, o), [a, b, mask, outside] as [string, string, number[] | null, boolean]);
    },
    /** Canvas `a` is now called `b`. */
    async keep(a: string, b: string) { await this.sync(); await page.evaluate(([a, b]) => (window as unknown as { keep: (a: string, b: string) => void }).keep(a, b), [a, b] as [string, string]); },
    async savePng(path: string, a: string, b?: string) {
      await this.sync();
      const url = await page.evaluate(([a, b]) => { const w = window as unknown as { diffPng: (a: string, b: string) => string; png: (a: string) => string }; return b ? w.diffPng(a, b) : w.png(a); }, [a, b ?? ''] as [string, string]);
      mkdirSync(join(path, '..'), { recursive: true });
      writeFileSync(path, Buffer.from(url.slice(url.indexOf(',') + 1), 'base64'));
    },
    /** The page's advance (px a character) of each CSS font, from ten zeros (the bench's text
     *  measure, so a monospaced face's words are where the replayer draws them; p5-board). */
    async advances(fonts: string[]): Promise<number[]> {
      return page.evaluate((fs) => { const c = document.createElement('canvas').getContext('2d')!; return fs.map((f) => { c.font = f; return c.measureText('0000000000').width / 10; }); }, fonts);
    },
    async close() { await browser.close(); },
  };
}
