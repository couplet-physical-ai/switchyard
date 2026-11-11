// WHAT EACH TEAM LANE CARRIES (fab-w1; FACTORY-SPEC §B, §C): per group lane, the four PR-yard
// cells (open PRs by phase: count, CI-failing, conflicted, waiting on checks, stale, by age), the
// signal posts (one per active repo, red first), the main-line cars (the lane's newest merged
// commits), merges and the repos ranked by activity (the repo level's sub-rows), plus the bots
// siding's pallets (per bot: PRs, repos touched, stale, failing). Counted from the world in
// slices (SLICE entities a turn, one slice per census check), the floor draws the last complete
// count. Lanes come from groups.ts (floorGroups: one lane per hued group, "other teams", bots).

import type { Pr, Repo } from '../wire.ts';
import type { World } from '../world.ts';
import { AGES, HOUR, phaseRow } from './census.ts';
import { BOTS_LANE, floorGroups, isBot } from './groups.ts';

export type Cell = {
  n: number;
  /** CI failing (the red top), conflicted (the crack), waiting on checks (the amber rim), stale */
  red: number; conflict: number; checks: number; stale: number;
  /** the oldest PR's age (ms) and the count per age bucket (census AGES) */
  oldest: number; ages: number[];
};
/** A repo's main line as a signal post: st 0 red, 1 running, 2 ok, 3 unknown. */
export type Post = { repo: string; name: string; st: number; since: number; head: string };
export type LaneCar = { sha: string; repo: string; at: number; state: string; culprit: boolean; title: string };
/** A repo of the lane, for its sub-row at group zoom (§F): PRs by phase, its post, its main dots,
 *  and its open PRs one by one (`items`: row | age bucket << 2 | flags << 5, flags PR_RED, PR_CHECKS,
 *  PR_STALE, PR_CONFLICT; at most ITEMS a repo, the oldest kept). fx-lanes: `score` ranks the rows
 *  by activity (open PRs, the day's main-line commits, a red or running main). */
export type LaneRepo = { repo: string; name: string; score: number; prs: [number, number, number, number]; red: number; post: Post; dots: { state: string; culprit: boolean }[]; items: number[]; day: number; recent: boolean };
export const PR_RED = 1, PR_CHECKS = 2, PR_STALE = 4, PR_CONFLICT = 8;
/** A sub-row's PRs at most (more: the oldest, which matter most, are kept). */
const ITEMS = 48;
export type Pallet = { bot: string; n: number; repos: number; stale: number; red: number };

export type LaneInfo = {
  id: string;
  cells: [Cell, Cell, Cell, Cell];
  /** red first (newest red first), then running, then ok by recency */
  posts: Post[];
  red: number;
  /** fx-lanes: of the red mains, those red for less than an hour (the buffer stop's bright
   *  notches) */
  fresh: number;
  cars: LaneCar[];
  merges1h: number;
  /** merges in the last 24 h, newest last (the gate lintel's ticks) */
  merges24: number;
  repos: LaneRepo[];
  /** the approach road: its repos' pushes per hour over 24 h (oldest first) and main-line runs
   *  that failed per hour */
  push24: Int16Array; fail24: Int16Array;
};

/** The back wall's boards: the fleet's last 24 h per hour (oldest first), one series per stage. */
export type Wall = {
  /** 01 pushes (commits) */ pushes: Int16Array;
  /** 02 PRs opened, and of them CI failing now */ opened: Int16Array; openedRed: Int16Array;
  /** 03–04 main-line commits landed, and of them failed */ landed: Int16Array; landedRed: Int16Array;
  /** 05–06 runs finished, and of them failed (07) */ runs: Int16Array; runsRed: Int16Array;
  /** 08 deploys, and of them failed */ deploys: Int16Array; deploysRed: Int16Array;
};

export type LaneCount = { lanes: Map<string, LaneInfo>; pallets: Pallet[]; wall: Wall; at: number; ver: number };

const h24 = (): Int16Array => new Int16Array(24);
function wall(): Wall { return { pushes: h24(), opened: h24(), openedRed: h24(), landed: h24(), landedRed: h24(), runs: h24(), runsRed: h24(), deploys: h24(), deploysRed: h24() }; }
/** The hour slot (0 = 24 h ago … 23 = this hour) of a time, -1 outside the day. */
const slotOf = (now: number, t: number): number => (t > now || t <= now - DAY ? -1 : 23 - Math.min(23, Math.floor((now - t) / HOUR)));

/** Entities one slice reads. */
const SLICE = 180;
const DAY = 24 * HOUR;

function cell(): Cell { return { n: 0, red: 0, conflict: 0, checks: 0, stale: 0, oldest: 0, ages: AGES.map(() => 0) }; }

export function botName(a: string): string {
  const s = (a ?? '').toLowerCase();
  if (s.includes('dependabot')) return 'dependabot';
  if (s.includes('renovate')) return 'renovate';
  if (s.includes('autofix')) return 'autofix';
  if (s.includes('woodpecker')) return 'woodpecker';
  return s.replace(/\[bot\]$/, '').replace(/^northwind-/, '');
}

function postOf(r: Repo): Post {
  const s = r.main?.state;
  const st = s === 'failure' || s === 'error' ? 0 : s === 'running' || s === 'pending' ? 1 : s === 'success' ? 2 : 3;
  return { repo: r.id, name: r.name, st, since: r.main?.since ?? 0, head: r.main?.head ?? '' };
}

export class LaneData {
  private job: Generator<void, LaneCount, void> | null = null;
  private done: LaneCount = { lanes: new Map(), pallets: [], wall: wall(), at: 0, ver: 0 };
  private jobVer = -1;
  private jobAt = -1e15;
  private jobWorld: World | null = null;
  /** Bumps with every complete count. */
  ver = 0;

  /** The last complete count; advances the next by one slice (a new one starts when the world
   *  changed and 2 s of fleet time passed). */
  step(w: World, now: number): LaneCount {
    if (!w.loaded) return this.done;
    if (this.jobWorld !== w) { this.jobWorld = w; this.job = null; this.jobVer = -1; this.jobAt = -1e15; }
    if (!this.job && w.ver !== this.jobVer && (now - this.jobAt >= 2000 || now < this.jobAt)) {
      this.jobVer = w.ver; this.jobAt = now;
      this.job = this.count(w, now);
    }
    if (this.job) {
      const r = this.job.next();
      if (r.done) { this.job = null; this.done = { ...r.value, ver: ++this.ver }; }
    }
    return this.done;
  }

  get last(): LaneCount { return this.done; }

  /** The count now, in one go (tests and tools). */
  settle(w: World, now: number): LaneCount {
    this.jobVer = -1; this.jobAt = -1e15; this.job = null;
    for (let i = 0; i < 100_000; i++) { this.step(w, now); if (!this.job) break; }
    return this.done;
  }

  private *count(w: World, now: number): Generator<void, LaneCount, void> {
    const G = floorGroups();
    const lanes = G.lanes();
    const out = new Map<string, LaneInfo>();
    const info = (id: string): LaneInfo => {
      let l = out.get(id);
      if (!l) out.set(id, (l = { id, cells: [cell(), cell(), cell(), cell()], posts: [], red: 0, fresh: 0, cars: [], merges1h: 0, merges24: 0, repos: [], push24: h24(), fail24: h24() }));
      return l;
    };
    for (const l of lanes) info(l.id);
    const repoAt = new Map<string, LaneRepo>();
    const laneOfRepo = new Map<string, string>();
    const W = wall();
    let n = 0;
    // repos: posts, cars, the sub-rows' rows
    for (const r of w.repos.values()) {
      if (++n % SLICE === 0) yield;
      const lid = G.laneOfRepo(r.id);
      laneOfRepo.set(r.id, lid);
      const L = info(lid);
      const post = postOf(r);
      const recent = r.main?.recent ?? [];
      const last = recent.length ? recent[recent.length - 1]!.at : 0;
      const activeAt = Math.max(last, r.last_activity ?? 0);
      if (post.st === 0) { L.red++; if (now - post.since < HOUR) L.fresh++; }
      if (post.st <= 1 || activeAt >= now - 7 * DAY) L.posts.push(post);
      let dayCars = 0;
      for (const d of recent) {
        if (d.at > now || d.at < now - DAY) continue;
        dayCars++;
        const k = slotOf(now, d.at);
        if (k >= 0) { W.landed[k]++; if (d.state === 'failure' || d.state === 'error') { W.landedRed[k]++; L.fail24[k]++; } }
        L.cars.push({ sha: d.sha, repo: r.id, at: d.at, state: d.state, culprit: !!d.culprit, title: d.title });
      }
      const lr: LaneRepo = { repo: r.id, name: r.name, score: 0, prs: [0, 0, 0, 0], red: 0, post, dots: recent.slice(-12).map((d) => ({ state: d.state, culprit: !!d.culprit })), items: [], day: dayCars, recent: activeAt >= now - DAY };
      repoAt.set(r.id, lr);
      L.repos.push(lr);
    }
    // PRs: the cells (bots: the pallets), merges
    const bots = new Map<string, Pallet & { set: Set<string> }>();
    for (const p of w.prs.values() as IterableIterator<Pr>) {
      if (++n % SLICE === 0) yield;
      const ko = slotOf(now, p.created);
      if (ko >= 0) { W.opened[ko]++; if (p.ci === 'failure' || p.ci === 'error') W.openedRed[ko]++; }
      if (p.merged_at && p.merged_at <= now && p.merged_at > now - DAY) {
        const L = info(laneOfRepo.get(p.repo) ?? G.laneOfRepo(p.repo));
        L.merges24++;
        if (p.merged_at > now - HOUR) L.merges1h++;
      }
      const row = phaseRow(p);
      if (row < 0) continue;
      const stale = !!p.stale_ms;
      const red = p.ci === 'failure' || p.ci === 'error';
      if (isBot(p.author, p.bot)) {
        const name = botName(p.author);
        let b = bots.get(name);
        if (!b) bots.set(name, (b = { bot: name, n: 0, repos: 0, stale: 0, red: 0, set: new Set() }));
        b.n++; b.set.add(p.repo);
        if (stale) b.stale++;
        if (red) b.red++;
        const C = info(BOTS_LANE).cells[row];
        C.n++; if (red) C.red++; if (stale) C.stale++;
        continue;
      }
      const lid = laneOfRepo.get(p.repo) ?? G.laneOfRepo(p.repo);
      const C = info(lid).cells[row];
      const age = Math.max(0, now - p.created);
      let b = 0;
      while (b < AGES.length - 1 && age >= AGES[b]!) b++;
      C.n++; C.ages[b]!++;
      if (red) C.red++;
      if (p.phase === 'conflict') C.conflict++;
      if (p.phase === 'checks' || p.ci === 'running' || p.ci === 'pending') C.checks++;
      if (stale) C.stale++;
      if (age > C.oldest) C.oldest = age;
      const lr = repoAt.get(p.repo);
      if (lr) {
        lr.prs[row]++; if (red) lr.red++;
        const fl = (red ? PR_RED : 0) | (p.phase === 'checks' || p.ci === 'running' || p.ci === 'pending' ? PR_CHECKS : 0) | (stale ? PR_STALE : 0) | (p.phase === 'conflict' ? PR_CONFLICT : 0);
        lr.items.push(row | (b << 2) | (fl << 5));
      }
    }
    // the day's pushes (per lane: its approach road), runs and deploys (the back wall)
    for (const c of w.commits.values()) {
      if (++n % SLICE === 0) yield;
      const k = slotOf(now, c.at);
      if (k < 0) continue;
      W.pushes[k]++;
      const lid = laneOfRepo.get(c.repo);
      if (lid) info(lid).push24[k]++;
    }
    for (const p of w.pipelines.values()) {
      if (++n % SLICE === 0) yield;
      const k = p.finished ? slotOf(now, p.finished) : -1;
      if (k < 0) continue;
      W.runs[k]++;
      if (p.state === 'failure' || p.state === 'error') W.runsRed[k]++;
    }
    for (const d of w.deploys.values()) {
      if (++n % SLICE === 0) yield;
      const k = slotOf(now, d.started);
      if (k < 0) continue;
      W.deploys[k]++;
      if (d.state === 'failure') W.deploysRed[k]++;
    }
    yield;
    // order: posts red first (newest red first), then running, ok, unknown by recency; cars by
    // time (the newest 18); repos by activity
    for (const L of out.values()) {
      L.posts.sort((a, b) => a.st - b.st || (a.st === 0 ? b.since - a.since : b.since - a.since));
      L.cars.sort((a, b) => a.at - b.at);
      if (L.cars.length > 18) L.cars = L.cars.slice(-18);
      // fx-lanes: the busiest first (§F "top 12 by activity"): open PRs, the day's main-line
      // commits, a red main (it must show) or a running one
      for (const r of L.repos) {
        const open = r.prs[0] + r.prs[1] + r.prs[2] + r.prs[3];
        r.score = 2 * Math.min(open, 24) + 3 * Math.min(r.day, 12) + (r.post.st === 0 ? 14 : r.post.st === 1 ? 4 : 0) + (r.recent ? 2 : 0);
        if (r.items.length > ITEMS) { r.items.sort((a, b) => (b >> 2 & 7) - (a >> 2 & 7)); r.items.length = ITEMS; }
      }
      L.repos.sort((a, b) => b.score - a.score || (a.name < b.name ? -1 : 1));
    }
    const pallets = [...bots.values()].sort((a, b) => b.n - a.n).slice(0, 4).map(({ set, ...p }) => ({ ...p, repos: set.size }));
    return { lanes: out, pallets, wall: W, at: now, ver: 0 };
  }
}
