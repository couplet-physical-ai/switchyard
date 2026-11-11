// A small rolling history of each engine's slots busy, cpu, mem and load (the Fleet view's sparklines).
// The server sends only the current values (Engine.cpu/mem/load, CONTRACT.md); this keeps the
// last N samples per engine, taken on the world's own clock (`World.at`, server ms: no clock of
// the module's), at most one sample per STEP of it. O(engines) a sample, fixed memory: a data
// turn never grows with it.

import type { World } from './world.ts';
import { enginesOf } from './yard/layout.ts';

export const SAMPLES = 60;
/** World ms between two samples: 60 samples span five minutes of the fleet. */
export const STEP = 5_000;

export type Series = { busy: Float32Array; cpu: Float32Array; mem: Float32Array; load: Float32Array; n: number; head: number };

/** cpu/mem come as 0..1 (the demo) or as percent (the contract): read both as percent. */
const pct = (v: number | undefined): number => (typeof v === 'number' && Number.isFinite(v) ? (v <= 1 ? v * 100 : v) : NaN);

export class EngineHistory {
  readonly series = new Map<string, Series>();
  /** Bumps on every sample: the canvas redraws on it. */
  ver = 0;
  private lastAt = 0;

  sample(w: World): void {
    if (!w.loaded || !w.at) return;
    // Time went backwards (a replay, a reload into the past): the old history is another world's.
    if (w.at < this.lastAt - STEP) { this.series.clear(); this.lastAt = 0; }
    if (w.at - this.lastAt < STEP) return;
    this.lastAt = w.at;
    let any = false;
    const all = enginesOf(w);
    for (const e of all) {
      if (!e) continue;
      let s = this.series.get(e.id);
      if (!s) {
        if (this.series.size >= 64) continue;
        s = { busy: new Float32Array(SAMPLES), cpu: new Float32Array(SAMPLES), mem: new Float32Array(SAMPLES), load: new Float32Array(SAMPLES), n: 0, head: 0 };
        this.series.set(e.id, s);
      }
      const slots = Math.max(1, e.slots || 1);
      s.busy[s.head] = (Math.min(slots, Array.isArray(e.running) ? e.running.length : e.busy || 0) / slots) * 100;
      s.cpu[s.head] = pct(e.cpu);
      s.mem[s.head] = pct(e.mem);
      s.load[s.head] = typeof e.load === 'number' && Number.isFinite(e.load) ? e.load : NaN;
      s.head = (s.head + 1) % SAMPLES;
      if (s.n < SAMPLES) s.n++;
      any = true;
    }
    // Engines the fleet no longer has.
    if (this.series.size > all.length) { const ids = new Set(all.map((e) => e.id)); for (const id of this.series.keys()) if (!ids.has(id)) this.series.delete(id); }
    if (any) this.ver++;
  }

  /** The i-th oldest sample of a series (0 ≤ i < n). */
  static at(s: Series, arr: Float32Array, i: number): number {
    return arr[(s.head - s.n + i + SAMPLES) % SAMPLES];
  }
}
