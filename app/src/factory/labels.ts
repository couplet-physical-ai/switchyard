// The floor's words (fab-w0; the text budget and the hover lines: fab-w1, FACTORY-SPEC §B, §F,
// overseer note 3). The greedy label placer every layer places with (measured boxes, a 12 px gap,
// nudged up in 15 px rows and slid sideways; never a cut word), and the words themselves, by the
// semantic zoom's level:
//
//   fleet (z < 1.4, no lane open)  the nine stage titles (one run each), the group names (the
//                                  docks', groupfloor.ts) and the culprit's callout: ≤ 40 runs with
//                                  the chrome. Every number lives in an encoding (stack heights,
//                                  red posts, belt widths and speeds, lintel ticks) and on hover:
//                                  `stageHover` (the stage titles' numbers, for hover.ts), and the
//                                  floor's hits (floor.ts `hoverFor`).
//   group (a lane open, z ≥ 1.4)   + the titles' stat lines, the machines' names and jobs, the
//                                  phases, the open lane's post names and cell counts, its age axis,
//                                  the tracks and districts
//   repo (z ≥ 2.4)                 + the open lane's sub-rows (repo names, "+N"), the apps' names
//
// Also the idle floor's titles.

import type { Frame } from '../../app.contract.d.ts';
import type { Gfx } from '../yard/gfx.ts';
import { C, withAlpha } from '../yard/theme.ts';
import { AGE_WORDS, PHASES } from './census.ts';
import type { Factory } from './factory.ts';
import { STAGES } from './grammar.ts';
import { floorGroups } from './groups.ts';
import { BOARDS, TITLE_Z, frontOf } from './front.ts'; // fx-front: the title row over the back wall's boards
import { ago, stackH } from './floor.ts';
import { insights } from '../insights.ts';
import { LANE_U, LANE_V0, PLAN, VIA_WORDS, WALL_Z } from './layout.ts';
import { MONO, SMALL, TITLE, dur, runningStep } from './prims.ts';
import type { Bay, Block, HitBox, Label, Layer, LiveFrame } from './types.ts';

const {
  DOCK_U0, ROW_U, GATE_U, RAIL_U0, RAIL_U1, INTAKE_U0, YARD_U0,
  ENG_U0, ENG_U1, ENG_V0, ENG_STEP, ENG_DV, ENG_H, SCAN_U, TRACK_V, CITY_U0, CITY_V0, VIAS,
} = PLAN;

/** Each stage title's anchor (u, v, z) and where a click flies (u, v, zoom). */
const STAGE_AT: Record<string, { at: [number, number, number]; fly: string }> = {
  '01': { at: [DOCK_U0 + 27, LANE_V0, 14], fly: '60,320,2.2' },
  '02': { at: [ROW_U[0], LANE_V0, 2], fly: '264,320,2' },
  '03': { at: [GATE_U + 3, LANE_V0, 24], fly: `${GATE_U},320,2.2` },
  '04': { at: [RAIL_U0 + 40, LANE_V0, 2], fly: '550,320,2.2' },
  '05': { at: [INTAKE_U0 + 10, 258, 6], fly: '705,291,3' },
  '06': { at: [ENG_U0 + 10, ENG_V0, ENG_H], fly: '915,300,1.9' },
  '07': { at: [SCAN_U, 30, 56], fly: `${SCAN_U},330,2.4` },
  '08': { at: [SCAN_U + 40, TRACK_V[0] - 6, 0], fly: '1165,330,2.6' },
  '09': { at: [CITY_U0 + 20, CITY_V0, 6], fly: '1360,320,2' },
};
/** fab-w1: with the lanes on, the titles stand on the back wall over their boards (floor.ts). */
const WALL_AT: Record<string, [number, number, number]> = {
  '01': [DOCK_U0 + 4, 0, WALL_Z], '02': [YARD_U0 + 6, 0, WALL_Z], '04': [RAIL_U0 - 8, 0, WALL_Z], '06': [ENG_U0 - 100, 0, WALL_Z],
  '07': [ENG_U1 + 18, 0, WALL_Z], '08': [SCAN_U + 18, 0, WALL_Z], '09': [CITY_U0 + 6, 0, WALL_Z],
};
// fx-front: the boards stand taller now (front.ts BOARDS): a zoomed-in title sits on its board's top
// (w2-chrome #12: every stage with a board, at its left end)
for (const b of BOARDS) WALL_AT[b.stage] = [b.u0 + 4, 0, b.z1];
if (WALL_AT['08']) WALL_AT['08'][2] = BOARDS.find((b) => b.stage === '07')?.z1 ?? WALL_Z;
/** fx-front: the fleet zoom's ONE title row (review iter-2 #7): each title over its stage, on one
 *  baseline, a leader down to its board (or, with none, to the stage). `parts`: [words, stage]. */
const TITLE_ROW: { n: string; parts: [string, string][]; at?: [number, number, number] }[] = [
  { n: '01', parts: [['sources', '01']] },
  { n: '02', parts: [['pr yard', '02']] },
  { n: '03', parts: [['merge gate', '03']] },
  { n: '04', parts: [['main lines', '04']] },
  { n: '05', parts: [['intake', '05']] },
  { n: '06', parts: [['consumption engine', '06']] },
  { n: '07', parts: [['tests', '07'], ['· deploy', '08']] },
  { n: '09', parts: [['apps', '09']] },
];
/** w2-chrome (REVIEW-iter3 #8): the glance row's band, the factory canvas's top BAND_H px (the
 *  camera's buttons and the coffee glance, y 46–68, glance.ts / strip.ts `controls`): opaque, so
 *  the floor never paints through it at any zoom, and a press there never reaches the floor. No
 *  label is placed in it. */
export const BAND_H = 74;

/** The fleet trend metric a stage's hover sparkline reads. */
const STAGE_SPARK: Record<string, 'pushes' | 'prs_open' | 'red' | 'intake_ms' | 'pipelines' | 'failures' | 'deploys' | ''> = {
  '01': '', '02': 'prs_open', '03': '', '04': 'red', '05': 'intake_ms', '06': 'pipelines', '07': 'failures', '08': 'deploys', '09': '',
};

export class Labels implements Layer {
  readonly name = 'labels';
  /** The boxes placed this frame (the placer's memory; reset each live frame and by a lens or
   *  the journey, whose dimmed words no longer claim their places). */
  list: Label[] = [];
  private nameOrder: Block[] = [];
  private nameOrderAt = -1;

  constructor(readonly f: Factory) {}

  /** A new frame: nothing placed yet. */
  reset(): void { this.list = []; this.hov.clear(); }

  live(g: Gfx, fr: LiveFrame): void { this.band(g); this.draw(g, fr.now); }

  /** w2-chrome (#8): the glance row's band, over every layer of the floor (this layer is the last,
   *  on the top canvas): the glance, the buttons, the lenses' cards and the hover draw after it.
   *  Its hit shadows every floor object under it (the last hit wins: factory.ts `hitAt`); a
   *  'drawer' hit is inert (no hover card, a click does nothing). */
  private band(g: Gfx): void {
    const W = this.f.cam.W;
    g.fillRect(0, 0, W, BAND_H, C.canvas);
    g.hline(0, W, g.crisp(BAND_H), '#1F1F21');
    this.f.hit(0, 0, W, BAND_H, 'drawer', '', '');
  }

  // ---- hover lines (overseer note 3: the numbers left the floor for the hover card) -----------
  private hov = new Map<HitBox, string[]>();

  /** The hover card's lines for a hit the floor's words or lanes made this frame (hover.ts and
   *  drawer.ts ask first); null: not theirs. */
  hoverFor(h: HitBox): string[] | null { return this.hov.get(h) ?? this.f.floor.hoverFor(h) ?? frontOf(this.f)?.hoverFor(h) ?? null; } // fx-front: + the boards', roads' and curbs' hits

  /** A stage's numbers, the ones its title's stat line used to print (≤ 3 lines): by the stage's
   *  number ('02'), its title ('pr yard') or its hit id. */
  stageHover(id: string): string[] {
    const n = STAGES.find((s) => s.n === id || s.title === id)?.n ?? Object.entries(STAGE_AT).find(([, a]) => a.fly === id)?.[0] ?? '';
    const f = this.f, c = f.census, w = f.world, fl = c.flow, num = (x: number) => x.toLocaleString('en-US');
    const lanes = floorGroups().lanes(), cnt = f.floor.data.last;
    const worst = (pick: (id: string) => number): [string, number] => {
      let best = '', k = 0;
      for (const l of lanes) { const v = pick(l.id); if (v > k) { k = v; best = l.short; } }
      return [best, k];
    };
    switch (n) {
      case '01': {
        const [b, k] = worst((id) => floorGroups().stats(id)?.pushes1h ?? 0);
        return ['sources', `${fl.pushes} pushes/h${k ? ` · busiest ${b} (${k})` : ''}`, `${lanes.length} group lanes · ${num(w.repos.size)} repos`];
      }
      case '02': {
        const open = c.phaseN.reduce((a, b) => a + b, 0);
        let red = 0, stale = 0, oldest = 0;
        for (const L of cnt.lanes.values()) for (const C of L.cells) { red += C.red; stale += C.stale; oldest = Math.max(oldest, C.oldest); }
        return ['pr yard', `${num(open)} open · ${num(c.botN)} from bots`, `${red} failing CI · ${stale} stale${oldest ? ` · oldest ${ago(oldest)}` : ''}`];
      }
      case '03': { const [b, k] = worst((id) => cnt.lanes.get(id)?.merges24 ?? 0); return ['merge gate', `${fl.merges} merged/h`, k ? `most merges 24 h: ${b} (${k})` : 'no merges in 24 h']; }
      case '04': { const [b, k] = worst((id) => cnt.lanes.get(id)?.red ?? 0); return ['main lines', `${c.redLines} red of ${num(w.repos.size)}`, k ? `most red: ${b} (${k})` : 'every main line green']; }
      case '05': return ['intake', `${c.waiting} queued`, c.oldestWait > 60_000 ? `oldest ${dur(c.oldestWait)}` : `p50 wait ${dur(w.stats.p50_queue_ms || 0)}`];
      case '06': {
        const slots = c.groups.reduce((a, gr) => a + (gr.hosted ? 0 : gr.slots), 0), busy = c.groups.reduce((a, gr) => a + (gr.hosted ? 0 : gr.running.length), 0);
        return ['consumption engine', `${c.building} building · ${busy} of ${slots} bays`, `${fl.started} jobs/h · p50 ${dur(w.stats.p50_build_ms || 0)}`];
      }
      case '07': {
        const pass = fl.finished ? Math.round(((fl.finished - fl.failed) / fl.finished) * 100) : Math.round((w.stats.success_rate_24h || 0) * 100);
        const sm = f.coffee.smokeWords();
        if (this.f.floor.on && !sm) return ['tests · deploy', `${pass}% pass · ${fl.failed} failed/h of ${fl.finished}`, `${c.deploying.length} deploying · ${fl.deploys} deploys/h`]; // fx-front: one board, one title
        return ['tests', `${pass}% pass · ${fl.failed} failed/h`, sm ? `smoke: ${sm}` : `${fl.finished} finished/h`];
      }
      case '08': return ['deploy', `${c.deploying.length} deploying · ${fl.deploys}/h`, VIAS.map((v) => `${VIA_WORDS[v]} ${fl.byVia[v] ?? 0}`).join(' · ')];
      case '09': {
        let up = 0, down = 0;
        for (const a of w.apps.values()) { if (a.health === 'up') up++; else if (a.health === 'down') down++; }
        return ['apps', `${up} of ${w.apps.size} up${down ? ` · ${down} down` : ''}`, `${c.districts.length} districts`];
      }
      default: return [];
    }
  }

  /** Where a click on a stage (its title, its board) flies: 'u,v,zoom'. */
  stageFly(n: string): string { return STAGE_AT[n]?.fly ?? ''; }

  /** A stage's 24 h sparkline (the fleet trend's), for the hover card's chart; null: none. */
  stageSpark(id: string): (number | null)[] | null {
    const own = this.f.floor.on ? frontOf(this.f)?.spark(id) : null; // fx-front: the board's day (its title or stage)
    if (own) return own;
    const n = STAGES.find((s) => s.n === id || s.title === id)?.n ?? (id === 'tests · deploy' ? '07' : '');
    // fab-w1: the back wall's own board (the day, an hour a value), else the fleet trend's
    const W = this.f.floor.on ? this.f.floor.data.last.wall : null;
    const ser = !W ? null : n === '01' ? W.pushes : n === '02' ? W.opened : n === '03' || n === '04' ? W.landed : n === '05' || n === '06' ? W.runs : n === '07' ? W.runsRed : n === '08' ? W.deploys : null;
    if (ser && ser.some((x) => x > 0)) return Array.from(ser);
    const k = STAGE_SPARK[n];
    if (!k) return null;
    const t = insights().trend('fleet') as unknown as Record<string, { spark?: (number | null)[] } | undefined> | null;
    const sp = t?.[k]?.spark;
    return sp && sp.length ? sp : null;
  }

  /** Reserve a label rect, nudged up in 15 px rows until it touches no other label. */
  place(x: number, y: number, w: number, h: number, maxUp = 9): number {
    const r = this.placeAt(x, y, w, h, maxUp, false);
    return r ? r[1] : -1;
  }

  /** Greedy placement over candidate positions (rows up, and with `slide` shifts sideways),
   *  measured boxes, a 12 px gap; null when nothing is free. */
  placeAt(x: number, y: number, w: number, h: number, maxUp: number, slide: boolean): [number, number] | null {
    const G = 12;
    const free = (xx: number, yy: number) => {
      if (yy - h < BAND_H + 2 || xx < 4 || xx + w > this.f.cam.W - 4) return false; // w2-chrome: never in the glance's band
      for (const l of this.list) if (xx < l.x + l.w + G && xx + w + G > l.x && yy - h - 3 < l.y && yy + 3 > l.y - l.h) return false;
      return true;
    };
    const shifts = slide ? [0, 28, -28, 56, -56, 90, -90] : [0];
    for (let k = 0; k <= maxUp; k++) {
      for (const dx of shifts) {
        const xx = x + dx, yy = y - k * 15;
        if (free(xx, yy)) { this.list.push({ x: xx, y: yy, w, h }); return [xx, yy]; }
      }
    }
    if (maxUp === 0 && !slide) return null;
    return null;
  }

  /** A label with its leader line: from the object's anchor (ax, ay) up to a label band. */
  leader(g: Gfx, ax: number, ay: number, lift: number, parts: [string, string, boolean?][], px = MONO): [number, number] {
    let wsum = 0;
    for (const [s, , b] of parts) wsum += g.width(s, px, !!b);
    const at = this.placeAt(Math.round(ax - 3), Math.round(ay - lift), wsum, px + 3, 8, true);
    if (!at) return [0, -1];
    const [x, y] = at;
    const lx = Math.min(Math.max(ax, x + 2), x + wsum - 2);
    g.begin_(); g.move(ax, ay - 1); g.line(lx, y + 4); g.stroke('#4A4A4E', g.hair * 1.5);
    g.begin_(); g.circle(ax, ay, 1.6); g.fill('#6A6A6E');
    // a dark band under the words so nothing behind them competes
    g.fillRect(x - 3, y - px, wsum + 6, px + 5, withAlpha(C.canvas, 0.86));
    g.runs(parts, x, y, px);
    return [x, y];
  }

  tag(g: Gfx, s: string, x: number, y: number, ink: string, edge: string): void {
    // (x moves with the placement)
    const w = g.width(s, SMALL) + 10;
    const at = this.placeAt(x, y, w, 16, 3, true);
    if (!at) return;
    const [xt, yy] = at;
    x = xt;
    g.fillRect(x, yy - 12, w, 16, withAlpha(C.canvas, 0.9));
    if (edge) { g.begin_(); g.rect(x + 0.5, yy - 11.5, w - 1, 15); g.stroke(withAlpha(edge, 0.7), 1); }
    g.text(s, x + 5, yy, ink, SMALL);
  }

  private draw(g: Gfx, now: number): void {
    const f = this.f, cam = f.cam, c = f.census, w = f.world, fl = f.floor;
    // the semantic zoom: fleet (titles, group names, the callout), group (a lane open, or z ≥ 1.4:
    // stat lines and names), repo (z ≥ 2.4: sub-rows and apps); the ladder thins the words (q1
    // fewer job names, q2 no counts, q3 no names): titles and failures always stay
    const level = fl.level;
    const detail = level >= 1;
    const q = f.budget.quality;
    const jobsPer = !detail ? 0 : q === 0 ? 3 : q === 1 ? 2 : 0;
    // fx-lanes: the lanes' names first (one each, on its road, in its hue)
    this.laneNames(g);
    // the stage titles: one run each at fleet zoom (their numbers on hover, `stageHover`), with
    // their stat lines once zoomed in; anchored at each stage's back edge, lifted into the band
    if (!detail && fl.on) this.titleRow(g);
    else for (const st of STAGES) {
      const A = STAGE_AT[st.n]!;
      const [u, v, z] = (fl.on ? WALL_AT[st.n] : null) ?? A.at;
      const ax = cam.x(u, v), ay = cam.y(u, v, z);
      const tw = g.width(st.title, TITLE, true);
      const x = Math.round(ax - 3);
      if (!detail) {
        const y = this.place(x, Math.round(ay - 16), tw, 18, 8);
        if (y < 60) continue;
        g.vline(g.crisp(ax), y + 4, ay - 1, '#3A3A3E');
        g.begin_(); g.circle(ax, ay, 1.6); g.fill('#6A6A6E');
        g.fillRect(x - 4, y - TITLE, tw + 8, TITLE + 6, withAlpha(C.canvas, 0.8));
        g.text(st.title, x, y, C.ink, TITLE, true);
        f.w2.notch(g, st.n, x + tw + 6, y); // fab-w2: the stage's trend notch
        this.stageHit(g, x - 3, y - 14, tw + 6, 20, st.n, A.fly, st.title);
        continue;
      }
      const lines = this.stageHover(st.n);
      const sub = lines.slice(1, 2).join('');
      const l1 = g.width(`${st.n} `, SMALL) + tw;
      const wv = Math.max(l1, g.width(sub, SMALL));
      // two lines placed as one block, so a neighbour's second line never lands on ours
      const yb = this.place(x, Math.round(ay - 34), wv, 36, 8);
      if (yb < 60) continue;
      const y = yb - 17;
      g.vline(g.crisp(ax), yb + 3, ay - 1, '#4A4A4E');
      g.begin_(); g.circle(ax, ay, 1.8); g.fill('#7A7A7E');
      g.fillRect(x - 4, y - TITLE, wv + 8, 38, withAlpha(C.canvas, 0.86));
      g.runs([[`${st.n} `, C.ink3], [st.title, C.ink, true]], x, y, TITLE);
      f.w2.notch(g, st.n, x + l1 + 6, y); // fab-w2: the stage's trend notch
      g.text(sub, x, y + 17, st.n === '04' && c.redLines ? C.redText : st.n === '06' && c.building ? C.amberText : C.ink2, SMALL);
      this.stageHit(g, x - 3, y - 14, wv + 6, 36, st.n, A.fly, st.title);
    }
    // the focal story: the newest commit that broke a main line, named over its car (one run; its
    // sha, author and age on the car's hover)
    const fc = c.focal, at = fl.focalAt;
    if (fc && at && !f.selected) {
      const ax = cam.x(at[0], at[1]), ay = cam.y(at[0], at[1], 8);
      const name = fc.repo.split('/')[1] ?? fc.repo;
      this.leader(g, ax, ay, 40, f.coffee.focalParts(fc.repo, name), SMALL); // w2-glance2: "broke main · 12m" only < 1 h red, else "name · red 7h" (REVIEW-iter3 #6)
    }
    // an open lane names its cells, posts and age axis (a lens pins one at the fleet zoom too)
    if (detail || fl.focusId) this.lanes(g, level, q);
    if (!detail) return;
    this.machines(g, now, jobsPer);
    this.places(g, q);
  }

  /** fx-front: the fleet zoom's stage titles, ONE row (review iter-2 #7) on one baseline.
   *  w2-chrome (REVIEW-iter3 #12): each title is centred over its OWN board (every stage has one,
   *  front.ts BOARDS), pushed apart only as much as the order needs (the least total shift:
   *  pool-adjacent-violators), and its leader runs to its board's LEFT FOOT: from the title's left
   *  end (a level jog when the board starts left of it) down the board's left edge to its base,
   *  never to a now pillar (every board's right edge). `titleSpans` keeps where they went. */
  titleSpans: { n: string; s: string; x: number; w: number; y: number }[] = [];
  private titleRow(g: Gfx): void {
    const f = this.f, cam = f.cam;
    const yT = Math.round(Math.max(BAND_H + 12, cam.y(0, 0, TITLE_Z)));
    const NOTCH = 12, GAP = 16;
    type T = { n: string; parts: [string, string][]; w: number; ws: number[]; p: number; x: number; fx: number; fy0: number; fy1: number };
    const ts: T[] = [];
    for (const r of TITLE_ROW) {
      const ws = r.parts.map(([s]) => g.width(s, TITLE, true) + NOTCH);
      const w = ws.reduce((a, b) => a + b, 0) + (ws.length - 1) * 4;
      const b = BOARDS.find((x) => x.stage === r.n);
      if (b) {
        const x0 = cam.x(b.u0, 0), x1 = cam.x(b.u1, 0);
        ts.push({ n: r.n, parts: r.parts, w, ws, p: (x0 + x1) / 2 - w / 2, x: 0, fx: x0, fy0: cam.y(b.u0, 0, b.z1), fy1: cam.y(b.u0, 0, b.z0) });
      } else if (r.at) {
        const [u, v, z] = r.at, ax = cam.x(u, v), ay = cam.y(u, v, z);
        ts.push({ n: r.n, parts: r.parts, w, ws, p: ax - w / 2, x: 0, fx: ax, fy0: ay, fy1: ay });
      }
    }
    // pool adjacent violators on p − offset: the least-squares placement that keeps the order
    const off: number[] = [];
    let acc = 0;
    for (const t of ts) { off.push(acc); acc += t.w + GAP; }
    const blocks: { s: number; n: number; i0: number }[] = [];
    ts.forEach((t, i) => {
      blocks.push({ s: t.p - off[i]!, n: 1, i0: i });
      while (blocks.length > 1 && blocks[blocks.length - 2]!.s / blocks[blocks.length - 2]!.n > blocks[blocks.length - 1]!.s / blocks[blocks.length - 1]!.n) {
        const b = blocks.pop()!, a = blocks[blocks.length - 1]!;
        a.s += b.s; a.n += b.n;
      }
    });
    blocks.forEach((b) => { for (let i = b.i0; i < b.i0 + b.n; i++) ts[i]!.x = b.s / b.n + off[i]!; });
    // inside the canvas
    const lo = 6 - Math.min(0, ...ts.map((t) => t.x - 6)), hi = Math.max(0, ...ts.map((t) => t.x + t.w - (cam.W - 40)));
    for (const t of ts) t.x += lo > 6 ? lo - 6 : -hi;
    this.titleSpans = [];
    const LEAD = '#3E3E43';
    for (const t of ts) {
      const x = Math.round(t.x), yl = yT + 5;
      // the leader: from the title's left end (or straight down, when the board starts under the
      // title) to the board's left foot, along the board's left edge
      const lx = g.crisp(t.fx);
      if (t.fy1 > yl + 2) {
        const xa = Math.min(lx, x + 2), xb = Math.max(lx, x + 2);
        if (xb - xa > 1) { g.begin_(); g.move(xa, yl + 0.5); g.line(xb, yl + 0.5); g.stroke(LEAD, g.hair); }
        g.vline(lx, yl, t.fy1, LEAD);
        g.begin_(); g.circle(t.fx, t.fy1, 1.6); g.fill('#6A6A6E');
      }
      g.fillRect(x - 4, yT - TITLE, t.w + 8, TITLE + 6, withAlpha(C.canvas, 0.8));
      let cx = x;
      t.parts.forEach(([s, n], j) => {
        g.text(s, cx, yT, C.ink, TITLE, true);
        const sw = t.ws[j]! - NOTCH;
        f.w2.notch(g, n, cx + sw + 4, yT); // fab-w2: the stage's trend notch
        cx += t.ws[j]! + 4;
      });
      const A = STAGE_AT[t.n]!;
      this.list.push({ x: x - 2, y: yT, w: t.w + 4, h: TITLE + 3 });
      this.titleSpans.push({ n: t.n, s: t.parts.map(([s]) => s).join(' '), x, w: t.w, y: yT });
      this.stageHit(g, x - 3, yT - 14, t.w + 6, 20, t.n, A.fly, t.parts.map(([s]) => s).join(' '));
    }
  }

  private stageHit(g: Gfx, x: number, y: number, w: number, h: number, n: string, fly: string, title: string): void {
    void g;
    const hits = this.f.fx.hits, before = hits.length;
    this.f.hit(x, y, w, h, 'stage', fly, title);
    if (hits.length > before) this.hov.set(hits[hits.length - 1]!, this.stageHover(n));
  }

  /** The machines' names and gauges, and the busy bays' jobs (group zoom and closer). */
  private machines(g: Gfx, now: number, jobsPer: number): void {
    const f = this.f, cam = f.cam, c = f.census, w = f.world;
    c.groups.forEach((gr, gi) => {
      if (this.f.plant.label(g, gr, gi)) return; // fab-w6: the machine's name on its wall (its numbers are the wall, the lit bays, the gauges)
      const v0 = ENG_V0 + gi * ENG_STEP;
      const x = cam.x(ENG_U0 + 6, v0 + ENG_DV) + 4, y = cam.y(ENG_U0 + 6, v0 + ENG_DV, 0) + 16;
      const util = gr.slots ? Math.round((gr.running.length / gr.slots) * 100) : 0;
      const gauges = gr.cpu >= 0 ? `cpu ${Math.round(gr.cpu)}% · mem ${Math.round(gr.mem)}%` : gr.hosted ? 'hosted' : 'no gauges';
      const parts: [string, string, boolean?][] = [[gr.name, gr.online ? C.ink : C.ink3, true], [`  ${gr.hosted ? `${gr.running.length} running` : `${gr.running.length}/${gr.slots} · ${util}%`}`, gr.running.length ? C.amberText : C.ink3], [`  ${gauges}`, C.ink3]];
      let wsum = 0; for (const [s, , b] of parts) wsum += g.width(s, SMALL, !!b);
      const at = this.placeAt(x, y, wsum, 14, 2, true);
      let xx = x, yy = y;
      if (at) [xx, yy] = at; else this.list.push({ x, y, w: wsum, h: 14 });
      g.fillRect(xx - 3, yy - 11, wsum + 6, 15, withAlpha(C.canvas, 0.82));
      g.runs(parts, xx, yy, SMALL);
      this.f.hit(xx - 3, yy - 11, wsum + 6, 15, 'engine', `915,${v0 + ENG_DV / 2},2.4`, gr.name);
    });
    // busy bays: the job's repo and how long it has run (red over 1.5× typical); the ones that
    // matter most first (overruns, then the longest running)
    const busyBays = this.f.bays.filter((b) => b.pid && w.pipelines.get(b.pid));
    const el = (b: Bay) => { const p = w.pipelines.get(b.pid)!; return p.started ? Math.max(0, now - p.started) : 0; };
    const over = (b: Bay) => { const p = w.pipelines.get(b.pid)!; return p.expected_ms ? el(b) / p.expected_ms : 0; };
    busyBays.sort((a, b) => (over(b) > 1.5 ? 1 : 0) - (over(a) > 1.5 ? 1 : 0) || el(b) - el(a));
    const perMachine = new Map<number, number>();
    const named = busyBays.filter((b) => {
      if (b.pid === this.f.hoverId) return true;
      const n = perMachine.get(b.group) ?? 0;
      if (n >= jobsPer) return false;
      perMachine.set(b.group, n + 1);
      return true;
    });
    named.sort((a, b) => a.group - b.group || a.slot - b.slot);
    for (const b of named) {
      const p = w.pipelines.get(b.pid)!;
      const e = el(b), exp = p.expected_ms ?? 0;
      const name = p.repo.split('/')[1] ?? p.repo;
      const ax = cam.x(b.u + b.du * 0.5, b.v), ay = cam.y(b.u + b.du * 0.5, b.v, ENG_H);
      const step = runningStep(p);
      this.leader(g, ax, ay, 18 + (b.slot % 2) * 16, [[name, C.ink], [` ${dur(e)}`, exp && e > exp * 1.5 ? C.redText : C.amberText], [step.length >= 3 ? ` · ${step}` : '', C.ink3]], SMALL);
    }
  }

  /** The lanes' names (fx-lanes; REVIEW-iter2 #2, overseer notes 7–8): one per lane, centred in its
   *  lane at its approach road's midpoint (floor.ts `roadMid`), in the lane's hue at L 0.80, an org
   *  lane's name after a dim ◇ (a stroked glyph: no extra text run). A lane under 16 px deep at the
   *  fleet zoom goes unnamed (its road's hover names it); nothing hangs off the screen's left edge;
   *  the bots' hatch names the siding at the fleet zoom. */
  private laneNames(g: Gfx): void {
    const f = this.f, fl = f.floor, cam = f.cam;
    if (!fl.on) return;
    const G = floorGroups();
    const fleet = fl.level === 0 && !fl.focusId;
    for (const L of fl.lanesNow) {
      const lane = G.lane(L.id);
      if (!lane || (lane.kind === 'bots' && fleet)) continue;
      const [u, v] = fl.roadMid(L);
      const px = Math.abs(cam.y(u, L.b1) - cam.y(u, L.b0));
      if (px < (fleet ? 16 : 13)) continue;
      const org = lane.kind === 'org';
      const name = org ? lane.bare : lane.short;
      const gw = org ? 11 : 0, wv = g.width(name, SMALL), w = gw + wv;
      const ax = cam.x(u, v), ay = cam.y(u, v);
      if (ax < -w || ay < 40 || ay > cam.H - 30) continue;
      const x = Math.max(6, Math.round(ax - w / 2)), y = Math.round(ay + 4);
      if (x + w > cam.W - 6) continue;
      const at = this.placeAt(x, y, w, 13, 0, false);
      if (!at) continue;
      g.fillRect(x - 3, y - 11, w + 6, 15, withAlpha(C.canvas, 0.74));
      if (org) {
        // ◇: the group is an org (its repos have no app team), dim
        const cx = x + 4, cy = y - 4;
        g.begin_(); g.move(cx, cy - 4); g.line(cx + 4, cy); g.line(cx, cy + 4); g.line(cx - 4, cy); g.ctx.closePath(); g.stroke(withAlpha(L.tint.ink, 0.5), 1.1);
      }
      g.text(name, x + gw, y, L.tint.ink, SMALL);
    }
  }

  /** The lanes' words at group zoom: the phases over the yard, the open lane's cell counts, its
   *  age axis and its red posts' names; with the lane open (fx-lanes: the group level, §F), its
   *  sub-rows' repos and "+N", the phases' counts and the age bays' ends. */
  private lanes(g: Gfx, level: number, q: number): void {
    const f = this.f, cam = f.cam, fl = f.floor;
    const lanes = fl.lanesNow, cnt = fl.data.last;
    if (!lanes.length) return;
    void level;
    const L = lanes[fl.lanes.index(fl.focusId)];
    const info = L ? cnt.lanes.get(L.id) : undefined;
    const rows = !!L && !!info && fl.subRowsOn(L);
    // the phases, along the yard's back edge (an open lane: its counts with them)
    if (q < 3) PHASES.forEach((ph, r) => {
      const s = rows && info ? `${ph} ${info.cells[r].n}` : ph;
      const x = cam.x(ROW_U[r] - LANE_U.CELL_DU / 2 + 4, LANE_V0), y = cam.y(ROW_U[r] - LANE_U.CELL_DU / 2 + 4, LANE_V0) - 4;
      const yy = this.place(x, y, g.width(s, SMALL), 13, 1);
      if (yy >= 0) g.text(s, x, yy, C.ink3, SMALL);
    });
    if (!L || L.s.stripe || !info) return;
    if (rows) {
      // the sub-rows: each repo's name at the row's start (red: its main is red), the rest as "+N"
      const rs = fl.rowsOf(L, info);
      for (const r of rs) {
        const v = (r.v0 + r.v1) / 2;
        const x = cam.x(YARD_U0 - 2, v), y = cam.y(YARD_U0 - 2, v) + 4;
        const s = r.repo ? r.repo.name : `+${r.more} more`;
        const wv = g.width(s, SMALL);
        const yy = this.place(x - wv, y, wv, 13, 0);
        if (yy < 0) continue;
        g.fillRect(x - wv - 2, yy - 10, wv + 4, 13, withAlpha(C.canvas, 0.75));
        g.text(s, x - wv, yy, r.repo ? (r.repo.post.st === 0 ? C.redText : C.ink2) : C.ink3, SMALL);
      }
      // the age bays' ends over the first row's first cell: new → old, left → right
      const r0 = rs[0];
      if (r0 && q < 2) {
        const u0 = ROW_U[0] - LANE_U.CELL_DU / 2 + 4, u1 = ROW_U[0] + LANE_U.CELL_DU / 2 - 4;
        for (const [s, u, right] of [[AGE_WORDS[0]!, u0, false], [AGE_WORDS[AGE_WORDS.length - 1]!, u1, true]] as [string, number, boolean][]) {
          const wv = g.width(s, SMALL), x = cam.x(u, r0.v0) - (right ? wv : 0), y = cam.y(u, r0.v0) - 3;
          const yy = this.place(x, y, wv, 13, 0);
          if (yy >= 0) g.text(s, x, yy, C.ink3, SMALL);
        }
      }
    }
    const inRows = rows ? new Set(fl.rowsOf(L, info).map((r) => r.repo?.repo ?? '')) : null;
    // the cells' counts over their stacks
    if (q < 2 && !rows) info.cells.forEach((C_, r) => {
      if (!C_.n) return;
      const u = ROW_U[r], v = (L.s.cell0 + L.s.cell1) / 2;
      const x = cam.x(u, v), y = cam.y(u, v, stackH(C_.n)) - 4;
      const s = String(C_.n), wv = g.width(s, SMALL, true);
      const yy = this.place(x - wv / 2, y, wv, 13, 1);
      if (yy >= 0) g.text(s, x, yy, C_.red >= C_.n / 2 ? C.redText : C.ink, SMALL, true, 'center');
    });
    // the red posts' repos (the newest red first), over their lamps (an open lane: those its rows
    // do not already name)
    const span = RAIL_U1 - RAIL_U0 - 8, max = Math.floor(span / 3.6);
    const list = info.posts.slice(0, max), pitch = Math.min(7, span / Math.max(1, list.length));
    let named = 0;
    list.forEach((p, j) => {
      if (p.st !== 0 || named >= (rows ? 4 : 8) || inRows?.has(p.repo)) return;
      const u = RAIL_U0 + 4 + j * pitch, v = L.s.curb;
      const x = cam.x(u, v), y = cam.y(u, v, 16) - 2;
      const wv = g.width(p.name, SMALL);
      const at = this.placeAt(x - 2, y, wv, 13, 6, true);
      if (!at) return;
      named++;
      g.fillRect(at[0] - 2, at[1] - 10, wv + 4, 13, withAlpha(C.canvas, 0.8));
      g.text(p.name, at[0], at[1], C.redText, SMALL);
    });
  }

  /** The tracks' and districts' names, and closer in the apps' names. */
  private places(g: Gfx, q: number): void {
    const f = this.f, cam = f.cam, c = f.census;
    if (q < 3) VIAS.forEach((via, i) => {
      const x = cam.x(SCAN_U + 16, TRACK_V[i] - 30), y = cam.y(SCAN_U + 16, TRACK_V[i] - 30) - 2;
      const s = `${VIA_WORDS[via]} ${c.flow.byVia[via] ?? 0}/h`;
      const yy = this.place(x, y, g.width(s, SMALL), 13, 0);
      if (yy >= 0) g.text(s, x, yy, C.ink3, SMALL);
    });
    for (const d of this.f.districtBox) {
      const x = cam.x(d.u0, d.v1) - 2, y = cam.y(d.u0, d.v1) + 12;
      const s = `${d.team} ${d.n}`;
      const yy = this.place(x, y, g.width(s, SMALL), 13, 0);
      if (yy >= 0) {
        g.fillRect(x - 2, yy - 10, g.width(s, SMALL) + 4, 13, withAlpha(C.canvas, 0.75));
        g.text(s, x, yy, C.ink2, SMALL);
        this.f.hit(x - 2, yy - 10, g.width(s, SMALL) + 4, 13, 'district', `${(d.u0 + d.u1) / 2},${(d.v0 + d.v1) / 2},3.2`, d.team);
      }
    }
    if (cam.zoom >= 2.6) {
      // apps by name, whole names only: those that deployed today first, then the rest while
      // the placer finds room (never a cut name)
      if (this.nameOrderAt !== c.at || this.nameOrder.length !== this.f.blocks.length) {
        this.nameOrderAt = c.at;
        this.nameOrder = [...this.f.blocks].sort((a, b) => (c.deploys24.get(b.id) ?? 0) - (c.deploys24.get(a.id) ?? 0));
      }
      let n = 0;
      const most = [48, 24, 12, 0, 0][q];
      for (const b of this.nameOrder) {
        if (n >= most) break;
        const x = cam.x(b.u + b.d, b.v + b.d / 2) + 3, y = cam.y(b.u + b.d, b.v + b.d / 2, b.h) + 4;
        if (x < 0 || x > cam.W - 380 * (this.f.selected ? 1 : 0) - 8 || y < 60 || y > cam.H - 70) continue;
        const wv = g.width(b.id, SMALL);
        if (this.place(x, y, wv, 13, 0) < 0) continue;
        g.fillRect(x - 2, y - 10, wv + 4, 13, withAlpha(C.canvas, 0.78));
        g.text(b.id, x, y, (c.deploys24.get(b.id) ?? 0) > 0 ? C.ink2 : C.ink3, SMALL);
        n++;
      }
    }
  }

  /** The old always-on key (retired: the key is on demand, legend.ts; factory.ts still asks
   *  behind `lens.legacyKey`, which is off). */
  legend(g: Gfx, f: Frame): void { void g; void f; }

  /** The idle floor (no fleet yet): the stage titles only, quiet. */
  idle(g: Gfx): void {
    const cam = this.f.cam;
    for (const n of ['01', '02', '04', '06', '07', '09']) {
      const [u, v, z] = STAGE_AT[n]!.at;
      const s = STAGES.find((x) => x.n === n)!.title;
      const x = Math.round(cam.x(u, v) - 3), y = Math.round(cam.y(u, v, z) - 16);
      g.vline(g.crisp(cam.x(u, v)), y + 4, cam.y(u, v, z) - 1, '#2E2E30');
      g.text(s, x, y, C.ink3, TITLE, true);
    }
  }
}

/** The camera buttons' glyphs (+, −, ⌂) as strokes, not text (the fleet's text budget). */
export function glyph(g: Gfx, s: string, cx: number, cy: number, col: string): void {
  g.begin_();
  if (s === '+' || s === '−') { g.move(cx - 4.5, cy); g.line(cx + 4.5, cy); if (s === '+') { g.move(cx, cy - 4.5); g.line(cx, cy + 4.5); } }
  else if (s === '⌂') { g.move(cx - 5, cy - 0.5); g.line(cx, cy - 5.5); g.line(cx + 5, cy - 0.5); g.move(cx - 3.5, cy - 1.5); g.line(cx - 3.5, cy + 4.5); g.line(cx + 3.5, cy + 4.5); g.line(cx + 3.5, cy - 1.5); }
  else { g.text(s, cx, cy + 4, col, 12, false, 'center'); return; }
  g.stroke(col, 1.3);
}
