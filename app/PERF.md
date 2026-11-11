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
