// The floor's chrome rows (fab-w0, from factory.ts; fx-glance owns the strip). Along the bottom
// edge, THE TIME STRIP: the replay controls (replay the last hour · 24 h at 60×; "live" is the
// status line's one control, app.contract), then the last 24 h across the whole bar as a
// BUTTERFLY, ten-minute bars: activity (runs finished) gray, up; failures red, down. Yesterday is
// dashed behind it (the persisted hourly ring's same hours a day back; the 7-d typical while the
// ring holds no yesterday). A bright bracket marks the coffee check's window (since you last
// looked) and its bars brighten; a light hour scale; the replay's playhead amber; a tick replays
// from that moment (lens.ts). The fleet's numbers are said once, in the coffee header (glance.ts),
// never here. At the top left, the camera's controls (zoom in, out, fit) and the zoom with its
// level of detail.
//
// Cost: the bars are counted when the census recounts (≤ 1/s, O(pipelines)); a frame strokes a
// handful of paths from typed arrays.

import type { Frame } from '../../app.contract.d.ts';
import type { Gfx } from '../yard/gfx.ts';
import { C, clamp, withAlpha } from '../yard/theme.ts';
import { insights } from '../insights.ts';
import type { Factory } from './factory.ts';
import { glyph } from './labels.ts'; // fab-w1
import { HOUR_MS, SMALL, clockWords } from './prims.ts';
import { baseline } from './agg/baseline.ts';
import { failuresOf } from './trendmarks.ts';

/** Ten-minute bins over 24 h. */
export const BINS = 144;
const BIN_MS = 600_000;
const DAY_MS = 24 * HOUR_MS;
/** The bar's height (px) and the butterfly's halves inside it. */
const BAR_H = 58, UP_H = 17, DOWN_H = 14;
const LIT = '#F2F2F0';
const GRAY = '#4E4E52', GRAY_IN = '#7A7A7E', GRAY_DIM = '#38383B';

export class Strip {
  constructor(readonly f: Factory) {}

  /** Runs finished / failed per ten-minute bin, oldest first, ending at `binsEnd` (server ms); a
   *  bin the world holds no runs for takes its hour's share of the fleet trend's spark (`est`). */
  readonly act = new Float32Array(BINS);
  readonly fail = new Float32Array(BINS);
  readonly est = new Uint8Array(BINS);
  /** Yesterday per hour (24, oldest first; NaN none) for activity and failures, and which it is:
   *  'yesterday' (the ring's), 'usual' (the 7-d typical, flat), '' none. */
  readonly ghostA = new Float32Array(24);
  readonly ghostF = new Float32Array(24);
  ghost: '' | 'yesterday' | 'usual' = '';
  binsEnd = 0;
  private binsAt = -1;
  private binsFactor = 0;

  /** Counts the bars (when the census recounted, or stress mode moved). */
  private bins(): void {
    const f = this.f, c = f.census, w = f.world, tl = f.tl;
    if (c.at === this.binsAt && c.factor === this.binsFactor) return;
    this.binsAt = c.at; this.binsFactor = c.factor;
    const end = tl.liveNow(), start = end - DAY_MS;
    this.binsEnd = end;
    this.act.fill(0); this.fail.fill(0); this.est.fill(0);
    let oldest = Infinity;
    for (const p of w.pipelines.values()) {
      const at = p.finished;
      if (!at) { if (p.created && p.created < oldest) oldest = p.created; continue; }
      if (at < oldest) oldest = at;
      const k = Math.floor((at - start) / BIN_MS);
      if (k < 0 || k >= BINS) continue;
      this.act[k]++;
      if (p.state === 'failure' || p.state === 'error') this.fail[k]++;
    }
    // before the world's first run: the fleet trend's hourly spark, a sixth of an hour per bin,
    // once the server holds a day (a v0.4 server's approximation holds 2 h, zeros before them)
    const tr = insights().trend('fleet');
    const F = c.factor > 1 ? c.factor : 1;
    if (tr && tr.hours_7d >= 24) {
      const pa = tr.pipelines.spark, pf = failuresOf(tr).spark, n = pa.length;
      for (let k = 0; k < BINS; k++) {
        if (start + (k + 1) * BIN_MS > oldest) break;
        const h = n - 1 - Math.floor((BINS - 1 - k) / 6);
        if (h < 0) continue;
        const a = pa[h], fl = pf[h];
        if (a === null || a === undefined) continue;
        this.act[k] = a / 6; this.fail[k] = (fl ?? 0) / 6; this.est[k] = 1;
      }
    }
    if (F > 1) for (let k = 0; k < BINS; k++) { this.act[k] *= F; this.fail[k] *= F; }
    // yesterday: the ring's hours a day back (≥ 12 of them), else the 7-d typical
    const b = baseline(), h0 = Math.floor(end / HOUR_MS) - 47;
    let have = 0;
    for (let i = 0; i < 24; i++) {
      const a = b.get('fleet', 'pipelines', h0 + i), fl = b.get('fleet', 'failures', h0 + i);
      this.ghostA[i] = a === null ? NaN : a * F / 6;
      this.ghostF[i] = fl === null ? NaN : fl * F / 6;
      if (a !== null) have++;
    }
    this.ghost = have >= 12 ? 'yesterday' : '';
    if (!this.ghost && tr) {
      // the server's 7-d typical once it holds a day (a v0.4 server holds none), else the ring's
      const day = tr.hours_7d >= 24;
      const ta = (day ? tr.pipelines.d7 : null) ?? b.d7('fleet', 'pipelines'), tf = (day ? failuresOf(tr).d7 : null) ?? b.d7('fleet', 'failures');
      if (ta !== null) { this.ghostA.fill(ta * F / 6); this.ghostF.fill((tf ?? NaN) * F / 6); this.ghost = 'usual'; }
    }
  }

  draw(g: Gfx, f: Frame, now: number): void {
    const tl = this.f.tl;
    const y0 = f.height - BAR_H, W = f.width;
    g.fillRect(0, y0, W, BAR_H, withAlpha(C.canvas, 0.94));
    g.hline(0, W, g.crisp(y0), '#1F1F21');
    // the replay controls (live is the status line's: one control)
    const mode = tl.mode;
    const opts: [string, string][] = [[mode === 'replay' ? 'replaying the hour' : 'replay last hour', 'replay'], ['24 h at 60×', 'replay24']];
    let x = 16;
    g.fillRect(x, y0 + 13, 4 + opts.reduce((a, [s]) => a + g.width(s, 13) + 22, 0), 28, '#1A1A1C');
    x += 2;
    for (const [s, k] of opts) {
      const on = k === 'replay' && mode === 'replay';
      const wv = g.width(s, 13) + 22;
      if (on) g.fillRect(x, y0 + 15, wv, 24, '#2C2C2E');
      g.text(s, x + 11, y0 + 31.5, on ? C.ink : C.ink2, 13);
      this.f.hit(x, y0 + 13, wv, 28, k, k, s);
      x += wv;
    }
    // the butterfly: the whole rest of the bar
    this.bins();
    const sx = x + 22, sw = Math.max(120, W - 16 - sx);
    const cy = y0 + 9 + UP_H, sy = y0 + 9, sh = UP_H + DOWN_H + 1;
    let ma = 1, mf = 0;
    for (let k = 0; k < BINS; k++) { if (this.act[k] > ma) ma = this.act[k]; if (this.fail[k] > mf) mf = this.fail[k]; }
    for (let i = 0; i < 24; i++) { if (this.ghostA[i] > ma) ma = this.ghostA[i]; if (this.ghostF[i] > mf) mf = this.ghostF[i]; }
    // failures read against their own peak, but never louder than a quarter of the activity's
    mf = Math.max(mf, ma * 0.25, 1);
    const end = this.binsEnd || tl.liveNow();
    const since = this.f.coffee.since, live = mode !== 'replay';
    const kSince = since > 0 && live ? clamp(1 - (end - since) / DAY_MS, 0, 1) : 2;
    const bw = Math.max(1, (sw / BINS) * 0.62), step = sw / BINS;
    // yesterday, dashed behind (an hour per step)
    if (this.ghost) {
      g.dash(true, 3, 3);
      for (let half = 0; half < 2; half++) {
        const arr = half ? this.ghostF : this.ghostA, m = half ? mf : ma, hh = half ? DOWN_H : UP_H, sgn = half ? 1 : -1;
        g.begin_();
        let pen = false;
        for (let i = 0; i < 24; i++) {
          const v = arr[i];
          if (!(v >= 0)) { pen = false; continue; }
          const yy = cy + sgn * (half ? 1 : 0) + sgn * Math.min(hh, (v / m) * hh);
          const xa = sx + (i / 24) * sw, xb = sx + ((i + 1) / 24) * sw;
          if (!pen) g.move(xa, yy); else g.line(xa, yy);
          g.line(xb, yy);
          pen = true;
        }
        g.stroke(half ? withAlpha(C.red, 0.55) : withAlpha(C.ink3, 0.75), 1);
      }
      g.dash(false);
    }
    // the bars: activity up, failures down, a ten-minute bar each where the world holds runs (an
    // hour's bar, dimmer, where only the trend's hourly spark does); inside the window brighter
    const sinceX = sx + kSince * sw;
    const hw = Math.max(1, step * 6 * 0.72);
    for (let pass = 0; pass < 3; pass++) {
      g.begin_();
      let any = false;
      for (let k = 0; k < BINS; k++) {
        const est = this.est[k] === 1;
        if (est && (pass !== 2 || k % 6 !== 0)) continue;
        if (!est && pass === 2) continue;
        const xx = est ? sx + (k + 3) * step : sx + (k + 0.5) * step;
        if (!est && (xx >= sinceX ? 1 : 0) !== pass) continue;
        const h = (this.act[k] / ma) * UP_H;
        if (h < 0.4) continue;
        g.move(xx, cy); g.line(xx, cy - h);
        any = true;
      }
      if (any) g.stroke(pass === 1 ? GRAY_IN : pass === 2 ? GRAY_DIM : GRAY, pass === 2 ? hw : bw);
    }
    for (let pass = 0; pass < 2; pass++) {
      g.begin_();
      let any = false;
      for (let k = 0; k < BINS; k++) {
        const est = this.est[k] === 1;
        if ((est ? 1 : 0) !== pass || (est && k % 6 !== 0)) continue;
        const h = (this.fail[k] / mf) * DOWN_H;
        if (h < 0.4) continue;
        const xx = est ? sx + (k + 3) * step : sx + (k + 0.5) * step;
        g.move(xx, cy + 1); g.line(xx, cy + 1 + h);
        any = true;
      }
      if (any) g.stroke(pass ? withAlpha(C.red, 0.55) : C.red, pass ? hw : bw);
    }
    // no history held before the first bar (a young server, a v0.4 one): said once, quietly
    let first = 0;
    while (first < BINS && this.act[first] <= 0 && !this.est[first]) first++;
    const fx = sx + first * step;
    if (first >= BINS * 0.3 && first < BINS && !this.ghost) {
      g.dash(true, 1, 3); g.hline(sx, fx, g.crisp(cy + 0.5), '#3A3A3E'); g.dash(false);
      g.hline(fx, sx + sw, g.crisp(cy + 0.5), '#2C2C2E');
      g.text(`no history before ${clockWords(end - (BINS - first) * BIN_MS, this.f.offsetMin).slice(0, 5)}`, (sx + fx) / 2, cy - 4, C.ink3, SMALL, false, 'center');
    } else g.hline(sx, sx + sw, g.crisp(cy + 0.5), '#2C2C2E');
    // the hour scale: a tick an hour on the axis, the local clock every 6 h
    const off = this.f.offsetMin * 60_000;
    const firstH = Math.ceil((end - DAY_MS + off) / HOUR_MS) * HOUR_MS - off;
    g.begin_();
    for (let at = firstH; at <= end; at += HOUR_MS) { const xx = g.crisp(sx + (1 - (end - at) / DAY_MS) * sw); g.move(xx, cy - 1.5); g.line(xx, cy + 2.5); }
    g.stroke('#4A4A4E', 1);
    const ly = y0 + BAR_H - 5;
    for (let at = firstH; at <= end; at += HOUR_MS) {
      const hour = Math.round((at + off) / HOUR_MS) % 24;
      if (hour % 6 !== 0) continue;
      const xx = sx + (1 - (end - at) / DAY_MS) * sw;
      if (xx < sx + 18 || xx > sx + sw - 70) continue;
      g.text(`${String(hour).padStart(2, '0')}:00`, xx, ly, C.ink3, SMALL, false, 'center');
    }
    g.text(live ? 'now' : clockWords(now, this.f.offsetMin), sx + sw, ly, live ? C.ink3 : C.amberText, SMALL, false, 'right');
    // since you last looked: a bright bracket over the window, and its bars brighter (above)
    if (kSince <= 1) {
      const bx = sinceX, ex = sx + sw, by = y0 + 4;
      g.fillRect(bx, sy, Math.max(0, ex - bx), sh, withAlpha(LIT, 0.035));
      g.fillRect(bx, by, Math.max(2, ex - bx), 2, withAlpha(LIT, 0.9));
      g.vline(g.crisp(bx), by, by + 7, LIT, 1.5);
      g.vline(g.crisp(ex), by, by + 7, LIT, 1.5);
    }
    // the replay's playhead
    const ph = mode === 'replay' ? 1 - (tl.liveNow() - now) / DAY_MS : 1;
    const px = sx + clamp(ph, 0, 1) * sw;
    if (mode !== 'live') g.vline(g.crisp(px), sy - 3, sy + sh + 3, C.packet, 1.5);
    this.f.lens.strip(g, sx, sy, sw, sh, now); // fab-lens: a tick jumps the replay there
  }

  /** The camera's controls (top left): zoom in, out, fit, and the zoom with its level of detail. */
  controls(g: Gfx, f: Frame): void {
    const x = 16, y = 46;
    const btn = (s: string, k: string, xx: number) => {
      g.fillRect(xx, y, 24, 22, '#1A1A1C');
      g.begin_(); g.rect(xx + 0.5, y + 0.5, 23, 21); g.stroke('#2E2E30', 1);
      glyph(g, s, xx + 12, y + 11, C.ink2); // fab-w1: strokes, not text (the fleet's text budget)
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
