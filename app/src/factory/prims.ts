// The floor's shared drawing primitives (fab-w0): the palette, the type sizes, the projected
// shapes every layer paints with (a polygon, a quad on the floor, an extruded box, a crate, a
// selection ring, a batch of lights) and a few small helpers for words and time. Each takes the
// camera; the Factory's own `box`/`quad`/`poly`/`crate` (the lens system's) call these.

import type { Pipeline } from '../wire.ts';
import type { Gfx } from '../yard/gfx.ts';
import { C, TAU } from '../yard/theme.ts';
import type { BoxBatch } from './batch.ts';
import type { Cam } from './iso.ts';

// ---- palette (canvas-only shades of the app's ramp) ------------------------------------------
export const F = {
  floor: '#0C0C0D',
  floorEdge: '#1E1E20',
  grid: '#141416',
  gridMajor: '#19191B',
  zone: '#232326',
  top: '#222224',
  topHi: '#29292C',
  side: '#18181A',
  front: '#141416',
  edge: '#3A3A3E',
  edgeHi: '#4E4E53',
  belt: '#121214',
  beltEdge: '#2B2B2F',
  slat: '#2A2A2E',
  slatHot: '#2E2C28',
  rail: '#3A3A3E',
  sleeper: '#1D1D20',
  bay: '#0F0F10',
  bayLit: '#2A2216',
  crateTop: '#E5B567',
  crateFront: '#B48C4E',
  crateSide: '#8E6E3E',
  dockTop: '#8A7146',
  dockFront: '#6B5838',
  dockSide: '#56472E',
  redTop: '#E06464',
  redFront: '#B04848',
  redSide: '#8A3838',
  light: '#5A6E5F',
} as const;

export const MONO = 12;
export const SMALL = 12;
export const TITLE = 15;
export const HOUR_MS = 3_600_000;

// ---- geometry primitives ---------------------------------------------------------------------
/** A closed polygon through (u, v, z) triples. */
export function poly(cam: Cam, g: Gfx, pts: number[]): void {
  for (let i = 0; i < pts.length; i += 3) {
    const x = cam.x(pts[i], pts[i + 1]), y = cam.y(pts[i], pts[i + 1], pts[i + 2]);
    if (i === 0) g.move(x, y); else g.line(x, y);
  }
  g.ctx.closePath();
}

/** A flat quad (u0..u1, v0..v1) at height z. */
export function quad(cam: Cam, g: Gfx, u0: number, v0: number, u1: number, v1: number, z = 0): void {
  poly(cam, g, [u0, v0, z, u1, v0, z, u1, v1, z, u0, v1, z]);
}

/** An extruded block: the faces the camera sees (front +v, right +u, top), dark, tone-shaded. */
export function box(cam: Cam, g: Gfx, u0: number, v0: number, du: number, dv: number, h: number, top: string = F.top, side: string = F.side, front: string = F.front, edge: string = F.edge, lw?: number): void {
  const u1 = u0 + du, v1 = v0 + dv;
  g.begin_(); poly(cam, g, [u0, v1, 0, u1, v1, 0, u1, v1, h, u0, v1, h]); g.fill(front);
  g.begin_(); poly(cam, g, [u1, v0, 0, u1, v1, 0, u1, v1, h, u1, v0, h]); g.fill(side);
  g.begin_(); poly(cam, g, [u0, v0, h, u1, v0, h, u1, v1, h, u0, v1, h]); g.fill(top);
  // edges: the silhouette and the two visible vertical corners
  const w = lw ?? g.hair * 1.5;
  g.begin_();
  g.move(cam.x(u0, v0), cam.y(u0, v0, h)); g.line(cam.x(u1, v0), cam.y(u1, v0, h)); g.line(cam.x(u1, v0), cam.y(u1, v0, 0));
  g.line(cam.x(u1, v1), cam.y(u1, v1, 0)); g.line(cam.x(u0, v1), cam.y(u0, v1, 0)); g.line(cam.x(u0, v1), cam.y(u0, v1, h)); g.ctx.closePath();
  g.move(cam.x(u0, v1), cam.y(u0, v1, h)); g.line(cam.x(u1, v1), cam.y(u1, v1, h)); g.line(cam.x(u1, v0), cam.y(u1, v0, h));
  g.move(cam.x(u1, v1), cam.y(u1, v1, h)); g.line(cam.x(u1, v1), cam.y(u1, v1, 0));
  g.stroke(edge, w);
}

/** A small crate (a cube) at floor point (u, v), side `d` world units. */
export function crate(cam: Cam, g: Gfx, u: number, v: number, d: number, red: boolean, dim: boolean, z = 2): void {
  const h = d * 0.8, u0 = u - d / 2, v0 = v - d / 2;
  const top = red ? F.redTop : dim ? F.dockTop : F.crateTop;
  const front = red ? F.redFront : dim ? F.dockFront : F.crateFront;
  const side = red ? F.redSide : dim ? F.dockSide : F.crateSide;
  const p = (uu: number, vv: number, zz: number) => { g.line(cam.x(uu, vv), cam.y(uu, vv, zz)); };
  g.begin_(); g.move(cam.x(u0, v0 + d), cam.y(u0, v0 + d, z)); p(u0 + d, v0 + d, z); p(u0 + d, v0 + d, z + h); p(u0, v0 + d, z + h); g.ctx.closePath(); g.fill(front);
  g.begin_(); g.move(cam.x(u0 + d, v0), cam.y(u0 + d, v0, z)); p(u0 + d, v0 + d, z); p(u0 + d, v0 + d, z + h); p(u0 + d, v0, z + h); g.ctx.closePath(); g.fill(side);
  g.begin_(); g.move(cam.x(u0, v0), cam.y(u0, v0, z + h)); p(u0 + d, v0, z + h); p(u0 + d, v0 + d, z + h); p(u0, v0 + d, z + h); g.ctx.closePath(); g.fill(top);
}

/** The selection's ring: an ellipse on the floor around (u, v) at height z. */
export function ring(cam: Cam, g: Gfx, u: number, v: number, r: number, z = 0): void {
  const x = cam.x(u, v), y = cam.y(u, v, z);
  g.begin_(); g.ctx.ellipse(x, y, r * cam.s + 4, (r * cam.s + 4) * 0.6, 0, 0, TAU); g.stroke(C.ink, 1.5);
}

/** Health lights collected in `b` (points in its u, v, z): round, or squares (cheaper). */
export function flushLights(cam: Cam, g: Gfx, b: BoxBatch, col: string, r: number, round: boolean): void {
  if (!b.n) return;
  const buf = (b as unknown as { buf: Float32Array }).buf;
  g.begin_();
  for (let i = 0; i < b.n; i++) {
    const o = i * 6, x = cam.x(buf[o], buf[o + 1]), y = cam.y(buf[o], buf[o + 1], buf[o + 5]);
    if (round) g.circle(x, y, r);
    else { g.ctx.rect(x - r / 2, y - r / 2, r, r); g.ops++; }
  }
  g.fill(col);
  b.n = 0;
}

/** Is the floor box (u0..u1, v0..v1, 0..h) on screen? (its projected corners' bounds, padded) */
export function onScreen(cam: Cam, u0: number, v0: number, u1: number, v1: number, h = 0, pad = 24): boolean {
  const xa = cam.x(u0, v1), xb = cam.x(u1, v0);
  if (Math.max(xa, xb) < -pad || Math.min(xa, xb) > cam.W + pad) return false;
  const ya = cam.y(u0, v0, h), yb = cam.y(u1, v1, 0);
  return !(Math.max(ya, yb) < -pad || Math.min(ya, yb) > cam.H + pad);
}

// ---- words and time --------------------------------------------------------------------------
export function dur(ms: number): string {
  if (!(ms > 0)) return '0s';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`.replace(/ 0s$/, '');
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ${m % 60}m`.replace(/ 0m$/, '');
  return `${Math.floor(h / 24)}d`;
}

export function clockWords(at: number, offsetMin: number): string {
  const d = new Date(at + offsetMin * 60_000);
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}:${String(d.getUTCSeconds()).padStart(2, '0')}`;
}

export function easeInOut(u: number): number { return u <= 0 ? 0 : u >= 1 ? 1 : u < 0.5 ? 2 * u * u : 1 - Math.pow(-2 * u + 2, 2) / 2; }

export function hash(s: string): number { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return Math.abs(h); }

/** The step a run is on now ('' when none reports running). */
export function runningStep(p: Pipeline): string {
  for (const wf of p.workflows ?? []) for (const s of wf.steps ?? []) if (s.state === 'running') return s.name;
  return '';
}

/** A run's short name: `repo #n`. */
export function pipeWords(p: Pipeline | undefined): string {
  if (!p) return '';
  return `${p.repo.split('/')[1]} #${p.number}`;
}

