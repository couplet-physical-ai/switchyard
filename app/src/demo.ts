// The built-in demo: the mock server's seeded simulation (server/sim.ts), run inside the data
// module. No network; the playhead advances it. Deterministic for a seed and an epoch, so a
// test that fixes the clock sees the same fleet every time.

import { createSim, type Sim } from '../server/sim.ts';
import type { Upstream } from './api.ts';
import type { Frame as WireFrame, History, Journey, Meta, PrDetail, SearchResults, Snapshot } from './wire.ts';

/** How much the demo simulates before it starts (and so how far back its replay goes). */
export const DEMO_WARMUP = 10 * 60_000;

export class DemoUpstream implements Upstream {
  readonly kind = 'demo' as const;
  readonly label = 'built-in demo';
  private sim: Sim;
  constructor(readonly epoch: number, seed = 7) {
    // Warm up before `epoch`, so main lines have history and the replay has something to show.
    // Bounded: the data module's engine (Hermes) has a smaller heap than a server process.
    this.sim = createSim({ epoch, seed, warmupMs: DEMO_WARMUP, historyMs: DEMO_WARMUP + 600_000, checkpointMs: 600_000, ringFrames: 6000, maxCommits: 1200 });
  }
  /** Runs the simulation to `wallMs` and returns the frames it produced. */
  pump(wallMs: number): WireFrame[] {
    if (wallMs <= this.sim.now) return [];
    // A long gap (a sleeping laptop) is not simulated tick by tick: the demo moves at most
    // 30 s at a time, so the yard catches up over a few frames instead of stalling.
    return this.sim.advanceTo(Math.min(wallMs, this.sim.now + 30_000));
  }
  get now(): number {
    return this.sim.now;
  }
  async snapshot(): Promise<Snapshot> {
    return this.sim.snapshot();
  }
  async history(from: number, to: number): Promise<History> {
    return this.sim.history(from, to);
  }
  async journey(repo: string, sha: string): Promise<Journey | null> {
    return this.sim.journey(repo, sha);
  }
  async pr(repo: string, number: number): Promise<PrDetail | null> {
    return this.sim.prDetail(repo, number);
  }
  async search(q: string): Promise<SearchResults> {
    return this.sim.search(q);
  }
  async meta(): Promise<Meta | null> {
    return { protocol: '0', version: 'demo', git_sha: '', adapters: [{ name: 'demo', state: 'ok' }], orgs: [] };
  }
}
