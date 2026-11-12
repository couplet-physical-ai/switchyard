# Exact (macOS): a display-link frame waits on the owner's timer turn and its between-call full GC

*An issue write-up for expo/exact, from Switchyard's Mac performance work (Nov 2026). Exact pin
`316d1f292f92f91a223d2f582e80fe17979c12c1`; file:line references are at that commit. All
measurements are on a Mac mini (Apple silicon), a development build at 1440×900, with real input
(`EXACT_AGENT=live`). Raw data is in Switchyard's `app/PERF.md`, passes 4–6.*

## Summary

A canvas-heavy view (Switchyard's Yard: four canvases, about 60 GPU replays a second while
packets move) holds 59–59.5 fps on macOS, but its frame-time p99 lands in the 24–48 ms bucket in
some 30-s windows, with 3–6 % of frames late. Every canvas is on the right replay path (Vello on
the GPU; `EXACT_CANVAS_STATS=1` shows `0.0 recorded/s`). The app's own per-frame work is small
(p99 under 1 ms for the moving layer, measured in Bun with Hermes pricing).

The late frames are the **main thread waiting on the owner (data-module) thread**. It waits in
three places, and in all three main is blocked even though it has nothing of its own to do:

1. **A native timer's turn, delivered synchronously.**
   - `NativeTaskTimers.deliverNativeTimer` (`host/apple/Sources/ExactKit/NativeTaskTimers.swift:100–114`) calls `runtime.fireNativeTimer` on main, which `Owner.sync`s.
   - The timer's commit draws every canvas whose arguments moved (`canvas_draw_turn`, `host/apple/src/canvas2d.rs:85`, reached from `fire_native_timer`, `host/apple/src/first_frame.rs:9`).
   - A display-link callback that falls inside that turn waits for it.
2. **The per-frame tick:** `Frames.tick` → `Runtime.tick` → `Owner.sync`, `host/apple/Sources/ExactKit/Frames.swift:78–90`.
3. **A full Hermes collection at the end of either call:** `collect_if_due` (`js/src/shim.cc:135–145`, called at `:464`).
   - It runs `collectGarbage` whenever the allocation since the last full collection passes `max(256 KiB, live / 2)`.
   - At a ~20 MB live heap that is one full collection per ~10 MB allocated, about 1–2 a second for a busy canvas view.
   - It runs inside whichever call crossed the line, often the one a frame is waiting for.

## Measurements

`sample <pid> 22` in a 30-s busy window (12,517 samples a thread):

| Main thread | Samples |
|---|---|
| idle (`mach_msg`) | 10,755 (86 %) |
| display-link callback (`Frames.tick`) | 659; **269 waiting on the owner** (`Runtime.tick` → `Owner.sync`) |
| a native timer delivered (`deliverNativeTimer`) | 787; **637 waiting on the owner** (`fireNativeTimer` → `Owner.sync`) |

| Owner thread | Samples |
|---|---|
| a timer's turn (`exact_fire_native_timer`) | 631, of which `canvas_draw_turn` 501 (JS 419, **a full collection between calls 68**) |
| frame ticks (`exact_tick_at`) | 267 |
| the stream (`exact_pump`) | 88 |

The late frames' callbacks run 15–28 ms after the frame's timestamp with only 1–3 ms of apply,
and their neighbours show a `callback gap`. On this Mac the callback itself arrives 4.5–8.7 ms
after the timestamp, so the budget after it is 8–12 ms, of which the GPU replay takes 2.2–4 ms.

**What the app already did** (passes 4–6):
- It cut the timer turn's work by ~3× (a shared `Intl.Collator`: Hermes creates one per `localeCompare` call; per-row change keys; ~2.8× less allocation per draw).
- It moved the still canvases to Core Graphics so only the moving layers use the GPU.
- It added two byte-identical recorder patches (font strings parsed once; `roundRect` without per-call arrays).

These moved late work from ~90 % to 3–6 % of frames and the work p99 from 24–48 to ~20–22 ms.
What's left is the wait itself.

## Why the existing switches don't solve it on macOS

- **`ExactSession.asyncFills`** (`host/apple/Sources/ExactKit/Session.swift:472–476`, iOS/tvOS only) sends a timer's turn to the owner without main waiting (`fireNativeTimerAsync`), and turns on deferred canvas draws (`runtime.canvasDefer(true)`, `Session.swift:719–724`; LLP 1072 §8.5).
  - On macOS it wouldn't save the frame: while a turn is in flight, the display link's tick is *held* (`Frames.swift:80–87`: `advanceInFlight` / `tickInFlight`), so the canvas misses the same slot, reported as held instead of late.
  - It also moves every macOS fill onto the asynchronous path, which hasn't been measured on macOS ("macOS follows once physical scrolling there is measured").
- **Deferred canvas draws alone** (`canvasDefer` without `asyncFills`) move a timer's draws into their own owner turn (`exact_canvas_draw`, `askCanvasDraw`, `Session.swift:618–629`). But the next display-link tick still `Owner.sync`s and so waits behind that turn.

## Proposed changes (either would do)

1. **Don't let a frame tick wait for a canvas-only owner turn.** When the owner is busy with a timer turn or a deferred canvas draw, have the display-link tick replay the canvases' last lists and present without `Owner.sync`.
   - The motion clock may advance on the next tick; the new draw lands one frame later.
   - In effect: the iOS `asyncFills` behaviour, but for canvas work only, and without holding the frame.
   - Where: `Frames.swift:78–90` (the macOS branch's synchronous `runtime.frame`/`runtime.advance`) and `NativeTaskTimers.swift:113–114`.
2. **Take the between-call full collection off the frame path.**
   - In `collect_if_due` (`js/src/shim.cc:135–145`), don't collect at the end of a call that answers a frame or a timer while the display link is running. Instead mark it owed and run it at the owner's next idle point (no frame pending), as `collect_owed` already does for large replies (`shim.cc:455–465`).
   - Alternatively, raise the threshold for canvas-heavy sessions; Hermes's young-generation collections already reclaim most per-frame garbage.
   - In our profile the collection was 68 of the timer turn's 631 owner samples (~11 %).

## How to reproduce

- **App:** a view with one always-animating canvas plus one canvas redrawn from a 250-ms `every` task, each draw ~3–5 ms of JS on Hermes, about 20 MB of live heap.
- **Measure:** `perf frames live 30000` under `EXACT_AGENT=live` and `sample <pid> 22` during the window.
- **What you'll see:** the late frames line up with `deliverNativeTimer` → `Owner.sync` and with `collect_garbage("between calls")` on the owner.
