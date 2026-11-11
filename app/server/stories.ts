// The simulation's Factory Floor (contract v0.5): seeding the Floor (server/floor.ts) from the
// seeded fleet, and the demo's stories, so the factory has something true to tell on its first
// frame. Pure and portable; deterministic per seed. The stories draw from their own generator
// (never the simulation's), and steer the simulation only through scheduled pushes and forced
// outcomes, so everything they cause (pipelines, red mains, events, clusters) is the
// simulation's own, consistent with every other entity.
//
//   - a failure cluster across 5 repos in 3 groups: "test-web-# · test · TypeError: cannot read
//     properties of undefined (reading 'id')", the first failures ~9 min before the demo's now,
//     the first repo fixed since (a recent recovery), the others failing again; it keeps going
//     while the demo runs;
//   - a flaky step: "e2e" in one repo fails and passes on the same sha (re-runs), with earlier
//     flips today;
//   - a group whose pass rate trends down (the cluster's main group: its past bends down over the
//     last 4 h and its runs fail more now), and one trending up (a bad week behind it);
//   - a recent recovery: a repo red since the seed goes green ~5 min before now;
//   - "since your last visit": the seeded main lines' recoveries and reds of the last 24 h, plus
//     the stories' new reds and recoveries.

import type { Group } from '../src/wire.ts';
import { type Baseline, type PassShape, synthPast } from './floor.ts';
import type { RepoX, Sim } from './sim.ts';
import { DAY, HOUR, MIN, SEC, hash32, makeRng, median } from './util.ts';

export const CLUSTER_LINE = "TypeError: cannot read properties of undefined (reading 'id')";
export const FLAKE_LINE = "Timeout <n>ms exceeded waiting for selector '[data-testid=<str>]'";

/** What the stories picked (the self-test and the docs read it). */
export type StoryCast = { cluster: string[]; down: string; up: string; flaky: string; recovers: string };

/** Seeds the Floor from the seeded fleet, in steps (each a data turn of the in-app demo). */
export function* floorSeedSteps(s: Sim): Generator<void, void, void> {
  const fl = s.floor;
  const st = s.state;
  const T0 = s.t0;
  const rng = makeRng((s.seed * 7919 + 0xfab5) >>> 0);
  s.computeStats();
  fl.catalog();
  yield;

  // ── the cast
  const groupOf = (rx: RepoX) => fl.groupOf(rx.r.id);
  const eligible = s.repos.filter((rx) => rx.appId && rx.tier <= 1 && s.laneFor(rx) === 'roadrunner' && rx.r.main.state === 'success' && rx.r.id !== 'Northwind-Labs/cicd');
  const byGroup = new Map<string, RepoX[]>();
  for (const rx of eligible) { const g = groupOf(rx); if (!g.startsWith('team:')) continue; let xs = byGroup.get(g); if (!xs) byGroup.set(g, (xs = [])); xs.push(rx); }
  // the client hues the four teams with the most apps (FACTORY-SPEC §C): the stories play there
  const appsOf = (g: string) => st.groups[g]?.apps ?? 0;
  const ranked = Object.keys(st.groups).filter((g) => g.startsWith('team:')).sort((a, b) => appsOf(b) - appsOf(a) || (st.groups[b]!.repos - st.groups[a]!.repos) || (a < b ? -1 : 1));
  const hued = ranked.slice(0, 4);
  const teams = hued.filter((g) => (byGroup.get(g)?.length ?? 0) >= 2);
  const take = (g: string | undefined, n: number): RepoX[] => {
    const xs = g ? byGroup.get(g)!.slice() : [];
    const out: RepoX[] = [];
    while (out.length < n && xs.length) out.push(xs.splice(Math.floor(rng() * xs.length), 1)[0]!);
    return out;
  };
  const A = teams[0], B = teams[1], C = teams[2] ?? [...byGroup.keys()].find((g) => g !== A && g !== B);
  const cluster = [...take(A, 2), ...take(B, 2), ...take(C, 1)];
  const inCluster = new Set(cluster);
  const allGroups = Object.keys(st.groups).sort();
  const up = hued.find((g) => g !== A && g !== B && g !== C && st.groups[g]!.repos >= 2) ?? ranked.find((g) => g !== A && g !== B && g !== C) ?? allGroups.find((g) => g !== A) ?? 'fleet';
  // the flaky step lives in a group of its own story (not the trending ones: re-runs would bend them)
  const flakyPool = eligible.filter((rx) => !inCluster.has(rx) && groupOf(rx) !== A && groupOf(rx) !== up);
  const flaky = flakyPool[Math.floor(rng() * flakyPool.length)];
  const redPool = s.repos.filter((rx) => rx.r.main.state === 'failure' && s.laneFor(rx) === 'roadrunner' && rx.r.lane !== 'none');
  const recovers = redPool.sort((a, b) => a.tier - b.tier || a.idx - b.idx)[0];
  s.cast = { cluster: cluster.map((rx) => rx.r.id), down: A ?? '', up, flaky: flaky?.r.id ?? '', recovers: recovers?.r.id ?? '' };

  // ── baselines (the 7 d the mock never ran), from the census
  const stats = st.stats;
  const fleetPipes = Math.max(10, stats.pipelines_24h / 24);
  const fleetDeploys = Math.max(1, stats.deploys_24h / 24);
  const wsum = s.repos.reduce((a, rx) => a + rx.w, 0) || 1;
  const appsN = Math.max(1, s.apps.length);
  const builds = (ids: RepoX[]) => median(ids.map((rx) => rx.r.p50_build_ms ?? 90_000)) || 90_000;
  const members = new Map<string, RepoX[]>();
  for (const rx of s.repos) { const g = groupOf(rx); let xs = members.get(g); if (!xs) members.set(g, (xs = [])); xs.push(rx); }
  fl.baseline('fleet', { pass: stats.success_rate_24h || 0.9, run: stats.p50_build_ms || 90_000, intake: 12_000, pipelines: fleetPipes, deploys: fleetDeploys, prAge: 2 * DAY, red: 0 });
  for (const g of allGroups) {
    const xs = members.get(g) ?? [];
    const share = xs.reduce((a, rx) => a + rx.w, 0) / wsum;
    const grp: Group = st.groups[g]!;
    const jitter = (hash32(g) % 1000) / 1000;
    const b: Baseline = {
      pass: g === A ? 0.93 : g === up ? 0.74 : 0.87 + 0.03 * jitter,
      run: builds(xs), intake: Math.round(8_000 + 9_000 * jitter),
      pipelines: Math.max(0.3, fleetPipes * share), deploys: Math.max(0.05, (fleetDeploys * grp.apps) / appsN),
      prAge: Math.round((1.2 + 2 * jitter) * DAY), red: g === A ? Math.max(0, grp.red) : grp.red,
    };
    fl.baseline(g, b);
  }
  yield;

  // ── the past 24 h, with the two trending stories bent into it
  const shapes = new Map<string, PassShape>();
  if (A) shapes.set(A, (ago) => (ago >= 4 ? 0.93 : 0.62 + 0.31 * (ago / 4)));
  shapes.set(up, (ago) => (ago >= 8 ? 0.72 : 0.97 - 0.25 * (ago / 8)));
  synthPast(fl, rng, allGroups, T0 - DAY, T0, shapes);
  yield;
  // the seeded runs (last 2 h of pipelines): their failures cluster, their flips are flakes; their
  // counts are already in the synthetic hours
  yield* fl.observeAllSteps(T0, false, 120);
  fl.seedLog(T0);
  yield;

  // ── the stories, on the simulation's own clock (relative to its epoch: the demo's now)
  const E = s.epoch;
  for (const rx of cluster) {
    rx.testStep = ['test-web-1', 'test-web-2', 'test-web-3'];
    fl.stories.set(`${rx.r.id}|test-web-#`, { cls: 'test', line: CLUSTER_LINE });
  }
  if (flaky) {
    flaky.testStep = ['e2e'];
    fl.stories.set(`${flaky.r.id}|e2e`, { cls: 'timeout', line: FLAKE_LINE });
    const ats = [E - 5 * HOUR - 12 * MIN, E - 3 * HOUR - 41 * MIN, E - 71 * MIN];
    fl.priorFlips(flaky.r.id, 'ci', 'e2e', ats, ats.map(() => rng.hex(40)).reverse(), [...ats.map((t) => t - 4 * MIN), E - 6 * HOUR - 3 * MIN]);
  }
  if (A) for (const rx of members.get(A) ?? []) if (!inCluster.has(rx)) s.storyBias.set(rx.r.id, 0.14);
  const titles = ['bump @exowatt/ui to 4.2', 'move session lookup into useAccount', 'drop legacy id shim from api client', 'adopt shared fetcher from @exowatt/ui', 'tighten Account type'];
  const at = (t: number) => Math.max(T0 + SEC, t);
  // each cluster repo fails (the first ~9 min before now); the first is fixed ~6 min before now
  // (a recent recovery by the time the demo opens), the others try again ~5 min before now and
  // fail again
  cluster.forEach((rx, i) => s.storyPush(at(E - 9.5 * MIN + i * 40 * SEC), rx, ['failure'], titles[i % titles.length]!));
  if (cluster[0]) s.storyPush(at(E - 6.5 * MIN), cluster[0], ['success'], 'fix: guard undefined account in useAccount');
  cluster.slice(1).forEach((rx, i) => s.storyPush(at(E - 5.2 * MIN + i * 40 * SEC), rx, ['failure'], 'retry: guard undefined account'));
  if (recovers) s.storyPush(at(E - 8 * MIN), recovers, ['success'], 'fix flaky fixture path');
  if (flaky) {
    s.storyPush(at(E - 9 * MIN), flaky, ['failure', 'success'], 'wire checkout e2e to staging');
    s.storyPush(at(E - 5.5 * MIN), flaky, ['failure', 'success'], 'retry checkout button selector');
  }
  // …and they go on while the demo runs: a cluster repo every ~5 min (fails 3 in 5, else a fix),
  // the flaky step every ~13 min
  const more = (t: number): void => {
    s.agenda.add(t, () => {
      const rx = cluster[Math.floor(rng() * cluster.length)];
      if (rx) s.storyPush(s.now + SEC, rx, [rng() < 0.6 ? 'failure' : 'success'], rng() < 0.5 ? 'follow-up: account id' : 'refactor account loader');
      more(s.now + Math.round((4 + 2 * rng()) * MIN / 100) * 100);
    });
  };
  more(E + 3 * MIN);
  const flakes = (t: number): void => {
    s.agenda.add(t, () => {
      if (flaky) s.storyPush(s.now + SEC, flaky, ['failure', 'success'], 'checkout e2e: wait for cart');
      flakes(s.now + Math.round((11 + 5 * rng()) * MIN / 100) * 100);
    });
  };
  flakes(E + 7 * MIN);
  yield;
  fl.tick(T0);
  fl.tickTrends(T0);
  s.floorOn = true;
}
