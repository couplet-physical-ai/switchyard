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
import { SlotBook, boardAt, boardOf, windowMs, type Board } from './model.ts';
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

const causeIs = (f: Frame, k: string) => (f.causes.length ? f.causes.includes(k as never) : f.cause === k);
function freshBitmap(f: Frame): boolean {
  return causeIs(f, 'mount') || causeIs(f, 'size') || causeIs(f, 'font') || causeIs(f, 'style');
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
/** the tiles (CSS px) a repaint's share is counted in, and its marks found by */
const TILE = 16;
/** over this many changed boxes, a repaint is cleared and clipped by its tiles (tileRuns) */
const MANY_BOXES = 24;
/** p5-board: the order the marks are painted in. Every change of font sends the face's whole
 *  family list (Exact's recorder: a number per character, ~400 B), and the board's words alternate
 *  fonts (a bold name, a plain detail): ~120 font changes, half of a whole board's ~100 KB. So a
 *  word that no later mark and no other word overlaps is painted last, with the others of its
 *  font (and colour): nothing painted after it covers it, and it covers nothing painted after
 *  it, so the pixels are the same. The rest keep their places. (Off: the bench's reference.) */
let groupWords = true;
/** A mark's ink (CSS px), for the order: a square's own box and a pixel round it; a word's run of
 *  advances (the face is monospaced) and two pixels each side, an em above its baseline and
 *  0.35 em under it, a pixel more each way (opBox, the repaints' box, is far looser). */
function inkBox(op: Op, s: number, out: number[]): void {
  if (op[0] === 'r') { out.push(op[1] * s - 1, op[2] * s - 1, (op[1] + op[3]) * s + 1, (op[2] + op[4]) * s + 1); return; }
  const px = op[5], w = op[1].length * advOf(px) * s, x = op[2] * s, y = op[3] * s;
  const x0 = op[7] === 2 ? x - w : op[7] === 1 ? x - w / 2 : x;
  out.push(x0 - 2, y - (px + 1) * s, x0 + w + 2, y + (px * 0.35 + 1) * s);
}
export function setGroupWords(on: boolean): void { groupWords = on; }
const ordBox: number[] = [];
function paintOrder(ops: Op[], s: number, cols: number, rows: number, group: boolean): number[] {
  const n = ops.length, order: number[] = [];
  if (!groupWords || !group) { for (let i = 0; i < n; i++) order.push(i); return order; }
  // each mark's box and the tiles it is on (a list of marks per tile)
  const B = new Float64Array(n * 4), head = new Int32Array(cols * rows).fill(-1), nxt: number[] = [], itm: number[] = [];
  for (let i = 0; i < n; i++) {
    ordBox.length = 0;
    inkBox(ops[i], s, ordBox);
    B[i * 4] = ordBox[0]; B[i * 4 + 1] = ordBox[1]; B[i * 4 + 2] = ordBox[2]; B[i * 4 + 3] = ordBox[3];
    const tx0 = Math.max(0, Math.floor(ordBox[0] / TILE)), tx1 = Math.min(cols - 1, Math.floor(ordBox[2] / TILE));
    for (let ty = Math.max(0, Math.floor(ordBox[1] / TILE)), ty1 = Math.min(rows - 1, Math.floor(ordBox[3] / TILE)); ty <= ty1; ty++) {
      for (let tx = tx0; tx <= tx1; tx++) { const t = ty * cols + tx; itm.push(i); nxt.push(head[t]); head[t] = itm.length - 1; }
    }
  }
  const late: number[] = [];
  for (let i = 0; i < n; i++) {
    if (ops[i][0] !== 't') { order.push(i); continue; }
    let free = true;
    const x0 = B[i * 4], y0 = B[i * 4 + 1], x1 = B[i * 4 + 2], y1 = B[i * 4 + 3];
    const tx0 = Math.max(0, Math.floor(x0 / TILE)), tx1 = Math.min(cols - 1, Math.floor(x1 / TILE));
    scan: for (let ty = Math.max(0, Math.floor(y0 / TILE)), ty1 = Math.min(rows - 1, Math.floor(y1 / TILE)); ty <= ty1; ty++) {
      for (let tx = tx0; tx <= tx1; tx++) {
        for (let e = head[ty * cols + tx]; e >= 0; e = nxt[e]) {
          const j = itm[e];
          if (j === i || (j < i && ops[j][0] === 'r')) continue; // (a square painted before it stays under it)
          if (B[j * 4] < x1 && B[j * 4 + 2] > x0 && B[j * 4 + 1] < y1 && B[j * 4 + 3] > y0) { free = false; break scan; }
        }
      }
    }
    if (free) late.push(i); else order.push(i);
  }
  // (by font, then colour, each in the scene's order)
  const key = (i: number) => { const op = ops[i] as ['t', string, number, number, string, number, 0 | 1, 0 | 1 | 2]; return `${op[6]}|${op[5]}|${op[4]}`; };
  const keys = late.map(key);
  const idx = late.map((_, k) => k).sort((a, b) => (keys[a] < keys[b] ? -1 : keys[a] > keys[b] ? 1 : a - b));
  for (const k of idx) order.push(late[k]);
  return order;
}

/** The dirty tiles as rects (x0, y0, x1, y1, CSS px): runs along each row of tiles, a run that
 *  continues the same run of the row above merged into it. */
function tileRuns(T: Uint8Array, cols: number, rows: number, W: number, H: number): number[] {
  const out: number[] = [];
  let open = new Map<number, number>(), was = open;
  for (let ty = 0; ty < rows; ty++) {
    was = open; open = new Map();
    for (let tx = 0; tx < cols; tx++) {
      if (!T[ty * cols + tx]) continue;
      const a = tx;
      while (tx + 1 < cols && T[ty * cols + tx + 1]) tx++;
      const key = a * 4096 + tx, k = was.get(key);
      const y1 = Math.min(H, (ty + 1) * TILE);
      if (k !== undefined) { out[k + 3] = y1; open.set(key, k); }
      else { open.set(key, out.length); out.push(a * TILE, ty * TILE, Math.min(W, (tx + 1) * TILE), y1); }
    }
  }
  return out;
}

/** p5-board: where two scenes' marks differ, as boxes (CSS px) pushed to `out`. Both lists are
 *  walked in order and aligned again after marks that came or went (a scene keeps its marks in
 *  order: a run that arrives, leaves or lands adds or drops its own), so a change in the number
 *  of marks repaints the marks that changed, not the board. A whole board is 100-180 KB of list
 *  (Exact's recorder, base64, JSON: 40-85 ms in Bun without its JIT, a few times that on the
 *  mini's Hermes); at 10× the count changed about once a second. The marks matched keep their
 *  order in both lists, so any pixel outside every box is painted by the same marks in the same
 *  order. A pair that differs in place (a timer's digit) is its characters' box (`charBox`).
 *  False: the lists are too far apart to align within the budget (paint it all). */
const ALIGN = 24, ALIGN_BUDGET = 6000;
export function diffOps(prev: Op[], ops: Op[], s: number, out: number[]): boolean {
  const n = prev.length, m = ops.length;
  let i = 0, j = 0, budget = ALIGN_BUDGET;
  while (i < n && j < m) {
    if (sameOp(prev[i], ops[j])) { i++; j++; continue; }
    // the nearest pair that is the same again: x marks of the old list went, y of the new came
    let a = -1, b = -1;
    find: for (let d = 1; d <= 2 * ALIGN; d++) {
      for (let x = Math.max(0, d - ALIGN); x <= Math.min(d, ALIGN); x++) {
        const y = d - x;
        if (i + x >= n || j + y >= m) continue;
        if (--budget < 0) return false;
        if (sameOp(prev[i + x], ops[j + y])) { a = x; b = y; break find; }
      }
    }
    // (none near: this pair changed; the walk goes on)
    if (a < 0) { a = 1; b = 1; }
    const k = Math.min(a, b);
    for (let q = 0; q < k; q++) if (!charBox(prev[i + q], ops[j + q], s, out)) { opBox(prev[i + q], s, out); opBox(ops[j + q], s, out); }
    for (let q = k; q < a; q++) opBox(prev[i + q], s, out);
    for (let q = k; q < b; q++) opBox(ops[j + q], s, out);
    i += a; j += b;
  }
  for (; i < n; i++) opBox(prev[i], s, out);
  for (; j < m; j++) opBox(ops[j], s, out);
  return true;
}

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
  /** the tiles a repaint touches (paint) */
  private tiles = new Uint8Array(0);
  /** p6: the last model, and what it was made of (the world, its version, the minute, the window):
   *  a second later with nothing else changed, only what follows the second is asked again */
  private model: Board | null = null;
  private modelOf: World | null = null;
  private modelKey = '';
  /** For the tests and the HUD: how often the board was asked, built and painted; what moved. */
  stats = { asks: 0, builds: 0, paints: 0, livePaints: 0, transits: 0, ops: 0, moving: 0, squares: 0, texts: 0, dirty: 0, redrawn: 0, claims: 0 };

  /** p5-board: the macOS host gives a canvas to its GPU module (Vello, Metal) only if the first
   *  draw with anything in it after a fresh bitmap (a mount, a new size) asks for the next frame.
   *  Otherwise Core Graphics keeps it for the bitmap's life, and while it animates (a transit:
   *  both layers ask for frames until it lands) Core Animation records and replays, on the main
   *  thread, every list the canvas kept since its last cover, each frame: the board's partial
   *  repaints never cover, so that is up to 64 lists a frame (PERF.md, "Where the native frame
   *  went": the factory's same finding; the Yard's `claim`). So the live layer's first paint on a
   *  fresh bitmap asks for one more frame, which draws nothing. Off: the tests' idle counts.
   *
   *  p6: the board itself stays with Core Graphics (`boardGpu` off). On the GPU every repaint is
   *  a replay of the whole canvas (the module copies the last surface, then draws the list: 4.7-7.9
   *  ms on the mini for a second's timers, ~0.1 % of the board), where Core Graphics paints the
   *  list into the bitmap it keeps. Core Animation records a canvas only while it animates, from a
   *  list that covers it: the board's first paint on a fresh bitmap asks for no frame (a transit
   *  then in flight lands at once), and its whole repaints are clipped to the canvas, so no list of
   *  the board ever covers it; its partial repaints never do. While a run's square travels the
   *  board still asks for frames (to land it), drawn into the kept bitmap off the main thread. */
  static gpuClaim = true;
  /** p6: the board claims the GPU too, as in pass 5 (a hidden switch for the A/B: SWITCHYARD_CANVAS=gpu) */
  static boardGpu = false;
  private claim = { board: false, live: false };
  /** a fresh bitmap whose draw was skipped (the board covered, app.ts `draw`): the next draw is
   *  its first, painted whole */
  private owed = { board: false, live: false };
  /** A draw of `which` was skipped (covered): a fresh bitmap in it is owed its first paint. */
  skipped(which: 'board' | 'live', f: Frame): void { if (freshBitmap(f)) this.owed[which] = true; }
  private freshFor(which: 'board' | 'live', f: Frame): boolean {
    const fresh = freshBitmap(f) || this.owed[which];
    this.owed[which] = false;
    if (fresh) this.claim[which] = Board3.gpuClaim && (which === 'live' || Board3.boardGpu);
    return fresh;
  }
  private claimed(which: 'board' | 'live'): boolean {
    if (!this.claim[which]) return false;
    this.claim[which] = false;
    this.stats.claims++;
    return true;
  }

  /** The board layer. Returns true only while a transit is under way (the next frame may land it);
   *  never on a fresh bitmap's first paint (p6: the board stays with Core Graphics). */
  drawBoard(ctx: Ctx2D, f: Frame, w: World, now: number, a: BoardArgs): boolean {
    const paints = this.stats.paints;
    const more = this.drawBoard0(ctx, f, w, now, a);
    // (the claim goes with the draw that painted: a fresh bitmap's first lists decide)
    return (this.stats.paints !== paints && this.claimed('board')) || more;
  }
  private drawBoard0(ctx: Ctx2D, f: Frame, w: World, now: number, a: BoardArgs): boolean {
    this.stats.asks++;
    this.now = f.time;
    const fresh = this.freshFor('board', f);
    // p6: a fresh bitmap's first paint asks for no frame (so Core Graphics keeps the board): what
    // was travelling is simply where it is (the board shown again, or a new size)
    if (fresh && !Board3.boardGpu && this.transits.length) {
      this.transits = [];
      this.hidden = new Set();
      this.hiddenVer++;
      this.liveDirty = true;
    }
    this.land(f.time);
    const L = (this.L = layoutOf(f.width, f.height));
    // (a board mounted again, as it is each time the Factory is shown again, keeps what it measured)
    if (this.measured !== L.s || causeIs(f, 'font') || causeIs(f, 'style')) {
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
    if (tuple === this.tuple && this.world === w) {
      // the board shown again with nothing changed since: the scene it showed, painted (not built)
      if (fresh && this.scene && this.L) { this.painted = `${f.width}x${f.height}@${f.scale}|${this.scene.key}`; this.paint(ctx, f, this.scene, L, true); }
      return this.transits.length > 0;
    }
    this.tuple = tuple;
    const opts = { win: a.win, sel: a.sel, mode: a.mode, dock: a.dock, hidden: this.hidden, hov: a.hov };
    // (p6: the same world, version, minute and window as the last model: the second's parts only)
    const mk = `${w.ver}|${Math.floor(now / 60_000)}|${a.win}`;
    const b = this.model && this.modelOf === w && this.modelKey === mk ? boardAt(this.model, w, now) : boardOf(w, now, windowMs(a.win), this.book);
    this.model = b; this.modelOf = w; this.modelKey = mk;
    this.appIds = b.apps.cells.map((c) => c.id);
    this.where = b.where;
    this.quiet = b.quiet;
    let scene = sceneOf(b, L, opts);
    this.stats.builds++;
    // ---- motion: what changed place since the scene before, on a new version of this world
    const layoutFor = `${f.width}x${f.height}|${a.win}|${a.dock ? 1 : 0}`;
    // (on a new bitmap, the board shown again, what moved while it was away is simply where it is:
    // it moved unseen, and a transit would replay it and build the scene twice in that frame)
    const moved = this.prev && this.world === w && this.prevFor === layoutFor && w.ver !== this.prevVer && !a.reduced && !fresh
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
    let boxes: number[] | null = null, exact = true;
    const raw: number[] = [];
    // (p5-board: the share is the boxes' union counted in 16 px tiles, not their sum: a list whose
    // rows all moved down one is many overlapping boxes over one column, not a third of the board)
    const cols = Math.ceil(f.width / TILE), rows = Math.ceil(f.height / TILE);
    if (this.tiles.length !== cols * rows) this.tiles = new Uint8Array(cols * rows);
    const T = this.tiles;
    if (!fresh && prev && this.shownAt === at && diffOps(prev, ops, s, raw)) {
      boxes = [];
      T.fill(0);
      let area = 0, tiles = 0;
      next: for (let i = 0; i < raw.length; i += 4) {
        const x0 = Math.max(0, Math.floor(raw[i] * dp) / dp), y0 = Math.max(0, Math.floor(raw[i + 1] * dp) / dp);
        const x1 = Math.min(f.width, Math.ceil(raw[i + 2] * dp) / dp), y1 = Math.min(f.height, Math.ceil(raw[i + 3] * dp) / dp);
        if (x1 <= x0 || y1 <= y0) continue;
        // (a mark that changed colour or size in place: its old box is its new one)
        for (let k = 0; k < boxes.length; k += 4) if (boxes[k] <= x0 && boxes[k + 1] <= y0 && boxes[k + 2] >= x1 && boxes[k + 3] >= y1) continue next;
        boxes.push(x0, y0, x1, y1);
        area += (x1 - x0) * (y1 - y0);
        for (let ty = Math.floor(y0 / TILE), ty1 = Math.min(rows - 1, Math.floor((y1 - 1e-6) / TILE)); ty <= ty1; ty++) {
          for (let tx = Math.floor(x0 / TILE), tx1 = Math.min(cols - 1, Math.floor((x1 - 1e-6) / TILE)); tx <= tx1; tx++) if (!T[ty * cols + tx]) { T[ty * cols + tx] = 1; tiles++; }
        }
      }
      if (tiles > cols * rows * DIRTY_MAX) boxes = null;
      else if (boxes.length > 4 * MANY_BOXES) {
        // many boxes (a list whose rows all moved): cleared and clipped as their tiles, merged into
        // runs, a few rects instead of hundreds; every mark on those tiles is painted again
        boxes = tileRuns(T, cols, rows, f.width, f.height);
        exact = false;
        this.stats.dirty = tiles / (cols * rows);
      } else this.stats.dirty = Math.min(1, area / (f.width * f.height));
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
      // (p6: the clear clipped to the canvas, the same pixels: the host never takes a list of the
      // board for a cover, so Core Animation never records it while a transit animates; boardGpu)
      if (Board3.boardGpu) ctx.clearRect(0, 0, f.width, f.height);
      else { ctx.save(); ctx.beginPath(); ctx.rect(0, 0, f.width, f.height); ctx.clip(); ctx.clearRect(0, 0, f.width, f.height); ctx.restore(); }
    }
    let fill = '', font = '', align = -1, redrawn = 0;
    const box: number[] = [];
    // (a few small boxes, a second's timers: in the scene's order; a whole or a tiled repaint grouped)
    for (const oi of paintOrder(ops, s, cols, rows, !only || !exact)) {
      const op = ops[oi];
      if (only) {
        // only the marks under a changed box (its tiles first: most marks are under none)
        box.length = 0;
        opBox(op, s, box);
        let near = false;
        const tx0 = Math.max(0, Math.floor(box[0] / TILE)), tx1 = Math.min(cols - 1, Math.floor(box[2] / TILE));
        for (let ty = Math.max(0, Math.floor(box[1] / TILE)), ty1 = Math.min(rows - 1, Math.floor(box[3] / TILE)); ty <= ty1 && !near; ty++) {
          for (let tx = tx0; tx <= tx1; tx++) if (T[ty * cols + tx]) { near = true; break; }
        }
        if (!near) continue;
        let hit = !exact;
        for (let i = 0; i < only.length && !hit; i += 4) if (box[0] < only[i + 2] && box[2] > only[i] && box[1] < only[i + 3] && box[3] > only[i + 1]) hit = true;
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
    const fresh = this.freshFor('live', f);
    if (!this.transits.length) {
      if (this.liveDirty || fresh) { ctx.resetTransform(); ctx.clearRect(0, 0, f.width, f.height); this.liveDirty = false; }
      this.stats.moving = 0;
      return fresh && this.claimed('live');
    }
    if (fresh) this.claimed('live'); // (a transit asks for the frames itself)
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
