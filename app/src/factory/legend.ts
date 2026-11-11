// THE KEY ("?"; fab-w1, FACTORY-SPEC §B): the floor's visual grammar, regenerated from grammar.ts.
// One row per kind, flow order: its shape drawn small in its colours, its word, and its legend line
// (≤ 4 words: what its height, width or colour says). Above them the colour roles: the three
// reserved states and the group hues the floor shows now (the lanes, back → front). No prose.

import type { Gfx } from '../yard/gfx.ts';
import { C, withAlpha } from '../yard/theme.ts';
import { GRAMMAR, STATE, type Kind, type Shape } from './grammar.ts';
import { floorGroups } from './groups.ts';
import type { Factory } from './factory.ts';

/** The rows, in the order a crate meets them. */
const ROWS: Kind[] = ['dock', 'lane', 'belt', 'stack', 'pallet', 'gate', 'post', 'car', 'stop', 'intake', 'engine', 'bay', 'crate', 'gauge', 'scanner', 'return', 'track', 'app', 'district', 'strip'];
const W = 344, ROW = 21, SMALL = 12;
const CARD = '#111112', CARD_EDGE = '#2E2E30';
const GRAY = ['#6E6A62', '#4A4844', '#3E3C38'] as const, AMBER = ['#E5B567', '#8E6E3E', '#B48C4E'] as const, RED = ['#E06464', '#8A3838', '#B04848'] as const;

/** Draws the key with its top right corner at (right, y). The panel's area is a hit (it keeps the
 *  pointer off the floor beneath). */
export function drawLegend(g: Gfx, f: Factory, right: number, y: number, t: number): void {
  const x = right - W;
  const lanes = f.floor.on ? floorGroups().lanes() : [];
  const H = 14 + 3 * ROW + 8 + ROWS.length * ROW + 30;
  g.fillRect(x, y, W, H, withAlpha(CARD, 0.96));
  g.begin_(); g.rect(x + 0.5, y + 0.5, W - 1, H - 1); g.stroke(CARD_EDGE, 1);
  f.hit(x, y, W, H, 'legendpanel', '', '');
  let yy = y + 22;
  // colour = state (reserved): red, amber, green-gray, hollow
  const sw: [string, string][] = [[STATE.fail, 'failing'], [STATE.flight, 'in flight'], [STATE.ok, 'ok'], ['', 'unknown']];
  let xx = x + 14;
  for (const [col, word] of sw) {
    if (col) g.fillRect(xx, yy - 9, 10, 10, col); else { g.begin_(); g.rect(xx + 0.5, yy - 8.5, 9, 9); g.stroke('#6A6A6E', 1); }
    g.text(word, xx + 15, yy, C.ink2, SMALL);
    xx += 15 + g.width(word, SMALL) + 14;
  }
  yy += ROW;
  // hue = group: a chip per lane, back → front (bots hatched)
  g.text('group', x + 14, yy, C.ink3, SMALL);
  xx = x + 14 + g.width('group', SMALL) + 10;
  const chip = Math.max(8, Math.min(18, (x + W - 14 - xx) / Math.max(1, lanes.length) - 3));
  for (const l of lanes) {
    const hex = floorGroups().hex(l.id);
    g.fillRect(xx, yy - 9, chip, 10, hex);
    if (l.kind === 'bots') { g.begin_(); for (let k = -10; k < chip; k += 4) { g.move(xx + Math.max(0, k), yy - 9 + Math.max(0, -k)); g.line(xx + Math.min(chip, k + 10), yy + 1 - Math.max(0, k + 10 - chip)); } g.stroke(withAlpha('#0C0C0E', 0.7), 1); }
    xx += chip + 3;
  }
  // fx-lanes (overseer note 8): a group's name is its team's, or its org's after a dim ◇ when its
  // repos have no app team ('ems' the team, '◇ ems' the org)
  yy += ROW;
  g.runs([['ems', C.ink2], [' a team · ', C.ink3], ['◇', C.ink3], [' ems', C.ink2], [' an org: no app team', C.ink3]], x + 14, yy, SMALL, W - 28);
  yy += 8;
  g.hline(x + 12, x + W - 12, yy - 2, '#232325');
  yy += ROW - 4;
  for (const k of ROWS) {
    const r = GRAMMAR[k];
    paint(g, r.shape, k, x + 34, yy - 4, t);
    g.runs([[r.word, C.ink, true], [`  ${r.says}`, C.ink3]], x + 70, yy, SMALL, W - 80);
    yy += ROW;
  }
  if (y + H + 21 < f.cam.H - 58) yy = (f.order.find((l) => l.name === 'front') as unknown as { legendRow?: (g: Gfx, x: number, y: number, W: number, H: number, yy: number) => number } | undefined)?.legendRow?.(g, x, y, W, H, yy) ?? yy; // fx-polish (note 11): the lane curbs' row, when the card has room
  g.hline(x + 12, x + W - 12, yy - 12, '#232325');
  g.runs([['click', C.ink2, true], [' a lens · ', C.ink3], ['shift', C.ink2, true], [' compare · ', C.ink3], ['esc', C.ink2, true], [' back', C.ink3]], x + 14, yy + 6, SMALL, W - 28);
}

/** A cube (top, side, front) of side `s` at screen (cx, cy). */
function cube(g: Gfx, cx: number, cy: number, s: number, c: readonly [string, string, string]): void {
  g.fillRect(cx - s, cy - s * 0.5, s * 2, s, c[2]);
  g.fillRect(cx + s, cy - s * 0.9, s * 0.5, s * 1.4, c[1]);
  g.fillRect(cx - s + s * 0.4, cy - s * 1.1, s * 2, s * 0.6, c[0]);
}

/** Each shape, small, in its colours, centred on (cx, cy). */
function paint(g: Gfx, shape: Shape, k: Kind, cx: number, cy: number, t: number): void {
  const hue = '#96C7D6'; // fx-lanes: the re-picked palette's first team slot
  switch (shape) {
    case 'slab': g.fillRect(cx - 13, cy - 3, 22, 9, '#18181A'); g.fillRect(cx - 11, cy - 7, 22, 5, hue); g.fillRect(cx + 9, cy - 1, 2, 5, STATE.fail); return;
    case 'carpet': g.fillRect(cx - 16, cy - 7, 32, 6, withAlpha(hue, 0.18)); g.fillRect(cx - 16, cy - 1, 32, 6, withAlpha('#B88AAD', 0.12)); g.hline(cx - 16, cx + 16, cy - 7, withAlpha(hue, 0.5), 1); return;
    case 'tally': g.fillRect(cx - 3, cy - 10, 6, 16, '#7285B4'); for (let k = 0; k < 4; k++) g.fillRect(cx - 3, cy + 3 - k * 3.4, 6, 2, k === 3 ? STATE.fail : '#B04848'); g.hline(cx - 14, cx - 3, cy + 4, '#3A3A3E', 1.2); return;
    case 'band': {
      g.fillRect(cx - 16, cy - 2, 32, 6, '#121214'); g.hline(cx - 16, cx + 16, cy + 1, withAlpha(hue, 0.7), 1.2);
      const off = ((t / 1000) * 10) % 6;
      for (let u = cx - 16 + off; u < cx + 16; u += 6) g.vline(u, cy - 2, cy + 4, '#3A3A3E', 1);
      return;
    }
    case 'stack': g.fillRect(cx - 9, cy - 1, 18, 6, '#1D1D20'); g.fillRect(cx - 9, cy + 2, 18, 3, '#3A3936'); g.fillRect(cx - 9, cy - 5, 18, 4, '#2C2C30'); g.fillRect(cx - 9, cy - 5, 18, 2, STATE.fail); g.hline(cx - 11, cx + 11, cy + 6, hue, 1.5); return;
    case 'pallet': {
      g.fillRect(cx - 12, cy - 6, 24, 11, '#3A3A3E');
      g.begin_(); for (let u = -10; u < 24; u += 4) { g.move(cx - 12 + Math.max(0, u), cy - 6 + Math.max(0, -u)); g.line(cx - 12 + Math.min(24, u + 11), cy + 5 - Math.max(0, u + 11 - 24)); } g.stroke(withAlpha('#0C0C0E', 0.7), 1);
      g.fillRect(cx - 1.5, cy - 6, 3, 11, STATE.fail);
      return;
    }
    case 'gantry': g.fillRect(cx - 13, cy - 8, 3, 14, '#4E4E53'); g.fillRect(cx + 10, cy - 8, 3, 14, '#4E4E53'); g.fillRect(cx - 13, cy - 9, 26, 4, hue); for (let i = 0; i < 4; i++) g.vline(cx - 8 + i * 4, cy - 9, cy - 5, C.ink, 1); return;
    case 'post': g.vline(cx - 6, cy - 6, cy + 5, '#6A4A4C', 1.2); g.fillRect(cx - 8, cy - 9, 4, 4, STATE.fail); g.vline(cx + 2, cy - 1, cy + 5, '#6A4A4C', 1.2); g.fillRect(cx, cy - 3, 4, 3, STATE.flight); g.begin_(); g.circle(cx + 10, cy + 3, 1.6); g.fill(STATE.ok); return;
    case 'flatcar': cube(g, cx - 12, cy + 1, 3.5, GRAY); cube(g, cx, cy + 1, 3.5, AMBER); cube(g, cx + 12, cy, 4.2, RED); return;
    case 'conveyor':
      if (k === 'return') { g.fillRect(cx - 16, cy + 1, 32, 3, '#121214'); cube(g, cx - 8, cy, 3.4, RED); cube(g, cx + 6, cy, 3.4, RED); return; }
      g.fillRect(cx - 16, cy + 1, 32, 3, '#121214'); for (let i = 0; i < 3; i++) cube(g, cx - 10 + i * 8, cy, 3, AMBER); return;
    case 'machine': g.fillRect(cx - 14, cy - 6, 28, 12, '#1E1E21'); g.fillRect(cx - 11, cy - 4, 6, 5, '#0F0F10'); g.fillRect(cx - 3, cy - 4, 6, 5, '#2A2216'); g.fillRect(cx + 5, cy - 4, 6, 5, '#0F0F10'); g.hline(cx - 14, cx + 14, cy - 6, '#4E4E53', 1); return;
    case 'recess': g.fillRect(cx - 12, cy - 5, 24, 10, '#2A2216'); g.begin_(); g.rect(cx - 11.5, cy - 4.5, 23, 9); g.stroke(STATE.flight, 1); cube(g, cx - 2, cy + 1, 3, AMBER); g.fillRect(cx - 12, cy + 6, 24, 2, STATE.fail); return;
    case 'cube': cube(g, cx - 11, cy + 1, 3.6, AMBER); cube(g, cx, cy + 1, 3.6, RED); cube(g, cx + 11, cy + 1, 3.6, GRAY); return;
    case 'tower': g.fillRect(cx - 8, cy - 2, 5, 8, '#5A5A5E'); g.fillRect(cx + 1, cy - 8, 5, 14, '#5A5A5E'); g.fillRect(cx + 1, cy - 9, 5, 3, STATE.fail); return;
    case 'chute': g.vline(cx, cy - 10, cy + 6, withAlpha(STATE.flight, 0.8), 2); g.vline(cx + 7, cy - 10, cy + 6, withAlpha(STATE.fail, 0.8), 2); g.fillRect(cx - 12, cy + 2, 8, 4, '#3A3A3E'); return;
    case 'track': g.hline(cx - 16, cx + 16, cy - 1, '#3A3A3E', 1.2); g.hline(cx - 16, cx + 16, cy + 3, '#3A3A3E', 1.2); cube(g, cx + 2, cy, 3.2, AMBER); return;
    case 'block': g.fillRect(cx - 12, cy - 2, 6, 8, '#3C3C40'); g.fillRect(cx - 4, cy - 9, 6, 15, '#3C3C40'); g.fillRect(cx + 4, cy - 5, 6, 11, '#3C3C40'); g.fillRect(cx - 3, cy - 11, 4, 2, STATE.ok); g.dash(true, 2, 2); g.begin_(); g.rect(cx + 4.5, cy - 11.5, 5, 5); g.stroke(withAlpha(C.amberText, 0.75), 1); g.dash(false); return;
    case 'plate': g.fillRect(cx - 14, cy - 4, 28, 10, withAlpha(hue, 0.35)); g.begin_(); g.rect(cx - 13.5, cy - 3.5, 27, 9); g.stroke(hue, 1); return;
    case 'bars': for (let i = 0; i < 9; i++) { const h = 2 + ((i * 7) % 9); g.fillRect(cx - 14 + i * 3.2, cy + 5 - h, 2, h, i === 6 ? STATE.fail : '#5A5A5E'); } return;
    default: return;
  }
}
