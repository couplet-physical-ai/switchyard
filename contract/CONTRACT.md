# Switchyard wire contract — v0.2

Owner: the **server** thread (`server/`). The client reads this and `contract/fixtures/`;
it never edits them. Any change: bump `PROTOCOL` minor, update fixtures in the same commit,
and tell the overseer (who tells the client thread). The server's source of truth for the
shapes is `server/src/model.rs` (serde); this file documents it.

All times are Unix **milliseconds** (UTC). All ids are strings. Repos are `owner/name`.
JSON over the wire. Unknown fields must be ignored by the client; unknown `kind`s and
unknown event `k`s skipped. Optional fields are **omitted** when absent (never `null`),
except the two singleton snapshot fields, which are `null` before their first value.

## Transport

| Endpoint | Purpose |
|---|---|
| `GET /api/v1/snapshot` | the whole fleet now: `Snapshot` (send `Accept-Encoding: gzip`; ~2.7 MB raw, ~0.5 MB gz). Header `x-switchyard-seq`, `ETag` (`If-None-Match` → 304). Served from a pre-encoded cache refreshed ≤ 1/s, so it may trail the stream by up to a second: always resume with `since=snapshot.seq`. |
| `GET /api/v1/stream?since=<seq>` | **WebSocket** (upgrade). Server pushes `Frame`s (text messages). With `since`, frames after it are replayed from the ring first; if `since` is too old (or from before a restart), the first message is `{"t":"reset"}`. |
| `GET /api/v1/stream/sse?since=<seq>` | same frames as Server-Sent Events (`data: <frame>`), fallback. |
| `GET /api/v1/history?from=<ms>&to=<ms>` | replay window (≤ 3 h, within the last 24 h): `History`. |
| `GET /api/v1/commit/{owner}/{name}/{sha}` | `Journey` for one commit (sha may be abbreviated). |
| `GET /api/v1/pr/{owner}/{name}/{number}` | `PrDetail`. |
| `GET /api/v1/search?q=&limit=` | ⌘K: `{q, results: Hit[]}` across repos / apps / PRs / commits / pipelines. |
| `GET /api/v1/meta` | `{protocol, version, git_sha, mode: "live"\|"demo", epoch, seq, snapshot:{seq,at,bytes,gzip_bytes}, clients, adapters: AdapterStatus[], orgs, counts, process: {rss_bytes, peak_rss_bytes, threads}, now}` |
| `GET /api/healthz` | liveness `{ok:true}` (public). |
| `GET /api/readyz` | `{ready, mode, seq, adapters: AdapterStatus[]}`; 200 when every enabled adapter has synced once, else 503. |
| `GET /connect` | (browser, SSO) page that mints a device token for the macOS app. |
| `GET /api/v1/whoami`, `GET /api/v1/tokens`, `DELETE /api/v1/tokens/{id}` | the caller, their device tokens, revoke one. |

`AdapterStatus = {name, state: "disabled"|"starting"|"syncing"|"ok"|"degraded"|"error", last_ok?, last_error?, lag_ms?, synced, note?, requests}`

### Auth

- Browser (web client, same origin): nothing to do; the platform's SSO edge signs the
  person in and the server trusts it (it verifies the edge's Google ID token).
- macOS app / scripts: `Authorization: Bearer syd_…` on every `/api/v1/*` request
  including the WebSocket upgrade. Where a header cannot be set, `?token=syd_…` works too.
  Get a token on `https://<server>/connect` (it also offers a
  `switchyard://connect?server=<url>&token=<token>` link).
- `401 {"error":"unauthorized"}` → the token is missing/revoked: send the user to `/connect`.
- Demo / local server (`--auth open`): no auth.

### Frames (one WebSocket message = one frame; ≤ 30 frames/s per client)

```jsonc
{ "t": "delta", "seq": 81234, "at": 1794339000123, "ops": [ Op, ... ] }
{ "t": "hb",    "seq": 81234, "at": 1794339000123 }   // after 5 s without a frame
{ "t": "reset", "seq": 81240, "at": 1794339000123 }   // discard state, refetch the snapshot
```

`seq` increases by one per frame (the server merges frames for slow clients, so a client
may see gaps: that is fine). Apply a delta only if `seq > state.seq`. After a `reset`,
refetch the snapshot and keep the socket: drop deltas with `seq <= snapshot.seq`.

`Op` = `{ "op": "upsert", "kind": Kind, "id": string, "v": Entity }`
     | `{ "op": "remove", "kind": Kind, "id": string }`
     | `{ "op": "event", "e": Event }` (transient, never stored).

`Kind` = `"org" | "repo" | "commit" | "pipeline" | "pr" | "deploy" | "app" | "engine" | "queue" | "lane" | "watcher" | "stats"`.
An upsert replaces the whole entity (`v` always carries its own `id`).

## Snapshot

```ts
type Snapshot = {
  protocol: "0.2", epoch: string, seq: number, at: number,
  orgs: Org[], repos: Repo[], commits: Commit[], pipelines: Pipeline[], prs: Pr[],
  deploys: Deploy[], apps: App[], engines: Engine[], queues: Queue[], lanes: Lane[],
  watcher: Watcher | null, stats: Stats | null
}
```

Retention: commits — last 24 h + anything in flight; pipelines — in flight + finished in
the last 2 h; PRs — open + closed/merged in the last 24 h; deploys — last 24 h.
Arrays are sorted by `id`.

## Entities

```ts
type Org = { id: string /* "Northwind-Labs" */, repos: number }

type Repo = {
  id: string,                 // "Northwind-Labs/cicd"
  org: string, name: string, default_branch: string,
  lane: "roadrunner_first" | "gha_first" | "primary" | "ci" | "failsafe" | "ci_only" | "none",
  lane_note?: string,
  app?: string,               // app id if this repo deploys an app
  main: MainState,
  heat: number,               // 0..1 in steps of 0.05: recent activity (3 h half-life)
  open_prs: number,
  last_activity: number,      // newest commit / pipeline / PR update (0 = none known)
  links: { github: string, woodpecker?: string, cicd?: string }
}

type MainState = {
  head: string,               // newest commit on the default branch ("" if unknown)
  state: CiState,             // newest DECIDED commit (success/failure/error); else head's state
  since: number,              // when main entered `state` (oldest commit of the current streak)
  culprit?: string,           // when red: the sha that turned it red
  recent: Dot[]               // oldest first, newest last, ≤ 40
}
type Dot = { sha: string, at: number, state: CiState, author: string, bot?: true,
             title: string, deployed?: true, culprit?: true }

type CiState = "success" | "failure" | "running" | "pending" | "blocked" | "skipped"
             | "canceled" | "error" | "none"

type Commit = {               // id = "owner/name@sha"
  id: string, repo: string, sha: string, branch: string, title: string, author: string, bot?: true,
  at: number,
  pr?: number,
  stage: "pushed" | "queued" | "building" | "gating" | "merged" | "deploying" | "deployed" | "failed" | "done",
  ci: CiState,                // combined: Roadrunner pipelines + GitHub Actions runs + statuses
  pipelines: string[],        // Pipeline ids (also ones no longer in the snapshot)
  deploy?: DeployRef
}

type Pipeline = {             // id = "wp:<owner/name>:<number>" (Roadrunner) | "gha:<run_id>" (GitHub Actions)
  id: string, lane: "roadrunner" | "gha",
  repo: string, number: number, sha: string,
  branch: string,             // push: the branch; pull_request: the PR's head branch
  event: "push" | "pull_request" | "tag" | "cron" | "manual" | "deployment",
  state: CiState, created: number, started?: number, finished?: number,
  queue_pos?: number,         // 1-based, while pending
  engine?: string,            // agent name, e.g. "dagger-ci-153-1", "rr-mac-mini-1"
  title?: string, author?: string,
  pr?: number,                // pull_request pipelines
  deploy?: true,              // has a deploy workflow (push pipelines)
  workflows: Workflow[],
  url: string
}
type Workflow = { name: string, state: CiState, started?: number, finished?: number,
                  engine?: string, steps: Step[] }
type Step = { name: string, state: CiState, started?: number, finished?: number,
              exit_code?: number, cached?: boolean }

type Pr = {                   // id = "owner/name#123"
  id: string, repo: string, number: number, title: string, author: string, bot?: true,
  draft: boolean, created: number, updated: number,
  head_sha: string, head: string, base: string,
  phase: "draft" | "checks" | "review" | "changes_requested" | "mergeable" | "conflict"
       | "merged" | "closed" | "deployed",
  ci: CiState,                // live pipelines on the head + GitHub's check rollup
  checks: { name: string, state: CiState, required?: true }[],   // required first
  review: { ai?: "pending" | "commented" | "approved" | "skipped",
            human?: "approved" | "changes_requested" | "review_required" },
  merged_at?: number, merge_sha?: string,
  blocked_by?: string,        // "merge conflict" | "failing: <check>" | "review required" | ...
  stale_ms?: number,          // open and idle > 72 h (hour resolution)
  url: string
}

type Deploy = {               // id = "owner/name@sha" (same as the commit's id)
  id: string, app: string, repo: string, sha: string,
  via: "roadrunner" | "gha" | "gha_fallback" | "manual",
  state: "pending" | "running" | "success" | "failure",
  started: number, finished?: number, pipeline?: string, url?: string
}
type DeployRef = { id: string, state: Deploy["state"] }

type App = {                  // id = app slug ("roster")
  id: string, repo?: string, url: string,
  health: "up" | "degraded" | "down" | "unknown",
  latency_ms?: number,
  checked: number,            // last probe, floored to 30 min (health changes arrive as events)
  live_sha?: string,          // deployed sha (from the latest successful deploy)
  main_sha?: string, behind?: number,   // commits on main after live_sha (if known)
  last_deploy?: DeployRef,
  runtime?: string,           // "lxc" | "static" | "external"
  team?: string, note?: string
}

type Engine = {               // "wp-agent-<n>" (Woodpecker agent) | "dagger:<VM n>" (Dagger engine host)
  id: string, kind: "dagger" | "wp_agent" | "gha_runner",
  label?: string,             // "dagger-ci-153-1" | "VM 153"
  platform?: string,          // "linux/amd64" | "darwin/arm64"
  host?: string,              // machine: "VM 153" | "VM 154" | "Mac mini"
  online: boolean,
  slots: number, busy: number,
  cpu?: number, mem?: number, load?: number,   // percent / percent / load1 (engine hosts)
  last_seen?: number,
  running: string[],          // Pipeline ids running here
  agents?: string[]           // engine host → its agent engine ids
}

type Queue = {                // id = "roadrunner"
  id: string,
  pending: number,            // workflows waiting for a slot
  running: number,            // workflows running
  waiting: number,            // workflows waiting on depends_on
  pipelines_running: number,
  paused?: true,
  oldest_wait_ms: number,
  items: string[]             // pending Pipeline ids in queue order (≤ 50)
}

type Lane = { id: string /* repo */, mode: Repo["lane"], fallback?: true, held?: true, note?: string }

type Watcher = { id: "outage", tripped: boolean, since?: number, gh_status: string, note?: string }

type Stats = { id: "fleet", commits_24h, pipelines_24h, success_rate_24h /* 0..1 */,
               p50_queue_ms, p50_build_ms, deploys_24h, apps_up, apps_down, prs_open,
               running, pending: number }
```

## Transient events (`op: "event"`) — the animation drivers

```ts
type Event =
  | { k: "push", repo, sha, branch, author, bot?, title, at }
  | { k: "enqueue", pipeline, lane, repo, sha, at }
  | { k: "start", pipeline, engine?, at }
  | { k: "step", pipeline, workflow, step, state, at }   // a step started or finished
  | { k: "finish", pipeline, state, at, culprit?: true }
  | { k: "pr", repo, number, phase, at }                 // a PR changed phase
  | { k: "merge", repo, number, sha, at }
  | { k: "deploy", app, sha, state, via, at }
  | { k: "health", app, from, to, at }
  | { k: "main", repo, from, to, culprit?, at }          // main turned red/green
```

Events are emitted only for live changes (never for backfill at boot), in the same frame as
the upserts they explain.

## Queries

```ts
type History = {
  from: number, to: number,
  base: Snapshot,              // the checkpoint at or before `from`
  frames: (Frame | { t: "snapshot", seq: number, at: number, v: Snapshot })[]
}
// Replay: state = base; apply every frame in order (frames with at < from just
// fast-forward); a `t:"snapshot"` entry replaces the state (server restart).

type Hit = { kind: "repo" | "app" | "pr" | "commit" | "pipeline", id: string,
             title: string, subtitle: string, score: number }

type Journey = {
  id: string /* commit id */, repo: string, sha: string,
  commit: Commit | null, repo_state: Repo | null,
  pipelines: Pipeline[],       // every run of this sha (oldest first)
  prs: Pr[], deploys: Deploy[], app: App | null,
  spans: Span[],               // Dagger spans from cicd /traces (may be empty)
  timeline: { at: number, k: "push"|"enqueue"|"start"|"finish"|"merge"|"deploy"|"deployed"|"health",
              label: string }[]
}

type PrDetail = { pr: Pr, repo_state: Repo | null, commits: Commit[], pipelines: Pipeline[],
                  deploys: Deploy[] }
```

## Fixtures

`contract/fixtures/snapshot.json` is a real fleet snapshot and `contract/fixtures/hour.jsonl`
the real frames that followed it (one frame per line), recorded from the live upstreams by
`switchyard-server --record` and sanitized by `switchyard-server sanitize` (private repo
names, private commit/PR titles, people's logins, internal hosts are replaced by stable
stand-ins; states, times, shapes and structure are real).

`switchyard-server --demo` (no credentials) serves them on every endpoint above, looping,
with all timestamps shifted so the recording ends "now", the previous loop pre-recorded
into `/history`, and a `reset` at each loop start.

```sh
cargo run --release -- --demo --listen 127.0.0.1:8080   # from server/, fixtures default to ../contract/fixtures
```
