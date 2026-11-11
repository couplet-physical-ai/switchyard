#!/usr/bin/env bun
// Checks the canvas tables and every projection against the recorded real fleet
// (../contract/fixtures, read here, never copied), then against sparse copies of it: every
// optional field the contract allows to be omitted, omitted, and some required ones too, plus
// unknown enum values. Nothing may throw. Also times a Mainlines and a PRs draw (a recording
// context: the data module's own cost, not the host's raster).
//
//   bun tools/table-check.ts [--fixtures DIR] [--seed N]

import type { Ctx2D, Frame } from '../app.contract.d.ts';
import { World } from '../src/world.ts';
import type { Frame as WireFrame, Snapshot } from '../src/wire.ts';
import { MainlinesModel } from '../src/table/mainlines.ts';
import { PrsModel } from '../src/table/prs.ts';
import { fleet, journeyView, prDetailView, prRow, search } from '../src/project.ts';
import { Timeline } from '../src/timeline.ts';
import { drawStatic, LiveLayer } from '../src/yard/draw.ts';
import { layout, pickMains } from '../src/yard/layout.ts';
import { Motion } from '../src/yard/motion.ts';

const argv = process.argv.slice(2);
const opt = (n: string) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
const dir = opt('--fixtures') ?? `${import.meta.dir}/../../contract/fixtures`;
let seed = Number(opt('--seed') ?? 1);
const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);

/** A context that records how many calls a draw makes (and measures text as mono 0.6 em). */
function recorder(): Ctx2D & { calls: number } {
  const st: Record<string, unknown> = { calls: 0, font: '12px x' };
  return new Proxy(st, {
    get(t, k) {
      if (k in t) return t[k as string];
      if (k === 'measureText') return (s: string) => { (t.calls as number)++; const px = Number(/(\d+(?:\.\d+)?)px/.exec(String(t.font))?.[1] ?? 12); return { width: String(s ?? '').length * px * 0.6 }; };
      return () => { (t.calls as number)++; };
    },
    set(t, k, v) { t[k as string] = v; return true; },
  }) as unknown as Ctx2D & { calls: number };
}

const frame = (time: number, width = 1408, height = 780): Frame => ({ time, mounted: 0, cause: 'frame', causes: [], width, height, pixelWidth: width * 2, pixelHeight: height * 2, scale: 2 });

let failures = 0;
function check(name: string, f: () => void): void {
  try { f(); } catch (e) { failures++; console.log(`FAIL ${name}: ${(e as Error)?.stack ?? e}`); }
}

const snap = (await Bun.file(`${dir}/snapshot.json`).json()) as Snapshot;
const frames = (await Bun.file(`${dir}/hour.jsonl`).text()).split('\n').filter(Boolean).map((l) => JSON.parse(l) as WireFrame);

function exercise(w: World, label: string, verbose = false): void {
  const now = w.at;
  const ml = new MainlinesModel();
  const pr = new PrsModel();
  check(`${label} mainlines`, () => {
    for (const [org, filter, q] of [['', '', ''], ['Northwind-Labs', '', ''], ['', 'red', ''], ['', 'building', ''], ['', '', 'a']]) ml.project(w, org, filter, q);
    ml.project(w, '', '', '');
    const ctx = recorder();
    let t = 0;
    ml.table.setFocus(ml.table.keys[3] ?? '');
    for (let i = 0; i < 30; i++) { ml.draw(ctx, frame((t += 16)), now, true); if (i === 5) ml.table.syncWheel(0); if (i === 6) ml.table.syncWheel(2000); }
    ml.table.pointer(500, 300);
    for (let i = 0; i < 30; i++) ml.draw(ctx, frame((t += 16)), now, true);
    const p = ml.table.pick(600, 300);
    if (p) ml.routeOf(p.key);
    for (const w2 of [960, 1200, 2880]) ml.draw(ctx, frame((t += 16), w2, 600), now, true);
    if (verbose) console.log(`mainlines: ${JSON.stringify(ml.counts)} · top after wheel 2000: ${ml.table.topKey()} · painted ${ml.table.lastPainted} rows`);
  });
  check(`${label} prs`, () => {
    for (const f of ['open', 'ready', 'blocked', 'bots', 'shipped']) pr.project(w, '', f, '', '');
    pr.project(w, '', 'open', '', '');
    const ctx = recorder();
    let t = 0;
    pr.table.setFocus(pr.table.keys[0] ?? '');
    for (let i = 0; i < 30; i++) pr.draw(ctx, frame((t += 16)), now, true);
    pr.table.pointer(500, 200);
    for (let i = 0; i < 30; i++) pr.draw(ctx, frame((t += 16)), now, true);
    if (verbose) console.log(`prs: ${JSON.stringify(pr.counts)} · first ${pr.table.keys[0]}`);
  });
  check(`${label} fleet`, () => { fleet(w, now); });
  check(`${label} yard`, () => {
    // the yard draws from a timeline; this one holds the world under test
    const tl = new Timeline();
    (tl as unknown as { world: World }).world = w;
    tl.playhead = now;
    const live = new LiveLayer();
    let L = layout(1440, 820, w, pickMains(w, 10, []));
    const mo = new Motion(() => L, () => t);
    let t = 1000;
    const ctx = recorder();
    for (const [W, H] of [[1440, 820], [960, 600], [2880, 1640]]) {
      L = layout(W, H, w, pickMains(w, 10, []));
      drawStatic(ctx, L);
      mo.sync(w);
      for (let i = 0; i < 20; i++) { t += 16; mo.update(t, w, 16); live.draw(ctx, L, tl, mo, t, false); }
    }
  });
  check(`${label} search`, () => { for (const q of ['', 'a', 'zinc', '#12', 'abcd', '1']) search(w, q, now); });
  check(`${label} pr detail`, () => {
    for (const p of Array.from(w.prs.values()).slice(0, 50)) { prRow(p, now, w); prDetailView({ pr: p, commits: [], pipelines: [] } as never, now, w); }
    prDetailView({} as never, now, w);
    prDetailView(null, now, w);
  });
  check(`${label} journey`, () => {
    for (const c of Array.from(w.commits.values()).slice(0, 40)) {
      journeyView({ commit: c, pipelines: (c.pipelines ?? []).map((id) => w.pipelines.get(id)).filter(Boolean), deploys: [], spans: [{ id: 't1', name: 'npm', start: c.at, ms: 4000 }] } as never, now);
    }
    journeyView({ commit: null, pipelines: null, deploys: null, spans: null } as never, now);
  });
}

// 1. the real fleet, then the real hour applied to it
const w = new World();
w.load(structuredClone(snap));
console.log(`fixtures: ${w.repos.size} repos, ${w.prs.size} prs, ${frames.length} frames`);
exercise(w, 'snapshot', true);
for (const f of frames) w.apply(f);
exercise(w, 'after the hour');

// 2. sparse: optional fields dropped at random, many required ones too, unknown enum values,
//    null watcher / stats (the wire omits; it never sends null inside an entity)
const OPTIONAL = new Set(['main', 'recent', 'links', 'checks', 'review', 'workflows', 'steps', 'culprit', 'app', 'heat', 'open_prs', 'author', 'title', 'sha', 'at', 'since', 'state', 'phase', 'repo', 'number', 'running', 'slots', 'health', 'url', 'lane', 'name', 'org', 'head', 'updated', 'created', 'started', 'finished', 'pipelines', 'items', 'blocked_by', 'stale_ms', 'draft', 'bot']);
function sparsify(x: unknown, p: number): unknown {
  if (Array.isArray(x)) return x.map((v) => sparsify(v, p));
  if (!x || typeof x !== 'object') return x;
  const o: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(x)) {
    if (k !== 'id' && OPTIONAL.has(k) && rand() < p) continue;
    if ((k === 'state' || k === 'phase' || k === 'health' || k === 'lane' || k === 'kind') && rand() < p / 2) { o[k] = 'mystery'; continue; }
    o[k] = sparsify(v, p);
  }
  return o;
}
for (const p of [0.1, 0.3, 0.6, 1]) {
  const s = sparsify(structuredClone(snap), p) as Snapshot;
  s.watcher = rand() < 0.5 ? null : s.watcher;
  s.stats = rand() < 0.5 ? null : s.stats;
  const ws = new World();
  check(`sparse ${p} load`, () => ws.load(s));
  exercise(ws, `sparse ${p}`);
  // frames stay well formed (world.apply's own); the entities they carry are sparse
  const sparseOp = (o: Record<string, unknown>) => ({ ...o, ...(o.v ? { v: sparsify(o.v, p) } : {}), ...(o.e ? { e: { ...(sparsify(o.e, p) as object), k: (o.e as { k: string }).k } } : {}) });
  check(`sparse ${p} frames`, () => { for (const f of frames.slice(0, 300)) ws.apply({ ...f, ops: (f as { ops: Record<string, unknown>[] }).ops.map(sparseOp) } as WireFrame); });
  exercise(ws, `sparse ${p} after frames`);
}

// 3. cost: the data module's share of a draw (rows in view only), 1440×900 and Retina-sized
const ml = new MainlinesModel();
ml.project(w, '', '', '');
const pr = new PrsModel();
pr.project(w, '', 'open', '', '');
for (const [name, m, n] of [['mainlines', ml, ml.table.keys.length], ['prs', pr, pr.table.keys.length]] as const) {
  const ctx = recorder();
  let t = 0;
  m.table.setFocus(m.table.keys[10] ?? '');
  for (let i = 0; i < 60; i++) m.draw(ctx, frame((t += 16)), w.at, true);
  const t0 = performance.now();
  const N = 600;
  for (let i = 0; i < N; i++) { m.table.syncWheel(i * 37); m.draw(ctx, frame((t += 16)), w.at, true); }
  const ms = (performance.now() - t0) / N;
  console.log(`${name}: ${n} rows, ${m.table.lastPainted} painted a frame, ${(ctx.calls / (N + 60)).toFixed(0)} context calls a frame, ${ms.toFixed(3)} ms a draw (bun JIT; Hermes is slower)`);
}

console.log(failures ? `${failures} FAILED` : 'all checks passed');
process.exit(failures ? 1 : 0);
