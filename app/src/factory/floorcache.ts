// The static floor's cache (fab-w7b, PERF.md "The static floor by dirty tiles"): the floor canvas
// repaints only the parts of the floor that changed.
//
// Why. A native draw runs in the data module (Hermes), where Exact's recorder serialises every
// canvas call into a byte list and base64s it: ~0.05 ms a KB on the Mac mini. The static floor is
// ~27,000 calls, ~660 KB a repaint (48-96 ms of work on the mini), and on a busy fleet its key
// moves about once a second (a car lands on a main line, a stack grows, a building gains a
// storey): 2-5 missed frames each time. A canvas keeps its pixels between draws, so most of that
// can be kept:
//
//   - `FRec` is a Canvas 2D context in plain JS (the floor's subset: paths, fills, strokes, rects,
//     text, state, transforms, gradients, save/restore and clip). Each paint is an item with a
//     hash and a device box, both built as its path is (no bytes, no base64: Bun without its JIT
//     records the floor in ~12 ms over the layers' own ~10, where Exact's recorder takes ~178).
//     An item's subpaths ("pieces", a hash and box each) are made only when a diff or a partial
//     flush looks at it.
//   - `diff` pairs the new list with the one the canvas shows: equal items by hash, their order
//     kept (a longest increasing run; an item that moved in z is dirty); in the items that
//     changed, the pieces equal to their counterpart's (the old item between the same kept
//     neighbours) are kept. What is left marks dirty tiles (TILE CSS px) under its old and new
//     boxes. Hashes match at 1/64 px; a kept item that crept under that step (a post growing with
//     its time in state) takes the old numbers (`carry`), so the list stays exactly what the
//     canvas shows and the creep is repainted once it adds up to 1/64 px.
//   - `flush` clears the dirty tiles and, clipped to them, replays every item that crosses them,
//     in order, with only the pieces that cross them. A fill's subpaths away from the clip add
//     no coverage inside it (their winding is zero there) and a stroke's stay within its box, so
//     the result inside is the whole repaint's; outside, nothing changed. A dashed stroke keeps
//     all its subpaths (its dash phase runs on). Clip rects sit on CSS-px tiles. (Chromium's 2D
//     canvas antialiases under any clip a few levels differently: a partial repaint matches a
//     whole one to within that at edges; with nothing changed nothing is sent.)
//
// factory.ts drives it (drawFloor): while the camera moves the floor is painted directly; the
// first still frame records it and sends it whole; data changes are recorded, diffed and flushed,
// at most one a second (FLOOR_COALESCE_MS).

import type { Ctx2D } from '../../app.contract.d.ts';

// ---- the list ---------------------------------------------------------------------------------
const S_MOVE = 1, S_LINE = 2, S_QUAD = 3, S_CUBIC = 4, S_ARC = 5, S_ELLIPSE = 6, S_RECT = 7, S_RRECT = 8, S_CLOSE = 9;
const NARGS = [0, 2, 2, 4, 6, 6, 8, 4, 5, 0];
const I_FILL = 1, I_STROKE = 2, I_FILLRECT = 3, I_STROKERECT = 4, I_CLEARRECT = 5, I_FILLTEXT = 6, I_STROKETEXT = 7;
/** Tile side (CSS px) of the dirty grid. */
export const TILE = 16;
/** Above this share of the tiles dirty, the canvas repaints whole. */
const WHOLE_SHARE = 0.55;

// hashing: two 32-bit polynomial lanes (plain multiplies stay exact under 2^53, then wrap)
const strH = new Map<string, number>();
function hstr(s: string): number {
  let h = strH.get(s);
  if (h === undefined) {
    h = 0x811c9dc5 | 0;
    for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
    if (strH.size > 8000) strH.clear();
    strH.set(s, h);
  }
  return h;
}
/** A 52-bit key from two lanes. */
const key52 = (a: number, b: number): number => (a >>> 0) * 1048576 + ((b >>> 12) & 0xfffff);

function growF(a: Float64Array<ArrayBuffer>, need: number): Float64Array<ArrayBuffer> {
  if (need <= a.length) return a;
  const b = new Float64Array(Math.max(need, a.length * 2));
  b.set(a);
  return b;
}
function growI(a: Int32Array<ArrayBuffer>, need: number): Int32Array<ArrayBuffer> {
  if (need <= a.length) return a;
  const b = new Int32Array(Math.max(need, a.length * 2));
  b.set(a);
  return b;
}

/** A gradient recorded for the floor: made again on the real context at each flush. */
export class FGrad {
  readonly stops: (number | string)[] = [];
  h = 0;
  real: CanvasGradient | null = null;
  realAt = -1;
  constructor(readonly kind: number, readonly a: number[]) {}
  addColorStop(offset: number, color: string): void { this.stops.push(offset, color); this.h = 0; }
  hash(): number {
    if (this.h) return this.h;
    let h = this.kind * 7 + 3;
    for (const v of this.a) h = (h * 31 + ((v * 64) | 0)) | 0;
    for (const s of this.stops) h = (h * 31 + (typeof s === 'number' ? (s * 4096) | 0 : hstr(s))) | 0;
    this.h = h || 1;
    return this.h;
  }
}
type Paint = string | FGrad;
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
  let h = 11;
  h = (h * 31 + (typeof s.fill === 'string' ? hstr(s.fill) : s.fill.hash())) | 0;
  h = (h * 31 + (typeof s.stroke === 'string' ? hstr(s.stroke) : s.stroke.hash())) | 0;
  h = (h * 31 + ((s.lw * 256) | 0)) | 0;
  h = (h * 31 + hstr(s.cap)) | 0; h = (h * 31 + hstr(s.join)) | 0; h = (h * 31 + ((s.miter * 16) | 0)) | 0;
  h = (h * 31 + hstr(s.font)) | 0; h = (h * 31 + hstr(s.align)) | 0; h = (h * 31 + hstr(s.base)) | 0;
  h = (h * 31 + ((s.alpha * 4096) | 0)) | 0; h = (h * 31 + hstr(s.comp)) | 0; h = (h * 31 + hstr(s.ls)) | 0;
  for (const d of s.dash) h = (h * 31 + ((d * 64) | 0)) | 0;
  h = (h * 31 + ((s.dashOff * 64) | 0)) | 0;
  return h;
}

/** One recording: segments, matrices, states, clips, items and (made on demand) their pieces. */
export class FList {
  W = 0; H = 0;
  /** segments: op, matrix, then NARGS[op] numbers */
  sg = new Float64Array(65536); sn = 0;
  mats = new Float64Array(6 * 64); matH = new Float64Array(64); nm = 0;
  states: State[] = []; stH: number[] = []; ns = 0;
  /** clips: segment range, rule, parent, hash (with the parent's), device box */
  cP0 = new Int32Array(16); cP1 = new Int32Array(16); cRule = new Int32Array(16); cPar = new Int32Array(16); cH = new Float64Array(16); cB = new Float64Array(64); nc = 1;
  /** items: kind, state, matrix, clip, segments, pieces (-1: not made yet), arguments, text, key,
   *  device box, own hash (without the path), the box's pad, a dashed stroke (one piece) */
  iK = new Int32Array(2048); iS = new Int32Array(2048); iM = new Int32Array(2048); iC = new Int32Array(2048);
  iP0 = new Int32Array(2048); iP1 = new Int32Array(2048); iQ0 = new Int32Array(2048); iQ1 = new Int32Array(2048);
  iA = new Float64Array(8192); iT: string[] = []; iKey = new Float64Array(2048); iB = new Float64Array(8192);
  iH = new Int32Array(2048); iPad = new Float64Array(2048); iDash = new Uint8Array(2048); iF = new Int32Array(2048); n = 0;
  /** pieces: key, device box, segment range */
  qKey = new Float64Array(8192); qB = new Float64Array(32768); qP0 = new Int32Array(8192); qP1 = new Int32Array(8192); nq = 0;
  reset(W: number, H: number): void { this.W = W; this.H = H; this.sn = 0; this.nm = 0; this.ns = 0; this.nc = 1; this.n = 0; this.nq = 0; }
  /** Room for one more item. */
  roomItem(): void {
    const need = this.n + 1;
    if (need <= this.iK.length) return;
    this.iK = growI(this.iK, need); this.iS = growI(this.iS, need); this.iM = growI(this.iM, need); this.iC = growI(this.iC, need);
    this.iP0 = growI(this.iP0, need); this.iP1 = growI(this.iP1, need); this.iQ0 = growI(this.iQ0, need); this.iQ1 = growI(this.iQ1, need);
    this.iA = growF(this.iA, need * 4); this.iKey = growF(this.iKey, need); this.iB = growF(this.iB, need * 4);
    this.iH = growI(this.iH, need); this.iPad = growF(this.iPad, need); this.iF = growI(this.iF, need);
    if (this.iDash.length < need) { const d = new Uint8Array(this.iK.length); d.set(this.iDash); this.iDash = d; }
  }
  roomPieces(k: number): void {
    const need = this.nq + k;
    if (need <= this.qKey.length) return;
    this.qKey = growF(this.qKey, need); this.qB = growF(this.qB, need * 4); this.qP0 = growI(this.qP0, need); this.qP1 = growI(this.qP1, need);
  }
}

/** Item `i`'s pieces (its subpaths; one for a dashed stroke or a rect or text), made once: a key
 *  and a device box each. Only the items a diff or a partial flush looks at need them. */
export function piecesOf(L: FList, i: number): void {
  if (L.iQ0[i] >= 0) return;
  const q0 = L.nq;
  const h = L.iH[i], pad = L.iPad[i], C = L.cB, cl = L.iC[i] * 4;
  const cx0 = C[cl], cy0 = C[cl + 1], cx1 = C[cl + 2], cy1 = C[cl + 3];
  const B = L.iB, o = i * 4;
  const outside = B[o] <= -1e8;
  const p0 = L.iP0[i], p1 = L.iP1[i];
  if (p1 <= p0) {
    L.roomPieces(1);
    const q = L.nq++;
    L.qKey[q] = L.iKey[i];
    L.qB[q * 4] = B[o]; L.qB[q * 4 + 1] = B[o + 1]; L.qB[q * 4 + 2] = B[o + 2]; L.qB[q * 4 + 3] = B[o + 3];
    L.qP0[q] = 0; L.qP1[q] = 0;
    L.iQ0[i] = q0; L.iQ1[i] = L.nq;
    return;
  }
  const whole = L.iDash[i] === 1;
  const s = L.sg, M = L.mats, MH = L.matH;
  let ph = 0, x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, start = p0, any = false, lastMi = -1;
  let a = 1, b = 0, c = 0, d = 1, e = 0, f = 0, sc = 1;
  let k = p0;
  for (;;) {
    const op = k < p1 ? s[k] : 0;
    if ((op === 0 || (!whole && (op === S_MOVE || op === S_RECT || op === S_RRECT))) && any) {
      L.roomPieces(1);
      const q = L.nq++;
      L.qKey[q] = key52((ph * 31 + h) | 0, ((((x0 * 4) | 0) * 31 + ((y0 * 4) | 0)) * 31 + ((x1 * 4) | 0)) * 31 + ((y1 * 4) | 0) + (k - start));
      let X0 = x0 - pad, Y0 = y0 - pad, X1 = x1 + pad, Y1 = y1 + pad;
      if (outside) { X0 = -1e9; Y0 = -1e9; X1 = 1e9; Y1 = 1e9; }
      if (X0 < cx0) X0 = cx0; if (Y0 < cy0) Y0 = cy0; if (X1 > cx1) X1 = cx1; if (Y1 > cy1) Y1 = cy1;
      L.qB[q * 4] = X0; L.qB[q * 4 + 1] = Y0; L.qB[q * 4 + 2] = X1; L.qB[q * 4 + 3] = Y1;
      L.qP0[q] = start; L.qP1[q] = k;
      ph = 0; x0 = Infinity; y0 = Infinity; x1 = -Infinity; y1 = -Infinity; start = k; any = false; lastMi = -1;
    }
    if (op === 0) break;
    any = true;
    const mi = s[k + 1], n = NARGS[op];
    if (mi !== lastMi) {
      lastMi = mi; ph = (ph * 31 + MH[mi]) | 0;
      const m = mi * 6; a = M[m]; b = M[m + 1]; c = M[m + 2]; d = M[m + 3]; e = M[m + 4]; f = M[m + 5];
      sc = Math.max(Math.abs(a) + Math.abs(c), Math.abs(b) + Math.abs(d));
    }
    ph = (ph * 31 + op) | 0;
    for (let j = 0; j < n; j++) ph = (ph * 31 + ((s[k + 2 + j] * 64) | 0)) | 0;
    // the points that bound the segment (arcs: the centre ± the radius)
    let r = 0;
    const np = op === S_QUAD ? 2 : op === S_CUBIC ? 3 : op >= S_RECT && op <= S_RRECT ? 4 : n ? 1 : 0;
    if (op === S_ARC) r = Math.abs(s[k + 4]) * sc;
    else if (op === S_ELLIPSE) r = Math.max(Math.abs(s[k + 4]), Math.abs(s[k + 5])) * sc;
    for (let j = 0; j < np; j++) {
      let x: number, y: number;
      if (np === 4) { x = s[k + 2] + (j & 1 ? s[k + 4] : 0); y = s[k + 3] + (j & 2 ? s[k + 5] : 0); } else { x = s[k + 2 + j * 2]; y = s[k + 3 + j * 2]; }
      const X = a * x + c * y + e, Y = b * x + d * y + f;
      if (X - r < x0) x0 = X - r; if (Y - r < y0) y0 = Y - r; if (X + r > x1) x1 = X + r; if (Y + r > y1) y1 = Y + r;
    }
    k += 2 + n;
  }
  L.iQ0[i] = q0; L.iQ1[i] = L.nq;
}

/** Cached font sizes (the px in a CSS font string) for text boxes. */
const fontPx = new Map<string, number>();
function pxOf(font: string): number {
  let p = fontPx.get(font);
  if (p === undefined) { const m = /([\d.]+)px/.exec(font); p = m ? Number(m[1]) : 10; fontPx.set(font, p); }
  return p;
}
const WIDE = /[^\x00-\x7f]/;

// ---- the recorder ---------------------------------------------------------------------------------
/** A Canvas 2D context in plain JS that records the floor (see the header). Each path keeps a
 *  running hash and device box as it is built: an item costs a few writes, its pieces wait. */
export class FRec {
  L = new FList();
  /** Measures text (the real context; Gfx asks once per size). */
  measurer: Ctx2D | null = null;
  private st: State = { ...DEFAULT, dash: [] };
  private stIdx = -1;
  private own = true;
  private stack: { st: State; m: number[]; mi: number; clip: number }[] = [];
  private m = [1, 0, 0, 1, 0, 0];
  private mi = 0;
  /** the matrix, unpacked; `lin`: it scales, shears or rotates (not a translation only) */
  private ma = 1; private mb = 0; private mc = 0; private md = 1; private me = 0; private mf = 0; private lin = false;
  private clipI = 0;
  /** the path: its first segment, running hash, device box */
  private p0 = 0;
  private ph = 0;
  /** the path's fine hash (1/65536 px): a kept item whose fine hash moved crept (carried over) */
  private pf = 0;
  private bx0 = Infinity; private by0 = Infinity; private bx1 = -Infinity; private by1 = -Infinity;
  imageSmoothingEnabled = true;

  begin(W: number, H: number): void {
    const L = this.L;
    L.reset(W, H);
    this.st = { ...DEFAULT, dash: [] }; this.stIdx = -1; this.own = true; this.stack.length = 0;
    this.setM([1, 0, 0, 1, 0, 0]);
    this.clipI = 0; this.beginPath();
    L.cP0[0] = 0; L.cP1[0] = 0; L.cPar[0] = 0; L.cH[0] = 0; L.cB[0] = -1e9; L.cB[1] = -1e9; L.cB[2] = 1e9; L.cB[3] = 1e9;
  }

  // ---- state ----
  private set<K extends keyof State>(k: K, v: State[K]): void {
    if (this.st[k] === v) return;
    if (!this.own) { this.st = { ...this.st }; this.own = true; }
    this.stIdx = -1;
    this.st[k] = v;
  }
  // an empty colour is not one: a canvas keeps the style it had (box edges of '' stroke in the
  // previous colour), and so must a replay that skips the items between
  get fillStyle(): Paint { return this.st.fill; } set fillStyle(v: Paint) { if (v !== '') this.set('fill', typeof v === 'string' || v instanceof FGrad ? v : String(v)); }
  get strokeStyle(): Paint { return this.st.stroke; } set strokeStyle(v: Paint) { if (v !== '') this.set('stroke', typeof v === 'string' || v instanceof FGrad ? v : String(v)); }
  get lineWidth(): number { return this.st.lw; } set lineWidth(v: number) { if (v > 0 && Number.isFinite(v)) this.set('lw', v); }
  get lineCap(): string { return this.st.cap; } set lineCap(v: string) { this.set('cap', v); }
  get lineJoin(): string { return this.st.join; } set lineJoin(v: string) { this.set('join', v); }
  get miterLimit(): number { return this.st.miter; } set miterLimit(v: number) { if (v > 0 && Number.isFinite(v)) this.set('miter', v); }
  get font(): string { return this.st.font; } set font(v: string) { this.set('font', v); }
  get textAlign(): string { return this.st.align; } set textAlign(v: string) { this.set('align', v); }
  get textBaseline(): string { return this.st.base; } set textBaseline(v: string) { this.set('base', v); }
  get globalAlpha(): number { return this.st.alpha; } set globalAlpha(v: number) { if (Number.isFinite(v) && v >= 0 && v <= 1) this.set('alpha', v); }
  get globalCompositeOperation(): string { return this.st.comp; } set globalCompositeOperation(v: string) { this.set('comp', v); }
  get letterSpacing(): string { return this.st.ls; } set letterSpacing(v: string) { this.set('ls', v); }
  get lineDashOffset(): number { return this.st.dashOff; } set lineDashOffset(v: number) { if (Number.isFinite(v)) this.set('dashOff', v); }
  setLineDash(d: number[]): void {
    const cur = this.st.dash;
    if (cur.length === d.length && cur.every((x, i) => x === d[i])) return;
    if (d.some((x) => !Number.isFinite(x) || x < 0)) return;
    this.set('dash', d.length % 2 ? [...d, ...d] : d.slice());
  }
  getLineDash(): number[] { return this.st.dash.slice(); }
  save(): void { this.stack.push({ st: this.st, m: this.m, mi: this.mi, clip: this.clipI }); this.own = false; }
  restore(): void {
    const s = this.stack.pop();
    if (!s) return;
    this.st = s.st; this.stIdx = -1; this.own = false;
    this.unpack(s.m); this.mi = s.mi; this.clipI = s.clip;
  }
  measureText(s: string): TextMetrics {
    const r = this.measurer;
    if (r) { const f = r.font; r.font = this.st.font; const ls = r.letterSpacing; r.letterSpacing = this.st.ls; const m = r.measureText(s); r.font = f; r.letterSpacing = ls; return m; }
    return { width: s.length * pxOf(this.st.font) * 0.6 } as TextMetrics;
  }
  createLinearGradient(x0: number, y0: number, x1: number, y1: number): FGrad { return new FGrad(1, [x0, y0, x1, y1]); }
  createRadialGradient(x0: number, y0: number, r0: number, x1: number, y1: number, r1: number): FGrad { return new FGrad(2, [x0, y0, r0, x1, y1, r1]); }

  // ---- transforms ----
  private unpack(m: number[]): void {
    this.m = m; this.ma = m[0]; this.mb = m[1]; this.mc = m[2]; this.md = m[3]; this.me = m[4]; this.mf = m[5];
    this.lin = !(m[0] === 1 && m[1] === 0 && m[2] === 0 && m[3] === 1);
  }
  private setM(m: number[]): void {
    this.unpack(m);
    const L = this.L, k = L.nm++;
    if (L.mats.length < (k + 1) * 6) { L.mats = growF(L.mats, (k + 1) * 6); L.matH = growF(L.matH, k + 1); }
    let h = 17;
    for (let i = 0; i < 6; i++) { L.mats[k * 6 + i] = m[i]; h = (h * 31 + ((m[i] * 4096) | 0)) | 0; }
    L.matH[k] = h;
    this.mi = k;
    // a transform in the middle of a path: its later segments are in the new space
    this.ph = (this.ph * 31 + h) | 0;
    this.pf = (this.pf * 31 + h) | 0;
  }
  setTransform(a: number | DOMMatrix2DInit = 1, b = 0, c = 0, d = 1, e = 0, f = 0): void {
    if (typeof a === 'object') { const o = a as { a?: number; b?: number; c?: number; d?: number; e?: number; f?: number }; this.setM([o.a ?? 1, o.b ?? 0, o.c ?? 0, o.d ?? 1, o.e ?? 0, o.f ?? 0]); return; }
    this.setM([a, b, c, d, e, f]);
  }
  resetTransform(): void { if (!this.lin && this.me === 0 && this.mf === 0) return; this.setM([1, 0, 0, 1, 0, 0]); }
  transform(a: number, b: number, c: number, d: number, e: number, f: number): void {
    const m = this.m;
    this.setM([m[0] * a + m[2] * b, m[1] * a + m[3] * b, m[0] * c + m[2] * d, m[1] * c + m[3] * d, m[0] * e + m[2] * f + m[4], m[1] * e + m[3] * f + m[5]]);
  }
  translate(x: number, y: number): void { this.transform(1, 0, 0, 1, x, y); }
  scale(x: number, y: number): void { this.transform(x, 0, 0, y, 0, 0); }
  rotate(r: number): void { const c = Math.cos(r), s = Math.sin(r); this.transform(c, s, -s, c, 0, 0); }
  getTransform(): DOMMatrix { const m = this.m; return { a: m[0], b: m[1], c: m[2], d: m[3], e: m[4], f: m[5] } as DOMMatrix; }

  // ---- paths ----
  beginPath(): void {
    this.p0 = this.L.sn;
    this.ph = this.L.matH[this.mi] | 0;
    this.pf = 0;
    this.bx0 = Infinity; this.by0 = Infinity; this.bx1 = -Infinity; this.by1 = -Infinity;
  }
  /** A point of the path (and `r` around it) into its device box. */
  private pt(x: number, y: number, r: number): void {
    let X: number, Y: number;
    if (this.lin) { X = this.ma * x + this.mc * y + this.me; Y = this.mb * x + this.md * y + this.mf; r *= Math.max(Math.abs(this.ma) + Math.abs(this.mc), Math.abs(this.mb) + Math.abs(this.md)); } else { X = x + this.me; Y = y + this.mf; }
    if (X - r < this.bx0) this.bx0 = X - r; if (Y - r < this.by0) this.by0 = Y - r; if (X + r > this.bx1) this.bx1 = X + r; if (Y + r > this.by1) this.by1 = Y + r;
  }
  moveTo(x: number, y: number): void {
    const L = this.L, k = L.sn;
    if (k + 4 > L.sg.length) L.sg = growF(L.sg, k + 4);
    const s = L.sg; s[k] = S_MOVE; s[k + 1] = this.mi; s[k + 2] = x; s[k + 3] = y; L.sn = k + 4;
    this.ph = ((this.ph * 961 + ((x * 64) | 0) * 31 + ((y * 64) | 0)) | 0) + 1 | 0;
    this.pf = (this.pf * 961 + ((x * 65536) | 0) * 31 + ((y * 65536) | 0)) | 0;
    if (this.lin) { this.pt(x, y, 0); return; }
    const X = x + this.me, Y = y + this.mf;
    if (X < this.bx0) this.bx0 = X; if (Y < this.by0) this.by0 = Y; if (X > this.bx1) this.bx1 = X; if (Y > this.by1) this.by1 = Y;
  }
  lineTo(x: number, y: number): void {
    const L = this.L, k = L.sn;
    if (k + 4 > L.sg.length) L.sg = growF(L.sg, k + 4);
    const s = L.sg; s[k] = S_LINE; s[k + 1] = this.mi; s[k + 2] = x; s[k + 3] = y; L.sn = k + 4;
    this.ph = ((this.ph * 961 + ((x * 64) | 0) * 31 + ((y * 64) | 0)) | 0) + 2 | 0;
    this.pf = (this.pf * 961 + ((x * 65536) | 0) * 31 + ((y * 65536) | 0)) | 0;
    if (this.lin) { this.pt(x, y, 0); return; }
    const X = x + this.me, Y = y + this.mf;
    if (X < this.bx0) this.bx0 = X; if (Y < this.by0) this.by0 = Y; if (X > this.bx1) this.bx1 = X; if (Y > this.by1) this.by1 = Y;
  }
  closePath(): void {
    const L = this.L, k = L.sn;
    if (k + 2 > L.sg.length) L.sg = growF(L.sg, k + 2);
    L.sg[k] = S_CLOSE; L.sg[k + 1] = this.mi; L.sn = k + 2;
    this.ph = (this.ph * 31 + 9) | 0;
  }
  private seg(op: number, a: number, b: number, c: number, d: number, e = 0, f = 0, g = 0, h = 0): void {
    const L = this.L, k = L.sn, n = NARGS[op];
    if (k + 2 + n > L.sg.length) L.sg = growF(L.sg, k + 2 + n);
    const s = L.sg;
    s[k] = op; s[k + 1] = this.mi; s[k + 2] = a; s[k + 3] = b; s[k + 4] = c; s[k + 5] = d;
    if (n > 4) { s[k + 6] = e; if (n > 5) { s[k + 7] = f; if (n > 6) { s[k + 8] = g; s[k + 9] = h; } } }
    L.sn = k + 2 + n;
    let ph = (this.ph * 31 + op) | 0, pf = this.pf;
    for (let j = 0; j < n; j++) { const v = s[k + 2 + j]; ph = (ph * 31 + ((v * 64) | 0)) | 0; pf = (pf * 31 + ((v * 65536) | 0)) | 0; }
    this.ph = ph; this.pf = pf;
  }
  quadraticCurveTo(a: number, b: number, x: number, y: number): void { this.seg(S_QUAD, a, b, x, y); this.pt(a, b, 0); this.pt(x, y, 0); }
  bezierCurveTo(a: number, b: number, c: number, d: number, x: number, y: number): void { this.seg(S_CUBIC, a, b, c, d, x, y); this.pt(a, b, 0); this.pt(c, d, 0); this.pt(x, y, 0); }
  arc(x: number, y: number, r: number, a0: number, a1: number, ccw = false): void { this.seg(S_ARC, x, y, r, a0, a1, ccw ? 1 : 0); this.pt(x, y, Math.abs(r)); }
  ellipse(x: number, y: number, rx: number, ry: number, rot: number, a0: number, a1: number, ccw = false): void { this.seg(S_ELLIPSE, x, y, rx, ry, rot, a0, a1, ccw ? 1 : 0); this.pt(x, y, Math.max(Math.abs(rx), Math.abs(ry))); }
  rect(x: number, y: number, w: number, h: number): void { this.seg(S_RECT, x, y, w, h); this.pt(x, y, 0); this.pt(x + w, y, 0); this.pt(x, y + h, 0); this.pt(x + w, y + h, 0); }
  roundRect(x: number, y: number, w: number, h: number, r: number | number[] = 0): void { this.seg(S_RRECT, x, y, w, h, typeof r === 'number' ? r : Number(r[0] ?? 0)); this.pt(x, y, 0); this.pt(x + w, y, 0); this.pt(x, y + h, 0); this.pt(x + w, y + h, 0); }
  arcTo(x1: number, y1: number, _x2: number, _y2: number, _r: number): void { this.lineTo(x1, y1); }

  clip(rule: string | object = 'nonzero'): void {
    const L = this.L, p0 = this.p0, p1 = L.sn;
    if (p1 <= p0) return;
    const k = L.nc++;
    if (L.cP0.length <= k) { L.cP0 = growI(L.cP0, k + 1); L.cP1 = growI(L.cP1, k + 1); L.cRule = growI(L.cRule, k + 1); L.cPar = growI(L.cPar, k + 1); L.cH = growF(L.cH, k + 1); L.cB = growF(L.cB, (k + 1) * 4); }
    const par = this.clipI;
    L.cP0[k] = p0; L.cP1[k] = p1; L.cRule[k] = rule === 'evenodd' ? 1 : 0; L.cPar[k] = par;
    L.cH[k] = (((L.cH[par] * 31) | 0) + this.ph * 7 + L.cRule[k] + 1) | 0;
    // the clip's device box (within its parent's)
    L.cB[k * 4] = Math.max(this.bx0, L.cB[par * 4]); L.cB[k * 4 + 1] = Math.max(this.by0, L.cB[par * 4 + 1]);
    L.cB[k * 4 + 2] = Math.min(this.bx1, L.cB[par * 4 + 2]); L.cB[k * 4 + 3] = Math.min(this.by1, L.cB[par * 4 + 3]);
    this.clipI = k;
  }

  // ---- paints ----
  private stateIdx(): number {
    if (this.stIdx >= 0) return this.stIdx;
    const L = this.L, k = L.ns++;
    L.states[k] = this.st; L.stH[k] = stateHash(this.st);
    this.stIdx = k; this.own = false;
    return k;
  }
  /** An item: over the path p0..p1 (its hash `ph`) or a single box (bx0..by1), `pad` around. */
  private item(kind: number, p0: number, p1: number, ph: number, pf: number, a: number, b: number, c: number, d: number, text: string, bx0: number, by0: number, bx1: number, by1: number, pad: number): void {
    const L = this.L;
    L.roomItem();
    const k = L.n++, si = this.stateIdx(), clip = this.clipI;
    L.iK[k] = kind; L.iS[k] = si; L.iM[k] = this.mi; L.iC[k] = clip; L.iP0[k] = p0; L.iP1[k] = p1; L.iQ0[k] = -1;
    const A = L.iA, o = k * 4; A[o] = a; A[o + 1] = b; A[o + 2] = c; A[o + 3] = d;
    L.iT[k] = text;
    // the item's own hash: kind, state, matrix, clip, arguments, text
    let h = (kind * 977 + L.stH[si]) | 0;
    h = (h * 31 + L.matH[this.mi]) | 0;
    h = (h * 31 + L.cH[clip]) | 0;
    h = (((h * 31 + ((a * 64) | 0)) * 31 + ((b * 64) | 0)) * 31 + ((c * 64) | 0)) | 0;
    h = (h * 31 + ((d * 64) | 0)) | 0;
    if (text) h = (h * 31 + hstr(text)) | 0;
    L.iH[k] = h; L.iPad[k] = pad;
    L.iF[k] = ((((pf * 31 + ((a * 65536) | 0)) | 0) * 31 + ((b * 65536) | 0)) * 31 + ((c * 65536) | 0)) | 0;
    L.iDash[k] = kind === I_STROKE && this.st.dash.length > 0 ? 1 : 0;
    const comp = this.st.comp;
    const C = L.cB, cl = clip * 4;
    let x0 = bx0 - pad, y0 = by0 - pad, x1 = bx1 + pad, y1 = by1 + pad;
    // composite operators that reach outside the shape cover the whole canvas
    if (comp !== 'source-over' && comp !== 'source-atop' && comp !== 'multiply' && comp !== 'screen' && comp !== 'lighter' && comp !== 'darken' && comp !== 'lighten' && comp !== 'overlay' && comp !== 'saturation') { x0 = -1e9; y0 = -1e9; x1 = 1e9; y1 = 1e9; }
    if (x0 < C[cl]) x0 = C[cl]; if (y0 < C[cl + 1]) y0 = C[cl + 1]; if (x1 > C[cl + 2]) x1 = C[cl + 2]; if (y1 > C[cl + 3]) y1 = C[cl + 3];
    const B = L.iB; B[o] = x0; B[o + 1] = y0; B[o + 2] = x1; B[o + 3] = y1;
    L.iKey[k] = key52((ph * 31 + h) | 0, ((((x0 * 4) | 0) * 31 + ((y0 * 4) | 0)) * 31 + ((x1 * 4) | 0)) * 31 + ((y1 * 4) | 0) + (p1 - p0));
  }
  private scaleOf(): number { return this.lin ? Math.max(Math.abs(this.ma) + Math.abs(this.mc), Math.abs(this.mb) + Math.abs(this.md)) : 1; }
  private strokePad(): number {
    const sc = this.scaleOf(), st = this.st;
    const miter = st.join === 'miter' ? Math.min(st.miter, 4) : 1;
    return st.lw * sc * miter * 0.5 + (st.cap === 'butt' ? 0 : st.lw * sc * 0.5) + 2;
  }
  fill(rule: string | object = 'nonzero'): void {
    const p1 = this.L.sn;
    if (p1 <= this.p0) return;
    this.item(I_FILL, this.p0, p1, this.ph, this.pf, rule === 'evenodd' ? 1 : 0, 0, 0, 0, '', this.bx0, this.by0, this.bx1, this.by1, 1.5);
  }
  stroke(): void {
    const p1 = this.L.sn;
    if (p1 <= this.p0) return;
    this.item(I_STROKE, this.p0, p1, this.ph, this.pf, 0, 0, 0, 0, '', this.bx0, this.by0, this.bx1, this.by1, this.strokePad());
  }
  private rectItem(kind: number, x: number, y: number, w: number, h: number, pad: number): void {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let j = 0; j < 4; j++) {
      const px = j & 1 ? x + w : x, py = j & 2 ? y + h : y;
      const X = this.ma * px + this.mc * py + this.me, Y = this.mb * px + this.md * py + this.mf;
      if (X < x0) x0 = X; if (Y < y0) y0 = Y; if (X > x1) x1 = X; if (Y > y1) y1 = Y;
    }
    this.item(kind, 0, 0, 0, 0, x, y, w, h, '', x0, y0, x1, y1, pad);
  }
  fillRect(x: number, y: number, w: number, h: number): void { this.rectItem(I_FILLRECT, x, y, w, h, 1.5); }
  strokeRect(x: number, y: number, w: number, h: number): void { this.rectItem(I_STROKERECT, x, y, w, h, this.strokePad()); }
  clearRect(x: number, y: number, w: number, h: number): void { this.rectItem(I_CLEARRECT, x, y, w, h, 1); }
  private text(kind: number, s: string, x: number, y: number, maxW: number): void {
    const st = this.st, px = pxOf(st.font);
    const ls = st.ls && st.ls !== '0px' ? parseFloat(st.ls) || 0 : 0;
    let w = s.length * (px * 0.62 + ls);
    if (WIDE.test(s)) for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) > 127) w += px * 0.45;
    if (maxW > 0 && w > maxW) w = maxW;
    const al = st.align, bl = st.base;
    const left = al === 'center' ? x - w / 2 : al === 'right' || al === 'end' ? x - w : x;
    const top = bl === 'top' || bl === 'hanging' ? y : bl === 'middle' ? y - px * 0.65 : bl === 'bottom' || bl === 'ideographic' ? y - px * 1.3 : y - px * 1.05;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let j = 0; j < 4; j++) {
      const qx = j & 1 ? left + w : left, qy = j & 2 ? top + px * 1.4 : top;
      const X = this.ma * qx + this.mc * qy + this.me, Y = this.mb * qx + this.md * qy + this.mf;
      if (X < x0) x0 = X; if (Y < y0) y0 = Y; if (X > x1) x1 = X; if (Y > y1) y1 = Y;
    }
    this.item(kind, 0, 0, 0, 0, x, y, maxW, 0, s, x0, y0, x1, y1, kind === I_STROKETEXT ? this.strokePad() + 3 : 3);
  }
  fillText(s: string, x: number, y: number, maxW?: number): void { s = String(s); if (s) this.text(I_FILLTEXT, s, x, y, maxW ?? -1); }
  strokeText(s: string, x: number, y: number, maxW?: number): void { s = String(s); if (s) this.text(I_STROKETEXT, s, x, y, maxW ?? -1); }
}

// ---- the dirty grid -------------------------------------------------------------------------------
/** Dirty tiles (TILE CSS px a side) over a W×H canvas, with a summed-area table for box queries. */
export class Tiles {
  W = 0; H = 0; cols = 0; rows = 0;
  d = new Uint8Array(0);
  private sat = new Int32Array(0);
  count = 0;
  get total(): number { return this.cols * this.rows; }
  reset(W: number, H: number): void {
    const cols = Math.max(1, Math.ceil(W / TILE)), rows = Math.max(1, Math.ceil(H / TILE));
    if (cols !== this.cols || rows !== this.rows) { this.d = new Uint8Array(cols * rows); this.sat = new Int32Array((cols + 1) * (rows + 1)); } else this.d.fill(0);
    this.W = W; this.H = H; this.cols = cols; this.rows = rows; this.count = 0;
  }
  /** Marks the tiles under a box (CSS px). */
  mark(x0: number, y0: number, x1: number, y1: number): void {
    // a box that is not a number is a bug upstream: repaint it all rather than keep stale pixels
    if (x0 !== x0 || y0 !== y0 || x1 !== x1 || y1 !== y1) { this.all(); return; }
    if (!(x1 > 0 && y1 > 0 && x0 < this.W && y0 < this.H)) return;
    const c0 = Math.max(0, Math.floor(x0 / TILE)), c1 = Math.min(this.cols - 1, Math.floor(x1 / TILE));
    const r0 = Math.max(0, Math.floor(y0 / TILE)), r1 = Math.min(this.rows - 1, Math.floor(y1 / TILE));
    const d = this.d, cols = this.cols;
    for (let r = r0; r <= r1; r++) for (let c = c0, i = r * cols + c0; c <= c1; c++, i++) if (!d[i]) { d[i] = 1; this.count++; }
  }
  all(): void { this.d.fill(1); this.count = this.cols * this.rows; }
  /** The summed-area table (after marking, before `any`). */
  build(): void {
    const d = this.d, S = this.sat, cols = this.cols, w = cols + 1;
    for (let r = 0; r < this.rows; r++) {
      let run = 0;
      for (let c = 0; c < cols; c++) { run += d[r * cols + c]; S[(r + 1) * w + c + 1] = S[r * w + c + 1] + run; }
    }
  }
  /** Any dirty tile under the box. */
  any(x0: number, y0: number, x1: number, y1: number): boolean {
    if (!(x1 > 0 && y1 > 0 && x0 < this.W && y0 < this.H)) return false;
    const w = this.cols + 1;
    const c0 = Math.max(0, Math.floor(x0 / TILE)), c1 = Math.min(this.cols - 1, Math.floor(x1 / TILE)) + 1;
    const r0 = Math.max(0, Math.floor(y0 / TILE)), r1 = Math.min(this.rows - 1, Math.floor(y1 / TILE)) + 1;
    const S = this.sat;
    return S[r1 * w + c1] - S[r0 * w + c1] - S[r1 * w + c0] + S[r0 * w + c0] > 0;
  }
  /** The dirty tiles as rects (x0, y0, x1, y1 in CSS px): runs per row, merged down. */
  rects(): number[] {
    const out: number[] = [], d = this.d, cols = this.cols;
    let prev: number[] = []; // c0, c1, rect index
    for (let r = 0; r < this.rows; r++) {
      const cur: number[] = [];
      let c = 0, pi = 0;
      while (c < cols) {
        if (!d[r * cols + c]) { c++; continue; }
        const c0 = c;
        while (c < cols && d[r * cols + c]) c++;
        while (pi < prev.length && prev[pi] < c0) pi += 3;
        let idx = -1;
        if (pi < prev.length && prev[pi] === c0 && prev[pi + 1] === c) { idx = prev[pi + 2]; out[idx + 3] = Math.min(this.H, (r + 1) * TILE); }
        else { idx = out.length; out.push(c0 * TILE, r * TILE, Math.min(this.W, c * TILE), Math.min(this.H, (r + 1) * TILE)); }
        cur.push(c0, c, idx);
      }
      prev = cur;
    }
    return out;
  }
}

// ---- the diff ---------------------------------------------------------------------------------------
/** Marks in `T` what differs between the list the canvas shows (`A`) and the new one (`B`).
 *  Items equal by hash and in the same relative order are kept; in the items that changed, the
 *  pieces equal to their counterpart's (the old item between the same kept neighbours) are kept;
 *  the rest marks its old or new box. */
/** Segments b0.. of B take the numbers of segments a0.. of A (n floats, the same ops). */
function carrySegs(A: FList, a0: number, B: FList, b0: number, n: number): boolean {
  const sa = A.sg, sb = B.sg;
  for (let k = 0; k < n;) {
    const op = sb[b0 + k];
    if (sa[a0 + k] !== op) return false;
    const m = NARGS[op];
    for (let q = 2; q < m + 2; q++) sb[b0 + k + q] = sa[a0 + k + q];
    k += 2 + m;
  }
  return true;
}
/** B's item j is kept as A's item i (equal at 1/64 px). If it crept under that step (its 1/65536
 *  px hash moved: a post's height growing with its time in state), it takes A's numbers, so the
 *  list stays exactly what the canvas shows and the creep adds up until it shows. False: the two
 *  do not line up (then both are repainted). */
function carry(A: FList, i: number, B: FList, j: number): boolean {
  if (A.iF[i] === B.iF[j]) return true;
  const a0 = A.iP0[i], b0 = B.iP0[j], n = A.iP1[i] - a0;
  if (n !== B.iP1[j] - b0 || !carrySegs(A, a0, B, b0, n)) return false;
  for (let k = 0; k < 4; k++) { B.iA[j * 4 + k] = A.iA[i * 4 + k]; B.iB[j * 4 + k] = A.iB[i * 4 + k]; }
  B.iF[j] = A.iF[i]; B.iQ0[j] = -1;
  return true;
}

export const diffDbg: { on: boolean; marks: [string, number, number][] } = { on: false, marks: [] };
export function diff(A: FList, B: FList, T: Tiles): void {
  const na = A.n, nb = B.n, AK = A.iKey, BK = B.iKey;
  const AB = A.iB, BB = B.iB; // (the pieces' arrays grow as they are made: read them late)
  const keepPair = (i: number, j: number) => {
    if (carry(A, i, B, j)) return;
    T.mark(BB[j * 4], BB[j * 4 + 1], BB[j * 4 + 2], BB[j * 4 + 3]);
    T.mark(AB[i * 4], AB[i * 4 + 1], AB[i * 4 + 2], AB[i * 4 + 3]);
  };
  let p = 0;
  while (p < na && p < nb && AK[p] === BK[p]) { keepPair(p, p); p++; }
  if (p === na && p === nb) return;
  let s = 0;
  while (s < na - p && s < nb - p && AK[na - 1 - s] === BK[nb - 1 - s]) { keepPair(na - 1 - s, nb - 1 - s); s++; }
  const a0 = p, a1 = na - s, b0 = p, b1 = nb - s;
  // 1. items by hash (duplicates in order)
  const head = new Map<number, number>();
  const nxt = new Int32Array(Math.max(1, a1 - a0));
  for (let i = a1 - 1; i >= a0; i--) { const k = AK[i], h = head.get(k); nxt[i - a0] = h === undefined ? -1 : h; head.set(k, i); }
  const mb = b1 - b0;
  const mo = new Int32Array(Math.max(1, mb)).fill(-1);
  const usedA = new Uint8Array(Math.max(1, a1 - a0));
  for (let j = b0; j < b1; j++) {
    const h = head.get(BK[j]);
    if (h !== undefined && h >= 0) { mo[j - b0] = h; head.set(BK[j], nxt[h - a0]); usedA[h - a0] = 1; }
  }
  // 2. the longest run of matched items in the old order: kept; a matched item off it moved in z
  const keep = new Uint8Array(Math.max(1, mb));
  {
    const tails: number[] = [], tailJ: number[] = [], pred = new Int32Array(Math.max(1, mb)).fill(-1);
    for (let j = 0; j < mb; j++) {
      const v = mo[j];
      if (v < 0) continue;
      let lo = 0, hi = tails.length;
      while (lo < hi) { const m = (lo + hi) >> 1; if (tails[m] < v) lo = m + 1; else hi = m; }
      tails[lo] = v; tailJ[lo] = j;
      pred[j] = lo > 0 ? tailJ[lo - 1] : -1;
    }
    let j = tails.length ? tailJ[tails.length - 1] : -1;
    while (j >= 0) { keep[j] = 1; j = pred[j]; }
  }
  for (let j = 0; j < mb; j++) {
    if (mo[j] < 0) continue;
    if (keep[j]) { keepPair(mo[j], j + b0); continue; }
    const jb = (j + b0) * 4, ia = mo[j] * 4;
    if (diffDbg.on) diffDbg.marks.push(['moved', j + b0, -1]);
    T.mark(BB[jb], BB[jb + 1], BB[jb + 2], BB[jb + 3]);
    T.mark(AB[ia], AB[ia + 1], AB[ia + 2], AB[ia + 3]);
  }
  // 3. the changed items' pieces: each new item takes as counterpart one old changed item between
  //    the same kept neighbours (in order); its pieces equal to the counterpart's are kept
  for (let i = a0; i < a1; i++) if (!usedA[i - a0]) piecesOf(A, i);
  const qHead = new Map<number, number>();
  const nqa = A.nq;
  const qNext = new Int32Array(Math.max(1, nqa)), qItem = new Int32Array(Math.max(1, nqa)), usedQ = new Uint8Array(Math.max(1, nqa));
  for (let i = a1 - 1; i >= a0; i--) {
    if (usedA[i - a0]) continue;
    for (let q = A.iQ1[i] - 1; q >= A.iQ0[i]; q--) { const k = A.qKey[q], h = qHead.get(k); qNext[q] = h === undefined ? -1 : h; qHead.set(k, q); qItem[q] = i; }
  }
  const taken = new Uint8Array(Math.max(1, a1 - a0));
  let lastKept = a0 - 1, floorOld = a0 - 1;
  // the old index of the next kept item after each position (a backward pass)
  const nextKept = new Int32Array(Math.max(1, mb));
  { let nk = a1; for (let j = mb - 1; j >= 0; j--) { nextKept[j] = nk; if (keep[j]) nk = mo[j]; } }
  for (let j = 0; j < mb; j++) {
    if (keep[j]) { lastKept = mo[j]; floorOld = lastKept; continue; }
    if (mo[j] >= 0) continue; // moved: marked whole above
    const jj = j + b0, hiOld = nextKept[j];
    piecesOf(B, jj);
    let cp = -1;
    for (let q = B.iQ0[jj]; q < B.iQ1[jj]; q++) {
      let c = qHead.get(B.qKey[q]) ?? -1, hit = -1;
      while (c >= 0) {
        const it = qItem[c];
        if (!usedQ[c] && (cp >= 0 ? it === cp : it > floorOld && it < hiOld && it > lastKept && !taken[it - a0])) { hit = c; break; }
        c = qNext[c];
      }
      if (hit >= 0) {
        usedQ[hit] = 1;
        // the kept piece takes the shown numbers (see carry)
        const na0 = A.qP0[hit], nn = A.qP1[hit] - na0;
        if (nn > 0 && (nn !== B.qP1[q] - B.qP0[q] || !carrySegs(A, na0, B, B.qP0[q], nn))) {
          const o = q * 4, BQ = B.qB, AQ = A.qB, oa = hit * 4;
          T.mark(BQ[o], BQ[o + 1], BQ[o + 2], BQ[o + 3]); T.mark(AQ[oa], AQ[oa + 1], AQ[oa + 2], AQ[oa + 3]);
        }
        B.iF[jj] ^= 0x5bd1e995;
        if (cp < 0) { cp = qItem[hit]; taken[cp - a0] = 1; floorOld = cp; }
      } else { const o = q * 4, BQB = B.qB; if (diffDbg.on) diffDbg.marks.push(['new', jj, q]); T.mark(BQB[o], BQB[o + 1], BQB[o + 2], BQB[o + 3]); }
    }
  }
  // the old changed items' pieces nobody kept
  const AQB = A.qB;
  for (let i = a0; i < a1; i++) {
    if (usedA[i - a0]) continue;
    for (let q = A.iQ0[i]; q < A.iQ1[i]; q++) if (!usedQ[q]) { const o = q * 4; if (diffDbg.on) diffDbg.marks.push(['old', i, q]); T.mark(AQB[o], AQB[o + 1], AQB[o + 2], AQB[o + 3]); }
  }
}

// ---- the replay -------------------------------------------------------------------------------------
/** Replays a list's items into a real context, setting only the state that differs. */
class Replay {
  /** Debug (the bench): item, segments sent, for every path item a flush sends. */
  static dbg: number[] | null = null;
  ops = 0; drawn = 0; segs = 0;
  private st: Partial<State> = {};
  private mat = -1;
  private clip = 0;
  constructor(private ctx: Ctx2D, private L: FList, private flushN: number) {}
  /** After a restore the context's state is the saved one: forget what was set. */
  private forget(): void { this.st = {}; this.mat = -1; }
  private paint(p: Paint): string | CanvasGradient {
    if (typeof p === 'string') return p;
    if (p.realAt !== this.flushN || !p.real) {
      const a = p.a;
      const g = p.kind === 1 ? this.ctx.createLinearGradient(a[0], a[1], a[2], a[3]) : this.ctx.createRadialGradient(a[0], a[1], a[2], a[3], a[4], a[5]);
      for (let i = 0; i < p.stops.length; i += 2) g.addColorStop(p.stops[i] as number, p.stops[i + 1] as string);
      p.real = g; p.realAt = this.flushN;
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
  private segs_(p0: number, p1: number): void {
    const ctx = this.ctx, s = this.L.sg;
    let k = p0;
    while (k < p1) {
      const op = s[k];
      this.setMat(s[k + 1]);
      switch (op) {
        case S_MOVE: ctx.moveTo(s[k + 2], s[k + 3]); break;
        case S_LINE: ctx.lineTo(s[k + 2], s[k + 3]); break;
        case S_QUAD: ctx.quadraticCurveTo(s[k + 2], s[k + 3], s[k + 4], s[k + 5]); break;
        case S_CUBIC: ctx.bezierCurveTo(s[k + 2], s[k + 3], s[k + 4], s[k + 5], s[k + 6], s[k + 7]); break;
        case S_ARC: ctx.arc(s[k + 2], s[k + 3], s[k + 4], s[k + 5], s[k + 6], s[k + 7] === 1); break;
        case S_ELLIPSE: ctx.ellipse(s[k + 2], s[k + 3], s[k + 4], s[k + 5], s[k + 6], s[k + 7], s[k + 8], s[k + 9] === 1); break;
        case S_RECT: ctx.rect(s[k + 2], s[k + 3], s[k + 4], s[k + 5]); break;
        case S_RRECT: ctx.roundRect(s[k + 2], s[k + 3], s[k + 4], s[k + 5], s[k + 6]); break;
        case S_CLOSE: ctx.closePath(); break;
        default: break;
      }
      k += 2 + NARGS[op];
      this.ops++; this.segs++;
    }
  }
  /** Switches to the item's clip (the region's clip stays under it: save/restore). */
  private useClip(c: number): void {
    if (c === this.clip) return;
    const ctx = this.ctx, L = this.L;
    if (this.clip !== 0) { ctx.restore(); this.forget(); this.ops++; }
    this.clip = c;
    if (c === 0) return;
    ctx.save(); this.ops++;
    const chain: number[] = [];
    for (let k = c; k !== 0; k = L.cPar[k]) chain.push(k);
    for (let i = chain.length - 1; i >= 0; i--) {
      const k = chain[i];
      ctx.beginPath(); this.segs_(L.cP0[k], L.cP1[k]); ctx.clip(L.cRule[k] === 1 ? 'evenodd' : 'nonzero'); this.ops += 2;
    }
  }
  end(): void { if (this.clip !== 0) { this.ctx.restore(); this.ops++; this.clip = 0; this.forget(); } }
  /** Item `i`; with `T`, only if it crosses a dirty tile, and only its pieces that do. */
  item(i: number, T: Tiles | null): void {
    const L = this.L, B = L.iB, o = i * 4;
    if (T && !T.any(B[o], B[o + 1], B[o + 2], B[o + 3])) return;
    const ctx = this.ctx, kind = L.iK[i], s = L.states[L.iS[i]];
    const A = L.iA, a = A[o], b = A[o + 1], c = A[o + 2], d = A[o + 3];
    if (kind === I_FILL || kind === I_STROKE) {
      const segs0 = this.segs;
      if (!T) {
        this.useClip(L.iC[i]); this.state(s, kind); ctx.beginPath(); this.ops++;
        this.segs_(L.iP0[i], L.iP1[i]);
      } else {
        piecesOf(L, i);
        const q0 = L.iQ0[i], q1 = L.iQ1[i], QB = L.qB;
        let started = false;
        for (let q = q0; q < q1; q++) {
          if (q1 - q0 > 1 && !T.any(QB[q * 4], QB[q * 4 + 1], QB[q * 4 + 2], QB[q * 4 + 3])) continue;
          if (!started) { started = true; this.useClip(L.iC[i]); this.state(s, kind); ctx.beginPath(); this.ops++; }
          this.segs_(L.qP0[q], L.qP1[q]);
        }
        if (!started) return;
      }
      if (Replay.dbg) Replay.dbg.push(i, this.segs - segs0);
      this.setMat(L.iM[i]);
      if (kind === I_FILL) ctx.fill(a === 1 ? 'evenodd' : 'nonzero'); else ctx.stroke();
      this.ops++; this.drawn++;
      return;
    }
    this.useClip(L.iC[i]);
    this.state(s, kind);
    this.setMat(L.iM[i]);
    this.drawn++; this.ops++;
    switch (kind) {
      case I_FILLRECT: ctx.fillRect(a, b, c, d); return;
      case I_STROKERECT: ctx.strokeRect(a, b, c, d); return;
      case I_CLEARRECT: ctx.clearRect(a, b, c, d); return;
      case I_FILLTEXT: { const t = L.iT[i]; if (c > 0) ctx.fillText(t, a, b, c); else ctx.fillText(t, a, b); return; }
      case I_STROKETEXT: { const t = L.iT[i]; if (c > 0) ctx.strokeText(t, a, b, c); else ctx.strokeText(t, a, b); return; }
      default: return;
    }
  }
}

// ---- the cache ----------------------------------------------------------------------------------------
/** The floor canvas's retained list: record a repaint into it, then `flush` sends the canvas only
 *  the tiles that changed (whole when what it shows is unknown, or most of it changed). */
export { Replay as FloorReplay };
export class FloorCache {
  /** Debug: every partial flush checks the diff's invariant (verifyDiff) and logs it. */
  static verify = false;
  /** Debug: log every partial flush's rects. */
  static logRects = false;
  private rec = new FRec();
  private lists = [new FList(), new FList()];
  /** What the canvas shows (null: unknown, after a direct paint). */
  private shown: FList | null = null;
  private T = new Tiles();
  private flushN = 0;
  /** What the last flush did. */
  readonly last = { whole: false, items: 0, pieces: 0, drawn: 0, ops: 0, segs: 0, tiles: 0, of: 0 };
  /** Since the bench last read them: flushes, partial ones, empty ones, ops sent. */
  readonly totals = { flushes: 0, partial: 0, empty: 0, ops: 0, whole: 0 };

  /** The last recording and what the canvas shows (the bench reads them). */
  get list(): FList { return this.rec.L; }
  get shownList(): FList | null { return this.shown; }
  /** Records a repaint W×H: returns the context the layers draw into. */
  begin(W: number, H: number, measurer: Ctx2D): Ctx2D {
    const free = this.lists[0] === this.shown ? this.lists[1] : this.lists[0];
    this.rec.L = free;
    this.rec.measurer = measurer;
    this.rec.begin(W, H);
    return this.rec as unknown as Ctx2D;
  }
  /** The canvas was painted directly: what it shows is not recorded. */
  invalidate(): void { this.shown = null; }
  get valid(): boolean { return this.shown !== null; }

  /** Sends `ctx` what differs between the canvas and the last recording; returns ops sent. */
  flush(ctx: Ctx2D, forceWhole = false): number {
    const B = this.rec.L, A = this.shown, T = this.T, last = this.last;
    const W = B.W, H = B.H;
    this.flushN++;
    this.totals.flushes++;
    last.items = B.n; last.pieces = B.nq; last.drawn = 0; last.ops = 0; last.segs = 0;
    T.reset(W, H);
    last.of = T.total;
    let whole = forceWhole || !A || A.W !== W || A.H !== H;
    if (!whole) {
      diff(A!, B, T);
      if (FloorCache.verify && T.count) console.log(`floorcache: verify ${this.flushN} tiles ${T.count}: ${verifyDiff(A!, B, T) || 'ok'}`);
      if (T.count === 0) { this.shown = B; last.whole = false; last.tiles = 0; this.totals.empty++; return 0; }
      if (T.count > WHOLE_SHARE * T.total) whole = true;
    }
    last.whole = whole;
    last.tiles = whole ? T.total : T.count;
    if (whole) this.totals.whole++;
    const rp = new Replay(ctx, B, this.flushN);
    ctx.resetTransform();
    if (whole) {
      ctx.clearRect(0, 0, W, H);
      for (let i = 0; i < B.n; i++) rp.item(i, null);
      rp.end();
    } else {
      this.totals.partial++;
      T.build();
      const R = T.rects();
      if (FloorCache.logRects) console.log(`floorcache: flush ${this.flushN} rects ${JSON.stringify(R.map((v) => Math.round(v)))}`);
      for (let k = 0; k < R.length; k += 4) ctx.clearRect(R[k], R[k + 1], R[k + 2] - R[k], R[k + 3] - R[k + 1]);
      ctx.save();
      ctx.beginPath();
      for (let k = 0; k < R.length; k += 4) ctx.rect(R[k], R[k + 1], R[k + 2] - R[k], R[k + 3] - R[k + 1]);
      ctx.clip();
      for (let i = 0; i < B.n; i++) rp.item(i, T);
      rp.end();
      ctx.restore();
      rp.ops += 4 + R.length / 2;
    }
    this.shown = B;
    last.drawn = rp.drawn; last.ops = rp.ops; last.segs = rp.segs;
    this.totals.ops += rp.ops;
    return rp.ops;
  }
}

/** Debug (the bench): the diff's invariant. Every piece that touches a clean tile must be painted
 *  the same, in the same order, in both lists (else a pixel the flush keeps would differ). Returns
 *  the first mismatch, or ''. */
export function verifyDiff(A: FList, B: FList, T: Tiles): string {
  const seq = (L: FList): { k: number; i: number; q: number }[] => {
    const out: { k: number; i: number; q: number }[] = [];
    for (let i = 0; i < L.n; i++) {
      piecesOf(L, i);
      for (let q = L.iQ0[i]; q < L.iQ1[i]; q++) {
        const o = q * 4, x0 = L.qB[o], y0 = L.qB[o + 1], x1 = L.qB[o + 2], y1 = L.qB[o + 3];
        if (!(x1 > 0 && y1 > 0 && x0 < T.W && y0 < T.H)) continue;
        const c0 = Math.max(0, Math.floor(x0 / TILE)), c1 = Math.min(T.cols - 1, Math.floor(x1 / TILE));
        const r0 = Math.max(0, Math.floor(y0 / TILE)), r1 = Math.min(T.rows - 1, Math.floor(y1 / TILE));
        let clean = false;
        for (let r = r0; r <= r1 && !clean; r++) for (let c = c0; c <= c1; c++) if (!T.d[r * T.cols + c]) { clean = true; break; }
        if (clean) out.push({ k: L.qKey[q], i, q });
      }
    }
    return out;
  };
  const a = seq(A), b = seq(B);
  const n = Math.min(a.length, b.length);
  const desc = (L: FList, e: { i: number; q: number } | undefined) => {
    if (!e) return 'none';
    const st = L.states[L.iS[e.i]], o = e.q * 4;
    return `item ${e.i} kind ${L.iK[e.i]} fill ${String(st.fill)} stroke ${String(st.stroke)} box ${L.qB.slice(o, o + 4).map((v) => Math.round(v)).join(',')}`;
  };
  for (let k = 0; k < n; k++) if (a[k].k !== b[k].k) return `at ${k}: old ${desc(A, a[k])} · new ${desc(B, b[k])}`;
  if (a.length !== b.length) return `lengths ${a.length} vs ${b.length}: old ${desc(A, a[n])} · new ${desc(B, b[n])}`;
  return '';
}
