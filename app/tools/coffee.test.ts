// The coffee check (src/factory/coffee.ts, anomaly.ts; fab-w4, FACTORY-SPEC §E) on the recorded
// fixtures and on a synthetic all-green fleet:
//   1. a fingerprint taken at t0, the floor opened at t0 + 1 h → exactly the expected fresh set;
//   2. the window: since the visit · 1 h · 24 h · 7 d each re-digest with their own start and set,
//      and W cycles them;
//   3. an all-green world shows zero marks (and the floor paints nothing for the coffee check);
//   4. the real fixture's marks come from its real data (clusters, trends);
//   5. each digest slice, the layout and a frame's painting stay cheap (Bun).
// Run: bun app/tools/coffee.test.ts
import { Timeline } from '../src/timeline.ts';
import { bindInsights, insights } from '../src/insights.ts';
import { Factory } from '../src/factory/factory.ts';
import { Gfx } from '../src/yard/gfx.ts';
import {
  DAY, HOUR, fingerprint, freshSince, marks, metricBad, packVisit, unpackVisit, windowStart, type Fresh, type MarkInput,
} from '../src/factory/anomaly.ts';
import type { Snapshot } from '../src/wire.ts';

let fails = 0;
const ok = (c: unknown, m: string) => { if (c) console.log('ok', m); else { fails++; console.log('FAIL', m); } };
const eq = (a: unknown, b: unknown, m: string) => { const x = JSON.stringify(a), y = JSON.stringify(b); ok(x === y, x === y ? m : `${m}: ${x} != ${y}`); };
const drain = <T>(g: Generator<void, T, void>): T => { for (;;) { const r = g.next(); if (r.done) return r.value; } };
const sorted = (xs: readonly string[]) => [...xs].sort();

const fixture = (await Bun.file(new URL('../../contract/fixtures/snapshot.json', import.meta.url)).json()) as Snapshot;
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));
const list = <T>(c: T[] | Record<string, T>): T[] => (Array.isArray(c) ? c : Object.values(c));

// ── 1. a fingerprint at t0, open at t0 + 1 h ──
{
  const tl = new Timeline();
  tl.load(clone(fixture), 0);
  bindInsights(tl, () => null);
  const w = tl.world, t0 = w.at;
  const fp0 = fingerprint(w, insights().clusters(), t0);
  const fp = unpackVisit(JSON.parse(JSON.stringify(packVisit(fp0))))!;
  eq([fp.at, fp.red.size, fp.down.size, fp.cl.size], [fp0.at, fp0.red.size, fp0.down.size, fp0.cl.size], 'fingerprint: survives the persisted form');
  ok(JSON.stringify(packVisit(fp0)).length < 14_000, `fingerprint: ${JSON.stringify(packVisit(fp0)).length} B (persisted state ≤ 16 KB)`);
  const repos = [...w.repos.values()];
  const greens = repos.filter((r) => r.main?.state === 'success');
  const reds = repos.filter((r) => r.main?.state === 'failure' || r.main?.state === 'error');
  ok(greens.length >= 2 && reds.length >= 3, `fixture: ${greens.length} green, ${reds.length} red main lines`);
  // one hour later: A turned red, B was fixed, C is red again with a new culprit, an app went
  // down, a downed app came back, a run failed, a deploy landed, a PR merged
  const C = reds.find((r) => r.main?.culprit)!, B = reds.find((r) => r !== C)!, A = greens[0];
  A.main = { ...A.main, state: 'failure', since: t0 + 20 * 60_000, culprit: 'aaaaaaa1111' };
  B.main = { ...B.main, state: 'success', since: t0 + 30 * 60_000, culprit: undefined, recent: [...(B.main.recent ?? []), { sha: 'bbbb', at: t0 + 30 * 60_000, state: 'success', author: 'x', title: 'fix' }] };
  C.main = { ...C.main, culprit: 'ccccccc2222', since: C.main.since };
  const apps = [...w.apps.values()];
  const X = apps.find((a) => a.health === 'up')!;
  X.health = 'down';
  w.health.push({ app: X.id!, from: 'up', to: 'down', at: t0 + 40 * 60_000 });
  // an app the visit saw down is up again (made down in the fingerprint itself)
  const Y = apps.find((a) => a.health === 'up' && a.id !== X.id)!;
  fp.down.add((await import('../src/factory/anomaly.ts')).h36(Y.id!));
  w.health.push({ app: Y.id!, from: 'down', to: 'up', at: t0 + 45 * 60_000 });
  const p = clone([...w.pipelines.values()][0]);
  p.id = 'wp:test/fail:1'; p.state = 'failure'; p.finished = t0 + 50 * 60_000; p.started = t0 + 48 * 60_000;
  w.pipelines.set(p.id, p);
  const dep = clone([...w.deploys.values()][0]);
  dep.id = 'test/app@dddd'; dep.started = t0 + 15 * 60_000; dep.finished = t0 + 16 * 60_000; dep.state = 'success';
  w.deploys.set(dep.id, dep);
  const pr = clone([...w.prs.values()].find((x) => x.phase !== 'merged')!);
  pr.id = `${pr.repo}#99999`; pr.merged_at = t0 + 35 * 60_000; pr.merge_sha = 'eeee'; pr.phase = 'merged';
  w.prs.set(pr.id, pr);
  const t1 = t0 + HOUR;
  w.at = t1;
  const fr = drain(freshSince(w, t0, t1, fp, null, insights().clusters()));
  eq(sorted(fr.newRed), sorted([A.id, C.id]), 'fresh: newly red = the one that turned red + the one red again with a new culprit');
  eq(fr.fixed, [B.id], 'fresh: fixed = the one that went green');
  eq(fr.down, [X.id], 'fresh: down = the app that went down');
  eq(fr.recovered, [Y.id], 'fresh: recovered = the app the visit saw down, up now');
  eq(fr.failed, [p.id], 'fresh: failed = the run that failed after the visit (none of the fixture\'s older ones)');
  ok(fr.deployApps.includes(dep.app) && fr.deploys === 1, `fresh: the deploy after the visit (${fr.deploys})`);
  eq(fr.merged, [`${pr.repo}@eeee`], 'fresh: the merge after the visit');
  eq([fr.at.get(`red:${A.id}`), fr.at.get(`fix:${B.id}`), fr.at.get(`app:${X.id}`), fr.at.get(`fail:${p.id}`)], [t0 + 20 * 60_000, t0 + 30 * 60_000, t0 + 40 * 60_000, t0 + 50 * 60_000], 'fresh: when each happened (the replay plays them in order)');
  eq(fr.acute.includes(A.id), true, 'fresh: A is acute (red < 1 h)');
  // the marks for that hour: A's beacon pulses (acute), X is down (broken)
  const mk = marks(markInput(w, t0, t1, fr, true));
  ok(mk.beacons.some((b) => b.kind === 'red' && b.id === A.id), 'marks: a beacon on the main line red < 1 h');
  eq(mk.verdict, 'broken', `marks: the verdict (${mk.why})`);
  ok(mk.cracks.filter((c) => c.kind === 'red').length === repos.filter((r) => (r.main?.state === 'failure' || r.main?.state === 'error') && (r.main?.since ?? t1) < t1 - DAY).length, `marks: cracks on every main line red > 24 h (${mk.cracks.length})`);
}

function markInput(w: Timeline['world'], since: number, now: number, fresh: Fresh, short: boolean, queue = { waiting: 0, oldestWait: 0, slots: 12, busy: 2, growing: false, p50: 60_000 }): MarkInput {
  const ins = insights();
  return {
    w, now, since, short, clusters: ins.clusters(), trend: (id) => ins.trend(id), srv: null, fresh, queue,
    downSince: (app) => { let at = 0; for (const h of w.health) if (h.app === app && h.to === 'down') at = h.at; return at; },
    groups: ins.groups(), groupWord: (id) => id,
  };
}

// ── a floor to drive: a Factory over a loaded timeline, frames on a recording-free canvas ──
const noop = () => {};
const ctx = new Proxy({}, {
  get: (_t, k) => (k === 'measureText' ? (s: string) => ({ width: 6.6 * String(s).length }) : k === 'canvas' ? { width: 1440, height: 900 } : k === 'createLinearGradient' || k === 'createRadialGradient' ? () => ({ addColorStop: noop }) : noop),
  set: () => true,
}) as never;
const frame = (t: number) => ({ time: t, width: 1440, height: 900, dpr: 1, scale: 1, cause: 'frame', causes: ['frame'] }) as never;
function floor(s: Snapshot, now: number): { tl: Timeline; f: Factory; run: (from: number, n: number, step?: number) => number } {
  const tl = new Timeline();
  tl.load(s, 0);
  tl.wallNow = () => now;
  tl.tick(0);
  bindInsights(tl, () => null);
  const f = new Factory(tl);
  const run = (from: number, n: number, step = 100) => {
    let t = from;
    for (let i = 0; i < n; i++, t += step) { tl.tick(t); f.drawFloor(ctx, frame(t), t); f.drawLive(ctx, frame(t), t, 0); }
    return t;
  };
  return { tl, f, run };
}
const redSince = (s: Snapshot, from: number) => list(s.repos).filter((r) => (r.main?.state === 'failure' || r.main?.state === 'error') && (r.main?.since ?? 0) > from).map((r) => r.id).sort();

// ── 2. the window: visit · 1 h · 24 h · 7 d ──
{
  const snap = clone(fixture), now = snap.at;
  const { tl, f, run } = floor(snap, now);
  const fp = fingerprint(tl.world, insights().clusters(), now - 3 * HOUR);
  const dropped = [...fp.red.keys()].slice(0, 3);
  for (const k of dropped) fp.red.delete(k);
  const visits = JSON.stringify({ origin: packVisit(fp) });
  const c = f.coffee;
  c.open('', visits, true, 0);
  let t = run(16, 40);
  ok(c.openAt >= 0, `open: the intro started (${c.words()})`);
  eq([c.dg.win, c.dg.since, c.dg.fresh.newRed.length], ['visit', now - 3 * HOUR, 3], 'window visit: from the visit 3 h ago, the 3 main lines red since it');
  ok(/since 3h ago/.test(c.words()), `window visit: words "${c.words()}"`);
  for (const [win, span] of [['1h', HOUR], ['24h', DAY], ['7d', 7 * DAY]] as const) {
    c.pick(win, t);
    t = run(t, 12);
    eq([c.dg.win, c.dg.since, c.since], [win, now - span, now - span], `window ${win}: the digest and the strip's bracket start ${span / HOUR} h back`);
    eq(sorted(c.dg.fresh.newRed), redSince(snap, now - span), `window ${win}: newly red = the main lines red since then (${c.dg.fresh.newRed.length})`);
  }
  ok(/last 7 d/.test(c.words()), `window 7d: words "${c.words()}"`);
  const k = c.key('w', t);
  t = run(t, 12);
  eq([k?.kind, k?.id, c.dg.win, c.dg.since], ['since', 'visit', 'visit', now - 3 * HOUR], 'W cycles 7 d → since the visit');
  ok(c.click({ kind: 'since', id: 'menu' }, t) && c.menu, 'the since chip opens its menu');
  ok(c.click({ kind: 'since', id: '24h' }, t) && !c.menu && c.win === '24h', 'a menu row picks the window and closes the menu');
  c.click({ kind: 'dock', id: 'x' }, t);
  ok(!c.menu, 'any other press closes the menu');
  // the replay: any input skips it, S replays it
  c.replay(t);
  ok(c.busy(t + 100), 'S: the replay plays (the live layer stays awake)');
  c.input('down', t + 200);
  ok(!c.busy(t + 300), 'any input skips the replay');
}

// ── 3. an all-green, quiet world: zero marks, nothing painted ──
{
  const s = clone(fixture), now = s.at;
  for (const r of list(s.repos)) { r.main = { ...r.main, state: 'success', culprit: undefined, recent: (r.main.recent ?? []).map((d) => ({ ...d, state: 'success', culprit: undefined })) }; }
  for (const a of list(s.apps)) a.health = 'up';
  for (const p of list(s.pipelines)) { if (p.state === 'failure' || p.state === 'error') p.state = 'success'; for (const wf of p.workflows ?? []) { if (wf.state === 'failure' || wf.state === 'error') wf.state = 'success'; for (const st of wf.steps ?? []) if (st.state === 'failure' || st.state === 'error') { st.state = 'success'; delete st.cluster; } } delete p.flaky; }
  s.clusters = []; s.flakes = [];
  for (const tr of list(s.trends ?? [])) for (const k of ['intake_ms', 'run_ms', 'pass_rate', 'pipelines', 'deploys', 'pr_age_ms', 'red'] as const) { tr[k] = { ...tr[k], dir: 0, h1: tr[k].d7 ?? null, h24: tr[k].d7 ?? null }; delete tr[k].bad; if (k === 'pass_rate') tr[k] = { ...tr[k], h1: 1, h24: 1, d7: 1 }; if (k === 'red') tr[k] = { ...tr[k], h1: 0, h24: 0, d7: 0 }; }
  for (const g of list(s.groups ?? [])) g.red = 0;
  for (const q of list(s.queues)) { q.pending = 0; q.oldest_wait_ms = 0; q.items = []; }
  // quiet: nothing deployed or merged in the window either (those rim, they are not marks)
  s.deploys = []; for (const p of list(s.prs)) delete p.merged_at;
  s.watcher = { id: 'outage', tripped: false, gh_status: 'ok' };
  const { f, run } = floor(s, now);
  f.coffee.open('', '', true, 0);
  for (const w of ['24h', '1h', '7d', 'visit'] as const) {
    f.coffee.pick(w, 0);
    run(16, 30);
    const m = f.coffee.dg.marks;
    eq([m.smoke.length, m.beacons.length, m.cracks.length, m.jam, m.embers.length, m.hot.length, m.verdict], [0, 0, 0, null, 0, 0, 'flowing'], `all green (${w}): zero marks, flowing`);
  }
  // the same green world with a jam: the wait trend bad, the queue growing, every slot busy
  {
    const ins = insights(), fleet = ins.trend('fleet')!;
    const jamIn = { ...markInput(f.world, now - HOUR, now, f.coffee.dg.fresh, true, { waiting: 6, oldestWait: 300_000, slots: 12, busy: 12, growing: true, p50: 60_000 }), trend: (id: string) => (id === 'fleet' ? { ...fleet, intake_ms: { ...fleet.intake_ms, dir: 1 as const, bad: true } } : ins.trend(id)) };
    const mj = marks(jamIn);
    eq([mj.jam?.waiting, mj.verdict, mj.hot.map((h) => h.kind), mj.embers.map((e) => e.id)], [6, 'jammed', ['jam'], ['intake']], 'jam: wait trend bad + queue growing + every slot busy → jammed, the intake embers, a jam callout');
    eq(marks({ ...jamIn, queue: { ...jamIn.queue, growing: false } }).jam, null, 'jam: not while the queue is not growing');
    eq(marks({ ...jamIn, queue: { ...jamIn.queue, busy: 11 } }).jam, null, 'jam: not while a slot is free');
  }
  const t = run(10_000, 3);
  const g = new Gfx();
  g.begin(ctx, 1);
  const o0 = g.ops;
  f.coffee.under(g, t);
  eq(g.ops - o0, 0, 'all green: the coffee check paints nothing on the floor (a healthy factory is quiet)');
}

// ── 4. the fixture's own marks (the recorded v0.5 tables) ──
{
  const snap = clone(fixture), now = snap.at;
  const { f, run } = floor(snap, now);
  f.coffee.open('', '', true, 0);
  f.coffee.pick('24h', 0);
  run(16, 40);
  const m = f.coffee.dg.marks;
  const want = list(snap.clusters ?? []).filter((c) => c.open > 0 && (c.count_1h >= 2 || c.repo_count >= 3)).sort((a, b) => b.repo_count - a.repo_count || b.count_1h - a.count_1h || (a.id < b.id ? -1 : 1)).slice(0, 3).map((c) => c.id);
  eq(m.smoke.map((s) => s.id), want, `fixture smoke: the open clusters hitting ≥ 3 repos or ≥ 2 an hour (${m.smoke.map((s) => `${s.step}·${s.repoN}`).join(', ')})`);
  const fleet = list(snap.trends ?? []).find((x) => x.id === 'fleet');
  const stageBad = (['pass_rate', 'intake_ms', 'run_ms', 'pr_age_ms', 'red'] as const).filter((k) => metricBad(k, fleet?.[k], false)).length;
  eq(m.embers.filter((e) => e.kind === 'stage').length, stageBad, `fixture embers: one per stage whose 24 h trend is worse than its 7 d (${m.embers.map((e) => `${e.id}:${e.metrics.join('+')}`).join(', ')})`);
  ok(m.hot.length >= 1 && m.hot.length <= 3, `fixture hotspots: ${m.hot.map((h) => `${h.lead}${h.rest}`).join(' | ')}`);
  ok(m.beacons.length <= 64 && m.verdict !== 'flowing', `fixture verdict: ${m.verdict} (${m.why})`);
}

// ── 5. costs (Bun): each digest slice, the layout, one frame's coffee painting ──
{
  const snap = clone(fixture), now = snap.at;
  const { tl, f, run } = floor(snap, now);
  f.coffee.open('', '', true, 0);
  run(16, 40);
  // warm (the first passes compile), then the longest slice of five digests
  // (the median of 9 warm runs per slice: a GC pause is not the code's cost)
  const runs: number[][] = [];
  for (let rep = 0; rep < 12; rep++) {
    const gen = (f.coffee as unknown as { digest: (w: unknown, n: number) => Generator<void, unknown, void> }).digest(tl.world, now);
    for (let i = 0; ; i++) { const t0 = performance.now(); const r = gen.next(); const ms = performance.now() - t0; if (rep >= 3) (runs[i] ??= []).push(ms); if (r.done) break; }
  }
  const slices = runs.map((xs) => xs.sort((a, b) => a - b)[xs.length >> 1]);
  const worst = Math.max(...slices);
  ok(worst < 1, `digest: ${slices.length} slices, longest ${worst.toFixed(2)} ms (${slices.map((x) => x.toFixed(2)).join(' / ')}; median of 9, < 1 ms in Bun)`);
  const g = new Gfx();
  g.begin(ctx, 1);
  let lay = 0, paint = 0;
  for (let i = 0; i < 20; i++) {
    (f.cam as unknown as { ver: number }).ver++;
    const t0 = performance.now(); f.coffee.under(g, 20_000 + i * 16); lay = Math.max(lay, performance.now() - t0);
    const t1 = performance.now(); f.coffee.under(g, 20_008 + i * 16); paint = Math.max(paint, performance.now() - t1);
  }
  ok(lay < 2, `layout (camera moved): ${lay.toFixed(2)} ms`);
  ok(paint < 0.5, `a frame's coffee painting: ${paint.toFixed(3)} ms`);
}

void windowStart;
console.log(fails ? `${fails} FAILED` : 'coffee: all ok');
process.exit(fails ? 1 : 0);
