// What the yard shows, computed from the world once per change (not once per frame): the one
// truth about the queue, what is building, the last hour's pulse, the busiest repos, the order
// of the main lines and of the apps, and each station's narrative caption.
//
// Aggregations over every repo and app run time-sliced (`Slicer`): a pass handles a bounded
// number of items per frame, so a large fleet (stress mode's 4,000 repos) never holds the data
// module's thread for longer than a slice, and its buffers are typed arrays, not objects.

import type { App, Pipeline, Repo } from '../wire.ts';
import { BOTS, type World } from '../world.ts';

export function isRed(r: Repo | undefined): boolean {
  const s = r?.main?.state;
  return s === 'failure' || s === 'error';
}

export const ORG_ORDER = ['Northwind-Labs', 'Northwind-EMS', 'Northwind-Forge', 'couplet-physical-ai', 'copper-browser'];

export function orgRank(org: string): number {
  if (org === BOTS) return 100;
  const i = ORG_ORDER.indexOf(org);
  return i < 0 ? 99 : i;
}

export function orgLabel(org: string): string {
  if (org === BOTS) return 'bots';
  const o = org.replace(/^Northwind-/, '');
  if (o === 'couplet-physical-ai') return 'couplet';
  if (o === 'copper-browser') return 'copper';
  return o.toLowerCase();
}

// ---- the queue: one truth ------------------------------------------------------------------

export type QueueTruth = {
  /** Every pipeline waiting for a slot, oldest first (Woodpecker's queue order kept). */
  items: Pipeline[];
  /** By lane, in order. */
  rr: Pipeline[];
  gha: Pipeline[];
  /** How many wait (the queue's own count when it knows more than it lists). */
  waiting: number;
  rrWaiting: number;
  ghaWaiting: number;
  /** When the oldest started waiting (server ms), 0 when none. */
  oldestAt: number;
  /** Ids waiting, for the motion system and the building count. */
  ids: Set<string>;
};

const qCache = new WeakMap<World, { key: number; v: QueueTruth }>();

/**
 * The queue as the yard, the status line and the QUEUE band all show it. Woodpecker can list a
 * pipeline as running while its workflow still waits for an agent (it is in the queue's
 * `items`, on no agent): that pipeline is queued, not building.
 */
export function queueTruth(w: World): QueueTruth {
  const key = w.kv.queue * 100003 + w.kv.pipeline;
  const hit = qCache.get(w);
  if (hit && hit.key === key) return hit.v;
  const ids = new Set<string>();
  const rr: Pipeline[] = [], gha: Pipeline[] = [];
  let rrN = 0, ghaN = 0, oldestAt = 0;
  for (const q of w.queues.values()) {
    const lane = q.id === 'gha' ? gha : rr;
    for (const id of q.items ?? []) {
      const p = w.pipelines.get(id);
      if (!p || ids.has(id)) continue;
      if (p.state !== 'running' && p.state !== 'pending' && p.state !== 'blocked') continue;
      ids.add(id);
      lane.push(p);
    }
    const n = Math.max(q.pending ?? 0, q.items?.length ?? 0);
    if (q.id === 'gha') ghaN += n; else rrN += n;
    if (q.oldest_wait_ms > 0 && (q.pending ?? 0) > 0) {
      const at = w.at - q.oldest_wait_ms;
      if (!oldestAt || at < oldestAt) oldestAt = at;
    }
  }
  // Pending pipelines the queues do not list (GitHub Actions has no queue entity).
  for (const p of w.pipelines.values()) {
    if (p.state !== 'pending' || !p.id || ids.has(p.id)) continue;
    ids.add(p.id);
    if (p.lane === 'gha') { gha.push(p); ghaN = Math.max(ghaN, gha.length); } else { rr.push(p); rrN = Math.max(rrN, rr.length); }
  }
  rr.sort((a, b) => (a.queue_pos ?? 1e9) - (b.queue_pos ?? 1e9) || a.created - b.created);
  gha.sort((a, b) => a.created - b.created);
  const items = rr.concat(gha).sort((a, b) => a.created - b.created);
  for (const p of items) if (!oldestAt || p.created < oldestAt) oldestAt = p.created;
  const v: QueueTruth = { items, rr, gha, waiting: Math.max(rrN + ghaN, items.length), rrWaiting: Math.max(rrN, rr.length), ghaWaiting: Math.max(ghaN, gha.length), oldestAt, ids };
  qCache.set(w, { key, v });
  return v;
}

/** A wait longer than this is stuck (DESIGN.md: flagged red). */
export const STUCK_MS = 3_600_000;

// ---- building --------------------------------------------------------------------------------

const bCache = new WeakMap<World, { key: number; v: Set<string> }>();

/** Pipelines running on a slot right now: on an agent, or a GitHub Actions run; never one
 *  the queue still holds. */
export function buildingIds(w: World): Set<string> {
  const key = (w.kv.engine * 100003 + w.kv.pipeline) * 31 + w.kv.queue;
  const hit = bCache.get(w);
  if (hit && hit.key === key) return hit.v;
  const q = queueTruth(w).ids;
  const out = new Set<string>();
  for (const e of w.engines.values()) for (const id of e.running) if (!q.has(id) && w.pipelines.get(id)?.state === 'running') out.add(id);
  for (const p of w.pipelines.values()) if (p.state === 'running' && p.lane === 'gha' && p.id && !q.has(p.id)) out.add(p.id);
  if (!w.engines.size) for (const p of w.pipelines.values()) if (p.state === 'running' && p.id && !q.has(p.id)) out.add(p.id);
  bCache.set(w, { key, v: out });
  return out;
}

// ---- the last hour ---------------------------------------------------------------------------

export type Pulse = {
  ok: Uint16Array; bad: Uint16Array; max: number; total: number; failed: number; p50: number;
  minute: number; key: number;
};
const pulse: Pulse = { ok: new Uint16Array(60), bad: new Uint16Array(60), max: 0, total: 0, failed: 0, p50: 0, minute: -1, key: -1 };
const durs = new Float64Array(4096);

/** Pipelines finished per minute over the last hour (bucket 59 = the current minute). */
export function lastHour(w: World, now: number): Pulse {
  const minute = Math.floor(now / 60_000);
  const key = w.kv.pipeline * 7919 + minute;
  if (pulse.key === key) return pulse;
  pulse.ok.fill(0); pulse.bad.fill(0);
  let total = 0, failed = 0, nd = 0;
  const start = (minute - 59) * 60_000;
  for (const p of w.pipelines.values()) {
    const f = p.finished;
    if (!f || f < start || f > now + 60_000) continue;
    const b = Math.min(59, Math.max(0, Math.floor((f - start) / 60_000)));
    if (p.state === 'failure' || p.state === 'error') { pulse.bad[b]++; failed++; }
    else if (p.state === 'success') pulse.ok[b]++;
    else continue;
    total++;
    if (p.started && nd < durs.length) durs[nd++] = f - p.started;
  }
  let max = 1;
  for (let i = 0; i < 60; i++) max = Math.max(max, pulse.ok[i] + pulse.bad[i]);
  const d = durs.subarray(0, nd).sort();
  pulse.p50 = nd ? d[nd >> 1] : 0;
  pulse.max = max; pulse.total = total; pulse.failed = failed; pulse.minute = minute; pulse.key = key;
  return pulse;
}

/** Pushes per minute over the last hour for one org (bucket 59 = now). */
const sparks = new Map<string, { key: number; v: Uint8Array }>();
export function orgSpark(w: World, org: string, now: number): Uint8Array {
  const minute = Math.floor(now / 60_000);
  const key = w.kv.commit * 7919 + minute + w.ver * 0;
  let s = sparks.get(org);
  if (s && s.key === key) return s.v;
  if (!s) { s = { key: -1, v: new Uint8Array(60) }; sparks.set(org, s); }
  s.v.fill(0);
  const start = (minute - 59) * 60_000;
  for (const at of w.pushes.get(org) ?? []) {
    if (at < start) continue;
    const b = Math.min(59, Math.floor((at - start) / 60_000));
    if (s.v[b] < 255) s.v[b]++;
  }
  s.key = key;
  return s.v;
}

export type Busy = { repo: string; name: string; n: number; red: number; running: number };
let busyCache: { key: number; v: Busy[] } = { key: -1, v: [] };

/** The repos that ran the most pipelines in the last hour. */
export function busiest(w: World, now: number, n: number): Busy[] {
  const minute = Math.floor(now / 60_000);
  const key = (w.kv.pipeline * 7919 + minute) * 64 + n;
  if (busyCache.key === key) return busyCache.v;
  const by = new Map<string, Busy>();
  const since = now - 3_600_000;
  for (const p of w.pipelines.values()) {
    const t = p.finished ?? p.started ?? p.created;
    if (t < since && p.state !== 'running') continue;
    let b = by.get(p.repo);
    if (!b) { b = { repo: p.repo, name: w.repos.get(p.repo)?.name ?? p.repo.split('/')[1] ?? p.repo, n: 0, red: 0, running: 0 }; by.set(p.repo, b); }
    b.n++;
    if (p.state === 'failure' || p.state === 'error') b.red++;
    if (p.state === 'running') b.running++;
  }
  const v = Array.from(by.values()).sort((a, b) => b.n - a.n || b.red - a.red || a.name.localeCompare(b.name)).slice(0, n);
  busyCache = { key, v };
  return v;
}

// ---- repos and apps: sliced passes -----------------------------------------------------------

/** A main line's state class for the heatmap and the tiers. */
export const S_NONE = 0, S_GREEN = 1, S_RED = 2, S_RUN = 3, S_PEND = 4, S_STALE = 5;

export function stateClass(r: Repo): number {
  const s = r.main?.state;
  if (s === 'failure' || s === 'error') return S_RED;
  if (s === 'running') return S_RUN;
  if (s === 'pending' || s === 'blocked') return S_PEND;
  if (s === 'success') return S_GREEN;
  return S_NONE;
}

export type RepoAgg = {
  /** Every repo in a stable order: org (fleet order), then name. */
  ids: string[];
  state: Uint8Array;
  /** [org, start, end) runs over `ids`. */
  orgs: { org: string; start: number; end: number; red: number }[];
  /** Main lines by attention: current reds (hottest first), building, then by heat. */
  ranked: string[];
  red: number;
  green: number;
  oldestRed: number;
  ver: number;
  /** Reds younger than a day (the main lines' LOD0 tier). */
  fresh: number;
  /** Repos worth a row: reds, building, or any heat. */
  hot: number;
  /** A hash of `state`: the heatmap redraws only when a cell's colour changed. */
  sig: number;
};

/** A red younger than this is a current streak. */
export const FRESH_MS = 86_400_000;

export type AppAgg = {
  /** Apps by attention: down, degraded, unknown, behind main, then up by last deploy. */
  ids: string[];
  health: Uint8Array;
  up: number;
  problems: string[];
  ver: number;
};

/** One unit of time-sliced work: `step(n)` handles up to n items and says whether it is done. */
interface Job { step(n: number): boolean }

export class Slicer {
  private q: Job[] = [];
  /** Items per frame (a slice): 400 repos is well under a millisecond on Hermes. */
  perFrame = 400;
  add(j: Job): void { this.q.push(j); }
  get busy(): boolean { return this.q.length > 0; }
  pump(): void {
    let left = this.perFrame;
    while (left > 0 && this.q.length) {
      const j = this.q[0];
      if (j.step(left)) this.q.shift();
      left -= this.perFrame; // one job per slice
    }
  }
  /** Runs every queued job to completion (a first frame must show something). */
  drain(): void { while (this.q.length) if (this.q[0].step(1e9)) this.q.shift(); }
}

export class Aggregates {
  repos: RepoAgg = { ids: [], state: new Uint8Array(0), orgs: [], ranked: [], red: 0, green: 0, oldestRed: 0, ver: -1, fresh: 0, hot: 0, sig: 0 };
  apps: AppAgg = { ids: [], health: new Uint8Array(0), up: 0, problems: [], ver: -1 };
  private repoWant = -1;
  private appWant = -1;
  private world: World | null = null;
  readonly slicer = new Slicer();

  /** Queues a pass for whatever changed; `pump` (once per frame) does a slice of the work. */
  update(w: World): void {
    if (w !== this.world) { this.world = w; this.repoWant = -1; this.appWant = -1; }
    const rv = w.kv.repo + w.kv.org * 7;
    if (rv !== this.repoWant) { this.repoWant = rv; this.slicer.add(this.repoJob(w, rv)); }
    const av = w.kv.app * 31 + w.kv.deploy;
    if (av !== this.appWant) { this.appWant = av; this.slicer.add(this.appJob(w, av)); }
  }

  pump(first: boolean): void {
    if (first || this.repos.ver < 0 || this.apps.ver < 0) this.slicer.drain();
    else this.slicer.pump();
  }

  private repoJob(w: World, ver: number): Job {
    let list: Repo[] | null = null;
    let i = 0;
    let state: Uint8Array;
    let red = 0, green = 0, oldestRed = 0;
    return {
      step: (n) => {
        if (!list) {
          list = Array.from(w.repos.values()).sort((a, b) => orgRank(a.org) - orgRank(b.org) || a.org.localeCompare(b.org) || a.name.localeCompare(b.name));
          state = new Uint8Array(list.length);
        }
        const end = Math.min(list.length, i + n);
        for (; i < end; i++) {
          const r = list[i];
          const s = stateClass(r);
          // A red older than a day is wallpaper, not news: the heatmap dims it.
          state[i] = s === S_RED && w.at - r.main.since >= FRESH_MS ? S_STALE : s;
          if (s === S_RED) { red++; if (!oldestRed || r.main.since < oldestRed) oldestRed = r.main.since; }
          else if (s === S_GREEN) green++;
        }
        if (i < list.length) return false;
        const ids = list.map((r) => r.id);
        const orgs: RepoAgg['orgs'] = [];
        for (let k = 0; k < list.length; k++) {
          const o = list[k].org;
          const last = orgs[orgs.length - 1];
          const isR = state[k] === S_RED || state[k] === S_STALE ? 1 : 0;
          if (!last || last.org !== o) orgs.push({ org: o, start: k, end: k + 1, red: isR });
          else { last.end = k + 1; last.red += isR; }
        }
        // Fresh reds (the current streaks people work on) first, then what is building, then
        // by heat; reds older than a day sit after the hot lines (they are not news).
        const now = w.at;
        let fresh = 0, hot = 0;
        const score = (r: Repo) => {
          const s = stateClass(r), heat = r.heat ?? 0;
          if (s === S_RED && now - r.main.since < FRESH_MS) return 5e6 + heat * 1e3 + Math.max(0, 1 - (now - r.main.since) / FRESH_MS);
          if (s === S_RUN || s === S_PEND) return 4e6 + heat * 1e3;
          if (heat > 0) return 3e6 + heat * 1e3;
          if (s === S_RED) return 2e6 + r.main.since / 1e13;
          return 1e6 + (r.last_activity ?? 0) / 1e13;
        };
        const scores = new Map<string, number>();
        for (const r of list) {
          const sc = score(r);
          scores.set(r.id, sc);
          if (sc >= 5e6) fresh++;
          if (sc >= 2e6) hot++;
        }
        const ranked = list.slice().sort((a, b) => scores.get(b.id)! - scores.get(a.id)! || a.id.localeCompare(b.id)).map((r) => r.id);
        let sig = list.length;
        for (let k = 0; k < state.length; k++) sig = (Math.imul(sig, 31) + state[k] * (k + 1)) | 0;
        this.repos = { ids, state, orgs, ranked, red, green, oldestRed, ver, fresh, hot, sig };
        return true;
      },
    };
  }

  private appJob(w: World, ver: number): Job {
    let done = false;
    return {
      step: () => {
        if (done) return true;
        const rank = (a: App) => (a.health === 'down' ? 0 : a.health === 'degraded' ? 1 : a.health === 'unknown' ? 2 : (a.behind ?? 0) > 0 ? 3 : 4);
        const deployedAt = (a: App) => (a.last_deploy ? w.deploys.get(a.last_deploy.id)?.started ?? 0 : 0);
        const list = Array.from(w.apps.values()).sort((a, b) => rank(a) - rank(b) || deployedAt(b) - deployedAt(a) || String(a.id).localeCompare(String(b.id)));
        const health = new Uint8Array(list.length);
        let up = 0;
        const problems: string[] = [];
        list.forEach((a, i) => {
          health[i] = a.health === 'up' ? (a.behind ?? 0) > 0 ? 4 : 0 : a.health === 'degraded' ? 1 : a.health === 'down' ? 2 : 3;
          if (a.health === 'up') up++;
          else if (a.health === 'down' || a.health === 'degraded') problems.push(String(a.id));
        });
        this.apps = { ids: list.map((a) => String(a.id)), health, up, problems, ver };
        done = true;
        return true;
      },
    };
  }
}

// ---- narrative ---------------------------------------------------------------------------------

export type Run = readonly [string, string, boolean?];

/** "1,513" */
export function thousands(n: number): string {
  const s = String(Math.round(n));
  return s.length > 3 ? `${s.slice(0, -3)},${s.slice(-3)}` : s;
}

/** The main line's story in words, from its state (never a fixed sentence). */
export function mainStory(r: Repo, now: number, fmt: (ms: number) => string): { text: string; tone: 'red' | 'green' | 'amber' | 'gray'; fix: string } {
  const m = r.main;
  const rec = m?.recent ?? [];
  if (!m) return { text: 'no main line yet', tone: 'gray', fix: '' };
  if (m.state === 'failure' || m.state === 'error') {
    const c = m.culprit ? rec.find((d) => d.sha === m.culprit) : undefined;
    const since = rec.filter((d) => d.at > (c?.at ?? m.since)).length;
    return { text: `red ${fmt(now - m.since)}${c ? ` · culprit ${c.sha.slice(0, 7)} by ${c.author.replace(/\[bot\]$/, '')}` : ''}${since ? ` · ${since} since` : ''}`, tone: 'red', fix: 'fix forward' };
  }
  if (m.state === 'running' || m.state === 'pending') return { text: `building ${m.head.slice(0, 7)}`, tone: 'amber', fix: '' };
  let lastRed = -1;
  for (let i = rec.length - 1; i >= 0; i--) if (rec[i].state === 'failure' || rec[i].state === 'error') { lastRed = i; break; }
  if (lastRed >= 0 && lastRed < rec.length - 1) {
    const fix = rec[lastRed + 1];
    return { text: `green since ${fmt(now - fix.at)} · fixed by ${fix.sha.slice(0, 7)}`, tone: 'green', fix: fix.sha };
  }
  if (m.state === 'success') return { text: `green · ${rec.length} commits, none red`, tone: 'green', fix: '' };
  return { text: m.state === 'none' ? 'no checks on main' : m.state, tone: 'gray', fix: '' };
}
