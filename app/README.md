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

The Mac app keeps itself current, the way Copper does. Copper's `Search/Updater.swift` is the
model: a small JSON file next to the download, a ZIP that is fetched, checked and put where the
bundle is, and nothing that relaunches on its own. The code is in `modules/apple/`:

- `UpdaterCore.swift`: the pure logic (versions, the feed, the host allowlist, the verify chain,
  the swap). It has no Exact in it.
- `Updater.swift`: the module, the timer, the network and the state.

**When it checks.** An installed copy checks by itself, on a background queue: about 10 s after
launch, then every 6 h. *Installed* means all three of these:

- it lives in `/Applications` or `~/Applications`;
- that folder is writable;
- it is not running under the Exact agent.

Dev builds (`target/clients/…`) never check by themselves. A manual check works anywhere and
reports its result: **Switchyard ▸ Check for Updates…** (the app menu), or **Check for updates**
in the Settings sheet's UPDATES section.

**The feed.** The primary feed is `latest.json`, a release asset that `scripts/release/latest-json.py`
publishes on every stable release:

```
https://github.com/couplet-physical-ai/switchyard/releases/latest/download/latest.json
```

```json
{"version": "0.1.1",
 "url": "https://github.com/couplet-physical-ai/switchyard/releases/download/v0.1.1/Switchyard-0.1.1-arm64.zip",
 "sha256": "<hex of the zip>",
 "notes": "…",
 "published": "<ISO-8601>"}
```

- **Required fields:** `version` (semver; a leading `v` is allowed), `url` and `sha256`
  (64 hex digits).
- **Optional fields:** `notes` and `published` are shown when present.
- **Checked when present:** `bundleId` (must be `com.exowatt.switchyard`) and
  `minimumSystemVersion` (a release that needs a newer macOS is not offered).
- **Ignored:** `build`, `dmg` and `commit`.

If `latest.json` is missing or cannot be read, the updater falls back to the releases API
(`api.github.com/repos/…/releases`). From there it takes the highest non-draft release that
carries both `Switchyard-<v>-arm64.zip` and `SHA256SUMS`, and the sum is that file's line for
the zip. If the API rate-limits it (403/429), it reads `releases/latest/download/SHA256SUMS`
instead. `app.json` `moduleConfig.updater.repo` overrides the repo.

**Host allowlist.** The feed must be https. A zip is fetched only from:

- `github.com`
- `objects.githubusercontent.com`
- `release-assets.githubusercontent.com`

The same rule applies to every redirect hop on the way: a `URLSession` redirect delegate checks
each one (GitHub redirects downloads to its asset hosts). The API request may also redirect
within `api.github.com`. Anything else, or plain http, is refused.

**The verify chain.** A newer version downloads in the background, into a staging folder on the
app's volume (Copper's `itemReplacementDirectory`). Before that, the updater checks that the
app's folder is writable and that staging is on the same volume. The download is accepted only
if all of these hold, in this order:

1. The zip's SHA-256 equals the feed's `sha256` (or its `SHA256SUMS` line). A mismatch runs
   no tool.
2. `/usr/bin/ditto -x -k` unpacks it, and the zip holds exactly one `.app`.
3. Its `CFBundleIdentifier` is `com.exowatt.switchyard`, the running bundle's id.
4. Its `CFBundleShortVersionString` equals the feed's version and is strictly newer than the
   running one.
5. `codesign --verify --deep --strict` passes. If the running copy carries a Team ID, the new
   one must carry the same. Releases are signed ad hoc, so today they carry none.
6. The quarantine flag is removed, and the updater checks that it is gone.

**Install: Copper's `Swap`.** The pill then reads *Update ready · Relaunch to update*. The same
button appears in Settings. Pressing it does two sibling renames with `rename(2)`, so it never
copies:

1. `Switchyard.app` → `Switchyard.app.old`
2. the staged bundle → `Switchyard.app`

If the second rename fails, the first is undone. The Contract then calls `relaunch()`. The old
process runs from `.old` until it exits.

The next launch, before its first check, removes what an update left:

- the `.old` bundle, and only if it is this app;
- the staging folders that this copy recorded, with their downloads.

The updater never relaunches on its own. It never touches the settings, the token in the
Keychain, or `~/Library/Application Support`.

**The pill and Settings.**

- **The pill** sits above the status line, in the web-reload pill's slot. It reads
  *Update available · v0.1.1* (a copy that cannot install itself), then
  *Downloading v0.1.1 · 42%*, then *Update ready · Relaunch to update*.
- **Failures** read *Update failed: <reason>*, quietly. An automatic check that cannot reach
  the feed shows nothing.
- **Settings ▸ UPDATES** shows *Switchyard <version>*, a status line (checking / downloading %
  / ready / failed / up to date), **Check for updates**, and, when an update is ready,
  **Relaunch to update**.
- **Log:** `~/Library/Logs/Switchyard/updater.log`, and stdout.
- **Web:** there is no updater on the web (`views/webreload.contract` offers a reload instead),
  and none of this shows.

**Pre-release channel.** Pre-releases are skipped unless the channel is on. Turn it on with
`defaults write com.exowatt.switchyard SwitchyardUpdatePrerelease -bool true`, or the env
`SWITCHYARD_UPDATE_PRERELEASE=1`. The channel reads the releases API (pre-releases do not move
`releases/latest`), with the same allowlist and verify chain.

**Test hooks (env only, never a setting).**

- `SWITCHYARD_UPDATE_FEED=<base URL>` reads `<base>/latest.json` instead of GitHub. It must be
  https, or plain `http://127.0.0.1:<port>`. That origin may also serve the zip.
- `SWITCHYARD_UPDATE_AUTOINSTALL=1` presses *Relaunch to update* as soon as an update is ready
  (installed copies only).
- Under the Exact agent, the updater never touches the network. An in-process stub feed
  (`SYStubFeed`) answers instead. Its first check is up to date, its second is a checksum
  failure, and its third is a ready 9.9.9 (a minimal ad-hoc-signed bundle that passes the whole
  chain). `tests/update.test.contract` walks through these on macOS.

**Homebrew.** The cask must declare **`auto_updates true`**. Then `brew upgrade` leaves the
self-updated app alone and does not fight the updater.

**Tests.**

```sh
app/tools/updater-tests.sh                 # native unit tests (on a Mac; MINI=user@host from elsewhere)
app/tools/updater-e2e.sh <Switchyard.app>  # end to end on a Mac, outside the agent
```

- `updater-tests.sh` compiles `UpdaterCore.swift` + `UpdaterTests.swift` with `swiftc`. It
  covers version compare, latest.json/SHA256SUMS/API parsing, the host allowlist, the verify
  chain (bad sum, corrupt zip, wrong id, not newer, tampered signature, quarantine) and the
  swap with an injected rename failure.
- `updater-e2e.sh`:
  1. Stamps two re-signed copies, 0.0.2 and 0.0.3.
  2. Serves the 0.0.3 zip and its `latest.json` on 127.0.0.1.
  3. Shows that the installed 0.0.2 finds it, downloads it, verifies it and is ready.
  4. With the AUTOINSTALL hook, shows that it swaps and relaunches as 0.0.3, and that the new
     process sweeps the `.old`.
  5. Quits only the pids it started, and removes the copy.

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
| `modules/apple/Updater*.swift`, `views/update.contract`, `src/update.ts` | the macOS updater ("Updates" above) |
| `tools/` | `webperf.mjs` (frame pacing in Chromium), `mini-sync.sh` (copy to the Mac mini), `updater-tests.sh`, `updater-e2e.sh` |
