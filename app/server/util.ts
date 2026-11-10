// Pure helpers shared by the simulation modules: a seeded PRNG and small math utilities.
// Portable: no Bun/Node APIs, no wall clock, no Math.random.

export type Rng = {
  (): number;
  int(lo: number, hi: number): number;
  range(lo: number, hi: number): number;
  pick<T>(xs: readonly T[]): T;
  chance(p: number): boolean;
  exp(mean: number): number;
  hex(n: number): string;
  weighted(cum: Float64Array): number;
};

/** mulberry32: tiny, fast, good enough for a simulation; fully deterministic per seed. */
export function makeRng(seed: number): Rng {
  let a = seed >>> 0;
  const next = (): number => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const r = next as Rng;
  r.int = (lo, hi) => lo + Math.floor(next() * (hi - lo + 1));
  r.range = (lo, hi) => lo + next() * (hi - lo);
  r.pick = (xs) => xs[Math.floor(next() * xs.length)]!;
  r.chance = (p) => next() < p;
  r.exp = (mean) => -Math.log(1 - next()) * mean;
  r.hex = (n) => {
    let s = '';
    while (s.length < n) s += ((next() * 4294967296) >>> 0).toString(16).padStart(8, '0');
    return s.slice(0, n);
  };
  r.weighted = (cum) => {
    const x = next() * cum[cum.length - 1]!;
    let lo = 0;
    let hi = cum.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (cum[mid]! > x) hi = mid;
      else lo = mid + 1;
    }
    return lo;
  };
  return r;
}

/** Stable 32-bit string hash (FNV-1a) for per-entity derived randomness. */
export function hash32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export const clamp = (x: number, lo: number, hi: number): number => (x < lo ? lo : x > hi ? hi : x);
export const round2 = (x: number): number => Math.round(x * 100) / 100;

export const TICK = 100;
export const SEC = 1000;
export const MIN = 60 * SEC;
export const HOUR = 60 * MIN;
export const DAY = 24 * HOUR;

/** Activity multiplier 0.2..1 by time of day (US Central business hours) and weekday. */
export function diurnal(ms: number): number {
  const hourUtc = (ms % DAY) / HOUR;
  const local = (hourUtc - 6 + 24) % 24;
  const d = Math.abs(local - 13.5);
  const f = d < 5 ? 1 : d < 9 ? 1 - (0.8 * (d - 5)) / 4 : 0.2;
  const dow = (Math.floor(ms / DAY) + 4) % 7; // 0 = Sunday (1970-01-01 was a Thursday)
  return dow === 0 || dow === 6 ? f * 0.6 : f;
}

export function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = xs.slice().sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)]!;
}

/** Binary min-heap of timed actions; ties broken by insertion order (deterministic). */
export class Agenda {
  private t: number[] = [];
  private n: number[] = [];
  private f: (() => void)[] = [];
  private counter = 0;
  get size(): number { return this.t.length; }
  add(at: number, fn: () => void): void {
    const i0 = this.t.length;
    this.t.push(at); this.n.push(this.counter++); this.f.push(fn);
    let i = i0;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.less(i, p)) { this.swap(i, p); i = p; } else break;
    }
  }
  peek(): number { return this.t.length ? this.t[0]! : Infinity; }
  pop(): (() => void) | undefined {
    const len = this.t.length;
    if (!len) return undefined;
    const top = this.f[0]!;
    this.swap(0, len - 1);
    this.t.pop(); this.n.pop(); this.f.pop();
    const m = this.t.length;
    let i = 0;
    for (;;) {
      const l = 2 * i + 1, r = l + 1;
      let s = i;
      if (l < m && this.less(l, s)) s = l;
      if (r < m && this.less(r, s)) s = r;
      if (s === i) break;
      this.swap(i, s); i = s;
    }
    return top;
  }
  private less(a: number, b: number): boolean {
    return this.t[a]! < this.t[b]! || (this.t[a] === this.t[b] && this.n[a]! < this.n[b]!);
  }
  private swap(a: number, b: number): void {
    [this.t[a], this.t[b]] = [this.t[b]!, this.t[a]!];
    [this.n[a], this.n[b]] = [this.n[b]!, this.n[a]!];
    [this.f[a], this.f[b]] = [this.f[b]!, this.f[a]!];
  }
}
