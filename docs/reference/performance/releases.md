# Numbers per release

The macOS app's performance, release by release, from 0.1.3 (the first release with a measured
problem) to 0.1.8, the last planned performance release. Every number was measured on the reference Mac mini (Apple silicon,
1440×900) with the load average logged. Windows were taken when the machine was quiet (load
about 1–2) unless a row says otherwise. The raw logs and the method for each pass are in
[`app/PERF.md`](https://github.com/couplet-physical-ai/switchyard/blob/main/app/PERF.md); how
to reproduce a measurement is in [How it is measured](index.md).

<!-- PENDING: 0.1.8 release soak row (filled from the release engineer's final table) -->

## How to read the tables

- **Idle CPU:** the app's CPU over about 57 s, sampled every 2 s.
- **Frozen fleet:** a mock server with three builds running, so their timers tick and nothing
  else changes. This is the hardest idle case: something on screen must change once a second.
- **Paused:** the fleet paused. Nothing on screen changes.
- **Busy:** the recorded fleet at 10× (`switchyard-server --demo --speed 10`) in 30 s windows. A
  few early rows are at 1×.
- **fps / p99:** Exact's display-link frame health. "p99" is the frame-time p99 bucket, so
  "16.5–17" means the 99th percentile frame fell in that bucket.
- **Heap:** the Hermes heap line (live plus external memory) the app writes to
  `~/Library/Logs/Switchyard/switchyard.log` every 30 s.

## Stability on the live fleet

A release soak runs the installed app against the live server for at least 20 minutes and
fails on a crash, a rising heap or external-memory slope, or a Yard that stops drawing
([Releasing](../../guides/releasing.md)).

| Release | Result | Heap peak | External memory | RSS |
|---|---|---|---|---|
| 0.1.3 | **Crashed after about 18 min**: Hermes out of memory on the old Factory floor, then the default view | hit the 64 MiB cap | grew about 0.13–0.15 MB/s (about 9 KB per drawn frame) | flat, 172–193 MB |
| 0.1.4 | **Crashed after about 4 min** (same cause); withdrawn | hit the cap | same | flat |
| 0.1.5 | Pass: a 30 min three-tab soak, a 30 min Yard soak and a 25 min release soak | 23.2 MB (cap now 512 MiB; gate 96 MB) | +1 % over the last 10 min | 138–251 MB |
| 0.1.6 | Pass: a 30 min soak cycling the tabs through view links, and a 25 min cycled release soak | 18.7 MB | flat, 8.6 MB | 138–220 MB |
| 0.1.7 | Pass: a 40 min soak (Live 20, Factory 10, Yard 10 min). Live heap half-means 15.85 and 15.86 MB, slope +0.002 MB/min | about 19 MB | flat, 7.8–8.8 MB | steps at each tab's first visit (+11 MB Factory, +15 MB Yard), flat within a tab: 188→214, 225→227, 242→243 MB |
| 0.1.8 | Pending: the release soak runs before the tag. A headless 60-minute trace of Live's retained heap on the live fleet found Live's own share growing about 0.004 MB/min, flat object counts | | | |

Switching tabs 25 times in a row (Live → Factory → Yard) grows RSS about 0.5 MB a round, slowing
down as it goes: 0.1.6 ends at 236–237 MB, 0.1.7 at 232–233 MB.

What the crash was and how it was fixed: [the macOS out-of-memory post-mortem](../../reports/incidents/2026-11-11-macos-oom.md).

## Idle CPU

Frozen fleet: three builds running, so timers tick.

| Release | Live | Factory | Yard | Canvas frames while idle |
|---|---|---|---|---|
| before 0.1.5 (`ca8a2b3`, the 0.1.4 line) | 10.9 % | 11.4 % | 13.0 % | 60 fps on every canvas, always |
| 0.1.5, first pass | 4.65 % | 6.55 % | 4.77 % | Live and the board 0; the Yard redrew once a second |
| 0.1.5 as shipped (`f6019ae`) | 2.86–3.28 % | 1.88–4.44 % | 3.05–3.60 % | Live and the board 0; the Yard about 12 per 30 s |
| 0.1.6 | 1.73 % | 1.40 % | 1.23 % | 0 |
| 0.1.7 | 2.00 % | 1.54 % | 1.19 % | 0 |
| 0.1.8 | **1.44 %** (1.84–1.86 % before Exact patch 0005) | 1.23–1.25 % | 0.89 % | 0 |

**Paused**, 0.1.7 and later: **0.09–0.11 % on every tab, 0 frames.** Earlier paused numbers
(1.3–1.6 %) were inflated by a bug in the test mock: it refused the stream and the app
reconnected in a loop. The mock was fixed, and in 0.1.7 the app stopped refetching the whole
fleet on every retry.

## Busy: frame rate

10× unless marked.

| Release | Live | Factory | Yard |
|---|---|---|---|
| 0.1.5 (`f6019ae`) | 1×: 60 fps, p99 16.5–17 ms | 1×: 60 fps. 10×: 40.5 fps, p99 192–384 ms (stalls) | 1×: 58.6–59 fps, p99 24–48 ms. 10×: 51.5 fps, p99 48–96 ms, about 90 % of frames late |
| 0.1.6 | 59.2 fps, p99 24–48 ms | 32–40 fps, 0.2–0.8 s stalls | 57.6 fps, p99 24–48 ms, 8 % late |
| 0.1.7 | 58.4 fps, CPU 16.7 % | **59.9 fps, p99 16.5–17 ms**, 0 of 196 frames missed | p99 16.5–17 / 21.5–22 ms, 1–2 % late |
| 0.1.8 | 56.8–58.7 fps, work p99 14–19.5 ms; CPU 16.5 → 13.9 % with patch 0005 | 59.7 fps | 59.3–59.5 fps; p99 16.5–17 ms in 2 of 3 windows, 24–48 ms in the third; about 5 % of frames late |

### Why the Yard is not a steady 17 ms p99

Every canvas is on the right rendering path: the moving layers draw on the GPU, the still ones
on Core Graphics. The Yard's remaining late frames are the main thread **waiting** on the data
module's turns (the 250 ms tick's commit, the per-frame tick) and on full Hermes garbage
collections that run inside them. Closing that gap needs a change in Exact's runtime: split a
timer turn's canvas draw from its commit, or run collection outside the calls that answer a
frame. The write-up with file and line references at the Exact pin is
[`app/upstream/exact-macos-frame-waits.md`](https://github.com/couplet-physical-ai/switchyard/blob/main/app/upstream/exact-macos-frame-waits.md);
the profiles are passes 4 and 5 in [macOS passes](mac-passes.md).

## Launch to connected

With a token file, against the live server.

| Release | Warm | Cold (first run of a new binary) |
|---|---|---|
| 0.1.5 | 0.86–0.98 s | 1.3–3.4 s |
| 0.1.6 | 0.78–0.79 s | 3.6 s |
| 0.1.7 | 0.70–0.78 s | 3.5 s |

About 2.5 s of a cold launch is macOS verifying and loading a binary it has never run, before any
app code. The app's own part is 0.7–0.9 s.

## Switching tabs

| Release | Result |
|---|---|
| 0.1.5 | Returning to a busy board: one 48–96 ms frame. |
| 0.1.6 | Re-entering the board: 0 frames. |
| 0.1.6–0.1.7 | The first-data window after connecting: one 96–192 ms frame (about 900 rows below the fold built in one batch). |
| 0.1.8 | First-data window: longest frame 14.5–15 ms (rows added four at a time); re-entering the board or the Yard: 15–22 ms of work. |

## Exact patches by release

The macOS build applies these patches to the pinned Exact; details and proofs are in
[Exact patches](exact-patches.md).

| Patch | First release | What it does | Proof |
|---|---|---|---|
| 0001 | 0.1.5 | Hermes heap cap 64 → 512 MiB | the OOM soak (heap peak 23.2 MB, far under the cap) |
| 0002 | 0.1.5 | The canvas recorder reuses its per-frame buffers (about 25× fewer bytes for a big frame) | byte-identical output on 78 replies |
| 0003 | 0.1.7 | The recorder parses each font string once | fuzz 300 of 300 identical |
| 0004 | 0.1.7 | `roundRect` with one radius without about 70 arrays per rectangle | fuzz 4,000 of 4,000 identical |
| 0005 | 0.1.8 | Live's text refresh touches only the paragraphs a batch changed | 0 px differ; Live idle 1.86 → 1.44 %, busy Live 16.5 → 13.9 % CPU |

## Soak CSV detail

The release soaks also export one sample a minute (RSS, the heap line and a cumulative canvas
frame counter). For 0.1.5–0.1.7 the 26-sample exports agree with the tables above: RSS 158–205,
149–189 and 188–234 MB; total heap 9.6–17.5, 9.6–18.5 and 9.6–19.3 MB (live 2.2–10.9 MB, external
7.4–8.7 MB). The frame counter is cumulative since launch, not a frame rate. A garbage-collected
heap moves between about 15 and 19 MB without leaking, which is why the gate compares slopes and
half-means rather than two samples.
