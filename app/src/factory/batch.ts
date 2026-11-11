// Batched drawing for the factory floor (DESIGN.md "Factory", "Rendering"). A canvas call is a
// host round trip on native (the recorder), so the floor never paints a box as its own three
// paths: boxes of one colour class are collected into a preallocated buffer and flushed as one
// path per visible face (front, right side, top) plus one for their edges. Boxes in one batch
// must not overlap on screen (cars on a rail, bays in a machine, crates of one class, blocks in
// one row of the city); the caller orders batches far to near.
//
// TrainTable merges crates that ride the same stretch of the same route into one crate with a
// ×N badge (the quality ladder's "trains"), with no allocation per frame.

import type { Gfx } from '../yard/gfx.ts';
import type { Cam } from './iso.ts';

/** Faces to draw: 3 = front, side, top; 2 = front+side as one silhouette, top; 1 = top only. */
export type Faces = 1 | 2 | 3;

export class BoxBatch {
  private buf = new Float32Array(6 * 256);
  n = 0;

  /** A box at floor (u0, v0), du × dv, h high, standing at height z. */
  add(u0: number, v0: number, du: number, dv: number, h: number, z = 0): void {
    if ((this.n + 1) * 6 > this.buf.length) {
      const b = new Float32Array(this.buf.length * 2);
      b.set(this.buf);
      this.buf = b;
    }
    const o = this.n * 6, b = this.buf;
    b[o] = u0; b[o + 1] = v0; b[o + 2] = du; b[o + 3] = dv; b[o + 4] = h; b[o + 5] = z;
    this.n++;
  }

  /** A crate (a cube `d` wide, 0.8 d high) centred on floor point (u, v), resting at z. */
  crate(u: number, v: number, d: number, z = 2): void {
    this.add(u - d / 2, v - d / 2, d, d, d * 0.8, z);
  }

  /** Paints every box and empties the batch. `edge` empty: no outline. */
  flush(g: Gfx, cam: Cam, top: string, side: string, front: string, edge = '', ew = 1, faces: Faces = 3): void {
    const n = this.n;
    if (!n) return;
    const b = this.buf;
    const ctx = g.ctx;
    const X = (u: number, v: number) => cam.x(u, v);
    const Y = (u: number, v: number, z: number) => cam.y(u, v, z);
    if (faces === 3) {
      g.begin_();
      for (let i = 0; i < n; i++) {
        const o = i * 6, u0 = b[o], v1 = b[o + 1] + b[o + 3], u1 = u0 + b[o + 2], z0 = b[o + 5], z1 = z0 + b[o + 4];
        ctx.moveTo(X(u0, v1), Y(u0, v1, z0)); ctx.lineTo(X(u1, v1), Y(u1, v1, z0)); ctx.lineTo(X(u1, v1), Y(u1, v1, z1)); ctx.lineTo(X(u0, v1), Y(u0, v1, z1)); ctx.closePath();
      }
      g.ops += n * 5;
      g.fill(front);
      g.begin_();
      for (let i = 0; i < n; i++) {
        const o = i * 6, v0 = b[o + 1], v1 = v0 + b[o + 3], u1 = b[o] + b[o + 2], z0 = b[o + 5], z1 = z0 + b[o + 4];
        ctx.moveTo(X(u1, v0), Y(u1, v0, z0)); ctx.lineTo(X(u1, v1), Y(u1, v1, z0)); ctx.lineTo(X(u1, v1), Y(u1, v1, z1)); ctx.lineTo(X(u1, v0), Y(u1, v0, z1)); ctx.closePath();
      }
      g.ops += n * 5;
      g.fill(side);
    } else if (faces === 2) {
      // the silhouette (front and side as one), the top over it
      g.begin_();
      for (let i = 0; i < n; i++) {
        const o = i * 6, u0 = b[o], v0 = b[o + 1], u1 = u0 + b[o + 2], v1 = v0 + b[o + 3], z0 = b[o + 5], z1 = z0 + b[o + 4];
        ctx.moveTo(X(u0, v1), Y(u0, v1, z0)); ctx.lineTo(X(u1, v1), Y(u1, v1, z0)); ctx.lineTo(X(u1, v0), Y(u1, v0, z0));
        ctx.lineTo(X(u1, v0), Y(u1, v0, z1)); ctx.lineTo(X(u0, v1), Y(u0, v1, z1)); ctx.closePath();
      }
      g.ops += n * 6;
      g.fill(side);
    }
    g.begin_();
    for (let i = 0; i < n; i++) {
      const o = i * 6, u0 = b[o], v0 = b[o + 1], u1 = u0 + b[o + 2], v1 = v0 + b[o + 3], z1 = b[o + 5] + b[o + 4];
      ctx.moveTo(X(u0, v0), Y(u0, v0, z1)); ctx.lineTo(X(u1, v0), Y(u1, v0, z1)); ctx.lineTo(X(u1, v1), Y(u1, v1, z1)); ctx.lineTo(X(u0, v1), Y(u0, v1, z1)); ctx.closePath();
    }
    g.ops += n * 5;
    g.fill(top);
    if (edge && faces === 3) {
      g.begin_();
      for (let i = 0; i < n; i++) {
        const o = i * 6, u0 = b[o], v0 = b[o + 1], u1 = u0 + b[o + 2], v1 = v0 + b[o + 3], z0 = b[o + 5], z1 = z0 + b[o + 4];
        // the silhouette, the top's front and right edges, the front-right vertical corner
        ctx.moveTo(X(u0, v0), Y(u0, v0, z1)); ctx.lineTo(X(u1, v0), Y(u1, v0, z1)); ctx.lineTo(X(u1, v0), Y(u1, v0, z0));
        ctx.lineTo(X(u1, v1), Y(u1, v1, z0)); ctx.lineTo(X(u0, v1), Y(u0, v1, z0)); ctx.lineTo(X(u0, v1), Y(u0, v1, z1)); ctx.closePath();
        ctx.moveTo(X(u0, v1), Y(u0, v1, z1)); ctx.lineTo(X(u1, v1), Y(u1, v1, z1)); ctx.lineTo(X(u1, v0), Y(u1, v0, z1));
        ctx.moveTo(X(u1, v1), Y(u1, v1, z1)); ctx.lineTo(X(u1, v1), Y(u1, v1, z0));
      }
      g.ops += n * 12;
      g.stroke(edge, ew);
    }
    this.n = 0;
  }

  /** Flat quads on the floor plane at height z (a lit bay, a progress bar): one path, one fill. */
  flushQuads(g: Gfx, cam: Cam, color: string, stroke = false, w = 1): void {
    const n = this.n;
    if (!n) return;
    const b = this.buf, ctx = g.ctx;
    g.begin_();
    for (let i = 0; i < n; i++) {
      const o = i * 6, u0 = b[o], v0 = b[o + 1], u1 = u0 + b[o + 2], v1 = v0 + b[o + 3], z = b[o + 5];
      ctx.moveTo(cam.x(u0, v0), cam.y(u0, v0, z)); ctx.lineTo(cam.x(u1, v0), cam.y(u1, v0, z)); ctx.lineTo(cam.x(u1, v1), cam.y(u1, v1, z)); ctx.lineTo(cam.x(u0, v1), cam.y(u0, v1, z)); ctx.closePath();
    }
    g.ops += n * 5;
    if (stroke) g.stroke(color, w); else g.fill(color);
    this.n = 0;
  }
}

const SLOTS = 1024;

/** Crates merged into trains: one slot per (route, stretch) key, open addressing, reused. */
export class TrainTable {
  readonly key = new Int32Array(SLOTS);
  readonly gen = new Int32Array(SLOTS);
  readonly count = new Int32Array(SLOTS);
  readonly u = new Float32Array(SLOTS);
  readonly v = new Float32Array(SLOTS);
  readonly red = new Uint8Array(SLOTS);
  readonly used = new Int32Array(SLOTS);
  nUsed = 0;
  private g = 1;

  reset(): void { this.g++; this.nUsed = 0; }

  /** Counts a crate at (u, v) into the train `k` (≥ 0); the first one in leads it. False when full. */
  add(k: number, u: number, v: number, red: boolean): boolean {
    let h = (Math.imul(k, 0x9e3779b1) >>> 0) % SLOTS;
    for (let probe = 0; probe < SLOTS; probe++) {
      if (this.gen[h] !== this.g) {
        if (this.nUsed >= SLOTS * 0.75) return false;
        this.gen[h] = this.g; this.key[h] = k; this.count[h] = 1; this.u[h] = u; this.v[h] = v; this.red[h] = red ? 1 : 0;
        this.used[this.nUsed++] = h;
        return true;
      }
      if (this.key[h] === k) { this.count[h]++; if (red) this.red[h] = 1; return true; }
      h = (h + 1) % SLOTS;
    }
    return false;
  }
}
