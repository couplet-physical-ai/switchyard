# Performance

Budgets (from the brief) and what we measured. Re-run the commands below on a release
build; numbers are from the machines named in each table.

| Budget | Result | How |
|---|---|---|
| `GET /api/v1/snapshot` p99 < 5 ms from memory | **p99 3.8 ms** at 16 concurrent clients, 31,850 req/s (p50 0.29 ms); **p99 1.0 ms** at 8 clients | `oha` against the server (gzip, 481 KiB per response) |
| Delta fan-out to 1,000 clients | **1,000 real WebSocket clients**: 0 failed, 0 resets, delivery lag p50 3 ms / p99 35 ms / max 59 ms at 6.3 frames/s/client (6,260 frames/s total) | `examples/wsload.rs` against `--demo --speed 10` |
| ≥ 20k events/s ingest | **47,400 pipeline events/s** through the reducer (apply + derive + diff + encode, flushing every 64 events) on a fleet-sized store | `cargo bench --bench core` → `ingest/pipeline_events_flush64` |
| RSS < 256 MB steady | live, all five orgs: see the deployed-server row below; locally **58 MB** after sync; demo + 1,000 WebSocket clients **190 MB** (212 MB peak) | `/proc/<pid>/status` VmRSS / VmHWM |
| Zero per-client upstream calls | by construction: adapters are the only upstream callers; one SSE connection + polls, independent of clients (see `docs/SOURCES.md`); `/api/v1/meta` → `adapters[].requests` | |

## Criterion (`cargo bench --bench core`)

Machine: **a Linux dev box** (AWS Graviton4, Neoverse V2, 16 vCPU, Linux aarch64), Rust 1.99.0,
release profile, other load present (load average ~2.5).

| Bench | Time | Throughput |
|---|---|---|
| `ingest/pipeline_events_flush64` (380 events) | 8.01 ms | **47.4 K events/s** |
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

## Deployed server

`switchyard.apps.example.com` (platform LXC, 2 cores / 2 GiB): see the table filled in at
deploy time below.
