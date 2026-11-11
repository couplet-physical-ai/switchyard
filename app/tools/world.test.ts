// The world's v0.4 ops: RFC 7386 merge patch (its appendix A cases) and main-line dots.
// Run: bun app/tools/world.test.ts
import { World, mergePatch } from '../src/world.ts';
const eq = (a: unknown, b: unknown, m: string) => { const x = JSON.stringify(a), y = JSON.stringify(b); if (x !== y) { console.log('FAIL', m, x, '!=', y); process.exit(1); } else console.log('ok', m); };
// RFC 7386 appendix A cases
const cases: [unknown, unknown, unknown][] = [
  [{a:'b'},{a:'c'},{a:'c'}], [{a:'b'},{b:'c'},{a:'b',b:'c'}], [{a:'b'},{a:null},{}], [{a:'b',b:'c'},{a:null},{b:'c'}],
  [{a:['b']},{a:'c'},{a:'c'}], [{a:'c'},{a:['b']},{a:['b']}], [{a:{b:'c'}},{a:{b:'d',c:null}},{a:{b:'d'}}],
  [{a:[{b:'c'}]},{a:[1]},{a:[1]}], [['a','b'],['c','d'],['c','d']], [{a:'b'},['c'],['c']], [{a:'foo'},null,null],
  [{a:'foo'},'bar','bar'], [{e:null},{a:1},{e:null,a:1}], [[1,2],{a:'b',c:null},{a:'b'}], [{},{a:{bb:{ccc:null}}},{a:{bb:{}}}],
];
cases.forEach(([t,p,r],i) => eq(mergePatch(t,p), r, `rfc7386 #${i+1}`));
const orig = {a:{b:1}}; mergePatch(orig, {a:{b:2}}); eq(orig, {a:{b:1}}, 'target untouched');
// world: patch + dot
const w = new World();
const dots = Array.from({length: 12}, (_, i) => ({ sha: `s${String(i).padStart(2,'0')}`, at: 1000 + i, state: 'success', author: 'x', title: 't' }));
w.load({ protocol: '0.4', seq: 1, at: 0, repos: [{ id: 'o/r', org: 'o', name: 'r', default_branch: 'main', lane: 'roadrunner', main: { state: 'success', recent: dots } }], orgs: [], commits: [], pipelines: [], prs: [], deploys: [], apps: [], engines: [], queues: [], lanes: [], watcher: { id: 'outage', tripped: false, gh_status: 'ok' }, stats: {} } as any);
const before = w.repos.get('o/r');
w.apply({ t: 'delta', seq: 2, at: 2000, ops: [
  { op: 'patch', kind: 'repo', id: 'o/r', v: { main: { state: 'failure', red_since: 1500 }, heat: 3 } },
  { op: 'dot', id: 'o/r', v: { sha: 's99', at: 2000, state: 'failure', author: 'y', title: 'u' } },
  { op: 'dot', id: 'o/r', v: { sha: 's05', at: 1005, state: 'failure', author: 'x', title: 't' } },
  { op: 'patch', kind: 'repo', id: 'missing/repo', v: { heat: 9 } },
  { op: 'patch', kind: 'stats', id: 'stats', v: { commits_24h: 5 } },
] } as any);
const r = w.repos.get('o/r');
eq(r.main.state, 'failure', 'patch nested'); eq(r.main.red_since, 1500, 'patch adds'); eq(r.heat, 3, 'patch top');
eq(r.main.recent.length, 12, 'dot keeps 12'); eq(r.main.recent.at(-1).sha, 's99', 'dot newest last'); eq(r.main.recent[0].sha, 's01', 'dot drops oldest');
eq(r.main.recent.find((d: any) => d.sha === 's05').state, 'failure', 'dot replaces same sha');
eq(before.main.state, 'success', 'old object untouched'); eq(w.repos.has('missing/repo'), false, 'patch on unknown ignored');
eq(w.stats.commits_24h, 5, 'stats patch'); eq(w.seq, 2, 'seq');

// ---- contract v0.5: the Factory Floor tables (groups, clusters, flakes, trends) ----
const metric = (h1: number) => ({ h1, h24: h1, d7: h1, dir: 0, spark: Array.from({ length: 24 }, () => h1) });
const trend = (id: string) => ({ id, at: 5, intake_ms: metric(1000), run_ms: metric(2000), pass_rate: metric(0.9), pipelines: metric(3), deploys: metric(1), pr_age_ms: metric(9), red: metric(1), hours_7d: 168 });
const snap5 = {
  protocol: '0.5', seq: 10, at: 1000, orgs: [{ id: 'o', repos: 2 }],
  repos: [
    { id: 'o/a', org: 'o', name: 'a', default_branch: 'main', lane: 'roadrunner_first', group: 'team:web', main: { head: 'x', state: 'failure', since: 900, recent: [] }, heat: 0.5, open_prs: 0, links: { github: '' } },
    { id: 'o/b', org: 'o', name: 'b', default_branch: 'main', lane: 'roadrunner_first', group: 'org:o', main: { head: 'y', state: 'success', since: 800, recent: [] }, heat: 0.1, open_prs: 0, links: { github: '' } },
  ],
  commits: [], prs: [], deploys: [], apps: [], engines: [], queues: [], lanes: [], watcher: null, stats: null,
  pipelines: [{ id: 'wp:o/a:1', lane: 'roadrunner', repo: 'o/a', number: 1, sha: 'x', branch: 'main', event: 'push', state: 'failure', created: 1, flaky: true, url: '',
    workflows: [{ name: 'ci', state: 'failure', steps: [{ name: 'test-web-2', state: 'failure', exit_code: 1, cluster: 'f:0123456789ab' }] }] }],
  groups: [{ id: 'org:o', name: 'o', kind: 'org', repos: 1, apps: 0, red: 0 }, { id: 'team:web', name: 'Web', kind: 'team', repos: 1, apps: 1, red: 1 }],
  clusters: [{ id: 'f:0123456789ab', signature: 'test-web-# · test · TypeError', step: 'test-web-#', class: 'test', line: 'TypeError', count: 3, count_1h: 1, repos: ['o/a'], repo_count: 1, groups: ['team:web'], first_seen: 1, last_seen: 2, examples: ['wp:o/a:1'], open: 1 }],
  flakes: [{ id: 'o/a|ci/test-web-2', repo: 'o/a', workflow: 'ci', step: 'test-web-2', flips_24h: 2, failures_24h: 3, last_at: 2, shas: ['x'] }],
  trends: [trend('fleet'), trend('team:web')],
};
const w5 = new World();
w5.load(JSON.parse(JSON.stringify(snap5)));
eq(w5.v05, true, 'v0.5: protocol 0.5 → v05');
eq([w5.groups.size, w5.clusters.size, w5.flakes.size, w5.trends.size], [2, 1, 1, 2], 'v0.5: the four tables from the snapshot arrays');
eq(w5.repos.get('o/a').group, 'team:web', 'v0.5: Repo.group kept');
eq(w5.pipelines.get('wp:o/a:1').flaky, true, 'v0.5: Pipeline.flaky kept');
eq(w5.pipelines.get('wp:o/a:1').workflows[0].steps[0].cluster, 'f:0123456789ab', 'v0.5: Step.cluster kept');
eq(w5.trends.get('fleet').pass_rate.spark.length, 24, 'v0.5: a trend\'s 24 h spark');
const kv0 = { ...w5.kv }, shape0 = w5.shapeVer;
w5.apply({ t: 'delta', seq: 11, at: 1100, ops: [
  { op: 'upsert', kind: 'group', id: 'team:ops', v: { id: 'team:ops', name: 'Ops', kind: 'team', repos: 0, apps: 1, red: 0 } },
  { op: 'patch', kind: 'cluster', id: 'f:0123456789ab', v: { count: 4, count_1h: 2, repos: ['o/b', 'o/a'], open: 2 } },
  { op: 'remove', kind: 'flake', id: 'o/a|ci/test-web-2' },
  { op: 'upsert', kind: 'trend', id: 'fleet', v: { ...trend('fleet'), at: 1100 } },
  { op: 'patch', kind: 'repo', id: 'o/b', v: { group: 'team:ops' } },
  { op: 'patch', kind: 'pipeline', id: 'wp:o/a:1', v: { flaky: null } },
] } as any);
eq(w5.groups.get('team:ops')?.name, 'Ops', 'v0.5 ops: upsert group');
eq([w5.clusters.get('f:0123456789ab').count, w5.clusters.get('f:0123456789ab').repos], [4, ['o/b', 'o/a']], 'v0.5 ops: patch cluster (arrays replace)');
eq(w5.flakes.size, 0, 'v0.5 ops: remove flake');
eq(w5.trends.get('fleet').at, 1100, 'v0.5 ops: upsert trend');
eq(w5.repos.get('o/b').group, 'team:ops', 'v0.5 ops: Repo.group patched');
eq('flaky' in w5.pipelines.get('wp:o/a:1'), false, 'v0.5 ops: null removes Pipeline.flaky');
eq([w5.kv.group - kv0.group, w5.kv.cluster - kv0.cluster, w5.kv.flake - kv0.flake, w5.kv.trend - kv0.trend, w5.kv.repo - kv0.repo, w5.kv.pipeline - kv0.pipeline], [1, 1, 1, 1, 1, 1], 'v0.5 ops: each table\'s change counter bumps (patches too)');
eq(w5.shapeVer - shape0, 1, 'v0.5 ops: a new group changes the shape');

// ---- a v0.4 server keeps working exactly as before ----
const snap4 = JSON.parse(JSON.stringify(snap5));
snap4.protocol = '0.4';
for (const k of ['groups', 'clusters', 'flakes', 'trends']) delete snap4[k];
for (const r of snap4.repos) delete r.group;
const w4 = new World();
w4.load(snap4);
eq(w4.v05, false, 'v0.4: protocol 0.4, no tables → not v05');
eq([w4.groups.size, w4.clusters.size, w4.flakes.size, w4.trends.size], [0, 0, 0, 0], 'v0.4: the tables stay empty');
eq([w4.repos.size, w4.pipelines.size, w4.repos.get('o/a').main.state], [2, 1, 'failure'], 'v0.4: the fleet loads as before');
w4.apply({ t: 'delta', seq: 11, at: 1100, ops: [
  { op: 'upsert', kind: 'widget', id: 'w', v: { id: 'w' } },
  { op: 'patch', kind: 'repo', id: 'o/b', v: { heat: 0.7 } },
  { op: 'event', e: { k: 'health', app: 'a', from: 'up', to: 'down', at: 1050 } },
] } as any);
eq([w4.repos.get('o/b').heat, w4.seq, w4.health.length], [0.7, 11, 1], 'v0.4: unknown kinds skipped, the rest applies; health events kept');
const wOld = new World();
wOld.load({ ...snap4, protocol: '0.2' });
eq(wOld.v05, false, 'v0.2/0.3: not v05');
const wMap = new World();
wMap.load({ ...JSON.parse(JSON.stringify(snap5)), repos: { 'o/a': { ...snap5.repos[0], id: undefined } }, groups: { 'team:web': snap5.groups[1] } } as any);
eq([wMap.v05, wMap.repos.get('o/a').id, wMap.groups.get('team:web').name], [true, 'o/a', 'Web'], 'the demo\'s id-keyed maps load too');
console.log('world.test: all ok');
