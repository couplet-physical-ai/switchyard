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
import { appHist, appHist7, bars, busySeries, clamp, clusterFacts, groupFlow, groupForApps, groupForOrg, healthSegs, hueHex, spark } from './lenses.ts';
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

  /** Over everything (after the story card and the compare dock): the floor's hover card, taller,
   *  with its kind's micro-chart. Nothing when the floor draws no hover box for this hit. */
  draw(g: Gfx, fr: Frame, dragging: boolean): void {
    const f = this.lens.f;
    if (!f.hoverId || dragging) return;
    const h = f.hitAt(f.px, f.py) as Hit | null;
    if (!h || !h.label || h.kind === 'stage' || h.kind === 'drawer') return;
    const lines = this.lens.preview(h);
    if (!lines || !lines.length) return;
    const key = `${h.kind}|${h.id}|${Math.floor(f.tl.clock / 1000)}`;
    if (key !== this.key) { this.key = key; this.chart = this.build(h); }
    const ch = this.chart;
    if (!ch) return;
    // the floor's box: max(line width) + 16 wide at min(px + 14, W − w − 8), py + 18; this card
    // is at least as wide and tall, from the same corner, so it covers it whole
    const wf = Math.max(...lines.map((l) => g.width(l, SMALL))) + 16;
    const wv = Math.max(wf, ...lines.map((l, i) => g.width(l, SMALL, i === 0) + 16), CW + 16);
    const bx = Math.min(f.px + 14, fr.width - wv - 8), by = f.py + 18;
    const H = lines.length * 16 + 10 + CH + 10;
    g.fillRect(bx, by, wv, H, BG);
    g.begin_(); g.rect(bx + 0.5, by + 0.5, wv - 1, H - 1); g.stroke(EDGE, 1);
    lines.forEach((l, i) => g.text(l, bx + 8, by + 18 + i * 16, i ? C.ink2 : C.ink, SMALL, i === 0));
    paint(g, ch, bx + 8, by + lines.length * 16 + 10, wv - 16, CH, f.tl.playhead);
  }

  /** The chart for a hit (null: the floor's words alone). */
  private build(h: Hit): Chart | null {
    const L = this.lens, f = L.f, w = f.world, c = f.census, now = f.tl.playhead;
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
        const bs = busySeries(L.hosts, gr);
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
        const s = new Array<number>(24).fill(0);
        for (const p of w.prs.values()) if (p.merged_at && p.merged_at > now - 24 * HOUR && p.merged_at <= now) s[23 - Math.min(23, Math.floor((now - p.merged_at) / HOUR))]++;
        return { k: 'bars', s, col: '#9A9AA0' };
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
