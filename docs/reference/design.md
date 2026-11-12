# Design language

Switchyard has one look across Live, the Factory and the Yard: a dark control-room screen in one
monospaced face, where colour means state and motion means work. This page states the rules, the
palette and the type, and where each is enforced. The history behind the rules is in
[the Factory decision](../decisions/0001-the-factory-is-the-berth-board.md).

## The hard rules

These are not preferences. Every view keeps them, and a change that breaks one is a bug.

1. **Motion is data. Idle is still.** Nothing moves unless a real event or real ongoing work
   drives it, one to one. No ambient streams, idle swarms, looping particles, breathing glows or
   "liveness" decoration. A running job may show its progress; a new commit may arrive; a run may
   travel from one place to the next because it really moved. When nothing happens, the screen
   does not change, and the app draws nothing and asks for no frames.
2. **State is colour on the thing itself.** The square, the glyph, the status word or the number
   carries the colour. No coloured borders, rails, outlines, underlines or tinted callout boxes.
   Sections are separated by whitespace and neutral grey hairlines.
3. **Dark, always.** Every surface is painted; there is no light theme.
4. **One typeface:** Commit Mono, regular and bold.
5. **No cranes,** and no decoration that is not data: no machines drawn for their own sake, no
   isometric depth that encodes nothing.
6. **One click to the source of truth.** Every run, commit, pull request, machine and app links
   to where it lives, from the server's own data, never a hard-coded host.
7. **Fit, don't scroll** (Factory and Yard). The canvas views fit the window at any size: no
   scroll, no drag, no zoom. Detail comes from pressing a thing.

## Colour

Three meanings, used the same way everywhere:

| Meaning | Colour | Where |
|---|---|---|
| normal | greys | passed results, up apps, empty slots, most of the screen |
| working now | amber `#E5B567` | a running job, a waiting run, a deploy in flight, a packet in motion |
| broken | red `#E06464` (marks), `#E3858C` (words) | a failed run, a red main line, a failed deploy, a down app |

Green (`#7FC48F`) appears only where "passed" is the exception worth seeing (Live's `LIVE` tag,
the Yard's pulse bars); at fleet scale green for "fine" would paint the screen and hide the red,
so the Factory has none. Exowatt orange (`#FF7212`) is for the focus ring and the mark only,
never for state.

The full token set lives in two places that must agree: the canvas palette
`app/src/yard/theme.ts` and the app's tokens `app/app.tamber` (`sy.<name>`).
`bun tools/check-theme.mjs` (from `app/`) checks that they match and that no ink used for words
is darker than `ink3`.

| Token | Hex | Role |
|---|---|---|
| `canvas` | `#0E0E0E` | the page |
| `raised` | `#151516` | panels, dialogs, the palette |
| `control` | `#1C1C1E` | segmented controls, inputs |
| `rule` | `#1F1F1F` | hairlines between sections |
| `edge` | `#2E2E30` | the edges of controls and chips |
| `ink` | `#F2F2F0` | names that matter now, titles |
| `ink2` | `#A3A3A3` | readouts, subtitles |
| `ink3` | `#8A8A8A` | captions; the darkest ink for words (5.6:1 on `canvas`) |
| `ink4` | `#6A6A6A` | marks only, never words |
| `amber` | `#E5B567` | working now |
| `amberText` | `#D8BA92` | amber words |
| `red` | `#E06464` | broken (marks) |
| `redText` | `#E3858C` | broken (words) |
| `green` | `#7FC48F` | passed, where it is the news |
| `up` | `#5A6E5F` | an app cell that is up (Yard) |
| `brand` | `#FF7212` | focus ring and the mark only |

## Type

One family, **Commit Mono** (SIL Open Font License 1.1), regular and bold, subset to Latin, arrows
and symbols, shipped in `app/assets/fonts/`. The canvases draw in the same face as the views.

- The headline of each view is the largest text (about 19–20 px, bold): the one sentence to read
  first.
- Everything else is 11–13 px on a 4/8 px rhythm. Names that matter are bold and `ink`;
  readouts are `ink2`; captions are `ink3`.
- Numbers that change in place use tabular digits, so a ticking timer does not jitter.
- Uppercase is for a few keywords (`LIVE`, `NOW`, `COMING`), never for data.

## Shapes

- **Squares** are the Factory's one mark: a run, a result, a bead, an app. A lit square is
  working or broken; a grey one is fine.
- **Rings** are the Yard's and Live's slots: one per slot, filled by how far the run is through
  its usual time.
- **Chips** (a 1 px dashed or solid neutral edge) carry steps and waits in Live and the Yard.
- **Hairlines** (1 px, neutral) separate sections and join the stages of an event in the
  Factory's ledger.
- **Selection** is four white corner brackets; hover is the same brackets in grey.

## Motion, precisely

| View | What may move | What may not |
|---|---|---|
| Live | A new event slides in; a job leaving "now" slides out; a running job's timer and step. | Anything when nothing changes. |
| Factory | A square travels when its run changed place between two versions of the fleet (about 0.6 s); a running job's timer and fill tick once a second. | Opening the page starts no motion. No loops. |
| Yard | Packets on the wires while commits travel; the replay's playhead. | Docked packets, idle machines, the dial when live. |

Ages ("4m", "red 2h") are said in whole minutes and turn together when the minute turns.
**Reduced motion** (the system setting) removes travel everywhere: things appear in their new
place with the same text and state.

How "idle is still" is enforced in code (the redraw key, the pulse, the wakes) is in
[the client architecture](../architecture/client.md); how it is measured is in
[Performance](performance/index.md).

## Accessibility

- Every word on the canvas meets 4.5:1 on the page colour (`check-theme.mjs`).
- The canvases carry a text description of the fleet (`role="img"` and a label that follows it).
- The Live feed and the inspectors are text, readable by assistive technology.
- Keyboard: ⌘1–⌘3 for the tabs, ⌘K for search, Space to pause, L for live, Escape to close
  ([Links, search and keys](../guides/links.md)).
