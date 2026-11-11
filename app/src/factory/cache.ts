// The factory's canvas cache (fab-w7, FACTORY-SPEC §I-W7): a retained display list that sends a
// canvas only what changed since it last drew.
//
// Why. A native draw runs in the data module (Hermes): every call is recorded by Exact's
// TypeScript recorder into a byte list, base64'd and handed to the host as JSON. That costs about
// 0.05 ms per KB of list on the Mac mini (PERF.md, "Where the native frame goes"), and the live
// layer was ~146 KB a frame: ~8 ms, past the frame. Exact has no offscreen layer or picture to
// keep (no drawImage of a canvas, a Path2D is re-sent with every paint), but a canvas keeps its
// pixels between draws on every host (the web's 2D canvas; macOS copies the last IOSurface
// before a replay). So the words and the chrome, which barely change from one frame to the next,
// draw on a canvas of their own over the live one, through this cache:
//
//   - `Retained` is a Canvas 2D context in plain JS. The phases drawn into it record items (one
//     paint each: a fill, a stroke, a rect, a run of text), each with its state, its path, a
//     52-bit hash and a device-space box.
//   - `flush(ctx)` compares the items with those the canvas shows. Nothing changed: it sends
//     nothing at all. Some did: the boxes of the items that went or came are cleared and, clipped
//     to them, every item crossing them is drawn again, in order. Most of the screen: all of it.
//
// A pulsing glyph costs its own box; a minute's new label its two boxes; the HUD, which redraws
// its numbers four times a second, its box. Semantics kept: z-order inside the canvas, every
// state the routed phases use (colours, gradients, fonts, alignment, dashes, alpha, composite,
// transforms). Not kept: `clip` (the canvas then redraws whole every time, said once in the log).

import type { Ctx2D } from '../../app.contract.d.ts';

const TAU = Math.PI * 2;
/** Debug: every flush draws the whole list (the reference a partial flush must match). */
const FORCE_WHOLE = false;

// ---- hashing ------------------------------------------------------------------------------------
const M1 = 0x01000193, M2 = 0x5bd1e995;
/** Two 32-bit lanes of a running hash. Numbers are quantised to 1/64 px. */
let ha = 0, hb = 0;
function hn(v: number): void {
  const q = (v * 64) | 0;
  ha = Math.imul(ha ^ q, M1);
  hb = Math.imul(hb ^ q, M2); hb ^= hb >>> 13;
}
const strHash = new Map<string, number>();
function hsOf(s: string): number {
  let h = strHash.get(s);
  if (h === undefined) {
    h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), M1);
    if (strHash.size > 6000) strHash.clear();
    strHash.set(s, h);
  }
  return h;
}
function hs(s: string): void { hn(hsOf(s) / 64); }

// ---- gradients ----------------------------------------------------------------------------------
/** A gradient recorded for a retained canvas: made again on the real context when replayed. */
export class RGrad {
  readonly stops: (number | string)[] = [];
  /** The real gradient, per flush. */
  real: CanvasGradient | null = null;
  realFlush = -1;
  constructor(readonly kind: 'linear' | 'radial', readonly a: number[]) {}
  addColorStop(offset: number, color: string): void { this.stops.push(offset, color); }
  hash(): number {
    const sa = ha, sb = hb;
    ha = this.kind === 'linear' ? 3 : 5; hb = 7;
    for (const v of this.a) hn(v);
    for (const s of this.stops) if (typeof s === 'number') hn(s); else hs(s);
    const out = (ha >>> 0) ^ Math.imul(hb, 31);
    ha = sa; hb = sb;
    return out;
  }
}
type Paint = string | RGrad;

// ---- state --------------------------------------------------------------------------------------
type State = {
  fill: Paint; stroke: Paint; lw: number; cap: string; join: string; miter: number;
  font: string; align: string; base: string; alpha: number; comp: string; ls: string;
  dash: number[]; dashOff: number;
};
const DEFAULT: State = {
  fill: '#000', stroke: '#000', lw: 1, cap: 'butt', join: 'miter', miter: 10,
  font: '10px sans-serif', align: 'start', base: 'alphabetic', alpha: 1, comp: 'source-over', ls: '0px',
  dash: [], dashOff: 0,
};
function stateHash(s: State): number {
  const sa = ha, sb = hb;
  ha = 11; hb = 13;
  if (typeof s.fill === 'string') hs(s.fill); else hn(s.fill.hash());
  if (typeof s.stroke === 'string') hs(s.stroke); else hn(s.stroke.hash());
  hn(s.lw); hs(s.cap); hs(s.join); hn(s.miter); hs(s.font); hs(s.align); hs(s.base); hn(s.alpha); hs(s.comp); hs(s.ls);
  for (const d of s.dash) hn(d);
  hn(s.dashOff);
  const out = (ha >>> 0) ^ Math.imul(hb, 17);
  ha = sa; hb = sb;
  return out;
}

// ---- one frame's list ---------------------------------------------------------------------------
const S_MOVE = 1, S_LINE = 2, S_QUAD = 3, S_CUBIC = 4, S_ARC = 5, S_ELLIPSE = 6, S_RECT = 7, S_RRECT = 8, S_CLOSE = 9;
const NARGS = [0, 2, 2, 4, 6, 6, 8, 4, 5, 0];
const I_FILL = 1, I_STROKE = 2, I_FILLRECT = 3, I_STROKERECT = 4, I_CLEARRECT = 5, I_FILLTEXT = 6, I_STROKETEXT = 7;

/** One frame's items, paths, states and matrices (three rotate: shown, ready, recording). */
class List {
  W = 0; H = 0;
  // matrices: 6 numbers each, and each one's hash
  mats: number[] = []; matH: number[] = [];
  states: State[] = []; stateH: number[] = [];
  // path segments: op, matrix, offset into nums
  sOp: number[] = []; sMat: number[] = []; sOff: number[] = []; nums: number[] = [];
  // items
  iKind: number[] = []; iState: number[] = []; iMat: number[] = []; iP0: number[] = []; iP1: number[] = [];
  iArgs: number[] = []; iText: string[] = []; iKey: number[] = []; iBox: number[] = [];
  n = 0; segs = 0; nNums = 0; nMats = 0; nStates = 0;
  clipped = false;
  reset(): void { this.n = 0; this.segs = 0; this.nNums = 0; this.nMats = 0; this.nStates = 0; this.clipped = false; }
}

/** Cached font sizes (the px in a CSS font string) for text boxes. */
const fontPx = new Map<string, number>();
function pxOf(font: string): number {
  let p = fontPx.get(font);
  if (p === undefined) { const m = /([\d.]+)px/.exec(font); p = m ? Number(m[1]) : 10; fontPx.set(font, p); }
  return p;
}

type Box = [number, number, number, number];
const WIDE = /[^\x00-\x7f]/;

/** A Canvas 2D context in plain JS that records items for `flush` (the subset the factory's
 *  words and chrome use; see the header). */
export class Retained {
  private lists = [new List(), new List(), new List()];
  private shown: List | null = null;
  private ready: List | null = null;
  private rec = this.lists[0];
  private recording = false;
  /** A fresh bitmap: the next flush draws everything. */
  private whole = true;
  private flushes = 0;
  /** Measures text for the Gfx (one host round trip per size and weight). */
  measurer: Ctx2D | null = null;
  /** What the last flush sent: items drawn, of all; dirty boxes; whole-canvas or not. */
  readonly last = { drawn: 0, items: 0, boxes: 0, whole: false, ops: 0, texts: 0 };
  /** Items and flushes since the bench last read them. */
  readonly totals = { flushes: 0, empty: 0, drawn: 0 };
  private warnedClip = false;

  // the recording state
  private st: State = { ...DEFAULT, dash: [] };
  /** The list index `st` was recorded at (-1: not since it last changed). */
  private stIdx = -1;
  /** `st` is ours alone to change in place (not recorded by an item, not saved on the stack). */
  private own = true;
  private stack: { st: State; m: number[] }[] = [];
  private m = [1, 0, 0, 1, 0, 0];
  private mIdx = -1;
  private p0 = 0;
  private pa = 0; private pb = 0;
  private cx = 0; private cy = 0;

  /** Starts recording a frame `W`×`H` CSS px. */
  begin(W: number, H: number): void {
    const free = this.lists.find((l) => l !== this.shown && l !== this.ready)!;
    this.rec = free;
    free.reset(); free.W = W; free.H = H;
    this.recording = true;
    this.st = { ...DEFAULT, dash: [] }; this.stIdx = -1; this.own = true; this.stack.length = 0;
    this.m = [1, 0, 0, 1, 0, 0]; this.mIdx = -1;
    this.p0 = 0; this.pa = 0; this.pb = 0;
  }
  /** The frame is complete: the next flush shows it. */
  end(): void {
    if (!this.recording) return;
    this.recording = false;
    this.ready = this.rec;
  }
  /** The canvas was made again (mounted, resized): the next flush draws it all. */
  invalidate(): void { this.whole = true; }
  /** Something recorded and not yet flushed. */
  get pending(): boolean { return this.ready !== null || this.whole; }

  // ---- state ----------------------------------------------------------------------------------
  private set<K extends keyof State>(k: K, v: State[K]): void {
    if (this.st[k] === v) return;
    this.mine();
    this.st[k] = v;
  }
  /** Copy-on-write: a state an item or the stack holds is never changed in place. */
  private mine(): void {
    if (!this.own) { this.st = { ...this.st }; this.own = true; }
    this.stIdx = -1;
  }
  get fillStyle(): Paint { return this.st.fill; } set fillStyle(v: Paint) { this.set('fill', typeof v === 'string' || v instanceof RGrad ? v : String(v)); }
  get strokeStyle(): Paint { return this.st.stroke; } set strokeStyle(v: Paint) { this.set('stroke', typeof v === 'string' || v instanceof RGrad ? v : String(v)); }
  get lineWidth(): number { return this.st.lw; } set lineWidth(v: number) { if (v > 0 && Number.isFinite(v)) this.set('lw', v); }
  get lineCap(): string { return this.st.cap; } set lineCap(v: string) { this.set('cap', v); }
  get lineJoin(): string { return this.st.join; } set lineJoin(v: string) { this.set('join', v); }
  get miterLimit(): number { return this.st.miter; } set miterLimit(v: number) { this.set('miter', v); }
  get font(): string { return this.st.font; } set font(v: string) { this.set('font', v); }
  get textAlign(): string { return this.st.align; } set textAlign(v: string) { this.set('align', v); }
  get textBaseline(): string { return this.st.base; } set textBaseline(v: string) { this.set('base', v); }
  get globalAlpha(): number { return this.st.alpha; } set globalAlpha(v: number) { if (Number.isFinite(v) && v >= 0 && v <= 1) this.set('alpha', v); }
  get globalCompositeOperation(): string { return this.st.comp; } set globalCompositeOperation(v: string) { this.set('comp', v); }
  get letterSpacing(): string { return this.st.ls; } set letterSpacing(v: string) { this.set('ls', v); }
  get lineDashOffset(): number { return this.st.dashOff; } set lineDashOffset(v: number) { this.set('dashOff', v); }
  imageSmoothingEnabled = true;
  setLineDash(d: number[]): void {
    const cur = this.st.dash;
    if (cur.length === d.length && cur.every((x, i) => x === d[i])) return;
    this.mine();
    this.st.dash = d.slice();
  }
  getLineDash(): number[] { return this.st.dash.slice(); }
  save(): void { this.stack.push({ st: this.st, m: this.m }); this.own = false; }
  restore(): void {
    const s = this.stack.pop();
    if (!s) return;
    this.st = s.st; this.stIdx = -1; this.own = false;
    this.setM(s.m);
  }
  measureText(s: string): TextMetrics {
    const r = this.measurer;
    if (r) { const f = r.font; r.font = this.st.font; const ls = r.letterSpacing; r.letterSpacing = this.st.ls; const m = r.measureText(s); r.font = f; r.letterSpacing = ls; return m; }
    return { width: s.length * pxOf(this.st.font) * 0.6 } as TextMetrics;
  }
  createLinearGradient(x0: number, y0: number, x1: number, y1: number): RGrad { return new RGrad('linear', [x0, y0, x1, y1]); }
  createRadialGradient(x0: number, y0: number, r0: number, x1: number, y1: number, r1: number): RGrad { return new RGrad('radial', [x0, y0, r0, x1, y1, r1]); }

  // ---- transforms ------------------------------------------------------------------------------
  private setM(m: number[]): void { this.m = m; this.mIdx = -1; }
  setTransform(a: number | DOMMatrix2DInit = 1, b = 0, c = 0, d = 1, e = 0, f = 0): void {
    if (typeof a === 'object') { const o = a as { a?: number; b?: number; c?: number; d?: number; e?: number; f?: number }; this.setM([o.a ?? 1, o.b ?? 0, o.c ?? 0, o.d ?? 1, o.e ?? 0, o.f ?? 0]); return; }
    this.setM([a, b, c, d, e, f]);
  }
  resetTransform(): void { this.setM([1, 0, 0, 1, 0, 0]); }
  transform(a: number, b: number, c: number, d: number, e: number, f: number): void {
    const m = this.m;
    this.setM([m[0] * a + m[2] * b, m[1] * a + m[3] * b, m[0] * c + m[2] * d, m[1] * c + m[3] * d, m[0] * e + m[2] * f + m[4], m[1] * e + m[3] * f + m[5]]);
  }
  translate(x: number, y: number): void { this.transform(1, 0, 0, 1, x, y); }
  scale(x: number, y: number): void { this.transform(x, 0, 0, y, 0, 0); }
  rotate(r: number): void { const c = Math.cos(r), s = Math.sin(r); this.transform(c, s, -s, c, 0, 0); }
  getTransform(): DOMMatrix { const m = this.m; return { a: m[0], b: m[1], c: m[2], d: m[3], e: m[4], f: m[5] } as DOMMatrix; }
  /** The current matrix's index in the list (recorded once per change). */
  private matIdx(): number {
    if (this.mIdx >= 0) return this.mIdx;
    const L = this.rec, m = this.m, k = L.nMats++;
    for (let i = 0; i < 6; i++) L.mats[k * 6 + i] = m[i];
    const sa = ha, sb = hb;
    ha = 17; hb = 19; for (let i = 0; i < 6; i++) hn(m[i] * 16);
    L.matH[k] = (ha >>> 0) ^ Math.imul(hb, 7);
    ha = sa; hb = sb;
    this.mIdx = k;
    return k;
  }

  // ---- paths -----------------------------------------------------------------------------------
  beginPath(): void { this.p0 = this.rec.segs; this.pa = 0; this.pb = 0; }
  private seg(op: number, a: number, b: number, c = 0, d = 0, e = 0, f = 0, g = 0, h = 0): void {
    const L = this.rec, k = L.segs++, mi = this.matIdx(), off = L.nNums;
    L.sOp[k] = op; L.sMat[k] = mi; L.sOff[k] = off;
    const N = L.nums, n = NARGS[op];
    if (n > 0) { N[off] = a; N[off + 1] = b; }
    if (n > 2) { N[off + 2] = c; N[off + 3] = d; }
    if (n > 4) { N[off + 4] = e; N[off + 5] = f; }
    if (n > 6) { N[off + 6] = g; N[off + 7] = h; }
    if (n === 5) N[off + 4] = e;
    L.nNums = off + n;
    // the path's running hash
    ha = this.pa; hb = this.pb;
    hn(op); hn(L.matH[mi] / 64);
    for (let i = 0; i < n; i++) hn(N[off + i]);
    this.pa = ha; this.pb = hb;
  }
  moveTo(x: number, y: number): void { this.seg(S_MOVE, x, y); this.cx = x; this.cy = y; }
  lineTo(x: number, y: number): void { this.seg(S_LINE, x, y); this.cx = x; this.cy = y; }
  quadraticCurveTo(a: number, b: number, x: number, y: number): void { this.seg(S_QUAD, a, b, x, y); this.cx = x; this.cy = y; }
  bezierCurveTo(a: number, b: number, c: number, d: number, x: number, y: number): void { this.seg(S_CUBIC, a, b, c, d, x, y); this.cx = x; this.cy = y; }
  arc(x: number, y: number, r: number, a0: number, a1: number, ccw = false): void { this.seg(S_ARC, x, y, r, a0, a1, ccw ? 1 : 0); }
  ellipse(x: number, y: number, rx: number, ry: number, rot: number, a0: number, a1: number, ccw = false): void { this.seg(S_ELLIPSE, x, y, rx, ry, rot, a0, a1, ccw ? 1 : 0); }
  rect(x: number, y: number, w: number, h: number): void { this.seg(S_RECT, x, y, w, h); }
  roundRect(x: number, y: number, w: number, h: number, r: number | number[] = 0): void { this.seg(S_RRECT, x, y, w, h, typeof r === 'number' ? r : Number(r[0] ?? 0)); }
  closePath(): void { this.seg(S_CLOSE, 0, 0); }
  arcTo(x1: number, y1: number, _x2: number, _y2: number, _r: number): void { this.lineTo(x1, y1); }
  clip(): void {
    this.rec.clipped = true;
    if (!this.warnedClip) { this.warnedClip = true; console.log('factory cache: a clip on the retained canvas; it redraws whole'); }
  }

  // ---- paints ----------------------------------------------------------------------------------
  private stateIdx(): number {
    if (this.stIdx >= 0) return this.stIdx;
    const L = this.rec, k = L.nStates++;
    L.states[k] = this.st; L.stateH[k] = stateHash(this.st);
    this.stIdx = k; this.own = false;
    return k;
  }
  private item(kind: number, p0: number, p1: number, a: number, b: number, c: number, d: number, text: string, box: Box): void {
    const L = this.rec, k = L.n++, si = this.stateIdx(), mi = this.matIdx();
    L.iKind[k] = kind; L.iState[k] = si; L.iMat[k] = mi; L.iP0[k] = p0; L.iP1[k] = p1;
    L.iArgs[k * 4] = a; L.iArgs[k * 4 + 1] = b; L.iArgs[k * 4 + 2] = c; L.iArgs[k * 4 + 3] = d;
    L.iText[k] = text;
    ha = kind * 977 + 1; hb = kind * 131 + 3;
    hn(L.stateH[si] / 64); hn(L.matH[mi] / 64);
    if (p1 > p0) { hn(this.pa / 64); hn(this.pb / 64); hn(p1 - p0); }
    hn(a); hn(b); hn(c); hn(d);
    if (text) hs(text);
    L.iKey[k] = (ha >>> 0) * 1048576 + (hb >>> 12);
    // composite operators that reach outside the shape cover the whole canvas
    const comp = this.st.comp;
    const outside = comp !== 'source-over' && comp !== 'source-atop' && comp !== 'saturation' && comp !== 'multiply' && comp !== 'screen' && comp !== 'lighter' && comp !== 'darken' && comp !== 'lighten' && comp !== 'overlay';
    const B = L.iBox;
    if (outside) { B[k * 4] = -1e9; B[k * 4 + 1] = -1e9; B[k * 4 + 2] = 1e9; B[k * 4 + 3] = 1e9; } else { B[k * 4] = box[0]; B[k * 4 + 1] = box[1]; B[k * 4 + 2] = box[2]; B[k * 4 + 3] = box[3]; }
  }
  /** The current path's device-space box, padded by `pad` CSS px. */
  private pathBox(pad: number): Box {
    const L = this.rec, N = L.nums, M = L.mats;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let s = this.p0; s < L.segs; s++) {
      const op = L.sOp[s], o = L.sOff[s], mi = L.sMat[s] * 6;
      const a = M[mi], b = M[mi + 1], c = M[mi + 2], d = M[mi + 3], e = M[mi + 4], f = M[mi + 5];
      const sc = Math.max(Math.hypot(a, b), Math.hypot(c, d));
      const add = (x: number, y: number, r: number) => {
        const X = a * x + c * y + e, Y = b * x + d * y + f, R = r * sc;
        if (X - R < x0) x0 = X - R; if (Y - R < y0) y0 = Y - R; if (X + R > x1) x1 = X + R; if (Y + R > y1) y1 = Y + R;
      };
      switch (op) {
        case S_MOVE: case S_LINE: add(N[o], N[o + 1], 0); break;
        case S_QUAD: add(N[o], N[o + 1], 0); add(N[o + 2], N[o + 3], 0); break;
        case S_CUBIC: add(N[o], N[o + 1], 0); add(N[o + 2], N[o + 3], 0); add(N[o + 4], N[o + 5], 0); break;
        case S_ARC: add(N[o], N[o + 1], Math.abs(N[o + 2])); break;
        case S_ELLIPSE: add(N[o], N[o + 1], Math.max(Math.abs(N[o + 2]), Math.abs(N[o + 3]))); break;
        case S_RECT: case S_RRECT: add(N[o], N[o + 1], 0); add(N[o] + N[o + 2], N[o + 1] + N[o + 3], 0); add(N[o] + N[o + 2], N[o + 1], 0); add(N[o], N[o + 1] + N[o + 3], 0); break;
        default: break;
      }
    }
    return [x0 - pad, y0 - pad, x1 + pad, y1 + pad];
  }
  private rectBox(x: number, y: number, w: number, h: number, pad: number): Box {
    const m = this.m;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const [px, py] of [[x, y], [x + w, y], [x, y + h], [x + w, y + h]]) {
      const X = m[0] * px + m[2] * py + m[4], Y = m[1] * px + m[3] * py + m[5];
      if (X < x0) x0 = X; if (Y < y0) y0 = Y; if (X > x1) x1 = X; if (Y > y1) y1 = Y;
    }
    return [x0 - pad, y0 - pad, x1 + pad, y1 + pad];
  }
  private strokePad(): number {
    const m = this.m, sc = Math.max(Math.hypot(m[0], m[1]), Math.hypot(m[2], m[3]));
    const miter = this.st.join === 'miter' ? Math.min(this.st.miter, 4) : 1;
    return this.st.lw * sc * miter * 0.5 + (this.st.cap === 'butt' ? 0 : this.st.lw * sc * 0.5) + 2;
  }
  fill(rule: string | object = 'nonzero'): void {
    if (this.rec.segs <= this.p0) return;
    this.item(I_FILL, this.p0, this.rec.segs, rule === 'evenodd' ? 1 : 0, 0, 0, 0, '', this.pathBox(1.5));
  }
  stroke(): void {
    if (this.rec.segs <= this.p0) return;
    const pad = this.strokePad();
    this.item(I_STROKE, this.p0, this.rec.segs, 0, 0, 0, 0, '', this.pathBox(pad));
  }
  fillRect(x: number, y: number, w: number, h: number): void { this.item(I_FILLRECT, 0, 0, x, y, w, h, '', this.rectBox(x, y, w, h, 1.5)); }
  strokeRect(x: number, y: number, w: number, h: number): void { this.item(I_STROKERECT, 0, 0, x, y, w, h, '', this.rectBox(x, y, w, h, this.strokePad())); }
  clearRect(x: number, y: number, w: number, h: number): void { this.item(I_CLEARRECT, 0, 0, x, y, w, h, '', this.rectBox(x, y, w, h, 1)); }
  private textBox(s: string, x: number, y: number, maxW: number): Box {
    const px = pxOf(this.st.font);
    const ls = this.st.ls && this.st.ls !== '0px' ? parseFloat(this.st.ls) || 0 : 0;
    let w = s.length * (px * 0.62 + ls);
    if (WIDE.test(s)) for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) > 127) w += px * 0.45;
    if (maxW > 0 && w > maxW) w = maxW;
    const al = this.st.align;
    const left = al === 'center' ? x - w / 2 : al === 'right' || al === 'end' ? x - w : x;
    const bl = this.st.base;
    const top = bl === 'top' || bl === 'hanging' ? y : bl === 'middle' ? y - px * 0.65 : bl === 'bottom' || bl === 'ideographic' ? y - px * 1.3 : y - px * 1.05;
    return this.rectBox(left, top, w, px * 1.4, 3);
  }
  fillText(s: string, x: number, y: number, maxW?: number): void {
    s = String(s);
    if (!s) return;
    this.item(I_FILLTEXT, 0, 0, x, y, maxW ?? -1, 0, s, this.textBox(s, x, y, maxW ?? -1));
  }
  strokeText(s: string, x: number, y: number, maxW?: number): void {
    s = String(s);
    if (!s) return;
    const b = this.textBox(s, x, y, maxW ?? -1), p = this.strokePad();
    this.item(I_STROKETEXT, 0, 0, x, y, maxW ?? -1, 0, s, [b[0] - p, b[1] - p, b[2] + p, b[3] + p]);
  }

  // ---- flush -----------------------------------------------------------------------------------
  /** Sends `ctx` what changed since it last drew; returns the items drawn. */
  flush(ctx: Ctx2D, W: number, H: number, scale = 1): number {
    const L = this.ready;
    const last = this.last;
    last.drawn = 0; last.boxes = 0; last.whole = false; last.ops = 0; last.texts = 0;
    if (!L && !this.whole) { this.totals.empty++; return 0; }
    const S = this.shown;
    const cur = L ?? S;
    this.flushes++;
    this.totals.flushes++;
    if (!cur) {
      // nothing ever recorded: a fresh canvas is cleared and stays so
      ctx.resetTransform(); ctx.clearRect(0, 0, W, H); this.whole = false; return 0;
    }
    last.items = cur.n;
    let boxes: Box[] | null = null;
    const whole = FORCE_WHOLE || this.whole || !S || cur.clipped || S.clipped || cur.W !== S.W || cur.H !== S.H;
    if (!whole) boxes = diff(S!, cur);
    this.whole = false;
    this.ready = null;
    this.shown = cur;
    if (boxes && !boxes.length) { this.totals.empty++; return 0; }
    let drawAll = whole;
    if (boxes) {
      boxes = merge(boxes, W, H, scale);
      let area = 0;
      for (const b of boxes) area += (b[2] - b[0]) * (b[3] - b[1]);
      if (area > W * H * 0.5) drawAll = true;
    }
    ctx.resetTransform();
    const rp = new Replay(ctx, cur, this.flushes);
    if (drawAll) {
      last.whole = true;
      ctx.clearRect(0, 0, W, H);
      for (let i = 0; i < cur.n; i++) rp.item(i);
    } else {
      const bx = boxes!;
      last.boxes = bx.length;
      for (const b of bx) ctx.clearRect(b[0], b[1], b[2] - b[0], b[3] - b[1]);
      ctx.save();
      ctx.beginPath();
      for (const b of bx) ctx.rect(b[0], b[1], b[2] - b[0], b[3] - b[1]);
      ctx.clip();
      const B = cur.iBox;
      for (let i = 0; i < cur.n; i++) {
        const x0 = B[i * 4], y0 = B[i * 4 + 1], x1 = B[i * 4 + 2], y1 = B[i * 4 + 3];
        for (const b of bx) if (x0 < b[2] && x1 > b[0] && y0 < b[3] && y1 > b[1]) { rp.item(i); break; }
      }
      ctx.restore();
    }
    last.drawn = rp.drawn; last.ops = rp.ops; last.texts = rp.texts;
    this.totals.drawn += rp.drawn;
    return rp.drawn;
  }
}

/** The boxes of the items in `a` and not in `b`, and in `b` and not in `a` (by hash; z-order
 *  among unchanged items is assumed kept). */
function diff(a: List, b: List): Box[] {
  const out: Box[] = [];
  if (a.n === b.n) {
    let same = true;
    for (let i = 0; i < a.n; i++) if (a.iKey[i] !== b.iKey[i]) { same = false; break; }
    if (same) return out;
  }
  const count = new Map<number, number>();
  for (let i = 0; i < a.n; i++) count.set(a.iKey[i], (count.get(a.iKey[i]) ?? 0) + 1);
  for (let i = 0; i < b.n; i++) {
    const k = b.iKey[i], c = count.get(k) ?? 0;
    if (c > 0) count.set(k, c - 1);
    else out.push([b.iBox[i * 4], b.iBox[i * 4 + 1], b.iBox[i * 4 + 2], b.iBox[i * 4 + 3]]);
  }
  for (let i = 0; i < a.n; i++) {
    const k = a.iKey[i], c = count.get(k) ?? 0;
    if (c > 0) { count.set(k, c - 1); out.push([a.iBox[i * 4], a.iBox[i * 4 + 1], a.iBox[i * 4 + 2], a.iBox[i * 4 + 3]]); }
  }
  return out;
}

/** Dirty boxes clamped to the canvas, snapped out to whole px and merged where they touch;
 *  more than 12 become one. */
function merge(bs: Box[], W: number, H: number, scale: number): Box[] {
  const out: Box[] = [];
  const s = scale > 0 ? scale : 1;
  for (const b of bs) {
    // snapped out to whole device pixels: a clip on pixel edges has no partial coverage, so what is
    // drawn again meets what is kept without a seam
    const x0 = Math.max(0, Math.floor((b[0] - 1) * s) / s), y0 = Math.max(0, Math.floor((b[1] - 1) * s) / s);
    const x1 = Math.min(W, Math.ceil((b[2] + 1) * s) / s), y1 = Math.min(H, Math.ceil((b[3] + 1) * s) / s);
    if (x1 > x0 && y1 > y0) out.push([x0, y0, x1, y1]);
  }
  let changed = true;
  while (changed && out.length > 1) {
    changed = false;
    for (let i = 0; i < out.length && !changed; i++) for (let j = i + 1; j < out.length; j++) {
      const a = out[i], b = out[j];
      if (a[0] <= b[2] + 4 && b[0] <= a[2] + 4 && a[1] <= b[3] + 4 && b[1] <= a[3] + 4) {
        a[0] = Math.min(a[0], b[0]); a[1] = Math.min(a[1], b[1]); a[2] = Math.max(a[2], b[2]); a[3] = Math.max(a[3], b[3]);
        out.splice(j, 1); changed = true; break;
      }
    }
  }
  if (out.length > 12) {
    const u: Box = [Infinity, Infinity, -Infinity, -Infinity];
    for (const b of out) { u[0] = Math.min(u[0], b[0]); u[1] = Math.min(u[1], b[1]); u[2] = Math.max(u[2], b[2]); u[3] = Math.max(u[3], b[3]); }
    return [u];
  }
  return out;
}

/** Replays a list's items into a real context, setting only the state that differs. */
class Replay {
  drawn = 0; ops = 0; texts = 0;
  private st: Partial<State> = {};
  private mat = -2;
  private lastPath = -1;
  constructor(private ctx: Ctx2D, private L: List, private flushN: number) {}
  private paint(p: Paint): string | CanvasGradient {
    if (typeof p === 'string') return p;
    if (p.realFlush !== this.flushN || !p.real) {
      const a = p.a;
      const g = p.kind === 'linear' ? this.ctx.createLinearGradient(a[0], a[1], a[2], a[3]) : this.ctx.createRadialGradient(a[0], a[1], a[2], a[3], a[4], a[5]);
      for (let i = 0; i < p.stops.length; i += 2) g.addColorStop(p.stops[i] as number, p.stops[i + 1] as string);
      p.real = g; p.realFlush = this.flushN;
      this.ops += 2 + p.stops.length / 2;
    }
    return p.real;
  }
  private setMat(mi: number): void {
    if (mi === this.mat) return;
    const M = this.L.mats, o = mi * 6;
    this.ctx.setTransform(M[o], M[o + 1], M[o + 2], M[o + 3], M[o + 4], M[o + 5]);
    this.mat = mi; this.ops++;
  }
  private state(s: State, kind: number): void {
    const c = this.ctx as unknown as Record<string, unknown>, cur = this.st;
    const text = kind === I_FILLTEXT || kind === I_STROKETEXT;
    const fills = kind === I_FILL || kind === I_FILLRECT || kind === I_FILLTEXT;
    const strokes = kind === I_STROKE || kind === I_STROKERECT || kind === I_STROKETEXT;
    if (cur.alpha !== s.alpha) { c.globalAlpha = s.alpha; cur.alpha = s.alpha; this.ops++; }
    if (cur.comp !== s.comp) { c.globalCompositeOperation = s.comp; cur.comp = s.comp; this.ops++; }
    if (fills && cur.fill !== s.fill) { c.fillStyle = this.paint(s.fill); cur.fill = s.fill; this.ops++; }
    if (strokes) {
      if (cur.stroke !== s.stroke) { c.strokeStyle = this.paint(s.stroke); cur.stroke = s.stroke; this.ops++; }
      if (cur.lw !== s.lw) { c.lineWidth = s.lw; cur.lw = s.lw; this.ops++; }
      if (cur.cap !== s.cap) { c.lineCap = s.cap; cur.cap = s.cap; this.ops++; }
      if (cur.join !== s.join) { c.lineJoin = s.join; cur.join = s.join; this.ops++; }
      if (cur.miter !== s.miter) { c.miterLimit = s.miter; cur.miter = s.miter; this.ops++; }
      if (cur.dash !== s.dash) {
        const d = cur.dash;
        if (!d || d.length !== s.dash.length || d.some((x, i) => x !== s.dash[i])) { this.ctx.setLineDash(s.dash); this.ops++; }
        cur.dash = s.dash;
      }
      if (cur.dashOff !== s.dashOff) { c.lineDashOffset = s.dashOff; cur.dashOff = s.dashOff; this.ops++; }
    }
    if (text) {
      if (cur.font !== s.font) { c.font = s.font; cur.font = s.font; this.ops++; }
      if (cur.align !== s.align) { c.textAlign = s.align; cur.align = s.align; this.ops++; }
      if (cur.base !== s.base) { c.textBaseline = s.base; cur.base = s.base; this.ops++; }
      if (cur.ls !== s.ls) { c.letterSpacing = s.ls; cur.ls = s.ls; this.ops++; }
    }
  }
  private path(p0: number, p1: number): void {
    const ctx = this.ctx, L = this.L, N = L.nums;
    ctx.beginPath();
    for (let s = p0; s < p1; s++) {
      this.setMat(L.sMat[s]);
      const o = L.sOff[s];
      switch (L.sOp[s]) {
        case S_MOVE: ctx.moveTo(N[o], N[o + 1]); break;
        case S_LINE: ctx.lineTo(N[o], N[o + 1]); break;
        case S_QUAD: ctx.quadraticCurveTo(N[o], N[o + 1], N[o + 2], N[o + 3]); break;
        case S_CUBIC: ctx.bezierCurveTo(N[o], N[o + 1], N[o + 2], N[o + 3], N[o + 4], N[o + 5]); break;
        case S_ARC: ctx.arc(N[o], N[o + 1], N[o + 2], N[o + 3], N[o + 4], N[o + 5] === 1); break;
        case S_ELLIPSE: ctx.ellipse(N[o], N[o + 1], N[o + 2], N[o + 3], N[o + 4], N[o + 5], N[o + 6], N[o + 7] === 1); break;
        case S_RECT: ctx.rect(N[o], N[o + 1], N[o + 2], N[o + 3]); break;
        case S_RRECT: ctx.roundRect(N[o], N[o + 1], N[o + 2], N[o + 3], N[o + 4]); break;
        case S_CLOSE: ctx.closePath(); break;
        default: break;
      }
    }
    this.ops += p1 - p0 + 1;
  }
  item(i: number): void {
    const L = this.L, ctx = this.ctx, kind = L.iKind[i], s = L.states[L.iState[i]];
    const A = L.iArgs, a = A[i * 4], b = A[i * 4 + 1], c = A[i * 4 + 2], d = A[i * 4 + 3];
    this.state(s, kind);
    this.drawn++;
    switch (kind) {
      case I_FILL: case I_STROKE: {
        const p0 = L.iP0[i], p1 = L.iP1[i];
        if (this.lastPath !== p0 * 100000 + p1) { this.path(p0, p1); this.lastPath = p0 * 100000 + p1; }
        this.setMat(L.iMat[i]);
        if (kind === I_FILL) ctx.fill(a === 1 ? 'evenodd' : 'nonzero'); else ctx.stroke();
        this.ops++;
        return;
      }
      case I_FILLRECT: this.setMat(L.iMat[i]); ctx.fillRect(a, b, c, d); this.ops++; return;
      case I_STROKERECT: this.setMat(L.iMat[i]); ctx.strokeRect(a, b, c, d); this.ops++; return;
      case I_CLEARRECT: this.setMat(L.iMat[i]); ctx.clearRect(a, b, c, d); this.ops++; return;
      case I_FILLTEXT: case I_STROKETEXT: {
        this.setMat(L.iMat[i]);
        const t = L.iText[i];
        if (kind === I_FILLTEXT) { if (c > 0) ctx.fillText(t, a, b, c); else ctx.fillText(t, a, b); } else if (c > 0) ctx.strokeText(t, a, b, c); else ctx.strokeText(t, a, b);
        this.ops++; this.texts++;
        return;
      }
      default: return;
    }
  }
}

// ---- cheaper circles ----------------------------------------------------------------------------
/** Exact's recorder draws a full circle as a line to its start and four cubics (248 B after the
 *  caller's moveTo): the live layer's glows, smoke, beacons and lamps were ~40 KB a frame of it.
 *  `fastArcs` gives a recorder full circles and ellipses of 3 cubics (2 when under 10 device px
 *  across; worst radial error 0.15 % and 1.8 %: under 0.1 px at those sizes), without the line
 *  when the path is already at the start: 168 / 112 B. Partial arcs go to the recorder's own. */
type ArcCtx = Ctx2D & { __syArcs?: boolean; _?: { subpath?: [number[], number[]] | null; state?: { transform?: number[] } } };
export function fastArcs(ctx: Ctx2D, scale: number): void {
  const c = ctx as ArcCtx;
  if (c.__syArcs || typeof c.arc !== 'function') return;
  const proto = Object.getPrototypeOf(c) as { arc: Ctx2D['arc']; ellipse: Ctx2D['ellipse'] };
  const arc0 = proto.arc, ell0 = proto.ellipse;
  const full = (x: number, y: number, rx: number, ry: number, rot: number, s: number, ac: boolean): void => {
    const cr = Math.cos(rot), sr = Math.sin(rot);
    const at = (a: number): [number, number] => { const px = rx * Math.cos(a), py = ry * Math.sin(a); return [x + px * cr - py * sr, y + px * sr + py * cr]; };
    const tan = (a: number): [number, number] => { const px = -rx * Math.sin(a), py = ry * Math.cos(a); return [px * cr - py * sr, px * sr + py * cr]; };
    const n = Math.max(rx, ry) * 2 * scale < 10 ? 2 : 3;
    const step = (ac ? -TAU : TAU) / n, k = (4 / 3) * Math.tan(step / 4);
    const p0 = at(s);
    // the line to the start, unless the path is already there (the recorder's subpath, in canvas
    // space: compared through the current transform)
    const inner = c._, sp = inner?.subpath, m = inner?.state?.transform;
    let there = false;
    if (sp && m && m.length === 6) {
      const X = m[0] * p0[0] + m[2] * p0[1] + m[4], Y = m[1] * p0[0] + m[3] * p0[1] + m[5];
      there = Math.abs(sp[1][0] - X) < 1e-9 && Math.abs(sp[1][1] - Y) < 1e-9;
    }
    if (!there) c.lineTo(p0[0], p0[1]);
    for (let i = 0; i < n; i++) {
      const a0 = s + step * i, a1 = s + step * (i + 1);
      const q0 = at(a0), q1 = at(a1), d0 = tan(a0), d1 = tan(a1);
      c.bezierCurveTo(q0[0] + k * d0[0], q0[1] + k * d0[1], q1[0] - k * d1[0], q1[1] - k * d1[1], q1[0], q1[1]);
    }
  };
  c.arc = function (x: number, y: number, r: number, s: number, e: number, ac = false): void {
    if (r > 0 && Math.abs(e - s) >= TAU - 1e-9 && Number.isFinite(x + y + r + s)) { full(x, y, r, r, 0, s, !!ac); return; }
    arc0.call(c, x, y, r, s, e, ac);
  };
  c.ellipse = function (x: number, y: number, rx: number, ry: number, rot: number, s: number, e: number, ac = false): void {
    if (rx > 0 && ry > 0 && Math.abs(e - s) >= TAU - 1e-9 && Number.isFinite(x + y + rx + ry + rot + s)) { full(x, y, rx, ry, rot, s, !!ac); return; }
    ell0.call(c, x, y, rx, ry, rot, s, e, ac);
  };
  c.__syArcs = true;
}
