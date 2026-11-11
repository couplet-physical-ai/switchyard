// THE COMPARE DOCK (fab-w3, FACTORY-SPEC §D "shift-click adds a dashed second subject, and a
// compare dock (bottom-right, 360×140) shows two small multiples on one scale"). Two lenses side
// by side, A in its hue and B in its, each row one bar per side on ONE scale, and one row of
// sparks on one scale, chosen by what the two are:
//
//   two groups    runs/h · pass · red mains · open PRs, and runs per hour over 24 h (v0.5 Trend);
//                 (w2-glance2, #9) ONE window, said: the rows are the last hour (h1, '–' with none)
//                 or now, the spark the 24 h; the other pairs say their windows in their rows
//   two engines   busy · cpu · mem · queued, and busy over time (the server's 24 h when it answered)
//   two apps      deploys 24 h · latency · behind · up share 7 d, and health over 7 d
//   two clusters  open · this hour · 24 h · repos, and the failures on one 24 h axis: a shared
//                 onset is a shared cause
//   anything else merged · runs · fail rate · red mains (the lit sets' counts)

import type { Gfx } from '../yard/gfx.ts';
import { C, withAlpha } from '../yard/theme.ts';
import { HOUR, phaseRow } from './census.ts';
import { appHist7, busySeries, clamp, healthSegs, machineEngines, spark } from './lenses.ts';
import type { ClusterFacts } from './lenses.ts';
import type { Lens, Lenses } from './lens.ts';
import { HUE_A, HUE_B, glyph, isBot } from './lens.ts';
import type { World } from '../world.ts';
import { insights, trend } from '../insights.ts';

/** What a side of the compare knows (the lens system's lit set and story, reduced). */
export type Side = {
  lens: Lens;
  m: { prs: number; merged24: number; runs: number; failed: number; red: number; up: number; apps: number; building: number; queued: number };
  cf?: ClusterFacts | null;
};

type Row = [string, number, number, (v: number) => string];
type Sparks = { word: string; a: (number | null)[] | null; b: (number | null)[] | null; max: number; kind: 'line' | 'ticks' | 'strip'; ta?: [number, string][]; tb?: [number, string][]; sa?: [number, number, string][]; sb?: [number, number, string][] };

export const DOCK_W = 360, DOCK_H = 140;

/** w2-glance2: a group's open PRs, not the bots' (the count its dock and its card say), cached
 *  per world version. */
const prsBy = { ver: -1, w: null as World | null, n: new Map<string, number>() };
function humanPrs(w: World, group: string): number {
  if (prsBy.w !== w || prsBy.ver !== w.ver) {
    prsBy.w = w; prsBy.ver = w.ver; prsBy.n.clear();
    const ins = insights();
    for (const p of w.prs.values()) {
      if (phaseRow(p) < 0 || isBot(p)) continue;
      const g = ins.groupOf(p.repo);
      prsBy.n.set(g, (prsBy.n.get(g) ?? 0) + 1);
    }
  }
  return prsBy.n.get(group) ?? 0;
}

/** Draws the dock with its bottom-right corner at (right, bottom); registers its close hit. */
export function drawCompare(L: Lenses, g: Gfx, A: Side, B: Side, right: number, bottom: number): void {
  const f = L.f, w = f.world, c = f.census, now = f.tl.playhead;
  const x = right - DOCK_W, y = bottom - DOCK_H, P = 10, LW = 74;
  const colW = (DOCK_W - P * 2 - LW) / 2, ax = x + P + LW, bx = ax + colW;
  const ka = A.lens.kind, kb = B.lens.kind;
  let rows: Row[] = [];
  let sp: Sparks | null = null;
  const pct = (v: number) => (Number.isFinite(v) ? `${Math.round(v * 100)}%` : '–'), num = (v: number) => (Number.isFinite(v) ? String(Math.round(v)) : '–'), per = (v: number) => (Number.isFinite(v) ? `${v < 10 ? v.toFixed(1) : Math.round(v)}/h` : '–');
  if (ka === 'group' && kb === 'group') {
    const ta = trend(A.lens.id), tb = trend(B.lens.id), ga = insights().group(A.lens.id), gb = insights().group(B.lens.id);
    const h1 = (v: number | null | undefined) => (v === null || v === undefined ? NaN : v);
    rows = [
      ['runs 1h', h1(ta?.pipelines.h1), h1(tb?.pipelines.h1), per],
      ['pass 1h', h1(ta?.pass_rate.h1), h1(tb?.pass_rate.h1), pct],
      ['red now', ga?.red ?? A.m.red, gb?.red ?? B.m.red, num],
      ['PRs now', humanPrs(w, A.lens.id), humanPrs(w, B.lens.id), num], // the dock's and the card's count (bots' PRs ride their pallets)
    ];
    const s1 = ta?.pipelines.spark ?? null, s2 = tb?.pipelines.spark ?? null;
    sp = { word: 'runs 24 h', a: s1, b: s2, max: Math.max(1, ...[...(s1 ?? []), ...(s2 ?? [])].map((v) => v ?? 0)), kind: 'line' };
  } else if (ka === 'vm' && kb === 'vm') {
    const ga = c.groups[Number(A.lens.id)], gb = c.groups[Number(B.lens.id)];
    const q = (gr: typeof ga) => (gr?.hosted ? c.gha.length : c.rr.length);
    rows = [
      ['busy', ga?.slots ? ga.running.length / ga.slots : 0, gb?.slots ? gb.running.length / gb.slots : 0, pct],
      ['cpu', Math.max(0, pc(ga?.cpu ?? -1)) / 100, Math.max(0, pc(gb?.cpu ?? -1)) / 100, pct],
      ['mem', Math.max(0, pc(ga?.mem ?? -1)) / 100, Math.max(0, pc(gb?.mem ?? -1)) / 100, pct],
      ['queued', q(ga), q(gb), num],
    ];
    sp = { word: 'busy', a: busySeries(L.hosts, ga, machineEngines(w, ga)), b: busySeries(L.hosts, gb, machineEngines(w, gb)), max: 100, kind: 'line' };
  } else if (ka === 'app' && kb === 'app') {
    const a1 = w.apps.get(A.lens.id), a2 = w.apps.get(B.lens.id);
    const h1 = appHist7(A.lens.id), h2 = appHist7(B.lens.id);
    const upShare = (h: typeof h1) => { const m = h?.health_ms; const up = m?.up ?? 0, t = up + (m?.degraded ?? 0) + (m?.down ?? 0) + (m?.unknown ?? 0); return t ? up / t : NaN; };
    rows = [
      ['deploys 24h', c.deploys24.get(A.lens.id) ?? 0, c.deploys24.get(B.lens.id) ?? 0, num],
      ['latency', a1?.latency_ms ?? 0, a2?.latency_ms ?? 0, (v) => `${Math.round(v)} ms`],
      ['behind', a1?.behind ?? 0, a2?.behind ?? 0, num],
      ['up 7 d', upShare(h1), upShare(h2), (v) => (Number.isFinite(v) ? pct(v) : '–')],
    ];
    sp = { word: 'health 7 d', a: null, b: null, max: 1, kind: 'strip', sa: healthSegs(h1?.health ?? [], a1?.health ?? 'unknown', now, h1?.since ?? now), sb: healthSegs(h2?.health ?? [], a2?.health ?? 'unknown', now, h2?.since ?? now) };
  } else if (ka === 'failure' && kb === 'failure' && A.cf && B.cf) {
    const a = A.cf, b = B.cf;
    rows = [['open', a.open, b.open, num], ['this hour', a.count1h, b.count1h, num], ['24 h', a.count, b.count, num], ['repos', a.repoCount, b.repoCount, num]];
    sp = { word: 'when', a: null, b: null, max: 1, kind: 'ticks', ta: a.held.map(([, , at]) => [at, HUE_A]), tb: b.held.map(([, , at]) => [at, HUE_B]) };
  } else {
    const rate = (m: Side['m']) => (m.runs ? m.failed / m.runs : 0);
    rows = [['merged 24h', A.m.merged24, B.m.merged24, num], ['runs 24h', A.m.runs, B.m.runs, num], ['fail 24h', rate(A.m), rate(B.m), pct], ['red now', A.m.red, B.m.red, num], ['in CI now', A.m.building + A.m.queued, B.m.building + B.m.queued, num]];
  }
  const H = DOCK_H;
  g.fillRect(x, y, DOCK_W, H, withAlpha('#111112', 0.96));
  g.begin_(); g.rect(x + 0.5, y + 0.5, DOCK_W - 1, H - 1); g.stroke('#2E2E30', 1);
  // the two subjects, in their hues (B dashed: the second subject)
  glyph(g, ka, ax + 5, y + 14, HUE_A); g.text(g.fit(A.lens.name, 12, colW - 18, true), ax + 14, y + 18, HUE_A, 12, true);
  glyph(g, kb, bx + 5, y + 14, HUE_B); g.text(g.fit(B.lens.name, 12, colW - 22, true), bx + 14, y + 18, HUE_B, 12, true);
  g.dash(true, 3, 2); g.hline(bx, bx + colW - 8, y + 23.5, HUE_B, 1); g.dash(false);
  g.hline(ax, ax + colW - 8, y + 23.5, HUE_A, 1);
  g.text('vs', x + P, y + 18, C.ink3, 12);
  // close
  g.text('×', x + DOCK_W - 12, y + 16, C.ink3, 13, false, 'center');
  f.fx.hit(x + DOCK_W - 22, y + 2, 20, 20, 'cmpx', 'cmp', 'stop comparing');
  const nRows = Math.min(rows.length, sp ? 4 : 5), rh = 17;
  for (let i = 0; i < nRows; i++) {
    const [k, va, vb, fmt] = rows[i], yy = y + 32 + i * rh;
    g.text(k, x + P, yy + 10, C.ink3, 12);
    const mx = Math.max(Number.isFinite(va) ? va : 0, Number.isFinite(vb) ? vb : 0) || 1, bw = colW - 52;
    if (Number.isFinite(va)) g.fillRect(ax, yy + 2, Math.max(1, (va / mx) * bw), 8, withAlpha(HUE_A, 0.85));
    g.text(fmt(va), ax + bw + 4, yy + 10, C.ink2, 12);
    if (Number.isFinite(vb)) g.fillRect(bx, yy + 2, Math.max(1, (vb / mx) * bw), 8, withAlpha(HUE_B, 0.85));
    g.text(fmt(vb), bx + bw + 4, yy + 10, C.ink2, 12);
  }
  if (!sp) return;
  const sy = y + 32 + nRows * rh + 4, sh = H - (sy - y) - 10, sw = colW - 12;
  g.text(sp.word, x + P, sy + sh / 2 + 4, C.ink3, 12);
  if (sp.kind === 'line') {
    if (sp.a) spark(g, sp.a, ax, sy, sw, sh, HUE_A, sp.max); else g.text('–', ax, sy + sh / 2 + 4, C.ink3, 12);
    if (sp.b) spark(g, sp.b, bx, sy, sw, sh, HUE_B, sp.max); else g.text('–', bx, sy + sh / 2 + 4, C.ink3, 12);
  } else if (sp.kind === 'ticks') {
    // one 24 h axis across both columns: a shared onset lines up
    const tx = ax, tw = colW * 2 - 12, k = (t: number) => 1 - clamp((now - t) / (24 * HOUR), 0, 1);
    g.hline(tx, tx + tw, sy + sh / 2 + 0.5, '#2A2A2C', 1);
    for (const [t, col] of sp.ta ?? []) g.fillRect(tx + k(t) * (tw - 2), sy, 2, sh / 2, col);
    for (const [t, col] of sp.tb ?? []) g.fillRect(tx + k(t) * (tw - 2), sy + sh / 2 + 1, 2, sh / 2, col);
  } else {
    for (const [a, b, col] of sp.sa ?? []) g.fillRect(ax + a * sw, sy + 4, Math.max(1, (b - a) * sw), sh - 8, col);
    for (const [a, b, col] of sp.sb ?? []) g.fillRect(bx + a * sw, sy + 4, Math.max(1, (b - a) * sw), sh - 8, col);
  }
}

function pc(v: number): number { return v < 0 ? -1 : v <= 1 ? v * 100 : v; }

