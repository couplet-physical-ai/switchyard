// The factory floor's projection and camera (DESIGN.md "Factory"). The floor is a world plane
// (u along the flow, left → right; v in depth, back → front; z up) seen from the front-right
// corner, a gentle trimetric view: u runs to the right and a little down, v runs down-left,
// z straight up. Every text is drawn in screen space at a projected anchor, never through the
// projection, so words are never skewed.

export const UX = 0.86, UY = 0.19;
export const VX = -0.36, VY = 0.66;
export const ZK = 1;

/** World extent of the floor. */
export const LU = 1500;
export const LV = 640;

export class Cam {
  /** Screen px per world unit at zoom 1 (fit), and the fitted origin. */
  fitS = 1;
  fitX = 0;
  fitY = 0;
  /** The person's zoom and pan (screen px) over the fit. */
  zoom = 1;
  panX = 0;
  panY = 0;
  /** Effective transform (recomputed by `apply`). */
  s = 1;
  ox = 0;
  oy = 0;
  W = 1440;
  H = 840;
  /** Bumps whenever the transform changed (the static floor redraws on it). */
  ver = 0;
  // a flight: the camera eases to a target
  private fly: { t0: number; dur: number; z0: number; x0: number; y0: number; z1: number; x1: number; y1: number } | null = null;

  fit(W: number, H: number, top: number, bottom: number): void {
    if (W === this.W && H === this.H && this.fitS !== 1) return;
    this.W = W; this.H = H;
    const minX = LV * VX, maxX = LU * UX, minY = -64, maxY = LU * UY + LV * VY;
    const availW = W - 150, availH = H - top - bottom;
    const s = Math.min(availW / (maxX - minX), availH / (maxY - minY));
    this.fitS = s;
    this.fitX = 110 + (availW - (maxX - minX) * s) / 2 - minX * s;
    this.fitY = top + (availH - (maxY - minY) * s) / 2 - minY * s;
    this.apply();
  }

  apply(): void {
    const s = this.fitS * this.zoom;
    // zoom about the screen centre of the fit, then pan
    const cx = this.W / 2, cy = this.H / 2;
    this.s = s;
    this.ox = cx + (this.fitX - cx) * this.zoom + this.panX;
    this.oy = cy + (this.fitY - cy) * this.zoom + this.panY;
    this.ver++;
  }

  x(u: number, v: number): number { return this.ox + this.s * (u * UX + v * VX); }
  y(u: number, v: number, z = 0): number { return this.oy + this.s * (u * UY + v * VY - z * ZK); }

  /** Screen → floor (z = 0). */
  unproject(sx: number, sy: number): [number, number] {
    const a = (sx - this.ox) / this.s, b = (sy - this.oy) / this.s;
    const det = UX * VY - VX * UY;
    return [(a * VY - b * VX) / det, (b * UX - a * UY) / det];
  }

  /** Zoom by `f` about the screen point (sx, sy). */
  zoomAt(f: number, sx: number, sy: number): void {
    this.fly = null;
    const z1 = Math.min(6, Math.max(0.6, this.zoom * f));
    const [u, v] = this.unproject(sx, sy);
    this.zoom = z1;
    this.apply();
    // keep the floor point under the pointer
    this.panX += sx - this.x(u, v);
    this.panY += sy - this.y(u, v);
    this.apply();
  }

  pan(dx: number, dy: number): void {
    this.fly = null;
    this.panX += dx; this.panY += dy;
    this.apply();
  }

  reset(t: number): void { this.flyTo(1, 0, 0, t); }

  /** Fly so that floor point (u, v) sits at the screen centre at zoom z. */
  flyToPoint(u: number, v: number, z: number, t: number): void {
    const save = { zoom: this.zoom, panX: this.panX, panY: this.panY };
    this.zoom = z; this.panX = 0; this.panY = 0; this.apply();
    const px = this.W / 2 - this.x(u, v), py = this.H / 2 - this.y(u, v);
    this.zoom = save.zoom; this.panX = save.panX; this.panY = save.panY; this.apply();
    this.flyTo(z, px, py, t);
  }

  flyTo(z: number, px: number, py: number, t: number): void {
    this.fly = { t0: t, dur: 900, z0: this.zoom, x0: this.panX, y0: this.panY, z1: z, x1: px, y1: py };
  }

  /** Advances a flight; true while flying. */
  step(t: number): boolean {
    const f = this.fly;
    if (!f) return false;
    const u = Math.min(1, Math.max(0, (t - f.t0) / f.dur));
    const e = u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2;
    this.zoom = f.z0 + (f.z1 - f.z0) * e;
    this.panX = f.x0 + (f.x1 - f.x0) * e;
    this.panY = f.y0 + (f.y1 - f.y0) * e;
    this.apply();
    if (u >= 1) this.fly = null;
    return true;
  }

  get key(): string { return `${this.W}x${this.H}:${this.zoom.toFixed(3)}:${Math.round(this.panX)}:${Math.round(this.panY)}`; }
}
