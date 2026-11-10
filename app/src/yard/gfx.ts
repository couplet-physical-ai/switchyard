// The yard's drawing surface: a thin wrapper over the canvas context that counts what a draw
// costs (budget.ts turns the counts into milliseconds) and measures text without asking the
// host. Commit Mono is monospaced, so a string's width is its length times the advance of
// its size: measured once per (size, weight) and kept, which makes fitting, truncating and
// centring labels free (a host measure is a JSON round trip on native; DESIGN.md "Rendering").

import type { Ctx2D } from '../../app.contract.d.ts';
import { C, TAU, font } from './theme.ts';

export type Align = 'left' | 'center' | 'right';

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

  /** The advance of one glyph at `px` (monospace). */
  advance(px: number, bold = false): number {
    const key = bold ? -px : px;
    let a = this.adv.get(key);
    if (a === undefined) {
      this.ctx.font = font(px, bold);
      a = this.ctx.measureText('0000000000').width / 10;
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

  /** Runs of text on one line, each its own colour; returns the end x. Cut to `maxW`. */
  runs(parts: readonly (readonly [string, string, boolean?])[], x: number, y: number, px: number, maxW = 1e9): number {
    const ctx = this.ctx;
    ctx.textAlign = 'left';
    const x0 = x;
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i];
      const bold = !!p[2];
      let s = p[0];
      if (!s) continue;
      const room = maxW - (x - x0);
      if (room <= 0) break;
      const w = this.width(s, px, bold);
      if (w > room) s = this.fit(s, px, room, bold);
      if (!s) break;
      ctx.font = font(px, bold);
      ctx.fillStyle = p[1];
      ctx.fillText(s, x, y);
      this.ops += 2;
      this.texts++;
      x += this.width(s, px, bold);
    }
    return x;
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
