// The yard's drawing surface: a thin wrapper over the canvas context that counts what a draw
// costs (budget.ts turns the counts into milliseconds) and measures text without asking the
// host. Commit Mono is monospaced, so a string's width is its length times the advance of
// its size: measured once per (size, weight) and kept, which makes fitting, truncating and
// centring labels free (a host measure is a JSON round trip on native; DESIGN.md "Rendering").

import type { Ctx2D } from '../../app.contract.d.ts';
import { C, TAU, font } from './theme.ts';

export type Align = 'left' | 'center' | 'right';
/** A run: text, colour, bold, priority (higher stays longer), cuttable (a commit message). */
export type Tok = readonly [string, string, boolean?, number?, boolean?];

/** Where a new token starts in a run of text: ` · `, ` → `, the space after a comma, a double
 *  space. */
function boundaryAt(s: string, i: number): boolean {
  const ch = s.charCodeAt(i);
  if (ch !== 32) return false;
  const nx = s.charCodeAt(i + 1);
  if ((nx === 0xb7 || nx === 0x2192) && s.charCodeAt(i + 2) === 32) return true;
  if (i > 0 && s.charCodeAt(i - 1) === 44) return true;
  return nx === 32 && (i === 0 || s.charCodeAt(i - 1) !== 32);
}

export class Gfx {
  ctx!: Ctx2D;
  /** Drawing operations recorded since `begin` (paths, fills, strokes, state). */
  ops = 0;
  /** Circles and arcs (each becomes four curves in the recorder). */
  arcs = 0;
  /** fillText calls (each one measures through the host on native). */
  texts = 0;
  /** Device pixels per yard unit (the host's scale times the yard's `k`). */
  px = 1;
  private adv = new Map<number, number>();

  begin(ctx: Ctx2D, devicePx: number): void {
    this.ctx = ctx;
    this.ops = 0;
    this.arcs = 0;
    this.texts = 0;
    this.px = devicePx;
  }

  /** Forget measured advances (the font finished loading, or changed). */
  resetFonts(): void {
    this.adv.clear();
  }

  /** Measure through `other`'s advances (one book for a layer's real and hashing passes). */
  shareAdvances(other: Gfx): void {
    this.adv = other.adv;
  }

  /** The advance of one glyph at `px` (monospace). */
  advance(px: number, bold = false): number {
    const key = bold ? -px : px;
    let a = this.adv.get(key);
    if (a === undefined) {
      // Measured without letter spacing: an eyebrow (1 px tracking) asking first must not
      // make every caption of its size 1 px a glyph wider (the gaps between runs, the early
      // ellipses).
      const ls = this.ctx.letterSpacing;
      if (ls && ls !== '0px') this.ctx.letterSpacing = '0px';
      this.ctx.font = font(px, bold);
      a = this.ctx.measureText('0000000000').width / 10;
      if (ls && ls !== '0px') this.ctx.letterSpacing = ls;
      if (!(a > 0)) a = px * 0.6;
      this.adv.set(key, a);
    }
    return a;
  }

  width(s: string, px: number, bold = false): number {
    return s.length * this.advance(px, bold);
  }

  /** `s` cut to at most `maxW` wide with a trailing ellipsis. */
  fit(s: string, px: number, maxW: number, bold = false): string {
    const a = this.advance(px, bold);
    const n = Math.floor(maxW / a);
    if (s.length <= n) return s;
    if (n <= 1) return '';
    return `${s.slice(0, n - 1)}…`;
  }

  /** The thinnest line: one device pixel (0.5 yard px on Retina). */
  get hair(): number {
    return 1 / Math.max(1, Math.round(this.px));
  }

  /** A crisp coordinate for a line `w` yard px wide (an odd device width sits on a pixel centre). */
  crisp(v: number, w = 1): number {
    const p = this.px;
    const dev = Math.max(1, Math.round(w * p));
    return dev % 2 ? (Math.floor(v * p) + 0.5) / p : Math.round(v * p) / p;
  }

  text(s: string, x: number, y: number, color: string, px: number, bold = false, align: Align = 'left'): number {
    if (!s) return 0;
    const ctx = this.ctx;
    ctx.font = font(px, bold);
    ctx.textAlign = align;
    ctx.fillStyle = color;
    ctx.fillText(s, x, y);
    this.ops += 3;
    this.texts++;
    return this.width(s, px, bold);
  }

  /** Runs of text on one line, each its own colour; returns the end x. Fitted to `maxW` at
   *  token boundaries (`fitTokens`): never a number, sha or handle cut in half. */
  runs(parts: readonly Tok[], x: number, y: number, px: number, maxW = 1e9): number {
    let total = 0;
    for (let i = 0; i < parts.length; i++) { const p = parts[i]; if (p[0]) total += this.width(p[0], px, !!p[2]); }
    return this.paint(total <= maxW + 0.01 ? parts : this.fitTokens(parts, px, maxW), x, y, px);
  }

  /** Paints runs left to right; neighbouring runs of one colour and weight go out as one text
   *  (a text is a host round trip: ~22 µs on Hermes), the same pixels in a monospaced face. */
  private paint(parts: readonly Tok[], x: number, y: number, px: number): number {
    const ctx = this.ctx;
    ctx.textAlign = 'left';
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i];
      let s = p[0];
      if (!s) continue;
      const bold = !!p[2];
      while (i + 1 < parts.length && (!parts[i + 1][0] || (parts[i + 1][1] === p[1] && !!parts[i + 1][2] === bold))) s += parts[++i][0];
      ctx.font = font(px, bold);
      ctx.fillStyle = p[1];
      ctx.fillText(s, x, y);
      this.ops += 2;
      this.texts++;
      x += this.width(s, px, bold);
    }
    return x;
  }

  /**
   * Fits runs into `maxW` (measured advances, so the web's wider face and the Mac's each fit
   * their own) by whole tokens. A token starts at a ` · `, ` → `, `, ` or a double space, at a
   * run that begins with one, and at every run that names its own priority (a run that names
   * none and starts with no separator continues the token before it). The lowest
   * priority goes first: by default the later a token, the lower (explicit priorities are
   * the 4th element). A token marked cuttable (5th element, e.g. a commit message) is cut
   * with an ellipsis when that leaves ≥ 6 characters, else dropped with its separator. Nothing
   * else is ever cut: a number, a sha, a handle shows whole or not at all.
   */
  fitTokens(parts: readonly Tok[], px: number, maxW: number): Tok[] {
    type Tk = { segs: [string, string, boolean][]; w: number; pri: number; cut: boolean; drop: boolean };
    const toks: Tk[] = [];
    let cur: Tk | null = null;
    for (let i = 0; i < parts.length; i++) {
      const [s, c, b0, pr, cut] = parts[i];
      if (!s) continue;
      const bold = !!b0;
      const explicit = pr !== undefined;
      let a = 0, q = 0;
      for (let j = 1; j <= s.length; j++) {
        if (j < s.length && !boundaryAt(s, j)) continue;
        const piece = s.slice(a, j);
        const fresh = !cur || q > 0 || explicit || boundaryAt(s, 0);
        if (fresh) {
          cur = { segs: [], w: 0, pri: explicit ? (pr as number) - q * 0.001 : -toks.length, cut: !!cut, drop: false };
          toks.push(cur);
        }
        cur!.segs.push([piece, c, bold]);
        cur!.w += this.width(piece, px, bold);
        a = j; q++;
      }
    }
    let total = 0;
    for (const t of toks) total += t.w;
    const order = toks.map((_, i) => i).sort((i, j) => toks[i].pri - toks[j].pri || j - i);
    for (const i of order) {
      if (total <= maxW + 0.01) break;
      const t = toks[i];
      if (t.cut) {
        const adv = this.advance(px, t.segs[0][2]);
        const n = Math.floor((maxW - (total - t.w)) / adv) - 1;
        const text = t.segs.map((z) => z[0]).join('');
        const lead = text.length - text.replace(/^[\s·→,]+/, '').length;
        if (n - lead >= 6) {
          let left = n;
          const segs: [string, string, boolean][] = [];
          for (const z of t.segs) {
            if (left <= 0) break;
            const piece = z[0].length > left ? z[0].slice(0, left) : z[0];
            left -= piece.length;
            segs.push([piece, z[1], z[2]]);
          }
          const last = segs[segs.length - 1];
          last[0] = `${last[0].replace(/[\s·]+$/, '')}…`;
          t.segs = segs;
          let w = 0;
          for (const z of segs) w += this.width(z[0], px, z[2]);
          total += w - t.w;
          t.w = w;
          continue;
        }
      }
      t.drop = true;
      total -= t.w;
    }
    const out: Tok[] = [];
    let before = false;
    for (const t of toks) {
      if (t.drop) { before = true; continue; }
      for (const z of t.segs) {
        // The line's new first token, after a dropped one, loses its leading separator.
        if (before && !out.length) { const s = z[0].replace(/^[\s·→,]+/, ''); if (s) out.push([s, z[1], z[2]]); }
        else out.push(z);
      }
      before = false;
    }
    return out;
  }

  /** Uppercase tracked eyebrow runs (the inspiration's `LIVE · RUNNING TONIGHT`). */
  eyebrow(parts: readonly (readonly [string, string])[], x: number, y: number, px: number, maxW = 1e9): number {
    const ctx = this.ctx;
    ctx.letterSpacing = '1px';
    ctx.textAlign = 'left';
    const a = this.advance(px) + 1;
    const x0 = x;
    for (const [s0, c] of parts) {
      if (!s0) continue;
      const room = Math.floor((maxW - (x - x0)) / a);
      if (room <= 0) break;
      let s = s0.toUpperCase();
      if (s.length > room) s = room > 1 ? `${s.slice(0, room - 1)}…` : '';
      if (!s) break;
      ctx.font = font(px);
      ctx.fillStyle = c;
      ctx.fillText(s, x, y);
      this.ops += 2;
      this.texts++;
      x += s.length * a;
    }
    ctx.letterSpacing = '0px';
    return x;
  }

  // ---- paths ---------------------------------------------------------------------------
  begin_(): void { this.ctx.beginPath(); this.ops++; }
  fill(color: string): void { const c = this.ctx; c.fillStyle = color; c.fill(); this.ops += 2; }
  stroke(color: string, w = 1): void { const c = this.ctx; c.strokeStyle = color; c.lineWidth = w; c.stroke(); this.ops += 3; }
  move(x: number, y: number): void { this.ctx.moveTo(x, y); this.ops++; }
  line(x: number, y: number): void { this.ctx.lineTo(x, y); this.ops++; }
  /** A circle added to the current path. */
  circle(x: number, y: number, r: number): void {
    const c = this.ctx;
    c.moveTo(x + r, y);
    c.arc(x, y, r, 0, TAU);
    this.ops += 2;
    this.arcs++;
  }
  arc(x: number, y: number, r: number, a0: number, a1: number): void {
    const c = this.ctx;
    c.moveTo(x + Math.cos(a0) * r, y + Math.sin(a0) * r);
    c.arc(x, y, r, a0, a1);
    this.ops += 2;
    this.arcs++;
  }
  rrect(x: number, y: number, w: number, h: number, r: number): void {
    this.ctx.roundRect(x, y, w, h, r);
    this.ops += 6;
    this.arcs++;
  }
  rect(x: number, y: number, w: number, h: number): void {
    this.ctx.rect(x, y, w, h);
    this.ops += 6;
  }
  fillRect(x: number, y: number, w: number, h: number, color: string): void {
    const c = this.ctx;
    c.fillStyle = color;
    c.fillRect(x, y, w, h);
    this.ops += 2;
  }
  /** fillRect with the current fill style (batch of same-colour cells). */
  cell(x: number, y: number, w: number, h: number): void {
    this.ctx.fillRect(x, y, w, h);
    this.ops++;
  }
  setFill(color: string): void { this.ctx.fillStyle = color; this.ops++; }
  alpha(a: number): void { this.ctx.globalAlpha = a; this.ops++; }
  dash(on: boolean, a = 3, b = 2.5): void { this.ctx.setLineDash(on ? [a, b] : []); this.ops++; }
  clear(x: number, y: number, w: number, h: number): void { this.ctx.clearRect(x, y, w, h); this.ops++; }

  /** A crisp horizontal line, `w` yard px wide (default: one device pixel). */
  hline(x0: number, x1: number, y: number, color: string, w = this.hair): void {
    const yy = this.crisp(y, w);
    this.begin_(); this.move(x0, yy); this.line(x1, yy); this.stroke(color, w);
  }
  vline(x: number, y0: number, y1: number, color: string, w = this.hair): void {
    const xx = this.crisp(x, w);
    this.begin_(); this.move(xx, y0); this.line(xx, y1); this.stroke(color, w);
  }
}

/** A machine's outline: rounded box, dark fill, 1px edge (the inspiration's rounded machines). */
export function machine(g: Gfx, x: number, y: number, w: number, h: number, r: number, edge: string = C.machine, lowDetail = false, dashed = false): void {
  g.begin_();
  if (lowDetail) g.rect(x, y, w, h); else g.rrect(x, y, w, h, r);
  g.fill(C.machineFill);
  if (dashed) g.dash(true, 3, 3);
  g.stroke(edge, 1);
  if (dashed) g.dash(false);
}

/** A port tab on a machine's edge: a small dark bar with a lit slit (inspiration). */
export function port(g: Gfx, cx: number, cy: number, h: number, lowDetail = false): void {
  const w = Math.max(3, h * 0.3);
  g.begin_();
  if (lowDetail) g.rect(cx - w / 2, cy - h / 2, w, h); else g.rrect(cx - w / 2, cy - h / 2, w, h, w / 2);
  g.fill(C.port);
  g.stroke(C.portEdge, 1);
}

/** A dashed step chip; returns its width. */
export function chip(g: Gfx, label: string, x: number, y: number, state: 'idle' | 'active' | 'ok' | 'bad' | 'skip' | 'wait', px: number): number {
  const w = Math.ceil(g.width(label, px)) + Math.round(px * 1.1);
  const h = Math.round(px + 7);
  g.begin_();
  g.rrect(x, y - h / 2, w, h, 3);
  if (state === 'ok') g.fill(C.greenFill);
  else if (state === 'bad') g.fill(C.redFill);
  if (state !== 'active') g.dash(true, 3, 2.5);
  g.stroke(state === 'active' ? '#9A9A9C' : state === 'ok' ? C.greenEdge : state === 'bad' ? C.redEdge : C.chipEdge, 1);
  if (state !== 'active') g.dash(false);
  const ink = state === 'active' ? C.ink : state === 'ok' ? C.greenInk : state === 'bad' ? C.redText : state === 'wait' ? C.amberText : state === 'skip' ? C.ink3 : C.chipInk;
  g.text(label, x + Math.round(px * 0.55), y + px * 0.36, ink, px);
  return w;
}

/** A dashed connector with an arrowhead, between chips. */
export function arrow(g: Gfx, x0: number, x1: number, y: number, color: string = C.ink4): void {
  g.begin_();
  g.dash(true, 2.5, 2.5);
  g.move(x0, y); g.line(x1 - 3.5, y);
  g.stroke(color, 1);
  g.dash(false);
  g.begin_();
  g.move(x1 - 3.5, y - 2.5); g.line(x1, y); g.line(x1 - 3.5, y + 2.5);
  g.stroke(color, 1);
}

/** Cached small strings: `×12`, numbers. No string is built per frame for a badge. */
const timesCache: string[] = [];
export function times(n: number): string {
  if (n < 0 || n > 99999) return `×${n}`;
  let s = timesCache[n];
  if (s === undefined) { s = `×${n}`; timesCache[n] = s; }
  return s;
}
