# switchyard-server

The live brain of Switchyard: one Rust (tokio + axum) binary that ingests every CI/CD
upstream of the fleet (Roadrunner/Woodpecker, GitHub, the cicd console, the apps catalog),
keeps the whole fleet's state in memory, and streams it to every client as one snapshot +
a delta stream. Deployed at **https://switchyard.apps.example.com**. The wire protocol is
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
cargo run --release -- --demo --static-dir ../app/dist/web
```

Then `curl -s localhost:8080/api/v1/meta | jq` or open `ws://localhost:8080/api/v1/stream`.

| Flag / env | Default | |
|---|---|---|
| `--listen` / `SWITCHYARD_LISTEN` | `0.0.0.0:8080` | |
| `--demo`, `--fixtures DIR`, `--speed X` | off, `contract/fixtures` (or `../contract/fixtures`), 1.0 | demo playback |
| `--auth open\|platform` / `SWITCHYARD_AUTH` | `open` | `platform` = SSO edge + device tokens |
| `--static-dir` / `SWITCHYARD_STATIC_DIR` | — | web client to serve at `/` (SPA fallback) |
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
- **History** (`src/history.rs`): 24 h on-disk ring of frames + periodic checkpoints;
  `/api/v1/history` returns a checkpoint and the frames after it.
- **Auth** (`src/auth.rs`, `src/google.rs`): browsers come through the platform's SSO edge
  (e-mail header confirmed by the edge's Google ID token, verified against Google's JWKS);
  the macOS app uses revocable device tokens minted on the SSO-gated `/connect` page; a
  Google ID token (`gcloud auth print-identity-token`) also works as a Bearer.

## Test and bench

```sh
cargo fmt --all -- --check
cargo clippy --all-targets --locked -- -D warnings
cargo test --locked            # unit, adapters (recorded upstream payloads), properties, golden, fixture replay
cargo bench --bench core       # ingest, snapshot, fan-out; numbers in docs/PERF.md
```

CI: `.woodpecker/server.yaml` (Roadrunner) runs all of the above (benches in `--test` mode).

## Deploy

The app platform deploys only Northwind-Labs repos, so a private wrapper repo
(`Northwind-Labs/deploy-wrapper`) pins one commit of this public repo; on the app's
container its build script fetches that commit, builds this crate (`--profile ct`,
persistent target dir, hot redeploy) and the web client, and installs both. Runtime secrets
are platform env vars (`WOODPECKER_TOKEN`, `GITHUB_TOKEN`, `CICD_READ_TOKEN`).
