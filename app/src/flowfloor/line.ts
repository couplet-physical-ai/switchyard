// Concept A, "the line" (ZERO.md "FACTORY REDO"): one belt through seven stations, left → right,
// work as crates. Sources feed the intake pad (the queue, oldest at its exit), the belt fans out
// to the engines (one machine per host, its slots as bays, a crate per run with its progress on
// the machine's front), merges through the test gate, crosses the main-line board (every repo a
// tile, red ones raised), the deploy press and into the apps (every app a block, its health on
// its top). What fails drops off the line into the FAILED bin along the front, newest first.
// No lanes by team; colour only on state (amber moves, red broke, green-grey fine).

import type { Gfx } from '../yard/gfx.ts';
import { C } from '../yard/theme.ts';
import { Cam, P, box, crate, poly, quad, type Tone } from './iso.ts';
import type { Item, Stages } from './stages.ts';

export type Hit = { kind: string; id: string; x: number; y: number; w: number; h: number; url?: string; label?: string };

/** The stations along u (centres) and the floor box. */
export const L = {
  u0: -10, u1: 1620, v0: 40, v1: 470,
  belt: 200, beltW: 26,
  src: { u0: 15, u1: 95, rows: [115, 200, 285] },
  intake: { u0: 190, u1: 330, v0: 130, v1: 270 },
  eng: { u0: 410, u1: 690, rows: [84, 200, 316], dv: 62, h: 16 },
  gate: { u: 800, v0: 138, v1: 262, h: 58 },
  mains: { u0: 915, u1: 1140, v0: 104, v1: 296 },
  deploy: { u0: 1215, u1: 1295, v0: 150, v1: 250, h: 34 },
  apps: { u0: 1365, u1: 1610, v0: 104, v1: 296 },
  bin: { u0: 720, u1: 1100, v0: 372, v1: 466 },
};

export const STATIONS: { id: string; name: string; u: number }[] = [
  { id: 'sources', name: 'sources', u: 55 },
  { id: 'intake', name: 'intake', u: 260 },
  { id: 'engines', name: 'engines', u: 550 },
  { id: 'tests', name: 'tests', u: 805 },
  { id: 'mains', name: 'main lines', u: 1028 },
  { id: 'deploy', name: 'deploy', u: 1255 },
  { id: 'apps', name: 'apps', u: 1488 },
];

const T = { head: 13, cap: 11.5, small: 10.5 };

function ago(ms: number): string {
  if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1000))}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h`;
  return `${Math.floor(ms / 86_400_000)}d`;
}

/** A belt strip from (ua, va) to (ub, vb), width w, its slats offset by `phase` (0..1). */
function belt(cam: Cam, g: Gfx, ua: number, va: number, ub: number, vb: number, w: number, phase: number): void {
  const du = ub - ua, dv = vb - va, len = Math.hypot(du, dv) || 1;
  const nu = (-dv / len) * (w / 2), nv = (du / len) * (w / 2);
  g.begin_(); poly(cam, g, [ua + nu, va + nv, 0.4, ub + nu, vb + nv, 0.4, ub - nu, vb - nv, 0.4, ua - nu, va - nv, 0.4]); g.fill(P.belt);
  g.begin_();
  g.move(cam.x(ua + nu, va + nv), cam.y(ua + nu, va + nv, 0.4)); g.line(cam.x(ub + nu, vb + nv), cam.y(ub + nu, vb + nv, 0.4));
  g.move(cam.x(ua - nu, va - nv), cam.y(ua - nu, va - nv, 0.4)); g.line(cam.x(ub - nu, vb - nv), cam.y(ub - nu, vb - nv, 0.4));
  g.stroke(P.beltEdge, 1);
  const step = 14, n = Math.floor(len / step);
  g.begin_();
  for (let i = 0; i < n; i++) {
    const t = (i + phase) * step / len;
    if (t > 1) break;
    const u = ua + du * t, v = va + dv * t;
    g.move(cam.x(u + nu * 0.8, v + nv * 0.8), cam.y(u + nu * 0.8, v + nv * 0.8, 0.5)); g.line(cam.x(u - nu * 0.8, v - nv * 0.8), cam.y(u - nu * 0.8, v - nv * 0.8, 0.5));
  }
  g.stroke(P.slat, 1);
}

/** Crates riding a belt: k of them, evenly, offset by `phase`. */
function riders(cam: Cam, g: Gfx, ua: number, va: number, ub: number, vb: number, k: number, phase: number): void {
  for (let i = 0; i < k; i++) {
    const t = ((i + phase) / k) % 1;
    crate(cam, g, ua + (ub - ua) * t, va + (vb - va) * t, 11, 'run', 0.5);
  }
}

export type LineOpts = { phase: number; window: string; windowMs: number; selected: string; failed: Item[] };

/** The static floor and the stations (everything but the motion). Returns the hit boxes. */
export function drawLine(g: Gfx, cam: Cam, S: Stages, now: number, o: LineOpts): Hit[] {
  const hits: Hit[] = [];
  const ph = o.phase;
  // ---- the floor
  g.begin_(); quad(cam, g, L.u0, L.v0, L.u1, L.v1, 0); g.fill(P.floor);
  g.begin_();
  for (let u = 0; u <= L.u1; u += 40) { g.move(cam.x(u, L.v0), cam.y(u, L.v0)); g.line(cam.x(u, L.v1), cam.y(u, L.v1)); }
  for (let v = L.v0; v <= L.v1; v += 40) { g.move(cam.x(L.u0, v), cam.y(L.u0, v)); g.line(cam.x(L.u1, v), cam.y(L.u1, v)); }
  g.stroke(P.grid, 1);
  g.begin_(); quad(cam, g, L.u0, L.v0, L.u1, L.v1, 0); g.stroke(P.floorEdge, 1);

  // ---- belts (back to front so machines overlap them)
  const B = L.belt, W = L.beltW;
  for (const r of L.src.rows) belt(cam, g, L.src.u1, r, 150, B, 18, ph);
  belt(cam, g, 150, B, L.intake.u0, B, W, ph);
  for (const r of L.eng.rows) { belt(cam, g, L.intake.u1, B, 370, B, W, ph); belt(cam, g, 370, B, L.eng.u0, r, 20, ph); }
  for (const r of L.eng.rows) { belt(cam, g, L.eng.u1, r, 730, B, 20, ph); }
  belt(cam, g, 730, B, L.mains.u0, B, W, ph);
  belt(cam, g, L.mains.u1, B, L.deploy.u0, B, W, ph);
  belt(cam, g, L.deploy.u1, B, L.apps.u0, B, W, ph);
  // the drop chutes: tests → bin, deploy → bin
  chute(cam, g, L.gate.u + 4, L.gate.v1 + 4, L.bin.v0 + 4);
  chute(cam, g, (L.deploy.u0 + L.deploy.u1) / 2, L.deploy.v1 + 4, L.bin.v0 + 4);

  // ---- 1 sources: three inlets (push, pr, cron + the rest)
  const src = S.sources;
  const words: [string, number][] = [['push', src.push], ['pr', src.pr], ['cron', src.cron + src.other]];
  L.src.rows.forEach((r, i) => {
    box(cam, g, L.src.u0, r - 22, L.src.u1 - L.src.u0, 44, 14);
    // the mouth, lit while something arrived in the last 10 minutes of this kind
    const hot = src.arrivals.some((a) => (i === 0 ? a.kind === 'push' : i === 1 ? a.kind === 'pr' : a.kind !== 'push' && a.kind !== 'pr'));
    g.begin_(); quad(cam, g, L.src.u1 - 18, r - 12, L.src.u1 - 4, r + 12, 14.2); g.fill(hot ? P.waitTop : P.well);
    const x = cam.x(L.src.u0, r) - 8, y = cam.y(L.src.u0, r, 7) + 4;
    const tail = ` ${words[i][1]}/h`;
    const wt = g.width(tail, T.small);
    g.text(words[i][0], x - wt, y, C.ink3, T.small, false, 'right');
    g.text(tail, x - wt, y, C.ink2, T.small);
  });
  riders(cam, g, 150, B, L.intake.u0, B, Math.min(3, Math.max(1, Math.round(S.flow.intake / 30))), ph);

  // ---- 2 intake: the queue on a pad, oldest at the exit (right)
  const I = L.intake;
  box(cam, g, I.u0, I.v0, I.u1 - I.u0, I.v1 - I.v0, 3);
  const q = S.intake.items;
  const per = 5, pitch = 24;
  q.slice(0, 30).forEach((it, i) => {
    const col = Math.floor(i / per), row = i % per;
    const stuck = now - it.at > 3_600_000;
    const u = I.u1 - 18 - col * pitch, v = I.v0 + 22 + row * pitch;
    crate(cam, g, u, v, 16, stuck ? 'fail' : 'wait', 3);
    if (o.selected === it.id) selRing(cam, g, u, v, 16, 3);
    hits.push({ kind: 'wait', id: it.id, x: cam.x(u, v) - 10, y: cam.y(u, v, 14) - 10, w: 20, h: 20, url: it.url, label: `${it.name} #${it.number}` });
  });

  // ---- 3 engines: one machine per host, its slots as bays
  const E = L.eng;
  S.engines.machines.slice(0, 3).forEach((m, mi) => {
    const c = E.rows[mi], v0 = c - E.dv / 2, v1 = c + E.dv / 2;
    box(cam, g, E.u0, v0, E.u1 - E.u0, E.dv, E.h, 0, P.top, P.side, P.front, m.online ? P.edge : '#2A2A2D');
    const n = Math.max(1, m.bays.length);
    const pitchU = (E.u1 - E.u0 - 24) / n, bw = Math.min(34, pitchU - 8);
    m.bays.forEach((b, i) => {
      const uc = E.u0 + 12 + pitchU * (i + 0.5);
      g.begin_(); quad(cam, g, uc - bw / 2, c - 19, uc + bw / 2, c + 19, E.h + 0.2); g.fill(P.well);
      g.begin_(); quad(cam, g, uc - bw / 2, c - 19, uc + bw / 2, c + 19, E.h + 0.2); g.stroke(m.online ? '#2E2E32' : '#222225', 1);
      if (b.item) {
        crate(cam, g, uc, c, Math.min(22, bw - 6), 'run', E.h);
        if (o.selected === b.item.id) selRing(cam, g, uc, c, Math.min(22, bw - 6), E.h);
        // its progress on the machine's front: a track and the elapsed share of the usual
        const pct = b.item.pct;
        const ua = uc - bw / 2, ub = uc + bw / 2;
        g.begin_(); quad(cam, g, ua, c + 22, ub, c + 26, E.h + 0.3); g.fill('#1E1E21');
        if (pct > 0) { g.begin_(); quad(cam, g, ua, c + 22, ua + (ub - ua) * pct, c + 26, E.h + 0.4); g.fill(pct > 0.97 ? C.amberText : C.packet); }
        const bx = cam.x(uc, c), by = cam.y(uc, c, E.h + 14);
        hits.push({ kind: 'run', id: b.item.id, x: bx - 14, y: by - 14, w: 28, h: 28, url: b.item.url, label: `${b.item.name} #${b.item.number}` });
      }
    });
  });
  // the machines' names, left of each, after all of them (a nearer machine never covers one)
  S.engines.machines.slice(0, 3).forEach((m, mi) => {
    const c = E.rows[mi];
    const x = cam.x(E.u0, c) - 10, y = cam.y(E.u0, c, E.h * 0.5) + 4;
    const tail = m.online ? ` ${m.busy}${m.slots ? `/${m.slots}` : ''}` : ' offline';
    const w2 = g.width(tail, T.small);
    const w1 = g.text(m.label, x - w2, y, m.online ? C.ink2 : C.ink3, T.small, true, 'right');
    g.text(tail, x - w2, y, C.ink3, T.small);
    if (m.url) hits.push({ kind: 'machine', id: m.id, x: x - w2 - w1 - 4, y: y - 12, w: w1 + w2 + 8, h: 16, url: m.url, label: m.label });
  });

  // ---- 4 tests: the gate over the belt (two posts and a beam), its pass light
  const G = L.gate;
  const rate = S.tests.passRate;
  box(cam, g, G.u - 6, G.v0 - 10, 12, 10, G.h);
  box(cam, g, G.u - 6, G.v1, 12, 10, G.h);
  box(cam, g, G.u - 8, G.v0 - 10, 16, G.v1 - G.v0 + 20, 8, G.h);
  g.begin_(); poly(cam, g, [G.u + 8, G.v0, G.h - 1, G.u + 8, G.v1, G.h - 1, G.u + 8, G.v1, G.h - 3, G.u + 8, G.v0, G.h - 3]); g.fill(rate >= 0.85 ? C.up : rate >= 0.7 ? C.packetDim : C.red);

  // ---- 5 main lines: every repo a tile; red ones raised at the front, taller the longer red
  const M = L.mains;
  box(cam, g, M.u0, M.v0, M.u1 - M.u0, M.v1 - M.v0, 3);
  const N = Math.max(1, S.mains.total);
  const cols = Math.max(8, Math.round(Math.sqrt(N * (M.u1 - M.u0) / (M.v1 - M.v0))));
  const rows = Math.ceil(N / cols);
  const pu = (M.u1 - M.u0 - 12) / cols, pv = (M.v1 - M.v0 - 12) / rows;
  const t = Math.min(pu, pv) * 0.72;
  g.begin_();
  const greens = S.mains.green;
  for (let k = 0; k < greens; k++) {
    const i = k % cols, j = Math.floor(k / cols);
    const u = M.u0 + 6 + pu * (i + 0.5), v = M.v0 + 6 + pv * (j + 0.5);
    quad(cam, g, u - t / 2, v - t / 2, u + t / 2, v + t / 2, 3.2);
  }
  g.fill('#2F3B33');
  // the red ones fill the board's last slots (front-right): oldest red first
  S.mains.red.forEach((r, k) => {
    const idx = greens + k, i = idx % cols, j = Math.floor(idx / cols);
    const u = M.u0 + 6 + pu * (i + 0.5), v = M.v0 + 6 + pv * (j + 0.5);
    const hrs = Math.max(0.1, (now - r.since) / 3_600_000);
    const h = 6 + 22 * Math.min(1, Math.log(1 + hrs) / Math.log(1 + 72));
    box(cam, g, u - t / 2, v - t / 2, t, t, h, 3, P.redTop, P.redSide, P.redFront, null);
    hits.push({ kind: 'main', id: r.repo, x: cam.x(u, v) - 8, y: cam.y(u, v, h + 3) - 8, w: 16, h: 16 + h * cam.s, url: r.url, label: r.name });
  });

  // ---- 6 deploy: the press, deploys waiting at its mouth
  const D = L.deploy;
  box(cam, g, D.u0, D.v0, D.u1 - D.u0, D.v1 - D.v0, D.h);
  box(cam, g, D.u0 + 22, D.v0 + 22, D.u1 - D.u0 - 44, D.v1 - D.v0 - 44, 10, D.h, P.topHi);
  S.deploy.running.slice(0, 4).forEach((it, i) => crate(cam, g, D.u0 - 14 - i * 16, B - 6 + (i % 2) * 12, 12, it.state === 'run' ? 'run' : 'wait', 0.5));

  // ---- 7 apps: every app a block, its health on top (down: raised, red)
  const A = L.apps;
  box(cam, g, A.u0, A.v0, A.u1 - A.u0, A.v1 - A.v0, 3);
  const NA = Math.max(1, S.apps.cells.length);
  const ac = Math.max(8, Math.round(Math.sqrt(NA * (A.u1 - A.u0) / (A.v1 - A.v0))));
  const ar = Math.ceil(NA / ac);
  const qu = (A.u1 - A.u0 - 12) / ac, qv = (A.v1 - A.v0 - 12) / ar;
  const at = Math.min(qu, qv) * 0.7;
  const cells = [...S.apps.cells].sort((a, b) => (a.health === 'up' ? 0 : 1) - (b.health === 'up' ? 0 : 1));
  cells.forEach((cell, k) => {
    const i = k % ac, j = Math.floor(k / ac);
    const u = A.u0 + 6 + qu * (i + 0.5), v = A.v0 + 6 + qv * (j + 0.5);
    const down = cell.health === 'down' || cell.health === 'degraded';
    const tone: Tone = down ? 'fail' : cell.health === 'up' ? 'ok' : 'grey';
    const h = down ? 18 : 5 + ((k * 7919) % 5);
    box(cam, g, u - at / 2, v - at / 2, at, at, h, 3, tone === 'ok' ? '#3E5244' : tone === 'fail' ? P.redTop : P.greyTop, '#1A1D1B', '#151716', null);
    if (down) hits.push({ kind: 'app', id: cell.id, x: cam.x(u, v) - 8, y: cam.y(u, v, h + 3) - 8, w: 16, h: 16, url: cell.url, label: cell.id });
  });

  // ---- the FAILED bin along the front: newest first, left to right
  hits.push(...drawBin(g, cam, now, o));
  return hits;
}

/** The selection: an ink ellipse on the floor around a crate. */
function selRing(cam: Cam, g: Gfx, u: number, v: number, d: number, z: number): void {
  g.begin_(); g.ctx.ellipse(cam.x(u, v), cam.y(u, v, z), d * cam.s * 0.9 + 3, (d * cam.s * 0.9 + 3) * 0.6, 0, 0, Math.PI * 2); g.stroke(C.ink, 1.5);
}

function chute(cam: Cam, g: Gfx, u: number, va: number, vb: number): void {
  g.begin_(); poly(cam, g, [u - 10, va, 0.3, u + 10, va, 0.3, u + 10, vb, 0.3, u - 10, vb, 0.3]); g.fill('#101011');
  g.begin_();
  for (let v = va + 10; v < vb - 6; v += 16) { g.move(cam.x(u - 6, v), cam.y(u - 6, v, 0.4)); g.line(cam.x(u, v + 6), cam.y(u, v + 6, 0.4)); g.line(cam.x(u + 6, v), cam.y(u + 6, v, 0.4)); }
  g.stroke('#3A2A2B', 1);
}

export const WINDOWS: [string, number][] = [['10m', 600_000], ['30m', 1_800_000], ['1h', 3_600_000], ['2h', 7_200_000]];

export function drawBin(g: Gfx, cam: Cam, now: number, o: LineOpts, Bn: { u0: number; u1: number; v0: number; v1: number } = L.bin): Hit[] {
  const hits: Hit[] = [];
  void now;
  // a low tray: its floor, a back lip and a front wall
  g.begin_(); quad(cam, g, Bn.u0, Bn.v0, Bn.u1, Bn.v1, 0.3); g.fill('#0F0F10');
  box(cam, g, Bn.u0 - 4, Bn.v0 - 4, Bn.u1 - Bn.u0 + 8, 4, 8);
  box(cam, g, Bn.u0 - 4, Bn.v0, 4, Bn.v1 - Bn.v0, 8);
  const f = o.failed;
  const perRow = Math.floor((Bn.u1 - Bn.u0 - 20) / 24);
  f.slice(0, perRow * 4).forEach((it, i) => {
    const row = Math.floor(i / perRow), col = i % perRow;
    const u = Bn.u0 + 16 + col * 24, v = Bn.v0 + 14 + row * 22;
    const sel = o.selected === it.id;
    crate(cam, g, u, v, 15, 'fail', 0.3);
    const x = cam.x(u, v), y = cam.y(u, v, 10);
    if (sel) selRing(cam, g, u, v, 15, 0.3);
    hits.push({ kind: 'failed', id: it.id, x: x - 11, y: y - 11, w: 22, h: 22, url: it.url, label: `${it.name} #${it.number}` });
  });
  box(cam, g, Bn.u1, Bn.v0, 4, Bn.v1 - Bn.v0, 8);
  box(cam, g, Bn.u0 - 4, Bn.v1, Bn.u1 - Bn.u0 + 8, 4, 8);
  if (f.length > perRow * 4) {
    const x = cam.x(Bn.u1 - 40, Bn.v1), y = cam.y(Bn.u1 - 40, Bn.v1, 0) + 14;
    g.text(`+${f.length - perRow * 4}`, x, y, C.redText, T.small);
  }
  // its head: "failed · last 30m · N", then the window chips (the Yard's chips)
  const x0 = cam.x(Bn.u0, Bn.v1 + 4) + 2, y0 = cam.y(Bn.u0, Bn.v1 + 4, 0) + 22;
  let x = x0;
  x += g.text('failed', x, y0, C.ink, T.head, true);
  x += g.text(' · last ', x, y0, C.ink3, T.cap);
  x += g.text(o.window, x, y0, C.ink3, T.cap);
  x += g.text(' · ', x, y0, C.ink3, T.cap);
  x += g.text(`${f.length}`, x, y0, f.length ? C.redText : C.ink3, T.cap) + 14;
  for (const [w, ms] of WINDOWS) {
    const on = w === o.window;
    const cw = Math.ceil(g.width(w, 11)) + 12, ch = 18;
    g.begin_(); g.rrect(x, y0 - 13, cw, ch, 3);
    if (!on) g.dash(true, 3, 2.5);
    g.stroke(on ? '#9A9A9C' : C.chipEdge, 1);
    if (!on) g.dash(false);
    g.text(w, x + 6, y0 + 0.5, on ? C.ink : '#8C8C8E', 11);
    hits.push({ kind: 'window', id: w, x, y: y0 - 13, w: cw, h: ch, label: `failed in the last ${w}` });
    void ms;
    x += cw + 4;
  }
  return hits;
}

/** The stage heads along the top: the name, then its numbers; a hairline down to its station. */
export function drawHeads(g: Gfx, cam: Cam, S: Stages, now: number, top: number): void {
  const busy = S.engines.running, slots = S.engines.slots;
  const lines: Record<string, [string, string][]> = {
    sources: [[`${S.sources.perHour}`, C.ink2], ['/h', C.ink3]],
    intake: S.intake.waiting ? [[`${S.intake.waiting} waiting`, C.amberText], [` · ${ago(now - S.intake.oldestAt)}`, C.ink3]] : [['empty', C.ink3]],
    engines: [[`${busy} busy`, busy ? C.amberText : C.ink3], [` of ${slots}`, C.ink3]],
    tests: [[`${Math.round(S.tests.passRate * 100)}%`, S.tests.passRate >= 0.85 ? C.greenInk : C.amberText], [` · ${S.tests.total}/h`, C.ink3]],
    mains: S.mains.red.length ? [[`${S.mains.red.length} red`, C.redText], [` · ${S.mains.green} green`, C.ink3]] : [['all green', C.greenInk]],
    deploy: [[`${S.deploy.running.length} now`, S.deploy.running.length ? C.amberText : C.ink3], [` · ${S.deploy.today} today`, C.ink3]],
    apps: S.apps.down.length ? [[`${S.apps.down.length} down`, C.redText], [` · ${S.apps.up} up`, C.ink3]] : [[`${S.apps.up} of ${S.apps.total} up`, C.greenInk]],
  };
  const xs = STATIONS.map((s) => cam.x(s.u, L.v0 + 60));
  for (const [si, s] of STATIONS.entries()) {
    const x = xs[si];
    const room = Math.min(si > 0 ? x - xs[si - 1] : 1e9, si < xs.length - 1 ? xs[si + 1] - x : 1e9) - 14;
    const yAnchor = cam.y(s.u, L.v0 + 60, 70);
    g.text(s.name, x, top + 14, C.ink, T.head, true, 'center');
    let parts = lines[s.id] ?? [];
    let w = 0; for (const [t] of parts) w += g.width(t, T.cap);
    if (w > room && parts.length > 1) { parts = parts.slice(0, 1); w = g.width(parts[0][0], T.cap); }
    let xx = x - w / 2;
    for (const [t, c] of parts) xx += g.text(t, xx, top + 31, c, T.cap);
    g.begin_(); g.move(Math.round(x) + 0.5, top + 40); g.line(Math.round(x) + 0.5, Math.max(top + 40, yAnchor)); g.stroke('#26262A', 1);
  }
}
