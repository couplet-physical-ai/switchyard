// The client's copy of the fleet: a Snapshot's collections as Maps, plus the indexes the yard
// and the views read. `apply` takes one wire Frame (contract/CONTRACT.md): upserts replace an
// entity, removes delete it, events go to the listener (the yard's motion) after the ops of
// the same frame have landed, so a listener always sees the world the event produced.

import type { App, Commit, Deploy, Engine, Event, Frame as WireFrame, Kind, Lane, Org, Pipeline, Pr, Queue, Repo, Snapshot, Stats, Watcher } from './wire.ts';

/** The sources column's row for bots (AUTOFIX, Renovate, agents). */
export const BOTS = '@bots';

export type Listener = (e: Event, w: World) => void;

const EMPTY_STATS: Stats = { commits_24h: 0, pipelines_24h: 0, success_rate_24h: 0, p50_queue_ms: 0, p50_build_ms: 0, deploys_24h: 0, apps_up: 0, apps_down: 0, prs_open: 0 };

export class World {
  protocol = '';
  seq = 0;
  at = 0;
  orgs = new Map<string, Org>();
  repos = new Map<string, Repo>();
  commits = new Map<string, Commit>();
  pipelines = new Map<string, Pipeline>();
  prs = new Map<string, Pr>();
  deploys = new Map<string, Deploy>();
  apps = new Map<string, App>();
  engines = new Map<string, Engine>();
  queues = new Map<string, Queue>();
  lanes = new Map<string, Lane>();
  watcher: Watcher = { id: 'outage', tripped: false, gh_status: 'unknown' };
  stats: Stats = { ...EMPTY_STATS };
  /** Bumps on every applied change; projections cache on it. */
  ver = 0;
  /** Bumps when the set of repos, orgs, engines or apps changes (the yard's layout). */
  shapeVer = 0;
  /** Per-kind change counters: the yard's panels redraw only when what they show changed. */
  kv: Record<string, number> = { org: 0, repo: 0, commit: 0, pipeline: 0, pr: 0, deploy: 0, app: 0, engine: 0, queue: 0, lane: 0, watcher: 0, stats: 0 };
  /** Push times by org, newest last, for the sources column's rate (last 60 minutes). */
  pushes = new Map<string, number[]>();
  /** Events applied, newest last (bounded): the yard's recent-activity feed. */
  recent: Event[] = [];
  loaded = false;

  load(s: Snapshot): void {
    this.protocol = String(s.protocol ?? '');
    this.seq = s.seq ?? 0;
    this.at = s.at ?? 0;
    this.orgs = toMap(s.orgs);
    this.repos = toMap(s.repos);
    this.commits = toMap(s.commits);
    this.pipelines = toMap(s.pipelines);
    this.prs = toMap(s.prs);
    this.deploys = toMap(s.deploys);
    this.apps = toMap(s.apps);
    this.engines = toMap(s.engines);
    this.queues = toMap(s.queues);
    this.lanes = toMap(s.lanes);
    this.watcher = s.watcher ?? { id: 'outage', tripped: false, gh_status: 'unknown' };
    this.stats = { ...EMPTY_STATS, ...(s.stats ?? {}) };
    this.pushes = new Map();
    for (const c of this.commits.values()) {
      if (c.at >= this.at - 3_600_000) this.notePush(c.bot || c.author?.endsWith('[bot]') ? BOTS : this.orgOf(c.repo), c.at);
    }
    for (const list of this.pushes.values()) list.sort((a, b) => a - b);
    this.recent = [];
    this.loaded = true;
    this.ver++;
    this.shapeVer++;
    for (const k of Object.keys(this.kv)) this.kv[k]++;
  }

  /** Applies a frame; returns false when it must be refetched (a reset or a gap). */
  apply(f: WireFrame, listener?: Listener): boolean {
    if (f.t === 'reset') return false;
    if (f.t === 'hb') {
      // The server merges frames for slow clients, so a gap in seq is fine (CONTRACT.md).
      this.at = Math.max(this.at, f.at);
      return true;
    }
    if (f.seq <= this.seq) return true; // already applied (a resume overlap)
    let events: Event[] | null = null;
    for (const op of f.ops) {
      if (op.op === 'event') (events ??= []).push(op.e);
      else if (op.op === 'upsert') this.upsert(op.kind, op.id, op.v);
      else if (op.op === 'remove') this.remove(op.kind, op.id);
    }
    this.seq = f.seq;
    this.at = Math.max(this.at, f.at);
    this.ver++;
    if (events) {
      for (const e of events) {
        if (e.k === 'push') { this.notePush(e.bot || e.author?.endsWith('[bot]') ? BOTS : this.orgOf(e.repo), e.at); this.kv.commit++; }
        this.recent.push(e);
        listener?.(e, this);
      }
      if (this.recent.length > 400) this.recent.splice(0, this.recent.length - 300);
    }
    return true;
  }

  private upsert(kind: Kind | string, id: string, v: unknown): void {
    if (kind in this.kv) this.kv[kind]++;
    const m = this.mapOf(kind);
    if (m) {
      if (!m.has(id) && (kind === 'repo' || kind === 'org' || kind === 'engine' || kind === 'app' || kind === 'queue')) this.shapeVer++;
      if (v && typeof v === 'object' && !(v as { id?: string }).id) (v as { id?: string }).id = id;
      m.set(id, v);
    } else if (kind === 'watcher') this.watcher = v as Watcher;
    else if (kind === 'stats') this.stats = { ...EMPTY_STATS, ...(v as Stats) };
  }

  private remove(kind: Kind | string, id: string): void {
    if (kind in this.kv) this.kv[kind]++;
    const m = this.mapOf(kind);
    if (m?.delete(id) && (kind === 'repo' || kind === 'org' || kind === 'engine' || kind === 'app' || kind === 'queue')) this.shapeVer++;
  }

  private mapOf(kind: Kind | string): Map<string, any> | null {
    switch (kind) {
      case 'org': return this.orgs;
      case 'repo': return this.repos;
      case 'commit': return this.commits;
      case 'pipeline': return this.pipelines;
      case 'pr': return this.prs;
      case 'deploy': return this.deploys;
      case 'app': return this.apps;
      case 'engine': return this.engines;
      case 'queue': return this.queues;
      case 'lane': return this.lanes;
      default: return null;
    }
  }

  private notePush(org: string, at: number): void {
    let list = this.pushes.get(org);
    if (!list) this.pushes.set(org, (list = []));
    list.push(at);
    if (list.length > 600) list.splice(0, list.length - 500);
  }

  orgOf(repo: string): string {
    return this.repos.get(repo)?.org ?? repo.split('/')[0] ?? '';
  }

  /** Pushes per hour for an org over the last `windowMs` before `now`. */
  rate(org: string, now: number, windowMs = 3_600_000): number {
    const list = this.pushes.get(org);
    if (!list) return 0;
    let n = 0;
    for (let i = list.length - 1; i >= 0 && list[i] > now - windowMs; i--) n++;
    return Math.round(n * 3_600_000 / windowMs);
  }

  pushesSince(org: string, since: number): number {
    const list = this.pushes.get(org);
    if (!list) return 0;
    let n = 0;
    for (let i = list.length - 1; i >= 0 && list[i] > since; i--) n++;
    return n;
  }

  commitOfPipeline(p: Pipeline): Commit | undefined {
    return this.commits.get(`${p.repo}@${p.sha}`);
  }
}

/** v0.2 sends arrays of entities with their own ids; the demo sends id-keyed maps. */
function toMap<T>(o: T[] | Record<string, T> | undefined | null): Map<string, T> {
  const m = new Map<string, T>();
  if (Array.isArray(o)) {
    for (const v of o) {
      const id = (v as { id?: string }).id;
      if (id != null) m.set(String(id), v);
    }
  } else if (o) {
    for (const k of Object.keys(o)) {
      const v = o[k];
      if (v && typeof v === 'object' && !(v as { id?: string }).id) (v as { id?: string }).id = k;
      m.set(k, v);
    }
  }
  return m;
}
