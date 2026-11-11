// Mainlines on the canvas table: every repo's default branch as one dense row (LOD2), the
// focused or hovered row opening to the full line (LOD0). The projection is cached on the
// world's version and the filter, and a row's words (ages) are made only when it is painted.

import type { Ctx2D, Frame } from '../../app.contract.d.ts';
import type { Dot, Repo } from '../wire.ts';
import type { World } from '../world.ts';
import { ago, laneText, mainState, short } from '../project.ts';
import { orgLabel } from '../yard/layout.ts';
import { withAlpha } from '../yard/paint.ts';
import { C, FACE, TAU, clamp } from '../yard/theme.ts';
import { CanvasTable, Layers, type RowCtx, type SubHit, advance, fit } from './table.ts';

export type MlState = 'red' | 'building' | 'green' | 'quiet';
export type MlRow = { id: string; r: Repo; st: MlState; heat: number };

/** Text never darker than this on the canvas colour (review #6: 4.5:1 for 11 px). */
export const TXT3 = '#8A8A8A';
const HAIR = '#1A1A1B';
const GROUP = '#262628';
const F11 = `11px ${FACE}`;
const F10 = `10px ${FACE}`;
const F12B = `700 12px ${FACE}`;
const F12 = `12px ${FACE}`;

const ORDER: Record<MlState, number> = { red: 0, building: 1, green: 2, quiet: 3 };

export const DENSE = 20;
export const OPEN = 52;
const HEAD = 22; // the sticky column header

export function dotsOf(r: Repo | undefined): Dot[] {
  const d = r?.main?.recent;
  return Array.isArray(d) ? d : [];
}

const isFail = (s: unknown) => s === 'failure' || s === 'error';

/** The index of the newest decided green dot (-1: none): reds before it are history. */
function lastGreen(d: Dot[]): number {
  for (let i = d.length - 1; i >= 0; i--) if (d[i]?.state === 'success') return i;
  return -1;
}

export function author(s: string | undefined): string {
  return (s ?? '').replace(/\[bot\]$/, '');
}

/** The commit a row opens: the culprit when red, else the head. */
export function openSha(r: Repo): string {
  const d = dotsOf(r);
  if (isFail(r.main?.state) && r.main?.culprit) return r.main.culprit;
  return r.main?.head || d.at(-1)?.sha || '';
}

/** "red 28m · dev-04", "building 2m", "green · fixed a1b2c3d", "no runs". */
export function stateWords(row: MlRow, now: number): string {
  const r = row.r;
  const d = dotsOf(r);
  switch (row.st) {
    case 'red': {
      const c = r.main?.culprit ? d.find((x) => x?.sha === r.main.culprit) : undefined;
      const since = r.main?.since;
      return `red${since ? ` ${coarse(now - since)}` : ''}${c?.author ? ` · ${author(c.author)}` : ''}`;
    }
    case 'building': {
      const at = d.at(-1)?.at;
      return at ? `building ${coarse(now - at)}` : 'building';
    }
    case 'green': {
      const fixed = fixedBy(d);
      return fixed ? `green · fixed ${short(fixed)}` : 'green';
    }
    default:
      return 'no runs';
  }
}

function fixedBy(d: Dot[]): string {
  for (let i = d.length - 1; i > 0; i--) {
    if (d[i]?.state === 'success' && isFail(d[i - 1]?.state)) return i >= d.length - 3 ? d[i].sha : '';
  }
  return '';
}

type Cols = {
  W: number; glyph: number; name: number; nameW: number; org: number; orgW: number; lane: number; laneW: number;
  state: number; stateW: number; dots0: number; dots1: number; head: number; headW: number; right: number;
  open1: number; prsR: number;
  /** The 11 px columns as character cells from `org` (monospace): one fillText paints them all. */
  a: number; a12b: number; a10: number; cOrg: number; cLane: number; cState: number; cHead: number; cPrs: number; cEnd: number;
};

/** The columns at width W; the 11 px ones snapped to character cells of advance `a`. */
function columns(W: number, maxDots: number, a: number, a12b: number, a10: number): Cols {
  const m = 12;
  const glyph = m;
  const name = m + 12;
  const nameW = W >= 1280 ? 210 : W >= 1100 ? 180 : 150;
  const org = name + nameW + 10;
  const cell = (x: number) => Math.round((x - org) / a);
  const at = (c: number) => org + c * a;
  const orgW = W >= 1100 ? 62 : 0;
  const cLane = cell(org + (orgW ? orgW + 8 : 0));
  const laneW = W >= 1220 ? 116 : 0;
  const cState = cell(at(cLane) + (laneW ? laneW + 8 : 0));
  const stateW = W >= 1100 ? 178 : 150;
  const x = at(cState) + stateW + 12;
  const right = W - m;
  const cEnd = Math.floor((right - org) / a);
  // the dense line's room: every dot of the longest main line at 9 px (v0.4 keeps ≤ 12)
  const n = Math.max(12, Math.min(40, maxDots));
  const dotsW = Math.max(120, Math.min(n * 9 + 8, right - 120 - x));
  const dots0 = x, dots1 = x + dotsW;
  const cHead = cell(dots1 + 22) + 1;
  const cPrs = cEnd - 9;
  const headW = Math.max(0, at(cPrs) - 5 * a - at(cHead));
  // LOD0's line: the same dots at 15 px, newest at one x for every row, over the head column
  const open1 = Math.max(dots1, Math.min(at(cPrs) - 70, dots0 + (n - 1) * 15 + 14));
  return {
    W, glyph, name, nameW, org, orgW, lane: at(cLane), laneW, state: at(cState), stateW, dots0, dots1, head: at(cHead), headW: headW >= 120 ? headW : 0,
    right: at(cEnd), open1, prsR: at(cPrs), a, a12b, a10, cOrg: 0, cLane, cState, cHead, cPrs, cEnd,
  };
}

/** Text in character cells: [cell, text, cells it may take, right-aligned]; '' between. */
function cells(n: number, parts: [number, string, number, boolean][]): string {
  const out = new Array<string>(n).fill(' ');
  for (const [c, t, w, right] of parts) {
    if (!t || w <= 0) continue;
    const s = t.length > w ? (w <= 1 ? '…' : `${t.slice(0, w - 1)}…`) : t;
    const c0 = right ? c - s.length : c;
    for (let i = 0; i < s.length; i++) if (c0 + i >= 0 && c0 + i < n) out[c0 + i] = s[i];
  }
  return out.join('').trimEnd();
}

export class MainlinesModel {
  readonly table = new CanvasTable<MlRow>((r) => r.id, DENSE, OPEN);
  private world: World | null = null;
  private ver = -1;
  private key = '';
  private rows: MlRow[] = [];
  /** Bumps whenever the rows are projected again: the canvas redraws on it. */
  seq = 0;
  counts = { total: 0, red: 0, building: 0, shown: 0 };
  private cols: Cols | null = null;
  private maxDots = 12;
  private layers = new Layers();

  constructor() {
    this.table.padTop = HEAD;
  }

  /** The rows for a filter, projected again only when the world or the filter changed. */
  project(w: World, org: string, filter: string, q: string): MlRow[] {
    const key = `${org}\u0000${filter}\u0000${q}`;
    if (w === this.world && w.ver === this.ver && key === this.key) return this.rows;
    const ql = q.trim().toLowerCase();
    const rows: MlRow[] = [];
    let total = 0, red = 0, building = 0, maxDots = 0;
    for (const r of w.repos.values()) {
      if (!r || typeof r !== 'object') continue;
      const id = String(r.id ?? '');
      if (!id) continue;
      if (org && r.org !== org) continue;
      if (ql && !id.toLowerCase().includes(ql)) continue;
      const st = mainState(r);
      total++;
      if (st === 'red') red++;
      else if (st === 'building') building++;
      if (filter === 'red' && st !== 'red') continue;
      if (filter === 'building' && st !== 'building') continue;
      maxDots = Math.max(maxDots, dotsOf(r).length);
      rows.push({ id, r, st, heat: Number(r.heat) || 0 });
    }
    rows.sort((a, b) => ORDER[a.st] - ORDER[b.st] || b.heat - a.heat || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    this.world = w;
    this.ver = w.ver;
    this.key = key;
    this.rows = rows;
    this.counts = { total, red, building, shown: rows.length };
    if (maxDots !== this.maxDots) { this.maxDots = maxDots; this.cols = null; }
    this.seq++;
    this.table.setRows(rows);
    return rows;
  }

  row(id: string): MlRow | undefined {
    const i = this.table.index.get(id);
    return i === undefined ? undefined : this.rows[i];
  }

  /** The route a row opens (its culprit's or head's journey), '' for none. */
  routeOf(id: string): string {
    const row = this.row(id);
    if (!row) return '';
    const sha = openSha(row.r);
    return sha ? `/commit/${row.id}/${sha}` : '';
  }

  draw(ctx: Ctx2D, frame: Frame, now: number, loaded: boolean): boolean {
    if (!this.cols || this.cols.W !== frame.width) this.cols = columns(frame.width, this.maxDots, advance(ctx, F11), advance(ctx, F12B), advance(ctx, F10));
    const cols = this.cols;
    const rows = this.rows, L = this.layers;
    const moving = this.table.draw(ctx, frame, (c, row, rc) => paintRow(c, row, rc, cols, rows[rc.index + 1]?.st, L), now, loaded ? 'No repo matches.' : 'Waiting for the fleet…');
    L.flush(ctx);
    paintHeader(ctx, cols, frame.width);
    return moving;
  }
}

function paintHeader(ctx: Ctx2D, k: Cols, W: number): void {
  ctx.fillStyle = C.canvas;
  ctx.fillRect(0, 0, W, HEAD);
  ctx.beginPath();
  ctx.moveTo(0, HEAD - 0.5);
  ctx.lineTo(W, HEAD - 0.5);
  ctx.strokeStyle = GROUP;
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.font = F10;
  ctx.fillStyle = TXT3;
  ctx.textAlign = 'left';
  ctx.letterSpacing = '0.6px';
  const y = 14;
  ctx.fillText('REPO', k.name, y);
  if (k.orgW) ctx.fillText('ORG', k.org, y);
  if (k.laneW) ctx.fillText('LANE', k.lane, y);
  ctx.fillText('MAIN', k.state, y);
  ctx.fillText('MAIN · NEWEST →', k.dots0, y);
  if (k.headW) ctx.fillText('LAST COMMIT', k.head, y);
  ctx.textAlign = 'right';
  ctx.fillText('PRS', k.prsR, y);
  ctx.fillText('AGE', k.right, y);
  ctx.letterSpacing = '0px';
}

function paintRow(ctx: Ctx2D, row: MlRow, rc: RowCtx, k: Cols, nextSt: MlState | undefined, L: Layers): void {
  const { y, h, W, e, focused, hits, now } = rc;
  const r = row.r;
  // ground: the focused row raised with a brand edge, a hovered one lifted (drawn now, under
  // the frame's layers)
  if (e > 0 || focused) {
    ctx.fillStyle = withAlpha(focused ? C.raised : '#141415', focused ? Math.max(0.6, e) : e);
    ctx.fillRect(0, y, W, h);
    if (focused) { ctx.fillStyle = C.brand; ctx.fillRect(0, y + 2, 2, h - 4); }
  }
  // hairline under the row; a stronger, full one where the state group changes
  const edge = nextSt !== undefined && nextSt !== row.st;
  L.rect(edge ? GROUP : HAIR, edge ? 0 : k.name, y + h - 1, edge ? W : W - k.name - 12, 1);

  const cy = y + 14; // line 1 baseline
  L.rect(row.st === 'red' ? C.red : row.st === 'building' ? C.packet : row.st === 'green' ? C.greenEdge : C.machineDim, k.glyph, y + 7, 6, 6);
  L.text(F12B, row.st === 'quiet' ? C.ink2 : C.ink, fit(String(r.name ?? row.id), k.nameW, k.a12b), k.name, cy);
  const a11 = k.a;
  const dots = dotsOf(r);
  const prs = Number(r.open_prs) || 0;
  const age = shortAge(now, dots.at(-1)?.at ?? (r.last_activity || undefined));
  const last = dots.at(-1);
  const words = stateWords(row, now);
  const plain = row.st === 'green' || row.st === 'quiet';
  const stateC = Math.floor(k.stateW / a11);
  // The gray 11 px columns as three strings (monospace cells, padded within a group): org, lane
  // and a plain state; the last commit; the open PRs and the age. Core Text shapes and bounds
  // every cell of every string, so a frame's text is most of its cost: while the list moves
  // fast they fade out (motion LOD) and only names, states and dots are drawn.
  const detail = 1 - rc.motion;
  const headText = k.headW && last ? `${short(last.sha ?? '')} ${last.title ?? ''}${last.author ? ` · ${author(last.author)}` : ''}` : '';
  if (detail > 0.05) {
    const a = Math.round(detail * 8) / 8;
    // (moving at all, the lane and a green row's words go too: the org, a red row's words,
    //  the dots, the PRs and the age carry a scroll)
    const ha = Math.round((1 - Math.max(rc.motion, rc.drift)) * 8) / 8;
    if (k.orgW) L.text(F11, TXT3, fit(orgLabel(String(r.org ?? '')), k.orgW, a11), k.org, cy, a);
    if (ha > 0) {
      const mid = cells(k.cHead - 2 - k.cLane, [
        [0, k.laneW ? laneText(String(r.lane ?? '')) : '', Math.floor(k.laneW / a11), false],
        [k.cState - k.cLane, plain ? words : '', stateC, false],
      ]);
      L.text(F11, TXT3, mid, k.lane, cy, ha);
    }
    // (the last commit, the longest string, goes as soon as the list moves at all; an open
    //  row's own LOD0 lines say it)
    if (e === 0 && headText && ha > 0) L.text(F11, TXT3, fit(headText, k.headW, a11), k.head, cy, ha);
    const right = cells(k.cEnd - k.cPrs + 5, [[5, prs ? String(prs) : '', 5, true], [k.cEnd - k.cPrs + 5, age || '–', 8, true]]);
    L.text(F11, TXT3, right, k.prsR - 5 * a11, cy, a);
  }
  if (!plain) {
    // "red 28m" in red; who broke it after, smaller and gray, so the red dots stay the hero
    const cut = row.st === 'red' ? words.indexOf(' · ') : -1;
    const lead = cut >= 0 ? words.slice(0, cut) : words;
    L.text(F11, row.st === 'red' ? C.redText : C.amberText, fit(lead, k.stateW, a11), k.state, cy);
    if (cut >= 0) {
      const x = k.state + (lead.length + 1) * a11;
      const room = k.state + k.stateW - x;
      if (room > 3 * k.a10) L.text(F10, TXT3, fit(words.slice(cut + 3), room, k.a10), x, cy);
    }
  }
  if (e > 0 && e < 1 && headText) {
    ctx.globalAlpha = 1 - e;
    ctx.font = F11;
    ctx.textAlign = 'left';
    ctx.fillStyle = TXT3;
    ctx.fillText(fit(headText, k.headW, a11), k.head, cy);
    ctx.globalAlpha = 1;
  }

  // the main line: compact at LOD2, full at LOD0, interpolated between
  const x1 = k.dots1 - 10 + (k.open1 - k.dots1) * e;
  const lineY = y + 10 + (OPEN / 2 - 10) * e;
  const avail = x1 - k.dots0;
  const pitch = Math.min(9 + 6 * e, avail / Math.max(1, Math.min(40, dots.length)));
  const red = row.st === 'red';
  if (e < 0.05 && pitch >= 4.5) denseLine(L, dots, k.dots0, x1, lineY, pitch, red, red ? r.main?.culprit ?? null : null);
  else if (pitch >= 4.5 || e > 0.5) mainLine(ctx, dots, k.dots0, x1, lineY, Math.max(4.5, pitch), 2.6 + 1.6 * e, e, red, red ? r.main?.culprit ?? null : null, hits, row.id);
  else bars(ctx, dots, k.dots0, x1, lineY, now, red);

  if (e <= 0.05) return;
  // LOD0 text: the commit in question, then the ways in. (The context keeps its state from the
  // last frame on macOS: say the alignment, the header ended right-aligned.)
  ctx.textAlign = 'left';
  ctx.globalAlpha = clamp((e - 0.25) / 0.75, 0, 1);
  const leftW = k.dots0 - 16 - k.name;
  const sha = openSha(r);
  const dot = dots.find((d) => d?.sha === sha) ?? dots.at(-1);
  const y2 = y + 32, y3 = y + 46;
  ctx.font = F11;
  let x = k.name;
  if (dot) {
    const lead = red ? `culprit ${short(sha)}` : row.st === 'building' ? `building ${short(dot.sha)}` : `head ${short(dot.sha)}`;
    ctx.fillStyle = red ? C.redText : C.ink2;
    ctx.fillText(lead, x, y2);
    x += lead.length * a11 + a11;
    ctx.fillStyle = C.ink2;
    const rest = `${author(dot.author)}${dot.title ? ` · ${dot.title}` : ''}`;
    ctx.fillText(fit(rest, k.name + leftW - x, a11), x, y2);
    if (hits && dot.sha) hits.push({ x: k.name, y: y2 - 11, w: lead.length * a11, h: 14, kind: 'commit', id: `${row.id}@${dot.sha}`, route: `/commit/${row.id}/${dot.sha}`, label: `${row.id} ${short(dot.sha)}` });
  } else {
    ctx.fillStyle = TXT3;
    ctx.fillText('no commits on main in the last day', x, y2);
  }
  // links
  x = k.name;
  const link = (label: string, color: string, hit: Omit<SubHit, 'x' | 'y' | 'w' | 'h'> | null) => {
    ctx.fillStyle = color;
    ctx.fillText(label, x, y3);
    const w = label.length * a11;
    if (hit && hits) hits.push({ x: x - 3, y: y3 - 11, w: w + 6, h: 15, ...hit });
    x += w + 2 * a11;
  };
  if (prs) link(`${prs} open PR${prs === 1 ? '' : 's'} ›`, C.ink2, { kind: 'prs', id: row.id, route: `/prs?repo=${encodeURIComponent(row.id)}`, label: `Open PRs of ${row.id}` });
  else link('no open PRs', TXT3, null);
  if (r.app) link(`app ${r.app} ›`, C.ink2, { kind: 'app', id: String(r.app), route: `/fleet?app=${encodeURIComponent(String(r.app))}`, label: `App ${r.app}` });
  if (sha) link(focusedHint(rc), TXT3, null);
  ctx.globalAlpha = 1;
}

/** "28m", "4h 32m", "20h", "3d": a duration a row can afford. */
export function coarse(ms: number): string {
  if (!Number.isFinite(ms) || ms < 60_000) return '<1m';
  const m = Math.floor(ms / 60_000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 10) return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
  if (h < 48) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

/** "9m", "4h", "2d": the age of the newest commit, one unit. */
function shortAge(now: number, at: number | undefined): string {
  if (typeof at !== 'number' || !(at > 0)) return '';
  const d = Math.max(0, now - at);
  if (d < 60_000) return 'now';
  if (d < 3_600_000) return `${Math.floor(d / 60_000)}m`;
  if (d < 86_400_000) return `${Math.floor(d / 3_600_000)}h`;
  return `${Math.floor(d / 86_400_000)}d`;
}

function focusedHint(rc: RowCtx): string {
  return rc.focused ? '↵ or click: journey' : 'click to focus';
}

/** The dots, newest at `x1`: reds older than the last green as rings, the current streak solid. */
/** LOD2's line into the frame's layers: rail, cap, dots in runs, rings for old reds and the
 *  culprit. A dozen ops a row. */
function denseLine(L: Layers, dots: Dot[], x0: number, x1: number, y: number, pitch: number, red: boolean, culprit: string | null): void {
  const r = 2.6;
  const n = Math.max(0, Math.min(dots.length, Math.floor((x1 - x0) / pitch) + 1, 40));
  const list = dots.slice(dots.length - n);
  const left = x1 - (list.length - 1) * pitch;
  const lg = lastGreen(list);
  const ci = culprit ? list.findIndex((d) => d?.sha === culprit) : -1;
  const ry = Math.round(y);
  const railX = list.length ? left - 4 : x0;
  L.rect(C.wire, railX, ry, x1 + 6 - railX, 1);
  if (red && ci >= 0) { const cx = x1 - (list.length - 1 - ci) * pitch; L.rect(RED_RAIL, cx, ry, x1 + 6 - cx, 1); }
  L.rect(C.portEdge, x1 + 6, y - 4.5, 3, 9);
  let i = 0;
  while (i < list.length) {
    const c = colorAt(list, i, lg);
    let j = i + 1;
    while (j < list.length && colorAt(list, j, lg) === c) j++;
    const xi = x1 - (list.length - 1 - i) * pitch;
    if (c) L.dots.add(c, c === C.dotDim ? r * 0.7 : r, pitch, xi, y, j - i);
    else for (let q = i; q < j; q++) L.ring(OLD_RED, 1, x1 - (list.length - 1 - q) * pitch, y, r - 0.5);
    if (c === C.ink) for (let q = i; q < j; q++) L.ring(C.packet, 1.2, x1 - (list.length - 1 - q) * pitch, y, r + 2);
    i = j;
  }
  if (ci >= 0) L.ring(CULPRIT_RING, 1, x1 - (list.length - 1 - ci) * pitch, y, r + 2);
}

const RED_RAIL = withAlpha(C.red, 0.5);
const OLD_RED = withAlpha(C.red, 0.45);
const CULPRIT_RING = withAlpha(C.red, 0.7);

function mainLine(ctx: Ctx2D, dots: Dot[], x0: number, x1: number, y: number, pitch: number, r: number, e: number, red: boolean, culprit: string | null, hits: SubHit[] | null, repo: string): void {
  const n = Math.max(0, Math.min(dots.length, Math.floor((x1 - x0) / pitch) + 1, 40));
  const list = dots.slice(dots.length - n);
  const left = x1 - (list.length - 1) * pitch;
  const lg = lastGreen(list);
  const ci = culprit ? list.findIndex((d) => d?.sha === culprit) : -1;
  // rail and cap (rects: one op each)
  const railX = list.length ? left - 4 : x0;
  ctx.fillStyle = C.wire;
  ctx.fillRect(railX, Math.round(y), x1 + 6 + 2 * e - railX, 1);
  if (red && ci >= 0) {
    const cx = x1 - (list.length - 1 - ci) * pitch;
    ctx.fillStyle = withAlpha(C.red, 0.5);
    ctx.fillRect(cx, Math.round(y), x1 + 6 + 2 * e - cx, 1);
  }
  const capH = 9 + 9 * e;
  ctx.fillStyle = C.portEdge;
  ctx.fillRect(x1 + 6 + 2 * e, y - capH / 2, 3 + 3 * e, capH);
  if (!list.length) return;
  // batched by colour: solid fills, then the rings
  const solid = new Map<string, number[]>();
  const oldRed: number[] = [], running: number[] = [];
  for (let i = 0; i < list.length; i++) {
    const d = list[i];
    const x = x1 - (list.length - 1 - i) * pitch;
    const s = d?.state;
    if (isFail(s)) {
      if (i < lg) { oldRed.push(x); continue; }
      push(solid, C.red, x);
    } else if (s === 'success') push(solid, C.dot, x);
    else if (s === 'running') { push(solid, C.ink, x); running.push(x); }
    else if (s === 'pending' || s === 'blocked') push(solid, TXT3, x);
    else push(solid, C.dotDim, x);
  }
  for (const [c, xs] of solid) {
    const rr = c === C.dotDim ? r * 0.7 : r;
    ctx.beginPath();
    for (const x of xs) { ctx.moveTo(x + rr, y); ctx.arc(x, y, rr, 0, TAU); }
    ctx.fillStyle = c;
    ctx.fill();
  }
  if (oldRed.length) {
    ctx.beginPath();
    for (const x of oldRed) { ctx.moveTo(x + r - 0.5, y); ctx.arc(x, y, r - 0.5, 0, TAU); }
    ctx.strokeStyle = withAlpha(C.red, 0.45);
    ctx.lineWidth = 1;
    ctx.stroke();
  }
  if (running.length) {
    ctx.beginPath();
    for (const x of running) { ctx.moveTo(x + r + 2, y); ctx.arc(x, y, r + 2, 0, TAU); }
    ctx.strokeStyle = C.packet;
    ctx.lineWidth = 1.2;
    ctx.stroke();
  }
  if (e > 0.3) {
    // deployed marks
    ctx.beginPath();
    let any = false;
    for (let i = 0; i < list.length; i++) {
      if (!list[i]?.deployed) continue;
      const x = x1 - (list.length - 1 - i) * pitch;
      ctx.moveTo(x - 2, y + r + 4);
      ctx.lineTo(x + 2, y + r + 4);
      any = true;
    }
    if (any) { ctx.strokeStyle = withAlpha(C.packetDim, e); ctx.lineWidth = 1.5; ctx.stroke(); }
  }
  if (ci >= 0) {
    const x = x1 - (list.length - 1 - ci) * pitch;
    ctx.beginPath();
    ctx.arc(x, y, r + 2, 0, TAU);
    ctx.strokeStyle = withAlpha(C.red, 0.7);
    ctx.lineWidth = 1;
    ctx.stroke();
    if (e > 0.4) {
      ctx.font = F10;
      ctx.textAlign = 'center';
      ctx.fillStyle = withAlpha(TXT3, e);
      ctx.fillText(short(culprit), x, y - r - 5); // the culprit, by its sha, once, gray
      ctx.textAlign = 'left';
    }
  }
  if (hits) {
    for (let i = 0; i < list.length; i++) {
      const d = list[i];
      if (!d?.sha) continue;
      const x = x1 - (list.length - 1 - i) * pitch;
      hits.push({ x: x - pitch / 2, y: y - r - 4, w: pitch, h: 2 * r + 8, kind: 'commit', id: `${repo}@${d.sha}`, route: `/commit/${repo}/${d.sha}`, label: `${short(d.sha)} ${d.title ?? ''}` });
    }
  }
}

/** A dot's solid colour ('' for an old red, drawn as a ring). */
function colorAt(list: Dot[], i: number, lg: number): string {
  const s = list[i]?.state;
  if (isFail(s)) return i < lg ? '' : C.red;
  if (s === 'success') return C.dot;
  if (s === 'running') return C.ink;
  if (s === 'pending' || s === 'blocked') return TXT3;
  return C.dotDim;
}

function push(m: Map<string, number[]>, c: string, x: number): void {
  let a = m.get(c);
  if (!a) m.set(c, (a = []));
  a.push(x);
}

/** Too many commits for dots at this width: time buckets, a bar's height its count, its
 *  colour the worst state in it (only the current red streak in full red). */
function bars(ctx: Ctx2D, dots: Dot[], x0: number, x1: number, y: number, now: number, red: boolean): void {
  const n = Math.max(4, Math.floor((x1 - x0) / 4));
  const t0 = dots[0]?.at ?? now - 86_400_000;
  const span = Math.max(60_000, now - t0);
  const count = new Array<number>(n).fill(0), worst = new Array<number>(n).fill(0);
  const lg = lastGreen(dots);
  for (let i = 0; i < dots.length; i++) {
    const d = dots[i];
    const b = clamp(Math.floor(((d?.at ?? now) - t0) / span * n), 0, n - 1);
    count[b]++;
    const s = d?.state;
    const w = isFail(s) ? (i > lg && red ? 4 : 2) : s === 'running' || s === 'pending' ? 3 : s === 'success' ? 1 : 0;
    worst[b] = Math.max(worst[b], w);
  }
  ctx.fillStyle = C.wire;
  ctx.fillRect(x0, y, x1 - x0, 1);
  const col = ['#5E5E60', C.dot, withAlpha(C.red, 0.5), C.packet, C.red];
  for (let b = 0; b < n; b++) {
    if (!count[b]) continue;
    const hh = Math.min(10, 3 + count[b] * 2);
    ctx.fillStyle = col[worst[b]];
    ctx.fillRect(x0 + b * 4, y - hh / 2, 3, hh);
  }
}
