# Data sources

Where every entity in the [wire contract](../../contract/CONTRACT.md) comes from, how
Switchyard reaches it, and why that path is the cheapest real-time one. Every upstream is
read by **one** task in the server; clients never cause an upstream call (upstream cost is
O(1) in clients). Endpoints and credentials come from the environment (table at the end);
nothing internal is hard-coded beyond the public hostnames already used across the fleet.

| Entity | Primary source (real time) | Backfill / reconcile | Cadence |
|---|---|---|---|
| Pipeline (Roadrunner), Step, Workflow | Woodpecker **event stream** (`GET /api/stream/events`, SSE): one message per pipeline change, fleet-wide, with the whole pipeline + workflows + steps | `GET /api/user/feed?latest=true`, `GET /api/repos/{id}/pipelines[/{n}]` | stream: instant; reconcile 60 s; boot: last `SWITCHYARD_BACKFILL_HOURS` (24) |
| Queue, Engine (Woodpecker agents) | `GET /api/queue/info`, `GET /api/agents` | — | 5 s |
| Engine (Dagger engine hosts: cpu/mem/load) | cicd `GET /api/engines` | — | 30 s |
| Repo (inventory, default branch, Woodpecker id) | Woodpecker `GET /api/repos?active=true` + GitHub GraphQL org repositories | — | 10 min (Woodpecker), 1 h (GitHub) |
| Repo main line (`main.recent`, quiet repos) | GitHub GraphQL: default-branch history (20 commits) with `statusCheckRollup.state` | — | 1 h, heads of recently pushed repos every 45–90 s |
| Commit | Woodpecker push pipelines (instant) + GitHub GraphQL heads of the most recently pushed repos | — | 45 s (Northwind-Labs), 90 s (other orgs) |
| Pipeline (GitHub Actions), checks, statuses | GitHub GraphQL `statusCheckRollup.contexts` of each head and each open PR head: `CheckRun`s grouped by workflow run → one `gha:` pipeline; `StatusContext`s → statuses | — | with the heads / PR polls |
| PR | GitHub GraphQL `search(type: ISSUE)`: recently updated open PRs (non-Dependabot) + PRs closed since the last sweep | all open human PRs (10 min), Dependabot PRs (30 min), closed in the last 24 h (boot) | 60 s |
| Deploy | Woodpecker `deploy` workflows (instant) + the `ci/failsafe-deploy` commit status + GitHub Actions deploy workflow runs + cicd's per-repo deploy verdict | — | with the sources above |
| Failure signature (clusters, 0.5) | Woodpecker step log `GET /api/repos/{id}/logs/{n}/{step_id}`, read **once per failed step** of a finished run (live first, then the boot backlog; ≤ 2.5 requests/s; the last 5,000 lines) and reduced to a class + one normalized line (`src/signature.rs`); GitHub Actions failures: step name + exit only | — | seconds after the failure |
| Groups (0.5) | the apps catalog's `team` per app, joined repo → app (else the repo's org) | — | with the apps catalog |
| Trends (0.5) | computed from the registers above; closed hours persisted to `<data-dir>/rollups.jsonl` (8 days) for the 7-day baseline | — | 5-minute buckets |
| Lane (Roadrunner mode per repo) | cicd `GET /api/roadrunner/mode` (lanes, fallback, held) | — | 30 s |
| Watcher (outage / failover) | cicd `GET /api/roadrunner/mode`: Roadrunner health, fleet lane, failover state | — | 30 s |
| App + health | apps catalog `GET /api/apps` (every app: repo, url, runtime, team, health probe, container state, last deploy) | — | 20 s |
| Spans (commit journey) | cicd `GET /api/traces` (Dagger spans), fetched on demand for `/api/v1/commit` and cached | — | on demand, cached 60 s |

## Why these paths

- **Woodpecker is the real-time backbone.** Its SSE stream is the only fleet-wide push feed
  among the upstreams: a single connection sees every pipeline/workflow/step transition on
  every repo the token can read. The bot identity is the one Woodpecker user with
  permissions on every active repo; the stream only carries repos the caller may see, so a
  personal token would show a partial fleet. The SSE connection is re-established with
  backoff and every reconnect triggers a reconcile (`/api/user/feed` + pipeline detail), so
  a dropped stream can delay but never lose an update. A `created` pipeline without
  workflows is not shown: Woodpecker stores one per webhook before reading its config and
  deletes it unpublished when no workflow matches. A pipeline whose detail turns 404 was
  deleted upstream and is removed from the board.
- **GitHub is polled through GraphQL, not REST, not webhooks.** One GraphQL query returns
  25–50 repositories with their heads, rollups and checks for a cost of ~1 point (budget
  5,000/h), so the whole fleet costs ~200 points/h. There is no fleet-wide GitHub webhook
  feed available to an app today (the org webhook relay only forwards repository-creation
  events), and REST would cost one call per repo. Pages that take GitHub more than ~10 s
  come back as HTTP 502; the adapter retries the page with a smaller page size.
- **cicd owns policy, not raw data.** Lanes/modes, the deploy verdict, the outage watcher,
  Dagger engine hosts and traces exist only in cicd, so Switchyard reads them from cicd
  instead of re-deriving them. `/api/roadrunner/mode` accepts a GitHub token; the
  SSO-gated read routes (engines, traces) accept a dedicated, GET-only service token
  (`CICD_READ_TOKEN`, cicd's `SWITCHYARD_READ_TOKEN`).
- **The apps catalog is the single cheap source for app health:** one unauthenticated call
  returns every app with its last probe, so 20 s polling costs one request per 20 s.

## Facts, not events

Every adapter emits **facts** (the latest observation of one upstream object, with its own
version: Woodpecker `updated`, GitHub `updatedAt`, a probe time, or a content hash). The
store keeps the newest fact per object and derives every wire entity from the current
facts, so arrival order, duplicates and replays never change the result (property-tested in
`tests/reducer_props.rs`). Transient animation events (`push`, `start`, `step`, `finish`,
...) are emitted only for live changes, never for backfill or late reconciles of finished
runs.

## Configuration

| Variable | Default | Used for |
|---|---|---|
| `WOODPECKER_URL` | `https://ci.dev.example.com` | Woodpecker API + event stream |
| `WOODPECKER_PUBLIC_URL` | `WOODPECKER_URL` | links shown to people |
| `WOODPECKER_TOKEN` | — (adapter disabled) | Woodpecker API token of the CI bot identity (read-only use) |
| `GITHUB_TOKEN` (or `GITHUB_BOT_TOKEN`) | — (adapter disabled) | GitHub GraphQL (read-only use) |
| `GITHUB_API_URL` | `https://api.github.com` | |
| `CICD_URL` | `https://cicd.apps.example.com` | cicd console API |
| `CICD_READ_TOKEN` | — (falls back to the GitHub token: lanes + watcher only) | cicd SSO-gated reads (engine hosts, traces) |
| `APPS_CATALOG_URL` | `https://catalog.apps.example.com/api/apps` | app inventory + health |
| `SWITCHYARD_ORGS` | the five Exowatt orgs | which GitHub orgs to watch |
| `SWITCHYARD_BACKFILL_HOURS` | `24` | boot backfill window |
| `EXOWATT_AUTH_AUDIENCE` | — | OAuth client id(s) of the SSO edge (verifies browser identities) |
| `SWITCHYARD_SERVICE_TOKENS` | — | `name:sha256hex,…` of read-only service tokens (`sys_…` Bearer; monitors, live e2e) |
| `EXOWATT_AUTH_ALLOWED_EMAIL_DOMAINS` / `SWITCHYARD_EMAIL_DOMAINS` | — | who may sign in |

An adapter whose credentials are missing registers as `disabled`: it shows in
`/api/readyz` and `/api/v1/meta` but does not hold readiness back.
