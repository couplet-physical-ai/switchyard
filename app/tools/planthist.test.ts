// The machine walls' 24 h (src/factory/planthist.ts): a server history (`GET /api/v1/engine/{id}
// /history`, one sample a minute, columnar) folded into the wall's buckets → the tide line's
// points; offline minutes and the time before the record are gaps; a host's agents summed; the
// client seam's fallback (no server: ≈ 2 h of occupancy at 5 min) through the same fold; the
// pump asks from a source at most once a minute. Run: bun app/tools/planthist.test.ts
import { bindInsights, insights } from '../src/insights.ts';
import { Timeline } from '../src/timeline.ts';
import { DAY_MS, PlantHist, WALL_BUCKETS, dataRuns, emptyTide, foldTide, historyIds, smoothed, tidePoints, type HistDoc } from '../src/factory/planthist.ts';

let fails = 0;
const ok = (c: unknown, m: string) => { if (c) console.log('ok', m); else { fails++; console.log('FAIL', m); } };
const eq = (a: unknown, b: unknown, m: string) => { const x = JSON.stringify(a), y = JSON.stringify(b); ok(x === y, x === y ? m : `${m}: ${x} != ${y}`); };
const near = (a: number, b: number, m: string, e = 1e-4) => ok(Math.abs(a - b) <= e, `${m} (${a} ≈ ${b})`);
const MIN = 60_000;

/** A server answer: 1440 minutes ending at `end`, `f(i)` → [busy, slots, cpu, mem] or null (offline). */
function serverDoc(id: string, end: number, f: (i: number) => [number, number, number, number] | null, repos: { repo: string; runs: number }[] = []): HistDoc {
  const n = 1440, from = end - n * MIN;
  const busy: (number | null)[] = [], slots: (number | null)[] = [], cpu: (number | null)[] = [], mem: (number | null)[] = [], load: (number | null)[] = [];
  for (let i = 0; i < n; i++) {
    const v = f(i);
    busy.push(v ? v[0] : null); slots.push(v ? v[1] : null); cpu.push(v ? v[2] : null); mem.push(v ? v[3] : null); load.push(v ? 1 : null);
  }
  return { id, kind: 'dagger', host: 'VM 1', from, step_ms: MIN, n, busy, slots, cpu, mem, load, repos, source: 'server' };
}

const END = 1_794_400_000_000 - (1_794_400_000_000 % MIN);

// ── a server history: the record began 16 h ago, an outage 2 h long in the middle ──
{
  const doc = serverDoc('dagger:VM 1', END, (i) => {
    if (i < 480) return null; // before the record: the first 8 h
    if (i >= 900 && i < 1020) return null; // offline for 2 h
    const busy = i >= 1380 ? 6 : i % 15 < 5 ? 3 : 0; // the last hour saturated; else 3 of 6 busy a third of each 15 min
    return [busy, 6, i >= 1380 ? 95 : 40, 50];
  }, [{ repo: 'o/a', runs: 3 }, { repo: 'o/b', runs: 5 }]);
  const t = foldTide('VM 1', [doc]);
  eq([t.n, t.source, t.to, t.from], [WALL_BUCKETS, 'server', END, END - DAY_MS], 'server: 96 buckets (15 min, the machine lens\'s) over the 24 h ending at the newest minute');
  ok(Number.isNaN(t.busy[0]!) && Number.isNaN(t.busy[31]!), 'server: no data before the record began → gap (NaN)');
  near(t.busy[32]!, 1 / 6, 'server: a 15-min bucket a third at 3/6, else idle → mean busy/slots 1/6');
  near(t.peak[32]!, 0.5, 'server: …and its peak is 3/6');
  ok(Number.isNaN(t.busy[60]!) && Number.isNaN(t.busy[67]!), 'server: the offline minutes → gap');
  near(t.busy[95]!, 1, 'server: the saturated last hour → tide at the top');
  near(t.peak[95]!, 1, 'server: …peak 1 (the wall ticks it red)');
  near(t.cpu[95]!, 0.95, 'server: cpu as a fraction (95 % → 0.95)');
  ok(Number.isNaN(t.mem[64]!), 'server: mem offline → gap too');
  eq(dataRuns(t.busy), [[32, 60], [68, 96]], 'server: two runs of data around the outage');
  near(t.covered, (96 - 32 - 8) / 96, 'server: covered = buckets with data / 96');
  eq(t.repos.map((r) => r.repo), ['o/b', 'o/a'], 'server: repos served, most runs first');
  // the tide line's points: one polyline per run, x in the window, y the value
  const pts = tidePoints(t, 'busy');
  eq(pts.length, 2, 'tide: the gap splits the line into two polylines');
  eq([pts[0]!.length, pts[1]!.length], [28, 28], 'tide: a point per bucket of each run');
  near(pts[0]![0]![0], 32.5 / 96, 'tide: a point sits at its bucket\'s middle (x)');
  near(pts[1]![pts[1]!.length - 1]![1], 1, 'tide: the last point is the saturated hour (y = 1)');
  ok(pts.every((l) => l.every(([x, y]) => x >= 0 && x <= 1 && y >= 0 && y <= 1)), 'tide: every point inside the wall\'s unit square');
  // smoothing keeps the gaps
  const s = smoothed(t.cpu, 1);
  ok(Number.isNaN(s[63]!) && !Number.isNaN(s[59]!), 'ribbons: smoothing keeps the gap and never leaks across it');
  near(s[95]!, 0.95, 'ribbons: the last bucket averages with its only neighbour');
}

// ── a lone bucket of data still draws (a short flat stroke) ──
{
  const doc = serverDoc('x', END, (i) => (i >= 700 && i < 705 ? [1, 2, 10, 10] : null));
  const t = foldTide('x', [doc]);
  const pts = tidePoints(t, 'busy');
  eq(pts.length, 1, 'lone: one polyline');
  eq(pts[0]!.length, 2, 'lone: a flat stroke across its bucket (two points)');
  near(pts[0]![1]![0] - pts[0]![0]![0], 1 / 96, 'lone: as wide as one bucket');
}

// ── a host with no Dagger engine: its agents' histories summed minute by minute ──
{
  const a = serverDoc('wp-agent-1', END, (i) => (i >= 1300 ? [3, 3, NaN, NaN] : [0, 3, NaN, NaN]));
  const b = serverDoc('wp-agent-2', END, (i) => (i >= 1300 ? [0, 3, NaN, NaN] : null));
  for (const d of [a, b]) { d.cpu = d.cpu.map(() => null); d.mem = d.mem.map(() => null); }
  const t = foldTide('VM 1', [a, b]);
  near(t.busy[95]!, 0.5, 'agents: 3 of 3 busy + 0 of 3 → 3/6 for the host');
  near(t.busy[60]!, 0, 'agents: where one agent is offline the other still counts (0 of 3)');
  ok(Number.isNaN(t.cpu[95]!), 'agents: no cpu reading → a gap, not zero');
  eq(t.ids, ['wp-agent-1', 'wp-agent-2'], 'agents: both ids folded');
}

// ── nothing answered: an empty tide (the wall shows only its time axis) ──
{
  const t = foldTide('VM 9', [null, undefined]);
  eq([t.source, t.covered, dataRuns(t.busy).length], ['none', 0, 0], 'empty: no answer → no data, no line');
  eq(emptyTide('k').n, WALL_BUCKETS, 'empty: the same 96 buckets');
}

// ── the fallback: no server history (404, the demo, the fixtures) → the client seam ──
const fixture = await Bun.file(new URL('../../contract/fixtures/snapshot.json', import.meta.url)).json();
{
  const tl = new Timeline();
  tl.load(JSON.parse(JSON.stringify(fixture)), 0);
  tl.tick(16);
  bindInsights(tl, () => null);
  const w = tl.world;
  eq(historyIds(w, 'VM 154', ['wp-agent-3', 'wp-agent-4']), ['wp-agent-3', 'wp-agent-4'], 'fallback: no Dagger host in the fixtures → the agents\' ids');
  const docs = await Promise.all(['wp-agent-3', 'wp-agent-4'].map((id) => insights().engineHistoryAsync(id)));
  ok(docs.every((d) => d?.source === 'client'), 'fallback: no upstream → the client seam answers (source client)');
  const t = foldTide('VM 154', docs);
  eq(t.source, 'client', 'fallback: the folded tide says so');
  ok(t.covered > 0 && t.covered <= 0.13, `fallback: ≈ 2 h of the 24 h carry data (${(t.covered * 24).toFixed(1)} h)`);
  const runs = dataRuns(t.busy);
  ok(runs.length >= 1 && runs[runs.length - 1]![1] === t.n, 'fallback: the data ends at the wall\'s right end (now)');
  ok(Number.isNaN(t.busy[0]!), 'fallback: the hours the client never saw are a gap, not zero');
  const busyNow = (w.engines.get('wp-agent-4')?.running.length ?? 0) / 6;
  ok(t.busy[t.n - 1]! >= 0 && t.busy[t.n - 1]! <= 1, `fallback: the newest bucket is a fraction of the host's 6 slots (now ${busyNow.toFixed(2)})`);
}

// ── the pump: from a source, once a minute per machine, folded on answer ──
{
  const asked: string[] = [];
  const H = new PlantHist();
  H.fetch = async (id) => { asked.push(id); return serverDoc(id, END, () => [1, 2, 50, 50]); };
  H.pump([{ key: 'VM 1', ids: ['dagger:VM 1'] }, { key: 'GHA', ids: [] }], 1000);
  H.pump([{ key: 'VM 1', ids: ['dagger:VM 1'] }], 1250); // in flight: not asked again
  await new Promise((r) => setTimeout(r, 5));
  eq(asked, ['dagger:VM 1'], 'pump: one fetch per machine; a machine without engines (hosted) is never asked');
  ok(H.tide('VM 1') !== null && H.ver === 1, 'pump: the answer is folded and bumps ver (the floor repaints)');
  H.pump([{ key: 'VM 1', ids: ['dagger:VM 1'] }], 30_000);
  await new Promise((r) => setTimeout(r, 5));
  eq(asked.length, 1, 'pump: not again within a minute');
  H.pump([{ key: 'VM 1', ids: ['dagger:VM 1'] }], 62_000);
  await new Promise((r) => setTimeout(r, 5));
  eq([asked.length, H.ver], [2, 1], 'pump: asked again after a minute; an unchanged answer does not repaint');
}

// fab-w6b: the wall's ghost line, the machine's typical busy/slots (the median of its buckets with data)
{
  const { typical } = await import('../src/factory/plant.ts');
  const t = emptyTide('m', 6);
  ok(Number.isNaN(typical(t)), 'typical: no data → NaN (no ghost)');
  const u = emptyTide('m', 6);
  u.busy.set([0.1, NaN, 0.5, 0.2, NaN, 0.9]);
  near(typical(u), 0.35, 'typical: the median of the buckets with data (gaps skipped)');
  u.busy[0] = 1; // cached per fold: a fold is a new tide
  near(typical(u), 0.35, 'typical: cached per tide');
}

// w2-engine2 (REVIEW-iter3 #3): a slot's recent past. Runs dealt to the lowest free slot in start
// order; the afterimage fades in sixths over 30 min; the lip ticks hold the last hour.
{
  const { dealSlots, afterK, laneArrivals, AFTER_MS, TICKS_MS } = await import('../src/factory/planthist.ts');
  const now = 10 * 3_600_000, M = 60_000;
  const run = (pid: string, lane: string, s: number, e: number, running = false) => ({ pid, lane, start: now - s * M, end: running ? now : now - e * M, running, red: false });
  const past = dealSlots([run('a', 'labs', 50, 40), run('b', 'soft', 45, 30), run('c', 'labs', 35, 20), run('d', 'ems', 10, 0, true), run('old', 'ems', 200, 190)], 3, now);
  eq(past.length, 3, 'dealSlots: one past per slot');
  // old → slot 0 (ends 190 min ago); a 50→40 → slot 1 (never used: free longest); b 45→30 → slot 2;
  // c 35→20 → slot 0 (free since 190); d (running, from 10) → slot 1 (free since 40, the longest)
  eq(past.map((s) => s.last?.pid ?? ''), ['c', 'a', 'b'], 'dealSlots: each slot keeps its last ENDED job (a running one is not an afterimage)');
  eq(past.map((s) => s.runs.map((r) => r.pid).join('')), ['c', 'ad', 'b'], 'dealSlots: jobs go round the slots free the longest (an idle machine shows its last few side by side)');
  ok(!past.some((s) => s.runs.some((r) => r.pid === 'old')), 'dealSlots: a job older than an hour leaves no lip tick');
  eq(dealSlots([], 0, now).length, 1, 'dealSlots: at least one slot');
  eq([afterK(0), afterK(AFTER_MS / 2), afterK(AFTER_MS - 1), afterK(AFTER_MS), afterK(-5)], [1, 0.5, 1 / 6, 0, 0], 'afterK: 1 → 0 over 30 min, in sixths; nothing after 30 min or for a future end');
  ok(TICKS_MS === 3_600_000, 'the lip is the last hour');
  const sparks: Record<string, (number | null)[]> = { 'team:a': [...new Array(22).fill(0), 2, 4], 'team:b': [...new Array(23).fill(null), 1], 'team:c': [3] };
  const { rows, max } = laneArrivals([{ id: 'A', members: ['team:a', 'team:b'] }, { id: 'C', members: ['team:c', 'team:none'] }], (id) => sparks[id]);
  eq([Array.from(rows[0]!.slice(22)), max, rows[1]![23]], [[2, 5], 5, 3], 'laneArrivals: a lane sums its groups\' hourly runs, a short spark ends at now');
}

// w2-engine2 (REVIEW-iter3 #6): a flaky cluster's heap is hatched, never solid red
{
  const { flakyCluster } = await import('../src/factory/clusters.ts');
  eq([flakyCluster({ count: 67, flaky: 27 }), flakyCluster({ count: 19, flaky: 0 }), flakyCluster({ count: 8, flaky: 4 }), flakyCluster({ count: 40, flaky: 3 }), flakyCluster({ count: 4, flaky: 1 })], [true, false, true, false, false], 'flakyCluster: ≥ a quarter of its 24 h failures (and ≥ 2) passed on the same sha');
  eq([flakyCluster(null, { n: 3, flaky: 2 }), flakyCluster(null, { n: 3, flaky: 1 }), flakyCluster(undefined, { n: 1, flaky: 0 })], [true, false, false], 'flakyCluster: no record → half its parked failures flaky');
  eq([flakyCluster({ count: 1 }, { n: 1, flaky: 0 }, { flips: 27, failures: 67 }), flakyCluster({ count: 1 }, { n: 1, flaky: 0 }, { flips: 1, failures: 67 })], [true, false], 'flakyCluster: a cluster opened again today keeps its step\'s flakes (the cron: 27 of 67)');
}

// p3 (#5): one flaky test for the callout and the belt: the coffee check's (a third flaky, or
// flaky at all at ≥ 10 a day, holding no main line red); the belt names a solid heap first
{
  const { flakyCalled, namedHeap } = await import('../src/factory/clusters.ts');
  eq([flakyCalled({ open: 0, count: 73, flaky: 3 }), flakyCalled({ open: 0, count: 6, flaky: 2 }), flakyCalled({ open: 0, count: 6, flaky: 1 }), flakyCalled({ open: 1, count: 73, flaky: 30 }), flakyCalled({ open: 0, count: 72, flaky: null }), flakyCalled({ open: 0, count: 1, flaky: 1 })], [true, true, false, false, false, true], 'flakyCalled: the callout\'s test (≥ ⅓ flaky, or any flake at ≥ 10 a day; never a cluster holding a main line red)');
  const H = (cl: string, repos: number, n: number, flakyCl: boolean) => ({ k: 0, cl, step: cl, u0: 0, u1: 1, h: n, unit: 1, n, repos, repoList: [], ids: [], flaky: new Set<string>(), newest: '', flakyCl });
  eq([namedHeap([H('cron', 3, 9, true), H('build', 1, 2, false)])?.cl, namedHeap([H('cron', 3, 9, true)])?.cl, namedHeap([]) ?? null], ['build', 'cron', null], 'namedHeap: the widest solid heap, a flaky one only when no solid one is on the belt');
}

// w2-engine2 (WOW #1): a failed run's light packet drops off the scanner into its heap
{
  const { cutAtHeap } = await import('../src/factory/packets.ts');
  const { PLAN } = await import('../src/factory/layout.ts');
  const R = PLAN.RETURN_V;
  eq(cutAtHeap([[0, 10], [PLAN.SCAN_U, 10], [PLAN.SCAN_U, R], [24, R], [24, 40]], 900), [[0, 10], [PLAN.SCAN_U, 10], [PLAN.SCAN_U, R], [900, R]], 'cutAtHeap: down the scanner, along the conveyor to the heap, no further');
}

// v4-heaps (REVIEW-iter3b #1–#3): failure CONCENTRATION, the shared contract with v4-verdict
{
  const { concentration, errorShape } = await import('../src/factory/clusters.ts');
  const NOW = 1_794_411_679_000, M = 60_000;
  eq([errorShape('error: …/admin/run-renewal-check returned HTTP 000'), errorShape('process exited with code 137'), errorShape('context deadline exceeded'), errorShape(null), errorShape('leaks found: N')], ['HTTP 000', 'exit 137', 'timed out', '', ''], 'errorShape: one shape for many endpoints');
  let n = 0;
  const P = (repo: string, state: string, ago: number, event = 'push', step = 'test', cluster?: string) => [`p${n++}`, {
    id: `p${n}`, lane: 'roadrunner', repo, number: n, sha: 's', branch: 'main', event, state, created: NOW - ago - 5 * M, finished: NOW - ago, url: '',
    workflows: [{ name: 'ci', state, steps: [{ name: step, state, cluster }] }],
  }] as const;
  const clusters = new Map([['f:a', { id: 'f:a', signature: 'x', step: 'patent-integrity-cron', class: 'exit', line: 'error: …/admin/run-patent-integrity-check returned HTTP 000', count: 1, count_1h: 1, repos: [], repo_count: 1, groups: [], first_seen: 0, last_seen: 0, examples: [], open: 1 }]]);
  const lt = 'Northwind-Labs/legal-tracker';
  // the 15:40Z hour: 27 runs, 8 failures, all legal-tracker's crons (three jobs, HTTP 000)
  const runs = [
    ...['notification-outbox', 'esign-sync', 'patent-integrity-cron'].flatMap((s, i) => [P(lt, 'failure', (5 + i) * M, 'cron', s, s === 'patent-integrity-cron' ? 'f:a' : undefined), P(lt, 'failure', (25 + i) * M, 'cron', s)]),
    P(lt, 'failure', 45 * M, 'cron', 'notification-outbox'), P(lt, 'error', 50 * M, 'cron', 'esign-sync'),
    ...Array.from({ length: 18 }, (_, i) => P(`Northwind-Labs/r${i % 6}`, 'success', (i + 2) * 3 * M)),
    P('Northwind-Labs/r9', 'running', 2 * M),
    P('Northwind-Labs/old', 'failure', 70 * M), // outside the hour
  ];
  const w = { at: NOW, ver: 1, pipelines: new Map(runs as any), clusters: clusters as any };
  const c = concentration(w, NOW, 60 * M);
  eq(c && [c.key, c.label, c.repo, c.fails, c.total, c.share, c.runs, c.fleetRuns, c.error, c.jobs], ['crons:Northwind-Labs/legal-tracker', 'legal-tracker crons', lt, 8, 8, 1, 8, 26, 'HTTP 000', 3], 'concentration: 8 of 8 fails are legal-tracker\'s crons (HTTP 000, 3 jobs)');
  // spread failures: no repo holds 60 %
  const w2 = { at: NOW, ver: 1, pipelines: new Map([P('a/x', 'failure', M), P('a/x', 'failure', 2 * M), P('a/y', 'failure', 3 * M), P('a/z', 'failure', 4 * M)] as any) };
  eq(concentration(w2, NOW, 60 * M), null, 'concentration: 2 of 4 is not a concentration (< 60 %)');
  const w3 = { at: NOW, ver: 1, pipelines: new Map([P('a/x', 'failure', M), P('a/y', 'success', 2 * M)] as any) };
  eq(concentration(w3, NOW, 60 * M), null, 'concentration: one failure is not a concentration (< 2)');
  const w4 = { at: NOW, ver: 1, pipelines: new Map([P('a/x', 'failure', M), P('a/x', 'failure', 2 * M), P('a/x', 'failure', 3 * M, 'cron'), P('a/y', 'failure', 4 * M, 'push', 'lint')] as any) };
  const c4 = concentration(w4, NOW, 60 * M);
  eq(c4 && [c4.key, c4.label, c4.fails, c4.total, c4.error], ['repo:a/x', 'x', 3, 4, ''], 'concentration: 3 of 4 on one repo\'s pushes is the repo, not its crons');
  eq(concentration({ at: NOW, ver: 1, pipelines: new Map() }, NOW, 60 * M), null, 'concentration: no failures, null');
}

// v4-heaps (REVIEW-iter3b #3): the belt names the heap group failing NOW; one repo's crons are one
// group; one state fact; a closed cluster is never named red
{
  const { heapFact, heapGroups, mergeKeyOf, namedGroup } = await import('../src/factory/clusters.ts');
  const pipes = new Map<string, any>([['a', { event: 'cron' }], ['b', { event: 'cron' }], ['c', { event: 'push' }], ['d', { event: 'push' }]]);
  eq([
    mergeKeyOf([{ id: 'a', repo: 'o/lt' }, { id: 'b', repo: 'o/lt' }], null, pipes),
    mergeKeyOf([{ id: 'c', repo: 'o/lt' }], 'error: …/admin/x returned HTTP 000', pipes),
    mergeKeyOf([{ id: 'c', repo: 'o/lt' }, { id: 'd', repo: 'o/x' }], 'HTTP 000', pipes),
    mergeKeyOf([{ id: 'c', repo: 'o/lt' }], 'leaks found: N', pipes),
    mergeKeyOf([], null, pipes),
  ], ['crons:o/lt', 'err:o/lt|HTTP 000', '', '', ''], 'mergeKeyOf: one repo\'s crons, or one repo\'s one error shape; several repos never merge');
  const H = (cl: string, o: { n?: number; repos?: number; rate?: number; open?: number; last?: number; count?: number; heat?: 'red' | 'flow' | 'quiet'; grp?: string; repo?: string; error?: string; flakyCl?: boolean; u1?: number }) => ({
    k: 0, cl, step: cl, u0: 0, u1: o.u1 ?? 1, h: 1, unit: 1, n: o.n ?? 1, repos: o.repos ?? 1, repoList: [], ids: [], flaky: new Set<string>(), newest: '', flakyCl: o.flakyCl ?? false,
    rate: o.rate, open: o.open, last: o.last, count: o.count, heat: o.heat, grp: o.grp, repo: o.repo, error: o.error,
  });
  // 14:38Z: notification-outbox closed (72 in 24 h, none this hour) against the crons failing now
  const closed = H('notification-outbox', { n: 1, rate: 0, open: 0, last: 1000, count: 72, heat: 'quiet' });
  const live = H('crons', { n: 8, rate: 8, open: 1, last: 5000, count: 76, heat: 'red', grp: 'crons:Northwind-Labs/legal-tracker', repo: 'Northwind-Labs/legal-tracker', error: 'HTTP 000' });
  const scan = H('security-scan', { n: 1, repos: 8, rate: 1, open: 7, last: 4000, count: 20, heat: 'red' });
  const g1 = namedGroup([closed, live, scan]);
  eq(g1 && [g1.label, g1.error, g1.heat, heapFact(g1, 6000)], ['legal-tracker crons', 'HTTP 000', 'red', '8 / h'], 'namedGroup: the most failures this hour first (not the 24 h count, not the widest): legal-tracker crons · HTTP 000 · 8 / h');
  eq(namedGroup([closed, H('b', { rate: 1, open: 0, last: 10 }), H('c', { rate: 1, open: 2, last: 5 })])?.head.cl, 'c', 'namedGroup: ties on the hour → the most mains held red');
  eq(namedGroup([H('b', { rate: 1, open: 1, last: 10 }), H('c', { rate: 1, open: 1, last: 50 })])?.head.cl, 'c', 'namedGroup: then the newest failure');
  eq(namedGroup([H('a', { rate: 9, flakyCl: true }), H('b', { rate: 1 })])?.head.cl, 'b', 'namedGroup: a solid group before a flaky one');
  const gs = heapGroups([closed, live, scan]);
  eq(gs.map((g) => g.heat), ['quiet', 'red', 'red'], 'heapGroups: a closed cluster (open 0, none this hour) is quiet: gray-red, never red');
  eq([heapFact({ rate: 1, open: 7, last: 0 }, 0), heapFact({ rate: 4, open: 1, last: 0 }, 0), heapFact({ rate: 0, open: 1, last: 0 }, 0), heapFact({ rate: 0, open: 0, last: 1 }, 1.4 * 3_600_000)], ['7 mains red', '4 / h', '1 main red', 'quiet 1 h'], 'heapFact: the one state fact (never "· 1 repo")');
}

console.log(fails ? `${fails} FAILED` : 'all planthist tests passed');
process.exit(fails ? 1 : 0);
