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
  DAY, HOUR, age, fingerprint, freshSince, marks, metricBad, midRank, packVisit, unpackVisit, usualOf, windowStart, type Fresh, type MarkInput,
} from '../src/factory/anomaly.ts';
import { emberFact } from '../src/factory/coffee.ts';
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
    eq([mj.jam?.waiting, mj.verdict, mj.factKey, mj.fact, mj.hot.map((h) => h.kind), mj.embers.map((e) => e.id)], [6, 'worse', 'jam', '6 waiting, every slot busy', ['jam'], ['intake']], 'jam: wait trend bad + queue growing + every slot busy → worse than usual by the jam (w2-glance2), the intake embers, a jam callout');
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
  ok(m.hot.length >= 1 && m.hot.length <= 4, `fixture hotspots (candidates; the floor draws ≤ 3): ${m.hot.map((h) => `${h.lead}${h.rest}`).join(' | ')}`);
  ok(m.beacons.length <= 64 && m.verdict !== 'flowing', `fixture verdict: ${m.verdict} (${m.why})`);
}

// ── 4b. w2-glance2 (REVIEW-iter3 #1 #4 #6 #9 #10): now against usual, share, one fact, no lying embers ──
{
  const snap = clone(fixture), now = snap.at;
  const { f, run } = floor(snap, now);
  f.coffee.open('', '', true, 0);
  f.coffee.pick('24h', 0);
  run(16, 40);
  const m = f.coffee.dg.marks, w = f.world;
  // #1 broken only on an app down now, the watcher, or a main red in the last 60 min
  let acute = 0;
  for (const r of w.repos.values()) { const st = r.main?.state, si = r.main?.since ?? 0; if ((st === 'failure' || st === 'error') && si >= now - HOUR && si <= now) acute++; }
  const down = [...w.apps.values()].filter((a) => a.health === 'down').length;
  eq(m.verdict === 'broken', !!(acute || down || w.watcher?.tripped), `#1 broken iff a main red < 1 h (${acute}), an app down (${down}) or the watcher (verdict ${m.verdict} · ${m.fact})`);
  ok(!!m.fact && f.coffee.verdictWords() === `${m.verdict === 'worse' ? 'worse than usual' : m.verdict} · ${m.fact}`, `#1 the header says the one fact that decided it: "${f.coffee.verdictWords()}"`);
  // a fleet whose 24 h window holds new reds but none in the last hour, nothing down: never broken
  const fleet = list(snap.trends ?? []).find((x) => x.id === 'fleet')!;
  const base = markInput(w, now - DAY, now, f.coffee.dg.fresh, false, { waiting: 0, oldestWait: 0, slots: 12, busy: 0, growing: false, p50: 0 });
  const quiet = clone(snap);
  for (const r of list(quiet.repos)) if (r.main && (r.main.state === 'failure' || r.main.state === 'error')) r.main.since = Math.min(r.main.since || now - 2 * HOUR, now - 2 * HOUR);
  for (const a of list(quiet.apps)) a.health = 'up';
  quiet.watcher = { id: 'outage', tripped: false, gh_status: 'ok' };
  const q = floor(quiet, now);
  const qm = marks({ ...base, w: q.f.world, fresh: { ...f.coffee.dg.fresh, newRed: ['x/a', 'x/b'] } });
  ok(qm.verdict !== 'broken', `#1 a window's new reds alone never make it broken (${qm.verdict} · ${qm.fact})`);
  // worse than usual: the pass rate 7 points under its 7 d decides, said as a fact
  const pf = { ...fleet, pass_rate: { ...fleet.pass_rate, h1: 0.69, d7: 0.76, bad: true }, red: { ...fleet.red, h1: 1, d7: 40, h24: 40 } };
  const pm = marks({ ...base, w: q.f.world, trend: (id: string) => (id === 'fleet' ? pf : base.trend(id)) });
  eq([pm.verdict, pm.factKey, pm.fact], ['worse', 'pass', 'pass 69% (usual 76%)'], '#1 pass 69 % against 76 % over 7 d → "worse than usual · pass 69% (usual 76%)"');
  const u = usualOf(pf, 3, now, 24);
  ok(u.passBad && u.rel === 'worse' && u.pass === 0.69 && u.passTyp === 0.76, '#1 usualOf holds the pass rate (h1 against d7, 5 points)');
  // flowing: red at or under its typical and the pass rate at or over its 7 d; else steady
  const gf = { ...fleet, pass_rate: { ...fleet.pass_rate, h1: 0.8, d7: 0.76, bad: false }, pipelines: { ...fleet.pipelines, h1: 1 }, red: { ...fleet.red, d7: 50, h24: 50 } };
  const gm = marks({ ...base, w: q.f.world, trend: (id: string) => (id === 'fleet' ? gf : base.trend(id)) });
  ok(gm.verdict === 'flowing' || gm.verdict === 'steady', `#1 below every line: flowing or steady, never broken or worse (${gm.verdict} · ${gm.fact})`);
  // the needle is a percentile
  eq([midRank([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 10), midRank([5, 5, 5, 5, 5, 5], 5), midRank([1, 2], 2)], [0.95, 0.5, -1], '#1 the needle: now\'s place in the week (ties half; too few hours: none)');
  // #4 the worst group by red share: couplet 10 of 17 beats labs 18 of 131
  const gs = [{ id: 'org:Northwind-Labs', red: 18, repos: 131 }, { id: 'org:couplet-physical-ai', red: 10, repos: 17 }, { id: 'team:software', red: 2, repos: 30 }];
  const sm = marks({ ...base, w: q.f.world, groups: gs, groupWord: (id) => (id.includes('couplet') ? 'couplet' : id.includes('Labs') ? 'labs' : 'software') });
  const g0 = sm.hot.find((h) => h.kind === 'group');
  eq(g0 ? `${g0.lead}${g0.rest}` : '', 'couplet · 10 of 17 red', '#4 worstGroup by red share × log(1 + red): "couplet · 10 of 17 red"');
  // #6 callouts: a name and one state fact, in slot order, a flaky cluster never first
  const order = ['red', 'down', 'cluster', 'group', 'jam', 'flaky'];
  const ks = m.hot.map((h) => order.indexOf(h.kind));
  ok(ks.every((k, i) => k >= 0 && (i === 0 || k >= ks[i - 1]!)) && m.hot[0]?.kind !== 'flaky', `#6 the slots in order (${m.hot.map((h) => h.kind).join(' · ')}), a flaky cluster never first`);
  const cl = m.hot.find((h) => h.kind === 'cluster');
  ok(!cl || /^ · \d+ mains? red · (now|\d+[mhd])$/.test(cl.rest), `#6 an open cluster: "· N mains red · age" (${cl ? cl.lead + cl.rest : 'none'})`);
  const fl = m.hot.find((h) => h.kind === 'flaky');
  ok(!fl || (fl.tone === 'flaky' && / · flaky( cron)? · \d+ \/ 24h$/.test(fl.rest)), `#6 a flaky cluster: gray-red, "· flaky · N / 24h" (${fl ? fl.lead + fl.rest : 'none'})`);
  for (const h of m.hot.filter((x) => x.kind === 'red')) ok(/ broke main · (now|\d+m)/.test(h.rest), `#6 "broke main" only under 1 h (${h.lead}${h.rest})`);
  eq([age(30_000), age(12 * 60_000), age(13 * HOUR), age(3 * DAY)], ['now', '12m', '13h', '3d'], '#6 ages in one unit');
  const red1 = [...w.repos.values()].find((r) => (r.main?.state === 'failure' || r.main?.state === 'error') && (r.main.since ?? 0) > 0 && now - r.main.since > HOUR);
  if (red1) {
    const parts = f.coffee.focalParts(red1.id, red1.name).map((x) => x[0]).join('');
    ok(!parts.includes('broke main') && / · red \d+[hd]$/.test(parts), `#6 the focal car red over an hour: "${parts}"`);
  }
  // #10 an ember never contradicts the wall's arrow: the day worse, the last hour better → none
  const rm = { h1: 21_000, h24: 45_000, d7: 39_000, dir: -1 as const, spark: [] };
  eq([metricBad('run_ms', rm, false), metricBad('run_ms', { ...rm, h1: 48_000, dir: 1 as const }, false)], [false, true], '#10 run time 45 s / 24 h against 39 s, the last hour 21 s → no ember; the last hour 48 s → ember');
  const lt = list(snap.trends ?? []).find((x) => x.id !== 'fleet');
  if (lt) ok(emberFact({ ...lt, pass_rate: { ...lt.pass_rate, h1: 0.4, d7: 0.49 } }, ['pass_rate'], false) === 'pass 40% (usual 49%)', '#10 an ember\'s hover names its metric: "pass 40% (usual 49%)"');
  for (const e of m.embers.filter((x) => x.kind === 'group')) ok(emberFact(insights().trend(e.id), e.metrics, false) !== '', `#10 every group ember can name its metric (${e.id}: ${emberFact(insights().trend(e.id), e.metrics, false)})`);
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
  // the median of 21 (as the digest's slices): the max of 20 caught a GC pause or a busy host's
  // preemption (it failed on main under a loaded devbox: 0.51 ms against 0.5), not the code's cost
  const lays: number[] = [], paints: number[] = [];
  for (let i = 0; i < 24; i++) {
    (f.cam as unknown as { ver: number }).ver++;
    const t0 = performance.now(); f.coffee.under(g, 20_000 + i * 16); const l = performance.now() - t0;
    const t1 = performance.now(); f.coffee.under(g, 20_008 + i * 16); const p = performance.now() - t1;
    if (i >= 3) { lays.push(l); paints.push(p); }
  }
  const med = (xs: number[]) => xs.sort((a, b) => a - b)[xs.length >> 1]!;
  const lay = med(lays), paint = med(paints);
  ok(lay < 2, `layout (camera moved): ${lay.toFixed(2)} ms (median of 21)`);
  ok(paint < 0.5, `a frame's coffee painting: ${paint.toFixed(3)} ms (median of 21)`);
}

// fab-w6b + fx-glance: a hotspot callout sits in the floor's dark places (the top band under the
// glance, or the lower-left void), inside the floor (12 px margin), 24 px clear of stage titles,
// beacons and its own anchor; it pins to the edge its anchor left by
{
  const { calloutAt, calloutPin } = await import('../src/factory/glance.ts');
  const vis = { l: 0, t: 68, r: 1440, b: 842 };
  const inTop = (y: number) => y - 13 >= 68 + 12 && y <= 68 + 12 + 13 + 20;
  const inVoid = (x: number, y: number, w: number) => x + w <= 1440 * 0.4 && y >= 68 + (842 - 68) * 0.62;
  const at = calloutAt(1430, 420, 150, vis)!;
  ok(at[0] - 5 >= 12 && at[0] + 150 + 5 <= 1440 - 12, `callout: clamped inside the right edge (x ${at[0]})`);
  ok(inTop(at[1]) || inVoid(at[0], at[1], 150), `callout: in the top band or the lower-left void (${at})`);
  const lo = calloutAt(300, 760, 150, vis)!;
  ok(lo[1] + 5 <= 842 - 12 && inVoid(lo[0], lo[1], 150), `callout: an anchor low on the left takes the void (${lo})`);
  const own = calloutAt(700, 100, 150, vis)!;
  const clear = (x: number, y: number, w: number, px: number, py: number, m: number) => px < x - 5 - m || px > x + w + 5 + m || py < y - 13 - m || py > y + 5 + m;
  ok(clear(own[0], own[1], 150, 700, 100, 24), `callout: 24 px clear of its own anchor (${own})`);
  // a stage title over the anchor's top-band spot, a beacon beside it: the callout keeps 24 px off both
  const title = { x: 600, y: 80, w: 220, h: 18, m: 24 }, beacon = { x: 860, y: 82, w: 20, h: 20, m: 24 };
  const kt = calloutAt(700, 300, 150, vis, [title, beacon])!;
  const off = (k: typeof title) => kt[0] + 150 + 5 + 24 <= k.x || kt[0] - 5 - 24 >= k.x + k.w || kt[1] + 5 + 24 <= k.y || kt[1] - 13 - 24 >= k.y + k.h;
  ok(kt && off(title) && off(beacon), `callout: 24 px clear of a stage title and a beacon (${kt})`);
  eq(calloutAt(700, 400, 150, vis, [{ x: 0, y: 0, w: 1440, h: 900, m: 0 }]), null, 'callout: no free place → none');
  eq([calloutPin(700, 400, vis), calloutPin(1500, 400, vis), calloutPin(-30, 400, vis), calloutPin(700, 30, vis), calloutPin(700, 900, vis)], ['', 'r', 'l', 't', 'b'], 'callout: pinned to the edge its anchor left by');
}

// fx-glance: the coffee header's totals ARE the status line's (red main lines, building, queued,
// apps down), counted the way app.ts's status line counted them (select.ts), in live, in a
// replay and in stress mode (the 10× fleet's own); and the header PAINTS them
{
  const { buildingIds, queueTruth, isRed } = await import('../src/yard/select.ts');
  const { FACTOR } = await import('../src/factory/stress.ts');
  const texts: string[] = [];
  const rec = new Proxy({}, {
    get: (_t, k) => (k === 'fillText' ? (s: string) => { texts.push(String(s)); } : k === 'measureText' ? (s: string) => ({ width: 6.6 * String(s).length }) : k === 'canvas' ? { width: 1440, height: 900 } : k === 'createLinearGradient' || k === 'createRadialGradient' ? () => ({ addColorStop: noop }) : noop),
    set: () => true,
  }) as never;
  const statusLine = (w: Timeline['world'], F: number) => {
    let red = 0, down = 0;
    for (const r of w.repos.values()) if (isRed(r)) red++;
    for (const a of w.apps.values()) if (a.health === 'down') down++;
    return { red: red * F, building: buildingIds(w).size * F, queued: queueTruth(w).waiting * F, down };
  };
  const painted = (n: number, word: string) => texts.some((s, i) => s === String(n) && (texts[i + 1] ?? '').startsWith(word));
  const check = (name: string, f: Factory, tl: Timeline, t: number, F: number) => {
    const T = f.coffee.status(tl.world, F > 1, t);
    texts.length = 0;
    for (let i = 0; i < 3; i++) { tl.tick(t + i * 16); f.drawLive(rec, frame(t + i * 16), t + i * 16, 0); }
    const want = statusLine(tl.world, F);
    eq([T.red, T.building, T.queued], [want.red, want.building, want.queued], `totals (${name}): red, building, queued = the status line's count${F > 1 ? ' × 10' : ''} (${want.red} · ${want.building} · ${want.queued})`);
    ok(F > 1 ? T.down >= want.down : T.down === want.down, `totals (${name}): apps down ${T.down} (the world's ${want.down}${F > 1 ? ' + the city\'s hashed copies' : ''})`);
    eq(f.coffee.glance0.drawn, `${T.red} red · ${T.building} building · ${T.queued} queued · ${T.down} down`, `header (${name}): the totals it drew are the status line's, word for word`);
    ok(T.red ? painted(T.red, ' red') : texts.includes('every main line green'), `header (${name}): paints "${T.red} red"`);
    ok(T.down ? painted(T.down, T.down === 1 ? ' app down' : ' apps down') : texts.some((s) => s === 'all apps up' || s.endsWith(' back')), `header (${name}): paints the apps down (${T.down})`);
    return texts.slice();
  };
  const snap = clone(fixture), now = snap.at;
  const { tl, f, run } = floor(snap, now);
  f.coffee.open('', '', true, 0);
  let t = run(16, 40);
  t = run(t, 90); // past the intro (T_DONE): the settled header
  const live = check('live', f, tl, t, 1);
  ok(live.some((s) => s.includes('worse than usual') || s.includes('as usual')), `header (live): the verdict is relative (${live.find((s) => s.includes('usual')) ?? 'none'})`);
  ok(!live.some((s) => / building$/.test(s)), 'header (live): building and queued are in the menu, not the row (≤ 4 worded chips)');
  // one name per thing: the return belt's tallest heap names its own signature (fx-engine), so the
  // worst cluster's callout gives way when that heap is its subject; the other hotspots keep theirs
  {
    const { tallestCluster } = await import('../src/factory/glance.ts');
    const { heapsOf, tallest } = await import('../src/factory/clusters.ts');
    eq(tallestCluster([{ cl: 'a', n: 3, open: true, repos: 4 }, { cl: 'b', n: 9, open: false, repos: 9 }, { cl: 'c', n: 5, open: true, repos: 2 }, { cl: 'd', n: 6, open: true, repos: 4 }]), 'd', 'named heap: the open group reaching the most repos (ties: the most failures)');
    const gl = f.coffee.glance0, hot = f.coffee.dg.marks.hot, hs = heapsOf(f.lens.parked), tall = hs ? (tallest(hs)?.cl ?? '') : tallestCluster(f.lens.parkGroups);
    const srcs = gl.callouts.map((o) => o.src);
    ok(tall !== '' && gl.callouts.length >= 1 && gl.callouts.length <= 3, `callouts: ≤ 3 drawn (${srcs.join(' | ')}; the tallest heap ${tall})`);
    ok(!srcs.includes(`cluster:${tall}`), `callouts: none names the tallest heap's cluster (${tall}), the heap names itself`);
    const clh = hot.find((h) => h.kind === 'cluster');
    if (clh && clh.id === tall) ok(hot.filter((h) => h.kind !== 'cluster').every((h) => srcs.includes(`${h.kind}:${h.id}`) || gl.callouts.length === 3), `callouts: the other hotspots keep theirs (${srcs.join(' | ')})`);
    else ok(!clh || srcs.includes(`cluster:${clh.id}`), `callouts: a cluster that is not the tallest heap keeps its callout (${clh?.id ?? 'none'})`);
    // the worst cluster made the tallest heap: its callout gives way, the group's stays
    if (clh) {
      const pgs = f.lens.parkGroups;
      // (the glance asks the belt's heaps first: with none laid, it picks from the park groups)
      const parked0 = f.lens.parked;
      f.lens.parked = [];
      f.lens.parkGroups = [{ ...(pgs[0] ?? { u0: 0, u1: 0, step: '', cls: '', flaky: 0, repos: 1, newest: '' }), cl: clh.id, n: 999, repos: 999, open: true }, ...pgs.slice(1)];
      for (let i = 0; i < 2; i++) { const tt = t + 16 * (i + 1); tl.tick(tt); f.drawLive(rec, frame(tt), tt, 0); }
      const s2 = gl.callouts.map((o) => o.src);
      ok(!s2.includes(`cluster:${clh.id}`) && hot.filter((h) => h.kind !== 'cluster').every((h) => s2.includes(`${h.kind}:${h.id}`)), `callouts: the worst cluster as the tallest heap → no cluster callout, the rest kept (${s2.join(' | ')})`);
      f.lens.parked = parked0;
      f.lens.parkGroups = pgs;
    }
  }
  // stress mode: the 10× fleet (the census multiplies the same way the header does)
  f.setStress(true);
  t = run(t, 12);
  check('stress', f, tl, t, FACTOR);
  eq([f.census.redLines, f.census.building, f.census.waiting], [f.coffee.now.red, f.coffee.now.building, f.coffee.now.queued], 'stress: the floor\'s census (its titles) counts what the header says');
  f.setStress(false);
  t = run(t, 12);
  // a replay: the replayed fleet's own totals, as chips (building and queued too)
  tl.startReplay({ from: now - HOUR, to: now, base: clone(fixture), frames: [] } as never, now);
  t = run(t, 12);
  const rp = check('replay', f, tl, t, 1);
  ok(painted(f.coffee.now.building, ' building') && painted(f.coffee.now.queued, ' queued'), 'header (replay): the replayed moment\'s building and queued');
}
void windowStart;
console.log(fails ? `${fails} FAILED` : 'coffee: all ok');
process.exit(fails ? 1 : 0);
