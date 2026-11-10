// The yard's palette and type (DESIGN.md, "Colour", "Type"). The canvas paints every pixel, so
// these are literal colours. Every value that also exists as an `app.tamber` token is the SAME
// value (tools/check-theme.mjs compares them); the rest are canvas-only shades of the same ramp.
//
// Text rule: no canvas text darker than ink3 (#8A8A8A, 5.6:1 on canvas). ink4 and the dim
// shades are for marks only (rings, rails, empty cells), never for words.

export const C = {
  // tokens shared with app.tamber (sy.<name>)
  canvas: '#0E0E0E',
  raised: '#151516',
  control: '#1C1C1E',
  rule: '#1F1F1F',
  edge: '#2E2E30',
  machine: '#58585A',
  ink: '#F2F2F0',
  ink2: '#A3A3A3',
  ink3: '#8A8A8A',
  ink4: '#6A6A6A',
  packet: '#E5B567', // sy.amber
  amberText: '#D8BA92',
  green: '#7FC48F',
  greenFill: '#1F2822',
  greenEdge: '#3C5443',
  greenInk: '#9CC3A6',
  red: '#E06464',
  redText: '#E3858C',
  redFill: '#2B1A1C',
  redEdge: '#6B3A3F',
  chipEdge: '#3E3E40',
  brand: '#FF7212',
  up: '#5A6E5F',
  // canvas-only marks (never text)
  wire: '#2A2A2B',
  wireHot: '#4C4A45',
  machineDim: '#3A3A3C',
  machineFill: '#101011',
  port: '#19191A',
  portEdge: '#545456',
  packetDim: '#8A7146',
  dot: '#CFCFD1',
  dotDim: '#4E4E50',
  cellOff: '#232325',
  cellGreen: '#3E5244',
  chipInk: '#8C8C8E',
  hud: '#0A0A0A',
} as const;

export const FACE = "'Commit Mono', ui-monospace, Menlo, monospace";

/** Font strings are built once per (size, weight): a draw sets `ctx.font` thousands of times. */
const fonts = new Map<number, string>();
export function font(px: number, bold = false): string {
  const key = bold ? -px : px;
  let f = fonts.get(key);
  if (f === undefined) { f = `${bold ? '700 ' : ''}${px}px ${FACE}`; fonts.set(key, f); }
  return f;
}

/** The type scale (DESIGN.md "Type"), in yard units (the yard scales with `k`, layout.ts). */
export const T = {
  eyebrow: 11,
  caption: 11,
  label: 11.5,
  title: 12,
  chip: 11,
} as const;

export const TAU = Math.PI * 2;

export const easeInOut = (u: number) => (u <= 0 ? 0 : u >= 1 ? 1 : u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2);
export const easeOut = (u: number) => (u <= 0 ? 0 : u >= 1 ? 1 : 1 - Math.pow(1 - u, 3));
export const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

/** `#RRGGBB` at alpha `a`, from a cache (alpha quantized to 1/32): no string per call. */
const alphaCache = new Map<number, string>();
export function withAlpha(hex: string, a: number): string {
  const n = parseInt(hex.slice(1), 16);
  const q = Math.round(clamp(a, 0, 1) * 32);
  const key = n * 64 + q;
  let s = alphaCache.get(key);
  if (s === undefined) {
    s = `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${(q / 32).toFixed(3)})`;
    alphaCache.set(key, s);
  }
  return s;
}
