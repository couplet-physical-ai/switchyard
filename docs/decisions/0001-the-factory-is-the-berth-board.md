---
status: accepted
date: 2026-11-12
---

# The Factory is the berth board

This record explains how the Factory moved from a detailed animated floor to a fixed board of real work. The berth board is the accepted design; its visual design is frozen.

## Context

Switchyard needs to show the fleet's flow from source events through waiting, building, checks, main lines, deploy, and apps. The Factory must make current work and anything broken right now obvious. A user must be able to press an item and reach the decisive log line, not just see a status mark.

The first Factory designs tried to make the whole software factory visible at once. Successive versions traded too much information for too little, and the square-swarm version showed motion that did not correspond to work. The final design needed a useful middle ground: an at-a-glance flow, enough event history to explain what happened, and a direct route to evidence.

## Decision

Use the **berth board**: six stations in flow order—waiting, building, checks, main lines, deploy, and apps—over a ledger of events. Source events enter the flow at waiting. The camera is fixed to the window. Pressing a run or mark opens an inspector with its details and the decisive log line. Nothing moves unless a real run changes place.

The product owner accepted this version as “the UI is finally good.” The Factory's visual design is frozen.

## Options considered

The sequence below records the decisions in the order they were made.

### (a) The Yard schematic

The Yard was the first overview: a schematic of work moving through the fleet. It remains useful as its own tab. It did not replace the need for a Factory view with one fixed, flow-ordered board and an event ledger, so it was kept rather than discarded.

### (b) Factory B: the isometric old floor

Of three initial Factory concepts, the product owner chose the 2.5-D isometric floor. It was built in phases and became the default in the 0.1.x releases. Team lanes, a PR yard, merge gate, consumption engine, app city, and 24-hour history wall made it rich; the “coffee check” was meant to make a quick daily scan possible.

It lost because the floor was hard to read and expensive to keep animating every frame. On macOS it produced about 9 KB of draw-list data per frame. That cost fed the investigation of the app's out-of-memory failures. More history, lenses, and callouts had added detail without making the immediate path easier to see.

### (c) The redesign from zero

The redesign made Live the default feed and kept Factory and Yard as separate tabs. It established a simpler visual language, including the rule against colored borders, rails, and tinted callouts. It was the right change to the app's default view, but it did not solve the remaining Factory design problem.

### (d) Factory redo, rounds one and two

In round one, concepts A and B were rejected as too boring. Round two explored six directions: circuit board, particle river, night transit, reactor, robot-arm hall, and foundry. None was kept as a standalone design; the next pass combined selected traits into one square-based flow.

### (e) The “square swarm” synthesis

The synthesis used only square forms: a swarm of cubes along right-angled lanes, blocky engine bays with robot arms, a QC light curtain and slag pit, named main-line rows, a deploy press, and an app skyline. It shipped in six small steps at `/factory?v=2`, briefly became the default Factory, and carried more of the flow than the earlier floor.

It was rejected because its cubes kept moving when no work moved. That made the display untruthful. The resulting rule is **motion is data; idle = still**. A moving mark must correspond to a real event or ongoing run.

### (f) The berth board

A new designer rebuilt the Factory from scratch using the brief called FACTORY3. The board keeps the key stages and enough context to inspect recent events, without the old floor's density or the swarm's empty motion. The product owner accepted it as “the UI is finally good”; the UI was frozen.

## Consequences

- The older floors are retired. Every `/factory?v=…` link opens the berth board.
- **Motion is data.** Idle means still; only a real event or ongoing work can move a mark.
- **No colored borders, rails, outlines, or tints.** Use neutral separation. Put state color on the item or glyph itself.
- Keep the view dark and use Commit Mono only. Do not use cranes.
- Keep the camera fixed to the window; let a press open the inspector instead of requiring pan, zoom, or page scrolling.
- Repaint only changed marks. The board must not resend its unchanged scene every frame.
- The visual design is frozen. Changes to data, behavior, or performance must preserve these decisions; a visual redesign requires a new decision record.

## History anchors

These public commits mark the main design transitions:

- [The first Yard and client views (`c713fa9`)](https://github.com/couplet-physical-ai/switchyard/commit/c713fa9).
- [The isometric Factory floor (`4a7b75a`)](https://github.com/couplet-physical-ai/switchyard/commit/4a7b75a).
- [The Live-first redesign and view cleanup (`f714d91`)](https://github.com/couplet-physical-ai/switchyard/commit/f714d91).
- [The square-swarm design (`4674f19`), then its move to the default Factory route (`0a99b64`)](https://github.com/couplet-physical-ai/switchyard/commit/4674f19).
- [The berth-board design (`1393bf0`) and default route (`802d36f`)](https://github.com/couplet-physical-ai/switchyard/commit/802d36f).
- [Still-board behavior (`0acea6a`) and repainting only changed marks (`dde9d1d`)](https://github.com/couplet-physical-ai/switchyard/commit/dde9d1d).
- [Retirement of the older floors (`6d6338b`)](https://github.com/couplet-physical-ai/switchyard/commit/6d6338b).
