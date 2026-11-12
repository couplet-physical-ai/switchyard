// The info layer (DESIGN.md, "Rendering"): everything that changes at the speed of the fleet,
// not of the animation — counts, captions, main-line dots, the heatmap, the apps, NOW, COMING,
// the last hour's pulse, the busiest repos. It is a canvas of its own whose bitmap is kept
// between draws, cut into panels: a draw redraws only the panels whose content key changed
// (clearRect + paint of that rectangle), so a label is rendered once and then simply stays,
// the way a game caches its UI atlas. A level-of-detail change crossfades a panel over 150 ms.

import type { Pipeline, Repo, Step } from '../wire.ts';
import type { World } from '../world.ts';
import type { Timeline } from '../timeline.ts';
import type { Quality } from './budget.ts';
import type { Ctx2D } from '../../app.contract.d.ts';
import { Gfx, arrow, chip, times } from './gfx.ts';
import { HashCtx } from './hashctx.ts';
import { CELL_H, type Lane, type MainRow, type Rect, type Scene, enginesOf } from './layout.ts';
import { type Level, type LodBook } from './lod.ts';
import { type Aggregates, type Run, S_GREEN, S_NONE, S_PEND, S_RED, S_RUN, S_STALE, STUCK_MS, busiest, buildingIds, isRed, lastHour, mainStory, orgSpark, queueTruth, thousands } from './select.ts';
import type { StressFleet } from './stress.ts';
import { C, T, TAU, clamp, withAlpha } from './theme.ts';

export type View = {
  w: World; S: Scene; tl: Timeline; agg: Aggregates; lod: LodBook; stress: StressFleet;
  /** The module clock (animation) and the playhead (server ms, what the world shows). */
  t: number; now: number;
  q: Quality; offsetMin: number;
  /** The NOW band's pipeline (picked by the live layer's focus rules). */
  focus: Pipeline | null;
};

/** `every`: the least time between two redraws of the panel (ms); a change sooner waits for the
 *  next draw after it (the 250 ms tick), so a busy fleet cannot redraw a big panel every frame. */
type Panel = { id: string; rect: Rect; key: number; every?: number; draw: (g: Gfx, v: View, r: Rect) => void; parts?: (v: View, r: Rect) => Part[] };
/** A piece of a panel drawn on its own (a main line's row): it sets every state it uses.
 *  p5-yard: a part may carry a key (a number, and up to two objects compared by identity) that
 *  stands for everything it draws; a part whose key, objects and band are the ones it had last
 *  time is not run at all (not even hashed): its last hash and box stand. NaN: no key. */
type Part = ((g: Gfx) => void) & { band?: readonly [number, number]; key?: number; of?: unknown; of2?: unknown };
/** A part drawn only inside a horizontal band of its panel, the whole width (a main line's row):
 *  its box is the band, so a repaint clips at the bands' edges, where no ink crosses (a clip
 *  through a shape antialiases it a little differently: Skia does). */
function banded(f: (g: Gfx) => void, y0: number, y1: number): Part {
  const p = f as Part;
  p.band = [y0, y1];
  return p;
}
/** What a panel (or each of its parts) painted last: its calls' hash and the box they ink;
 *  p5-yard: each part's key and objects (NaN: none) and whether it leaned on its neighbours. */
type Drawn = { h1: Int32Array; h2: Int32Array; box: Float64Array; n: number; banded?: boolean; keys: Float64Array; objs: unknown[]; inh: Uint8Array };
/** A part keyed (p5-yard): `f` with its band, key and the objects it draws (compared by identity). */
function keyed(p: Part, key: number, of: unknown, of2?: unknown): Part {
  p.key = key; p.of = of; p.of2 = of2;
  return p;
}

const h = (a: number, b: number) => (Math.imul(a ^ 0x5bd1e995, 31) + b) | 0;
const hs = (a: number, s: string) => { for (let i = 0; i < s.length; i++) a = h(a, s.charCodeAt(i)); return h(a, s.length); };
/** What the engines panel prints that follows the clock: each running job's age ("42s", then
 *  "3m") and its slowness, an offline machine's "last seen". Its key, in place of the second: the
 *  panel is redrawn when one of those words changes, not every second for a word that did not. */
function enginesClock(v: View): number {
  const { w, now } = v;
  let k = 0;
  for (const e of w.engines.values()) {
    if (e.last_seen && e.online === false) k = hs(k, fmtDur(now - e.last_seen));
    for (const pid of e.running) {
      const p = w.pipelines.get(pid);
      const el = p?.started ? now - p.started : 0;
      const exp = p?.expected_ms ?? w.repos.get(p?.repo ?? '')?.p50_build_ms ?? 0;
      k = h(hs(k, fmtShort(el)), exp > 0 && el > exp * 1.5 ? 1 : 0);
    }
  }
  return k;
}

export class InfoLayer {
  private keys = new Map<string, number>();
  private drawnAt = new Map<string, number>();
  private sceneKey = '';
  /** Where NOW's running step chip is (the live layer bobs a packet over it). */
  activeChip = { x: -1, y: 0 };
  // p3-yard: what each panel painted last (its calls' hash, per part), and where its rect was
  private drawn = new Map<string, Drawn>();
  private rects = new Map<string, string>();
  private gh = new Gfx();
  private hc = new HashCtx();
  /** For the bench and the tests: panels asked, skipped as unchanged, repainted in parts, whole. */
  stats = { asked: 0, same: 0, parts: 0, whole: 0, partsDrawn: 0, partsKept: 0, partsHashed: 0 };
  /** Off: every part is hashed, keyed or not, as before p5-yard (tests compare). */
  static keys = true;
  /** Off: every panel whose key moved is repainted whole, as before p3-yard (tests compare). */
  static gate = true;
  gate = InfoLayer.gate;
  static debug = false;

  /** Draws the dirty panels; returns true while a crossfade wants more frames. */
  draw(g: Gfx, v: View, full: boolean): boolean {
    const S = v.S;
    const panels = this.panels(v);
    if (S.key !== this.sceneKey) {
      this.sceneKey = S.key;
      // A new scene with every panel where it was (the main lines' rows picked again, say):
      // each panel is asked again and repaints only what changed. Moved panels: all of it.
      let moved = false;
      for (const p of panels) { const rk = `${p.rect.x},${p.rect.y},${p.rect.w},${p.rect.h}`; if (this.rects.get(p.id) !== rk) { moved = true; if (InfoLayer.debug) console.log(`info: ${p.id} moved ${this.rects.get(p.id)} -> ${rk}`); } this.rects.set(p.id, rk); }
      if (moved || !this.gate) full = true;
      else this.keys.clear();
    }
    if (full) {
      g.clear(0, 0, S.W, S.H); this.keys.clear(); this.drawn.clear();
      for (const p of panels) this.rects.set(p.id, `${p.rect.x},${p.rect.y},${p.rect.w},${p.rect.h}`);
    }
    const fading = v.lod.animating(v.t);
    for (const p of panels) {
      const old = this.keys.get(p.id);
      const fadeKey = fading ? (v.t | 0) : 0;
      const key = h(p.key, fadeKey);
      if (old === key) continue;
      if (!full && p.every && old !== undefined && v.t - (this.drawnAt.get(p.id) ?? -1e9) < p.every) continue;
      this.keys.set(p.id, key);
      this.drawnAt.set(p.id, v.t);
      const r = p.rect;
      if (!this.gate) {
        if (!full) g.clear(r.x, r.y, r.w, r.h);
        p.draw(g, v, r);
        continue;
      }
      this.paint(g, v, p, full);
    }
    return fading;
  }

  /** One panel whose key moved: its calls hashed first (nothing sent); the same calls as last
   *  time paint nothing; in parts, only the boxes of the parts that changed are cleared and
   *  painted again, clipped, with every part that inks in them, in order: the same pixels as a
   *  whole repaint. A part that leans on its neighbours' state, a new list of parts, or most of
   *  them changed: the panel is repainted whole. */
  private paint(g: Gfx, v: View, p: Panel, full: boolean): void {
    const r = p.rect;
    this.stats.asked++;
    const parts: Part[] = p.parts ? p.parts(v, r) : [(gg: Gfx) => p.draw(gg, v, r)];
    const n = parts.length;
    const gh = this.gh, hc = this.hc;
    gh.shareAdvances(g);
    hc.measurer = g.ctx;
    gh.begin(hc as unknown as Ctx2D, g.px);
    const now: Drawn = { h1: new Int32Array(n), h2: new Int32Array(n), box: new Float64Array(n * 4), n, keys: new Float64Array(n), objs: new Array<unknown>(n * 2), inh: new Uint8Array(n) };
    // p5-yard: a keyed part with the key, objects and band it had at this index last time is
    // not run: its last hash and box stand (only after a part that left the baseline state, so
    // the next part is hashed from where it would have been)
    const old = full || !InfoLayer.keys ? undefined : this.drawn.get(p.id);
    const prev = old && old.n === n ? old : undefined;
    let alone = true;
    for (let i = 0; i < n; i++) {
      const part = parts[i], k = part.key ?? NaN, band = part.band;
      now.keys[i] = k; now.objs[i * 2] = part.of; now.objs[i * 2 + 1] = part.of2;
      if (prev && prev.keys[i] === k && prev.objs[i * 2] === part.of && prev.objs[i * 2 + 1] === part.of2 && !prev.inh[i] && hc.baseline()
        && (!band || (prev.box[i * 4 + 1] === band[0] && prev.box[i * 4 + 3] === band[1]))) {
        now.h1[i] = prev.h1[i]; now.h2[i] = prev.h2[i];
        for (let j = i * 4; j < i * 4 + 4; j++) now.box[j] = prev.box[j];
        this.stats.partsKept++;
        continue;
      }
      this.stats.partsHashed++;
      hc.reset();
      part(gh);
      hc.end();
      if (hc.inherits) { alone = false; now.inh[i] = 1; }
      now.h1[i] = hc.h1; now.h2[i] = hc.h2;
      if (band) { now.box[i * 4] = r.x; now.box[i * 4 + 1] = band[0]; now.box[i * 4 + 2] = r.x + r.w; now.box[i * 4 + 3] = band[1]; }
      else { now.box[i * 4] = hc.x0; now.box[i * 4 + 1] = hc.y0; now.box[i * 4 + 2] = hc.x1; now.box[i * 4 + 3] = hc.y1; }
    }
    hc.measurer = null;
    const was = full ? undefined : this.drawn.get(p.id);
    this.drawn.set(p.id, now);
    if (was && was.n === n) {
      let same = true;
      for (let i = 0; i < n && same; i++) same = was.h1[i] === now.h1[i] && was.h2[i] === now.h2[i];
      if (same) { this.stats.same++; return; }
    }
    // All parts banded (disjoint bands, so their order does not matter): parts are matched by
    // band and calls, whatever their number (a queue one row longer repaints that row).
    let allBanded = true;
    for (let i = 0; i < n && allBanded; i++) allBanded = !!parts[i].band;
    let banded = alone && n > 1 && !!was && was.n > 1 && was.banded && allBanded;
    now.banded = allBanded;
    if (was && (was.n === n || banded) && n > 1 && alone) {
      // the changed parts' boxes, before and after, out to whole device pixels
      const px = g.px;
      const boxes: number[] = [];
      let changed = 0;
      const add = (b: Float64Array, i: number) => {
        // clamped to the panel (a whole repaint clears no more), out to whole device pixels
        const x0 = Math.max(r.x, b[i * 4]), y0 = Math.max(r.y, b[i * 4 + 1]), x1 = Math.min(r.x + r.w, b[i * 4 + 2]), y1 = Math.min(r.y + r.h, b[i * 4 + 3]);
        if (!(x1 > x0) || !(y1 > y0)) return;
        addBox(boxes, Math.floor(x0 * px) / px, Math.floor(y0 * px) / px, Math.ceil(x1 * px) / px, Math.ceil(y1 * px) / px);
      };
      if (banded) {
        const key = (d: Drawn, i: number) => `${d.box[i * 4 + 1]},${d.box[i * 4 + 3]},${d.h1[i]},${d.h2[i]}`;
        const olds = new Map<string, number>();
        for (let j = 0; j < was.n; j++) { const k = key(was, j); olds.set(k, (olds.get(k) ?? 0) + 1); }
        for (let i = 0; i < n; i++) {
          const k = key(now, i), c = olds.get(k) ?? 0;
          if (c > 0) olds.set(k, c - 1); else { changed++; add(now.box, i); }
        }
        const left = new Map<string, number>(olds);
        for (let j = 0; j < was.n; j++) { const k = key(was, j), c = left.get(k) ?? 0; if (c > 0) { left.set(k, c - 1); changed++; add(was.box, j); } }
        // the dirty bands under most of the panel: all of it
        let area = 0;
        for (let b = 0; b < boxes.length; b += 4) area += (boxes[b + 2] - boxes[b]) * (boxes[b + 3] - boxes[b + 1]);
        if (area > r.w * r.h * 0.7) banded = false, changed = n;
        else changed = 0;
      } else {
        for (let i = 0; i < n; i++) {
          if (was.h1[i] === now.h1[i] && was.h2[i] === now.h2[i]) continue;
          changed++;
          add(was.box, i); add(now.box, i);
        }
      }
      if (changed * 2 <= n) {
        this.stats.parts++;
        if (InfoLayer.debug) {
          const ch: string[] = [];
          for (let i = 0; i < Math.min(n, was.n); i++) if (was.h1[i] !== now.h1[i] || was.h2[i] !== now.h2[i]) ch.push(`${i}:[${[...was.box.slice(i * 4, i * 4 + 4)].map((x) => x.toFixed(1))}]->[${[...now.box.slice(i * 4, i * 4 + 4)].map((x) => x.toFixed(1))}]`);
          console.log(`info ${p.id} parts ${ch.join(' ')} boxes ${boxes.map((x) => x.toFixed(1)).join(',')}`);
        }
        const ctx = g.ctx;
        for (let b = 0; b < boxes.length; b += 4) {
          const bx0 = boxes[b], by0 = boxes[b + 1], bx1 = boxes[b + 2], by1 = boxes[b + 3];
          ctx.save();
          ctx.beginPath();
          ctx.rect(bx0, by0, bx1 - bx0, by1 - by0);
          ctx.clip();
          ctx.clearRect(bx0, by0, bx1 - bx0, by1 - by0);
          ctx.globalAlpha = 1;
          ctx.setLineDash([]);
          ctx.letterSpacing = '0px';
          g.ops += 8;
          for (let i = 0; i < n; i++) {
            const x0 = now.box[i * 4], y0 = now.box[i * 4 + 1], x1 = now.box[i * 4 + 2], y1 = now.box[i * 4 + 3];
            if (x1 <= bx0 || x0 >= bx1 || y1 <= by0 || y0 >= by1) continue;
            parts[i](g);
            this.stats.partsDrawn++;
          }
          ctx.restore();
          g.ops++;
        }
        return;
      }
    }
    this.stats.whole++;
    if (InfoLayer.debug) console.log(`info ${p.id} whole${full ? ' (full)' : was ? (was.n !== n ? ` (${was.n}→${n} parts)` : alone ? ' (most parts changed)' : ' (a part leans on its neighbours)') : ' (first)'}`);
    if (!full) g.clear(r.x, r.y, r.w, r.h);
    for (let i = 0; i < n; i++) parts[i](g);
  }

  private panels(v: View): Panel[] {
    const { S, w, t, now } = v;
    const sec = Math.floor(now / 1000), min = Math.floor(now / 60000);
    const kv = w.kv;
    const fade = (id: string) => (v.lod.fade(id, t).a < 1 ? (t | 0) : 0);
    const L = S.L, top = S.top;
    const stressT = v.stress.on ? Math.floor(t / 3000) : 0;
    // live, the header's clock is hh:mm and its hour's counts are by the minute (lastHour); its
    // other words follow the data (the queue's and engines' too). Replay, behind and paused show
    // seconds (the playhead, "behind live").
    const headClock = v.tl.mode === 'live' ? h(h(min, 7), h(kv.queue, kv.engine)) : h(sec, Math.floor(t / 1000));
    return [
      { id: 'header', rect: { x: 0, y: 0, w: S.dial.labelX - 150, h: S.header.h }, key: h(h(headClock, h(w.repos.size, v.tl.mode.length)), h((v.q << 4) | (v.stress.on ? 1 : 0) | (v.tl.speed === 1 ? 2 : 0), kv.app)) + kv.pipeline + kv.repo, draw: drawHeader },
      { id: 'sources', rect: { x: 0, y: top.y0 - 4, w: S.intake.x - 6, h: S.divY - 6 - (top.y0 - 4) }, key: h(h(kv.commit, min), h(S.sources.lod, fade('sources'))), draw: drawSources },
      { id: 'intake', rect: { x: S.intake.x - 6, y: top.y0 - 4, w: S.engines.x - S.intake.x, h: S.divY - 6 - (top.y0 - 4) }, key: h(h(kv.queue, kv.pipeline), Math.floor(now / 10000)), draw: drawIntake },
      { id: 'engines', rect: { x: S.engines.x - 4, y: top.y0 - 4, w: S.engines.w + 8, h: S.divY - 6 - (top.y0 - 4) }, key: h(h(h(kv.engine, kv.pipeline), enginesClock(v)), h(S.engines.lod, fade('lanes')) + stressT) + (tracksOn(v) ? 7 : 0), draw: (g, vv, r) => { drawEngines(g, vv, r); drawTracks(g, vv); }, parts: (vv, r) => [(g) => drawEngines(g, vv, r), (g) => drawTracks(g, vv)] },
      { id: 'gates', rect: { x: S.gates.x - 6, y: top.y0 - 4, w: S.bus.x - S.gates.x + 4, h: S.divY - 6 - (top.y0 - 4) }, key: h(h(kv.stats, kv.pr), min), draw: drawGates },
      { id: 'mains', rect: { x: S.mains.x0 - 4, y: top.y0 - 4, w: S.mains.x1 - S.mains.x0 + 8 + S.m - 4, h: S.mains.heat.y - 4 - (top.y0 - 4) }, key: h(h(kv.repo, min), h(kv.pipeline, fade('rows'))), every: v.stress.on ? 1000 : 400, draw: drawMains, parts: mainsParts },
      { id: 'heat', rect: { x: S.mains.x0 - 4, y: S.mains.heat.y - 4, w: S.mains.x1 - S.mains.x0 + 8, h: S.mains.heat.h + 6 }, key: h(v.agg.repos.sig, v.stress.on ? 1 : 0), every: 1000, draw: drawHeat },
      { id: 'apps', rect: { x: S.mains.x0 - 4, y: S.deploy.y - 16, w: S.mains.x1 - S.mains.x0 + 8, h: S.H - (S.deploy.y - 16) }, key: h(h(kv.app, kv.deploy), h(min, h(kv.stats, fade('apps')))), draw: drawApps },
      { id: 'now', rect: { x: L.x0 - 4, y: S.now.y - 4, w: L.x1 - L.x0 + 8, h: S.now.h + 6 }, key: h(h(kv.pipeline, sec), h(kv.repo, nowKey(v.focus))), draw: (g, vv, r) => this.drawNow(g, vv, r), parts: (vv, r) => this.nowParts(vv, r) },
      { id: 'queue', rect: { x: L.x0 - 4, y: S.queue.y - 4, w: L.x1 - L.x0 + 8, h: S.queue.h + 6 }, key: h(h(kv.queue, kv.pipeline), Math.floor(now / 10000)), draw: drawQueue, parts: queueParts },
      { id: 'pulse', rect: { x: S.pulse.x - 4, y: S.pulse.y - 4, w: S.pulse.w + 8, h: S.H - (S.pulse.y - 4) }, key: h(kv.pipeline, min), draw: drawPulse },
      { id: 'busy', rect: { x: S.busy.x - 4, y: S.busy.y - 4, w: S.busy.w + 8, h: S.H - (S.busy.y - 4) }, key: h(h(kv.pipeline, min), kv.repo), draw: drawBusy },
    ];
  }

  // ---- NOW: one pipeline up close ------------------------------------------------------------
  /** NOW as two banded parts (p3-yard): its first line, whose timer moves each second, and the
   *  rest (the steps, the main line), which seldom does. */
  private nowParts(v: View, r: Rect): Part[] {
    // (the first line's descenders end ~19 px down; the steps' bracket label starts ~24 px down)
    return [banded((g) => this.drawNow(g, v, r, 1), r.y, r.y + 22), banded((g) => this.drawNow(g, v, r, 2), r.y + 22, r.y + r.h)];
  }

  /** `only`: 1 the first line, 2 the rest, 0 all of it. */
  private drawNow(g: Gfx, v: View, r: Rect, only: 0 | 1 | 2 = 0): void {
    const { w, now, S } = v;
    const p = v.focus;
    if (only !== 1) this.activeChip.x = -1;
    const y1 = r.y + 16;
    if (!p) {
      if (only !== 2) g.runs([['NOW', C.ink3], [' · nothing building · every slot is free', C.ink3]], r.x + 4, y1, T.eyebrow, r.w);
      return;
    }
    const repo = w.repos.get(p.repo);
    const el = p.started ? now - p.started : 0;
    const eng = (p.engine ?? '').toLowerCase();
    let failStep = '';
    if (p.state === 'failure' || p.state === 'error') for (const wf0 of p.workflows ?? []) { const st = wf0.steps.find((z) => z.state === 'failure' || z.state === 'error'); if (st) { failStep = st.name; break; } }
    const where = p.state === 'running' ? `building on ${eng || (p.lane === 'gha' ? 'github actions' : 'roadrunner')} · ${fmtDur(el)}`
      : p.state === 'pending' ? `waiting ${fmtDur(now - p.created)}`
      : p.state === 'failure' || p.state === 'error' ? `broke main${failStep ? ` at ${failStep}` : ''} · ${fmtShort(now - (p.finished ?? now))} ago`
      : `${p.state} · ${fmtDur((p.finished ?? now) - (p.started ?? p.created))}`;
    const broke = p.state === 'failure' || p.state === 'error';
    const x0 = r.x + 4;
    if (only !== 2) {
    let x = g.eyebrow([['now', C.ink3]], x0, y1, T.eyebrow);
    // Whole tokens: the repo and what happened stay; the branch goes first, then the culprit.
    x = g.runs([[' · ', C.ink3, false, 10], [repo?.name ?? p.repo, C.ink, true], [p.lane === 'gha' ? ' (actions)' : ` #${p.number}`, C.ink2], [` · ${p.branch}`, C.ink3, false, -6], [` · ${where}`, broke ? C.redText : C.ink3, false, 8],
      [broke && p.author ? ` · ${p.sha.slice(0, 7)} ${p.author.replace(/\[bot\]$/, '')}` : '', C.ink3, false, 2]], x, y1, T.label, r.w - (x - x0) - 8);
    void x;
    }
    if (only === 1) return;
    // The right part: the repo's main line, its story in words.
    const split = Math.round(r.w * (r.w > 760 ? 0.6 : 0.56));
    const mx0 = r.x + split + 12, mx1 = r.x + r.w - 14;
    const cy = r.y + 52;
    const wf = p.workflows?.find((x2) => x2.state === 'running') ?? p.workflows?.find((x2) => x2.state === 'failure' || x2.state === 'error') ?? p.workflows?.[0];
    const steps: Step[] = wf?.steps ?? [];
    const labelX = x0, sx = x0 + 74;
    g.text(g.fit(wf?.name ?? 'pipeline', T.caption, 62), labelX, cy + 4, C.ink3, T.caption);
    arrow(g, x0 + 44 > sx - 24 ? sx - 24 : x0 + 44, sx - 4, cy, C.ink4);
    const limit = mx0 - 26;
    const groups = parallelGroups(steps);
    const labels = steps.map((st) => trim(st.name, 18) + (st.cached ? ' ⟳' : ''));
    const cw = (i: number) => Math.ceil(g.width(labels[i], T.chip)) + Math.round(T.chip * 1.1);
    let act = steps.findIndex((st) => st.state === 'running');
    if (act < 0) act = Math.max(0, steps.findIndex((st) => st.state !== 'success' && st.state !== 'skipped'));
    // A window of groups around the active step that fits; the rest folded into chips.
    const gi = groups.findIndex(([a, b]) => act >= a && act < b);
    let lo = Math.max(0, gi), hi = Math.max(lo + 1, gi + 1);
    const gw = (k: number) => { const [a, b] = groups[k]; let s = 0; for (let i = a; i < b; i++) s += cw(i) + (i < b - 1 ? 6 : 0); return s + 22; };
    let used = groups.length ? gw(lo) : 0;
    const fold = 70;
    while (true) {
      const canR = hi < groups.length && sx + used + gw(hi) + (lo > 0 ? fold : 0) + (hi + 1 < groups.length ? fold : 0) <= limit;
      const canL = lo > 0 && sx + used + gw(lo - 1) + (lo - 1 > 0 ? fold : 0) + (hi < groups.length ? fold : 0) <= limit;
      if (canR && (hi - gi <= gi - lo || !canL)) { used += gw(hi); hi++; }
      else if (canL) { lo--; used += gw(lo); }
      else break;
    }
    let cx = sx;
    if (lo > 0) {
      const done = groups[lo][0];
      cx += chip(g, `${done} done`, cx, cy, 'ok', T.chip);
      arrow(g, cx + 3, cx + 17, cy, C.ink4); cx += 20;
    }
    for (let k = lo; k < hi && k < groups.length; k++) {
      const [a, b] = groups[k];
      const gx0 = cx;
      let drawnTo = a;
      for (let i = a; i < b; i++) {
        // A wide parallel group folds what does not fit into "+N".
        if (cx + cw(i) > limit - (i < b - 1 ? 40 : 0)) break;
        const st0 = steps[i];
        const st = st0.state === 'success' ? 'ok' : st0.state === 'failure' || st0.state === 'error' ? 'bad' : st0.state === 'running' ? 'active' : st0.state === 'skipped' || st0.state === 'canceled' ? 'skip' : 'idle';
        const wdt = chip(g, labels[i], cx, cy, st, T.chip);
        if (st0.state === 'running' && this.activeChip.x < 0) { this.activeChip.x = cx + wdt / 2; this.activeChip.y = cy - 15; }
        cx += wdt + (i < b - 1 ? 6 : 0);
        drawnTo = i + 1;
      }
      if (drawnTo < b) { cx += chip(g, `+${b - drawnTo}`, cx, cy, 'idle', T.chip); }
      if (b - a > 1) {
        // Parallel steps: one bracket over them, "all at once", no arrows between.
        g.begin_(); g.move(gx0, cy - 13); g.line(gx0, cy - 16); g.line(cx, cy - 16); g.line(cx, cy - 13); g.stroke(C.ink4, 1);
        g.text('all at once', gx0 + 2, cy - 20, C.ink3, T.caption);
      }
      if (drawnTo < b) { hi = k + 1; break; }
      if (k < groups.length - 1) { arrow(g, cx + 3, cx + 17, cy, C.ink4); cx += 20; }
    }
    if (hi < groups.length) cx += chip(g, `+${steps.length - groups[hi][0]}`, cx, cy, 'idle', T.chip);
    const exp = p.expected_ms ?? repo?.p50_build_ms ?? w.stats.p50_build_ms ?? 0;
    const done = steps.filter((st) => st.state === 'success').length;
    const line: Run[] = [
      [`${done} of ${steps.length} steps`, C.ink2],
      [exp ? ` · typical ${fmtDur(exp)}` : '', C.ink3],
      [exp && el > exp * 1.5 && p.state === 'running' ? ` · ${fmtDur(el - exp)} over` : '', C.amberText],
      [` · ${p.lane === 'gha' ? 'github actions' : 'roadrunner'} · ${p.event === 'pull_request' ? `pull request${p.pr ? ` #${p.pr}` : ''}` : `push to ${p.branch}`}`, C.ink3],
    ];
    g.runs(line, sx, cy + 26, T.caption, limit - sx);
    if (repo) {
      const story = mainStory(repo, now, fmtDur);
      const tone = story.tone === 'red' ? C.redText : story.tone === 'green' ? C.greenInk : story.tone === 'amber' ? C.amberText : C.ink3;
      g.runs([[repo.name, C.ink, true], [' · main', C.ink3]], mx0, cy - 16, T.label, mx1 - mx0);
      mainLine(g, repo, mx0, mx1, cy + 2, 13, 4, 0, v.q, now, false);
      g.runs([[story.text, tone], [story.fix && story.tone === 'red' ? ` → ${story.fix}` : '', C.ink3]], mx0, cy + 26, T.caption, mx1 - mx0 + 10);
    }
  }
}

/** A pipeline's short handle: Woodpecker's number, or "gha" for a GitHub Actions run (its
 *  run id is eleven digits that say nothing). */
export function pnum(p: Pipeline): string {
  return p.lane === 'gha' ? 'gha ' : `#${p.number} `;
}

function nowKey(p: Pipeline | null): number {
  if (!p) return 0;
  let s = 0;
  const id = p.id ?? '';
  for (let i = 0; i < id.length; i++) s = (s * 31 + id.charCodeAt(i)) | 0;
  return s;
}

/** Steps whose run times overlap form one group ("all at once"); others are their own. */
export function parallelGroups(steps: Step[]): [number, number][] {
  const out: [number, number][] = [];
  let a = 0;
  for (let i = 1; i <= steps.length; i++) {
    const prev = steps[i - 1], cur = steps[i];
    const overlap = cur && prev && cur.started != null && prev.started != null && (prev.finished == null || cur.started < prev.finished - 250) && Math.abs(cur.started - prev.started) < Math.max(1500, ((prev.finished ?? cur.started) - prev.started) * 0.6);
    if (!overlap) { out.push([a, i]); a = i; }
  }
  return out.filter(([x, y]) => y > x);
}

// ---- header -------------------------------------------------------------------------------------
function drawHeader(g: Gfx, v: View, r: Rect): void {
  const { tl, w, S, now } = v;
  const y = S.header.y;
  const mode = tl.mode;
  // The mode keyword (the only uppercase on the line), then the headline (what is wrong, at
  // 20 px: the first thing read), then the numbers behind it in plain case.
  const tag: [string, string] = mode === 'live' ? ['live', C.green] : mode === 'paused' ? ['paused', C.packet] : mode === 'replay' ? ['replay', C.packet] : ['behind', C.amberText];
  let x = g.eyebrow([tag], S.m, y, T.eyebrow);
  if (v.stress.on) x = g.eyebrow([[' · stress 10×', C.redText]], x, y, T.eyebrow);
  x += 14;
  const reds = v.agg.repos.red;
  let down = 0, degraded = 0;
  for (const id of v.agg.apps.problems) { const hh = w.apps.get(id)?.health; if (hh === 'down') down++; else if (hh === 'degraded') degraded++; }
  const hl: Run[] = [];
  hl.push(reds ? [`${thousands(reds)} main ${reds === 1 ? 'line' : 'lines'} red`, C.redText, true] : ['every main line green', C.greenInk, true]);
  if (down) hl.push([' · ', C.ink3], [`${down} ${down === 1 ? 'app' : 'apps'} down`, C.redText, true]);
  else if (degraded) hl.push([' · ', C.ink3], [`${degraded} degraded`, C.amberText, true]);
  else hl.push([' · ', C.ink3], ['every app up', C.ink2, true]);
  const big = r.w > 900 ? T.headline : T.title + 2;
  x = g.runs(hl, x, y + (big > 16 ? 1 : 0), big, Math.max(0, r.w - x - 8)) + 16;
  const lh = lastHour(w, now);
  const qt = queueTruth(w);
  // Whole tokens only (fitTokens): the mode's words stay, then the hour's builds and failures,
  // then building and waiting; the repo count and the clock go first.
  const data: Run[] = [];
  if (mode === 'live') data.push([`${thousands(v.S.mains.heat.n)} repos`, C.ink3, false, -6], [` · ${fmtClock(now, v.offsetMin)}`, C.ink3, false, -7]);
  else if (mode === 'replay') data.push([`${fmtClock(tl.replayFrom, v.offsetMin)} → ${fmtClock(tl.replayTo, v.offsetMin)}`, C.amberText, false, 9], [` · at ${fmtClock(tl.playhead, v.offsetMin)}`, C.amberText, false, 10], [' · 60×', C.amberText, false, -5]);
  else data.push([`${fmtDur(tl.behindMs())} behind live`, C.amberText, false, 10], [mode === 'behind' ? ` · ${tl.speed === 1 ? '1×' : '¼×'}` : ' · frozen', C.amberText, false, 8]);
  data.push([` · last hour ${lh.total} builds`, C.ink3, false, 6], [`, ${lh.failed} failed`, C.ink3, false, 5], [` · ${buildingIds(w).size} building`, C.ink3, false, 4], [` · ${qt.waiting} waiting`, C.ink3, false, 3]);
  g.runs(data, x, y, T.caption, Math.max(0, r.w - x - 8));
}

// ---- sources ------------------------------------------------------------------------------------
function drawSources(g: Gfx, v: View, r: Rect): void {
  const { S, w, now, t } = v;
  const src = S.sources;
  let total = 0, best = '', bestN = -1;
  for (const row of src.rows) { const n = w.rate(row.org, now); total += n; if (n > bestN) { bestN = n; best = row.label; } }
  if (src.lod >= 2) { total = 0; for (const o of w.pushes.keys()) total += w.rate(o, now); }
  stationHead(g, S, src.x, S.intake.x - src.x - 12, 'sources', ' · pushes an hour', [[`${total}/h`, C.amberText], [best && src.lod < 2 ? ` · ${best} busiest` : ` · ${S.stress ? v.stress.orgLabels.length : S.sources.rows.length} sources`, C.ink3]]);
  const fd = v.lod.fade('sources', t);
  if (fd.a < 1) { g.alpha(1 - fd.a); sourcesAt(g, v, fd.from); g.alpha(fd.a); }
  sourcesAt(g, v, src.lod);
  if (fd.a < 1) g.alpha(1);
  // The return wire's caption, under the sources.
  // Written on the return wire itself, as the inspiration labels its wires: the wire breaks
  // for the words (a canvas-coloured backing; the static layer's wire runs under it).
  const cap = 'failures ride home to whoever pushed them';
  const cw = Math.min(g.width(cap, T.caption), S.gates.gate.x - src.x - 40);
  g.fillRect(src.x + 2, S.divY - 7, cw + 12, 13, C.canvas);
  g.text(g.fit(cap, T.caption, cw), src.x + 8, S.divY + 4, C.ink3, T.caption);
}

function sourcesAt(g: Gfx, v: View, lod: Level): void {
  const { S, w, now } = v;
  const src = S.sources;
  if (lod <= 1 && src.rows.length > 1) {
    const sparkW = lod === 0 ? clamp(src.w - 128, 0, 72) : 0;
    for (const row of src.rows) {
      const n10 = w.pushesSince(row.org, now - 600_000);
      const rate = w.rate(row.org, now);
      const gx = row.x, gy = row.y - 5;
      // The source glyph: a document with a line per recent push, or a robot for bots.
      g.begin_(); g.rrect(gx, gy, 13, 10, 2); g.stroke(n10 ? C.ink2 : C.machineDim, 1);
      if (row.bot) {
        g.begin_(); g.circle(gx + 4.5, gy + 5, 1.2); g.circle(gx + 8.5, gy + 5, 1.2); g.fill(n10 ? C.ink : C.ink4);
      } else if (n10) {
        g.begin_();
        for (let i = 0; i < Math.min(3, n10); i++) { g.move(gx + 3, gy + 3 + i * 2.2); g.line(gx + 10 - (i % 2) * 3, gy + 3 + i * 2.2); }
        g.stroke(C.ink2, 1);
      }
      const nameX = gx + 19;
      const rateX = src.x + src.w - sparkW - (sparkW ? 10 : 2);
      g.text(g.fit(row.label, T.label, rateX - nameX - 34), nameX, row.y + 4, n10 ? C.ink2 : C.ink3, T.label);
      g.text(`${rate}/h`, rateX, row.y + 4, rate ? C.ink3 : C.ink3, T.caption, false, 'right');
      if (sparkW) {
        const sp = orgSpark(w, row.org, now);
        const bw = sparkW / 60;
        let mx = 1;
        for (let i = 0; i < 60; i++) if (sp[i] > mx) mx = sp[i];
        g.hline(rateX + 6, rateX + 6 + sparkW, row.y + 4, C.rule);
        g.begin_();
        for (let i = 0; i < 60; i++) if (sp[i]) { const hh = Math.max(1.5, (sp[i] / mx) * 9); g.rect(rateX + 6 + i * bw, row.y + 4 - hh, Math.max(1, bw - 0.4), hh); }
        g.fill(C.packetDim);
      }
    }
  } else if (lod === 2) {
    // Pills: label + rate, flowing in rows.
    let x = src.x, y = S.top.body + 4;
    const labels = S.stress ? v.stress.orgLabels : src.rows.map((r) => r.label);
    for (let i = 0; i < labels.length; i++) {
      const rate = S.stress ? Math.round(5 + (i * 37) % 40) : w.rate(src.rows[i]?.org ?? '', now);
      const s = `${trim(labels[i], 9)} ${rate}`;
      const pw = g.width(s, T.caption) + 12;
      if (x + pw > src.x + src.w) { x = src.x; y += 17; }
      if (y > S.top.y1 - 6) break;
      g.begin_(); g.rrect(x, y - 6, pw, 13, 6.5); g.stroke(rate ? C.packetDim : C.machineDim, 1);
      g.text(s, x + 6, y + 3.5, C.ink3, T.caption);
      x += pw + 4;
    }
  } else {
    // Cells: one per source, amber by push rate.
    const n = S.stress ? v.stress.orgLabels.length : src.rows.length;
    const cell = 9, pitch = 11;
    const cols = Math.max(1, Math.floor(src.w / pitch));
    for (let i = 0; i < n; i++) {
      const rate = S.stress ? (i * 37) % 40 : 10;
      g.fillRect(src.x + (i % cols) * pitch, S.top.body + Math.floor(i / cols) * pitch, cell, cell, rate > 30 ? C.packet : rate > 15 ? C.packetDim : C.machineDim);
    }
    g.text(`${n} sources`, src.x, S.top.body + Math.ceil(n / cols) * pitch + 12, C.ink3, T.caption);
  }
}

// ---- intake -----------------------------------------------------------------------------------
function drawIntake(g: Gfx, v: View, r: Rect): void {
  const { S, w, now } = v;
  const it = S.intake;
  const qt = queueTruth(w);
  const stuck = qt.items.filter((p) => now - p.created > STUCK_MS).length;
  const wait = w.stats.p50_queue_ms;
  const cap: Run[] = qt.waiting
    ? stuck ? [[`${stuck} stuck ${fmtDur(now - qt.oldestAt)}`, C.redText]] : [[`${qt.waiting} waiting`, C.amberText], [` · ${fmtDur(now - qt.oldestAt)}`, C.ink3]]
    : [[wait ? `${fmtDur(wait)} wait` : 'no wait', C.amberText], [' p50', C.ink3]];
  stationHead(g, S, it.x, S.engines.x - it.x - 10, 'intake', '', cap);
  const rr = it.rr, gh = it.gha;
  g.text(rr.w >= 76 ? 'roadrunner' : 'rr queue', rr.x, rr.y - 5, C.ink2, T.caption);
  const capN = Math.max(1, Math.floor((rr.w - 14) / 11));
  if (qt.rr.length > capN) g.text(`+${qt.rr.length - capN}`, rr.x + 4, rr.y + rr.h / 2 + 4, C.amberText, T.caption);
  const rrSub: Run[] = qt.rrWaiting ? (stuck ? [[`stuck ${fmtDur(now - qt.rr.reduce((m, p) => Math.min(m, p.created), now))}`, C.redText]] : [[`${qt.rrWaiting} in line`, C.amberText]]) : [['empty', C.ink3]];
  g.runs(rrSub, rr.x, rr.y + rr.h + 13, T.caption, rr.w + 20);
  g.text(gh.w >= 96 ? 'github actions' : 'actions', gh.x, gh.y - 5, C.ink2, T.caption);
  g.runs(qt.ghaWaiting ? [[`${qt.ghaWaiting} queued`, C.amberText]] : [['empty', C.ink3]], gh.x, gh.y + gh.h + 13, T.caption, gh.w + 20);
  if (w.watcher.tripped) g.text(`github ${w.watcher.gh_status}`, gh.x, gh.y + gh.h + 27, C.redText, T.caption);
}

// ---- engines ----------------------------------------------------------------------------------
function drawEngines(g: Gfx, v: View, r: Rect): void {
  const { S, w } = v;
  const E = S.engines;
  const all = enginesOf(w);
  let busy = 0, slots = 0;
  if (S.stress) { for (let i = 0; i < E.lanes.length || i < v.stress.lanes.length; i++) { const l = v.stress.lanes[i]; if (!l) break; slots += l.slots; for (let s = 0; s < l.slots; s++) if (v.stress.busy(i, s, v.t)) busy++; } }
  else for (const e of all) { if (e.online === false) continue; slots += Math.max(1, e.slots); }
  if (!S.stress) busy = buildingIds(w).size;
  const p50 = w.stats.p50_build_ms;
  stationHead(g, S, E.x, E.w, 'engines', ' · slots', [[`${busy} of ${slots} busy`, C.amberText], [`${p50 ? ` · ${fmtDur(p50)} typical` : ''} · ${thousands(w.stats.pipelines_24h)} today`, C.ink3]]);
  const fd = v.lod.fade('lanes', v.t);
  if (fd.a < 1) { g.alpha(1 - fd.a); enginesAt(g, v, fd.from, r); g.alpha(fd.a); }
  enginesAt(g, v, E.lod, r);
  if (fd.a < 1) g.alpha(1);
}

function laneStat(v: View, lane: Lane, li: number): { busy: number; slots: number; cpu: number } {
  const { w } = v;
  if (lane.virtual) {
    let b = 0;
    for (let s = 0; s < lane.slots.length; s++) if (v.stress.busy(li, s, v.t)) b++;
    return { busy: b, slots: lane.slots.length, cpu: -1 };
  }
  const q = buildingIds(w);
  let busy = 0, slots = 0, cpu = 0, ncpu = 0;
  const seen = new Set<string>();
  for (const id of lane.engines) {
    const e = w.engines.get(id) ?? enginesOf(w).find((x) => x.id === id);
    if (!e) continue;
    slots += Math.max(1, e.slots);
    for (const pid of e.running) if (q.has(pid) && !seen.has(pid)) { seen.add(pid); busy++; }
    if (e.cpu != null) { cpu += e.cpu; ncpu++; }
  }
  return { busy, slots: slots || lane.slots.length, cpu: ncpu ? cpu / ncpu : -1 };
}

/** The pipelines running on a lane, oldest first: name, elapsed, slow (over 1.5× typical). */
function laneRunning(v: View, lane: Lane): { name: string; el: number; slow: boolean }[] {
  const { w, now } = v;
  if (lane.virtual) return [];
  const q = buildingIds(w);
  const out: { name: string; el: number; slow: boolean }[] = [];
  const seen = new Set<string>();
  for (const id of lane.engines) {
    const e = w.engines.get(id) ?? enginesOf(w).find((x) => x.id === id);
    if (!e) continue;
    for (const pid of e.running) {
      if (!q.has(pid) || seen.has(pid)) continue;
      seen.add(pid);
      const p = w.pipelines.get(pid);
      const el = p?.started ? now - p.started : 0;
      const exp = p?.expected_ms ?? w.repos.get(p?.repo ?? '')?.p50_build_ms ?? 0;
      out.push({ name: w.repos.get(p?.repo ?? '')?.name ?? p?.repo.split('/')[1] ?? pid, el, slow: exp > 0 && el > exp * 1.5 });
    }
  }
  return out.sort((a, b) => b.el - a.el);
}

function enginesAt(g: Gfx, v: View, lod: Level, r: Rect): void {
  const { S, w, now } = v;
  const E = S.engines;
  if (lod <= 1 && E.lanes.length) {
    E.lanes.forEach((lane, li) => {
      const st = laneStat(v, lane, li);
      const cpu = st.cpu >= 0 && !lane.offline ? ` · cpu ${Math.round(st.cpu <= 1 ? st.cpu * 100 : st.cpu)}%` : '';
      const stat = lane.offline ? 'offline' : `${st.busy}/${st.slots}`;
      // amber only when the lane is full (the next push waits); otherwise a plain count
      const statColor = lane.offline ? C.ink3 : st.busy >= st.slots && st.slots > 0 ? C.amberText : C.ink2;
      const x1 = r.x + r.w - 6;
      // What runs there, oldest first, and for how long (amber: over 1.5x its typical time).
      const cap = lane.offline ? null : laneRunning(v, lane);
      const tail: Run[] = [];
      if (lane.offline) {
        const e = lane.engines.map((id) => w.engines.get(id)).find((x) => x?.last_seen);
        tail.push([e?.last_seen ? ` · last seen ${fmtDur(now - e.last_seen)} ago` : '', C.ink3]);
      } else if (cap && cap.length) {
        for (let k = 0; k < cap.length; k++) {
          const c = cap[k];
          tail.push([k ? ' · ' : '  ', C.ink3], [c.name, C.ink2], [` ${fmtShort(c.el)}`, c.slow ? C.amberText : C.ink3]);
        }
      } else tail.push([lane.virtual ? '  synthetic' : '  idle', C.ink3]);
      if (lod === 0) {
        // The label band above the machine: nothing is written where packets travel.
        // Whole tokens: the name and the load stay, the platform and the cpu go first.
        const endX = g.runs([[lane.title, C.ink2, false, 9], [` · ${lane.sub}`, C.ink3, false, -3], [` · ${stat}`, statColor, false, 8], [cpu, C.ink3, false, -2]], lane.x, lane.labelY, T.caption, x1 - lane.x);
        g.runs(tail, endX, lane.labelY, T.caption, x1 - endX);
      } else {
        // LOD1: the words to the right of the (slot-sized) machine; the exit wire runs under.
        const tx = lane.x + lane.w + 8;
        const endX = g.runs([[trim(lane.title, 14), C.ink2, false, 9], [` ${stat}`, statColor, false, 8], [cpu, C.ink3, false, -2]], tx, lane.y + lane.h / 2 + 4, T.caption, x1 - tx);
        g.runs(tail, endX, lane.y + lane.h / 2 + 4, T.caption, x1 - endX);
      }
    });
    return;
  }
  // LOD2: pills; LOD3: a cell per slot, a block per host.
  const lanes: { title: string; slots: number; offline: boolean }[] = S.stress ? v.stress.lanes : E.lanes.map((l) => ({ title: l.title, slots: l.slots.length, offline: l.offline }));
  const c = E.cells;
  if (lod === 2) {
    let x = c.x, y = c.y + 6;
    for (let i = 0; i < lanes.length; i++) {
      const l = lanes[i];
      let b = 0;
      for (let s = 0; s < l.slots; s++) if (v.stress.busy(i, s, v.t)) b++;
      const s = `${trim(l.title, 10)} ${b}/${l.slots}`;
      const pw = g.width(s, T.caption) + 14;
      if (x + pw > c.x + c.w) { x = c.x; y += 17; }
      if (y > c.y + c.h - 4) break;
      g.begin_(); g.rrect(x, y - 6, pw, 13, 6.5); g.stroke(b ? C.packetDim : C.machineDim, 1);
      g.text(s, x + 7, y + 3.5, b >= l.slots ? C.amberText : b ? C.ink2 : C.ink3, T.caption);
      x += pw + 4;
    }
    return;
  }
  const cell = 4, pitch = 5, gap = 6;
  let x = c.x, y = c.y + 4;
  let busyN = 0, totalN = 0;
  for (let i = 0; i < lanes.length; i++) {
    const l = lanes[i];
    const cols = Math.min(6, l.slots), rows = Math.ceil(l.slots / cols);
    const bw = cols * pitch;
    if (x + bw > c.x + c.w) { x = c.x; y += rows * pitch + gap; }
    if (y + rows * pitch > c.y + c.h - 14) break;
    for (let s = 0; s < l.slots; s++) {
      const b = !l.offline && v.stress.busy(i, s, v.t);
      if (b) busyN++;
      totalN++;
      g.fillRect(x + (s % cols) * pitch, y + Math.floor(s / cols) * pitch, cell, cell, l.offline ? C.cellOff : b ? C.packet : C.machineDim);
    }
    x += bw + gap;
  }
  g.text(`${lanes.length} hosts · ${busyN} of ${totalN} slots busy`, c.x, c.y + c.h - 2, C.ink3, T.caption);
}

// ---- gates ------------------------------------------------------------------------------------
/** The building slots' faint full rings (the progress rings' tracks), while any progress ring
 *  is drawn at the top two quality levels. p3-yard: here, not on the live layer: they do not move,
 *  and they were ~4 KB of its ~8 KB a frame. (The live layer's progress rings are the same colour
 *  over them, so the order of the two does not change the pixels.) */
export function tracksOn(v: View): boolean {
  const { S, w } = v;
  if (S.engines.lod >= 2 || v.q > 1) return false;
  const building = buildingIds(w);
  if (!building.size) return false;
  const fallback = w.stats.p50_build_ms || 0;
  for (const lane of S.engines.lanes) {
    if (lane.virtual) continue;
    for (const id of lane.engines) {
      const e = w.engines.get(id) ?? enginesOf(w).find((x) => x.id === id);
      const slots = S.engines.slotByEngine.get(id);
      if (!e || !slots) continue;
      for (const pid of e.running) {
        if (!building.has(pid)) continue;
        const pl = w.pipelines.get(pid);
        const exp = pl?.expected_ms ?? w.repos.get(pl?.repo ?? '')?.p50_build_ms ?? fallback;
        if (exp > 0) return true;
      }
    }
  }
  return false;
}

function drawTracks(g: Gfx, v: View): void {
  if (!tracksOn(v)) return;
  g.begin_();
  for (const lane of v.S.engines.lanes) for (const s of lane.slots) if (!lane.offline) g.circle(s.x, s.y, s.r + 2.5);
  g.stroke(withAlpha(C.packet, 0.1), 1);
}

function drawGates(g: Gfx, v: View, r: Rect): void {
  const { S, w } = v;
  const G = S.gates;
  const s = w.stats;
  const pct = Math.round(s.success_rate_24h <= 1 ? s.success_rate_24h * 100 : s.success_rate_24h);
  stationHead(g, S, G.x, r.w - 2, 'gates', '', [[`${pct}% pass`, C.amberText], [' 24h', C.ink3]]);
  void thousands;
  g.text(r.w > 110 ? 'required checks' : 'checks', G.x, G.gate.y + G.gate.h + 13, C.ink3, T.caption);
  let review = 0, ready = 0;
  for (const p of w.prs.values()) { if (p.phase === 'review') review++; else if (p.phase === 'mergeable') ready++; }
  g.runs([['review', C.ink2], [` · ${review}`, C.amberText]], G.review.x, G.review.y - 5, T.caption, r.w);
  g.runs([[`${thousands(s.prs_open || w.prs.size)} prs open`, C.ink3]], G.review.x, G.review.y + G.review.h + 13, T.caption, r.w - 2);
  // The gate's last verdicts, newest right: a dot per finished pipeline.
  const fin = verdicts(w);
  const n = Math.min(fin.length, Math.floor((r.w - 6) / 7));
  const yy = G.review.y + G.review.h + 30;
  if (n > 0 && yy < S.divY - 24) {
    g.text(r.w > 100 ? 'last verdicts' : 'verdicts', G.x, yy, C.ink3, T.caption);
    for (const ok of [true, false]) {
      g.begin_();
      for (let i = 0; i < n; i++) { const p = fin[fin.length - n + i]; if ((p.state === 'success') === ok) g.circle(G.x + 3 + i * 7, yy + 9, 2.4); }
      g.fill(ok ? C.dot : C.red);
    }
  }
  void ready;
}

/** Every finished pipeline with a verdict, oldest first (the gates' dots), kept while the
 *  pipelines are the same (p5-yard: the panel is asked each minute and on every pr and stats
 *  change, and this walked and sorted every pipeline each time). */
const verdictCache = new WeakMap<World, { kv: number; v: Pipeline[] }>();
function verdicts(w: World): Pipeline[] {
  const hit = verdictCache.get(w);
  if (hit && hit.kv === w.kv.pipeline) return hit.v;
  const fin: Pipeline[] = [];
  for (const p of w.pipelines.values()) if (p.finished && (p.state === 'success' || p.state === 'failure' || p.state === 'error')) fin.push(p);
  fin.sort((a, b) => (a.finished ?? 0) - (b.finished ?? 0));
  verdictCache.set(w, { kv: w.kv.pipeline, v: fin });
  return fin;
}

// ---- main lines -------------------------------------------------------------------------------
function drawMains(g: Gfx, v: View, r: Rect): void {
  void r;
  for (const part of mainsParts(v)) part(g);
}

/** The main lines panel as parts (p3-yard): its head, then a row a part, so a change to one
 *  line repaints that row's box, not the ~190 KB panel. */
function mainsParts(v: View, r?: Rect): Part[] {
  void r;
  const { S, w, now, t } = v;
  const top = S.top;
  const M = S.mains;
  const ra = v.agg.repos;
  const fresh = ra.fresh;
  const parts: Run[] = ra.red
    ? [[`${ra.red} red`, C.redText], [fresh ? ` · ${fresh} today` : '', C.redText], [ra.oldestRed ? ` · oldest ${fmtDur(now - ra.oldestRed)}` : '', C.ink3], [` · ${ra.green} green`, C.ink3]]
    : [[`all ${ra.green} green`, C.greenInk]];
  // the head down to the first row; each row its band (layout.ts: yMid is 16 under a LOD0 row's
  // top, else the middle of its height; the bands do not overlap)
  const top0 = (row: MainRow) => row.y - (row.lod === 0 ? 16 : row.h / 2);
  const first = M.rows.length ? top0(M.rows[0]) : S.mains.heat.y - 4;
  const out: Part[] = [banded((g) => stationHead(g, S, M.x0, M.x1 - M.x0, 'main lines', ' · newest right', parts), top.y0 - 4, first)];
  const f0 = v.lod.fade('rows', t);
  const fd = { from: f0.from, a: f0.a };
  for (const row of M.rows) {
    const repo = w.repos.get(row.repo);
    if (!repo) continue;
    const y0 = top0(row), y1 = y0 + row.h;
    if (fd.a < 1 && row.lod !== fd.from) out.push(banded((g) => { g.alpha(1 - fd.a); mainRow(g, v, repo, row, fd.from); g.alpha(fd.a); mainRow(g, v, repo, row, row.lod); g.alpha(1); }, y0, y1));
    // p5-yard: keyed by the repo (copy on write: a change is a new object), the row and the
    // words that follow the clock, so an unchanged row is not even hashed
    else out.push(keyed(banded((g) => mainRow(g, v, repo, row, row.lod), y0, y1), mainRowKey(v, repo, row.lod), repo, row));
  }
  return out;
}

/** Adds a box (x0, y0, x1, y1) to a list of disjoint boxes, merging those it overlaps. */
function addBox(boxes: number[], x0: number, y0: number, x1: number, y1: number): void {
  for (let b = 0; b < boxes.length; b += 4) {
    if (x1 < boxes[b] || x0 > boxes[b + 2] || y1 < boxes[b + 1] || y0 > boxes[b + 3]) continue;
    x0 = Math.min(x0, boxes[b]); y0 = Math.min(y0, boxes[b + 1]); x1 = Math.max(x1, boxes[b + 2]); y1 = Math.max(y1, boxes[b + 3]);
    boxes.splice(b, 4);
    addBox(boxes, x0, y0, x1, y1);
    return;
  }
  boxes.push(x0, y0, x1, y1);
}

/** fmtShort(ms)'s words as a number: the same number exactly when the same words. */
export function shortKey(ms: number): number {
  if (!isFinite(ms) || ms < 0) return -1;
  const s = Math.round(ms / 1000);
  if (s < 60) return s;
  const m = Math.floor(s / 60);
  if (m < 60) return 1000 + m;
  const hh = Math.floor(m / 60);
  return hh < 48 ? 2000 + hh : 3000 + Math.round(hh / 24);
}

/** fmtDur(ms)'s words as a number: the same number exactly when the same words. */
export function durKey(ms: number): number {
  if (!isFinite(ms) || ms < 0) return -1;
  const s = Math.round(ms / 1000);
  if (s < 60) return s;
  const m = Math.floor(s / 60);
  // ("4m 5s" keys its seconds, never a multiple of 60; "4m" its minutes times 60)
  if (m < 60) return 1000 + (s % 60 && m < 10 ? s : m * 60);
  const hh = Math.floor(m / 60);
  if (hh >= 48) return 1e7 + Math.round(hh / 24);
  return 1e6 + (m % 60 && hh < 10 ? m : hh * 60);
}

/** What a main line's row draws besides its repo and its row (both keyed by identity): its
 *  level, the dots' shape (square from q3), and the words that follow the clock (a red line's
 *  age, whether it is red today, the shown commit's age). NaN at LOD2: its bars follow the clock. */
function mainRowKey(v: View, repo: Repo, lod: Level): number {
  if (lod > 1) return NaN;
  const now = v.now;
  let k = h(lod + 1, v.q >= 3 ? 1 : 0);
  const red = isRed(repo);
  if (red) k = h(h(k, shortKey(now - repo.main.since)), now - repo.main.since < 86_400_000 ? 1 : 0);
  const rec = repo.main.recent;
  let c = rec[rec.length - 1];
  if (red && repo.main.culprit) { c = undefined as unknown as typeof c; for (let i = 0; i < rec.length; i++) if (rec[i].sha === repo.main.culprit) { c = rec[i]; break; } }
  return c ? h(h(k, 7), shortKey(now - c.at)) : k;
}

function mainRow(g: Gfx, v: View, repo: Repo, row: MainRow, lod: Level): void {
  const { now, q } = v;
  const red = isRed(repo);
  const fresh = red && now - repo.main.since < 86_400_000;
  const st = repo.main.state;
  const state = red ? `red ${fmtShort(now - repo.main.since)}` : st === 'running' || st === 'pending' ? 'building' : st === 'success' ? 'green' : st === 'none' ? 'no checks' : st;
  const stColor = red ? (fresh ? C.redText : C.redText) : st === 'running' || st === 'pending' ? C.amberText : C.ink3;
  const px = lod === 0 ? T.label : T.caption;
  const ty = row.y + (lod === 0 ? 4 : 3.5);
  const sw = g.width(state, T.caption);
  g.text(g.fit(repo.name, px, row.nameW - sw - 10, lod === 0), row.x0, ty, red && fresh ? C.ink : C.ink2, px, lod === 0);
  g.text(state, row.x0 + row.nameW, ty, stColor, T.caption, false, 'right');
  if (lod <= 1) {
    const first = mainLine(g, repo, row.dx0, row.dx1, row.y, row.pitch, row.r, lod, q, now, false);
    // The rail's empty stretch carries the newest commit (on a red line, the culprit's): its
    // sha (10 px, gray as the Mainlines table's: inline at the row's height, as the Mainlines table has it, never
    // over the dots or a neighbour), what it says, who, when. The message is cut first, then
    // when, then who; the sha goes last. Only where it fits without touching a dot.
    const room = first - 14 - row.dx0;
    if (room > 60) {
      const rec = repo.main.recent;
      const c = red && repo.main.culprit ? rec.find((d) => d.sha === repo.main.culprit) : rec[rec.length - 1];
      if (c) {
        const ago = fmtShort(now - c.at);
        const who = c.author.replace(/\[bot\]$/, '');
        const lead = red && c.sha === repo.main.culprit;
        let x = row.dx0;
        if (lead) x = g.runs([[c.sha.slice(0, 7), C.ink3, false, 9]], x, ty, T.small, room) + 6;
        g.runs([[c.title, lod === 0 ? C.ink2 : C.ink3, false, -50, true], [` · ${who}`, C.ink3, false, -1], [` · ${ago}`, C.ink3, false, -2]], x, ty, T.caption, row.dx0 + room - x);
      }
    }
  } else bucketBars(g, repo, row.dx0, row.dx1, row.y, row.h - 3, now);
}

/**
 * A main line: dots newest right, an end cap. Only the current red streak is solid red; reds
 * before the last green are faint rings (history, not news). The rail takes the state's tint.
 * LOD0 labels the culprit over its dot.
 */
export function mainLine(g: Gfx, r: Repo, x0: number, x1: number, y: number, pitch: number, rad: number, lod: Level, q: Quality, now: number, label: boolean): number {
  const rec = r.main?.recent ?? [];
  const n = Math.max(1, Math.floor((x1 - x0) / pitch) + 1);
  const start = Math.max(0, rec.length - n);
  const cnt = rec.length - start;
  const xAt = (i: number) => x1 - (rec.length - 1 - i) * pitch;
  const red = isRed(r);
  // The current streak: from the culprit (or the first red after the last green) to now.
  let streak = rec.length;
  if (red) {
    streak = rec.length - 1;
    while (streak > 0 && (rec[streak - 1].state === 'failure' || rec[streak - 1].state === 'error' || rec[streak - 1].state === 'running' || rec[streak - 1].state === 'pending' || rec[streak - 1].state === 'canceled' || rec[streak - 1].state === 'skipped')) streak--;
    const ci = r.main.culprit ? rec.findIndex((d) => d.sha === r.main.culprit) : -1;
    if (ci >= 0) streak = ci;
  }
  // rail, tinted by state; it starts just before the oldest dot shown
  const left = cnt ? xAt(start) : x1;
  g.hline(Math.max(x0, left - 10), x1 + 8, y, C.wire, g.hair);
  if (red && streak < rec.length) {
    // the wire goes red from the culprit to the head: where it broke, and how long it stayed so
    g.begin_(); g.move(xAt(Math.max(start, streak)), y); g.line(x1 + 8, y); g.stroke(withA(C.red, 0.8), 1.2);
  } else if (!red && r.main?.state === 'success' && cnt) {
    g.begin_(); g.move(left, y); g.line(x1 + 8, y); g.stroke(withA(C.green, 0.3), 1);
  }
  // end cap (a port tab)
  g.begin_(); g.rrect(x1 + 7, y - 6, 3.5, 12, 1.5); g.fill(C.port); g.stroke(C.portEdge, 1);
  if (!cnt) return x1;
  const square = q >= 3;
  const dotAt = (x: number, rr: number) => { if (square) g.rect(x - rr, y - rr, rr * 2, rr * 2); else g.circle(x, y, rr); };
  // greens/whites, grays, solid reds (streak), faint reds (history), running rings
  g.begin_();
  for (let i = start; i < rec.length - 1; i++) { const s = rec[i].state; if (s === 'success') dotAt(xAt(i), rad); }
  g.fill(C.dot);
  // the head: the brightest dot on the line, when it is green
  if (rec[rec.length - 1].state === 'success') { g.begin_(); dotAt(x1, rad); g.fill(C.ink); }
  g.begin_();
  let any = false;
  for (let i = start; i < rec.length; i++) { const s = rec[i].state; if (s === 'skipped' || s === 'canceled' || s === 'none' || s === 'blocked') { dotAt(xAt(i), rad * 0.7); any = true; } }
  if (any) g.fill(C.dotDim);
  g.begin_(); any = false;
  for (let i = Math.max(start, streak); i < rec.length; i++) { const s = rec[i].state; if (s === 'failure' || s === 'error') { dotAt(xAt(i), rad); any = true; } }
  if (any) g.fill(C.red);
  g.begin_(); any = false;
  for (let i = start; i < Math.min(rec.length, red ? streak : rec.length); i++) { const s = rec[i].state; if (s === 'failure' || s === 'error') { g.circle(xAt(i), y, rad - 0.5); any = true; } }
  if (any) g.stroke(withA(C.red, 0.45), 1);
  g.begin_(); any = false;
  for (let i = start; i < rec.length; i++) { const s = rec[i].state; if (s === 'running' || s === 'pending') { g.circle(xAt(i), y, rad); any = true; } }
  if (any) g.fill(C.ink);
  if (any) {
    g.begin_();
    for (let i = start; i < rec.length; i++) { const s = rec[i].state; if (s === 'running' || s === 'pending') g.circle(xAt(i), y, rad + 2.5); }
    g.stroke(C.packet, 1.2);
  }
  // deployed marks
  // what is live: one tick under the newest deployed dot (ink3; amber is for motion)
  if (lod === 0) {
    for (let i = rec.length - 1; i >= start; i--) if (rec[i].deployed) {
      const x = xAt(i);
      g.begin_(); g.move(x - 2.5, y + rad + 3.5); g.line(x + 2.5, y + rad + 3.5); g.stroke(C.ink3, 1.2);
      break;
    }
  }
  // the culprit: a ring, and (the lens card only: rows carry it inline) its sha and author over it
  const ci = red && r.main.culprit ? rec.findIndex((d) => d.sha === r.main.culprit) : -1;
  if (ci >= start) {
    const x = xAt(ci);
    g.begin_(); g.circle(x, y, rad + 2); g.stroke(withA(C.red, 0.7), 1);
    if (label) {
      const c = rec[ci];
      const s = `${c.sha.slice(0, 7)} ${c.author.replace(/\[bot\]$/, '')}`;
      const tw = g.width(s, T.caption);
      const lx = clamp(x - tw / 2, x0 - 4, x1 + 8 - tw);
      g.text(s, lx, y - rad - 5, C.redText, T.caption);
    }
  }
  return left;
}

/** LOD2: the dots as time-bucket bars (height = commits in the bucket, colour = its worst state). */
function bucketBars(g: Gfx, r: Repo, x0: number, x1: number, y: number, hh: number, now: number): void {
  const rec = r.main?.recent ?? [];
  g.hline(x0, x1 + 8, y + hh / 2, C.wire, g.hair);
  if (!rec.length) return;
  const nb = Math.max(4, Math.floor((x1 - x0) / 4));
  const t0 = rec[0].at, span = Math.max(1, Math.max(now, rec[rec.length - 1].at) - t0);
  const cnt = new Uint8Array(nb), worst = new Uint8Array(nb);
  for (const d of rec) {
    const b = Math.min(nb - 1, Math.floor(((d.at - t0) / span) * nb));
    cnt[b]++;
    const s = d.state === 'failure' || d.state === 'error' ? 3 : d.state === 'running' || d.state === 'pending' ? 2 : d.state === 'success' ? 1 : 0;
    if (s > worst[b]) worst[b] = s;
  }
  let mx = 1;
  for (let i = 0; i < nb; i++) if (cnt[i] > mx) mx = cnt[i];
  const bw = (x1 - x0) / nb;
  for (const [s, color] of [[1, C.dot], [2, C.packet], [3, C.red], [0, C.dotDim]] as const) {
    g.setFill(color);
    for (let i = 0; i < nb; i++) if (cnt[i] && worst[i] === s) { const bh = Math.max(2, (cnt[i] / mx) * hh); g.cell(x0 + i * bw, y + hh / 2 - bh, Math.max(1, bw - 1), bh); }
  }
}

// ---- heatmap ------------------------------------------------------------------------------------
const HEAT_COLORS: Record<number, string> = { [S_NONE]: C.cellOff, [S_GREEN]: C.cellGreen, [S_RED]: C.red, [S_RUN]: C.packet, [S_PEND]: C.packetDim, [S_STALE]: C.redEdge };

function drawHeat(g: Gfx, v: View, r: Rect): void {
  const { S } = v;
  const H = S.mains.heat;
  const ra = v.agg.repos;
  const st = S.stress ? v.stress.repoState : ra.state;
  const shown = S.mains.rows.length;
  // Whole tokens: the count and the way to Mainlines stay; the legend goes first.
  g.runs([['every repo', C.ink2, false, 10], [` · ${thousands(H.n)}`, C.ink2, false, 9], [' · one cell each', C.ink3, false, -4], [' · bright red = red today', C.ink3, false, -2], [` · ${shown} have rows above`, C.ink3, false, -3], ['   mainlines ›', C.ink3, false, 5]], S.mains.x0, H.y + 8, T.caption, r.w - 8);
  // One label per org band, in the gutter left of the cells, centred on its band.
  for (const b of H.blocks) g.text(g.fit(b.label, T.caption, b.x - S.mains.x0 - 8), S.mains.x0, b.labelY + 3.5, C.ink3, T.caption);
  for (const s of [S_GREEN, S_NONE, S_PEND, S_STALE, S_RUN, S_RED]) {
    g.setFill(HEAT_COLORS[s]);
    for (const b of H.blocks) {
      for (let i = b.start; i < b.end; i++) {
        if (st[i] !== s) continue;
        const j = i - b.start;
        g.cell(b.x + (j % b.cols) * H.pitch, b.y + Math.floor(j / b.cols) * H.pitch, H.cell, H.cell);
      }
    }
  }
}

// ---- deploy and apps ----------------------------------------------------------------------------
function drawApps(g: Gfx, v: View, r: Rect): void {
  const { S, w, now, t } = v;
  const D = S.deploy, A = S.apps;
  let rr = 0, gha = 0, fb = 0, deploying = 0;
  for (const d of w.deploys.values()) {
    if (d.state === 'running' || d.state === 'pending') deploying++;
    if (d.via === 'roadrunner') rr++; else if (d.via === 'gha') gha++; else if (d.via === 'gha_fallback') fb++;
  }
  const tx = D.x + D.w + 12;
  g.runs([['deploy', C.ink, true], [' · ', C.ink3], [deploying ? `${deploying} deploying` : `${w.stats.deploys_24h} today`, C.amberText], [` · roadrunner ${rr} · gha ${gha}`, C.ink3], [' · fallback ', C.ink3], [`${fb}`, fb ? C.ink2 : C.ink3]], tx, D.y + D.h / 2 + 4, T.caption, r.x + r.w - tx - 4);
  const aa = v.agg.apps;
  const up = S.stress ? v.stress.appHealth.reduce((n, x) => n + (x === 0 || x === 4 ? 1 : 0), 0) : aa.up;
  const parts: Run[] = [['apps', C.ink, true], [` · ${thousands(up)} of ${thousands(A.n)} up`, C.ink3]];
  // Problem apps by name, as many as fit whole; the rest "+N more", never past the margin.
  const room = r.x + r.w - 8 - A.x;
  let used = g.width(`apps · ${thousands(up)} of ${thousands(A.n)} up`, T.caption);
  const probs = aa.problems;
  let shown = 0;
  for (let k = 0; k < probs.length; k++) {
    const a = w.apps.get(probs[k]);
    const s1 = ` · ${probs[k]} ${a?.health ?? ''}`;
    const left = probs.length - k - 1;
    const reserve = left ? g.width(` · +${left} more`, T.caption) : 0;
    const wd = g.width(s1, T.caption);
    if (used + wd + reserve > room) break;
    parts.push([s1, a?.health === 'down' ? C.redText : C.amberText]);
    used += wd;
    shown++;
  }
  if (probs.length > shown) { const s2 = ` · +${probs.length - shown} more`; parts.push([s2, C.redText]); used += g.width(s2, T.caption); }
  if (used + g.width(' · by attention', T.caption) <= room) parts.push([' · by attention', C.ink3]);
  void now;
  g.runs(parts, A.x, A.namesY, T.caption, room);
  const health = S.stress ? v.stress.appHealth : aa.health;
  const fd = v.lod.fade('apps', t);
  void fd;
  const colors = [C.up, C.packet, C.red, C.machineDim, '#6E6A4E'];
  for (let s = 0; s < 5; s++) {
    g.setFill(colors[s]);
    for (let i = 0; i < A.n; i++) if (health[i] === s) g.cell(A.x + (i % A.cols) * A.pitch, A.y + Math.floor(i / A.cols) * A.pitch, A.cell, A.cell);
  }
}

// ---- COMING: the queue in order ---------------------------------------------------------------
function drawQueue(g: Gfx, v: View, r: Rect): void {
  for (const part of queueParts(v, r)) part(g);
}

/** COMING as parts (p3-yard): its head, each waiting row, the rest, each finished row; a queue
 *  that only aged repaints the rows whose words moved. */
function queueParts(v: View, r: Rect): Part[] {
  const out: Part[] = [];
  const { w, now } = v;
  const qt = queueTruth(w);
  const items = qt.items;
  const stuck = items.filter((p) => now - p.created > STUCK_MS).length;
  const x0 = r.x + 4;
  // bands: the head over the first row; each row 22 px about its line (chips are ~17 px high)
  const rowBand = (y: number) => [y - 11, y + 11] as const;
  out.push(banded((g) => {
    const x = g.eyebrow([['coming', C.ink3], [' · in order', C.ink3]], x0, r.y + 14, T.eyebrow);
    g.runs(items.length ? [[` · ${qt.waiting} waiting`, C.amberText], [stuck ? ` · ${stuck} stuck over an hour` : ` · oldest ${fmtDur(now - qt.oldestAt)}`, stuck ? C.redText : C.ink3]] : [[' · nothing waiting, every slot can take the next push · ', C.ink3], ['just finished:', C.ink2]], x, r.y + 14, T.caption, r.w - (x - x0));
  }, r.y, r.y + 27));
  const rowH = 22;
  const nRows = Math.max(0, Math.floor((r.h - 26) / rowH));
  let used = 0;
  if (items.length) {
    const cap = Math.max(1, Math.min(items.length, nRows - 2 > 3 ? Math.min(nRows - 2, 6) : nRows));
    const show = items.slice(0, cap - (items.length > cap ? 1 : 0));
    // p5-yard: each row keyed by its pipeline (copy on write), its place and the words that
    // follow the clock (its wait, stuck or long), so a queue that did not move is not hashed
    show.forEach((p, i) => out.push(keyed(banded((g) => {
      const y = r.y + 38 + i * rowH;
      const name = w.repos.get(p.repo)?.name ?? p.repo.split('/')[1] ?? p.repo;
      g.runs([[pnum(p), C.ink2, false, 9], [name, C.ink3, false, 8, true]], x0, y + 4, T.label, 180);
      let x = x0 + 190;
      const age = now - p.created;
      const est = p.expected_ms ?? w.repos.get(p.repo)?.p50_build_ms ?? w.stats.p50_build_ms ?? 0;
      const lim = r.x + r.w - 6;
      const chips: [string, 'idle' | 'bad' | 'wait'][] = [
        [`${p.event === 'pull_request' ? 'pr' : 'push'} · ${trim(p.branch, 16)}`, 'idle'],
        [age > STUCK_MS ? `stuck ${fmtDur(age)}` : `waiting ${fmtDur(age)}`, age > STUCK_MS ? 'bad' : age > 120_000 ? 'wait' : 'idle'],
        [p.lane === 'gha' ? 'gha runner' : 'roadrunner', 'idle'],
        [est ? `~${fmtDur(est)} build` : 'then build', 'idle'],
      ];
      for (let j = 0; j < chips.length; j++) {
        const cw = g.width(chips[j][0], T.chip) + 13;
        if (x + cw > lim) break;
        x += chip(g, chips[j][0], x, y, chips[j][1], T.chip);
        if (j < chips.length - 1 && x + 22 < lim) { arrow(g, x + 3, x + 18, y, C.ink4); x += 21; }
      }
    }, ...rowBand(r.y + 38 + i * rowH)), waitKey(v, p, r), p)));
    used = show.length;
    if (items.length > show.length) {
      const y = r.y + 38 + show.length * rowH;
      const more = items.length - show.length;
      out.push(banded((g) => {
        g.begin_();
        for (let i = 0; i < Math.min(more, 24); i++) g.rect(x0 + i * 12, y - 4, 8, 8);
        g.stroke(C.chipEdge, 1);
        g.text(`${more} more behind these`, x0 + Math.min(more, 24) * 12 + 6, y + 4, C.ink3, T.caption);
      }, ...rowBand(y)));
      used++;
    }
  }
  // Under the queue (or instead of it): what just finished, so the band keeps telling.
  const left = nRows - used - (used ? 1 : 0);
  if (left < 1) return out;
  let yTop = r.y + 38 + used * rowH;
  if (used) { const yy = yTop; out.push(banded((g) => { g.text('just finished', x0, yy + 4, C.ink3, T.caption); }, ...rowBand(yy))); yTop += rowH; }
  const cols = r.w > 700 ? 2 : 1;
  const colW = (r.w - 8) / cols;
  const done = Array.from(w.pipelines.values()).filter((p) => p.finished && now - p.finished < 3_600_000).sort((a, b) => (b.finished ?? 0) - (a.finished ?? 0)).slice(0, Math.max(0, left * cols));
  done.forEach((p, i) => out.push(keyed(banded((g) => {
    const c = Math.floor(i / left), k = i % left;
    const y = yTop + k * rowH;
    const cx0 = x0 + c * colW;
    const name = w.repos.get(p.repo)?.name ?? p.repo.split('/')[1] ?? p.repo;
    const nameW = Math.min(180, colW * 0.45);
    g.runs([[pnum(p), C.ink2, false, 9], [name, C.ink3, false, 8, true]], cx0, y + 4, T.label, nameW - 8);
    const ok = p.state === 'success';
    let cx = cx0 + nameW;
    cx += chip(g, ok ? 'passed' : p.state, cx, y, ok ? 'ok' : p.state === 'failure' || p.state === 'error' ? 'bad' : 'skip', T.chip) + 8;
    g.runs([[fmtDur((p.finished ?? 0) - (p.started ?? p.created)), C.ink3], [` · ${fmtShort(now - (p.finished ?? now))} ago`, C.ink3]], cx, y + 4, T.caption, cx0 + colW - cx - 8);
  }, ...rowBand(yTop + (i % left) * rowH)), h(h(hs(h(Math.floor(i / left), shortKey(now - (p.finished ?? now))), w.repos.get(p.repo)?.name ?? p.repo), r.x), r.w + cols * 4096), p)));
  return out;
}

/** What a waiting row draws besides its pipeline (by identity) and its band: its repo's name,
 *  its wait's words and tone, the typical build's words, the panel's x and width. */
function waitKey(v: View, p: Pipeline, r: Rect): number {
  const { w, now } = v;
  const age = now - p.created;
  const est = p.expected_ms ?? w.repos.get(p.repo)?.p50_build_ms ?? w.stats.p50_build_ms ?? 0;
  const k = h(h(durKey(age), age > STUCK_MS ? 2 : age > 120_000 ? 1 : 0), est ? durKey(est) : -2);
  return h(h(hs(k, w.repos.get(p.repo)?.name ?? p.repo), r.x), r.w);
}

// ---- PULSE: the last hour ---------------------------------------------------------------------
function drawPulse(g: Gfx, v: View, r: Rect): void {
  const { w, now } = v;
  const lh = lastHour(w, now);
  const x0 = r.x + 4;
  const x = g.eyebrow([['pulse', C.ink3], [' · last hour', C.ink3]], x0, r.y + 14, T.eyebrow);
  const pct = lh.total ? Math.round(((lh.total - lh.failed) / lh.total) * 100) : 0;
  g.runs([[` · ${lh.total} builds`, C.amberText], [lh.total ? ` · ${lh.failed} failed · ${pct}%` : '', C.ink3], [lh.p50 ? ` · p50 ${fmtDur(lh.p50)}` : '', C.ink3]], x, r.y + 14, T.caption, r.w - (x - x0) - 70);
  const bx = x0, bw = r.w - 8;
  const by1 = r.y + r.h - 14, bh = Math.max(16, r.h - 40);
  const cw = bw / 60;
  g.hline(bx, bx + bw, by1 + 0.5, C.rule, 1);
  g.setFill(C.up);
  for (let i = 0; i < 60; i++) { const n = lh.ok[i]; if (n) { const hh = (n / lh.max) * bh; g.cell(bx + i * cw + 0.5, by1 - hh, Math.max(1, cw - 1.5), hh); } }
  g.setFill(C.red);
  for (let i = 0; i < 60; i++) { const n = lh.bad[i]; if (n) { const base = (lh.ok[i] / lh.max) * bh; const hh = (n / lh.max) * bh; g.cell(bx + i * cw + 0.5, by1 - base - hh, Math.max(1, cw - 1.5), hh); } }
  g.text('−60m', bx, by1 + 12, C.ink3, T.caption);
  g.text('−30m', bx + bw / 2, by1 + 12, C.ink3, T.caption, false, 'center');
  g.text('now', bx + bw, by1 + 12, C.ink3, T.caption, false, 'right');
  g.text(`${lh.max}/min`, bx + bw, r.y + 14, C.ink3, T.caption, false, 'right');
}

// ---- BUSIEST: who ran the most this hour ------------------------------------------------------
function drawBusy(g: Gfx, v: View, r: Rect): void {
  const { w, now } = v;
  const x0 = r.x + 4;
  g.eyebrow([['busiest', C.ink3], [' · last hour', C.ink3]], x0, r.y + 14, T.eyebrow);
  const colW = r.w > 420 ? (r.w - 16) / 2 : r.w - 8;
  const cols = r.w > 420 ? 2 : 1;
  const rowH = 15;
  const rowsN = Math.max(1, Math.floor((r.h - 24) / rowH));
  const list = busiest(w, now, rowsN * cols);
  const mx = list[0]?.n ?? 1;
  // The bars leave room for the widest count ("15 · 2 red"), so no count is ever cut.
  let labW = 0;
  for (const b of list) labW = Math.max(labW, g.width(`${b.n}${b.red ? ` · ${b.red} red` : ''}`, T.caption));
  list.forEach((b, i) => {
    const c = Math.floor(i / rowsN), k = i % rowsN;
    const x = x0 + c * (colW + 16), y = r.y + 32 + k * rowH;
    const barX = x + Math.min(132, colW * 0.5), barW = Math.max(8, colW - (barX - x) - labW - 10);
    g.text(g.fit(b.name, T.caption, barX - x - 8), x, y, b.red ? C.ink2 : C.ink3, T.caption);
    const bwid = Math.max(2, (b.n / mx) * barW);
    g.fillRect(barX, y - 6, bwid, 5, C.packetDim);
    if (b.red) g.fillRect(barX + bwid - Math.max(2, (b.red / mx) * barW), y - 6, Math.max(2, (b.red / mx) * barW), 5, C.red);
    g.runs([[`${b.n}`, C.ink3], [b.red ? ` · ${b.red} red` : '', C.redText]], barX + bwid + 6, y, T.caption, x + colW - (barX + bwid + 6));
  });
  if (!list.length) g.text('no builds this hour', x0, r.y + 32, C.ink3, T.caption);
}

// ---- shared -----------------------------------------------------------------------------------
/** A station's two header lines: title (bold, white) + a gray note; then the amber stat + why. */
function stationHead(g: Gfx, S: Scene, x: number, w: number, title: string, note: string, caption: Run[]): void {
  const y = S.top.y0 + 10;
  g.runs([[title, C.ink, true], [note, C.ink3]], x, y, T.title, w);
  g.runs(caption, x, y + 15, T.caption, w);
}

function withA(hex: string, a: number): string {
  return withAlphaCached(hex, a);
}
import { withAlpha as withAlphaCached } from './theme.ts';

export function trim(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

export function fmtDur(ms: number): string {
  if (!isFinite(ms) || ms < 0) return '–';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return s % 60 && m < 10 ? `${m}m ${s % 60}s` : `${m}m`;
  const hh = Math.floor(m / 60);
  if (hh >= 48) return `${Math.round(hh / 24)} days`;
  return m % 60 && hh < 10 ? `${hh}h ${m % 60}m` : `${hh}h`;
}

/** Compact: 58s, 4m, 19h, 106d. */
export function fmtShort(ms: number): string {
  if (!isFinite(ms) || ms < 0) return '–';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const hh = Math.floor(m / 60);
  if (hh < 48) return `${hh}h`;
  return `${Math.round(hh / 24)}d`;
}

export function fmtClock(ms: number, offsetMin: number): string {
  const d = new Date(ms + offsetMin * 60_000);
  const hh = d.getUTCHours(), mi = d.getUTCMinutes();
  return `${hh < 10 ? '0' : ''}${hh}:${mi < 10 ? '0' : ''}${mi}`;
}

void TAU; void CELL_H; void times;
