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
  64 MiB heap, and no allocation per frame. Stress mode adds a few kilobytes (repo states, app
  health, slot occupancy), never copies of entities.

## Factory (the default view; DESIGN.md "Factory")

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
