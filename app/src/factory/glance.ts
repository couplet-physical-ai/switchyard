// THE GLANCE (fab-w4; FACTORY-SPEC §E "the first 10 s"; fx-glance: the 10-second read): the
// floor's top row after the zoom readout, the replay's playhead on the time strip, and the settled
// hotspot callouts.
//
//   dial      a 28-px needle gauge in four sectors (flowing · slowed · jammed · broken); the needle
//             swings to the verdict in the intro's 0.3–1.5 s, its place inside the sector is the
//             severity (anomaly.ts `sev`); the broken sector breathes on the one eased beat
//   verdict   RELATIVE: "broken · worse than usual" / "broken · as usual" / "flowing" (anomaly.ts
//             `usualOf`: the last hour's failures and the red main lines now against their 7-d
//             same-hour p90)
//   chips     at most four, WORDED, each a lens (it lights what it counts; hover names it):
//               "32 red · 26 new"         the red main lines now, the window's new ones
//               "119 recovered"           main lines fixed in the window
//               "1112 fails ▲ usual 640"  the window's failed runs, ▲/▼ only for that trend
//               "2 apps down"             apps down now (else "3 apps back", else "all apps up")
//             the rest (building and queued now, deploys, merges, new clusters) is in the window
//             dropdown. The totals (red, building, queued, down) are the STATUS LINE's own numbers
//             (coffee.ts `status`: one count; stress mode the 10× fleet's), never a count here.
//             In a replay the chips are the replayed moment's totals.
//   since     the window chip: "since 3h ago ▾"; a press opens the menu (since you last looked ·
//             last hour · last 24 h · last 7 d, then "now", then the chips that did not fit)
//   strip     the replay's playhead sweeps the strip's since-visit bracket (strip.ts draws it), a
//             ‹ when the window reaches past the strip's 24 h
//   callouts  ≤ 3 once the replay settles, where it is broken: the worst cluster (unless it is the
//             return belt's tallest heap, which names itself), the worst group, the jam, the app down. Each sits in the dark top band or the lower-left void with a leader to its
//             anchor, 24 px clear of stage titles, beacons and its own anchor; each a lens
//
// Strings are built when the digest, the window, the totals or the camera change, never per frame.

import type { Frame } from '../../app.contract.d.ts';
import type { Gfx, Tok } from '../yard/gfx.ts';
import { C, clamp } from '../yard/theme.ts';
import { insights } from '../insights.ts';
import { DAY, VERDICTS, WINS, ago, type Verdict, type Win } from './anomaly.ts';
import type { Coffee } from './coffee.ts';
import { K_CARD, K_INK, K_RED, pulse, tint } from './fx.ts';
import { FACTOR } from './stress.ts';
import { heapsOf, tallest } from './clusters.ts'; // the heap the belt names, the same pick

const SMALL = 12;
const OK = '#7FC48F';
const CHIP = '#161618';
const CHIP_EDGE = '#2E2E30';
const CARD = '#111112';
const COL: Record<Verdict, string> = { flowing: OK, slowed: C.amberText, jammed: C.packet, broken: C.red };
const A0 = 0.75 * Math.PI, SWEEP = 1.5 * Math.PI;
const STEPS = 12;
/** The dial's radius (a 28-px gauge). */
const DIAL_R = 14;
/** The intro's beats (ms after the floor opened): the dial swings, the window replays, it settles. */
export const T_DIAL = 300, T_COUNT = 600, T_SWEEP = 1500, T_SETTLE = 7000, T_DONE = 7600;

/** A worded chip: its number (counting up with the needle), its words, an optional trend mark
 *  (▲ +1 / ▼ −1, drawn) and the words after it; its lens (`key`, '' none) and its hover line. */
type Chip = { key: string; steps: string[]; ncol: string; numW: number; rest: Tok[]; tri: -1 | 0 | 1; triCol: string; post: Tok[]; w: number; label: string; accent: string; kind: string };
/** A row of the window menu: a window, a plain line, or a chip that did not fit (a lens). */
type Row = { kind: 'win' | 'info' | 'lens'; id: string; label: string; hint: string; col: string; lensKind: string };
/** A hotspot callout: its words' box (x, baseline y, width), its anchor, its lens, and the edge it
 *  is pinned to when the anchor is off the floor ('' when the leader reaches the anchor). */
type Callout = { x: number; y: number; ax: number; ay: number; w: number; parts: Tok[]; kind: string; id: string; label: string; pin: Pin; src: string };
type Pin = '' | 'l' | 'r' | 't' | 'b';
/** The floor's visible area (screen px): under the top row, over the time strip, left of a drawer. */
type Vis = { l: number; t: number; r: number; b: number };
/** A box the callouts keep clear of (screen px), and by how much. */
export type Keep = { x: number; y: number; w: number; h: number; m: number };
/** A callout box's margin to the floor's visible edges (px). */
const EDGE = 12;
/** The keep-out around stage titles, beacons and a callout's own anchor (px). */
const KEEP = 24;

export class Glance {
  private key = [-1, -1, -1, -1, -1];
  private keyWin: Win | '' = '';
  private chips: Chip[] = [];
  private word = '';
  private suffix = '';
  private suffixCol: string = C.ink3;
  private why = '';
  private sinceW = '';
  private rows: Row[] = [];
  private winRows: Row[] = [];
  private tailRows: Row[] = [];
  private shown = -1;
  private rowW = 0;
  /** The settled callouts (tests read `src`: the hotspot's kind:id). */
  callouts: Callout[] = [];
  private calloutKey = [-1, -1, -1, -1];
  private calloutPG: unknown = null;
  private sevFrom = 0;
  private loggedX = -1;
  /** The header's totals as last drawn (tests read them: the status line's numbers). */
  drawn = '';

  constructor(readonly c: Coffee) {}

  /** Re-reads the digest and the totals into words and widths (when either, the window, the mode,
   *  the stress factor or the clock's minute moved). */
  private prepare(g: Gfx): void {
    const c = this.c, f = c.f, d = c.dg, fr = d.fresh, k = this.key, T = c.now;
    const minute = Math.floor(f.tl.liveNow() / 60_000);
    // a replay, or a world held off the server (a replay paused, too much kept): the moment's totals
    const replay = f.tl.mode === 'replay' || (f.tl.mode !== 'live' && f.tl.stale) ? 1 : 0;
    const tk = ((T.red * 31 + T.building) * 31 + T.queued) * 31 + T.down * 7 + T.up + T.factor * 131;
    if (k[0] === c.dgN && this.keyWin === c.win && k[1] === minute && k[2] === (c.noVisit ? 1 : 0) && k[3] === tk && k[4] === replay) return;
    k[0] = c.dgN; k[1] = minute; k[2] = c.noVisit ? 1 : 0; k[3] = tk; k[4] = replay; this.keyWin = c.win;
    const m = d.marks, u = m.usual, F = T.factor > 1 ? T.factor : 1;
    this.word = m.verdict;
    const rel = m.verdict === 'flowing' ? '' : u.rel;
    this.suffix = replay ? (f.tl.mode === 'paused' ? ' · paused' : ' · replay') : rel === 'worse' ? ' · worse than usual' : rel === 'usual' ? ' · as usual' : '';
    this.suffixCol = replay ? C.ink2 : rel === 'worse' ? C.redText : C.ink3;
    const usualWhy: string[] = [];
    if (u.fails1h !== null && u.failsThr !== null) usualWhy.push(`${Math.round(u.fails1h)} fails in the last hour (p90 ${Math.round(u.failsThr)})`);
    if (u.redThr !== null) usualWhy.push(`${u.red} red (p90 ${Math.round(u.redThr)})`);
    this.why = [m.why || m.verdict, ...usualWhy].join(' · ');
    const ww = c.windowWords();
    const nf = Math.max(fr.failed.length, fr.failCount) * F, nm = Math.max(fr.merged.length, fr.mergedCount) * F;
    const all: Chip[] = [];
    const chip = (key: string, kind: string, n: number, ncol: string, rest: Tok[], label: string, accent: string, tri: -1 | 0 | 1 = 0, triCol: string = C.ink3, post: Tok[] = []): void => {
      const steps: string[] = [];
      if (n >= 0) for (let i = 1; i <= STEPS; i++) steps.push(String(Math.ceil((n * i) / STEPS))); // never a "0 apps down" mid-count
      const numW = n >= 0 ? g.width(steps[STEPS - 1], SMALL, true) : 0;
      let w = 8 + numW + tokW(g, rest) + (tri ? 13 : 0) + tokW(g, post) + 8;
      w = Math.ceil(w);
      all.push({ key, kind, steps, ncol, numW, rest, tri, triCol, post, w, label, accent });
    };
    if (replay) {
      // the replayed moment's totals: the status line's numbers then
      if (T.red) chip('red', 'fresh', T.red, C.redText, [[' red', C.redText]], `${T.red} main lines red then`, C.red);
      else chip('', '', -1, C.greenInk, [['every main line green', C.greenInk]], 'every main line green then', OK);
      chip('', '', T.building, C.amberText, [[' building', C.ink2]], `${T.building} building then`, C.packet);
      chip('intake', 'intake', T.queued, C.ink, [[' queued', C.ink2]], `${T.queued} queued then`, C.ink3);
      this.appsChip(chip, T, fr.recovered.length * F, 'then');
    } else {
      const nNew = fr.newRed.length * F;
      if (T.red) chip('red', 'fresh', T.red, C.redText, [[' red', C.redText], [nNew ? ` · ${nNew} new` : ' · none new', nNew ? C.ink2 : C.ink3]], `${T.red} main lines red now · ${nNew} turned red ${ww}`, C.red);
      else chip('', '', -1, C.greenInk, [['every main line green', C.greenInk]], 'every main line green', OK);
      const nFix = fr.fixed.length * F;
      if (nFix) chip('fixed', 'fresh', nFix, C.greenInk, [[' recovered', C.greenInk]], `${nFix} main lines recovered · ${ww}`, OK);
      if (nf > 0) {
        const wu = u.winUsual !== null ? u.winUsual * F : null, wt = u.winThr !== null ? u.winThr * F : null;
        const tri: -1 | 0 | 1 = wu === null ? 0 : wt !== null && nf > wt ? 1 : nf < wu * 0.85 ? -1 : 0;
        chip('failed', 'fresh', nf, C.ink, [[' fails', C.ink2]], `${nf} runs failed · ${ww}${wu !== null ? ` · usual ${wu} for a window this long` : ''}`, C.red,
          tri, tri > 0 ? C.red : '#8FA898', wu !== null ? [[` · usual ${wu}`, C.ink3]] : []);
      }
      this.appsChip(chip, T, fr.recovered.length * F, ww);
    }
    // the row holds ≤ 4 (fewer when narrow); the rest (and building, queued, deploys, merges,
    // clusters) is in the menu
    this.chips = all.slice(0, 4);
    this.sinceW = c.windowWords();
    const h7 = insights().trend('fleet')?.hours_7d ?? 168;
    this.winRows = WINS.map((w) => ({
      kind: 'win' as const, id: w, col: C.ink2, lensKind: '',
      label: w === 'visit' ? 'since you last looked' : w === '1h' ? 'last hour' : w === '24h' ? 'last 24 h' : 'last 7 d',
      hint: w === 'visit' ? (c.noVisit ? 'none kept yet' : `${ago(f.tl.liveNow() - c.visitAt)} ago`) : w === '7d' && h7 < 168 ? `${h7} h held` : '',
    }));
    this.tailRows = [];
    if (!replay) {
      this.tailRows.push({ kind: 'info', id: 'now', label: `now · ${T.building} building · ${T.queued} queued`, hint: '', col: C.ink2, lensKind: '' });
      const extra: [string, number, string][] = [['deploys', fr.deploys * F, `${fr.deploys * F} deploys`], ['merged', nm, `${nm} PRs merged`], ['clusters', fr.newClusters.length * F, `${fr.newClusters.length * F} new failure clusters`]];
      for (const [id, n, label] of extra) if (n > 0) this.tailRows.push({ kind: 'lens', id, label, hint: '', col: C.ink2, lensKind: 'fresh' });
    }
    this.shown = -1;
    this.drawn = c.headWords();
  }

  /** The menu's rows for `shown` chips on the row: the windows, "now", the chips that did not
   *  fit, the window's other counts (rebuilt only when that number changes). */
  private menuRows(g: Gfx, shown: number): void {
    if (shown === this.shown) return;
    this.shown = shown;
    const over: Row[] = this.chips.slice(shown).map((ch) => ({ kind: ch.kind ? 'lens' as const : 'info' as const, id: ch.key, label: ch.label.split(' · ')[0], hint: '', col: ch.ncol, lensKind: ch.kind }));
    this.rows = [...this.winRows, ...this.tailRows.slice(0, 1), ...over, ...this.tailRows.slice(1)];
    this.rowW = Math.max(...this.rows.map((r) => g.width(r.label, SMALL, r.kind === 'win' && r.id === this.c.win) + (r.hint ? g.width(r.hint, SMALL) + 18 : 0))) + 34;
  }

  /** The apps chip: down now, else back in the window, else all up. */
  private appsChip(chip: (key: string, kind: string, n: number, ncol: string, rest: Tok[], label: string, accent: string) => void, T: Coffee['now'], back: number, ww: string): void {
    if (T.down) chip('down', 'fresh', T.down, C.redText, [[` ${T.down === 1 ? 'app' : 'apps'} down`, C.redText]], `${T.down} ${T.down === 1 ? 'app' : 'apps'} down ${ww === 'then' ? 'then' : 'now'}`, C.red);
    else if (back) chip('back', 'fresh', back, C.greenInk, [[` ${back === 1 ? 'app' : 'apps'} back`, C.greenInk]], `${back} apps recovered · ${ww}`, OK);
    else chip('', '', -1, C.greenInk, [['all apps up', C.greenInk]], 'every app up', OK);
  }

  draw(g: Gfx, fr: Frame, t: number, x0: number, right: number): void {
    void fr;
    const c = this.c, f = c.f, d = c.dg;
    c.ensureNow(t);
    this.prepare(g);
    const replay = f.tl.mode === 'replay' || (f.tl.mode !== 'live' && f.tl.stale);
    const it = c.introT(t);
    const y = 46;
    const v = d.marks.verdict, col = COL[v];
    // the needle: at rest until 0.3 s, swings to the verdict by 1.5 s (a small overshoot)
    const e = c.openAt < 0 ? 0 : clamp((it - T_DIAL) / (T_SWEEP - T_DIAL), 0, 1);
    const sev = this.sevFrom + (d.marks.sev - this.sevFrom) * easeOutBack(e);
    if (e >= 1) this.sevFrom = d.marks.sev;
    this.dial(g, x0 + DIAL_R, y + 11, sev, c.openAt < 0 ? -1 : VERDICTS.indexOf(v), t, e);
    let x = x0 + DIAL_R * 2 + 8;
    if (c.openAt >= 0) {
      x += g.text(this.word, x, y + 16.5, e > 0.5 ? col : C.ink3, 15, true);
      if (this.suffix && e > 0.5) x += g.text(this.suffix, x, y + 16, this.suffixCol, 13);
      x += 14;
    } else x += g.text('looking…', x, y + 16.5, C.ink3, 15, true) + 14;
    f.fx.hit(x0 - 4, y - 4, x - x0, 30, 'verdict', v, this.why);
    if (c.openAt < 0) return;
    // the chips (count up with the needle), then the window chip
    // the chips count up over ≤ 600 ms of the intro only (overseer): live updates show the number at once
    const ec = c.openAt < 0 ? 0 : clamp((it - T_DIAL) / T_COUNT, 0, 1);
    const step = Math.max(1, Math.ceil(ec * STEPS));
    const sinceW = replay ? 0 : g.width(this.sinceW, SMALL) + 26;
    let room = right - x - sinceW - 8, n = 0;
    for (const ch of this.chips) {
      if (ch.w + 6 > room) break;
      room -= ch.w + 6;
      n++;
      g.fillRect(x, y + 1, ch.w, 20, CHIP);
      g.begin_(); g.rect(x + 0.5, y + 1.5, ch.w - 1, 19); g.stroke(CHIP_EDGE, 1);
      g.fillRect(x + 1, y + 2, 2, 18, ch.accent);
      let cx = x + 8;
      if (ch.steps.length) { g.text(ch.steps[step - 1], cx, y + 15.5, ch.ncol, SMALL, true); cx += ch.numW; }
      cx = g.runs(ch.rest, cx, y + 15.5, SMALL);
      if (ch.tri) { tri(g, cx + 7, y + 11, ch.tri, ch.triCol); cx += 13; }
      if (ch.post.length) g.runs(ch.post, cx, y + 15.5, SMALL);
      if (ch.key) f.fx.hit(x, y + 1, ch.w, 20, ch.kind, ch.key, ch.label);
      x += ch.w + 6;
    }
    // the chips that did not fit are in the menu
    this.menuRows(g, n);
    if (replay) return;
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
    f.fx.hit(cx, y + 1, sinceW, 20, 'since', 'menu', 'pick the window · building, queued and the rest');
    // for drivers (tools/glance-shots.mjs): where the chip is, once per place
    if (cx !== this.loggedX) { this.loggedX = cx; console.log(`coffee: since chip at ${Math.round(cx + sinceW / 2)},${y + 11} rows ${y + 26 + 4 + 11} step 22`); }
    this.strip(g, it);
    c.look(g, t); // wow 4: the light walking the worst path
    if (!f.lens.topLens && f.tl.mode !== 'replay' && it >= T_SETTLE) this.calloutsDraw(g, clamp((it - T_SETTLE) / (T_DONE - T_SETTLE), 0, 1));
    if (c.menu) this.menuDraw(g, Math.min(cx, right - this.rowW), y + 26);
  }

  /** The dial: a 28-px gauge, four sectors, the live one lit, the needle at `sev` (0..1 over 270°). */
  private dial(g: Gfx, x: number, y: number, sev: number, vi: number, t: number, e: number): void {
    const r = DIAL_R - 3, seg = SWEEP / 4, gap = 0.07;
    g.begin_(); g.circle(x, y, DIAL_R - 0.5); g.fill('#141415');
    for (let i = 0; i < 4; i++) {
      const on = i === vi && e > 0.5;
      const a = on ? (i === 3 ? 0.7 + 0.3 * pulse(t) : 1) : 0.26;
      g.begin_(); g.arc(x, y, r, A0 + i * seg + gap, A0 + (i + 1) * seg - gap);
      g.stroke(withA(COL[VERDICTS[i]], a), on ? 3.2 : 2.4);
    }
    const ang = A0 + clamp(sev, 0, 1.04) * SWEEP;
    const nc = vi >= 0 && e > 0.5 ? COL[VERDICTS[vi]] : C.ink3;
    g.begin_(); g.move(x - Math.cos(ang) * 3, y - Math.sin(ang) * 3); g.line(x + Math.cos(ang) * (r + 1), y + Math.sin(ang) * (r + 1));
    g.stroke(C.ink, 1.8);
    g.begin_(); g.circle(x, y, 2.6); g.fill(nc);
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
      g.begin_(); g.move(sx - 3, sy - 2); g.line(sx - 8, sy + 1); g.line(sx - 3, sy + 4); g.stroke(C.ink, 1.4);
    }
    if (it < T_SWEEP || it >= T_SETTLE) return;
    const p = clamp((it - T_SWEEP) / (T_SETTLE - 300 - T_SWEEP), 0, 1), px = bx + (ex - bx) * p;
    g.fillRect(bx, sy, Math.max(0, px - bx), sh, tint(K_INK, 0.06));
    g.vline(g.crisp(px), sy - 3, sy + sh + 3, C.ink, 1.5);
    g.begin_(); g.circle(px, sy - 3, 2.5); g.fill(C.ink);
  }

  private calloutsDraw(g: Gfx, a: number): void {
    const c = this.c, f = c.f, cam = f.cam, k = this.calloutKey;
    const pgs = f.lens.parkGroups;
    if (k[0] !== c.dgN || k[1] !== cam.ver || k[2] !== f.census.at || k[3] !== c.now.factor || pgs !== this.calloutPG) {
      k[0] = c.dgN; k[1] = cam.ver; k[2] = f.census.at; k[3] = c.now.factor; this.calloutPG = pgs;
      // the return belt's tallest heap names its own signature (fx-engine, plant.ts): the worst
      // cluster's callout gives way to it when that is its subject (one name per thing)
      const heaps = heapsOf(f.lens.parked);
      const tall = heaps ? (tallest(heaps)?.cl ?? '') : tallestCluster(pgs);
      // stress mode: the callouts' counts are the 10× fleet's, as the header's are
      const F = c.now.factor;
      this.callouts = [];
      // what the callouts keep clear of: the words placed this frame (stage titles by 24 px, the
      // rest by the placer's 12) and the beacons' lamps (24 px)
      const keep: Keep[] = [];
      for (const l of f.labels) keep.push({ x: l.x, y: l.y - l.h, w: l.w, h: l.h + 3, m: l.h >= 18 ? KEEP : 12 });
      const bxy = c.beaconXY;
      for (let i = 0; i + 1 < bxy.length; i += 2) keep.push({ x: bxy[i] - 10, y: bxy[i + 1] - 10, w: 20, h: 20, m: KEEP });
      const vis = this.floorBox();
      // the slab's front edge (screen): below it, the lower-left void
      const P = f.plan, FV = P.RETURN_V + 34;
      const edge: [number, number, number, number] = [cam.x(-112, FV), cam.y(-112, FV, 0), cam.x(P.CITY_U1, FV), cam.y(P.CITY_U1, FV, 0)];
      c.dg.marks.hot.forEach((h, i) => {
        const ax = c.hotXY[i * 2], ay = c.hotXY[i * 2 + 1];
        if (!(ax >= 0) || this.callouts.length >= 3) return;
        if (h.kind === 'cluster' && h.id === tall) return;
        const rest = F > 1 ? h.rest.replace(/\d+/, (n) => String(Number(n) * F)) : h.rest;
        const parts: Tok[] = [[h.lead, h.red ? C.redText : h.kind === 'jam' ? C.amberText : C.ink, true], [rest, C.ink2]];
        const w = g.width(h.lead, SMALL, true) + g.width(rest, SMALL);
        const pin = calloutPin(ax, ay, vis);
        const at = calloutAt(ax, ay, w, vis, keep, edge);
        if (!at) return;
        // the callout's own box joins what the next ones keep clear of
        keep.push({ x: at[0] - 5, y: at[1] - 13, w: w + 10, h: 18, m: 8 });
        // each callout is a lens: the cluster's (a failing run of it the world holds, else the
        // tests), the group's dock or district, the intake
        let kind = 'scanner', id = 'tests', label = 'tests';
        if (h.kind === 'cluster') {
          const ex = insights().cluster(h.id)?.examples.find((pid) => f.world.pipelines.has(pid));
          if (ex) { kind = 'failure'; id = ex; label = h.lead; }
        } else if (h.kind === 'jam') { kind = 'intake'; id = 'intake'; label = 'intake'; }
        else if (h.kind === 'down') { kind = 'app'; id = h.id; label = h.id; }
        else if (h.kind === 'group') {
          if (h.id.startsWith('org:')) { kind = 'dock'; id = h.id.slice(4); label = h.lead; }
          else { const di = f.fx.districtBox.findIndex((b) => b.team.toLowerCase().replace(/\s+/g, '-') === h.id.slice(5)); kind = 'district'; id = String(di); label = f.fx.districtBox[di]?.team ?? h.lead; }
        }
        this.callouts.push({ x: at[0], y: at[1], ax, ay, w, parts, kind, id, label, pin, src: `${h.kind}:${h.id}` });
      });
    }
    if (!this.callouts.length) return;
    // the boxes claim their places so later words (the hover card's) keep off them
    for (const o of this.callouts) f.fx.placeAt(o.x - 5, o.y + 5, o.w + 10, 18, 0, false);
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
    g.begin_();
    for (const o of this.callouts) if (!o.pin) { g.ctx.moveTo(o.ax + 2.2, o.ay); g.ctx.arc(o.ax, o.ay, 2.2, 0, Math.PI * 2); }
    g.fill(tint(K_RED, 0.8));
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

  /** The window menu under its chip: one row per window (the chosen one marked), then "now"
   *  (building, queued), then the chips that did not fit and the window's other counts. */
  private menuDraw(g: Gfx, x: number, y: number): void {
    const c = this.c, f = c.f, W = this.rowW, H = 22;
    const n = this.rows.length, sep = this.rows.findIndex((r) => r.kind !== 'win');
    const hh = H * n + 8 + (sep >= 0 ? 7 : 0);
    g.fillRect(x, y, W, hh, CARD);
    g.begin_(); g.rect(x + 0.5, y + 0.5, W - 1, hh - 1); g.stroke('#3A3A3E', 1);
    let ry = y + 4;
    this.rows.forEach((r, i) => {
      if (i === sep) { g.hline(x + 8, x + W - 8, g.crisp(ry + 3), '#2A2A2C'); ry += 7; }
      const on = r.kind === 'win' && r.id === c.win;
      if (on) { g.fillRect(x + 1, ry, W - 2, H, '#1E1E20'); g.fillRect(x + 1, ry + 4, 2, H - 8, C.ink); }
      else if (r.kind !== 'info' && f.hoverId === r.id) g.fillRect(x + 1, ry, W - 2, H, '#19191B');
      g.text(r.label, x + 12, ry + 15, on ? C.ink : r.col, SMALL, on);
      if (r.hint) g.text(r.hint, x + W - 10, ry + 15, C.ink3, SMALL, false, 'right');
      if (r.kind === 'win') f.fx.hit(x, ry, W, H, 'since', r.id, r.label);
      else if (r.kind === 'lens') f.fx.hit(x, ry, W, H, r.lensKind, r.id, r.label);
      ry += H;
    });
  }
}

/** The cluster the return belt names (clusters.ts `tallest`: the open park group reaching the most
 *  repos; ties: the most failures, then nearest the scanner, the first), '' none: fx-engine names
 *  that heap on the floor. */
export function tallestCluster(pgs: readonly { cl: string; n: number; open: boolean; repos?: number }[]): string {
  let best = '', n = 0, r = 0;
  for (const p of pgs) { const pr = p.repos ?? 0; if (p.open && (pr > r || (pr === r && p.n > n))) { n = p.n; r = pr; best = p.cl; } }
  return best;
}

function tokW(g: Gfx, parts: readonly Tok[]): number { let w = 0; for (const p of parts) if (p[0]) w += g.width(p[0], SMALL, !!p[2]); return w; }

/** A trend mark, drawn (fonts differ in which symbols they have): ▲ (+1) or ▼ (−1). */
function tri(g: Gfx, x: number, y: number, dir: 1 | -1, col: string): void {
  g.begin_();
  if (dir > 0) { g.move(x - 4, y + 3.5); g.line(x, y - 3.5); g.line(x + 4, y + 3.5); }
  else { g.move(x - 4, y - 3.5); g.line(x, y + 3.5); g.line(x + 4, y - 3.5); }
  g.ctx.closePath(); g.fill(col);
}

/** The edge an off-floor anchor is past (the farther overshoot), '' when it is on the floor. */
export function calloutPin(ax: number, ay: number, v: Vis): Pin {
  const ol = v.l - ax, or = ax - v.r, ot = v.t - ay, ob = ay - v.b;
  const m = Math.max(ol, or, ot, ob);
  if (m <= 0) return '';
  return m === ol ? 'l' : m === or ? 'r' : m === ot ? 't' : 'b';
}

/** Where the dark lower-left void is without the slab's edge (tests): left of 40 % of the width,
 *  under 62 % of the height. */
const VOID_R = 0.4, VOID_T = 0.62;

/** A callout's place ([x, baseline y] of its words, `w` px wide; its box is 5 px wider each side,
 *  13 px over and 5 under the baseline), in the floor's dark places: the TOP BAND (two rows under
 *  the glance) or the LOWER-LEFT VOID (rows up from the strip, left of 40 % of the width), the
 *  candidate nearest its anchor whose box keeps clear of every `keep` box by its margin and of
 *  the anchor itself by 24 px, and stays EDGE px inside the visible area; null when none is free. */
export function calloutAt(ax: number, ay: number, w: number, v: Vis, keep: readonly Keep[] = [], edge: readonly [number, number, number, number] | null = null): [number, number] | null {
  const x0 = v.l + EDGE + 5, x1 = v.r - EDGE - 5 - w, y0 = v.t + EDGE + 13, y1 = v.b - EDGE - 5;
  if (x1 < x0 || y1 < y0) return null;
  let best: [number, number] | null = null, bd = Infinity;
  const consider = (x: number, y: number) => {
    x = Math.round(clamp(x, x0, x1)); y = Math.round(clamp(y, y0, y1));
    const bl = x - 5, bt = y - 13, br = x + w + 5, bb = y + 5;
    const cx = clamp(ax, bl, br), cy = clamp(ay, bt, bb), d = Math.hypot(cx - ax, cy - ay);
    if (d >= bd) return; // no nearer than the best so far: the cheap test first
    // its own anchor: 24 px clear
    if (ax > bl - KEEP && ax < br + KEEP && ay > bt - KEEP && ay < bb + KEEP) return;
    for (const k of keep) if (bl < k.x + k.w + k.m && br > k.x - k.m && bt < k.y + k.h + k.m && bb > k.y - k.m) return;
    bd = d; best = [x, y];
  };
  // the top band: two rows, sliding sideways from over the anchor
  for (const y of [y0, y0 + 20]) for (let dx = 0; dx <= 720; dx += 24) { consider(ax - w / 2 + dx, y); if (dx) consider(ax - w / 2 - dx, y); }
  // the lower-left void: rows up from the strip, under the slab's front edge (`edge`: two points
  // on it, screen px; without one, the bottom-left corner of the visible area)
  if (edge) {
    const [ex0, ey0, ex1, ey1] = edge, k = (ey1 - ey0) / ((ex1 - ex0) || 1);
    const under = (x: number, y: number) => y > ey0 + (x - ex0) * k + 10;
    for (let y = y1; y >= y0; y -= 20) for (let x = x0; x <= x1; x += 32) if (under(x - 5, y - 13) && under(x + w + 5, y - 13)) consider(x, y);
  } else {
    const vr = v.l + (v.r - v.l) * VOID_R, vt = v.t + (v.b - v.t) * VOID_T;
    for (let y = y1; y >= vt; y -= 20) for (let x = x0; x + w <= vr; x += 24) consider(x, y);
  }
  return best;
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

void FACTOR;
