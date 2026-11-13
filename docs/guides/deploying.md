# Deploy and operate Switchyard

GitHub Actions builds and checks this repository; it does not deploy the service. A deployment lives outside this public repository: it pins a Switchyard revision, supplies the site's configuration, and rolls out the server and web build together.

## CI in this repository

The workflows in [`.github/workflows/`](https://github.com/couplet-physical-ai/switchyard/tree/main/.github/workflows) run on GitHub-hosted runners and are path-filtered. Check them with `gh run list`, `gh run watch` and `gh run view --log-failed`:

| Workflow | Trigger paths | Checks |
|---|---|---|
| [`server.yml`](https://github.com/couplet-physical-ai/switchyard/blob/main/.github/workflows/server.yml) | `server/**`, `contract/**` | Rust formatting, Clippy with warnings denied, tests, and a Criterion benchmark smoke run. |
| [`client.yml`](https://github.com/couplet-physical-ai/switchyard/blob/main/.github/workflows/client.yml) | `app/**`, `contract/**` | Exact web build, `*.test.contract` suites in headless Chromium, and the mock-server self-test. |
| [`contract.yml`](https://github.com/couplet-physical-ai/switchyard/blob/main/.github/workflows/contract.yml) | `contract/**`, `scripts/ci/**` | Fixture validation against the wire contract. |
| [`security.yml`](https://github.com/couplet-physical-ai/switchyard/blob/main/.github/workflows/security.yml) | Every pull request and push to `main` | `scripts/check-no-internal.sh` (no internal hosts, private orgs or private addresses in any tracked file), Gitleaks, and an OSV dependency scan. |
| [`dco.yml`](https://github.com/couplet-physical-ai/switchyard/blob/main/.github/workflows/dco.yml) | Every pull request | Every commit is signed off. |

## Configuration

Everything site-specific is runtime configuration, never source. The server reads it from the environment; [`server/.env.example`](https://github.com/couplet-physical-ai/switchyard/blob/main/server/.env.example) lists every key with neutral placeholders:

| Key | What |
|---|---|
| `SWITCHYARD_ORGS` | GitHub orgs to watch, in display order |
| `WOODPECKER_URL`, `WOODPECKER_PUBLIC_URL` | Woodpecker API and the web UI links open |
| `CICD_URL`, `CICD_ENGINE_HOST` | the Roadrunner console and the machine its `/engine` page shows |
| `APPS_CATALOG_URL` | the apps platform's catalog |
| `SWITCHYARD_BOT_LOGINS` | the site's own bots whose logins carry no bot mark |
| `SWITCHYARD_PUBLIC_URL`, `SWITCHYARD_EMAIL_DOMAINS` | the public base URL and who may sign in |
| `WOODPECKER_TOKEN`, `GITHUB_TOKEN`, `CICD_READ_TOKEN`, `SWITCHYARD_SERVICE_TOKENS` | secrets, from the platform's secret store |

An unset key turns off the adapter that needs it: `GET /api/v1/meta` lists each adapter's state with the missing key as its note, links built on an unset base are empty, and the boot log names every missing key. For a local run, copy the example to `server/.env` (ignored by git) and start the server with `SWITCHYARD_ENV_FILE=.env`.

The macOS release reads the default server and the org order from repository secrets (`SWITCHYARD_DEFAULT_SERVER`, `SWITCHYARD_ORGS`); see [Releasing](releasing.md). A web build takes the org order from `SWITCHYARD_ORGS` in its environment, like the server.

## Service deployment

The deployment pins a commit of this repository, builds the Rust server and Exact web client from that revision with the site's configuration, rolls out the service, and verifies it. Its pipeline and configuration are separate from this repository's checks.

After rollout, request `GET /api/v1/meta` through an authorized session and compare the reported build metadata with the pinned revision:

- `git_sha` identifies the running server build.
- `web.sha` identifies the source revision recorded by the served web build.
- `web.tree` identifies the `app/` source tree used for that web build. A server-only deployment can change `git_sha` without changing `web.tree`.

Then run the live end-to-end checks against the deployed service. Confirm that a client can connect, receives live updates, and can load the current web client. The development guide lists the client e2e tools.

## Restarts and warm boot

After a process restart, the server loads the last recorded fleet state and serves it while upstream adapters rebuild the in-memory store. During this period `GET /api/v1/meta` reports `booting: true`. A normal rebuild takes about six minutes; counts remain at the last known state rather than falling to a partial backfill. Runs, running deploys, engines, and the queue keep updating during the boot, so a run that finishes then shows finished within seconds. When the adapters settle, the server publishes the difference to the rebuilt state in one delta and clears `booting`.

Every deploy restarts the server, so every connected client is reset once: a client that resumes the stream at or before the sequence the new process started from (`boot_seq`) gets a reset and refetches the snapshot. Clients reconnect on their own; a brief "catching up" after a deploy is expected. Time deploys away from a macOS release soak, which measures a client connected to the live server.

Do not treat `booting: true` by itself as a failed deployment. Check adapter status in `meta`, allow the startup backfill to settle, and confirm that `booting` clears. A failed or degraded adapter should be investigated separately from the service rollout.

## Rollback

To roll back, deploy a previously verified Switchyard commit through the same deployment pipeline. Verify `git_sha`, `web.sha`, and `web.tree` again; they should describe the older pinned build. Keep the same warm-boot behavior in mind after the rollback restart.

## Operational gotchas

- A passing CI run is not a deployment. Watch the separate deployment pipeline for rollout and verification.
- Path filters prevent unrelated builds: a client-only change does not rebuild the Rust server, while a `contract/` change affects server, client, and contract validation.
- During warm boot, compare metadata and adapter status rather than interpreting a temporary change in the state display as a completed deployment.
- A run shown as running long after it finished, or a pipeline waiting with nothing behind it, is a bug, not warm-boot behavior: compare `/api/v1/snapshot` with the upstream. The [stale-data post-mortem](../reports/incidents/2026-11-12-phantom-and-stale-data.md) lists the causes found so far.
