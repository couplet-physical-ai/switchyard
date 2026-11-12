# Releasing Switchyard

## One command

```sh
scripts/release.sh 0.1.0
```

It checks that `origin/main` is green on Roadrunner (`gh rr status`), tags it `v0.1.0`,
pushes the tag, waits for [`release.yml`](../.github/workflows/release.yml), then runs the
tap's `bump-switchyard` workflow. `--dry-run` shows the plan; `--skip-ci` skips the
Roadrunner check.

## What the release workflow does

`.github/workflows/release.yml` (GitHub Actions; macOS builds stay on GitHub's macOS runners,
free for this public repo), on a `v*` tag or a manual run:

1. `runs-on: xcode-27` (macOS 27, Xcode 27.1, the Xcode Exact is developed against; the
   Mac mini runs the same pair).
2. Bun 1.4.2, a checkout of [expo/exact](https://github.com/expo/exact) at the pin
   (`app/exact.pin`, else [`packaging/exact.pin`](exact.pin)), `bun scripts/exact.mjs setup`
   and the Hermes bundle for `aarch64-apple-darwin`; cargo registry, Hermes and Exact's
   `target/` are cached per pin.
3. [`scripts/release/build-macos.sh`](../scripts/release/build-macos.sh) builds
   `dist/Switchyard.app` (arm64).
4. [`scripts/release/package-macos.sh`](../scripts/release/package-macos.sh) ad-hoc signs it
   (`codesign -s -`; no Developer ID exists), writes `Switchyard-<v>-arm64.zip` (what the
   cask installs), `Switchyard-<v>-arm64.dmg` and `SHA256SUMS`.
5. Launch smoke: the packaged app must still be running after 5 s.
6. GitHub release `v<v>` with the zip, dmg, `SHA256SUMS` and `latest.json`, the in-app
   updater's feed (stable URL
   <https://github.com/couplet-physical-ai/switchyard/releases/latest/download/latest.json>;
   shape in [`scripts/release/latest-json.py`](../scripts/release/latest-json.py)). The bundle's
   `CFBundleVersion` is `M*1000000 + m*1000 + p`, so it rises with every release on both build
   paths; the updater refuses a bundle that is not newer. Its notes come from the commit subjects since the
   previous release, grouped by area (`client:`, `server:`, `ci:`, `release:`, …):
   [`scripts/release/notes.py`](../scripts/release/notes.py) (`python3 scripts/release/notes.py 0.1.0` previews them).

The tap ([couplet-physical-ai/homebrew-tap](https://github.com/couplet-physical-ai/homebrew-tap))
moves itself: its `bump-switchyard` workflow reads the newest release's `SHA256SUMS`, hashes
the zip again, and commits `Casks/switchyard.rb` with its own `GITHUB_TOKEN` (deploy keys are
disabled for the org, and this repo's token cannot push there). It runs every 20 minutes and on
demand: `gh workflow run bump-switchyard.yml -R couplet-physical-ai/homebrew-tap -f version=0.1.0`.

The cask's structure lives here, in [`homebrew/switchyard.rb.in`](homebrew/switchyard.rb.in);
after changing it, render it into the tap once with
`scripts/release/bump-cask.sh <version> <sha256> <tap checkout> --push`.

## Manual runs

```sh
gh workflow run release.yml -f version=0.0.1 -f mode=placeholder -f prerelease=true   # release-path check
gh workflow run release.yml -f version=0.0.0 -f mode=exact-probe                    # toolchain check, publishes nothing
```

## Fallback: build on the Mac mini

If GitHub's macOS runners are down or cannot build Exact:

```sh
scripts/release/release-mac-mini.sh 0.1.0
```

It refuses to start when `/Volumes/Farm` (shared) has under 20 GB free, then copies `HEAD` to the mini (`mini-user@192.0.2.1`,
`/Volumes/Farm/farm-exowatt/switchyard-release`: one Exact checkout `exact/`, one working tree
`src/` whose `app/target` is kept between releases, and its own `CARGO_HOME`/`RUSTUP_HOME`; ~15 GB), builds and packages there, verifies the checksums here, publishes
the release with `gh`, and dispatches the tap bump.

## Signing

There is no Apple Developer ID, so the app is ad-hoc signed and not notarized. The cask's
`postflight` removes `com.apple.quarantine`; a dmg download needs
`xattr -dr com.apple.quarantine /Applications/Switchyard.app` once.

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

Run all three on the Mac mini against the new stable release `N` (previous release `P`). Each one
quits only `/Applications`' copy. Tokens go over as files only (`SY_TOKEN_FILE`, mode 600).

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
