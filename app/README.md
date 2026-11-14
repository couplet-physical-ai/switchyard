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
and a token (kept in a file only you can read, "Security" below) in the connection sheet, or takes a
`switchyard://connect?server=…&token=…` link.

### Exact patches

Our native builds use a patched Exact. `scripts/exact-patches/*.patch` (applied in name order
to the checkout at `exact.pin`) is the whole set; today there are five:

- `0001-heap-512m.patch`: `exact_js::DEFAULT_MAX_HEAP` (`js/src/lib.rs`) 64 MiB → 512 MiB, the
  Hermes heap ceiling of the data module (app.ts). Exact has no app-level setting for it (only
  a host crate's `Module::set_max_heap`, and ours is generated), and Hermes's out-of-memory
  is fatal (`hermes_fatal`), so the 0.1.3/0.1.4 macOS app died at 64 MiB.
- `0002-recorder-no-per-frame-buffers.patch`: the native canvas seam (`canvas/recorder.js`)
  reuses each canvas's list buffer and base64s into one reused buffer (no per-frame garbage).
- `0003-recorder-font-parse-kept.patch` (after 0002): the same recorder parses each font
  string and quotes each family once, not on every `ctx.font =` and every text's measure.
  The lists are byte-identical (PERF.md, pass 5).
- `0004-recorder-roundrect-one-radius.patch` (after 0003): the recorder's `roundRect` with one
  radius and a size that is not negative records the same ops without the ~70 arrays it made
  per rectangle (byte-identical; less garbage for Hermes to collect).
- `0005-mac-text-pass-touched-only.patch` (macOS host only): after a batch that only gives text
  new words (a running timer's second), the Mac presenter's text pass asks only of the paragraphs
  that batch touched, when nothing else moved, scrolled or is owed, instead of rebuilding its
  index and walking every paragraph near the viewport (30 % of Live's idle CPU; PERF.md, pass 7).

`scripts/patch-exact.sh <exact dir>` applies them to a checkout's working tree (HEAD stays at
the pin). `scripts/fetch-exact.sh` calls it after checkout and before setup, into
`exact-<pin>-p<patches hash>`, so a patched checkout never shares a directory with the plain
pin; the release paths (GitHub Actions and the mini fallback, `scripts/release/`) call it right
after their own checkout. With an `$EXACT2` of your own, run it once yourself. The web build is
unaffected (the browser runs its own JS). Applying is idempotent and loud: a patch that is
already in is skipped, one that neither applies nor is in exits 1. After
an `exact.pin` bump, refresh each patch against the new pin (`git -C $EXACT2 diff > …`).
To undo one in a checkout: `git -C $EXACT2 apply -R app/scripts/exact-patches/<patch>`.

### Without a server

**Watch the demo** (on the setup screen or in the connection sheet) runs a seeded
simulation of the fleet inside the app: ~410 repos in five orgs, engines, queues, PRs,
deploys and app health. The same simulation runs as a standalone mock of the API:

```sh
bun app/server/mock.ts --port 4790          # live; --frozen, --rate 10, --burst, --fixtures <dir>
bun app/server/selftest.ts                  # 50 checks: shapes, determinism, history, WS, SSE, auth
```

## Security and install: where the token lives

Switchyard keeps one secret, the read-only device token the server's `/connect` page mints. It
keeps it readable by your own macOS user's processes, the way `gh` keeps its token:

- **macOS:** `~/Library/Application Support/com.exowatt.switchyard/token`, mode `0600`, in a
  folder of mode `0700`, written atomically (a `0600` temp file, then a rename). Any process
  running as you can read it; other users cannot. `modules/apple/Keychain.swift` keeps it.
- **Web:** the page's `localStorage` under `exact.secret.switchyard.token` (the key Exact used, so
  a page's token carries over), this origin only (`modules/web/index.js`). With no server set the
  page uses its own origin's sign-in and needs no token.

**Why not the Keychain.** Exowatt builds have no Apple Developer ID. Without a Team ID, a Keychain
item's partition is the CDHash of the build that made it, so every update asked again, and 0.1.2
blocked its launch on that prompt with no window. An "any application" access list does not help:
we tried it on a Mac, and the partition still prompts. With a Developer ID we would tighten this
(a Keychain item whose partition is our Team ID).

**From 0.1.2 and earlier.** Those builds kept the token in the Keychain (a generic password,
service `com.exowatt.switchyard`, account `switchyard.token`). The first launch with no token file
reads that item once, with its window already up; macOS may ask once whether Switchyard may read
it, and the floor says *Waiting for Keychain access…* meanwhile. Allow, and the token moves to the
file and `migrated` (`0600`, beside it) is marked: it is checked before any Keychain call, so
the app never reads the Keychain again, and later updates never ask. Deny, and the card offers
**Try again** and **Enter token**. Nothing at boot waits on the token, and the demo and the page's
own server never do.

The app then deletes the old item (a delete never asks). On a Mac, a newer ad-hoc build deleted
the item an older Switchyard build made, but macOS refused the delete of one another app had made
(`errSecInvalidOwnerEdit`, at once, with no prompt), so the item may stay, unread. (While macOS's
prompt is up, every Keychain call of the app waits behind it, so the delete runs once the prompt is
answered or dismissed; a save never waits for it.) When the delete fails, Switchyard remembers
that (`keychain-left`, beside the token), logs it once
to `~/Library/Logs/Switchyard/switchyard.log`, and Settings shows, under **Security**:

> An old Switchyard token remains in your login Keychain; remove it in Keychain Access → search
> 'switchyard'.

(Keychain Access lists it as `com.exowatt.switchyard`, account `switchyard.token`.) The note goes
once a delete succeeds. **Forget token** in Settings signs out: it deletes the token file and tries
the item's delete again (never a read); `migrated` stays.

The token is never in a Contract value or argument, Exact's kept answers (`kv/exact.kept`), a
persisted state, argv or a log line. Contract sees `tok` as `{has, ver, status, detail, left}`, `ver` an
8-character hash. It travels only as `Authorization: Bearer`, and as the stream's `?token=` (a
WebSocket carries no header).

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

**The feed.** The primary feed is `latest.json`, a release asset that sy-ship
(`scripts/release/latest-json.py`) publishes on every release. The stable address names the
newest non-prerelease:

```
https://github.com/couplet-physical-ai/switchyard/releases/latest/download/latest.json
```

```json
{"version": "0.1.1", "build": 1001,
 "url": "https://github.com/couplet-physical-ai/switchyard/releases/download/v0.1.1/Switchyard-0.1.1-arm64.zip",
 "dmg": "https://github.com/couplet-physical-ai/switchyard/releases/download/v0.1.1/Switchyard-0.1.1-arm64.dmg",
 "sha256": "<hex of the zip>", "notes": "…", "published": "<ISO-8601>",
 "minimumSystemVersion": "14.0", "bundleId": "com.exowatt.switchyard", "commit": "<sha>"}
```

- **Required fields:** `version` (a leading `v` is allowed), `build`, `url`, `sha256` (64 hex
  digits), and `bundleId`, which must equal this app's.
- **Shown:** `notes` and `published`.
- **Checked:** `minimumSystemVersion`. An update that needs a newer macOS is refused politely:
  *Switchyard 0.1.1 needs macOS 15.0 or later*.
- **Ignored:** `dmg`, `commit`, and any unknown field.
- **"Newer" means the build.** `build` is `CFBundleVersion`, M×1000000 + m×1000 + p (0.1.0 →
  1000, 0.1.1 → 1001). The feed's `build` must be greater than the running copy's
  `CFBundleVersion`.

If `latest.json` is missing or cannot be read, the updater falls back to the releases API.
There it takes the highest non-draft release that carries `Switchyard-<v>-arm64.zip` and reads
that release's own `latest.json` (or, without one, its `SHA256SUMS` line, with the build
computed from the version). If the API rate-limits it (403/429), it reads
`releases/latest/download/SHA256SUMS` instead. `app.json` `moduleConfig.updater.repo`
overrides the repo.

**Trust anchor and host allowlist.** Releases are signed ad hoc, so there is no Team ID to pin
(see *Certificate pinning* below for copies signed with a certificate). Trust rests on these
instead:

- the feed is https only;
- the zip URL is on `https://github.com/couplet-physical-ai/switchyard/releases/…`;
- every redirect hop goes only to `objects.githubusercontent.com` or
  `release-assets.githubusercontent.com` (GitHub's release CDN), or stays within the repo's
  releases. A `URLSession` redirect delegate checks each hop. The API request may also move
  within its repo on `api.github.com`.

Another host, another repo's path, or plain http is refused.

**The verify chain.** A newer build downloads in the background, into a staging folder on the
app's volume (Copper's `itemReplacementDirectory`). Before anything is fetched, the updater
checks that the app's folder and the bundle can be renamed, and that staging is on the same
volume. The download is accepted only if all of these hold, in this order:

1. The zip's SHA-256 equals `latest.json` `sha256` (or its `SHA256SUMS` line). A mismatch runs
   no tool.
2. `/usr/bin/ditto -x -k` unpacks exactly one `Switchyard.app`. The zip is made with `ditto -c -k
   --sequesterRsrc --keepParent`.
3. Its `CFBundleIdentifier` is `com.exowatt.switchyard`: the running app's id, and the feed's
   `bundleId`.
4. `CFBundleShortVersionString` equals `version`, `CFBundleVersion` equals `build`, and that
   build is greater than the running one.
5. `SecStaticCodeCheckValidity` passes with `kSecCSStrictValidate | kSecCSCheckAllArchitectures
   | kSecCSCheckNestedCode`, and so does `codesign --verify --deep --strict`. The cdhash
   (`kSecCodeInfoUnique`) is logged.
6. Any quarantine flag is removed (URLSession downloads carry none).
7. The pin (below).

**Certificate pinning.** The pin is off unless the running copy is signed with a certificate.
All releases today are ad hoc, so for them it does nothing. The launch line logs
`pin: off (running ad-hoc)`, and an update is taken ad hoc or cert-signed, as before. That
also makes the one-time switch from ad hoc to a certificate a normal update.

A copy signed with a certificate (`kSecCodeInfoCertificates` present, `kSecCodeSignatureAdhoc`
clear) takes only a build whose leaf certificate is the same. The comparison is the SHA-256 of
the leaf's DER, from `SecCodeCopySigningInformation`. Anything else is refused with *Update
failed: update signed by a different certificate*, including an ad-hoc build. A copy that cannot
read its own signature takes no update. The log names the running leaf hash and the new one:
hashes of public certificates, never a secret. Going back to ad hoc, or moving to another
certificate, needs a manual install (the DMG or `brew`).

**Install: Copper's `Swap`.** The pill then reads *Update ready · Relaunch to update*. The same
button appears in Settings. Pressing it does two sibling renames with `rename(2)`, so it never
copies. If the folder or the bundle is not writable (EACCES/EPERM, for example a Homebrew copy
in `/Applications` owned by another account), it refuses before touching anything, with *Update
needs admin rights; run `brew upgrade --greedy --cask switchyard`*. Otherwise:

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
- **Log:** `~/Library/Logs/Switchyard/update.log`, and stdout (stderr too under `--update-now`).
- **On failure** the app keeps running unchanged, and the pill says why.
- **Web:** there is no updater on the web (`views/webreload.contract` offers a reload instead),
  and none of this shows.

**Pre-release channel.** Pre-releases are skipped unless the channel is on. Turn it on with
`defaults write com.exowatt.switchyard SwitchyardUpdatePrerelease -bool true`, or the env
`SWITCHYARD_UPDATE_PRERELEASE=1`. The channel reads the releases API (pre-releases do not move
`releases/latest`), with the same allowlist and verify chain.

**Test hooks (env or launch argument only, never a setting).**

- **Headless update:** the launch argument `--update-now`, or the env `SWITCHYARD_UPDATE_NOW=1`.
  At launch, from the native module, with no UI, it checks, downloads, verifies, swaps and
  relaunches (Copper's relaunch: a shell waits for the old pid, then `open`s the bundle; the
  feed variable rides along, the hook does not). Every step goes to stderr and to
  `~/Library/Logs/Switchyard/update.log`. On failure the app keeps running. For example:

  ```sh
  open -n --env SWITCHYARD_UPDATE_FEED=https://github.com/couplet-physical-ai/switchyard/releases/download/v0.0.4/latest.json \
    ~/Applications/Switchyard.app --args --update-now
  SWITCHYARD_UPDATE_NOW=1 ~/Applications/Switchyard.app/Contents/MacOS/Switchyard
  ```

- `SWITCHYARD_UPDATE_FEED=<URL>` replaces GitHub's `latest.json`. The URL is either a
  `latest.json` itself or a base that serves `<base>/latest.json`. On GitHub the normal rules
  hold. Elsewhere it must be https, or plain `http://127.0.0.1:<port>`, and that origin may also
  serve the zip.
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
app/tools/updater-tests.sh                 # native unit tests (on a Mac; MINI=user@host from elsewhere); the
                                           # pin cases sign fixtures with throwaway certificates in a temp
                                           # keychain, made per run and deleted after
app/tools/updater-e2e.sh <Switchyard.app>  # end to end on a Mac, outside the agent, local feed
app/tools/updater-e2e-feed.sh <Switchyard.app> 0.0.2 <latest.json URL>   # a real feed, --update-now
```

- `updater-tests.sh` compiles `UpdaterCore.swift` + `UpdaterTests.swift` (and the test hooks'
  `HooksCore.swift` + `HooksTests.swift`, below) with `swiftc`. It covers:
  - version and build compare;
  - latest.json/SHA256SUMS/API parsing;
  - the host allowlist and off-host redirects;
  - the verify chain: bad sum, corrupt zip, wrong id, build not newer or not the feed's,
    tampered signature, quarantine;
  - the swap with an injected rename failure (rollback);
  - EACCES before anything is touched.
- `updater-e2e.sh`:
  1. Stamps two re-signed copies, 0.0.2 (build 2) and 0.0.3 (build 3).
  2. Serves the 0.0.3 zip and its `latest.json` on 127.0.0.1.
  3. Shows that the installed 0.0.2 finds it, downloads it, verifies it and is ready.
  4. With the AUTOINSTALL hook, shows that it swaps and relaunches as 0.0.3, and that the new
     process sweeps the `.old`.
  5. Quits only the pids it started, and removes the copy.
- `updater-e2e-feed.sh` installs a stamped old build and updates it from a real `latest.json`
  with `--update-now`.


**Tokens never sit in kept answers.** Exact keeps a resource's answer and its identifying
arguments on disk for the next launch (`kv/exact.kept`). Builds before 778694f passed the token
through Contract, so it landed there in plain text; now Contract only sees `{has, ver, status}` and
the sources keep the token in the data module's memory ("Security"). At every launch the module
also deletes any kept entry or persisted state that holds a token (`syd_`/`sys_`-shaped, or the
stored token's value as the module reads it), and
logs `scrub: removed N kept entries holding a token` to switchyard.log. Native tests in
`tools/updater-tests.sh`; a real launch in `tools/kept-scrub-e2e.sh` (Mac).

## Test hooks (macOS)

Two env-only hooks for proving a build with no agent channel (a release, a fresh install). They
are in every build, release included, and do nothing unless their variable is set; the web
ignores them. The code is `modules/apple/HooksCore.swift` (pure, tested by
`tools/updater-tests.sh`) and `Hooks.swift` (the module side), `src/hooks.ts` and
`views/hooks.contract`. Their lines go to stderr and to `~/Library/Logs/Switchyard/switchyard.log`
(the folder is made if missing), never with the token in them.

- **`SWITCHYARD_TOKEN_FILE=<path>`** connects with a device token from a file, with no confirm
  sheet. At launch the module reads the file once and refuses it, logging
  `token-file: failed <reason>`, unless the path is absolute and the file is a regular file this
  user owns, mode exactly `0600`, at most 4 KiB of UTF-8, and not empty once trimmed (spaces and
  newlines off both ends). The server is `SWITCHYARD_SERVER` when it is set, else the build's
  `SWITCHYARD_DEFAULT_SERVER`, else the stored one. The data module takes `{server, token}` once
  (`native.call({op: "tokenFile"})`, sent as a mutation, so no answer kept for the next launch
  holds it), checks them with the `switchyard://` link's `parseLink`, and connects as the link's
  Connect does (`connectTokenFile`): the server is stored, the token goes to the token file
  ("Security"; the data module stores it through the module, so it never enters a Contract
  value). The connect that follows logs `token-file: connected <server>` or
  `token-file: failed <server>: <why>`. The token never crosses argv, a URL or a log.
- **`SWITCHYARD_SNAPSHOT=<png>[:<seconds>]`** draws the main window to `<png>` (an absolute path)
  `<seconds>` after launch (default 8, at most 3600; the seconds follow the last colon), logs
  `snapshot: <path> <w>x<h>` (pixels) or `snapshot: failed <reason>`, and the app keeps running.
  It draws the session's root view the way the agent's `screenshot` does (`cacheDisplay` into an
  sRGB bitmap, Exact's `Capture.picture`), with each GPU-replayed 2D canvas's IOSurface copied in
  for the capture. Nothing here asks the window server (`CGWindowListCreateImage`,
  `screencapture`), so it needs no Screen Recording grant and works over ssh.

```sh
umask 077; printf '%s\n' "$TOKEN" > ~/.sy-token     # 0600; or chmod 600 an existing file
open -n --env SWITCHYARD_SERVER=https://switchyard.example.com \
  --env SWITCHYARD_TOKEN_FILE=$HOME/.sy-token --env SWITCHYARD_SNAPSHOT=/tmp/sy.png:10 \
  /Applications/Switchyard.app
grep -E 'token-file|snapshot' ~/Library/Logs/Switchyard/switchyard.log
```

**The heap line (always on, macOS).** Every 30 s the data module writes
`heap: <live+ext MB> MB · live <MB> · ext <MB> · cap 512 · frames <n>` to switchyard.log
(`src/memlog.ts`, through the module's `heapLog` op, so it carries the `pid <pid>` prefix). The
first number is what counts toward Hermes's cap (Hades counts external bytes, ArrayBuffers and big
strings, with the live heap); `frames` is the canvas frames drawn since launch, a running count.
The release soak (`scripts/release/soak-mini.sh`) reads it. RSS cannot see this: 0.1.4 died of a
Hermes OOM with RSS flat. The web logs its own console line (performance.memory) while connected.

**`SWITCHYARD_HEAPLOG=1:<mode>`** (a diagnostic, `src/heapprobe.ts`): the yard's live canvas
runs a synthetic churn every frame (`a` `+=` strings, `b` ArrayBuffer doubling, `c` JSON, `d` a
3000-op canvas, `t` text, `r` regexes, `n` toLocaleString, `k`/`K` localeCompare, `e` nothing,
`X,Y` in turn, 60 s each) and logs `probe <mode>: … ext
… live …` every 10 s; `1:real` draws the app as it is and adds each surface's draws and the
external bytes its draw turns added.

## Layout

| Path | What |
|---|---|
| `app.contract`, `views/*.contract` | Contract routes: Live, Factory, Yard, Connect, ⌘K and settings |
| `app.ts` | the data module: sources Contract asks, and the canvases' `draw` |
| `src/world.ts` | the fleet as Maps, applying wire frames |
| `src/timeline.ts` | LIVE / Pause / 1× / ¼× / the hour replay |
| `src/now/view.ts` | Live's data-source seam |
| `src/factory/*` | the Factory floor, its canvases, lenses, replay and coffee check |
| `src/yard/*` | the Yard: layout, motion (packets), the canvas layers |
| `src/project.ts` | the Live search palette's projections |
| `src/wire.ts` | the wire contract (`../contract/CONTRACT.md`) in TypeScript |
| `server/` | the deterministic simulation and mock server |
| `tests/` | `*.test.contract` suites (web and macOS) |
| `modules/apple/Updater*.swift`, `views/update.contract`, `src/update.ts` | the macOS updater ("Updates" above) |
| `modules/apple/Hooks*.swift`, `views/hooks.contract`, `src/hooks.ts` | the macOS test hooks ("Test hooks" above) |
| `modules/apple/Keychain*.swift`, `modules/web/index.js`, `views/token.contract` | the token at rest and its card ("Security" above) |
| `tools/` | `yard-regress.mjs` (pixel comparison), `webperf.mjs` (frame pacing in Chromium), `mini-sync.sh`, updater tools |
