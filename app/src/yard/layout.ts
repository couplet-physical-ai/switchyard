// Where everything in the yard sits, from the canvas size and the world (DESIGN.md, "Layout of
// the Yard"). Pure geometry: no drawing. The static layer draws machines and wires from it;
// the live layer anchors packets, rings and labels to it.

import type { Engine, Repo } from '../wire.ts';
import type { World } from '../world.ts';

export type Pt = { x: number; y: number };
export type Machine = { id: string; x: number; y: number; w: number; h: number; inPort: Pt; outPort: Pt; title: string; sub: string };
export type Slot = { engine: string; idx: number; x: number; y: number; r: number };
export type EngineBox = Machine & { kind: Engine['kind']; engines: string[]; slots: Slot[] };
export type SourceRow = { org: string; label: string; x: number; y: number; port: Pt; bot: boolean };
export type MainLine = { repo: string; x0: number; x1: number; y: number; step: number; n: number };
export type AppCell = { app: string; x: number; y: number; s: number };
export type Band = { y0: number; y1: number };

export type Layout = {
  W: number; H: number; m: number; compact: boolean;
  live: Band; now: Band; queue: Band;
  cols: { sources: number; intake: number; engines: number; gates: number; mains: number };
  titleY: number;
  sources: SourceRow[];
  junction: Pt;
  intake: { roadrunner: Machine; gha: Machine };
  engines: EngineBox[];
  slotByEngine: Map<string, Slot[]>;
  gate: Machine;
  review: Machine;
  deploy: Machine;
  bus: { x: number; y0: number; y1: number };
  mains: MainLine[];
  agg: { x0: number; x1: number; y: number };
  apps: AppCell[];
  appsBox: { x: number; y: number; w: number; h: number; cols: number };
  ret: { y: number; x0: number; x1: number; topY: number };
  dial: Pt & { r: number };
  key: string;
};

export const ORG_ORDER = ['Northwind-Labs', 'Northwind-EMS', 'Northwind-Forge', 'couplet-physical-ai', 'copper-browser'];
import { BOTS } from '../world.ts';
export { BOTS };

export function orgLabel(org: string): string {
  if (org === BOTS) return 'bots';
  const o = org.replace(/^Northwind-/, '');
  if (o === 'couplet-physical-ai') return 'couplet';
  if (o === 'copper-browser') return 'copper';
  return o.toLowerCase();
}

/** The repos the yard draws as main lines: red ones first (oldest red first), then by heat. */
export function pickMains(world: World, n: number, keep: string[] = []): string[] {
  const repos = Array.from(world.repos.values());
  // Red lines that people are working on first (by heat), at most two in five lines.
  const red = repos.filter((r) => isRed(r)).sort((a, b) => (b.heat ?? 0) - (a.heat ?? 0) || (b.main?.since ?? 0) - (a.main?.since ?? 0));
  const hot = repos.filter((r) => !isRed(r)).sort((a, b) => (b.heat ?? 0) - (a.heat ?? 0) || a.id.localeCompare(b.id));
  const out: string[] = [];
  for (const r of red) if (out.length < Math.max(1, Math.floor(n * 0.4))) out.push(r.id);
  // Keep lines already shown where possible, so the yard does not reshuffle under the eye.
  for (const id of keep) if (out.length < n && !out.includes(id) && world.repos.has(id)) out.push(id);
  for (const r of hot) if (out.length < n && !out.includes(r.id)) out.push(r.id);
  return out.slice(0, n);
}

export function isRed(r: Repo | undefined): boolean {
  const s = r?.main?.state;
  return s === 'failure' || s === 'error';
}

export function layout(W: number, H: number, world: World, mains: string[]): Layout {
  const m = W >= 1200 ? 28 : 20;
  const compact = W < 1200;
  // Bands: LIVE takes what NOW and QUEUE leave; QUEUE folds first on short canvases.
  const queueH = H >= 720 ? 150 : 0;
  const nowH = H >= 560 ? 128 : 0;
  const live: Band = { y0: 0, y1: H - nowH - queueH };
  const now: Band = { y0: live.y1, y1: live.y1 + nowH };
  const queue: Band = { y0: now.y1, y1: H };
  const LH = live.y1;

  const cols = {
    sources: m,
    intake: Math.round(W * (compact ? 0.2 : 0.205)),
    engines: Math.round(W * 0.3),
    gates: Math.round(W * 0.548),
    mains: Math.round(W * 0.668),
  };
  const titleY = 84;
  const top = 126;

  // Sources: one row per org (by size), then bots.
  const orgs = Array.from(world.orgs.keys());
  orgs.sort((a, b) => rank(a) - rank(b) || (world.orgs.get(b)?.repos ?? 0) - (world.orgs.get(a)?.repos ?? 0) || a.localeCompare(b));
  const srcRows = [...orgs.slice(0, 7), BOTS];
  const srcGap = Math.min(36, Math.max(26, (LH - top - 120) / srcRows.length));
  const srcW = compact ? 118 : 138;
  const sources: SourceRow[] = srcRows.map((org, i) => {
    const y = top + i * srcGap;
    return { org, label: orgLabel(org), x: m, y, port: { x: m + srcW, y }, bot: org === BOTS };
  });

  // Intake: the Roadrunner queue (tall) above the GitHub Actions scale set.
  const qW = 66;
  const rr: Machine = mk('roadrunner', cols.intake, top - 12, qW, 138, 'roadrunner', 'woodpecker queue');
  const gha: Machine = mk('gha', cols.intake, rr.y + rr.h + 34, qW, 62, 'gha', 'actions scale set');
  const junction = { x: cols.intake - 34, y: (rr.inPort.y + gha.inPort.y) / 2 };

  // Engines: each Dagger engine its own machine; Woodpecker agents and GHA runners grouped.
  const engW = Math.round(W * 0.205);
  const all = Array.from(world.engines.values());
  const groups: { id: string; kind: Engine['kind']; title: string; engines: Engine[] }[] = [];
  for (const e of all.filter((e) => e.kind === 'dagger').sort((a, b) => a.id.localeCompare(b.id))) groups.push({ id: e.id, kind: 'dagger', title: `${e.id.toLowerCase()} · dagger`, engines: [e] });
  const agents = all.filter((e) => e.kind === 'wp_agent').sort((a, b) => a.id.localeCompare(b.id));
  if (agents.length) groups.push({ id: 'agents', kind: 'wp_agent', title: 'agents · woodpecker', engines: agents });
  const runners = all.filter((e) => e.kind === 'gha_runner').sort((a, b) => a.id.localeCompare(b.id));
  if (runners.length) groups.push({ id: 'runners', kind: 'gha_runner', title: 'runners · gha', engines: runners });
  const slotR = compact ? 8.5 : 10;
  const pitch = slotR * 2 + (compact ? 7 : 9);
  const perRow = Math.max(4, Math.floor((engW - 28) / pitch));
  const engStride = 20; // title above each box
  const avail = Math.max(200, LH - top - 70);
  const rowsTotal = groups.reduce((n, g) => n + Math.ceil(slotsOf(g.engines) / perRow), 0);
  const rowH = Math.min(pitch + 4, Math.max(slotR * 2 + 6, (avail - groups.length * (engStride + 18)) / Math.max(1, rowsTotal)));
  const engines: EngineBox[] = [];
  const slotByEngine = new Map<string, Slot[]>();
  let ey = top - 12;
  for (const g of groups) {
    const n = slotsOf(g.engines);
    const rows = Math.ceil(n / perRow);
    const h = Math.round(rows * rowH + 16);
    const box = mk(g.id, cols.engines, ey, engW, h, g.title, '') as EngineBox;
    box.kind = g.kind;
    box.engines = g.engines.map((e) => e.id);
    box.slots = [];
    let k = 0;
    for (const e of g.engines) {
      const list: Slot[] = [];
      for (let i = 0; i < Math.max(1, e.slots); i++, k++) {
        const r = Math.floor(k / perRow), c = k % perRow;
        const inRow = Math.min(perRow, n - r * perRow);
        const x0 = box.x + box.w / 2 - ((inRow - 1) * pitch) / 2;
        const s: Slot = { engine: e.id, idx: i, x: x0 + c * pitch, y: box.y + 8 + rowH * (r + 0.5), r: slotR };
        list.push(s);
        box.slots.push(s);
      }
      slotByEngine.set(e.id, list);
    }
    engines.push(box);
    ey += h + engStride + 12;
  }

  // Gates, the reviewer below them, and deploy in the lower tier.
  const gW = compact ? 96 : 112;
  const gate = mk('gate', cols.gates, top - 12, gW, 84, 'gates', 'required checks');
  const review = mk('review', cols.gates, gate.y + gate.h + 40, gW, 58, 'review', 'ai reviewer');
  const tier2 = Math.max(review.y + review.h + 44, LH - 116);
  const deploy = mk('deploy', cols.gates, tier2, gW, 64, 'deploy', 'provisioning-api');

  // Main lines: the bus on their left, a line per repo, then the rest as one row.
  const x0 = cols.mains, x1 = W - m - 16;
  const busX = x0 - 18;
  const lineGap = 36;
  const firstY = top + 10;
  const mainsCap = Math.max(2, Math.floor((tier2 - 30 - firstY) / lineGap));
  const shown = mains.slice(0, mainsCap);
  const step = compact ? 14 : 16;
  const n = Math.max(6, Math.floor((x1 - x0 - 24) / step));
  const lines: MainLine[] = shown.map((repo, i) => ({ repo, x0, x1, y: firstY + i * lineGap, step, n }));
  const agg = { x0, x1, y: firstY + shown.length * lineGap - 6 };
  const bus = { x: busX, y0: firstY - 4, y1: tier2 + deploy.h / 2 };

  // Apps: a grid to the right of deploy.
  const appIds = Array.from(world.apps.keys()).sort();
  const cell = compact ? 10 : 12, gapA = compact ? 5 : 6;
  const gx = x0, gy = tier2 + 6;
  const colsA = Math.max(8, Math.floor((x1 - gx) / (cell + gapA)));
  const apps: AppCell[] = appIds.map((app, i) => ({ app, x: gx + (i % colsA) * (cell + gapA), y: gy + Math.floor(i / colsA) * (cell + gapA), s: cell }));
  const rowsA = Math.ceil(appIds.length / colsA);
  const appsBox = { x: gx, y: gy, w: colsA * (cell + gapA) - gapA, h: rowsA * (cell + gapA) - gapA, cols: colsA };

  const lastSrc = sources[sources.length - 1];
  const ret = { y: LH - 26, x0: m - 8, x1: gate.x + gate.w / 2, topY: lastSrc.y };
  const dial = { x: W - m - 12, y: 34, r: 11 };

  const key = [W, H, mains.join(','), groups.map((g) => `${g.id}:${slotsOf(g.engines)}`).join(','), srcRows.join(','), appIds.length].join('|');
  return {
    W, H, m, compact, live, now, queue, cols, titleY, sources, junction, intake: { roadrunner: rr, gha }, engines, slotByEngine,
    gate, review, deploy, bus, mains: lines, agg, apps, appsBox, ret, dial, key,
  };
}

function mk(id: string, x: number, y: number, w: number, h: number, title: string, sub: string): Machine {
  return { id, x, y, w, h, inPort: { x, y: y + h / 2 }, outPort: { x: x + w, y: y + h / 2 }, title, sub };
}

function slotsOf(es: Engine[]): number {
  return es.reduce((n, e) => n + Math.max(1, e.slots), 0);
}

function rank(org: string): number {
  const i = ORG_ORDER.indexOf(org);
  return i < 0 ? 99 : i;
}

/** A cubic S-curve between two ports, as the wires are drawn. */
export function wire(a: Pt, b: Pt): [Pt, Pt, Pt, Pt] {
  const dx = Math.max(24, Math.abs(b.x - a.x) * 0.5);
  return [a, { x: a.x + dx, y: a.y }, { x: b.x - dx, y: b.y }, b];
}

export function bezierAt(p: [Pt, Pt, Pt, Pt], u: number): Pt {
  const v = 1 - u;
  const a = v * v * v, b = 3 * v * v * u, c = 3 * v * u * u, d = u * u * u;
  return { x: a * p[0].x + b * p[1].x + c * p[2].x + d * p[3].x, y: a * p[0].y + b * p[1].y + c * p[2].y + d * p[3].y };
}
