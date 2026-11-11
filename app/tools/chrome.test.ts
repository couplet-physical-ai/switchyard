// The floor's chrome (w2-chrome, REVIEW-iter3 #7, #8, #12) on the recorded fixtures:
//   1. a car's journey strokes with round caps of its own: the time strip's bars and the drawer
//      that follow it stroke flat (`butt`), so the strip never turns into discs (#7);
//   2. the glance row is an opaque band the floor never paints through, and a press on it never
//      reaches the floor (#8);
//   3. the back wall's titles: one per board, each centred over its own board, none spilling over
//      another board by more than 20 % of its width (#12).
// Run: bun app/tools/chrome.test.ts
import { Timeline } from '../src/timeline.ts';
import { bindInsights } from '../src/insights.ts';
import { Factory } from '../src/factory/factory.ts';
import { BOARDS } from '../src/factory/front.ts';
import { BAND_H } from '../src/factory/labels.ts';
import type { Snapshot } from '../src/wire.ts';

let fails = 0;
const ok = (c: unknown, m: string) => { if (c) console.log('ok', m); else { fails++; console.log('FAIL', m); } };

const fixture = (await Bun.file(new URL('../../contract/fixtures/snapshot.json', import.meta.url)).json()) as Snapshot;
const W = 1440, H = 900;
const noop = () => {};

/** A 2D context that keeps its state stack and, at each stroke and fill, the state and the path's
 *  points (device px: the frames below are at scale 1). */
type Op = { op: 'stroke' | 'fill' | 'fillRect' | 'text'; cap: string; lw: number; style: string; pts: number[]; s?: string };
function recorder() {
  const ops: Op[] = [];
  let st = { cap: 'butt', join: 'miter', lw: 1, stroke: '#000', fill: '#000', alpha: 1 };
  const stack: typeof st[] = [];
  let pts: number[] = [];
  const base: Record<string, unknown> = {
    canvas: { width: W, height: H },
    save: () => { stack.push({ ...st }); },
    restore: () => { const s = stack.pop(); if (s) st = s; },
    beginPath: () => { pts = []; },
    moveTo: (x: number, y: number) => { pts.push(x, y); },
    lineTo: (x: number, y: number) => { pts.push(x, y); },
    rect: (x: number, y: number, w: number, h: number) => { pts.push(x, y, x + w, y + h); },
    stroke: () => { ops.push({ op: 'stroke', cap: st.cap, lw: st.lw, style: String(st.stroke), pts: pts.slice() }); },
    fill: () => { ops.push({ op: 'fill', cap: st.cap, lw: st.lw, style: String(st.fill), pts: pts.slice() }); },
    fillRect: (x: number, y: number, w: number, h: number) => { ops.push({ op: 'fillRect', cap: st.cap, lw: st.lw, style: String(st.fill), pts: [x, y, x + w, y + h] }); },
    fillText: (s: string, x: number, y: number) => { ops.push({ op: 'text', cap: st.cap, lw: st.lw, style: String(st.fill), pts: [x, y], s: String(s) }); },
    measureText: (s: string) => ({ width: 9 * String(s).length }),
    getLineDash: () => [],
    createLinearGradient: () => ({ addColorStop: noop }),
    createRadialGradient: () => ({ addColorStop: noop }),
  };
  const ctx = new Proxy(base, {
    get: (t, k) => {
      if (k === 'lineCap') return st.cap;
      if (k === 'lineJoin') return st.join;
      if (k === 'lineWidth') return st.lw;
      if (k === 'strokeStyle') return st.stroke;
      if (k === 'fillStyle') return st.fill;
      if (k === 'globalAlpha') return st.alpha;
      return k in t ? t[k as string] : noop;
    },
    set: (_t, k, v) => {
      if (k === 'lineCap') st.cap = v; else if (k === 'lineJoin') st.join = v; else if (k === 'lineWidth') st.lw = v;
      else if (k === 'strokeStyle') st.stroke = v; else if (k === 'fillStyle') st.fill = v; else if (k === 'globalAlpha') st.alpha = v;
      return true;
    },
  });
  return { ctx: ctx as never, ops, reset: () => { ops.length = 0; st = { cap: 'butt', join: 'miter', lw: 1, stroke: '#000', fill: '#000', alpha: 1 }; stack.length = 0; } };
}
const frame = (t: number) => ({ time: t, width: W, height: H, pixelWidth: W, pixelHeight: H, dpr: 1, scale: 1, cause: 'frame', causes: ['frame'] }) as never;

const snap = JSON.parse(JSON.stringify(fixture)) as Snapshot;
const tl = new Timeline();
tl.load(snap, 0);
tl.wallNow = () => snap.at;
tl.tick(0);
bindInsights(tl, () => null);
const f = new Factory(tl);
const quiet = recorder();
let t = 16;
const run = (n: number, ctx = quiet.ctx) => { for (let i = 0; i < n; i++, t += 100) { tl.tick(t); f.drawFloor(quiet.ctx, frame(t), t); f.drawLive(ctx, frame(t), t, 0); } };
f.coffee.open('', '', true, 0);
run(120);

// ── 1. the journey's round caps stay its own (#7) ──
{
  let car = '';
  for (const r of tl.world.repos.values()) { const rc = r.main?.recent ?? []; if (rc.length) { car = `${r.id}@${rc[rc.length - 1]!.sha}`; break; } }
  ok(car, `a car to select (${car})`);
  f.select(car, 'commit');
  run(4);
  const rec = recorder();
  run(1, rec.ctx);
  const journey = rec.ops.filter((o) => o.op === 'stroke' && o.cap === 'round' && o.lw === 9);
  ok(journey.length >= 1, `the journey strokes its glow with round caps (${journey.length})`);
  const y0 = H - 58;
  const inStrip = (o: Op) => o.pts.length >= 4 && o.pts.every((v, i) => (i % 2 ? v >= y0 - 1 : true));
  const strip = rec.ops.filter((o) => o.op === 'stroke' && inStrip(o));
  const wide = strip.filter((o) => o.lw > 4);
  ok(strip.length > 0, `the time strip strokes after the journey (${strip.length}, ${wide.length} wider than 4 px)`);
  const round = strip.filter((o) => o.cap !== 'butt');
  ok(round.length === 0, `every time-strip stroke is flat-capped after a journey (${round.length} not: ${[...new Set(round.map((o) => `${o.cap} ${o.lw}`))].slice(0, 4).join(', ')})`);
  const drawer = rec.ops.filter((o) => o.op === 'stroke' && o.pts.length >= 2 && o.pts.every((v, i) => (i % 2 ? true : v >= W - 372)));
  ok(drawer.length > 0 && drawer.every((o) => o.cap === 'butt'), `the drawer after it strokes flat too (${drawer.length} strokes; journey() restores its state)`);
  f.select('', '');
  run(2);
}

// ── 2. the glance row's band (#8) ──
{
  for (const z of [1, 2, 2.6]) {
    f.cam.reset(t);
    run(30);
    if (z !== 1) { f.cam.zoomAt(z, W / 2, H / 2); run(30); }
    const rec = recorder();
    run(1, rec.ctx);
    const band = rec.ops.find((o) => o.op === 'fillRect' && o.pts[0]! <= 0 && o.pts[1]! <= 0 && o.pts[2]! >= W && Math.abs(o.pts[3]! - BAND_H) < 1);
    ok(band, `zoom ${Math.round(f.cam.zoom * 100)} %: an opaque band over the glance row (y 0–${BAND_H}, ${band?.style ?? 'none'})`);
    // the floor's own presses never land in it: whatever answers a press there was drawn over the
    // band (the glance, the camera's buttons), never under it
    const hits = f.fx.hits as { x: number; y: number; w: number; h: number; kind: string }[];
    const bi = hits.findIndex((h) => h.kind === 'drawer' && h.x <= 0 && h.y <= 0 && h.w >= W && Math.abs(h.h - BAND_H) < 1);
    let under = 0, below = 0;
    for (let x = 4; x < W - 4; x += 12) for (let y = 2; y < BAND_H - 1; y += 5) {
      const h = f.hitAt(x, y);
      if (!h || hits.indexOf(h as never) < bi) under++;
    }
    for (const h of hits.slice(0, Math.max(0, bi))) if (h.y < BAND_H && h.y + h.h > 0) below++;
    ok(bi >= 0 && under === 0, `zoom ${Math.round(f.cam.zoom * 100)} %: no floor object answers a press in the band (${under} points; ${below} floor hits reach under it)`);
  }
  f.cam.reset(t); t += 2000; run(3);
}

// ── 3. the titles over their boards (#12) ──
{
  const rec = recorder();
  run(1, rec.ctx);
  const cam = f.cam;
  const span = (b: (typeof BOARDS)[number]) => [cam.x(b.u0, 0), cam.x(b.u1, 0)] as const;
  ok(BOARDS.some((b) => b.stage === '03') && BOARDS.some((b) => b.stage === '06'), 'merge gate and consumption engine have boards of their own');
  const titles = f.words.titleSpans;
  ok(titles.length === BOARDS.length, `one title per board (${titles.length} titles, ${BOARDS.length} boards)`);
  for (const ti of titles) {
    const b = BOARDS.find((x) => x.stage === ti.n);
    if (!b) { ok(false, `title ${ti.s}: a board`); continue; }
    const [a0, a1] = span(b), mid = (a0 + a1) / 2, tm = ti.x + ti.w / 2;
    ok(Math.abs(tm - mid) <= Math.max(24, (a1 - a0) * 0.2), `"${ti.s}" is centred over its board (${Math.round(tm)} vs ${Math.round(mid)})`);
    let worst = 0;
    for (const o of BOARDS) {
      if (o === b) continue;
      const [c0, c1] = span(o), ov = Math.max(0, Math.min(ti.x + ti.w, c1) - Math.max(ti.x, c0));
      worst = Math.max(worst, ov / ti.w);
    }
    ok(worst <= 0.2, `"${ti.s}" overlaps no other board by more than 20 % (${Math.round(worst * 100)} %)`);
  }
  for (let i = 1; i < titles.length; i++) ok(titles[i]!.x >= titles[i - 1]!.x + titles[i - 1]!.w + 8, `"${titles[i - 1]!.s}" and "${titles[i]!.s}" do not touch`);
}

console.log(fails ? `chrome: ${fails} FAILED` : 'chrome: all ok');
process.exit(fails ? 1 : 0);
