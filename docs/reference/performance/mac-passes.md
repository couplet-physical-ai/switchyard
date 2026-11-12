# macOS performance passes

This is the ordered pass record through pass 7, the last pass, in [`app/PERF.md`](https://github.com/couplet-physical-ai/switchyard/blob/main/app/PERF.md). All seven passes ship by 0.1.8, the final planned performance release. Numbers are conditional on the stated Mac mini, workload, load, and window; a CPU percentage from an idle tab is not a frame-time measurement.

## Summary

| Pass | Date | Theme | Headline number |
|---|---|---|---|
| 1 — initial idle pass | Before 2026-11-12 | Stop drawing covered or unchanged views | Idle CPU fell from 10.9/11.4/13.0% to 4.65/6.55/4.77% for Live/Factory/Yard; Live and Factory asked for 0 display-link callbacks. |
| 2 — idle pass 2 | 2026-11-12 | Re-stamp timers instead of rebuilding views | Bun clock-only Live answer: 6.1 ms to 0.03–0.05 ms; a Factory tick repainted 7 of 706 marks. |
| 3 — shell | 2026-11-12 | Sleep the pulse when no visible timer needs it | Web timer recalculations fell from 60–61/s to 0 on paused Factory/Yard; stream frames now wake data. |
| 4 — GPU and owner wait | 2026-11-12 | Find the late-frame source; reject a slicing fix that only moves the wait | Yard at 10× remained about 59 fps; sliced vs base late work was 4.9% vs 3.9% and 6.2% vs 4.0%. |
| 5 — Yard | 2026-11-12 | Shrink recurring sort, paint, and recorder work | Clean mini pair: late work 4.9% to 3.1%; work p99 moved from 24–48 ms to 21.5–22 ms. |
| 5 — Factory board | 2026-11-12 | Claim the GPU once and repaint changed marks | Busy board improved from 55.6 fps (one window 42.1) to 59.4–59.7 fps; recorded replays fell to 0/s. |
| 6 — idle | 2026-11-12 | Keep timer-only canvases on Core Graphics and reduce Live's timer payload | Idle Factory 1.81/1.70% to 1.25/1.23%; Yard 1.41% to 0.89%; Live stayed about 1.85%. |
| 7 — touched text (Exact patch 0005) | 2026-11-12 | Limit macOS text refresh to paragraphs touched by safe words-only batches | Live idle with timers 1.86% to 1.44%; busy Live at 10× 16.5% to 13.9% CPU; 0 pixels differ. |

The first source calls the initial work the `idle` pass, not “pass 1”; it is listed first because the source labels its follow-up “idle pass 2.” The heap-cap and OOM work predates this sequence and is covered in the [incident report](../../reports/incidents/2026-11-11-macos-oom.md).

## Pass 1 — initial idle pass

**Symptom.** A quiet view still consumed CPU, and covered canvases continued to receive work. On a frozen fixture fleet with three visible running timers, mini CPU was 10.9% Live, 11.4% Factory, and 13.0% Yard.

**Cause and evidence.** This was visible in CPU and frame counters rather than a sampled call tree: the canvases and periodic clock were doing work when their pixels had not changed. In particular, the covered Yard could lay out its scene again after an unchanged pick set, and the older Factory surfaces could mount on macOS.

**Changes.** [`8efbba8`](https://github.com/couplet-physical-ai/switchyard/commit/8efbba8) stopped macOS from mounting the old Factory versions. [`51959e7`](https://github.com/couplet-physical-ai/switchyard/commit/51959e7) made `ov.tick` the redraw key and paced the pulse at 250 ms only while something moved, otherwise once a second. [`a3a7e58`](https://github.com/couplet-physical-ai/switchyard/commit/a3a7e58) relaid out the Yard only when its picks changed. [`054d8cc`](https://github.com/couplet-physical-ai/switchyard/commit/054d8cc) and [`ff823ac`](https://github.com/couplet-physical-ai/switchyard/commit/ff823ac) made the clock follow what was on top.

**Proof.** In the same frozen-fleet setup, idle CPU became 4.65% Live, 6.55% Factory, and 4.77% Yard. Live and Factory had 0 display-link callbacks while idle. Yard still drew its 1 Hz timer frame at 60 fps timing (p99 16.5–17 ms), so this was a large reduction, not the final idle target.

## Pass 2 — make a timer tick cheap

**Symptom.** Even with the frame loop asleep, a visible timer cost about 2–3% CPU per tab. Live rebuilt its entire feed every second, and the Factory repainted about 600 marks for a timer change.

**Cause and evidence.** `tools/turns.ts demo` measured the old `nowFeed` answer at 6.1 ms in Bun, over the 4 ms per-turn target; on a slow Mac, the same work could consume most of a Hermes turn. A Factory timer changed only a few glyphs, but the board repainted the whole scene.

**Changes.** [`1020abb`](https://github.com/couplet-physical-ai/switchyard/commit/1020abb) re-stamped Live's already-built rows and split a full rebuild into two turns. [`67b5766`](https://github.com/couplet-physical-ai/switchyard/commit/67b5766) repainted only changed Factory marks. [`2a85cee`](https://github.com/couplet-physical-ai/switchyard/commit/2a85cee) made Yard header and engine panels redraw only when their text changed. [`6a0b8e1`](https://github.com/couplet-physical-ai/switchyard/commit/6a0b8e1) shortened interpreted snapshot parsing; [`4a9588e`](https://github.com/couplet-physical-ai/switchyard/commit/4a9588e) avoided re-measurement and stale transits when returning to Factory.

**Proof.** A clock-only Live re-stamp took 0.03–0.05 ms in Bun; a full demo rebuild became 2.3 + 2.0 ms in two turns, from 6.2 ms in one. The board's timer tick repainted 7 of 706 marks (0.14%); its pixels matched a whole paint. On the mini, 1440×900, load average 0.9–1.8, LIVE ticking CPU was 3.28→2.86% for Live, 4.44→1.88% for Factory, and 3.60→3.05% for Yard. Pass 2 reduced work, but an idle 1 Hz pulse still left a CPU floor.

## Pass 3 — the shell pulse sleeps

**Symptom.** Pass 2 left about 2.0–2.7% CPU even when nothing changed. The one-second `overview(clockMs)` pulse still re-asked the overview and invalidated every consumer of `ov`.

**Cause and evidence.** The web profile showed 60 style recalculations per second on timer-only or paused views. In a 20-second frozen-mock window, the base asked for Live's overview 20 times and `nowFeed` 19 times; Factory asked for `overview` and `f3Stats` 20 times each. These are wake/re-evaluation costs, not canvas animation that corresponds to work.

**Changes.** [`262f5bc`](https://github.com/couplet-physical-ai/switchyard/commit/262f5bc) made the 250 ms pulse active-only, let stream frames wake the overview, and used one-shot wakes for minute/age changes. [`075321b`](https://github.com/couplet-physical-ai/switchyard/commit/075321b) completed the shell changes. [`91aff90`](https://github.com/couplet-physical-ai/switchyard/commit/91aff90) added a timer-only `nowTick` answer: 8.7 KB on the recorded fleet instead of the whole 122 KB feed each second. The parallel Yard work [`c901879`](https://github.com/couplet-physical-ai/switchyard/commit/c901879) and [`ea8fa8a`](https://github.com/couplet-physical-ai/switchyard/commit/ea8fa8a) sent only changed canvases/parts and banded changed rows.

**Proof.** On Chromium with three running timers, paused Factory and Yard fell from 60 recalculations/s to 0; main-thread script/task time fell from 15.1/30.7 ms/s to 2.6/8.6 for Factory and from 13.9/29.5 to 2.4/8.0 for Yard. Live's timer-only answer asked only for `nowTick`. On the Mac mini at 10×, the earlier base was 51.5 fps with p99 frame intervals of 48–96 ms; the p3 Yard tree reached 56.8–57.7 fps, p99 24–48 ms, and about 19–20 ms median work. That was an improvement but still missed the frame target; pass 4 profiles the remaining wait. The pass did not record a direct Mac mini base/head pair for the idle-pulse change. The 0.1.6 release note later reported about 1.3–2.1% idle CPU per tab.

## Pass 4 — profile the native frame and owner wait

**Symptom.** The busy Yard still missed the 60 fps target at 10×. On the mini, an earlier base measured 51.5 fps with p99 frame intervals of 48–96 ms; the pass-3 Yard measured 56.8–57.7 fps, p99 24–48 ms, with about 90% of frames late and roughly 19–20 ms median work.

**Cause and evidence.** `EXACT_CANVAS_STATS=1` showed the busy Yard was already on Vello: 3–66 GPU replays/s at 2.2–4.0 ms each and 0 recorded/s. A 22-second main-thread sample had 10,755 of 12,517 samples idle, but 637 of 787 native timer deliveries waited synchronously for the owner thread; 269 frame ticks also waited on it. On the owner, timer turns spent 501 samples in canvas drawing (419 JavaScript, 68 full collections between calls). A late display-link callback was waiting for the timer's commit, not rasterizing the canvas.

**Changes.** The experiment [`853ba6e`](https://github.com/couplet-physical-ai/switchyard/commit/853ba6e) sliced the Yard info draw. It cut a devbox no-JIT 10× panel estimate, but did not reduce native frame waits. [`f627747`](https://github.com/couplet-physical-ai/switchyard/commit/f627747) reverted those slices after the mini A/B. The mock's stream-path correction remained, and [`fc37169`](https://github.com/couplet-physical-ai/switchyard/commit/fc37169) shortened paused wake intervals.

**Proof.** On interleaved 30-second mini windows with the recorded fleet at 10×, base/head FPS was 58.97/59.22 and 59.09/59.08. Late work was 32/824 (3.9%) vs 41/836 (4.9%) in one pair, and 31/779 (4.0%) vs 52/836 (6.2%) in the other. Slicing did not help, so it was reverted. The useful result of this pass was the profile: reduce or decouple synchronous owner turns rather than move the same work into later frames. That profile became an upstream write-up for Exact, [`app/upstream/exact-macos-frame-waits.md`](https://github.com/couplet-physical-ai/switchyard/blob/main/app/upstream/exact-macos-frame-waits.md): the main thread waits on the owner's timer turn and on a full collection between calls, with file and line references at the Exact pin and two proposed changes.

## Pass 5 — Yard timer and recorder work

**Symptom.** The display link was late during busy Yard updates even though the main thread was mostly idle. In a clean 10× mini pair, the head still had late work and frame p99 above 17 ms.

**Cause and evidence.** The pass-4 `DataSource::draw` sample had 491 samples: about 200 in `Array.prototype.sort`, including 74 in `localeCompare`, 37 in `Collator::create`, and 29 in `Collator::compare`; about 140 were GC, and only 13 were host text measurement. Hermes creates an `Intl.Collator` for each `localeCompare`. The Yard sorted all repos again on nearly every stream frame. Repeatedly painting unchanged main-line rows and allocating recorder shapes added work too.

**Changes.** [`61fa9ee`](https://github.com/couplet-physical-ai/switchyard/commit/61fa9ee) keyed unchanged Yard parts and main-line rows. [`0a008d1`](https://github.com/couplet-physical-ai/switchyard/commit/0a008d1) reused shared collators, kept repo order, and keyed queue rows. [`78d8477`](https://github.com/couplet-physical-ai/switchyard/commit/78d8477) ranked only the first 120 repos and kept pipeline verdicts; [`e5d51d6`](https://github.com/couplet-physical-ai/switchyard/commit/e5d51d6) also replaced repeated locale sorting in the shared flow model with a shared collator. [`992b273`](https://github.com/couplet-physical-ai/switchyard/commit/992b273) cached native font parsing/quoting. [`088e0e8`](https://github.com/couplet-physical-ai/switchyard/commit/088e0e8) compared the Yard scene signature by its parts. [`5f65381`](https://github.com/couplet-physical-ai/switchyard/commit/5f65381) added the one-radius `roundRect` fast path. See [Exact patches](exact-patches.md) for the native patches.

**Proof.** In Bun without JIT, `--hermes --fed`, 10×, Yard info draw p50 fell from 3.12 to 1.73 ms; allocation fell from 709 to 255 KB/draw. Yard live p99 fell from 4.75 to 2.27 ms. The clean mini pair (load 3–6) reduced late work from 39/798 (4.9%) to 25/806 (3.1%) and work p99 from 24–48 ms to 21.5–22 ms. Frame p99 and missed slots did not move: the remaining long gaps were callback gaps with little app work. The pass improved owner work but did not meet 60 fps / 17 ms p99 on that loaded mini.

## Pass 5 — Factory board and reconnects

**Symptom.** The 10× Factory board had 0.2–0.8 second stalls. The base mini run was 55.58 fps; a 12-second window fell to 42.06 fps with frame p99 384–768 ms.

**Cause and evidence.** The first paint on a new bitmap did not claim Vello because an idle board asked for no next frame. Core Animation then recorded/replayed as many as 64 kept partial-paint lists on the main thread during a transit. Separately, changes in mark count forced a full 100–180 KB board list through Exact's recorder. A refused live stream also retried by rebuilding the world and replaying Live row entrances.

**Changes.** [`f33ac50`](https://github.com/couplet-physical-ai/switchyard/commit/f33ac50) made each board layer request one harmless follow-up frame on a fresh bitmap so the host could select Vello. [`bdfb9f7`](https://github.com/couplet-physical-ai/switchyard/commit/bdfb9f7) aligned mark lists across insertions/removals instead of repainting the whole board. [`69b0626`](https://github.com/couplet-physical-ai/switchyard/commit/69b0626) clipped large dirty sets to tile runs; [`b4571c6`](https://github.com/couplet-physical-ai/switchyard/commit/b4571c6) grouped non-overlapping words by font and colour. [`9648d25`](https://github.com/couplet-physical-ai/switchyard/commit/9648d25) made stream retry independent of the snapshot generation so it could resume without rebuilding the world.

**Proof.** On the mini at 10×, the board reached 59.39–59.70 fps, with 1–2 missed slots per roughly 195-slot window and 0 recorded replays/s (the base had 0 GPU and about 40–45 recorded/s). Frame p99 was 16.5–48 ms across the two head runs; the remaining 24–48 ms work records were GPU replay bursts. In the no-JIT devbox bench, 84 board paints at 10× (81 partial) differed from full repaints by 0 pixels; grouped-word output also differed by 0 pixels over 78 paints. On a refused-stream soak, frames fell from 68 in 70 seconds to 0, CPU from 1.72% to 0.08%, and snapshot fetches from 7 to the initial 2.

## Pass 6 — idle canvases and Live's one-second answer

**Symptom.** Pass 5 fixed busy Factory stalls, but timer-only idle was above the 1.5% target: Factory 1.93%, Live 2.14%, and Yard about 1.7%. Factory's one-second timer caused a whole Vello replay (4.7–7.9 ms); Live's data answer itself was only about 0.005 ms in Bun.

**Cause and evidence.** A 10-second mini sample of Live idle with timers found the main thread at 57% of non-waiting samples; `Presenter.refreshVisibleText` alone was 30% of total process samples because each batch walked every text candidate near the viewport. The owner thread was 35%; half of its samples wrote the 8.5 KB `nowTick` answer through Exact's kept-reply path. Each second also wrote that answer to disk and synced it because its arguments indirectly read device state.

**Changes.** [`5a3001c`](https://github.com/couplet-physical-ai/switchyard/commit/5a3001c) kept the board and Yard info canvases on Core Graphics and left the moving board layer on GPU; `boardAt` now asks only for values that can change on a second. [`a9ae29c`](https://github.com/couplet-physical-ai/switchyard/commit/a9ae29c) quantized progress rings to visible device pixels. [`81f4ba5`](https://github.com/couplet-physical-ai/switchyard/commit/81f4ba5) kept unchanged Live rows by identity, reduced the timer answer from 543 values / 8.5 KB to 250 / 4.5 KB, and made it independent of the persistent store so it was not written each second. The first Live feed was also applied in small groups of four rows every 40 ms instead of one +1,367-view batch.

**Proof.** Interleaved mini idle windows with three visible timers had 0 canvas frames in every tab. Factory CPU fell from 1.81/1.70% to 1.25/1.23%; Yard from 1.41% to 0.89%. Live stayed at 1.86/1.84% from a base of 1.81/2.18%, so the 1.5% target was not met. Paused Live was 0.11% with 0 frames. At 10×, Factory held 59.69 fps and Yard 59.54 fps; the Live connect hitch's maximum work fell from 96–192 ms to 14.5–15 ms. The remaining Live cost was Exact's text pass; pass 7 addresses it with Exact patch 0005.

## Pass 7 — touched-text host pass

**Symptom and profile evidence.** Pass 6 left Live idle with timers at about 1.85%, above the 1.5% target. Its Live-idle sample with three running timers found `Presenter.refreshVisibleText` in 23 of 77 non-waiting process samples (about 30% of the process). Every batch with operations dropped the text viewport index, so one timer label changing once a second rebuilt the index (a `convertRect` per shown paragraph) and walked every paragraph within 1,600 points of the viewport, asking four backing-scale and three ancestor questions of each. For a small label, which is most of Live, every answer was "nothing to do".

**Change.** [`7a4c7fa`](https://github.com/couplet-physical-ai/switchyard/commit/7a4c7fa) adds Exact patch 0005. A batch is words-only when every operation sets a paragraph's runs, sets or clears only `text`, `title` or `accessibilityLabel`, or repaints an svg, animation or canvas. After such a batch the macOS presenter keeps the index and refreshes only the touched paragraphs, provided no text work is owed and no view moved, resized, mounted or reparented, and no document scrolled or changed scale since the index was built. Every other batch takes the full pass as before. See [Exact patches](exact-patches.md).

**Proof.** [`4c4cf53`](https://github.com/couplet-physical-ai/switchyard/commit/4c4cf53) records the mini run (quiet, load 1.1–2.3, interleaved dev builds, 56–57 s windows; head = pass 6 plus 0005, base = pass 6):

| | Base | Head |
|---|---|---|
| Live idle, timers ticking (ABBA ×3) | 1.66, 2.05, 1.88 → **1.86%** | 1.43, 1.40, 1.48 → **1.44%** |
| Board idle, timers | 1.42% | 1.40% |
| Yard idle, timers | 0.89% | 0.89% |
| Live paused (×3, 0 frames both) | 0.23% mean | 0.19% mean |
| Live busy 10×, CPU | 16.46% | 13.90% |
| Board busy 10× (×2) | 59.38 / 59.39 fps | 58.81 / 59.38 fps |
| Yard busy 10× (×2) | 59.30 / 59.22 fps | 59.45 / 59.36 fps |

The Live-idle profile went from 5 `refreshVisibleText` samples to 0 and from 38 to 20 active main-thread samples. Window-server pictures of a deterministic drive (start, two timer ticks, a scroll, a tick after it) differed in **0 of 1,370,880 pixels** base vs head, and base vs a second base, at every step. The drive stopped at a held wheel scroll, which the mini's terminal could not post; held scroll, resize and new rows take the full pass, which `TextTouchedMacTests` (2/2) covers. Of Exact's 23 XCTest classes only `PixelGridMacTests` failed, the same way on base (the mini drives a 1× display). The macOS suite passed 38/0. Verdict: 0005 passes and ships in 0.1.8.
