# Client architecture

Switchyard has one Exact app definition and one data module for the browser and macOS clients. The contract describes the views, state, tasks, and controls; the data module answers small queries and draws canvases from the fleet world.

## One app, two hosts

[`app/app.contract`](https://github.com/couplet-physical-ai/switchyard/blob/main/app/app.contract) defines routes, resources, state, actions, background tasks, and the shared UI. [`app/app.ts`](https://github.com/couplet-physical-ai/switchyard/blob/main/app/app.ts) implements the data module: it connects to the server, owns the client-side world and timeline, answers view-model queries, and supplies canvas drawing. A source answers a focused question; canvas surfaces read the world directly when they draw. The app's host and rendering rationale is described in [`app/DESIGN.md`](https://github.com/couplet-physical-ai/switchyard/blob/main/app/DESIGN.md); Exact-specific conventions are in [`app/AGENTS.md`](https://github.com/couplet-physical-ai/switchyard/blob/main/app/AGENTS.md).

| Host | Runtime | Delivery |
|---|---|---|
| Web | Exact's browser host | The server serves the static web build. The page uses the same-origin server session and can offer a reload when the served web build changes. |
| macOS | Exact's native host, with the data module running on Hermes | The native app uses the same contract and data module, plus native modules for device-token storage and the updater. |

## Views and modules

The current client has three main views:

| Route | View | What it shows |
|---|---|---|
| `/` | Live | A time-ordered feed of events and the jobs they started, their current step and location, and their result. |
| `/factory` | Factory | The berth board: six stations from waiting through apps, with a ledger of events and an inspector for a selected run. |
| `/yard` | Yard | The fleet schematic, with repositories, engines, CI work, deployments, and apps. |

The earlier Factory implementations in `app/src/factory/` and `app/src/flowfloor/` are being retired. The current `/factory` view is Factory 3, implemented in [`app/src/factory3/`](https://github.com/couplet-physical-ai/switchyard/tree/main/app/src/factory3).

The data module's main pieces are:

| Module | Responsibility |
|---|---|
| [`app/src/world.ts`](https://github.com/couplet-physical-ai/switchyard/blob/main/app/src/world.ts) | Holds the current snapshot as entity maps and applies each wire frame. State operations land before that frame's event listeners run. |
| [`app/src/timeline.ts`](https://github.com/couplet-physical-ai/switchyard/blob/main/app/src/timeline.ts) | Drives Live, Paused, Behind, and Replay modes from server-time frames and history. |
| [`app/src/yard/`](https://github.com/couplet-physical-ai/switchyard/tree/main/app/src/yard) | Lays out the Yard, selects fleet entities, keeps its drawing budget, and renders static, information, live, and top canvas layers. |
| [`app/src/factory3/`](https://github.com/couplet-physical-ai/switchyard/tree/main/app/src/factory3) | Builds the Factory berth board, its live transits, inspector, and log view. |
| [`app/src/now/`](https://github.com/couplet-physical-ai/switchyard/tree/main/app/src/now) and [`app/src/flow/`](https://github.com/couplet-physical-ai/switchyard/tree/main/app/src/flow) | Build Live's bounded, time-ordered event and job rows from the world. |
| [`app/src/totals.ts`](https://github.com/couplet-physical-ai/switchyard/blob/main/app/src/totals.ts) | Shares counts for building, queued, failing, and healthy work across the views. |

View components and their contracts live under [`app/views/`](https://github.com/couplet-physical-ai/switchyard/tree/main/app/views). They include Live, Factory, shared shapes, token state, native update state, web reload state, and native test hooks.

## Drawing and time

The Yard uses canvas layers for stable structure, changing information, and live marks. Factory 3 separates its mostly still board from the layer that draws a run moving to a new station. A transit exists only when a real world update changes that run's place; there is no ambient animation.

The overview's `ov.tick` is the redraw key. It advances only when data or a displayed time-dependent value changes. The `ov.pace` value selects the least work needed:

- `0`: a 250 ms pulse for demo, replay, behind-live playback, the HUD, or stress mode.
- `1`: a one-second tick when a visible timer needs to advance; it does not ask for an unrelated overview redraw.
- `2`: no pulse. The client schedules one-shot wakes at the next relevant time boundary, and incoming stream frames wake the views that depend on them.

When the view is paused and no data changes, the playhead and canvases stand still. Covered canvas layers also sleep until their view is shown again. The implementation is in [`app/app.ts`](https://github.com/couplet-physical-ai/switchyard/blob/main/app/app.ts#L551) and the task declarations are in [`app/app.contract`](https://github.com/couplet-physical-ai/switchyard/blob/main/app/app.contract#L132).

## Device token and test hooks

The browser can store a device token for that origin in `localStorage`; the standard web app uses its same-origin SSO session and does not need separate token setup. The macOS host stores its token in a user-readable file with mode `0600` inside a private application-support directory. The data module reads it once asynchronously, keeps the value out of Exact answers and logs, and exposes only connection status to the contract.

For native test or managed launch flows, `SWITCHYARD_TOKEN_FILE` names a token file with mode `0600`. The native hook reads it once, validates it like a `switchyard://connect` link, connects, and reports the result without putting the token into a persisted Exact answer. The hook is implemented in [`app/src/hooks.ts`](https://github.com/couplet-physical-ai/switchyard/blob/main/app/src/hooks.ts), [`app/views/hooks.contract`](https://github.com/couplet-physical-ai/switchyard/blob/main/app/views/hooks.contract), and the native host module.

`app/app.contract` assigns stable `testId` values to controls and canvases. The view contracts also define the updater, web-reload, token, and native-hook states used by the contract tests. These let tests exercise connection, update, and redraw behavior without a live user token.

## Updates

The macOS updater checks for a newer build and displays an Update action; it swaps the bundle only after the user chooses to relaunch. The web build has no updater. It compares its build metadata with `/api/v1/meta` and offers a reload after the server serves a newer web build. See [`app/views/update.contract`](https://github.com/couplet-physical-ai/switchyard/blob/main/app/views/update.contract), [`app/views/webreload.contract`](https://github.com/couplet-physical-ai/switchyard/blob/main/app/views/webreload.contract), and the [release guide](../guides/releasing.md).
