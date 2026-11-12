# Server architecture

`switchyard-server` is the Rust service that reads upstream CI/CD state, maintains the fleet model, and serves snapshots, deltas, history, and queries. One adapter task reads each upstream; clients never trigger upstream polling.

## Runtime and adapters

The binary uses Tokio and Axum. In [`server/src/runtime.rs`](https://github.com/couplet-physical-ai/switchyard/blob/main/server/src/runtime.rs), adapters send fact batches to a single reducer task over a bounded channel. The reducer flushes dirty entities at up to 30 frames per second; encoded frames are shared by the hub across clients.

The crate module list is in [`server/src/lib.rs`](https://github.com/couplet-physical-ai/switchyard/blob/main/server/src/lib.rs). The main responsibilities are split across these modules:

| Modules | Responsibility |
|---|---|
| `adapters/`, `facts.rs` | Read upstreams and represent their observations as versioned facts. |
| `runtime.rs`, `store.rs` | Track adapter health, merge facts, derive entities, and reduce batches into frames. |
| `model.rs`, `wire.rs` | Define entity and frame types and convert snapshots and diffs. |
| `hub.rs`, `history.rs` | Fan out shared frames and retain checkpoints for replay. |
| `api.rs`, `auth.rs`, `logs.rs` | Serve the HTTP/WebSocket/SSE API, enforce read access, and fetch pipeline logs. |
| `ledger.rs`, `query.rs`, `record.rs`, `regroup.rs`, `signature.rs`, `traces.rs` | Build change/history views, search, replay records, historical grouping, failure signatures, and commit journeys. |
| `demo.rs`, `google.rs`, `links.rs` | Provide demo mode, SSO identity verification, and upstream deep links. |

| Adapter | What it reads | Cadence |
|---|---|---|
| Woodpecker / Roadrunner | A fleet-wide event stream carries pipeline, workflow, and step changes. Backfill and reconnect reconciliation recover recent and active runs. Queue and agent state and repository inventory are polled separately. | Stream updates are event-driven; reconciliation every 60 s; queue and agents every 5 s; repository inventory every 10 min. The default boot backfill covers 24 h. |
| GitHub | GraphQL supplies repositories, default-branch commits and checks, open pull requests, and GitHub Actions runs. | Recently pushed repository heads every 45 s for the primary organization and 90 s for others; updated pull requests every 60 s; all open human pull requests every 10 min; Dependabot pull requests every 30 min; quiet repository history hourly. |
| cicd | Roadrunner lanes and modes, deployment verdicts, outage/failover status, and Dagger engine hosts. | Every 30 s. |
| Apps catalog | App inventory, team, deployment, and health state in one catalog response. | Every 20 s. |

The Woodpecker, GitHub, cicd, and apps adapters are in [`server/src/adapters/`](https://github.com/couplet-physical-ai/switchyard/tree/main/server/src/adapters). A missing adapter credential disables that adapter; it does not make other sources depend on it.

## Facts, store, and reduction

The store in [`server/src/store.rs`](https://github.com/couplet-physical-ai/switchyard/blob/main/server/src/store.rs) keeps versioned fact registers, indexes, and the current derived wire entities. A fact's version is based on its source lifecycle or observation time, not when it arrived. Merging facts is order-independent, so duplicate delivery, replay, and a late backfill do not replace newer state merely because they arrived later. Dirty keys are re-derived and diffed into upserts, patches, removals, dot updates, and transient events.

Protocol 0.6 has these entity kinds: `org`, `repo`, `commit`, `pipeline`, `pr`, `deploy`, `app`, `engine`, `queue`, `lane`, `watcher`, `stats`, `group`, `cluster`, `flake`, and `trend`. The model definitions are in [`server/src/model.rs`](https://github.com/couplet-physical-ai/switchyard/blob/main/server/src/model.rs). The store retains base facts for 26 h; commits, pull requests, and deploys are visible for 24 h, while finished pipelines are visible for 2 h.

The reducer in [`server/src/runtime.rs`](https://github.com/couplet-physical-ai/switchyard/blob/main/server/src/runtime.rs) applies each fact batch, derives changed entities, then publishes the resulting frame. Event operations follow the state operations in their frame, so a client handling an event sees the world that event produced. Backfills and late reconciliations update state without replaying old motion events.

For a pull request, the server replaces a matching Roadrunner workflow status from GitHub's potentially lagging check rollup with the workflow state from the highest-numbered Roadrunner pipeline for that head. An active Roadrunner run takes precedence over the settled rollup. This is the “newest run wins” rule in [`server/src/store.rs`](https://github.com/couplet-physical-ai/switchyard/blob/main/server/src/store.rs).

## Snapshot, stream, and sequence

`GET /api/v1/snapshot` returns the current fleet. WebSocket `/api/v1/stream` and the SSE fallback `/api/v1/stream/sse` carry delta frames. A client can resume from a sequence number; the server replays retained frames when possible. Sequence numbers increase with frames, and clients apply only frames newer than their current state. Slow clients receive merged frames; if a client falls behind the bounded stream ring, or asks to resume before retained history, the server sends a reset. The client discards its projection and fetches a snapshot.

The hub and HTTP surface are implemented in [`server/src/hub.rs`](https://github.com/couplet-physical-ai/switchyard/blob/main/server/src/hub.rs) and [`server/src/api.rs`](https://github.com/couplet-physical-ai/switchyard/blob/main/server/src/api.rs). The complete message shapes and replay rules are in the [wire contract](../reference/contract.md).

## History and replay

The live service keeps disk-backed history; demo mode uses in-memory history. [`server/src/history.rs`](https://github.com/couplet-physical-ai/switchyard/blob/main/server/src/history.rs) records frames and periodic snapshot checkpoints every 5 min. It retains about 25 h so clients can replay up to the latest 24 h. `GET /api/v1/history?from=<ms>&to=<ms>` returns a base snapshot and the frames needed to rebuild a window; one request is limited to 3 h. A restart is represented as a history discontinuity and replay base, rather than pretending that sequence numbers continue across processes.

## Pipeline logs

`GET /api/v1/pipeline/{id}/log?step=<name>` fetches a step log on demand from Woodpecker or GitHub Actions. The default tail is 200 lines; the maximum is 500. For a failed step, `around=decisive` returns up to 40 lines on either side of the decisive failure line. Responses are bounded and redacted, cached briefly while a step runs and longer after it finishes, and at most four upstream log reads run concurrently. See [`server/src/logs.rs`](https://github.com/couplet-physical-ai/switchyard/blob/main/server/src/logs.rs).

## Metadata and warm boot

`GET /api/v1/meta` reports the protocol and server `git_sha`, current sequence and counts, adapter health, and web build information. `web.sha` identifies the commit that built the served web files; `web.tree` identifies the `app/` tree. Adapter entries include state, last success, lag, and backfill/sync status.

After a restart, the server serves the last state recorded in history (when it is less than 2 h old) while adapters rebuild the in-memory store. `meta.booting` is `true` during this warm boot. When the adapters settle, the server publishes the difference to the rebuilt fleet in one delta. This avoids showing a half-empty fleet during backfill. A typical rebuild takes about six minutes; the runtime also has a 10-minute settle ceiling. The behavior was introduced in commit [`7a65ca7`](https://github.com/couplet-physical-ai/switchyard/commit/7a65ca7).

During the boot only the half-built fleet's churn is held. These go out at once, as whole entities applied to the warm state:

- live event operations;
- pipelines the last state holds, and pipelines running now;
- running deploys, engines, and the queue.

Removals go out only for runs the last state holds. Repositories, commits, and derived views wait for the settle. The served `/api/v1/snapshot` is the last state plus what went out, rebuilt as the sequence moves, so a client that connects or refetches mid-boot sees a finished run as finished. Before [`9bb1679`](https://github.com/couplet-physical-ai/switchyard/commit/9bb1679) and [`03a3e12`](https://github.com/couplet-physical-ai/switchyard/commit/03a3e12), every entity change was held until the settle, so a run that finished during a deploy's warm boot showed as running for 8–20 minutes ([post-mortem](../reports/incidents/2026-11-12-phantom-and-stale-data.md)).

The hub records the sequence it started numbering after (the restored history's last, `boot_seq`). A client resuming at or before it saw another process's frames, which this process never diffed against, so it gets a reset and refetches the snapshot ([`a65ad31`](https://github.com/couplet-physical-ai/switchyard/commit/a65ad31)). The client checks the same thing from its side: a stream reopened after a drop compares the server's `epoch` in `/api/v1/meta` with the one its fleet came from.

## Authentication

The web client uses the platform's single sign-on session. The macOS client and authorized tools use a read-only device token created on the SSO-gated `/connect` page; tokens can be revoked. The native stream has a token-aware route for WebSocket clients that cannot attach browser credentials. Local demo and development modes can run without authentication. No credential values belong in documentation, logs, or source examples.
