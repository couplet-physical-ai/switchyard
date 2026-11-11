// Concept B, "the heaps" (ZERO.md "FACTORY REDO"): seven stage pits on one belt, no machinery.
// Each pit's plinth is how much passed through it in the last hour; on it, one crate per thing IN
// it right now, heaped (a pile-up is a tall heap). Breaks fall forward off the belt into the
// FAILED bin along the front. The same order, the same colours, nothing but the counts.

import type { Gfx } from '../yard/gfx.ts';
import { C } from '../yard/theme.ts';
import { Cam, P, box, crate, poly, quad, type Tone } from './iso.ts';
import { WINDOWS, drawBin, type Hit, type LineOpts } from './line.ts';
import type { Stages } from './stages.ts';

export const HL = { u0: -10, u1: 1500, v0: 60, v1: 470, belt: 190, pad: 110 };
const CENTERS = [60, 275, 490, 705, 920, 1135, 1350];
const NAMES = ['sources', 'intake', 'engines', 'tests', 'main lines', 'deploy', 'apps'];

function heap(cam: Cam, g: Gfx, uc: number, vc: number, z0: number, n: number, tone: (i: number) => Tone, hits: Hit[] | null, ids?: string[], urls?: string[]): void {
  const d = 15, per = 5, layer = per * per;
  for (let i = 0; i < Math.min(n, layer * 6); i++) {
    const l = Math.floor(i / layer), k = i % layer;
    const shrink = l; // each layer one ring in
    const row = Math.floor(k / per), col = k % per;
    if (row < shrink / 2 || col < shrink / 2) continue;
    const u = uc - (per - 1) * 9 + col * 18, v = vc - (per - 1) * 9 + row * 18;
    crate(cam, g, u, v, d, tone(i), z0 + l * 12.5, 0.8);
    if (hits && ids?.[i]) hits.push({ kind: 'run', id: ids[i], x: cam.x(u, v) - 8, y: cam.y(u, v, z0 + l * 12.5 + 12) - 8, w: 16, h: 16, url: urls?.[i] });
  }
}

export function drawHeaps(g: Gfx, cam: Cam, S: Stages, now: number, o: LineOpts): Hit[] {
  const hits: Hit[] = [];
  g.begin_(); quad(cam, g, HL.u0, HL.v0, HL.u1, HL.v1, 0); g.fill(P.floor);
  g.begin_();
  for (let u = 0; u <= HL.u1; u += 40) { g.move(cam.x(u, HL.v0), cam.y(u, HL.v0)); g.line(cam.x(u, HL.v1), cam.y(u, HL.v1)); }
  for (let v = HL.v0; v <= HL.v1; v += 40) { g.move(cam.x(HL.u0, v), cam.y(HL.u0, v)); g.line(cam.x(HL.u1, v), cam.y(HL.u1, v)); }
  g.stroke(P.grid, 1);
  // the belt through every pit
  const B = HL.belt;
  g.begin_(); poly(cam, g, [0, B - 14, 0.4, HL.u1 - 20, B - 14, 0.4, HL.u1 - 20, B + 14, 0.4, 0, B + 14, 0.4]); g.fill(P.belt);
  g.begin_();
  for (let u = ((o.phase * 14) % 14); u < HL.u1 - 20; u += 14) { g.move(cam.x(u, B - 11), cam.y(u, B - 11, 0.5)); g.line(cam.x(u, B + 11), cam.y(u, B + 11, 0.5)); }
  g.stroke(P.slat, 1);
  // per hour through each stage (the plinth) and what is in it now (the heap)
  const thru = [S.sources.perHour, S.flow.intake, S.flow.engines, S.tests.total, S.flow.mains, S.flow.deploy, S.apps.total];
  const runIds = S.engines.machines.flatMap((m) => m.bays.filter((b) => b.item).map((b) => b.item!));
  const now_: { n: number; tone: (i: number) => Tone; ids?: string[]; urls?: string[] }[] = [
    { n: S.sources.arrivals.length, tone: () => 'wait' },
    { n: S.intake.items.length, tone: (i) => (now - (S.intake.items[i]?.at ?? now) > 3_600_000 ? 'fail' : 'wait'), ids: S.intake.items.map((x) => x.id), urls: S.intake.items.map((x) => x.url) },
    { n: runIds.length, tone: () => 'run', ids: runIds.map((x) => x.id), urls: runIds.map((x) => x.url) },
    { n: 0, tone: () => 'run' },
    { n: S.mains.red.length, tone: () => 'fail' },
    { n: S.deploy.running.length, tone: () => 'run' },
    { n: S.apps.down.length, tone: () => 'fail' },
  ];
  CENTERS.forEach((uc, i) => {
    const h = 4 + 26 * Math.min(1, Math.log(1 + thru[i]) / Math.log(1 + 300));
    const pad = HL.pad;
    box(cam, g, uc - pad / 2, B - pad / 2, pad, pad, h, 0, P.top, P.side, P.front, P.edge);
    // tests: the plinth splits into passed (green-grey) and failed (red) by share
    if (i === 3 && S.tests.total) {
      const f = S.tests.failed / S.tests.total;
      g.begin_(); quad(cam, g, uc - pad / 2 + 8, B - pad / 2 + 8, uc - pad / 2 + 8 + (pad - 16) * (1 - f), B + pad / 2 - 8, h + 0.3); g.fill('#3E5244');
      g.begin_(); quad(cam, g, uc - pad / 2 + 8 + (pad - 16) * (1 - f), B - pad / 2 + 8, uc + pad / 2 - 8, B + pad / 2 - 8, h + 0.3); g.fill(P.redTop);
    }
    // apps: every app a small tile on top (up: green-grey), the down ones heaped over them
    if (i === 6) {
      const n = S.apps.total, cols = 16, pu = (pad - 12) / cols, rows = Math.ceil(n / cols), pv = (pad - 12) / Math.max(rows, 1);
      g.begin_();
      for (let k = 0; k < n; k++) { const a = k % cols, b = Math.floor(k / cols); quad(cam, g, uc - pad / 2 + 6 + a * pu + 0.6, B - pad / 2 + 6 + b * pv + 0.6, uc - pad / 2 + 6 + (a + 1) * pu - 0.6, B - pad / 2 + 6 + (b + 1) * pv - 0.6, h + 0.3); }
      g.fill('#3E5244');
    }
    const nn = now_[i];
    heap(cam, g, uc, B, h, nn.n, nn.tone, hits, nn.ids, nn.urls);
  });
  hits.push(...drawBin(g, cam, now, o, { u0: 640, u1: 1020, v0: 318, v1: 412 }));
  // drops from tests and deploy into it
  for (const u of [705, 1020]) {
    g.begin_(); poly(cam, g, [u - 9, B + HL.pad / 2 + 2, 0.3, u + 9, B + HL.pad / 2 + 2, 0.3, u + 9, 318, 0.3, u - 9, 318, 0.3]); g.fill('#101011');
  }
  return hits;
}

export function drawHeapHeads(g: Gfx, cam: Cam, S: Stages, now: number, top: number): void {
  const big = [
    [`${S.sources.perHour}`, '/h', C.ink],
    [`${S.intake.waiting}`, 'waiting', S.intake.waiting ? C.amberText : C.ink3],
    [`${S.engines.running}`, `of ${S.engines.slots} busy`, S.engines.running ? C.amberText : C.ink3],
    [`${Math.round(S.tests.passRate * 100)}%`, `pass · ${S.tests.failed} failed/h`, S.tests.passRate >= 0.85 ? C.greenInk : C.amberText],
    [`${S.mains.red.length}`, 'red', S.mains.red.length ? C.redText : C.greenInk],
    [`${S.deploy.running.length}`, `now · ${S.deploy.today} today`, S.deploy.running.length ? C.amberText : C.ink3],
    [`${S.apps.down.length ? S.apps.down.length : S.apps.up}`, S.apps.down.length ? 'down' : 'up', S.apps.down.length ? C.redText : C.greenInk],
  ] as const;
  CENTERS.forEach((uc, i) => {
    const x = cam.x(uc, HL.belt - HL.pad / 2);
    g.text(NAMES[i], x, top + 14, C.ink, 13, true, 'center');
    const [n, word, col] = big[i];
    const wn = g.width(n, 19, true), ww = g.width(` ${word}`, 11.5);
    g.text(n, x - (wn + ww) / 2, top + 38, col, 19, true);
    g.text(` ${word}`, x - (wn + ww) / 2 + wn, top + 38, C.ink3, 11.5);
    const ya = cam.y(uc, HL.belt - HL.pad / 2, 40);
    g.begin_(); g.move(Math.round(x) + 0.5, top + 46); g.line(Math.round(x) + 0.5, Math.max(top + 46, ya)); g.stroke('#26262A', 1);
  });
  void now; void WINDOWS;
}
