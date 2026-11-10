# Switchyard client (`app/`)

The Switchyard client: Exowatt's whole delivery system as one living schematic, on the web
and macOS, built with [Exact](https://github.com/expo/exact) at the commit in `exact.pin`.
Design: [DESIGN.md](DESIGN.md). Performance: [PERF.md](PERF.md).

![The yard](screenshots/yard-web.png)

## Build and run

Exact has no releases: an app builds against a checkout of it. `scripts/fetch-exact.sh`
clones expo/exact at `exact.pin` (into `~/.cache/switchyard/`, or `$EXACT2`) and runs its
`setup` once. Bun 1.4.2 is required (Exact checks).

| What | Command | Output |
|---|---|---|
| web build | `app/scripts/build.sh web [outdir]` | static files in `app/dist` (`shell.html`, `app.js`, `app.plan`, …) |
| macOS app | `app/scripts/build.sh mac` | prints the `Switchyard.app` path (under `app/target/clients/…/macos/`) |
| tests | `app/scripts/build.sh test web` · `app/scripts/build.sh test macos` | `tests/*.test.contract` at 1440×900 |
| dev loop | `cd app && bun exact.mjs web` | reloads on save |

The server serves the web build from the same origin: any path that is not `/api/…` and is
not a file in the build answers `shell.html`. On the web the client talks to the page's own
origin; on macOS it asks for a server URL and a token (kept in the Keychain) in the
connection sheet, or takes a `switchyard://connect?server=…&token=…` link.

### Without a server

**Watch the demo** (on the setup screen or in the connection sheet) runs a seeded
simulation of the fleet inside the app: ~410 repos in five orgs, engines, queues, PRs,
deploys and app health. The same simulation runs as a standalone mock of the API:

```sh
bun app/server/mock.ts --port 4790          # live; --frozen, --rate 10, --burst, --fixtures <dir>
bun app/server/selftest.ts                  # 50 checks: shapes, determinism, history, WS, SSE, auth
```

## Layout

| Path | What |
|---|---|
| `app.contract`, `views/*.contract` | the views (Contract): chrome, Mainlines, PRs, Fleet, Journey, ⌘K, settings |
| `app.ts` | the data module: sources Contract asks, and the canvases' `draw` |
| `src/world.ts` | the fleet as Maps, applying wire frames |
| `src/timeline.ts` | LIVE / Pause / 1× / ¼× / the hour replay |
| `src/yard/*` | the yard: layout, motion (packets), the two canvas layers |
| `src/project.ts` | what each view reads |
| `src/wire.ts` | the wire contract (`../contract/CONTRACT.md`) in TypeScript |
| `server/` | the deterministic simulation and mock server |
| `tests/` | `*.test.contract` suites (web and macOS) |
| `tools/` | `webperf.mjs` (frame pacing in Chromium), `mini-sync.sh` (copy to the Mac mini) |
