// LIVE view model (src/now/view.ts, src/now/log.ts): the feed's bands and lines, what needs a
// human, the deep links (server data only), the totals agreeing everywhere, the caps, the memo,
// the inline detail and the log rows; on hand-made worlds, the recorded fleet and (when present)
// a live snapshot. Run: bun app/tools/now.test.ts [live-snapshot.json]
import { existsSync, readFileSync } from 'node:fs';
import { World } from '../src/world.ts';
import { BROKEN_CAP, EMPTY_FEED, feedAnswer, panelAnswer, fit, timer, dur, ago, type NowDeps, type NowFeed } from '../src/now/view.ts';
import { pickRows } from '../src/now/log.ts';
import { NOW_CAP, JUST_CAP, EARLIER_CAP } from '../src/flow/model.ts';

let fails = 0;
const ok = (c: unknown, m: string) => { if (c) console.log('ok', m); else { fails++; console.log('FAIL', m); } };
const eq = (a: unknown, b: unknown, m: string) => {
  const x = JSON.stringify(a), y = JSON.stringify(b);
  if (x === y) console.log('ok', m); else { fails++; console.log('FAIL', m, x, '!=', y); }
};
const MIN = 60_000, H = 3_600_000;
const here = new URL('.', import.meta.url).pathname;
const fixtures = `${here}../../contract/fixtures`;
const NOW = 1_800_000_000_000;
type P = Record<string, any>;
let pn = 0;
const GH = 'https://github.example.com', RR = 'https://ci.example.com', CICD = 'https://cicd.example.com';
function pipe(o: P): P {
  const n = ++pn;
  const lane = o.lane ?? 'roadrunner';
  const repo = o.repo ?? 'o/a';
  return {
    id: o.id ?? (lane === 'gha' ? `gha:${n}` : `wp:${repo}:${n}`), lane, repo, number: n, sha: 'aaa1111',
    branch: 'main', event: 'push', state: 'success', created: NOW - 10 * MIN, url: `${RR}/repos/1/pipeline/${n}`,
    links: lane === 'gha' ? { github: `${GH}/${repo}/actions/runs/${n}` } : { cicd: `${CICD}/pipelines/1/${n}`, commit: `${GH}/${repo}/commit/${o.sha ?? 'aaa1111'}` },
    workflows: [{ name: 'ci', state: o.state ?? 'success', steps: [{ name: 'build', state: o.state ?? 'success', url: `${CICD}/pipelines/1/${n}?tab=steps&step=${n}` }] }],
    ...o,
  };
}
const repo = (id: string, o: P = {}): P => ({ id, org: 'o', name: id.slice(2), default_branch: 'main', lane: 'roadrunner_first', main: { head: '', state: 'success', since: 0, recent: [] }, heat: 0, open_prs: 0, links: { github: `${GH}/${id}`, woodpecker: `${RR}/repos/1`, cicd: `${CICD}/repos/1` }, ...o });
function world(o: { pipelines?: P[]; commits?: P[]; engines?: P[]; deploys?: P[]; apps?: P[]; repos?: P[]; queues?: P[]; prs?: P[] }): World {
  const w = new World();
  w.load({
    protocol: '0.5', seq: 1, at: NOW, orgs: [], repos: o.repos ?? [repo('o/a'), repo('o/b')], commits: o.commits ?? [], pipelines: o.pipelines ?? [], prs: o.prs ?? [],
    deploys: o.deploys ?? [], apps: o.apps ?? [], engines: o.engines ?? [], queues: o.queues ?? [], lanes: [], watcher: null, stats: null,
    groups: [], clusters: [], flakes: [], trends: [],
  } as any);
  return w;
}
const deps = (w: World, now = NOW): NowDeps => ({ world: () => w, now: () => now, offsetMin: () => 0, upstream: () => null });
const feed = (w: World, now = NOW, f: [string, string, string] = ['', '', '']): NowFeed => feedAnswer(deps(w, now), [Math.floor(now / 1000), ...f]);
const allLinks = (f: NowFeed) => [
  ...f.needs.flatMap((n) => n.links), ...[...f.now, ...f.just, ...f.earlier].flatMap((b) => [...b.links, ...b.jobs.flatMap((j) => j.links)]),
  ...f.machines.map((m) => ({ id: 'machine', label: m.label, url: m.url })).filter((l) => l.url),
];

// ── words ──
eq([timer(42_000), timer(245_000), timer(3_725_000)], ['0:42', '4:05', '1:02:05'], 'timer: m:ss and h:mm:ss');
eq([dur(42_000), dur(192_000), dur(14 * MIN), dur(65 * MIN)], ['42s', '3m 12s', '14m', '1h 05m'], 'dur: finished durations');
eq([ago(10_000), ago(5 * MIN), ago(90 * MIN), ago(50 * H)], ['now', '5m', '1h 30m', '2d'], 'ago');
eq(fit('fix the console window opening twice', 20), 'fix the console…', 'fit cuts at a word bound, never mid-token');
eq(fit('short', 20), 'short', 'fit keeps what fits');

// ── a push fanning out, in flight: one block, its jobs as a tree, where they run ──
{
  const w = world({
    commits: [{ id: 'o/a@s1', repo: 'o/a', sha: 's1', branch: 'main', title: 'add the widget', author: 'dev-a', at: NOW - 10 * MIN, stage: 'building', ci: 'running', pipelines: [], links: { commit: `${GH}/o/a/commit/s1` } }],
    engines: [
      { id: 'dagger:VM 153', kind: 'dagger', label: 'VM 153', host: 'VM 153', online: true, slots: 6, busy: 1, running: [], agents: ['wp-agent-1'], url: `${CICD}/engine` },
      { id: 'wp-agent-1', kind: 'wp_agent', label: 'dagger-ci-153-1', host: 'VM 153', online: true, slots: 3, busy: 1, running: ['wp:o/a:9001'], url: `${RR}/admin/agents` },
    ],
    pipelines: [
      pipe({ id: 'wp:o/a:9001', sha: 's1', state: 'running', started: NOW - 3 * MIN, created: NOW - 4 * MIN, expected_ms: 6 * MIN, engine: 'dagger-ci-153-1',
        workflows: [{ name: 'ci', state: 'running', engine: 'dagger-ci-153-1', steps: [{ name: 'clone', state: 'success' }, { name: 'test', state: 'running', started: NOW - MIN, url: `${CICD}/pipelines/1/9001?tab=steps&step=2` }] }] }),
      pipe({ sha: 's1', lane: 'gha', state: 'pending', queue_pos: 1, created: NOW - 4 * MIN + 1000, workflows: [{ name: 'Deploy Docs', state: 'pending', steps: [] }] }),
    ],
  });
  const f = feed(w);
  eq([f.running, f.queued, f.now.length, f.idle], [1, 1, 1, false], 'status line: 1 running, 1 queued, one event in flight');
  const b = f.now[0];
  eq([b.kind, b.repo, b.branch, b.sha, b.title, b.who], ['push', 'a', 'main', 's1', 'add the widget', 'dev-a'], 'event line: kind, repo, branch, sha, message, author');
  eq(b.links.map((l) => [l.label, l.url]), [['commit', `${GH}/o/a/commit/s1`]], 'event link: the commit on GitHub (Pipeline/Commit links)');
  eq(b.jobs.map((j) => [j.state, j.glyph, j.tone, j.last]), [['running', '●', 'run', false], ['queued', '○', 'wait', true]], 'jobs: running then queued; tree ends at the last');
  const r = b.jobs[0];
  eq([r.where, r.step, r.timer, r.usual, r.hasPct, Math.round(r.pct * 100)], ['roadrunner · vm 153 · slot 1', '2/2 test', '3:00', '/ ~6:00', true, 50], 'running job: where (CI · machine · slot), step, timer vs usual, progress');
  eq(r.links.map((l) => [l.label, l.url]), [['roadrunner', `${CICD}/pipelines/1/9001?tab=steps&step=2`]], 'running job links to its running step in Roadrunner');
  eq([b.jobs[1].where, b.jobs[1].step], ['github actions', 'waiting for a slot'], 'queued GHA job');
  eq(f.machines.map((m) => [m.label, m.text, m.cells.filter((c) => c.on).length, m.url]), [['vm 153', '1/3', 1, `${CICD}/engine`], ['github actions', '0', 0, '']], 'machines: busy/slots (its agents\' slots) cells, links from Engine.url; GitHub counts running runs');
  // detail: the job's steps, its links, the log asks
  const p = panelAnswer(deps(w), ['job:wp:o/a:9001', 1]);
  eq([p.ok, p.kind, p.logStep, p.logWorkflow, p.logLive, p.logFail], [true, 'job', 'test', 'ci', true, false], 'detail: the running step is the log to tail, live');
  eq(p.steps.map((s) => `${s.depth}${s.glyph}${s.name}`), ['0●ci · VM 153', '1✓clone', '1●test'], 'detail: workflow then its steps');
  eq(p.links.map((l) => l.label), ['roadrunner', 'step', 'vm 153', 'commit'], 'detail links: run, step, machine, commit');
  const m = panelAnswer(deps(w), ['machine:m:VM 153', 1]);
  eq([m.kind, m.title, m.runs.length, m.runs[0]?.repo], ['machine', 'VM 153', 1, 'a'], 'machine detail: what runs there');
}

// ── finished: just + earlier one-liners, results, deploy → app → health ──
{
  const w = world({
    apps: [{ id: 'app-a', repo: 'o/a', url: 'https://app-a.example.com/', health: 'up', checked: NOW - 5 * MIN, links: { status: 'https://grafana.example.com/d/a' } }],
    deploys: [{ id: 'o/a@d1', app: 'app-a', repo: 'o/a', sha: 'd1', via: 'roadrunner', state: 'success', started: NOW - 9 * MIN, finished: NOW - 5 * MIN, pipeline: 'wp:o/a:9101', links: { cicd: `${CICD}/pipelines/1/9101` } }],
    pipelines: [
      pipe({ id: 'wp:o/a:9101', sha: 'd1', deploy: true, created: NOW - 10 * MIN, started: NOW - 9 * MIN, finished: NOW - 5 * MIN, workflows: [{ name: 'ci', state: 'success', steps: [] }, { name: 'deploy', state: 'success', steps: [] }] }),
      pipe({ repo: 'o/b', sha: 'f1', state: 'failure', created: NOW - 40 * MIN, started: NOW - 39 * MIN, finished: NOW - 35 * MIN,
        workflows: [{ name: 'ci', state: 'failure', steps: [{ name: 'clone', state: 'success' }, { name: 'test', state: 'failure', exit_code: 1, url: `${CICD}/pipelines/2/7?tab=steps&step=9` }] }] }),
    ],
  });
  const f = feed(w);
  eq([f.now.length, f.just.length, f.earlier.length, f.idle], [0, 1, 1, true], 'bands: a deploy that just finished, a failure earlier, nothing running');
  ok(/^Nothing running right now\. Last event \d+m ago\.$/.test(f.idleText), `idle says so and when the last event was: "${f.idleText}"`);
  const j = f.just[0];
  eq([j.glyph, j.chain.map((c) => [c.text, c.app, c.health])], ['✓', [['deploy', 'app-a', 'up']]], 'deploy result: → app → health');
  eq(j.links.map((l) => l.label), ['commit', 'roadrunner', 'app'], 'done row links: commit, the run, the app');
  const e = f.earlier[0];
  eq([e.glyph, e.tone, e.result], ['✕', 'fail', 'failed at test'], 'failure: red ✕ and the failing step');
  eq(e.links.find((l) => l.id === 'ci')?.[ 'url' as 'url'], `${CICD}/pipelines/2/7?tab=steps&step=9`, 'a failure links straight to the failing step');
  eq(e.jobs[0]?.result, 'failed at test', 'a done row carries its jobs for the inline expansion');
  const p = panelAnswer(deps(w), [`job:${w.pipelines.values().next().value!.id}`, 1]);
  ok(p.ok, 'detail of a finished job');
}

// ── needs a human: unhealthy app, failed deploy, stuck job, stuck queue, machine offline, failing main ──
{
  const w = world({
    repos: [repo('o/a', { app: 'app-a' }), repo('o/b', { main: { head: 'bad1', state: 'failure', since: NOW - 2 * H, culprit: 'bad1', recent: [{ sha: 'bad1', at: NOW - 2 * H, state: 'failure', author: 'dev-b', title: 'break it' }] } })],
    apps: [{ id: 'app-a', repo: 'o/a', url: 'https://app-a.example.com/', health: 'down', checked: NOW - 3 * MIN, links: { status: 'https://grafana.example.com/d/a' } }],
    deploys: [
      { id: 'o/a@x0', app: 'app-a', repo: 'o/a', sha: 'x0', via: 'roadrunner', state: 'success', started: NOW - 5 * H, finished: NOW - 5 * H },
      { id: 'o/a@x1', app: 'app-a', repo: 'o/a', sha: 'x1', via: 'roadrunner', state: 'failure', started: NOW - H, finished: NOW - 50 * MIN, links: { cicd: `${CICD}/pipelines/1/77` } },
    ],
    engines: [{ id: 'dagger:VM 154', kind: 'dagger', label: 'VM 154', host: 'VM 154', online: false, slots: 6, busy: 0, running: [], last_seen: NOW - 20 * MIN, url: `${CICD}/engine` }],
    queues: [{ id: 'roadrunner', pending: 4, running: 6, waiting: 0, pipelines_running: 6, oldest_wait_ms: 25 * MIN, items: [], url: `${RR}/admin/queue` }],
    pipelines: [
      pipe({ repo: 'o/a', sha: 'st1', state: 'running', created: NOW - 70 * MIN, started: NOW - 60 * MIN, expected_ms: 10 * MIN }),
      pipe({ repo: 'o/b', sha: 'bad1', state: 'failure', created: NOW - 100 * MIN, finished: NOW - 95 * MIN }),
    ],
  });
  const f = feed(w);
  eq(f.needs.map((n) => [n.kind, n.what, n.word]), [
    ['app', 'app-a', 'down'], ['deploy', 'app-a', 'deploy failed'], ['stuck', 'a ci', 'stuck'], ['queue', 'Roadrunner queue', 'stuck'], ['machine', 'VM 154', 'offline'], ['main', 'b', 'red 2h'],
  ], 'needs, most urgent first: app down, failed deploy, stuck job, stuck queue, machine offline, failing main ("red 2h", the Yard\'s words)');
  const mn = f.needs.at(-1)!;
  eq([mn.sha, mn.who, mn.beads.map((b) => `${b.st}${b.cul ? '*' : ''}`)], ['bad1', 'dev-b', ['bad*']], 'a failing main: culprit sha, author, its bead trail with the culprit ringed');
  eq(f.needs.map((n) => n.links.map((l) => l.label)), [['app', 'status'], ['roadrunner', 'app', 'status'], ['roadrunner'], ['queue'], ['machine'], ['commit', 'roadrunner']], 'every need has its deep links');
  eq([f.needsN, f.needsMore], [6, '3 more: 1 stuck queues · 1 machines offline · 1 failing mains'], 'the first three show; the rest is counted by kind');
  const fb = feed(w, NOW, ['o/b', '', '']);
  eq(fb.needs.map((n) => n.kind), ['main'], 'a repo filter keeps only that repo’s needs (no fleet-wide queue/machines)');
  eq([fb.filtered, fb.filterText], [true, 'repo b'], 'the filter is said');
}

// ── links are only ever built from the server's data (no hardcoded hosts) ──
{
  const snap = JSON.parse(readFileSync(`${fixtures}/snapshot.json`, 'utf8'));
  const w = new World();
  w.load(snap);
  const now = snap.at;
  const f = feed(w, now);
  const hosts = new Set<string>();
  for (const r of w.repos.values()) for (const u of Object.values(r.links ?? {})) if (typeof u === 'string') hosts.add(new URL(u).host);
  for (const p of w.pipelines.values()) { hosts.add(new URL(p.url).host); for (const u of Object.values((p as any).links ?? {})) if (typeof u === 'string') hosts.add(new URL(u).host); }
  for (const a of w.apps.values()) { if (a.url) hosts.add(new URL(a.url).host); for (const u of Object.values((a as any).links ?? {})) if (typeof u === 'string') hosts.add(new URL(u).host); }
  for (const d of w.deploys.values()) { if (d.url) hosts.add(new URL(d.url).host); }
  for (const pr of w.prs.values()) hosts.add(new URL(pr.url).host);
  const links = allLinks(f);
  const bad = links.filter((l) => !hosts.has(new URL(l.url).host));
  ok(links.length > 0 && bad.length === 0, `fixtures: all ${links.length} links point at hosts the server's data names (${bad.slice(0, 2).map((l) => l.url).join(', ')})`);
  ok(links.every((l) => /^https:\/\//.test(l.url)), 'fixtures: every link is https');
  // totals agree everywhere (the status line, the sections, the model)
  const runningJobs = f.now.reduce((n, b) => n + b.jobs.filter((j) => j.state === 'running').length, 0);
  eq(f.running, runningJobs, `fixtures: the status line's ${f.running} running = the running jobs listed under Running now`);
  const queuedJobs = f.now.reduce((n, b) => n + b.jobs.filter((j) => j.state === 'queued').length, 0);
  eq(f.queued, queuedJobs, `fixtures: ${f.queued} queued = the queued jobs listed`);
  eq(f.needsN, f.needs.length, 'fixtures: the needs count = its rows');
  ok(f.now.length <= NOW_CAP && f.just.length <= JUST_CAP && f.earlier.length <= EARLIER_CAP && f.needs.length <= BROKEN_CAP, `fixtures: caps hold (now ${f.now.length}, just ${f.just.length}, earlier ${f.earlier.length}, needs ${f.needs.length})`);
  eq(new Set([...f.now, ...f.just, ...f.earlier].map((b) => b.id)).size, f.now.length + f.just.length + f.earlier.length, 'fixtures: event ids unique');
  ok(feed(w, now) === f, 'memo: the same second and filter answers the same object');
  ok(feed(w, now + 1000) !== f, 'memo: the next second recomputes');
  // cost
  const t0 = performance.now();
  for (let i = 0; i < 200; i++) feedAnswer(deps(w, now + (i + 2) * 1000), [i, '', '', '']);
  const per = (performance.now() - t0) / 200;
  ok(per < 4, `fixtures: a feed answer costs ${per.toFixed(2)} ms (< 4 ms)`);
  eq(feedAnswer(deps(new World()), [0, '', '', '']), EMPTY_FEED, 'an empty world answers the empty feed');
  // the commit filter
  const any = f.just[0] ?? f.earlier[0];
  if (any) {
    const fs = feed(w, now, ['', '', `${any.repoFull}@${any.sha}`]);
    ok([...fs.now, ...fs.just, ...fs.earlier].every((b) => b.repoFull === any.repoFull && b.sha === any.sha), 'fixtures: a commit filter shows only that commit');
  }
}

// ── the log rows: the decisive line and the end, bounded ──
{
  const lines = Array.from({ length: 300 }, (_, i) => `line ${i + 1}`);
  const { rows, gap } = pickRows(lines, 100);
  ok(rows.some((r) => r.hot && r.text === 'line 101'), 'log: the decisive line is marked');
  ok(gap && rows.some((r) => r.text === '⋯'), 'log: a gap between the error and the end is shown');
  ok(rows.filter((r) => r.n !== '').length <= 48 && rows.at(-1)?.text === 'line 300', `log: ≤ 48 lines, ending at the tail (${rows.length} rows)`);
  const win = pickRows(Array.from({ length: 81 }, (_, i) => `w${i}`), 40, true);
  eq([win.rows.length, win.rows[40].hot, win.gap], [81, true, false], 'log: the server\'s window around the decisive line shows whole');
  const short = pickRows(['a', 'b'], -1);
  eq(short.rows.map((r) => r.text), ['a', 'b'], 'log: a short log shows whole');
}

// ── a live snapshot, when given (the e2e harness passes one) ──
{
  const p = process.argv[2];
  if (p && existsSync(p)) {
    const snap = JSON.parse(readFileSync(p, 'utf8'));
    const w = new World();
    w.load(snap);
    const f = feed(w, snap.at);
    const runningJobs = f.now.reduce((n, b) => n + b.jobs.filter((j) => j.state === 'running').length, 0);
    eq(f.running, runningJobs, `live: ${f.running} running in the status line = the running jobs listed`);
    const links = allLinks(f);
    ok(links.every((l) => /^https:\/\//.test(l.url)), `live: ${links.length} links, all https`);
    console.log(`live: now ${f.now.length} · just ${f.just.length} · earlier ${f.earlier.length} · needs ${f.needsN} · machines ${f.machines.map((m) => `${m.label} ${m.text}`).join(', ')}`);
  }
}

console.log(fails ? `${fails} FAILED` : 'all passed');
process.exit(fails ? 1 : 0);
