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

console.log(fails ? `${fails} FAILED` : 'all planthist tests passed');
process.exit(fails ? 1 : 0);
