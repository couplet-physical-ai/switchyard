# Switchyard client: performance

Numbers for the Yard (DESIGN.md, "Rendering"), measured 2026-11-10/11 on branch
`sy/client-yard`. 1× is the real-data fixture server (392 repos, 237 apps, 5 Woodpecker agents,
GitHub Actions, one Roadrunner queue). 10× is stress mode: the renderer synthesizes a fleet ten
times as large (4,000 repos, 60 sources, 40 hosts / 160–170 slots, 2,370 apps, 10,000 packets)
from typed arrays, without holding ten times the entities.

## How to measure

| Host | Tool | What it reads |
|---|---|---|
| macOS (Metal) | `tools/perf-drive.mjs macos … "perf frames live 6000"` | Exact's frame health on a normal event loop (`EXACT_AGENT=live`): display-link callbacks, FPS, missed slots on the 60 Hz grid, and per-frame *work* (from the frame's timestamp until its callback returned and the owner work it sent landed). Drives use a named, emptied store (`--storage yard-perf --reset-storage`) and connect by real taps; any `clock` op would put the app on the agent's virtual clock, and then frame health reads `virtual-clock` and nothing is measured. |
| Web Chromium | `tools/perf-web.mjs [--server URL] [--stress] [--scale 2]` | Playwright's Chromium on a free `requestAnimationFrame` loop (fps, median and p95 interval), and CDP `Performance.getMetrics` over the window: `ScriptDuration` (all JavaScript) and `TaskDuration` (all main-thread work) divided by frames. |
| Either | the HUD (⌘⇧D, or `hud` in the status line) | fps and frame interval from `frame.time`, the cost model's draw estimate, quality level, LOD histogram, packet counts, info-layer redraw rate and cost. The draw figure is an *estimate* (calibrated per executor: Hermes or JIT); a `draw` may not read a clock. |

The build Mac is shared. Every macOS row says what else was running.

## macOS: Mac mini (Apple silicon), development build, Metal

The launch log reads `canvas gpu: vello loaded` (the Metal toolchain build); there is no
`no Canvas 2D GPU module` line. Every macOS number below was taken on that build, from a clean
build directory; earlier CPU-canvas numbers are discarded.

**Run A**, 19:09–19:12 mini time, load average 3.6–7 on 12 cores (other workers' builds and drives):

| Window | Fleet | HUD | FPS | Missed of requested | Work median | Work p99 |
|---|---|---|---|---|---|---|
| 1440×900 | 1× | on | 59.33 | 4 / 360 | 8.5–9.0 ms | 20.5–21.0 ms |
| 1440×900 | 10× | on | 59.17 | 5 / 361 | 2.5–3.0 ms | 14.0–14.5 ms |
| 1440×900 | 1× | off | 59.19 | 1 / 74 ¹ | 8.5–9.0 ms | 17.0–17.5 ms |
| 1440×900 | 10× | off | 59.67 | 2 / 360 | 2.5–3.0 ms | 3.5–4.0 ms |
| 2880×1800 | 1× | on | 59.34 | 4 / 361 | 8.0–8.5 ms | 16.0–16.5 ms |
| 2880×1800 | 10× | on | 59.33 | 4 / 360 | 2.5–3.0 ms | 2.5–3.0 ms |
| 2880×1800 | 1× | off | 58.35 | 3 / 109 ¹ | 5.0–5.5 ms | 14.5–15.0 ms |
| 2880×1800 | 10× | off | 58.83 | 7 / 360 | 3.0–3.5 ms | 7.0–7.5 ms |

¹ Without the HUD, the live layer sleeps when nothing moves (no traveller, no effect, no fade),
so a 10 s window at 1× held only 74 (1440) or 106 (2880) frames of work: the rest were idle.

**Run B**, 19:28–19:42, load average 4–7, while another team's GPU-heavy `emu-desktop` perf run
used 190–205 % CPU:

| Window | Fleet | HUD | FPS | Missed | Work median | Work p99 |
|---|---|---|---|---|---|---|
| 1440×900 | 1× | on | 58.33–58.50 | 9–10 / 360 | 20.5–22.5 ms | 24–48 ms |
| 1440×900 | 10× | on | 59.83 | 2 / 359 | 0.5–1.0 ms | 17.0–17.5 ms |
| 1440×900 | 1× | off | 57.12 | 10 / 209 | 21.0–21.5 ms | 24–48 ms |
| 1440×900 | 10× | off | 56.00 | 24 / 360 | 0.5–1.0 ms | 24–48 ms |

An A/B in the same minutes, with the build from before the last yard changes (commit
`f9c6bb7`), read the same 1× work (median 20.0–21.0 ms, 59.83 FPS): Run B's slower 1× work is the
machine, not a regression.

The frame rate held 56–60 FPS in every run, 1× and 10×, at both sizes. Pinning the quality
ladder at each level (q0 full … q4 survival) at 1× moved the work median by under 1 ms (11–12 ms in
that run, at load 6–8): at 1× the cost is not in what the ladder controls (packets, glow, labels)
but in the frame itself (four stacked full-window canvases, the data module's turn, Vello's
encode). In stress mode the ladder goes to q3 (trains) on its own and the work is lower than at
1× (2.5–3 ms): 10,000 packets cost about 200 train sprites, the lanes are cells (no rings to
stroke), and labels are off.

## Web: Chromium (Playwright's headless shell, SwiftShader; no GPU on either host)

`tools/perf-web.mjs`, 8 s windows:

| Host | Window | Fleet | FPS | Frame median / p95 | JS per frame | Main-thread work per frame |
|---|---|---|---|---|---|---|
| devbox (Linux) | 1440×900 @1× | 1× | 59.9 | 16.7 / 16.8 ms | 0.18–0.52 ms | 0.72–2.24 ms |
| devbox | 1440×900 @1× | 10× | 59.9 | 16.7 / 16.7 ms | 1.62 ms | 3.12 ms |
| Mac mini | 1440×900 @1× | 1× | 59.8 | 16.7 / 16.8 ms | 0.18 ms | 0.78 ms |
| Mac mini | 1440×900 @1× | 10× | 59.8 | 16.7 / 16.8 ms | 2.39 ms | 4.16 ms |
| Mac mini | 1440×900 @2× (2880×1800 px) | 1× | 59.4 | 16.7 / 16.7 ms | 0.17 ms | 1.69 ms |
| Mac mini | 1440×900 @2× | 10× | 60.0 | 16.7 / 16.7 ms | 0.55 ms | 2.39 ms |

JS per frame is an average over every frame in the window, idle ones included (the live layer
sleeps when nothing moves). The Exact web agent under `--timing platform` paces a headless page at
about 24 FPS whatever it draws (23.7 at 1×, 22.6 at 10×, 24.2 paused with nothing moving), so
agent drives are not a frame-rate measure; `perf-web.mjs` runs outside it.

## The budget at work

- Frame budget: 16.6 ms, the yard's draw under ~6 ms (`budget.ts`). The estimate is a cost model
  (operations, arcs, texts, sprites; prices per executor) scaled by a gain that rises when frames
  are missed while the yard's own share is real (over ~2 ms). Missed frames while the yard draws
  next to nothing are someone else's and never step the ladder down.
- The info layer is a cache: a redraw (mount, resize, new data) is a hitch, not a load. It shows
  in the HUD (`info 4/s ~0.2 ms`; ~15 ms for a 4,000-cell heatmap in stress) and steps the ladder
  only if it redraws more than 8 times a second. The heatmap redraws at most once a second, the
  main-line rows at most 2.5 times (1 in stress).
- Source turns stay under Hermes' 100 ms: `connect` never builds the scene (the first draw does),
  and the built-in demo seeds its fleet in ~165 steps (`server/seed.ts` `seedFleetSteps`, the same
  fleet as `seedFleet`); before that, `connect` took 99–119 ms on the loaded build Mac and the
  demo failed to start there.
- Memory: one world (`Timeline.world`). The packet pool is typed arrays allocated once at start,
  sized for stress (12,288 packets, route and template arenas, spatial cells): about 4 MB of the
  data module's Hermes heap, and no allocation per frame. Stress mode adds a few kilobytes (repo states, app
  health, slot occupancy), never copies of entities.
- Heap cap (macOS): the data module's Hermes heap is capped at 512 MiB, not Exact's default
  64 MiB (`scripts/exact-patches/0001-heap-512m.patch`, README "Exact patches"); a GC OOM there
  is still fatal (`hermes_fatal`, no recoverable path in the prebuilt Hermes), so the cap is a
  stopgap, not a budget: the live set should stay far under it.

## Factory route (DESIGN.md "Routes and discovery")

Measured 2026-11-11 03:40–04:45Z on `sy/fab-base`. 1× is the live server on each host's
`127.0.0.1:8090` (394 repos, 239 apps); 10× is stress mode (`src/factory/stress.ts`: census ×10,
engines ×10 slots, a 2,390-block city, 3,000 synthesized crates on the floor's routes).

**How.** Web: `tools/perf-web.mjs [--stress] [--hud] [--pan] [--scale 2]` (Playwright headless
shell, SwiftShader, 8 s windows; `--hud` keeps the live layer drawing every frame, the worst
case). macOS: `tools/perf-drive.mjs macos --storage sy-fab-<n> --reset-storage --size <W×H> …
"perf frames live 6000"` (EXACT_AGENT=live, real taps, no clock op), calm first, then with the
HUD on. Draw costs: `bun tools/factory-bench.ts [demo|fixtures] [--stress] [--hermes]` (a
recording ctx; `--hermes` prices the ladder as the macOS data module does).

**What the budget does on the floor.** The static floor (`factoryFloor`) repaints only when its
key moves (camera, fleet shape, apps' health, cars, quality ≥ 3): Contract re-hands it its
arguments every 250 ms, equal or not, and those are skipped. Geometry is batched (one path per
face and colour class), off-screen items, rows and hits are culled, the city has four LODs by
block size, crates merge into ×N trains from q3, labels thin per rung. Calm (nothing travelling)
the live layer sleeps and a 125 ms Contract pulse wakes it for the belts and the 1 Hz beat (asking
for frames and drawing nothing stalled the macOS display link: 47–49 FPS). Bun, fixtures, 1×:
live draw 0.15 ms median, 1,100 canvas calls a loud frame (2,500 before), 80 of 600 frames drawn
calm; floor 0.25–0.45 ms (Hermes estimate 18 ms full, 12 ms low detail).

| Host | Tree | Window | Fleet | HUD | FPS | Work / JS per frame | Rung |
|---|---|---|---|---|---|---|---|
| web (devbox) | before (255f81c) | 1440×900 @1× | 1× | off | 59.8 | JS 7.0 · task 10.7 ms | — |
| web | before | 1440×900 @2× | 1× | off | 56.0 | JS 6.9 · task 12.8 ms | — |
| web | fab-base (pre-merge) | 1440×900 @1× | 1× | off | 59.9 | JS 2.6 · task 4.1 ms | q0 |
| web | fab-base | 1440×900 @2× | 1× | off | 59.9 | JS 0.9 · task 2.2 ms | q0 |
| web | fab-base | 1440×900 @1× | 10× | off | 59.9 | JS 5.2 · task 8.0 ms | q3 |
| web | fab-base | 1440×900 @2× | 10× | off | 59.8 | JS 5.1 · task 10.4 ms | q3 |
| web | fab-base | 1440×900 @1× | 1× / 10× | on | 59.9 / 59.8 | JS 6.2 / 6.5 ms | |
| web | fab-base | 1440×900 @1×, panning | 1× / 10× | on | 59.9 / 59.8 | task 12.8 / 12.7 ms | |
| macOS Metal | fab-base (pre-merge, p4) | 1440×900 | 1× | off / on | 60.0 / 59.2 | work median 7.0–9.0 ms | q0 calm |
| macOS | fab-base (p4) | 1440×900 | 10× | off / on | 58.7–60.0 / 59.5 | 9.5–11.5 ms | q4 |
| macOS | fab-base (p4) | 2880×1800 | 1× | on | 59.5 | 8.5–9.0 ms | |
| macOS | fab-base (p4) | 2880×1800 | 10× | off / on | 55.3–59.7 / 59.8 | 9.5–11.0 ms | q4 |
| macOS | merged with fab-lens (p6) | 1440×900 | 1× | off / on | 33.9–36.5 / 31.2 | 24–48 ms | q4 |
| macOS | merged (p6) | 1440×900 | 10× | on | 31.0 | 24–48 ms | q4 |

The merged tree (the lenses' per-frame layers under and over the live layer: ~1,400 more canvas
calls a frame, Hermes estimate 8.5 ms at q4 at 1×, 10.8 ms at 10×) halves the Mac's frame rate:
**the 60 fps target is not met on macOS after the merge**, and the ladder cannot buy it back (the
lens layers do not step with it). A pre-merge run minutes earlier (p5) already read work 24–48 ms
at 56 FPS on the same build that read 9–11 ms in p4, so part of it may be the machine; the merged
build's own estimate says most of it is not. Next: put the lens layers on the ladder (and cache
their static parts on the floor layer), then re-measure.

### Factory B, wave B (fab-w7): 60 fps at full quality on the mini

Measured 2026-11-11 06:00–07:45Z on `sy/fab-w7` (merged with main `c1116e3`, W3's lenses in).
"Before" is `c1116e3` itself. 1× is the recorded server on each host's `127.0.0.1:8090` (394
repos, 239 apps); 10× is stress mode. The mini: 1440×900, Metal (Vello), load average 2.1–3.1,
no other worker on it, `/tmp/sy-fab-w7-run2.sh` (a perf drive: connect by taps, 14 s from the
intro on, HUD on, 3 × `perf frames live 6000`, 10× on, 3 more). Web: `tools/perf-web.mjs`,
8 s windows.

| Host | Tree | Fleet | HUD | FPS (mean of the window) | Frame time median | Work median (late) | Rung |
|---|---|---|---|---|---|---|---|
| macOS Metal | before (`1b5ca6b`, W3 not in) | 1× | off / on | 54.4–56.6 | — | 24–48 ms (246 of 265 late) | q4 |
| macOS Metal | before (`c1116e3`, the overseer's run) | 1× / 10× | on | 55–56 / ~53 | — | — | q4 / q4 |
| macOS Metal | **after (`3aa1dd0`)** | 1× | on | **58.3–59.7** (t8 59.2–59.7, t9 58.3–59.0) | **16.5–17.0 ms** | 10.5–11.0 ms (0–2 late) | **q0** |
| macOS Metal | after | 10× | on | **59.0–60.0** | 16.5–17.0 ms | 11.5–12.5 ms (0 late) | q4 |
| web | before (`c1116e3`) | 1× | off / on | 59.9 / 59.9 | 16.7 ms | JS 1.87 / 6.92 ms a frame | — |
| web | before | 10× | off / on | 59.9 / 59.9 | 16.7 ms | JS 6.53 / 7.32 ms | — |
| web | **after** | 1× | off / on | 59.9 / 59.9 | 16.7 ms | JS 2.14 / 2.73 ms | q0 |
| web | **after** | 10× | off / on | 59.8 / 59.9 | 16.7 ms | JS 3.49 / 3.66 ms | q4 |

On the mini, the remaining 1–10 missed slots per 360 come with no late work of ours (work ends
5–6 ms before the deadline). Every run's first window (connect + intro + load) reads 58.2–58.8.

**Where the native frame went.** Two causes, found with `EXACT_CANVAS_STATS=1` and
`factory-bench --real` (Exact's own recorder):

1. **The live canvas never reached the GPU.** The stats read `0.0 gpu/s · 56 recorded/s`: Core
   Animation recorded and replayed the whole live list on the main thread every frame. The macOS
   host gives a canvas to the Vello module only when its first draw after a fresh bitmap (mount,
   resize) asks for another frame. A calm floor's first draw didn't ask. Fix: `gpuClaim` in
   `factory.ts` (both canvases ask once after mount or resize). After the fix the stats read
   `56–104 gpu/s, 0.0 recorded/s`. Draw estimate 5.97 → 4.69 ms, 54–56 → 56–58 fps.
2. **The cost is the list's bytes, not its calls.** On native, the data module (Hermes) runs
   Exact's JS recorder, which serializes every call into a byte list and base64s it for the host:
   about 0.05 ms per KB, with a cliff near 130 KB a frame. The merged live frame was ~146 KB: under
   (the lenses' glows, smoke, beacons) 59 K, labels 31 K (14.5 K of them `font`), floor 18 K, top
   10 K, strip 8 K, HUD 7 K.

**What each fix bought** (`bun tools/factory-bench.ts <src> --hud --real --hermes`, live KB a
drawn frame; the mini column is the drive right after the fix):

| Fix | demo 1× q0 | fixtures 1× q0 | demo 10× (auto rung) | Mini 1× |
|---|---|---|---|---|
| before (`c1116e3`) | 142.0 KB | 127.8 KB | 144.7 KB at q4 (1,091 KB at q0) | 55–56 fps, q4 |
| GPU claim (both canvases) | — | — | — | 56–58 fps, work 24–48 → 18–19 ms |
| top canvas: words and chrome retained (`cache.ts`) | 87 KB + ~1 KB top | | | 59.7–59.8 fps, q0 |
| the ladder no longer learns from the intro | | | | holds q0 (it had settled at q4) |
| circles as 3/2 cubics (`fastArcs`) | 69.7 KB | 51.7 KB | 74.4 KB at q4 (203 KB at q0) | work 16–16.5 → 13.5–14 ms, late 67 → 3 of 360 |
| the floor's ladder judges misses by its own share (`FacBudget`) | | | | no more q0 ↔ q2 flapping: q0 for the whole drive |

- **cache.ts `Retained`**: groups, labels, the journey, tags, drawer, hover, legend, strip,
  controls, `lens.top` and the HUD now draw into a plain-JS recording (state, path hash and
  device box per item). Its `flush` diffs the item hashes between frames and repaints only the
  dirty boxes on a new `factoryTop` canvas (pointer-events none, over `factory-live`). A frame
  where nothing changed sends nothing. It falls back to a whole repaint after a size change, a
  clip, or more than 50 % dirty. While a lens other than the pipeline lens is open, its veil
  composites over everything, so the words go back to the live canvas. Partial vs whole repaints
  of 7 driven states (load, hover, zoom, lens): 0 pixels differ outside the HUD's own numbers.
  The top canvas sends 0–13 KB a frame (mean 1.5 KB).
- **`fastArcs`**: Exact's recorder draws a full circle as a line to its start plus four cubics
  (248 B). A full circle or ellipse is now 3 cubics, or 2 under 10 device px (worst radial error
  0.15 % / 1.8 %, under 0.1 px at those sizes), and skips the line when the path is already at
  the start: 168 / 112 B. Partial arcs still go to the recorder.
- **The ladder.** The coffee check's intro (`introHolds`: its 10 s, a replay, or at most 12 s
  waiting for a digest) no longer counts toward the ladder, which restarts from q0 when the intro
  ends. On the mini the load's misses had settled it at q4 for good. `FacBudget` counts a missed
  frame against the floor only while the floor's estimate is over 4.5 ms (¾ of the budget). At
  q0 the floor is ~2.3 ms, and the host's few misses a minute had been stepping it down. Every
  rung change is logged (`factory: quality qA → qB at … · est … (live N ops, top M ops) …`).
- **Calm frames.** `tools/factory-perf.mjs` (new) compares calm (the frozen fixtures: only the
  belts and the 125 ms pulse) with loud (the demo): live canvas calls a second, **calm 13,140 vs
  loud 124,380 = 10.6 %** (≤ 15 %). The calm floor draws 80 of 600 frames. The script exits 1
  when the ratio goes over 15 %.

| Window | Live frames drawn | Live calls/s | Top calls/s | Live KB per drawn frame | Rung |
|---|---|---|---|---|---|
| calm 1× (fixtures) | 80 / 600 | 13,140 | 300 | ~45 | q0 |
| loud 1× (demo) | 580 / 600 | 124,380 | 1,140 | 69.6 | q0 |
| calm 10× | 596 / 600 | 221,580 | 840 | 96.5 | q0 (Bun: Hermes q4) |
| loud 10× | 580 / 600 | 233,880 | 1,140 | 108.7 | q0 (Bun: Hermes q4) |

**Motion (§G).** Slats are now `#252529`, OKLab lightness +0.083 over the belt (was +0.10).
Belt speed stays `6 + 10·log2(1 + rate/60)` px/s (`motion.ts beltSpeedPx`). Above 24 crates in
flight, crates ride as trains with a ×N badge on any rung (`crates.ts TRAINS_OVER`; before, only
q3+). Overlapping badges keep the biggest. One 1 Hz beat and the arrival ripples are unchanged
(`motion.ts`).

**Turns** (`bun tools/turns.ts … --max 4`): demo 422 turns, longest 1.75 ms; fixtures 152 turns,
longest 1.86 ms.

**On the integrated tree** (main `ad8bc31` merged: W1 lanes, W6 engine, W5 city; drive `m1`, 07:54Z):
mini 1× q0 56.5 / 57.2 / 57.7 / 59.5 fps (draw ~1.6 ms, 755 ops, 0 texts on the live canvas),
10× q4 58.5 / 59.0 / 59.2 fps (draw ~3.3 ms). The misses at 1× follow the static floor's repaints
(`floor1/s ~44 ms` on Hermes; the window with `floor0/s` reads 59.5): a floor key that churns
about once a second on a calm fleet. That is the next fix (see below).

### Factory B, wave C (fab-w7b + fab-w7c): the static floor repaints by dirty tiles

The static floor (slab, lanes, belts, docks, the PR yard, the front's boards and roads, the
city's districts) was painted whole on every data change: ~700 KB of recorded calls a repaint,
~48 ms on the mini's Hermes, about once a second on a live fleet. Those were the misses left at
1× on the integrated tree (wave B, above).

**How** (`src/factory/floorcache.ts`). The floor paints into a plain-JS recorder: state, path
segments and device box per item, pieces made on demand. A data repaint is recorded over a few
frames, with the census held still for at most `FLOOR_JOB_MS` = 400 ms. If frames come further
apart, the rest is recorded at once. Then the diff runs: an item counts as kept only when it is
the same bit for bit (head, state, paint, matrix, segments, clip), in the same z order. The
changed pieces mark 16 px device tiles, which are sent in bands under a clip. Repaints are
coalesced to one a second (`FLOOR_COALESCE_MS`). Camera moves, resizes and an interrupted flush
still paint whole. The HUD's third switch cycles `tiles on → whole → off`:
- **on**: dirty tiles.
- **whole**: the same recordings, every repaint sent whole. This is the control.
- **off**: painted directly, as before.

**Correctness: the hard bar.** `bun tools/factory-bench.ts <src> --floor-pixels cpu --floor-exact`
replays every data repaint in headless Chromium with Exact's own web replayer
(`host/web/canvas2d-glue.js`, `tools/floorpix.ts`). It compares the retained canvas with a
full repaint of the same recording.

| Source | Data repaints | Pixels changed outside the repainted tiles | Retained ≠ full, outside every repainted tile | Inside the repainted tiles | Recorder vs direct paint | Exact check |
|---|---|---|---|---|---|---|
| demo | 320 (307 partial, 13 empty) | **0** | **0** | ≤ 11 levels (AA) | 0 px (321) | 0 of 1,902,989 pieces |
| demo `--stress` | 320 (301 partial, 19 empty) | **0** | **0** | ≤ 11 levels (AA) | 0 px (321) | 0 of 2,377,481 |
| fixtures, playing (`--fixtures-live 30`) | 17 (2 partial, 15 empty) | **0** | **0** | ≤ 10 levels (AA) | 0 px | 0 of 104,141 |

These are `--pix-split` numbers: every subpath is rasterized on its own.

- **Unsplit, inside the tiles.** Skia rasterizes a multi-subpath fill as one coverage mask, and
  a clip changes that mask by up to 11 levels at 1–2 px. In the unsplit demo run, 199 of 320
  repaints differ by ≤ 273 px at ≤ 11 levels next to tile edges, and the retained canvas differs
  by ≤ 410 px at ≤ 5 levels. No full repaint changed an untouched pixel.
- **Exact check.** `--floor-exact` checks that every piece on a kept tile is painted bit for bit
  the same in both lists, in order.
- **GPU path.** The agent (GPU) path gives the same results over 120 demo repaints.
- **Stills.** In the browser (`bun exact.mjs agent web --size 1440x900`, demo, the same virtual
  clock, 7 stills from 14.6 s to 37.1 s), tiles `on` vs `whole` differ by ≤ 13 levels, with
  ≤ 23 px over 8 levels, in 5 of the 7 stills. In the last two the runs had drifted apart: one car
  and a few crates are in a different state. Two `on` runs are identical, 0 px.

**Bugs this found and fixed.**

1. **Moved geometry stayed on the canvas.** fab-w7b's "creep carry" kept items that moved less
   than 1/64 px, using a fine hash folded with XOR. Two such pieces cancel in an XOR. The carry
   and its hash are gone; a kept piece is now the same bit for bit (`keepItem`, `sameHead`,
   `sameSegs`).
2. **Edge antialiasing changed with the clip.** Skia antialiases a canvas edge differently when
   the clip's bounds equal the canvas's. The two corner tiles now ride in every band.
3. **Embers painted ungated.** `emberPass` opened only on a census. A second paint after one
   census (a pan, a recording) found it closed and painted the embers ungated at full strength.
   Every floor paint now opens it.
4. **Posts drawn at mixed times.** A recording made over frames read the posts' heights at a
   different instant on each frame. The paint now has one instant (`floorNow`), and heights move
   in 1/8 steps, so a growing post changes the floor about once a minute, not on every repaint.
5. **The floor never repainted on a slow host.** A recording whose frames came ≥ 400 ms apart was
   dropped and started again, every time. Under the agent's stepped clock the floor never
   repainted. The rest is now recorded at once.

fab-w7b's suspected NaN boxes, from typed arrays held across a reallocation, did not survive the
rewrite: every read goes through the list's accessors. A debug counter (`Tiles.nan`) read 0 over
demo, fixtures and stress.

**Bytes a repaint** (`bun tools/factory-bench.ts <src> --frames 3600 --real`, Exact's recorder,
2880×1684):

| Source | Off (painted directly) | Dirty tiles (median / max) | Recorded KB a minute |
|---|---|---|---|
| demo | 702 KB | **40 KB** / 77 KB | 38,617 → 2,795 |
| demo `--stress` | 876 KB | **40 KB** / 77 KB | 49,056 → 2,821 |
| fixtures, playing | 704 KB | 0 (nothing on the floor changed) | 5,635 → 0 |

The floor's paint ms in Bun: p50 14.3 → 0.39 (demo), 18.6 → 0.47 (stress).

**The mini** (2026-11-11 10:30–11:10Z, 1440×900, Metal, `/tmp/sy-fab-w7c-run.sh`: connect by
taps, the HUD on, 3 × `perf frames live 6000` at 1×, 10× on, 3 more). Before is main `4a7fe2d`.
After is `69c45a9`, i.e. main `cbbbae4` plus this wave. Both were measured on a mini with nothing
else of ours on it (load average 1.4–1.7; a mutagen agent and a VM, not ours). The first before
run, with a background Switchyard at ~28 % CPU, read 8090 1× 55.9–56.7 and demo 1× 55.2–57.8.
In the tables below, the first FPS is the window that includes the HUD tap; then the three
6-second windows.

| Tree | Fleet | FPS by window | Work median (late of ~360) | Rung | Static floor (HUD est.) |
|---|---|---|---|---|---|
| before | 8090 1× | 57.6 · 57.2 / 57.0 / 57.5 | 16.0–16.5 ms (116–146) | q0 | `floor1/s ~48 ms` |
| **after** | 8090 1× | **59.7 · 59.7 / 60.0 / 60.0** | **12.0–13.0 ms (2–10)** | q0 | `~1.4 ms` (48 ms only for the first, whole paint) |
| before | 8090 10× | 58.8 / 58.8 / 58.7 | 17.0–17.5 ms (196–204) | q4 | `~31 ms` |
| **after** | 8090 10× | **60.0 / 60.0 / 60.0** | 13.5–14.0 ms (5–10) | q4 | `0.2–1.1 ms` |
| before | demo 1× | 56.4 · 56.8 / 58.5 / 57.8 | 18.0–20.0 ms (217–240) | q1 | `~51 ms` |
| **after** | demo 1× | 57.0 · 57.0 / 57.7 / 57.2 | 13.0–14.0 ms (74–78) | **q0** | `0.0–3.1 ms` |
| before | demo 10× | 56.3 / 56.0 / 57.2 | 20.5–22.0 ms (304–315) | q4 | `~47 ms` |
| after | demo 10× | 57.3 / 57.0 / 57.0 | 15.5–16.5 ms (167–170) | q4 | `0.3–1.6 ms` |

- **8090 meets the target**: ≥ 59 fps in every window at q0, with 0–2 missed slots per 360.
- **The demo does not.** It rises a rung (q1 → q0) and its work drops by 5–6 ms, but it stays at
  57–57.7 fps with 14–18 missed slots per window. Those misses come in windows where the floor
  did not repaint (`floor0/s`), so they are not the static floor's. The demo's own simulation
  runs in the data module, and its live list is ~40 % bigger than 8090's (1,720 vs 1,200 ops).
  That is the next place to look.

### Factory B, round 3 (fx-demo): the demo's last misses

The demo at 1× stayed at 57–57.7 fps (wave C, above). The lead was its simulation, which
`advance()` pumps from every draw. **Measured, the simulation was not the cause.** The cause was the
coffee check's walking light: the light moving along the worst path "when the floor is worse than
usual". The 8090 recording never shows that light: it has no worst path.

**The mini** (2026-11-11 12:40–13:15Z, 1440×900, Metal, HUD on, q0 in every window). Each run:
connect by taps, 14 s from the tap, the HUD tap, then 6-second `perf frames live` windows at 1×,
then stress mode (10×). Load average 1.0–3.3, logged before and after each run. The top processes were a VM, WindowServer and the 8090 server, with no other worker's build or app. The
build is incremental, 20 s a variant, in one clone. "Work" is the frame work's median; "late" is
work records past the frame's deadline, of ~360. Every demo run here opened on "broken · worse than
usual", so the light was on.

| Tree (what differs) | Fleet | FPS by 6 s window | Missed slots a window | Work median (late) |
|---|---|---|---|---|
| before: main `e2685c9` | demo 1× | 56.7 / 57.0 / 57.8 | 20 / 18 / 13 | 17.5–21 ms (199–301) |
| before | demo 10× | 56.0 / 56.8 / 56.3 | 24 / 19 / 22 | 20–21.5 ms (308–322) |
| before | 8090 1× (control) | 59.8 / 60.0 / 60.0 | 1 / 0 / 0 | 15–16 ms (46–59) |
| before | 8090 10× | 60.0 / 60.0 / 59.8 | 0 / 0 / 1 | 16–17 ms (175–179) |
| sim pumped only from the 250 ms tick, made 400 ms ahead and handed out at the playhead, run 1 | demo 1× | 59.2 / 59.8 / 59.8 | 5 / 1 / 1 | 16–19.5 ms |
| the same build, run 2 | demo 1× | 56.2 / 56.7 / 57.3 | 23 / 20 / 16 | 16.5–19.5 ms |
| before + the light's `look()` off | demo 1× | 59.7 / 60.0 / 60.0 / 59.8 / 60.0 | 2 / 0 / 0 / 1 / 0 | 15–16.5 ms |
| the same, again | demo 1× | 58.2 / 59.8 / 60.0 / 60.0 / 60.0 | 11 / 1 / 0 / 0 / 0 | 11–13 ms (9–68) |
| sim off the draws + the light off | demo 1× | 59.7 / 60.0 / 60.0 / 60.0 / 60.0 | 2 / 0 / 0 / 0 / 0 | 15–16.5 ms |
| the light on the live canvas (`069efd4`) | demo 1× | 57.0 / 57.5 / 57.8 / 57.7 / 58.0 | 18 / 15 / 13 / 14 / 12 | 11.5–13.5 ms (13–28) |
| the same, again | demo 1× | 57.3 / 58.0 / 58.0 / 57.7 / 57.5 | 16 / 12 / 12 / 14 / 15 | 11–13 ms (9–20) |
| path on the retained top canvas, glow on the live one | demo 1× | 58.0 / 58.0 / 57.7 / 58.3 / 58.2 | 12 / 12 / 14 / 10 / 11 | 10–11 ms (5–10) |
| the same | demo 10× | 57.8 / 58.0 / 58.3 | 13 / 12 / 10 | 12–13.5 ms (16–29) |
| the path as 24 px separate strokes, on the live canvas | demo 1× | 57.0 / 57.7 / 57.8 / 57.8 / 57.7 | 18 / 14 / 13 / 13 / 14 | 11–11.5 ms (5–13) |
| the path stroke only, no glow | demo 1× | 58.2 / 57.7 / 57.5 / 58.7 | 11 / 14 / 15 / 8 | 11–12 ms (7–13) |
| **the glow only, on the live canvas: no path stroke (= this commit)** | demo 1× | **59.5 / 60.0 / 60.0 / 60.0** | **3 / 0 / 0 / 0** | 11.5–13 ms (12–16) |

- **The simulation is not the cause.** The same build pumped from the tick read 59.2–59.8 once
  and 56.2–57.3 the next time. The light off read 59.7–60 with the simulation pumped from the
  draws (as before) and from the tick. That change was dropped. It was not free either: the
  simulation's answers ran up to 400 ms ahead of the playhead, so the coffee check's 24 h window
  (`changes(since)`, `complete` against `now − 24 h`) came back incomplete, and its chip went dashed.
- **The light's path stroke is.** The light was a faint path (one 1.2 px stroke, 9 % white, ≤ 7
  points, round joins) and a glow (4 circles). It used to draw on the retained top canvas, so
  `factoryTop` was re-sent every frame (Bun: 1,684 of 1,742 flushes sent, median 3.7 KB, vs 873 /
  1.1 KB with the glow on the live canvas). Moving it to the live canvas cut the top canvas's GPU
  replays from ~110/s to ~81/s, but the misses stayed. A bisect put them on the stroke alone. The
  stroke cost ~2 fps on the live canvas, on the top canvas even when not re-sent, and cut into
  24 px separate strokes. The glow alone costs nothing measurable.
- **The fix** (`coffee.ts`, marked `// fx-demo`): the glow draws on the live canvas through the Gfx
  `under()` remembered (it moves every frame), and the faint path line is not drawn. The light
  still walks the worst path, and the veil's holes still mark it. Stills, before and after:
  `/tmp/sy-preview/b-iter-3/fx-demo-look-before-after*.png` (the glow mid-walk) and
  `fx-demo-intro-before-after.png`.
- **Open question:** a 1.2 px, 9 % white polyline costs ~2 fps on macOS wherever it is drawn, and
  the mechanism is unknown. Canvas stats are the same with and without it (~81 GPU replays/s,
  1.8 ms each). The frame work is low (median 10–13 ms, ≤ 30 late of 360). The missed slots fall
  outside the work Exact measures. Another long, thin translucent stroke on a per-frame canvas
  may cost the same.
- **Not measured on the mini:** demo 10× and 8090 after the final change. 8090 draws no light (no
  worst path), and this commit's other change (`sim.ts`) only runs in the demo and the mock.

**The simulation, cheaper anyway** (`app/server/sim.ts`). `computeStats` sorted the last 24 h of
finished runs twice every 10 s of fleet time (`median`). That was 65 % of a simulated day's CPU,
and after a few hours of demo it was a ~1–2 ms (Bun) spike every 10 s inside a draw. The queue
waits and the successful runs' build times are now kept sorted as runs finish and age out, so the
medians are a lookup. The output is the same frame for frame: a lite sim over 26 h made 9,360
frames with the same hash (`f7fba4f3`) and 8,763 stats changes before and after. The mock's
selftest passes, 81/81.

**How fast the demo can simulate** (`bun tools/demo-speed.ts`, new; for fx-day's "24 h in 2 min"
at 720×). The demo starts 24 h back, then is pumped to now in fixed slices: `DemoUpstream.pump`
plus `World.apply`.

| Measure | Before (`e2685c9`) | After |
|---|---|---|
| 24 h of fleet, Bun JIT, 12 s slices (720×'s per-frame step) | 32.1 s of CPU, 2,690 fleet-ms per CPU-ms (11,500 in hour 1, falling to 1,800 by hour 24) | **8.5 s, 10,174** (8,000–14,000 every hour) |
| the same, per 12 s slice | p50 4.24, p95 10.6, max 15.9 ms | p50 0.86, p95 3.06, max 8.4 ms |
| 24 h, interpreter (`BUN_JSC_useJIT=0`, nearer Hermes) | — | 18.1 s, 4,765 fleet-ms per CPU-ms |
| a 2 h busy stretch, slices that keep a turn ≤ 4 ms (Bun) | — | 30 s slices: p95 2.8, max 4.2 ms (~18,000 fleet-ms per CPU-ms) |

- **At the 250 ms tick:** a ≤ 4 ms turn makes ~30 s of fleet, so ≤ ~120×.
- **At 720×:** a turn would need 180 s (~18 ms Bun), or 12 s every display frame (0.9 ms Bun median,
  3 ms p95).
- **On the mini:** Hermes runs ~10–25× slower than Bun's JIT, so that is ~10–75 ms a frame. The
  demo cannot simulate 720× live. A 24 h demo replay must start where the demo can keep up, play
  slower, or be simulated ahead in slices.
- **What remains of the simulation's cost:** `prune` 21 % (every 60 s of fleet, `for…in` sweeps
  over the commits, pipelines, deploys and PRs, with deletes from those objects), JSON parse 20 % and
  stringify 17 % (the frames' copies).

## Idle pass 2 (idle2): clock ticks cost ~nothing (2026-11-12)

Branch `sy/mac-idle2`, base `ff823ac` (the `idle` pass). What a 1 Hz tick costs now:

- **Live**: a clock-only tick re-stamps the last feed: timers, ages, rings and the intake.
  - Cost: 0.03–0.05 ms in Bun; the rows and their order are unchanged.
  - A full rebuild is two turns: 2.3 + 2.0 ms on the demo (was one 6.2 ms turn).
  - finished events are built only when they can be shown.
- **Board**: a tick repaints only the marks that changed, clipped to their boxes: 0.14 % of the board, 7 of 706 marks. Pixels are identical to a whole paint.
- **Yard**: the header and engines panels redraw only when their words change.
- **Launch**: `src/json.ts` cuts arrays of objects by indexOf plus a verifying `JSON.parse`, without the interpreted scanner. The snapshot parses in 68 yields (was 118).

Mac mini, dev build, 1440×900, `/tmp/sy-idle2-m.sh`:

- Each run is a perf drive (`EXACT_AGENT=live`, connected by real taps).
- CPU is the app's `ps -o time` delta, sampled every 2 s over 56–57 s.
- Frames come from `perf frames live`.
- Load average: 0.9–1.8 (nothing else on the mini) unless noted. Live has no Pause of its own: it is paused from the Yard's.
- LIVE is `tools/live-proxy.ts` to the real fleet, with its stream flowing.
- frozen is `server/mock.ts --frozen`: 3 builds "running", so 1 Hz timers tick and no stream frames arrive.
- merged is HEAD plus `sy/mac-perf` 4ec35d8 (`leak`'s Exact patch 0002).

| Idle CPU | Live | Board | Yard |
|---|---|---|---|
| base, LIVE ticking | 3.28 % | 4.44 % | 3.60 % |
| head, LIVE ticking | 2.86 % | **1.88 %** | 3.05 % |
| base, LIVE paused | — | 4.51 % | 3.37 % |
| head, LIVE paused | — | 1.89 % | 2.96 % |
| base, frozen (timers) | 3.66 % | 4.55 % | 3.56 % |
| merged, frozen (timers) | 3.21 % | **2.09 %** | 2.84 % |
| merged, LIVE paused / frozen paused | 2.65 % | 2.05 % | — |

The `idle` worker's frozen numbers at `51959e7` were 4.65 / 6.55 / 4.77 %.

**Busy**: the recorded fleet at 1× (`switchyard-server --demo`), 20 s windows.

| Busy | Live | Board | Yard |
|---|---|---|---|
| base | 60.00 fps · frame p99 16.5–17 · work p99 18.5–19 · 7.1 % CPU | 60.00 fps · p99 16.5–17 · work max 48–96 · 11.6 % CPU | 59.05 fps · p99 24–48 · 41 of 313 late · 19.1 % CPU |
| head | 60.00 fps · p99 16.5–17 · work p99 20.5–21 · 7.6 % CPU | no frame asked in the window · 3.4 % CPU | 58.55 fps · p99 24–48 · 22 of 164 late · 17.0 % CPU |

**Tab switches**: the 3 s after each tap, base vs head, with the most work in one frame.

- Factory: none asked (both).
- Yard: 11.5–12 ms (base) / 10–10.5 ms (head).
- Back to Live: none (base) / 16.5–17 ms (head).
- Back to the board, head only: 48–96 ms, a run's transit on the board as it was shown again.

**Launch → data**: process start → `token-file: connected` (snapshot fetched, parsed, loaded), warm, 3 runs.

- base: 859–980 ms.
- head: 847–856 ms.
- merged: 865–870 ms.
- Cold first launch: 1.3–3.4 s.

The parts:

- Exact boots in 100–170 ms.
- The snapshot fetch from the mini takes ~440 ms (715 KB brotli; first byte at 170 ms).
- Parsing and loading take the rest.

Live's rows follow in the next turns (the drive's own wait for `nowData.idle == false` met within 0.75 s of its start).

Where the floor is:

- With nothing changing (paused, or a frozen fleet), the board still costs ~1.9–2.1 %.
- That is the 1 Hz `pulseIdle` re-asking `overview(clockMs)` and the runner re-evaluating what reads `ov`.
- Next: make `liveFeed` answer per stream frame so `ov` follows it, and stop the pulse when nothing on top ticks.

## Pass 3, the shell (p3-shell): the pulse sleeps (2026-11-12)

Branch `sy/mac-p3shell`, base `f6019ae` (pass 2 merged). What a quiet second costs now:

- **Nothing shown ticks** (paused, a still fleet, Live filtered to a quiet repo): no pulse at all
  (`ov.pace` 2).
  - The stream's frames wake the clock: `liveFeed` keeps them in an inbox, moves `feed.wake`, and
    Contract ticks once 30 ms later (`fed`), so the overview, the canvases and Live follow the
    stream, not a clock.
  - A ladder of one-shot wakes reaches the playhead's next minute (32/16/8/4/2/1 s: about six a
    minute) for ages, hh:mm and the heap line; one more a second after any change.
- **A shown timer runs** (`ov.pace` 1): the 1 s tick moves only `clockMs`.
  - `rk` (ov.tick plus the second) redraws the canvases; Live's moving parts, its panel and the
    board's inspector re-stamp at `tickMs`.
  - Live's second is `nowTick`: the "now" band, the machines' rings, the clock, intake and idle
    line. The whole feed (`nowFeed`: every finished event and every need) is asked when what it
    shows changed (the world, the view, the minute's wakes, a row's band edge).
  - The recorded fleet: the per-second answer is 8.7 KB, where the whole feed was 122 KB each
    second; the re-stamp takes 0.005 ms in Bun.
  - The overview is not asked, and neither is `f3Stats` (now per board change; per second only
    with the HUD).
- **Busy** (the demo, a replay, playing behind, the HUD, stress, the web's older floors): the 250 ms
  pulse, as before.
- Also:
  - the palette's search runs per query and per open, not per stream frame;
  - the old floor's coffee visits run only on `/factory?v=1`;
  - no pulse before a fleet loads;
  - the token file's "connected" is logged as the connect answers, not at the next tick.
- **Live covered or paused**: its forever-breathing marks (the LIVE beat, a live step's chip) are
  still. Live stays mounted under the board and the Yard; on the web those animations kept 60
  style recalcs a second going behind every view.
- **The board shown again**: each visit mounts the Factory's canvases afresh (the tabs pop and
  push the route). A fresh mount now:
  - keeps the face's measures (12 `measureText` round trips before);
  - starts no transit for what moved while it was away (it moved unseen; the transit also built
    the scene twice in that frame);
  - paints the last scene unbuilt when nothing changed.
  - Bun, the fixtures' board after 60 frames covered: 1.85 → 1.33–1.56 ms, 0 measures, 0 transits.

**Web** (Chromium, Playwright's headless shell, this devbox), `server/mock.ts --frozen` (3 builds
"running": the 1 Hz timers, no stream frames); paused = the time control's Pause (Live's from the
Yard). Script / main-thread task ms per second over 15 s, style recalcs per second, and data-module
source calls per 20 s (an instrumented build):

| Web, ms/s · recalcs/s · source calls | base `f6019ae` | head |
|---|---|---|
| Live, timers | 16.3 / 34.1 · 61 · overview 20, nowFeed 19 | 17.4 / 38.8 · 61 · nowTick 20 (8.7 KB each) |
| Board, timers | 15.3 / 35.8 · 60 · overview 20, f3Stats 20 | 10.2 / 19.5 · 0 · 0 |
| Yard, timers | 15.3 / 36.5 · 60 · overview 20 | 10.3 / 20.0 · 0 · 0 |
| Live, paused | 16.1 / 32.5 · 60 | 2.5 / 9.7 · 0 · 0 |
| Board, paused | 15.1 / 30.7 · 60 · overview 20, f3Stats 20 | 2.6 / 8.6 · 0 · 0 |
| Yard, paused | 13.9 / 29.5 · 60 | 2.4 / 8.0 · 0 · 0 |
| Live, the mock's moving fleet | 41.9 / 65.3 · 61 · overview 65, nowFeed 27, search 12 | 31.0 / 61.5 · 61 · overview 16, nowFeed 16, nowTick 44 |

How to read it:

- Live on top with work running keeps its beat and its live chips (real work), which are most of
  the web's script time there.
- Live's timers: one small `nowTick` re-stamp a second, and nothing else.
- On the moving fleet, the overview and the whole feed are asked per batch of stream frames (16 in 20 s; the overview was 65).
- The time columns before `91aff90` (`nowTick`); the source calls at it.
- The Mac mini numbers for this pass come after sy-ship's 0.1.5 gate (the mini was busy).

**Launch → connected** (pass 2's logs, LIVE, token file):

- Warm: the token file is read and the connect starts at ~170 ms; "connected" at 856–980 ms. In
  between, the fetch takes ~440 ms (first byte ~170 ms, 715 KB brotli) and the parse and load ~250 ms.
- The log line came up to 250 ms after the connect itself (fixed above).
- Cold, a new build's first launch: Exact's first line comes at 2.5 s and "connected" at 3.4 s.
  - The 2.5 s is the OS starting a new binary for the first time (code-signature checks,
    dyld), before any app code runs.
  - The app's own part is the same ~700–900 ms as warm.
- A local cache of the last fleet would not help a first launch (there is none). Two pieces can
  still come down:
  - parse the snapshot as it streams in (a byte stream overlapping the ~270 ms download with the
    ~250 ms parse);
  - a larger parse step on native.

## Pass 4 (p4-gpu): where the Yard's native frame goes, and the paused wakes (2026-11-12)

Mac mini, recorded fleet at 10× (`switchyard-server --demo --speed 10`, fresh per run), busy Yard,
1440×900, real taps (`EXACT_AGENT=live`), sy-client's 0.1.6 soak app running beside it (load 1.3–1.9).

**It is not the GPU path.** `EXACT_CANVAS_STATS=1` (read from the drive's `app:` lines: `log show`
and `log stream` catch nothing, NSLog from a child of the agent does not reach the unified log)
reads, every second of the busy Yard at base `368b10d` (5 runs): `3–66 gpu/s (2.2–4.0 ms each),
0.0 recorded/s, 0.0 bitmap/s` (~62 while packets move, 3–8 while only the panels change). All four
layers replay on Vello; nothing is recorded by Core Animation.

**Where the main thread goes** (`sample <pid> 22` inside a 30 s window, 12,517 samples a thread):

| Main thread | Samples | |
|---|---|---|
| idle (`mach_msg`) | 10,755 (86 %) | |
| display-link callback (`Frames.tick`) | 659 | of which 269 waiting on the owner (`Runtime.tick` → `Owner.sync`) and 377 applying batches (`fitDocument` 152, `ShortcutHost.sync` 102: a `buttonFace` asked of the owner per button per batch) |
| a native timer delivered (`deliverNativeTimer`) | 787 | **637 waiting on the owner** (`fireNativeTimer` → `Owner.sync`), 147 applying its batch |

| Owner (data module) thread | Samples |
|---|---|
| idle | 11,404 |
| a timer's turn (`exact_fire_native_timer`) | 631: its commit draws the canvases whose args moved (`canvas_draw_turn` 501: JS 419, a full Hermes collection between calls 68) |
| frame ticks (`exact_tick_at`) | 267 |
| the stream (`exact_pump`) | 88 |

So a late frame is the main thread waiting: the 250 ms tick (`fed`, the overview) is a native timer
the main thread delivers synchronously, and its commit draws `yardInfo` (and `yardLive`) on the
owner. A display-link callback that comes during that turn waits for it. The frame report agrees:
the late frames' callbacks run 15–28 ms from the frame's timestamp with 1–3 ms of apply, and their
neighbours have a `callback gap`. Also: on this Mac the callback itself arrives 4.5–8.7 ms after
the frame's timestamp (target offset 7.9–12.2 ms, steady within a run), so a frame's work can't
read under that, and the budget after the callback is 8–12 ms, of which the GPU replay takes 2.2–4.

**Tried, measured, reverted: the info layer in slices.** A draw asked its dirty panels until their
last hashed ops would pass 700 and left the rest to the next 1–3 frames (`853ba6e`). On the
devbox it cut the info draw (Bun without JIT, `yard-bench --hermes`, 10×) from p50 10.1 / p90 24.5
/ p99 54.9 ms to 2.1 / 5.8 / 21.9. On the mini it bought nothing: the slices moved the same owner
work into the frames that followed, where the display-link callback waits for it in
`Runtime.tick`. Busy Yard, 10×, 30 s windows, interleaved, sy-client's soak app beside:

| Run | Tree | Callbacks | FPS | Late | Work median | Work p99 | CPU | Load |
|---|---|---|---|---|---|---|---|---|
| base 3 | `368b10d` | 824 | 58.97 | 32 (3.9 %) | 9.0–9.5 | 22.0–22.5 | 30.1 % | 1.86 → 2.13 |
| head 3 | `853ba6e` (slices) | 836 | 59.22 | 41 (4.9 %) | 9.0–9.5 | 23.5–24.0 | 26.2 % | 2.10 → 2.11 |
| base 4 | `368b10d` | 779 | 59.09 | 31 (4.0 %) | 9.0–9.5 | 24–48 | 27.6 % | 1.95 → 1.99 |
| head 4 | `853ba6e` (slices) | 836 | 59.08 | 52 (6.2 %) | 9.0–9.5 | 22.5–23.0 | 30.5 % | 1.64 → 1.88 |

The recorded fleet is busy in bursts: the canvas stats alternate ~62 gpu/s (packets moving) with
3–8 gpu/s (only the panels), so a 30 s window has ~800 callbacks, not 1,800. The panels' hashed
ops (10×) for whoever cuts the info layer next: mains 2,360 (5–6 ms in Bun without JIT), queue 630
(3.2 ms), heat 420, sources 300, apps 257, now 160, the rest ≤ 80; 12 of 20 asks of mains found
the same calls (a per-row key would skip them).

**What is left, then, is not the canvases' drawing but the owner's turns the main thread waits
on**: the tick's commit (overview, the args draws), the frame tick, the stream's pump, and a full
Hermes collection between calls (Exact's `collect_if_due`, `js/src/shim.cc`: one whenever the
allocation since the last one passes half the live heap, ~10 MB at the Yard's ~20 MB). Each holds
whichever display-link callback falls inside it. The ways out are in Exact (deliver a timer
without the main thread waiting on its turn; collect off the frame path) or fewer, smaller owner
turns in the app; neither fit this pass.

**Paused, Live asked frames** (sy-client's 368b10d run: 44 callbacks a paused 30 s window). The
cause was the test mock: it answered `/api/v1/tstream` (the device-token WebSocket path, which the
real server's `api.rs` serves) with 404, so the app, holding a token, reconnected every 8–16 s,
refetched the 2 MB snapshot and re-mounted Live's rows (their `nowIn` entrance: ~22 frames each
time). The mock now serves `tstream` as `stream` (`853ba6e`). Against the real server the app never
saw this; it still reconnects that way against any server that refuses the stream.

Mini, paused Live, 30 s, frozen mock (load 1.4–1.8):

| Tree | Mock | Callbacks | CPU |
|---|---|---|---|
| base `368b10d` | 404 on `tstream` | 44 | 1.69 % |
| base `368b10d` | serves `tstream` | **0** | **0.11 %** |
| head `a5712a9` (+ `fc37169`) | serves `tstream` | 0 | 0.12 % |

`fc37169` (paused: one wake every 32 s instead of a ladder rung that never shrank, since the
playhead stands) stays: fewer wakes, no frames either way.

## Pass 5, the Yard (p5-yard): the timer turn shrinks (2026-11-12)

Pass 4 found the late frames were the main thread waiting on the data module's turns: the 250 ms
tick's commit drawing yardInfo + yardLive (637 samples of 22 s in `deliverNativeTimer`), the
per-frame `Runtime.tick` (269) and full Hermes collections. Pass 5 makes those turns small.

**Where the timer turn went** (p4's mini sample `base-prof1`, the 491 samples of
`DataSource::draw` inside `exact_fire_native_timer`, Hermes frames merged by function):
`Array.prototype.sort` ~200, of which `localeCompare` 74, `Collator::create` 37 and
`Collator::compare` 29; GC ~140 (`collect_garbage` between calls 68, young/incremental the
rest); `canvas_measure` (the host's text measure) only 13. Hermes builds an `Intl.Collator`
for **every** `localeCompare` call (ECMA-402 defines it as `new Intl.Collator(…).compare`), and
`Aggregates.repoJob` re-sorted every repo by org and name, and ranked them all, on every
`kv.repo` change: at 10× nearly every stream frame.

**What changed** (all in `src/yard/`, plus two recorder patches):

| Commit | What |
|---|---|
| `61fa9ee` | The info layer's parts take a key (a number and up to two objects by identity): a part whose key, objects and band match the last paint's is not run, not even hashed; its last hash and box stand. The main lines key each row (repo by identity, row, `shortKey`: `fmtShort`'s words as a number). |
| `0a008d1` | One `Intl.Collator` (and one numeric) made once, used for every sort in the Yard (the same order by spec; checked on the fixtures' 776 names, 602,176 pairs: 0 disagree). The repos' org/name order is kept while the same ids keep the same org and name. The queue's waiting and just-finished rows are keyed. |
| `78d8477` | The ranked repos: only the first 120 (the yard's picks), by insertion, scores in a `Float64Array` (checked against the full sort on 30 perturbed trials with ties: 0 differ). The gates' verdicts kept per `kv.pipeline`. |
| `992b273` | `exact-patches/0003`: the native recorder parses each font string once and quotes each family once (bounded maps). |
| `088e0e8` | `Yard.ensure` compares the scene signature's twelve parts instead of building a string every draw. |
| `5f65381` | `exact-patches/0004`: the recorder's `roundRect` with one radius and a size that is not negative records the same ops without ~70 arrays per rectangle. |

**Devbox** (`tools/yard-bench.ts --hermes --fed`, Bun 1.4.2, the recorded fleet at 10×,
`switchyard-server --demo --speed 10`, base `50768b6` and head run at the same time on one
stream; `--hermes` now prices `localeCompare` as Hermes does, a collator per call; `--fed`
asks the overview as the app's `fed` task does):

| | yardLive ms p50 / p99 | yardInfo ms p50 / p99 / mean | info alloc KB/draw | live alloc KB/frame |
|---|---|---|---|---|
| base, JIT | 0.14 / 3.16 | 1.33 / 7.70 / 1.90 | – | – |
| head, JIT | **0.13 / 0.74** | **1.03 / 6.12 / 1.36** | – | – |
| base, no JIT (an interpreter's proportions) | 0.50 / 4.75 | 3.12 / 52 / 6.7 | 709 | 68 |
| head, no JIT | 0.51 / 2.27 | **1.73** / 46 / 3.7 | **255** | **53** |

(Allocation from `--alloc`: JSC's heap blocks plus mimalloc's pages across each call, the
collector held off with `BUN_JSC_largeHeapSize/smallHeapSize=8e9`; coarse per call, fair as a
mean.) Per panel (no JIT): the main lines' paint p50 3.36 → 0.17 ms, the queue's 1.22 → 0.22 ms.
The p99 of an info draw is a panel whose content really moved (the queue's rows shift when the
waiting list grows by one, the main lines reorder): those repaint whole, as they must.

**Pixels.** `tools/yard-pixels.ts` (every info draw through the gate, against a twin with the
gate off, on the live 10× stream, 60 s): the head's list of differing draws is the base's
(the pre-existing 12–48 px at x 237–259, p3-yard's), no new one. `tools/yard-regress.mjs`
(built webs, frozen clock): base → head 2,069 px of 1,248,480 in the Yard; base → base 1,585 in
the same places (the demo's timers and packets are not frozen by it), so nothing from this pass.
The two recorder patches are byte-identical by fuzz (0003: 300 trials of font/fillText/caps/
stretch/save/restore/getters; 0004: 4,000 trials of roundRect under transforms, odd radii and
negative sizes): 0 differ.

**Mac mini** (`p5yard-m.sh`, a copy of p4's recipe: a fresh `--demo --speed 10` server per run,
busy Yard 1440×900, real taps, `EXACT_CANVAS_STATS=1`; window A = `perf frames live 30000`;
base `50768b6` with the shared Exact (0001+0002), head `5f65381` with a private Exact
(0001–0004); interleaved base/head ×2, 13:11–13:19Z). p5-board's builds ran beside it, so the
load was 3–14, not p4's 1.3–1.9; **pair 1's base ran at load 14 → 12 and is tainted; pair 2
(load 3–6 for both) is the clean one.**

| Run | load | fps | missed slots | frame p99 | work late | work median | work p99 |
|---|---|---|---|---|---|---|---|
| base 1 (tainted) | 14.2 → 11.8 | 59.08 | 19 / 1228 | 24–48 | 80 / 1209 (6.6 %) | 12.5–13.0 | 24–48 |
| head 1 | 3.8 → 4.5 | 58.91 | 25 / 1367 | 24–48 | 26 / 1342 (1.9 %) | 11.5–12.0 | **20.0–20.5** |
| base 2 | 3.0 → 5.7 | 58.85 | 16 / 814 | 24–48 | 39 / 798 (4.9 %) | 10.5–11.0 | 24–48 |
| head 2 | 3.8 → 3.2 | 59.15 | 12 / 818 | 24–48 | **25 / 806 (3.1 %)** | 12.0–12.5 | **21.5–22.0** |

Every canvas stayed on the GPU (`62–64 gpu/s, 2.3–2.4 ms each, 0.0 recorded/s`). Late work fell
by a third to two thirds and its p99 left the 24–48 ms bucket for 20–22 ms; the head's sample
(`sample-head-busy2`, 6 s) has no `arrayPrototypeSort` or `Collator::create` left under the
timer turn (36 samples of 1,002 on the main thread in `exact_fire_native_timer`). The frame
p99 and the missed slots did not move: the newest hitches of `perf frames report` are
**callback gaps** (a 33 ms gap, the callback 1.4–3.7 ms, the work around it 1.4–5.5 ms): the
display link did not call, with nothing of the app's in the way. With Swift compiles beside it
that is expected; whether they remain on a quiet mini is the next measurement. **Not met:**
60 fps, p99 ≤ 17 ms, ≤ 1 % late at 10× (head 2: 59.15 fps, frame p99 24–48, 3.1 % late work).

**Exact: why no timer patch.** `ExactSession.asyncFills` (`host/apple/Sources/ExactKit/Session.swift:473–476`)
already sends a timer's turn to the owner without the main thread waiting
(`NativeTaskTimers.deliverNativeTimer`, `NativeTaskTimers.swift:100–114`:
`fireNativeTimerAsync`), but only on iOS ("macOS follows once physical scrolling there is
measured"). On macOS it would not save the frame: with a turn in flight the display link's
tick is *held* (`Frames.swift:80–87` `advanceInFlight`, `submitMotionTick` `tickInFlight`), so
the canvas misses the same slot, now as a held frame instead of a late one; and it switches
every macOS fill to the asynchronous path, which is not measured there. The fix is a turn that
fits, which this pass makes. What Exact would need for a frame never to wait on a timer turn:
the timer turn split from the canvas commit (the turn's draws recorded on the owner and their
lists replayed by the next display-link tick, `canvas_draw_turn` under
`exact_fire_native_timer`), or the shim's between-call full collection
(`js/src/shim.cc:135–145` `collect_if_due`: every `max(256 KiB, live/2)` allocated) moved off
the call that answers a frame.

## Pass 5, the board (p5-board): no frame waits on a whole board, and a refused stream stops looping (2026-11-12)

Branch `sy/mac-p5board`, base `50768b6`. The board (Factory) at 10× read 32–40 fps with
0.2–0.8 s stalls on the mini (pre-existing; 60 at 1×). Two causes, both the board's own.

**1. The board never reached the GPU** (`f33ac50`). The macOS host gives a canvas to its GPU
module only if the first draw with anything in it after a fresh bitmap asks for the next frame
(PERF.md "Where the native frame went"; the old floor's and the Yard's `gpuClaim`). Board3's two
layers asked for nothing there (an idle board asks for nothing), so both stayed with Core
Graphics; and while a transit animates (both layers ask for frames until it lands: at 10× nearly
always) Core Animation records and replays, on the main thread, every list the canvas kept since
its last cover, each frame. The board's partial repaints never cover, so that was up to 64 lists
a frame. Each layer's first paint on a fresh bitmap now asks for one more frame (which draws
nothing); a fresh bitmap whose draw was skipped while covered (app.ts) is owed its whole paint and
its claim.

**2. A change in the number of marks repainted the whole board** (`bdfb9f7`, `69b0626`).
`paint()` compared the scenes index by index and went whole whenever their lengths differed: a run
arriving, leaving or landing. A whole board is 100–180 KB of list through Exact's recorder (the
list, base64, JSON); at 10× that came about once a second. Now:
- `diffOps` walks both lists in order and aligns them again after marks that came or went (the
  nearest equal pair, 24 marks a side, 6,000 compares at most, else whole). Matched marks keep their
  order in both lists, so a pixel outside every changed box is painted by the same marks in the
  same order.
- The 30 % whole-repaint share is the boxes' union in 16 px tiles, not their sum (the events list
  moving down one row is ~280 overlapping boxes in one column).
- Over 24 boxes, the repaint is cleared and clipped as its tiles' runs, and every mark on those
  tiles is painted again: a few rects, not hundreds.
- A whole or tiled repaint paints last, grouped by font and colour, every word that no later mark
  and no other word overlaps (`paintOrder`): each font change sends the face's whole family list
  (Exact's recorder: a number per character, ~400 B), and the board's words alternate fonts (~120
  changes, half of a whole board). A whole board: 101.7 → 69.7 KB (the fixtures' board).

**Devbox** (`tools/f3-bench.ts`, new: the board against the live 10× recorded fleet in Bun, a small
Contract runtime (connect, the stream, the overview at the pulse / `fed` / wakes, `rk`, 60 Hz
draws), the draws through Exact's own recorder (`--real`), `BUN_JSC_useJIT=0`, 45 s, interleaved,
load 1.5–2.2):

| Run | Whole paints | Frames > 16 ms | Frame work p99 / max | Largest list |
|---|---|---|---|---|
| base 1 | 26 of 84 (every count change) | 31 | 40.3 / 63.0 ms | 158.6 KB |
| head 1 | 3 of 67 (the mount, layout changes) | 3 | 11.5 / 39.6 ms | 108.1 KB (the mount) |
| base 2 | 19 of 77 | 24 | 45.7 / 71.4 ms | 177.3 KB |
| head 2 | 2 of 77 | 6 | 27.1 / 39.7 ms | 107.9 KB (the mount) |
| head + tile runs (`69b0626`) | 3 of 84 (the mount, the bench's font pass, a layout change) | 6 | 24.3 / 39.7 ms | partials ≤ 60 KB |
| head + words grouped | 3 of 78 | 6 | 23.0 / 36.1 ms (the mount) | 72.8 KB (the mount) |

**Pixels.** `f3-bench --pixels`: every board list also goes to a canvas that keeps it (Exact's web
replayer in headless Chromium, `tools/floorpix.ts`), and after each paint a whole repaint of the
same scene, in the scene's own order, goes to a fresh one. 84 paints at 10× (81 partial, 3 whole):
**0 pixels differ**; with the words grouped, 78 paints (73 partial): **0 pixels differ**.
`factory3-shots stills` base vs head (frozen fixtures): the only differences are the running
timers (the two runs 4 s apart) and the proxy's port in the status line.

**3. A refused stream** (`9648d25`). Against a server that refuses `/api/v1/tstream`, `retry`
bumped `gen`, the connect's argument, so every rung of the ladder fetched the 2 MB snapshot again
and loaded a new world (Live rebuilt; and paused, `tl.load` put the module back to live under a
paused UI, so its 1 Hz timers ticked). The ladder itself was right: 2, 4, 8, 16, then every 30 s
(the 8–16 s seen were its rungs inside 30 s windows; a test on the base tree reaches 30 s and
stays). Now:
- `retry` bumps `fgen`, the stream's own argument; the connect (and the world, and Live's rows)
  stands. The stream resumes after the newest seq it brought (`since`); a resume the server can
  no longer serve comes back as a reset, which refetches the snapshot at once (`refetch`).
- A failed connect still asks the snapshot on the ladder.
- A reload while paused stays paused.
- `tests/reconnect.test.contract`: the mock's `/nostream/` (the same API, the stream 404'd);
  retries at 2, 4, 8, 16, 30, 30, 30 s, never sooner; `gen` stands (one snapshot); Live's rows stand.

**The mini** (2026-11-12 13:22–13:37Z; 1440×900, dev builds, real taps, `EXACT_AGENT=live`,
`EXACT_CANVAS_STATS=1`, the recorded fleet at 10× on a fresh `switchyard-server --demo --speed 10`
per run; base `50768b6` and head built side by side, runs interleaved, nothing else on the mini;
load average logged per run). Window A is 30 s of the busy board, window B 12 s with `sample`.

| Run | Window | Callbacks | FPS | Missed slots | Frame time p99 | Work median / p99 / max (late) | Canvas stats while squares move | CPU (load) |
|---|---|---|---|---|---|---|---|---|
| base 1 | A | 180 | 55.58 | 14 of 194 | 48–96 ms | 9.5–10 / 48–96 / 48–96 ms (12) | **0 gpu/s, 44.9 recorded/s** | 11.2 % (1.09 → 1.50) |
| base 1 | B | 76 | **42.06** | 32 of 108 | **384–768 ms** | 8–8.5 / 48–96 / 48–96 ms (11) | | |
| head 1 | A | 193 | **59.70** | 1 of 194 | **16.5–17 ms** | 9–9.5 / 24–48 / 24–48 ms (12) | **33.9–49.8 gpu/s, 0 recorded/s** | 11.7 % (1.59 → 1.36) |
| head 1 | B | 15 | 60.00 | 0 of 15 | 16.5–17 ms | 8.5–9 / 19.5–20 / 19.5–20 ms (3) | | |
| base 2 | A | 173 | 56.31 | 11 of 184 | 48–96 ms | 9–9.5 / 48–96 / 48–96 ms (11) | 0 gpu/s, 39–40.9 recorded/s | 12.0 % (1.48 → 1.30) |
| head 2 | A | 198 | **59.39** | 2 of 200 | 24–48 ms | 9–9.5 / 24–48 / 24–48 ms (15) | 40.7–61.7 gpu/s, 0 recorded/s | 12.6 % (1.23 → 1.14) |

(The board asks for frames only while a run's square travels: ~190 of a 30 s window's 1,800 slots.)
- **Cause 1, proven**: at base the board's canvases are never on the GPU (`0.0 gpu/s`), and while
  squares move Core Animation records ~40–45 lists a second on the main thread; the 0.4–0.8 s
  frames follow. At head both are on Vello (`34–62 gpu/s`, `0.0 recorded/s`).
- Head: 59.4–59.7 fps in window A (1–2 missed slots of ~195), 60 in B. Frame time p99 16.5–17 ms
  (run 1) and 24–48 ms (run 2: its 2 missed slots). The work's maximum is still 24–48 ms (12–15
  late records a window): the GPU replays read 5–16 ms each while squares move.

**A refused stream on the mini** (the frozen mock's `/nostream/`, paused Live, 70 s window after
the pause; both apps on the head clone's mock):

| Tree | Frames in the 70 s | CPU (load) | Snapshot GETs in the run | Stream opens |
|---|---|---|---|---|
| base `50768b6` | 68 (three bursts of 21–24: Live's rows entering again) | 1.72 % (1.48 → 1.30) | 7 (the connect's 2, then one a rung) | 6 |
| head | **0** | **0.08 %** (1.23 → 1.10) | **2** (the connect's) | 6 (2, 4, 8, 16, 30 s) |

**Idle with timers** (the frozen mock, which serves `tstream`: 3 builds running, so the 1 Hz
timers tick; 58 s windows):

| Tab | Tree | Frames in the windows | CPU (load) |
|---|---|---|---|
| Live | head | 0 | 2.14 % (1.22 → 1.68) |
| Board | head | 0 frame callbacks; 1 GPU replay a second (the timers' repaint, 4.7–7.9 ms each) | 1.93 % (1.08 → 1.17) |
| Board | base `50768b6` | 0; 0.5–1 bitmap replay a second (Core Graphics, off the main thread) | 1.51 % (1.28 → 1.30) |

The refused stream is fixed outright (0 frames, 0.08 % CPU, one snapshot). The board meets 60 fps
at 10× with its stalls gone; idle with timers does not meet ≤ 1.5 % on Live (2.14 %) or the board
(1.93 %), and the board's idle CPU went up from base's 1.51 %: on Vello, the one repaint a second
(the timers, ~0.1 % of the board) costs a whole GPU replay of the canvas (4.7–7.9 ms), where Core
Graphics updated the bitmap in place.

**What is left.**
- The board asks for frames during a transit only to land it (`land`: the square drawn in its
  berth). If the live layer kept the landed squares until the board's next argument change, the
  board would never animate: it could stay on Core Graphics (cheap partial repaints, never
  recorded), and only the live layer would need the GPU claim. That would bring the idle board
  back to ~1.5 % and take the per-frame board replays (5–16 ms GPU each) out of the busy frames.
- Live's idle with timers (2.14 %): one 1 Hz tick re-stamps `nowTickData`; the cost is likely the
  runtime's apply (texts relaid each second), not the module (0.005 ms in Bun). Unmeasured.
- A layout change still repaints the whole board (~70 KB now, ~1 per 45 s at 10×).
