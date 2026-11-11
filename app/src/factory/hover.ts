// HOVER PREVIEWS (fab-w3, FACTORY-SPEC §D "hover answers in ≤ 80 ms with ≤ 3 lines plus a
// micro-chart"): the floor's hover box keeps its words (Lenses.preview), and this draws the same
// card a little taller over it, with ONE small chart per kind:
//
//   dock / district (a group)  pushes per hour over 24 h, in the group's hue / apps by health
//   PR stack / bot pallet      what blocks them, one stacked bar
//   machine / gauge            busy share over time (the server's 24 h when the lens asked for it)
//   intake                     each queued run's wait, a bar
//   merge gate                 merges per hour over 24 h
//   tests / return conveyor    runs (gray) and failures (red) per half hour over 24 h
//   parked failure             its cluster's failures on a 24 h axis (first → last seen)
//   deploy track               its deploys on a 24 h axis
//   app                        health over 7 d (the server's history), else its deploys
//   main-line car              the repo's last 12 main runs
//   run (a crate, a bay)       elapsed against expected
//
// Cost: the chart's data is built when the hovered thing changes (or once a second), O(entities);
// a frame only paints it.

import type { Gfx } from '../yard/gfx.ts';
import { C, withAlpha } from '../yard/theme.ts';
import type { Frame } from '../../app.contract.d.ts';
import { HOUR, PHASES, phaseRow } from './census.ts';
import { appHist, appHist7, bars, busySeries, machineEngines, clamp, clusterFacts, groupFlow, groupForApps, groupForOrg, healthSegs, hostedRuns, hueHex, spark } from './lenses.ts';
import { floorGroups } from './groups.ts';
import type { Lenses } from './lens.ts';
import { BLOCKERS, ageBucket, blocker, botName, healthCol, isBot } from './lens.ts';
import { groupOf as insGroupOf } from '../insights.ts';

type Hit = { x: number; y: number; w: number; h: number; kind: string; id: string; label: string };

/** A micro-chart: what it draws and its numbers. */
type Chart =
  | { k: 'spark'; s: (number | null)[]; col: string; max?: number }
  | { k: 'bars'; s: number[]; col: string; red?: number[] }
  | { k: 'stack'; parts: [number, string][] }
  | { k: 'ticks'; items: [number, string][]; span: [number, number] | null }
  | { k: 'dots'; dots: string[] }
  | { k: 'progress'; u: number; over: boolean }
  | { k: 'strip'; segs: [number, number, string][] };

const CW = 172, CH = 18;
const BG = '#161618', EDGE = '#3A3A3E', SMALL = 12;

export class Hover {
  private key = '';
  private chart: Chart | null = null;

  constructor(readonly lens: Lenses) {}

  /** Over everything (after the story card and the compare dock): THE hover card (fx-lens: the
   *  only one; drawer.ts's plain box is gone). One title line, at most three short lines (the
   *  floor's own words first, else the lens's preview, else the drawer's facts), and its kind's
   *  micro-chart. Placed beside its object, never over it, and inside the viewport. */
  draw(g: Gfx, fr: Frame, dragging: boolean): void {
    const f = this.lens.f;
    if (!f.hoverId || dragging) return;
    const h = f.hitAt(f.px, f.py) as Hit | null;
    if (!h || !h.label || h.kind === 'drawer' || h.kind === 'crumb' || h.kind === 'crumbx') return;
    const part = this.lens.part(h);
    const mine = f.words.hoverFor(h); // fab-w1: the stage titles' numbers and the lanes' cells and posts (labels.ts, floor.ts)
    const raw = mine ?? (h.kind === 'stage' ? null : this.lens.preview(h)) ?? f.drawer.facts(h);
    if (!raw || !raw.length) return;
    const key = `${h.kind}|${h.id}|${part}|${h.x | 0}|${Math.floor(f.tl.clock / 1000)}`;
    if (key !== this.key) { this.key = key; this.chart = this.build(h, part); this.lines = this.words(raw, part); }
    const ch = this.chart, lines = this.lines;
    if (!lines.length) return;
    const MAXW = 300;
    const wv = Math.min(MAXW, Math.max(CW, ...lines.map((l, i) => g.width(l, SMALL, i === 0)))) + 16;
    const H = lines.length * 16 + 10 + (ch ? CH + 8 : 0);
    const [bx, by] = place(h, f.px, f.py, wv, H, fr.width, fr.height);
    g.fillRect(bx, by, wv, H, BG);
    g.begin_(); g.rect(bx + 0.5, by + 0.5, wv - 1, H - 1); g.stroke(EDGE, 1);
    lines.forEach((l, i) => g.text(g.fit(l, SMALL, wv - 16, i === 0), bx + 8, by + 18 + i * 16, i ? C.ink2 : C.ink, SMALL, i === 0));
    if (ch) paint(g, ch, bx + 8, by + lines.length * 16 + 8, wv - 16, CH, f.tl.playhead);
  }
  private lines: string[] = [];

  /** fx-lens: the card's words: the title and ≤ 3 lines, the click hint saying what a press opens
   *  now (the floor's hints predate the part lenses). */
  private words(raw: string[], part: string): string[] {
    const hint = HINT[part];
    const out = raw.filter((l, i) => i === 0 || !/^(zoom or )?click:/.test(l)).slice(0, hint ? 3 : 4);
    if (hint) out.push(hint);
    else { const k = raw.findIndex((l, i) => i > 0 && /^(zoom or )?click:/.test(l)); if (k > 0 && out.length < 4) out.push(raw[k]!); }
    return out;
  }

  /** The chart for a hit (null: the floor's words alone). */
  private build(h: Hit, part: string): Chart | null {
    const L = this.lens, f = L.f, w = f.world, c = f.census, now = f.tl.playhead;
    // fx-lens: the lanes' parts (floor.ts registers them as the group's dock / district)
    if (part === 'road' || part === 'stripe' || (part === 'dock' && f.floor.on)) {
      const lid = L.laneOf(h), info = f.floor.data.last.lanes.get(lid);
      if (!info) return null;
      const s = Array.from(info.push24), red = Array.from(info.fail24);
      return { k: 'bars', s: half(s), col: floorGroups().hex(lid), red: half(red) };
    }
    if (part === 'cell') {
      const lid = L.laneOf(h), row = L.rowAt(h), G = floorGroups();
      const counts = new Map<string, number>();
      for (const p of w.prs.values()) {
        if (phaseRow(p) !== row || isBot(p) || G.laneOfRepo(p.repo) !== lid) continue;
        const k = blocker(p);
        counts.set(k, (counts.get(k) ?? 0) + 1);
      }
      return { k: 'stack', parts: BLOCKERS.filter(([k]) => counts.get(k)).map(([k, col]) => [counts.get(k) ?? 0, col] as [number, string]) };
    }
    if (part === 'rail') {
      const lid = L.laneOf(h), G = floorGroups();
      const s = new Array<number>(24).fill(0), red = new Array<number>(24).fill(0);
      for (const r of w.repos.values()) {
        if (G.laneOfRepo(r.id) !== lid) continue;
        for (const d of r.main?.recent ?? []) {
          if (d.at < now - 24 * HOUR || d.at > now) continue;
          const k = 23 - Math.min(23, Math.floor((now - d.at) / HOUR));
          s[k]++; if (d.state === 'failure' || d.state === 'error') red[k]++;
        }
      }
      return { k: 'bars', s, col: '#8A8A8E', red };
    }
    if (part === 'city') {
      const d = c.districts.find((x) => x.team === h.label.replace(/ \d+$/, ''));
      if (!d) return null;
      const n = { up: 0, degraded: 0, down: 0, unknown: 0 } as Record<string, number>;
      for (const id of d.apps) { const a = w.apps.get(id); n[a?.health ?? 'unknown'] = (n[a?.health ?? 'unknown'] ?? 0) + 1; }
      return { k: 'stack', parts: [[n.up, healthCol('up')], [n.degraded, C.packet], [n.down, C.red], [n.unknown, '#4E4E52']] };
    }
    switch (h.kind) {
      case 'dock': case 'rail': {
        const gr = groupForOrg(w, h.id);
        if (!gr) return null;
        const repos = new Set<string>();
        for (const r of w.repos.values()) if (insGroupOf(r.id) === gr.id) repos.add(r.id);
        return { k: 'spark', s: groupFlow(w, gr.id, repos, new Set(), now).pushes24, col: hueHex(gr.id) };
      }
      case 'district': case 'districtArea': {
        const d = c.districts.find((x) => x.team === h.label.replace(/ \d+$/, ''));
        if (!d) return null;
        const n = { up: 0, degraded: 0, down: 0, unknown: 0 } as Record<string, number>;
        for (const id of d.apps) { const a = w.apps.get(id); n[a?.health ?? 'unknown'] = (n[a?.health ?? 'unknown'] ?? 0) + 1; }
        const gr = groupForApps(w, d.apps);
        return { k: 'stack', parts: [[n.up, gr ? hueHex(gr.id) : healthCol('up')], [n.degraded, C.packet], [n.down, C.red], [n.unknown, '#4E4E52']] };
      }
      case 'stack': case 'pallet': {
        const [row, b] = h.kind === 'stack' ? h.id.split(',').map(Number) : [-1, -1];
        const counts = new Map<string, number>();
        for (const p of w.prs.values()) {
          const r = phaseRow(p);
          if (r < 0) continue;
          if (h.kind === 'stack') { if (isBot(p) || r !== row || ageBucket(now - p.created) !== b) continue; }
          else if (!isBot(p) || botName(p.author) !== h.id) continue;
          const k = blocker(p);
          counts.set(k, (counts.get(k) ?? 0) + 1);
        }
        return { k: 'stack', parts: BLOCKERS.filter(([k]) => counts.get(k)).map(([k, col]) => [counts.get(k) ?? 0, col] as [number, string]) };
      }
      case 'machine': case 'gauge': case 'engine': {
        const gi = h.kind === 'engine' ? -1 : Number(h.id);
        const gr = c.groups[gi];
        if (!gr) return null;
        const td = f.plant.hist.tide(gr.id); // fx-lens: the machine wall's own 24 h first
        if (td && td.covered > 0) return { k: 'spark', s: Array.from(td.busy, (v) => (v === v ? v * 100 : null)), col: C.packet, max: 100 };
        const hr = hostedRuns(w, gr, now);
        if (hr) return { k: 'spark', s: hr.busy, col: C.packet, max: 100 };
        const bs = busySeries(L.hosts, gr, machineEngines(w, gr));
        if (bs) return { k: 'spark', s: bs, col: C.packet, max: 100 };
        return { k: 'progress', u: gr.slots ? gr.running.length / gr.slots : 0, over: false };
      }
      case 'intake': {
        const s: number[] = [];
        for (const id of [...c.rr, ...c.gha]) { const p = w.pipelines.get(id); if (p) s.push(Math.max(0, now - p.created)); }
        s.sort((a, b) => b - a);
        return s.length ? { k: 'bars', s: s.slice(0, 16), col: C.packet } : null;
      }
      case 'gate': {
        // fx-lens: what landed on main per hour today (red: it ran red), as the gate's lens tells it
        const s = new Array<number>(24).fill(0), red = new Array<number>(24).fill(0);
        for (const r of w.repos.values()) for (const d of r.main?.recent ?? []) {
          if (d.at < now - 24 * HOUR || d.at > now) continue;
          const k = 23 - Math.min(23, Math.floor((now - d.at) / HOUR));
          s[k]++; if (d.state === 'failure' || d.state === 'error') red[k]++;
        }
        return { k: 'bars', s, col: '#9A9AA0', red };
      }
      case 'scanner': case 'return': {
        const all: number[] = new Array(48).fill(0), red: number[] = new Array(48).fill(0);
        for (let i = 0; i < 288; i++) { all[(i / 6) | 0] += c.dens[i]; red[(i / 6) | 0] += c.densRed[i]; }
        return { k: 'bars', s: all, col: '#3A3A3E', red };
      }
      case 'failure': {
        const cf = clusterFacts(w, h.id);
        if (!cf) return null;
        return { k: 'ticks', items: cf.held.map(([id, , at]) => [at, id === h.id ? C.ink : C.red] as [number, string]), span: [cf.first, cf.last] };
      }
      case 'track': {
        const i = Number(h.id), via = ['roadrunner', 'gha', 'gha_fallback'][i];
        const items: [number, string][] = [];
        for (const d of w.deploys.values()) {
          if ((via === 'gha_fallback' ? d.via !== 'gha_fallback' && d.via !== 'manual' : d.via !== via) || d.started < now - 24 * HOUR) continue;
          items.push([d.started, d.state === 'success' ? '#7FC48F' : d.state === 'failure' ? C.red : C.packet]);
        }
        return { k: 'ticks', items, span: null };
      }
      case 'app': {
        const h7 = appHist7(h.id);
        if (h7) return { k: 'strip', segs: healthSegs(h7.health ?? [], w.apps.get(h.id)?.health ?? 'unknown', now, h7.since) };
        const ah = appHist(h.id);
        return { k: 'ticks', items: (ah?.deploys ?? []).map((d) => [d.at, d.state === 'success' ? '#7FC48F' : d.state === 'failure' ? C.red : C.packet] as [number, string]), span: null };
      }
      case 'stage': { const s = f.words.stageSpark(h.label); return s ? { k: 'spark', s, col: '#9A9AA0' } : null; } // fab-w1: the stage's 24 h
      case 'commit': {
        const at = h.id.indexOf('@');
        const r = w.repos.get(h.id.slice(0, at));
        const dots = (r?.main?.recent ?? []).slice(-12).map((d) => (d.state === 'failure' || d.state === 'error' ? C.red : d.state === 'running' || d.state === 'pending' ? C.packet : '#5A6E5F'));
        return dots.length ? { k: 'dots', dots } : null;
      }
      case 'pipeline': {
        const p = w.pipelines.get(h.id);
        if (!p) return null;
        const exp = p.expected_ms ?? w.repos.get(p.repo)?.p50_build_ms ?? w.stats.p50_build_ms ?? 0;
        const el = p.started ? Math.max(0, (p.finished ?? now) - p.started) : 0;
        if (!exp) return null;
        return { k: 'progress', u: clamp(el / exp, 0, 2), over: el > exp * 1.5 };
      }
      default: return null;
    }
  }
}

/** fx-lens: what a press on each part opens (the card's last line). */
const HINT: Record<string, string> = {
  road: 'click: the group across the floor', dock: 'click: the group across the floor', stripe: 'click: the group across the floor',
  cell: 'click: these PRs, by age and blocker', rail: 'click: its main lines, red first', post: 'click: this repo across the floor',
  row: 'click: this repo across the floor', car: 'click: this commit\'s journey', city: 'click: the district\'s scorecard',
  gate: 'click: what landed today, by lane',
};

/** fx-lens: 48 half-hour slots → 24 hours. */
function half(a: number[]): number[] {
  if (a.length !== 48) return a;
  const o = new Array<number>(24).fill(0);
  for (let i = 0; i < 48; i++) o[i >> 1] += a[i]!;
  return o;
}

/** fx-lens: where the card goes. Beside its object, never over it: below it, else above, else to
 *  its right, else its left (a big object, say a district or a road, wider or taller than a third
 *  of the screen: beside the pointer, flipped to the roomier side); always inside the viewport,
 *  clear of the top bar (40) and of the timeline strip (the bottom 92). */
export function place(h: { x: number; y: number; w: number; h: number }, px: number, py: number, w: number, H: number, W: number, VH: number): [number, number] {
  const top = 40, bot = VH - 92, M = 8;
  const fitsX = (x: number) => Math.min(Math.max(M, x), W - w - M);
  const big = h.w > W / 3 || h.h > VH / 3;
  if (big) {
    const x = px + 16 + w > W - M ? px - 16 - w : px + 16;
    const y = py + 18 + H > bot ? py - 18 - H : py + 18;
    return [fitsX(x), Math.min(Math.max(top, y), bot - H)];
  }
  if (h.y + h.h + 6 + H <= bot) return [fitsX(px - 24), h.y + h.h + 6];
  if (h.y - 6 - H >= top) return [fitsX(px - 24), h.y - 6 - H];
  const y = Math.min(Math.max(top, py - H / 2), bot - H);
  if (h.x + h.w + 8 + w <= W - M) return [h.x + h.w + 8, y];
  return [Math.max(M, h.x - 8 - w), y];
}

/** Paints a chart in a w × h box at (x, y). */
function paint(g: Gfx, ch: Chart, x: number, y: number, w: number, h: number, now: number): void {
  switch (ch.k) {
    case 'spark': spark(g, ch.s, x, y, w, h, ch.col, ch.max ?? 0); return;
    case 'bars': {
      const mx = Math.max(1, ...ch.s);
      bars(g, ch.s, x, y, w, h, ch.col, mx);
      if (ch.red) bars(g, ch.red, x, y, w, h, C.red, mx);
      return;
    }
    case 'stack': {
      const tot = ch.parts.reduce((a, p) => a + p[0], 0) || 1;
      let bx = x;
      for (const [n, col] of ch.parts) { if (!n) continue; const ww = (n / tot) * w; g.fillRect(bx, y + 4, Math.max(1, ww - 1), h - 8, col); bx += ww; }
      return;
    }
    case 'ticks': {
      g.hline(x, x + w, y + h - 3.5, '#2A2A2C', 1);
      const k = (t: number) => 1 - clamp((now - t) / (24 * HOUR), 0, 1);
      if (ch.span) { const a = k(ch.span[0]), b = k(ch.span[1]); g.fillRect(x + a * w, y + h - 7, Math.max(2, (b - a) * w), 3, withAlpha(C.red, 0.3)); }
      for (const [t, col] of ch.items) g.fillRect(x + k(t) * (w - 2), y + 2, 2, h - 5, col);
      return;
    }
    case 'dots': ch.dots.forEach((col, i) => g.fillRect(x + i * 13, y + 4, 10, h - 8, col)); return;
    case 'progress': {
      g.fillRect(x, y + 6, w, h - 12, '#2A2A2C');
      g.fillRect(x, y + 6, Math.min(w, w * Math.min(1, ch.u)), h - 12, ch.over ? C.red : C.packet);
      if (ch.u > 1) g.vline(x + w / Math.max(1, ch.u), y + 2, y + h - 2, C.ink, 1);
      return;
    }
    case 'strip': for (const [a, b, col] of ch.segs) g.fillRect(x + a * w, y + 5, Math.max(1, (b - a) * w), h - 10, col); return;
    default: return;
  }
}

void PHASES;
