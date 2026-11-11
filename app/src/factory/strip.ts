// The floor's chrome rows (fab-w0, from factory.ts). Along the bottom edge, the time strip and
// the fleet sentence: the span control (live · replay the last hour · 24 h at 60×), the last
// 24 h as event density per 10 minutes (failures red, the playhead amber; a tick replays from
// that moment, lens.ts), and one sentence about the fleet, failure first. At the top left, the
// camera's controls (zoom in, out, fit) and the zoom with its level of detail.

import type { Frame } from '../../app.contract.d.ts';
import type { Gfx } from '../yard/gfx.ts';
import { C, clamp, withAlpha } from '../yard/theme.ts';
import type { Factory } from './factory.ts';
import { HOUR_MS, SMALL, clockWords } from './prims.ts';

export class Strip {
  constructor(readonly f: Factory) {}

  draw(g: Gfx, f: Frame, now: number): void {
    const c = this.f.census, w = this.f.world, tl = this.f.tl;
    const y0 = f.height - 58, H = 58, W = f.width;
    g.fillRect(0, y0, W, H, withAlpha(C.canvas, 0.94));
    g.hline(0, W, g.crisp(y0), '#1F1F21');
    // the span control: live · last hour · 24 h
    const mode = tl.mode;
    const opts: [string, string][] = [['live', 'live'], [mode === 'replay' ? 'replaying the hour' : 'replay last hour', 'replay'], ['24 h at 60×', 'replay24']];
    let x = 16;
    g.fillRect(x, y0 + 13, 4 + opts.reduce((a, [s]) => a + g.width(s, 13) + 22, 0), 28, '#1A1A1C');
    x += 2;
    for (const [s, k] of opts) {
      const on = (k === 'live' && mode === 'live') || (k === 'replay' && mode === 'replay');
      const wv = g.width(s, 13) + 22;
      if (on) g.fillRect(x, y0 + 15, wv, 24, '#2C2C2E');
      if (k === 'live') { g.begin_(); g.circle(x + 10, y0 + 27, 3); g.fill(mode === 'live' ? C.green : C.ink4); }
      g.text(s, x + (k === 'live' ? 17 : 11), y0 + 31.5, on ? C.ink : C.ink2, 13);
      this.f.hit(x, y0 + 13, wv, 28, k, k, s);
      x += wv;
    }
    // the last 24 h: event density per 5 min, failures red, the playhead amber
    const sx = x + 20, sw = Math.min(460, W * 0.3), sh = 22, sy = y0 + 13;
    let mx = 1;
    for (let i = 0; i < 288; i += 2) mx = Math.max(mx, (c.dens[i] + c.dens[i + 1]) / 2);
    // ten-minute bars, each one stroke (a bar is 2 calls; a rect is 6 on the native recorder)
    const bw = Math.max(0.8, (sw / 144) * 0.75);
    for (let pass = 0; pass < 2; pass++) {
      const d = pass ? c.densRed : c.dens;
      g.begin_();
      for (let i = 0; i < 288; i += 2) {
        const h = ((d[i] + d[i + 1]) / (mx * 2)) * sh;
        if (h <= 0.3) continue;
        const x = sx + ((i + 1) / 288) * sw;
        g.move(x, sy + sh); g.line(x, sy + sh - h);
      }
      g.stroke(pass ? C.red : '#3A3A3E', bw);
    }
    g.hline(sx, sx + sw, g.crisp(sy + sh + 0.5), '#2A2A2C');
    const ph = mode === 'replay' ? 1 - (tl.liveNow() - now) / (24 * HOUR_MS) : 1;
    const px = sx + clamp(ph, 0, 1) * sw;
    g.vline(g.crisp(px), sy - 3, sy + sh + 3, C.packet, 1.5);
    this.f.lens.strip(g, sx, sy, sw, sh, now); // fab-lens: a tick jumps the replay there
    g.text('24 h ago', sx, sy + sh + 15, C.ink3, 12);
    g.text(mode === 'live' ? 'now' : clockWords(now, this.f.offsetMin), sx + sw, sy + sh + 15, mode === 'live' ? C.ink3 : C.amberText, 12, false, 'right');
    // the fleet sentence: failure first
    const red = c.redLines;
    let up = 0, down = 0;
    for (const a of w.apps.values()) { if (a.health === 'up') up++; else if (a.health === 'down') down++; }
    const bx = sx + sw + 26;
    const head: [string, string, boolean?][] = red ? [[`${red} main ${red === 1 ? 'line' : 'lines'} red`, C.redText, true]] : [['every main line green', C.green, true]];
    if (down) head.push([` · ${down} ${down === 1 ? 'app' : 'apps'} down`, C.redText, true]);
    const slots = c.groups.reduce((a, gr) => a + (gr.hosted ? 0 : gr.slots), 0);
    const busy = c.groups.reduce((a, gr) => a + (gr.hosted ? 0 : gr.running.length), 0);
    // one count per thing, the same words the floor and the status line use
    const tail: string[] = [`${c.building} building (${busy} of ${slots} bays)`, `${c.waiting} queued`, `${c.deploying.length} deploying`, `${c.flow.finished} builds/h`, `${c.flow.failed} failed/h`, `${up} of ${w.apps.size} apps up`];
    if (c.bottleneck) tail.push(`bottleneck: ${({ prs: 'pr yard', intake: 'intake', engines: 'the engines', deploy: 'deploy' } as Record<string, string>)[c.bottleneck]}`);
    // whole fields only: drop from the end instead of cutting one
    let room = W - bx - 16 - head.reduce((a, [s, , b]) => a + g.width(s, 13, !!b), 0);
    let line = '';
    for (const t of tail) { const add = `  ·  ${t}`; if (g.width(line + add, 13) > room) break; line += add; }
    g.runs([...head.map(([s, col]) => [s, col, true] as [string, string, boolean]), [line, C.ink2]], bx, y0 + 26, 13);
    void room;
    const parts = [`${w.repos.size} repos`, `${c.docks.length - 1} orgs`, `${this.f.census.phaseN.reduce((a, b) => a + b, 0) + c.botN} PRs open`];
    if (c.redNames.length) parts.push(`newest red: ${c.redNames.join(', ')}`);
    let l2 = '';
    for (const t of parts) { const add = l2 ? ` · ${t}` : t; if (g.width(l2 + add, 12) > W - bx - 16) break; l2 += add; }
    g.text(l2, bx, y0 + 44, C.ink3, 12);
  }

  /** The camera's controls (top left): zoom in, out, fit, and the zoom with its level of detail. */
  controls(g: Gfx, f: Frame): void {
    const x = 16, y = 46;
    const btn = (s: string, k: string, xx: number) => {
      g.fillRect(xx, y, 24, 22, '#1A1A1C');
      g.begin_(); g.rect(xx + 0.5, y + 0.5, 23, 21); g.stroke('#2E2E30', 1);
      g.text(s, xx + 12, y + 15, C.ink2, 12, false, 'center');
      this.f.hit(xx, y, 24, 22, k, k, s);
    };
    btn('+', 'zoomin', x); btn('−', 'zoomout', x + 26); btn('⌂', 'fit', x + 52);
    const lod = this.f.cam.zoom >= 2.6 ? 'apps' : this.f.cam.zoom >= 1.6 ? 'org districts' : 'fleet';
    // the zoom and its level of detail (how to pan and zoom needs no permanent words)
    const words: [string, string][] = [[`${Math.round(this.f.cam.zoom * 100)}%  ${lod}`, C.ink2]];
    if (this.f.lens.legacyKey) words.push(['  drag to pan · wheel to zoom · click a crate', C.ink3]); // fab-lens: the coffee glance takes the hint's place
    const wv = words.reduce((a, [s]) => a + g.width(s, SMALL), 0);
    g.fillRect(x + 80, y, wv + 12, 22, withAlpha(C.canvas, 0.86));
    g.runs(words, x + 86, y + 15, SMALL);
    void f;
  }
}
