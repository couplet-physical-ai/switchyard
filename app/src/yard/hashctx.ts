// A 2D context that paints nothing (p3-yard): it hashes every call a draw makes, with every
// argument bit for bit, and keeps the box the calls can ink. The info layer draws a panel (or a
// part of one) into it first: the same hash means the same calls, so the same pixels, and the
// panel is not sent again; a different one tells which boxes to repaint. Nothing goes to the
// host, so a panel whose key moved but whose look did not costs only its own logic.
//
// It also notes whether a part used a state it did not set itself (a colour, a width, a font) or
// left one off the baseline (alpha 1, no dash, no letter spacing): such a part cannot be redrawn
// alone, clipped, in the middle of its panel, so its panel is repainted whole.

import type { Ctx2D } from '../../app.contract.d.ts';

const F64 = new Float64Array(1);
const U32 = new Uint32Array(F64.buffer);

// what a part sets before it uses it
const S_FILL = 1, S_STROKE = 2, S_WIDTH = 4, S_FONT = 8, S_ALIGN = 16;

export class HashCtx {
  /** Two 32-bit lanes of the hash of every call since `reset`. */
  h1 = 0x811c9dc5 | 0;
  h2 = 0x1b873593 | 0;
  /** The box the calls can ink (canvas units), Infinity/-Infinity when none. */
  x0 = Infinity; y0 = Infinity; x1 = -Infinity; y1 = -Infinity;
  /** A state used before this part set it, or one left off the baseline at its end. */
  inherits = false;
  private set = 0;
  /** Where measureText goes (the real context: a monospaced advance is measured once). */
  measurer: Ctx2D | null = null;
  // the current path's box
  private px0 = Infinity; private py0 = Infinity; private px1 = -Infinity; private py1 = -Infinity;
  private fontPx = 12;
  private ls = 0;
  private _fillStyle: unknown = '#000';
  private _strokeStyle: unknown = '#000';
  private _lineWidth = 1;
  private _font = '10px sans-serif';
  private _textAlign = 'left';
  private _globalAlpha = 1;
  private _letterSpacing = '0px';
  private dashed = false;
  textBaseline = 'alphabetic';
  lineCap = 'butt';
  lineJoin = 'miter';

  /** A fresh hash and box; the state is kept (a part starts where the panel's last one left it). */
  reset(): void {
    this.h1 = 0x811c9dc5 | 0; this.h2 = 0x1b873593 | 0;
    this.x0 = this.y0 = Infinity; this.x1 = this.y1 = -Infinity;
    this.px0 = this.py0 = Infinity; this.px1 = this.py1 = -Infinity;
    this.inherits = false;
    this.set = 0;
  }

  /** The part ended: off the baseline means it cannot be redrawn alone. */
  end(): void {
    if (this._globalAlpha !== 1 || this.dashed || (this._letterSpacing !== '0px' && this._letterSpacing !== '')) this.inherits = true;
  }

  /** Hashes a number (a subclass's arguments). */
  protected num(v: number): void { this.n(v); }
  private n(v: number): void {
    F64[0] = v;
    const a = U32[0], b = U32[1];
    this.h1 = Math.imul(this.h1 ^ a, 0x01000193) ^ b;
    this.h2 = Math.imul((this.h2 + b) | 0, 0x5bd1e995) ^ (a >>> 13);
  }
  private s(v: unknown): void {
    const str = String(v);
    let h = 0x9747b28c | 0;
    for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 0x01000193);
    this.n(h); this.n(str.length);
  }
  private pt(x: number, y: number, r = 0): void {
    if (x - r < this.px0) this.px0 = x - r;
    if (x + r > this.px1) this.px1 = x + r;
    if (y - r < this.py0) this.py0 = y - r;
    if (y + r > this.py1) this.py1 = y + r;
  }
  private ink(x0: number, y0: number, x1: number, y1: number): void {
    if (x0 < this.x0) this.x0 = x0;
    if (y0 < this.y0) this.y0 = y0;
    if (x1 > this.x1) this.x1 = x1;
    if (y1 > this.y1) this.y1 = y1;
  }
  private need(bits: number): void {
    if ((this.set & bits) !== bits) this.inherits = true;
  }

  get fillStyle(): unknown { return this._fillStyle; }
  set fillStyle(v: unknown) { this._fillStyle = v; this.set |= S_FILL; this.n(1); this.s(v); }
  get strokeStyle(): unknown { return this._strokeStyle; }
  set strokeStyle(v: unknown) { this._strokeStyle = v; this.set |= S_STROKE; this.n(2); this.s(v); }
  get lineWidth(): number { return this._lineWidth; }
  set lineWidth(v: number) { this._lineWidth = v; this.set |= S_WIDTH; this.n(3); this.n(v); }
  get font(): string { return this._font; }
  set font(v: string) {
    this._font = v; this.set |= S_FONT; this.n(4); this.s(v);
    const m = /(\d+(?:\.\d+)?)px/.exec(v);
    this.fontPx = m ? Number(m[1]) : 12;
  }
  get textAlign(): string { return this._textAlign; }
  set textAlign(v: string) { this._textAlign = v; this.set |= S_ALIGN; this.n(5); this.s(v); }
  get globalAlpha(): number { return this._globalAlpha; }
  set globalAlpha(v: number) { this._globalAlpha = v; this.n(6); this.n(v); }
  get letterSpacing(): string { return this._letterSpacing; }
  set letterSpacing(v: string) { this._letterSpacing = v; this.n(7); this.s(v); const m = /(-?\d+(?:\.\d+)?)px/.exec(v); this.ls = m ? Number(m[1]) : 0; }

  setLineDash(d: number[]): void { this.dashed = d.length > 0; this.n(8); this.n(d.length); for (const x of d) this.n(x); }
  measureText(s: string): { width: number } {
    const m = this.measurer;
    if (m) {
      // the real face's advance (the caller keeps it per size), with this context's font; the
      // real context's own font and spacing are put back
      const f = m.font, ls = m.letterSpacing;
      m.font = this._font;
      m.letterSpacing = this._letterSpacing;
      const r = m.measureText(s);
      m.font = f;
      m.letterSpacing = ls;
      return r;
    }
    return { width: s.length * this.fontPx * 0.6 };
  }
  beginPath(): void { this.n(10); this.px0 = this.py0 = Infinity; this.px1 = this.py1 = -Infinity; }
  moveTo(x: number, y: number): void { this.n(11); this.n(x); this.n(y); this.pt(x, y); }
  lineTo(x: number, y: number): void { this.n(12); this.n(x); this.n(y); this.pt(x, y); }
  arc(x: number, y: number, r: number, a0: number, a1: number, ccw = false): void { this.n(13); this.n(x); this.n(y); this.n(r); this.n(a0); this.n(a1); this.n(ccw ? 1 : 0); this.pt(x, y, r); }
  roundRect(x: number, y: number, w: number, h: number, r: number): void { this.n(14); this.n(x); this.n(y); this.n(w); this.n(h); this.n(r); this.pt(x, y); this.pt(x + w, y + h); }
  rect(x: number, y: number, w: number, h: number): void { this.n(15); this.n(x); this.n(y); this.n(w); this.n(h); this.pt(x, y); this.pt(x + w, y + h); }
  fill(): void { this.n(20); this.need(S_FILL); this.ink(this.px0 - 1, this.py0 - 1, this.px1 + 1, this.py1 + 1); }
  stroke(): void { this.n(21); this.need(S_STROKE | S_WIDTH); const e = this._lineWidth / 2 + 1; this.ink(this.px0 - e, this.py0 - e, this.px1 + e, this.py1 + e); }
  fillRect(x: number, y: number, w: number, h: number): void { this.n(22); this.n(x); this.n(y); this.n(w); this.n(h); this.need(S_FILL); this.ink(Math.min(x, x + w) - 1, Math.min(y, y + h) - 1, Math.max(x, x + w) + 1, Math.max(y, y + h) + 1); }
  clearRect(x: number, y: number, w: number, h: number): void { this.n(23); this.n(x); this.n(y); this.n(w); this.n(h); this.ink(x - 1, y - 1, x + w + 1, y + h + 1); }
  fillText(s: string, x: number, y: number): void {
    this.n(24); this.s(s); this.n(x); this.n(y);
    this.need(S_FILL | S_FONT | S_ALIGN);
    // generous: a monospaced face's advance is ~0.6 em; glyphs overhang, '…' and '⟳' are wide
    const px = this.fontPx;
    const w = s.length * (px * 0.75 + Math.max(0, this.ls)) + px;
    const a = this._textAlign;
    const xa = a === 'center' ? x - w / 2 : a === 'right' || a === 'end' ? x - w : x - px * 0.5;
    this.ink(xa, y - px * 1.25, xa + w + px * 0.5, y + px * 0.5);
  }
  save(): void { this.n(30); }
  restore(): void { this.n(31); this.inherits = true; }
  clip(): void { this.n(32); this.inherits = true; }
  setTransform(): void { this.n(33); this.inherits = true; }
  resetTransform(): void { this.n(34); this.inherits = true; }
  translate(): void { this.n(35); this.inherits = true; }
  scale(): void { this.n(36); this.inherits = true; }
}

/** A HashCtx that also keeps the calls, to be played on a real context only if their hash moved
 *  (the live layer's redraws that are not animation frames: a still yard redrawn because a
 *  surface argument moved paints nothing, and its canvas keeps its pixels). */
export class TapeCtx extends HashCtx {
  /** [name, value or arguments]: a property set or a call, in order. */
  private tape: [string, unknown][] = [];
  clearTape(): void { this.tape.length = 0; }
  play(ctx: Ctx2D): void {
    const c = ctx as unknown as Record<string, unknown>;
    for (const [k, v] of this.tape) {
      if (Array.isArray(v)) (c[k] as (...a: unknown[]) => void).apply(ctx, v);
      else c[k] = v;
    }
  }
  override set fillStyle(v: unknown) { super.fillStyle = v; this.tape.push(['fillStyle', v]); }
  override get fillStyle(): unknown { return super.fillStyle; }
  override set strokeStyle(v: unknown) { super.strokeStyle = v; this.tape.push(['strokeStyle', v]); }
  override get strokeStyle(): unknown { return super.strokeStyle; }
  override set lineWidth(v: number) { super.lineWidth = v; this.tape.push(['lineWidth', v]); }
  override get lineWidth(): number { return super.lineWidth; }
  override set font(v: string) { super.font = v; this.tape.push(['font', v]); }
  override get font(): string { return super.font; }
  override set textAlign(v: string) { super.textAlign = v; this.tape.push(['textAlign', v]); }
  override get textAlign(): string { return super.textAlign; }
  override set globalAlpha(v: number) { super.globalAlpha = v; this.tape.push(['globalAlpha', v]); }
  override get globalAlpha(): number { return super.globalAlpha; }
  override set letterSpacing(v: string) { super.letterSpacing = v; this.tape.push(['letterSpacing', v]); }
  override get letterSpacing(): string { return super.letterSpacing; }
  override setLineDash(d: number[]): void { super.setLineDash(d); this.tape.push(['setLineDash', [d.slice()]]); }
  override beginPath(): void { super.beginPath(); this.tape.push(['beginPath', []]); }
  override moveTo(x: number, y: number): void { super.moveTo(x, y); this.tape.push(['moveTo', [x, y]]); }
  override lineTo(x: number, y: number): void { super.lineTo(x, y); this.tape.push(['lineTo', [x, y]]); }
  override arc(x: number, y: number, r: number, a0: number, a1: number, ccw = false): void { super.arc(x, y, r, a0, a1, ccw); this.tape.push(['arc', [x, y, r, a0, a1, ccw]]); }
  override roundRect(x: number, y: number, w: number, h: number, r: number): void { super.roundRect(x, y, w, h, r); this.tape.push(['roundRect', [x, y, w, h, r]]); }
  override rect(x: number, y: number, w: number, h: number): void { super.rect(x, y, w, h); this.tape.push(['rect', [x, y, w, h]]); }
  override fill(): void { super.fill(); this.tape.push(['fill', []]); }
  override stroke(): void { super.stroke(); this.tape.push(['stroke', []]); }
  override fillRect(x: number, y: number, w: number, h: number): void { super.fillRect(x, y, w, h); this.tape.push(['fillRect', [x, y, w, h]]); }
  override clearRect(x: number, y: number, w: number, h: number): void { super.clearRect(x, y, w, h); this.tape.push(['clearRect', [x, y, w, h]]); }
  override fillText(s: string, x: number, y: number): void { super.fillText(s, x, y); this.tape.push(['fillText', [s, x, y]]); }
  override save(): void { super.save(); this.tape.push(['save', []]); }
  override restore(): void { super.restore(); this.tape.push(['restore', []]); }
  override clip(): void { super.clip(); this.tape.push(['clip', []]); }
  override setTransform(...a: number[]): void { super.setTransform(); this.n6(a); this.tape.push(['setTransform', a]); }
  override resetTransform(): void { super.resetTransform(); this.tape.push(['resetTransform', []]); }
  override translate(...a: number[]): void { super.translate(); this.n6(a); this.tape.push(['translate', a]); }
  override scale(...a: number[]): void { super.scale(); this.n6(a); this.tape.push(['scale', a]); }
  private n6(a: number[]): void { for (const x of a) this.num(x); }
}
