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

## Updates (macOS)

The Mac app keeps itself current, like Copper. `modules/apple/Updater.swift` is a native module:

- **When it checks.** An installed copy checks by itself about 10 s after launch, then every
  6 h, on a background queue. Installed means it lives in `/Applications` or `~/Applications`,
  its folder is writable, and it is not running under the Exact agent. Dev builds
  (`target/clients/…`) never check by themselves. **Switchyard ▸ Check for Updates…** (the app
  menu) checks at any time, and a slim pill reports the result: *up to date*, *Downloading
  0.1.1 · 42%*, or *Update failed: …*.
- **The feed.** GitHub releases of `couplet-physical-ai/switchyard`, read through the API.
  `app.json` `moduleConfig.updater.repo` overrides the repo. The updater takes the highest
  semver among non-draft releases that carry `Switchyard-<v>-arm64.zip` and `SHA256SUMS`.
  When the API rate-limits it (403/429), it falls back to
  `releases/latest/download/SHA256SUMS`.
- **Download and verify.** A newer release downloads in the background. Then the updater
  checks all of these before it accepts the update:
  - the zip's SHA-256 matches its `SHA256SUMS` line;
  - `ditto -x -k` unpacks it into a staging folder on the same volume as the app;
  - the bundle id matches this app's, and `CFBundleShortVersionString` matches the release;
  - `codesign --verify --deep --strict` passes;
  - the quarantine flag is removed.
- **Install.** The pill then says *Switchyard 0.1.1 is ready · Restart to update*. Its *notes*
  show the release body (the first ~1,500 characters) as plain text. Pressing the pill swaps
  the bundle in place with `FileManager.replaceItemAt`, an atomic same-volume exchange, and
  relaunches into the new version. A failed swap leaves the old app as it was.
- **Log.** It writes to `~/Library/Logs/Switchyard/updater.log`, and to stdout.
- **Web.** There is no updater on the web (the server serves the newest web build), and
  nothing shows.

**Pre-release channel.** Pre-releases are skipped unless you turn the channel on with
`defaults write com.exowatt.switchyard SwitchyardUpdatePrerelease -bool true`, or the env
`SWITCHYARD_UPDATE_PRERELEASE=1`.

**Release requirements.** Each release must stamp its version into `Info.plist` and
re-sign; the version check refuses a zip whose version differs from its tag. **The Homebrew
cask must declare `auto_updates true`**, so `brew upgrade` leaves the self-updated app alone
and Homebrew does not fight the updater.

**End-to-end test (a real Mac, outside the agent):**

```sh
app/tools/updater-e2e.sh <path to a release Switchyard.app> 0.0.2
```

The script installs a copy at `~/Applications`, stamped to an old version and re-signed.
It launches the copy with `SWITCHYARD_UPDATE_PRERELEASE=1` and
`SWITCHYARD_UPDATE_AUTOINSTALL=1`. Once the update is ready, the Contract installs and
relaunches it. The script then prints the log, the versions, and the process now running,
and removes the copy. `FEED=<base URL>` points the run at a test feed instead
(`SWITCHYARD_UPDATE_FEED`, read only from the environment).

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
| `modules/apple/Updater.swift`, `views/update.contract`, `src/update.ts` | the macOS updater ("Updates" above) |
| `tools/` | `webperf.mjs` (frame pacing in Chromium), `mini-sync.sh` (copy to the Mac mini), `updater-e2e.sh` |
