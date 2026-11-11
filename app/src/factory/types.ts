// The factory floor's shared types (fab-w0, FACTORY-SPEC §I "W0"): the floor plan, the layer
// contract every stage implements, and the small shapes the layers hand each other.
//
// THE HOOK SURFACE (stable; wave-A workers code against it while W0 moves factory.ts apart).
// Every member below keeps its name and signature; renaming or re-typing one is a breaking
// change for the files that reach it. Members of `Factory` (factory.ts) used outside it:
//
//   lens.ts and coffee.ts, as `f.<member>` (`f` is the Factory):
//     world: World · tl: Timeline · cam: Cam · census: Census · plan: Plan (PLAN, layout.ts)
//     fx: FactoryFx (the factory itself) · lens: Lenses · coffee: Coffee · budget: Budget
//     px, py: number (the last pointer) · hoverId: string · selected: string · offsetMin: number
//     select(id, kind): void · hitAt(x, y): HitBox | null
//   lens.ts's FactoryFx (`fx.<member>`, typed there as `Factory['<member>']`):
//     box(g, u0, v0, du, dv, h, top?, side?, front?, edge?, lw?): void
//     crate(g, u, v, d, red, dim, z?): void · car(g, u, v, red, settled): void
//     quad(g, u0, v0, u1, v1, z?): void · poly(g, pts: number[] /* u, v, z triples */): void
//     hit(x, y, w, h, kind, id, label): void
//     placeAt(x, y, w, h, maxUp, slide): [number, number] | null
//     dockV(org): number · railV(org): number
//     bays: Bay[] · blocks: Block[] · blockAt: Map<string, Block> · districtBox: DistrictBox[]
//     hits: HitBox[] (lens.ts's `Hit` is `Factory['hits'][number]`) · labels: Label[]
//   The plan's keys lens.ts and coffee.ts read (`P = f.plan`): AGE_V AISLE_V CITY_U0 COLLECT_U
//     DIST_U DOCK_U0 DOCK_U1 ENG_DV ENG_H ENG_STEP ENG_U0 ENG_U1 ENG_V0 GATE_U INTAKE_U0
//     INTAKE_U1 LANE_V PALLET_V RAIL_U0 RAIL_U1 RAIL_V RETURN_V ROW_DU ROW_U SCAN_U STACK_DV
//     TRACK_U1 TRACK_V YARD_U0 YARD_U1 (and every other key of `Plan` stays).
//   app.ts: new Factory(tl) · hud · setStress(on) · onEvent(e, w, t) · floorKey · selected
//     · budget · stress · calm · statsLine() · counts() · pointer(kind, x, y, buttons, t)
//     · journey · journeyFor · selCommit() · offsetMin · cam · coffee · wheel(total)
//     · drawFloor(ctx, frame, t) · reduced · drawLive(ctx, frame, t, wheel)
//   tools (turns.ts, factory-bench.ts) reach the factory only through app.ts's sources/draw.
//   factory.ts also still exports `dur` and the type `Plan`.
//   seams.ts, hud.ts and motion.ts reach nothing on Factory (they do not import it).
//   New with the split (additive): the layers by name (`floor`, `plant`, `city`, `crates`,
//     `reactions`, `words`), the registry `order`, the chrome (`drawer`, `strip`), the scratch
//     batches `bA`..`bD`, `stat`, `selPipeline()`, and `overlay(g, lens)`, which runs the layers'
//     `overlay` hooks for the lens on top (lens.ts may call it; nothing implements it yet).
//   pointer() and select() stay in factory.ts (W3's hook; W7 owns the loop).
//
// THE LAYERS (layers.ts, back to front). The loop (factory.ts) runs every layer's hook in
// registry order: `onEvent` as events land, `census` after each census check, `floor` when the
// static floor repaints, `hits` and `live` every live frame (under the lens), `overlay` when a
// lens the layer owns is on top. A layer keeps its own state; it reaches the floor's shared
// things (camera, census, world, scratch batches, the hit list) through `f`, the Factory.

import type { Ctx2D, Frame } from '../../app.contract.d.ts';
import type { Event } from '../wire.ts';
import type { World } from '../world.ts';
import type { Gfx } from '../yard/gfx.ts';
import type { Lens } from './lens.ts';

export type { Lens };

/** A floor point (world units u, v). */
export type Pt = [number, number];

/** The deploy routes, back to front (the three tracks). */
export type Via = 'roadrunner' | 'gha' | 'gha_fallback';

/** The floor plan: where every stage sits, in world units (u: left → right, v: back → front;
 *  the floor is LU × LV, iso.ts). Today's constants are PLAN (layout.ts). */
export interface Plan {
  /** sources: the org docks (u), and the collector belt they feed (u) */
  readonly DOCK_U0: number; readonly DOCK_U1: number; readonly COLLECT_U: number;
  /** the aisle (v) every push rides from the collector to the gate */
  readonly AISLE_V: number;
  /** the PR yard: its slab (u), the phase rows' centres (u) and width, the age buckets' fronts
   *  (v, newest first) and depth, the bot pallets' row (v) */
  readonly YARD_U0: number; readonly YARD_U1: number; readonly ROW_U: readonly number[]; readonly ROW_DU: number;
  readonly AGE_V: readonly number[]; readonly STACK_DV: number; readonly PALLET_V: number;
  /** the merge gate (u) */
  readonly GATE_U: number;
  /** the main-line rails: their span (u) and one v per org */
  readonly RAIL_U0: number; readonly RAIL_U1: number; readonly RAIL_V: readonly number[];
  /** the intake: its span (u) and its two lanes (v: roadrunner, gha) */
  readonly INTAKE_U0: number; readonly INTAKE_U1: number; readonly LANE_V: readonly number[];
  /** the distributor belt (u) that feeds the machines */
  readonly DIST_U: number;
  /** the consumption engine: the machines' span (u), the first one's back (v), the step between
   *  machines (v), a machine's depth (v) and height */
  readonly ENG_U0: number; readonly ENG_U1: number; readonly ENG_V0: number; readonly ENG_STEP: number; readonly ENG_DV: number; readonly ENG_H: number;
  /** the test scanner (u) */
  readonly SCAN_U: number;
  /** the deploy tracks (one v per via) and where they end (u) */
  readonly TRACK_V: readonly number[]; readonly TRACK_U1: number;
  /** the city of apps' plot */
  readonly CITY_U0: number; readonly CITY_U1: number; readonly CITY_V0: number; readonly CITY_V1: number;
  /** the return conveyor along the front edge (v) */
  readonly RETURN_V: number;
  /** the deploy routes, one per track */
  readonly VIAS: readonly Via[];
}

/** A crate in flight along its route (an event's token). */
export type Crate = {
  id: string; kind: 'commit' | 'pipeline' | 'pr' | 'deploy'; route: Pt[]; len: number; cum: number[];
  t0: number; dur: number; red: boolean; label: string; org: string; hold: number;
  /** The route as a small integer (the trains' key), -1 until asked. */
  rid: number;
};
/** Something on screen the pointer can pick (screen px), drawn this frame. */
export type HitBox = { x: number; y: number; w: number; h: number; kind: string; id: string; label: string };
/** A placed label's box (screen px; y is its baseline). */
export type Label = { x: number; y: number; w: number; h: number };
/** An engine slot: its recess on the machine's top, the machine (`group`), the slot, its job. */
export type Bay = { u: number; v: number; du: number; dv: number; group: number; slot: number; pid: string };
/** A city block; `hv` -1: a real app (health from the world), ≤ -2: stress copy -2-i, 4: idle. */
export type Block = { id: string; u: number; v: number; d: number; h: number; district: number; hv: number };
/** A team's district in the city (world units) and its app count. */
export type DistrictBox = { team: string; u0: number; v0: number; u1: number; v1: number; n: number };

/** The static floor's repaint, handed to each layer's `floor` hook in registry order. */
export interface FloorPass {
  readonly g: Gfx;
  /** the ladder's low-detail floor (quality ≥ 3) */
  readonly lo: boolean;
  /** no fleet yet (the idle skeleton) */
  readonly idle: boolean;
  /** An extruded thing on the floor box (u0..u1, v0..v1, 0..h): painted after every layer's
   *  hook, far to near across all layers (by u·0.19 + v·0.66), skipped when off screen. */
  add(u0: number, v0: number, paint: () => void, u1: number, v1: number, h: number): void;
  /** Painted after the sorted things, in the order asked (the cars, then the city). */
  after(paint: () => void): void;
}

/** One live frame, handed to every layer's `hits`, `live` and `overlay` hooks. */
export interface LiveFrame {
  ctx: Ctx2D;
  f: Frame;
  /** the frame clock (frame.time, ms) */
  t: number;
  /** the world's time (the playhead, server ms) */
  now: number;
  /** the frame budget's quality rung (0 full … 4 survival) */
  q: number;
  /** zoomed in (z ≥ 1.6): names and counts appear */
  detail: boolean;
}

/** A stage of the floor (FACTORY-SPEC §I): every hook optional. */
export interface Layer {
  readonly name: string;
  /** An event landed (the timeline's listener): send its crates, schedule its ripples. Runs
   *  after the floor's own bookkeeping (reduced motion skips events; crates are capped). */
  onEvent?(e: Event, w: World, t: number): void;
  /** After every census check (each draw, recounted or not): layouts that follow the fleet's
   *  shape. Keep it cheap when nothing moved. */
  census?(w: World): void;
  /** The static floor (`factoryFloor`): paint flat things now, `add` extruded ones (depth-sorted
   *  across layers), `after` what sits over them. */
  floor?(fp: FloorPass): void;
  /** Hit boxes for the layer's objects, before anything live is drawn. */
  hits?(fr: LiveFrame): void;
  /** The live layer (`factoryLive`), under the lens; true while something of it still moves
   *  (the layer keeps getting frames). */
  live?(g: Gfx, fr: LiveFrame): boolean | void;
  /** The lens on top is one of this layer's kinds: draw its story; true when it drew. */
  overlay?(g: Gfx, lens: Lens, fr: LiveFrame): boolean;
}
