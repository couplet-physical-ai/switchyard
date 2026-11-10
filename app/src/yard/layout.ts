// Where everything in the yard sits (DESIGN.md, "Layout of the Yard"): pure geometry from the
// canvas size, the fleet's census and the LOD book. No drawing. The static layer draws machines
// and wires from it, the info layer its panels, the live layer anchors packets to it.
//
// The yard is an L: the flow schematic across the top left (sources → intake → engine lanes →
// gates), the return wire under it as the band divider, NOW / COMING / the last hour's pulse /
// the busiest repos below it, and the main lines down the whole right side (rows by attention,
// then every repo as a heatmap cell, then deploy and the apps), fed by a vertical bus.
//
// Units are "yard px": canvas px divided by `k`, the scale that grows type and geometry a
// little on very large canvases (a 2880-wide window gets 1.375×, not 2×: the rest of the room
// shows more, not bigger).

import type { Engine } from '../wire.ts';
import { BOTS, type World } from '../world.ts';
import { effective, type Level, type LodBook, type Thresholds } from './lod.ts';
import { type AppAgg, type RepoAgg, isRed, ORG_ORDER, orgLabel, orgRank } from './select.ts';
import type { StressFleet, VirtualLane } from './stress.ts';
import { clamp } from './theme.ts';

export { BOTS, isRed, ORG_ORDER, orgLabel };

export type Pt = { x: number; y: number };
export type Rect = { x: number; y: number; w: number; h: number };
export type Machine = Rect & { id: string; inPort: Pt; outPort: Pt };
export type Slot = { engine: string; idx: number; x: number; y: number; r: number; lane: number };
export type Lane = Machine & {
  title: string; sub: string; kind: Engine['kind']; engines: string[]; slots: Slot[]; offline: boolean; virtual: boolean;
  /** Label baseline (LOD0) and caption baseline (running repos). */
  labelY: number; captionY: number; lod: Level;
};
export type SourceRow = { org: string; label: string; x: number; y: number; port: Pt; bot: boolean; lod: Level; i: number };
export type MainRow = {
  repo: string; i: number; y: number; h: number; lod: Level;
  /** Name column start, the dots' span (newest at dx1), the dot pitch and radius. */
  x0: number; nameW: number; dx0: number; dx1: number; pitch: number; r: number;
};
export type HeatBlock = { org: string; label: string; x: number; y: number; cols: number; rows: number; start: number; end: number; labelY: number };
export type Leg = { pts: Float32Array; len: number };
export type HitRegion = Rect & { kind: string; id: string; label: string; grid?: { cols: number; pitch: number; start: number; end: number; kind: string } };

export type Scene = {
  W: number; H: number; k: number; px: number; m: number; stress: boolean;
  key: string;
  header: { y: number; h: number };
  dial: Pt & { r: number; labelX: number };
  L: { x0: number; x1: number }; R: { x0: number; x1: number };
  top: { y0: number; y1: number; head: number; body: number };
  divY: number;
  sources: { x: number; w: number; rows: SourceRow[]; lod: Level; cellsY: number };
  intake: { x: number; w: number; rr: Machine; gha: Machine; junction: Pt };
  engines: { x: number; w: number; lanes: Lane[]; lod: Level; slotByEngine: Map<string, Slot[]>; cells: Rect };
  gates: { x: number; w: number; gate: Machine; review: Machine };
  bus: { x: number; y0: number; y1: number };
  mains: { x0: number; x1: number; y0: number; rows: MainRow[]; heat: { y: number; h: number; blocks: HeatBlock[]; cell: number; pitch: number; n: number; lod: Level }; rowsBottom: number };
  deploy: Machine;
  apps: { x: number; y: number; w: number; h: number; cell: number; pitch: number; cols: number; n: number; lod: Level; namesY: number };
  now: Rect; queue: Rect; pulse: Rect; busy: Rect;
  legs: {
    fan: Leg[]; jRr: Leg; jGha: Leg; toLane: Leg[]; fromLane: Leg[]; gateBus: Leg; review: Leg; reject: Leg;
    ret: Leg; retTicks: Leg[]; deploy: Leg; apps: Leg;
  };
  hits: HitRegion[];
  /** Elements per LOD in this scene (the HUD's histogram). */
  hist: [number, number, number, number];
};

// ---- census: what there is to draw (real, or stress's 10×) -------------------------------------

export type LaneSpec = VirtualLane & { engines: string[]; virtual: boolean };

export type Census = {
  orgs: string[]; orgLabels: string[];
  lanes: LaneSpec[];
  repos: number; repoState: Uint8Array; repoIds: string[];
  orgRuns: { org: string; label: string; start: number; end: number }[];
  apps: number; appHealth: Uint8Array; appIds: string[];
  ranked: string[]; fresh: number; hot: number;
  stress: boolean;
};

export function census(w: World, ra: RepoAgg, aa: AppAgg, st: StressFleet | null): Census {
  const orgs = Array.from(w.orgs.keys()).sort((a, b) => orgRank(a) - orgRank(b) || (w.orgs.get(b)?.repos ?? 0) - (w.orgs.get(a)?.repos ?? 0) || a.localeCompare(b));
  const realOrgs = [...orgs.slice(0, 7), BOTS];
  const realLanes: LaneSpec[] = engineGroups(w).map((g) => ({
    id: g.id, title: g.title, sub: g.sub, kind: g.kind, slots: g.engines.reduce((n, e) => n + Math.max(1, e.slots), 0),
    offline: g.engines.length > 0 && g.engines.every((e) => e.online === false), engines: g.engines.map((e) => e.id), virtual: false,
  }));
  const runs = ra.orgs.map((o) => ({ org: o.org, label: orgLabel(o.org), start: o.start, end: o.end }));
  if (!st?.on) {
    return {
      orgs: realOrgs, orgLabels: realOrgs.map(orgLabel), lanes: realLanes, repos: ra.ids.length, repoState: ra.state, repoIds: ra.ids,
      orgRuns: runs, apps: aa.ids.length, appHealth: aa.health, appIds: aa.ids, ranked: ra.ranked, fresh: ra.fresh, hot: ra.hot, stress: false,
    };
  }
  st.build(ra.state, realOrgs.map(orgLabel), realLanes, aa.health);
  const n = st.repoState.length;
  // The virtual repos continue each org's run, ten times over.
  const vruns: Census['orgRuns'] = [];
  const per = Math.max(1, ra.ids.length);
  for (let k = 0; k * per < n; k++) for (const r of runs) {
    const s = k * per + r.start, e = Math.min(n, k * per + r.end);
    if (s < e) vruns.push({ org: k ? `${r.org}~${k}` : r.org, label: k ? `${r.label}-${k + 1}` : r.label, start: s, end: e });
  }
  return {
    orgs: st.orgLabels.map((l, i) => (i < realOrgs.length ? realOrgs[i] : `~${l}`)), orgLabels: st.orgLabels,
    lanes: st.lanes.map((l, i) => ({ ...l, engines: i < realLanes.length ? realLanes[i].engines : [], virtual: i >= realLanes.length })),
    repos: n, repoState: st.repoState, repoIds: ra.ids, orgRuns: vruns, apps: st.appHealth.length, appHealth: st.appHealth, appIds: aa.ids,
    ranked: ra.ranked, fresh: ra.fresh, hot: ra.hot, stress: true,
  };
}

/** A slot cell's height in a LOD0 lane (kept for the info layer). */
export const CELL_H = 20;
/** A LOD0 lane: label line, the machine, the caption line. */
export const LANE0_H = 46;
/** A LOD0 slot cell's width (set per layout; the info layer fits names into it). */
export function slotCellW(S: Scene): number {
  const l = S.engines.lanes[0];
  if (!l || l.slots.length < 2) return 100;
  const a = l.slots[0], b = l.slots[1];
  return b.y === a.y ? b.x - a.x : 100;
}

// ---- thresholds (yard px per element) -----------------------------------------------------------
const TH_LANE: Thresholds = [50, 22, 13];
const TH_SOURCE: Thresholds = [19, 14, 9];
const TH_ROW: Thresholds = [22, 13.5, 9];
const TH_CELL: Thresholds = [7.5, 5, 3];

export function scaleFor(W: number, H: number): number {
  return 1 + 0.5 * clamp(Math.min(W / 1440, H / 900) - 1.25, 0, 1);
}

export function layout(Wc: number, Hc: number, deviceScale: number, c: Census, lod: LodBook, picks: string[], t: number): Scene {
  const k = scaleFor(Wc, Hc);
  const W = Wc / k, H = Hc / k;
  const px = deviceScale * k;
  const m = W >= 1200 ? 16 : 12;
  const hist: [number, number, number, number] = [0, 0, 0, 0];
  const hits: HitRegion[] = [];

  // ---- the L and the right column
  const Lw = Math.round((W - 2 * m) * (W >= 1600 ? 0.545 : 0.565));
  const L = { x0: m, x1: m + Lw };
  const busX = L.x1 + 14;
  const R = { x0: busX + 14, x1: W - m };
  const headerY = 22;
  const y0 = 38;

  // ---- top-left columns
  // Gaps: the fan-in from the sources and the hand-off to the lanes need room to curve.
  const gx = clamp(Math.round(Lw * 0.034), 16, 36);
  const gFan = clamp(Math.round(Lw * 0.06), 30, 64);
  const gHand = clamp(Math.round(Lw * 0.05), 24, 52);
  const ws = clamp(Math.round(Lw * 0.22), 112, 230);
  const wi = clamp(Math.round(Lw * 0.1), 58, 104);
  const wg = clamp(Math.round(Lw * 0.1), 58, 104);
  const xs = L.x0 + 4, xi = xs + ws + gFan, xe = xi + wi + gHand, xg = L.x1 - wg;
  const we = xg - gx - xe;
  const head = 30; // a station's title + caption
  const body0 = y0 + head + 8;

  // How tall the schematic wants to be: the engine lanes at LOD0, the source rows at LOD0.
  const nLanes = c.lanes.length, nSrc = c.orgs.length;
  // A LOD0 lane is a machine sized to its slots (a row of slot circles), a label line over it
  // and a caption line under it naming what runs there.
  const pitch0 = 17;
  const laneNeed0 = (slots: number) => { void slots; return LANE0_H; };
  let need0 = 0;
  for (const l of c.lanes) need0 += laneNeed0(l.slots);
  const wantLanes = need0, wantSrc = nSrc * 20 + 18;
  const topMax = Math.round(H * 0.46), topMin = Math.max(150, Math.min(Math.round(H * 0.3), Math.max(wantLanes, wantSrc) + head + 24));
  const bodyH = clamp(Math.max(wantLanes, wantSrc, 150), topMin - head - 8, topMax - head - 8);
  const top = { y0, y1: body0 + bodyH, head, body: body0 };
  const divY = top.y1 + 14;

  // ---- sources
  const srcPitchRaw = bodyH / Math.max(1, nSrc);
  const srcLod = lod.pick('sources', Math.min(22, srcPitchRaw), nSrc, TH_SOURCE, t);
  const srcPitch = srcLod <= 1 ? Math.min(srcLod === 0 ? 20 : 15, srcPitchRaw) : srcLod === 2 ? 16 : 0;
  const rows: SourceRow[] = [];
  const portX = xs + ws;
  if (srcLod <= 1) {
    for (let i = 0; i < nSrc; i++) {
      const y = body0 + 6 + i * srcPitch;
      rows.push({ org: c.orgs[i], label: c.orgLabels[i], x: xs, y, port: { x: portX, y }, bot: c.orgs[i] === BOTS, lod: srcLod, i });
      hits.push({ x: xs - 4, y: y - srcPitch / 2, w: ws + 4, h: srcPitch, kind: 'org', id: c.orgs[i], label: c.orgLabels[i] });
    }
  } else {
    // Pills (LOD2) or cells (LOD3): every org fans in from one port, mid-column.
    const y = body0 + bodyH / 2;
    rows.push({ org: '*', label: 'all orgs', x: xs, y, port: { x: portX, y }, bot: false, lod: srcLod, i: 0 });
  }
  hist[srcLod] += nSrc;

  // ---- intake: Roadrunner's queue, GitHub Actions under it
  const rr = mk('roadrunner', xi, body0 + 10, wi, 26);
  const gha = mk('gha', xi, rr.y + rr.h + 40, wi, 18);
  const junction = { x: xi - Math.round(gFan * 0.38), y: Math.round((rr.inPort.y + gha.inPort.y) / 2) };
  hits.push({ x: xi - 4, y: rr.y - 14, w: wi + 8, h: rr.h + 30, kind: 'queue', id: 'roadrunner', label: 'Roadrunner queue' });
  hits.push({ x: xi - 4, y: gha.y - 14, w: wi + 8, h: gha.h + 30, kind: 'queue', id: 'gha', label: 'GitHub Actions' });

  // ---- engine lanes
  // The size a lane gets, normalised so that "LOD0 fits exactly" reads as 52 px a lane.
  const lanePx = need0 > 0 ? (bodyH / need0) * 52 : 60;
  const laneLod = lod.pick('lanes', Math.min(64, lanePx), nLanes, TH_LANE, t);
  const lanes: Lane[] = [];
  const slotByEngine = new Map<string, Slot[]>();
  const cells = { x: xe, y: body0, w: we, h: bodyH };
  if (laneLod <= 1) {
    let ly = body0;
    const lh1 = Math.min(24, bodyH / Math.max(1, nLanes));
    c.lanes.forEach((spec, li) => {
      const n = Math.max(1, spec.slots);
      let box: Lane;
      let lh: number;
      if (laneLod === 0) {
        box = mk(spec.id, xe, ly + 15, we, 22) as Lane;
        lh = LANE0_H;
      } else {
        box = mk(spec.id, xe, ly + 2, we, Math.max(12, lh1 - 6)) as Lane;
        lh = lh1;
      }
      box.title = spec.title; box.sub = spec.sub; box.kind = spec.kind; box.engines = spec.engines; box.offline = spec.offline;
      box.virtual = spec.virtual; box.lod = laneLod; box.labelY = ly + 10; box.captionY = box.y + box.h + 12; box.slots = [];
      const list = spec.engines.length ? spec.engines : [spec.id];
      let k2 = 0;
      const labelW = Math.min(110, Math.round(we * 0.36));
      const pitch1 = Math.min(12, Math.max(7, (we - labelW - 64) / n));
      const r1 = Math.min(3.5, box.h / 2 - 2.5);
      for (const eid of list) {
        const per = spec.engines.length ? Math.max(1, slotsOfEngine(spec, eid)) : n;
        const sl: Slot[] = [];
        for (let i = 0; i < per; i++, k2++) {
          const s: Slot = laneLod === 0
            ? { engine: eid, idx: i, x: box.x + 7 + pitch0 / 2 + k2 * pitch0, y: box.y + box.h / 2, r: 5, lane: li }
            : { engine: eid, idx: i, x: box.x + labelW + 6 + k2 * pitch1, y: box.y + box.h / 2, r: r1, lane: li };
          sl.push(s);
          box.slots.push(s);
        }
        slotByEngine.set(eid, sl);
      }
      lanes.push(box);
      hits.push({ x: xe - 4, y: ly, w: we + 8, h: lh, kind: 'engine', id: spec.id, label: spec.title });
      ly += lh;
    });
  } else {
    hits.push({ x: xe, y: body0, w: we, h: bodyH, kind: 'engine', id: '*', label: 'engines' });
  }
  hist[laneLod] += nLanes;

  // ---- gates
  const gate = mk('gate', xg, body0 + 6, wg, 40);
  const review = mk('review', xg, gate.y + gate.h + 34, wg, 22);
  hits.push({ x: xg - 4, y: gate.y - 4, w: wg + 8, h: gate.h + 22, kind: 'gate', id: 'gate', label: 'Required checks' });
  hits.push({ x: xg - 4, y: review.y - 4, w: wg + 8, h: review.h + 22, kind: 'view', id: 'prs', label: 'Pull requests' });

  // ---- right column: main lines, the heatmap, deploy and apps
  const rx0 = R.x0, rx1 = R.x1, rw = rx1 - rx0;
  const mainsY0 = body0;
  // Apps first (bottom), then the heatmap above it; the rows get what is left.
  const nApps = c.apps;
  const appsCellTarget = clamp(Math.floor(Math.sqrt((rw * 40) / Math.max(1, nApps))), 2, 9);
  const appLod = lod.pick('apps', appsCellTarget, nApps, TH_CELL, t);
  const appCell = appLod === 0 ? 7 : appLod === 1 ? 5 : appLod === 2 ? 3 : 2;
  const appPitch = appCell + (appLod <= 1 ? 2 : 1);
  const appCols = Math.max(8, Math.floor((rw - 2) / appPitch));
  const appRows = Math.ceil(nApps / appCols);
  const appsH = appRows * appPitch;
  const appsY = H - m - appsH;
  const appsNamesY = appsY - 8;
  const deployY = appsNamesY - 34;
  const deploy = mk('deploy', rx0, deployY, Math.min(96, Math.round(rw * 0.16)), 22);
  hist[appLod] += nApps;
  hits.push({ x: rx0 - 4, y: deployY - 16, w: rw, h: 40, kind: 'view', id: 'fleet', label: 'Deploys and apps' });
  hits.push({ x: rx0, y: appsY, w: appCols * appPitch, h: appsH, kind: 'app', id: '', label: '', grid: { cols: appCols, pitch: appPitch, start: 0, end: nApps, kind: 'app' } });

  // Heatmap: every repo, one cell each, in org blocks (label on the left).
  const nRepos = c.repos;
  const heatW = rw;
  const labelCol = 72;
  const cellTarget = clamp(Math.floor(Math.sqrt(((heatW - labelCol) * 120) / Math.max(1, nRepos))), 2, 8);
  const heatLod: Level = 3;
  const cell = cellTarget >= 6 ? 5 : cellTarget >= 4 ? 4 : cellTarget >= 3 ? 3 : 2;
  const pitch = cell + (cell >= 4 ? 2 : 1);
  const hcols = Math.max(8, Math.floor((heatW - labelCol) / pitch));
  const runs = c.orgRuns;
  // In stress there are dozens of org runs: merge each copy of the fleet into one block.
  const blocksSpec = mergeRuns(runs, c.stress);
  // Blocks flow left to right (a label, then the cells), wrapping; a line is as tall as its
  // tallest block and never shorter than a label.
  const flow = (dry: boolean, y0: number) => {
    const out: HeatBlock[] = [];
    let x = rx0, y = y0 + 16, lineH = 0;
    for (const b of blocksSpec) {
      const lw = Math.min(labelCol, Math.ceil(b.label.length * 7) + 8);
      const maxCols = Math.max(4, Math.floor((heatW - lw) / pitch));
      const cols = Math.min(maxCols, b.count);
      const rowsN = Math.max(1, Math.ceil(b.count / cols));
      const bw = lw + cols * pitch + 10;
      if (x > rx0 && x + bw > rx0 + heatW) { x = rx0; y += lineH + 3; lineH = 0; }
      out.push({ org: b.org, label: b.label, x: x + lw, y, cols, rows: rowsN, start: b.start, end: b.start + b.count, labelY: y + cell + 1 });
      if (!dry) hits.push({ x: x + lw, y, w: cols * pitch, h: rowsN * pitch, kind: 'repo', id: '', label: '', grid: { cols, pitch, start: b.start, end: b.start + b.count, kind: 'repo' } });
      lineH = Math.max(lineH, rowsN * pitch, 12);
      x += bw;
    }
    return { out, h: y + lineH - y0 };
  };
  const heatH = Math.min(flow(true, 0).h + 2, Math.round(H * 0.42));
  const heatY = deployY - 18 - heatH;
  const blocks = flow(false, heatY).out.filter((b) => b.y + b.rows * pitch <= heatY + heatH + 2);
  hist[heatLod] += nRepos;
  hits.push({ x: rx0, y: heatY - 2, w: rw, h: 14, kind: 'view', id: 'mainlines', label: 'All main lines' });

  // Rows: the fresh reds (today's streaks) at LOD0, then the rest of the lines worth a row at
  // LOD1, or LOD2 time-bucket bars when the space per row is short. Every repo there is counts
  // as a sibling: a 4,000-repo fleet reads as texture sooner than a 400-repo one.
  const rowsTop = mainsY0 + 2, rowsBottom = heatY - 14;
  const avail = Math.max(0, rowsBottom - rowsTop - 8);
  const nameW = clamp(Math.round(rw * 0.3), 150, 240);
  const H0 = 25, H1 = 15, H2 = 11;
  // LOD0 for today's reds while they take at most ~40 % of the column; the rest of the lines a
  // level (or two) lower, decided by the room per row among the lines that want one.
  const cap0 = Math.min(8, Math.floor((avail * 0.4) / H0));
  const freshLod: Level = cap0 >= 2 ? 0 : 1;
  const hFresh = freshLod === 0 ? H0 : H1;
  const n0 = lod.sticky('fresh-n', Math.min(c.fresh, Math.max(cap0, 0)));
  const rest = Math.max(0, avail - n0 * hFresh - 6);
  const wantRest = Math.max(1, Math.min(Math.max(0, c.hot - n0), 48));
  const restLod = Math.max(1, lod.pick('rows', Math.min(26, rest / Math.min(wantRest, 12)), wantRest, [22, 12, 8], t)) as Level;
  const hRest = restLod === 1 ? H1 : H2;
  const mainRows: MainRow[] = [];
  let ry = rowsTop + 6;
  const order = picks.length ? picks : c.ranked;
  for (let i = 0; i < order.length; i++) {
    const l: Level = i < n0 ? freshLod : restLod;
    if (l === 3) break;
    const hh = i < n0 ? hFresh : hRest;
    if (ry + hh > rowsBottom + 2) break;
    // Dot pitch grows with the room (40 dots across at most), never below the level's minimum.
    const span = rx1 - 12 - (rx0 + nameW + 12);
    const pitchD = l === 0 ? clamp(Math.floor(span / 40), 11, 15) : l === 1 ? clamp(Math.floor(span / 40), 8, 11) : 6;
    const rr2 = l === 0 ? 3.5 : l === 1 ? 2.5 : 2;
    const dx1 = rx1 - 12;
    const dx0 = rx0 + nameW + 12;
    const yMid = ry + (l === 0 ? 16 : hh / 2);
    mainRows.push({ repo: order[i], i, y: yMid, h: hh, lod: l, x0: rx0, nameW, dx0, dx1, pitch: pitchD, r: rr2 });
    hits.push({ x: rx0 - 2, y: ry, w: rw + 2, h: hh, kind: 'repo', id: order[i], label: order[i] });
    hist[l]++;
    ry += hh + (i === n0 - 1 ? 6 : 0);
  }
  const busY0 = gate.outPort.y;

  // ---- lower left: NOW, COMING, the pulse and the busiest
  const lx0 = L.x0, lw = Lw;
  let ly = divY + 22;
  const lowerH = H - m - ly;
  const nowH = clamp(Math.round(lowerH * 0.28), 78, 112);
  const now: Rect = { x: lx0, y: ly, w: lw, h: nowH };
  ly += nowH + 10;
  // COMING gets its rows (the queue, then up to 8 "just finished"), PULSE the rest (taller
  // bars read better than more history rows).
  const pulseMin = clamp(Math.round(lowerH * 0.24), 62, 110);
  const queueWant = 38 + 22 * Math.max(9, Math.floor((lowerH - nowH - 180) / 22));
  const queueH = Math.max(40, Math.min(queueWant, H - m - ly - pulseMin - 12));
  const pulseH = Math.max(pulseMin, Math.min(150, H - m - ly - queueH - 12));
  const queue: Rect = { x: lx0, y: ly, w: lw, h: queueH };
  ly += queueH + 12;
  const pw = Math.round(lw * (lw > 700 ? 0.58 : 0.55));
  const pulse: Rect = { x: lx0, y: ly, w: pw, h: pulseH };
  const busy: Rect = { x: lx0 + pw + 24, y: ly, w: lw - pw - 24, h: pulseH };
  hits.push({ x: now.x, y: now.y, w: now.w, h: 22, kind: 'now', id: '', label: '' });

  // ---- header: the dial ("1 hour, sped up") at the right; a Contract button sits over it.
  const dial = { x: W - m - 8, y: 17, r: 7, labelX: W - m - 22 };

  // ---- the wire graph (static layer draws it; packets ride it)
  const fan: Leg[] = rows.map((s) => bezLeg(s.port.x, s.port.y, junction.x, junction.y));
  const jRr = bezLeg(junction.x, junction.y, rr.inPort.x, rr.inPort.y);
  const jGha = bezLeg(junction.x, junction.y, gha.inPort.x, gha.inPort.y);
  const toLane: Leg[] = [], fromLane: Leg[] = [];
  for (const ln of lanes) {
    const q = ln.kind === 'gha_runner' ? gha : rr;
    toLane.push(bezLeg(q.outPort.x, q.outPort.y, ln.inPort.x, ln.inPort.y));
    fromLane.push(bezLeg(ln.outPort.x, ln.outPort.y, gate.inPort.x, gate.inPort.y));
  }
  if (!lanes.length) {
    const mid = { x: xe, y: body0 + bodyH / 2 };
    toLane.push(bezLeg(rr.outPort.x, rr.outPort.y, mid.x, mid.y));
    fromLane.push(bezLeg(xe + we, mid.y, gate.inPort.x, gate.inPort.y));
  }
  const gateBus = polyLeg([gate.outPort.x, gate.outPort.y, busX, gate.outPort.y]);
  const reviewLeg = polyLeg([gate.x + gate.w / 2, gate.y + gate.h, review.x + review.w / 2, review.y]);
  const retX = L.x0 - 6;
  const reject = polyLeg([gate.x + gate.w - 10, gate.y + gate.h, gate.x + gate.w - 10, review.y - 8, gate.x + gate.w + 6, review.y - 8, gate.x + gate.w + 6, divY]);
  const firstSrcY = rows[0]?.y ?? body0;
  const ret = polyLeg(roundedPath([busX, divY, retX, divY, retX, firstSrcY], 8));
  const retTicks = rows.map((s) => polyLeg([retX, s.y, s.x - 3, s.y]));
  const deployLeg = polyLeg([busX, deploy.inPort.y, deploy.inPort.x, deploy.inPort.y]);
  const appsLeg = polyLeg([deploy.outPort.x, deploy.outPort.y, deploy.outPort.x + 12, deploy.outPort.y, deploy.outPort.x + 12, appsY - 2]);

  const bus = { x: busX, y0: busY0, y1: deploy.inPort.y };
  const hasMain = mainRows.length;
  void hasMain;

  const key = [Wc, Hc, deviceScale, picks.slice(0, mainRows.length).join(','), mainRows.map((r) => r.lod).join(''), c.lanes.map((l) => `${l.id}:${l.slots}:${l.offline ? 0 : 1}`).join(','),
    c.orgs.length, c.repos, c.apps, srcLod, laneLod, appLod, c.stress ? 1 : 0].join('|');

  return {
    W, H, k, px, m, stress: c.stress, key,
    header: { y: headerY, h: 30 }, dial, L, R, top, divY,
    sources: { x: xs, w: ws, rows, lod: srcLod, cellsY: body0 },
    intake: { x: xi, w: wi, rr, gha, junction },
    engines: { x: xe, w: we, lanes, lod: laneLod, slotByEngine, cells },
    gates: { x: xg, w: wg, gate, review },
    bus,
    mains: { x0: rx0, x1: rx1, y0: mainsY0, rows: mainRows, heat: { y: heatY, h: heatH, blocks, cell, pitch, n: nRepos, lod: heatLod }, rowsBottom },
    deploy,
    apps: { x: rx0, y: appsY, w: appCols * appPitch, h: appsH, cell: appCell, pitch: appPitch, cols: appCols, n: nApps, lod: appLod, namesY: appsNamesY },
    now, queue, pulse, busy,
    legs: { fan, jRr, jGha, toLane, fromLane, gateBus, review: reviewLeg, reject, ret, retTicks, deploy: deployLeg, apps: appsLeg },
    hits, hist,
  };
}

function slotsOfEngine(spec: LaneSpec, eid: string): number {
  void spec;
  return engineSlots.get(eid) ?? 1;
}
/** Slot counts by engine id, refreshed by `engineGroups` (the lane spec carries only totals). */
const engineSlots = new Map<string, number>();

function mergeRuns(runs: Census['orgRuns'], stress: boolean): { org: string; label: string; start: number; count: number }[] {
  if (!stress) return runs.map((r) => ({ org: r.org, label: r.label, start: r.start, count: r.end - r.start }));
  // Stress: one block per copy of the fleet (k), the copies laid end to end.
  const out: { org: string; label: string; start: number; count: number }[] = [];
  let cur: { org: string; label: string; start: number; count: number } | null = null;
  for (const r of runs) {
    const kk = r.org.includes('~') ? Number(r.org.split('~')[1]) : 0;
    const label = kk ? `fleet ${kk + 1}` : 'real';
    if (!cur || cur.label !== label) { cur = { org: `fleet${kk}`, label, start: r.start, count: 0 }; out.push(cur); }
    cur.count = r.end - cur.start;
  }
  return out;
}

function mk(id: string, x: number, y: number, w: number, h: number): Machine {
  return { id, x, y, w, h, inPort: { x, y: y + h / 2 }, outPort: { x: x + w, y: y + h / 2 } };
}

/** A cubic S-curve between two ports, sampled as a polyline (the wires the inspiration draws). */
export function bezLeg(ax: number, ay: number, bx: number, by: number, n = 14): Leg {
  const dx = Math.max(16, Math.abs(bx - ax) * 0.5);
  const pts = new Float32Array((n + 1) * 2);
  for (let i = 0; i <= n; i++) {
    const u = i / n, v = 1 - u;
    const a = v * v * v, b = 3 * v * v * u, c2 = 3 * v * u * u, d = u * u * u;
    pts[i * 2] = a * ax + b * (ax + dx) + c2 * (bx - dx) + d * bx;
    pts[i * 2 + 1] = a * ay + b * ay + c2 * by + d * by;
  }
  return { pts, len: polyLen(pts) };
}

export function polyLeg(xy: number[]): Leg {
  const pts = new Float32Array(xy);
  return { pts, len: polyLen(pts) };
}

function polyLen(p: Float32Array): number {
  let L = 0;
  for (let i = 2; i < p.length; i += 2) L += Math.hypot(p[i] - p[i - 2], p[i + 1] - p[i - 1]);
  return L;
}

/** A polyline with rounded corners (quarter circles of radius r, sampled). */
function roundedPath(xy: number[], r: number): number[] {
  if (xy.length < 6) return xy;
  const out = [xy[0], xy[1]];
  for (let i = 2; i < xy.length - 2; i += 2) {
    const ax = xy[i - 2], ay = xy[i - 1], bx = xy[i], by = xy[i + 1], cx = xy[i + 2], cy = xy[i + 3];
    const l1 = Math.hypot(bx - ax, by - ay), l2 = Math.hypot(cx - bx, cy - by);
    const rr = Math.min(r, l1 / 2, l2 / 2);
    const p1x = bx + ((ax - bx) / l1) * rr, p1y = by + ((ay - by) / l1) * rr;
    const p2x = bx + ((cx - bx) / l2) * rr, p2y = by + ((cy - by) / l2) * rr;
    for (let s = 0; s <= 6; s++) {
      const u = s / 6, v = 1 - u;
      out.push(v * v * p1x + 2 * v * u * bx + u * u * p2x, v * v * p1y + 2 * v * u * by + u * u * p2y);
    }
  }
  out.push(xy[xy.length - 2], xy[xy.length - 1]);
  return out;
}

// ---- engines, as the fleet reports them ------------------------------------------------------

export type EngineGroup = { id: string; kind: Engine['kind']; title: string; sub: string; engines: Engine[]; stats: string[] };

/** The id of the virtual engine that stands for GitHub Actions when no runners are reported. */
export const GHA = 'gha';

const engCache = new WeakMap<World, { ver: number; all: Engine[] }>();
/** Every engine the yard shows: the fleet's, plus a virtual one for GitHub Actions' runs. */
export function enginesOf(w: World): Engine[] {
  const ver = w.kv.engine * 100003 + w.kv.pipeline;
  const hit = engCache.get(w);
  if (hit && hit.ver === ver) return hit.all;
  const all = Array.from(w.engines.values());
  if (!all.some((e) => e.kind === 'gha_runner')) {
    const running: string[] = [];
    for (const p of w.pipelines.values()) if (p.lane === 'gha' && p.state === 'running' && p.id) running.push(p.id);
    all.push({ id: GHA, kind: 'gha_runner', label: 'github actions', online: true, slots: Math.max(4, running.length), busy: running.length, running });
  }
  for (const e of all) engineSlots.set(e.id, Math.max(1, e.slots));
  engCache.set(w, { ver, all });
  return all;
}

const hostRank = (h: string) => (/^vm/i.test(h) ? 0 : /mac/i.test(h) ? 2 : 1);

export function engineGroups(w: World): EngineGroup[] {
  const all = enginesOf(w);
  const groups: EngineGroup[] = [];
  const agents = all.filter((e) => e.kind === 'wp_agent');
  const daggers = all.filter((e) => e.kind === 'dagger');
  const hosts = new Map<string, Engine[]>();
  const loose: Engine[] = [];
  for (const a of agents) {
    if (a.host) { let l = hosts.get(a.host); if (!l) hosts.set(a.host, (l = [])); l.push(a); }
    else loose.push(a);
  }
  const usedDagger = new Set<string>();
  for (const h of Array.from(hosts.keys()).sort((a, b) => hostRank(a) - hostRank(b) || a.localeCompare(b, 'en', { numeric: true }))) {
    const list = hosts.get(h)!.sort((a, b) => a.id.localeCompare(b.id, 'en', { numeric: true }));
    const dg = daggers.filter((d) => d.host === h || d.label === h || d.id === `dagger:${h}`);
    for (const d of dg) usedDagger.add(d.id);
    const plat = list[0]?.platform?.startsWith('darwin') ? 'macos' : dg.length ? 'dagger' : 'linux';
    groups.push({ id: `host:${h}`, kind: 'wp_agent', title: h.toLowerCase(), sub: plat, engines: list, stats: dg.map((d) => d.id) });
  }
  for (const d of daggers.filter((d) => !usedDagger.has(d.id)).sort((a, b) => a.id.localeCompare(b.id, 'en', { numeric: true }))) {
    groups.push({ id: d.id, kind: 'dagger', title: (d.label ?? d.id).toLowerCase(), sub: 'dagger', engines: [d], stats: [d.id] });
  }
  if (loose.length) groups.push({ id: 'agents', kind: 'wp_agent', title: 'agents', sub: 'woodpecker', engines: loose.sort((a, b) => a.id.localeCompare(b.id)), stats: [] });
  const runners = all.filter((e) => e.kind === 'gha_runner').sort((a, b) => a.id.localeCompare(b.id));
  if (runners.length) groups.push({ id: 'runners', kind: 'gha_runner', title: 'github actions', sub: runners.length === 1 && runners[0].id === GHA ? 'hosted' : 'runners', engines: runners, stats: [] });
  return groups;
}

/** Picks the repos that get rows, sticky: shown lines stay unless a fresh red needs the room. */
export function pickMains(ranked: string[], n: number, keep: string[], fresh: number): string[] {
  if (!keep.length) return ranked.slice(0, n);
  const out: string[] = [];
  const freshSet = ranked.slice(0, fresh);
  for (const id of freshSet) if (out.length < n) out.push(id);
  const rankedSet = new Set(ranked.slice(0, n + 8));
  for (const id of keep) if (out.length < n && !out.includes(id) && rankedSet.has(id)) out.push(id);
  for (const id of ranked) if (out.length < n && !out.includes(id)) out.push(id);
  // Keep the ranked order (tiers stay sorted); stickiness only decides who is in.
  const pos = new Map(ranked.map((id, i) => [id, i]));
  return out.sort((a, b) => (pos.get(a) ?? 1e9) - (pos.get(b) ?? 1e9));
}

/** The point inside a lane where a slot sits (for a pipeline id), or null. */
export function laneOfEngine(S: Scene, engine: string): Lane | null {
  for (const l of S.engines.lanes) if (l.engines.includes(engine) || l.id === engine) return l;
  return null;
}

export { effective };
