// Factory 3, "the berth board": the painter and the only motion there is.
//
// Two canvases. `board` holds every mark and word; it is repainted only when the scene says
// something new (scene.ts' key), so an idle fleet costs nothing: no frame is asked for, no
// pixel changes. `live` is empty except while a run is changing place: then the run's square
// travels from where it was to where it is now, once, and the layer is cleared.
//
// A transit is made in exactly one way: an entity's place in the new scene differs from its
// place in the scene before it, after a real change of the world (a new version). There is no
// clock that makes one, and no rate.

import type { Ctx2D, Frame } from '../../app.contract.d.ts';
import type { World } from '../world.ts';
import { FACE, easeInOut } from '../yard/theme.ts';
import { SlotBook, boardOf, windowMs } from './model.ts';
import { LINE_Y, PLACE, advOf, layoutOf, sceneOf, setAdvance, SIZES, type Anchor, type Hit, type Layout, type Op, type Scene } from './scene.ts';

export type BoardArgs = { win: string; sel: string; mode: string; reduced: boolean; dock: boolean; hov: string };
/** A square on its way from one place to another: along `pts` (CSS px, the square's centre),
 *  right angles only. `t0` is set by the live layer's first frame of it (−1 until then: that
 *  layer sleeps between transits and wakes a tick late); `born` and `delay` are the board's. */
type Transit = { key: string; c: string; pts: number[]; len: number; s0: number; s1: number; born: number; delay: number; t0: number; dur: number };
/** a square's side while it rides the line */
const RIDE = 9;

/** A run that entered this long ago is news (it arrives from the left edge); older, it is
 *  simply there (the board was opened on it). */
const FRESH_MS = 30_000;
const MAX_TRANSITS = 48;

function freshBitmap(f: Frame): boolean {
  const has = (k: string) => (f.causes.length ? f.causes.includes(k as never) : f.cause === k);
  return has('mount') || has('size') || has('font') || has('style');
}

/** An op's box on the board (CSS px; a text's generously: the face is monospaced, so its width is
 *  its length in advances, padded for antialiasing and a wider fallback glyph). */
function opBox(op: Op, s: number, out: number[]): void {
  if (op[0] === 'r') { out.push(op[1] * s - 1, op[2] * s - 1, (op[1] + op[3]) * s + 1, (op[2] + op[4]) * s + 1); return; }
  const px = op[5], w = (op[1].length * advOf(px) * 1.1 + 2) * s, x = op[2] * s, y = op[3] * s;
  const x0 = op[7] === 2 ? x - w : op[7] === 1 ? x - w / 2 : x;
  out.push(x0 - 2, y - (px * 1.1 + 2) * s, x0 + w + 2, y + (px * 0.4 + 2) * s);
}
/** Where two texts that differ only in some characters differ: the face is monospaced, so a
 *  timer's "3:43" → "3:44" is one glyph's box (padded), not the whole line's. Else false. */
function charBox(a: Op, b: Op, s: number, out: number[]): boolean {
  if (a[0] !== 't' || b[0] !== 't' || a[1].length !== b[1].length) return false;
  for (let k = 2; k < 8; k++) if (a[k] !== b[k]) return false;
  const t0 = a[1], t1 = b[1], n = t0.length;
  let i = 0, j = n - 1;
  while (i < n && t0.charCodeAt(i) === t1.charCodeAt(i)) i++;
  while (j > i && t0.charCodeAt(j) === t1.charCodeAt(j)) j--;
  if (i >= n) return true;
  const px = a[5], ad = advOf(px), x = a[2], y = a[3];
  const x0 = a[7] === 2 ? x - n * ad : a[7] === 1 ? x - (n * ad) / 2 : x;
  out.push((x0 + i * ad) * s - 3, y * s - (px * 1.1 + 2) * s, (x0 + (j + 1) * ad) * s + 3, y * s + (px * 0.4 + 2) * s);
  return true;
}
const sameOp = (a: Op, b: Op) => {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
};
/** Above this share of the board changed, it is simply repainted whole. */
const DIRTY_MAX = 0.3;

const fonts = new Map<number, string>();
function fontOf(px: number, bold: boolean): string {
  const q = Math.round(px * 4) / 4, key = bold ? -q : q;
  let f = fonts.get(key);
  if (f === undefined) { f = `${bold ? '700 ' : ''}${q}px ${FACE}`; fonts.set(key, f); }
  return f;
}

export class Board3 {
  private book = new SlotBook();
  private L: Layout | null = null;
  private scene: Scene | null = null;
  private tuple = '';
  private painted = '';
  /** the anchors of the last scene, and what they were laid out for (a new layout moves nothing) */
  private prev: Map<string, Anchor[]> | null = null;
  private prevFor = '';
  private prevVer = -1;
  private world: World | null = null;
  private transits: Transit[] = [];
  private hidden = new Set<string>();
  private hiddenVer = 0;
  private liveDirty = false;
  private hits: Hit[] = [];
  private said = '';
  private ratio = '';
  private measured = 0;
  private quiet = false;
  private lastPaint = 0;
  private lastLive = 0;
  private now = 0;
  /** the ops on the bitmap now, and the size and scale they were painted at */
  private shown: Op[] | null = null;
  private shownAt = '';
  /** For the tests and the HUD: how often the board was asked, built and painted; what moved. */
  stats = { asks: 0, builds: 0, paints: 0, livePaints: 0, transits: 0, ops: 0, moving: 0, squares: 0, texts: 0, dirty: 0, redrawn: 0 };

  /** The board layer. Returns true only while a transit is under way (the next frame may land it). */
  drawBoard(ctx: Ctx2D, f: Frame, w: World, now: number, a: BoardArgs): boolean {
    this.stats.asks++;
    this.now = f.time;
    const fresh = freshBitmap(f);
    this.land(f.time);
    const L = (this.L = layoutOf(f.width, f.height));
    if (fresh || this.measured !== L.s) {
      // the face's advance at each size (the scene fits words by it); again when the font arrives
      this.measured = L.s;
      this.ratio = '';
      for (const px of SIZES) {
        let a = 0;
        for (const bold of [false, true]) { ctx.font = fontOf(px * L.s, bold); a = Math.max(a, ctx.measureText('0000000000').width / 10); }
        setAdvance(px, a / L.s);
        this.ratio += `${a.toFixed(2)},`;
      }
    }
    // (a quiet board is the same until the world or the minute changes: it is not even rebuilt)
    const tuple = `${this.ratio}|${w.ver}|${Math.floor(now / (this.quiet ? 60_000 : 1000))}|${f.width}x${f.height}@${f.scale}|${a.win}|${a.sel}|${a.mode}|${a.dock ? 1 : 0}|${a.hov}|${this.hiddenVer}`;
    if (tuple === this.tuple && !fresh && this.world === w) return this.transits.length > 0;
    this.tuple = tuple;
    const opts = { win: a.win, sel: a.sel, mode: a.mode, dock: a.dock, hidden: this.hidden, hov: a.hov };
    const b = boardOf(w, now, windowMs(a.win), this.book);
    this.appIds = b.apps.cells.map((c) => c.id);
    this.where = b.where;
    this.quiet = b.quiet;
    let scene = sceneOf(b, L, opts);
    this.stats.builds++;
    // ---- motion: what changed place since the scene before, on a new version of this world
    const layoutFor = `${f.width}x${f.height}|${a.win}|${a.dock ? 1 : 0}`;
    const moved = this.prev && this.world === w && this.prevFor === layoutFor && w.ver !== this.prevVer && !a.reduced
      ? this.depart(this.prev, scene.anchors, L.s, f.time, now, a.mode === 'replay') : 0;
    if (moved) { scene = sceneOf(b, L, opts); this.stats.builds++; }
    this.prev = scene.anchors; this.prevFor = layoutFor; this.prevVer = w.ver; this.world = w;
    this.scene = scene;
    this.hits = scene.hits;
    // for the tests: where the bin's newest strip, the 2h chip and the newest red line are
    const said = `${f.width}x${f.height}|${scene.say.failed ?? ''}|${scene.say.chip ?? ''}|${scene.say.red ?? ''}`;
    if (said !== this.said) {
      this.said = said;
      if (scene.say.failed) console.log(`factory3: newest failed ${scene.say.failed}`);
      if (scene.say.chip) console.log(`factory3: window 2h at ${scene.say.chip}`);
      if (scene.say.red) console.log(`factory3: newest red ${scene.say.red}`);
    }
    const paintKey = `${f.width}x${f.height}@${f.scale}|${scene.key}`;
    if (paintKey !== this.painted || fresh) {
      this.painted = paintKey;
      this.paint(ctx, f, scene, L, fresh);
    }
    return this.transits.length > 0;
  }

  /** Transits whose time is up land: their mark is drawn where it now is. */
  private land(t: number): void {
    if (!this.transits.length) return;
    const n = this.transits.length;
    // (one the live layer never started, because it is covered or asleep, lands after a moment)
    this.transits = this.transits.filter((tr) => (tr.t0 >= 0 ? t < tr.t0 + tr.dur : t < tr.born + tr.delay + 1500));
    if (this.transits.length !== n) {
      this.hidden = new Set(this.transits.map((tr) => tr.key));
      this.hiddenVer++;
      this.liveDirty = true;
    }
  }

  /** Compares where every entity was with where it is; returns how many transits it started. */
  private depart(prev: Map<string, Anchor[]>, next: Map<string, Anchor[]>, s: number, t: number, now: number, fast: boolean): number {
    let made = 0;
    const base = fast ? 220 : 420;
    const line = (LINE_Y + 0.5) * s;
    const go = (from: { x: number; y: number; s: number }, to: Anchor, c: string, delay = 0): number => {
      if (this.transits.length >= MAX_TRANSITS || this.hidden.has(to.key)) return 0;
      const ax = (from.x + from.s / 2) * s, ay = (from.y + from.s / 2) * s;
      const bx = (to.x + to.s / 2) * s, by = (to.y + to.s / 2) * s;
      // between stations it rides the line: up to it, along it, down to its place. Inside one
      // station (a failure dropping into the bin) it goes straight: across, then down.
      const pts = Math.abs(bx - ax) < 24 * s || from.x < 0 ? (from.x < 0 ? [ax, line, bx, line, bx, by] : [ax, ay, bx, ay, bx, by]) : [ax, ay, ax, line, bx, line, bx, by];
      let len = 0;
      for (let i = 2; i < pts.length; i += 2) len += Math.abs(pts[i] - pts[i - 2]) + Math.abs(pts[i + 1] - pts[i - 1]);
      const dur = Math.min(fast ? 420 : 900, base + len * (fast ? 0.18 : 0.4));
      this.transits.push({ key: to.key, c, pts, len, s0: from.s * s, s1: to.s * s, born: t, delay, t0: -1, dur });
      this.hidden.add(to.key);
      made++;
      return delay + dur;
    };
    for (const [id, to] of next) {
      if (id.endsWith('#bin')) continue;
      const from = prev.get(id);
      const place = to[0].place;
      let landAt = 0;
      if (from && from[0].place < place) {
        // it moved on: every square it had flies to where it is now
        if (to.length >= from.length) to.forEach((a, i) => { landAt = Math.max(landAt, go(from[i % from.length], a, a.c)); });
        else from.forEach((a) => { landAt = Math.max(landAt, go(a, to[0], to[0].c)); });
      } else if (from && place === PLACE.slot && from[0].place === PLACE.slot && to.length > from.length) {
        // a run that spread to another agent: the new berth fills from the first
        for (const a of to) if (!from.some((p) => p.key === a.key)) go(from[0], a, a.c);
      } else if (!from && !id.startsWith('d:') && place <= PLACE.slot && this.fresh(id, now)) {
        // news: it enters from the left edge, level with where it goes
        for (const a of to) go({ x: -RIDE - 8, y: LINE_Y, s: RIDE }, a, a.c);
      }
      // a failure drops from its result into the bin, after it has landed there
      const bin = next.get(`${id}#bin`);
      if (bin && !prev.has(`${id}#bin`) && place === PLACE.result && landAt > 0) go(to[0], bin[0], bin[0].c, landAt);
    }
    if (made) { this.hiddenVer++; this.stats.transits += made; }
    return made;
  }

  private fresh(id: string, now: number): boolean {
    const p = this.world?.pipelines.get(id);
    return !!p && now - (p.started ?? p.created) < FRESH_MS && now - p.created < FRESH_MS * 4;
  }

  /** Paints the scene. Over the scene already on the bitmap (the same size, as many marks), only
   *  the boxes of the marks that changed are cleared and painted again, every mark under them in
   *  order and clipped to them: a clock's second repaints its timers and filling crates (well
   *  under 1 % of the board), not the board's ~600 marks. The pixels are the whole paint's. */
  private paint(ctx: Ctx2D, f: Frame, scene: Scene, L: Layout, fresh: boolean): void {
    this.stats.paints++;
    this.lastPaint = f.time;
    this.stats.ops = scene.ops.length;
    this.stats.squares = scene.counts.squares;
    this.stats.texts = scene.counts.texts;
    const s = L.s, dp = Math.max(1, f.scale || 1);
    const snap = (v: number) => Math.round(v * s * dp) / dp;
    const ops = scene.ops, prev = this.shown, at = `${f.width}x${f.height}@${dp}|${s}`;
    // the boxes that changed (device-pixel aligned), or null: paint it all
    let boxes: number[] | null = null;
    if (!fresh && prev && this.shownAt === at && prev.length === ops.length) {
      const raw: number[] = [];
      for (let i = 0; i < ops.length; i++) {
        if (sameOp(prev[i], ops[i]) || charBox(prev[i], ops[i], s, raw)) continue;
        opBox(prev[i], s, raw);
        opBox(ops[i], s, raw);
      }
      boxes = [];
      let area = 0;
      next: for (let i = 0; i < raw.length; i += 4) {
        const x0 = Math.max(0, Math.floor(raw[i] * dp) / dp), y0 = Math.max(0, Math.floor(raw[i + 1] * dp) / dp);
        const x1 = Math.min(f.width, Math.ceil(raw[i + 2] * dp) / dp), y1 = Math.min(f.height, Math.ceil(raw[i + 3] * dp) / dp);
        if (x1 <= x0 || y1 <= y0) continue;
        // (a mark that changed colour or size in place: its old box is its new one)
        for (let k = 0; k < boxes.length; k += 4) if (boxes[k] <= x0 && boxes[k + 1] <= y0 && boxes[k + 2] >= x1 && boxes[k + 3] >= y1) continue next;
        boxes.push(x0, y0, x1, y1);
        area += (x1 - x0) * (y1 - y0);
      }
      if (area > f.width * f.height * DIRTY_MAX) boxes = null;
      else this.stats.dirty = area / (f.width * f.height);
    }
    this.shown = ops;
    this.shownAt = at;
    ctx.resetTransform();
    ctx.globalAlpha = 1;
    let only: number[] | null = null;
    if (boxes) {
      if (!boxes.length) { this.stats.redrawn = 0; return; }
      for (let i = 0; i < boxes.length; i += 4) ctx.clearRect(boxes[i], boxes[i + 1], boxes[i + 2] - boxes[i], boxes[i + 3] - boxes[i + 1]);
      ctx.save();
      ctx.beginPath();
      for (let i = 0; i < boxes.length; i += 4) ctx.rect(boxes[i], boxes[i + 1], boxes[i + 2] - boxes[i], boxes[i + 3] - boxes[i + 1]);
      ctx.clip();
      only = boxes;
    } else {
      this.stats.dirty = 1;
      ctx.clearRect(0, 0, f.width, f.height);
    }
    let fill = '', font = '', align = -1, redrawn = 0;
    const box: number[] = [];
    for (const op of ops) {
      if (only) {
        // only the marks under a changed box
        box.length = 0;
        opBox(op, s, box);
        let hit = false;
        for (let i = 0; i < only.length; i += 4) if (box[0] < only[i + 2] && box[2] > only[i] && box[1] < only[i + 3] && box[3] > only[i + 1]) { hit = true; break; }
        if (!hit) continue;
      }
      redrawn++;
      if (op[0] === 'r') {
        const x = snap(op[1]), y = snap(op[2]);
        const w = Math.max(1 / dp, snap(op[1] + op[3]) - x), h = Math.max(1 / dp, snap(op[2] + op[4]) - y);
        if (fill !== op[5]) { fill = op[5]; ctx.fillStyle = fill; }
        ctx.fillRect(x, y, w, h);
      } else {
        const ft = fontOf(op[5] * s, op[6] === 1);
        if (font !== ft) { font = ft; ctx.font = ft; }
        if (align !== op[7]) { align = op[7]; ctx.textAlign = op[7] === 2 ? 'right' : op[7] === 1 ? 'center' : 'left'; }
        if (fill !== op[4]) { fill = op[4]; ctx.fillStyle = fill; }
        ctx.fillText(op[1], snap(op[2]), snap(op[3]));
      }
    }
    if (only) ctx.restore();
    this.stats.redrawn = redrawn;
  }

  /** The live layer: the squares in transit, and nothing else. Asleep (no frame asked) otherwise. */
  drawLive(ctx: Ctx2D, f: Frame): boolean {
    const t = f.time;
    const fresh = freshBitmap(f);
    if (!this.transits.length) {
      if (this.liveDirty || fresh) { ctx.resetTransform(); ctx.clearRect(0, 0, f.width, f.height); this.liveDirty = false; }
      this.stats.moving = 0;
      return false;
    }
    this.stats.livePaints++;
    this.lastLive = t;
    this.liveDirty = true;
    ctx.resetTransform();
    ctx.globalAlpha = 1;
    ctx.clearRect(0, 0, f.width, f.height);
    const ride = RIDE * (this.L?.s ?? 1);
    let moving = 0;
    for (const tr of this.transits) {
      if (tr.t0 < 0) tr.t0 = Math.max(t, tr.born) + tr.delay;
      if (t < tr.t0) continue;
      moving++;
      // (past its time it rests on its mark until the board, which draws first, lands it)
      const u = easeInOut(Math.min(1, (t - tr.t0) / tr.dur));
      let d = tr.len * u, x = tr.pts[0], y = tr.pts[1];
      for (let i = 2; i < tr.pts.length; i += 2) {
        const seg = Math.abs(tr.pts[i] - tr.pts[i - 2]) + Math.abs(tr.pts[i + 1] - tr.pts[i - 1]);
        if (d <= seg || i === tr.pts.length - 2) {
          const k = seg ? Math.min(1, d / seg) : 1;
          x = tr.pts[i - 2] + (tr.pts[i] - tr.pts[i - 2]) * k; y = tr.pts[i - 1] + (tr.pts[i + 1] - tr.pts[i - 1]) * k;
          break;
        }
        d -= seg;
      }
      // its own size where it leaves and where it lands; the line's size between
      const size = u < 0.18 ? tr.s0 + (ride - tr.s0) * (u / 0.18) : u > 0.82 ? ride + (tr.s1 - ride) * ((u - 0.82) / 0.18) : ride;
      ctx.fillStyle = tr.c;
      ctx.fillRect(x - size / 2, y - size / 2, size, size);
    }
    this.stats.moving = moving;
    return true;
  }

  /** What is under (x, y) (CSS px of the canvas): the topmost hit. */
  pick(x: number, y: number): Hit | null {
    const s = this.L?.s ?? 1;
    const lx = x / s, ly = y / s;
    for (let i = this.hits.length - 1; i >= 0; i--) {
      const h = this.hits[i];
      if (lx < h.x || lx > h.x + h.w || ly < h.y || ly > h.y + h.h) continue;
      if (h.kind !== 'appgrid') return h;
      // the apps grid: the cell under the point
      const [gx, gy, gp, per, n] = h.id.split(',').map(Number);
      const i2 = Math.floor((ly - gy) / gp) * per + Math.floor((lx - gx) / gp);
      if (i2 >= 0 && i2 < n && this.appIds[i2]) return { kind: 'app', id: this.appIds[i2], x: gx + (i2 % per) * gp - 1, y: gy + Math.floor(i2 / per) * gp - 1, w: gp, h: gp };
      return null;
    }
    return null;
  }
  /** the apps in the grid's order (model.ts sorts them by name) */
  appIds: string[] = [];
  /** a running run → its berth, for the inspector */
  where = new Map<string, string>();
  statsLine(): string {
    const st = this.stats;
    return `transits=${st.transits} live=${st.livePaints}`;
  }
  /** For the HUD and the perf tools: asked, built, painted. */
  workLine(): string {
    const st = this.stats;
    return `board paints ${st.paints} · moving-layer paints ${st.livePaints} · transits ${st.transits} · scene builds ${st.builds} · ${st.ops} marks · last paint ${(st.dirty * 100).toFixed(2)} % of the board, ${st.redrawn} marks`;
  }
  /** "still": no pixel of either canvas has changed for two seconds (and one was painted at all). */
  get still(): boolean { return this.stillAt(this.now); }
  /** The same at the module clock `t`: a still board is not drawn at all on macOS (its arguments
   *  unchanged), so the last draw's time stops; the clock goes on. */
  stillAt(t: number): boolean {
    return this.stats.paints > 0 && !this.transits.length && Math.max(t, this.now) - Math.max(this.lastPaint, this.lastLive) >= 2000;
  }
  get moving(): boolean { return this.transits.length > 0; }
  /** Something on the board runs or waits (a timer it shows follows the second): not quiet. */
  get ticking(): boolean { return this.tuple !== '' && !this.quiet; }
}
