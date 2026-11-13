# Performance

Budgets (from the brief) and what we measured. Re-run the commands below on a release
build; numbers are from the machines named in each table.

| Budget | Result | How |
|---|---|---|
| `GET /api/v1/snapshot` p99 < 5 ms from memory | **p99 3.8 ms** at 16 concurrent clients, 31,850 req/s (p50 0.29 ms); **p99 1.0 ms** at 8 clients | `oha` against the server (gzip, 481 KiB per response) |
| Delta fan-out to 1,000 clients | **1,000 real WebSocket clients**: 0 failed, 0 resets, delivery lag p50 3 ms / p99 35 ms / max 59 ms at 6.3 frames/s/client (6,260 frames/s total) | `examples/wsload.rs` against `--demo --speed 10` |
| ≥ 20k events/s ingest | **32,900 pipeline events/s** through the reducer (apply + derive + diff + choose upsert / patch / dot + encode, flushing every 64 events) on a fleet-sized store (47,400/s before v0.4's patch encoding; the v0.5 Factory Floor refreshes off this path, ≤ 1/s) | `cargo bench --bench core` → `ingest/pipeline_events_flush64` |
| RSS < 256 MB steady | deployed, all five orgs: **61 MB** steady (peak 80 MB); demo + 1,000 WebSocket clients **190 MB** (212 MB peak) | `/api/v1/meta` → `process`, `/proc/<pid>/status` |
| Zero per-client upstream calls | by construction: adapters are the only upstream callers; one SSE connection + polls, independent of clients (see `docs/SOURCES.md`); `/api/v1/meta` → `adapters[].requests` | |

## Criterion (`cargo bench --bench core`)

Machine: **a Linux dev box** (AWS Graviton4, Neoverse V2, 16 vCPU, Linux aarch64), Rust 1.99.0,
release profile, other load present (load average ~2.5).

| Bench | Time | Throughput |
|---|---|---|
| `ingest/pipeline_events_flush64` (380 events) | 11.5 ms | **32.9 K events/s** (v0.3, whole upserts only: 8.01 ms, 47.4 K/s) |
| `insights/recompute_fleet` (groups + clusters + flakes + trends, ≤ 1/s) | 9.7 ms | — |
| `snapshot/serve_cached` (what a request does: clone the pre-encoded `Arc`) | 23.8 ns | — |
| `snapshot/build_from_store` (≤ 1/s rebuild from pre-serialized tables, ~3.1 MB) | 152 µs | 19.8 GiB/s |
| `snapshot/gzip` (≤ 1/s, cached for every gzip request) | 17.0 ms | 181 MiB/s |
| `fanout/publish_to_all_receivers/100` | 583 ns per frame | 171 M deliveries/s |
| `fanout/publish_to_all_receivers/1000` | 2.14 µs per frame | 467 M deliveries/s |

The fleet in the bench mirrors the real one: 400 repos, 240 apps, 900 pipelines (650
finished, 250 at random steps; 3 workflows × 6 steps each), 1,100 open PRs. An ingest
"event" is one full pipeline observation as Woodpecker's event stream delivers it.

## Snapshot under HTTP load

Machine: a Linux dev box, server `--demo` (2.68 MB snapshot, 481 KiB gzip), loopback.

```sh
oha -n 2000 -c 16 --no-tui -H 'Accept-Encoding: gzip' http://127.0.0.1:8080/api/v1/snapshot
```

| Concurrency | req/s | p50 | p90 | p99 | p99.9 |
|---|---|---|---|---|---|
| 16 | 31,853 | 0.29 ms | 0.72 ms | **3.81 ms** | 7.71 ms |
| 8 | 28,442 | 0.20 ms | — | **1.03 ms** | — |

## 1,000 WebSocket clients

Machine: a Linux dev box (server and load generator on the same box).

```sh
cargo run --release -- --demo --speed 10 --listen 127.0.0.1:8080 &
ulimit -n 8192
cargo run --release --example wsload -- ws://127.0.0.1:8080/api/v1/stream 1000 60
```

```
clients 1000 connected 1000 failed 0 | 60 s | frames 375814 (6260/s total, 6.3/s/client)
  deltas 375814 resets 0 merged-gaps 7089 | 1037.8 MB
delivery lag ms (receipt − frame.at): p50 3 p90 24 p99 35 max 59 | connect ms p50 0 p99 1
```

`merged-gaps` counts frames the per-client pump merged into one (the ≤ 30 frames/s
coalescing): no client fell behind the broadcast channel, so no client needed a reset.
Server RSS went from 139 MB (demo fixtures + replay ring in memory) to 190 MB with 1,000
sockets (~50 KB per client) after the WebSocket buffers were cut from tungstenite's
128 KiB-per-direction defaults to 4 KiB read / unbuffered write (before: 318 MB).

## Payload sizes (contract v0.4)

Live recordings of the whole fleet (five orgs, ~395 repos, ~1,050–1,160 open PRs, ~240 apps)
on a Linux dev box, raw JSON as a client parses it. v0.3 sent every change as a whole-entity
upsert; v0.4 sends whichever of upsert, merge `patch` or main-line `dot` ops is smallest, keeps
12 main-line dots per repo and lists only required / not-passed checks on PRs.

| | v0.3 | v0.4 |
|---|---|---|
| Snapshot | 3.08 MB (repos 45 %, PRs 27 %) | **2.47 MB** raw, 0.50 MB gzip (sanitized fixture: 2.2 MB) |
| Stream | 7.0 MB/h (repo upserts 48 %, pipelines 15 %) | **1.9 MB/h** raw, 0.18 MB/h gzip (24.8 min, 794 frames, 2,834 ops) |
| `/history` for 1 h (base + frames) | ~10 MB | **~4.4 MB** (`base=0` chunks: frames only) |
| Largest stream message | unbounded (a resume merged every missed frame) | ≤ 512 KB (`hub::MAX_MESSAGE`) |

The v0.4 column is the recording that became `contract/fixtures` (before sanitizing; sizes are
`wc -c` of `snapshot.json` and `hour.jsonl` scaled to an hour). The client's own check,
`bun app/tools/stream-check.ts <url> 90` (snapshot + 90 s of stream equals a fresh snapshot,
entity by entity), verifies that the smaller ops still reproduce the server's state.

## Factory Floor cost (contract v0.5)

Groups, failure clusters, flakes and trends are derived from the same registers as every
other entity, but they read the whole fleet, so the reducer refreshes them **at most once a
second** (`ReducerCfg::insights_every_ms`) instead of on each 33 ms flush; trends move in
5-minute buckets.

| | Result | How |
|---|---|---|
| Ingest | **32.9 K pipeline events/s** (unchanged: the Factory Floor is off the hot path; recomputing it on every flush would cost 4.8 K/s) | `ingest/pipeline_events_flush64` |
| One Factory Floor refresh | **9.7 ms** on the fleet-sized bench store (≤ 1 % of a core at 1/s) | `insights/recompute_fleet` |
| Snapshot | **2.39 MB** raw, 0.49 MB gzip (sanitized fixture 2.14 MB): the new tables add 127 KB (5 %): 161 clusters 84 KB, 26 trends 34 KB, 28 flakes 7 KB, 25 groups 2 KB | recording `run7` (24.9 min, 764 frames) |
| Stream | **1.45 MB/h** raw, 0.13 MB/h gzip; the new kinds are 49 KB/h (3.4 %), mostly trend patches once per 5 minutes | same |
| `/history` for 1 h | **~3.8 MB** | base + frames |
| `GET /api/v1/insights` | 71 KB raw | live fleet |
| Upstream | Woodpecker step logs: one request per failed step, ever, ≤ 2.5/s (live failures first, then the boot backlog) | `/api/v1/meta` → `adapters[].requests` |

## Deployed server

The deployed server — platform LXC (2 cores / 2 GiB), `--profile ct` build,
live against every upstream (five orgs, ~390 repos, ~240 apps). Measured from a Linux dev box
through the platform edge (TLS, Caddy) with a read-only service token.

| What | Result | How |
|---|---|---|
| Push → live delta | commit `2f1c06b` pushed to this repo: the stream delivered its `push` + `enqueue` events and the pipeline/commit/repo upserts **3.7 s after `git push` returned** (9.9 s after the check started; the push began at +5.0 s and returned at +6.2 s) | `examples/e2e.rs <url> <sha>` started before the push |
| Snapshot | 1.2 MB raw / 186 KB gzip right after a restart (2.7 MB once closed + Dependabot PRs are backfilled); 225–270 ms end to end over the edge from the devbox | `examples/e2e.rs` |
| 200 WebSocket clients over the edge | 200/200 connected (connect p50 169 ms), 0 resets, 0 merged frames, lag p50 39 ms / p99 1.0 s (during the post-restart GitHub backfill: 21 KB average frames) | `wsload wss://…/api/v1/stream 200 45` |
| RSS | 41 MB at start, 72 MB with 200 clients during the GitHub backfill, **61 MB steady** after the full backfill (2.5 MB snapshot, 393 repos / 908 commits / 379 PRs / 238 apps; peak 80 MB) | `/api/v1/meta` → `process` |
| Upstream calls | independent of clients: Woodpecker 1 SSE stream + polls, GitHub ~200 GraphQL points/h, cicd 2 req/30 s, catalog 1 req/20 s | `/api/v1/meta` → `adapters[].requests` |

Re-run the live check any time:

```sh
SY_TOKEN=… cargo run --release --example e2e -- "$SWITCHYARD_URL"
```
