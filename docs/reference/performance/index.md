# Performance

This page is the short route from a question to a repeatable Switchyard measurement. The Mac pass record is [`app/PERF.md`](https://github.com/couplet-physical-ai/switchyard/blob/main/app/PERF.md) (passes 1–7, the last in 0.1.8); the pages here explain the method and preserve release evidence.

## Pick the right host

| Host | Use it for | What to record |
|---|---|---|
| Build Mac | Building and smoke checks. It is shared, so do not treat an isolated number from it as a reference result. | Build, Exact pin, and any concurrent work. |
| Mac mini | Reference macOS performance machine: Apple silicon, Metal, native Exact host, Hermes data module. | Build, screen size, load average, process CPU, server mode, and whether the run was interleaved. |
| Devbox with Bun | Fast iteration and controlled comparisons against the same stream. Bun's normal mode has JIT; `BUN_JSC_useJIT=0` gives interpreter proportions. | JIT state, `--hermes` pricing flag where supported, stream, size, duration, and A/B order. |

`--hermes` is a pricing model for the macOS data-module frame budget, not a Hermes runtime. `BUN_JSC_useJIT=0` is also an approximation, not an absolute prediction of native milliseconds. Use the Mac mini for final native numbers.

## Reproduce a measurement

1. Choose a frozen fixture stream for idle or the same recorded/demo stream for a busy run. Keep the stream, window size, display scale, view, and duration identical between builds.
2. Build base and head from clean, separate worktrees. On the mini, run A/B interleaved (for example, A–B–B–A, repeated); log load and concurrent CPU work. Do not compare a loaded base run with an idle head run.
3. Use a fresh named app store for native `perf-drive` runs. Connect by real taps and keep the normal event loop; a virtual-clock operation measures the virtual clock, not display-link timing.
4. Report FPS, missed 60 Hz slots, frame-time p99, owner work p99, CPU, and conditions. For an idle claim also report canvas frame count and the heap-line counter.
5. For a release candidate, install the build and run the view-cycled soak. Keep the per-minute CSV and check the heap and RSS slopes, the heap cap, liveness, and crash status. The current gate is described in [`packaging/RELEASING.md`](https://github.com/couplet-physical-ai/switchyard/blob/main/packaging/RELEASING.md).

A reproducible Bun comparison from `app/` uses the recorded fixtures and the bench's default local mock URL. Start the mock in one terminal:

```sh
bun server/mock.ts --port 8361 --fixtures ../contract/fixtures --frozen
```

Then run the bench from another terminal in `app/`:

```sh
bun tools/yard-bench.ts --frames 600 --hermes
BUN_JSC_useJIT=0 bun tools/yard-bench.ts --frames 600 --hermes
```

Run the base and head commands against the same mock in alternating order. For a busy run, use the recorded demo stream rather than `--frozen`; never use a private production endpoint in a public report.

A release soak uses the installed build and samples the app's heap line and process RSS. The view cycle gives each surface a sustained interval:

```sh
SY_SOAK_NEED_HEAP=1 SY_SOAK_HEAP_CAP_MB=512 \
  SY_SOAK_CYCLE=live:15,factory:15,yard:15 \
  scripts/release/soak-mini.sh <version>
```

The soak writes a per-minute CSV. It reads the first number in `heap:` as Hermes's live-plus-external heap; the `frames` value is cumulative since launch. See [`releases.md`](releases.md) for the supplied CSV ranges and which metrics those files do not contain.

## Tools

| Tool | What it measures |
|---|---|
| [`app/tools/yard-bench.ts`](https://github.com/couplet-physical-ai/switchyard/blob/main/app/tools/yard-bench.ts) | Yard canvases, draw time, operation/list bytes, phase timing, allocation estimates, and optional Hermes-style pricing. Supports JIT and `BUN_JSC_useJIT=0`. |
| [`app/tools/f3-bench.ts`](https://github.com/couplet-physical-ai/switchyard/blob/main/app/tools/f3-bench.ts) | Factory 3 turns per display slot and frame work; `--real` includes Exact's recorder, base64, and JSON path. `BUN_JSC_useJIT=0` models interpreter proportions. |
| [`app/tools/f3-sec.ts`](https://github.com/couplet-physical-ai/switchyard/blob/df6e18a/app/tools/f3-sec.ts) | One-second Factory board work split into `boardOf`, `sceneOf`, `diffOps`, and draw; `--real` also measures the recorder. |
| [`app/tools/perf-drive.mjs`](https://github.com/couplet-physical-ai/switchyard/blob/main/app/tools/perf-drive.mjs) | Drives the native Exact app on its normal event loop and reports display-link callbacks, FPS, missed slots, and frame work. |
| [`app/tools/turns.ts`](https://github.com/couplet-physical-ai/switchyard/blob/main/app/tools/turns.ts) | Data-module source-turn duration on demo, fixtures, or a supplied server; `--max` fails on a turn over the chosen budget. |
| [`app/tools/webperf.mjs`](https://github.com/couplet-physical-ai/switchyard/blob/main/app/tools/webperf.mjs) | Chromium cold start, frame pacing, data-module draw timing, script time, and main-thread task time. |
| [`app/tools/idle-web.mjs`](https://github.com/couplet-physical-ai/switchyard/blob/main/app/tools/idle-web.mjs) | Browser canvas frames, calls, script time, and task time per second for idle and busy views. |
| [`app/tools/yard-pixels.ts`](https://github.com/couplet-physical-ai/switchyard/blob/main/app/tools/yard-pixels.ts) | Pixel equality for the Yard's partial info-layer repaint versus a full repaint. |
| [`app/tools/yard-regress.mjs`](https://github.com/couplet-physical-ai/switchyard/blob/main/app/tools/yard-regress.mjs) | Before/after browser stills under a stepped clock; reports changed pixels for Yard and Factory. |
| [`app/tools/floorpix.ts`](https://github.com/couplet-physical-ai/switchyard/blob/main/app/tools/floorpix.ts) | Exact web-replayer pixel comparison for retained floor/board drawings and full repaint references. |
| [`app/src/heapprobe.ts`](https://github.com/couplet-physical-ai/switchyard/blob/main/app/src/heapprobe.ts) and [`app/src/memlog.ts`](https://github.com/couplet-physical-ai/switchyard/blob/main/app/src/memlog.ts) | Synthetic Hermes external-memory probes and the periodic heap line used by release soak. |

The `f3-sec.ts` microbench is recorded in the pass-6 tree and is not present in the current `main` snapshot; use the linked performance commit for that exact tool version.

## Idle means still

Idle is a measured state, not a low animation rate. No stream change, timer, moving job, pointer, or real event means **0 canvas frames** and no canvas calls. `idle-web.mjs` should show 0 canvas frames/s and approximately 0 ms/s of script attributable to canvas work; the native frame counter should stay unchanged. The pause measurements in the pass-6 record are about 0.1% CPU with 0 frames; an idle tab with a visible one-second timer has a different, explicitly measured budget.

The app's pace values describe its scheduler:

| Pace | Meaning | Expected wake |
|---|---|---|
| `0` | Active work, demo/replay, or a state that needs the busy pulse. | 250 ms pulse while that work is active. |
| `1` | A visible timer is counting. | One-second tick; it should update only the timer-dependent data and pixels. |
| `2` | Nothing shown needs a periodic pulse. | No periodic pulse. Stream frames wake data; one-shot wakes reach the next minute boundary (about six per minute at most) and a short follow-up wake handles a change. |

Paused, covered, or unchanged canvases should not request frames. A timer that is genuinely visible may update once a second; an idle view is not allowed to animate merely to look alive. For the measured pass sequence, Exact patches, Hermes constraints, release rows, and the OOM report, see [`mac-passes.md`](mac-passes.md), [`exact-patches.md`](exact-patches.md), [`hermes.md`](hermes.md), [`releases.md`](releases.md), and the [macOS OOM post-mortem](../../reports/incidents/2026-11-11-macos-oom.md).
