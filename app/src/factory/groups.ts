// GROUP IDENTITY ON THE FLOOR (fab-w2; FACTORY-SPEC §C). Every group the floor shows, its lane,
// its colour and its numbers, from ONE source: src/insights.ts (`groupOf`, `groups`, `groupHue`,
// `trend`), which serves the server's v0.5 tables and approximates them on v0.4.
//
//   lanes        the floor's group lanes, back → front: the hued teams (slot order: the four
//                biggest by apps), "other teams" (every folded team), the orgs (labs, forge,
//                ems, couplet, copper, then any other), and the bots siding last. Frozen for the
//                session like the hues: a new group folds or appends, nobody moves.
//   laneOf…      repo / group / PR / pipeline / commit → its lane ('bots' for bot authors).
//   stats        per-lane aggregates for the floor (pushes/h, open PRs by phase and per PR-yard
//                stack, running and queued jobs, red mains, failures in the last hour, apps up and
//                down, the lane's trend), counted in slices of SLICE entities, one slice a turn.
//   paint        groupStripe / groupEdge / compositionStripe / hatch / plateTint: the same hue on
//                every stage (dock roof → stack stripes → bay stripes → district plates).
//
// Nothing here fetches; nothing here walks the fleet in one turn.

import type { Cam } from './iso.ts';
import type { Gfx } from '../yard/gfx.ts';
import type { App, Commit, Metric, Pipeline, Pr, Trend } from '../wire.ts';
import type { World } from '../world.ts';
import { BOTS } from '../world.ts';
import { BOTS_HUE, OTHER_HUE, insights, type GroupHue } from '../insights.ts';
import { normTeam, teamGroupId } from '../../server/floor.ts';
import { AGES, HOUR, phaseRow } from './census.ts';
import { failuresOf, trendOfLane } from './trendmarks.ts';
import { baseline } from './agg/baseline.ts';

/** The lane every folded team shares. */
export const OTHER_LANE = 'other';
/** The bots siding (§C): bot PRs, commits and pipelines, one by one. */
export const BOTS_LANE = 'bots';

export type LaneKind = 'team' | 'org' | 'other' | 'bots';
export type Lane = {
  /** A Group id ('team:software', 'org:Northwind-Labs'), OTHER_LANE or BOTS_LANE. */
  id: string;
  /** 0 = the back lane; bots last. */
  index: number;
  kind: LaneKind;
  /** 'Software', 'Northwind-Labs', 'other teams', 'bots'. */
  name: string;
  /** ≤ 11 characters, lower case: the floor's label ('software', 'labs', 'other teams'); a key
   *  too (district names, lens titles), so an org that shares a team's name says so ('ems org'). */
  short: string;
  /** The name alone ('ems' for both the team and the org): `groupLabel` puts the kind's mark on it. */
  bare: string;
  hue: GroupHue;
  /** The Group ids folded into this lane (one for a hued group; none for bots). */
  members: string[];
  /** From the Group table: repos, apps, red mains now. */
  repos: number; apps: number; red: number;
};

/** Per-lane numbers for the floor (FACTORY-SPEC §C/§E). */
export type LaneStats = {
  id: string;
  /** Commits pushed in the last hour (bots' in the bots lane). */
  pushes1h: number;
  /** Open PRs by the PR yard's rows (draft, checks, review, approved); bot PRs in the bots lane. */
  prs: [number, number, number, number];
  prsOpen: number;
  /** Open stale PRs (idle > 72 h). */
  stale: number;
  running: number; queued: number;
  /** Repos whose main line is red now; of them, red for less than an hour (a fresh red). */
  redMains: number; freshRed: number;
  /** Pipelines finished in the last hour, and of them failed. */
  finished1h: number; failures1h: number;
  apps: number; appsUp: number; appsDegraded: number; appsDown: number;
  repos: number;
  /** The lane's trend: its group's (v0.5: the server's; v0.4: insights' approximation), "other
   *  teams" merged from its members' (trendmarks.mergeTrends), null for bots. */
  trend: Trend | null;
  /** Pushes per hour over the last 24 h, oldest first, from the commits the world holds (no
   *  server sends a push trend): the baseline ring's seed and the dock's ghost. */
  pushSpark: number[];
};

export type GroupCounts = {
  /** Lane stats by lane id, in lane order. */
  lanes: Map<string, LaneStats>;
  /** Open non-bot PRs per PR-yard stack (row × age bucket) and lane: stack[r][b] → lane → n. */
  stacks: Map<string, number>[][];
  /** The world time the count was taken at. */
  at: number;
};

const SHORT_ORG: Record<string, string> = {
  'Northwind-Labs': 'labs', 'Northwind-EMS': 'ems', 'Northwind-Forge': 'forge', 'couplet-physical-ai': 'couplet', 'copper-browser': 'copper',
};
const BOT_RE = /bot\b|\[bot\]|dependabot|renovate|autofix/i;

/** Entities one slice of the count reads (~0.1 ms in Bun). */
const SLICE = 160;

/** A bot author (§C: the bots siding takes them one by one). */
export function isBot(author: string | undefined, bot?: boolean): boolean {
  return !!bot || (!!author && BOT_RE.test(author));
}

export class Groups {
  private laneList: Lane[] = [];
  private laneKey = '';
  private laneVer = '';
  /** Lane ids in the order first seen this session (frozen order). */
  private order: string[] = [];
  private laneOfGroupMap = new Map<string, string>();
  private job: Generator<void, GroupCounts, void> | null = null;
  private done: GroupCounts = { lanes: new Map(), stacks: emptyStacks(), at: 0 };
  private jobVer = -1;
  private jobAt = -1e15;
  private jobWorld: World | null = null;
  private stepClock = NaN;
  /** Bumps when a count completes (painters key their caches on it). */
  ver = 0;

  get world(): World { return insights().world; }

  // ── lanes ──

  /** The floor's lanes, back → front (bots last). Recomputed when the group table changes; the
   *  order of lanes already seen never changes in a session. */
  lanes(): Lane[] {
    const ins = insights();
    const ver = `${ins.tl.epoch}:${ins.ver('groups')}:${ins.world.groups.size}:${ins.world.kv.app ?? 0}`;
    if (ver === this.laneVer && this.laneList.length) return this.laneList;
    this.laneVer = ver;
    const gs = ins.groups();
    const key = `${ins.tl.epoch}:${gs.map((g) => `${g.id}.${g.repos}.${g.apps}.${g.red}`).join('|')}`;
    if (key === this.laneKey && this.laneList.length) return this.laneList;
    this.laneKey = key;
    const byLane = new Map<string, Lane>();
    this.laneOfGroupMap.clear();
    for (const g of gs) {
      const h = ins.groupHue(g.id);
      const lid = h.folded ? OTHER_LANE : g.id;
      this.laneOfGroupMap.set(g.id, lid);
      let l = byLane.get(lid);
      if (!l) {
        const kind: LaneKind = lid === OTHER_LANE ? 'other' : g.kind === 'team' ? 'team' : 'org';
        const short = lid === OTHER_LANE ? 'other teams' : shortOf(g.id, g.name);
        l = { id: lid, index: 0, kind, name: lid === OTHER_LANE ? 'other teams' : g.name, short, bare: short, hue: lid === OTHER_LANE ? OTHER_HUE : h, members: [], repos: 0, apps: 0, red: 0 };
        byLane.set(lid, l);
      }
      l.members.push(g.id);
      l.repos += g.repos; l.apps += g.apps; l.red += g.red;
    }
    byLane.set(BOTS_LANE, { id: BOTS_LANE, index: 0, kind: 'bots', name: 'bots', short: 'bots', bare: 'bots', hue: BOTS_HUE, members: [], repos: 0, apps: 0, red: 0 });
    // the frozen order: lanes seen before keep their places; new ones are ranked in
    const fresh = [...byLane.values()].filter((l) => !this.order.includes(l.id)).sort(laneRank);
    if (fresh.length) {
      const all = [...this.order.map((id) => byLane.get(id)).filter((l): l is Lane => !!l), ...fresh];
      // the first time (or a new world): the spec's order outright; later: append before bots
      this.order = this.order.length ? [...this.order.filter((id) => id !== BOTS_LANE), ...fresh.map((l) => l.id).filter((id) => id !== BOTS_LANE), BOTS_LANE] : all.sort(laneRank).map((l) => l.id);
    }
    this.laneList = this.order.map((id) => byLane.get(id)).filter((l): l is Lane => !!l);
    this.laneList.forEach((l, i) => { l.index = i; });
    // a team and an org of one name ('ems'): the org's label says so
    const teamShort = new Set(this.laneList.filter((l) => l.kind === 'team').map((l) => l.short));
    for (const l of this.laneList) if (l.kind === 'org' && teamShort.has(l.short)) l.short = `${l.short} org`;
    return this.laneList;
  }

  lane(id: string): Lane | undefined { return this.lanes().find((l) => l.id === id); }

  /** The lane of a Group id (a folded team: "other teams"). */
  laneOfGroup(groupId: string): string {
    if (groupId === BOTS_LANE) return BOTS_LANE;
    this.lanes();
    const l = this.laneOfGroupMap.get(groupId);
    if (l) return l;
    return insights().groupHue(groupId).folded ? OTHER_LANE : groupId;
  }

  /** The lane of a repo (its group's). */
  laneOfRepo(repo: string): string { return this.laneOfGroup(insights().groupOf(repo)); }
  /** A PR's lane: the bots siding for a bot's, else its repo's. */
  laneOfPr(p: Pr): string { return isBot(p.author, p.bot) ? BOTS_LANE : this.laneOfRepo(p.repo); }
  /** A pipeline's lane: the bots siding for a bot's run, else its repo's. */
  laneOfPipeline(p: Pipeline): string { return isBot(p.author) ? BOTS_LANE : this.laneOfRepo(p.repo); }
  /** A commit's lane. */
  laneOfCommit(c: Commit): string { return isBot(c.author, c.bot) ? BOTS_LANE : this.laneOfRepo(c.repo); }

  /** A lane's identity colour (hex). */
  hex(laneId: string): string { return laneId === BOTS_LANE ? BOTS_HUE.hex : laneId === OTHER_LANE ? OTHER_HUE.hex : insights().groupHue(laneId).hex; }

  // ── aggregates ──

  /** The last complete count; advances the next one by one slice per module-clock turn (a new
   *  count starts when the world changed and 2 s of fleet time passed). */
  counts(): GroupCounts {
    const ins = insights(), w = ins.world;
    if (!w.loaded) return this.done;
    const clock = ins.tl.clock;
    if (clock === this.stepClock) return this.done;
    this.stepClock = clock;
    if (this.jobWorld !== w) { this.jobWorld = w; this.job = null; this.jobVer = -1; this.jobAt = -1e15; }
    if (!this.job && w.ver !== this.jobVer && (w.at - this.jobAt >= 2000 || w.at < this.jobAt)) {
      this.jobVer = w.ver; this.jobAt = w.at;
      this.job = this.count(w, ins.tl.playhead || w.at);
    }
    if (this.job) {
      const r = this.job.next();
      if (r.done) { this.job = null; this.done = r.value; this.ver++; this.observe(r.value); }
    }
    return this.done;
  }

  private seeded = new Set<string>();
  private seededEpoch = -1;

  /** Feeds the persisted hourly ring (agg/baseline.ts) from a live count: per lane and for the
   *  fleet, pipelines finished, failures and red mains in the last hour, and pushes; the first
   *  time a key is seen, its 24 h sparks seed the hours the ring has not seen. */
  private observe(c: GroupCounts): void {
    const ins = insights();
    if (ins.tl.mode !== 'live' || !(c.at > 0)) return;
    if (this.seededEpoch !== ins.tl.epoch) { this.seededEpoch = ins.tl.epoch; this.seeded.clear(); }
    const b = baseline();
    const tot = { pipelines: 0, failures: 0, red: 0, pushes: 0 };
    const pushes = new Array<number>(24).fill(0);
    const seed = (key: string, t: Trend | null, push: number[]) => {
      if (this.seeded.has(key)) return;
      this.seeded.add(key);
      b.seed(key, 'pushes', push, c.at);
      if (t) { b.seed(key, 'pipelines', t.pipelines.spark, c.at); b.seed(key, 'failures', failuresOf(t).spark, c.at); b.seed(key, 'red', t.red.spark, c.at); }
    };
    for (const s of c.lanes.values()) {
      seed(s.id, s.trend, s.pushSpark);
      b.record(s.id, 'pipelines', c.at, s.finished1h);
      b.record(s.id, 'failures', c.at, s.failures1h);
      b.record(s.id, 'red', c.at, s.redMains);
      b.record(s.id, 'pushes', c.at, s.pushes1h);
      tot.pipelines += s.finished1h; tot.failures += s.failures1h; tot.red += s.redMains; tot.pushes += s.pushes1h;
      s.pushSpark.forEach((x, i) => { pushes[i] += x; });
    }
    seed('fleet', ins.trend('fleet'), pushes);
    for (const k of ['pipelines', 'failures', 'red', 'pushes'] as const) b.record('fleet', k, c.at, tot[k]);
    b.maybeSave(ins.tl.clock);
  }

  /** Runs the count to completion now (tests and tools only: O(fleet) in one go). */
  settle(): GroupCounts {
    for (let i = 0; i < 100_000 && (this.job || this.ver === 0); i++) { this.stepClock = NaN; this.counts(); if (!this.job && this.ver > 0) break; }
    return this.done;
  }

  stats(laneId: string): LaneStats | undefined { return this.counts().lanes.get(laneId); }

  private *count(w: World, now: number): Generator<void, GroupCounts, void> {
    const lanes = this.lanes();
    const out = new Map<string, LaneStats>();
    for (const l of lanes) out.set(l.id, emptyStats(l.id));
    const at = (id: string) => { let s = out.get(id); if (!s) out.set(id, (s = emptyStats(id))); return s; };
    const stacks = emptyStacks();
    let n = 0;
    for (const r of w.repos.values()) {
      if (++n % SLICE === 0) yield;
      const s = at(this.laneOfRepo(r.id));
      s.repos++;
      const st = r.main?.state;
      if (st === 'failure' || st === 'error') { s.redMains++; if (now - (r.main.since || 0) < HOUR) s.freshRed++; }
    }
    for (const c of w.commits.values()) {
      if (++n % SLICE === 0) yield;
      if (c.at > now || c.at <= now - 24 * HOUR) continue;
      const s = at(this.laneOfCommit(c));
      if (c.at > now - HOUR) s.pushes1h++;
      // by clock hour, the hour of `now` last (the trends' spark convention)
      const k = 23 - (Math.floor(now / HOUR) - Math.floor(c.at / HOUR));
      if (k >= 0) s.pushSpark[k]!++;
    }
    for (const p of w.prs.values() as IterableIterator<Pr>) {
      if (++n % SLICE === 0) yield;
      const row = phaseRow(p);
      if (row < 0) continue;
      const lid = this.laneOfPr(p);
      const s = at(lid);
      s.prs[row]++; s.prsOpen++;
      if (p.stale_ms) s.stale++;
      if (lid === BOTS_LANE) continue;
      const age = Math.max(0, now - p.created);
      let b = 0;
      while (age >= AGES[b]!) b++;
      const m = stacks[row]![b]!;
      m.set(lid, (m.get(lid) ?? 0) + 1);
    }
    for (const p of w.pipelines.values()) {
      if (++n % SLICE === 0) yield;
      const s = at(this.laneOfPipeline(p));
      if (p.state === 'running') s.running++;
      else if (p.state === 'pending') s.queued++;
      if (p.finished && p.finished > now - HOUR && p.finished <= now && p.state !== 'canceled' && p.state !== 'skipped') {
        s.finished1h++;
        if (p.state === 'failure' || p.state === 'error') s.failures1h++;
      }
    }
    for (const a of w.apps.values() as IterableIterator<App>) {
      if (++n % SLICE === 0) yield;
      const gid = appGroup(a, w);
      if (!gid) continue;
      const s = at(this.laneOfGroup(gid));
      s.apps++;
      if (a.health === 'up') s.appsUp++; else if (a.health === 'degraded') s.appsDegraded++; else if (a.health === 'down') s.appsDown++;
    }
    yield;
    for (const l of lanes) at(l.id).trend = trendOfLane(l);
    return { lanes: out, stacks, at: now };
  }
}

/** The mark an org-fallback group carries in words (fx-lanes, overseer note 8): a team keeps its
 *  bare name, a group that is an org because its repos have no app team reads '◇ ems'. The
 *  legend explains it (legend.ts). */
export const ORG_MARK = '◇';

/** A lane's name as people read it: '◇ ems' for an org lane, else its name ('ems', 'other
 *  teams', 'bots'). The floor draws the mark dim (a glyph, not a run: labels.ts). */
export function groupLabel(l: Pick<Lane, 'kind' | 'bare' | 'short'>): string {
  return l.kind === 'org' ? `${ORG_MARK} ${l.bare}` : l.short;
}

/** A lane's rank in the §C order: hued teams by slot, other teams, orgs by slot, bots. */
function laneRank(a: Lane, b: Lane): number {
  return rank(a) - rank(b) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}
function rank(l: Lane): number {
  if (l.kind === 'bots') return 10_000;
  if (l.kind === 'other') return 1_000;
  const slot = l.hue.slot < 0 ? 99 : l.hue.slot;
  // a team after the four blues may borrow an org slot: still a team lane, before "other teams"
  return l.kind === 'team' ? slot : 2_000 + slot;
}

function shortOf(id: string, name: string): string {
  if (id.startsWith('org:')) { const o = id.slice(4); return SHORT_ORG[o] ?? o.toLowerCase().replace(/^northwind-/, '').slice(0, 11); }
  const s = (id.startsWith('team:') ? id.slice(5) : name).toLowerCase();
  return s.length <= 11 ? s : s.split(/[-\s]/)[0]!.slice(0, 11);
}

function emptyStats(id: string): LaneStats {
  return {
    id, pushes1h: 0, prs: [0, 0, 0, 0], prsOpen: 0, stale: 0, running: 0, queued: 0, redMains: 0, freshRed: 0, finished1h: 0, failures1h: 0,
    apps: 0, appsUp: 0, appsDegraded: 0, appsDown: 0, repos: 0, trend: null, pushSpark: new Array<number>(24).fill(0),
  };
}

function emptyStacks(): Map<string, number>[][] {
  return [0, 1, 2, 3].map(() => AGES.map(() => new Map<string, number>()));
}

/** An app's group: its team's ('team:<slug>'), else its repo's group. */
function appGroup(a: App, w: World): string {
  const t = normTeam(a.team);
  if (t) return teamGroupId(t);
  return a.repo && w.repos.has(a.repo) ? insights().groupOf(a.repo) : '';
}

// ── the module-level seam ──

let bound: Groups | null = null;
/** The session's groups (one per data module). */
export function floorGroups(): Groups { return (bound ??= new Groups()); }

export const lanes = (): Lane[] => floorGroups().lanes();
export const laneOfRepo = (repo: string): string => floorGroups().laneOfRepo(repo);
export const laneOfGroup = (groupId: string): string => floorGroups().laneOfGroup(groupId);
export const laneHex = (laneId: string): string => floorGroups().hex(laneId);
export const groupCounts = (): GroupCounts => floorGroups().counts();
export { BOTS };
export type { Metric };
