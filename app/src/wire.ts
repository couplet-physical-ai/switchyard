// Switchyard wire contract v0.2 (contract/CONTRACT.md), as TypeScript. The server owns the
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
};
export type DeployRef = { id: string; state: DeployState };
export type Commit = {
  id?: string; repo: string; sha: string; branch: string; title: string; author: string; bot?: boolean; at: number;
  pr?: number; stage: Stage; ci: CiState; pipelines: string[]; deploy?: DeployRef;
};
export type Step = { name: string; state: CiState; started?: number; finished?: number; exit_code?: number; cached?: boolean };
export type Workflow = { name: string; state: CiState; started?: number; finished?: number; engine?: string; steps: Step[] };
export type Pipeline = {
  /** "wp:<owner/name>:<number>" | "gha:<run_id>" (the demo leaves it to the key; the client sets it). */
  id?: string;
  lane: 'roadrunner' | 'gha'; repo: string; number: number; sha: string; branch: string;
  event: 'push' | 'pull_request' | 'tag' | 'cron' | 'manual' | 'deployment';
  state: CiState; created: number; started?: number; finished?: number; queue_pos?: number;
  engine?: string; title?: string; author?: string; pr?: number; deploy?: boolean;
  workflows: Workflow[]; url: string; expected_ms?: number;
};
export type Pr = {
  id?: string; repo: string; number: number; title: string; author: string; bot?: boolean; draft: boolean;
  created: number; updated: number; head_sha: string; head?: string; base: string; phase: PrPhase; ci?: CiState;
  checks: { name: string; state: CiState; required?: boolean }[];
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

export type Kind = 'org' | 'repo' | 'commit' | 'pipeline' | 'pr' | 'deploy' | 'app' | 'engine' | 'queue' | 'lane' | 'watcher' | 'stats';
/** v0.2 sends arrays sorted by id; the demo sends id-keyed maps. */
type Coll<T> = T[] | Record<string, T>;
export type Snapshot = {
  protocol: string; epoch?: string; seq: number; at: number;
  orgs: Coll<Org>; repos: Coll<Repo>; commits: Coll<Commit>; pipelines: Coll<Pipeline>; prs: Coll<Pr>;
  deploys: Coll<Deploy>; apps: Coll<App>; engines: Coll<Engine>; queues: Coll<Queue>; lanes: Coll<Lane>;
  watcher: Watcher | null; stats: Stats | null;
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
  | { op: 'remove'; kind: Kind; id: string }
  | { op: 'event'; e: Event };

export type Frame =
  | { t: 'delta'; seq: number; at: number; ops: Op[] }
  | { t: 'hb'; seq: number; at: number }
  | { t: 'reset'; seq?: number; at?: number };

/** A `t:"snapshot"` entry in history replaces the state (a server restart). */
export type HistoryFrame = Frame | { t: 'snapshot'; seq: number; at: number; v: Snapshot };
export type History = { from: number; to: number; base?: Snapshot; frames: HistoryFrame[] };

/** cicd's Dagger spans, passed through by the server (shape not fixed by the contract). */
export type Span = { id: string; parent?: string; name: string; start: number; end?: number; state?: CiState; pipeline?: string; cached?: boolean };
export type JourneyEntry = { at: number; k: string; label: string };
export type Journey = {
  id?: string; repo?: string; sha?: string;
  commit: Commit | null; repo_state?: Repo | null;
  pipelines: Pipeline[]; prs?: Pr[]; deploys: Deploy[]; app?: App | null;
  spans: Span[]; timeline?: JourneyEntry[];
};
export type PrDetail = {
  pr: Pr; repo_state?: Repo | null; commits: Commit[]; pipelines: Pipeline[]; deploys?: Deploy[];
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
};
