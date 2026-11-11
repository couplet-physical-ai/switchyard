// The Factory Floor aggregates of contract v0.5 (groups, failure clusters, flakes, trends,
// /insights, /changes?since), kept by the mock's two sources: the simulation (server/sim.ts, also
// the in-app demo) and the fixture replay (server/mock.ts --fixtures, v0.4 recordings). Pure and
// portable: no Bun/Node APIs, no wall clock, no Math.random; time is always passed in.
//
// The pure helpers at the top (team normalization, shard folding, failure classes, signatures)
// are shared with the client, whose src/insights.ts approximates the same tables for a v0.4
// server.
//
// The Floor owns four id-keyed tables (state.groups/clusters/flakes/trends) and marks what it
// changes through `mark(kind, id)`, so the caller's frame flush emits the upserts and removes
// (the contract reducer applied to a checkpoint reproduces the snapshot exactly). It reads:
//   - pipelines, as they change (`observe`): failed steps join a cluster (Step.cluster), a step
//     that failed and passed on the same sha is a flip (Flake, Pipeline.flaky), finished
//     pipelines and their timings roll up into hourly buckets per group and for the fleet;
//   - events (`onEvent`): main red/green, deploys, health changes and merges for /changes;
//   - a periodic `tick` (every few minutes): 24 h windows decay, red counts and the gauges
//     (red mains, PR age) are sampled, trends are recomputed.

import type {
  App, ChangeCounts, Changes, CiState, Cluster, Event, FailClass, Flake, Group, Insights, Metric, Pipeline, Pr, Repo, Trend,
  DemoSnapshot as Snapshot,
} from '../src/wire.ts';
import { DAY, HOUR, hash32, type Rng } from './util.ts';

// ───────────────────────────── pure helpers (shared with the client) ─────────────────────────────

/** A team from the apps catalog, normalized: lower-case, "-team" dropped ("software-team" →
 *  "software"). '' for no usable team ("", "-", "unknown", "none", "n/a"). */
export function normTeam(team: string | undefined | null): string {
  const t = String(team ?? '').trim().toLowerCase().replace(/[\s_]+/g, '-').replace(/-team$/, '');
  return !t || t === '-' || t === 'unknown' || t === 'none' || t === 'n/a' || t === 'na' ? '' : t;
}

/** A team's display name: the catalog's spelling when it is an acronym ("HR", "SEIT"), else the
 *  slug in sentence case ("power-systems" → "Power systems"). */
export function teamName(raw: string, slug: string): string {
  const base = raw.trim().replace(/[-_ ]team$/i, '');
  if (/^[A-Z0-9]{2,}$/.test(base)) return base;
  const s = slug.replace(/-/g, ' ');
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export const isRedState = (s: CiState | string | undefined): boolean => s === 'failure' || s === 'error';
const isFailed = isRedState;

/** Each repo's team: the most common usable team among the apps that name it (`App.repo`; ties
 *  to the alphabetically first), else the team of the app it names (`Repo.app` → `App.team`).
 *  Repos without one are absent (their group is their org). */
export function repoTeams(repos: Iterable<Repo>, apps: Iterable<App>): Map<string, { slug: string; raw: string }> {
  const votes = new Map<string, Map<string, { n: number; raw: string }>>();
  const byId = new Map<string, App>();
  for (const a of apps) {
    if (!a) continue;
    if (a.id) byId.set(a.id, a);
    const slug = normTeam(a.team);
    if (!slug || !a.repo) continue;
    let m = votes.get(a.repo);
    if (!m) votes.set(a.repo, (m = new Map()));
    const v = m.get(slug);
    if (v) v.n++;
    else m.set(slug, { n: 1, raw: String(a.team) });
  }
  const out = new Map<string, { slug: string; raw: string }>();
  for (const [repo, m] of votes) {
    let best = '', bn = -1, raw = '';
    for (const [slug, v] of m) if (v.n > bn || (v.n === bn && slug < best)) { best = slug; bn = v.n; raw = v.raw; }
    out.set(repo, { slug: best, raw });
  }
  for (const r of repos) {
    if (!r?.app || out.has(r.id)) continue;
    const a = byId.get(r.app);
    const slug = normTeam(a?.team);
    if (slug) out.set(r.id, { slug, raw: String(a!.team) });
  }
  return out;
}

export const teamGroupId = (slug: string): string => `team:${slug}`;
export const orgGroupId = (org: string): string => `org:${org}`;

/** Numbered shards folded: "test-web-3" → "test-web-#", "test (2/4)" → "test (#/#)". */
export function foldStep(name: string): string {
  return String(name ?? '').replace(/\(\s*\d+\s*\/\s*\d+\s*\)/g, '(#/#)').replace(/([-_ .:])\d+$/, '$1#');
}

/** A failure's class guessed from its workflow/step names and exit code. */
export function guessClass(step: string, workflow = '', exit?: number): FailClass {
  const s = `${workflow}/${step}`.toLowerCase();
  if (exit === 137) return 'oom';
  if (exit === 124 || /timeout|timed-out/.test(s)) return 'timeout';
  if (/gitleaks|osv|secur|audit|trivy|snyk|vuln|cve|sast|scan/.test(s)) return 'security';
  if (/lint|fmt|format|clippy|eslint|ruff|prettier|black|style/.test(s)) return 'lint';
  if (/typecheck|type-check|tsc|mypy|pyright|types/.test(s)) return 'typecheck';
  if (/deploy|rollout|publish|release|verify|provision/.test(s)) return 'deploy';
  if (/test|spec|e2e|pytest|jest|vitest|ctp|smoke/.test(s)) return 'test';
  if (/deps|install|lock|vendor|requirements/.test(s)) return 'deps';
  if (/compile|cargo|rust|rustc|gcc|javac/.test(s)) return 'compile';
  if (/build|image|docker|bundle|package|mkdocs|docs|wasm/.test(s)) return 'build';
  if (/clone|fetch|checkout|network|download|pull/.test(s)) return 'network';
  if (/migrat|postgres|infra|runner|setup|db/.test(s)) return 'infra';
  return 'exit';
}

/** "<step> · <class>[ · <line>]". */
export const signatureOf = (step: string, cls: FailClass, line?: string): string => `${step} · ${cls}${line ? ` · ${line}` : ''}`;

const hex8 = (n: number): string => (n >>> 0).toString(16).padStart(8, '0');
/** "f:" + 12 hex of the signature's hash (the server's is sha256; any stable 48 bits read the same). */
export function clusterIdOf(signature: string): string {
  return `f:${(hex8(hash32(signature)) + hex8(hash32(`\u0001${signature}`))).slice(0, 12)}`;
}

/** Realistic decisive log lines, normalized (numbers, hashes, paths, durations masked). `{mod}`
 *  is a word of the repo's own (a test or crate name): such failures are the repo's own and do
 *  not cluster across repos; the others (a CVE drop, an OOM, the registry) do. */
const LINES: Record<FailClass, string[]> = {
  test: [
    'AssertionError: expected <n> to equal <n> ({mod}.spec)',
    "FAILED tests/test_{mod}.py::test_roundtrip - KeyError: '<str>'",
    "thread '{mod}::tests::parse' panicked at <path>:<n>:<n>: assertion `left == right` failed",
    'Error: expect(received).toEqual(expected) in {mod}.test.ts',
  ],
  compile: ['error[E0308]: mismatched types in {mod}', "error[E0425]: cannot find value `{mod}_cfg` in this scope", 'error: could not compile `{mod}` (lib) due to <n> previous errors'],
  typecheck: ["error TS2339: Property '{mod}' does not exist on type '<type>'", 'error: Argument of type "<type>" cannot be assigned to parameter "{mod}" [arg-type]'],
  lint: ['error: unused import: `{mod}`', "F401 '{mod}' imported but unused", 'Diff in <path> at line <n> (cargo fmt --check)'],
  deps: ['npm ERR! code ERESOLVE unable to resolve dependency tree', '× No solution found when resolving dependencies', 'error: failed to select a version for the requirement `<name> = "^<n>.<n>"`'],
  build: ['ERROR: failed to solve: process "/bin/sh -c <cmd>" did not complete successfully: exit code: <n>', 'Error: Build failed with <n> errors ({mod})', 'Aborted with <n> warnings in strict mode'],
  deploy: ['rollout did not become healthy in <dur>', 'GET /api/healthz returned 502 after <n> attempts', 'image <hash> not found in registry'],
  security: ['osv-scanner: <n> vulnerabilities found in <path>', 'gitleaks: leaks found: <n>', 'CRITICAL: CVE-<n>-<n> in <name> <n>.<n>.<n>'],
  oom: ['Killed (signal 9): {mod} ran out of memory (limit <n> MiB)'],
  timeout: ["Timeout <n>ms exceeded waiting for selector '<str>'", 'step exceeded its <dur> timeout'],
  network: ["fatal: unable to access '<url>': Could not resolve host: <host>", 'error: RPC failed; curl <n> transfer closed with outstanding read data remaining'],
  infra: ['dagger: engine connection lost: EOF', 'Error response from daemon: no space left on device'],
  exit: [],
};

/** The decisive line for a failure: deterministic by (class, step) — and by repo when the line is
 *  the repo's own. None for `exit` (only the exit code is known). */
export function errorLineOf(cls: FailClass, step: string, repo: string): string | undefined {
  const xs = LINES[cls];
  if (!xs?.length) return undefined;
  const own = xs.filter((l) => l.includes('{mod}'));
  const shared = xs.filter((l) => !l.includes('{mod}'));
  // a repo-own failure 3 times in 4 where the class has both kinds
  const h = hash32(`${cls}|${step}|${repo}`);
  const pool = own.length && (!shared.length || h % 4 !== 0) ? own : shared;
  const pick = pool === own ? h >>> 3 : hash32(`${cls}|${step}`);
  const name = String(repo).split('/').pop() ?? 'app';
  return pool[pick % pool.length]!.replace('{mod}', name.replace(/[^a-z0-9]+/gi, '_').toLowerCase());
}

// ───────────────────────────── the Floor ─────────────────────────────

export type FloorKind = 'group' | 'cluster' | 'flake' | 'trend' | 'pipeline' | 'repo';

/** One hour of a series: finished pipelines, their outcomes and timings, deploys, the gauges. */
type Bucket = { h: number; n: number; ok: number; fail: number; run: number[]; intake: number[]; deploys: number; red: number; prAge: number };
const newBucket = (h: number): Bucket => ({ h, n: 0, ok: 0, fail: 0, run: [], intake: [], deploys: 0, red: -1, prAge: -1 });
const SAMPLES = 24;
const push48 = (xs: number[], v: number, k: number): void => { if (xs.length < SAMPLES) xs.push(v); else xs[k % SAMPLES] = v; }; // (a bounded sample per hour)

/** A series' 7 d baseline (the mock simulates no week: it is seeded from the census). */
export type Baseline = { pass: number; run: number; intake: number; pipelines: number; deploys: number; prAge: number; red: number };

class Series {
  buckets: Bucket[] = [];
  k = 0;
  constructor(public base: Baseline) {}
  at(h: number): Bucket {
    const last = this.buckets[this.buckets.length - 1];
    if (last && last.h === h) return last;
    for (let i = this.buckets.length - 1; i >= 0; i--) {
      const b = this.buckets[i]!;
      if (b.h === h) return b;
      if (b.h < h) { const nb = newBucket(h); this.buckets.splice(i + 1, 0, nb); this.trim(); return nb; }
    }
    const nb = newBucket(h);
    this.buckets.unshift(nb);
    this.trim();
    return nb;
  }
  get(h: number): Bucket | undefined {
    for (let i = this.buckets.length - 1; i >= 0; i--) { const b = this.buckets[i]!; if (b.h === h) return b; if (b.h < h) return undefined; }
    return undefined;
  }
  private trim(): void { if (this.buckets.length > 30) this.buckets.splice(0, this.buckets.length - 26); }
}

type ClusterX = { c: Cluster; times: number[]; openRepos: Set<string>; repoAt: Map<string, number>; flakes: number[]; exPipes: string[] };
type ShaStep = { fail: number; pass: number; flipped: boolean; pipes: string[] };
type FlakeX = { f: Flake; flips: number[]; };
type Seen = { st: string; started: boolean; finished: boolean; cl: Map<string, string> | null; flaky: boolean };
type LogE =
  | { k: 'recovered'; at: number; repo: string; red_ms: number }
  | { k: 'deploy'; at: number; app: string; sha: string; state: string }
  | { k: 'health'; at: number; app: string; from: string; to: string }
  | { k: 'merge'; at: number }
  | { k: 'flip'; at: number };

/** A failure's class/line override (the demo's stories). */
export type Story = { cls?: FailClass; line?: string };

export type FloorOptions = {
  state: Snapshot;
  mark: (kind: FloorKind, id: string) => void;
};

const r2 = (x: number): number => Math.round(x * 100) / 100;
const r3 = (x: number): number => Math.round(x * 1000) / 1000;
const sec = (ms: number): number => Math.round(ms / 1000) * 1000;
function p50(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = xs.slice().sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)]!;
}

export class Floor {
  readonly state: Snapshot;
  private mark: (kind: FloorKind, id: string) => void;
  /** repo → its Group id. */
  readonly repoGroup = new Map<string, string>();
  private series = new Map<string, Series>();
  private cx = new Map<string, ClusterX>();
  /** first failure per signature, kept 7 d (a cluster that comes back is not new). */
  private firstSeen = new Map<string, number>();
  /** Same-sha bookkeeping for flips: steps that failed, by `${repo}@${sha}|${wf}/${step}` (few),
   *  and steps that passed, by that key's hash (many: numbers only), both kept 6 h. */
  private shaSteps = new Map<string, ShaStep>();
  private shaPasses = new Map<number, number>();
  private stepFails = new Map<string, number[]>();
  /** `${repo}|${workflow}/${folded step}` → the cluster of its latest failure (open tracking). */
  private lastFail = new Map<string, string>();
  /** repo → the cluster of its newest failure (Changes.red[].cluster). */
  private repoCluster = new Map<string, string>();
  private fx = new Map<string, FlakeX>();
  private seen = new Map<string, Seen>();
  private log: LogE[] = [];
  private redRepos = new Set<string>();
  readonly stories = new Map<string, Story>();
  /** The 7 d window's hours behind d7 (the mock: a full week, seeded). */
  hours7d = 168;
  lastTick = 0;

  constructor(o: FloorOptions) {
    this.state = o.state;
    this.mark = o.mark;
    this.state.groups ??= {};
    this.state.clusters ??= {};
    this.state.flakes ??= {};
    this.state.trends ??= {};
  }

  // ── groups ──

  /** Repo.group for every repo and the Group table, from the apps catalog. Returns the repos
   *  whose group changed (the caller emits them; `mark('repo')` is called too). */
  catalog(): string[] {
    const st = this.state;
    const teams = repoTeams(Object.values(st.repos), Object.values(st.apps));
    const changed: string[] = [];
    const next = new Map<string, Group>();
    const names = new Map<string, string>();
    const get = (id: string, name: string, kind: 'team' | 'org'): Group => {
      let g = next.get(id);
      if (!g) next.set(id, (g = { id, name, kind, repos: 0, apps: 0, red: 0 }));
      return g;
    };
    this.redRepos.clear();
    for (const r of Object.values(st.repos)) {
      const t = teams.get(r.id);
      const gid = t ? teamGroupId(t.slug) : orgGroupId(r.org);
      if (t) names.set(t.slug, teamName(t.raw, t.slug));
      const g = get(gid, t ? names.get(t.slug)! : r.org, t ? 'team' : 'org');
      g.repos++;
      if (isRedState(r.main?.state)) { g.red++; this.redRepos.add(r.id); }
      this.repoGroup.set(r.id, gid);
      if (r.group !== gid) { r.group = gid; changed.push(r.id); this.mark('repo', r.id); }
    }
    for (const a of Object.values(st.apps)) {
      const slug = normTeam(a.team);
      let gid = '';
      if (slug) { gid = teamGroupId(slug); if (!next.has(gid)) get(gid, teamName(String(a.team), slug), 'team'); }
      else if (a.repo) gid = this.repoGroup.get(a.repo) ?? '';
      const g = gid ? next.get(gid) : undefined;
      if (g) g.apps++;
    }
    for (const id of Object.keys(st.groups)) if (!next.has(id)) { delete st.groups[id]; this.mark('group', id); }
    for (const [id, g] of next) {
      const cur = st.groups[id];
      if (!cur || cur.name !== g.name || cur.kind !== g.kind || cur.repos !== g.repos || cur.apps !== g.apps || cur.red !== g.red) {
        st.groups[id] = g;
        this.mark('group', id);
      }
    }
    return changed;
  }

  groupOf(repo: string): string {
    return this.repoGroup.get(repo) ?? orgGroupId(String(repo).split('/')[0] ?? '');
  }

  private setRed(repo: string, red: boolean): void {
    if (red === this.redRepos.has(repo)) return;
    if (red) this.redRepos.add(repo); else this.redRepos.delete(repo);
    const g = this.state.groups[this.groupOf(repo)];
    if (!g) return;
    this.state.groups[g.id] = { ...g, red: Math.max(0, g.red + (red ? 1 : -1)) };
    this.mark('group', g.id);
  }

  // ── series ──

  /** Declares the series (fleet + every group) with their 7 d baselines. */
  baseline(id: string, b: Baseline): void {
    const s = this.series.get(id);
    if (s) s.base = b; else this.series.set(id, new Series(b));
  }
  ser(id: string): Series {
    let s = this.series.get(id);
    if (!s) {
      const f = this.series.get('fleet')?.base;
      this.series.set(id, (s = new Series(f ? { ...f, pipelines: f.pipelines / 10, deploys: f.deploys / 10, red: 0 } : { pass: 0.9, run: 90_000, intake: 10_000, pipelines: 2, deploys: 0.2, prAge: 2 * DAY, red: 0 })));
    }
    return s;
  }
  private both(repo: string, f: (s: Series) => void): void {
    f(this.ser('fleet'));
    f(this.ser(this.groupOf(repo)));
  }

  /** Synthetic history: hour `h` of group `gid`, added to the fleet too (the mock's past before
   *  it started). The gauges are the group's; the fleet's are set by the caller. */
  synth(gid: string, h: number, v: { n: number; ok: number; fail: number; run: number[]; intake: number[]; deploys: number; red: number; prAge: number }): void {
    const gs = this.ser(gid), fs = this.ser('fleet');
    const g = gs.at(h), f = fs.at(h);
    for (const b of [g, f]) { b.n += v.n; b.ok += v.ok; b.fail += v.fail; b.deploys += v.deploys; }
    for (const x of v.run) { push48(g.run, x, gs.k++); push48(f.run, x, fs.k++); }
    for (const x of v.intake) { push48(g.intake, x, gs.k++); push48(f.intake, x, fs.k++); }
    g.red = v.red;
    g.prAge = v.prAge;
  }
  /** The fleet's gauges for hour `h` (synthetic past). */
  synthFleetGauges(h: number, red: number, prAge: number): void {
    const b = this.ser('fleet').at(h);
    b.red = red;
    b.prAge = prAge;
  }

  // ── pipelines ──

  /** Everything the state holds now (a fresh start): each pipeline observed once. */
  observeAll(at: number, rollup = true): void {
    for (const _ of this.observeAllSteps(at, rollup, Infinity)) void _;
  }
  /** The same in steps of `chunk` pipelines (the in-app demo's turns). */
  *observeAllSteps(at: number, rollup: boolean, chunk: number): Generator<void, void, void> {
    const ps = Object.entries(this.state.pipelines).sort((a, b) => (a[1].finished ?? a[1].created) - (b[1].finished ?? b[1].created));
    let n = 0;
    for (const [id, p] of ps) {
      if (++n % chunk === 0) yield;
      this.observe(id, p, at, rollup);
    }
  }

  /** A pipeline as it is now (after an upsert or patch): new failed and passed steps, its start
   *  and its finish. Mutates it (Step.cluster, Pipeline.flaky) and marks it when it does. A
   *  failed step is counted once, however often the pipeline is upserted again. */
  observe(id: string, p: Pipeline, now: number, rollup = true): boolean {
    if (!p || !Array.isArray(p.workflows)) return false;
    // (keyed by creation too: a looping fixture replays the same pipeline ids, each loop new runs)
    id = String(id);
    const key = seenKey(id, p);
    const prev = this.seen.get(key);
    const sig = stepSig(p);
    if (prev && prev.st === sig && prev.started === !!p.started && prev.finished === !!p.finished && (!prev.flaky || p.flaky)) return false;
    let touched = false;
    const seen: Seen = prev ?? { st: '', started: false, finished: false, cl: null, flaky: false };
    if (seen.flaky && !p.flaky) { p.flaky = true; touched = true; }
    if (!seen.started && p.started && p.created) {
      if (rollup) this.both(p.repo, (s) => { const b = s.at(Math.floor(p.started! / HOUR)); push48(b.intake, Math.max(0, p.started! - p.created), s.k++); });
      seen.started = true;
    }
    for (const wf of p.workflows) {
      for (const st of wf.steps ?? []) {
        const key = `${wf.name}/${st.name}`;
        if (isFailed(st.state)) {
          const known = seen.cl?.get(key);
          if (known) { if (st.cluster !== known) { st.cluster = known; touched = true; } }
          else if (st.cluster) (seen.cl ??= new Map()).set(key, st.cluster);
          else { (seen.cl ??= new Map()).set(key, this.stepFailed(id, p, wf.name, st, st.finished ?? p.finished ?? now)); touched = true; }
        } else if (st.state === 'success' && !(prev && prev.st.includes(`|${key}=s`))) this.stepPassed(p, wf.name, st.name, st.finished ?? now);
      }
    }
    if (!seen.finished && p.finished && p.state !== 'pending' && p.state !== 'running') {
      seen.finished = true;
      const h = Math.floor(p.finished / HOUR);
      const ok = p.state === 'success', fail = isFailed(p.state);
      if (rollup) this.both(p.repo, (s) => {
        const b = s.at(h);
        b.n++;
        if (ok) b.ok++;
        if (fail) b.fail++;
        if (ok && p.started) push48(b.run, p.finished! - p.started, s.k++);
      });
    }
    seen.st = stepSig(p);
    this.seen.set(key, seen);
    if (this.seen.size > 6000) { let k = 0; for (const key of this.seen.keys()) { if (k++ > 1500) break; this.seen.delete(key); } }
    if (touched) this.mark('pipeline', id);
    return touched;
  }

  private stepFailed(pid: string, p: Pipeline, wf: string, st: { name: string; exit_code?: number; cluster?: string }, at: number): string {
    const step = foldStep(st.name);
    const story = this.stories.get(`${p.repo}|${step}`);
    const cls = story?.cls ?? guessClass(st.name, wf, st.exit_code);
    const line = story ? story.line : errorLineOf(cls, step, p.repo);
    const signature = signatureOf(step, cls, line);
    const cid = clusterIdOf(signature);
    st.cluster = cid;
    let x = this.cx.get(cid);
    if (!x) {
      const first = Math.min(this.firstSeen.get(signature) ?? at, at);
      this.firstSeen.set(signature, first);
      const c: Cluster = { id: cid, signature, step, class: cls, ...(line ? { line } : {}), count: 0, count_1h: 0, repos: [], repo_count: 0, groups: [], first_seen: first, last_seen: at, examples: [], open: 0 };
      x = { c, times: [], openRepos: new Set(), repoAt: new Map(), flakes: [], exPipes: [] };
      this.cx.set(cid, x);
    }
    const c = x.c;
    x.times.push(at);
    if (x.times.length > 2000) x.times.splice(0, 500);
    if (st.exit_code !== undefined) c.exit_code = st.exit_code;
    x.repoAt.set(p.repo, Math.max(at, x.repoAt.get(p.repo) ?? 0));
    x.openRepos.add(p.repo);
    x.exPipes = [pid, ...x.exPipes.filter((e) => e !== pid)].slice(0, 5);
    if (at > c.last_seen) c.last_seen = at;
    if (at < c.first_seen) c.first_seen = at;
    this.lastFail.set(`${p.repo}|${wf}/${step}`, cid);
    this.repoCluster.set(p.repo, cid);
    // flips: this step passed on the same sha before (within 6 h)
    const sk = `${p.repo}@${p.sha}|${wf}/${st.name}`;
    const ss = this.shaSteps.get(sk) ?? { fail: 0, pass: this.shaPasses.get(hash32(sk)) ?? 0, flipped: false, pipes: [] };
    ss.fail = Math.max(ss.fail, at);
    if (!ss.pipes.includes(pid)) ss.pipes.push(pid);
    this.shaSteps.set(sk, ss);
    const fk = `${p.repo}|${wf}/${st.name}`;
    const fl = this.stepFails.get(fk) ?? [];
    fl.push(at);
    if (fl.length > 60) fl.splice(0, 20);
    this.stepFails.set(fk, fl);
    this.refreshCluster(x, at);
    if (!ss.flipped && ss.pass && Math.abs(at - ss.pass) <= 6 * HOUR) this.flip(p.repo, p.sha, wf, st.name, Math.max(at, ss.pass), ss);
    return cid;
  }

  /** A step passed: the repo's latest run of it no longer fails; a flip if it failed on this sha. */
  private stepPassed(p: Pipeline, wf: string, name: string, at: number): boolean {
    const step = foldStep(name);
    const lk = `${p.repo}|${wf}/${step}`;
    const cid = this.lastFail.get(lk);
    if (cid) {
      this.lastFail.delete(lk);
      const x = this.cx.get(cid);
      if (x && x.openRepos.delete(p.repo)) this.refreshCluster(x, at);
    }
    const sk = `${p.repo}@${p.sha}|${wf}/${name}`;
    const ss = this.shaSteps.get(sk);
    if (!ss) {
      this.shaPasses.set(hash32(sk), at);
      if (this.shaPasses.size > 40_000) { let k = 0; for (const h of this.shaPasses.keys()) { if (k++ >= 10_000) break; this.shaPasses.delete(h); } }
      return false;
    }
    ss.pass = Math.max(ss.pass, at);
    if (!ss.flipped && ss.fail && Math.abs(at - ss.fail) <= 6 * HOUR) { this.flip(p.repo, p.sha, wf, name, at, ss); return false; }
    return false;
  }

  /** Forgets same-sha records older than the 6 h a flip may take (the periodic tick). */
  private pruneShaSteps(now: number): void {
    const old = now - 6 * HOUR;
    for (const [k, v] of this.shaSteps) if (Math.max(v.fail, v.pass) < old) this.shaSteps.delete(k);
    for (const [h, t] of this.shaPasses) if (t < old) this.shaPasses.delete(h);
  }

  /** A step failed and passed on the same sha: a Flake flip; the failed runs whose every failed
   *  step has now passed on this sha are flaky. */
  private flip(repo: string, sha: string, wf: string, step: string, at: number, ss: ShaStep): void {
    ss.flipped = true;
    const id = `${repo}|${wf}/${step}`;
    let x = this.fx.get(id);
    if (!x) { x = { f: { id, repo, workflow: wf, step, flips_24h: 0, failures_24h: 0, last_at: at, shas: [] }, flips: [] }; this.fx.set(id, x); }
    x.flips.push(at);
    x.f.shas = [sha, ...x.f.shas.filter((s) => s !== sha)].slice(0, 5);
    x.f.last_at = Math.max(x.f.last_at, at);
    this.refreshFlake(x, at);
    this.log.push({ k: 'flip', at });
    for (const pid of ss.pipes) {
      const p = this.state.pipelines[pid];
      if (!p || p.flaky || !isFailed(p.state)) continue;
      const passed = (k: string) => !!(this.shaSteps.get(k)?.pass || this.shaPasses.get(hash32(k)));
      const all = p.workflows.every((w) => w.steps.every((s) => !isFailed(s.state) || passed(`${repo}@${sha}|${w.name}/${s.name}`)));
      if (!all) continue;
      p.flaky = true;
      const sn = this.seen.get(seenKey(pid, p));
      if (sn) sn.flaky = true;
      this.mark('pipeline', pid);
      for (const w of p.workflows) for (const s of w.steps) {
        const cx = s.cluster ? this.cx.get(s.cluster) : undefined;
        if (cx && isFailed(s.state)) { cx.flakes.push(at); this.refreshCluster(cx, at); }
      }
    }
  }

  /** Seeds a flake's earlier flips (the demo's past). */
  priorFlips(repo: string, wf: string, step: string, ats: number[], shas: string[], failures: number[]): void {
    const id = `${repo}|${wf}/${step}`;
    const x: FlakeX = this.fx.get(id) ?? { f: { id, repo, workflow: wf, step, flips_24h: 0, failures_24h: 0, last_at: 0, shas: [] }, flips: [] };
    x.flips.push(...ats);
    x.flips.sort((a, b) => a - b);
    x.f.shas = [...new Set([...shas, ...x.f.shas])].slice(0, 5);
    x.f.last_at = Math.max(x.f.last_at, ...ats);
    this.fx.set(id, x);
    const fl = this.stepFails.get(id) ?? [];
    for (const t of failures) if (!fl.includes(t)) fl.push(t);
    fl.sort((a, b) => a - b);
    this.stepFails.set(id, fl);
    for (const at of ats) this.log.push({ k: 'flip', at });
    this.log.sort((a, b) => a.at - b.at);
    this.refreshFlake(x, Math.max(...ats));
  }

  private refreshFlake(x: FlakeX, now: number): void {
    const from = now - DAY;
    x.flips = x.flips.filter((t) => t > from);
    const fails = (this.stepFails.get(x.f.id) ?? []).filter((t) => t > from).length;
    const f = x.f;
    if (!x.flips.length) {
      this.fx.delete(f.id);
      if (this.state.flakes[f.id]) { delete this.state.flakes[f.id]; this.mark('flake', f.id); }
      return;
    }
    const next: Flake = { ...f, flips_24h: x.flips.length, failures_24h: Math.max(fails, x.flips.length) };
    x.f = next;
    const cur = this.state.flakes[f.id];
    if (!cur || JSON.stringify(cur) !== JSON.stringify(next)) { this.state.flakes[f.id] = next; this.mark('flake', f.id); }
  }

  private refreshCluster(x: ClusterX, now: number): void {
    const from = now - DAY;
    if (x.times.length && x.times[0]! <= from) x.times = x.times.filter((t) => t > from);
    x.flakes = x.flakes.filter((t) => t > from);
    for (const [r, t] of x.repoAt) if (t <= from) { x.repoAt.delete(r); x.openRepos.delete(r); }
    const c = x.c;
    if (!x.times.length) {
      this.cx.delete(c.id);
      if (this.state.clusters[c.id]) { delete this.state.clusters[c.id]; this.mark('cluster', c.id); }
      return;
    }
    const repos = [...x.repoAt.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).map(([r]) => r);
    const groups: string[] = [];
    for (const r of repos) { const g = this.groupOf(r); if (!groups.includes(g)) groups.push(g); }
    let h1 = 0;
    for (let i = x.times.length - 1; i >= 0 && x.times[i]! > now - HOUR; i--) h1++;
    const next: Cluster = {
      id: c.id, signature: c.signature, step: c.step, class: c.class, ...(c.line ? { line: c.line } : {}), ...(c.exit_code !== undefined ? { exit_code: c.exit_code } : {}),
      count: x.times.length, count_1h: h1, repos: repos.slice(0, 12), repo_count: repos.length, groups,
      first_seen: c.first_seen, last_seen: x.times[x.times.length - 1]!, examples: x.exPipes.slice(0, 5), open: x.openRepos.size,
      ...(x.flakes.length ? { flaky: x.flakes.length } : {}),
    };
    x.c = next;
    const cur = this.state.clusters[c.id];
    if (!cur || JSON.stringify(cur) !== JSON.stringify(next)) { this.state.clusters[c.id] = next; this.mark('cluster', c.id); }
  }

  // ── events ──

  onEvent(e: Event): void {
    switch (e.k) {
      case 'main': {
        const red = isRedState(e.to);
        if (!red && isRedState(e.from)) {
          const r = this.state.repos[e.repo];
          const since = this.redSince.get(e.repo) ?? r?.main?.since ?? e.at;
          this.log.push({ k: 'recovered', at: e.at, repo: e.repo, red_ms: Math.max(0, e.at - since) });
          this.redSince.delete(e.repo);
        } else if (red) this.redSince.set(e.repo, e.at);
        this.setRed(e.repo, red);
        break;
      }
      case 'deploy':
        if (e.state === 'success' || e.state === 'failure') {
          this.log.push({ k: 'deploy', at: e.at, app: e.app, sha: e.sha, state: e.state });
          this.countDeploy(this.state.apps[e.app]?.repo, e.at);
        }
        break;
      case 'health':
        this.log.push({ k: 'health', at: e.at, app: e.app, from: e.from, to: e.to });
        break;
      case 'merge':
        this.log.push({ k: 'merge', at: e.at });
        break;
    }
    if (this.log.length > 8000) this.log.splice(0, 2000);
  }
  private redSince = new Map<string, number>();

  /** A finished deploy into the hourly rollups. */
  countDeploy(repo: string | undefined, at: number): void {
    const h = Math.floor(at / HOUR);
    if (repo) this.both(repo, (s) => { s.at(h).deploys++; });
    else this.ser('fleet').at(h).deploys++;
  }

  /** The change log's past from what a fresh state holds: main-line recoveries in the repos'
   *  recent dots, finished deploys, merged PRs (all within 24 h). */
  seedLog(now: number): void {
    const from = now - DAY;
    for (const r of Object.values(this.state.repos)) {
      const dots = r.main?.recent ?? [];
      let redAt = 0;
      for (const d of dots) {
        if (isRedState(d.state)) { if (!redAt) redAt = d.at; }
        else if (d.state === 'success' && redAt) {
          if (d.at > from && d.at <= now) this.log.push({ k: 'recovered', at: d.at, repo: r.id, red_ms: d.at - redAt });
          redAt = 0;
        }
      }
      if (isRedState(r.main?.state)) this.redSince.set(r.id, r.main.since);
    }
    for (const d of Object.values(this.state.deploys)) {
      if ((d.state === 'success' || d.state === 'failure') && d.finished && d.finished > from && d.finished <= now) this.log.push({ k: 'deploy', at: d.finished, app: d.app, sha: d.sha, state: d.state });
    }
    for (const p of Object.values(this.state.prs) as Pr[]) {
      if ((p.phase === 'merged' || p.phase === 'deployed') && p.updated > from && p.updated <= now) this.log.push({ k: 'merge', at: p.updated });
    }
    this.log.sort((a, b) => a.at - b.at);
  }

  // ── the periodic recompute ──

  /** Decays the 24 h windows, samples the gauges and recomputes every trend (call every few
   *  minutes of fleet time; O(repos + PRs + groups × 24)). */
  tick(now: number): void {
    this.lastTick = now;
    const st = this.state;
    const from = now - DAY;
    // only the clusters whose 24 h or 1 h window moved past one of their failures
    for (const x of [...this.cx.values()]) {
      let h1 = 0;
      for (let i = x.times.length - 1; i >= 0 && x.times[i]! > now - HOUR; i--) h1++;
      if (h1 !== x.c.count_1h || (x.times[0] ?? 0) <= from || (x.flakes[0] ?? Infinity) <= from) this.refreshCluster(x, now);
    }
    for (const x of [...this.fx.values()]) if ((x.flips[0] ?? 0) <= from) this.refreshFlake(x, now);
    this.pruneShaSteps(now);
    let k = 0;
    while (k < this.log.length && this.log[k]!.at <= from) k++;
    if (k) this.log.splice(0, k);
    for (const [sig, t] of this.firstSeen) if (t < now - 7 * DAY) this.firstSeen.delete(sig);
    for (const [key, ts] of this.stepFails) { const kept = ts.filter((t) => t > from); if (kept.length) this.stepFails.set(key, kept); else this.stepFails.delete(key); }
    // red counts (also catches a main that changed without an event) and the gauges
    const red = new Map<string, number>();
    let fleetRed = 0;
    for (const r of Object.values(st.repos)) {
      const isR = isRedState(r.main?.state);
      if (isR !== this.redRepos.has(r.id)) { if (isR) this.redRepos.add(r.id); else this.redRepos.delete(r.id); }
      if (!isR) continue;
      fleetRed++;
      const g = this.groupOf(r.id);
      red.set(g, (red.get(g) ?? 0) + 1);
    }
    for (const g of Object.values(st.groups)) {
      const n = red.get(g.id) ?? 0;
      if (g.red !== n) { st.groups[g.id] = { ...g, red: n }; this.mark('group', g.id); }
    }
    const ages = new Map<string, number[]>();
    const all: number[] = [];
    for (const p of Object.values(st.prs) as Pr[]) {
      if (p.bot || p.phase === 'merged' || p.phase === 'closed' || p.phase === 'deployed') continue;
      const age = Math.max(0, now - p.created);
      all.push(age);
      const g = this.groupOf(p.repo);
      let xs = ages.get(g);
      if (!xs) ages.set(g, (xs = []));
      xs.push(age);
    }
    const h = Math.floor(now / HOUR);
    const sample = (sid: string, r: number, age: number) => {
      const s = this.ser(sid);
      const b = s.at(h);
      b.red = r;
      b.prAge = age;
      // a fresh start: the hour before carries the first sample rather than a gap
      const pb = s.at(h - 1);
      if (pb.red < 0) { pb.red = r; pb.prAge = age; }
    };
    sample('fleet', fleetRed, p50(all) ?? -1);
    for (const gid of Object.keys(st.groups)) sample(gid, red.get(gid) ?? 0, p50(ages.get(gid) ?? []) ?? -1);
    for (const id of Object.keys(st.trends)) if (id !== 'fleet' && !st.groups[id]) { delete st.trends[id]; this.mark('trend', id); }
    // the trends follow, a few per call of `tickTrends` (the in-app demo's turns stay small)
    this.trendQueue = ['fleet', ...Object.keys(st.groups).sort()];
  }

  /** Trends still to recompute after a `tick`. */
  private trendQueue: string[] = [];
  get trendsDue(): boolean { return this.trendQueue.length > 0; }
  /** Recomputes up to `max` of the trends a `tick` queued. */
  tickTrends(now: number, max = Infinity): void {
    for (let i = 0; i < max && this.trendQueue.length; i++) {
      const id = this.trendQueue.shift()!;
      if (id !== 'fleet' && !this.state.groups[id]) continue;
      this.state.trends[id] = this.trendOf(id, now);
      this.mark('trend', id);
    }
  }

  /** One series' Trend at `now`: h1 (the last 60 minutes: this hour and the rest of the one
   *  before), h24, d7 (the baseline blended with today), 24 hourly sparks, the current hour last. */
  trendOf(id: string, now: number): Trend {
    const s = this.ser(id);
    const H = Math.floor(now / HOUR);
    const f = (now - H * HOUR) / HOUR;
    const cur = s.get(H) ?? newBucket(H), prev = s.get(H - 1) ?? newBucket(H - 1);
    const w = 1 - f;
    const hrs: Bucket[] = [];
    for (let i = 23; i >= 0; i--) hrs.push(s.get(H - i) ?? newBucket(H - i));
    const sum = (k: 'n' | 'ok' | 'fail' | 'deploys') => hrs.reduce((a, b) => a + b[k], 0);
    const h1n = cur.n + prev.n * w, h1ok = cur.ok + prev.ok * w, h1fail = cur.fail + prev.fail * w;
    const runs = [...cur.run, ...prev.run], intakes = [...cur.intake, ...prev.intake];
    const allRun: number[] = [], allIn: number[] = [];
    for (const b of hrs) { allRun.push(...b.run); allIn.push(...b.intake); }
    const pass = (ok: number, fail: number): number | null => (ok + fail > 0 ? r3(ok / (ok + fail)) : null);
    const gauge = (k: 'red' | 'prAge'): (number | null)[] => hrs.map((b) => (b[k] >= 0 ? (k === 'prAge' ? sec(b[k]) : b[k]) : null));
    const lastGauge = (k: 'red' | 'prAge'): number | null => { for (let i = hrs.length - 1; i >= 0; i--) if (hrs[i]![k] >= 0) return k === 'prAge' ? sec(hrs[i]![k]) : hrs[i]![k]; return null; };
    const avgGauge = (k: 'red' | 'prAge'): number | null => { const xs = hrs.filter((b) => b[k] >= 0).map((b) => b[k]); return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null; };
    const base = s.base;
    const blend = (b: number, today: number | null): number => (today === null ? b : (b * 144 + today * 24) / 168);
    const m = (h1: number | null, h24: number | null, d7: number | null, spark: (number | null)[], kind: 'ms' | 'rate' | 'pass' | 'count', worse: -1 | 0 | 1): Metric => {
      const fix = (v: number | null): number | null => (v === null || !Number.isFinite(v) ? null : kind === 'ms' ? sec(v) : kind === 'pass' ? r3(v) : kind === 'rate' ? r2(v) : Math.round(v * 100) / 100);
      const a = fix(h1), b24 = fix(h24), b7 = fix(d7);
      const ref = b7 ?? b24;
      let dir: -1 | 0 | 1 = 0;
      if (a !== null && ref !== null) {
        if (kind === 'pass') dir = a - ref > 0.03 ? 1 : a - ref < -0.03 ? -1 : 0;
        else if (ref === 0) dir = a > 0 ? 1 : 0;
        else dir = a > ref * 1.15 ? 1 : a < ref * 0.85 ? -1 : 0;
      }
      const out: Metric = { h1: a, h24: b24, d7: b7, dir, spark: spark.map(fix) };
      if (dir !== 0 && worse !== 0 && dir === worse) out.bad = true;
      return out;
    };
    const passSpark = hrs.map((b, i) => (i === 23 ? pass(h1ok, h1fail) : pass(b.ok, b.fail)));
    const pipeSpark = hrs.map((b, i) => (i === 23 ? h1n : b.n));
    const depSpark = hrs.map((b, i) => (i === 23 ? cur.deploys + prev.deploys * w : b.deploys));
    const runSpark = hrs.map((b, i) => (i === 23 ? p50(runs) : p50(b.run)));
    const inSpark = hrs.map((b, i) => (i === 23 ? p50(intakes) : p50(b.intake)));
    const h24pass = pass(sum('ok'), sum('fail'));
    const h24run = p50(allRun), h24in = p50(allIn);
    const h24red = avgGauge('red'), h24age = avgGauge('prAge');
    return {
      id, at: now,
      intake_ms: m(p50(intakes), h24in, blend(base.intake, h24in), inSpark, 'ms', 1),
      run_ms: m(p50(runs), h24run, blend(base.run, h24run), runSpark, 'ms', 1),
      pass_rate: m(pass(h1ok, h1fail), h24pass, blend(base.pass, h24pass), passSpark, 'pass', -1),
      pipelines: m(h1n, sum('n') / 24, blend(base.pipelines, sum('n') / 24), pipeSpark, 'rate', 0),
      deploys: m(cur.deploys + prev.deploys * w, sum('deploys') / 24, blend(base.deploys, sum('deploys') / 24), depSpark, 'rate', 0),
      pr_age_ms: m(lastGauge('prAge'), h24age, blend(base.prAge, h24age), gauge('prAge'), 'ms', 1),
      red: m(lastGauge('red'), h24red, blend(base.red, h24red), gauge('red'), 'count', 1),
      hours_7d: this.hours7d,
    };
  }

  // ── queries ──

  insights(now: number): Insights {
    const st = this.state;
    const groups = Object.values(st.groups).sort((a, b) => b.repos - a.repos || (a.name < b.name ? -1 : 1));
    const clusters = Object.values(st.clusters).sort(clusterOrder);
    const flakes = Object.values(st.flakes).sort((a, b) => b.flips_24h - a.flips_24h || b.last_at - a.last_at || (a.id < b.id ? -1 : 1));
    const name = (id: string) => st.groups[id]?.name ?? id;
    const trends = Object.values(st.trends).sort((a, b) => (a.id === 'fleet' ? -1 : b.id === 'fleet' ? 1 : name(a.id) < name(b.id) ? -1 : name(a.id) > name(b.id) ? 1 : 0));
    return { at: now, groups, clusters, flakes, trends };
  }

  /** "Since your last visit" over (since, until], within the retained 24 h. */
  changes(sinceIn: number, untilIn: number | undefined, now: number): Changes {
    const st = this.state;
    const floor = now - DAY;
    const until = Math.min(now, untilIn ?? now);
    const complete = sinceIn >= floor;
    const since = Math.min(until, Math.max(sinceIn, floor));
    const inWin = (t: number) => t > since && t <= until;
    const counts: ChangeCounts = { red: 0, recovered: 0, still_red: 0, pipelines: 0, failed: 0, deploys: 0, deploys_failed: 0, clusters_new: 0, flakes: 0, prs_merged: 0, apps_down: 0, apps_recovered: 0 };
    const red: Changes['red'] = [];
    const stillRed: Changes['still_red'] = [];
    for (const r of Object.values(st.repos)) {
      if (!isRedState(r.main?.state)) continue;
      const group = this.groupOf(r.id);
      if (inWin(r.main.since)) {
        const cluster = this.culpritCluster(r) ?? this.repoCluster.get(r.id);
        red.push({ repo: r.id, group, at: r.main.since, ...(r.main.culprit ? { culprit: r.main.culprit } : {}), ...(cluster && st.clusters[cluster] ? { cluster } : {}) });
      } else if (r.main.since <= since) stillRed.push({ repo: r.id, group, since: r.main.since });
    }
    red.sort((a, b) => b.at - a.at || (a.repo < b.repo ? -1 : 1));
    stillRed.sort((a, b) => a.since - b.since || (a.repo < b.repo ? -1 : 1));
    const recovered: Changes['recovered'] = [];
    const deploys: Changes['deploys'] = [];
    const apps: Changes['apps'] = [];
    const recSeen = new Set<string>();
    for (let i = this.log.length - 1; i >= 0; i--) {
      const e = this.log[i]!;
      if (!inWin(e.at)) continue;
      if (e.k === 'recovered') {
        if (recSeen.has(e.repo) || isRedState(st.repos[e.repo]?.main?.state)) continue;
        recSeen.add(e.repo);
        recovered.push({ repo: e.repo, group: this.groupOf(e.repo), at: e.at, red_ms: e.red_ms });
      } else if (e.k === 'deploy') {
        counts.deploys++;
        if (e.state === 'failure') counts.deploys_failed++;
        if (deploys.length < 50) deploys.push({ app: e.app, sha: e.sha, state: e.state, at: e.at });
      } else if (e.k === 'health') {
        apps.push({ app: e.app, from: e.from, to: e.to, at: e.at });
        if (e.to === 'down') counts.apps_down++;
        if (e.to === 'up' && (e.from === 'down' || e.from === 'degraded')) counts.apps_recovered++;
      } else if (e.k === 'merge') counts.prs_merged++;
    }
    const clusters: Changes['clusters'] = [];
    for (const x of this.cx.values()) {
      let n = 0;
      for (let i = x.times.length - 1; i >= 0 && x.times[i]! > since; i--) if (x.times[i]! <= until) n++;
      if (!n) continue;
      const isNew = x.c.first_seen > since;
      if (isNew) counts.clusters_new++;
      clusters.push({ id: x.c.id, count: n, new: isNew });
    }
    clusters.sort((a, b) => b.count - a.count || (a.id < b.id ? -1 : 1));
    for (const f of Object.values(st.flakes)) if (inWin(f.last_at)) counts.flakes++;
    // pipelines and failures: the hourly buckets, the hour at each end pro-rated
    const window = (sid: string): { n: number; fail: number } => {
      const s = this.series.get(sid);
      let n = 0, fail = 0;
      if (!s) return { n, fail };
      for (const b of s.buckets) {
        const lo = Math.max(since, b.h * HOUR), hi = Math.min(until, (b.h + 1) * HOUR);
        if (hi <= lo) continue;
        // the current hour is only filled up to now
        const span = Math.min(HOUR, Math.max(1, Math.min(now, (b.h + 1) * HOUR) - b.h * HOUR));
        const part = Math.min(1, (hi - lo) / span);
        n += b.n * part;
        fail += b.fail * part;
      }
      return { n: Math.round(n), fail: Math.round(fail) };
    };
    const fw = window('fleet');
    counts.pipelines = fw.n;
    counts.failed = fw.fail;
    const groups: Changes['groups'] = [];
    for (const gid of Object.keys(st.groups)) {
      const gw = window(gid);
      const r = red.filter((x) => x.group === gid).length;
      if (gw.fail || r) groups.push({ id: gid, failed: gw.fail, red: r });
    }
    groups.sort((a, b) => b.red - a.red || b.failed - a.failed || (a.id < b.id ? -1 : 1));
    counts.red = red.length;
    counts.recovered = recovered.length;
    counts.still_red = stillRed.length;
    return { since, until, complete, counts, red, recovered, still_red: stillRed, clusters: clusters.slice(0, 20), deploys, apps: apps.slice(0, 100), groups };
  }

  /** The cluster of the failing step of a red main's culprit run. */
  private culpritCluster(r: Repo): string | undefined {
    const c = r.main.culprit ? this.state.commits[`${r.id}@${r.main.culprit}`] : undefined;
    for (const pid of c?.pipelines ?? []) {
      const p = this.state.pipelines[pid];
      for (const w of p?.workflows ?? []) for (const s of w.steps) if (s.cluster && isFailed(s.state)) return s.cluster;
    }
    return undefined;
  }
}

/** Insights order: open first, then count_1h, then count. */
export function clusterOrder(a: Cluster, b: Cluster): number {
  return (b.open > 0 ? 1 : 0) - (a.open > 0 ? 1 : 0) || b.count_1h - a.count_1h || b.count - a.count || b.last_seen - a.last_seen || (a.id < b.id ? -1 : 1);
}

const seenKey = (id: string, p: Pipeline): string => `${id}@${p.created ?? 0}`;

/** A compact signature of a pipeline's step states (what changed since it was last observed). */
function stepSig(p: Pipeline): string {
  let s = p.state;
  for (const w of p.workflows) for (const st of w.steps ?? []) s += `|${w.name}/${st.name}=${st.state === 'success' ? 's' : isFailed(st.state) ? 'f' : st.state[0]}${st.cluster ? 'c' : ''}`;
  return s;
}

// ───────────────────────────── synthetic past (the mock has no week behind it) ─────────────────────────────

/** Activity by hour of day (US Central business hours), 0.2..1. */
export function dayShape(ms: number): number {
  const local = ((ms % DAY) / HOUR - 6 + 24) % 24;
  const d = Math.abs(local - 13.5);
  return d < 5 ? 1 : d < 9 ? 1 - (0.8 * (d - 5)) / 4 : 0.2;
}

/** A pass-rate shape over the last hours: the demo's trending stories. `ago` in hours (0 = now). */
export type PassShape = (ago: number) => number;

/** Fills hours [from, to) of every group from its baseline, deterministic per `rng`. The fleet
 *  is the sum of its groups. `shape` bends a group's pass rate (a story); `scale` is the share of
 *  an hour to fill (the hour the simulation starts in is part-synthetic). */
export function synthPast(fl: Floor, rng: Rng, groups: string[], from: number, to: number, shapes: Map<string, PassShape> = new Map(), deploysToo = true): void {
  for (let t = Math.floor(from / HOUR) * HOUR; t < to; t += HOUR) {
    const h = Math.floor(t / HOUR);
    const part = Math.min(1, (to - t) / HOUR, (t + HOUR - from) / HOUR);
    const ago = (to - t) / HOUR;
    let fleetRed = 0;
    for (const gid of groups) {
      const b = fl.ser(gid).base;
      const vol = b.pipelines * (0.35 + 0.9 * dayShape(t)) * part;
      const n = Math.max(0, Math.round(vol + (rng() - 0.5) * Math.sqrt(vol + 1)));
      const pass = Math.min(0.995, Math.max(0.3, (shapes.get(gid)?.(ago) ?? b.pass) + (rng() - 0.5) * 0.04));
      const term = Math.round(n * 0.95);
      let ok = 0;
      if (term <= 40) { for (let i = 0; i < term; i++) if (rng() < pass) ok++; }
      else ok = Math.round(term * pass);
      const run: number[] = [], intake: number[] = [];
      for (let i = 0; i < Math.min(4, ok); i++) run.push(Math.round(b.run * (0.75 + rng() * 0.5)));
      for (let i = 0; i < Math.min(4, n); i++) intake.push(Math.round(b.intake * (0.6 + rng() * 0.8 + 0.6 * dayShape(t))));
      const deploys = deploysToo ? Math.max(0, Math.round(b.deploys * (0.3 + dayShape(t)) * part + (rng() - 0.5))) : 0;
      const red = Math.max(0, Math.round(b.red + (rng() - 0.5) * 1.2));
      fleetRed += red;
      fl.synth(gid, h, { n, ok, fail: term - ok, run, intake, deploys, red, prAge: Math.round(b.prAge * (0.9 + rng() * 0.2)) });
    }
    fl.synthFleetGauges(h, fleetRed, Math.round(fl.ser('fleet').base.prAge * (0.9 + rng() * 0.2)));
  }
}

/** The Floor of a recorded (v0.4) fleet, derived deterministically from what its snapshot holds:
 *  groups from the apps catalog; clusters from the failed steps of its pipelines (last 2 h);
 *  flakes from flips on the same sha and from steps that fail repeatedly with passes between
 *  (a recording has few re-runs); 7 d baselines from the census (Stats and the repos' heat);
 *  the 22 h before its pipelines synthesized around them; the change log from its main lines,
 *  deploys and merged PRs. */
export function seedRecorded(fl: Floor, now: number, rng: Rng): void {
  const st = fl.state;
  fl.catalog();
  const stats = st.stats ?? ({} as Snapshot['stats']);
  const groups = Object.keys(st.groups).sort();
  const openAges: number[] = [];
  for (const p of Object.values(st.prs) as Pr[]) if (!p.bot && p.phase !== 'merged' && p.phase !== 'closed' && p.phase !== 'deployed') openAges.push(Math.max(0, now - p.created));
  const fleet: Baseline = {
    pass: stats.success_rate_24h || 0.85, run: stats.p50_build_ms || 60_000, intake: stats.p50_queue_ms || 8_000,
    pipelines: Math.max(1, (stats.pipelines_24h || 240) / 24), deploys: Math.max(0.1, (stats.deploys_24h || 24) / 24),
    prAge: p50(openAges) ?? 2 * DAY, red: Object.values(st.groups).reduce((a, g) => a + g.red, 0),
  };
  fl.baseline('fleet', fleet);
  const heat = new Map<string, { w: number; runs: number[] }>();
  let wsum = 0;
  for (const r of Object.values(st.repos)) {
    const g = fl.groupOf(r.id);
    let x = heat.get(g);
    if (!x) heat.set(g, (x = { w: 0, runs: [] }));
    const w = 0.02 + (r.heat ?? 0);
    x.w += w;
    wsum += w;
    if (r.p50_build_ms) x.runs.push(r.p50_build_ms);
  }
  const appsN = Math.max(1, Object.keys(st.apps).length);
  for (const g of groups) {
    const x = heat.get(g) ?? { w: 0, runs: [] };
    const grp = st.groups[g]!;
    const j = (hash32(g) % 1000) / 1000 - 0.5;
    fl.baseline(g, {
      pass: Math.min(0.99, Math.max(0.5, fleet.pass + 0.12 * j)), run: p50(x.runs) ?? fleet.run, intake: Math.round(fleet.intake * (1 + 0.5 * j)),
      pipelines: Math.max(0.05, (fleet.pipelines * x.w) / (wsum || 1)), deploys: Math.max(0.02, (fleet.deploys * grp.apps) / appsN),
      prAge: Math.round(fleet.prAge * (1 + 0.6 * j)), red: grp.red,
    });
  }
  let oldest = now;
  for (const p of Object.values(st.pipelines)) if (p.finished && p.finished < oldest) oldest = p.finished;
  synthPast(fl, rng, groups, now - DAY, Math.max(now - DAY, oldest), new Map(), false);
  // deploys: the snapshot holds the real 24 h of them
  for (const d of Object.values(st.deploys)) if ((d.state === 'success' || d.state === 'failure') && d.finished && d.finished > now - DAY) fl.countDeploy(d.repo, d.finished);
  fl.observeAll(now);
  flapping(fl, now);
  fl.seedLog(now);
  fl.tick(now);
  fl.tickTrends(now);
}

/** A step that failed at least twice with a pass between, on different shas (within 6 h): the
 *  recording's flakes, its passes taken as the flips. */
function flapping(fl: Floor, now: number): void {
  const runs = new Map<string, { at: number; ok: boolean; sha: string }[]>();
  const keys = new Map<string, [string, string, string]>();
  for (const p of Object.values(fl.state.pipelines)) {
    for (const w of p.workflows ?? []) for (const s of w.steps ?? []) {
      if (s.state !== 'success' && !isFailed(s.state)) continue;
      const k = `${p.repo}|${w.name}/${s.name}`;
      let xs = runs.get(k);
      if (!xs) { runs.set(k, (xs = [])); keys.set(k, [p.repo, w.name, s.name]); }
      xs.push({ at: s.finished ?? p.finished ?? now, ok: s.state === 'success', sha: p.sha });
    }
  }
  for (const [k, xs] of [...runs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    if (xs.filter((x) => !x.ok).length < 2) continue;
    xs.sort((a, b) => a.at - b.at);
    const flips: number[] = [], shas: string[] = [], fails: number[] = [];
    for (let i = 1; i + 1 < xs.length; i++) {
      const a = xs[i - 1]!, b = xs[i]!, c = xs[i + 1]!;
      if (!a.ok && b.ok && !c.ok && c.at - a.at <= 6 * HOUR) { flips.push(b.at); shas.unshift(a.sha); }
    }
    for (const x of xs) if (!x.ok) fails.push(x.at);
    if (!flips.length) continue;
    const [repo, wf, step] = keys.get(k)!;
    fl.priorFlips(repo, wf, step, flips, shas.slice(0, 5), fails);
  }
}
