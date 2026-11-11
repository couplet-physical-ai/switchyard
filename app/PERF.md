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
