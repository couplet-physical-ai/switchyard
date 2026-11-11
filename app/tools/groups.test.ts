// Group identity on the floor (src/factory/groups.ts), the trend marks' maths
// (src/factory/trendmarks.ts), the persisted hourly ring (src/factory/agg/baseline.ts) and the
// failures-by-cluster order (src/factory/clusters.ts), on the recorded fixtures (v0.5 as recorded,
// and served as v0.4) and on the demo's simulation. Run: bun app/tools/groups.test.ts
import { BOTS_HUE, OTHER_HUE, bindInsights, insights, oklchHex } from '../src/insights.ts';
import { Timeline } from '../src/timeline.ts';
import { createSim } from '../server/sim.ts';
import { Groups, BOTS_LANE, OTHER_LANE } from '../src/factory/groups.ts';
import { POLARITY, curb, ember, failuresOf, ghost, mergeTrends, metricOf, notch, severity, threshold, typical, withDir } from '../src/factory/trendmarks.ts';
import { Baseline, RING_H, baseline, dequant, quant } from '../src/factory/agg/baseline.ts';
import { clusterOrder } from '../src/factory/clusters.ts';
import { Gfx } from '../src/yard/gfx.ts';
import { Cam } from '../src/factory/iso.ts';
import type { Metric, Trend } from '../src/wire.ts';

let fails = 0;
const ok = (c: unknown, m: string) => { if (c) console.log('ok', m); else { fails++; console.log('FAIL', m); } };
const eq = (a: unknown, b: unknown, m: string) => { const x = JSON.stringify(a), y = JSON.stringify(b); ok(x === y, x === y ? m : `${m}: ${x} != ${y}`); };
const HOUR = 3_600_000;

/** ΔE in OKLab between two hex colours. */
function oklab(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  const lin = (c: number) => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  const r = lin((n >> 16) & 255), g = lin((n >> 8) & 255), b = lin(n & 255);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s];
}
const dE = (a: string, b: string) => { const x = oklab(a), y = oklab(b); return Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]); };

function load(snap: any): Timeline {
  const tl = new Timeline();
  tl.load(snap, 0);
  tl.tick(16);
  return tl;
}

// ── fixtures (v0.5 as recorded) ──
const fixture = await Bun.file(new URL('../../contract/fixtures/snapshot.json', import.meta.url)).json();
{
  const tl = load(JSON.parse(JSON.stringify(fixture)));
  bindInsights(tl, () => null);
  const G = new Groups();
  const lanes = G.lanes();
  const ins = insights();
  eq(ins.groups().length, 25, 'fixtures: 25 groups (v0.5 table)');
  eq(lanes.map((l) => l.short), ['software', 'controls', 'hardware', 'optics', 'other teams', 'labs', 'forge', 'ems', 'couplet', 'copper', 'bots'], 'fixtures: §C lane order back → front (four teams, other teams, five orgs, the bots siding)');
  eq(lanes.reduce((n, l) => n + l.members.length, 0), 25, 'fixtures: every group in exactly one lane');
  eq(lanes.find((l) => l.id === OTHER_LANE)!.members.length, 16, 'fixtures: 16 teams fold into "other teams"');
  eq(lanes.reduce((n, l) => n + l.repos, 0), 394, 'fixtures: the lanes cover the 394 repos');
  const hexes = lanes.map((l) => G.hex(l.id));
  eq(new Set(hexes).size, hexes.length, `fixtures: lane hues distinct (${hexes.join(' ')})`);
  eq([G.hex(BOTS_LANE), G.hex(OTHER_LANE)], [BOTS_HUE.hex, OTHER_HUE.hex], 'fixtures: bots and other teams are the neutral hues');
  let minAdj = 9;
  for (let i = 1; i < lanes.length; i++) minAdj = Math.min(minAdj, dE(hexes[i - 1]!, hexes[i]!));
  ok(minAdj >= 0.07, `fixtures: adjacent lanes ΔE_ok ≥ 0.07 (min ${minAdj.toFixed(3)})`);
  // stable: the same order again, and after a new team appears (it folds; nobody moves)
  const again = G.lanes().map((l) => l.id);
  eq(again, lanes.map((l) => l.id), 'fixtures: lane order stable across calls');
  tl.world.apps.set('zz-new', { id: 'zz-new', repo: 'Northwind-Labs/zz', team: 'aaa-new-team', url: '', health: 'up', checked: 0 } as any);
  tl.world.kv.app++;
  eq(new Groups().lanes().map((l) => l.id), lanes.map((l) => l.id), 'fixtures: lane order independent of the instance (deterministic)');
  tl.world.apps.delete('zz-new');
  tl.world.kv.app++;
  // repo → lane
  eq(G.laneOfRepo('Northwind-Labs/amber-basin'), 'team:software', 'fixtures: a software repo → the software lane');
  const hrRepo = [...tl.world.repos.values()].find((r: any) => r.group === 'team:hr')!;
  eq(G.laneOfRepo(hrRepo.id), OTHER_LANE, 'fixtures: an HR repo → other teams');
  const botPr = [...tl.world.prs.values()].find((p: any) => p.bot || /bot/.test(p.author))!;
  eq(G.laneOfPr(botPr as any), BOTS_LANE, 'fixtures: a bot PR → the bots siding');
  // aggregates, sliced
  // warm (the JIT), then a fresh count timed slice by slice (one slice a module-clock turn)
  for (let i = 0; i < 2000 && G.ver === 0; i++) { tl.tick(tl.clock + 16); G.counts(); }
  tl.world.kv.repo++; (tl.world as any).ver++;
  tl.tick(tl.clock + 5000); (tl.world as any).at += 5000;
  let slices = 0;
  const times: number[] = [];
  for (let i = 0; i < 2000 && G.ver === 1; i++) { tl.tick(tl.clock + 16); const s = performance.now(); G.counts(); times.push(performance.now() - s); slices++; }
  times.sort((a, b) => a - b);
  const cnt = G.counts();
  ok(G.ver === 2 && times[Math.floor(times.length * 0.95)]! < 1, `fixtures: a count in ${slices} slices (p95 ${times[Math.floor(times.length * 0.95)]!.toFixed(2)} ms, max ${times[times.length - 1]!.toFixed(2)} ms a slice)`);
  const sum = (k: keyof (typeof cnt.lanes extends Map<string, infer S> ? S : never)) => [...cnt.lanes.values()].reduce((n, s) => n + (s[k] as number), 0);
  const red = [...tl.world.repos.values()].filter((r: any) => r.main?.state === 'failure' || r.main?.state === 'error').length;
  eq(sum('redMains'), red, `fixtures: red mains add up (${red})`);
  eq(sum('repos'), tl.world.repos.size, 'fixtures: repos add up');
  const open = [...tl.world.prs.values()].filter((p: any) => ['draft', 'checks', 'conflict', 'review', 'changes_requested', 'mergeable'].includes(p.phase) || p.draft).length;
  eq(sum('prsOpen'), open, `fixtures: open PRs add up (${open})`);
  ok(cnt.lanes.get(BOTS_LANE)!.prsOpen > 300 && cnt.lanes.get('team:software')!.prsOpen > 0, `fixtures: bot PRs in the siding (${cnt.lanes.get(BOTS_LANE)!.prsOpen})`);
  eq(sum('apps'), tl.world.apps.size - [...tl.world.apps.values()].filter((a: any) => !/\S/.test(String(a.team ?? '')) || /^unknown/.test(String(a.team)) ? !(a.repo && tl.world.repos.has(a.repo)) : false).length, 'fixtures: apps add up (team, else the repo\'s group)');
  ok(cnt.lanes.get('org:Northwind-Labs')!.trend !== null && cnt.lanes.get(OTHER_LANE)!.trend !== null && cnt.lanes.get(BOTS_LANE)!.trend === null, 'fixtures: lane trends (other teams merged, none for bots)');
  const stackSum = cnt.stacks.flat().reduce((n, m) => n + [...m.values()].reduce((a, b) => a + b, 0), 0);
  eq(stackSum, open - cnt.lanes.get(BOTS_LANE)!.prsOpen, 'fixtures: PR-yard stack shares cover the non-bot open PRs');
  // the fleet trend's derived failures/h and its severity
  const ft = ins.trend('fleet')!;
  const fm = failuresOf(ft);
  ok(fm.spark.length === 24 && fm.h1 !== null && Math.abs(fm.h1! - ft.pipelines.h1! * (1 - ft.pass_rate.h1!)) < 0.02, `fixtures: failures/h = pipelines × (1 − pass) (h1 ${fm.h1}, d7 ${fm.d7})`);
  ok(severity(ft.pass_rate, 'fleet', 'pass_rate') > 0, `fixtures: the fleet pass rate is bad → an ember (k ${severity(ft.pass_rate, 'fleet', 'pass_rate').toFixed(2)})`);
  const other = mergeTrends('other', lanes.find((l) => l.id === OTHER_LANE)!.members.map((id) => ins.trend(id)!).filter(Boolean));
  ok(other && other.pipelines.spark.length === 24 && other.id === 'other', 'fixtures: mergeTrends folds 16 teams into one trend');
  // clusters for the return conveyor
  const failed = [...tl.world.pipelines.values()].filter((p: any) => p.state === 'failure' || p.state === 'error').slice(0, 60).map((p: any) => ({ id: p.id, repo: p.repo, at: p.finished }));
  const co = clusterOrder(failed);
  ok(co.reduce((n, r) => n + r.ids.length, 0) === failed.length && co.every((r, i) => i === 0 || co[i - 1]!.newest >= r.newest) && co.every((r) => r.signature.includes(' · ')), `fixtures: clusterOrder groups ${failed.length} failures into ${co.length} runs, newest run first`);
  const multi = co.find((r) => r.ids.length >= 2);
  ok(!!multi && multi.ids.every((id) => insights().clusterOf(id)?.id === multi.clusterId || multi.clusterId.startsWith('~')), `fixtures: a run's members share one cluster (${multi?.signature}, ${multi?.ids.length})`);
}

// ── fixtures served as v0.4 (no groups table: approximated) ──
{
  const f4 = JSON.parse(JSON.stringify(fixture));
  f4.protocol = '0.4';
  for (const k of ['groups', 'clusters', 'flakes', 'trends']) delete f4[k];
  for (const r of f4.repos) delete r.group;
  for (const p of f4.pipelines) { delete p.flaky; for (const w of p.workflows ?? []) for (const st of w.steps ?? []) delete st.cluster; }
  const tl = load(f4);
  bindInsights(tl, () => null);
  const G = new Groups();
  eq(G.lanes().map((l) => l.short), ['software', 'controls', 'hardware', 'optics', 'other teams', 'labs', 'forge', 'ems', 'couplet', 'copper', 'bots'], 'v0.4 fixtures: the same 11 lanes from the approximated groups');
  ok(insights().groups().length === 25, 'v0.4 fixtures: 25 groups approximated');
}

// ── the demo's simulation (v0.5) ──
{
  const sim = createSim({ seed: 7, epoch: Date.UTC(2026, 10, 10, 20, 0), warmupMs: 10 * 60_000 });
  const tl = load(sim.snapshot() as any);
  bindInsights(tl, () => null);
  const G = new Groups();
  const lanes = G.lanes();
  const hexes = lanes.map((l) => G.hex(l.id));
  ok(lanes.length >= 3 && lanes.length <= 11 && lanes[lanes.length - 1]!.id === BOTS_LANE && new Set(hexes).size === hexes.length, `demo: ${lanes.length} lanes, bots last, hues distinct (${lanes.map((l) => l.short).join(', ')})`);
  G.settle();
  const down = sim.cast!.down;
  const lane = G.laneOfGroup(down);
  const t = G.stats(lane)?.trend;
  ok(t && severity(failuresOf(t), lane, 'failures') + severity(t.pass_rate, lane, 'pass_rate') > 0, `demo: the trending-down group (${down}) burns an ember`);
}

// ── trend marks: polarity, direction, thresholds ──
{
  const m = (h1: number | null, d7: number | null, spark: (number | null)[] = []): Metric => ({ h1, h24: h1, d7, dir: 0, spark });
  eq([withDir(m(0.6, 0.8), 'pass_rate').dir, withDir(m(0.6, 0.8), 'pass_rate').bad], [-1, true], 'withDir: the pass rate falling is bad');
  eq([withDir(m(90_000, 50_000), 'run_ms').dir, withDir(m(90_000, 50_000), 'run_ms').bad], [1, true], 'withDir: slower runs are bad');
  eq([withDir(m(30, 60), 'pipelines').dir, withDir(m(30, 60), 'pipelines').bad], [-1, undefined], 'withDir: throughput has no worse side');
  eq(withDir(m(1, 0), 'red').dir, 1, 'withDir: one more red main from zero counts');
  eq(withDir(m(1.1, 1), 'red').dir, 0, 'withDir: within ±15 % is flat');
  eq([POLARITY.pass_rate, POLARITY.intake_ms, POLARITY.deploys], [-1, 1, 0], 'POLARITY');
  eq(threshold(m(10, 8), 'zz', 'failures'), 10, 'threshold: typical × 1.25');
  eq(threshold(m(10, 2), 'zz', 'failures'), 3, 'threshold: at least typical + one failure');
  ok(Math.abs(threshold(m(0.9, 0.9), 'zz', 'pass_rate')! - 0.87) < 1e-9, 'threshold: pass rate floor (typical − 3 points)');
  eq([severity(m(9, 8), 'zz', 'failures'), severity(m(14, 8), 'zz', 'failures') > 0.4], [0, true], 'severity: over the threshold only');
  eq(severity({ ...m(8, 8), bad: true }, 'zz', 'failures'), 0.3, 'severity: the server\'s bad alone is a faint ember');
  eq(metricOf(null, 'red'), null, 'metricOf: no trend');
}

// ── the persisted ring ──
{
  const b = new Baseline();
  const at0 = Date.UTC(2026, 10, 1, 0, 30);
  for (let h = 0; h < 7 * 24; h++) b.record('fleet', 'pipelines', at0 + h * HOUR, 40 + (h % 24));
  for (let h = 0; h < 7 * 24; h++) b.record('fleet', 'failures', at0 + h * HOUR, h % 24 === 13 ? 30 : 4);
  const d7 = b.d7('fleet', 'pipelines')!;
  ok(Math.abs(d7 - 51.5) < 2.5, `ring: d7 ≈ the mean (${d7})`);
  eq(b.p90('fleet', 'failures', at0 + 13 * HOUR), dequant(quant(30)), 'ring: the same hour\'s p90 (the 13:00 spike)');
  eq(b.p90('fleet', 'failures', at0 + 2 * HOUR), dequant(quant(4)), 'ring: another hour\'s p90');
  ok(b.p90('fleet', 'pass_rate', at0 + 13 * HOUR)! < 0.6, 'ring: pass rate derived (its low side at the spike hour)');
  const s = b.serialize();
  ok(s.length < 2000, `ring: serialized ${s.length} B for two full series`);
  const c = new Baseline();
  c.load(s);
  eq([c.d7('fleet', 'pipelines'), c.p90('fleet', 'failures', at0 + 13 * HOUR), c.lastHour], [d7, b.p90('fleet', 'failures', at0 + 13 * HOUR), b.lastHour], 'ring: round trip through storage');
  // a gap clears the hours it skipped; older hours are ignored
  b.record('fleet', 'pipelines', at0 + (7 * 24 + 30) * HOUR, 50);
  eq([b.values('fleet', 'pipelines').length, b.get('fleet', 'pipelines', Math.floor(at0 / HOUR) + 7 * 24 + 10)], [7 * 24 - 30, null], 'ring: a 30 h gap clears 30 hours');
  b.record('fleet', 'pipelines', at0, 999);
  ok(!b.values('fleet', 'pipelines').includes(dequant(quant(999))), 'ring: an hour older than 7 d is ignored');
  eq(new Baseline().d7('fleet', 'pipelines'), null, 'ring: empty → null');
  const e = new Baseline();
  e.seed('g', 'pushes', Array.from({ length: 24 }, (_, i) => i), at0);
  eq([e.values('g', 'pushes').length, Math.round(e.d7('g', 'pushes')!)], [24, 12], 'ring: a 24 h seed gives a day (zeros are samples): d7 is its mean until the week fills');
  let saved = '';
  const store = { load: () => s, save: (x: string) => { saved = x; } };
  const r = baseline();
  r.clear();
  r.bind(store);
  ok(r.d7('fleet', 'pipelines') === d7, 'ring: bound store loads at once');
  r.record('fleet', 'red', at0 + 7 * 24 * HOUR, 3);
  r.maybeSave(1);
  ok(saved.startsWith('b1|') && saved.length < 6000, `ring: saved through the store (${saved.length} B)`);
  // a full 11-lane, 4-metric ring stays under the persisted budget
  const big = new Baseline();
  for (let k = 0; k < 12; k++) for (let h = 0; h < RING_H; h++) for (const mm of ['pipelines', 'failures', 'red', 'pushes'] as const) big.record(`lane${k}`, mm, at0 + h * HOUR, (h * 7 + k) % 50);
  const bs = big.serialize(6000);
  ok(bs.length <= 6000 && bs.includes('lane0'), `ring: 12 keys × 4 metrics × 168 h → ${bs.length} B (≤ 6000)`);
}

// ── painters: they draw (op counts), legible without text (no fillText) ──
{
  let texts = 0, fills = 0, strokes = 0;
  const noop = () => {};
  const ctx = new Proxy({}, {
    get: (_t, k) => (k === 'fillText' ? () => { texts++; } : k === 'fill' ? () => { fills++; } : k === 'stroke' ? () => { strokes++; } : k === 'measureText' ? () => ({ width: 6 }) : k === 'createRadialGradient' ? () => ({ addColorStop: noop }) : noop),
    set: () => true,
  }) as any;
  const g = new Gfx();
  g.begin(ctx, 2);
  const cam = new Cam();
  cam.fit(1440, 900, 84, 58);
  const tr: Metric = { h1: 9, h24: 6, d7: 5, dir: 1, bad: true, spark: Array.from({ length: 24 }, (_, i) => (i > 20 ? 12 : 4)) };
  ghost(g, cam, 10, 10, 50, 40, 12);
  curb(g, cam, tr, [10, 60], [100, 60], { key: 'zz-paint', metric: 'failures', depth: 10 });
  ember(g, cam, 0, 0, 100, 100, 0.8);
  const w = notch(g, 100, 100, tr, 'failures');
  ok(texts === 0 && fills >= 4 && strokes >= 3 && w > 0, `painters: ghost, curb, ember, notch draw ${fills} fills and ${strokes} strokes, no text`);
  eq(notch(g, 0, 0, { ...tr, dir: 0 }, 'failures'), 0, 'notch: flat draws nothing');
  ok(typical(tr, 'fleet', 'failures') === 5, 'typical: the server\'s d7 first');
}

console.log(fails ? `groups.test: ${fails} FAILED` : 'groups.test: all ok');
process.exit(fails ? 1 : 0);
