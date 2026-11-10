// Switchyard wire contract v0 (contract/CONTRACT.md), as TypeScript. The server owns the
// contract; this file mirrors it. Unknown fields are ignored and unknown kinds skipped.
// Journey, PrDetail and Search are provisional shapes the client proposes (not yet in v0).

export type CiState = 'success' | 'failure' | 'running' | 'pending' | 'blocked' | 'skipped' | 'canceled' | 'error' | 'none';
export type LaneMode = 'roadrunner_first' | 'gha_first' | 'primary' | 'ci' | 'failsafe' | 'ci_only' | 'none';
export type Stage = 'pushed' | 'queued' | 'building' | 'gating' | 'merged' | 'deploying' | 'deployed' | 'failed' | 'done';
export type Health = 'up' | 'degraded' | 'down' | 'unknown';
export type PrPhase = 'draft' | 'checks' | 'review' | 'changes_requested' | 'mergeable' | 'conflict' | 'merged' | 'closed' | 'deployed';
export type DeployState = 'pending' | 'running' | 'success' | 'failure';
export type DeployVia = 'roadrunner' | 'gha' | 'gha_fallback' | 'manual';

export type Org = { id: string; repos: number };
export type Dot = { sha: string; at: number; state: CiState; author: string; bot?: boolean; title: string; deployed?: boolean; culprit?: boolean };
export type MainState = { head: string; state: CiState; since: number; culprit?: string | null; recent: Dot[] };
export type Repo = {
  id: string; org: string; name: string; default_branch: string; lane: LaneMode; lane_note?: string;
  app?: string; main: MainState; heat: number; open_prs: number;
  links: { github: string; woodpecker?: string; cicd?: string };
  p50_build_ms?: number;
};
export type DeployRef = { id: string; state: DeployState };
export type Commit = {
  repo: string; sha: string; branch: string; title: string; author: string; bot?: boolean; at: number;
  pr?: number; stage: Stage; ci: CiState; pipelines: string[]; deploy?: DeployRef;
};
export type Step = { name: string; state: CiState; started?: number; finished?: number; exit_code?: number; cached?: boolean };
export type Workflow = { name: string; state: CiState; started?: number; finished?: number; steps: Step[] };
export type Pipeline = {
  /** The map key, which the client sets on receipt (the wire leaves it to the key). */
  id?: string;
  lane: 'roadrunner' | 'gha'; repo: string; number: number; sha: string; branch: string;
  event: 'push' | 'pull_request' | 'tag' | 'cron' | 'manual' | 'deployment';
  state: CiState; created: number; started?: number; finished?: number; queue_pos?: number;
  engine?: string; workflows: Workflow[]; url: string; expected_ms?: number;
};
export type Pr = {
  repo: string; number: number; title: string; author: string; bot?: boolean; draft: boolean;
  created: number; updated: number; head_sha: string; base: string; phase: PrPhase;
  checks: { name: string; state: CiState }[];
  review: { ai?: 'pending' | 'commented' | 'approved' | 'skipped'; human?: string };
  blocked_by?: string; stale_ms?: number; url: string;
};
export type Deploy = { app: string; repo: string; sha: string; via: DeployVia; state: DeployState; started: number; finished?: number; url?: string };
export type App = {
  repo?: string; url: string; health: Health; latency_ms?: number; checked: number;
  live_sha?: string; main_sha?: string; behind?: number; last_deploy?: DeployRef; runtime?: string; team?: string;
};
export type Engine = { id: string; kind: 'dagger' | 'wp_agent' | 'gha_runner'; slots: number; busy: number; cpu?: number; mem?: number; load?: number; running: string[] };
export type Queue = { id: 'roadrunner' | 'gha'; pending: number; running: number; oldest_wait_ms: number; items: string[] };
export type Lane = { id: string; mode: LaneMode; fallback?: boolean; held?: boolean; note?: string };
export type Watcher = { id: 'outage'; tripped: boolean; since?: number; gh_status: string; note?: string };
export type Stats = {
  commits_24h: number; pipelines_24h: number; success_rate_24h: number; p50_queue_ms: number; p50_build_ms: number;
  deploys_24h: number; apps_up: number; apps_down: number; prs_open: number;
};

/** Entities keyed by id, as the snapshot carries them (`kind` → map). */
export type Kind = 'org' | 'repo' | 'commit' | 'pipeline' | 'pr' | 'deploy' | 'app' | 'engine' | 'queue' | 'lane' | 'watcher';
export type Snapshot = {
  protocol: string; seq: number; at: number;
  orgs: Record<string, Org>; repos: Record<string, Repo>; commits: Record<string, Commit>;
  pipelines: Record<string, Pipeline>; prs: Record<string, Pr>; deploys: Record<string, Deploy>;
  apps: Record<string, App>; engines: Record<string, Engine>; queues: Record<string, Queue>;
  lanes: Record<string, Lane>; watcher: Watcher; stats: Stats;
};

export type Event =
  | { k: 'push'; repo: string; sha: string; branch: string; author: string; bot?: boolean; title: string; at: number }
  | { k: 'enqueue'; pipeline: string; lane: 'roadrunner' | 'gha'; repo: string; sha: string; at: number }
  | { k: 'start'; pipeline: string; engine: string; at: number }
  | { k: 'step'; pipeline: string; workflow: string; step: string; state: CiState; at: number }
  | { k: 'finish'; pipeline: string; state: CiState; at: number; culprit?: boolean }
  | { k: 'pr'; repo: string; number: number; phase: PrPhase; at: number }
  | { k: 'merge'; repo: string; number: number; sha: string; at: number }
  | { k: 'deploy'; app: string; sha: string; state: DeployState; via: DeployVia; at: number }
  | { k: 'health'; app: string; from: Health; to: Health; at: number }
  | { k: 'main'; repo: string; from: CiState; to: CiState; culprit?: string; at: number };

export type Op =
  | { op: 'upsert'; kind: Kind; id: string; v: unknown }
  | { op: 'remove'; kind: Kind; id: string }
  | { op: 'event'; e: Event };

export type Frame =
  | { t: 'delta'; seq: number; at: number; ops: Op[] }
  | { t: 'hb'; seq: number; at: number }
  | { t: 'reset' };

/** Provisional (client proposal): the replay window, with the state at `from`. */
export type History = { from: number; to: number; base?: Snapshot; frames: Frame[] };

/** Provisional (client proposal): one commit end to end. */
export type Span = { id: string; parent?: string; name: string; start: number; end?: number; state: CiState; pipeline: string; cached?: boolean };
export type Journey = {
  commit: Commit; pipelines: Pipeline[]; spans: Span[]; deploys: Deploy[]; app?: App;
  health_after: { at: number; health: Health; latency_ms?: number }[];
};
/** Provisional (client proposal): one PR with its commits, pipelines and phase timeline. */
export type PrDetail = { pr: Pr; commits: Commit[]; pipelines: Pipeline[]; timeline: { at: number; phase: PrPhase; note?: string }[] };
/** Provisional (client proposal): ⌘K results. */
export type SearchHit = { kind: 'repo' | 'pr' | 'commit' | 'app' | 'pipeline'; id: string; title: string; subtitle: string; score: number };
export type SearchResults = { q: string; results: SearchHit[] };
export type Meta = { protocol: string; version: string; git_sha: string; adapters: { name: string; state: string; last_ok?: number; last_error?: string; lag_ms?: number }[]; orgs: string[] };
