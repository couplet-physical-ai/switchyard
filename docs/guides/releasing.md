# Release the macOS app

macOS releases are built, signed with a Developer ID, notarized and stapled on the release Mac, then published as GitHub release assets. A stable release also updates the public Homebrew tap. Gated releases stay prereleases until the updater and live-memory checks pass.

## Stable release path

The release script checks that the source revision is green, tags it, builds and signs on the release Mac, publishes the release, and updates the tap's cask:

```sh
scripts/release.sh VERSION
```

Use `--dry-run` to print the planned actions. `--skip-ci` skips the CI check. [`scripts/release/release-mac-mini.sh`](https://github.com/couplet-physical-ai/switchyard/blob/main/scripts/release/release-mac-mini.sh) copies the commit to the release Mac, builds the Apple Silicon app with the pinned Exact checkout, signs and notarizes it with [`scripts/release/package-macos.sh`](https://github.com/couplet-physical-ai/switchyard/blob/main/scripts/release/package-macos.sh), packages a ZIP and disk image from the stapled app, smoke-launches the packaged app, runs the macOS tests, writes `SHA256SUMS` and `latest.json`, and publishes the release. The server a fresh install talks to and the org order are site configuration: the script reads them from the environment (`SWITCHYARD_DEFAULT_SERVER`, `SWITCHYARD_ORGS`, kept with the private deployment), and an app release refuses to build without the server.

[`scripts/release/bump-tap.sh`](https://github.com/couplet-physical-ai/switchyard/blob/main/scripts/release/bump-tap.sh) checks the published zip against `SHA256SUMS` and pushes the `switchyard` cask to the tap.

## Gated prerelease

A gated release is published as a prerelease. GitHub's stable `latest` feed and the Homebrew tap ignore prereleases, so users keep receiving the previous stable version while the candidate is tested.

1. Cut the candidate with `scripts/release.sh VERSION --gate`.
2. Run the updater end-to-end check from the previous version to the candidate. [`scripts/release/update-e2e-mini.sh`](https://github.com/couplet-physical-ai/switchyard/blob/main/scripts/release/update-e2e-mini.sh) exercises the installed-app path. [`app/tools/updater-e2e.sh`](https://github.com/couplet-physical-ai/switchyard/blob/main/app/tools/updater-e2e.sh) uses a local feed; [`app/tools/updater-e2e-feed.sh`](https://github.com/couplet-physical-ai/switchyard/blob/main/app/tools/updater-e2e-feed.sh) checks a release feed. Verify that the new process starts and the installed bundle is the candidate.
3. Run a live soak for at least 20 min with the app's `heap:` samples enabled. The soak needs a mode-`0600` token file through `SY_TOKEN_FILE`; pass a file path, never the file contents. Set `SY_SOAK_NEED_HEAP=1` and a reviewed `SY_SOAK_HEAP_CAP_MB` value. The current cycled gate uses 15 min each on Live, Factory, and Yard (45 min total): `SY_SOAK_CYCLE=live:15,factory:15,yard:15`.
4. Promote only after both checks pass:

   ```sh
   scripts/release.sh VERSION --promote
   ```

The soak checks that the app remains alive, no new crash report appears, RSS and JavaScript heap plateau, and each view stays within its memory gates. The Yard must draw frames. The heap line is required because RSS alone can miss growth inside Hermes. A borderline or failed soak remains a prerelease; do not promote it.

A garbage-collected heap is a sawtooth: it moves about 2 MB a minute without leaking, so two samples a few minutes apart prove nothing (0.1.7's first soak was flagged that way and passed a rerun). Since `e5eb5f0` each view segment of at least 15 minutes is judged on every sample:

| Check | Limit | Why |
|---|---|---|
| External-memory slope (least squares) | ≤ +0.05 MB/min | The primary leak signal: the 0.1.3/0.1.4 crash grew it about 9 MB/min. |
| Heap slope (least squares) | ≤ +0.3 MB/min | Uses every sample, not two. |
| Heap half-means | second half ≤ first half + 1.5 MB | Robust to the sawtooth. |
| Live creep on the post-collection floor (each minute's lowest heap) | slope ≤ +0.1 MB/min, or half-means ≤ +1 MB | Slow creep where nothing redraws. |

The full rationale, with the numbers from 0.1.6 and 0.1.7, is in `packaging/RELEASING.md`.

After promotion, `--promote` makes the candidate the stable Latest release and bumps the tap. The stable update feed then points to it, and a fresh Homebrew install receives the new cask.

## Signing and downloads

From 0.1.9 the macOS app is signed with a Developer ID Application certificate (hardened runtime, no entitlements), notarized, and stapled; the disk image is signed, notarized, and stapled too, so neither install route needs a quarantine workaround. The in-app updater pins the signing team (see the app README, "Signer pinning"). Versions up to 0.1.8 were ad-hoc signed; they take the first signed build as a normal update.

The release produces a versioned Apple Silicon ZIP, a DMG, `SHA256SUMS`, and the updater feed. The in-app updater checks the feed and archive before offering an Update action; it relaunches only when the user chooses **Relaunch to update**. The web app does not use this updater.

## Source files

- [`scripts/release.sh`](https://github.com/couplet-physical-ai/switchyard/blob/main/scripts/release.sh) coordinates the tag, the release Mac build, and the tap update.
- [`scripts/release/release-mac-mini.sh`](https://github.com/couplet-physical-ai/switchyard/blob/main/scripts/release/release-mac-mini.sh) builds, signs, notarizes, and publishes the macOS artifacts.
- [`packaging/RELEASING.md`](https://github.com/couplet-physical-ai/switchyard/blob/main/packaging/RELEASING.md) documents the release gates and tap process.
- [`scripts/release/soak-mini.sh`](https://github.com/couplet-physical-ai/switchyard/blob/main/scripts/release/soak-mini.sh) measures live stability and memory across the view cycle.
