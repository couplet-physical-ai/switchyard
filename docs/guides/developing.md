# Develop Switchyard

Switchyard has a Rust server and an Exact client. The client toolchain is Bun 1.4.2 and the Exact revision pinned in `packaging/exact.pin`; use Cargo and the repository's Rust toolchain for the server.

## Set up and build the client

[`app/scripts/build.sh`](https://github.com/couplet-physical-ai/switchyard/blob/main/app/scripts/build.sh) wraps Exact's build and test commands. From the repository root:

```sh
app/scripts/build.sh web
```

To invoke the web build directly:

```sh
cd app
bun exact.mjs web-build
```

The web build writes a static client that the server can serve. The macOS app and its tests use the native Exact host; the macOS release workflow builds that target on GitHub's macOS runners.

## Run a local fleet

The mock server in [`app/server/mock.ts`](https://github.com/couplet-physical-ai/switchyard/blob/main/app/server/mock.ts) has two data sources. Without `--fixtures`, it runs a deterministic simulated demo fleet. To replay the sanitized wire fixtures, start it from `app/`:

```sh
cd app
bun server/mock.ts --fixtures ../contract/fixtures --frozen
```

`--fixtures` serves the fixture snapshot and loops its recorded frames. `--frozen` holds mock time still for deterministic tests. Omit `--frozen` to watch the fixture stream advance.

For a web build that must read a real server, [`app/tools/live-proxy.ts`](https://github.com/couplet-physical-ai/switchyard/blob/main/app/tools/live-proxy.ts) serves the web files and forwards API requests to the upstream server. Give it a local mode-`0600` token file; the proxy reads the value from the file and does not print it. Do not put a device token in a command argument or source file.

## Test the client

The Exact web suite runs `tests/*.test.contract` in headless Chromium. The build wrapper also runs the bounded boot-turn checks:

```sh
app/scripts/build.sh test web
```

From `app/`, the focused TypeScript and performance checks include:

```sh
bun tools/turns.ts demo --max 4
bun tools/turns.ts fixtures --max 4
bun tools/*.test.ts
```

The repository also has [`app/tools/now-e2e.mjs`](https://github.com/couplet-physical-ai/switchyard/blob/main/app/tools/now-e2e.mjs) for Live end-to-end checks and [`app/tools/yard-regress.mjs`](https://github.com/couplet-physical-ai/switchyard/blob/main/app/tools/yard-regress.mjs) for Yard regression checks. Run each tool with its documented arguments for the target being tested.

The mock has a self-test, and [`scripts/ci/validate_fixtures.py`](https://github.com/couplet-physical-ai/switchyard/blob/main/scripts/ci/validate_fixtures.py) validates the wire fixtures. The macOS app has its own native test suite; it runs on the macOS build host, not in the Linux web pipeline.

## Test the server

From `server/`, run the same checks as the Roadrunner server pipeline:

```sh
cargo fmt --all -- --check
cargo clippy --all-targets --locked -- -D warnings
cargo test --locked
cargo bench --locked --bench core -- --test
```

The formatting check, Clippy, tests, and Criterion smoke benchmark run when server or contract paths change. See [deploying](deploying.md) for the CI path filters.

## Public-repository checks

Before pushing a change, scan the repository for leaked credentials and prohibited public-repository data:

```sh
gitleaks dir . -c .gitleaks.toml
```

Follow the public-repository rules in [`CLAUDE.md`](https://github.com/couplet-physical-ai/switchyard/blob/main/CLAUDE.md): do not commit tokens, internal addresses or hostnames, or personal contact details. Use environment configuration for runtime-only endpoints and keep any local device-token file mode `0600`.

## Known mock-stream gotcha

An older mock returned 404 for the resumable token stream route `tstream`. That made a reconnecting client repeatedly reopen the stream; in paused Live the repeated activity looked like motion. The mock now serves that route. If a paused view appears busy only against a mock, check the mock's stream route before changing redraw logic. The history is recorded in pass 4 of [`app/PERF.md`](https://github.com/couplet-physical-ai/switchyard/blob/main/app/PERF.md).
