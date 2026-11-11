// The Factory's floor, "square swarm" (ZERO.md "FACTORY REDO", Felipe's round-2 synthesis): the
// whole fleet as one flow of work, left to right: sources → intake → engines → tests → main lines
// → deploy → apps. Work is a swarm of small glowing SQUARE cubes running along one spine of
// right-angled lanes; it bunches where work queues and thins where it is fast. Every station is a
// block of squares and rectangles (no circles, no triangles, no rings), labelled with its big
// number just above it. Failed work drops out of the flow into the slag pit (the FAILED bin).
//
// Everything is drawn in one design space (D) that the floor fits to the window (floor.ts): a
// fixed camera, no pan, no zoom, no scroll. Hits are in design units; floor.ts maps them.

import type { Gfx } from '../yard/gfx.ts';
import { C } from '../yard/theme.ts';
import type { Item, Machine, Stages } from './stages.ts';

export type Hit = { kind: string; id: string; x: number; y: number; w: number; h: number; url?: string; label?: string };

export const WINDOWS: [string, number][] = [['10m', 600_000], ['30m', 1_800_000], ['1h', 3_600_000], ['2h', 7_200_000]];

/** The design space, and the box the camera frames (the stations, their labels, the pit's head). */
export const D = { x0: 0, y0: 58, x1: 1440, y1: 668 };

/** The spine's height: the line every station sits on. */
const Y = 300;
const SRC = { x: 28, s: 52, ys: [196, 300, 404] };
const IN = { x: 150, y: 224, cols: 6, rows: 6, cell: 22, gap: 4 };
const ENG = { x: 352, w: 404, plate: 66, pitch: 54, bay: 46, rows: [176, 300, 424], h: 108 };
const GATE = { x: 800, w: 52, y0: 228, y1: 372 };
const PIT = { x0: 640, x1: 1012, y0: 540, y1: 620 };
const YARD = { x0: 900, x1: 1138, y0: 152, row: 19, rows: 18 };
const PRESS = { x: 1172, w: 66, y0: 238, y1: 362 };
const SKY = { x0: 1272, x1: 1434, base: 478, top: 112 };

const AMBER = C.packet, GREEN = C.green, RED = C.red;
const BODY = '#161617', TOPB = '#1F1F21', SHADE = '#0A0A0B', WELL = '#0C0C0D', TRACK = '#141416';

export type SwarmOpts = {
  /** ms since the floor started (frozen at 0 under reduced motion) */
  t: number;
  window: string;
  selected: string;
  failed: Item[];
};

// ---- primitives (squares and rectangles only) -----------------------------------------------

/** A block: a body, a lighter top band (its lit top), a shadow under its front. */
function block(g: Gfx, x: number, y: number, w: number, h: number, body = BODY, top = TOPB): void {
  g.fillRect(x + 4, y + 5, w, h, SHADE);
  g.fillRect(x, y, w, h, body);
  g.fillRect(x, y, w, 3, top);
}

/** A glowing cube: emissive light around its own square (a blurred shadow, no halo panel), the
 *  core, its lit top edge. `glow` 0 draws it flat (the swarm's small ones glow with one faint
 *  square halo instead: a blur per cube would cost too much at 60 fps). */
function cube(g: Gfx, cx: number, cy: number, s: number, color: string, glow = 1): void {
  const h = s / 2;
  if (glow > 0 && s >= 12) {
    const c = g.ctx;
    c.shadowColor = color; c.shadowBlur = s * 0.9 * glow;
    g.fillRect(cx - h, cy - h, s, s, color);
    c.shadowBlur = 0; c.shadowColor = 'transparent';
  } else {
    if (glow > 0) { g.alpha(0.13 * glow); g.fillRect(cx - s, cy - s, s * 2, s * 2, color); g.alpha(1); }
    g.fillRect(cx - h, cy - h, s, s, color);
  }
  g.alpha(0.45); g.fillRect(cx - h, cy - h, s, Math.max(1, s * 0.22), '#FFFFFF'); g.alpha(1);
}

/** A selected thing: four corner brackets in ink (squares only). */
function brackets(g: Gfx, x: number, y: number, w: number, h: number): void {
  const k = Math.min(8, w / 3), t = 1.5;
  for (const [ax, ay, sx, sy] of [[x, y, 1, 1], [x + w, y, -1, 1], [x, y + h, 1, -1], [x + w, y + h, -1, -1]] as const) {
    g.fillRect(sx > 0 ? ax : ax - k, sy > 0 ? ay : ay - t, k, t, C.ink);
    g.fillRect(sx > 0 ? ax : ax - t, sy > 0 ? ay : ay - k, t, k, C.ink);
  }
}

/** A deterministic 0..1 per (string, k). */
function rnd(s: string, k = 0): number {
  let h = 2166136261 ^ k;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return ((h >>> 0) % 10007) / 10007;
}

// ---- the lanes: right-angled polylines the swarm runs along ------------------------------------

type Pt = readonly [number, number];
type Lane = { id: string; pts: Pt[]; len: number; segs: number[]; rate: number; color: string; speed: number; bunch: number; fall?: boolean };

function lane(id: string, pts: Pt[], rate: number, color: string, speed = 74, bunch = 1, fall = false): Lane {
  const segs: number[] = [];
  let len = 0;
  for (let i = 1; i < pts.length; i++) { const d = Math.abs(pts[i][0] - pts[i - 1][0]) + Math.abs(pts[i][1] - pts[i - 1][1]); segs.push(d); len += d; }
  return { id, pts, len, segs, rate, color, speed, bunch, fall };
}

function at(l: Lane, p: number): [number, number, number, number] {
  let d = p * l.len;
  for (let i = 0; i < l.segs.length; i++) {
    const s = l.segs[i];
    if (d <= s || i === l.segs.length - 1) {
      const [x0, y0] = l.pts[i], [x1, y1] = l.pts[i + 1];
      const f = s ? Math.min(1, d / s) : 0;
      return [x0 + (x1 - x0) * f, y0 + (y1 - y0) * f, Math.sign(x1 - x0), Math.sign(y1 - y0)];
    }
    d -= s;
  }
  const e = l.pts[l.pts.length - 1];
  return [e[0], e[1], 1, 0];
}

const yardRowY = (i: number): number => YARD.y0 + i * YARD.row + YARD.row / 2;

function lanes(S: Stages): Lane[] {
  const out: Lane[] = [];
  const feed = [S.sources.push, S.sources.pr, S.sources.cron + S.sources.other];
  const bunch = 1 + Math.min(2.2, S.intake.waiting / 4);
  SRC.ys.forEach((ey, k) => out.push(lane(`src${k}`, [[SRC.x + SRC.s, ey], [118, ey], [118, Y], [IN.x - 2, Y]], feed[k], AMBER, 70, bunch)));
  // intake → each engine, by its share of the running work
  const busy = S.engines.machines.slice(0, 3).map((m) => m.busy);
  const tot = busy.reduce((a, b) => a + b, 0) || 1;
  ENG.rows.forEach((ry, r) => {
    const share = (busy[r] ?? 0) / tot;
    out.push(lane(`in${r}`, [[IN.x + 156, Y], [328, Y], [328, ry], [ENG.x - 2, ry]], S.flow.engines * share, AMBER, 76));
    out.push(lane(`out${r}`, [[ENG.x + ENG.w + 2, ry], [778, ry], [778, Y], [GATE.x - 2, Y]], S.flow.tests * share, AMBER, 80));
  });
  // past the gate: passed work (green) into the main-line yard, three rows at a time
  const passed = Math.max(0, S.flow.mains);
  [0, 5, 11].forEach((row, k) => out.push(lane(`yard${k}`, [[GATE.x + GATE.w + 2, Y], [882, Y], [882, yardRowY(row)], [YARD.x0 - 2, yardRowY(row)]], passed / 3, GREEN, 72)));
  out.push(lane('press', [[YARD.x1 + 2, yardRowY(5)], [1154, yardRowY(5)], [1154, Y], [PRESS.x - 2, Y]], S.flow.deploy, GREEN, 66));
  out.push(lane('apps', [[PRESS.x + PRESS.w + 2, Y], [1256, Y], [1256, SKY.base + 12], [SKY.x0 + 30, SKY.base + 12]], S.flow.deploy, GREEN, 66));
  // the reject chute: failures fall straight down into the slag pit
  out.push(lane('chute', [[GATE.x + GATE.w / 2, GATE.y1 + 4], [GATE.x + GATE.w / 2, PIT.y0 - 6]], S.tests.failed, RED, 120, 1, true));
  return out;
}

function drawLanes(g: Gfx, ls: Lane[]): void {
  for (const l of ls) {
    const w = l.fall ? 12 : 10;
    for (let i = 1; i < l.pts.length; i++) {
      const [x0, y0] = l.pts[i - 1], [x1, y1] = l.pts[i];
      g.fillRect(Math.min(x0, x1) - w / 2, Math.min(y0, y1) - w / 2, Math.abs(x1 - x0) + w, Math.abs(y1 - y0) + w, TRACK);
    }
  }
}

/** The swarm: per lane, cubes in proportion to its hourly rate, each at a stable offset. */
function drawSwarm(g: Gfx, ls: Lane[], t: number): number {
  let n = 0;
  for (const l of ls) {
    if (l.rate <= 0) continue;
    const count = Math.max(2, Math.min(18, Math.round(l.rate / 2.5)));
    for (let i = 0; i < count; i++) {
      const j = rnd(l.id, i);
      let p = ((t / 1000) * l.speed / l.len + i / count + j * 0.4 / count) % 1;
      if (l.bunch > 1) p = 1 - Math.pow(1 - p, l.bunch); // slows toward the end: a queue
      if (l.fall) p = p * p; // gravity
      const [x, y, dx, dy] = at(l, p);
      const off = (j - 0.5) * 5;
      const cx = x + (dy ? off : 0), cy = y + (dx ? off : 0);
      const s = 3.5 + j * 2.5;
      // its trail: a fading rectangle behind it, along its lane
      const tl = 9 + s;
      g.alpha(0.2);
      if (dx) g.fillRect(dx > 0 ? cx - tl : cx, cy - s / 4, tl, s / 2, l.color);
      else g.fillRect(cx - s / 4, dy > 0 ? cy - tl : cy, s / 2, tl, l.color);
      g.alpha(1);
      cube(g, cx, cy, s, l.color, 0.8);
      n++;
    }
  }
  return n;
}

// ---- the stations -----------------------------------------------------------------------------

function drawSources(g: Gfx, S: Stages, t: number): void {
  const kinds: [string, number][] = [['push', S.sources.push], ['pr', S.sources.pr], ['cron', S.sources.cron + S.sources.other]];
  SRC.ys.forEach((ey, k) => {
    const x = SRC.x, y = ey - SRC.s / 2;
    block(g, x, y, SRC.s, SRC.s);
    // the mouth: a lit slot on its right face that flashes as it emits
    const [, rate] = kinds[k];
    const beat = rate > 0 ? 0.5 + 0.5 * Math.max(0, Math.sin((t / 1000) * (0.6 + rate / 20) * Math.PI + k)) : 0;
    g.fillRect(x + SRC.s - 12, ey - 9, 8, 18, WELL);
    if (rate > 0) { g.alpha(0.35 + 0.6 * beat); g.fillRect(x + SRC.s - 10, ey - 7, 4, 14, AMBER); g.alpha(1); }
    g.text(kinds[k][0], x + 8, ey + 4, C.ink2, 11, true);
    g.text(`${rate}/h`, x + 8, ey + 17, C.ink3, 10);
  });
}

function drawIntake(g: Gfx, S: Stages, o: SwarmOpts, hits: Hit[], now: number): void {
  const w = IN.cols * (IN.cell + IN.gap) - IN.gap, h = IN.rows * (IN.cell + IN.gap) - IN.gap;
  block(g, IN.x - 6, IN.y - 6, w + 12, h + 12);
  const items = S.intake.items;
  const cap = IN.cols * IN.rows;
  for (let i = 0; i < cap; i++) {
    const c = i % IN.cols, r = Math.floor(i / IN.cols);
    const x = IN.x + c * (IN.cell + IN.gap), y = IN.y + r * (IN.cell + IN.gap);
    g.fillRect(x, y, IN.cell, IN.cell, WELL);
    const it = items[i];
    if (!it) continue;
    if (i === cap - 1 && items.length > cap) { g.text(`+${items.length - cap + 1}`, x + IN.cell / 2, y + 15, C.amberText, 10, true, 'center'); continue; }
    const stuck = now - it.at > 3_600_000;
    cube(g, x + IN.cell / 2, y + IN.cell / 2, 14, stuck ? RED : C.packetDock, 0.6);
    if (o.selected === it.id) brackets(g, x - 2, y - 2, IN.cell + 4, IN.cell + 4);
    hits.push({ kind: 'wait', id: it.id, x, y, w: IN.cell, h: IN.cell, url: it.url, label: `${it.name} #${it.number}` });
  }
}

function drawEngines(g: Gfx, S: Stages, o: SwarmOpts, hits: Hit[]): void {
  const ms = S.engines.machines.slice(0, 3);
  ENG.rows.forEach((ry, r) => {
    const m: Machine | undefined = ms[r];
    const x = ENG.x, y = ry - ENG.h / 2;
    block(g, x, y, ENG.w, ENG.h);
    if (!m) return;
    // the name plate: the machine, busy of slots
    const name = m.label === 'github actions' ? 'gha' : m.label;
    g.text(name, x + 10, ry - 4, m.online ? C.ink : C.ink3, 12, true);
    g.text(m.online ? `${m.busy}/${m.slots || m.bays.length}` : 'offline', x + 10, ry + 12, C.ink3, 10.5);
    if (m.url) hits.push({ kind: 'machine', id: m.id, x, y, w: ENG.plate - 4, h: ENG.h, url: m.url, label: m.label });
    m.bays.slice(0, 6).forEach((b, i) => {
      const bx = x + ENG.plate + i * ENG.pitch, by = ry - 32;
      g.fillRect(bx, by, ENG.bay, ENG.bay, WELL);
      if (!b.item) return;
      const it = b.item;
      cube(g, bx + ENG.bay / 2, by + ENG.bay / 2, 22, AMBER, 1);
      // its progress under the bay, its repo under that
      g.fillRect(bx, by + ENG.bay + 4, ENG.bay, 3, '#232325');
      if (it.pct > 0) g.fillRect(bx, by + ENG.bay + 4, ENG.bay * it.pct, 3, AMBER);
      g.text(g.fit(it.name, 9.5, ENG.pitch - 4), bx, by + ENG.bay + 18, C.ink2, 9.5);
      if (o.selected === it.id) brackets(g, bx - 3, by - 3, ENG.bay + 6, ENG.bay + 6);
      hits.push({ kind: 'run', id: it.id, x: bx, y: by, w: ENG.bay, h: ENG.bay + 20, url: it.url, label: `${it.name} #${it.number}` });
    });
  });
}

function drawGate(g: Gfx, S: Stages, t: number): void {
  const { x, w, y0, y1 } = GATE;
  block(g, x, y0, 10, y1 - y0);
  block(g, x + w - 10, y0, 10, y1 - y0);
  block(g, x - 4, y0 - 12, w + 8, 12);
  // the light curtain: thin vertical beams that sweep
  const n = 7;
  for (let i = 0; i < n; i++) {
    const bx = x + 13 + i * ((w - 26) / (n - 1));
    const a = 0.12 + 0.18 * Math.max(0, Math.sin(t / 260 - i * 0.7));
    g.alpha(a); g.fillRect(bx - 0.5, y0 + 2, 1, y1 - y0 - 4, '#F2E6CC'); g.alpha(1);
  }
  void S;
}

function drawPit(g: Gfx, o: SwarmOpts, hits: Hit[], t: number): void {
  const { x0, x1, y0, y1 } = PIT;
  // the pit: walls of blocks, a floor glowing like slag
  block(g, x0 - 10, y0 - 6, 10, y1 - y0 + 16);
  block(g, x1, y0 - 6, 10, y1 - y0 + 16);
  g.fillRect(x0, y0, x1 - x0, y1 - y0, '#100B0B');
  const f = o.failed;
  const heat = f.length ? 1 : 0.35;
  for (let i = 0; i < 4; i++) { g.alpha((0.05 + 0.03 * Math.sin(t / 700 + i)) * heat); g.fillRect(x0, y1 - 10 - i * 14, x1 - x0, 10 + i * 14, RED); }
  g.alpha(1);
  g.fillRect(x0 - 10, y1, x1 - x0 + 20, 6, '#1A1314');
  const pitch = 34, perRow = Math.floor((x1 - x0 - 16) / pitch);
  const rows = 2;
  f.slice(0, perRow * rows).forEach((it, i) => {
    const c = i % perRow, r = Math.floor(i / perRow);
    const cx = x0 + 22 + c * pitch, cy = y1 - 22 - r * 30;
    cube(g, cx, cy, 22, RED, 1);
    if (o.selected === it.id) brackets(g, cx - 15, cy - 15, 30, 30);
    hits.push({ kind: 'failed', id: it.id, x: cx - 15, y: cy - 15, w: 30, h: 30, url: it.url, label: `${it.name} #${it.number}` });
  });
  if (f.length > perRow * rows) g.text(`+${f.length - perRow * rows}`, x1 - 8, y0 + 16, C.redText, 11, true, 'right');
  // its head under it: "failed · last 30m · N" and the window chips
  const yb = y1 + 28;
  let x = x0;
  x += g.text('failed', x, yb, C.ink, 13, true);
  x += g.text(` · last ${o.window} · `, x, yb, C.ink3, 11.5);
  x += g.text(`${f.length}`, x, yb, f.length ? C.redText : C.ink3, 11.5) + 14;
  for (const [w] of WINDOWS) {
    const on = w === o.window;
    const cw = Math.ceil(g.width(w, 11)) + 12, ch = 18;
    g.begin_(); g.rect(x + 0.5, yb - 13 + 0.5, cw - 1, ch - 1);
    if (!on) g.dash(true, 3, 2.5);
    g.stroke(on ? '#9A9A9C' : C.chipEdge, 1);
    if (!on) g.dash(false);
    g.text(w, x + 6, yb + 0.5, on ? C.ink : C.chipInk, 11);
    hits.push({ kind: 'window', id: w, x, y: yb - 13, w: cw, h: ch, label: `failed in the last ${w}` });
    x += cw + 4;
  }
}

function drawYard(g: Gfx, S: Stages, hits: Hit[]): void {
  block(g, YARD.x0 - 8, YARD.y0 - 8, YARD.x1 - YARD.x0 + 16, YARD.rows * YARD.row + 16);
  const reds = S.mains.red.slice(0, YARD.rows);
  for (let i = 0; i < YARD.rows; i++) {
    const y = yardRowY(i);
    const r = reds[i];
    g.fillRect(YARD.x0 + 100, y - 0.5, YARD.x1 - YARD.x0 - 104, 1, '#232325');
    if (!r) continue;
    g.text(g.fit(r.name, 10.5, 94), YARD.x0, y + 4, C.redText, 10.5);
    cube(g, YARD.x1 - 10, y, 9, RED, 0.8);
    hits.push({ kind: 'main', id: r.repo, x: YARD.x0, y: y - YARD.row / 2, w: YARD.x1 - YARD.x0, h: YARD.row, url: r.url, label: r.name });
  }
  const more = S.mains.red.length - reds.length;
  const yb = YARD.y0 + YARD.rows * YARD.row + 22;
  g.text(more > 0 ? `+${more} red · ${S.mains.green} green` : `${S.mains.green} green`, YARD.x0, yb, more > 0 ? C.redText : C.greenInk, 10.5);
}

function drawPress(g: Gfx, S: Stages, t: number): void {
  const { x, w, y0, y1 } = PRESS;
  block(g, x, y0, w, y1 - y0);
  const run = S.deploy.running.length > 0;
  // the ram: a block that strokes down while deploys run
  const k = run ? 0.5 - 0.5 * Math.cos((t / 900) * Math.PI) : 0;
  g.fillRect(x + 10, y0 + 10, w - 20, 22 + k * 30, '#2A2A2C');
  g.fillRect(x + 8, Y + 14, w - 16, 10, '#2A2A2C');
  if (run) cube(g, x + w / 2, Y + 4, 14, AMBER, 1);
}

const APITCH = 8;
function appsTop(S: Stages): number {
  const cols = Math.floor((SKY.x1 - SKY.x0) / APITCH);
  return SKY.base - Math.ceil(S.apps.cells.length / cols) * APITCH - 8;
}
function drawApps(g: Gfx, S: Stages, hits: Hit[]): void {
  const cells = S.apps.cells;
  const pitch = APITCH, cols = Math.floor((SKY.x1 - SKY.x0) / pitch);
  const rows = Math.ceil(cells.length / cols);
  const y0 = SKY.base - rows * pitch;
  block(g, SKY.x0 - 6, y0 - 8, SKY.x1 - SKY.x0 + 12, rows * pitch + 14, '#131314');
  cells.forEach((c, i) => {
    const x = SKY.x0 + (i % cols) * pitch, y = y0 + Math.floor(i / cols) * pitch;
    const col = c.health === 'up' ? '#B8D9C0' : c.health === 'down' ? RED : c.health === 'degraded' ? AMBER : '#2A2A2C';
    g.alpha(c.health === 'up' ? 0.75 : 1); g.fillRect(x, y, 5, 5, col); g.alpha(1);
    if (c.health === 'down' || c.health === 'degraded') hits.push({ kind: 'app', id: c.id, x: x - 2, y: y - 2, w: 9, h: 9, url: c.statusUrl || c.url, label: c.id });
  });
}

// ---- the labels -------------------------------------------------------------------------------

function ago(ms: number): string {
  const m = Math.round(ms / 60_000);
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h`;
}

/** Each station's label just above it: the name, the big number, its unit. (x centre, y top). */
export function drawHeads(g: Gfx, S: Stages, now: number): void {
  const at: [string, number, number, string, string, string][] = [
    ['sources', SRC.x + SRC.s / 2 + 18, SRC.ys[0] - SRC.s / 2, `${S.sources.perHour}`, '/h', C.ink],
    ['intake', IN.x + 76, IN.y - 6, `${S.intake.waiting}`, S.intake.waiting ? `waiting · ${ago(now - S.intake.oldestAt)}` : 'waiting', S.intake.waiting ? AMBER : C.ink3],
    ['engines', ENG.x + ENG.w / 2, ENG.rows[0] - ENG.h / 2, `${S.engines.running}`, `of ${S.engines.slots} busy`, S.engines.running ? AMBER : C.ink3],
    ['tests', GATE.x + GATE.w / 2, GATE.y0 - 12, `${Math.round(S.tests.passRate * 100)}%`, 'pass', S.tests.passRate >= 0.85 ? C.greenInk : C.amberText],
    ['main lines', (YARD.x0 + YARD.x1) / 2, YARD.y0 - 8, `${S.mains.red.length}`, `red · ${S.mains.green} green`, S.mains.red.length ? C.redText : C.greenInk],
    ['deploy', PRESS.x + PRESS.w / 2, PRESS.y0, `${S.deploy.running.length}`, 'now', S.deploy.running.length ? AMBER : C.ink3],
    ['apps', (SKY.x0 + SKY.x1) / 2, appsTop(S) - 8, S.apps.down.length ? `${S.apps.down.length}` : `${S.apps.up}`, S.apps.down.length ? 'down' : `of ${S.apps.total} up`, S.apps.down.length ? C.redText : C.greenInk],
  ];
  for (const [name, x, top, n, unit0, col] of at) {
    const unit = ` ${unit0}`;
    const wn = g.width(n, 22, true), wu = g.width(unit, 11.5);
    const y = top - 12;
    g.text(name, x, y - 26, C.ink, 13, true, 'center');
    g.text(n, x - (wn + wu) / 2, y, col, 22, true);
    g.text(unit, x - (wn + wu) / 2 + wn, y, C.ink3, 11.5);
  }
}

// ---- the floor --------------------------------------------------------------------------------

/** Draws the whole floor in design units; returns its hits (design units) and the swarm's size. */
export function drawSwarmFloor(g: Gfx, S: Stages, now: number, o: SwarmOpts): { hits: Hit[]; cubes: number } {
  const hits: Hit[] = [];
  const ls = lanes(S);
  drawLanes(g, ls);
  drawSources(g, S, o.t);
  drawIntake(g, S, o, hits, now);
  drawEngines(g, S, o, hits);
  drawGate(g, S, o.t);
  drawYard(g, S, hits);
  drawPress(g, S, o.t);
  drawApps(g, S, hits);
  drawPit(g, o, hits, o.t);
  const cubes = drawSwarm(g, ls, o.t);
  drawHeads(g, S, now);
  return { hits, cubes };
}
