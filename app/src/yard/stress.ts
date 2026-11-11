// Stress mode (DESIGN.md, "Stress"): a 10× fleet for the RENDERER only. The data module's
// 64 MiB heap holds one real fleet, never ten, so nothing here is an entity: the extra repos,
// orgs, engines and apps are indices whose state is a hash of the index and the real fleet's
// own mix, kept in typed arrays (4,000 repo states are 4 KB). Packets are the pool's (10,000
// sprites on the real wires, pool.ts). Turning it off frees the arrays.

import type { Engine } from '../wire.ts';
import { S_GREEN, S_NONE, S_PEND, S_RED, S_RUN, S_STALE } from './select.ts';

export const FACTOR = 10;
export const STRESS_PACKETS = 10_000;

/** A small, fast, seeded hash (no Math.random in a data module). */
export function hash(a: number, b = 0): number {
  let h = (a * 0x27d4eb2d) ^ (b * 0x165667b1) ^ 0x9e3779b9;
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}
export const unit = (a: number, b = 0) => hash(a, b) / 4294967296;

export type VirtualLane = { id: string; title: string; sub: string; kind: Engine['kind']; slots: number; offline: boolean };

export class StressFleet {
  on = false;
  /** Repo states: the real ones first, then 9 hashed copies with the same red/green mix. */
  repoState = new Uint8Array(0);
  appHealth = new Uint8Array(0);
  orgLabels: string[] = [];
  lanes: VirtualLane[] = [];
  private builtFor = '';

  /** (Re)builds the virtual census from the real one's shape. Cheap: typed arrays. */
  build(realStates: Uint8Array, realOrgs: string[], realLanes: VirtualLane[], realApps: Uint8Array): void {
    const key = `${realStates.length}:${realOrgs.length}:${realLanes.length}:${realApps.length}`;
    if (key === this.builtFor && this.repoState.length) {
      this.repoState.set(realStates.subarray(0, Math.min(realStates.length, this.repoState.length)));
      return;
    }
    this.builtFor = key;
    let red = 0, run = 0, none = 0;
    for (let i = 0; i < realStates.length; i++) { const s = realStates[i]; if (s === S_RED || s === S_STALE) red++; else if (s === S_RUN || s === S_PEND) run++; else if (s === S_NONE) none++; }
    const n = Math.max(1, realStates.length);
    const pr = Math.max(0.03, red / n), pu = Math.max(0.02, run / n), pn = none / n;
    const total = Math.max(4000, realStates.length * FACTOR);
    this.repoState = new Uint8Array(total);
    this.repoState.set(realStates);
    for (let i = realStates.length; i < total; i++) {
      const u = unit(i, 7);
      this.repoState[i] = u < pr * 0.35 ? S_RED : u < pr ? S_STALE : u < pr + pu ? S_RUN : u < pr + pu + pn ? S_NONE : S_GREEN;
    }
    const apps = Math.max(2370, realApps.length * FACTOR);
    this.appHealth = new Uint8Array(apps);
    this.appHealth.set(realApps);
    for (let i = realApps.length; i < apps; i++) {
      const u = unit(i, 11);
      this.appHealth[i] = u < 0.004 ? 2 : u < 0.012 ? 1 : u < 0.05 ? 4 : 0;
    }
    this.orgLabels = [];
    for (let k = 0; k < FACTOR; k++) for (const o of realOrgs) this.orgLabels.push(k ? `${o}-${k + 1}` : o);
    this.lanes = [];
    for (let k = 0; k < FACTOR; k++) {
      for (const l of realLanes) this.lanes.push({ ...l, id: k ? `${l.id}~${k}` : l.id, title: k ? `${l.title}-${k + 1}` : l.title, offline: k ? unit(k, l.slots) < 0.06 : l.offline });
    }
  }

  clear(): void {
    this.repoState = new Uint8Array(0);
    this.appHealth = new Uint8Array(0);
    this.orgLabels = [];
    this.lanes = [];
    this.builtFor = '';
  }

  /** Whether virtual slot `s` of lane `l` is busy at time bucket `t` (changes every ~3 s). */
  busy(l: number, s: number, t: number): boolean {
    return unit(l * 64 + s, Math.floor(t / 3000) + l) < 0.55;
  }
}
