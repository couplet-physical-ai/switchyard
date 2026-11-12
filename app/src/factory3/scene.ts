// Factory 3, "the berth board": the scene. A pure function of the model, the window and what is
// selected: a list of rectangles and words (logical units; board.ts paints them at the fit's
// scale), the hit regions, and where every run sits (its anchors, which board.ts compares from
// one world version to the next: a run that changed place is the only thing that ever moves).
//
// Squares and right angles only. Grey is normal (a passed run, a green line, an app that is up);
// amber is work happening now; red is broken. A word is coloured only when it is a status.

import { C } from '../yard/theme.ts';
import { WINDOWS, type Bead, type Board, type Cell, type CellState, type Run } from './model.ts';

export type Op = ['r', number, number, number, number, string] | ['t', string, number, number, string, number, 0 | 1, 0 | 1 | 2];
export type Hit = { kind: string; id: string; x: number; y: number; w: number; h: number; url?: string };
/** Where an entity (a run, a deploy) is drawn: `place` orders the stations it passes through;
 *  `key` names the mark (hidden while a transit is on its way to it). */
export type Anchor = { place: number; key: string; x: number; y: number; s: number; c: string; label: string };
export const PLACE = { wait: 0, slot: 1, result: 2, bin: 3, deploy: 0, app: 1 } as const;

export type Layout = {
  /** logical → CSS px */
  s: number; W: number; H: number;
  /** the ledger's top (the floor's bottom): the same fraction of the height the inspector's dock uses */
  split: number;
  cols: { x: number; w: number }[];
};
export const SPLIT = 0.56;
/** the line the stations sit on (logical y): what moves between stations rides it */
export const LINE_Y = 66;
const BASE_H = 842, MIN_W = 1280;
const NAMES = ['waiting', 'building', 'checks', 'main lines', 'deploy', 'apps'];

/** The fixed camera: the board fits the window; a bigger window gets bigger type and more rows. */
export function layoutOf(cssW: number, cssH: number): Layout {
  let s = Math.min(cssH / BASE_H, cssW / MIN_W);
  if (s > 1) s = 1 + (s - 1) * 0.6;
  s = Math.max(0.4, s);
  const W = cssW / s, H = cssH / s;
  const base = [148, 356, 208, 208, 136, 112], grow = [0.08, 0.34, 0.16, 0.16, 0.14, 0.12];
  const extra = Math.max(0, W - MIN_W);
  const cols: { x: number; w: number }[] = [];
  let x = 16;
  for (let i = 0; i < 6; i++) { const w = Math.round(base[i] + extra * grow[i]); cols.push({ x, w }); x += w + 16; }
  return { s, W, H, split: Math.round(H * SPLIT), cols };
}

export type SceneOpts = {
  win: string; sel: string; mode: string;
  /** the inspector's dock is open: the ledger is under it and is not drawn */
  dock: boolean;
  /** marks a transit is on its way to (drawn when it lands) */
  hidden: Set<string>;
  /** what the pointer is over: its hit's rectangle "x,y,w,h" (logical), '' for nothing */
  hov: string;
};
export type Scene = { ops: Op[]; hits: Hit[]; anchors: Map<string, Anchor[]>; key: string; counts: { squares: number; texts: number }; say: Record<string, string> };

const AMBER = C.packet, AMBER_BASE = '#2A2314', DOCK = C.packetDock, RED = C.red, RED_DIM = C.redEdge;
const PASS = '#6A6A6A', BEAD = '#4E4E50', EMPTY = '#18181A', APP_UP = '#3A3A3C', HOLLOW = '#3A3A3C';

/** A glyph's advance at each size the board uses (logical units). board.ts measures them at
 *  the fit's scale: a hinted face advances by whole device pixels, not by 0.6 of its size. */
export const SIZES = [10, 10.5, 11, 11.5, 12, 19];
const ADV = new Map<number, number>();
export function setAdvance(px: number, a: number): void { if (a > px * 0.3 && a < px) ADV.set(px, a); }
const adv = (px: number) => ADV.get(px) ?? px * 0.6;
const tw = (s: string, px: number) => s.length * adv(px);
function fit(s: string, px: number, maxW: number): string {
  const n = Math.floor(maxW / adv(px));
  if (s.length <= n) return s;
  return n <= 1 ? '' : `${s.slice(0, n - 1)}…`;
}
/** a live timer: m:ss; past an hour, hours and minutes (nothing that old changes by the second) */
export function timer(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s >= 3600) return `${Math.floor(s / 3600)}h ${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m`;
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
/** A finished thing's age, counted in minutes of the clock (now's minute − its minute): every age
 *  on the board turns at the same instant, once a minute, as a station clock does; between two
 *  turns an idle board is the same picture. */
export function ageAt(now: number, at: number): string {
  return age((Math.floor(now / 60_000) - Math.floor(at / 60_000)) * 60_000);
}
export function age(ms: number): string {
  if (ms < 60_000) return 'now';
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m`;
  if (ms < 172_800_000) return `${Math.floor(ms / 3_600_000)}h`;
  return `${Math.floor(ms / 86_400_000)}d`;
}

export function sceneOf(b: Board, L: Layout, o: SceneOpts): Scene {
  const ops: Op[] = [];
  const hits: Hit[] = [];
  const anchors = new Map<string, Anchor[]>();
  const say: Record<string, string> = {};
  const now = b.at;
  const minute = Math.floor(now / 60_000) * 60_000;
  const ago = (at: number) => ageAt(now, at);
  let squares = 0, texts = 0;
  const R = (x: number, y: number, w: number, h: number, c: string) => { ops.push(['r', x, y, w, h, c]); squares++; };
  const T = (s: string, x: number, y: number, c: string, px: number, bold = false, align: 0 | 1 | 2 = 0): number => {
    if (!s) return 0;
    ops.push(['t', s, x, y, c, px, bold ? 1 : 0, align]); texts++;
    return tw(s, px);
  };
  /** runs of words on one line; returns the end x */
  const run = (parts: [string, string, boolean?][], x: number, y: number, px: number): number => {
    for (const [s, c, bold] of parts) x += T(s, x, y, c, px, !!bold);
    return x;
  };
  const hit = (kind: string, id: string, x: number, y: number, w: number, h: number, url?: string) => { if (id || url) hits.push({ kind, id, x, y, w, h, url }); };
  const anchor = (id: string, a: Anchor) => { const l = anchors.get(id); if (l) l.push(a); else anchors.set(id, [a]); };
  const hollow = (x: number, y: number, s: number, c = HOLLOW) => { R(x, y, s, 1, c); R(x, y + s - 1, s, 1, c); R(x, y + 1, 1, s - 2, c); R(x + s - 1, y + 1, 1, s - 2, c); };
  /** what is selected: four corner brackets in ink */
  const brackets = (x: number, y: number, w: number, h: number, c: string = C.ink) => {
    const k = Math.min(6, w / 3, h / 3), t = 1.5;
    for (const [ax, ay, sx, sy] of [[x, y, 1, 1], [x + w, y, -1, 1], [x, y + h, 1, -1], [x + w, y + h, -1, -1]] as const) {
      R(sx > 0 ? ax : ax - k, sy > 0 ? ay : ay - t, k, t, c);
      R(sx > 0 ? ax : ax - t, sy > 0 ? ay : ay - k, t, k, c);
    }
  };
  /** a run's crate in a berth or the waiting bay: the square fills to elapsed ÷ typical */
  const crate = (x: number, y: number, s: number, r: Run) => {
    if (r.state === 'wait') { R(x, y, s, s, DOCK); return; }
    const el = now - (r.started || r.created);
    R(x, y, s, s, AMBER_BASE);
    if (r.expectedMs > 0) {
      const h = Math.max(2, Math.min(s, Math.round(s * Math.min(1, el / r.expectedMs))));
      R(x, y + s - h, s, h, AMBER);
    } else { const k = Math.round(s * 0.42); R(x + (s - k) / 2, y + (s - k) / 2, k, k, AMBER); }
  };
  const [cW, cB, cC, cM, cD, cA] = L.cols;
  const live = o.mode === 'live' || o.mode === '';

  // ---- the headline: what is happening now, in one sentence --------------------------------
  {
    let x = 16;
    const y = 38;
    if (!live) x += T(o.mode === 'replay' ? 'replaying the last hour' : o.mode, x, y - 2, C.amberText, 11.5) + 14;
    const building = b.busy, waiting = b.waiting.total;
    if (building || waiting) {
      x = run([[`${building}`, building ? AMBER : C.ink, true], [' building · ', C.ink, true], [`${waiting}`, C.ink, true], [' waiting', C.ink, true]], x, y, 19);
    } else x += T('nothing building', x, y, C.ink, 19, true);
    x += 16;
    const parts: [string, string][] = [];
    parts.push([b.checks.binTotal ? `${b.checks.binTotal} failed in the last ${o.win}` : `nothing failed in the last ${o.win}`, b.checks.binTotal ? C.redText : C.ink3]);
    const down = b.apps.bad.filter((a) => a.health === 'down').length;
    if (down) parts.push([` · ${down} app${down === 1 ? '' : 's'} down`, C.redText]);
    const last = b.ledger[0]?.at ?? 0;
    if (!building && !waiting && last) parts.push([` · last event ${ago(last)}${ago(last) === 'now' ? '' : ' ago'}`, C.ink3]);
    run(parts, x, y - 2, 11.5);
    say.head = `${building} building · ${waiting} waiting · ${b.checks.binTotal} failed`;
  }

  // ---- the line: six stations in the order work passes through them -----------------------
  const lineY = LINE_Y;
  R(16, lineY, L.W - 32, 1, C.wire);
  const caps: [string, string, boolean?][][] = [
    b.waiting.total ? [[`${b.waiting.total}`, AMBER, true], [b.waiting.oldestAt ? ` · oldest ${timer(now - b.waiting.oldestAt)}` : '', now - b.waiting.oldestAt > 3_600_000 ? C.redText : C.ink3]] : [['empty', C.ink3]],
    [[`${b.busy}`, b.busy ? AMBER : C.ink2, true], [` of ${b.slots} slots`, C.ink3]],
    b.checks.ran ? [[`${Math.round(100 * (b.checks.ran - b.checks.failed) / b.checks.ran)}%`, C.ink2, true], [` pass · ${b.checks.ran} ran`, C.ink3]] : [['none ran', C.ink3]],
    [[`${b.mains.red.length}`, b.mains.red.length ? C.redText : C.ink2, true], [` red · ${b.mains.green} green`, C.ink3]],
    [[`${b.deploy.running.length}`, b.deploy.running.length ? AMBER : C.ink2, true], [` now · ${b.deploy.today} today`, C.ink3]],
    b.apps.bad.length ? [[`${b.apps.bad.length}`, C.redText, true], [` not up · ${b.apps.up} up`, C.ink3]] : [[`${b.apps.up}`, C.ink2, true], [` of ${b.apps.total} up`, C.ink3]],
  ];
  L.cols.forEach((c, i) => {
    R(c.x, lineY - 3, 7, 7, C.machine);
    T(NAMES[i], c.x, lineY + 22, C.ink, 12, true);
    run(caps[i], c.x, lineY + 38, 11.5);
  });
  if (b.waiting.url) hit('link', '', cW.x, lineY + 8, cW.w, 34, b.waiting.url);
  const top = lineY + 56, bottom = L.split - 10;
  const room = bottom - top;

  // ---- building: each machine, its berths (a column per agent) ------------------------------
  let rows = 0;
  for (const m of b.machines) rows += Math.ceil(m.slots.length / m.cols);
  const M = b.machines.length;
  const pitch = Math.max(18, Math.min(40, Math.floor((room - 20 * M - 12 * (M - 1)) / Math.max(1, rows))));
  const sq = Math.max(10, pitch - 10);
  const two = sq >= 20;
  /** a crate and its two lines of words: the name; the step and the timer */
  const strip = (x: number, y: number, w: number, r: Run, step: string, key: string, place: number) => {
    anchor(r.id, { place, key, x, y, s: sq, c: r.state === 'wait' ? DOCK : AMBER, label: r.name });
    hit('run', r.id, x - 2, y - 2, w, sq + 4);
    if (o.hidden.has(key)) { R(x, y, sq, sq, EMPTY); return; }
    crate(x, y, sq, r);
    const tx = x + sq + 8, tw0 = w - sq - 12;
    const el = now - (r.state === 'wait' ? r.created : r.started || r.created);
    const over = r.state === 'run' && r.expectedMs > 0 && el > r.expectedMs * 1.5;
    const stuck = r.state === 'wait' && el > 3_600_000;
    const clockC = stuck ? C.redText : r.state === 'wait' ? C.ink2 : C.amberText;
    const what = r.state === 'wait' ? r.kind : (step || r.kind);
    const clock = timer(el);
    const tail = r.state === 'run' && r.expectedMs > 0 ? (over ? ` · ${timer(el - r.expectedMs)} over` : ` of ~${timer(r.expectedMs)}`) : '';
    if (two) {
      T(fit(r.name, 11.5, tw0), tx, y + sq / 2 - 3, C.ink, 11.5, true);
      // the step and the timer first; "of ~typical" only when all of it fits
      const all = tw(`${what} ${clock}${tail}`, 10.5) <= tw0;
      const wd = all ? what : fit(what, 10.5, Math.max(0, tw0 - tw(` ${clock}`, 10.5)));
      run([[wd, C.ink3], [`${wd ? ' ' : ''}${clock}`, clockC], [all ? tail : '', over ? C.amberText : C.ink3]], tx, y + sq / 2 + 10, 10.5);
    } else {
      const x1 = tx + T(fit(r.name, 11, tw0 - tw(` ${clock}`, 11)), tx, y + sq / 2 + 4, C.ink, 11, true);
      T(` ${clock}`, x1, y + sq / 2 + 4, clockC, 11);
    }
  };
  {
    let y = top;
    for (const m of b.machines) {
      const hx = run([[m.label, C.ink, true], [`  ${m.busy} of ${m.slots.length}`, C.ink3], [m.online ? '' : '  offline', C.redText], [m.over ? `  +${m.over} more` : '', C.amberText]], cB.x, y + 11, 11.5);
      if (m.url) { T(' ↗', hx, y + 11, C.ink3, 10); hit('link', '', cB.x, y - 2, hx - cB.x + 16, 18, m.url); }
      y += 20;
      const per = Math.ceil(m.slots.length / m.cols);
      const cw = Math.floor(cB.w / m.cols);
      m.slots.forEach((sl, i) => {
        const col = Math.floor(i / per), row = i % per;
        const x = cB.x + col * cw, yy = y + row * pitch;
        if (sl.run) strip(x, yy, cw - 6, sl.run, sl.step, `slot:${m.id}:${sl.n}`, PLACE.slot);
        else R(x, yy, sq, sq, EMPTY);
      });
      y += per * pitch + 12;
    }
  }

  // ---- waiting: the queue, in order ---------------------------------------------------------
  {
    const max = Math.max(1, Math.floor(room / pitch));
    const items = b.waiting.items;
    const show = items.length > max ? max - 1 : items.length;
    for (let i = 0; i < show; i++) strip(cW.x, top + i * pitch, cW.w, items[i], '', `wait:${items[i].id}`, PLACE.wait);
    const more = Math.max(b.waiting.total, items.length) - show;
    if (more > 0) T(`+${more} more waiting`, cW.x, top + show * pitch + 14, C.amberText, 11);
  }

  // ---- checks: every run that finished in the window; the failed bin -------------------------
  {
    const cell = 9, gp = 12;
    const per = Math.max(1, Math.floor((cC.w + 3) / gp));
    const lines = o.win === '10m' ? 1 : o.win === '30m' ? 2 : o.win === '1h' ? 3 : 4;
    const cap = per * lines;
    const list = b.checks.results.length > cap ? b.checks.results.slice(b.checks.results.length - cap) : b.checks.results;
    list.forEach((r, i) => {
      const x = cC.x + (i % per) * gp, y = top + Math.floor(i / per) * gp;
      const c = r.state === 'pass' ? PASS : r.state === 'fail' ? (r.fixed ? RED_DIM : RED) : HOLLOW;
      const key = `result:${r.id}`;
      anchor(r.id, { place: PLACE.result, key, x, y, s: cell, c: r.state === 'cancel' ? PASS : c, label: r.name });
      hit('run', r.id, x - 1, y - 1, gp, gp);
      if (o.hidden.has(key)) return;
      if (r.state === 'cancel') hollow(x, y, cell); else R(x, y, cell, cell, c);
    });
    let y = top + lines * gp + 18;
    // the bin's header: failed · last 30m · N, and the window's chips
    const hx = run([['failed', C.ink, true], [` · last ${o.win} · `, C.ink3], [`${b.checks.binTotal}`, b.checks.binTotal ? C.redText : C.ink2, true]], cC.x, y, 11.5);
    const chipsW = WINDOWS.reduce((a, [k]) => a + tw(k, 11) + 10 + 4, -4);
    let cx = cC.x + cC.w - chipsW, cy = y - 12;
    if (cx < hx + 10) { cx = cC.x; cy = y + 8; y += 24; }
    for (const [k] of WINDOWS) {
      const w = tw(k, 11) + 10, on = k === o.win;
      const edge = on ? C.chipEdge : '#262628';
      if (on) R(cx, cy, w, 17, C.control);
      R(cx, cy, w, 1, edge); R(cx, cy + 16, w, 1, edge); R(cx, cy + 1, 1, 15, edge); R(cx + w - 1, cy + 1, 1, 15, edge);
      T(k, cx + 5, cy + 12.5, on ? C.ink : C.ink3, 11);
      hit('window', k, cx - 2, cy - 3, w + 4, 23);
      if (k === '2h') say.chip = `${Math.round((cx + w / 2) * L.s)},${Math.round((cy + 8) * L.s)}`;
      cx += w + 4;
    }
    y += 12;
    const rowH = 22;
    const max = Math.max(0, Math.floor((bottom - y) / rowH));
    const bin = b.checks.bin;
    const show = bin.length > max ? Math.max(0, max - 1) : bin.length;
    for (let i = 0; i < show; i++) {
      const g = bin[i], r = g.run, yy = y + i * rowH;
      const key = `bin:${r.id}`;
      anchor(`${r.id}#bin`, { place: PLACE.bin, key, x: cC.x, y: yy + 5, s: 10, c: RED, label: r.name });
      hit('run', r.id, cC.x - 2, yy, cC.w + 4, rowH);
      if (i === 0) say.failed = `${r.id} ${Math.round((cC.x + 60) * L.s)},${Math.round((yy + 10) * L.s)}`;
      if (o.hidden.has(key)) continue;
      R(cC.x, yy + 5, 10, 10, RED);
      const ag = ago(r.finished);
      const right = cC.x + cC.w;
      T(ag, right, yy + 14, C.ink3, 11, false, 2);
      // the name; the failing step (cut first); how many times (never cut); its age
      const times = g.count > 1 ? ` ×${g.count}` : '';
      const roomN = cC.w - 18 - tw(ag, 11) - 10 - tw(times, 11);
      const nm = fit(r.name, 11.5, Math.max(roomN * 0.55, roomN - tw(`  ${r.step}`, 11)));
      const x1 = cC.x + 18 + T(nm, cC.x + 18, yy + 14, C.ink, 11.5, true);
      const st = r.step ? fit(r.step, 11, roomN - tw(nm, 11.5) - tw('  ', 11)) : '';
      const x2 = x1 + (st ? T(`  ${st}`, x1, yy + 14, C.ink2, 11) : 0);
      T(times, x2, yy + 14, C.redText, 11);
    }
    if (bin.length > show) T(`+${bin.length - show} more`, cC.x + 18, y + show * rowH + 14, C.redText, 11);
  }

  // ---- main lines: the red ones, the newest broken first -------------------------------------
  {
    const rowH = 22, bs = 7, bg = 9;
    const max = Math.max(1, Math.floor(room / rowH));
    const red = b.mains.red;
    const show = red.length > max ? max - 1 : red.length;
    const bead = (k: Bead, fresh: boolean) => (k === 'fail' ? (fresh ? RED : RED_DIM) : k === 'run' ? AMBER : k === 'pass' ? BEAD : '');
    for (let i = 0; i < show; i++) {
      const l = red[i], y = top + i * rowH;
      const fresh = minute - l.since < 86_400_000;
      const ag = l.since ? ago(l.since) : '';
      const right = cM.x + cM.w;
      T(ag, right, y + 14, fresh ? C.redText : C.ink3, 11, false, 2);
      const bx = right - 30 - 8 * bg;
      l.beads.forEach((k, j) => {
        const x = bx + (8 - l.beads.length + j) * bg, c = bead(k, fresh);
        if (c) R(x, y + 7, bs, bs, c); else hollow(x, y + 7, bs, '#2C2C2E');
      });
      T(fit(l.name, 11.5, bx - cM.x - 8), cM.x, y + 14, fresh ? C.ink : C.ink2, 11.5, fresh);
      hit('repo', l.repo, cM.x - 2, y, cM.w + 4, rowH);
      if (i === 0) say.red = `${l.repo} ${Math.round((cM.x + 30) * L.s)},${Math.round((y + 11) * L.s)}`;
    }
    if (red.length > show) T(`+${red.length - show} more red`, cM.x, top + show * rowH + 14, C.ink3, 11);
  }

  // ---- deploy: what deploys now; the apps whose last deploy failed ---------------------------
  {
    const rowH = 22;
    let y = top;
    const max = Math.max(1, Math.floor(room / rowH));
    const list = [...b.deploy.running, ...b.deploy.failed];
    const show = list.length > max ? max - 1 : list.length;
    for (let i = 0; i < show; i++) {
      const d = list[i];
      const key = `deploy:${d.id}`;
      const c = d.state === 'fail' ? RED : AMBER;
      if (d.state === 'run') anchor(`d:${d.id}`, { place: PLACE.deploy, key, x: cD.x, y: y + 5, s: 10, c: PASS, label: d.app });
      R(cD.x, y + 5, 10, 10, c);
      const word = d.state === 'fail' ? ago(d.finished || d.started) : timer(now - d.started);
      const right = cD.x + cD.w;
      T(word, right, y + 14, d.state === 'fail' ? C.ink3 : C.amberText, 11, false, 2);
      T(fit(d.app, 11.5, cD.w - 18 - tw(word, 11) - 8), cD.x + 18, y + 14, C.ink, 11.5, true);
      hit(d.pipeline ? 'run' : 'app', d.pipeline || d.app, cD.x - 2, y, cD.w + 4, rowH);
      y += rowH;
    }
    if (list.length > show) T(`+${list.length - show} more`, cD.x + 18, y + 14, C.ink3, 11);
  }

  // ---- apps: every app, a square each; the ones not up, named ----------------------------------
  {
    const n = b.apps.cells.length;
    const badRows = Math.min(b.apps.bad.length, 4);
    const gridRoom = room - badRows * 20 - (badRows ? 10 : 0);
    let gp = 10;
    while (gp > 5 && Math.ceil(n / Math.max(1, Math.floor((cA.w + 2) / gp))) * gp > gridRoom) gp--;
    const cell = gp - 2;
    const per = Math.max(1, Math.floor((cA.w + 2) / gp));
    const at = new Map<string, [number, number]>();
    b.apps.cells.forEach((a, i) => {
      const x = cA.x + (i % per) * gp, y = top + Math.floor(i / per) * gp;
      const c = a.health === 'up' ? APP_UP : a.health === 'down' ? RED : a.health === 'degraded' ? AMBER : '';
      if (c) R(x, y, cell, cell, c); else hollow(x, y, cell, '#2C2C2E');
      if (o.sel === a.id) brackets(x - 2, y - 2, cell + 4, cell + 4);
      at.set(a.id, [x, y]);
    });
    // one hit for the grid: the cell under the pointer (board.ts resolves it by position)
    const gridRows = Math.ceil(n / per);
    hits.push({ kind: 'appgrid', id: `${cA.x},${top},${gp},${per},${n}`, x: cA.x, y: top, w: per * gp, h: gridRows * gp });
    let y = top + gridRows * gp + 10;
    for (let i = 0; i < badRows; i++) {
      const a = b.apps.bad[i];
      R(cA.x, y + 4, 10, 10, a.health === 'down' ? RED : AMBER);
      const word = i === 3 && b.apps.bad.length > 4 ? `+${b.apps.bad.length - 3} more` : a.id;
      T(fit(word, 11.5, cA.w - 18), cA.x + 18, y + 13, C.ink, 11.5, true);
      hit('app', a.id, cA.x - 2, y, cA.w + 4, 20);
      y += 20;
    }
    // deploys that landed in the last half minute: where their app's cell is (a transit's end)
    for (const d of b.deploy.landed) {
      const p = at.get(d.app);
      if (p) anchor(`d:${d.id}`, { place: PLACE.app, key: `app:${d.app}`, x: p[0], y: p[1], s: cell, c: PASS, label: d.app });
    }
  }

  // ---- the ledger: the last events, each traced through the stations above ---------------------
  if (!o.dock) {
    const y0 = L.split;
    R(16, y0, L.W - 32, 1, C.rule);
    const hy = y0 + 24;
    run([['events', C.ink, true], [' · newest first · what each one triggered, and how it ended', C.ink3]], 16, hy, 11.5);
    const leftEnd = cB.x + cB.w;
    const stations: [typeof cC, string][] = [[cC, 'checks'], [cM, 'main line'], [cD, 'deploy'], [cA, 'app']];
    T('ran on', leftEnd, hy, C.ink3, 11, false, 2);
    for (const [c, name] of stations) T(name, c.x, hy, C.ink3, 11);
    const rowH = 24;
    const first = hy + 14;
    const max = Math.max(0, Math.floor((L.H - first - 6) / rowH));
    const rowsL = b.ledger.slice(0, max);
    const wordC = (s: CellState) => (s === 'fail' ? C.redText : s === 'run' || s === 'warn' ? C.amberText : C.ink3);
    const sqC = (s: CellState) => (s === 'fail' ? RED : s === 'run' || s === 'warn' ? AMBER : s === 'wait' ? DOCK : PASS);
    rowsL.forEach((r, i) => {
      const y = first + i * rowH, base = y + 16, cy = y + 7;
      const sel = !!o.sel && (o.sel === r.pid || o.sel === r.checks.id || o.sel === r.deploy.id);
      if (sel) brackets(12, y + 2, L.W - 24, rowH - 4);
      T(ago(r.at), 16 + 26, base, C.ink3, 11, false, 2);
      T(r.kind === 'deployment' ? 'deploy' : r.kind, 16 + 38, base, C.ink3, 11);
      const nx = 16 + 38 + 50;
      const nameW = Math.min(170, Math.max(110, (leftEnd - nx) * 0.3));
      T(fit(r.name, 11.5, nameW), nx, base, C.ink, 11.5, true);
      const ranW = tw(r.ranOn, 11);
      T(r.ranOn, leftEnd, base, C.ink3, 11, false, 2);
      const tx = nx + nameW + 12, tEnd = leftEnd - (ranW ? ranW + 14 : 0);
      const fold = r.folded > 1 ? `×${r.folded} · ` : '';
      const ref = `${fold}${r.ref}${r.title ? ' · ' : ''}`;
      const refFit = fit(ref, 11, tEnd - tx);
      const x1 = tx + T(refFit, tx, base, C.ink3, 11);
      let x2 = x1;
      if (refFit === ref) x2 = x1 + T(fit(r.title, 11, tEnd - x1 - (tEnd - x1 > 420 && r.author ? tw(r.author, 11) + 16 : 0)), x1, base, C.ink2, 11);
      if (tEnd - x1 > 420 && r.author && refFit === ref) T(r.author, Math.max(x2 + 16, tEnd - tw(r.author, 11)), base, C.ink3, 11);
      hit('run', r.pid, 12, y, leftEnd - 4, rowH);
      // the trace: a square per stage reached, joined by a hairline; a hollow square = not yet
      const cells: [typeof cC, Cell, string][] = [[cC, r.checks, 'run'], [cM, r.main, 'repo'], [cD, r.deploy, 'run'], [cA, r.app, 'app']];
      let prevEnd = -1;
      for (const [c, cell, kind] of cells) {
        if (cell.state === 'na') continue;
        const x = c.x;
        if (cell.state === 'none') hollow(x, cy, 10); else if (cell.state === 'cancel') hollow(x, cy, 10, PASS); else R(x, cy, 10, 10, sqC(cell.state));
        if (prevEnd >= 0 && cell.state !== 'none' && x - 8 > prevEnd + 8) R(prevEnd + 8, cy + 5, x - 8 - (prevEnd + 8), 1, C.wire);
        let word = cell.word;
        if (cell.t0 > 0 && (cell.state === 'run' || cell.state === 'wait')) word = `${word} ${timer(now - cell.t0)}`;
        const ww = T(fit(word, 11, c.w - 18), x + 16, base, wordC(cell.state), 11);
        prevEnd = x + 16 + ww;
        hit(kind, cell.id, x - 2, y, c.w + 4, rowH);
      }
    });
    say.rows = String(rowsL.length);
  }

  // what the pointer is over: its corners in grey; what is selected, wherever the floor shows
  // it (its berth, its result, its strip in the bin): its corners in white
  const corners = (h: { x: number; y: number; w: number; h: number }, c: string) => brackets(h.x - 3, h.y - 1, h.w + 6, h.h + 2, c);
  let selRect = '';
  if (o.sel) for (const h of hits) {
    if (h.id !== o.sel || h.kind === 'window' || h.kind === 'link' || h.y >= L.split) continue;
    corners(h, C.ink);
    selRect += `${h.x},${h.y},${h.w},${h.h};`;
  }
  if (o.hov && !selRect.includes(`${o.hov};`)) {
    const [hx, hy, hw, hh] = o.hov.split(',').map(Number);
    if (hw > 0 && hh > 0) corners({ x: hx, y: hy, w: hw, h: hh }, C.ink3);
  }

  // the key: every mark and word, in order (a scene that says the same thing paints nothing)
  let key = '';
  for (const op of ops) key += op.join('\u0001') + '\u0002';
  return { ops, hits, anchors, key, counts: { squares, texts }, say };
}
