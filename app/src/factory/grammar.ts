// THE VISUAL GRAMMAR (fab-w1; FACTORY-SPEC §B). One table: every kind on the floor and what each
// of its channels says (shape, colour role, height, footprint, motion, pulse, glow/marks, label),
// and the colour rules that keep state and group identity apart:
//
//   - STATE hues are reserved: red = failing, amber = in flight, green-gray = ok, hollow = unknown.
//     Red and amber carry chroma ≥ 0.11 (OKLCH); no group colour comes near them.
//   - GROUP hues (a team or org lane, its dock roof, stack stripes, rail underframes, crate bands,
//     bay stripes, district plates) stay muted: chroma ≤ 0.075, hue angles clear of red (0–50°)
//     and amber (60–100°), ΔE ≥ 20 (CIEDE2000) from every state colour and ΔE_ok ≥ 0.10 from
//     red, amber, ok and the fixed flash, so a group can never be read as a state. Lane neighbours
//     differ by ΔE_ok ≥ 0.10 and any two groups by ≥ 0.06 (fx-lanes, REVIEW-iter2 #1: "which team
//     is broken" in one second).
//   - Neutral lanes ("other teams", the bots siding) are near-gray and carry a shape instead
//     (bots: hatched), so they are exempt from the hue rules but never take a state's colour.
//
// The legend (legend.ts) is drawn from this table; tools/factory-grammar.test.ts holds the rules.
// Nothing here draws or reads the world.

import { BOTS_HUE, OTHER_HUE, oklchHex } from '../insights.ts';
import { C as THEME } from '../yard/theme.ts';

// ── colour science (sRGB ↔ OKLab, CIELab D65, CIEDE2000) ──────────────────────────────────────

/** `#rrggbb` → linear sRGB. */
function lin(hex: string): [number, number, number] {
  const f = (i: number) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return [f(1), f(3), f(5)];
}

/** `#rrggbb` → OKLab [L, a, b]. */
export function oklab(hex: string): [number, number, number] {
  const [r, g, b] = lin(hex);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s, 1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s];
}

/** `#rrggbb` → OKLCH [L, C, h°]. */
export function oklch(hex: string): [number, number, number] {
  const [L, a, b] = oklab(hex);
  const h = (Math.atan2(b, a) * 180) / Math.PI;
  return [L, Math.hypot(a, b), h < 0 ? h + 360 : h];
}

/** OKLab distance (ΔE_ok, 0..~1). */
export function deltaOk(x: string, y: string): number {
  const a = oklab(x), b = oklab(y);
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

/** `#rrggbb` → CIELab (D65). */
export function cielab(hex: string): [number, number, number] {
  const [r, g, b] = lin(hex);
  const X = (0.4124564 * r + 0.3575761 * g + 0.1804375 * b) / 0.95047;
  const Y = 0.2126729 * r + 0.7151522 * g + 0.0721750 * b;
  const Z = (0.0193339 * r + 0.1191920 * g + 0.9503041 * b) / 1.08883;
  const f = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : ((24389 / 27) * t + 16) / 116);
  return [116 * f(Y) - 16, 500 * (f(X) - f(Y)), 200 * (f(Y) - f(Z))];
}

/** CIEDE2000 colour difference ("ΔE"; ~2 just noticeable, 20 clearly another colour). */
export function deltaE(x: string, y: string): number {
  const [L1, a1, b1] = cielab(x), [L2, a2, b2] = cielab(y);
  const rad = Math.PI / 180;
  const C1 = Math.hypot(a1, b1), C2 = Math.hypot(a2, b2), Cb = (C1 + C2) / 2;
  const G = 0.5 * (1 - Math.sqrt(Cb ** 7 / (Cb ** 7 + 25 ** 7)));
  const ap1 = a1 * (1 + G), ap2 = a2 * (1 + G);
  const Cp1 = Math.hypot(ap1, b1), Cp2 = Math.hypot(ap2, b2);
  const hp = (a: number, b: number) => { if (!a && !b) return 0; const h = Math.atan2(b, a) / rad; return h < 0 ? h + 360 : h; };
  const h1 = hp(ap1, b1), h2 = hp(ap2, b2);
  const dL = L2 - L1, dC = Cp2 - Cp1;
  let dh = 0;
  if (Cp1 * Cp2 !== 0) { dh = h2 - h1; if (dh > 180) dh -= 360; else if (dh < -180) dh += 360; }
  const dH = 2 * Math.sqrt(Cp1 * Cp2) * Math.sin((dh / 2) * rad);
  const Lb = (L1 + L2) / 2, Cpb = (Cp1 + Cp2) / 2;
  let hb = h1 + h2;
  if (Cp1 * Cp2 !== 0) hb = Math.abs(h1 - h2) > 180 ? (h1 + h2 + (h1 + h2 < 360 ? 360 : -360)) / 2 : (h1 + h2) / 2;
  const T = 1 - 0.17 * Math.cos((hb - 30) * rad) + 0.24 * Math.cos(2 * hb * rad) + 0.32 * Math.cos((3 * hb + 6) * rad) - 0.2 * Math.cos((4 * hb - 63) * rad);
  const dth = 30 * Math.exp(-(((hb - 275) / 25) ** 2));
  const Rc = 2 * Math.sqrt(Cpb ** 7 / (Cpb ** 7 + 25 ** 7));
  const SL = 1 + (0.015 * (Lb - 50) ** 2) / Math.sqrt(20 + (Lb - 50) ** 2), SC = 1 + 0.045 * Cpb, SH = 1 + 0.015 * Cpb * T;
  const RT = -Math.sin(2 * dth * rad) * Rc;
  return Math.sqrt((dL / SL) ** 2 + (dC / SC) ** 2 + (dH / SH) ** 2 + RT * (dC / SC) * (dH / SH));
}

// ── the reserved state colours ──────────────────────────────────────────────────────────────────

/** The state colours (the floor's fills; text variants are their lighter inks). */
export const STATE = {
  /** failing: a red crate, a red post lamp, a red car, a red lip */
  fail: '#E06464',
  /** in flight: a crate in motion, a running car, a lit bay */
  flight: '#E5B567',
  /** ok / up: the green-gray of a health light at rest */
  ok: '#5A6E5F',
} as const;
/** Not a state of its own: the one brighter flash when a main line turns green again (ok's
 *  accent, transient; never on a group's mark). */
export const FIXED = '#7FC48F';
export type StateRole = keyof typeof STATE | 'unknown';

/** The reserve every colour rule checks. */
export const RESERVE = {
  /** red and amber's OKLCH chroma floor (green-gray "ok" is deliberately quiet) */
  stateChroma: 0.11,
  /** a group hue's chroma ceiling */
  groupChroma: 0.075,
  /** CIEDE2000 from every state colour */
  deltaE: 20,
  /** hue angles a group may not take (red, amber) */
  forbidden: [[0, 50], [60, 100]] as [number, number][],
  /** two neighbouring lanes, ΔE_ok at least (fx-lanes: was 0.07 for hued pairs only) */
  adjacentOk: 0.10,
  /** any two groups the floor shows, ΔE_ok at least */
  anyOk: 0.06,
  /** every group from red, amber, ok and the fixed flash, ΔE_ok at least */
  reserveOk: 0.10,
  /** below this chroma a group is neutral (a shape carries it, not a hue) */
  neutralChroma: 0.02,
} as const;

/** A group colour as the rules see it. */
export type HueSpec = { id: string; hex: string; l: number; c: number; h: number };

/** Every rule a group palette breaks (empty: it is lawful). `lanes` in lane order (adjacency). */
export function hueViolations(lanes: HueSpec[]): string[] {
  const out: string[] = [];
  for (const [k, hex] of Object.entries(STATE)) {
    if (k === 'ok') continue;
    const c = oklch(hex)[1];
    if (c < RESERVE.stateChroma) out.push(`state ${k} ${hex} chroma ${c.toFixed(3)} < ${RESERVE.stateChroma}`);
  }
  for (const g of lanes) {
    if (g.c < RESERVE.neutralChroma) continue;
    if (g.c > RESERVE.groupChroma + 1e-9) out.push(`${g.id} chroma ${g.c} > ${RESERVE.groupChroma}`);
    const h = ((g.h % 360) + 360) % 360;
    for (const [a, b] of RESERVE.forbidden) if (h >= a && h <= b) out.push(`${g.id} hue ${h}° in ${a}–${b}°`);
    for (const [k, hex] of Object.entries(STATE)) {
      const d = deltaE(g.hex, hex);
      if (d < RESERVE.deltaE) out.push(`${g.id} ${g.hex} ΔE ${d.toFixed(1)} from state ${k} ${hex}`);
    }
  }
  // fx-lanes: neighbours (neutral lanes too: they sit between hued ones), any pair, the reserve
  for (let i = 1; i < lanes.length; i++) {
    const a = lanes[i - 1]!, b = lanes[i]!;
    if (a.c < RESERVE.neutralChroma && b.c < RESERVE.neutralChroma) continue;
    const d = deltaOk(a.hex, b.hex);
    if (d < RESERVE.adjacentOk) out.push(`${a.id}↔${b.id} adjacent ΔE_ok ${d.toFixed(3)} < ${RESERVE.adjacentOk}`);
  }
  for (let i = 0; i < lanes.length; i++) for (let j = i + 1; j < lanes.length; j++) {
    const d = deltaOk(lanes[i]!.hex, lanes[j]!.hex);
    if (d < RESERVE.anyOk) out.push(`${lanes[i]!.id}↔${lanes[j]!.id} ΔE_ok ${d.toFixed(3)} < ${RESERVE.anyOk}`);
  }
  for (const g of lanes) for (const [k, hex] of Object.entries(RESERVED)) {
    const d = deltaOk(g.hex, hex);
    if (d < RESERVE.reserveOk) out.push(`${g.id} ${g.hex} ΔE_ok ${d.toFixed(3)} from ${k} ${hex}`);
  }
  return out;
}

// ── red means broken NOW (w2-red, REVIEW-iter3 #2, #5) ──────────────────────────────────────────
//
// Full-strength red (`C.red`) is ONE story: a main line or an app broken now. Everything else that
// used to share it takes another role:
//   - a PR failing its checks is business as usual: a desaturated BRICK cap (`C.redPR`, OKLCH L 0.485)
//     with a 1-px red top edge, never a solid red fill;
//   - a red main has an AGE TIER (`redTier`, from `main.since`):
//       hot   < 1 h     full red, a white-hot core and a white rim, IN the beat (fx.ts `hotRims`);
//       red   1 h – 7 d full red, still;
//       rust  ≥ 7 d     brick `C.rust`, half height, a 45° hatch, out of the beat;
//   - an open PR untouched for more than 14 d desaturates (`PR_OLD_MS`, 60 % of its chroma).
// The tiers hold on every red-main mark: the signal posts, a red main's newest car, the tally
// at each rail's end and the dock roof's red gauge.

/** The app's palette plus the red roles (the brief's `C.redPR`; floor.ts and groupfloor.ts paint
 *  from this one). */
export const C = {
  ...THEME,
  /** a PR failing its checks: the brick cap (OKLCH L 0.485, chroma 0.088; the state red: 0.68, 0.156) */
  redPR: '#8A4A44',
  /** the brick cap's faces (darker, for its sides) */
  redPRSide: '#6A3934', redPRFront: '#74403A',
  /** a main line red for 7 d or more: rust (and its shaded faces, its hatch) */
  rust: '#6E3B36', rustSide: '#4E2A27', rustFront: '#5C312D', rustHatch: '#2A1514',
  /** the white-hot core and rim of a red main under an hour old */
  hot: '#FFF4EE',
  /** v4-heaps (REVIEW-iter3b #2, #3): FAILING FLOW, failures that break no main now: the chute's
   *  rail when one repo or one cluster is the flow, a heap holding no main red (one repo's crons),
   *  its label. Gray-red (OKLCH L ≈ 0.48, chroma ≈ 0.05; the flaky heap's family), never the
   *  state red: the colour stays on the heap that holds a main red. */
  failFlow: '#7A4F4C', failFlowText: '#B4908C',
  /** a failing-flow heap's faces, and a HEALED one's (open 0, none this hour: quieter still) */
  failFlowTop: '#6E5250', failFlowSide: '#4A3634', failFlowFront: '#563F3D',
  quietTop: '#4A3D3C', quietSide: '#33292A', quietFront: '#3C3231',
} as const;

const HOUR = 3_600_000, DAY = 24 * HOUR;
/** A red main's tiers (ms): hot below RED_HOT_MS, rust from RED_RUST_MS. */
export const RED_HOT_MS = HOUR, RED_RUST_MS = 7 * DAY;
/** An open PR untouched longer than this desaturates (60 % of its chroma). */
export const PR_OLD_MS = 14 * DAY;
/** 0 hot (< 1 h), 1 red (1 h – 7 d), 2 rust (≥ 7 d). */
export type RedTier = 0 | 1 | 2;
export const TIER_HOT = 0, TIER_RED = 1, TIER_RUST = 2;
/** A red main's tier from how long it has been red (an unknown `since`: red, the middle). */
export function redTier(ageMs: number): RedTier {
  if (!(ageMs >= 0) || !Number.isFinite(ageMs)) return TIER_RED;
  return ageMs < RED_HOT_MS ? TIER_HOT : ageMs < RED_RUST_MS ? TIER_RED : TIER_RUST;
}
/** When a red main of age `ageMs` (now) changes tier next: ms from now (Infinity: never again). */
export function tierFlipIn(ageMs: number): number {
  if (!(ageMs >= 0)) return Infinity;
  return ageMs < RED_HOT_MS ? RED_HOT_MS - ageMs : ageMs < RED_RUST_MS ? RED_RUST_MS - ageMs : Infinity;
}
/** How long, in words for a hover: `red 106 d`, `red 7 h`, `red 12 min`. */
export function redFor(ageMs: number): string {
  if (!(ageMs > 0)) return 'red';
  const m = Math.round(ageMs / 60_000);
  if (m < 60) return `red ${Math.max(1, m)} min`;
  const h = Math.round(ageMs / HOUR);
  if (h < 48) return `red ${h} h`;
  return `red ${Math.round(ageMs / DAY)} d`;
}

/** The colours no group may come near (ΔE_ok ≥ RESERVE.reserveOk): the three states and the
 *  fixed flash. */
export const RESERVED: Record<string, string> = { red: STATE.fail, amber: STATE.flight, ok: STATE.ok, fixed: FIXED };

/** A palette's closest calls (ΔE_ok): any two groups, two neighbours (lane order), a group and a
 *  reserved colour. For the test's print and the HUD. */
export function paletteReport(lanes: HueSpec[]): { any: [string, string, number]; nb: [string, string, number]; res: [string, string, number] } {
  let any: [string, string, number] = ['', '', 9], nb: [string, string, number] = ['', '', 9], res: [string, string, number] = ['', '', 9];
  for (let i = 0; i < lanes.length; i++) {
    for (let j = i + 1; j < lanes.length; j++) { const d = deltaOk(lanes[i]!.hex, lanes[j]!.hex); if (d < any[2]) any = [lanes[i]!.id, lanes[j]!.id, d]; }
    if (i > 0) { const d = deltaOk(lanes[i - 1]!.hex, lanes[i]!.hex); if (d < nb[2]) nb = [lanes[i - 1]!.id, lanes[i]!.id, d]; }
    for (const [k, hex] of Object.entries(RESERVED)) { const d = deltaOk(lanes[i]!.hex, hex); if (d < res[2]) res = [lanes[i]!.id, k, d]; }
  }
  return { any, nb, res };
}

/** A lane's ink for words (its label on the floor): the lane's hue at OKLCH L 0.80, chroma ≤ 0.08
 *  (readable on the near-black floor, still its colour). */
export function laneInk(hex: string): string {
  const [, c, h] = oklch(hex);
  return oklchHex(0.8, Math.min(0.08, c), h);
}

/** A group hue at another lightness and a share of its chroma (the PR cells' muted faces, a
 *  stale layer's dust: OKLCH L `l`, chroma × `ck`). */
export function tone(hex: string, l: number, ck: number): string {
  const [, c, h] = oklch(hex);
  return oklchHex(l, c * ck, h);
}

/** A hue spec from OKLCH. */
export function hueSpec(id: string, l: number, c: number, h: number): HueSpec { return { id, hex: oklchHex(l, c, h), l, c, h }; }

/** The neutral lanes' colours (exempt from the hue rules; a shape carries them). */
export const NEUTRAL = { other: OTHER_HUE.hex, bots: BOTS_HUE.hex } as const;

// ── the table (§B) ──────────────────────────────────────────────────────────────────────────────

export type Kind =
  | 'dock' | 'lane' | 'stack' | 'pallet' | 'gate' | 'post' | 'car' | 'stop' | 'belt' | 'intake' | 'engine' | 'bay'
  | 'crate' | 'gauge' | 'scanner' | 'return' | 'track' | 'app' | 'district' | 'strip';

/** The shapes the legend can draw (legend.ts paints one per kind). */
export type Shape = 'slab' | 'carpet' | 'stack' | 'pallet' | 'gantry' | 'post' | 'flatcar' | 'tally' | 'band' | 'chute' | 'machine' | 'recess' | 'cube' | 'tower' | 'beam' | 'conveyor' | 'track' | 'block' | 'plate' | 'bars';

export type Channels = {
  /** the legend's word for it */
  word: string;
  shape: Shape;
  /** what the state hue on it means ('' none) */
  state: string;
  /** which colour role fills it: state hue, the group's, or neutral */
  colour: 'state' | 'group' | 'neutral';
  /** where the group hue goes on it ('' none) */
  group: string;
  height: string;
  footprint: string;
  motion: string;
  pulse: string;
  /** ember, smoke, cracks, beacons, ghosts on it */
  glow: string;
  /** what it says in words, and when */
  label: string;
  /** the legend's one line (≤ 4 words) */
  says: string;
};

export const GRAMMAR: Record<Kind, Channels> = {
  dock: { word: 'dock', shape: 'slab', state: 'roof = a red gauge: red mains / repos, from the front edge (rust ≥ 7 d, red, hot < 1 h); door lamp: a fresh red', colour: 'group', group: 'roof fill', height: 'pushes/h (√)', footprint: '∝ √repos (lane depth)', motion: 'door flaps per push', pulse: 'door on the beat while fresh', glow: 'ember: returns > p90; a red road edge: red rising', label: 'group name', says: 'group · red roof = share' },
  lane: { word: 'lane', shape: 'carpet', state: '', colour: 'group', group: 'its floor, dock → buffer stop (8–12 %, neighbours alternating)', height: '', footprint: 'depth ∝ √repos', motion: '', pulse: '', glow: 'ember: failures > p90', label: 'name on its road (◇ = an org)', says: 'a group, dock → rail' },
  stack: { word: 'PR stack', shape: 'stack', state: 'brick cap (C.redPR, 1-px red edge): CI failing · crack: conflict · amber rim: checks', colour: 'group', group: 'layers in the lane\'s hue, muted; base stripe', height: 'open PRs (a layer = 5)', footprint: 'fixed cell (group × phase)', motion: 'a layer slides in on a PR', pulse: '', glow: 'dust: stale layers · gray: untouched > 14 d', label: 'count at group zoom', says: 'open PRs · brick: CI failing' },
  pallet: { word: 'bot pallet', shape: 'pallet', state: 'red strap: > 50 % failing', colour: 'neutral', group: 'hatch (bots)', height: 'log count', footprint: '∝ repos touched', motion: '', pulse: '', glow: 'dust ∝ stale', label: 'hover', says: 'bot PRs, height = log n' },
  gate: { word: 'merge gate', shape: 'gantry', state: 'amber flash on a merge; red if it broke main', colour: 'group', group: 'lintel per lane', height: 'fixed', footprint: 'one lintel per lane', motion: 'ticks shift', pulse: 'flash per merge', glow: 'dim: no merge for 2 h', label: 'title', says: 'ticks = merges/h' },
  post: { word: 'signal post', shape: 'post', state: 'lamp: red failing (hot < 1 h · red · rust ≥ 7 d) · amber running · gray ok', colour: 'state', group: 'base ring', height: 'tier: hot and red full, rust half', footprint: 'one per active repo, red first', motion: '', pulse: 'hot only: white core and rim on the beat', glow: 'beacon < 1 h · cracks > 24 h · rust hatched', label: 'repo at group zoom', says: 'a repo\'s main · red first' },
  car: { word: 'rail car', shape: 'flatcar', state: 'gray settled · amber running · red: a red main\'s newest (rust ≥ 7 d)', colour: 'state', group: 'underframe in the lane hue', height: 'red ×1.5, rust half', footprint: 'flatcar', motion: 'slides in on a merge', pulse: 'hot: white core on the beat', glow: 'beacon < 1 h', label: 'culprit callout', says: 'a merged commit' },
  stop: { word: 'red tally', shape: 'tally', state: 'a block per red main: rust ≥ 7 d (half, hatched) at the foot, red, hot < 1 h on top', colour: 'state', group: 'its plinth', height: '∝ red mains', footprint: 'the rail\'s end', motion: '', pulse: 'hot top on the beat', glow: '', label: 'hover', says: 'height = red mains' },
  belt: { word: 'belt', shape: 'band', state: 'red crates only', colour: 'group', group: 'stacked group stripes', height: '', footprint: 'width = flow/h', motion: 'slat speed = rate (log)', pulse: '', glow: 'ember = starved', label: 'hover', says: 'width = flow, speed = rate' },
  intake: { word: 'intake', shape: 'conveyor', state: 'amber queued; red if oldest > 2× p50', colour: 'state', group: 'crate band', height: 'pile on overflow', footprint: '2 lanes', motion: 'stops when slots are full', pulse: '', glow: 'jam', label: 'count if > 0', says: 'what waits for a slot' },
  engine: { word: 'machine', shape: 'machine', state: 'edge red: offline', colour: 'neutral', group: '', height: 'fixed', footprint: '∝ slots', motion: 'wall scrolls', pulse: '', glow: 'shimmer cpu ≥ 90 % · smoke OOM', label: 'name at zoom', says: 'a host · its slots' },
  bay: { word: 'bay', shape: 'recess', state: 'amber building; red lip > 1.5× expected', colour: 'state', group: 'floor stripe', height: '', footprint: 'recess', motion: 'crate rides progress', pulse: 'tick per step', glow: 'cracks > 3×', label: 'repo at zoom', says: 'a slot · lit = building' },
  crate: { word: 'crate', shape: 'cube', state: 'amber · red · gray', colour: 'state', group: '2-px band', height: '', footprint: 'size = log expected', motion: 'rides its route; trains > 24', pulse: 'white rim = new', glow: '', label: 'hover', says: 'a run, push or PR' },
  gauge: { word: 'gauge', shape: 'tower', state: 'red cap ≥ 90 %', colour: 'state', group: '', height: 'current %', footprint: 'tower', motion: 'lerp 1 s', pulse: '', glow: 'ghost = 24 h p90', label: '% at zoom', says: 'cpu · mem' },
  scanner: { word: 'scanner', shape: 'chute', state: 'beam amber / red', colour: 'state', group: '', height: 'chute = failures/h per signature', footprint: '6 chutes + other', motion: 'sweep per finish', pulse: '', glow: 'smoke ≥ 3 repos · hatch = flaky', label: 'signature', says: 'tests · red splits off' },
  return: { word: 'return', shape: 'conveyor', state: 'red crates', colour: 'state', group: 'band; spur to its dock', height: 'piles > 5/h', footprint: 'front edge', motion: 'replays since-visit', pulse: '', glow: 'red tethers: same signature', label: 'newest repo · step', says: 'failures ride home' },
  track: { word: 'deploy track', shape: 'track', state: 'amber; red parks', colour: 'state', group: 'crate band', height: '', footprint: 'width = deploys/h', motion: 'elapsed / p50', pulse: '', glow: 'ember fallback · beacon watcher', label: 'hover', says: 'deploys to apps' },
  app: { word: 'app', shape: 'block', state: 'roof light; hollow = unknown', colour: 'state', group: 'district plate', height: 'deploys 7 d', footprint: 'ghost storeys ∝ behind', motion: 'deploy ring', pulse: '', glow: 'beacon < 1 h · cracks > 24 h', label: 'name ≥ 2.6×', says: 'an app · height = deploys' },
  district: { word: 'district', shape: 'plate', state: 'beacon if an app is down', colour: 'group', group: 'plate fill', height: '', footprint: '∝ apps', motion: '', pulse: '', glow: 'ember failures > p90', label: 'team at zoom', says: 'a team\'s apps' },
  strip: { word: 'time strip', shape: 'bars', state: 'red failures, amber activity', colour: 'state', group: 'by group on hover', height: 'events / 5 min', footprint: '24 h', motion: 'playhead', pulse: '', glow: 'ghost = yesterday', label: 'now, last visit', says: '24 h of events' },
};

/** The fleet zoom's text budget (§B): titles, group names, callouts, the chrome. */
export const TEXT_BUDGET = 40;

/** The stages in flow order: their two-word titles (the only words at fleet zoom besides group
 *  names and ≤ 3 callouts). */
export const STAGES: readonly { n: string; title: string }[] = [
  { n: '01', title: 'sources' }, { n: '02', title: 'pr yard' }, { n: '03', title: 'merge gate' }, { n: '04', title: 'main lines' },
  { n: '05', title: 'intake' }, { n: '06', title: 'consumption engine' }, { n: '07', title: 'tests' }, { n: '08', title: 'deploy' }, { n: '09', title: 'apps' },
];
