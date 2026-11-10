// One canvas, any number of rows (DESIGN.md, "Views"): the reusable table behind Mainlines and
// PRs. A list of 400 Contract rows with a canvas each costs 400 surfaces and 400 backing stores
// (×4 on Retina); this is ONE surface whose draw paints only the rows in the viewport, so a row
// off screen costs nothing.
//
//   layout          rows are `dense` px (LOD2); a focused or hovered row eases to `open` px
//                   (LOD0) over ~150 ms. Only expanded rows differ, so a row's y is its index
//                   times `dense` plus the few expansions above it: O(expanded), never O(rows).
//   virtualization  the draw walks the index range under the viewport, nothing else.
//   scroll physics  wheel deltas move a target, clamped to the content; the offset eases to it
//                   (exponential, ~70 ms), so a mouse's notches glide and a trackpad's stream is
//                   followed closely.
//   anchoring       when rows above the pointer (or the focus) grow or shrink, the offset moves
//                   with them, so the row under the pointer stays under it: no hover ping-pong.
//   hover LOD       the row under a resting pointer (a dwell of 90 ms, none while scrolling)
//                   opens; leaving it closes. Hysteresis comes from the dwell plus the anchor.
//   reorders        rows that change place when the data re-sorts slide there (200 ms).
//   hit test        rows by y (the same walk as the layout), and the targets an open row
//                   registered while it was drawn (its links and dots), like the yard's `pickAt`.
//
// The data module owns the state (one table per view, alive across visits); Contract hands in
// what it knows (wheel sum, pointer, focus) as canvas arguments, so a change redraws.

import type { Ctx2D, Frame } from '../../app.contract.d.ts';
import { C, clamp, easeInOut } from '../yard/theme.ts';
import { withAlpha } from '../yard/paint.ts';

/** A target inside a row, in canvas coordinates, registered by the row's painter. */
export type SubHit = { x: number; y: number; w: number; h: number; kind: string; id: string; route: string; label: string };

/** What a painter is told about one row. `e` is the row's expansion, 0 (LOD2) to 1 (LOD0),
 *  already eased; `hits` takes the row's targets (only for rows open enough to show them). */
export type RowCtx = { y: number; h: number; W: number; e: number; focused: boolean; hovered: boolean; hits: SubHit[] | null; now: number; index: number };

export type Painter<R> = (ctx: Ctx2D, row: R, rc: RowCtx) => void;

export type Pick = { key: string; index: number; sub: SubHit | null };

const EXPAND_MS = 150;
const DWELL_MS = 90;
const SCROLL_TAU = 70;
const MOVE_MS = 200;
const QUIET_AFTER_WHEEL = 160;

export class CanvasTable<R> {
  rows: R[] = [];
  keys: string[] = [];
  index = new Map<string, number>();
  /** LOD2 and LOD0 row heights, px. */
  dense: number;
  open: number;
  padTop = 0;
  padBottom = 12;
  W = 0;
  H = 0;
  /** The offset shown and the one it eases to, px from the content's top. */
  scroll = 0;
  target = 0;
  focus = '';
  hover = '';
  /** Rows the last draw painted (the rest cost nothing). */
  lastPainted = 0;
  hits: SubHit[] = [];

  private exp = new Map<string, number>(); // key → linear progress 0..1 (absent = 0)
  private expList: [number, number][] = []; // [index, extra px] sorted by index, rebuilt each step
  private lastT = -1;
  private wheelSeen = NaN;
  private lastWheelAt = -1e9;
  private px = -1;
  private py = -1;
  private candidate = '';
  private candidateSince = 0;
  private pending = ''; // a focus to reveal once its row exists (a deep link before the data)
  private revealed = '';
  private moves = new Map<string, { from: number; t0: number }>();
  private barUntil = -1;
  private now = 0;

  constructor(readonly keyOf: (r: R) => string, dense: number, open: number) {
    this.dense = dense;
    this.open = open;
  }

  // ---- data ----------------------------------------------------------------------------------

  /** New rows (a filter, or the world changed). Keeps the offset; rows that moved slide. */
  setRows(rows: R[]): void {
    const before = new Map<string, number>();
    if (this.rows.length && this.H > 0) {
      // screen positions of what is on screen now (and a screen around it)
      const [i0, i1] = this.range(this.scroll - this.H, this.scroll + 2 * this.H);
      for (let i = i0; i <= i1 && i < this.keys.length; i++) before.set(this.keys[i], this.yOf(i));
    }
    this.rows = rows;
    this.keys = rows.map(this.keyOf);
    this.index = new Map(this.keys.map((k, i) => [k, i]));
    for (const k of Array.from(this.exp.keys())) if (!this.index.has(k)) this.exp.delete(k);
    for (const k of Array.from(this.moves.keys())) if (!this.index.has(k)) this.moves.delete(k);
    this.rebuildExp();
    if (before.size && before.size < 400) {
      for (const [k, oldY] of before) {
        const i = this.index.get(k);
        if (i === undefined) continue;
        const d = oldY - this.yOf(i);
        if (Math.abs(d) >= 1 && Math.abs(d) < 3 * this.H) this.moves.set(k, { from: d + this.moveOffset(k), t0: this.now });
      }
    }
    this.clampTarget();
    this.scroll = clamp(this.scroll, 0, this.maxScroll());
    if (this.pending && this.index.has(this.pending)) this.reveal(this.pending);
  }

  // ---- input ---------------------------------------------------------------------------------

  /** Contract's running sum of wheel deltaY: the change since the last one scrolls. */
  syncWheel(sum: number): void {
    if (!Number.isFinite(sum)) return;
    if (Number.isNaN(this.wheelSeen)) { this.wheelSeen = sum; return; }
    const dy = sum - this.wheelSeen;
    this.wheelSeen = sum;
    if (dy) this.scrollBy(dy);
  }

  scrollBy(dy: number): void {
    this.target = clamp(this.target + dy, 0, this.maxScroll());
    this.lastWheelAt = this.now;
    this.barUntil = this.now + 900;
  }

  scrollTo(y: number): void {
    this.target = clamp(y, 0, this.maxScroll());
    this.barUntil = this.now + 900;
  }

  /** The pointer over the canvas (-1: not over it). */
  pointer(x: number, y: number): void {
    this.px = x;
    this.py = y;
    if (y < 0) { this.candidate = ''; this.hover = ''; }
  }

  /** The focused row; a new focus is scrolled into view (centred when it is far away). */
  setFocus(key: string): void {
    if (key === this.focus) {
      if (key && this.revealed !== key && this.index.has(key)) this.reveal(key);
      return;
    }
    this.focus = key;
    if (key) this.reveal(key);
  }

  reveal(key: string): void {
    const i = this.index.get(key);
    if (i === undefined) { this.pending = key; return; }
    this.pending = '';
    this.revealed = key;
    if (this.H <= 0) { this.pending = key; return; }
    const top = this.yOf(i);
    const h = this.open;
    const margin = Math.min(this.dense * 2, this.H / 4);
    const viewTop = this.target, viewBot = this.target + this.H;
    if (top >= viewTop + margin && top + h <= viewBot - margin) return;
    const far = top + h < this.scroll - this.H || top > this.scroll + 2 * this.H;
    if (far) {
      // a jump: centre it, and start the glide close by
      this.target = clamp(top - this.H / 3, 0, this.maxScroll());
      this.scroll = clamp(this.target + Math.sign(this.scroll - this.target) * this.H * 0.5, 0, this.maxScroll());
    } else if (top < viewTop + margin) this.target = clamp(top - margin, 0, this.maxScroll());
    else this.target = clamp(top + h - this.H + margin, 0, this.maxScroll());
  }

  /** The key `step` rows from the focus (or the first row on screen). */
  neighbour(step: number): string {
    if (!this.keys.length) return '';
    const cur = this.index.get(this.focus);
    if (cur === undefined) {
      const [i0] = this.range(this.target, this.target + this.H);
      return this.keys[clamp(i0, 0, this.keys.length - 1)];
    }
    return this.keys[clamp(cur + step, 0, this.keys.length - 1)];
  }

  /** What is at a point of the canvas: an open row's own target first, else the row. */
  pick(x: number, y: number): Pick | null {
    for (let k = this.hits.length - 1; k >= 0; k--) {
      const h = this.hits[k];
      if (x >= h.x && x <= h.x + h.w && y >= h.y && y <= h.y + h.h) {
        const i = this.rowAtY(y + this.scroll);
        return { key: i >= 0 ? this.keys[i] : '', index: i, sub: h };
      }
    }
    const i = this.rowAtY(y + this.scroll);
    if (i < 0) return null;
    return { key: this.keys[i], index: i, sub: null };
  }

  /** The first row whose top is at or below the target offset (what a test reads). */
  topKey(): string {
    if (!this.keys.length) return '';
    const i = this.rowAtY(Math.max(this.target, this.padTop));
    if (i < 0) return '';
    const top = this.yOf(i);
    return this.keys[top < this.target - 0.5 && i + 1 < this.keys.length ? i + 1 : i];
  }

  /** Whether the list is scrolled to its end (its last row in view). */
  atEnd(): boolean {
    return this.H > 0 && this.keys.length > 0 && this.target >= this.maxScroll() - 1;
  }

  /** Whether a row is on screen (at the target offset). */
  visible(key: string): boolean {
    const i = this.index.get(key);
    if (i === undefined || this.H <= 0) return false;
    const top = this.yOf(i);
    return top + this.dense > this.target && top < this.target + this.H;
  }

  // ---- layout --------------------------------------------------------------------------------

  private extraOf(v: number): number {
    return (this.open - this.dense) * easeInOut(clamp(v, 0, 1));
  }

  private rebuildExp(): void {
    const list: [number, number][] = [];
    for (const [k, v] of this.exp) {
      const i = this.index.get(k);
      if (i === undefined || v <= 0) continue;
      list.push([i, this.extraOf(v)]);
    }
    list.sort((a, b) => a[0] - b[0]);
    this.expList = list;
  }

  /** Top of row `i` in content px. */
  yOf(i: number): number {
    let y = this.padTop + i * this.dense;
    for (const [j, ex] of this.expList) { if (j >= i) break; y += ex; }
    return y;
  }

  heightOf(i: number): number {
    for (const [j, ex] of this.expList) { if (j === i) return this.dense + ex; if (j > i) break; }
    return this.dense;
  }

  /** The row at content y, or -1 past either end. */
  rowAtY(cy: number): number {
    const n = this.keys.length;
    if (!n) return -1;
    let y = cy - this.padTop;
    if (y < 0) return -1;
    let acc = 0;
    for (const [j, ex] of this.expList) {
      const top = j * this.dense + acc;
      if (y < top) break;
      if (y < top + this.dense + ex) return j;
      acc += ex;
    }
    const i = Math.floor((y - acc) / this.dense);
    return i < n ? i : -1;
  }

  /** The index range touching content y0..y1 (clamped to the rows). */
  range(y0: number, y1: number): [number, number] {
    const n = this.keys.length;
    if (!n) return [0, -1];
    let a = this.rowAtY(Math.max(this.padTop, y0));
    if (a < 0) a = y0 <= this.padTop ? 0 : n - 1;
    let b = this.rowAtY(y1);
    if (b < 0) b = n - 1;
    return [a, Math.max(a, b)];
  }

  contentH(): number {
    let extra = 0;
    for (const [, ex] of this.expList) extra += ex;
    return this.padTop + this.keys.length * this.dense + extra + this.padBottom;
  }

  maxScroll(): number {
    return Math.max(0, this.contentH() - this.H);
  }

  private clampTarget(): void {
    this.target = clamp(this.target, 0, this.maxScroll());
  }

  private moveOffset(key: string): number {
    const m = this.moves.get(key);
    if (!m) return 0;
    const u = clamp((this.now - m.t0) / MOVE_MS, 0, 1);
    return m.from * (1 - easeInOut(u));
  }

  // ---- time ----------------------------------------------------------------------------------

  /** Advances the animations to `t` (ms); true while anything still moves. */
  step(t: number): boolean {
    // Real elapsed time: easing is exponential, so a late frame lands where it should be
    // (a host that skips frames, or a test's clock jumping 800 ms, sees the end state).
    const dt = this.lastT < 0 ? 16 : clamp(t - this.lastT, 0, 2000);
    this.lastT = t;
    this.now = t;
    let moving = false;

    // Hover: the row under a resting pointer, after a dwell; none while the list scrolls.
    const scrolling = Math.abs(this.target - this.scroll) > 0.5 || t - this.lastWheelAt < QUIET_AFTER_WHEEL;
    if (this.py >= 0 && this.px >= 0 && !scrolling) {
      const i = this.rowAtY(this.py + this.scroll);
      const k = i >= 0 ? this.keys[i] : '';
      if (k !== this.candidate) { this.candidate = k; this.candidateSince = t; }
      if (this.candidate !== this.hover) {
        if (t - this.candidateSince >= DWELL_MS || !this.candidate) this.hover = this.candidate;
        else moving = true; // the dwell ends on a later frame
      }
    } else if (this.py < 0) { this.hover = ''; this.candidate = ''; }
    else if (scrolling) this.candidateSince = t;

    // The anchor: the row under the pointer, else the focus; its screen y must not move while
    // rows around it open and close.
    let anchor = -1;
    if (this.py >= 0) anchor = this.rowAtY(this.py + this.scroll);
    if (anchor < 0 && this.focus) anchor = this.index.get(this.focus) ?? -1;
    const before = anchor >= 0 ? this.yOf(anchor) : 0;

    // Expansions ease toward their targets.
    const want = new Set<string>();
    if (this.focus && this.index.has(this.focus)) want.add(this.focus);
    if (this.hover && this.index.has(this.hover)) want.add(this.hover);
    for (const k of want) if (!this.exp.has(k)) this.exp.set(k, 0);
    const rate = dt / EXPAND_MS;
    for (const [k, v] of this.exp) {
      const to = want.has(k) ? 1 : 0;
      if (v === to) { if (to === 0) this.exp.delete(k); continue; }
      const nv = to > v ? Math.min(1, v + rate) : Math.max(0, v - rate);
      if (nv <= 0) this.exp.delete(k); else this.exp.set(k, nv);
      moving = true;
    }
    this.rebuildExp();

    if (anchor >= 0) {
      const d = this.yOf(anchor) - before;
      if (d) {
        this.scroll += d;
        this.target += d;
      }
    }
    this.clampTarget();

    // Scroll eases to its target.
    if (this.scroll !== this.target) {
      const k = 1 - Math.exp(-dt / SCROLL_TAU);
      this.scroll += (this.target - this.scroll) * k;
      if (Math.abs(this.target - this.scroll) < 0.25) this.scroll = this.target;
      moving = true;
    }
    this.scroll = clamp(this.scroll, 0, this.maxScroll());

    for (const [k, m] of this.moves) {
      if (t - m.t0 >= MOVE_MS) this.moves.delete(k);
      else moving = true;
    }
    if (t < this.barUntil) moving = true;
    return moving;
  }

  // ---- drawing -------------------------------------------------------------------------------

  /** Paints the rows in view; true while the table animates (the canvas asks for a frame). */
  draw(ctx: Ctx2D, frame: Frame, paint: Painter<R>, now: number, empty = ''): boolean {
    if (frame.width > 0 && frame.height > 0) {
      if (frame.width !== this.W || frame.height !== this.H) {
        this.W = frame.width;
        this.H = frame.height;
        if (this.pending) this.reveal(this.pending);
      }
    }
    const moving = this.step(frame.time);
    const W = this.W, H = this.H;
    ctx.clearRect(0, 0, W, H);
    this.hits = [];
    if (!this.keys.length) {
      if (empty) {
        ctx.font = "12px 'Commit Mono', ui-monospace, Menlo, monospace";
        ctx.fillStyle = C.ink3;
        ctx.textAlign = 'left';
        ctx.fillText(empty, 16, 24);
      }
      this.lastPainted = 0;
      return moving;
    }
    const [i0, i1] = this.range(this.scroll - this.dense, this.scroll + H + this.dense);
    let painted = 0;
    for (let i = i0; i <= i1; i++) {
      const k = this.keys[i];
      const y = this.yOf(i) - this.scroll + this.moveOffset(k);
      const h = this.heightOf(i);
      if (y > H || y + h < 0) continue;
      const v = this.exp.get(k) ?? 0;
      const e = easeInOut(clamp(v, 0, 1));
      paint(ctx, this.rows[i], { y, h, W, e, focused: k === this.focus, hovered: k === this.hover, hits: e > 0.6 ? this.hits : null, now, index: i });
      painted++;
    }
    // A thin scroll bar while the list moves.
    const total = this.contentH();
    if (total > H + 1 && now >= 0) {
      const a = clamp((this.barUntil - frame.time) / 300, 0, 1);
      if (a > 0) {
        const th = Math.max(24, H * (H / total));
        const ty = (H - th) * (this.scroll / Math.max(1, total - H));
        ctx.beginPath();
        ctx.roundRect(W - 4, ty, 3, th, 1.5);
        ctx.fillStyle = withAlpha(C.ink3, 0.55 * a);
        ctx.fill();
      }
    }
    this.lastPainted = painted;
    return moving;
  }
}

/** Monospace text fitting: the face's advance per size, measured once, then pure arithmetic
 *  (no `measureText` per row per frame). */
const adv = new Map<string, number>();
export function advance(ctx: Ctx2D, font: string): number {
  let a = adv.get(font);
  if (a === undefined || !(a > 0)) {
    ctx.font = font;
    a = ctx.measureText('0000000000').width / 10;
    if (a > 0) adv.set(font, a);
    else a = 7;
  }
  return a;
}

/** `s` cut to `maxW` px in a monospace face of advance `a` (an ellipsis when cut). */
export function fit(s: string, maxW: number, a: number): string {
  if (maxW <= a) return '';
  const n = Math.floor(maxW / a);
  if (s.length <= n) return s;
  return n <= 1 ? '…' : `${s.slice(0, n - 1)}…`;
}
