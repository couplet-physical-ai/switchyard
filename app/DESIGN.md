# Switchyard client — design

Switchyard shows Exowatt's whole delivery system as one living schematic: every push is a
packet that travels from its source, through the Roadrunner or GitHub Actions queue, onto
an engine slot, through the gates, onto its repo's main line, out through a deploy and into
an app whose health you can see. The look comes from Kit Langton's merge-process animation
(near-black, one monospace, thin gray wires, rounded machines with port tabs, amber packets,
progress rings, dot lines, red culprit labels, dashed step chips, `Pause | 1× | ¼×`) and
carries it to fleet scale: five orgs, ~400 repos, ~60 apps, live.

**Subject.** A CI/CD fleet in motion. **Audience.** Engineers and the people who run the
delivery system (Felipe first). **Job.** Answer "what is happening in delivery right now, and
where is it stuck?" in one glance, and let you follow any commit end to end in two clicks.

## Principles

1. **The yard is the thesis.** The first screen is the schematic, not a table of numbers.
   Everything else (main lines, PRs, journeys, fleet) is one keystroke away.
2. **Aggregate, then expand.** Never draw 400 tiny boxes. Stations are shared machines
   (queues, engines, gates, deploy); repos appear only where they carry information: as a
   packet's label while it travels, as one of the hottest main lines, as a red line.
   Everything else is a count with a way in (`+404 more · 3 red` → Mainlines).
3. **Motion means an event happened.** Nothing moves for decoration. A packet moves because
   a commit moved; a ring grows because a pipeline is running; a dot appears because main
   got a commit. When nothing happens the yard is still.
4. **State is form plus text, never colour alone.** A red main is a red dot *and* a
   `culprit` label *and* `red since 14:02` in words. Green/amber/red keep their meaning
   everywhere and are never used as decoration.
5. **Calm density.** Wires are 1 px gray, labels are small, white is reserved for the names
   that matter right now. Brightness is the hierarchy.

## Layout of the Yard (hero)

A map of the whole fleet in one screen, laid out as an L: the flow schematic across the top
left, the return wire under it, the bands of what is happening now and next below, and a
full-height column of main lines, the heatmap of every repo, deploy and apps on the right. A
32 px top bar holds navigation and search; a 26 px status line holds where the fleet comes
from, the time controls and the HUD switch.

```
┌ switchyard  yard mainlines prs fleet                                  search ⌘K ┐
│ LIVE  24 main lines red · 1 app down   392 repos · 23:58 · last hour 121 builds…  1 hour, sped up ◔│
│ sources       intake      engines · slots                gates  │ main lines · newest right   │
│ ▤ labs 47/h ╮ roadrunner  vm 153 · linux · 5/6  tidal-union 20m │ hollow-relay  red 8m  ●●○●◉│
│ ▤ ems  23/h ┼─┤▭▭  ├────▸ (◔)(◔)(◔)(◔)(◔)( ) ───────╮ ┌──┐ │ vivid-lantern red 35m ●●●◉│
│ ▤ …         │ stuck 19h   vm 154 · linux · 5/6  vivid-lantern  ├─┤╪ ├─┤ … (today's reds, LOD0)  │
│ ⚇ bots 25/h╯ actions     github actions · hosted · 1/4      │ checks │ early-canyon  red 21h ••••│
│ ─ failures ride home to whoever pushed them ─────────────────────────┘ │ … green lines, LOD1      │
│ NOW · hollow-relay #722 · main · broke main at notification-outbox · 8m ago │ every repo · 392 (heat)│
│  ci - - clone → [notification-outbox]    hollow-relay · main ●●●●●◉ red 8m · culprit 56abd48 │
│ COMING · IN ORDER · 1 waiting · 1 stuck over an hour        │ ▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪   │
│  #6 zinc-beacon  push·main → stuck 19h → roadrunner → ~56s  │ deploy · 1 deploying · rr 110 │
│  just finished (two columns of passed / failure chips)      │ apps · 237 of 237 up · by attention│
│ PULSE · LAST HOUR (bars, red = failed)   BUSIEST · LAST HOUR │ ▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪ │
├──────────────────────────────────────────────────────────────────────────────────┤
│ ● live  local server :8090  392 repos · 11 building · 1 queued · …   hud  Pause │1×│¼× │
└──────────────────────────────────────────────────────────────────────────────────┘
```

The headline (19 px, red when something is) is the first thing read; every other word is
11–12 px mono on a 4/8 px rhythm, with 1 px hairlines. Uppercase is for keywords only (`LIVE`,
`NOW`, `COMING`), never for data.

### Stations

| Station | Drawn as | Caption (amber stat, gray why) |
|---|---|---|
| **sources** | One row per org plus bots: activity glyph, name, pushes/h, a last-hour sparkline. Wires fan into intake. | `113/h · labs busiest` |
| **intake** | Roadrunner and GitHub Actions queue machines; queued packets dock inside, `+N` beyond what fits. | `1 stuck 19h`, `15s wait p50` |
| **engines** | One compact lane per host (VM 153, VM 154, the Mac mini, GitHub Actions): a machine sized to its slot circles, with a label band above it naming the host, platform, load and what runs there for how long (`tidal-union 20m`, amber when over 1.5× typical). Offline hosts are dashed with `last seen 24h ago`. | `11 of 16 busy · 56s typical · 1,531 today` |
| **gates** | The integrator's clamp, the review machine, and a strip of the last verdicts (a dot per finished pipeline, newest right). | `80% pass 24h` |
| **main lines** | Today's red lines at full detail (LOD0: bold name, culprit sha and author over the dot that broke it, the wire red from culprit to head), then the rest of the lines worth a row (LOD1/LOD2) with the newest commit's title in the rail's empty stretch. Success dots `#A3A3A3`, the head dot in ink, one ink3 tick under the newest deployed dot. | `24 red · 12 today · oldest 106 days` |
| **heatmap** | Every repo as one cell, grouped by org, flowing left to right; bright red = red today, dim red = red for longer. Hover a cell for its lens. | `every repo · 392 · 32 have rows above` |
| **deploy · apps** | The deploy machine, its counts by lane, then every app as a cell sorted by attention, problem apps named until the margin (`+N more`). | `1 deploying · roadrunner 110 · gha 9 · fallback 3` |
| **return wire** | The band's lower edge; labelled on the wire. A failed pipeline's packet turns red, is named `repo · sha · failing step`, and rides it home to its org row. | |
| **NOW** | The newest red on a main line (10 minutes), else the hottest build: its steps as dashed chips, parallel ones bracketed `all at once`, the failing step red; its main line beside it with the story in words. | `broke main at deps · 43s ago` |
| **COMING** | The queue in order as chip trains (`push · main → waiting 4m → roadrunner → ~56s build`), waits over an hour red, `N more behind these`; then what just finished, two columns. One count for the queue everywhere (`select.ts` `queueTruth`). | `3 waiting · 1 stuck over an hour` |
| **PULSE · BUSIEST** | The last hour per minute (green builds, red failures) and the busiest repos with their failures. | `121 builds · 41 failed · p50 34s` |

### Level of detail

Each element picks a level from its on-screen size and how many siblings are visible
(`lod.ts`), with 12 % hysteresis and a 150 ms crossfade, so nothing pops:

| Level | Engines | Main lines | Sources |
|---|---|---|---|
| LOD0 | machine with slots, rings, label band, every packet | dots, culprit labels, commit titles | rows with glyph and sparkline |
| LOD1 | compact machine, words to its right, exit wire under it | smaller dots, no labels | rows without sparklines |
| LOD2 | a pill per host: state colour and `busy/slots` | time-bucket bars | — |
| LOD3 | a cell per slot, a block per host | the heatmap only | a cell per source |

Hovering an element (pointermove → `hitAt`) promotes it to LOD0 in a lens: a repo's full main
line with its last commit, an app's live and main SHAs, a pipeline's step and timing, a host's
running pipelines, an org's push rate.

### Density by size

The layout is computed from the canvas (`layout.ts`); nothing is a scaled picture. At
1024×700 every band keeps its words (fitted with `…`), main lines show ~20 rows; at 1440×900
~35; at 1920×1080 ~50 with titles in full; at 2880×1800 the busiest list splits in two columns
and the rows reach ~70. A 4,000-repo stress fleet turns the sources, engines and heatmap to
LOD3 and keeps the band compact.

## Motion system

All motion is driven by events and by one clock (see *Time*). Nothing moves when nothing happens:
no idle bob, no turning dial in LIVE, no spinner. A pipeline with no typical duration shows a
still dashed ring.

- **Packet.** 9×6 px rounded rect. Amber while it travels; docked packets are dimmed
  (`#8A7146`), so brightness says "moving now". Bots carry a dark bar.
- **Travel.** Along the wires (curves sampled into polylines), eased, clamped to 420–1500 ms a
  hop; a fixed 60 Hz simulation with an interpolated render. At 60× three ghosts trail each
  traveller. Words are never crossed: machines are sized to their slots, labels sit in bands
  above, exit wires run where nothing is written.
- **Dock.** The k-th building pipeline of an engine sits in slot k, the same count the rings
  use; when the layout changes, docked packets snap to their new anchors.
- **Finish.** Success flashes the gate and pops a dot on the main line. Failure turns the packet
  red, flashes, lands on the main line, then rides the return wire named by what broke; NOW
  jumps to it.
- **Labels.** A packet is named on its first hop and on its way home after a failure; above 4×
  only failures are named. Labels never sit on machines or text, never overlap each other.
- **Coalescing.** At most 24 new packets a frame; the rest join the newest packet on the same
  wire as `×N`. Under the ladder's lower rungs packets sharing a stretch of wire merge into trains.
- **Replay.** A 1 px event-density strip across the top (red ticks for failures, an amber
  playhead), the dial's hand as progress.
- **Reduced motion.** No travel or trails: packets appear where they go. State and text are
  identical.

## Time

One playhead, in server milliseconds, drives everything the yard shows.

| Control | Meaning |
|---|---|
| **LIVE** | Playhead = the server's latest frame time plus local elapsed time. Deltas apply as they arrive. The tag reads `LIVE` in green. |
| **Pause** | The playhead stops; the world shown freezes. Deltas keep arriving into a local ring, so nothing is lost. The tag reads `PAUSED · −42 s`. |
| **1×** | The playhead moves at wall speed. After a pause it plays the buffered ring forward, behind live; the tag reads `−42 s` and a `LIVE` button jumps back. |
| **¼×** | Slow motion for a busy moment: the playhead moves at a quarter of wall speed. |
| **1 hour, sped up** | Fetches `/api/v1/history` for the last hour (its `base` is the state at the start) and plays it at 60×: an hour in a minute. The dial's hand sweeps once per loop; the tag reads `REPLAY · 13:12 → 14:12`. At the end it returns to LIVE. |

The data module holds two worlds: the live world (snapshot + every delta) and the shown
world (the live world in LIVE; otherwise a world rebuilt from a base and the frames up to the
playhead). The canvas reads the shown world every frame; Contract views read projections of
it through resources that re-ask on a 4 Hz tick, so lists never update faster than a person
can read. Under a test, the playhead follows the runner's clock, so a replay is
deterministic.

## Type

One family: **Commit Mono** (SIL OFL 1.1), regular and bold, subset to Latin, arrows and
symbols (26 KB each). Shipped in `assets/fonts/`; the canvas draws in the same face.

| Role | Size / weight | Use |
|---|---|---|
| headline | 19 / 700 | the yard's one sentence: `24 main lines red · 1 app down` |
| eyebrow | 11 / 400, uppercase, tracked; keywords only, never data | `LIVE`, `NOW`, `COMING · IN ORDER` |
| label | 11.5–13 / 400 | gray subtitles, readouts, list cells (canvas 11.5, views 13) |
| title | 13 / 700, white | station and repo names |
| chip | 11 / 400 | dashed step chips, badges |
| body | 14 / 400 | lists, detail text |
| heading | 20 / 700 | view titles in Mainlines, PRs, Fleet, Journey |
| figure | 32 / 400, tabular | Fleet's few big numbers |

Numbers that change in place use tabular digits.

## Colour

A deliberate single-theme world: dark always, every surface painted. Values sampled from the
inspiration and then tuned for contrast. The canvas palette (`src/yard/theme.ts`) and
`app.tamber` hold the same values; `bun tools/check-theme.mjs` checks that, and that every ink
for words is at least 4.5:1 on `canvas`.

| Token | Hex | Role |
|---|---|---|
| `canvas` | `#0E0E0E` | the page |
| `raised` | `#151516` | panels, sheet, palette |
| `control` | `#1C1C1E` | segmented control, inputs |
| `control.on` | `#2C2C2E` | the selected segment |
| `rule` | `#1F1F1F` | band rules |
| `wire` | `#2E2E2E` | wires; `#4A4A4A` while a packet is on them |
| `machine` | `#5A5A5C` | machine outlines, port tabs |
| `ink` | `#F2F2F0` | titles, names that matter now |
| `ink.2` | `#A3A3A3` | subtitles, readouts |
| `ink.3` | `#8A8A8A` | captions, chip text; the darkest ink for words on the canvas (5.6:1) |
| `ink.4` | `#6A6A6A` | marks only (rails, empty rings), never words |
| `packet` | `#E5B567` | packets in motion, rings, the running state |
| `packet.dock` | `#8A7146` | a packet at rest (amber is for motion) |
| `amber.text` | `#D8BA92` | amber prose (`1–7 min a landing`) |
| `green` | `#7FC48F` | success dots, `LIVE` |
| `green.fill` | `#232B25` | passed step chips |
| `red` | `#E06464` | failure dots, culprit |
| `red.text` | `#E08088` | red prose (`red since 14:02`) |
| `red.fill` | `#2D1D1F` | failed step chips |
| `dot` | `#A3A3A3` | success dots (the head dot is `ink`) |
| `up` | `#5A6E5F` | an app cell that is up |
| `brand` | `#FF7212` | Exowatt orange: focus ring and the mark only |

The Exowatt Fresnel mark (white) sits at the left of the top bar; the brand gradient appears
only in the app icon. Status colours are never used as series colours.

## Views

- **Mainlines** — every repo's default branch as a row: name, lane mode, state in words, the
  last 40 dots (newest right, end cap like the inspiration), `culprit` over the dot that broke
  it, a small mark over deployed commits, `fixed by a1b2c3` when a later commit turned it green.
  Sorted red first, then by heat; filtered by org and state; virtualized.
- **PRs** — every open PR as a dashed step-chip pipeline: `draft → checks → review → mergeable
  → merged → deployed`, the current phase solid with a packet on it, passed phases green-filled,
  `conflict` and `changes requested` red. Author badge (`autofix`, `renovate`, a person), checks as
  a row of small dots (required first), `stale 3d` in amber, `blocked by …`.
- **Commit journey** — one commit left to right: push → pipelines → workflows → steps as a
  waterfall on a shared time axis (Dagger spans, cached ones hatched) → deploy → the app's
  health after. Each segment says its duration.
- **Fleet** — apps (health, live vs main SHA and how far behind, last deploy and how, lane
  mode, latency), engines and runners (slots busy, CPU), queue pressure, the outage watcher,
  and 24-hour figures.
- **⌘K** — one field; instant matches from the client's own index, then the server's search
  for commits. Arrow keys move, Return opens, Escape closes.
- **Settings** — server URL and token (kept in the platform's secret store), connection and
  adapter status from `/api/v1/meta`. `switchyard://connect?server=…&token=…` fills both.

## Accessibility

The canvas carries a text description of the fleet (`role="img"` and a label that updates
at 1 Hz: `18 building, 12 queued, 3 main lines red, 2 apps down`), and every fact it shows is
also in a Contract view a screen reader can read (NOW, QUEUE, Mainlines, Fleet). Keyboard: tabs
by number keys `1`–`4`, ⌘K, Space for Pause, `L` for LIVE, arrows in lists. Focus rings in
`brand`. Reduced motion as above.

## Architecture (why it is fast)

- **One data module (TypeScript).** The stream mapper applies each frame to the world in
  module memory and answers Contract a tiny value (`seq`, a 4 Hz tick, a status). The canvas
  surfaces in the same module read the world directly, so animation never goes through Contract.
- **Four canvas layers** (`src/yard/draw.ts`): `yardStatic` (wires, machines, ports, the bus,
  the return wire) redrawn only when the layout changes; `yardInfo`, panels of words and data
  each redrawn only when what it shows changed (`info.ts`, a cached UI atlas); `yardLive`,
  packets, rings, effects, labels, the dial, every frame while anything moves and asleep
  otherwise (the 4 Hz tick redraws it); `yardTop`, the hover lens and the HUD.
- **Frame budget and quality ladder** (`budget.ts`): a cost model per frame (operations, arcs,
  texts, sprites, priced per executor), a 6 ms draw budget, five rungs (full → lean → flat →
  trains → survival) stepped down after sustained overruns and up after good frames, with
  hysteresis and a doubling back-off against flapping. Lower rungs drop glow and labels, square
  the dots, merge packets into trains and draw the static layer at low detail.
- **Batched, pooled, culled.** One path per colour; packets in typed arrays (12,288, zero
  allocation per frame); off-screen sprites culled; glyph advances cached (no host
  `measureText` round trips); aggregates time-sliced (400 repos a frame).
- **Stress mode** (HUD or Settings): a synthetic 10× fleet built from the real one's census in
  typed arrays (`stress.ts`), 10,000 packets on the real wires, to keep the ladder honest.
- Numbers: `PERF.md`.
