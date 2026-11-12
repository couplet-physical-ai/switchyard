# Release the macOS app

macOS releases are built on GitHub Actions, then published as GitHub release assets. A stable release also updates the public Homebrew tap. Gated releases stay prereleases until the updater and live-memory checks pass.

## Stable release path

The release script checks that the source revision is green on Roadrunner, tags it, waits for the macOS workflow, and then asks the tap to update its cask:

```sh
scripts/release.sh VERSION
```

Use `--dry-run` to print the planned actions. `--skip-ci` skips the Roadrunner check. The workflow in [`.github/workflows/release.yml`](https://github.com/couplet-physical-ai/switchyard/blob/main/.github/workflows/release.yml) runs on GitHub's macOS runners. It sets up Bun 1.4.2 and the pinned Exact checkout, builds the Apple Silicon app, packages a ZIP and disk image, writes `SHA256SUMS` and `latest.json`, smoke-launches the packaged app, and publishes the release.

The Homebrew tap's `bump-switchyard` workflow verifies the release checksum and updates the `switchyard` cask. It also checks periodically, so the tap can catch up after a release without embedding tap credentials in this repository.

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

A garbage-collected heap is a sawtooth: it moves about 2 MB a minute without leaking, so two samples a few minutes apart prove nothing (0.1.7's first soak was flagged that way and passed a rerun). Since `c4fefdc` each view segment of at least 15 minutes is judged on every sample:

| Check | Limit | Why |
|---|---|---|
| External-memory slope (least squares) | ≤ +0.05 MB/min | The primary leak signal: the 0.1.3/0.1.4 crash grew it about 9 MB/min. |
| Heap slope (least squares) | ≤ +0.3 MB/min | Uses every sample, not two. |
| Heap half-means | second half ≤ first half + 1.5 MB | Robust to the sawtooth. |
| Live creep on the post-collection floor (each minute's lowest heap) | slope ≤ +0.1 MB/min, or half-means ≤ +1 MB | Slow creep where nothing redraws. |

The full rationale, with the numbers from 0.1.6 and 0.1.7, is in `packaging/RELEASING.md`.

After promotion, `--promote` makes the candidate the stable Latest release and starts the tap bump. The stable update feed then points to it, and a fresh Homebrew install receives the new cask.

## Signing and downloads

The macOS app is ad-hoc signed and not notarized because the project does not have an Apple Developer ID. The Homebrew cask removes the quarantine flag during installation. A disk-image install needs the quarantine-removal step in the [install guide](install.md).

The workflow produces a versioned Apple Silicon ZIP, a DMG, `SHA256SUMS`, and the updater feed. The in-app updater checks the feed and archive before offering an Update action; it relaunches only when the user chooses **Relaunch to update**. The web app does not use this updater.

## Source files

- [`scripts/release.sh`](https://github.com/couplet-physical-ai/switchyard/blob/main/scripts/release.sh) coordinates the tag, workflow, and tap update.
- [`.github/workflows/release.yml`](https://github.com/couplet-physical-ai/switchyard/blob/main/.github/workflows/release.yml) builds and publishes macOS artifacts.
- [`packaging/RELEASING.md`](https://github.com/couplet-physical-ai/switchyard/blob/main/packaging/RELEASING.md) documents the release gates and tap process.
- [`scripts/release/soak-mini.sh`](https://github.com/couplet-physical-ai/switchyard/blob/main/scripts/release/soak-mini.sh) measures live stability and memory across the view cycle.
