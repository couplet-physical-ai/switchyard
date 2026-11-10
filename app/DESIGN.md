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

Three bands, as in the inspiration: **LIVE** (the schematic), **NOW** (one pipeline up
close), **QUEUE** (what runs next, in order). A slim top bar holds navigation and status; a
bottom bar holds the time controls.

```
┌ switchyard   yard  mainlines  prs  fleet                      ⌘K search      ● LIVE ┐
│ LIVE · ALL ORGS · 412 repos                                       1 hour, sped up ◔ │
│                                                                                       │
│ sources          intake          engines · roadrunner     gates        main lines     │
│ ▤ Northwind-Labs ─╮ ┌──────┐       ┌ VM 153 · dagger ┐   ┌──────┐   cicd ●●●●●◉●●▕    │
│ ▤ Northwind-EMS  ─┼─┤ ▭▭▭  ├══════╡ ◔ ◔ ◔ ○ ○ ○ ○ ○ ╞═══╡ ═╪═  ╞══ omega ●●●◉●●●▕    │
│ ▤ Forge        ─┤ │ +9   │       └─────────────────┘   └──────┘   …  (hottest 8)     │
│ ▤ couplet      ─┤ └──────┘       ┌ VM 154 · dagger ┐   ┌──────┐   +404 more · 3 red  │
│ ▤ copper       ─┤ ┌──────┐       │ ◔ ○ ○ ○ ○ ○ ○ ○ │   │ AI   │                       │
│ ⚇ bots         ─╯ │ gha  ├══════╡ runners · gha    │   │review│   deploy ═══ ▪▪▪▪▪▪▪  │
│                   └──────┘       └─────────────────┘   └──────┘   ┌────┐     ▪▪▪▪▪▪▪  │
│ ╰──────────────── back to the author that wrote it ─────────────────────────────╯   │
├───────────────────────────────────────────────────────────────────────────────────────┤
│ NOW · Northwind-Labs/cicd #8812, building on VM 153                                    │
│  - - clone → deps → [build] → test → lint - -   ● ● ● culprit ● ● ●                   │
├───────────────────────────────────────────────────────────────────────────────────────┤
│ QUEUE · IN ORDER · 12 waiting · oldest 3m 10s                                         │
│  wp 4021  Northwind-EMS/plant-controller   push · main      waiting 2m 40s               │
├───────────────────────────────────────────────────────────────────────────────────────┤
│ 412 repos · 18 building · 12 queued · 61 of 63 apps up            Pause │ 1× │ ¼×     │
└───────────────────────────────────────────────────────────────────────────────────────┘
```

### Stations, left to right

| Station | What it is | How it is drawn | Data |
|---|---|---|---|
| **sources** | Where commits come from: one row per org, plus one row for bots (AUTOFIX, Renovate, agents) | An activity glyph (a rounded rect with 0–3 lines, the inspiration's "builder" document: lines = pushes in the last 10 minutes), the org name, `31/h`. Wires leave each row and fan into intake. | `push` events, `orgs`, commits in the last hour |
| **intake** | The Woodpecker queue (Roadrunner) and the GitHub Actions scale set | Tall machines with port tabs. Queued packets stack inside, oldest at the bottom; beyond five, `+N`. Below: `12 waiting · oldest 3m`. | `queues`, `enqueue` |
| **engines** | Dagger engines VM 153 / VM 154, Woodpecker agents, GHA runners | One machine per engine group with a circle per slot (the inspiration's hand-off circles). A running pipeline is a packet in its slot with a progress ring: elapsed over the repo's typical duration; an indeterminate quarter arc when unknown. Header `VM 153 · dagger`, sub `6/8 · cpu 63%`. | `engines`, `start`, `step` |
| **gates** | Required checks and the AI PR reviewer | The inspiration's integrator (a clamp glyph that closes as a packet passes) and a review machine below it. The machine's subtitle shows the step that just ran (`test on Linux`). | `finish`, `pr` |
| **main lines** | Default branches | The 8 hottest repos (by `heat`, red ones always first) as dot lines: `repo · green` or `repo · red since 14:02` with a `culprit` label over the dot that broke it. A ring marks a commit still running. A last row aggregates the rest: `+404 more · 3 red`. | `repos[].main`, `main` |
| **deploy** | provisioning-api and the failsafe | A machine whose port tabs show the lane mode a deploy used (`roadrunner`, `gha`, `fallback`). | `deploys`, `deploy` |
| **apps** | Every app's health | A grid of small squares, one per app, sorted by name; up is pale gray, degraded amber, down red with its name beside it. A deploy pulses its square. | `apps`, `health` |
| **return wire** | Failures go back to the author | A long wire along the bottom; a failed pipeline's packet turns red and travels it back to its org row (`back to the author that wrote it`). | `finish` with failure |

### Expanding on focus

Hovering a station highlights its wires and shows a one-line readout; clicking selects it.
Selection drives the NOW band (an engine shows its running pipelines; a main line shows that
repo; an org shows its busiest repos) and every selection has a deep route (Mainlines filtered
to the repo, the commit journey, the app in Fleet). ⌘K reaches any repo, PR, commit, app or
pipeline directly.

### Density by width

The yard is laid out from the canvas size, not scaled from a fixed picture:

| Canvas width | Main lines | Dots per line | Apps grid | Gates |
|---|---|---|---|---|
| ≥ 1600 | 10 | 24 | 12 columns | own column |
| 1200–1600 | 8 | 16 | 10 columns | own column |
| 960–1200 | 6 | 12 | 8 columns | folded into engines |
| < 960 | the yard draws at 960 logical px and scales down to fit; NOW/QUEUE stack | | | |

Height: below 640 px of canvas the QUEUE band collapses to one line; below 520 the NOW band
does too.

## Motion system

All motion is driven by events and by one clock (see *Time*). Durations are wall time at 1×.

- **Packet.** 12×8 px rounded rect (2 px radius), amber `packet`. A bot's packet has a 1 px
  dark inner bar (the inspiration's document mark). A tiny pip at its top-right turns green or
  red when its pipeline finishes.
- **Travel.** Along the wire's path (straight runs and quarter-circle corners, no free
  béziers except the source fan-in), eased in and out (cubic), ~260 px/s, each hop clamped to
  450–1400 ms. Above ~500 px/s a packet draws a 3-step fading trail behind it, which is the
  streak the inspiration shows on fast moves.
- **Dock.** A packet slows into its slot; the slot's ring starts at 0 and grows with elapsed
  time. Port tabs on a machine light amber while a packet passes through them, then fade over
  400 ms.
- **Finish.** Success: a white ring flashes once around the packet (180 ms) and it travels to
  its main line (or the PR bin), where a dot pops in (radius 0 → 5.5 → 4.5, 240 ms). Failure:
  the packet turns red, the dot lands red with a `culprit` label fading in above it, and a red
  copy travels the return wire to its org.
- **Labels.** A packet carries its repo name for its first hop (fades out over 1.2 s), so a
  burst is readable without a legend.
- **Health.** An app square crossfades in 300 ms; going down adds its name beside it.
- **Coalescing.** A frame never spawns more than 24 packets; the rest of a burst merges into
  one packet per org labelled `×N`. At most 160 packets are in flight; beyond that new ones
  merge into the newest packet on the same wire. A 1,000-event burst therefore costs one frame
  of bookkeeping, not 1,000 animations.
- **Reduced motion.** No travel: packets appear at their destination, rings show their value
  without sweeping, dots appear without popping, the dial does not turn. State and text are
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
| eyebrow | 12 / 400, uppercase, tracking 0.08em | `LIVE · ALL ORGS`, `NOW`, `QUEUE · IN ORDER` |
| label | 13 / 400 | gray subtitles, readouts, list cells |
| title | 13 / 700, white | station and repo names |
| chip | 11 / 400 | dashed step chips, badges |
| body | 14 / 400 | lists, detail text |
| heading | 20 / 700 | view titles in Mainlines, PRs, Fleet, Journey |
| figure | 32 / 400, tabular | Fleet's few big numbers |

Numbers that change in place use tabular digits.

## Colour

A deliberate single-theme world: dark always, every surface painted. Values sampled from the
inspiration and then tuned for contrast (checked by `tools/contrast.mjs`, WCAG 2.2 against
`canvas`).

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
| `ink.3` | `#7C7C7C` | captions, chip text (4.5:1) |
| `packet` | `#E5B567` | packets, rings, the running state |
| `amber.text` | `#D8BA92` | amber prose (`1–7 min a landing`) |
| `green` | `#7FC48F` | success dots, `LIVE` |
| `green.fill` | `#232B25` | passed step chips |
| `red` | `#E06464` | failure dots, culprit |
| `red.text` | `#E08088` | red prose (`red since 14:02`) |
| `red.fill` | `#2D1D1F` | failed step chips |
| `gray.dot` | `#9A9A9C` | pending / skipped / canceled dots |
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

- **One data module (TypeScript).** The stream mapper applies each frame to the live world in
  module memory and answers Contract a tiny value (`seq`, a 4 Hz tick, a status). A canvas
  surface in the same module reads the world directly every frame, so animation never goes
  through Contract.
- **Two canvas layers.** A static layer (wires, machines, labels, dot lines, the apps grid)
  redraws only when the world or the size changes; a live layer draws packets, rings and port
  lights every frame and returns `true` to keep animating.
- **Batched paths.** One path per colour per layer, so a frame is a few hundred drawing
  operations, not thousands.
- Measured on the spike (prod web build, headless Chromium, 1440×900: 727 packets, steady 60
  fps, p99 frame 16.8 ms, 0 long tasks; macOS development build on the M-series mini, two
  layers, 150 packets: 60.00 fps, 0 missed of 300 frames). The full numbers for the real app
  are in `PERF.md`.
- TypeScript, not a Rust data module: the reducer handles a frame of 100 ops in well under a
  millisecond (PERF.md), and the canvas `draw` must be TypeScript anyway, so a Rust module
  would add a boundary to cross every frame for no gain.
