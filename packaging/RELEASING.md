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

It copies `HEAD` to the mini (`mini-user@192.0.2.1`,
`/Volumes/Farm/farm-exowatt/switchyard-release`, which holds the Exact checkout and its own
`CARGO_HOME`/`RUSTUP_HOME`), builds and packages there, verifies the checksums here, publishes
the release with `gh`, and dispatches the tap bump.

## Signing

There is no Apple Developer ID, so the app is ad-hoc signed and not notarized. The cask's
`postflight` removes `com.apple.quarantine`; a dmg download needs
`xattr -dr com.apple.quarantine /Applications/Switchyard.app` once.
