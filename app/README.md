# Switchyard client (`app/`)

The Switchyard client: Exowatt's whole delivery system as one living schematic, on the web
and macOS, built with [Exact](https://github.com/expo/exact) at the commit in `exact.pin`.
Design: [DESIGN.md](DESIGN.md). Performance: [PERF.md](PERF.md).

![The yard](screenshots/yard-web.png)

## Build and run

Exact has no releases: an app builds against a checkout of it. `app/exact.mjs` finds it
through **`$EXACT2`** (the path of an expo/exact checkout; without it, `../../../exact`).
`scripts/fetch-exact.sh` makes one: it clones expo/exact at the commit in **`exact.pin`**
(`316d1f292f92f91a223d2f582e80fe17979c12c1`, the same as `packaging/exact.pin`) into
`${XDG_CACHE_HOME:-~/.cache}/switchyard/exact-<pin>` (or `$EXACT2`), runs `bun install` and
`bun scripts/exact.mjs setup` once, and prints the path last. Every `scripts/build.sh` verb
calls it when `EXACT2` is unset. **Bun 1.4.2 exactly** (Exact checks).

| What | Command (from the repo root) | Output |
|---|---|---|
| web build (headless, Linux) | `app/scripts/build.sh web <OUTDIR>` = `cd app && bun exact.mjs web-build --out <OUTDIR>` | static files in `<OUTDIR>` (default `app/dist`): `index.html` (= `shell.html`), `app.js`, `app.plan`, `style.css`, chunks, `assets/`, `routes.json` |
| web tests (headless Chromium, CI) | `app/scripts/build.sh test web` = `cd app && bun exact.mjs test web 'tests/*.test.contract' --size 1440x900` | exit 1 on a failure |
| macOS release app | `app/scripts/build-macos-release.sh` (= `bun exact.mjs mac --release`, ad-hoc signed; `SWITCHYARD_MAC_FLAGS` overrides) | prints the path last: `app/target/clients/<hash>/com.exowatt.switchyard/macos/Switchyard.app` |
| macOS tests | `app/scripts/build.sh test macos` | |
| mock API selftest | `bun app/server/selftest.ts` | 50 checks |
| dev loop | `cd app && bun exact.mjs web` | reloads on save |

The tests run on the built-in demo fleet (no network). A cold macOS release build takes
about 4 minutes on an M-series Mac mini (cargo ~190 s, swift ~45 s).

The server serves the web build from the same origin (`switchyard-server --static-dir
<OUTDIR>`): with no server set, the client reads `/api/v1/snapshot` and
`ws(s)://<origin>/api/v1/stream` of the page's own origin. On macOS it asks for a server URL
and a token (kept in the Keychain) in the connection sheet, or takes a
`switchyard://connect?server=…&token=…` link.

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
