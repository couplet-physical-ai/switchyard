// LIVE FLOW: the primary view's model. One row per EVENT (a push, a PR, a merge, a tag, a cron
// firing, a manual run), what HANDLED it (every pipeline it started: kind, CI, machine + slot,
// live step) and the RESULT (pass / fail at a step with its error line / cancelled; a deploy:
// which app got which sha and its health now). Derived from the World only, bounded (caps
// below), memoized on (w.ver, ⌊now/1000⌋, filter). The view (view.ts) codes against these types.
//
// Grouping: pipelines by repo + sha + trigger (Pipeline.event, push on the default branch of a
// PR's commit = merge). A cron or manual trigger fires many times on the same sha, so those split
// into firings (pipelines created within FIRE_GAP_MS of each other); their id carries the firing's
// first creation time (`…#cron@<t0>`). Other triggers keep the plain id `${repo}@${sha}#${kind}`
// for the run nearest the push; a re-run of the same sha much later (> RERUN_GAP_MS) is its own
// row (`…#push@<t0>`), since it is a new event happening now.

import type { World } from '../world.ts';
import { COLL } from '../yard/select.ts';
import type { CiState, Commit, Engine, Pipeline, Step, Workflow } from '../wire.ts';

export type FlowKind = 'build' | 'test' | 'lint' | 'deploy' | 'release' | 'ci';
export type FlowEventKind = 'push' | 'pr' | 'merge' | 'tag' | 'cron' | 'manual' | 'deployment';
export type FlowBand = 'now' | 'just' | 'earlier';
export type FlowState = 'waiting' | 'queued' | 'running' | 'pass' | 'fail' | 'cancelled' | 'skipped';
export interface FlowMachine {
  /** `m:<host>` ("m:VM 153", "m:Mac mini") or `m:gha` (GitHub runners). flowMachine takes it. */
  id: string;
  /** What to print: the host ("VM 153", "Mac mini") or "GitHub runner". */
  label: string;
  /** 1-based slot on the host (agents ordered by label, then the position in the agent's running list). */
  slot?: number;
  /** Slots on the host (all its agents), absent for GitHub runners. */
  slots?: number;
  /** Busy slots on the host now (GitHub: running GHA pipelines). */
  busy?: number;
  host?: string;
  /** (extra) The agent the job runs on ("dagger-ci-153-2"). */
  agent?: string;
  /** (extra) Every agent of the host is offline (FlowView.machines only). */
  online?: boolean;
}
export interface FlowStep {
  name: string;
  /** 1-based position of the step in its workflow ("3/7" = index 3, count 7). */
  index: number;
  count: number;
  started?: number;
  /** (extra) The workflow it belongs to. */
  workflow?: string;
}
export interface FlowDeploy { app: string; url?: string; sha: string; state: FlowState; health?: 'up' | 'degraded' | 'down' | 'unknown'; via: string }
export interface FlowResult {
  state: FlowState;
  /** The first failed step's name. */
  failStep?: string;
  /** (extra) Its workflow. */
  failWorkflow?: string;
  errorLine?: string;
  durationMs?: number;
  deploy?: FlowDeploy;
}
export interface FlowJob {
  id: string;            // the Pipeline id
  ci: 'roadrunner' | 'gha'; kind: FlowKind; name: string;     // the workflow names, short
  state: FlowState; created: number; started?: number; finished?: number;
  expectedMs?: number; queuePos?: number;
  machine?: FlowMachine; step?: FlowStep; result: FlowResult; url: string;
}
export interface FlowEvent {
  id: string;            // stable: `${repo}@${sha}#${kind}` (one row per repo+sha+trigger; see the header)
  kind: FlowEventKind; repo: string; group?: string; branch: string; sha: string; pr?: number;
  author: string; bot: boolean; title: string; at: number; url: string;   // GitHub commit/PR url
  band: FlowBand; jobs: FlowJob[];   // jobs ordered: running, queued, then finished (fail first)
  /** (extra) The event as a whole: waiting (pushed, no CI yet) | running | queued | fail | cancelled | pass. */
  state: FlowState;
  /** (extra) The last job's finish (bands `just`/`earlier`). */
  finished?: number;
  /** (extra) Jobs beyond the per-event cap (JOBS_CAP), not in `jobs`. */
  more?: number;
  /** (extra, `earlier` only) A cron that fired many times on one sha is ONE earlier row (id
   *  `${repo}@${sha}#cron~`): `folded` firings (this row shows the newest), `foldedFail` failed. */
  folded?: number;
  foldedFail?: number;
}
export interface FlowFilter { repo?: string; group?: string; branch?: string; author?: string }
export interface FlowView {
  at: number; running: number; queued: number; idle: boolean;
  machines: FlowMachine[];           // each engine host: busy/slots/online
  events: FlowEvent[];               // now (all, cap 40) + just (≤ 20, 15 min) + earlier (≤ 30, 2 h)
  lastEventAt?: number;
  /** (extra) `now` rows still waiting for CI (pushed, no pipeline yet). */
  waiting?: number;
  /** (extra) The view's rows stay as they are while the clock is at most this (the world
   *  unchanged): the next time a row crosses a band's edge (just → earlier, out of the 2 h,
   *  a waiting push out of its 5 min). Only texts (timers, ages) move before it. */
  until: number;
}
export interface FlowStepDetail { name: string; state: FlowState; ms?: number; cached?: boolean; errorLine?: string; started?: number }
export interface FlowWorkflowDetail { name: string; state: FlowState; started?: number; finished?: number; machine?: FlowMachine; steps: FlowStepDetail[] }
export interface FlowJobDetail extends FlowJob {
  workflows: FlowWorkflowDetail[];
  /** (extra) The event row this job belongs to. */
  repo: string; sha: string; branch: string; title: string;
}

// ---- caps and windows ----
export const NOW_CAP = 40;
export const JUST_CAP = 20;
export const EARLIER_CAP = 30;
export const JOBS_CAP = 12;
export const JUST_MS = 15 * 60_000;
export const EARLIER_MS = 2 * 3_600_000;
export const WAIT_MS = 5 * 60_000;
/** cron / manual: pipelines created within this of the previous one are one firing. */
export const FIRE_GAP_MS = 60_000;
/** other triggers: a run of the same sha created this long after the previous one is a re-run. */
export const RERUN_GAP_MS = 20 * 60_000;
const STEPS_CAP = 60;
const WORKFLOWS_CAP = 24;

// ---- states ----

export function flowState(s: CiState | string | undefined): FlowState {
  switch (s) {
    case 'success': return 'pass';
    case 'failure': case 'error': return 'fail';
    case 'canceled': return 'cancelled';
    case 'skipped': return 'skipped';
    case 'running': return 'running';
    case 'pending': return 'queued';
    default: return 'waiting'; // blocked (approval / depends_on), none
  }
}
const live = (s: FlowState) => s === 'running' || s === 'queued' || s === 'waiting';
const doneRank = (s: FlowState) => (s === 'fail' ? 0 : s === 'cancelled' ? 1 : s === 'pass' ? 2 : 3);

// ---- classification ----

// Name keywords (no lookbehind: Hermes). A name is classified by its LAST keyword ("release-lint" lints, "lint-fix" too);
// a deploy keyword anywhere wins ("Deploy Docs" deploys).
const RE_DEPLOY = /deploy|rollout|promote|provision|failsafe/i;
const KEYWORDS: [RegExp, FlowKind][] = [
  [/release|(?:^|[^a-z])tag(?![a-z])|package|homebrew|(?:^|[^a-z])cask|(?:^|[^a-z])dist(?![a-z])|installer|publish|notari[sz]e/gi, 'release'],
  [/lint|fmt|format|clippy|eslint|ruff|prettier|gitleaks|security|scan|audit|osv|typecheck|(?:^|[^a-z])tsc(?![a-z])/gi, 'lint'],
  [/test|e2e|spec(?![a-z])|smoke|(?:^|[^a-z])qa(?![a-z])|check|verify|validate|contract|compat/gi, 'test'],
  [/build|compile|image|docker|bundle|wheel|cargo|(?:^|[^a-z])ml(?![a-z])|(?:^|[^a-z])docs?(?![a-z])|site/gi, 'build'],
];
const GENERIC = /^(ci|main|pipeline|default|workflow)$/i;

/** One workflow name's kind (or null: no keyword). */
export function nameKind(name: string): FlowKind | null {
  if (RE_DEPLOY.test(name)) return 'deploy';
  let best: FlowKind | null = null, at = -1;
  for (const [re, kind] of KEYWORDS) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(name))) { if (m.index >= at) { at = m.index; best = kind; } if (!m[0]) re.lastIndex++; }
  }
  return best;
}

/** The pipeline's kind: a tag is a release; a deploy pipeline (or a deploy workflow) a deploy;
 *  a release workflow a release; a plain `ci` workflow stays `ci`; else test > lint > build over
 *  the workflow names; else `ci`. */
export function kindOf(p: Pipeline): FlowKind {
  if (p.event === 'tag') return 'release';
  if (p.deploy || p.event === 'deployment') return 'deploy';
  const names = wfNames(p);
  let rel = false, test = false, lint = false, build = false, generic = names.length === 0;
  for (const n of names) {
    const k = nameKind(n);
    if (k === 'deploy') return 'deploy';
    if (k === 'release') rel = true;
    else if (k === 'test') test = true;
    else if (k === 'lint') lint = true;
    else if (k === 'build') build = true;
    if (GENERIC.test(n.trim())) generic = true;
  }
  if (rel) return 'release';
  // A plain `ci` workflow builds and tests: it stays `ci`.
  if (generic) return 'ci';
  if (test) return 'test';
  if (lint) return 'lint';
  if (build) return 'build';
  return 'ci';
}
function wfNames(p: Pipeline): string[] {
  const ws = p.workflows ?? [];
  if (ws.length) return ws.map((w) => w.name);
  return p.lane === 'gha' && p.title ? [p.title] : [];
}
/** The job's short name: the workflow names (GHA: the run's workflow), ≤ 3 then "+N". */
export function jobName(p: Pipeline): string {
  const names = wfNames(p);
  if (!names.length) return p.lane === 'gha' ? 'GitHub Actions' : `#${p.number ?? ''}`;
  const uniq: string[] = [];
  for (const n of names) if (!uniq.includes(n)) uniq.push(n);
  return uniq.length <= 3 ? uniq.join(' · ') : `${uniq.slice(0, 3).join(' · ')} +${uniq.length - 3}`;
}

/** Distinct non-empty names, ≤ 3 then "+N". */
function short(names: string[]): string {
  const uniq: string[] = [];
  for (const n of names) if (n && !uniq.includes(n)) uniq.push(n);
  return uniq.length <= 3 ? uniq.join(' · ') : `${uniq.slice(0, 3).join(' · ')} +${uniq.length - 3}`;
}

function eventKindOf(p: Pipeline, c: Commit | undefined, defaultBranch: string | undefined): FlowEventKind {
  switch (p.event) {
    case 'pull_request': return 'pr';
    case 'tag': return 'tag';
    case 'cron': return 'cron';
    case 'manual': return 'manual';
    case 'deployment': return 'deployment';
    default:
      return c?.pr != null && defaultBranch != null && (p.branch === defaultBranch || c.branch === defaultBranch) ? 'merge' : 'push';
  }
}

// ---- machines ----

const GHA_ID = 'm:gha';

type HostAgg = { id: string; host: string; slots: number; busy: number; online: boolean; agents: Engine[]; order: number };
type EngIndex = {
  ver: number;
  byName: Map<string, Engine>;        // id and label → engine
  hosts: Map<string, HostAgg>;        // host → aggregate
  slotOf: Map<string, { host: string; slot: number; agent: string }>; // pipeline id → its slot
};
const engCache = new WeakMap<World, EngIndex>();

/** The host a raw engine name lives on, when the engine table does not know it. */
export function hostOfName(name: string): string {
  const m = /(?:^|-)ci-(\d{2,4})-\d+$/.exec(name) ?? /(?:vm|VM)[ -]?(\d{2,4})/.exec(name);
  if (m) return `VM ${m[1]}`;
  if (/mac-?mini/i.test(name)) return 'Mac mini';
  return name;
}
function hostOf(e: Engine): string {
  if (e.host) return e.host;
  if (e.kind === 'dagger' && e.id.startsWith('dagger:')) return e.id.slice(7);
  return hostOfName(e.label ?? e.id);
}
function hostOrder(h: string): number {
  const m = /^VM (\d+)/.exec(h);
  if (m) return Number(m[1]);
  if (/mac/i.test(h)) return 10_000;
  return 20_000;
}

function engIndex(w: World): EngIndex {
  const hit = engCache.get(w);
  // Engines, and whether the runs they name still run (World.kv bumps on every change; a load bumps all).
  const ver = w.kv.engine * 100003 + w.kv.pipeline;
  if (hit && hit.ver === ver) return hit;
  const byName = new Map<string, Engine>();
  const hosts = new Map<string, HostAgg>();
  const slotOf = new Map<string, { host: string; slot: number; agent: string }>();
  const agents: Engine[] = [];
  for (const e of w.engines.values()) {
    byName.set(e.id, e);
    if (e.label && !byName.has(e.label)) byName.set(e.label, e);
    if (e.kind === 'gha_runner') continue;
    const host = hostOf(e);
    let h = hosts.get(host);
    if (!h) hosts.set(host, (h = { id: `m:${host}`, host, slots: 0, busy: 0, online: false, agents: [], order: hostOrder(host) }));
    if (e.kind === 'wp_agent' || !(e.agents?.length)) h.agents.push(e);
    if (e.online !== false) h.online = true;
    agents.push(e);
  }
  for (const h of hosts.values()) {
    // A Dagger host listing its agents counts through them (its own slots are the same slots).
    const wp = h.agents.filter((e) => e.kind === 'wp_agent');
    if (wp.length) h.agents = wp;
    h.agents.sort((a, b) => COLL.compare(a.label ?? a.id, b.label ?? b.id)); // (one collator: Hermes makes one per localeCompare, p5)
    let base = 0;
    for (const e of h.agents) {
      h.slots += e.slots ?? 0;
      // A run the engine still names but the world removed (or holds finished) holds no slot,
      // even before the server patches the engine (Felipe's phantoms).
      let gone = 0;
      for (const pid of e.running ?? []) { const p = w.pipelines.get(pid); if (!p || p.state !== 'running') gone++; }
      h.busy += Math.max(0, (e.busy ?? 0) - gone);
      (e.running ?? []).forEach((pid, i) => { if (!slotOf.has(pid)) slotOf.set(pid, { host: h!.host, slot: base + i + 1, agent: e.label ?? e.id }); });
      base += Math.max(e.slots ?? 0, e.running?.length ?? 0);
    }
  }
  const idx: EngIndex = { ver, byName, hosts, slotOf };
  engCache.set(w, idx);
  return idx;
}

function hostMachine(h: HostAgg, extra?: { slot?: number; agent?: string }): FlowMachine {
  const m: FlowMachine = { id: h.id, label: h.host, host: h.host, slots: h.slots, busy: h.busy, online: h.online };
  if (extra?.slot != null) m.slot = extra.slot;
  if (extra?.agent) m.agent = extra.agent;
  return m;
}

function engineName(p: Pipeline): string | undefined {
  if (p.engine) return p.engine;
  const ws = p.workflows ?? [];
  for (const wf of ws) if (wf.state === 'running' && wf.engine) return wf.engine;
  for (let i = ws.length - 1; i >= 0; i--) if (ws[i].engine) return ws[i].engine;
  return undefined;
}

/** Where a job runs (host, slot, the host's load now) or, finished, where it ran (host + agent). */
function machineOf(w: World, p: Pipeline, idx: EngIndex, ghaBusy: number, engine?: string): FlowMachine | undefined {
  const m = machineNow(p, idx, ghaBusy, engine);
  if (!m || live(flowState(p.state))) return m;
  const out: FlowMachine = { id: m.id, label: m.label };
  if (m.host) out.host = m.host;
  if (m.agent) out.agent = m.agent;
  void w;
  return out;
}
function machineNow(p: Pipeline, idx: EngIndex, ghaBusy: number, engine?: string): FlowMachine | undefined {
  if (p.lane === 'gha') return { id: GHA_ID, label: 'GitHub runner', busy: ghaBusy };
  const name = engine ?? engineName(p);
  const pid = p.id ?? '';
  const pos = idx.slotOf.get(pid);
  // (a workflow that names its own agent, in the steps panel, is placed by that agent)
  if (pos && (!engine || engine === pos.agent || idx.byName.get(engine)?.label === pos.agent)) {
    const h = idx.hosts.get(pos.host)!;
    return hostMachine(h, { slot: pos.slot, agent: pos.agent });
  }
  if (!name) return undefined;
  const e = idx.byName.get(name);
  const host = e ? hostOf(e) : hostOfName(name);
  const h = idx.hosts.get(host);
  if (h) return hostMachine(h, { agent: e?.label ?? name });
  return { id: `m:${host}`, label: host, host, agent: name };
}

// ---- jobs ----

function runningStep(p: Pipeline): FlowStep | undefined {
  const ws = p.workflows ?? [];
  let wf: Workflow | undefined = ws.find((x) => x.state === 'running');
  if (!wf) wf = ws.find((x) => x.state === 'pending' || x.state === 'blocked');
  if (!wf) return undefined;
  const steps = wf.steps ?? [];
  if (!steps.length) return undefined;
  // The newest running step (parallel steps: the one that started last is the news), else the
  // first not yet finished.
  let at = -1;
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    if (s.state === 'running' && (at < 0 || (s.started ?? 0) >= (steps[at].started ?? 0))) at = i;
  }
  if (at < 0) at = steps.findIndex((s) => s.state === 'pending' || s.state === 'blocked' || s.state === 'none');
  if (at < 0) at = steps.length - 1;
  const s = steps[at];
  const out: FlowStep = { name: s.name, index: at + 1, count: steps.length, workflow: wf.name };
  if (s.started != null) out.started = s.started;
  return out;
}

function firstFailed(p: Pipeline): { wf: Workflow; step: Step } | undefined {
  for (const wf of p.workflows ?? []) {
    for (const s of wf.steps ?? []) if (s.state === 'failure' || s.state === 'error') return { wf, step: s };
  }
  for (const wf of p.workflows ?? []) {
    if (wf.state === 'failure' || wf.state === 'error') return { wf, step: { name: wf.name, state: wf.state } };
  }
  return undefined;
}

function deployState(s: string | undefined): FlowState {
  switch (s) {
    case 'success': return 'pass';
    case 'failure': return 'fail';
    case 'running': return 'running';
    case 'pending': return 'queued';
    default: return 'waiting';
  }
}

function flowDeployOf(w: World, repo: string, sha: string): FlowDeploy | undefined {
  const d = w.deploys.get(`${repo}@${sha}`);
  if (!d) return undefined;
  const app = w.apps.get(d.app);
  const out: FlowDeploy = { app: d.app, sha: d.sha ?? sha, state: deployState(d.state), via: d.via ?? 'roadrunner' };
  const url = app?.url ?? d.url;
  if (url) out.url = url;
  if (app?.health) out.health = app.health;
  return out;
}

/** A job per pipeline object (the World replaces a pipeline on every change, so the object is
 *  its version), re-derived when what else it reads moved: engines, clusters, deploys, apps, and
 *  for GHA the runner count. Jobs are shared between views: treat them as read-only. */
const jobCache = new WeakMap<Pipeline, { key: string; job: FlowJob }>();

function jobOf(w: World, p: Pipeline, idx: EngIndex, ghaBusy: number): FlowJob {
  // A finished job's machine is only where it ran (no slot, no load), so it does not move with
  // every engine change: it re-derives only when the set of engines changes (World.shapeVer).
  const done = !live(flowState(p.state));
  const key = done
    ? `d${w.shapeVer}|${w.kv.cluster}|${w.kv.deploy}|${w.kv.app}`
    : `${idx.ver}|${w.kv.cluster}|${w.kv.deploy}|${w.kv.app}|${p.lane === 'gha' ? ghaBusy : 0}`;
  const hit = jobCache.get(p);
  if (hit && hit.key === key) return hit.job;
  const job = makeJob(w, p, idx, ghaBusy);
  jobCache.set(p, { key, job });
  return job;
}

function makeJob(w: World, p: Pipeline, idx: EngIndex, ghaBusy: number): FlowJob {
  const state = flowState(p.state);
  const kind = kindOf(p);
  const result: FlowResult = { state };
  if (state === 'fail') {
    const f = firstFailed(p);
    if (f) {
      result.failStep = f.step.name;
      result.failWorkflow = f.wf.name;
      const line = f.step.cluster ? w.clusters.get(f.step.cluster)?.line : undefined;
      if (line) result.errorLine = line;
    } else if (!(p.workflows ?? []).length) {
      // Woodpecker errors before any workflow exists (a config error): say so, name no step.
      result.errorLine = 'pipeline error before any step ran';
    }
  }
  // The deploy result: on the pipeline that ran it (Deploy.pipeline), else on a deploy job.
  const d = w.deploys.get(`${p.repo}@${p.sha}`);
  if (d && (d.pipeline === p.id || (kind === 'deploy' && (!d.pipeline || !w.pipelines.has(d.pipeline))))) {
    const dep = flowDeployOf(w, p.repo, p.sha);
    if (dep) result.deploy = dep;
  }
  if (p.finished != null) result.durationMs = Math.max(0, p.finished - (p.started ?? p.created));
  const job: FlowJob = {
    id: p.id ?? '', ci: p.lane === 'gha' ? 'gha' : 'roadrunner', kind, name: jobName(p),
    state, created: p.created, result, url: p.url ?? '',
  };
  if (p.started != null) job.started = p.started;
  if (p.finished != null) job.finished = p.finished;
  if (p.expected_ms != null) job.expectedMs = p.expected_ms;
  if (state === 'queued' && p.queue_pos != null) job.queuePos = p.queue_pos;
  const m = machineOf(w, p, idx, ghaBusy);
  if (m) job.machine = m;
  if (state === 'running') { const s = runningStep(p); if (s) job.step = s; }
  return job;
}

/** running, queued/waiting, then finished: fail, cancelled, pass, skipped; newest first inside. */
function jobOrder(a: FlowJob, b: FlowJob): number {
  const ra = a.state === 'running' ? 0 : live(a.state) ? 1 : 2;
  const rb = b.state === 'running' ? 0 : live(b.state) ? 1 : 2;
  if (ra !== rb) return ra - rb;
  if (ra === 2) {
    const d = doneRank(a.state) - doneRank(b.state);
    if (d) return d;
    return (b.finished ?? 0) - (a.finished ?? 0) || cmp(a.id, b.id);
  }
  if (ra === 0) return (a.started ?? a.created) - (b.started ?? b.created) || cmp(a.id, b.id);
  return (a.queuePos ?? 1e9) - (b.queuePos ?? 1e9) || a.created - b.created || cmp(a.id, b.id);
}
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

// ---- events ----

function ghUrl(w: World, repo: string): string {
  const g = w.repos.get(repo)?.links?.github;
  return g ? g.replace(/\/+$/, '') : `https://github.com/${repo}`;
}
function eventUrl(w: World, repo: string, sha: string, kind: FlowEventKind, pr?: number): string {
  const base = ghUrl(w, repo);
  return kind === 'pr' && pr != null ? `${base}/pull/${pr}` : `${base}/commit/${sha}`;
}

type Draft = {
  id: string; kind: FlowEventKind; repo: string; sha: string; t0: number; tLast: number;
  pipes: Pipeline[]; commit?: Commit;
};

/** All event rows of the world (unfiltered, unbanded), keyed and cached per w.ver. */
type Built = { key: string; drafts: Draft[]; shas: Set<string>; pushed: Commit[] };
const buildCache = new WeakMap<World, Built>();

function drafts(w: World): Built {
  // Rows read pipelines, commits (author, title, pr) and repos (default branch): rebuilt only when
  // one of those changed, not on every frame.
  const key = `${w.kv.pipeline}|${w.kv.commit}|${w.kv.repo}`;
  const hit = buildCache.get(w);
  if (hit && hit.key === key) return hit;
  // repo + sha + raw event → pipelines
  const groups = new Map<string, Pipeline[]>();
  for (const p of w.pipelines.values()) {
    if (!p || !p.repo || !p.sha) continue;
    const k = `${p.repo}@${p.sha}#${p.event}`;
    let g = groups.get(k);
    if (!g) groups.set(k, (g = []));
    g.push(p);
  }
  const out: Draft[] = [];
  for (const g of groups.values()) {
    const p0 = g[0];
    const c = w.commits.get(`${p0.repo}@${p0.sha}`);
    const def = w.repos.get(p0.repo)?.default_branch;
    const kind = eventKindOf(p0, c, def);
    const base = `${p0.repo}@${p0.sha}#${kind}`;
    if (g.length > 1) g.sort((a, b) => a.created - b.created || cmp(a.id ?? '', b.id ?? ''));
    const fire = kind === 'cron' || kind === 'manual';
    const gap = fire ? FIRE_GAP_MS : RERUN_GAP_MS;
    const runs: Draft[] = [];
    let cur: Draft | null = null;
    for (const p of g) {
      if (!cur || p.created - cur.tLast > gap) {
        cur = { id: '', kind, repo: p.repo, sha: p.sha, t0: p.created, tLast: p.created, pipes: [], commit: c };
        runs.push(cur);
      }
      cur.pipes.push(p);
      cur.tLast = p.created;
    }
    // Ids: a firing is `@t0`; for other triggers the run nearest the push is the plain id.
    let anchor = -1;
    if (!fire) {
      const ref = c?.at ?? runs[0].t0;
      let best = Infinity;
      runs.forEach((r, i) => { const d = Math.abs(r.t0 - ref); if (d < best) { best = d; anchor = i; } });
    }
    runs.forEach((r, i) => { r.id = i === anchor ? base : `${base}@${r.t0}`; out.push(r); });
  }
  const shas = new Set<string>();
  for (const d of out) shas.add(`${d.repo}@${d.sha}`);
  // commits still at `pushed` (the waiting rows' candidates), newest first, bounded
  const pushed: Commit[] = [];
  for (const c of w.commits.values()) if (c.stage === 'pushed' && !shas.has(`${c.repo}@${c.sha}`)) pushed.push(c);
  pushed.sort((a, b) => b.at - a.at);
  if (pushed.length > NOW_CAP * 2) pushed.length = NOW_CAP * 2;
  const built: Built = { key, drafts: out, shas, pushed };
  buildCache.set(w, built);
  return built;
}

/** Pushes with no pipeline yet: a commit at stage `pushed`, or a recent `push` event. */
function waitingDrafts(w: World, now: number, b: Built, lim: { until: number }): Draft[] {
  const out: Draft[] = [];
  // the list changes when a scanned time leaves the 5 min (or a future one comes within 1 min)
  const edge = (at: number) => {
    const t = at > now + 60_000 ? at - 60_001 : at + WAIT_MS;
    if (t < lim.until) lim.until = t;
  };
  const seen = new Set<string>();
  const since = now - WAIT_MS;
  const add = (repo: string, sha: string, at: number, c: Commit | undefined) => {
    if (!repo || !sha || at < since || at > now + 60_000) return;
    const key = `${repo}@${sha}`;
    if (seen.has(key) || b.shas.has(key)) return;
    seen.add(key);
    const def = w.repos.get(repo)?.default_branch;
    const kind: FlowEventKind = c?.pr != null && def != null && c.branch === def ? 'merge' : 'push';
    out.push({ id: `${key}#${kind}`, kind, repo, sha, t0: at, tLast: at, pipes: [], commit: c });
  };
  // the recent feed first (bounded, newest last)
  const rec = w.recent;
  for (let i = rec.length - 1; i >= 0; i--) {
    const e = rec[i];
    if (e.at < since) break;
    edge(e.at);
    // A push whose commit the server already moved on (a repo with no CI: the server marks it
    // done at once) waits for nothing: no waiting row, no intake count.
    const known = e.k === 'push' ? w.commits.get(`${e.repo}@${e.sha}`) : undefined;
    if (known && known.stage !== 'pushed') continue;
    if (e.k === 'push') add(e.repo, e.sha, e.at, known ?? ({ repo: e.repo, sha: e.sha, branch: e.branch, title: e.title, author: e.author, bot: e.bot, at: e.at, stage: 'pushed', ci: 'none', pipelines: [] } as Commit));
  }
  for (const c of b.pushed) {
    if (c.at < since) break;
    edge(c.at);
    add(c.repo, c.sha, c.at, c);
  }
  return out;
}

function eventOf(w: World, d: Draft, idx: EngIndex, ghaBusy: number, now: number): FlowEvent {
  const c = d.commit;
  const p0 = d.pipes[0];
  const repo = w.repos.get(d.repo);
  let jobs = d.pipes.map((p) => jobOf(w, p, idx, ghaBusy));
  if (jobs.length > 1) jobs.sort(jobOrder);
  let more: number | undefined;
  if (jobs.length > JOBS_CAP) { more = jobs.length - JOBS_CAP; jobs = jobs.slice(0, JOBS_CAP); }
  // the event's state: anything live wins; else the worst finish
  let state: FlowState = 'waiting';
  let finished: number | undefined;
  if (jobs.length) {
    const top = jobs[0].state;
    state = top === 'waiting' ? 'queued' : top;
    if (top === 'skipped') state = 'pass';
    for (const j of jobs) if (j.finished != null && (finished == null || j.finished > finished)) finished = j.finished;
  }
  const fire = d.kind === 'cron' || d.kind === 'manual' || d.kind === 'deployment';
  const ghaTitle = p0?.lane === 'gha';
  // The event time: the push (the commit's time) when it is the run's trigger, else the first run.
  let at = d.t0;
  if (!fire && c?.at != null && c.at <= d.t0 && d.t0 - c.at <= RERUN_GAP_MS) at = c.at;
  // Title and author. A cron firing: its cron names (the pipelines' titles), else its jobs; no
  // author (the scheduler fired it: the commit's author did not, and "mine" must not match it).
  // A manual run: who ran it. Else the commit.
  let title: string, author: string;
  if (d.kind === 'cron') {
    title = short(d.pipes.map((p) => p.title ?? '')) || short(d.pipes.map(jobName)) || c?.title || '';
    author = d.pipes.find((p) => p.author)?.author ?? '';
  } else {
    title = (!fire && c?.title) || d.pipes.find((p) => p.lane !== 'gha' && p.title)?.title || c?.title || (ghaTitle ? p0?.title : '') || '';
    author = (fire ? d.pipes.find((p) => p.author)?.author : undefined) ?? c?.author ?? d.pipes.find((p) => p.author)?.author ?? '';
  }
  const branch = d.pipes.find((p) => p.event === 'pull_request')?.branch ?? p0?.branch ?? c?.branch ?? '';
  const pr = d.pipes.find((p) => p.pr != null)?.pr ?? c?.pr;
  const ev: FlowEvent = {
    id: d.id, kind: d.kind, repo: d.repo, branch, sha: d.sha, author,
    bot: !!(c?.bot) || /(\[bot\]|-bot)$/i.test(author), title, at, url: eventUrl(w, d.repo, d.sha, d.kind, pr),
    band: 'now', jobs, state,
  };
  if (repo?.group) ev.group = repo.group;
  if (pr != null) ev.pr = pr;
  if (finished != null && !live(state)) ev.finished = finished;
  if (more) ev.more = more;
  ev.band = live(state) ? 'now' : (finished ?? at) >= now - JUST_MS ? 'just' : 'earlier';
  return ev;
}

function matches(w: World, d: Draft, f: FlowFilter | undefined): boolean {
  if (!f) return true;
  if (f.repo && d.repo !== f.repo) return false;
  if (f.group && w.repos.get(d.repo)?.group !== f.group) return false;
  if (f.branch) {
    const b = d.commit?.branch;
    if (b !== f.branch && !d.pipes.some((p) => p.branch === f.branch)) return false;
  }
  if (f.author) {
    const a = f.author.trim().replace(/^@/, '').toLowerCase();
    if (a) {
      const ca = (d.commit?.author ?? '').toLowerCase();
      if (ca !== a && !d.pipes.some((p) => (p.author ?? '').toLowerCase() === a)) return false;
    }
  }
  return true;
}

function filterKey(f?: FlowFilter): string {
  if (!f) return '';
  const k = `${f.repo ?? ''}\u0001${f.group ?? ''}\u0001${f.branch ?? ''}\u0001${(f.author ?? '').trim().replace(/^@/, '').toLowerCase()}`;
  return k === '\u0001\u0001\u0001' ? '' : k;
}

/** The fleet's machines: one per host (agents summed), then GitHub runners. */
function machinesOf(idx: EngIndex, ghaBusy: number): FlowMachine[] {
  const out: FlowMachine[] = [];
  const hosts = [...idx.hosts.values()].sort((a, b) => a.order - b.order || cmp(a.host, b.host));
  for (const h of hosts) out.push(hostMachine(h));
  out.push({ id: GHA_ID, label: 'GitHub runner', busy: ghaBusy });
  return out;
}

const ghaCache = new WeakMap<World, { ver: number; n: number }>();
function ghaRunning(w: World): number {
  const hit = ghaCache.get(w);
  if (hit && hit.ver === w.kv.pipeline) return hit.n;
  let n = 0;
  for (const p of w.pipelines.values()) if (p.lane === 'gha' && p.state === 'running') n++;
  ghaCache.set(w, { ver: w.kv.pipeline, n });
  return n;
}

type Memo = { ver: number; sec: number; key: string; view: FlowView };
const memo = new WeakMap<World, Memo[]>();
const MEMO_KEYS = 4;

/** The LIVE FLOW view model. Memoized on (w.ver, ⌊now/1000⌋, filter): the last few filters. */
export function flowOf(w: World, now: number, filter?: FlowFilter): FlowView {
  const sec = Math.floor(now / 1000);
  const key = filterKey(filter);
  let list = memo.get(w);
  if (list) {
    for (const m of list) if (m.ver === w.ver && m.sec === sec && m.key === key) return m.view;
  } else memo.set(w, (list = []));
  const view = build(w, now, filter);
  list.push({ ver: w.ver, sec, key, view });
  if (list.length > MEMO_KEYS) list.splice(0, list.length - MEMO_KEYS);
  return view;
}

function build(w: World, now: number, filter?: FlowFilter): FlowView {
  const idx = engIndex(w);
  const gha = ghaRunning(w);
  const built = drafts(w);
  const all = built.drafts;
  const lim = { until: Infinity };
  const waiting = waitingDrafts(w, now, built, lim);
  const nowEv: FlowEvent[] = [];
  // finished rows: only those that can be shown (or fold into a shown cron) become events, so a
  // fleet's 700 finished runs of the last 2 h cost a sort key each, not an event each
  type Fin = { d: Draft; t: number; ev?: FlowEvent };
  const justC: Fin[] = [];
  const earlyC: Fin[] = [];
  let until = lim.until;
  let running = 0, queued = 0, lastEventAt: number | undefined;
  const horizon = now - EARLIER_MS;
  const finished = (d: Draft, ev?: FlowEvent) => {
    let t: number;
    if (ev) t = ev.finished ?? ev.at;
    else {
      // eventOf's own `finished` (the latest job's finish; every job kept, under JOBS_CAP) and `at`
      let fin: number | undefined;
      for (const p of d.pipes) if (p.finished != null && (fin == null || p.finished > fin)) fin = p.finished;
      const c = d.commit;
      let at = d.t0;
      const fire = d.kind === 'cron' || d.kind === 'manual' || d.kind === 'deployment';
      if (!fire && c?.at != null && c.at <= d.t0 && d.t0 - c.at <= RERUN_GAP_MS) at = c.at;
      t = fin ?? at;
    }
    if (t >= now - JUST_MS) { justC.push({ d, t, ev }); if (t + JUST_MS < until) until = t + JUST_MS; }
    else if (t >= horizon) { earlyC.push({ d, t, ev }); if (t + EARLIER_MS < until) until = t + EARLIER_MS; }
  };
  const consider = (d: Draft) => {
    if (!matches(w, d, filter)) return;
    // cheap pre-cut: a run whose every pipeline finished before the horizon is gone
    let alive = d.pipes.length === 0;
    let lastT = d.tLast;
    for (const p of d.pipes) {
      if (live(flowState(p.state))) { alive = true; break; }
      const t = p.finished ?? p.started ?? p.created;
      if (t > lastT) lastT = t;
    }
    if (lastEventAt == null || d.t0 > lastEventAt) lastEventAt = d.t0;
    if (!alive && lastT < horizon) return;
    if (!alive && d.pipes.length <= JOBS_CAP) { finished(d); return; }
    const ev = eventOf(w, d, idx, gha, now);
    if (ev.band === 'now') {
      nowEv.push(ev);
      for (const j of ev.jobs) { if (j.state === 'running') running++; else if (j.state === 'queued' || j.state === 'waiting') queued++; }
      // jobs past the cap still count
      if (ev.more) {
        for (const p of d.pipes) {
          if (ev.jobs.some((j) => j.id === p.id)) continue;
          const s = flowState(p.state);
          if (s === 'running') running++; else if (s === 'queued' || s === 'waiting') queued++;
        }
      }
    } else finished(d, ev);
  };
  for (const d of all) consider(d);
  for (const d of waiting) consider(d);
  const byFinish = (a: Fin, b: Fin) => b.t - a.t || cmp(a.d.id, b.d.id);
  justC.sort(byFinish);
  earlyC.sort(byFinish);
  const evOf = (c: Fin) => c.ev ?? eventOf(w, c.d, idx, gha, now);
  const just = justC.slice(0, JUST_CAP).map(evOf);
  // earlier: the rows foldCrons keeps under the cap, and every later firing of a cron they head
  const earlier: FlowEvent[] = [];
  const heads = new Set<string>();
  let shown = 0;
  for (const c of earlyC) {
    if (c.d.kind === 'cron') {
      const k = `${c.d.repo}@${c.d.sha}#cron~`;
      if (!heads.has(k)) { if (shown >= EARLIER_CAP) continue; heads.add(k); shown++; }
    } else { if (shown >= EARLIER_CAP) continue; shown++; }
    earlier.push(evOf(c));
  }
  // now: the newest trigger first; just and earlier (sorted above, by key) both by the newest
  // finish: a row sliding from just into earlier keeps its place
  nowEv.sort((a, b) => lastTrigger(b) - lastTrigger(a) || cmp(a.id, b.id));
  foldCrons(earlier);
  const events = [
    ...nowEv.slice(0, NOW_CAP),
    ...just.slice(0, JUST_CAP),
    ...earlier.slice(0, EARLIER_CAP),
  ];
  const view: FlowView = {
    at: now, running, queued, idle: nowEv.length === 0,
    machines: machinesOf(idx, gha), events, until,
  };
  if (lastEventAt != null) view.lastEventAt = lastEventAt;
  let waitingRows = 0;
  for (const e of nowEv) if (e.state === 'waiting') waitingRows++;
  if (waitingRows) view.waiting = waitingRows;
  return view;
}

/** Earlier cron firings on the same repo + sha fold into one row (the newest, which `earlier`
 *  lists first), so a 5-minute cron does not push every other event out of the band. In place. */
function foldCrons(earlier: FlowEvent[]): void {
  let fold: Map<string, FlowEvent> | null = null;
  let w = 0;
  for (let i = 0; i < earlier.length; i++) {
    const e = earlier[i];
    if (e.kind !== 'cron') { earlier[w++] = e; continue; }
    const k = `${e.repo}@${e.sha}#cron~`;
    const head = (fold ??= new Map()).get(k);
    if (!head) {
      fold.set(k, e);
      earlier[w++] = e;
      continue;
    }
    if (!head.folded) { head.folded = 1; head.foldedFail = head.state === 'fail' ? 1 : 0; head.id = k; }
    head.folded++;
    if (e.state === 'fail') head.foldedFail = (head.foldedFail ?? 0) + 1;
    if (e.title) {
      const names = head.title ? head.title.split(' · ') : [];
      if (!names.includes(e.title) && !/ \+\d+$/.test(head.title)) head.title = short([...names, ...e.title.split(' · ')]);
    }
  }
  earlier.length = w;
}

/** A `now` row's newest trigger: its latest-created job (a re-run moves it up), else its time. */
function lastTrigger(e: FlowEvent): number {
  let t = e.at;
  for (const j of e.jobs) if (j.created > t) t = j.created;
  return t;
}

// ---- panels ----

/** The steps panel of one pipeline: its workflows, each step's state, duration and error line. */
export function flowJob(w: World, pipelineId: string, now: number): FlowJobDetail | null {
  const p = w.pipelines.get(pipelineId);
  if (!p) return null;
  const idx = engIndex(w);
  const gha = ghaRunning(w);
  const job = jobOf(w, p, idx, gha);
  const c = w.commits.get(`${p.repo}@${p.sha}`);
  const workflows: FlowWorkflowDetail[] = (p.workflows ?? []).slice(0, WORKFLOWS_CAP).map((wf) => {
    const out: FlowWorkflowDetail = { name: wf.name, state: flowState(wf.state), steps: [] };
    if (wf.started != null) out.started = wf.started;
    if (wf.finished != null) out.finished = wf.finished;
    if (wf.engine) { const m = machineOf(w, p, idx, gha, wf.engine); if (m) out.machine = m; }
    else if (job.machine) out.machine = job.machine;
    for (const s of (wf.steps ?? []).slice(0, STEPS_CAP)) {
      const st: FlowStepDetail = { name: s.name, state: flowState(s.state) };
      if (s.started != null) {
        st.started = s.started;
        if (s.finished != null) st.ms = Math.max(0, s.finished - s.started);
        else if (s.state === 'running') st.ms = Math.max(0, now - s.started);
      }
      if (s.cached) st.cached = true;
      if (s.cluster) { const line = w.clusters.get(s.cluster)?.line; if (line) st.errorLine = line; }
      out.steps.push(st);
    }
    return out;
  });
  return { ...job, workflows, repo: p.repo, sha: p.sha, branch: p.branch ?? c?.branch ?? '', title: c?.title ?? p.title ?? '' };
}

/** A machine (its `m:` id, a host, an engine id or label, or `m:gha`) and what it runs now. */
export function flowMachine(w: World, engineId: string, now: number): { machine: FlowMachine; running: FlowJob[] } | null {
  const idx = engIndex(w);
  const gha = ghaRunning(w);
  const RUN_CAP = 40;
  if (engineId === GHA_ID || engineId === 'gha' || engineId === 'GitHub runner') {
    const running: FlowJob[] = [];
    for (const p of w.pipelines.values()) {
      if (p.lane === 'gha' && p.state === 'running') running.push(jobOf(w, p, idx, gha));
    }
    running.sort(jobOrder);
    return { machine: { id: GHA_ID, label: 'GitHub runner', busy: gha }, running: running.slice(0, RUN_CAP) };
  }
  let host = engineId.startsWith('m:') ? engineId.slice(2) : engineId;
  if (!idx.hosts.has(host)) {
    const e = idx.byName.get(engineId);
    host = e ? hostOf(e) : hostOfName(engineId);
  }
  const h = idx.hosts.get(host);
  if (!h) return null;
  const ids = new Set<string>();
  for (const e of h.agents) for (const pid of e.running ?? []) ids.add(pid);
  // pipelines that say they run here even if the engine table has not caught up
  for (const p of w.pipelines.values()) {
    if (p.state !== 'running' || p.lane === 'gha' || !p.id || ids.has(p.id)) continue;
    const n = engineName(p);
    if (!n) continue;
    const e = idx.byName.get(n);
    if ((e ? hostOf(e) : hostOfName(n)) === host) ids.add(p.id);
  }
  const running: FlowJob[] = [];
  for (const id of ids) {
    const p = w.pipelines.get(id);
    if (p) running.push(jobOf(w, p, idx, gha));
  }
  running.sort(jobOrder);
  return { machine: hostMachine(h), running: running.slice(0, RUN_CAP) };
}
