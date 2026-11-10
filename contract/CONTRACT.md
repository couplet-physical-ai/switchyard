# Switchyard wire contract — v0 (draft)

Owner: the **server** thread (`server/`). The client reads this and `contract/fixtures/`;
it never edits them. Any change: bump `PROTOCOL` minor, update fixtures in the same commit,
and tell the overseer (who tells the client thread).

All times are Unix **milliseconds** (UTC). All ids are strings. Repos are `owner/name`.
JSON over the wire (compact keys are fine later as a negotiated `?enc=` option; v0 is plain
JSON). Unknown fields must be ignored by the client; unknown `kind`s skipped.

## Transport

| Endpoint | Purpose |
|---|---|
| `GET /api/v1/snapshot` | the whole fleet now: `Snapshot` (gzip/br). Includes `seq` (last applied delta). |
| `GET /api/v1/stream?since=<seq>` | **WebSocket** (upgrade) — server pushes `Frame`s. `since` resumes from the ring; too old → server sends `{"t":"reset"}` and the client re-fetches the snapshot. |
| `GET /api/v1/stream/sse?since=<seq>` | same frames as Server-Sent Events (fallback). |
| `GET /api/v1/history?from=<ms>&to=<ms>` | recorded `Delta`s in a window (for "last hour, sped up" replay; ring ≥ 24 h on disk). |
| `GET /api/v1/commit/{owner}/{name}/{sha}` | `Journey` for one commit (pipelines → workflows → steps → spans → deploy → health). |
| `GET /api/v1/pr/{owner}/{name}/{number}` | `PrDetail`. |
| `GET /api/v1/search?q=` | ⌘K results across repos / PRs / commits / apps / pipelines. |
| `GET /api/healthz`, `/api/readyz` | liveness; readiness = every upstream adapter has synced once (lists each adapter's state). |
| `GET /api/v1/meta` | `{protocol, version, git_sha, adapters:[{name, state, last_ok, last_error, lag_ms}], orgs:[...]}` |

Frame (one WS message = one frame; the server coalesces to ≤ 30 frames/s per client):

```jsonc
{ "t": "delta", "seq": 81234, "at": 1794339000123, "ops": [ Op, ... ] }
{ "t": "hb", "seq": 81234, "at": ... }                  // heartbeat every 5 s
{ "t": "reset" }                                          // refetch snapshot
```

`Op` = `{ "op": "upsert" | "remove", "kind": Kind, "id": string, "v"?: Entity }` plus
transient visual events: `{ "op": "event", "e": Event }`.

## Entities (`kind` → shape)

```ts
type Org = { id: string /* "Northwind-Labs" */, repos: number }

type Repo = {
  id: string,                 // "Northwind-Labs/cicd"
  org: string, name: string, default_branch: string,
  lane: "roadrunner_first" | "gha_first" | "primary" | "ci" | "failsafe" | "ci_only" | "none",
  lane_note?: string,
  app?: string,               // app id if this repo deploys an app
  main: MainState,
  heat: number,               // 0..1 recent activity (commits+pipelines last 24 h, decayed)
  open_prs: number,
  links: { github: string, woodpecker?: string, cicd?: string }
}

type MainState = {
  head: string,               // sha
  state: CiState,             // of HEAD
  since: number,              // when main entered this state (red since …)
  culprit?: string,           // sha that first turned it red (null when green)
  recent: Dot[]               // newest last, ≤ 40
}
type Dot = { sha: string, at: number, state: CiState, author: string, bot?: boolean,
             title: string, deployed?: boolean, culprit?: boolean }

type CiState = "success" | "failure" | "running" | "pending" | "blocked" | "skipped"
             | "canceled" | "error" | "none"

type Commit = {               // id = "owner/name@sha"
  repo: string, sha: string, branch: string, title: string, author: string, bot?: boolean,
  at: number,                 // pushed / committed
  pr?: number,
  stage: Stage,               // where the packet is right now
  ci: CiState,
  pipelines: string[],        // Pipeline ids
  deploy?: DeployRef
}

type Stage = "pushed" | "queued" | "building" | "gating" | "merged" | "deploying"
           | "deployed" | "failed" | "done"

type Pipeline = {             // id = "wp:<repo_id>:<number>" or "gha:<run_id>"
  lane: "roadrunner" | "gha",
  repo: string, number: number, sha: string, branch: string,
  event: "push" | "pull_request" | "tag" | "cron" | "manual" | "deployment",
  state: CiState, created: number, started?: number, finished?: number,
  queue_pos?: number,
  engine?: string,            // "VM 153" | "VM 154" | runner name
  workflows: Workflow[],
  url: string
}
type Workflow = { name: string, state: CiState, started?: number, finished?: number,
                  steps: Step[] }
type Step = { name: string, state: CiState, started?: number, finished?: number,
              exit_code?: number, cached?: boolean }

type Pr = {                   // id = "owner/name#123"
  repo: string, number: number, title: string, author: string, bot?: boolean,
  draft: boolean, created: number, updated: number,
  head_sha: string, base: string,
  phase: "draft" | "checks" | "review" | "changes_requested" | "mergeable" | "conflict"
       | "merged" | "closed" | "deployed",
  checks: { name: string, state: CiState }[],     // required first
  review: { ai?: "pending" | "commented" | "approved" | "skipped", human?: string },
  blocked_by?: string, stale_ms?: number, url: string
}

type Deploy = {               // id = "<app>:<sha>"
  app: string, repo: string, sha: string,
  via: "roadrunner" | "gha" | "gha_fallback" | "manual",
  state: "pending" | "running" | "success" | "failure",
  started: number, finished?: number, url?: string
}
type DeployRef = { id: string, state: Deploy["state"] }

type App = {                  // id = app slug ("roster")
  repo?: string, url: string,
  health: "up" | "degraded" | "down" | "unknown",
  latency_ms?: number, checked: number,
  live_sha?: string, main_sha?: string, behind?: number,
  last_deploy?: DeployRef, runtime?: string, team?: string
}

type Engine = {               // Roadrunner Dagger engine / Woodpecker agent / GHA runner
  id: string, kind: "dagger" | "wp_agent" | "gha_runner",
  slots: number, busy: number, cpu?: number, mem?: number, load?: number,
  running: string[]           // Pipeline ids
}

type Queue = { id: "roadrunner" | "gha", pending: number, running: number,
               oldest_wait_ms: number, items: string[] /* Pipeline ids, ≤ 50 */ }

type Lane = { id: string /* repo */, mode: Repo["lane"], fallback?: boolean,
              held?: boolean, note?: string }

type Watcher = { id: "outage", tripped: boolean, since?: number, gh_status: string,
                 note?: string }
```

`Snapshot` = `{ protocol, seq, at, orgs, repos, commits /* last 24 h + in flight */,
pipelines /* in flight + last 2 h */, prs /* open + merged last 24 h */, deploys /* last 24 h */,
apps, engines, queues, lanes, watcher, stats }` where `stats` =
`{ commits_24h, pipelines_24h, success_rate_24h, p50_queue_ms, p50_build_ms, deploys_24h,
   apps_up, apps_down, prs_open }`.

## Transient events (`op: "event"`) — the animation drivers

The client animates packets from these; they are never stored as entities.

```ts
type Event =
  | { k: "push", repo, sha, branch, author, bot?, title, at }
  | { k: "enqueue", pipeline, lane, repo, sha, at }
  | { k: "start", pipeline, engine, at }
  | { k: "step", pipeline, workflow, step, state, at }
  | { k: "finish", pipeline, state, at, culprit?: boolean }
  | { k: "pr", repo, number, phase, at }
  | { k: "merge", repo, number, sha, at }
  | { k: "deploy", app, sha, state, via, at }
  | { k: "health", app, from, to, at }
  | { k: "main", repo, from, to, culprit?, at }   // main turned red/green
```

## Fixtures (server thread delivers early)

`contract/fixtures/snapshot.json` (a real, sanitized fleet snapshot) and
`contract/fixtures/hour.jsonl` (one real hour of frames) so the client builds against
real shapes and can replay "1 hour, sped up" offline. `server --demo` serves them
(looping, with timestamps shifted to now) so the client can run without credentials.
