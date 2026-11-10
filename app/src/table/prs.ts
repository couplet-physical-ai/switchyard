// Pull requests on the canvas table: one dense row a PR (repo#n, title, author, a compact
// phase track of dashed mini-chips with the stuck one red, check dots, age); the hovered or
// focused row opens to the labelled track, the failing check and the review state.

import type { Ctx2D, Frame } from '../../app.contract.d.ts';
import type { Pr } from '../wire.ts';
import type { World } from '../world.ts';
import { ago, phaseIndex, short } from '../project.ts';
import { arrow, withAlpha } from '../yard/paint.ts';
import { C, FACE, TAU } from '../yard/theme.ts';
import { CanvasTable, type RowCtx, advance, fit } from './table.ts';
import { TXT3, author, coarse } from './mainlines.ts';

export type PrTableRow = { id: string; pr: Pr; bad: boolean; updated: number };

export const PR_DENSE = 20;
export const PR_OPEN = 56;
const HEAD = 22;
const HAIR = '#1A1A1B';
const F11 = `11px ${FACE}`;
const F10 = `10px ${FACE}`;
const F12B = `700 12px ${FACE}`;
const F12 = `12px ${FACE}`;
const LABELS = ['draft', 'checks', 'review', 'mergeable', 'merged', 'deployed'];

const isFail = (s: unknown) => s === 'failure' || s === 'error';
const isOpenPhase = (p: unknown) => p !== 'merged' && p !== 'closed' && p !== 'deployed';

function checksOf(pr: Pr): { name: string; state: string }[] {
  return Array.isArray(pr.checks) ? pr.checks.filter((c) => c && typeof c === 'object') as { name: string; state: string }[] : [];
}

export function isBot(pr: Pr): boolean {
  return !!pr.bot || String(pr.author ?? '').endsWith('[bot]');
}

export function isBlocked(pr: Pr): boolean {
  return pr.phase === 'conflict' || pr.phase === 'changes_requested' || !!pr.blocked_by;
}

/** Where a PR is stuck (the chip drawn red), -1 when it is not. */
export function stuckAt(pr: Pr): number {
  if (pr.phase === 'conflict') return 3;
  if (pr.phase === 'changes_requested') return 2;
  const failed = checksOf(pr).some((c) => isFail(c.state));
  const i = phaseIndex(pr.phase);
  return failed && i >= 0 && i <= 1 ? 1 : -1;
}

/** Each chip's look: a non-draft PR never went through `draft`, so its draft chip is skipped,
 *  never green (review #17). */
export function chipStates(pr: Pr): ('idle' | 'active' | 'ok' | 'bad' | 'skip')[] {
  const idx = phaseIndex(pr.phase);
  const bad = stuckAt(pr);
  const terminal = pr.phase === 'merged' || pr.phase === 'deployed';
  return LABELS.map((_, i) => {
    if (i === bad) return 'bad';
    if (i === 0 && !pr.draft && pr.phase !== 'draft') return 'skip';
    if (idx < 0) return 'skip';
    if (i < idx) return 'ok';
    if (i === idx) return terminal ? 'ok' : 'active';
    return 'idle';
  });
}

export function phaseWord(pr: Pr): [string, string] {
  const bad = stuckAt(pr);
  switch (pr.phase) {
    case 'conflict': return ['conflict', C.redText];
    case 'changes_requested': return ['changes', C.redText];
    case 'mergeable': return ['ready', C.greenInk];
    case 'merged': return ['merged', C.greenInk];
    case 'deployed': return ['deployed', C.greenInk];
    case 'closed': return ['closed', TXT3];
    case 'draft': return ['draft', TXT3];
    case 'checks': return bad === 1 ? ['failing', C.redText] : ['checks', C.amberText];
    case 'review': return ['review', C.ink2];
    default: return [String(pr.phase ?? '–'), TXT3];
  }
}

type Cols = { W: number; glyph: number; name: number; nameW: number; title: number; titleW: number; author: number; authorW: number; track: number; word: number; checks: number; right: number };

function columns(W: number): Cols {
  const m = 12;
  const right = W - m;
  const ageW = 76, checksW = 104, wordW = 70, trackW = 6 * 15 - 3, authorW = W >= 1200 ? 120 : 96;
  const checks = right - ageW - 12 - checksW;
  const word = checks - 12 - wordW;
  const track = word - 8 - trackW;
  const authorX = track - 16 - authorW;
  const name = m + 12;
  const nameW = W >= 1280 ? 220 : 180;
  const title = name + nameW + 10;
  return { W, glyph: m, name, nameW, title, titleW: Math.max(0, authorX - 12 - title), author: authorX, authorW, track, word, checks, right };
}

export class PrsModel {
  readonly table = new CanvasTable<PrTableRow>((r) => r.id, PR_DENSE, PR_OPEN);
  private world: World | null = null;
  private ver = -1;
  private key = '';
  private rows: PrTableRow[] = [];
  seq = 0;
  counts = { open: 0, ready: 0, blocked: 0, bots: 0, total: 0 };
  private cols: Cols | null = null;

  constructor() {
    this.table.padTop = HEAD;
  }

  project(w: World, org: string, filter: string, q: string, repo: string): PrTableRow[] {
    const key = `${org}\u0000${filter}\u0000${q}\u0000${repo}`;
    if (w === this.world && w.ver === this.ver && key === this.key) return this.rows;
    const ql = q.trim().toLowerCase();
    const rows: PrTableRow[] = [];
    let open = 0, ready = 0, blocked = 0, bots = 0;
    for (const pr of w.prs.values()) {
      if (!pr || typeof pr !== 'object' || !pr.repo) continue;
      if (org && w.orgOf(pr.repo) !== org) continue;
      if (repo && pr.repo !== repo) continue;
      const isOpen = isOpenPhase(pr.phase);
      const bot = isBot(pr);
      const blk = isBlocked(pr);
      if (isOpen) open++;
      if (pr.phase === 'mergeable') ready++;
      if (blk) blocked++;
      if (bot && isOpen) bots++;
      if (filter === 'open' && !isOpen) continue;
      if (filter === 'ready' && pr.phase !== 'mergeable') continue;
      if (filter === 'blocked' && !blk) continue;
      if (filter === 'bots' && !bot) continue;
      if (filter === 'shipped' && isOpen) continue;
      const id = `${pr.repo}#${pr.number}`;
      if (ql && !(`${id} ${pr.title ?? ''} ${pr.author ?? ''}`.toLowerCase().includes(ql))) continue;
      rows.push({ id, pr, bad: stuckAt(pr) >= 0 || pr.phase === 'conflict' || pr.phase === 'changes_requested', updated: Number(pr.updated) || 0 });
    }
    rows.sort((a, b) => Number(b.bad) - Number(a.bad) || b.updated - a.updated || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    this.world = w;
    this.ver = w.ver;
    this.key = key;
    this.rows = rows;
    this.counts = { open, ready, blocked, bots, total: rows.length };
    this.seq++;
    this.table.setRows(rows);
    return rows;
  }

  routeOf(id: string): string {
    const i = this.table.index.get(id);
    const row = i === undefined ? undefined : this.rows[i];
    return row ? `/pr/${row.pr.repo}/${row.pr.number}` : '';
  }

  draw(ctx: Ctx2D, frame: Frame, now: number, loaded: boolean): boolean {
    if (!this.cols || this.cols.W !== frame.width) this.cols = columns(frame.width);
    const cols = this.cols;
    const moving = this.table.draw(ctx, frame, (c, row, rc) => paintPr(c, row, rc, cols), now, loaded ? 'No pull request matches.' : 'Waiting for the fleet…');
    paintHeader(ctx, cols, frame.width);
    return moving;
  }
}

function paintHeader(ctx: Ctx2D, k: Cols, W: number): void {
  ctx.fillStyle = C.canvas;
  ctx.fillRect(0, 0, W, HEAD);
  ctx.fillStyle = '#262628';
  ctx.fillRect(0, HEAD - 1, W, 1);
  ctx.font = F10;
  ctx.fillStyle = TXT3;
  ctx.textAlign = 'left';
  ctx.letterSpacing = '0.6px';
  const y = 14;
  ctx.fillText('PULL REQUEST', k.name, y);
  if (k.titleW > 40) ctx.fillText('TITLE', k.title, y);
  ctx.fillText('AUTHOR', k.author, y);
  ctx.fillText('PHASE', k.track, y);
  ctx.fillText('CHECKS', k.checks, y);
  ctx.textAlign = 'right';
  ctx.fillText('UPDATED', k.right, y);
  ctx.letterSpacing = '0px';
}

function paintPr(ctx: Ctx2D, row: PrTableRow, rc: RowCtx, k: Cols): void {
  const { y, h, W, e, focused, hits, now } = rc;
  const pr = row.pr;
  if (e > 0 || focused) {
    ctx.fillStyle = withAlpha(focused ? C.raised : '#141415', focused ? Math.max(0.6, e) : e);
    ctx.fillRect(0, y, W, h);
    if (focused) { ctx.fillStyle = C.brand; ctx.fillRect(0, y + 2, 2, h - 4); }
  }
  ctx.fillStyle = HAIR;
  ctx.fillRect(k.name, y + h - 1, W - k.name - 12, 1);
  const cy = y + 14;
  const states = chipStates(pr);
  const [word, wordC] = phaseWord(pr);
  // glyph: where it stands
  const bad = states.includes('bad');
  ctx.fillStyle = bad ? C.red : pr.phase === 'mergeable' ? C.green : !isOpenPhase(pr.phase) ? C.greenEdge : pr.phase === 'draft' ? C.machineDim : C.packet;
  ctx.beginPath();
  ctx.roundRect(k.glyph, y + 7, 6, 6, 1.5);
  ctx.fill();

  ctx.textAlign = 'left';
  const a12b = advance(ctx, F12B), a11 = advance(ctx, F11), a12 = advance(ctx, F12);
  const name = `${String(pr.repo).split('/')[1] ?? pr.repo} #${pr.number}`;
  ctx.font = F12B;
  ctx.fillStyle = C.ink;
  ctx.fillText(fit(name, k.nameW, a12b), k.name, cy);
  if (k.titleW > 40) {
    ctx.font = F12;
    ctx.fillStyle = C.ink2;
    ctx.fillText(fit(String(pr.title ?? ''), k.titleW, a12), k.title, cy);
  }
  ctx.font = F11;
  const bot = isBot(pr);
  ctx.fillStyle = bot ? C.amberText : TXT3;
  ctx.fillText(bot ? `${fit(author(pr.author), k.authorW - 4 * a11, a11)} bot` : fit(author(pr.author), k.authorW, a11), k.author, cy);

  // the phase track: mini-chips at LOD2 (fading out as the row opens to the labelled one)
  const mini = 1 - Math.min(1, e * 1.6);
  if (mini > 0) {
    ctx.globalAlpha = mini;
    miniTrack(ctx, states, k.track, y + 10);
    ctx.globalAlpha = 1;
  }
  ctx.font = F11;
  ctx.fillStyle = wordC;
  ctx.fillText(word, k.word, cy);

  // checks: "✓ N" for those that passed beyond the list (v0.4's checks_passed), then a dot for
  // each listed one (required first, then those that have not passed: the server's order)
  const checks = checksOf(pr);
  const passed = Math.max(0, Number(pr.checks_passed) || 0);
  const shown = checks.slice(0, 8);
  const failed = checks.filter((c) => isFail(c.state)).length;
  ctx.font = F11;
  let cx = k.checks;
  if (passed) {
    const t = `✓${passed}`;
    ctx.fillStyle = C.greenInk;
    ctx.fillText(t, cx, cy);
    cx += (t.length + 0.5) * a11;
  }
  const groups = new Map<string, number[]>();
  shown.forEach((c, i) => {
    const col = c.state === 'success' ? C.ink2 : isFail(c.state) ? C.red : c.state === 'running' || c.state === 'pending' ? C.packet : C.dotDim;
    let a = groups.get(col);
    if (!a) groups.set(col, (a = []));
    a.push(cx + 3 + i * 6);
  });
  for (const [col, xs] of groups) {
    ctx.beginPath();
    for (const x of xs) { ctx.moveTo(x + 2.2, y + 10); ctx.arc(x, y + 10, 2.2, 0, TAU); }
    ctx.fillStyle = col;
    ctx.fill();
  }
  cx += shown.length ? shown.length * 6 + 4 : 0;
  if (failed) { ctx.fillStyle = C.redText; ctx.fillText(`${failed} red`, cx, cy); }
  else if (!passed && !checks.length) { ctx.fillStyle = TXT3; ctx.fillText('–', cx, cy); }

  // updated, or stale in amber
  ctx.textAlign = 'right';
  const stale = Number(pr.stale_ms) || 0;
  if (stale > 86_400_000 && isOpenPhase(pr.phase)) { ctx.fillStyle = C.amberText; ctx.fillText(`stale ${coarse(stale)}`, k.right, cy); }
  else { ctx.fillStyle = TXT3; ctx.fillText(pr.updated ? coarse(now - pr.updated) : '–', k.right, cy); }
  ctx.textAlign = 'left';

  if (e <= 0.05) return;
  // LOD0: the labelled track, what blocks it, the review and the head
  ctx.globalAlpha = Math.min(1, Math.max(0, (e - 0.2) / 0.8));
  const y2 = y + 31, y3 = y + 50;
  let x = k.name;
  const a10 = advance(ctx, F10);
  states.forEach((st, i) => {
    if (i === 0 && st === 'skip') return; // never a draft: no draft chip at all
    const label = st === 'bad' ? (pr.phase === 'conflict' ? 'conflict' : pr.phase === 'changes_requested' ? 'changes' : 'failing') : LABELS[i];
    if (x > k.name) { arrow(ctx, x + 2, x + 13, y2); x += 15; }
    x += bigChip(ctx, label, x, y2, st, a10);
  });
  x += 16;
  ctx.font = F11;
  const failing = checks.find((c) => isFail(c.state));
  const why = pr.blocked_by ? `blocked by ${pr.blocked_by}` : failing ? `failing: ${failing.name}` : '';
  if (why) { ctx.fillStyle = C.redText; ctx.fillText(fit(why, Math.max(0, W - 24 - x), a11), x, y2 + 4); }
  const rv = pr.review && typeof pr.review === 'object' ? pr.review : {};
  const parts = [
    rv.ai ? `ai ${rv.ai}` : '',
    rv.human ? String(rv.human).replace(/_/g, ' ') : '',
    pr.head_sha ? `head ${short(pr.head_sha)}` : '',
    pr.base ? `into ${pr.base}` : '',
    pr.created ? `opened ${ago(now, pr.created)}` : '',
  ].filter(Boolean);
  ctx.fillStyle = TXT3;
  const line = parts.join(' · ');
  ctx.fillText(fit(line, Math.max(0, k.checks - 16 - k.name), a11), k.name, y3);
  ctx.textAlign = 'right';
  ctx.fillText(focused ? '↵ or click: open' : 'click to open', k.right, y3);
  ctx.textAlign = 'left';
  if (hits && pr.head_sha) {
    const at = line.indexOf('head ');
    if (at >= 0) hits.push({ x: k.name + at * a11 - 2, y: y3 - 11, w: 12 * a11 + 4, h: 15, kind: 'commit', id: `${pr.repo}@${pr.head_sha}`, route: `/commit/${pr.repo}/${pr.head_sha}`, label: `head ${short(pr.head_sha)}` });
  }
  ctx.globalAlpha = 1;
}

/** A labelled phase chip, 15 px tall (10 px type): the open row's track. */
function bigChip(ctx: Ctx2D, label: string, x: number, cy: number, st: string, a10: number): number {
  const w = Math.ceil(label.length * a10) + 12;
  ctx.beginPath();
  ctx.roundRect(x + 0.5, cy - 7, w, 14, 3);
  if (st === 'ok') { ctx.fillStyle = C.greenFill; ctx.fill(); }
  else if (st === 'bad') { ctx.fillStyle = C.redFill; ctx.fill(); }
  else if (st === 'active') { ctx.fillStyle = withAlpha(C.packet, 0.14); ctx.fill(); }
  ctx.setLineDash(st === 'idle' || st === 'skip' ? [3, 2.5] : []);
  ctx.lineWidth = 1;
  ctx.strokeStyle = st === 'ok' ? C.greenEdge : st === 'bad' ? C.redEdge : st === 'active' ? C.packet : C.chipEdge;
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.font = F10;
  ctx.textAlign = 'left';
  ctx.fillStyle = st === 'ok' ? C.greenInk : st === 'bad' ? C.redText : st === 'active' ? C.amberText : TXT3;
  ctx.fillText(label, x + 6.5, cy + 3.5);
  return w + 1;
}

/** Six dashed mini-chips (12×8, 3 apart): passed green, the current solid amber, the stuck
 *  one red, a never-taken draft a faint outline. */
function miniTrack(ctx: Ctx2D, states: string[], x0: number, cy: number): void {
  for (let i = 0; i < states.length; i++) {
    const st = states[i];
    const x = x0 + i * 15;
    ctx.beginPath();
    ctx.roundRect(x + 0.5, cy - 3.5, 11, 7, 2);
    if (st === 'ok') { ctx.fillStyle = C.greenFill; ctx.fill(); }
    else if (st === 'bad') { ctx.fillStyle = C.redFill; ctx.fill(); }
    else if (st === 'active') { ctx.fillStyle = withAlpha(C.packet, 0.9); ctx.fill(); }
    ctx.setLineDash(st === 'idle' || st === 'skip' ? [2, 2] : []);
    ctx.lineWidth = 1;
    ctx.strokeStyle = st === 'ok' ? C.greenEdge : st === 'bad' ? C.red : st === 'active' ? C.packet : st === 'skip' ? withAlpha(C.chipEdge, 0.45) : C.chipEdge;
    ctx.stroke();
    ctx.setLineDash([]);
  }
}
