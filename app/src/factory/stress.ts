// Stress mode on the factory floor (DESIGN.md "Factory", "Stress"): a 10× fleet for the RENDERER
// only, as the yard's (src/yard/stress.ts). The data module's 64 MiB heap holds one real fleet,
// never ten, so nothing here is an entity:
//   - the census's counts are multiplied (pushes, PR stacks, pallets, flow, the queue);
//   - every engine host gets ten times its slots, each busy or idle by a hash of (slot, 3 s bucket);
//   - the city gets nine hashed copies of every app (2,370 blocks for 237 apps), health from a
//     hash with the real fleet's mix, kept in a Uint8Array;
//   - crates in flight are a pure function of (route, index, time): STRESS_CRATES of them on the
//     floor's real routes, positions computed per frame from typed arrays, never allocated.
// Turning it off drops the arrays.

import { FACTOR, hash, unit } from '../yard/stress.ts';

export { FACTOR, hash, unit };

/** Crates in flight at 10× (the yard's stress runs 10,000 packets on its wires). */
export const STRESS_CRATES = 3000;

/** A route crates ride: an axis-aligned polyline on the floor (world units). */
export type SRoute = { pts: Float32Array; cum: Float32Array; len: number; n: number; speed: number; red: boolean; first: number };

export class FactoryStress {
  on = false;
  routes: SRoute[] = [];
  total = 0;
  /** Health of the virtual app copies, by copy index: 0 up, 1 degraded, 2 down, 3 unknown. */
  health = new Uint8Array(0);
  private routesKey = '';

  /** (Re)builds the routes for this floor plan (`key` names it); `weights` share STRESS_CRATES. */
  setRoutes(key: string, list: [number, number][][], weights: number[], red: boolean[]): void {
    if (key === this.routesKey && this.routes.length) return;
    this.routesKey = key;
    let wsum = 0;
    for (const w of weights) wsum += w;
    this.routes = [];
    let first = 0;
    list.forEach((pts, r) => {
      const n = Math.max(1, Math.round((STRESS_CRATES * weights[r]) / Math.max(1e-9, wsum)));
      const P = new Float32Array(pts.length * 2);
      const cum = new Float32Array(pts.length);
      let len = 0;
      pts.forEach(([u, v], i) => {
        P[i * 2] = u; P[i * 2 + 1] = v;
        if (i) len += Math.hypot(u - pts[i - 1][0], v - pts[i - 1][1]);
        cum[i] = len;
      });
      // belts run at 30-60 units a second, the return conveyor slower
      const speed = red[r] ? 22 : 30 + (hash(r, 3) % 30);
      this.routes.push({ pts: P, cum, len, n, speed, red: red[r], first });
      first += n;
    });
    this.total = first;
  }

  /** Builds the virtual apps' health once for `n` copies (the real fleet's mix, hashed). */
  ensureHealth(n: number): void {
    if (this.health.length === n) return;
    this.health = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      const u = unit(i, 11);
      this.health[i] = u < 0.004 ? 2 : u < 0.012 ? 1 : u < 0.05 ? 3 : 0;
    }
  }

  clear(): void {
    this.routes = [];
    this.total = 0;
    this.routesKey = '';
    this.health = new Uint8Array(0);
  }

  /** Distance along route `r` of its crate `i` at time `t` (ms). */
  dist(r: SRoute, ri: number, i: number, t: number): number {
    const d = (t / 1000) * r.speed + r.len * unit(i, ri * 977 + 13);
    return d - Math.floor(d / r.len) * r.len;
  }

  /** The floor point at distance `d` along route `r`, into out[0..1]. */
  at(r: SRoute, d: number, out: Float32Array): void {
    const c = r.cum, p = r.pts;
    let i = 1;
    while (i < c.length - 1 && c[i] < d) i++;
    const seg = c[i] - c[i - 1] || 1;
    const k = Math.min(1, Math.max(0, (d - c[i - 1]) / seg));
    out[0] = p[(i - 1) * 2] + (p[i * 2] - p[(i - 1) * 2]) * k;
    out[1] = p[(i - 1) * 2 + 1] + (p[i * 2 + 1] - p[(i - 1) * 2 + 1]) * k;
  }

  /** Whether virtual slot `s` of host `g` is busy at `t` (changes every ~3 s, ~55 % busy). */
  busy(g: number, s: number, t: number): boolean {
    return unit(g * 257 + s, Math.floor(t / 3000) + g) < 0.55;
  }

  /** A virtual job's progress through its bay (0..1), moving with time. */
  progress(g: number, s: number, t: number): number {
    const span = 3000;
    return ((t % span) / span + unit(g * 31 + s, 5)) % 1;
  }
}
