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
