// THE GLANCE (fab-w4; FACTORY-SPEC §E "the first 10 s"): the floor's top row after the zoom
// readout, the replay's playhead on the time strip, and the settled hotspot callouts.
//
//   dial      a 270° gauge in four sectors (flowing · slowed · jammed · broken); the needle
//             swings to the verdict in the intro's 0.3–1.5 s, its place inside the sector is the
//             severity (anomaly.ts `sev`); the broken sector breathes on the beat
//   counters  a glyph and a number per thing that changed in the window, counting up with the
//             needle: ▲ newly red · ▼ fixed · ✕ failed runs · ■ apps down (□ recovered) ·
//             ● deploys · ⑂ merged · ☁ new clusters. Each is a lens (it lights what it counts);
//             hover names it. They drop from the end rather than run into the key
//   since     the window chip: "since 3h ago ▾"; a press opens the menu (since you last looked ·
//             last hour · last 24 h · last 7 d), a row picks it
//   strip     the window's bracket (lens.ts draws it from coffee.since) gets the replay's
//             playhead sweeping it, and a ‹ when the window reaches past the strip's 24 h
//   callouts  ≤ 3 once the replay settles, where it is broken: the worst cluster over the
//             scanner, the worst group at its dock or district, the jam at the intake; each a lens
//
// Strings are built when the digest, the window or the camera change, never per frame.

import type { Frame } from '../../app.contract.d.ts';
import type { Gfx, Tok } from '../yard/gfx.ts';
import { C, clamp } from '../yard/theme.ts';
import { insights } from '../insights.ts';
import { DAY, VERDICTS, WINS, ago, type Verdict, type Win } from './anomaly.ts';
import type { Coffee } from './coffee.ts';
import { K_CARD, K_INK, K_RED, pulse, tint } from './fx.ts';
import { breathe } from './motion.ts';

const SMALL = 12;
const OK = '#7FC48F';
const CHIP = '#161618';
const CHIP_EDGE = '#2E2E30';
const CARD = '#111112';
const COL: Record<Verdict, string> = { flowing: OK, slowed: C.amberText, jammed: C.packet, broken: C.red };
const A0 = 0.75 * Math.PI, SWEEP = 1.5 * Math.PI;
const STEPS = 12;
/** The intro's beats (ms after the floor opened): the dial swings, the window replays, it settles. */
export const T_DIAL = 300, T_SWEEP = 1500, T_SETTLE = 7000, T_DONE = 7600;

type Glyph = 'up' | 'down' | 'x' | 'app' | 'appOk' | 'dot' | 'merge' | 'smoke';
type Counter = { key: string; glyph: Glyph; n: number; steps: string[]; col: string; gcol: string; label: string; w: number };
/** A hotspot callout: its words' box (x, baseline y, width), its anchor, its lens, and the edge it
 *  is pinned to when the anchor is off the floor ('' when the leader reaches the anchor). */
type Callout = { x: number; y: number; ax: number; ay: number; w: number; parts: Tok[]; kind: string; id: string; label: string; pin: Pin };
type Pin = '' | 'l' | 'r' | 't' | 'b';
/** The floor's visible area (screen px): under the top row, over the time strip, left of a drawer. */
type Vis = { l: number; t: number; r: number; b: number };
/** A callout box's margin to the floor's visible edges (px). */
const EDGE = 12;

export class Glance {
  private key = [-1, -1, -1, -1];
  private keyWin: Win | '' = '';
  private counters: Counter[] = [];
  private word = '';
  private wordReplay = '';
  private why = '';
  private sinceW = '';
  private rows: { win: Win; label: string; hint: string }[] = [];
  private rowW = 0;
  private callouts: Callout[] = [];
  private calloutKey = [-1, -1, -1];
  private sevFrom = 0;
  private loggedX = -1;

  constructor(readonly c: Coffee) {}

  /** Re-reads the digest into words and widths (when it, the window or the clock's minute moved). */
  private prepare(g: Gfx): void {
    const c = this.c, d = c.dg, fr = d.fresh, k = this.key;
    const minute = Math.floor(c.f.tl.liveNow() / 60_000);
    if (k[0] === c.dgN && this.keyWin === c.win && k[1] === minute && k[2] === (c.noVisit ? 1 : 0)) return;
    k[0] = c.dgN; k[1] = minute; k[2] = c.noVisit ? 1 : 0; this.keyWin = c.win;
    this.word = d.marks.verdict;
    this.wordReplay = `${d.marks.verdict} · replay`;
    this.why = d.marks.why || d.marks.verdict;
    const nf = Math.max(fr.failed.length, fr.failCount), nm = Math.max(fr.merged.length, fr.mergedCount);
    const ww = c.windowWords();
    const list: [string, Glyph, number, string, string, string][] = [
      ['red', 'up', fr.newRed.length, C.redText, C.red, `main lines turned red · ${ww}`],
      ['fixed', 'down', fr.fixed.length, C.greenInk, OK, `main lines fixed · ${ww}`],
      ['failed', 'x', nf, C.redText, C.red, `runs failed · ${ww}`],
      ['down', fr.down.length ? 'app' : 'appOk', fr.down.length || fr.recovered.length, fr.down.length ? C.redText : C.greenInk, fr.down.length ? C.red : OK, fr.down.length ? `apps went down · ${ww}` : `apps recovered · ${ww}`],
      ['clusters', 'smoke', fr.newClusters.length, C.ink2, '#A6A6AC', `new failure clusters · ${ww}`],
      ['deploys', 'dot', fr.deploys, C.ink2, C.ink3, `deploys · ${ww}`],
      ['merged', 'merge', nm, C.ink2, C.ink3, `PRs merged · ${ww}`],
    ];
    this.counters = [];
    for (const [key, glyph, n, col, gcol, label] of list) {
      if (n <= 0) continue;
      const steps: string[] = [];
      for (let i = 1; i <= STEPS; i++) steps.push(String(Math.round((n * i) / STEPS)));
      this.counters.push({ key, glyph, n, steps, col, gcol, label: `${n} ${label}`, w: 7 + 10 + 5 + g.width(steps[STEPS - 1], SMALL, true) + 8 });
    }
    this.sinceW = c.windowWords();
    const h7 = insights().trend('fleet')?.hours_7d ?? 168;
    this.rows = WINS.map((w) => ({
      win: w,
      label: w === 'visit' ? 'since you last looked' : w === '1h' ? 'last hour' : w === '24h' ? 'last 24 h' : 'last 7 d',
      hint: w === 'visit' ? (c.noVisit ? 'none kept yet' : `${ago(c.f.tl.liveNow() - c.visitAt)} ago`) : w === '7d' && h7 < 168 ? `${h7} h held` : '',
    }));
    this.rowW = Math.max(...this.rows.map((r) => g.width(r.label, SMALL) + (r.hint ? g.width(r.hint, SMALL) + 18 : 0))) + 34;
  }

  draw(g: Gfx, fr: Frame, t: number, x0: number, right: number): void {
    void fr;
    const c = this.c, f = c.f, d = c.dg;
    this.prepare(g);
    const replay = f.tl.mode === 'replay';
    const it = c.introT(t);
    const y = 46;
    const v = d.marks.verdict, col = COL[v];
    // the needle: at rest until 0.3 s, swings to the verdict by 1.5 s (a small overshoot)
    const e = c.openAt < 0 ? 0 : clamp((it - T_DIAL) / (T_SWEEP - T_DIAL), 0, 1);
    const sev = this.sevFrom + (d.marks.sev - this.sevFrom) * easeOutBack(e);
    if (e >= 1) this.sevFrom = d.marks.sev;
    this.dial(g, x0 + 12, y + 11, sev, c.openAt < 0 ? -1 : VERDICTS.indexOf(v), t, e);
    let x = x0 + 28;
    const word = replay ? this.wordReplay : this.word;
    if (c.openAt >= 0) x += g.text(word, x, y + 16.5, e > 0.5 ? col : C.ink3, 15, true) + 12;
    else x += g.text('looking…', x, y + 16.5, C.ink3, 15, true) + 12;
    f.fx.hit(x0 - 4, y, x - x0, 22, 'verdict', v, this.why);
    if (replay || c.openAt < 0) return;
    // the counters (count up with the needle), then the window chip
    const step = Math.max(1, Math.ceil(e * STEPS));
    const sinceW = g.width(this.sinceW, SMALL) + 26;
    let room = right - x - sinceW - 8;
    for (const ch of this.counters) {
      if (ch.w + 5 > room) break;
      room -= ch.w + 5;
      g.fillRect(x, y + 1, ch.w, 20, CHIP);
      g.begin_(); g.rect(x + 0.5, y + 1.5, ch.w - 1, 19); g.stroke(CHIP_EDGE, 1);
      glyph(g, ch.glyph, x + 12, y + 11, ch.gcol);
      g.text(ch.steps[step - 1], x + 22, y + 15, ch.col, SMALL, true);
      f.fx.hit(x, y + 1, ch.w, 20, 'fresh', ch.key, ch.label);
      x += ch.w + 5;
    }
    // the window: a chip with a caret; incomplete (the server holds less than asked) is dashed
    const cx = x + 3;
    g.fillRect(cx, y + 1, sinceW, 20, c.menu ? '#232325' : '#141415');
    g.begin_(); g.rect(cx + 0.5, y + 1.5, sinceW - 1, 19);
    if (!d.complete) g.dash(true, 2, 2);
    g.stroke(c.menu ? '#5A5A5E' : '#3A3A3E', 1);
    if (!d.complete) g.dash(false);
    g.text(this.sinceW, cx + 8, y + 15, c.menu ? C.ink : C.ink2, SMALL);
    const tx = cx + sinceW - 12;
    g.begin_(); g.move(tx - 3.5, y + 9); g.line(tx + 3.5, y + 9); g.line(tx, y + 13.5); g.ctx.closePath(); g.fill(C.ink3);
    f.fx.hit(cx, y + 1, sinceW, 20, 'since', 'menu', 'pick the window');
    // for drivers (tools/glance-shots.mjs): where the chip is, once per place
    if (cx !== this.loggedX) { this.loggedX = cx; console.log(`coffee: since chip at ${Math.round(cx + sinceW / 2)},${y + 11} rows ${y + 26 + 4 + 11} step 22`); }
    this.strip(g, it);
    if (!f.lens.topLens && f.tl.mode !== 'replay' && it >= T_SETTLE) this.calloutsDraw(g, clamp((it - T_SETTLE) / (T_DONE - T_SETTLE), 0, 1));
    if (c.menu) this.menuDraw(g, cx, y + 26);
  }

  /** The dial: four sectors, the live one lit, the needle at `sev` (0..1 over the 270°). */
  private dial(g: Gfx, x: number, y: number, sev: number, vi: number, t: number, e: number): void {
    const r = 10, seg = SWEEP / 4, gap = 0.08;
    for (let i = 0; i < 4; i++) {
      const on = i === vi && e > 0.5;
      const a = on ? (i === 3 ? 0.65 + 0.35 * pulse(t) : 1) : 0.28;
      g.begin_(); g.arc(x, y, r, A0 + i * seg + gap, A0 + (i + 1) * seg - gap);
      g.stroke(withA(COL[VERDICTS[i]], a), on ? 3 : 2.2);
    }
    const ang = A0 + clamp(sev, 0, 1.04) * SWEEP;
    const nc = vi >= 0 && e > 0.5 ? COL[VERDICTS[vi]] : C.ink3;
    g.begin_(); g.move(x - Math.cos(ang) * 2, y - Math.sin(ang) * 2); g.line(x + Math.cos(ang) * (r - 2), y + Math.sin(ang) * (r - 2));
    g.stroke(nc, 1.6);
    g.begin_(); g.circle(x, y, 2); g.fill(nc);
  }

  /** The replay's playhead on the strip's window bracket, and a ‹ when the window is longer than
   *  the strip's 24 h. */
  private strip(g: Gfx, it: number): void {
    const c = this.c, f = c.f, d = c.dg, hits = f.fx.hits;
    let tk: { x: number; y: number; w: number; h: number } | null = null;
    for (let i = hits.length - 1; i >= 0; i--) if (hits[i].kind === 'tick') { tk = hits[i]; break; }
    if (!tk) return;
    const sx = tk.x, sy = tk.y + 4, sw = tk.w, sh = tk.h - 8;
    const k = clamp(1 - (d.now - d.since) / DAY, 0, 1), bx = sx + k * sw, ex = sx + sw;
    if (d.now - d.since > DAY * 1.02) {
      g.begin_(); g.move(sx - 3, sy - 6); g.line(sx - 8, sy - 3); g.line(sx - 3, sy); g.stroke(C.ink, 1.4);
    }
    if (it < T_SWEEP || it >= T_SETTLE) return;
    const p = clamp((it - T_SWEEP) / (T_SETTLE - 300 - T_SWEEP), 0, 1), px = bx + (ex - bx) * p;
    g.fillRect(bx, sy, Math.max(0, px - bx), sh, tint(K_INK, 0.06));
    g.vline(g.crisp(px), sy - 7, sy + sh + 3, C.ink, 1.5);
    g.begin_(); g.circle(px, sy - 7, 2.5); g.fill(C.ink);
  }

  private calloutsDraw(g: Gfx, a: number): void {
    const c = this.c, f = c.f, cam = f.cam, k = this.calloutKey;
    if (k[0] !== c.dgN || k[1] !== cam.ver || k[2] !== f.census.at) {
      k[0] = c.dgN; k[1] = cam.ver; k[2] = f.census.at;
      this.callouts = [];
      c.dg.marks.hot.forEach((h, i) => {
        const ax = c.hotXY[i * 2], ay = c.hotXY[i * 2 + 1];
        if (!(ax >= 0)) return;
        const parts: Tok[] = [[h.lead, h.red ? C.redText : h.kind === 'jam' ? C.amberText : C.ink, true], [h.rest, C.ink2]];
        const w = g.width(h.lead, SMALL, true) + g.width(h.rest, SMALL);
        const vis = this.floorBox(), pin = calloutPin(ax, ay, vis);
        const at = calloutAt(ax, ay, w, vis, (x, y) => !!f.fx.placeAt(x, y, w, 14, 0, false));
        if (!at) return;
        // each callout is a lens: the cluster's (a failing run of it the world holds, else the
        // tests), the group's dock or district, the intake
        let kind = 'scanner', id = 'tests', label = 'tests';
        if (h.kind === 'cluster') {
          const ex = insights().cluster(h.id)?.examples.find((pid) => f.world.pipelines.has(pid));
          if (ex) { kind = 'failure'; id = ex; label = h.lead; }
        } else if (h.kind === 'jam') { kind = 'intake'; id = 'intake'; label = 'intake'; }
        else if (h.kind === 'group') {
          if (h.id.startsWith('org:')) { kind = 'dock'; id = h.id.slice(4); label = h.lead; }
          else { const di = f.fx.districtBox.findIndex((b) => b.team.toLowerCase().replace(/\s+/g, '-') === h.id.slice(5)); kind = 'district'; id = String(di); label = f.fx.districtBox[di]?.team ?? h.lead; }
        }
        this.callouts.push({ x: at[0], y: at[1], ax, ay, w, parts, kind, id, label, pin });
      });
    }
    if (!this.callouts.length) return;
    g.alpha(a);
    // the leaders: from the true anchor, bent (a 45° knee) to the nearest point of the box
    g.begin_();
    for (const o of this.callouts) {
      if (o.pin) continue;
      const px = clamp(o.ax, o.x - 5, o.x + o.w + 5), py = clamp(o.ay, o.y - 13, o.y + 5);
      const dx = px - o.ax, dy = py - o.ay, k = Math.min(Math.abs(dx), Math.abs(dy));
      if (Math.abs(dx) + Math.abs(dy) < 2) continue;
      g.move(o.ax, o.ay); g.line(o.ax + Math.sign(dx) * k, o.ay + Math.sign(dy) * k); g.line(px, py);
    }
    g.stroke(tint(K_RED, 0.5), 1);
    // an anchor off the floor: the callout is pinned to the nearest edge, a small arrow toward it
    g.begin_();
    let pins = 0;
    for (const o of this.callouts) {
      if (!o.pin) continue;
      const [px, py, ux, uy] = arrowAt(o, o.pin);
      g.move(px + ux * 5, py + uy * 5); g.line(px - uy * 4, py + ux * 4); g.line(px + uy * 4, py - ux * 4); g.ctx.closePath();
      pins++;
    }
    if (pins) g.fill(C.ink2);
    for (const o of this.callouts) {
      g.fillRect(o.x - 5, o.y - 13, o.w + 10, 18, tint(K_CARD, 0.92));
      g.begin_(); g.rect(o.x - 4.5, o.y - 12.5, o.w + 9, 17); g.stroke(o.parts[0][1] === C.redText ? '#4A2A2E' : CHIP_EDGE, 1);
      g.runs(o.parts, o.x, o.y, SMALL);
      f.fx.hit(o.x - 5, o.y - 13, o.w + 10, 18, o.kind, o.id, o.label);
    }
    g.alpha(1);
  }

  /** The floor's visible area: between the top row (the glance, y 46–68) and the time strip (the
   *  bottom 58 px), left of the drawer when one is open. */
  private floorBox(): Vis {
    const f = this.c.f, cam = f.cam;
    return { l: 0, t: 68, r: f.selected ? cam.W - 372 : cam.W, b: cam.H - 58 };
  }

  /** The "since" menu under its chip: one row per window, the chosen one marked. */
  private menuDraw(g: Gfx, x: number, y: number): void {
    const c = this.c, f = c.f, W = this.rowW, H = 22;
    g.fillRect(x, y, W, H * this.rows.length + 8, CARD);
    g.begin_(); g.rect(x + 0.5, y + 0.5, W - 1, H * this.rows.length + 7); g.stroke('#3A3A3E', 1);
    this.rows.forEach((r, i) => {
      const ry = y + 4 + i * H, on = r.win === c.win;
      if (on) { g.fillRect(x + 1, ry, W - 2, H, '#1E1E20'); g.fillRect(x + 1, ry + 4, 2, H - 8, C.ink); }
      else if (f.hoverId === r.win) g.fillRect(x + 1, ry, W - 2, H, '#19191B');
      g.text(r.label, x + 12, ry + 15, on ? C.ink : C.ink2, SMALL, on);
      if (r.hint) g.text(r.hint, x + W - 10, ry + 15, C.ink3, SMALL, false, 'right');
      f.fx.hit(x, ry, W, H, 'since', r.win, r.label);
    });
  }
}

/** The edge an off-floor anchor is past (the farther overshoot), '' when it is on the floor. */
export function calloutPin(ax: number, ay: number, v: Vis): Pin {
  const ol = v.l - ax, or = ax - v.r, ot = v.t - ay, ob = ay - v.b;
  const m = Math.max(ol, or, ot, ob);
  if (m <= 0) return '';
  return m === ol ? 'l' : m === or ? 'r' : m === ot ? 't' : 'b';
}

/** A callout's place ([x, baseline y] of its words, `w` px wide; its box is 5 px wider each side,
 *  13 px over and 5 under the baseline): up and to the right of its anchor as before, nudged by the
 *  placer's candidates (rows up, shifts sideways), each CLAMPED so the box stays EDGE px inside
 *  the floor's visible area; the first free one (`free` reserves it), else null. */
export function calloutAt(ax: number, ay: number, w: number, v: Vis, free: (x: number, y: number) => boolean): [number, number] | null {
  const x0 = v.l + EDGE + 5, x1 = v.r - EDGE - 5 - w, y0 = v.t + EDGE + 13, y1 = v.b - EDGE - 5;
  if (x1 < x0 || y1 < y0) return null;
  const seen = new Set<number>();
  for (const dy of [0, -15, -30, 15, -45, 30, -60, -75]) {
    for (const dx of [0, 28, -28, 56, -56, 90, -90]) {
      const x = Math.round(clamp(ax + 16 + dx, x0, x1)), y = Math.round(clamp(ay - 30 + dy, y0, y1));
      const key = x * 4096 + y;
      if (seen.has(key)) continue;
      seen.add(key);
      if (free(x, y)) return [x, y];
    }
  }
  return null;
}

/** Where a pinned callout's arrow sits on its box and which way it points: [x, y, ux, uy]. */
function arrowAt(o: { x: number; y: number; w: number; ax: number; ay: number }, pin: Pin): [number, number, number, number] {
  const l = o.x - 5, r = o.x + o.w + 5, t = o.y - 13, b = o.y + 5;
  const cy = clamp(o.ay, t + 6, b - 6), cx = clamp(o.ax, l + 8, r - 8);
  switch (pin) {
    case 'l': return [l - 2, cy, -1, 0];
    case 'r': return [r + 2, cy, 1, 0];
    case 't': return [cx, t - 2, 0, -1];
    default: return [cx, b + 2, 0, 1];
  }
}

/** A counter's glyph, drawn (fonts differ in which symbols they have). */
function glyph(g: Gfx, k: Glyph, x: number, y: number, col: string): void {
  g.begin_();
  switch (k) {
    case 'up': g.move(x - 4, y + 3.5); g.line(x, y - 3.5); g.line(x + 4, y + 3.5); g.ctx.closePath(); g.fill(col); return;
    case 'down': g.move(x - 4, y - 3.5); g.line(x, y + 3.5); g.line(x + 4, y - 3.5); g.ctx.closePath(); g.fill(col); return;
    case 'x': g.move(x - 3.5, y - 3.5); g.line(x + 3.5, y + 3.5); g.move(x + 3.5, y - 3.5); g.line(x - 3.5, y + 3.5); g.stroke(col, 1.8); return;
    case 'app': g.rect(x - 3.5, y - 3.5, 7, 7); g.fill(col); return;
    case 'appOk': g.rect(x - 3, y - 3, 6, 6); g.stroke(col, 1.4); return;
    case 'dot': g.circle(x, y, 3.2); g.fill(col); return;
    case 'merge': {
      // git's merge mark: a trunk, a branch curving into it, a dot at each end
      g.move(x - 2.5, y - 4); g.line(x - 2.5, y + 4); g.move(x + 3, y - 2.5); g.ctx.quadraticCurveTo(x + 3, y + 1.5, x - 2.5, y + 1.5); g.stroke(col, 1.4);
      g.begin_(); g.circle(x + 3, y - 3, 1.7); g.ctx.moveTo(x - 0.8, y + 4); g.circle(x - 2.5, y + 4, 1.7); g.fill(col); return;
    }
    case 'smoke': g.circle(x - 2.5, y + 1.5, 2.6); g.ctx.moveTo(x + 4.5, y - 1); g.circle(x + 2, y - 1, 2.6); g.fill(col); return;
  }
}

function easeOutBack(x: number): number { const c1 = 1.4, c3 = c1 + 1; return x <= 0 ? 0 : x >= 1 ? 1 : 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2); }

const dialCache = new Map<string, string[]>();
function withA(col: string, a: number): string {
  let row = dialCache.get(col);
  if (!row) {
    const n = parseInt(col.slice(1), 16);
    row = Array.from({ length: 33 }, (_, q) => `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${(q / 32).toFixed(3)})`);
    dialCache.set(col, row);
  }
  return row[Math.round(clamp(a, 0, 1) * 32)];
}

void breathe;
