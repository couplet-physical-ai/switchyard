// The fleet's totals, one count for every place that says them (the status line, the board's
// head, the Yard): main lines red, apps up and down, what builds and what waits (buildingIds,
// queueTruth: the Yard's QUEUE band agrees). Stress mode (the Yard's 10x synthetic fleet) counts
// the fleet ten times.

import type { World } from './world.ts';
import { buildingIds, queueTruth } from './yard/select.ts';
import { FACTOR } from './yard/stress.ts';

export type Totals = { repos: number; red: number; building: number; queued: number; apps: number; up: number; down: number; factor: number };

export const isRedMain = (state: string | undefined): boolean => state === 'failure' || state === 'error';

export function totals(w: World, stress = false): Totals {
  const t: Totals = { repos: 0, red: 0, building: 0, queued: 0, apps: 0, up: 0, down: 0, factor: 1 };
  if (!w.loaded) return t;
  for (const r of w.repos.values()) if (isRedMain(r.main?.state)) t.red++;
  for (const a of w.apps.values()) { if (a.health === 'up') t.up++; else if (a.health === 'down') t.down++; }
  t.repos = w.repos.size; t.apps = w.apps.size;
  t.building = buildingIds(w).size;
  t.queued = queueTruth(w).waiting;
  if (stress) {
    const f = (t.factor = FACTOR);
    t.repos *= f; t.red *= f; t.building *= f; t.queued *= f; t.apps *= f; t.up *= f; t.down *= f;
  }
  return t;
}
