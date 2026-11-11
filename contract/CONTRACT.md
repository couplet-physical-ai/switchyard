# Switchyard wire contract — v0.5

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
| `GET /api/v1/snapshot?at=<ms>` | the fleet as it was at `at` (within the last 24 h): a `Snapshot` with `at` = the requested time. |
| `GET /api/v1/stream/sse?since=<seq>` | same frames as Server-Sent Events (`data: <frame>`), fallback. |
| `GET /api/v1/tstream?token=<device token>&since=<seq>` (WS), `GET /api/v1/tstream/sse?token=…` | the same streams for native clients that cannot set headers on a WebSocket: they accept ONLY our own tokens in the query: a device token (`syd_…`) or a read-only service token (`sys_…`) (see Auth). |
| `GET /api/v1/history?from=<ms>&to=<ms>[&base=0]` | replay window (≤ 3 h, within the last 24 h): `History`. `base=0`: no base snapshot, only what happened after `from`. |
| `GET /api/v1/commit/{owner}/{name}/{sha}` | `Journey` for one commit (sha may be abbreviated). |
| `GET /api/v1/pr/{owner}/{name}/{number}` | `PrDetail`. |
| `GET /api/v1/search?q=&limit=` | ⌘K: `{q, results: Hit[]}` across repos / apps / PRs / commits / pipelines. |
| `GET /` and any other non-`/api` path | the web client (`--static-dir` / `SWITCHYARD_WEB_DIR`): the file if it exists, else `shell.html` with 200 (SPA). Content-hashed files (`name-XXXXXXXX.ext`) are `Cache-Control: public, max-age=31536000, immutable`; everything else (`shell.html`, `index.html`, `app.js`, `app.plan`, `style.css`, …) `no-cache`. Unknown `/api/*` paths are a JSON 404, never the shell. |
| `GET /api/v1/insights` | the Factory Floor in one call: `Insights` (groups, failure clusters, flakes, trends), same entities as the snapshot tables, sorted for display. |
| `GET /api/v1/changes?since=<ms>[&until=<ms>]` | "since your last visit": `Changes` — what turned red, recovered, deployed, new failure clusters, counts; within the last 24 h. |
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
  including the WebSocket upgrade (the platform edge lets Bearer requests on `/api/*`
  through to the server, which checks the token). Get a token on `https://<server>/connect`
  (it also offers a `switchyard://connect?server=<url>&token=<token>` link).
- A WebSocket / EventSource that cannot carry a header: `/api/v1/tstream?token=syd_…`
  (`/api/v1/tstream/sse?token=…`). These two paths pass the platform edge without a session
  and accept nothing but a valid device (`syd_…`) or service (`sys_…`) token in the query. (`?token=` on `/api/v1/stream`
  also works where there is no edge in front, e.g. a local server. Behind the platform
  never do that: the edge redirects the request to the sign-in page with the whole URL,
  token included, in the redirect's `rd=` parameter.)
- Monitors: read-only service tokens (`Authorization: Bearer sys_…`), configured on the
  server as hashes.
- `401 {"error":"unauthorized"}` → the token is missing/revoked: send the user to `/connect`.
- Demo / local server (`--auth open`): no auth, and permissive CORS (`*`) on every path so
  a dev client on another origin can read it. A platform server is same-origin only.

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
     | `{ "op": "patch",  "kind": Kind, "id": string, "v": object }`
     | `{ "op": "dot",    "id": string /* repo id */, "v": Dot }`
     | `{ "op": "remove", "kind": Kind, "id": string }`
     | `{ "op": "event", "e": Event }` (transient, never stored).

`Kind` = `"org" | "repo" | "commit" | "pipeline" | "pr" | "deploy" | "app" | "engine" | "queue" | "lane" | "watcher" | "stats"`
       `| "group" | "cluster" | "flake" | "trend"` (0.5; older clients skip unknown kinds).

- **upsert** replaces the whole entity (`v` always carries its own `id`).
- **patch** is an [RFC 7386 JSON Merge Patch](https://www.rfc-editor.org/rfc/rfc7386) on the
  entity the client holds: objects merge recursively, `null` removes a field, anything else
  (arrays, scalars) replaces the field. It always follows an upsert of that entity (in the
  snapshot or an earlier frame); a client that does not hold the entity ignores it.
- **dot** puts one `Dot` into `repos[id].main.recent`: remove the dot with the same `sha`,
  add this one, sort by `(at, sha)` ascending, keep the newest 12. (The server sends dot ops
  only when this rule reproduces its main line exactly; otherwise it patches `main` with the
  whole `recent` array.)
- Ops apply in order. The server sends whichever of upsert / patch / dots+patch is smallest;
  applying them yields exactly the entity an upsert would have carried.

## Snapshot

```ts
type Snapshot = {
  protocol: "0.5", epoch: string, seq: number, at: number,
  orgs: Org[], repos: Repo[], commits: Commit[], pipelines: Pipeline[], prs: Pr[],
  deploys: Deploy[], apps: App[], engines: Engine[], queues: Queue[], lanes: Lane[],
  watcher: Watcher | null, stats: Stats | null,
  groups: Group[], clusters: Cluster[], flakes: Flake[], trends: Trend[]   // 0.5
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
  p50_build_ms?: number,      // median duration of the repo's successful push runs, last 24 h
  group?: string,             // 0.5: Group id (team from the apps catalog, else the org)
  links: { github: string, woodpecker?: string, cicd?: string }
}

type MainState = {
  head: string,               // newest commit on the default branch ("" if unknown)
  state: CiState,             // newest DECIDED commit (success/failure/error); else head's state
  since: number,              // when main entered `state` (oldest commit of the current streak)
  culprit?: string,           // when red: the sha that turned it red
  recent: Dot[]               // oldest first, newest last, ≤ 12 (sorted by (at, sha))
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
  expected_ms?: number,       // while pending/running: median duration (started → finished)
                              // of this repo's last ≤ 20 successful runs of the same lane,
                              // event and deploy-ness (last 24 h). Progress = (now − started) / expected_ms.
  engine?: string,            // agent name, e.g. "dagger-ci-153-1", "rr-mac-mini-1"
  title?: string, author?: string,
  pr?: number,                // pull_request pipelines
  deploy?: true,              // has a deploy workflow (push pipelines)
  flaky?: true,               // 0.5: failed, but every failed step passed on the same sha within 6 h
  workflows: Workflow[],
  url: string
}
type Workflow = { name: string, state: CiState, started?: number, finished?: number,
                  engine?: string, steps: Step[] }
type Step = { name: string, state: CiState, started?: number, finished?: number,
              exit_code?: number, cached?: boolean,
              cluster?: string }      // 0.5: failed steps: the failure Cluster id

type Pr = {                   // id = "owner/name#123"
  id: string, repo: string, number: number, title: string, author: string, bot?: true,
  draft: boolean, created: number, updated: number,
  head_sha: string, head: string, base: string,
  phase: "draft" | "checks" | "review" | "changes_requested" | "mergeable" | "conflict"
       | "merged" | "closed" | "deployed",
  ci: CiState,                // live pipelines on the head + GitHub's check rollup
  checks: { name: string, state: CiState, required?: true }[],   // required first; only
                              // required checks and checks that have not passed
  checks_passed?: number,     // how many other checks passed (success / skipped)
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

### Factory Floor (0.5): groups, failure clusters, flakes, trends

```ts
type Group = {                // id = "team:<slug>" | "org:<Owner>"
  id: string, name: string,   // "Software", "Power systems", "Northwind-EMS"
  kind: "team" | "org",       // team: from the apps catalog (a repo's app's team, normalized:
                              // lower-case, "-team" dropped); org: repos without a known team
  repos: number, apps: number,
  red: number                 // repos in the group whose main is red now
}

type FailClass = "compile" | "test" | "lint" | "typecheck" | "deps" | "build" | "deploy"
               | "security" | "oom" | "timeout" | "network" | "infra" | "exit"
               // exit = only the exit code is known

type Cluster = {              // id = "f:" + 12 hex of sha256(signature); failures of the last 24 h
  id: string,
  signature: string,          // the grouping key, readable: "<step> · <class>[ · <line>]"
  step: string,               // step (Roadrunner) or job / step (GHA) name; numbered shards folded
                              // ("test-web-3" → "test-web-#")
  class: FailClass,
  line?: string,              // the decisive error line from the step's log, normalized (hashes,
                              // numbers, paths, durations masked), ≤ 160 chars
  exit_code?: number,
  count: number,              // failed steps with this signature, last 24 h
  count_1h: number,           // … last hour
  repos: string[],            // distinct repos, most recent first (≤ 12)
  repo_count: number,
  groups: string[],           // Group ids of those repos
  first_seen: number,         // first failure with this signature (kept 7 d)
  last_seen: number,
  examples: string[],         // failing Pipeline ids, newest first (≤ 5)
  open: number,               // repos whose latest run of this step still fails (0 = all recovered)
  flaky?: number              // how many of `count` were flakes (passed on the same sha within 6 h)
}

type Flake = {                // id = "<owner/name>|<workflow>/<step>"; present while flips_24h ≥ 1
  id: string, repo: string, workflow: string, step: string,
  flips_24h: number,          // shas on which this step both failed and passed within 6 h (last 24 h)
  failures_24h: number,       // failed runs of this step, last 24 h
  last_at: number,
  shas: string[]              // newest first (≤ 5)
}

type Trend = {                // id = "fleet" | a Group id; recomputed at most every 5 min
  id: string, at: number,
  intake_ms: Metric,          // pipeline created → started, p50 (queue wait)
  run_ms: Metric,             // started → finished of successful runs, p50
  pass_rate: Metric,          // success / (success + failure + error) of finished pipelines, 0..1
  pipelines: Metric,          // finished pipelines per hour
  deploys: Metric,            // deploys per hour
  pr_age_ms: Metric,          // median age of open non-bot PRs (a gauge, sampled hourly)
  red: Metric,                // repos with a red main (a gauge, sampled hourly)
  hours_7d: number            // hours of history behind d7 (≤ 168; fills in after a fresh start)
}
type Metric = {
  h1: number | null, h24: number | null, d7: number | null,   // last hour / 24 h / 7 d
  dir: -1 | 0 | 1,            // h1 against d7 (h24 while d7 is null): beyond ±15 % (pass_rate: ±3 points)
  bad?: true,                 // that direction is worse (slower, fewer passes, older PRs, more red)
  spark: (number | null)[]    // 24 hourly values, oldest first, the current hour last
}
```

Durations are in ms rounded to the second; rates to 2 decimals; `null` = no data in that
window. Rates (`pipelines`, `deploys`) are per hour in every window, so they compare
directly.

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
  from: number, to: number,    // `from` is moved up to the oldest retained state if older
  base: Snapshot | null,       // the fleet AT `from` (base.at = from); null with `base=0`
  frames: (Frame | { t: "snapshot", seq: number, at: number, v: Snapshot })[]
                               // in order; at >= from (at > from with base=0), at <= to
}
// Replay: state = base; apply every entry in order; a `t:"snapshot"` entry replaces the
// state (a server restart inside the window).

type Hit = { kind: "repo" | "app" | "pr" | "commit" | "pipeline", id: string,
             title: string, subtitle: string, score: number }

type Journey = {
  id: string /* commit id */, repo: string, sha: string,
  commit: Commit | null, repo_state: Repo | null,
  pipelines: Pipeline[],       // every run of this sha (oldest first)
  prs: Pr[], deploys: Deploy[], app: App | null,
  spans: Span[],               // the Dagger calls of this sha's Roadrunner runs (may be empty)
  timeline: { at: number, k: "push"|"enqueue"|"start"|"finish"|"merge"|"deploy"|"deployed"|"health",
              label: string }[]
}

// One Dagger call (a trace in Tempo, read through cicd `/api/traces`), oldest first.
type Span = { id: string /* trace id */, name: string /* "npm", "python-uv", "failsafe", … */,
              call?: string /* its arguments, without paths/registries/keys */,
              pipeline?: number /* Woodpecker pipeline number */, start: number, ms: number,
              spans?: number /* inner span count */ }

type PrDetail = { pr: Pr, checks: { name: string, state: CiState, required?: true }[] /* every check */, repo_state: Repo | null, commits: Commit[], pipelines: Pipeline[],
                  deploys: Deploy[] }
```

### Factory Floor queries (0.5)

```ts
type Insights = { at: number, groups: Group[],
                  clusters: Cluster[],   // open first, then count_1h, then count
                  flakes: Flake[],       // flips_24h descending
                  trends: Trend[] }      // "fleet" first, then groups by name

type Changes = {                         // GET /api/v1/changes?since=<ms>[&until=<ms>]
  since: number, until: number,
  complete: boolean,                     // false when `since` is older than the retained 24 h (clamped)
  counts: { red: number, recovered: number, still_red: number, pipelines: number,
            failed: number, deploys: number, deploys_failed: number, clusters_new: number,
            flakes: number, prs_merged: number, apps_down: number, apps_recovered: number },
  red: { repo: string, group?: string, at: number, culprit?: string /* sha */,
         cluster?: string }[],          // main went red after `since` and is still red, newest first
  recovered: { repo: string, group?: string, at: number, red_ms: number }[],
  still_red: { repo: string, group?: string, since: number }[],   // red before `since`, still red
  clusters: { id: string, count: number /* failures after since */, new: boolean }[],  // ≤ 20
  deploys: { app: string, sha: string, state: string, at: number }[],                  // ≤ 50, newest first
  apps: { app: string, from: string, to: string, at: number }[],                       // health changes
  groups: { id: string, failed: number, red: number }[]            // where it happened, worst first
}
```

## Fixtures

`contract/fixtures/snapshot.json` is a real fleet snapshot and `contract/fixtures/hour.jsonl`
the real frames that followed it (one frame per line), recorded from the live upstreams by
`switchyard-server --record` and sanitized by `switchyard-server sanitize` (private repo
names, private commit/PR titles and branch names, people's logins are replaced by stable
stand-ins; internal hosts in links become `<name>.example.com`; states, times, shapes and
structure are real).

`switchyard-server --demo` (no credentials) serves them on every endpoint above, looping,
with every timestamp shifted so the loop starts "now", the previous loop pre-recorded into
`/history`, a `reset` at each loop start, and the served snapshot following the stream (at
most 1 s behind) like the live server's.

```sh
cargo run --release -- --demo --listen 127.0.0.1:8080   # from server/, fixtures default to ../contract/fixtures
```

## Changes

- **0.5** (additive; 0.4 clients keep working: they skip the new kinds and fields): the
  Factory Floor. `Repo.group` and `Group` entities; failure `Cluster`s by normalized
  signature (step + class + the decisive log line) with `Step.cluster`; `Flake`s and
  `Pipeline.flaky`; `Trend`s per stage for the fleet and each group (1 h / 24 h / 7 d with
  24 h sparks, from hourly rollups kept 8 d); `GET /api/v1/insights`, `GET /api/v1/changes?since=`.
- **0.4**: smaller deltas and snapshot (measured on the live fleet: stream 7.0 → 1.9 MB/h,
  snapshot 3.1 → 2.5 MB, so 1 h of `/history` ≈ 4.4 MB). New ops `patch` (RFC 7386 merge patch) and `dot` (one main-line
  Dot); `Repo.main.recent` keeps 12 dots (was ≤ 40, 20 in practice); `Pr.checks` lists only
  required / not-passed checks plus `checks_passed`, and `PrDetail.checks` has them all.
- **0.3** (additive): `Pipeline.expected_ms?`, `Repo.p50_build_ms?`; `History.base` is the
  state at `from` (frames before `from` are folded in) or `null` with `base=0`;
  `GET /api/v1/snapshot?at=`; `/api/v1/tstream[/sse]?token=` for header-less native
  streams; web client served at `/` with SPA fallback + cache rules; `meta.process`; the
  demo snapshot follows the stream; `Journey.spans` defined (`Span`, one per Dagger call).
- **0.2** (additive over v0): every entity carries `id`; deploy id = `owner/name@sha`;
  Engine `host`/`online`/`agents`/load; Queue `waiting`/`pipelines_running`/`paused`; Pr
  `ci`/`head`/`merge_sha`/`blocked_by`/`stale_ms`; `start.engine` optional; History
  `{base, frames}`.
