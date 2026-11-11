// The Factory's fixed camera and shapes (ZERO.md "FACTORY REDO"): one isometric view of the
// whole floor, fitted to the window (no pan, no zoom, no scroll), refitted when the window
// changes. u runs along the flow (left → right), v in depth (back → front), z up; the same
// trimetric angle as the old floor. Words are drawn in screen space at projected anchors.

import type { Gfx } from '../yard/gfx.ts';

// a gentler angle than the old floor's (0.86/0.19, -0.36/0.66): the flow runs nearly level
// across the window, so a long line of stations fills it
export const UX = 0.86, UY = 0.22;
export const VX = -0.40, VY = 0.72;

export class Cam {
  s = 1; ox = 0; oy = 0; W = 1440; H = 900;
  /** Changes whenever the transform does (the static layer redraws on it). */
  key = '';

  /** Fit the floor's box (u0..u1, v0..v1, up to height zMax) into the rectangle (x, y, w, h). */
  fit(W: number, H: number, u0: number, v0: number, u1: number, v1: number, zMax: number, x: number, y: number, w: number, h: number): void {
    const xs = [u0 * UX + v0 * VX, u1 * UX + v0 * VX, u0 * UX + v1 * VX, u1 * UX + v1 * VX];
    const ys = [u0 * UY + v0 * VY - zMax, u1 * UY + v0 * VY - zMax, u0 * UY + v1 * VY, u1 * UY + v1 * VY];
    const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
    const s = Math.min(w / (maxX - minX), h / (maxY - minY));
    this.W = W; this.H = H; this.s = s;
    this.ox = x + (w - (maxX - minX) * s) / 2 - minX * s;
    this.oy = y + (h - (maxY - minY) * s) / 2 - minY * s;
    this.key = `${W}x${H}:${s.toFixed(4)}:${this.ox.toFixed(1)}:${this.oy.toFixed(1)}`;
  }
  x(u: number, v: number): number { return this.ox + this.s * (u * UX + v * VX); }
  y(u: number, v: number, z = 0): number { return this.oy + this.s * (u * UY + v * VY - z); }
}

export const P = {
  floor: '#0C0C0D',
  floorEdge: '#1E1E20',
  grid: '#131315',
  top: '#222224',
  topHi: '#29292C',
  side: '#18181A',
  front: '#141416',
  edge: '#3A3A3E',
  belt: '#111113',
  beltEdge: '#2B2B2F',
  slat: '#232327',
  well: '#0D0D0E',
  crateTop: '#E5B567', crateFront: '#B48C4E', crateSide: '#8E6E3E',
  waitTop: '#8A7146', waitFront: '#6B5838', waitSide: '#56472E',
  redTop: '#E06464', redFront: '#B04848', redSide: '#8A3838',
  okTop: '#5A6E5F', okFront: '#465649', okSide: '#3A473D',
  greyTop: '#3A3A3E', greyFront: '#2C2C30', greySide: '#242427',
} as const;

export function poly(cam: Cam, g: Gfx, pts: number[]): void {
  for (let i = 0; i < pts.length; i += 3) {
    const x = cam.x(pts[i], pts[i + 1]), y = cam.y(pts[i], pts[i + 1], pts[i + 2]);
    if (i === 0) g.move(x, y); else g.line(x, y);
  }
  g.ctx.closePath();
}

export function quad(cam: Cam, g: Gfx, u0: number, v0: number, u1: number, v1: number, z = 0): void {
  poly(cam, g, [u0, v0, z, u1, v0, z, u1, v1, z, u0, v1, z]);
}

/** An extruded block, the three faces the camera sees, with a hairline silhouette. */
export function box(cam: Cam, g: Gfx, u0: number, v0: number, du: number, dv: number, h: number, z = 0,
  top: string = P.top, side: string = P.side, front: string = P.front, edge: string | null = P.edge): void {
  const u1 = u0 + du, v1 = v0 + dv, z1 = z + h;
  g.begin_(); poly(cam, g, [u0, v1, z, u1, v1, z, u1, v1, z1, u0, v1, z1]); g.fill(front);
  g.begin_(); poly(cam, g, [u1, v0, z, u1, v1, z, u1, v1, z1, u1, v0, z1]); g.fill(side);
  g.begin_(); poly(cam, g, [u0, v0, z1, u1, v0, z1, u1, v1, z1, u0, v1, z1]); g.fill(top);
  if (!edge) return;
  g.begin_();
  g.move(cam.x(u0, v0), cam.y(u0, v0, z1)); g.line(cam.x(u1, v0), cam.y(u1, v0, z1)); g.line(cam.x(u1, v0), cam.y(u1, v0, z));
  g.line(cam.x(u1, v1), cam.y(u1, v1, z)); g.line(cam.x(u0, v1), cam.y(u0, v1, z)); g.line(cam.x(u0, v1), cam.y(u0, v1, z1)); g.ctx.closePath();
  g.move(cam.x(u0, v1), cam.y(u0, v1, z1)); g.line(cam.x(u1, v1), cam.y(u1, v1, z1)); g.line(cam.x(u1, v0), cam.y(u1, v0, z1));
  g.move(cam.x(u1, v1), cam.y(u1, v1, z1)); g.line(cam.x(u1, v1), cam.y(u1, v1, z));
  g.stroke(edge, 1);
}

export type Tone = 'run' | 'wait' | 'fail' | 'ok' | 'grey';
const TONES: Record<Tone, [string, string, string]> = {
  run: [P.crateTop, P.crateFront, P.crateSide],
  wait: [P.waitTop, P.waitFront, P.waitSide],
  fail: [P.redTop, P.redFront, P.redSide],
  ok: [P.okTop, P.okFront, P.okSide],
  grey: [P.greyTop, P.greyFront, P.greySide],
};

/** A crate (a work item): a cube of side d centred on (u, v), resting at height z. */
export function crate(cam: Cam, g: Gfx, u: number, v: number, d: number, tone: Tone, z = 0, hMul = 0.8): void {
  const [t, f, s] = TONES[tone];
  box(cam, g, u - d / 2, v - d / 2, d, d, d * hMul, z, t, s, f, null);
}
