// THE seam for the Factory Floor's data (contract v0.5): groups, failure clusters, flakes,
// trends, "since your last visit", and the two histories the contract does not have yet. The
// factory reads them ONLY through here, with one API whatever the server speaks:
//
//   - a v0.5 server (and the built-in demo, and the mock): its own tables, kept live in the world
//     (World.groups/clusters/flakes/trends, Repo.group, Step.cluster, Pipeline.flaky) and its
//     `/api/v1/changes?since=`;
//   - a v0.4 server: the same shapes APPROXIMATED here, client-side, from what the world holds,
//     cheaply and in slices (each approximation is documented where it is built).
//
// Engine history (H6) and app history (H7) are client-side seams on both versions until the
// server adds them (`engineHistory`, `appHistory`).
//
// Everything is synchronous and cheap except `changesSince` (it may fetch). A draw may call the
// accessors: the v0.4 approximations advance a bounded slice per call and return the last
// complete result, so no call does O(fleet) work; `ver(table)` bumps when a table changed.

import { clusterIdOf, clusterOrder, foldStep, guessClass, isRedState, normTeam, orgGroupId, repoTeams, signatureOf, teamGroupId, teamName } from '../server/floor.ts';
import type { Upstream } from './api.ts';
import { EngineHistory, STEP } from './enginehist.ts';
import { Timeline } from './timeline.ts';
import type {
  App, AppDetail, ChangeCounts, Changes, CiState, Cluster, Deploy, DeployRef, DeployState, DeployVia, Engine, EngineHistoryDoc, Flake, Group, Health,
  Insights as InsightsDoc, Metric, Pipeline, Pr, Repo, Trend,
} from './wire.ts';
import type { HealthChange, World } from './world.ts';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

export type Table = 'groups' | 'clusters' | 'flakes' | 'trends';
const KIND: Record<Table, string> = { groups: 'group', clusters: 'cluster', flakes: 'flake', trends: 'trend' };

// ───────────────────────────── group hues (FACTORY-SPEC §C) ─────────────────────────────

/** A group's identity colour. `slot` is its hued slot (0–8), -1 when folded into the neutral
 *  "other teams" (or the bots siding). */
export type GroupHue = { l: number; c: number; h: number; hex: string; slot: number; folded: boolean };

/** §C: group chroma ≤ 0.075 (state colours are ≥ 0.11), hues clear of red (0–50°) and amber
 *  (60–100°); adjacent lanes alternate lightness. The fixture's groups get exactly these:
 *  the four biggest teams (by apps) the blues, the five orgs their own. */
const TEAM_SLOTS: [number, number, number][] = [[0.75, 0.065, 252], [0.60, 0.075, 274], [0.75, 0.055, 205], [0.60, 0.065, 228]];
const ORG_SLOTS: Record<string, [number, number, number]> = {
  'Northwind-Labs': [0.62, 0.070, 180], 'Northwind-Forge': [0.75, 0.060, 298], 'Northwind-EMS': [0.60, 0.075, 320],
  'couplet-physical-ai': [0.68, 0.065, 118], 'copper-browser': [0.72, 0.060, 345],
};
/** The org slots in lane order (an unknown org takes the first one no known org holds). */
const ORG_ORDER_HUE = ['Northwind-Labs', 'Northwind-Forge', 'Northwind-EMS', 'couplet-physical-ai', 'copper-browser'];
/** Teams past the hued slots fold into "other teams": neutral. */
export const OTHER_HUE: GroupHue = hue(0.62, 0.012, 90, -1, true);
/** The bots siding (§C): near-neutral, drawn with a hatch. */
export const BOTS_HUE: GroupHue = hue(0.50, 0.008, 250, -1, true);
/** At most this many hued groups (§C: "teams beyond the 9 hue slots fold into other teams"). */
export const HUE_SLOTS = 9;

function hue(l: number, c: number, h: number, slot: number, folded = false): GroupHue {
  return { l, c, h, hex: oklchHex(l, c, h), slot, folded };
}

/** OKLCH → sRGB `#rrggbb` (gamut-clipped). */
export function oklchHex(l: number, c: number, h: number): string {
  const a = c * Math.cos((h * Math.PI) / 180), b = c * Math.sin((h * Math.PI) / 180);
  const l_ = l + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = l - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = l - 0.0894841775 * a - 1.2914855480 * b;
  const L = l_ ** 3, M = m_ ** 3, S = s_ ** 3;
  const lin = [
    4.0767416621 * L - 3.3077115913 * M + 0.2309699292 * S,
    -1.2684380046 * L + 2.6097574011 * M - 0.3413193965 * S,
    -0.0041960863 * L - 0.7034186147 * M + 1.7076147010 * S,
  ];
  let out = '#';
  for (const x of lin) {
    const v = x <= 0.0031308 ? 12.92 * x : 1.055 * Math.pow(Math.max(0, x), 1 / 2.4) - 0.055;
    out += Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, '0');
  }
  return out.toUpperCase();
}

// ───────────────────────────── the views the seam returns besides the contract's ─────────────────────────────

/** H6, client-side until the server has it: an engine's utilisation over time. */
export type EngineHistoryView = {
  id: string; slots: number;
  /** src/enginehist.ts samples since the app opened (≤ 60, every STEP ms of fleet time), oldest first: percent / load1. */
  step: number; busy: number[]; cpu: number[]; mem: number[]; load: number[];
  /** Occupancy rebuilt from the retained pipelines (≈ the last 2 h): slots busy per `res` ms, oldest first, the last bucket ending `to`. */
  res: number; from: number; to: number; occupancy: number[];
  /** Runs on this engine or its agents, newest first. */
  runs: { pipeline: string; repo: string; started: number; finished?: number; state: CiState }[];
  /** Repos served in the last hour: runs and engine-ms. */
  served: { repo: string; jobs: number; ms: number }[];
};

/** H7, client-side until the server has it: an app's health and deploys over time. */
export type AppHistoryView = {
  id: string; health: Health; checked: number; latency_ms?: number; last_deploy?: DeployRef;
  /** Health changes the stream reported since the world was loaded (`since`), oldest first. */
  transitions: HealthChange[];
  /** Incidents rebuilt from them (and the health now): an open one has no `to`. */
  incidents: { from: number; to?: number; state: Health }[];
  /** This app's deploys the world holds (24 h), newest first. */
  deploys: { at: number; sha: string; state: DeployState; via: DeployVia; finished?: number }[];
  since: number;
};

// ───────────────────────────── the seam ─────────────────────────────

type ApproxFloor = { clusters: Map<string, Cluster>; flakes: Map<string, Flake>; sorted: Cluster[]; flakeList: Flake[] };
type Job<T> = { gen: Generator<void, T, void>; key: string };

/** Pipelines (or other entities) one slice of an approximation reads (~0.15 ms in Bun; Hermes runs it 10–25× slower). */
const SLICE = 80;
/** Slices per turn of the module clock (a frame, or a source's answer): however many accessors
 *  a draw calls, the approximations cost at most this many slices in it. */
const SLICES_PER_TURN = 1;

export class Insights {
  /** Group hue slots, frozen for the session (§C: ranks are frozen per session). */
  private hueOf = new Map<string, GroupHue>();
  private orgHueTaken = new Set<string>();
  private teamSlotsUsed = 0;
  private hueKey = '';
  // caches (keyed on the world and its counters)
  private gWorld: World | null = null;
  private gKey = '';
  private teams = new Map<string, { slug: string; raw: string }>();
  private teamsKey = '';
  private approxGroups: Group[] = [];
  private v5Groups: Group[] = [];
  private v5GroupsKey = '';
  private v5Clusters: Cluster[] = [];
  private v5ClustersKey = '';
  private v5Flakes: Flake[] = [];
  private v5FlakesKey = '';
  private floorJob: Job<ApproxFloor> | null = null;
  private floorDone: ApproxFloor = { clusters: new Map(), flakes: new Map(), sorted: [], flakeList: [] };
  private floorKey = '';
  private floorAt = -1e15;
  private trendJob: Job<Map<string, Trend>> | null = null;
  private trendDone = new Map<string, Trend>();
  private trendKey = '';
  private trendAt = -1e15;
  /** Approximation versions (a v0.4 server): bump when a table is replaced. */
  private av = { groups: 0, clusters: 0, flakes: 0, trends: 0 };
  private engCache: { key: string; v: EngineHistoryView | null } = { key: '', v: null };
  private pumpClock = NaN;
  private pumps = 0;

  constructor(readonly tl: Timeline, private upstream: () => Upstream | null = () => null, private engines: EngineHistory | null = null) {}

  get world(): World { return this.tl.world; }
  /** The server speaks v0.5 (its own tables), else everything here is approximated. */
  get v05(): boolean { return this.tl.world.v05; }

  /** A change counter per table: compare it to redraw only when the table changed. */
  ver(table: Table): number {
    const w = this.world;
    // (a replaced world restarts its counters: the timeline's epoch tells the worlds apart)
    if (w.v05) return this.tl.epoch * 1_000_003 + (w.kv[KIND[table]] ?? 0);
    this.pump();
    return this.tl.epoch * 1_000_003 + this.av[table];
  }

  // ── groups ──

  /** The repo's Group id: `Repo.group` on v0.5; else (v0.4) `team:<slug>` from the apps
   *  catalog (App.team of the apps whose App.repo is this repo, the most apps winning; else
   *  Repo.app's App.team; normalized lower-case with "-team" dropped, "unknown" none), else
   *  `org:<Owner>`. */
  groupOf(repo: string): string {
    const w = this.world;
    const r = w.repos.get(repo);
    if (w.v05 && r?.group) return r.group;
    const t = this.teamMap().get(repo);
    return t ? teamGroupId(t.slug) : orgGroupId(r?.org ?? String(repo).split('/')[0] ?? '');
  }

  group(id: string): Group | undefined {
    const w = this.world;
    if (w.v05) return w.groups.get(id);
    return this.groups().find((g) => g.id === id);
  }

  /** Every group, biggest first (repos, then name). v0.4: built from the catalog (O(repos +
   *  apps), redone when repos, apps or a main line changed, at most once per 2 s of fleet time). */
  groups(): Group[] {
    const w = this.world;
    if (w.v05) {
      const key = `${w.kv.group}`;
      if (this.gWorld !== w || this.v5GroupsKey !== key) {
        this.gWorld = w;
        this.v5GroupsKey = key;
        this.v5Groups = [...w.groups.values()].sort(groupOrder);
      }
      return this.v5Groups;
    }
    const key = `${w.shapeVer}:${w.kv.app}:${w.kv.repo}:${Math.floor(w.at / 2000)}`;
    if (this.gWorld === w && this.gKey === key) return this.approxGroups;
    this.gWorld = w;
    this.gKey = key;
    const teams = this.teamMap();
    const next = new Map<string, Group>();
    const get = (id: string, name: string, kind: 'team' | 'org'): Group => {
      let g = next.get(id);
      if (!g) next.set(id, (g = { id, name, kind, repos: 0, apps: 0, red: 0 }));
      return g;
    };
    for (const r of w.repos.values()) {
      const t = teams.get(r.id);
      const g = t ? get(teamGroupId(t.slug), teamName(t.raw, t.slug), 'team') : get(orgGroupId(r.org), r.org, 'org');
      g.repos++;
      if (isRedState(r.main?.state)) g.red++;
    }
    for (const a of w.apps.values()) {
      const slug = normTeam(a.team);
      const g = slug ? get(teamGroupId(slug), teamName(String(a.team), slug), 'team') : a.repo ? next.get(this.groupOf(a.repo)) : undefined;
      if (g) g.apps++;
    }
    const list = [...next.values()].sort(groupOrder);
    if (JSON.stringify(list) !== JSON.stringify(this.approxGroups)) { this.approxGroups = list; this.av.groups++; }
    return this.approxGroups;
  }

  private teamMap(): Map<string, { slug: string; raw: string }> {
    const w = this.world;
    const key = `${w.shapeVer}:${w.kv.app}`;
    if (this.teamsKey !== key || this.gWorld !== w) {
      this.teamsKey = key;
      this.teams = repoTeams(w.repos.values(), appsWithIds(w));
    }
    return this.teams;
  }

  /** The group's identity colour (FACTORY-SPEC §C). The fixture's ten groups get the spec's
   *  values: the four teams with the most apps the four team slots (blues, alternating
   *  lightness), each org its own slot; teams past the nine hued slots fold into the neutral
   *  "other teams". Ranks are frozen for the session: a group keeps its colour while the app
   *  runs, and a new group takes a free slot or folds. `'bots'` is the bots siding. */
  groupHue(groupId: string): GroupHue {
    if (groupId === 'bots') return BOTS_HUE;
    let h = this.hueOf.get(groupId);
    if (h) return h;
    this.assignHues();
    h = this.hueOf.get(groupId);
    if (h) return h;
    // a group the world does not list (yet): an org takes its own slot, a team folds
    if (groupId.startsWith('org:')) h = this.orgHue(groupId.slice(4));
    h ??= OTHER_HUE;
    this.hueOf.set(groupId, h);
    return h;
  }

  private assignHues(): void {
    const gs = this.groups();
    const key = gs.map((g) => g.id).join('|');
    if (!gs.length || key === this.hueKey) return;
    this.hueKey = key;
    const orgs = gs.filter((g) => g.kind === 'org' && !this.hueOf.has(g.id)).sort((a, b) => orgRank(a.id) - orgRank(b.id) || (a.id < b.id ? -1 : 1));
    for (const g of orgs) this.hueOf.set(g.id, this.orgHue(g.id.slice(4)) ?? OTHER_HUE);
    let free = HUE_SLOTS - [...this.hueOf.values()].filter((x) => !x.folded).length;
    const teams = gs.filter((g) => g.kind === 'team' && !this.hueOf.has(g.id)).sort((a, b) => b.apps - a.apps || b.repos - a.repos || (a.id < b.id ? -1 : 1));
    for (const g of teams) {
      let x: GroupHue = OTHER_HUE;
      if (free > 0 && this.teamSlotsUsed < TEAM_SLOTS.length) {
        const [l, c, hh] = TEAM_SLOTS[this.teamSlotsUsed]!;
        x = hue(l, c, hh, this.teamSlotsUsed++);
        free--;
      } else if (free > 0) {
        // fewer than five orgs: a team after the four blues borrows a free org colour
        const o = ORG_ORDER_HUE.find((k) => !this.orgHueTaken.has(k) && !this.world.orgs.has(k));
        if (o) { this.orgHueTaken.add(o); const [l, c, hh] = ORG_SLOTS[o]!; x = hue(l, c, hh, TEAM_SLOTS.length + ORG_ORDER_HUE.indexOf(o)); free--; }
      }
      this.hueOf.set(g.id, x);
    }
  }

  /** An org's own slot; an org §C does not know takes the first slot no known org of this
   *  fleet holds. */
  private orgHue(org: string): GroupHue | undefined {
    const pick = ORG_SLOTS[org] && !this.orgHueTaken.has(org) ? org : ORG_ORDER_HUE.find((o) => !this.orgHueTaken.has(o) && !this.world.orgs.has(o));
    if (!pick) return undefined;
    this.orgHueTaken.add(pick);
    const [l, c, h] = ORG_SLOTS[pick]!;
    return hue(l, c, h, TEAM_SLOTS.length + ORG_ORDER_HUE.indexOf(pick));
  }

  // ── clusters and flakes ──

  /** The failure cluster of a pipeline's failed step (`step`: a step name or "workflow/step";
   *  none: its first failed step). v0.5: `Step.cluster`. v0.4: the step's own signature (see
   *  `clusters()`), looked up in the last complete approximation, or a one-failure cluster. */
  clusterOf(pipelineId: string, step?: string): Cluster | null {
    const w = this.world;
    const p = w.pipelines.get(pipelineId);
    if (!p) return null;
    const hit = failedStep(p, step);
    if (!hit) return null;
    if (w.v05) return hit.st.cluster ? w.clusters.get(hit.st.cluster) ?? null : null;
    this.pump();
    const sig = approxSignature(hit.st.name, hit.wf, hit.st.exit_code);
    const id = clusterIdOf(sig.signature);
    const known = this.floorDone.clusters.get(id);
    if (known) return known;
    const at = hit.st.finished ?? p.finished ?? w.at;
    return {
      id, signature: sig.signature, step: sig.step, class: sig.cls, ...(hit.st.exit_code !== undefined ? { exit_code: hit.st.exit_code } : {}),
      count: 1, count_1h: at > w.at - HOUR ? 1 : 0, repos: [p.repo], repo_count: 1, groups: [this.groupOf(p.repo)],
      first_seen: at, last_seen: at, examples: [pipelineId], open: 1,
    };
  }

  cluster(id: string): Cluster | undefined {
    const w = this.world;
    if (w.v05) return w.clusters.get(id);
    this.pump();
    return this.floorDone.clusters.get(id);
  }

  /** Failure clusters, open first, then count_1h, then count (the Insights order). v0.4
   *  APPROXIMATION: from the pipelines the world holds (in flight + finished in the last ~2 h,
   *  so `count` covers that, not 24 h); signature = the failing step's name with numbered shards
   *  folded ("test-web-3" → "test-web-#") + a class guessed from the step name and exit code,
   *  no error line (the logs are the server's); `open` = repos whose latest held run of that
   *  step failed; built in slices of SLICE pipelines, redone at most every 2 s of fleet time. */
  clusters(): Cluster[] {
    const w = this.world;
    if (w.v05) {
      const key = `${w.kv.cluster}`;
      if (this.v5ClustersKey !== key || this.gWorld !== w) {
        this.v5ClustersKey = key;
        this.v5Clusters = [...w.clusters.values()].sort(clusterOrder);
      }
      return this.v5Clusters;
    }
    this.pump();
    return this.floorDone.sorted;
  }

  /** Flaky steps, most flips first. v0.4 APPROXIMATION: a step that failed and passed on the
   *  same sha among the held pipelines (≈ 2 h, not 24 h). */
  flakes(): Flake[] {
    const w = this.world;
    if (w.v05) {
      const key = `${w.kv.flake}`;
      if (this.v5FlakesKey !== key || this.gWorld !== w) {
        this.v5FlakesKey = key;
        this.v5Flakes = [...w.flakes.values()].sort(flakeOrder);
      }
      return this.v5Flakes;
    }
    this.pump();
    return this.floorDone.flakeList;
  }

  // ── trends ──

  /** The fleet's ('fleet') or a group's trend. v0.4 APPROXIMATION (null until the first slice
   *  run completes): h1 from the last hour of what the world holds (pipelines finished, deploys,
   *  red mains now, the age of open non-bot PRs now); h24 only where the world holds 24 h (the
   *  fleet's from Stats; deploys per group from the 24 h of deploys); d7 null (hours_7d 0); `dir`
   *  h1 against h24; sparks: the hours the held data covers (pipelines ≈ the last 2 h, deploys 24
   *  h, gauges only now), null elsewhere. Redone at most once a minute of fleet time. */
  trend(id: 'fleet' | string): Trend | null {
    const w = this.world;
    if (w.v05) return w.trends.get(id) ?? null;
    this.pump();
    return this.trendDone.get(id) ?? null;
  }

  // ── since your last visit ──

  /** What changed since `ms` (to `until`, default now). v0.5 (and the demo): the server's
   *  `/api/v1/changes`. `complete` is false when `ms` was older than the retained 24 h and was
   *  clamped (the coffee check then says "since 24 h ago"). v0.4 APPROXIMATION from the world
   *  (no network): reds from main lines red now whose `since` is after `ms`; recoveries from
   *  `main` events seen and from red→green turns in the main lines' recent dots; deploys from
   *  the 24 h of deploys; app health from the health events seen since the world was loaded;
   *  pipelines/failures from the held pipelines (≈ 2 h) and, before them, one per commit of the
   *  24 h of commits (its combined state); clusters and flakes from the approximations above. */
  async changesSince(ms: number, until?: number): Promise<Changes> {
    const up = this.upstream();
    if (up?.changes && (this.world.v05 || up.kind === 'demo')) {
      try {
        const c = await up.changes(ms, until);
        if (c && typeof c === 'object' && 'counts' in c) return c;
      } catch { /* the approximation answers */ }
    }
    return this.approxChanges(ms, until);
  }

  /** The Factory Floor in one call: the server's `/api/v1/insights` on v0.5, else the
   *  approximations above in the same shape. */
  async insights(): Promise<InsightsDoc> {
    const up = this.upstream();
    if (up?.insights && this.world.v05) {
      try { const r = await up.insights(); if (r && Array.isArray(r.groups)) return r; } catch { /* local tables */ }
    }
    const groups = this.groups();
    const trends: Trend[] = [];
    const ft = this.trend('fleet');
    if (ft) trends.push(ft);
    for (const g of [...groups].sort((a, b) => (a.name < b.name ? -1 : 1))) { const t = this.trend(g.id); if (t) trends.push(t); }
    return { at: this.world.at, groups, clusters: this.clusters(), flakes: this.flakes(), trends };
  }

  // ── H6 / H7: client-side histories ──

  /** H6: an engine's utilisation over time (client-side on every server version for now):
   *  the enginehist.ts samples taken since the app opened, plus its occupancy rebuilt at 5 min
   *  resolution from the held pipelines (started/finished/engine, ≈ 2 h), its runs, and the
   *  repos it served in the last hour. `id` is an Engine id (a host's history includes its
   *  agents'). Null for an unknown engine. */
  engineHistory(id: string): EngineHistoryView | null {
    const w = this.world;
    const e = w.engines.get(id);
    if (!e) return null;
    const key = `${id}:${w.kv.pipeline}:${w.kv.engine}:${this.engines?.ver ?? 0}:${Math.floor(w.at / 5000)}`;
    if (this.engCache.key === key && this.gWorld === w) return this.engCache.v;
    const names = engineNames(w, e);
    const res = 5 * 60_000;
    const to = Math.ceil(w.at / res) * res, from = to - 24 * res;
    const occ = new Array<number>(24).fill(0);
    const runs: EngineHistoryView['runs'] = [];
    const served = new Map<string, { jobs: number; ms: number }>();
    for (const [pid, p] of w.pipelines) {
      if (!p.started || !p.engine || !names.has(p.engine)) continue;
      const end = p.finished ?? w.at;
      runs.push({ pipeline: pid, repo: p.repo, started: p.started, ...(p.finished ? { finished: p.finished } : {}), state: p.state });
      for (let i = Math.max(0, Math.floor((p.started - from) / res)); i < 24; i++) {
        const lo = from + i * res, hi = lo + res;
        if (lo >= end) break;
        const overlap = Math.min(hi, end) - Math.max(lo, p.started);
        if (overlap > 0) occ[i]! += overlap / res;
      }
      const inHour = Math.min(end, w.at) - Math.max(p.started, w.at - HOUR);
      if (inHour > 0) { const s = served.get(p.repo) ?? { jobs: 0, ms: 0 }; s.jobs++; s.ms += inHour; served.set(p.repo, s); }
    }
    runs.sort((a, b) => b.started - a.started);
    const series = (arr: 'busy' | 'cpu' | 'mem' | 'load'): number[] => {
      const out: number[] = [];
      const s = this.engines?.series.get(id);
      if (!s) return out;
      for (let i = 0; i < s.n; i++) out.push(EngineHistory.at(s, s[arr], i));
      return out;
    };
    const v: EngineHistoryView = {
      id, slots: e.slots, step: STEP, busy: series('busy'), cpu: series('cpu'), mem: series('mem'), load: series('load'),
      res, from, to, occupancy: occ.map((x) => Math.round(x * 100) / 100), runs: runs.slice(0, 200),
      served: [...served.entries()].map(([repo, s]) => ({ repo, jobs: s.jobs, ms: Math.round(s.ms) })).sort((a, b) => b.ms - a.ms || (a.repo < b.repo ? -1 : 1)),
    };
    this.engCache = { key, v };
    return v;
  }

  /** H7: an app's health and deploys over time (client-side on every server version for now):
   *  the health changes the stream reported since the world was loaded, the incidents they
   *  make (an app not up now with no change seen opens one at `checked`), App.checked,
   *  latency and last_deploy, and this app's deploys in the world (24 h). Null when unknown. */
  appHistory(id: string): AppHistoryView | null {
    const w = this.world;
    const a = w.apps.get(id);
    if (!a) return null;
    const transitions = w.health.filter((h) => h.app === id);
    const incidents: AppHistoryView['incidents'] = [];
    let open: { from: number; state: Health } | null = null;
    for (const t of transitions) {
      if (t.to === 'up') { if (open) incidents.push({ from: open.from, to: t.at, state: open.state }); open = null; }
      else if (!open) open = { from: t.at, state: t.to };
      else if (t.to === 'down') open.state = 'down';
    }
    if (open) incidents.push(open);
    else if (a.health !== 'up' && a.health !== 'unknown' && !transitions.length) incidents.push({ from: a.checked, state: a.health });
    const deploys: AppHistoryView['deploys'] = [];
    for (const d of w.deploys.values() as IterableIterator<Deploy>) {
      if (d.app !== id) continue;
      deploys.push({ at: d.started, sha: d.sha, state: d.state, via: d.via, ...(d.finished ? { finished: d.finished } : {}) });
    }
    deploys.sort((x, y) => y.at - x.at);
    return {
      id, health: a.health, checked: a.checked, ...(a.latency_ms !== undefined ? { latency_ms: a.latency_ms } : {}), ...(a.last_deploy ? { last_deploy: a.last_deploy } : {}),
      transitions, incidents, deploys, since: w.loadedAt,
    };
  }

  // ── H6 / H7 from the server (73ef168), else the client seams above ──

  private appHist = new Map<string, { at: number; epoch: number; v: Promise<AppHistoryResult | null> }>();
  private engHist = new Map<string, { at: number; epoch: number; v: Promise<EngineHistoryResult | null> }>();

  /** H7 from the server: `GET /api/v1/app/{id}` (its last ≤ 10 deploys, 7 d of health, time per
   *  state), `source: 'server'`. Where the server has none (404, the demo, an error) the client
   *  seam `appHistory(id)` in the same shape, `source: 'client'`, `complete: false`. Cached per id
   *  for 60 s of the module clock (one fetch in flight per id); null for an app nobody knows. */
  appHistoryAsync(id: string): Promise<AppHistoryResult | null> {
    return cached(this.appHist, id, this.tl, async () => {
      const up = this.upstream();
      if (up?.appHistory) {
        try { const r = await up.appHistory(id); if (r && typeof r === 'object' && Array.isArray(r.deploys)) return { ...r, source: 'server' as const }; } catch { /* the client seam answers */ }
      }
      const v = this.appHistory(id);
      return v ? appDetailOf(v, this.world) : null;
    });
  }

  /** H6 from the server: `GET /api/v1/engine/{id}/history` (24 h, one sample a minute, columnar,
   *  `source: 'server'`). Where the server has none: the client seam `engineHistory(id)` as the
   *  same columns at its 5 min occupancy resolution (≈ 2 h; cpu/mem/load only in the newest
   *  bucket, from the samples since the app opened), `source: 'client'`. Cached 60 s per id. */
  engineHistoryAsync(id: string): Promise<EngineHistoryResult | null> {
    return cached(this.engHist, id, this.tl, async () => {
      const up = this.upstream();
      if (up?.engineHistory) {
        try { const r = await up.engineHistory(id); if (r && typeof r === 'object' && Array.isArray(r.busy)) return { ...r, source: 'server' as const }; } catch { /* the client seam answers */ }
      }
      const v = this.engineHistory(id);
      return v ? engineDocOf(v, this.world) : null;
    });
  }

  // ── the v0.4 approximations, in slices ──

  /** Advances the approximations by one slice (v0.4 only): restarts a job when what it reads
   *  changed (and enough fleet time passed), else continues it. */
  private pump(): void {
    const w = this.world;
    if (w.v05 || !w.loaded) return;
    if (this.tl.clock !== this.pumpClock) { this.pumpClock = this.tl.clock; this.pumps = 0; }
    if (this.pumps >= SLICES_PER_TURN) return;
    this.pumps++;
    if (this.gWorld !== w) { this.gWorld = w; this.floorKey = ''; this.trendKey = ''; this.floorAt = -1e15; this.trendAt = -1e15; this.floorJob = null; this.trendJob = null; }
    const fk = `${w.kv.pipeline}`;
    if (!this.floorJob && fk !== this.floorKey && w.at - this.floorAt >= 2000) {
      this.floorJob = { gen: approxFloor(this, w), key: fk };
      this.floorAt = w.at;
    }
    if (this.floorJob) {
      const r = this.floorJob.gen.next();
      if (r.done) {
        this.floorKey = this.floorJob.key;
        this.floorJob = null;
        const prev = this.floorDone;
        this.floorDone = r.value;
        if (JSON.stringify(prev.sorted) !== JSON.stringify(r.value.sorted)) this.av.clusters++;
        if (JSON.stringify(prev.flakeList) !== JSON.stringify(r.value.flakeList)) this.av.flakes++;
      }
      return; // one slice of one job per call
    }
    const tk = `${w.kv.pipeline}:${w.kv.deploy}:${w.kv.repo}:${w.kv.pr}:${w.kv.stats}`;
    if (!this.trendJob && tk !== this.trendKey && w.at - this.trendAt >= 60_000) {
      this.trendJob = { gen: approxTrends(this, w), key: tk };
      this.trendAt = w.at;
    }
    if (this.trendJob) {
      const r = this.trendJob.gen.next();
      if (r.done) { this.trendKey = this.trendJob.key; this.trendJob = null; this.trendDone = r.value; this.av.trends++; }
    }
  }

  /** v0.4 "since your last visit" (see changesSince). Async: it yields between its passes. */
  private async approxChanges(sinceIn: number, untilIn?: number): Promise<Changes> {
    const w = this.world;
    const now = w.at;
    const floor = now - DAY;
    const until = Math.min(now, untilIn ?? now);
    const complete = sinceIn >= floor;
    const since = Math.min(until, Math.max(sinceIn, floor));
    const inWin = (t: number | undefined) => t !== undefined && t > since && t <= until;
    const counts: ChangeCounts = { red: 0, recovered: 0, still_red: 0, pipelines: 0, failed: 0, deploys: 0, deploys_failed: 0, clusters_new: 0, flakes: 0, prs_merged: 0, apps_down: 0, apps_recovered: 0 };
    const red: Changes['red'] = [], stillRed: Changes['still_red'] = [], recovered: Changes['recovered'] = [];
    const recSeen = new Set<string>();
    for (const e of w.recent) {
      if (e.k === 'main' && !isRedState(e.to) && isRedState(e.from) && inWin(e.at) && !recSeen.has(e.repo)) {
        const r = w.repos.get(e.repo);
        if (r && isRedState(r.main?.state)) continue;
        recSeen.add(e.repo);
        recovered.push({ repo: e.repo, group: this.groupOf(e.repo), at: e.at, red_ms: Math.max(0, e.at - redStart(r, e.at)) });
      }
    }
    let k = 0;
    for (const r of w.repos.values()) {
      if (++k % 200 === 0) await yieldTurn();
      const group = this.groupOf(r.id);
      if (isRedState(r.main?.state)) {
        if (inWin(r.main.since)) {
          const cl = this.culpritCluster(r);
          red.push({ repo: r.id, group, at: r.main.since, ...(r.main.culprit ? { culprit: r.main.culprit } : {}), ...(cl ? { cluster: cl } : {}) });
        } else if (r.main.since <= since) stillRed.push({ repo: r.id, group, since: r.main.since });
        continue;
      }
      if (recSeen.has(r.id)) continue;
      // a red streak in the recent dots that ended inside the window
      let redAt = 0;
      for (const d of r.main?.recent ?? []) {
        if (isRedState(d.state)) { if (!redAt) redAt = d.at; }
        else if (d.state === 'success' && redAt) {
          if (inWin(d.at)) { recovered.push({ repo: r.id, group, at: d.at, red_ms: d.at - redAt }); recSeen.add(r.id); }
          redAt = 0;
        }
      }
    }
    red.sort((a, b) => b.at - a.at || (a.repo < b.repo ? -1 : 1));
    stillRed.sort((a, b) => a.since - b.since || (a.repo < b.repo ? -1 : 1));
    recovered.sort((a, b) => b.at - a.at || (a.repo < b.repo ? -1 : 1));
    await yieldTurn();
    const deploys: Changes['deploys'] = [];
    for (const d of w.deploys.values() as IterableIterator<Deploy>) {
      if ((d.state !== 'success' && d.state !== 'failure') || !inWin(d.finished)) continue;
      counts.deploys++;
      if (d.state === 'failure') counts.deploys_failed++;
      deploys.push({ app: d.app, sha: d.sha, state: d.state, at: d.finished! });
    }
    deploys.sort((a, b) => b.at - a.at);
    const apps: Changes['apps'] = [];
    for (const h of w.health) {
      if (!inWin(h.at)) continue;
      apps.push({ app: h.app, from: h.from, to: h.to, at: h.at });
      if (h.to === 'down') counts.apps_down++;
      if (h.to === 'up' && (h.from === 'down' || h.from === 'degraded')) counts.apps_recovered++;
    }
    apps.reverse();
    for (const p of w.prs.values() as IterableIterator<Pr>) if ((p.phase === 'merged' || p.phase === 'deployed') && inWin(p.merged_at ?? p.updated)) counts.prs_merged++;
    await yieldTurn();
    // pipelines: the held ones; before the oldest of them, one per commit
    const failedBy = new Map<string, number>();
    let oldest = until;
    for (const p of w.pipelines.values()) {
      if (p.created < oldest) oldest = p.created;
      if (!inWin(p.finished)) continue;
      counts.pipelines++;
      if (isRedState(p.state)) { counts.failed++; const g = this.groupOf(p.repo); failedBy.set(g, (failedBy.get(g) ?? 0) + 1); }
    }
    for (const c of w.commits.values()) {
      if (!inWin(c.at) || c.at >= oldest || c.ci === 'pending' || c.ci === 'running' || c.ci === 'none' || c.ci === 'skipped') continue;
      counts.pipelines += Math.max(1, c.pipelines?.length ?? 1);
      if (isRedState(c.ci)) { counts.failed++; const g = this.groupOf(c.repo); failedBy.set(g, (failedBy.get(g) ?? 0) + 1); }
    }
    this.pump();
    const clusters: Changes['clusters'] = [];
    for (const c of this.floorDone.sorted) {
      if (!inWin(c.last_seen)) continue;
      const isNew = c.first_seen > since;
      if (isNew) counts.clusters_new++;
      clusters.push({ id: c.id, count: c.count, new: isNew });
    }
    clusters.sort((a, b) => b.count - a.count || (a.id < b.id ? -1 : 1));
    for (const f of this.floorDone.flakeList) if (inWin(f.last_at)) counts.flakes++;
    const groups: Changes['groups'] = [];
    const gids = new Set<string>([...failedBy.keys(), ...red.map((r) => r.group!)]);
    for (const id of gids) groups.push({ id, failed: failedBy.get(id) ?? 0, red: red.filter((r) => r.group === id).length });
    groups.sort((a, b) => b.red - a.red || b.failed - a.failed || (a.id < b.id ? -1 : 1));
    counts.red = red.length;
    counts.recovered = recovered.length;
    counts.still_red = stillRed.length;
    return { since, until, complete, counts, red, recovered, still_red: stillRed, clusters: clusters.slice(0, 20), deploys: deploys.slice(0, 50), apps, groups };
  }

  private culpritCluster(r: Repo): string | undefined {
    const c = r.main.culprit ? this.world.commits.get(`${r.id}@${r.main.culprit}`) : undefined;
    for (const pid of c?.pipelines ?? []) { const cl = this.clusterOf(pid); if (cl) return cl.id; }
    return undefined;
  }
}

// ───────────────────────────── the v0.4 approximations ─────────────────────────────

type Sig = { step: string; cls: ReturnType<typeof guessClass>; signature: string; id: string };
/** Signatures by (workflow, step, exit code): a fleet's steps repeat a few hundred names. */
const sigMemo = new Map<string, Sig>();
function approxSignature(name: string, wf: string, exit?: number): Sig {
  const key = `${wf}\u0000${name}\u0000${exit ?? ''}`;
  let s = sigMemo.get(key);
  if (s) return s;
  const step = foldStep(name);
  const cls = guessClass(name, wf, exit);
  const signature = signatureOf(step, cls);
  s = { step, cls, signature, id: clusterIdOf(signature) };
  if (sigMemo.size > 4000) sigMemo.clear();
  sigMemo.set(key, s);
  return s;
}

/** Clusters and flakes from the held pipelines, about SLICE pipelines (or entries) a call. */
function* approxFloor(ins: Insights, w: World): Generator<void, ApproxFloor, void> {
  type Acc = { c: Cluster; times: number[]; repoAt: Map<string, number>; ex: { id: string; at: number }[]; flaky: number };
  const acc = new Map<string, Acc>();
  /** `${repo}|${wf}/${folded}` → its newest held run of the step: [at, failed, cluster id]. */
  const latest = new Map<string, [number, boolean, string]>();
  /** `${repo}@${sha}|${wf}/${step}` → [last fail, last pass, the cluster ids of its failures]. */
  const same = new Map<string, [number, number, string[] | null, string, string, string, string]>();
  /** `${repo}|${wf}/${step}` → failed runs. */
  const fails = new Map<string, number>();
  let n = 0;
  for (const [pid, p] of w.pipelines) {
    if (++n % SLICE === 0) yield;
    for (const wf of p.workflows ?? []) for (const st of wf.steps ?? []) {
      const failed = isRedState(st.state);
      if (!failed && st.state !== 'success') continue;
      const at = st.finished ?? p.finished ?? p.created;
      const sig = approxSignature(st.name, wf.name, failed ? st.exit_code : undefined);
      const lk = `${p.repo}|${wf.name}/${sig.step}`;
      const cur = latest.get(lk);
      if (!cur || at >= cur[0]) latest.set(lk, [at, failed, sig.id]);
      const sk = `${p.repo}@${p.sha}|${wf.name}/${st.name}`;
      let ss = same.get(sk);
      if (!ss) same.set(sk, (ss = [0, 0, null, p.repo, p.sha, wf.name, st.name]));
      if (!failed) { ss[1] = Math.max(ss[1], at); continue; }
      ss[0] = Math.max(ss[0], at);
      (ss[2] ??= []).push(sig.id);
      const fk = `${p.repo}|${wf.name}/${st.name}`;
      fails.set(fk, (fails.get(fk) ?? 0) + 1);
      let a = acc.get(sig.id);
      if (!a) {
        a = { c: { id: sig.id, signature: sig.signature, step: sig.step, class: sig.cls, count: 0, count_1h: 0, repos: [], repo_count: 0, groups: [], first_seen: at, last_seen: at, examples: [], open: 0 }, times: [], repoAt: new Map(), ex: [], flaky: 0 };
        acc.set(sig.id, a);
      }
      a.times.push(at);
      if (st.exit_code !== undefined) a.c.exit_code = st.exit_code;
      a.repoAt.set(p.repo, Math.max(at, a.repoAt.get(p.repo) ?? 0));
      a.ex.push({ id: pid, at });
    }
  }
  yield;
  const open = new Map<string, Set<string>>();
  n = 0;
  for (const [lk, [, failed, id]] of latest) {
    if (++n % (SLICE * 8) === 0) yield;
    if (failed) { const s = open.get(id) ?? new Set(); s.add(lk.slice(0, lk.indexOf('|'))); open.set(id, s); }
  }
  const flakes = new Map<string, Flake>();
  n = 0;
  for (const [f, ps, ids, repo, sha, wf, step] of same.values()) {
    if (++n % (SLICE * 8) === 0) yield;
    if (!f || !ps || Math.abs(f - ps) > 6 * HOUR) continue;
    const id = `${repo}|${wf}/${step}`;
    const fl = flakes.get(id) ?? { id, repo, workflow: wf, step, flips_24h: 0, failures_24h: fails.get(id) ?? 0, last_at: 0, shas: [] };
    fl.flips_24h++;
    fl.last_at = Math.max(fl.last_at, f, ps);
    fl.shas = [sha, ...fl.shas].slice(0, 5);
    flakes.set(id, fl);
    for (const cid of ids ?? []) { const a = acc.get(cid); if (a) a.flaky++; }
  }
  yield;
  const out = new Map<string, Cluster>();
  n = 0;
  for (const [id, a] of acc) {
    if (++n % SLICE === 0) yield;
    const repos = [...a.repoAt.entries()].sort((x, y) => y[1] - x[1] || (x[0] < y[0] ? -1 : 1)).map(([r]) => r);
    const groups: string[] = [];
    for (const r of repos) { const g = ins.groupOf(r); if (!groups.includes(g)) groups.push(g); }
    a.times.sort((x, y) => x - y);
    let h1 = 0;
    for (const t of a.times) if (t > w.at - HOUR) h1++;
    const c: Cluster = {
      ...a.c, count: a.times.length, count_1h: h1, repos: repos.slice(0, 12), repo_count: repos.length, groups,
      first_seen: a.times[0]!, last_seen: a.times[a.times.length - 1]!, examples: a.ex.sort((x, y) => y.at - x.at).slice(0, 5).map((e) => e.id),
      open: open.get(id)?.size ?? 0, ...(a.flaky ? { flaky: a.flaky } : {}),
    };
    out.set(id, c);
  }
  yield;
  return { clusters: out, flakes, sorted: [...out.values()].sort(clusterOrder), flakeList: [...flakes.values()].sort(flakeOrder) };
}

/** Trends from what the world holds (see Insights.trend), a slice per collection. */
function* approxTrends(ins: Insights, w: World): Generator<void, Map<string, Trend>, void> {
  const now = w.at;
  const H = Math.floor(now / HOUR);
  type S = { n: number[]; ok: number[]; fail: number[]; run: number[][]; intake: number[][]; dep: number[]; h1: { n: number; ok: number; fail: number; run: number[]; intake: number[]; dep: number }; red: number; ages: number[]; dep24: number; covered: number };
  const mk = (): S => ({ n: new Array(24).fill(0), ok: new Array(24).fill(0), fail: new Array(24).fill(0), run: Array.from({ length: 24 }, () => []), intake: Array.from({ length: 24 }, () => []), dep: new Array(24).fill(0), h1: { n: 0, ok: 0, fail: 0, run: [], intake: [], dep: 0 }, red: 0, ages: [], dep24: 0, covered: 24 });
  const series = new Map<string, S>();
  const both = (repo: string, f: (s: S) => void) => {
    let fs = series.get('fleet');
    if (!fs) series.set('fleet', (fs = mk()));
    f(fs);
    const g = ins.groupOf(repo);
    let gs = series.get(g);
    if (!gs) series.set(g, (gs = mk()));
    f(gs);
  };
  const slot = (t: number) => 23 - (H - Math.floor(t / HOUR));
  let oldest = now, n = 0;
  for (const p of w.pipelines.values()) {
    if (++n % SLICE === 0) yield;
    if (p.created < oldest) oldest = p.created;
    if (p.started && p.created) {
      const i = slot(p.started), dt = Math.max(0, p.started - p.created);
      both(p.repo, (s) => { if (i >= 0 && i < 24) s.intake[i]!.push(dt); if (p.started! > now - HOUR) s.h1.intake.push(dt); });
    }
    if (!p.finished || p.state === 'pending' || p.state === 'running') continue;
    const i = slot(p.finished), ok = p.state === 'success', fail = isRedState(p.state), recent = p.finished > now - HOUR;
    const ms = ok && p.started ? p.finished - p.started : -1;
    both(p.repo, (s) => {
      if (i >= 0 && i < 24) { s.n[i]!++; if (ok) s.ok[i]!++; if (fail) s.fail[i]!++; if (ms >= 0) s.run[i]!.push(ms); }
      if (recent) { s.h1.n++; if (ok) s.h1.ok++; if (fail) s.h1.fail++; if (ms >= 0) s.h1.run.push(ms); }
    });
  }
  yield;
  n = 0;
  for (const d of w.deploys.values() as IterableIterator<Deploy>) {
    if (++n % SLICE === 0) yield;
    if ((d.state !== 'success' && d.state !== 'failure') || !d.finished || d.finished <= now - DAY) continue;
    const i = slot(d.finished), recent = d.finished > now - HOUR;
    both(d.repo, (s) => { if (i >= 0 && i < 24) s.dep[i]!++; s.dep24++; if (recent) s.h1.dep++; });
  }
  for (const r of w.repos.values()) {
    if (++n % SLICE === 0) yield;
    if (isRedState(r.main?.state)) both(r.id, (s) => { s.red++; });
  }
  yield;
  for (const p of w.prs.values() as IterableIterator<Pr>) {
    if (++n % SLICE === 0) yield;
    if (p.bot || p.phase === 'merged' || p.phase === 'closed' || p.phase === 'deployed') continue;
    const age = Math.max(0, now - p.created);
    both(p.repo, (s) => { s.ages.push(age); });
  }
  yield;
  // the hours the held pipelines cover (older slots are null, not zero)
  const firstSlot = Math.max(0, slot(oldest));
  const stats = w.stats;
  const out = new Map<string, Trend>();
  n = 0;
  for (const id of ['fleet', ...ins.groups().map((g) => g.id)]) {
    if (++n % 8 === 0) yield;
    const s = series.get(id) ?? mk();
    const fleet = id === 'fleet';
    const pass = (ok: number, fail: number) => (ok + fail > 0 ? Math.round((ok / (ok + fail)) * 1000) / 1000 : null);
    const spark = (f: (i: number) => number | null, from = firstSlot) => Array.from({ length: 24 }, (_, i) => (i < from ? null : f(i)));
    const h24 = {
      pass: fleet && stats.success_rate_24h ? stats.success_rate_24h : null,
      run: fleet && stats.p50_build_ms ? stats.p50_build_ms : null,
      intake: fleet && stats.p50_queue_ms ? stats.p50_queue_ms : null,
      pipelines: fleet && stats.pipelines_24h ? stats.pipelines_24h / 24 : null,
      deploys: s.dep24 / 24,
    };
    const red = s.red;
    const age = med(s.ages);
    out.set(id, {
      id, at: now,
      intake_ms: metric(med(s.h1.intake), h24.intake, spark((i) => (i === 23 ? med(s.h1.intake) : med(s.intake[i]!))), 'ms', 1),
      run_ms: metric(med(s.h1.run), h24.run, spark((i) => (i === 23 ? med(s.h1.run) : med(s.run[i]!))), 'ms', 1),
      pass_rate: metric(pass(s.h1.ok, s.h1.fail), h24.pass, spark((i) => (i === 23 ? pass(s.h1.ok, s.h1.fail) : pass(s.ok[i]!, s.fail[i]!))), 'pass', -1),
      pipelines: metric(s.h1.n, h24.pipelines, spark((i) => (i === 23 ? s.h1.n : s.n[i]!)), 'rate', 0),
      deploys: metric(s.h1.dep, h24.deploys, spark((i) => (i === 23 ? s.h1.dep : s.dep[i]!), 0), 'rate', 0),
      pr_age_ms: metric(age, null, spark((i) => (i === 23 ? age : null), 23), 'ms', 1),
      red: metric(red, null, spark((i) => (i === 23 ? red : null), 23), 'count', 1),
      hours_7d: 0,
    });
  }
  return out;
}

function metric(h1: number | null, h24: number | null, spark: (number | null)[], kind: 'ms' | 'pass' | 'rate' | 'count', worse: -1 | 0 | 1): Metric {
  const fix = (v: number | null): number | null => (v === null || !Number.isFinite(v) ? null : kind === 'ms' ? Math.round(v / 1000) * 1000 : kind === 'pass' ? Math.round(v * 1000) / 1000 : Math.round(v * 100) / 100);
  const a = fix(h1), b = fix(h24);
  let dir: -1 | 0 | 1 = 0;
  if (a !== null && b !== null) {
    if (kind === 'pass') dir = a - b > 0.03 ? 1 : a - b < -0.03 ? -1 : 0;
    else if (b === 0) dir = a > 0 ? 1 : 0;
    else dir = a > b * 1.15 ? 1 : a < b * 0.85 ? -1 : 0;
  }
  const m: Metric = { h1: a, h24: b, d7: null, dir, spark: spark.map(fix) };
  if (dir !== 0 && worse !== 0 && dir === worse) m.bad = true;
  return m;
}

// ───────────────────────────── helpers ─────────────────────────────

const med = (xs: number[]): number | null => {
  if (!xs.length) return null;
  const s = xs.slice().sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)]!;
};

function groupOrder(a: Group, b: Group): number {
  return b.repos - a.repos || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
}
function flakeOrder(a: Flake, b: Flake): number {
  return b.flips_24h - a.flips_24h || b.last_at - a.last_at || (a.id < b.id ? -1 : 1);
}
function orgRank(id: string): number {
  const i = ORG_ORDER_HUE.indexOf(id.slice(4));
  return i < 0 ? 99 : i;
}

/** The world's apps with their ids (the demo's maps leave `id` to the key; World sets it). */
function appsWithIds(w: World): App[] {
  const out: App[] = [];
  for (const [id, a] of w.apps) out.push(a.id ? a : { ...a, id });
  return out;
}

/** The failed step `step` ("name" or "workflow/name") of a pipeline, else its first failed step. */
function failedStep(p: Pipeline, step?: string): { wf: string; st: Pipeline['workflows'][number]['steps'][number] } | null {
  const slash = step ? step.indexOf('/') : -1;
  const wfName = slash > 0 ? step!.slice(0, slash) : undefined;
  const name = slash > 0 ? step!.slice(slash + 1) : step;
  for (const wf of p.workflows ?? []) {
    if (wfName && wf.name !== wfName) continue;
    for (const st of wf.steps ?? []) {
      if (name && st.name !== name) continue;
      if (isRedState(st.state)) return { wf: wf.name, st };
    }
  }
  return null;
}

/** The names an engine's runs carry in Pipeline.engine: its id, label and its agents'. */
function engineNames(w: World, e: Engine): Set<string> {
  const s = new Set<string>([e.id]);
  if (e.label) s.add(e.label);
  for (const a of e.agents ?? []) { s.add(a); const ae = w.engines.get(a); if (ae?.label) s.add(ae.label); }
  return s;
}

/** When the red streak that ended at `at` began (the main line's dots), else `at`. */
function redStart(r: Repo | undefined, at: number): number {
  let start = at;
  for (const d of r?.main?.recent ?? []) {
    if (d.at > at) break;
    if (isRedState(d.state)) { if (start === at) start = d.at; }
    else if (d.state === 'success' && d.at < at) start = at;
  }
  return start;
}

/** The server's H7 answer, or the client seam's in its shape. */
export type AppHistoryResult = AppDetail & { source: 'server' | 'client' };
/** The server's H6 answer, or the client seam's in its shape. */
export type EngineHistoryResult = EngineHistoryDoc & { source: 'server' | 'client' };

/** Fetch TTL per id (module-clock ms). */
const HIST_TTL = 60_000;

/** One promise per id, kept `HIST_TTL` of the module clock (and only for this timeline epoch);
 *  a failed fetch is forgotten at once. At most 64 ids are kept. */
function cached<T>(m: Map<string, { at: number; epoch: number; v: Promise<T> }>, id: string, tl: Timeline, f: () => Promise<T>): Promise<T> {
  const hit = m.get(id);
  if (hit && hit.epoch === tl.epoch && tl.clock - hit.at < HIST_TTL && tl.clock >= hit.at) return hit.v;
  const v = f();
  m.set(id, { at: tl.clock, epoch: tl.epoch, v });
  v.catch(() => { if (m.get(id)?.v === v) m.delete(id); });
  if (m.size > 64) { const first = m.keys().next().value; if (first !== undefined && first !== id) m.delete(first); }
  return v;
}

/** The client seam's H7 view in the server's shape. */
function appDetailOf(v: AppHistoryView, w: World): AppHistoryResult {
  const health = v.transitions.map((t) => ({ from: t.from, to: t.to, at: t.at })).reverse();
  const ms: Partial<Record<Health, number>> = {};
  let t = w.at, state: Health = v.health;
  for (const h of health) { ms[state] = (ms[state] ?? 0) + Math.max(0, t - Math.max(h.at, v.since)); t = h.at; state = h.from; if (t <= v.since) break; }
  if (t > v.since) ms[state] = (ms[state] ?? 0) + (t - v.since);
  return {
    id: v.id, app: w.apps.get(v.id) ?? null, source: 'client', complete: false, since: v.since, health, health_ms: ms,
    deploys: v.deploys.slice(0, 10).map((d) => ({
      sha: d.sha, via: d.via, state: d.state, started: d.at, at: d.finished ?? d.at,
      ...(d.finished ? { finished: d.finished, duration_ms: Math.max(0, d.finished - d.at) } : {}),
    })),
  };
}

/** The client seam's H6 view in the server's columns (5 min buckets over ≈ 2 h). */
function engineDocOf(v: EngineHistoryView, w: World): EngineHistoryResult {
  const e = w.engines.get(v.id);
  const n = v.occupancy.length;
  const mean = (xs: number[]) => { const ys = xs.filter((x) => Number.isFinite(x)); return ys.length ? Math.round((ys.reduce((a, b) => a + b, 0) / ys.length) * 10) / 10 : null; };
  const col = (last: number | null) => Array.from({ length: n }, (_, i) => (i === n - 1 ? last : null));
  return {
    id: v.id, kind: e?.kind ?? 'wp_agent', ...(e?.host ? { host: e.host } : {}), from: v.from, step_ms: v.res, n, source: 'client',
    busy: v.occupancy.slice(), slots: new Array<number | null>(n).fill(v.slots),
    cpu: col(mean(v.cpu)), mem: col(mean(v.mem)), load: col(mean(v.load)),
    repos: v.served.map((s) => ({ repo: s.repo, runs: s.jobs })),
  };
}

async function yieldTurn(): Promise<void> {
  const s = (globalThis as { scheduler?: { yield?: () => Promise<void> } }).scheduler;
  if (s?.yield) await s.yield();
}

// ───────────────────────────── the module-level seam ─────────────────────────────

let bound: Insights | null = null;

/** Binds the seam to the app's timeline, upstream and engine history (app.ts, once). */
export function bindInsights(tl: Timeline, upstream: () => Upstream | null, engines: EngineHistory | null = null): Insights {
  bound = new Insights(tl, upstream, engines);
  return bound;
}

/** The bound seam (an empty one before app.ts binds it). */
export function insights(): Insights {
  return (bound ??= new Insights(new Timeline()));
}

export const groupOf = (repo: string): string => insights().groupOf(repo);
export const groups = (): Group[] => insights().groups();
export const groupHue = (groupId: string): GroupHue => insights().groupHue(groupId);
export const clusterOf = (pipelineId: string, step?: string): Cluster | null => insights().clusterOf(pipelineId, step);
export const clusters = (): Cluster[] => insights().clusters();
export const flakes = (): Flake[] => insights().flakes();
export const trend = (id: 'fleet' | string): Trend | null => insights().trend(id);
export const changesSince = (ms: number, until?: number): Promise<Changes> => insights().changesSince(ms, until);
export const engineHistory = (id: string): EngineHistoryView | null => insights().engineHistory(id);
export const appHistory = (id: string): AppHistoryView | null => insights().appHistory(id);
export const insightsVer = (table: Table): number => insights().ver(table);
/** H7 from the server's `/api/v1/app/{id}` (60 s cache), else the client seam in its shape. */
export const appHistoryAsync = (id: string): Promise<AppHistoryResult | null> => insights().appHistoryAsync(id);
/** H6 from the server's `/api/v1/engine/{id}/history` (60 s cache), else the client seam in its shape. */
export const engineHistoryAsync = (id: string): Promise<EngineHistoryResult | null> => insights().engineHistoryAsync(id);
