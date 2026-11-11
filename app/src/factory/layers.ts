// The factory's layers (fab-w0, FACTORY-SPEC §I): the ordered registry of the floor's stages.
// The loop (factory.ts) runs every hook of every layer in this order, back to front: events as
// they land, the census check, the static floor's repaint (its extruded things depth-sorted
// across layers), and each live frame's hits and drawing, all under the lens system (lens.ts)
// and the chrome (the journey, the drawer, the strip). A new layer is one line in `order`.

import { City } from './city.ts';
import { Crates, Reactions } from './crates.ts';
import type { Factory } from './factory.ts';
import { Floor } from './floor.ts';
import { Front } from './front.ts'; // fx-front
import { Labels } from './labels.ts';
import { Plant, Tracks } from './plant.ts';
import type { Layer } from './types.ts';

/** The floor's stages, built once per Factory: the ones the factory and the lens system reach by
 *  name, and `order`, the registry. */
export function buildLayers(f: Factory) {
  const floor = new Floor(f), plant = new Plant(f), city = new City(f), reactions = new Reactions(f), tracks = new Tracks(f), crates = new Crates(f), words = new Labels(f);
  const order: Layer[] = [
    floor, //     floor.ts: slab, grid, zones, belts, steel, docks, PR yard, gate, cars; haze, slats, lamps
    new Front(f), // fx-front front.ts: the back wall's boards and now seam, the approach roads, the lane curbs
    plant, //     plant.ts: intake, machines, bays, gauges, scanner
    city, //      city.ts: districts, blocks, health lights, trouble breathing
    reactions, // crates.ts: rings, beams and doors where crates arrive
    tracks, //    plant.ts: deploys in flight on the deploy tracks
    crates, //    crates.ts: crates in motion, trains, stress crates
    { name: 'groups', live: (g, fr) => { f.w2.over(g, fr.t); return false; } }, // fab-w2 groupfloor.ts: bay stripes, group dock names and hits
    words, //     labels.ts: stage titles, names and counts (the greedy placer)
  ];
  return { floor, plant, city, reactions, tracks, crates, words, order };
}
