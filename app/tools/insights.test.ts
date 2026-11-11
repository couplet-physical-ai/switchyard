// The Factory Floor seam (src/insights.ts): one API whatever the server speaks.
//   - v0.4 (the recorded fixtures as recorded): every table approximated client-side, in slices;
//   - v0.5 (the simulation, as the demo and the mock serve it): the server's own tables.
// Plus the §C group hues, and the H6/H7 client-side histories. Run: bun app/tools/insights.test.ts
import { BOTS_HUE, HUE_SLOTS, Insights, OTHER_HUE } from '../src/insights.ts';
import { Timeline } from '../src/timeline.ts';
import { EngineHistory } from '../src/enginehist.ts';
import { createSim } from '../server/sim.ts';
import { CLUSTER_LINE } from '../server/stories.ts';
import type { Upstream } from '../src/api.ts';

let fails = 0;
const ok = (c: unknown, m: string) => { if (c) console.log('ok', m); else { fails++; console.log('FAIL', m); } };
const eq = (a: unknown, b: unknown, m: string) => { const x = JSON.stringify(a), y = JSON.stringify(b); ok(x === y, x === y ? m : `${m}: ${x} != ${y}`); };
/** Runs the slices to completion: each call does one bounded slice. */
const settle = (ins: Insights, max = 200) => { for (let i = 0; i < max; i++) { ins.tl.tick(ins.tl.clock + 16); ins.clusters(); ins.trend('fleet'); } };

// ── v0.4: the fixtures as recorded ──
const fixture = await Bun.file(new URL('../../contract/fixtures/snapshot.json', import.meta.url)).json();
// the recording is v0.5 itself since contract 46bdd2a: served as a v0.4 server would (mock --v04)
fixture.protocol = '0.4';
for (const k of ['groups', 'clusters', 'flakes', 'trends']) delete fixture[k];
for (const r of fixture.repos) delete r.group;
for (const p of fixture.pipelines) { delete p.flaky; for (const w of p.workflows ?? []) for (const st of w.steps ?? []) delete st.cluster; }
const tl4 = new Timeline();
tl4.load(fixture, 0);
const engines = new EngineHistory();
engines.sample(tl4.world);
const i4 = new Insights(tl4, () => null, engines);
eq([tl4.world.protocol, i4.v05], ['0.4', false], 'v0.4: the fixtures speak 0.4');
eq(i4.groupOf('Northwind-Labs/amber-basin'), 'team:software', 'v0.4 groupOf: App.team via App.repo');
const noApp = [...tl4.world.repos.values()].find((r: any) => !r.app && ![...tl4.world.apps.values()].some((a: any) => a.repo === r.id))!;
eq(i4.groupOf(noApp.id), `org:${noApp.org}`, 'v0.4 groupOf: no app → org:<Owner>');
const gs = i4.groups();
eq([gs.length, gs.reduce((n, g) => n + g.repos, 0)], [25, 394], 'v0.4 groups: 25 groups covering the 394 repos once');
ok(gs.some((g) => g.id === 'team:software' && g.repos === 124 && g.apps === 136) && !gs.some((g) => /unknown/.test(g.id)), 'v0.4 groups: software 124 repos / 136 apps ("software-team" folded in, "unknown-team" dropped)');
eq(gs.reduce((n, g) => n + g.red, 0), [...tl4.world.repos.values()].filter((r: any) => r.main.state === 'failure' || r.main.state === 'error').length, 'v0.4 groups: red counts add up to the red mains');
// §C hues: the fixture's ten groups get the spec's colours
const hex = (id: string) => i4.groupHue(id).hex;
eq(['team:software', 'team:controls', 'team:hardware', 'team:optics'].map(hex), ['#90B1D7', '#727DAD', '#85B9BF', '#55889F'], '§C hues: the four biggest teams (by apps)');
eq(['org:Northwind-Labs', 'org:Northwind-Forge', 'org:Northwind-EMS', 'org:couplet-physical-ai', 'org:copper-browser'].map(hex), ['#61A89A', '#B2A6D0', '#94729C', '#949E70', '#C196AD'], '§C hues: each org its own');
eq([i4.groupHue('team:power-systems'), i4.groupHue('team:hr')], [OTHER_HUE, OTHER_HUE], '§C hues: teams past the nine slots fold into "other teams"');
eq([hex('bots'), OTHER_HUE.hex], ['#606468', '#89867E'], '§C hues: the bots siding and other teams');
const hues = gs.map((g) => i4.groupHue(g.id));
ok(hues.filter((h) => !h.folded).length === HUE_SLOTS && hues.every((h) => h.c <= 0.075 && !(h.h > 0 && h.h < 50 && !h.folded) && !(h.h >= 60 && h.h <= 100 && !h.folded)), '§C hues: 9 hued, chroma ≤ 0.075, clear of red 0–50° and amber 60–100°');
eq(i4.groupHue('team:software'), new Insights(tl4).groupHue('team:software'), '§C hues: deterministic');
const before = hex('team:software');
tl4.world.apps.set('zz-new', { id: 'zz-new', repo: 'Northwind-Labs/zz', team: 'aaa-new-team', url: '', health: 'up', checked: 0 } as any);
tl4.world.kv.app++;
eq([hex('team:software'), i4.groupHue('team:aaa-new').folded], [before, true], '§C hues: frozen for the session (a new team folds, nobody moves)');
tl4.world.apps.delete('zz-new');
tl4.world.kv.app++;
// clusters, flakes, trends: approximated in slices
tl4.tick(16);
const t0 = performance.now();
i4.clusters();
const firstCall = performance.now() - t0;
settle(i4);
const cs = i4.clusters();
// the widest cluster in the recording (security-scan in the v0.4 recording, failsafe-deploy in v0.5's)
const sec = [...cs].sort((a, b) => b.repo_count - a.repo_count)[0];
const SEC = sec?.step ?? '';
ok(sec && sec.repo_count >= 2 && sec.line === undefined && sec.signature === `${SEC} · ${sec.class}`, `v0.4 clusters: ${SEC} across ${sec?.repo_count} repos, class guessed, no line (${cs.length} clusters, first call ${firstCall.toFixed(2)} ms)`);
const web = cs.filter((c) => c.step.startsWith('test-web'));
ok(web.length >= 1 && web.every((c) => c.step === 'test-web-#'), `v0.4 clusters: shards folded (${web.map((c) => c.signature).join(' | ')})`);
ok(cs.every((c, i) => i === 0 || (cs[i - 1]!.open > 0 ? 1 : 0) >= (c.open > 0 ? 1 : 0)), 'v0.4 clusters: open first');
const failing = [...tl4.world.pipelines.entries()].find(([, p]: any) => p.workflows.some((w: any) => w.steps.some((s: any) => s.name === SEC && s.state === 'failure')))!;
eq(i4.clusterOf(failing[0], SEC)?.id, sec?.id, 'v0.4 clusterOf: a failing pipeline\'s step → its cluster');
ok(i4.clusterOf(failing[0]) !== null, 'v0.4 clusterOf: no step → its first failed step\'s cluster');
eq(i4.clusterOf(failing[0], `${(failing[1] as any).workflows.find((w: any) => w.steps.some((s: any) => s.name === SEC && s.state === 'failure')).name}/${SEC}`)?.id, sec?.id, 'v0.4 clusterOf: by "workflow/step"');
const fl = i4.flakes();
const flip = (f: (typeof fl)[number]) => f.shas.every((sha) => {
  const runs = [...tl4.world.pipelines.values()].filter((p: any) => p.repo === f.repo && p.sha === sha).flatMap((p: any) => p.workflows.filter((w: any) => w.name === f.workflow).flatMap((w: any) => w.steps.filter((s: any) => s.name === f.step)));
  return runs.some((s: any) => s.state === 'success') && runs.some((s: any) => s.state === 'failure' || s.state === 'error');
});
ok(fl.length >= 1 && fl.every(flip), `v0.4 flakes: each a step that failed and passed on the same sha (${fl.length}: ${fl.slice(0, 3).map((f) => f.id).join(', ')}…)`);
const ft = i4.trend('fleet')!;
ok(ft && ft.pass_rate.h24 === fixture.stats.success_rate_24h && ft.pass_rate.d7 === null && ft.hours_7d === 0 && ft.pass_rate.h1 !== null, `v0.4 trend fleet: h1 ${ft?.pass_rate.h1} from the last hour, h24 ${ft?.pass_rate.h24} from Stats, d7 null`);
ok(ft.pipelines.spark.length === 24 && ft.pipelines.spark[0] === null && ft.pipelines.spark[23] !== null && ft.deploys.spark.filter((x) => x !== null).length === 24, 'v0.4 trend sparks: pipelines only where held (≈ 2 h), deploys over 24 h');
const gt = i4.trend('team:software')!;
ok(gt && gt.pass_rate.h24 === null && gt.deploys.h24 !== null && gt.red.h1 === gs.find((g) => g.id === 'team:software')!.red, 'v0.4 trend group: h24 only for deploys; red now');
const v0 = i4.ver('clusters');
eq(i4.ver('clusters'), v0, 'v0.4 ver: steady while nothing changes');
const at = tl4.world.at;
const ch = await i4.changesSince(at - 8 * 3600_000);
ok(ch.complete && ch.red.length > 0 && ch.recovered.length > 0 && ch.deploys.length > 0 && ch.counts.pipelines > 0 && ch.still_red.length > 0,
  `v0.4 changesSince 8 h: ${ch.red.length} red, ${ch.recovered.length} recovered, ${ch.still_red.length} still red, ${ch.counts.deploys} deploys, ${ch.counts.pipelines} pipelines`);
ok(ch.red.every((r) => tl4.world.repos.get(r.repo)!.main.since > ch.since) && ch.red.some((r) => r.cluster), 'v0.4 changesSince: reds after since, with their cluster where held');
const old = await i4.changesSince(at - 48 * 3600_000);
eq([old.complete, old.since], [false, at - 24 * 3600_000], 'v0.4 changesSince 48 h: complete false, clamped to 24 h');
const eh = i4.engineHistory('wp-agent-1')!;
ok(eh && eh.occupancy.length === 24 && eh.runs.length > 0 && eh.busy.length === 1 && eh.served.length > 0, `H6 engineHistory: ${eh?.runs.length} runs, occupancy ${eh?.occupancy.slice(-4).join(' ')}, served ${eh?.served.length} repos`);
const appId = [...tl4.world.deploys.values()].find((d: any) => tl4.world.apps.has(d.app))!.app as string;
const ah = i4.appHistory(appId)!;
ok(ah && ah.deploys.length >= 1 && ah.since === tl4.world.loadedAt && Array.isArray(ah.incidents), `H7 appHistory ${appId}: ${ah?.deploys.length} deploys, health ${ah?.health}`);
tl4.world.apply({ t: 'delta', seq: tl4.world.seq + 1, at: at + 1000, ops: [{ op: 'event', e: { k: 'health', app: appId, from: 'up', to: 'down', at: at + 1000 } }] });
tl4.world.apply({ t: 'delta', seq: tl4.world.seq + 1, at: at + 60_000, ops: [{ op: 'event', e: { k: 'health', app: appId, from: 'down', to: 'up', at: at + 60_000 } }] });
eq(i4.appHistory(appId)!.incidents, [{ from: at + 1000, to: at + 60_000, state: 'down' }], 'H7 appHistory: health events → an incident');

// ── a big world: no call does O(fleet) work ──
const big = new Timeline();
const many = JSON.parse(JSON.stringify(fixture));
const base = many.pipelines;
for (let k = 1; k < 40; k++) for (const p of base.slice(0, 260)) many.pipelines.push({ ...p, id: `${p.id}~${k}`, sha: `${p.sha.slice(0, 30)}${k}` });
big.load(many, 0);
const ib = new Insights(big);
let worst = 0;
const times: number[] = [];
for (let i = 0; i < 400; i++) {
  big.tick(big.clock + 16);
  const s = performance.now();
  for (let k = 0; k < 10; k++) { ib.clusters(); ib.flakes(); ib.trend('fleet'); ib.groupOf('Northwind-Labs/amber-basin'); }
  times.push(performance.now() - s);
}
times.sort((a, b) => a - b);
worst = times[Math.floor(times.length * 0.98)]!;
ok(ib.clusters().length > 0 && ib.trend('fleet') && worst < 3, `slices: ${big.world.pipelines.size} pipelines, 40 accessor calls a frame: p98 ${worst.toFixed(2)} ms, max ${times[times.length - 1]!.toFixed(2)} ms`);

// ── v0.5: the simulation's own tables (as the demo and the mock serve them) ──
const E = Date.UTC(2026, 10, 10, 20, 0);
const sim = createSim({ seed: 7, epoch: E, warmupMs: 10 * 60_000 });
const tl5 = new Timeline();
tl5.load(sim.snapshot() as any, 0);
const up = { kind: 'demo', changes: async (s: number, u?: number) => sim.changes(s, u) } as unknown as Upstream;
const i5 = new Insights(tl5, () => up);
eq(i5.v05, true, 'v0.5: the simulation speaks 0.5');
const r5 = [...tl5.world.repos.values()][0]!;
eq(i5.groupOf(r5.id), r5.group, 'v0.5 groupOf: Repo.group');
eq(i5.groups().length, tl5.world.groups.size, 'v0.5 groups: the server\'s table');
const c5 = i5.clusters();
ok(c5[0]?.line === CLUSTER_LINE && c5[0].repo_count >= 4 && c5[0].repo_count <= 6 && c5[0].groups.length >= 2 && c5[0].groups.length <= 3, `v0.5 clusters: the story cluster leads (${c5[0]?.signature}, ${c5[0]?.repo_count} repos, ${c5[0]?.groups.length} groups)`);
ok(c5[0]!.open < c5[0]!.repo_count && tl5.world.repos.get(sim.cast!.cluster[0]!)!.main.state !== 'failure', `the demo opens with one cluster repo fixed already (open ${c5[0]!.open} of ${c5[0]!.repo_count})`);
const ex = c5[0]!.examples[0]!;
eq(i5.clusterOf(ex)?.id, c5[0]!.id, 'v0.5 clusterOf: Step.cluster');
ok(i5.flakes().length >= 1 && i5.flakes()[0]!.flips_24h >= 2, `v0.5 flakes: ${i5.flakes()[0]?.id} ${i5.flakes()[0]?.flips_24h} flips`);
eq(i5.trend('fleet'), tl5.world.trends.get('fleet'), 'v0.5 trend: the server\'s');
const down = i5.groups().filter((g) => i5.trend(g.id)?.pass_rate.bad && i5.trend(g.id)?.pass_rate.dir === -1).map((g) => g.id);
const upg = i5.groups().filter((g) => i5.trend(g.id)?.pass_rate.dir === 1).map((g) => g.id);
ok(down.includes(sim.cast!.down) && upg.includes(sim.cast!.up), `v0.5 trends: ${sim.cast!.down} trending down (bad), ${sim.cast!.up} up`);
ok(!i5.groupHue(sim.cast!.down).folded && !i5.groupHue(sim.cast!.up).folded, 'the demo\'s trending groups are hued (not folded)');
const c = await i5.changesSince(E - 9 * 3600_000);
ok(c.complete && c.red.some((x) => x.cluster === c5[0]!.id) && c.recovered.some((x) => x.repo === sim.cast!.recovers) && c.recovered.some((x) => x.repo === sim.cast!.cluster[0]), `v0.5 changesSince (the server's): ${c.red.length} red (the cluster's among them), ${c.recovered.length} recovered (${sim.cast!.recovers.split('/')[1]} and the fixed cluster repo among them)`);
const kv = i5.ver('trends');
tl5.world.apply({ t: 'delta', seq: tl5.world.seq + 1, at: tl5.world.at + 1, ops: [{ op: 'upsert', kind: 'trend', id: 'fleet', v: tl5.world.trends.get('fleet') }] } as any);
ok(i5.ver('trends') !== kv, 'v0.5 ver: bumps on the table\'s ops');

// ── H6/H7 from the server (73ef168), else the client seams in the server's shape ──
{
  let appCalls = 0, engCalls = 0;
  const srvApp = { id: appId, app: null, deploys: [{ sha: 'abc', via: 'roadrunner', state: 'success', started: 1, at: 2, finished: 2, duration_ms: 1 }], health: [], health_ms: { up: 5 }, since: 0, complete: true };
  const fake = {
    kind: 'http',
    appHistory: async (id: string) => { appCalls++; return id === appId ? srvApp : null; },
    engineHistory: async (id: string) => { engCalls++; return id === 'boom' ? Promise.reject(new Error('500')) : null; },
  } as unknown as Upstream;
  const ih = new Insights(tl4, () => fake, engines);
  const a1 = await ih.appHistoryAsync(appId), a2 = await ih.appHistoryAsync(appId);
  ok(a1?.source === 'server' && a1.deploys.length === 1 && a2 === a1 && appCalls === 1, `appHistoryAsync: the server's answer, cached per id (${appCalls} fetch)`);
  const other = [...tl4.world.apps.keys()].find((k) => k !== appId)!;
  const a3 = await ih.appHistoryAsync(other);
  ok(a3?.source === 'client' && a3.complete === false && a3.id === other && Array.isArray(a3.deploys) && typeof a3.health_ms === 'object', 'appHistoryAsync: 404 → the client seam in the server\'s shape');
  eq(await ih.appHistoryAsync('zz-no-such-app'), null, 'appHistoryAsync: unknown app → null');
  const e1 = await ih.engineHistoryAsync('wp-agent-1');
  ok(e1?.source === 'client' && e1.n === e1.busy.length && e1.busy.length === 24 && e1.step_ms === 300_000 && e1.repos.length > 0, `engineHistoryAsync: 404 → the client seam as columns (${e1?.n} × ${e1?.step_ms} ms, ${e1?.repos.length} repos)`);
  eq(await ih.engineHistoryAsync('boom'), null, 'engineHistoryAsync: a failing fetch falls back (unknown engine → null)');
  const n0 = engCalls;
  await ih.engineHistoryAsync('wp-agent-1');
  tl4.tick(tl4.clock + 61_000);
  await ih.engineHistoryAsync('wp-agent-1');
  eq(engCalls - n0, 1, 'engineHistoryAsync: cached 60 s, then asked again');
}

console.log(fails ? `insights.test: ${fails} FAILED` : 'insights.test: all ok');
process.exit(fails ? 1 : 0);
