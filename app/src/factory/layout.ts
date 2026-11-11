// The floor plan (fab-w0): where every stage of the factory sits, in world units (u: left →
// right, v: back → front; the floor is LU × LV, iso.ts). Today's plan is fixed; the lanes and
// the accordion (`vmap`, FACTORY-SPEC §C, §F) grow from here. `f.plan` (factory.ts) is PLAN.

import type { Plan } from './types.ts';

export const PLAN: Plan = {
  DOCK_U0: 10, DOCK_U1: 64,
  COLLECT_U: 104,
  AISLE_V: 385,
  YARD_U0: 122, YARD_U1: 426,
  ROW_U: [153, 227, 301, 375],
  ROW_DU: 46,
  AGE_V: [470, 398, 326, 254, 182, 110],
  STACK_DV: 46,
  PALLET_V: 560,
  GATE_U: 442,
  RAIL_U0: 456, RAIL_U1: 640,
  RAIL_V: [130, 210, 290, 370, 450],
  INTAKE_U0: 662, INTAKE_U1: 748,
  LANE_V: [276, 306],
  DIST_U: 762,
  ENG_U0: 776, ENG_U1: 1052,
  ENG_V0: 34, ENG_STEP: 146, ENG_DV: 116, ENG_H: 30,
  SCAN_U: 1104,
  TRACK_V: [210, 330, 450],
  TRACK_U1: 1222,
  CITY_U0: 1232, CITY_U1: 1494, CITY_V0: 22, CITY_V1: 610,
  RETURN_V: 626,
  VIAS: ['roadrunner', 'gha', 'gha_fallback'],
};

/** A deploy track's name. */
export const VIA_WORDS: Record<string, string> = { roadrunner: 'roadrunner', gha: 'gha', gha_fallback: 'fallback' };
