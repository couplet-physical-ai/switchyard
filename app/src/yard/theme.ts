// The yard's palette and type (DESIGN.md, "Colour", "Type"). The canvas paints every pixel,
// so these are literal colours; Contract views use the same values as tokens in app.tamber.

export const C = {
  canvas: '#0E0E0E',
  raised: '#151516',
  rule: '#1F1F1F',
  wire: '#2A2A2A',
  wireHot: '#4C4A45',
  machine: '#58585A',
  machineDim: '#3A3A3C',
  machineFill: '#101011',
  port: '#19191A',
  portEdge: '#5A5A5C',
  ink: '#F2F2F0',
  ink2: '#A3A3A3',
  ink3: '#7C7C7C',
  ink4: '#5C5C5C',
  packet: '#E5B567',
  packetDim: '#8A7146',
  amberText: '#D8BA92',
  green: '#7FC48F',
  greenFill: '#1F2822',
  greenEdge: '#3C5443',
  greenInk: '#9CC3A6',
  red: '#E06464',
  redText: '#E3858C',
  redFill: '#2B1A1C',
  redEdge: '#6B3A3F',
  dot: '#CFCFD1',
  dotDim: '#5E5E60',
  chipEdge: '#3E3E40',
  chipInk: '#8C8C8E',
  brand: '#FF7212',
} as const;

export const FACE = "'Commit Mono', ui-monospace, Menlo, monospace";
export const font = (px: number, bold = false) => `${bold ? '700 ' : ''}${px}px ${FACE}`;

export const TAU = Math.PI * 2;

export const easeInOut = (u: number) => (u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2);
export const easeOut = (u: number) => 1 - Math.pow(1 - u, 3);
export const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
