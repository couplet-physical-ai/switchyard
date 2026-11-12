# Changelog

This page lists tagged releases newest first, from `v0.1.7` back to `v0.0.1`. Dates are tag dates. Short commit IDs identify changes in the public repository.

## Unreleased

<!-- PENDING: 0.1.8 / 0.1.9 -->

No commits newer than `v0.1.7` are present on `main`. The listed untagged changes are on `origin/sy/mac-p6` and `origin/sy/retire`; the retirement branch includes the macOS performance work.

**Views**

- On `origin/sy/retire`, every `/factory?v=…` route now opens the berth board. The earlier isometric floor and square swarm are retired. (`c1626f0`)

**macOS**

- On `origin/sy/mac-p6` and `origin/sy/retire`, the Factory board and Yard information layer keep clipped, static painting on the Core Graphics path instead of asking the host to record each frame. (`5a3001c`)

**Performance**

- On `origin/sy/mac-p6` and `origin/sy/retire`, Live keeps its displayed rows and sends only changed timer fields; the Factory and Yard progress rings fill by device pixel. (`81f4ba5`, `a9ae29c`)
- The performance report adds an interleaved comparison of idle and ticking views. (`df6e18a`)

## v0.1.7 (pre-release)

**Date:** 2026-11-12

*Theme: Keep the board smooth when many runs move at once.*

**macOS**

- The Factory canvas uses the GPU path after its initial paint, avoiding repeated recording of the whole moving scene. (`f33ac50`)

**Performance**

- The Factory repaints changed marks and clips work to the tiles that changed, including when runs enter or leave the scene. (`bdfb9f7`, `69b0626`)
- The Yard keys rows and keeps repository order between updates; one shared text collator replaces repeated sorting work. (`61fa9ee`, `0a008d1`)

**Fixes**

- A dropped live stream resumes from its last sequence while keeping the current fleet, rather than fetching the full snapshot on every retry. (`9648d25`)
- A paused view no longer repeats the same wake indefinitely. (`fc37169`)

## v0.1.6

**Date:** 2026-11-12

*Theme: Let idle views sleep and update only what moves.*

**Views**

- Live updates only its changing timers and ages; returning to Factory restores the measured board without replaying unseen movement. (`91aff90`, `4a9588e`)
- `switchyard://view/live`, `/factory`, and `/yard` switch the open app to that view. (`368b10d`)

**macOS**

- The app logs which view is open, and the release soak can cycle views while checking that idle Factory stays still. (`368b10d`, `4546175`)

**Performance**

- With no visible timer running, the periodic pulse stops; stream data wakes the overview instead. (`262f5bc`)
- Yard canvases redraw changed parts and rows rather than repainting every panel. (`c901879`, `ea8fa8a`)

**Fixes**

- Live remains still when covered or paused, and a fresh connection does not pulse before the fleet loads. (`b5741c6`, `c264617`)

## v0.1.5

**Date:** 2026-11-12

*Theme: Replace the animated floor with a quiet, inspectable Factory board.*

**Views**

- Factory becomes a fixed board of six stations over an event ledger; a run moves only when its real state changes. (`20e7d28`, `ca8a2b3`)
- Live becomes a time-ordered feed from source event to job, result, and app health, with a one-click inspector around the decisive log line. (`fde5436`, `3962a5b`)
- Deep links open the relevant view, run, repository, or app. (`634c175`)

**Server**

- A restart serves the last settled fleet while backfill runs, then sends one settled update instead of temporarily clearing counts and main lines. (`7a65ca7`)
- Pipeline logs are available on demand around the decisive error line. (`988b0a8`, `69eb653`)

**macOS**

- The old animated floor is no longer mounted in the macOS app; after the earlier out-of-memory failures, this release passed a 25-minute live soak. (`8efbba8`, `8f358f7`)

**Performance**

- Idle views redraw only when their data or visible clock changes. (`51959e7`, `67b5766`)

## v0.1.4 — withdrawn; superseded by v0.1.5

**Date:** 2026-11-11

*Theme: Add richer failure and trend reading to the isometric Factory.*

**Views**

- The Factory verdict compares current failures with the recent baseline and names the main failure concentration. (`0475561`, `96d6260`)
- Failure groups are ranked by recent volume, and the replay shows the same verdict as the live view. (`b0ccdee`, `f7349a6`)

**Fixes**

- **Withdrawn:** after publication, the release was moved back to prerelease status following Hermes out-of-memory failures in the macOS app. `v0.1.5` replaces it with the animated floor removed.

## v0.1.3

**Date:** 2026-11-11

*Theme: Keep sign-in from blocking app launch.*

**macOS**

- The device token moves to a private file, with a one-time migration from the older Keychain item; launch no longer waits for a Keychain prompt. (`1f6defc`, `6cd120b`)

**Server**

- Historical snapshots fill in group information for data recorded before the grouped-fleet contract. (`c2108ab`)

**Fixes**

- A sign-out or token save can complete while the old Keychain prompt is pending, and the app reports when an older item could not be removed. (`a8878b6`)

## v0.1.2

**Date:** 2026-11-11

*Theme: Make the Factory floor easier to read and inspect.*

**Views**

- The floor adds named team lanes, stage histories, a clearer failure verdict, and focused inspectors for groups, engines, main lines, and apps. (`49133c0`, `6d77b49`, `94d742e`)
- A run’s whole journey is easier to follow, and the coffee-check summary points to the current issue rather than adding more general decoration. (`26baef9`, `b339592`)

**Server**

- The app catalog keeps the last known list when a refresh returns empty and reports the catalog’s stale state. (`28ce266`)

**Performance**

- The static Factory floor repaints only changed tiles; verification checks that untouched pixels stay identical. (`a536414`, `d91ab17`)

## v0.1.1

**Date:** 2026-11-11

*Theme: Prevent app state and logs from retaining sign-in secrets.*

**macOS**

- Each launch removes cached answers or saved state that contains a token, and install checks look for token values in app support data and logs. (`f3ab409`, `af6dfb3`)

**Fixes**

- The web reload prompt compares the client build tree, so a server-only update does not ask users to reload. (`491dc79`, `617468a`)
- Release scripts handle empty prerelease settings on the macOS runner. (`209871b`)

## v0.1.0

**Date:** 2026-11-11

*Theme: Make the Factory the default view and add fleet-level failure history.*

**Views**

- The isometric Factory floor becomes the default: work passes through team lanes, the PR yard, merge gate, main lines, engines, checks, deploys, and app districts. Selecting an item opens its journey and a detail drawer. (`7d83a3b`, `7d353b9`)

**Server**

- The fleet contract adds groups, failure clusters, flaky checks, trends, and a change ledger with app and engine history. (`5577311`, `73ef168`)

**macOS**

- A fresh Homebrew install is checked through launch and connection to the fleet. (`19c9487`)

**Performance**

- Factory layers gain a frame budget and level of detail; idle work sleeps instead of repainting continuously. (`38000dc`, `0ea9faf`)

## v0.0.6 (pre-release)

**Date:** 2026-11-11

*Theme: Verify the update path between prereleases.*

**macOS**

- The prerelease guide records a tested update between two prerelease builds. (`1aac83c`)

## v0.0.5 (pre-release)

**Date:** 2026-11-11

*Theme: Add live fleet tables, an updater, and a denser Yard.*

**Views**

- Mainlines and PRs become windowed tables, and the Yard fits more fleet information while keeping failure marks prominent. (`e3fead3`, `4a3a76c`, `31c3dd6`)
- PR detail shows the failing phase first, lists required checks, and explains where the work is held. (`9fd8724`)

**macOS**

- The app adds an in-app updater, install checks, and a web reload notice when the served client is newer. (`eaea78c`, `643e652`, `da4e6f1`)

**Performance**

- Canvas operations are batched, motion uses level of detail, and parsing and demo startup are split into smaller turns. (`13752cf`, `df45e3c`, `e3bfe34`)

**Fixes**

- Live reconnects with backoff and retries a failed snapshot fetch instead of staying disconnected. (`5e2592e`)

## v0.0.4 (pre-release)

**Date:** 2026-11-11

*Theme: Connect the first client to live fleet data and safe history replay.*

**Views**

- Fleet, Mainlines, PRs, and Journey show current status and trace a commit through its checks and deploy. (`327f70a`, `78db1bc`)
- A connect link opens the app to the requested connection flow. (`0427b0a`)

**Server**

- The server adds live snapshots, bounded streaming, replayable history, and consistent state across a restart. (`ca3051b`, `bbde473`, `c0f2a95`)
- If an upstream is unavailable, the server backs off while keeping the last good fleet. (`ed4f410`)
- Wire updates become smaller patches and dot operations; server and client fixtures validate that replay matches the live world. (`0a14251`, `5fa74d4`)

**macOS**

- Releases carry versioned update metadata, and first-run sign-in asks before saving a device token. (`36e9e55`, `8542c16`)

**Fixes**

- Startup reports ready when the key repositories and open work are available, while slower inventory backfill continues. (`4eefe07`, `6bd72ff`)

## v0.0.3 (pre-release)

**Date:** 2026-11-10

*Theme: Ship the first working client, server, and web checks.*

**Views**

- The first app combines the living Yard, Mainlines, PRs, Fleet, Journey, search, time controls, and a demo fleet. (`fd4396b`)

**Server**

- A Rust service and initial wire contract serve real fixtures and a built-in demo. (`bc8545e`)

**macOS**

- The release runner includes the timeout tool required by the build. (`063e36d`)

**Fixes**

- Web builds run contract tests and a mock-server self-test. (`56b469c`)

## v0.0.2

**Date:** 2026-11-10

*Theme: Make the placeholder app render in a headless window.*

**macOS**

- `--snapshot` renders the app window directly to an image, with a dark appearance. (`5dfb3e4`)

## v0.0.1

**Date:** 2026-11-10

*Theme: Establish the macOS release pipeline and app shell.*

**macOS**

- The first tagged build adds a placeholder app, a release script, and archive and disk-image packaging. (`07dd4c4`)
