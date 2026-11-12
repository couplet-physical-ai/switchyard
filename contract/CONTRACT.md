# Switchyard wire contract — v0.6

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
| `GET /api/v1/snapshot?at=<ms>` | the fleet as it was at `at` (within the last 24 h): a `Snapshot` with `at` = the requested time. See "Past states" below for which tables a past state carries. |
| `GET /api/v1/stream/sse?since=<seq>` | same frames as Server-Sent Events (`data: <frame>`), fallback. |
| `GET /api/v1/tstream?token=<device token>&since=<seq>` (WS), `GET /api/v1/tstream/sse?token=…` | the same streams for native clients that cannot set headers on a WebSocket: they accept ONLY our own tokens in the query: a device token (`syd_…`) or a read-only service token (`sys_…`) (see Auth). |
| `GET /api/v1/history?from=<ms>&to=<ms>[&base=0]` | replay window (≤ 3 h, within the last 24 h): `History`. `base=0`: no base snapshot, only what happened after `from`. Groups as in "Past states". |
| `GET /api/v1/commit/{owner}/{name}/{sha}` | `Journey` for one commit (sha may be abbreviated). |
| `GET /api/v1/pr/{owner}/{name}/{number}` | `PrDetail`. |
| `GET /api/v1/search?q=&limit=` | ⌘K: `{q, results: Hit[]}` across repos / apps / PRs / commits / pipelines. |
| `GET /` and any other non-`/api` path | the web client (`--static-dir` / `SWITCHYARD_WEB_DIR`): the file if it exists, else `shell.html` with 200 (SPA). Content-hashed files (`name-XXXXXXXX.ext`) are `Cache-Control: public, max-age=31536000, immutable`; everything else (`shell.html`, `index.html`, `app.js`, `app.plan`, `style.css`, …) `no-cache`. Unknown `/api/*` paths are a JSON 404, never the shell. |
| `GET /api/v1/insights` | the Factory Floor in one call: `Insights` (groups, failure clusters, flakes, trends), same entities as the snapshot tables, sorted for display. |
| `GET /api/v1/changes?since=<ms>[&until=<ms>]` | "since your last visit": `Changes` — what turned red, recovered, deployed, new failure clusters, PRs, counts; up to 7 days back. |
| `GET /api/v1/app/{id}` | `AppHistory`: the app now, its last 10 deploys, its health transitions over 7 days. 404 if unknown. |
| `GET /api/v1/pipeline/{id}/log?step=<Step.name>[&workflow=<Workflow.name>][&tail=200][&around=decisive]` | `PipelineLog`: the tail of one step's log (or, with `around=decisive`, the ±40 lines around a failed step's decisive line), read on demand (only when `meta.caps` has `"pipeline_log"`). `id` URL-encoded (`wp%3Aacme%2Fapi%3A42`, `gha%3A123`); `tail` lines, default 200, max 500. 404 for a pipeline not in the live view or an unknown step; 400 without `step`; 502 when the upstream fails. |
| `GET /api/v1/engine/{id}/history` | `EngineHistory`: one engine (agent, Dagger host, runner pool) over 24 h at one-minute resolution, columnar; the repos it served in the last hour. 404 if unknown. |
| `GET /api/v1/meta` | `{protocol, version, git_sha, mode: "live"\|"demo", epoch, seq, snapshot:{seq,at,bytes,gzip_bytes}, clients, adapters: AdapterStatus[], orgs, counts, process: {rss_bytes, peak_rss_bytes, threads}, web, caps, links, booting?, now}`. `booting: true` (0.6): the server restarted and is rebuilding the fleet from its sources (~5 min); meanwhile the snapshot and stream hold the fleet as it was just before the restart (live events still arrive) and move to the rebuilt fleet in one delta when `booting` clears (a client may say "catching up"). `links` (0.6): the deep-link bases `{github, roadrunner, woodpecker, cicd}` (`roadrunner` = `woodpecker`, the Roadrunner UI; `cicd` = the Roadrunner console); every URL field is built from these, so a client never hardcodes a host. `caps`: optional features this server serves, e.g. `["pipeline_log"]` (a client shows a feature only when listed; absent on servers before it). `web` (null without a web client): `{sha, tree?, files, shell_bytes, app_js_bytes}`, `sha` = the commit the served web build came from, `tree` = that commit's `app/` tree hash (`git rev-parse <sha>:app`, 40 hex): a deploy that changes only the server moves `sha`, never `tree`. |
| `GET /api/healthz` | liveness `{ok:true}` (public). |
| `GET /api/readyz` | `{ready, mode, seq, adapters: AdapterStatus[]}`; 200 when every enabled adapter has synced once, else 503. |
| `GET /connect` | (browser, SSO) page that mints a device token for the macOS app. |
| `GET /api/v1/whoami`, `GET /api/v1/tokens`, `DELETE /api/v1/tokens/{id}` | the caller, their device tokens, revoke one. |

`AdapterStatus = {name, state: "disabled"|"starting"|"syncing"|"ok"|"degraded"|"error", last_ok?, last_error?, last_error_at?, lag_ms?, synced, backfilling?, note?, requests}` (an adapter back to `ok` keeps its `last_error`; `last_error_at` says when it was)

### Past states (`/snapshot?at=`, `/history`)

- **Groups are always there.** Every `Repo` carries `group` and the `groups` table is
  present, as live. History recorded by a server ≥ 0.5 carries the groups of its time.
  Older history (before 0.5, which had none) is filled from the **live** repo → group
  map, i.e. the team each repo is in now, not then (team moves are rare; the map is not
  persisted). The `groups` table is recounted (`repos`, `apps`, `red`) from the state at
  that time, and `/history` frames carry `group` ops whenever those counts move, so a
  replay keeps its lanes and their red counts.
- **Clusters, flakes, trends** (and `Pipeline.flaky`, `Step.cluster`): as recorded at
  that time by a server ≥ 0.5; older history has none (empty tables). They are never
  recomputed for the past: failure signatures need step logs read at the time.
- A time before the oldest recorded history is answered with the oldest recorded state
  (its `at` says which).

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
  protocol: "0.6", epoch: string, seq: number, at: number,
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
  links: { github: string,    // the repo on GitHub
           woodpecker?: string, // its Woodpecker repo page
           cicd?: string }      // its Roadrunner console repo page (/repos/<wp id>)
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
  deploy?: DeployRef,
  links?: { commit: string,   // 0.6: the commit on GitHub
            branch?: string,  // its branch on GitHub (absent for "pull/N")
            pr?: string }     // its PR on GitHub
}

type Pipeline = {             // id = "wp:<owner/name>:<number>" (Roadrunner) | "gha:<run_id>" (GitHub Actions)
  id: string, lane: "roadrunner" | "gha",
  repo: string, number: number, sha: string,
  branch: string,             // push: the branch; pull_request: the PR's head branch
  ref?: string,               // 0.6: tag runs: the tag ("v1.4.0")
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
  url: string,                // Roadrunner run (wp:) | GitHub Actions run (gha:)
  links?: {                   // 0.6
    cicd?: string,            // the run in the Roadrunner console (wp:)
    woodpecker?: string,      // the run in Roadrunner (= `url`, wp:)
    github?: string,          // the GitHub Actions run (gha:)
    commit?: string,          // the commit on GitHub
    branch?: string,          // the branch on GitHub (not tag runs; PR runs: the head branch)
    release?: string,         // the release / tag on GitHub (tag runs with a `ref`)
    pr?: string               // the PR on GitHub (pull_request runs)
  }
}
type Workflow = { name: string, state: CiState, started?: number, finished?: number,
                  engine?: string, steps: Step[],
                  url?: string }      // 0.6: Roadrunner opened on its first step (wp:),
                                      // the GitHub Actions run (gha:)
type Step = { name: string, state: CiState, started?: number, finished?: number,
              exit_code?: number, cached?: boolean,
              cluster?: string,       // 0.5: failed steps: the failure Cluster id
              url?: string }          // 0.6: where the step and its log open: Roadrunner's
                                      // step page `…/repos/{id}/pipeline/{n}/{step pid}`
                                      // (wp:); the GitHub Actions job (gha: a Step is a
                                      // job), on its failed step `…/job/{id}#step:{i}:1`
                                      // when it failed

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
  url: string,                // the PR on GitHub
  links?: { checks: string,   // 0.6: its checks tab
            branch?: string } // its head branch on GitHub
}

type Deploy = {               // id = "owner/name@sha" (same as the commit's id)
  id: string, app: string, repo: string, sha: string,
  via: "roadrunner" | "gha" | "gha_fallback" | "manual",
  state: "pending" | "running" | "success" | "failure",
  started: number, finished?: number, pipeline?: string,
  url?: string,               // the deploy run (Woodpecker / GitHub Actions)
  links?: { cicd?: string,    // 0.6: the deploy run in the Roadrunner console (Roadrunner deploys)
            commit?: string,  // the deployed commit on GitHub
            app?: string }    // "Open app": the app's URL
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
  team?: string, note?: string,
  status_url?: string,        // 0.6: its status page (apps catalog: health, latency, resources)
  links?: { logs?: string,    // 0.6: its runtime logs (apps catalog)
            repo?: string }   // its repo on GitHub
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
  agents?: string[],          // engine host → its agent engine ids
  url?: string                // 0.6: its machine's page: the Roadrunner console's engine page
                              // for the machine it shows (its Dagger engine and the agents on
                              // it), else Roadrunner's agents page (no page per agent)
}

type Queue = {                // id = "roadrunner"
  id: string,
  pending: number,            // workflows waiting for a slot
  running: number,            // workflows running
  waiting: number,            // workflows waiting on depends_on
  pipelines_running: number,
  paused?: true,
  oldest_wait_ms: number,
  items: string[],            // pending Pipeline ids in queue order (≤ 50)
  url?: string                // 0.6: its page (Roadrunner's queue)
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

type Trend = {                // id = "fleet" | a Group id; as of `at`, the start of the current
                              // 5-minute bucket (updates at most every 5 min, plus late data)
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
  h1?: number, h24?: number, d7?: number,   // last hour / 24 h / 7 d (absent = no data)
  dir: -1 | 0 | 1,            // h1 against d7 (h24 until 7-day data exists): beyond ±15 % AND an
                              // absolute floor (5 s for durations, 1 h for PR age, 2/h for rates,
                              // 5 points for pass_rate, 1 repo for red); 0 for intake/run/pass_rate
                              // when the last hour had < 5 finished runs
  bad?: true,                 // that direction is worse (slower, fewer passes, older PRs, more red)
  spark: (number | null)[]    // the last 24 full hours, oldest first (the running hour is h1)
}
```

Durations are in ms rounded to the second (PR age to the hour); rates to 2 decimals; a missing `h1`/`h24`/`d7`
(or a `null` in `spark`) = no data in that window. Rates (`pipelines`, `deploys`) are per hour in every window, so they compare
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
  complete: boolean,                     // false when `since` predates what the server has seen (its
                                         // persisted log, ≤ 7 d); `since` is clamped to 7 d
  counts: { red: number, recovered: number, still_red: number, pipelines: number,
            failed: number, deploys: number, deploys_failed: number, clusters_new: number,
            flakes: number, prs_opened: number, prs_merged: number,
            prs_stuck: number,       // open, not draft, human, no activity > 3 d (now)
            prs_stuck_bot: number,   // the same for bot PRs (Renovate, Dependabot, …)
            apps_down: number, apps_recovered: number },
  red: { repo: string, group?: string, at: number, culprit?: string /* sha */,
         cluster?: string }[],          // main went red after `since` and is still red, newest first
  recovered: { repo: string, group?: string, at: number, red_ms?: number }[],
  still_red: { repo: string, group?: string, since: number }[],   // red before `since`, still red
  clusters: { id: string, count: number /* failures after since */, new: boolean }[],  // ≤ 20
  deploys: { app: string, sha: string, state: string, at: number }[],                  // ≤ 50, newest first
  apps: { app: string, from: string, to: string, at: number }[],                       // health changes
  groups: { id: string, failed: number, red: number,
            prs: { opened: number, merged: number, stuck: number } }[]  // where it happened,
                                                                         // worst first (red, failed, stuck)
}

type AppHistory = {                      // GET /api/v1/app/{id}
  id: string,
  app: App | null,                       // as in the snapshot (null: gone from the catalog)
  deploys: { sha: string, via: Deploy["via"] /* the lane */, state: Deploy["state"],
             started: number, at: number /* finished, else started */,
             finished?: number, duration_ms?: number, pipeline?: string }[],  // ≤ 10, newest first
  health: { from: Health, to: Health, at: number }[],   // transitions, newest first, 7 d
  health_ms: { up?: number, degraded?: number, down?: number, unknown?: number },
                                         // time in each state from `since` to now
  since: number, complete: boolean       // the 7 d window, or less while the log is younger
}

type PipelineLog = {                     // GET /api/v1/pipeline/{id}/log?step=&workflow=&tail=
  id: string, step: string,
  workflow?: string,                     // the step's workflow (Woodpecker workflow / GHA workflow)
  state: CiState,                        // the step's state as read
  lines: string[],                       // the tail, oldest first: ANSI and \r progress stripped,
                                         // GitHub's per-line timestamps stripped, each line cut at
                                         // 400 chars (…), secrets redacted to "[redacted]" (see
                                         // below); [] for a step that has not started (pending,
                                         // blocked, skipped) or a GHA job still running (GitHub
                                         // publishes a job's log when it ends)
  truncated: boolean,                    // the log goes on before `lines`, or a line / the 64 KB
                                         // budget was cut
  bytes: number,                         // UTF-8 size of `lines` (≤ 64 KB)
  around?: "decisive",                   // `around=decisive` and the step has a decisive line:
                                         // `lines` = the ±40 lines around it (else the tail)
  after?: number,                        // with `around`: log lines after the window
  decisive?: number,                     // failed steps: the index in `lines` of the decisive
                                         // error line, raw (redacted like the rest): a line
                                         // the step's Cluster.line is the normalized form of
                                         // (else the classifier's pick; read from the same last
                                         // 5,000 log lines), at its first occurrence in the
                                         // returned lines; never a teardown line ("context
                                         // canceled", "signal: killed"); absent when none is
                                         // inside the returned tail or the log gave no clear cause
  fetched: number                        // when it was read upstream (ms)
}
// Woodpecker (`wp:`): the step's own log. GitHub Actions (`gha:`): a Step is a job; its
// log is the job's. Cached 10 s while the step runs and 10 min once it is done; at
// most 4 upstream reads at a time. Redacted: `Authorization: …`, `Bearer`/`Basic`
// credentials, URL user:password@, values of secret-named keys (token, secret,
// password, api_key, access_key, private_key, credential, dsn, …: `k=v`, `k: v`,
// `"k": "v"`, `--k=v`), known token shapes (ghp_/ghs_/github_pat_, xox?-, sk-…, AKIA…,
// AIza…, syd_/sys_, npm_, glpat-, …), JWTs, PEM private key blocks (every line),
// and long mixed-case high-entropy strings. Hex digests and paths stay.

type EngineHistory = {                   // GET /api/v1/engine/{id}/history (id URL-encoded:
                                         // "dagger%3AVM%20153")
  id: string, kind: Engine["kind"], host?: string,
  from: number, step_ms: 60000, n: 1440, // minute i covers [from + i·step_ms, + step_ms)
  busy:  (number | null)[],              // n values: peak busy slots in the minute (a minute
                                         // without a change holds the last value); null =
                                         // offline / no data
  slots: (number | null)[],
  cpu:   (number | null)[],              // as Engine.cpu / mem / load, 1 decimal
  mem:   (number | null)[],
  load:  (number | null)[],
  repos: { repo: string, runs: number }[]  // pipelines it (a host: its agents) ran in the
                                           // last hour, most first
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

- **0.6** (additive; 0.5 clients keep working): deep links, all optional and built from
  the configured bases in `meta.links {github, roadrunner, woodpecker, cicd}` — a client
  hides a link that is absent. `Step.url` (Roadrunner step page; GitHub Actions job, on
  its failed step), `Workflow.url`, `Engine.url` (machine page), `Queue.url`,
  `App.status_url`, `Pipeline.ref` (tags); `links` objects on Pipeline / Commit / Pr /
  Deploy / App; Repo `links.cicd` → the console's repo page. `PipelineLog`:
  `around=decisive`. Snapshot +20 % raw, +6 % gzipped (live: 1.84 → 2.21 MB raw).
  Warm boot: after a restart the server serves the fleet as it was before it until it has
  rebuilt (`meta.booting`), never the half-empty fleet of a cold start.
- **0.5** (additive; 0.4 clients keep working: they skip the new kinds and fields): the
  Factory Floor. `Repo.group` and `Group` entities; failure `Cluster`s by normalized
  signature (step + class + the decisive log line) with `Step.cluster`; `Flake`s and
  `Pipeline.flaky`; `Trend`s per stage for the fleet and each group (1 h / 24 h / 7 d with
  24 h sparks, from hourly rollups kept 8 d); `GET /api/v1/insights`, `GET /api/v1/changes?since=`.
  Measured on the live fleet: the new tables add 127 KB (5 %) to the snapshot (2.39 MB) and
  49 KB/h (3.4 %) to the stream (1.45 MB/h). Then: `/changes` PR counts (opened / merged /
  stuck per group) and a 7-day window (a persisted log), `GET /api/v1/app/{id}`,
  `GET /api/v1/engine/{id}/history`; `GET /api/v1/pipeline/{id}/log` behind
  `meta.caps: ["pipeline_log"]` (+ `decisive`).
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
