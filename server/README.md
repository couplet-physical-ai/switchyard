# switchyard-server

The live brain of Switchyard: one Rust (tokio + axum) binary that ingests every CI/CD
upstream of the fleet (Roadrunner/Woodpecker, GitHub, the cicd console, the apps catalog),
keeps the whole fleet's state in memory, and streams it to every client as one snapshot +
a delta stream. Deployed at **https://switchyard.apps.example.internal**. The wire protocol is
[`contract/CONTRACT.md`](../contract/CONTRACT.md).

```
 Woodpecker SSE ─┐                                  ┌─► GET /api/v1/snapshot   (pre-encoded, gzip, ETag)
 Woodpecker polls┤                                  ├─► WS  /api/v1/stream     (≤ 30 frames/s per client)
 GitHub GraphQL ─┼─► facts ─► Store (reducer) ─► Hub┼─► SSE /api/v1/stream/sse
 cicd console   ─┤    mpsc     order-independent    ├─► 24 h replay ring ─► /api/v1/history
 apps catalog   ─┘             derive + diff        └─► /commit /pr /search /meta
```

## Run it

```sh
cd server
# Demo: the recorded fixtures, looped and time-shifted to "now"; no credentials.
cargo run --release -- --demo --listen 127.0.0.1:8080
# Live, against the real upstreams (tokens from env, see docs/SOURCES.md):
WOODPECKER_TOKEN=… GITHUB_TOKEN=… cargo run --release -- --listen 127.0.0.1:8080
# Serve a web client build at / as well:
cargo run --release -- --demo --static-dir /tmp/sy-web   # from ../app: scripts/build.sh web /tmp/sy-web
```

Then `curl -s localhost:8080/api/v1/meta | jq` or open `ws://localhost:8080/api/v1/stream`.

| Flag / env | Default | |
|---|---|---|
| `--listen` / `SWITCHYARD_LISTEN` | `0.0.0.0:8080` | |
| `--demo`, `--fixtures DIR`, `--speed X` | off, `contract/fixtures` (or `../contract/fixtures`), 1.0 | demo playback |
| `--auth open\|platform` / `SWITCHYARD_AUTH` | `open` | `platform` = SSO edge + device tokens |
| `--static-dir` / `SWITCHYARD_WEB_DIR` | — | web client to serve at `/`: the file, else `shell.html` (SPA); hashed files cached for a year |
| `--data-dir` / `SWITCHYARD_DATA_DIR` | `data` | replay ring + device tokens |
| `--public-url` / `SWITCHYARD_PUBLIC_URL` | — | for `/connect` links |
| `--record DIR --record-minutes N` | — | record live fixtures (snapshot + frames) |
| `switchyard-server sanitize --in DIR --out DIR --public-repos FILE` | | scrub a recording for the public repo |

## How it works

- **Adapters** (`src/adapters/`): one task per upstream emits *facts* — the latest
  observation of one upstream object with its own version. Woodpecker's event stream is the
  real-time backbone; GitHub is polled with GraphQL (~1 point per 25–50 repos). Details and
  rationale: [`docs/SOURCES.md`](docs/SOURCES.md).
- **Store** (`src/store.rs`): keeps the newest fact per object and *derives* every wire
  entity (repo main line + culprit, commit stage, PR phase, deploy across all signals, app
  live sha / behind, fleet stats) from current facts only. Marked-dirty entities are
  re-derived on each flush (≤ 30/s) and diffed against the last serialized JSON, so a frame
  carries only real changes. Any arrival order, duplicates or replays give the same state
  (`tests/reducer_props.rs`).
- **Hub** (`src/hub.rs`): every frame is encoded once and shared (`Arc`) by all clients; a
  ring of recent frames serves `?since=` resumes; the snapshot is re-encoded at most once a
  second and served from memory with a cached gzip. Per-client pumps merge pending frames
  (≤ 30 frames/s); a client that falls behind the broadcast channel gets a `reset` (refetch
  the snapshot), never an unbounded queue.
- **History** (`src/history.rs`): 24 h on-disk ring of frames + periodic checkpoints.
  `/api/v1/history?from&to` returns the fleet at `from` (`base`) and the frames after it;
  `&base=0` drops the base (replay in chunks). A server restart inside the window goes out
  as one delta (only what changed across it), never a whole snapshot.
- **Factory Floor** (`src/store/insights.rs`, `src/signature.rs`, `src/ledger.rs`; contract
  0.5): every repo gets a `group` (its app's team from the apps catalog, else its org).
  The log of each failed Roadrunner step is read once and reduced to a signature (step +
  class + the decisive normalized line, the repo's own names masked), and failures with
  the same signature across the fleet form a `cluster` (24 h, with first-seen kept 7 d).
  A step that failed and passed on the same sha within 6 h is a `flake`. `trend`s compare
  the last hour with 24 h and 7 d per stage, for the fleet and each group, in 5-minute
  buckets, from the registers plus hourly rollups persisted in `<data-dir>/rollups.jsonl`.
  `/api/v1/changes?since=` answers "since my last visit" (up to 7 days) from a ledger kept
  off the stream and persisted to `<data-dir>/ledger.jsonl` (appended as things happen,
  compacted at boot and daily); the same ledger serves `/api/v1/app/{id}` (last deploys,
  health over 7 days) and `/api/v1/engine/{id}/history` (24 h of engine load by the minute,
  rebuilt from history at boot).
- `/api/v1/pipeline/{id}/log?step=` serves the tail of one step's log on demand
  (`src/logs.rs`): Woodpecker step logs or GitHub Actions job logs, read with the
  adapters' tokens, ≤ 500 lines / 64 KB, secrets redacted, cached 10 s while running and
  10 min once done, ≤ 4 upstream reads at a time. Listed in `meta.caps` as
  `pipeline_log` when configured (live mode). All of it is computed from the registers like
  every other entity, so the order-independence properties cover it.
- **Restart settling** (`Hub::begin_settle` / `end_settle`, `Adapters::settled`): a new
  process starts empty and backfills the whole fleet (GitHub's inventory and PR pages take
  ~4-6 min). History records nothing while it does; once every adapter is synced, done
  with its boot backfill and quiet for 5 s (at most 10 min), history records one restart
  entry with the settled fleet. A deploy therefore costs `/history` ~0.2 MB instead of a
  megabytes-large refill. `readyz` turns ready earlier (heads + open PRs, ~1 min);
  `meta.adapters[].backfilling` shows the rest.
- **Warm boot** (`ReducerCfg::warm`, `History::last_state`): when history holds a state
  from the last 2 h (any restart, any deploy), clients are served that fleet while the
  store rebuilds: the snapshot is the last state, the half-built fleet's churn is held (live events,
  the runs it holds or that are going, the deploys going, the engines and the queue still go
  out: a run that finishes during the boot shows finished at once) and `meta.booting` is true; at settle one delta moves them to the rebuilt
  fleet. Without it, every restart showed a half-empty fleet for ~5 min (live: 376 repos,
  13 red, 129 blank main lines, against 387 / 27 settled).
- **Auth** (`src/auth.rs`, `src/google.rs`): see [Tokens](#tokens) below.

## Tokens

| Who | Credential | Where it is accepted |
|---|---|---|
| A browser | the platform's SSO session (the edge adds the e-mail header and its Google ID token, verified against Google's JWKS) | everything, incl. `/` and `/connect` |
| The macOS app (a person) | **device token** `syd_…`, minted on the SSO-gated `/connect` page (link `switchyard://connect?server=…&token=…`), revocable, stored hashed in `<data-dir>` | `Authorization: Bearer` on `/api/v1/*`; `?token=` on `/api/v1/tstream[/sse]` |
| Monitors, the live e2e check, test clients | **service token** `sys_…`, read-only, one per identity name (`e2e`, `client`, …), configured as hashes in `SWITCHYARD_SERVICE_TOKENS=name:sha256hex,…` | same as a device token |
| Someone on the VPN with gcloud | a Google ID token (`gcloud auth print-identity-token`) | `Authorization: Bearer` on `/api/v1/*` |

`/api/v1/tstream` and `/api/v1/tstream/sse` exist for clients that cannot set headers on a
WebSocket: the platform edge lets them through without a session
(`allow_paths_unauthenticated`), so they accept **only** our own tokens from the query,
never edge headers or Google tokens. Behind the edge never put `?token=` on any other path:
the edge redirects it to sign-in with the token copied into the redirect URL. Every refused
request is logged with its path, the token *kind* and the client address (never the token).

Rotate a service token (the value never leaves a 0600 file):

```sh
umask 077; python3 -c "import secrets; print('sys_' + secrets.token_urlsafe(32))" > new-token
h=$(tr -d '\n' < new-token | sha256sum | cut -d' ' -f1)
# list every identity that should keep working, e.g. e2e:<h1>,client:<h2>
printf 'e2e:%s,client:%s' "$h" "$h_client" | gh secret set SWITCHYARD_SERVICE_TOKENS -R Northwind-Labs/deploy-wrapper
gh workflow run populate-secrets.yml -R Northwind-Labs/deploy-wrapper   # writes the app env, restarts it
curl -so /dev/null -w '%{http_code}\n' -H "Authorization: Bearer $(cat old-token)" https://switchyard.apps.example.internal/api/v1/meta  # 401
curl -so /dev/null -w '%{http_code}\n' -H "Authorization: Bearer $(cat new-token)" https://switchyard.apps.example.internal/api/v1/meta  # 200
```

Device tokens: `GET /api/v1/tokens` lists the caller's, `DELETE /api/v1/tokens/{id}` revokes one. The cicd
read token this server uses (`CICD_READ_TOKEN`) is the other half of cicd's
`SWITCHYARD_READ_TOKEN`; rotate it on both sides: `gh secret set SWITCHYARD_READ_TOKEN -R
Northwind-Labs/cicd` + `gh workflow run populate-secrets.yml -R Northwind-Labs/cicd`, then the
same value as `CICD_READ_TOKEN` here.

## Test and bench

```sh
cargo fmt --all -- --check
cargo clippy --all-targets --locked -- -D warnings
cargo test --locked            # unit, adapters (recorded upstream payloads), properties, golden, fixture replay
cargo bench --bench core       # ingest, snapshot, fan-out; numbers in docs/PERF.md
```

CI: `.woodpecker/server.yaml` (Roadrunner) runs all of the above (benches in `--test` mode).

Live checks against a running server (numbers in [`docs/PERF.md`](docs/PERF.md)):

```sh
# health, readiness (every adapter ok), a real snapshot, live deltas; with a sha pushed
# right after it starts, the time until that commit shows up on the stream
SY_TOKEN=… cargo run --release --example e2e -- https://switchyard.apps.example.internal [sha]
# N real WebSocket clients: delivery lag, merged frames, resets
cargo run --release --example wsload -- wss://switchyard.apps.example.internal/api/v1/stream 200 60
```

## Deploy

The app platform deploys only Northwind-Labs repos, so a private wrapper repo
(`Northwind-Labs/deploy-wrapper`) pins one commit of this public repo (`UPSTREAM`) and
carries the web client prebuilt at the same commit (`web/`). On the app's container its
build script fetches the pinned commit, builds this crate (`--profile ct`, persistent target
dir, hot redeploy) and serves `web/` via `--static-dir`. The web client is built off the
container: Exact's toolchain does not fit the platform's build window, and the container is
small and runs the live server.

```sh
# 1. the web client at the commit being deployed (Bun + Exact at app/exact.pin)
git archive <sha> app contract packaging | tar -x -C /tmp/sy-src
(cd /tmp/sy-src/app && scripts/build.sh web /tmp/sy-web)
# 2. pin the server + web together; pushing main deploys (Roadrunner, ~2 min)
cd deploy-wrapper && scripts/bump.sh <sha> --web /tmp/sy-web && git push origin main
# 3. verify (meta.git_sha and meta.web.sha are the pinned commit)
SY_TOKEN=$(cat e2e-token) cargo run --release --example e2e -- https://switchyard.apps.example.internal
```

Server and web always ship in one bump, so the page and the stream never disagree on the
protocol. `scripts/bump.sh <sha>` without `--web` keeps the current `web/`. Runtime
secrets are platform env vars written by the wrapper's `populate-secrets.yml`
(`WOODPECKER_TOKEN`, `GITHUB_TOKEN`, `CICD_READ_TOKEN`, `SWITCHYARD_SERVICE_TOKENS`).
After a deploy, `readyz` is ready within ~1 min and the restart settles into history
after ~4 min (see [Restart settling](#how-it-works)).
