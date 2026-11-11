// The built-in demo: the mock server's seeded simulation (server/sim.ts), run inside the data
// module in its lite form (no frame log). No network; the playhead pulls it forward. The same
// seed and start make the same fleet, so a test that fixes the clock sees the same yard.
//
// Its "last hour, sped up" is a rewind: a new simulation started an hour before now plays
// forward at 60× until it reaches now, and then simply carries on as the live one.

import { createSim, type Sim } from '../server/sim.ts';
import type { Upstream } from './api.ts';
import type { Frame as WireFrame, History, Journey, Meta, PrDetail, SearchResults, Snapshot } from './wire.ts';

export async function yieldTurn(): Promise<void> {
  const s = (globalThis as { scheduler?: { yield?: () => Promise<void> } }).scheduler;
  if (s?.yield) await s.yield();
}

/** How much the demo simulates before it starts, so main lines have history. */
export const DEMO_WARMUP = 10 * 60_000;
/** The rewind's length. */
export const DEMO_REPLAY = 60 * 60_000;

export class DemoUpstream implements Upstream {
  readonly kind = 'demo' as const;
  readonly label = 'built-in demo';
  private sim: Sim;
  private constructor(readonly epoch: number, seed: number) {
    this.sim = createSim({ epoch, seed, warmupMs: DEMO_WARMUP, checkpointMs: 60_000, maxCommits: 1200, lite: true, deferWarmup: true });
  }
  /** A demo at `epoch`, its warm-up run 4 s of fleet time per turn (a turn has 100 ms of CPU;
   *  10 s took 99–119 ms on the build Mac under load, so a `connect` could fail its budget). */
  static async start(epoch: number, seed = 7): Promise<DemoUpstream> {
    const d = new DemoUpstream(epoch, seed);
    // The seeding is one turn and the warm-up others: on a busy Mac (efficiency cores) the
    // two together went over a turn's 100 ms budget.
    await yieldTurn();
    while (!d.sim.warm(2_000)) await yieldTurn();
    await yieldTurn(); // the caller loads the world next: give it a turn of its own
    return d;
  }
  /** Runs the simulation toward `ms` (at most 5 s per call, so a long gap catches up over
   *  several frames instead of stalling one) and returns the frames it made. */
  pump(ms: number): WireFrame[] {
    if (ms <= this.sim.now) return [];
    return this.sim.advanceTo(Math.min(ms, this.sim.now + 5_000));
  }
  get now(): number {
    return this.sim.now;
  }
  /** The simulation's own store, not a copy: the world shares its entities (it never
   *  mutates them, and the sim's frames replace what changes), so a 4 MB copy is never made. */
  async snapshot(): Promise<Snapshot> {
    return this.sim.liveState() as unknown as Snapshot;
  }
  async history(_from: number, _to: number): Promise<History> {
    throw new Error('the demo rewinds instead');
  }
  async journey(repo: string, sha: string): Promise<Journey | null> {
    return this.sim.journey(repo, sha) as Journey | null;
  }
  async pr(repo: string, number: number): Promise<PrDetail | null> {
    return this.sim.prDetail(repo, number) as PrDetail | null;
  }
  async search(q: string): Promise<SearchResults> {
    return this.sim.search(q);
  }
  async meta(): Promise<Meta | null> {
    return { protocol: '0.2', version: 'demo', git_sha: '', mode: 'demo', adapters: [{ name: 'demo', state: 'ok' }], orgs: [] };
  }
}
