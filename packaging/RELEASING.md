# Releasing Switchyard

## One command

```sh
scripts/release.sh 0.1.0
```

It checks that `origin/main` is green (every check run of the commit passed), tags it
`v0.1.0`, pushes the tag, then runs
[`scripts/release/release-mac-mini.sh`](../scripts/release/release-mac-mini.sh) at that commit:
the release Mac builds, signs, notarizes and staples; this machine publishes the GitHub release
and moves the tap. `--dry-run` shows the plan; `--skip-ci` skips the check.

Site configuration comes from the environment, never from the source: `MINI` (or `SY_MINI`,
`user@host` of the release Mac), `SWITCHYARD_DEFAULT_SERVER` (the server a fresh install talks
to; an app release refuses to build without it) and `SWITCHYARD_ORGS` (the watched orgs in
display order, the server's list). The real values are kept with the private deployment
(`set -a; . <its release env>; set +a` before running). Public release notes and the cask never
name the server.

## What the release does

[`scripts/release/release-mac-mini.sh`](../scripts/release/release-mac-mini.sh) `<version>
[--mode app|placeholder] [--prerelease] [--no-publish]`:

1. Refuses to start when the release Mac's working volume has under 20 GB free, then copies the
   commit (`REF`, default `HEAD`) to `$MINI_DIR/src` (default
   `/Volumes/Farm/farm-exowatt/switchyard-release`: one Exact checkout `exact/` at the pin
   (`app/exact.pin`, else [`packaging/exact.pin`](exact.pin)), cloned and set up on first use,
   with its own `CARGO_HOME` (and the pinned Hermes engine) and `RUSTUP_HOME`, and one working
   tree `src/` whose `app/target` is kept between releases; ~15 GB). `MINI_RUSTUP_HOME` and
   `MINI_CACHE` reuse the account's toolchains and Exact caches instead; `MINI_MIN_FREE_GB`
   (default 20) is the free-space floor.
2. [`scripts/release/build-macos.sh`](../scripts/release/build-macos.sh) builds
   `dist/Switchyard.app` (arm64). With `MINI_LOCK=<file>` the build and the macOS tests run under
   `lockf -t 10800 <file>`, queued behind other builds on a shared Mac.
3. [`scripts/release/package-macos.sh`](../scripts/release/package-macos.sh) signs it with the
   Developer ID, notarizes and staples the app, zips it (`Switchyard-<v>-arm64.zip`, what the
   cask and the updater install), makes `Switchyard-<v>-arm64.dmg`, signs, notarizes and staples
   the dmg, checks all of it with `codesign`, `spctl` and `stapler`, and writes `SHA256SUMS` from
   the final files (*Signing* below).
4. Launch smoke: the app unpacked from the zip must still be running after 5 s. Then the app's
   `*.test.contract` suites on the macOS host (`app/scripts/build.sh test macos`).
5. Back here: the checksums are verified, `latest.json` (the in-app updater's feed, stable URL
   <https://github.com/couplet-physical-ai/switchyard/releases/latest/download/latest.json>;
   shape in [`scripts/release/latest-json.py`](../scripts/release/latest-json.py)) is written
   from `SHA256SUMS` and the shipped `Info.plist`, so it hashes the stapled zip, and on a Mac
   Gatekeeper checks the zip and the dmg once more.
6. GitHub release `v<v>` with the zip, dmg, `SHA256SUMS` and `latest.json`. The bundle's
   `CFBundleVersion` is `M*1000000 + m*1000 + p`, so it rises with every release; the updater
   refuses a bundle that is not newer. Its notes come from the commit subjects since the
   previous release, grouped by area (`client:`, `server:`, `ci:`, `release:`, …):
   [`scripts/release/notes.py`](../scripts/release/notes.py) (`python3 scripts/release/notes.py 0.1.0`
   previews them). `0.0.x`, suffixed versions and `--prerelease` publish as prereleases.
7. [`scripts/release/bump-tap.sh`](../scripts/release/bump-tap.sh) (stable releases only):
   downloads the release's `SHA256SUMS` and zip, checks the hash, and renders
   [`homebrew/switchyard.rb.in`](homebrew/switchyard.rb.in) into
   [couplet-physical-ai/homebrew-tap](https://github.com/couplet-physical-ai/homebrew-tap)
   `Casks/switchyard.rb` (`scripts/release/bump-cask.sh --push`). The tap's own scheduled bump
   only edits the version and sha256, so the cask's structure always comes from here.

`--mode placeholder` proves the release path without the client (a tiny AppKit window, signed
and notarized the same way); use a `0.0.x` version so it stays a prerelease.

## Signing

Every release is signed with Exowatt Inc's **Developer ID Application** certificate (team
`62D5L6T44Y`), with the hardened runtime and a secure timestamp on each Mach-O
(`Contents/MacOS/Switchyard`, `libexact_canvas_gpu.dylib`, `libexact_modules.dylib`; no
entitlements: the dylibs load from the bundle and carry the same team), then notarized by Apple
and stapled. The dmg is signed, notarized and stapled too. No keychain is involved anywhere.

- **Tool:** `exo-macsign` (a wrapper around [rcodesign](https://github.com/indygreg/apple-platform-rs)),
  installed on the release Mac at `~/.local/bin/exo-macsign` with rcodesign 0.29.
  `package-macos.sh` refuses any copy whose SHA-256 differs from
  [`exo-macsign.sha256`](exo-macsign.sha256); bump that file to move to a newer tool.
- **Credentials:** on the release Mac, in `~/.config/exowatt-apple-signing/` (dir 0700, files
  0600): `developer-id-application.p12` + `p12-password`, the App Store Connect API key
  `AuthKey_<id>.p8` + `asc-issuer`, and `team-id`. Or the same values in the environment as
  `EXO_MACSIGN_P12_BASE64`, `EXO_MACSIGN_P12_PASSWORD`, `EXO_MACSIGN_ASC_KEY_P8_BASE64`,
  `EXO_MACSIGN_ASC_KEY_ID`, `EXO_MACSIGN_ASC_ISSUER`, `EXO_MACSIGN_TEAM_ID`. They are never in
  this repository. `exo-macsign doctor --online` checks them.
- **Command:** `scripts/release/package-macos.sh <v>` runs
  `exo-macsign release dist/Switchyard.app --zip … --dmg …`.
  A failed signature or a rejected notarization (exit 3; Apple's log is printed) fails the
  release before anything is published. `--adhoc` makes an ad-hoc local test build that must
  never be published.
- **Verify** a published copy:

  ```sh
  gh release download v<v> -R couplet-physical-ai/switchyard -p '*.zip' -p '*.dmg'
  ditto -x -k Switchyard-<v>-arm64.zip x && spctl -a -vv -t exec x/Switchyard.app   # source=Notarized Developer ID
  xcrun stapler validate x/Switchyard.app && codesign --verify --deep --strict x/Switchyard.app
  spctl -a -vv -t open --context context:primary-signature Switchyard-<v>-arm64.dmg && xcrun stapler validate Switchyard-<v>-arm64.dmg
  app/tools/updater-tests.sh --verify-release "$PWD/Switchyard-<v>-arm64.zip" <v>      # the updater takes it
  ```

Releases up to 0.1.8 were ad-hoc signed; their updater takes the first Developer ID build as a
normal update (the pin is off on an ad-hoc copy), and from then on the updater pins the team
(app README, "Signer pinning"). The cask no longer strips the quarantine flag.

## Prereleases and the update proof

`0.0.x` and suffixed versions (`0.2.0-rc.1`) publish as **prereleases**: GitHub's
`/releases/latest/…` skips them and `scripts/release.sh` leaves the tap alone. To prove the in-app
updater without touching what users get, cut two prereleases and point the older one at the newer
one's feed:

```sh
scripts/release.sh 0.0.5 && scripts/release.sh 0.0.6
SY_UPDATE_FEED=https://github.com/couplet-physical-ai/switchyard/releases/download/v0.0.6/latest.json \
  scripts/release/update-e2e-mini.sh 0.0.5 0.0.6
```


## After every release: the mini proofs

Run all three on the Mac mini (`SY_MINI=user@host`) against the new stable release `N`
(previous release `P`). Each one quits only `/Applications`' copy. Tokens go over as files only (`SY_TOKEN_FILE`, mode 600).

```sh
T=~/.config/switchyard/e2e-token
# 1. P → N over the stable feed. P connects first, so its token is stored. N's window must show
#    within 5 s with NO Keychain prompt, and a seeded token in exact.kept must be scrubbed.
SY_TOKEN_FILE=$T SY_SEED_TOKEN=1 scripts/release/update-e2e-mini.sh P N
# 2. A fresh tap install, connected live: window within 5 s, no prompt, and the token only in
#    Application Support/com.exowatt.switchyard/token (0600, dir 0700). Snapshot in /tmp/sy-shots/.
SY_TOKEN_FILE=$T SY_SNAPSHOT=1 scripts/release/install-e2e-mini.sh N
# 3. A live soak of 20 min or more: the process stays alive, and RSS plus the app's `heap:` lines
#    plateau, the max heap over the last 10 min stays under the cap, and no crash report appears.
#    Use SY_SOAK_NEED_HEAP=1 and SY_SOAK_HEAP_CAP_MB once the app logs heap lines.
#    Per-minute CSV: /tmp/sy-soak-N.csv.
SY_TOKEN_FILE=$T scripts/release/soak-mini.sh N 25
```

`SY_KC_PROMPT_OK=1` on (1) allows one known Keychain prompt. That was 0.1.2 → 0.1.3 only: the
token moved out of the Keychain then, and any later update with a prompt is a regression. The
soak exists because 0.1.3 and 0.1.4 die of a Hermes OOM after 4 to 18 min live while their RSS
stays flat, so RSS alone does not catch it.

## Gated releases (since the 0.1.4 rollback)

A gated release never reaches users before the mini proves it. `--gate` publishes it as a
**prerelease**: GitHub's `/releases/latest` and so the stable feed skip it, and the tap's cron
bump only follows the latest release. The gates run against the release's own feed, then
`--promote` makes it Latest and bumps the tap.

```sh
P=0.1.3 N=0.1.5 T=~/.config/switchyard/e2e-token
scripts/release.sh $N --gate
# 1. P → N through N's own feed: 0 Keychain prompts, window within 5 s, the seeded token scrubbed.
#    --keep leaves N installed for the soak.
SY_UPDATE_FEED=https://github.com/couplet-physical-ai/switchyard/releases/download/v$N/latest.json \
  SY_TOKEN_FILE=$T SY_SEED_TOKEN=1 scripts/release/update-e2e-mini.sh $P $N --keep
# 2. a live soak of at least 20 min of the installed N: it stays alive, no crash report, and the
#    heap and RSS stay flat; with the view cycle each segment is gated on its own heap, and the
#    Yard must draw frames.
SY_TOKEN_FILE=$T SY_SOAK_NEED_HEAP=1 SY_SOAK_HEAP_CAP_MB=<cap> SY_SOAK_CYCLE=live:15,factory:15,yard:15 \
  scripts/release/soak-mini.sh $N   # 0.1.6+: cycles the views via switchyard://view/<name>
# 3. only now: Latest + tap, then the users' paths: the stable feed and a fresh brew install.
scripts/release.sh $N --promote
SY_TOKEN_FILE=$T scripts/release/update-e2e-mini.sh $P $N
SY_TOKEN_FILE=$T SY_SNAPSHOT=1 scripts/release/install-e2e-mini.sh $N
```

If any gate fails, the release stays a prerelease. Nothing needs to be rolled back.

## The soak's memory gate, and why it changed (0.1.7)

Up to the first 0.1.7 run, each view segment was judged by its **heap 3 minutes before the end
compared with its last heap reading**, failing if it grew more than 8 %. That compares two single
samples of a garbage-collected heap that swings 15 ↔ 19 MB minute to minute. The verdict depended
on where the two samples landed in the sawtooth, not on whether memory grew:

- **0.1.7 run 1:** flagged Live +12.1 % and Factory +12.6 %. The least-squares slopes of the same
  runs were +0.19 and +0.15 MB/min, external memory was flat (≤ +0.02 MB/min), and RSS was flat.
- **0.1.6:** passed, with a Live slope of +0.16 MB/min. Its samples simply landed better; on a
  different sampling the same check would have flagged it too.
- **sy-client's 40-min soak of the 0.1.7 tree:** successive 8-min windows of one Live run gave
  slopes from −0.26 to +0.23 MB/min, while the 20-min half-means were 15.85 / 15.86 MB. An 8-min
  slope is ±0.25 MB/min from GC noise alone.

The gate was therefore changed **after a flagged run**, and that is stated here on purpose. It is
legitimate because the old check was statistically broken, not too strict: it would have failed
0.1.6 on another sampling. The flagged 0.1.7 run was **not** promoted on re-analysis; 0.1.7 got a
fresh 45-min soak under the new gate.

The gate now, per view segment (segments of at least 15 min):

| Signal | Limit | Why |
|---|---|---|
| External-memory slope (least squares) | ≤ +0.05 MB/min | the primary leak signal: 0.1.3/0.1.4 grew it about 9 MB/min |
| Heap slope (least squares) | ≤ +0.3 MB/min | uses every sample, not two |
| Heap half-means (segments ≥ 10 min) | second half ≤ first half + 1.5 MB | robust to the sawtooth |
| Live creep on the post-GC floor (each minute's lowest heap sample) | slope ≤ +0.1 MB/min **or** half-means ≤ +1 MB | slow creep where nothing redraws |
| Heap maximum | ≤ the cap | |
| Yard frames | > 0 | |
| Process | alive, no new crash report | |

A Live creep result with both legs within 20 % of their limits is BORDERLINE: the run exits 3, and
the release is reported, not promoted.
