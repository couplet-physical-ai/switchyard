// Small drawing helpers shared by the yard's layers and the views' canvases.

import type { Ctx2D } from '../../app.contract.d.ts';
import type { CiState, Dot } from '../wire.ts';
import { C, TAU, font } from './theme.ts';

export function machine(ctx: Ctx2D, x: number, y: number, w: number, h: number, r = 10, edge: string = C.machine): void {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
  ctx.fillStyle = C.machineFill;
  ctx.fill();
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = edge;
  ctx.stroke();
}

/** A port tab on a machine's edge (the inspiration's small dark bars). */
export function port(ctx: Ctx2D, cx: number, cy: number, lit = 0): void {
  const w = 7, h = 26;
  ctx.beginPath();
  ctx.roundRect(cx - w / 2, cy - h / 2, w, h, 2.5);
  ctx.fillStyle = C.port;
  ctx.fill();
  ctx.lineWidth = 1.2;
  ctx.strokeStyle = C.portEdge;
  ctx.stroke();
  ctx.beginPath();
  ctx.roundRect(cx - 1, cy - h / 2 + 5, 2, h - 10, 1);
  ctx.fillStyle = lit > 0 ? withAlpha(C.packet, 0.35 + 0.65 * lit) : '#2E2E30';
  ctx.fill();
}

export function text(ctx: Ctx2D, s: string, x: number, y: number, color: string, px = 13, bold = false, align: CanvasTextAlign = 'left'): number {
  ctx.font = font(px, bold);
  ctx.textAlign = align;
  ctx.fillStyle = color;
  ctx.fillText(s, x, y);
  return ctx.measureText(s).width;
}

/** Runs of text in one line, each its own colour: [[text, colour, bold?], …]. Returns the end x. */
export function runs(ctx: Ctx2D, parts: [string, string, boolean?][], x: number, y: number, px = 13): number {
  ctx.textAlign = 'left';
  for (const [s, color, bold] of parts) {
    ctx.font = font(px, !!bold);
    ctx.fillStyle = color;
    ctx.fillText(s, x, y);
    x += ctx.measureText(s).width;
  }
  return x;
}

export function eyebrow(ctx: Ctx2D, parts: [string, string][], x: number, y: number): number {
  ctx.letterSpacing = '1px';
  const end = runs(ctx, parts.map(([s, c]) => [s.toUpperCase(), c] as [string, string]), x, y, 12);
  ctx.letterSpacing = '0px';
  return end;
}

export function withAlpha(hex: string, a: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${Math.max(0, Math.min(1, a)).toFixed(3)})`;
}

/** A dashed step chip; returns its width. */
export function chip(ctx: Ctx2D, label: string, x: number, y: number, state: 'idle' | 'active' | 'ok' | 'bad' | 'skip', px = 11): number {
  ctx.font = font(px);
  const w = Math.ceil(ctx.measureText(label).width) + 14;
  const h = px + 9;
  ctx.beginPath();
  ctx.roundRect(x, y - h / 2, w, h, 3);
  if (state === 'ok') { ctx.fillStyle = C.greenFill; ctx.fill(); }
  else if (state === 'bad') { ctx.fillStyle = C.redFill; ctx.fill(); }
  ctx.setLineDash(state === 'active' ? [] : [3, 2.5]);
  ctx.lineWidth = 1;
  ctx.strokeStyle = state === 'active' ? '#8E8E90' : state === 'ok' ? C.greenEdge : state === 'bad' ? C.redEdge : C.chipEdge;
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.textAlign = 'left';
  ctx.fillStyle = state === 'active' ? C.ink : state === 'ok' ? C.greenInk : state === 'bad' ? C.redText : state === 'skip' ? C.ink4 : C.chipInk;
  ctx.fillText(label, x + 7, y + px * 0.36);
  return w;
}

/** A dashed connector with an arrowhead, between chips. */
export function arrow(ctx: Ctx2D, x0: number, x1: number, y: number, color: string = C.ink4): void {
  ctx.beginPath();
  ctx.setLineDash([2.5, 2.5]);
  ctx.moveTo(x0, y);
  ctx.lineTo(x1 - 4, y);
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.beginPath();
  ctx.moveTo(x1 - 4, y - 3);
  ctx.lineTo(x1, y);
  ctx.lineTo(x1 - 4, y + 3);
  ctx.stroke();
}

export function dotColor(s: CiState): string {
  switch (s) {
    case 'failure': case 'error': return C.red;
    case 'running': return C.ink;
    case 'pending': case 'blocked': return C.ink3;
    case 'skipped': case 'canceled': case 'none': return C.dotDim;
    default: return C.dot;
  }
}

/**
 * A main line: dots newest right, an end cap, the culprit labelled. `x1` is the rightmost dot.
 * Returns the x of the leftmost dot drawn.
 */
export function dotLine(ctx: Ctx2D, dots: Dot[], x0: number, x1: number, y: number, step: number, t: number, opts: { red?: boolean; culprit?: string | null; r?: number; cap?: boolean; label?: boolean } = {}): number {
  const r = opts.r ?? 4.5;
  const n = Math.max(1, Math.floor((x1 - x0) / step) + 1);
  const list = (Array.isArray(dots) ? dots : []).filter((d) => d && typeof d === 'object').slice(-n);
  const left = x1 - (list.length - 1) * step;
  // the rail
  ctx.beginPath();
  ctx.moveTo(x0, y);
  ctx.lineTo(x1 + 18, y);
  ctx.lineWidth = 1;
  ctx.strokeStyle = C.wire;
  ctx.stroke();
  const ci = opts.culprit ? list.findIndex((d) => d.sha === opts.culprit) : -1;
  if (opts.red && ci >= 0) {
    ctx.beginPath();
    ctx.moveTo(x1 - (list.length - 1 - ci) * step, y);
    ctx.lineTo(x1 + 18, y);
    ctx.strokeStyle = withAlpha(C.red, 0.55);
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }
  if (opts.cap !== false) {
    ctx.beginPath();
    ctx.roundRect(x1 + 16, y - 11, 6, 22, 2.5);
    ctx.fillStyle = C.port;
    ctx.fill();
    ctx.strokeStyle = C.portEdge;
    ctx.lineWidth = 1.2;
    ctx.stroke();
  }
  // batch by colour
  const byColor = new Map<string, number[]>();
  const rings: number[] = [];
  for (let i = 0; i < list.length; i++) {
    const d = list[i];
    const x = x1 - (list.length - 1 - i) * step;
    if (d.state === 'running' || d.state === 'pending') rings.push(x);
    const c = dotColor(d.state);
    let a = byColor.get(c);
    if (!a) byColor.set(c, (a = []));
    a.push(x);
  }
  for (const [c, xs] of byColor) {
    ctx.beginPath();
    for (const x of xs) {
      const rr = c === C.dotDim ? r * 0.75 : r;
      ctx.moveTo(x + rr, y);
      ctx.arc(x, y, rr, 0, TAU);
    }
    ctx.fillStyle = c;
    ctx.fill();
  }
  if (rings.length) {
    ctx.beginPath();
    for (const x of rings) { ctx.moveTo(x + r + 3, y); ctx.arc(x, y, r + 3, 0, TAU); }
    ctx.strokeStyle = C.packet;
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }
  // deployed marks
  ctx.beginPath();
  let anyDeployed = false;
  for (let i = 0; i < list.length; i++) {
    if (!list[i].deployed) continue;
    const x = x1 - (list.length - 1 - i) * step;
    ctx.moveTo(x - 2, y + r + 4);
    ctx.lineTo(x + 2, y + r + 4);
    anyDeployed = true;
  }
  if (anyDeployed) { ctx.strokeStyle = C.packetDim; ctx.lineWidth = 1.5; ctx.stroke(); }
  if (ci >= 0) {
    const x = x1 - (list.length - 1 - ci) * step;
    ctx.beginPath(); ctx.arc(x, y, r + 2.5, 0, TAU); ctx.strokeStyle = withAlpha(C.red, 0.6); ctx.lineWidth = 1.2; ctx.stroke();
    if (opts.label !== false) text(ctx, 'culprit', x, y - r - 7, C.redText, 10, false, 'center');
  }
  return left;
}

export function fmtDur(ms: number): string {
  if (!isFinite(ms) || ms < 0) return '–';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return s % 60 && m < 10 ? `${m}m ${s % 60}s` : `${m}m`;
  const h = Math.floor(m / 60);
  if (h >= 48) return `${Math.round(h / 24)} days`;
  return m % 60 && h < 10 ? `${h}h ${m % 60}m` : `${h}h`;
}

export function fmtClock(ms: number, offsetMin: number): string {
  const d = new Date(ms + offsetMin * 60_000);
  const h = d.getUTCHours(), mi = d.getUTCMinutes();
  return `${h < 10 ? '0' : ''}${h}:${mi < 10 ? '0' : ''}${mi}`;
}
