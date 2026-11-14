// Switchyard wire contract v0.5 (contract/CONTRACT.md), as TypeScript; a v0.4 server is still read
// (World.v05 is false there, and src/insights.ts approximates the 0.5 tables). The server owns the
// contract; this file mirrors it. Unknown fields are ignored and unknown kinds skipped.
// The built-in demo (server/sim.ts) speaks the same shapes, with two old habits the client
// tolerates: snapshot collections as id-keyed maps (v0.2 sends arrays) and entities without
// their own `id` (the client sets it from the key).

export type CiState = 'success' | 'failure' | 'running' | 'pending' | 'blocked' | 'skipped' | 'canceled' | 'error' | 'none';
export type LaneMode = 'roadrunner_first' | 'gha_first' | 'primary' | 'ci' | 'failsafe' | 'ci_only' | 'none';
export type Stage = 'pushed' | 'queued' | 'building' | 'gating' | 'merged' | 'deploying' | 'deployed' | 'failed' | 'done';
export type Health = 'up' | 'degraded' | 'down' | 'unknown';
export type PrPhase = 'draft' | 'checks' | 'review' | 'changes_requested' | 'mergeable' | 'conflict' | 'merged' | 'closed' | 'deployed';
export type DeployState = 'pending' | 'running' | 'success' | 'failure';
export type DeployVia = 'roadrunner' | 'gha' | 'gha_fallback' | 'manual';

export type Org = { id: string; repos: number };
export type Dot = { sha: string; at: number; state: CiState; author: string; bot?: boolean; title: string; deployed?: boolean; culprit?: boolean };
/** `recent`: oldest first, newest last, ≤ 40. */
export type MainState = { head: string; state: CiState; since: number; culprit?: string | null; recent: Dot[] };
export type Repo = {
  id: string; org: string; name: string; default_branch: string; lane: LaneMode; lane_note?: string;
  app?: string; main: MainState; heat: number; open_prs: number; last_activity?: number;
  links: { github: string; woodpecker?: string; cicd?: string };
  p50_build_ms?: number;
  /** v0.5: Group id (team from the apps catalog, else the org). */
  group?: string;
};
export type DeployRef = { id: string; state: DeployState };
export type Commit = {
  id?: string; repo: string; sha: string; branch: string; title: string; author: string; bot?: boolean; at: number;
  pr?: number; stage: Stage; ci: CiState; pipelines: string[]; deploy?: DeployRef;
};
export type Step = {
  name: string; state: CiState; started?: number; finished?: number; exit_code?: number; cached?: boolean;
  /** v0.5: failed steps: the failure Cluster id. */
  cluster?: string;
};
export type Workflow = { name: string; state: CiState; started?: number; finished?: number; engine?: string; steps: Step[] };
export type Pipeline = {
  /** "wp:<owner/name>:<number>" | "gha:<run_id>" (the demo leaves it to the key; the client sets it). */
  id?: string;
  lane: 'roadrunner' | 'gha'; repo: string; number: number; sha: string; branch: string;
  event: 'push' | 'pull_request' | 'tag' | 'cron' | 'manual' | 'deployment';
  state: CiState; created: number; started?: number; finished?: number; queue_pos?: number;
  engine?: string; title?: string; author?: string; pr?: number; deploy?: boolean;
  workflows: Workflow[]; url: string; expected_ms?: number;
  /** v0.5: failed, but every failed step passed on the same sha within 6 h. */
  flaky?: boolean;
};
export type Pr = {
  id?: string; repo: string; number: number; title: string; author: string; bot?: boolean; draft: boolean;
  created: number; updated: number; head_sha: string; head?: string; base: string; phase: PrPhase; ci?: CiState;
  /** v0.4: only required checks and checks that have not passed (PrDetail has them all). */
  checks: { name: string; state: CiState; required?: boolean }[];
  /** v0.4: how many other checks passed. */
  checks_passed?: number;
  review: { ai?: 'pending' | 'commented' | 'approved' | 'skipped'; human?: string };
  merged_at?: number; merge_sha?: string; blocked_by?: string; stale_ms?: number; url: string;
};
export type Deploy = {
  id?: string; app: string; repo: string; sha: string; via: DeployVia; state: DeployState;
  started: number; finished?: number; pipeline?: string; url?: string;
};
export type App = {
  id?: string; repo?: string; url: string; health: Health; latency_ms?: number; checked: number;
  live_sha?: string; main_sha?: string; behind?: number; last_deploy?: DeployRef; runtime?: string; team?: string; note?: string;
};
export type Engine = {
  id: string; kind: 'dagger' | 'wp_agent' | 'gha_runner'; label?: string; platform?: string; host?: string;
  online?: boolean; slots: number; busy: number; cpu?: number; mem?: number; load?: number; last_seen?: number;
  running: string[]; agents?: string[];
};
export type Queue = {
  id: string; pending: number; running: number; waiting?: number; pipelines_running?: number; paused?: boolean;
  oldest_wait_ms: number; items: string[];
};
export type Lane = { id: string; mode: LaneMode; fallback?: boolean; held?: boolean; note?: string };
export type Watcher = { id: 'outage'; tripped: boolean; since?: number; gh_status: string; note?: string };
export type Stats = {
  id?: string; commits_24h: number; pipelines_24h: number; success_rate_24h: number; p50_queue_ms: number; p50_build_ms: number;
  deploys_24h: number; apps_up: number; apps_down: number; prs_open: number; running?: number; pending?: number;
};

// ---- Factory Floor (contract v0.5): groups, failure clusters, flakes, trends ----

/** id = "team:<slug>" | "org:<Owner>". */
export type Group = { id: string; name: string; kind: 'team' | 'org'; repos: number; apps: number; red: number };
export type FailClass = 'compile' | 'test' | 'lint' | 'typecheck' | 'deps' | 'build' | 'deploy' | 'security' | 'oom' | 'timeout' | 'network' | 'infra' | 'exit';
/** id = "f:" + 12 hex of the signature's hash; failures of the last 24 h. */
export type Cluster = {
  id: string; signature: string; step: string; class: FailClass; line?: string; exit_code?: number;
  count: number; count_1h: number; repos: string[]; repo_count: number; groups: string[];
  first_seen: number; last_seen: number; examples: string[]; open: number; flaky?: number;
};
/** id = "<owner/name>|<workflow>/<step>"; present while flips_24h >= 1. */
export type Flake = { id: string; repo: string; workflow: string; step: string; flips_24h: number; failures_24h: number; last_at: number; shas: string[] };
export type Metric = { h1: number | null; h24: number | null; d7: number | null; dir: -1 | 0 | 1; bad?: boolean; spark: (number | null)[] };
/** id = "fleet" | a Group id. */
export type Trend = {
  id: string; at: number; intake_ms: Metric; run_ms: Metric; pass_rate: Metric; pipelines: Metric; deploys: Metric;
  pr_age_ms: Metric; red: Metric; hours_7d: number;
};
/** GET /api/v1/insights. */
export type Insights = { at: number; groups: Group[]; clusters: Cluster[]; flakes: Flake[]; trends: Trend[] };
export type ChangeCounts = {
  red: number; recovered: number; still_red: number; pipelines: number; failed: number; deploys: number; deploys_failed: number;
  clusters_new: number; flakes: number; prs_merged: number; apps_down: number; apps_recovered: number;
};
/** GET /api/v1/changes?since=<ms>[&until=<ms>]: "since your last visit". `complete` is false when
 *  `since` was older than the retained window (24 h) and was clamped to it. */
export type Changes = {
  since: number; until: number; complete: boolean; counts: ChangeCounts;
  red: { repo: string; group?: string; at: number; culprit?: string; cluster?: string }[];
  recovered: { repo: string; group?: string; at: number; red_ms: number }[];
  still_red: { repo: string; group?: string; since: number }[];
  clusters: { id: string; count: number; new: boolean }[];
  deploys: { app: string; sha: string; state: string; at: number }[];
  apps: { app: string; from: string; to: string; at: number }[];
  groups: { id: string; failed: number; red: number }[];
};

/** GET /api/v1/app/{id} (server 36dc09d): an app's last ≤ 10 deploys (newest first) and its 7 d
 *  of health changes (newest first); `health_ms` = time spent in each state over `since` → now;
 *  `complete` false while the server's ledger holds less than 7 d. */
export type AppDeployRow = {
  sha: string; via: DeployVia; state: DeployState; started: number; at: number; finished?: number; duration_ms?: number; pipeline?: string;
};
export type AppDetail = {
  id: string; app: App | null; deploys: AppDeployRow[]; health: { from: Health; to: Health; at: number }[];
  health_ms: Partial<Record<Health, number>>; since: number; complete: boolean;
};
/** GET /api/v1/engine/{id}/history (id URL-encoded): columnar, one sample a `step_ms` (60 s) over
 *  24 h (`n` = 1440), oldest first from `from`; null = offline / no sample. `busy` and `slots` are
 *  slot counts, cpu/mem percent, load load1; `repos` = runs served in the window, most first. */
export type EngineHistoryDoc = {
  id: string; kind: Engine['kind']; host?: string; from: number; step_ms: number; n: number;
  busy: (number | null)[]; slots: (number | null)[]; cpu: (number | null)[]; mem: (number | null)[]; load: (number | null)[];
  repos: { repo: string; runs: number }[];
};

export type Kind = 'org' | 'repo' | 'commit' | 'pipeline' | 'pr' | 'deploy' | 'app' | 'engine' | 'queue' | 'lane' | 'watcher' | 'stats'
  | 'group' | 'cluster' | 'flake' | 'trend';
/** v0.2 sends arrays sorted by id; the demo sends id-keyed maps. */
type Coll<T> = T[] | Record<string, T>;
export type Snapshot = {
  protocol: string; epoch?: string; seq: number; at: number;
  orgs: Coll<Org>; repos: Coll<Repo>; commits: Coll<Commit>; pipelines: Coll<Pipeline>; prs: Coll<Pr>;
  deploys: Coll<Deploy>; apps: Coll<App>; engines: Coll<Engine>; queues: Coll<Queue>; lanes: Coll<Lane>;
  watcher: Watcher | null; stats: Stats | null;
  /** v0.5 (absent from a v0.4 server). */
  groups?: Coll<Group>; clusters?: Coll<Cluster>; flakes?: Coll<Flake>; trends?: Coll<Trend>;
};

export type Event =
  | { k: 'push'; repo: string; sha: string; branch: string; author: string; bot?: boolean; title: string; at: number }
  | { k: 'enqueue'; pipeline: string; lane: 'roadrunner' | 'gha'; repo: string; sha: string; at: number }
  | { k: 'start'; pipeline: string; engine?: string; at: number }
  | { k: 'step'; pipeline: string; workflow: string; step: string; state: CiState; at: number }
  | { k: 'finish'; pipeline: string; state: CiState; at: number; culprit?: boolean }
  | { k: 'pr'; repo: string; number: number; phase: PrPhase; at: number }
  | { k: 'merge'; repo: string; number: number; sha: string; at: number }
  | { k: 'deploy'; app: string; sha: string; state: DeployState; via: DeployVia; at: number }
  | { k: 'health'; app: string; from: Health; to: Health; at: number }
  | { k: 'main'; repo: string; from: CiState; to: CiState; culprit?: string; at: number };

export type Op =
  | { op: 'upsert'; kind: Kind; id: string; v: unknown }
  /** v0.4: an RFC 7386 merge patch on an entity already held (ignored otherwise). */
  | { op: 'patch'; kind: Kind; id: string; v: unknown }
  /** v0.4: one main-line dot into repos[id].main.recent (same sha replaced, sorted, newest 12). */
  | { op: 'dot'; id: string; v: Dot }
  | { op: 'remove'; kind: Kind; id: string }
  | { op: 'event'; e: Event };

export type Frame =
  | { t: 'delta'; seq: number; at: number; ops: Op[] }
  | { t: 'hb'; seq: number; at: number }
  | { t: 'reset'; seq?: number; at?: number };

/** A `t:"snapshot"` entry in history replaces the state (a server restart). */
export type HistoryFrame = Frame | { t: 'snapshot'; seq: number; at: number; v: Snapshot };
export type History = { from: number; to: number; base?: Snapshot; frames: HistoryFrame[]; /** the reply's size (a chunked replay sizes its next window by it) */ bytes?: number };

/** One Dagger call from cicd's traces (contract v0.3): oldest first. The demo's older form
 *  (`end`, `parent`, `state`, `cached`) is still read. */
export type Span = {
  id: string; name: string; call?: string; pipeline?: number | string; start: number; ms?: number; spans?: number;
  end?: number; parent?: string; state?: CiState; cached?: boolean;
};
export type JourneyEntry = { at: number; k: string; label: string };
export type Journey = {
  id?: string; repo?: string; sha?: string;
  commit: Commit | null; repo_state?: Repo | null;
  pipelines: Pipeline[]; prs?: Pr[]; deploys: Deploy[]; app?: App | null;
  spans: Span[]; timeline?: JourneyEntry[];
};
export type PrDetail = {
  pr: Pr; repo_state?: Repo | null; commits: Commit[]; pipelines: Pipeline[]; deploys?: Deploy[];
  /** v0.4: every check (Pr.checks lists only required and not-passed ones). */
  checks?: { name: string; state: CiState; required?: boolean }[];
  /** The demo's: phase changes. */
  timeline?: { at: number; phase: PrPhase; note?: string }[];
};
export type SearchHit = { kind: 'repo' | 'pr' | 'commit' | 'app' | 'pipeline'; id: string; title: string; subtitle: string; score: number };
export type SearchResults = { q: string; results: SearchHit[] };
export type Meta = {
  protocol: string; version: string; git_sha: string; mode?: 'live' | 'demo'; epoch?: string; seq?: number; now?: number;
  adapters: { name: string; state: string; last_ok?: number; last_error?: string; lag_ms?: number }[];
  orgs: unknown[];
};

/** The demo's own store (server/sim.ts): v0's id-keyed maps, singletons always present. */
export type DemoSnapshot = {
  protocol: string; seq: number; at: number;
  orgs: Record<string, Org>; repos: Record<string, Repo>; commits: Record<string, Commit>;
  pipelines: Record<string, Pipeline>; prs: Record<string, Pr>; deploys: Record<string, Deploy>;
  apps: Record<string, App>; engines: Record<string, Engine>; queues: Record<string, Queue>;
  lanes: Record<string, Lane>; watcher: Watcher; stats: Stats;
  /** v0.5: the Factory Floor tables (server/floor.ts keeps them). */
  groups: Record<string, Group>; clusters: Record<string, Cluster>; flakes: Record<string, Flake>; trends: Record<string, Trend>;
};
