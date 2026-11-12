# Hermes performance notes

The macOS Exact host runs the app's data module on Hermes. That changes both the CPU budget and what counts toward the heap. This page records the constraints that affected measured Switchyard work; it does not treat Bun estimates as native timings.

## Turn budget and interpreter comparisons

Exact's source-turn budget is 100 ms of CPU on Hermes. That is a ceiling, not a target: a slow Mac can run Hermes about 10–25× slower than Bun with JIT, and a long turn delays frame work even when the main thread appears idle. The project uses a 4 ms Bun turn check as a guardrail for ordinary data work.

```sh
bun app/tools/turns.ts demo --max 4
bun app/tools/turns.ts fixtures --max 4
```

For draw proportions, run the Bun harness in both modes. `BUN_JSC_useJIT=0` disables JSC's JIT; it is nearer to an interpreter than Bun JIT, but it is not Hermes and its milliseconds are not interchangeable with a Mac measurement. `yard-bench.ts --hermes` adds Hermes-style frame pricing and reproduces the per-call `localeCompare` behavior; it does not invoke Hermes.

## Locale work in a hot path

Hermes constructed an `Intl.Collator` for each `String.prototype.localeCompare` call. The Yard's repository aggregate sorted on nearly every stream frame. A 491-sample mini profile of timer turns had about 200 samples under `Array.prototype.sort`, including 74 under `localeCompare`, 37 in `Collator::create`, and 29 in `Collator::compare`. About 140 samples were GC; host text measurement accounted for 13.

The fix was to make one default and one numeric `Intl.Collator` and reuse them, while keeping the existing repo order when its inputs did not change. On 776 fixture names, 602,176 pairwise comparisons produced no ordering differences. On the mini, the hot sort and `Collator::create` disappeared from the timer-turn sample. See [the macOS pass record](mac-passes.md) and commit [`0a008d1`](https://github.com/couplet-physical-ai/switchyard/commit/0a008d1).

`Number.prototype.toLocaleString('en-US')` was another suspect in the retired floor's repeated label formatting. The old floor replaced it with a pure-JS thousands formatter; the output matched all 18 checked values. A heap probe includes an `n` mode for `toLocaleString`, but the supplied performance record does not quantify its CPU cost or identify it as the cause of the old-floor external-memory drift. Treat avoiding repeated locale formatting in a draw as a useful hot-path rule, not as a measured Hermes speedup.

## External memory is part of the heap

Hermes/Hades accounts for external bytes such as ArrayBuffers and large strings toward the heap ceiling. Switchyard's periodic `heap:` line reports the first number as live plus external memory, followed by the live and external parts. The `frames` field is cumulative since launch. RSS can stay flat while the Hermes counter grows, so RSS alone cannot rule out an impending Hermes OOM.

Exact collects between data-module calls, but frequent collection does not make per-frame churn harmless. During the instrumented legacy-floor reproduction, the live set stayed around 9–12 MB while `js_externalBytes` rose about 0.13–0.15 MB/s; with no canvas frames, external bytes stayed flat. The old floor's draw path was the trigger. The 64 MiB heap ceiling was raised to 512 MiB as headroom, but OOM remained fatal and the cap was not the fix. See the [OOM post-mortem](../../reports/incidents/2026-11-11-macos-oom.md) and [patch 0001](exact-patches.md#patch-set).

## Recorder allocations

The pre-patch native canvas recorder could grow a list writer from a 256-byte ArrayBuffer by doubling and copying it, create base64 through repeated string concatenation, and serialize another JSON reply. Temporary views, buffers, and strings can increase Hermes external accounting even when the JavaScript live set is small. Patch 0002 reuses list and base64 buffers and joins the reply once; its reply bytes were checked against the unpatched seam for 78 cases.

A font change also sends the whole family list through the recorder. In the Factory board, each font change could encode the family one character at a time (roughly 400 bytes per family list); the board alternated fonts about 120 times in a whole repaint. Grouping non-overlapping words by font and colour reduced the board list from 101.7 to 69.7 KB on the fixture board. Patches 0003 and 0004 reduce native recorder parsing and path-allocation work without changing tested output bytes. Details and scope limits are in [Exact patches](exact-patches.md).

## Read the probes correctly

- `app/tools/yard-bench.ts --hermes` prices the Yard's recorder and frame budget with Hermes-style `localeCompare`; use it to find relative hot paths.
- `app/tools/f3-bench.ts --real` and `app/tools/f3-sec.ts --real` include the Exact recorder. Set `BUN_JSC_useJIT=0` for interpreter proportions.
- `app/src/heapprobe.ts` can compare discarded strings, growing ArrayBuffers, JSON, recorded canvas work, text, regexes, `toLocaleString`, and `localeCompare`. The probe runs in the draw path and reports external and live bytes; its output is diagnostic, not a release-soak result.
- `app/src/memlog.ts` emits the production-shaped heap line every 30 seconds. Use its cumulative `frames` count alongside per-minute soak CSVs and RSS.

The practical rule is to keep data-module turns small, share locale objects, avoid formatting or allocating unchanged drawing state each frame, and verify memory with live-plus-external heap rather than RSS alone.
