// Switchyard mock fleet simulation: seeded, deterministic, discrete 100 ms ticks.
// PURE + PORTABLE: no Bun/Node APIs, no wall clock, no Math.random, no timers. Time is always
// passed in (`advanceTo(ms)` / `step(ms)`); the caller owns I/O. The same code runs in Bun
// (server/mock.ts) and inside the client's data module for an offline demo.
//
// Every state change marks (kind, id) dirty; a frame flush emits one `upsert` (or `remove`)
// per dirty entity, then the tick's transient events — so the contract reducer
// (server/reduce.ts) applied to any checkpoint reproduces `snapshot()` exactly.

import type {
  App, CiState, Commit, Deploy, DeployVia, Engine, Event, Frame, Health, History, Journey, Kind,
  Pipeline, Pr, PrDetail, PrPhase, Queue, Repo, SearchResults, DemoSnapshot as Snapshot, Step, Workflow,
} from '../src/wire.ts';
import { FrameLog, historyJson } from './history.ts';
import * as N from './names.ts';
import { ACTIVE, newPr, prOnPipeline, prPhase, prPush, wave } from './prs.ts';
import { seedFleet, seedFleetSteps } from './seed.ts';
import { Agenda, DAY, HOUR, MIN, SEC, TICK, clamp, diurnal, makeRng, median, round2, type Rng } from './util.ts';
import { journeyOf, prDetailOf, searchFleet } from './views.ts';

export const PROTOCOL = '0';
export { TICK };
const PEAK_PER_MS = 1 / 5000; // ~1 commit / 5 s fleet-wide at daytime peak

export type SimOptions = {
  epoch: number; seed?: number; warmupMs?: number; historyMs?: number; ringFrames?: number;
  checkpointMs?: number; maxCommits?: number;
  /** The in-app demo: keep no frame log and no checkpoints (no history, no resume); a
   *  caller takes frames with advanceTo as they are made. Small enough for a 64 MiB heap. */
  lite?: boolean;
  /** Do not run the warm-up in the constructor: the caller runs it with `warm`, in slices. */
  deferWarmup?: boolean;
};
export type Lane = 'roadrunner' | 'gha';
type DirtyKind = Kind | 'stats';

export type RepoX = {
  r: Repo; idx: number; w: number; tier: 0 | 1 | 2; size: number; sec: boolean; appId?: string;
  via: DeployVia; wpNum: number; ghaNum: number; prNum: number; mainCount: number;
  ord: Map<string, number>; settledOrd: number; pushes: number[]; prs: PrX[];
};
export type PipeX = {
  id: string; p: Pipeline; rx: RepoX; commitId: string; isMain: boolean; ord: number;
  outcome: CiState; fail?: [number, number]; deployFail?: [number, number]; readyAt: number;
  dur: number[][]; cached: boolean[][]; prX?: PrX; deployWf: number; deployVia?: DeployVia;
  deployId?: string; done: boolean;
};
export type PrX = {
  id: string; pr: Pr; rx: RepoX; commits: string[]; pipelines: string[];
  timeline: { at: number; phase: PrPhase; note?: string }[]; gen: number; lastCi: CiState; branch: string;
};
export type AppX = {
  id: string; a: App; rx: RepoX; baseLat: number; pinned: boolean;
  samples: { at: number; health: Health; latency_ms?: number }[];
};
type PipeRec = { t: number; s: CiState; q: number; b: number };

const COLL: Record<string, keyof Snapshot> = {
  org: 'orgs', repo: 'repos', commit: 'commits', pipeline: 'pipelines', pr: 'prs', deploy: 'deploys',
  app: 'apps', engine: 'engines', queue: 'queues', lane: 'lanes',
};
const isTerminal = (s: CiState): boolean => s !== 'pending' && s !== 'running';
const ms100 = (s: number): number => Math.max(TICK, Math.round((s * SEC) / TICK) * TICK);

export class Sim {
  readonly seed: number;
  readonly epoch: number;
  readonly t0: number;
  readonly rng: Rng;
  now: number;
  seq = 0;
  k = 0;
  state: Snapshot;
  log: FrameLog;
  agenda = new Agenda();
  repos: RepoX[] = [];
  repoById = new Map<string, RepoX>();
  cum = new Float64Array(0);
  apps: AppX[] = [];
  appById = new Map<string, AppX>();
  appSlots: AppX[][] = [];
  pipes = new Map<string, PipeX>();
  prs = new Map<string, PrX>();
  queues: Record<Lane, PipeX[]> = { roadrunner: [], gha: [] };
  running: Record<Lane, number> = { roadrunner: 0, gha: 0 };
  archCommits = new Map<string, Commit>();
  archPipes = new Map<string, Pipeline>();
  archDeploys = new Map<string, Deploy>();
  archPrs = new Map<string, PrX>();
  mergedFrom = new Map<string, PrX>();
  recCommits: number[] = [];
  recPipes: PipeRec[] = [];
  recDeploys: number[] = [];
  preCum = new Float64Array(1441);
  openPrs = 0;
  ghaRun = 18_400_000_000;
  nextWave = 0;
  nextTrip = 0;
  tripEnd = 0;
  nextIncident = 0;
  private dirty = new Map<string, [DirtyKind, string]>();
  private events: string[] = [];
  private queueDirty: Record<Lane, boolean> = { roadrunner: true, gha: true };
  private readonly ckptMs: number;
  private readonly maxCommits: number;
  private readonly lite: boolean;
  private snapCache = { key: '', json: '' };

  constructor(o: SimOptions) {
    this.seed = o.seed ?? 7;
    this.epoch = o.epoch;
    this.t0 = o.epoch - (o.warmupMs ?? HOUR);
    this.now = this.t0;
    this.rng = makeRng(this.seed * 2654435761 + 1);
    this.ckptMs = o.checkpointMs ?? 10 * MIN;
    this.maxCommits = o.maxCommits ?? 3000;
    this.lite = !!o.lite;
    this.log = new FrameLog(Math.max(o.historyMs ?? 2 * HOUR, o.warmupMs ?? HOUR), o.ringFrames ?? 20000);
    this.state = {
      protocol: PROTOCOL, seq: 0, at: this.t0, orgs: {}, repos: {}, commits: {}, pipelines: {}, prs: {},
      deploys: {}, apps: {}, engines: {}, queues: {}, lanes: {}, watcher: { id: 'outage', tripped: false, gh_status: 'operational' },
      stats: { commits_24h: 0, pipelines_24h: 0, success_rate_24h: 0, p50_queue_ms: 0, p50_build_ms: 0, deploys_24h: 0, apps_up: 0, apps_down: 0, prs_open: 0 },
    };
    for (let i = 0; i < 1440; i++) this.preCum[i + 1] = this.preCum[i]! + PEAK_PER_MS * diurnal(this.t0 - DAY + i * MIN) * MIN;
    // A deferred warm-up seeds in steps too: `warm` runs them first, one per call.
    if (o.deferWarmup) { this.seeding = seedFleetSteps(this); return; }
    seedFleet(this);
    this.seeded();
    this.warm(Infinity);
  }

  private seeding: Generator<void, void, void> | null = null;
  private needSeeded = false;
  private seeded(): void {
    this.computeStats();
    this.dirty.clear();
    this.events.length = 0;
    this.checkpoint();
  }

  /** Runs up to `sliceMs` more of the warm-up; true once the simulation has reached its epoch. */
  warm(sliceMs: number): boolean {
    if (this.seeding) {
      // the stats and the first checkpoint get a call of their own
      if (this.seeding.next().done) this.seeding = null, this.needSeeded = true;
      return false;
    }
    if (this.needSeeded) { this.needSeeded = false; this.seeded(); return false; }
    if (this.now < this.epoch) this.step(Math.min(this.epoch, this.now + sliceMs), false);
    if (this.lite) this.log.drop();
    return this.now + TICK > this.epoch;
  }

  /** The store itself (the in-app demo shares it instead of copying a snapshot). */
  liveState(): Snapshot {
    this.state.seq = this.seq;
    this.state.at = this.now;
    return this.state;
  }

  // ───────────────────────────── public API ─────────────────────────────

  /** Runs the simulation up to `ms`; returns how many frames were produced. */
  step(ms: number, coalesce = true): number {
    const before = this.seq;
    while (this.now + TICK <= ms) {
      this.tick();
      if (!coalesce) this.flush();
      if (this.now - this.lastCkpt >= this.ckptMs) { this.flush(); this.checkpoint(); }
    }
    this.flush();
    return this.seq - before;
  }
  /** Runs to `ms` (coalesced) and returns the produced frames as objects. */
  advanceTo(ms: number): Frame[] {
    const from = this.seq;
    this.collecting = true;
    this.step(ms);
    this.collecting = false;
    const out = (this.log.since(from, this.seq) ?? []).map((j) => JSON.parse(j) as Frame);
    if (this.lite) this.log.drop();
    return out;
  }
  /** Frames after `since` (JSON strings), or null → client must reset. */
  framesSince(since: number): string[] | null { return this.log.since(since, this.seq); }
  heartbeat(): Frame { return { t: 'hb', seq: this.seq, at: this.now }; }
  snapshotJson(): string {
    const key = `${this.seq}:${this.now}`;
    if (this.snapCache.key !== key) {
      this.state.seq = this.seq;
      this.state.at = this.now;
      this.snapCache = { key, json: JSON.stringify(this.state) };
    }
    return this.snapCache.json;
  }
  snapshot(): Snapshot { return JSON.parse(this.snapshotJson()) as Snapshot; }
  historyJson(from: number, to: number): string { return historyJson(this.log.window(from, to, this.now)); }
  history(from: number, to: number): History { return JSON.parse(this.historyJson(from, to)) as History; }
  journey(repo: string, sha: string): Journey | null { return journeyOf(this, repo, sha); }
  prDetail(repo: string, number: number): PrDetail | null { return prDetailOf(this, repo, number); }
  search(q: string): SearchResults { return searchFleet(this, q); }
  get historyStart(): number { return this.log.oldestAt; }
  get frameBytes(): number { return this.log.bytes; }

  /** One frame of `n` synthetic transient events (pushes + steps) for client coalescing tests. */
  burst(n = 1000): number {
    const running = [...this.pipes.values()].filter((px) => px.p.state === 'running');
    for (let i = 0; i < n; i++) {
      if (i % 2 === 1 && running.length) {
        const px = this.rng.pick(running);
        const wf = this.rng.pick(px.p.workflows);
        const st = this.rng.pick(wf.steps);
        this.ev({ k: 'step', pipeline: px.id, workflow: wf.name, step: st.name, state: this.rng.chance(0.5) ? 'running' : 'success', at: this.now });
      } else {
        const rx = this.repos[this.rng.weighted(this.cum)]!;
        const author = this.rng.pick(N.HUMANS);
        this.ev({ k: 'push', repo: rx.r.id, sha: this.rng.hex(40), branch: rx.r.default_branch, author, title: N.commitTitle(author, this.rng), at: this.now });
      }
    }
    const s = this.seq;
    this.flush();
    return this.seq - s;
  }

  // ───────────────────────────── frame plumbing ─────────────────────────────

  private lastCkpt = 0;
  /** advanceTo is gathering frames: a lite sim keeps its log until it hands them over. */
  private collecting = false;
  private checkpoint(): void {
    this.state.seq = this.seq;
    this.state.at = this.now;
    this.log.checkpoint(this.seq, this.now, this.lite ? '' : JSON.stringify(this.state));
    if (this.lite && !this.collecting) this.log.drop();
    this.lastCkpt = this.now;
  }
  mark(kind: DirtyKind, id: string): void {
    const key = kind + '\u0000' + id;
    if (!this.dirty.has(key)) this.dirty.set(key, [kind, id]);
  }
  ev(e: Event): void { this.events.push(JSON.stringify({ op: 'event', e })); }
  private lookup(kind: DirtyKind, id: string): unknown {
    if (kind === 'watcher') return this.state.watcher;
    if (kind === 'stats') return this.state.stats;
    return (this.state[COLL[kind]!] as Record<string, unknown>)[id];
  }
  private flush(): void {
    for (const lane of ['roadrunner', 'gha'] as const) if (this.queueDirty[lane]) this.refreshQueue(lane);
    if (!this.dirty.size && !this.events.length) return;
    const parts: string[] = [];
    for (const [kind, id] of this.dirty.values()) {
      const v = this.lookup(kind, id);
      const head = `{"op":"${v === undefined ? 'remove' : 'upsert'}","kind":"${kind}","id":${JSON.stringify(id)}`;
      parts.push(v === undefined ? head + '}' : `${head},"v":${JSON.stringify(v)}}`);
    }
    for (const e of this.events) parts.push(e);
    this.dirty.clear();
    this.events.length = 0;
    this.seq++;
    this.log.push(this.seq, this.now, `{"t":"delta","seq":${this.seq},"at":${this.now},"ops":[${parts.join(',')}]}`);
  }

  // ───────────────────────────── the tick ─────────────────────────────

  private tick(): void {
    this.now += TICK;
    this.k++;
    const now = this.now;
    while (this.agenda.peek() <= now) this.agenda.pop()!();
    if (this.rng() < PEAK_PER_MS * diurnal(now) * TICK) this.arrival();
    if (now >= this.nextWave) wave(this);
    if (now >= this.nextTrip) this.trip();
    if (this.tripEnd && now >= this.tripEnd) this.untrip();
    if (now >= this.nextIncident) this.incident();
    for (const ax of this.appSlots[this.k % 600] ?? []) this.healthCheck(ax);
    this.dispatch();
    if (this.k % 50 === 0) for (const lane of ['roadrunner', 'gha'] as const) if (this.queues[lane].length) this.queueDirty[lane] = true;
    if (this.k % 50 === 0) this.engineMetrics();
    if (this.k % 100 === 0) this.computeStats();
    if (this.k % 600 === 0) this.prune();
    if (this.k % 3000 === 0) this.staleSweep();
  }

  pickAuthor(main: boolean): string {
    const r = this.rng();
    if (main) return r < 0.72 ? this.rng.pick(N.HUMANS) : r < 0.84 ? 'phi-agent[bot]' : r < 0.9 ? 'copilot-swe[bot]' : r < 0.95 ? 'autofix[bot]' : 'renovate[bot]';
    return r < 0.75 ? this.rng.pick(N.HUMANS) : r < 0.87 ? 'renovate[bot]' : r < 0.95 ? 'phi-agent[bot]' : 'copilot-swe[bot]';
  }

  private arrival(): void {
    const rx = this.repos[this.rng.weighted(this.cum)]!;
    const pNew = clamp(0.035 * (1 + (150 - this.openPrs) / 40), 0.004, 0.15);
    const r = this.rng();
    if (r < pNew) { newPr(this, rx, this.pickAuthor(false)); return; }
    const wip = rx.prs.filter((p) => p.pr.phase === 'draft' || p.pr.phase === 'checks');
    if (r < pNew + 0.18 && wip.length) { prPush(this, this.rng.pick(wip)); return; }
    const author = this.pickAuthor(true);
    this.push(rx, rx.r.default_branch, author, N.commitTitle(author, this.rng));
  }

  // ───────────────────────────── commits & pipelines ─────────────────────────────

  push(rx: RepoX, branch: string, author: string, title: string, prX?: PrX, sha = this.rng.hex(40)): string {
    const now = this.now;
    const bot = author.endsWith('[bot]');
    const repo = rx.r.id;
    const id = `${repo}@${sha}`;
    const c: Commit = { repo, sha, branch, title, author, ...(bot ? { bot } : {}), at: now, ...(prX ? { pr: prX.pr.number } : {}), stage: 'pushed', ci: 'pending', pipelines: [] };
    this.state.commits[id] = c;
    this.mark('commit', id);
    this.recCommits.push(now);
    this.ev({ k: 'push', repo, sha, branch, author, ...(bot ? { bot } : {}), title, at: now });
    const isMain = branch === rx.r.default_branch;
    let ord = 0;
    const skip = rx.r.lane === 'none' || this.rng.chance(0.15);
    if (isMain) {
      ord = ++rx.mainCount;
      rx.ord.set(sha, ord);
      if (rx.ord.size > 400) rx.ord.delete(rx.ord.keys().next().value!);
      const m = rx.r.main;
      m.recent.push({ sha, at: now, state: skip ? (rx.r.lane === 'none' ? 'none' : 'skipped') : 'pending', author, ...(bot ? { bot } : {}), title });
      if (m.recent.length > 40) m.recent.shift();
      m.head = sha;
      if (rx.appId) {
        const a = this.appById.get(rx.appId)!.a;
        a.main_sha = sha;
        a.behind = (a.behind ?? 0) + 1;
        this.mark('app', rx.appId);
      }
    }
    rx.pushes.push(now);
    while (rx.pushes.length && rx.pushes[0]! < now - HOUR) rx.pushes.shift();
    rx.r.heat = round2(clamp(rx.r.heat * 0.9 + 0.1 * clamp(0.15 + rx.pushes.length / 8, 0, 1), 0.01, 1));
    this.mark('repo', repo);
    if (skip) {
      c.ci = rx.r.lane === 'none' ? 'none' : 'skipped';
      c.stage = 'done';
    } else {
      const delay = this.rng.int(3, 20) * TICK;
      this.agenda.add(now + delay, () => this.enqueue(rx, id, isMain, ord, prX));
    }
    return id;
  }

  laneFor(rx: RepoX): Lane {
    switch (rx.r.lane) {
      case 'gha_first': return this.state.watcher.tripped ? 'roadrunner' : 'gha';
      case 'ci': case 'ci_only': return 'gha';
      default: return 'roadrunner';
    }
  }

  /** Workflow plan: names, durations (ms), cache hits, and the deploy workflow if any. */
  plan(rx: RepoX, isMain: boolean, lane: Lane): { wfs: Workflow[]; dur: number[][]; cached: boolean[][]; deployWf: number; deployVia?: DeployVia } {
    const r = this.rng;
    const sz = lane === 'gha' ? rx.size * 0.6 : rx.size; // GHA lanes are the small, light repos
    const wfs: Workflow[] = [];
    const dur: number[][] = [];
    const cached: boolean[][] = [];
    const add = (name: string, steps: [string, number, boolean][]): void => {
      wfs.push({ name, state: 'pending', steps: steps.map(([n]) => ({ name: n, state: 'pending' } as Step)) });
      dur.push(steps.map(([, d]) => ms100(d)));
      cached.push(steps.map(([, , c]) => c));
    };
    const depsC = r.chance(0.45);
    const buildC = r.chance(0.2);
    add('ci', [
      ['clone', r.range(2, 6), false],
      ['deps', depsC ? r.range(1, 3) : clamp(r.range(5, 40) * sz, 5, 40), depsC],
      ['build', buildC ? r.range(3, 12) : clamp((20 + 180 * r() ** 2.5) * sz, 20, 200), buildC],
      ['test', clamp((15 + 285 * r() ** 3) * sz, 15, 300), false],
      ['lint', r.range(3, 12), false],
    ]);
    if (rx.sec) add('security', [['gitleaks', r.range(3, 12), false], ['osv', r.range(5, 25), r.chance(0.3)]]);
    let deployWf = -1;
    let deployVia: DeployVia | undefined;
    if (isMain && rx.appId) {
      deployVia = rx.via === 'roadrunner' && r.chance(0.03) ? 'gha_fallback' : rx.via;
      if ((deployVia === 'roadrunner' && lane === 'roadrunner') || (deployVia === 'gha' && lane === 'gha')) {
        deployWf = wfs.length;
        add('deploy', [['publish', r.range(10, 40), r.chance(0.3)], ['rollout', r.range(15, 60), false], ['verify', r.range(5, 20), false]]);
      }
    }
    return { wfs, dur, cached, deployWf, deployVia };
  }

  /** Decides the pipeline outcome up front (~88% success, 7% failure, 3% canceled, 2% error). */
  outcome(px: PipeX, red: boolean): void {
    const r = this.rng();
    const [s, f, c] = px.prX ? [0.84, 0.95, 0.98] : red ? [0.82, 0.94, 0.97] : [0.9, 0.95, 0.98];
    px.outcome = r < s ? 'success' : r < f ? 'failure' : r < c ? 'canceled' : 'error';
    if (px.outcome === 'failure') {
      if (px.dur.length > 1 && px.p.workflows[1]!.name === 'security' && this.rng.chance(0.2)) px.fail = [1, this.rng.int(0, 1)];
      else { const x = this.rng(); px.fail = [0, x < 0.25 ? 2 : x < 0.85 ? 3 : 4]; }
    } else if (px.outcome === 'error') px.fail = [0, this.rng.int(0, 1)];
    if (px.deployWf >= 0 && this.rng.chance(0.05)) px.deployFail = [px.deployWf, this.rng.int(1, 2)];
  }

  private enqueue(rx: RepoX, commitId: string, isMain: boolean, ord: number, prX?: PrX): void {
    const c = this.state.commits[commitId];
    if (!c) return;
    const lane = this.laneFor(rx);
    const { id, number, url } = this.newPipeId(rx, lane);
    const pl = this.plan(rx, isMain, lane);
    const q = this.queues[lane];
    const p: Pipeline = {
      lane, repo: rx.r.id, number, sha: c.sha, branch: c.branch, event: prX ? 'pull_request' : 'push',
      state: 'pending', created: this.now, queue_pos: q.length + 1, workflows: pl.wfs, url,
      expected_ms: (rx.r.p50_build_ms ?? 150000) + (pl.deployWf >= 0 ? 60000 : 0),
    };
    const px: PipeX = {
      id, p, rx, commitId, isMain, ord, outcome: 'success', readyAt: this.now + (this.rng.chance(0.8) ? this.rng.int(20, 200) : this.rng.int(200, 900)) * TICK,
      dur: pl.dur, cached: pl.cached, prX, deployWf: pl.deployWf, deployVia: pl.deployVia, done: false,
    };
    this.outcome(px, rx.r.main.state === 'failure');
    this.state.pipelines[id] = p;
    this.pipes.set(id, px);
    this.mark('pipeline', id);
    q.push(px);
    this.queueDirty[lane] = true;
    c.pipelines.push(id);
    c.stage = 'queued';
    this.mark('commit', commitId);
    if (prX) prX.pipelines.push(id);
    this.ev({ k: 'enqueue', pipeline: id, lane, repo: rx.r.id, sha: c.sha, at: this.now });
    if (px.outcome === 'canceled') {
      const exp = p.expected_ms ?? 120000;
      const at = this.rng.chance(0.3) ? px.readyAt - TICK : px.readyAt + Math.round((this.rng.range(0.1, 0.7) * exp) / TICK) * TICK;
      this.agenda.add(Math.max(this.now + TICK, at), () => this.cancel(px));
    }
  }

  newPipeId(rx: RepoX, lane: Lane): { id: string; number: number; url: string } {
    if (lane === 'roadrunner') {
      const number = ++rx.wpNum;
      return { id: `wp:${rx.r.id}:${number}`, number, url: `https://ci.dev.example.com/repos/${1000 + rx.idx}/pipeline/${number}` };
    }
    const run = ++this.ghaRun;
    return { id: `gha:${run}`, number: ++rx.ghaNum, url: `https://github.com/${rx.r.id}/actions/runs/${run}` };
  }

  private freeEngine(lane: Lane): Engine | undefined {
    let best: Engine | undefined;
    let score = 0;
    for (const e of Object.values(this.state.engines)) {
      if ((lane === 'gha') !== (e.kind === 'gha_runner')) continue;
      const free = e.slots - e.busy;
      if (free <= 0) continue;
      const s = free / e.slots + (e.kind === 'dagger' ? 0.05 : 0);
      if (s > score) { score = s; best = e; }
    }
    return best;
  }

  private dispatch(): void {
    for (const lane of ['roadrunner', 'gha'] as const) {
      if (lane === 'gha' && this.state.watcher.tripped) continue;
      const q = this.queues[lane];
      let changed = false;
      for (let i = 0; i < q.length;) {
        const px = q[i]!;
        if (px.readyAt > this.now) { i++; continue; }
        const eng = this.freeEngine(lane);
        if (!eng) break;
        q.splice(i, 1);
        this.start(px, eng);
        changed = true;
      }
      if (changed) {
        q.forEach((px, j) => { if (px.p.queue_pos !== j + 1) { px.p.queue_pos = j + 1; this.mark('pipeline', px.id); } });
        this.queueDirty[lane] = true;
      }
    }
  }

  private start(px: PipeX, eng: Engine): void {
    const p = px.p;
    p.state = 'running';
    p.started = this.now;
    p.engine = eng.id;
    delete p.queue_pos;
    eng.running.push(px.id);
    eng.busy = eng.running.length;
    this.mark('engine', eng.id);
    this.running[p.lane]++;
    this.ev({ k: 'start', pipeline: px.id, engine: eng.id, at: this.now });
    this.setCommit(px, (c) => { c.stage = 'building'; c.ci = 'running'; });
    if (px.isMain) this.setDot(px, 'running');
    p.workflows.forEach((_, wi) => { if (wi !== px.deployWf) this.startWf(px, wi); });
    this.mark('pipeline', px.id);
  }

  private startWf(px: PipeX, wi: number): void {
    const wf = px.p.workflows[wi]!;
    wf.state = 'running';
    wf.started = this.now;
    this.startStep(px, wi, 0);
  }

  private startStep(px: PipeX, wi: number, si: number): void {
    const wf = px.p.workflows[wi]!;
    const st = wf.steps[si]!;
    st.state = 'running';
    st.started = this.now;
    if (px.cached[wi]![si]) st.cached = true;
    this.mark('pipeline', px.id);
    this.ev({ k: 'step', pipeline: px.id, workflow: wf.name, step: st.name, state: 'running', at: this.now });
    this.agenda.add(this.now + px.dur[wi]![si]!, () => this.endStep(px, wi, si));
  }

  private endStep(px: PipeX, wi: number, si: number): void {
    if (px.done) return;
    const wf = px.p.workflows[wi]!;
    const st = wf.steps[si]!;
    const hit = (f?: [number, number]): boolean => !!f && f[0] === wi && f[1] === si;
    const failed = hit(px.fail) || hit(px.deployFail);
    const res: CiState = failed ? (px.outcome === 'error' && hit(px.fail) ? 'error' : 'failure') : 'success';
    st.state = res;
    st.finished = this.now;
    st.exit_code = res === 'success' ? 0 : res === 'error' ? 137 : this.rng.chance(0.8) ? 1 : 2;
    this.mark('pipeline', px.id);
    this.ev({ k: 'step', pipeline: px.id, workflow: wf.name, step: st.name, state: res, at: this.now });
    if (res === 'success' && si + 1 < wf.steps.length) { this.startStep(px, wi, si + 1); return; }
    for (let j = si + 1; j < wf.steps.length; j++) wf.steps[j]!.state = 'skipped';
    wf.state = res;
    wf.finished = this.now;
    this.onWfEnd(px, wi);
  }

  private onWfEnd(px: PipeX, wi: number): void {
    const wfs = px.p.workflows;
    if (wi === 0 && px.deployWf >= 0) {
      const dw = wfs[px.deployWf]!;
      if (wfs[0]!.state === 'success') {
        px.deployId = this.deployCreate(px, px.deployVia ?? 'roadrunner');
        this.agenda.add(this.now + this.rng.int(10, 40) * TICK, () => {
          if (px.done) return;
          this.deploySet(px.deployId!, 'running');
          this.startWf(px, px.deployWf);
        });
      } else {
        dw.state = 'skipped';
        dw.steps.forEach((s) => (s.state = 'skipped'));
      }
    }
    if (wi === px.deployWf && px.deployId) this.deploySet(px.deployId, wfs[wi]!.state === 'success' ? 'success' : 'failure');
    if (wfs.every((w) => isTerminal(w.state))) {
      const states = wfs.map((w) => w.state);
      this.finish(px, states.includes('error') ? 'error' : states.includes('failure') ? 'failure' : 'success');
    }
  }

  private cancel(px: PipeX): void {
    if (px.done) return;
    const q = this.queues[px.p.lane];
    const i = q.indexOf(px);
    if (i >= 0) { q.splice(i, 1); delete px.p.queue_pos; this.queueDirty[px.p.lane] = true; }
    for (const wf of px.p.workflows) {
      if (isTerminal(wf.state)) continue;
      for (const s of wf.steps) {
        if (s.state === 'running') { s.state = 'canceled'; s.finished = this.now; }
        else if (s.state === 'pending') s.state = 'skipped';
      }
      wf.state = wf.state === 'running' ? 'canceled' : 'skipped';
      if (wf.started) wf.finished = this.now;
    }
    this.finish(px, 'canceled');
  }

  private finish(px: PipeX, state: CiState): void {
    const p = px.p;
    const now = this.now;
    px.done = true;
    p.state = state;
    p.finished = now;
    this.mark('pipeline', px.id);
    if (p.engine && p.started) {
      const e = this.state.engines[p.engine]!;
      e.running = e.running.filter((x) => x !== px.id);
      e.busy = e.running.length;
      this.mark('engine', e.id);
      this.running[p.lane]--;
    }
    this.queueDirty[p.lane] = true;
    this.recPipes.push({ t: now, s: state, q: (p.started ?? now) - p.created, b: p.started ? now - p.started : 0 });
    const verdictWfs = p.workflows.filter((_, i) => i !== px.deployWf).map((w) => w.state);
    const verdict: CiState = state === 'canceled' ? 'canceled' : verdictWfs.includes('error') ? 'error' : verdictWfs.includes('failure') ? 'failure' : 'success';
    this.setCommit(px, (c) => {
      c.ci = state;
      if (state === 'success') {
        c.stage = !px.isMain ? 'gating' : c.deploy?.state === 'success' ? 'deployed' : px.rx.appId ? 'deploying' : 'done';
      } else c.stage = state === 'canceled' ? 'done' : 'failed';
    });
    let culprit = false;
    if (px.isMain) {
      this.setDot(px, state);
      culprit = this.mainVerdict(px, verdict);
    }
    this.ev({ k: 'finish', pipeline: px.id, state, at: now, ...(culprit ? { culprit } : {}) });
    if (culprit) {
      this.ev({ k: 'main', repo: px.rx.r.id, from: 'success', to: 'failure', culprit: p.sha, at: now });
    }
    if (px.prX) prOnPipeline(this, px.prX, px);
    if (px.isMain && px.rx.appId && state === 'success' && px.deployWf < 0) this.outOfBandDeploy(px);
  }

  private setCommit(px: PipeX, f: (c: Commit) => void): void {
    const c = this.state.commits[px.commitId];
    if (!c) return;
    f(c);
    this.mark('commit', px.commitId);
  }
  private setDot(px: PipeX, state: CiState): void {
    const d = px.rx.r.main.recent.find((x) => x.sha === px.p.sha);
    if (d && d.state !== state) { d.state = state; this.mark('repo', px.rx.r.id); }
  }

  /** Main turns red on the first failing settled commit, green again on a later success. */
  private mainVerdict(px: PipeX, v: CiState): boolean {
    const rx = px.rx;
    if ((v !== 'success' && v !== 'failure') || px.ord < rx.settledOrd) return false;
    rx.settledOrd = px.ord;
    const m = rx.r.main;
    if (v === 'failure' && m.state !== 'failure') {
      m.state = 'failure';
      m.since = this.now;
      m.culprit = px.p.sha;
      const d = m.recent.find((x) => x.sha === px.p.sha);
      if (d) d.culprit = true;
      this.mark('repo', rx.r.id);
      return true;
    }
    if (v === 'success' && m.state !== 'success') {
      const from = m.state;
      m.state = 'success';
      m.since = this.now;
      m.culprit = null;
      this.mark('repo', rx.r.id);
      this.ev({ k: 'main', repo: rx.r.id, from, to: 'success', at: this.now });
    }
    return false;
  }

  // ───────────────────────────── deploys ─────────────────────────────

  deployCreate(px: PipeX, via: DeployVia): string {
    const rx = px.rx;
    const app = rx.appId!;
    const sha = px.p.sha;
    const id = `${app}:${sha}`;
    const ax = this.appById.get(app)!;
    this.state.deploys[id] = { app, repo: rx.r.id, sha, via, state: 'pending', started: this.now, url: ax.a.url };
    this.mark('deploy', id);
    this.ev({ k: 'deploy', app, sha, state: 'pending', via, at: this.now });
    this.setCommit(px, (c) => { c.deploy = { id, state: 'pending' }; c.stage = 'deploying'; });
    ax.a.last_deploy = { id, state: 'pending' };
    this.mark('app', app);
    return id;
  }

  deploySet(id: string, st: Deploy['state']): void {
    const d = this.state.deploys[id];
    if (!d || d.state === st) return;
    d.state = st;
    const done = st === 'success' || st === 'failure';
    if (done) { d.finished = this.now; this.recDeploys.push(this.now); }
    this.mark('deploy', id);
    this.ev({ k: 'deploy', app: d.app, sha: d.sha, state: st, via: d.via, at: this.now });
    const cid = `${d.repo}@${d.sha}`;
    const c = this.state.commits[cid];
    if (c) {
      c.deploy = { id, state: st };
      if (done) c.stage = st === 'success' ? 'deployed' : 'failed';
      this.mark('commit', cid);
    }
    const ax = this.appById.get(d.app)!;
    const a = ax.a;
    a.last_deploy = { id, state: st };
    this.mark('app', d.app);
    if (st !== 'success') return;
    const rx = ax.rx;
    a.live_sha = d.sha;
    const ord = rx.ord.get(d.sha);
    a.behind = ord ? Math.max(0, rx.mainCount - ord) : 0;
    const dot = rx.r.main.recent.find((x) => x.sha === d.sha);
    if (dot) { dot.deployed = true; this.mark('repo', rx.r.id); }
    const prX = this.mergedFrom.get(cid);
    if (prX && prX.pr.phase === 'merged') prPhase(this, prX, 'deployed');
    if (!ax.pinned && a.health === 'up' && this.rng.chance(0.03) && this.apps.filter((x) => x.a.health !== 'up').length < 3) {
      this.setHealth(ax, this.rng.chance(0.3) ? 'down' : 'degraded');
      this.agenda.add(this.now + this.rng.int(10, 50) * 6 * SEC, () => this.setHealth(ax, 'up'));
    }
  }

  private outOfBandDeploy(px: PipeX): void {
    const via = px.deployVia ?? px.rx.via;
    const id = this.deployCreate(px, via);
    const wait = via === 'manual' ? this.rng.int(60, 300) : this.rng.int(5, 30);
    const run = this.rng.int(30, 120);
    const ok = this.rng.chance(0.95);
    this.agenda.add(this.now + wait * SEC, () => this.deploySet(id, 'running'));
    this.agenda.add(this.now + (wait + run) * SEC, () => this.deploySet(id, ok ? 'success' : 'failure'));
  }

  // ───────────────────────────── watcher, health, engines ─────────────────────────────

  private trip(): void {
    this.nextTrip = Infinity;
    this.tripEnd = this.now + Math.round(this.rng.range(2.5, 3.5) * 600) * TICK;
    this.state.watcher = { id: 'outage', tripped: true, since: this.now, gh_status: 'degraded', note: 'GitHub Actions degraded: delayed job starts; GHA lanes held, gha_first lanes falling back to Roadrunner' };
    this.mark('watcher', 'outage');
    this.setLanes(true);
  }
  private untrip(): void {
    this.tripEnd = 0;
    this.nextTrip = this.now + Math.round(this.rng.range(38, 52) * 600) * TICK;
    this.state.watcher = { id: 'outage', tripped: false, since: this.now, gh_status: 'operational' };
    this.mark('watcher', 'outage');
    this.setLanes(false);
  }
  private setLanes(on: boolean): void {
    for (const ln of Object.values(this.state.lanes)) {
      if (ln.mode === 'gha_first') { if (on) ln.fallback = true; else delete ln.fallback; this.mark('lane', ln.id); }
      if (ln.mode === 'ci' || ln.mode === 'ci_only') { if (on) ln.held = true; else delete ln.held; this.mark('lane', ln.id); }
    }
  }

  latency(ax: AppX): number | undefined {
    const h = ax.a.health;
    if (h === 'down') return undefined;
    return Math.round(h === 'degraded' ? this.rng.range(900, 3200) : ax.baseLat * this.rng.range(0.8, 1.35));
  }
  private healthCheck(ax: AppX): void {
    const a = ax.a;
    a.checked = this.now;
    const lat = this.latency(ax);
    if (lat === undefined) delete a.latency_ms; else a.latency_ms = lat;
    ax.samples.push({ at: this.now, health: a.health, ...(lat === undefined ? {} : { latency_ms: lat }) });
    if (ax.samples.length > 240) ax.samples.shift();
    this.mark('app', ax.id);
  }
  setHealth(ax: AppX, to: Health): void {
    const from = ax.a.health;
    if (from === to) return;
    ax.a.health = to;
    this.ev({ k: 'health', app: ax.id, from, to, at: this.now });
    this.healthCheck(ax);
  }
  private incident(): void {
    this.nextIncident = this.now + Math.max(MIN, Math.round(this.rng.exp(8 * MIN) / TICK) * TICK);
    if (this.apps.filter((a) => a.a.health !== 'up').length >= 3) return;
    const cand = this.apps.filter((a) => a.a.health === 'up' && !a.pinned);
    if (!cand.length) return;
    const ax = this.rng.pick(cand);
    this.setHealth(ax, this.rng.chance(0.3) ? 'down' : 'degraded');
    this.agenda.add(this.now + this.rng.int(30, 150) * 6 * SEC, () => this.setHealth(ax, 'up'));
  }

  private engineMetrics(): void {
    for (const e of Object.values(this.state.engines)) {
      const u = e.busy / e.slots;
      e.cpu = round2(clamp(0.04 + 0.82 * u + (this.rng() - 0.5) * 0.08, 0.01, 0.99));
      e.mem = round2(clamp(0.18 + 0.6 * u + (this.rng() - 0.5) * 0.04, 0.05, 0.97));
      e.load = round2(e.busy * (e.kind === 'dagger' ? 1.7 : 1.2) + this.rng() * 0.6);
      this.mark('engine', e.id);
    }
  }

  private refreshQueue(lane: Lane): void {
    this.queueDirty[lane] = false;
    const q = this.queues[lane];
    const Q = this.state.queues[lane] as Queue;
    let oldest = Infinity;
    for (const px of q) if (px.p.created < oldest) oldest = px.p.created;
    const ow = q.length ? this.now - oldest : 0;
    const items = q.slice(0, 50).map((px) => px.id);
    if (Q.pending === q.length && Q.running === this.running[lane] && Q.oldest_wait_ms === ow && Q.items.join() === items.join()) return;
    Q.pending = q.length;
    Q.running = this.running[lane];
    Q.oldest_wait_ms = ow;
    Q.items = items;
    this.mark('queue', lane);
  }

  // ───────────────────────────── stats & pruning ─────────────────────────────

  computeStats(): void {
    const ws = this.now - DAY;
    // one splice per list, not a shift per entry (a shift moves the whole array: after the
    // seed, thousands of them were one 5 ms turn in Bun, ~50 ms on a slow Mac's Hermes)
    const drop = <T>(a: T[], old: (v: T) => boolean): void => { let k = 0; while (k < a.length && old(a[k]!)) k++; if (k) a.splice(0, k); };
    drop(this.recCommits, (t) => t < ws);
    drop(this.recPipes, (r) => r.t < ws);
    drop(this.recDeploys, (t) => t < ws);
    const idx = clamp(Math.floor((ws - (this.t0 - DAY)) / MIN), 0, 1440);
    const pre = this.preCum[1440]! - this.preCum[idx]!;
    const done = this.recPipes;
    const ok = done.filter((r) => r.s === 'success');
    const s = {
      commits_24h: this.recCommits.length + Math.round(pre),
      pipelines_24h: done.length + Math.round(pre * 0.86),
      success_rate_24h: done.length ? Math.round((ok.length / done.length) * 1000) / 1000 : 0.9,
      p50_queue_ms: median(done.map((r) => r.q)),
      p50_build_ms: median(ok.map((r) => r.b)),
      deploys_24h: this.recDeploys.length + Math.round(pre * 0.07),
      apps_up: this.apps.filter((a) => a.a.health === 'up').length,
      apps_down: this.apps.filter((a) => a.a.health === 'down').length,
      prs_open: this.openPrs,
    };
    if (JSON.stringify(s) !== JSON.stringify(this.state.stats)) { this.state.stats = s; this.mark('stats', 'stats'); }
  }

  private prune(): void {
    const now = this.now;
    const cap = <V>(m: Map<string, V>, n: number): void => { while (m.size > n) m.delete(m.keys().next().value!); };
    const live = (c: Commit): boolean => c.stage === 'pushed' || c.stage === 'queued' || c.stage === 'building' || c.stage === 'deploying';
    const commits = this.state.commits;
    let count = 0;
    for (const id in commits) count++;
    for (const id in commits) {
      const c = commits[id]!;
      if (live(c) || (c.at >= now - DAY && count <= this.maxCommits)) continue;
      this.archCommits.set(id, c);
      delete commits[id];
      this.mark('commit', id);
      count--;
    }
    for (const id in this.state.pipelines) {
      const p = this.state.pipelines[id]!;
      if (p.finished === undefined || p.finished >= now - 2 * HOUR) continue;
      this.archPipes.set(id, p);
      delete this.state.pipelines[id];
      this.pipes.delete(id);
      this.mark('pipeline', id);
    }
    for (const id in this.state.deploys) {
      const d = this.state.deploys[id]!;
      if (d.finished === undefined || d.started >= now - DAY) continue;
      this.archDeploys.set(id, d);
      delete this.state.deploys[id];
      this.mark('deploy', id);
    }
    for (const id in this.state.prs) {
      const pr = this.state.prs[id]!;
      if (ACTIVE.includes(pr.phase) || pr.updated >= now - DAY) continue;
      const prX = this.prs.get(id);
      if (prX) this.archPrs.set(id, prX);
      this.prs.delete(id);
      delete this.state.prs[id];
      this.mark('pr', id);
    }
    cap(this.archCommits, 12000);
    cap(this.archPipes, 8000);
    cap(this.archDeploys, 5000);
    cap(this.archPrs, 3000);
  }

  private staleSweep(): void {
    for (const prX of this.prs.values()) {
      const pr = prX.pr;
      if (!ACTIVE.includes(pr.phase)) continue;
      const idle = this.now - pr.updated;
      if (idle < 30 * MIN) continue;
      const s = Math.floor(idle / (5 * MIN)) * 5 * MIN;
      if (pr.stale_ms !== s) { pr.stale_ms = s; this.mark('pr', prX.id); }
    }
  }
}

export function createSim(o: SimOptions): Sim { return new Sim(o); }
