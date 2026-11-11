// LIVE FLOW model (src/flow/model.ts): grouping, fan-out, bands at their edges, kind
// classification, machine + slot, the failing step + its error line, deploy + health, the
// filters, the caps, memoization and the cost on the recorded fleet. Run:
//   bun app/tools/flow.test.ts
import { readFileSync } from 'node:fs';
import { World } from '../src/world.ts';
import {
  EARLIER_CAP, EARLIER_MS, JOBS_CAP, JUST_CAP, JUST_MS, NOW_CAP, WAIT_MS,
  decisiveIndex, flowJob, flowMachine, flowOf, maskLine, flowState, hostOfName, jobName, kindOf, nameKind,
  type FlowEvent, type FlowView,
} from '../src/flow/model.ts';

let fails = 0;
const ok = (c: unknown, m: string) => { if (c) console.log('ok', m); else { fails++; console.log('FAIL', m); } };
const eq = (a: unknown, b: unknown, m: string) => {
  const x = JSON.stringify(a), y = JSON.stringify(b);
  if (x === y) console.log('ok', m); else { fails++; console.log('FAIL', m, x, '!=', y); }
};
const MIN = 60_000, H = 3_600_000;
const here = new URL('.', import.meta.url).pathname;
const fixtures = `${here}../../contract/fixtures`;

// ───────────────────────── hand-made worlds ─────────────────────────
const NOW = 1_800_000_000_000;
type P = Record<string, any>;
let pn = 0;
function pipe(o: P): P {
  const n = ++pn;
  const lane = o.lane ?? 'roadrunner';
  return {
    id: o.id ?? (lane === 'gha' ? `gha:${n}` : `wp:${o.repo ?? 'o/a'}:${n}`), lane, repo: 'o/a', number: n, sha: 'aaa1111',
    branch: 'main', event: 'push', state: 'success', created: NOW - 10 * MIN, url: `https://ci.example.com/${n}`,
    workflows: [{ name: 'ci', state: o.state ?? 'success', steps: [{ name: 'build', state: o.state ?? 'success' }] }],
    ...o,
  };
}
function world(o: { pipelines?: P[]; commits?: P[]; engines?: P[]; deploys?: P[]; apps?: P[]; clusters?: P[]; repos?: P[]; at?: number }): World {
  const w = new World();
  const repos = o.repos ?? [
    { id: 'o/a', org: 'o', name: 'a', default_branch: 'main', lane: 'roadrunner_first', group: 'team:web', main: { head: '', state: 'success', since: 0, recent: [] }, heat: 0, open_prs: 0, links: { github: 'https://github.com/o/a' } },
    { id: 'o/b', org: 'o', name: 'b', default_branch: 'main', lane: 'roadrunner_first', group: 'team:power', main: { head: '', state: 'success', since: 0, recent: [] }, heat: 0, open_prs: 0, links: { github: 'https://github.com/o/b' } },
  ];
  w.load({
    protocol: '0.5', seq: 1, at: o.at ?? NOW, orgs: [], repos, commits: o.commits ?? [], pipelines: o.pipelines ?? [], prs: [],
    deploys: o.deploys ?? [], apps: o.apps ?? [], engines: o.engines ?? [], queues: [], lanes: [], watcher: null, stats: null,
    groups: [], clusters: o.clusters ?? [], flakes: [], trends: [],
  } as any);
  return w;
}
const commit = (o: P): P => ({ repo: 'o/a', sha: 'aaa1111', branch: 'main', title: 'fix the thing', author: 'dev-a', at: NOW - 10 * MIN, stage: 'done', ci: 'success', pipelines: [], ...o, id: `${o.repo ?? 'o/a'}@${o.sha ?? 'aaa1111'}` });
const bandOf = (v: FlowView, id: string) => v.events.find((e) => e.id === id)?.band;
const ev = (v: FlowView, pred: (e: FlowEvent) => boolean) => v.events.find(pred);

// ── states ──
eq(['success', 'failure', 'error', 'canceled', 'skipped', 'running', 'pending', 'blocked', 'none'].map(flowState),
  ['pass', 'fail', 'fail', 'cancelled', 'skipped', 'running', 'queued', 'waiting', 'waiting'], 'flowState maps every CiState');

// ── grouping + fan-out ──
{
  const w = world({
    commits: [commit({ sha: 's1', title: 'add the widget', author: 'dev-a' })],
    pipelines: [
      pipe({ sha: 's1', state: 'running', started: NOW - 9 * MIN, created: NOW - 10 * MIN, title: 'add the widget', workflows: [{ name: 'ci', state: 'running', steps: [{ name: 'clone', state: 'success' }, { name: 'test', state: 'running', started: NOW - MIN }, { name: 'push', state: 'pending' }] }] }),
      pipe({ sha: 's1', lane: 'gha', title: 'Security Scan', created: NOW - 10 * MIN + 2000, state: 'success', started: NOW - 9 * MIN, finished: NOW - 8 * MIN, workflows: [{ name: 'Security Scan', state: 'success', steps: [] }] }),
      pipe({ sha: 's1', lane: 'gha', title: 'Deploy Docs', created: NOW - 10 * MIN + 3000, state: 'pending', queue_pos: 2, workflows: [{ name: 'Deploy Docs', state: 'pending', steps: [] }] }),
      pipe({ sha: 's1', event: 'pull_request', branch: 'topic/x', pr: 7, created: NOW - 11 * MIN, state: 'failure', started: NOW - 11 * MIN, finished: NOW - 5 * MIN }),
      pipe({ repo: 'o/b', sha: 's1', created: NOW - 3 * MIN, state: 'success', finished: NOW - MIN }),
    ],
  });
  const v = flowOf(w, NOW);
  const push = v.events.find((e) => e.id === 'o/a@s1#push')!;
  ok(push, 'grouping: one push row per repo + sha + trigger (id `${repo}@${sha}#push`)');
  eq(push?.jobs.length, 3, 'fan-out: the push row carries its 3 pipelines (Roadrunner + 2 GHA)');
  eq(push?.jobs.map((j) => j.state), ['running', 'queued', 'pass'], 'jobs ordered: running, queued, then finished');
  eq([push?.kind, push?.title, push?.author, push?.branch, push?.band, push?.state], ['push', 'add the widget', 'dev-a', 'main', 'now', 'running'], 'the push row: kind, title, author, branch, band now, state running');
  eq(push?.url, 'https://github.com/o/a/commit/s1', 'a push links its GitHub commit');
  eq(push?.at, NOW - 10 * MIN, 'event time: the push (the commit time)');
  eq(push?.group, 'team:web', 'event group from the repo');
  const pr = v.events.find((e) => e.id === 'o/a@s1#pr')!;
  ok(pr && pr.kind === 'pr' && pr.pr === 7 && pr.branch === 'topic/x' && pr.url === 'https://github.com/o/a/pull/7', 'the same sha under a PR trigger is its own row (PR url, head branch)');
  ok(v.events.some((e) => e.id === 'o/b@s1#push'), 'the same sha in another repo is another row');
  const run = push.jobs[0];
  eq(run.step, { name: 'test', index: 2, count: 3, workflow: 'ci', started: NOW - MIN }, 'step: the running step of the running workflow (1-based index / count)');
  eq(push.jobs[1].queuePos, 2, 'a queued job keeps its queue position');
  eq([v.running, v.queued, v.idle], [1, 1, false], 'top strip: 1 running, 1 queued, not idle');
}

// ── merge, tag, cron firings, manual, re-runs ──
{
  const w = world({
    commits: [commit({ sha: 'm1', pr: 12, branch: 'main' }), commit({ sha: 'c1', at: NOW - 30 * H })],
    pipelines: [
      pipe({ sha: 'm1', created: NOW - 5 * MIN, finished: NOW - 2 * MIN }),
      pipe({ sha: 't1', event: 'tag', branch: 'v1.2.0', created: NOW - 5 * MIN, finished: NOW - MIN, workflows: [{ name: 'ci', state: 'success', steps: [] }] }),
      pipe({ sha: 'c1', event: 'cron', title: 'nightly', created: NOW - 60 * MIN, finished: NOW - 58 * MIN, workflows: [{ name: 'notify', state: 'success', steps: [] }] }),
      pipe({ sha: 'c1', event: 'cron', title: 'sync', created: NOW - 60 * MIN + 20_000, finished: NOW - 58 * MIN, workflows: [{ name: 'sync', state: 'success', steps: [] }] }),
      pipe({ sha: 'c1', event: 'cron', title: 'nightly', created: NOW - 30 * MIN, finished: NOW - 28 * MIN, workflows: [{ name: 'notify', state: 'success', steps: [] }] }),
      pipe({ sha: 'c1', event: 'manual', created: NOW - 20 * MIN, finished: NOW - 10 * MIN }),
      pipe({ sha: 'c1', event: 'manual', created: NOW - 4 * MIN, state: 'running', started: NOW - 4 * MIN }),
      pipe({ sha: 'r1', created: NOW - 90 * MIN, finished: NOW - 85 * MIN, state: 'failure' }),
      pipe({ sha: 'r1', created: NOW - 2 * MIN, state: 'running', started: NOW - 2 * MIN }),
    ],
  });
  const v = flowOf(w, NOW);
  ok(v.events.some((e) => e.id === 'o/a@m1#merge' && e.kind === 'merge' && e.pr === 12), 'a push on the default branch of a PR commit is a merge');
  const tag = v.events.find((e) => e.id === 'o/a@t1#tag');
  ok(tag && tag.jobs[0].kind === 'release', 'a tag is its own trigger and its pipeline is a release');
  // the firings at -60 and -30 min both sit in `earlier`: they fold into one row
  const crons = v.events.filter((e) => e.kind === 'cron');
  eq(crons.map((e) => [e.id, e.folded, e.foldedFail, e.title, e.author]), [['o/a@c1#cron~', 2, 0, 'nightly · sync', '']], 'earlier: a cron that fired twice on one sha is one folded row (titles merged, no author)');
  const cw = world({
    commits: [commit({ sha: 'c1', at: NOW - 30 * H })],
    pipelines: [
      pipe({ sha: 'c1', event: 'cron', title: 'nightly', created: NOW - 40 * MIN, finished: NOW - 38 * MIN, state: 'failure', workflows: [{ name: 'notify', state: 'failure', steps: [] }] }),
      pipe({ sha: 'c1', event: 'cron', title: 'nightly', created: NOW - 10 * MIN, finished: NOW - 8 * MIN, workflows: [{ name: 'notify', state: 'success', steps: [] }] }),
      pipe({ sha: 'c1', event: 'cron', title: 'sync', created: NOW - 10 * MIN + 20_000, finished: NOW - 8 * MIN, workflows: [{ name: 'sync', state: 'success', steps: [] }] }),
    ],
  });
  const cv = flowOf(cw, NOW);
  const c10 = cv.events.find((e) => e.id === `o/a@c1#cron@${NOW - 10 * MIN}`);
  eq([c10?.band, c10?.jobs.length, c10?.at, c10?.title, c10?.author], ['just', 2, NOW - 10 * MIN, 'nightly · sync', ''], 'cron: a firing is a row `…#cron@<t0>`, its jobs (within a minute) share it, its time is the firing (not the old commit), its title the cron names');
  eq(cv.events.filter((e) => e.kind === 'cron').map((e) => [e.id, e.band, e.state]).sort(), [[`o/a@c1#cron@${NOW - 10 * MIN}`, 'just', 'pass'], [`o/a@c1#cron@${NOW - 40 * MIN}`, 'earlier', 'fail']].sort(), 'cron: one row per firing across bands (a single earlier firing is not folded)');
  eq(v.events.filter((e) => e.kind === 'manual').map((e) => e.band).sort(), ['just', 'now'].sort(), 'manual: each trigger is a row');
  const bw = world({ commits: [commit({ sha: 'k1', author: 'dev-a' })], pipelines: [pipe({ sha: 'k1', event: 'manual', author: 'ci-woodpecker-bot', created: NOW - MIN, finished: NOW })] });
  eq(flowOf(bw, NOW).events.map((e) => [e.author, e.bot, e.title]), [['ci-woodpecker-bot', true, 'fix the thing']], 'manual: the one who ran it (a -bot is a bot), the commit title');
  const r1 = v.events.filter((e) => e.sha === 'r1');
  eq(r1.map((e) => [e.id, e.band]).sort(), [['o/a@r1#push', 'earlier'], [`o/a@r1#push@${NOW - 2 * MIN}`, 'now']].sort(), 'a re-run of a push much later is a new row (the first run keeps the plain id)');
}

// ── waiting for CI ──
{
  const w = world({
    commits: [
      commit({ sha: 'w1', stage: 'pushed', at: NOW - MIN, title: 'just pushed' }),
      commit({ sha: 'w2', stage: 'pushed', at: NOW - WAIT_MS - 1000, title: 'too old' }),
      commit({ sha: 'w3', stage: 'pushed', at: NOW - MIN, pr: 3, branch: 'main' }),
    ],
  });
  w.apply({ t: 'delta', seq: 2, at: NOW, ops: [{ op: 'event', e: { k: 'push', repo: 'o/b', sha: 'w4', branch: 'feat', author: 'dev-b', title: 'streamed', at: NOW - 30_000 } }] } as any);
  const v = flowOf(w, NOW);
  const w1 = v.events.find((e) => e.id === 'o/a@w1#push');
  eq([w1?.band, w1?.state, w1?.jobs.length, w1?.title], ['now', 'waiting', 0, 'just pushed'], 'a pushed commit with no pipeline: a `now` row, waiting for CI');
  ok(!v.events.some((e) => e.sha === 'w2'), `waiting lasts ≤ ${WAIT_MS / MIN} min`);
  ok(v.events.some((e) => e.id === 'o/a@w3#merge'), 'a waiting merge is a merge row');
  const w4 = v.events.find((e) => e.id === 'o/b@w4#push');
  eq([w4?.band, w4?.branch, w4?.author, w4?.title], ['now', 'feat', 'dev-b', 'streamed'], 'a recent push event with no pipeline yet: waiting');
  eq([v.idle, v.waiting, v.running, v.queued], [false, 3, 0, 0], 'waiting rows are not idle, and counted apart from jobs');
  eq(v.lastEventAt, NOW - 30_000, 'lastEventAt: the newest event');
}

// ── bands at their edges ──
{
  const mk = (sha: string, finished: number) => pipe({ sha, created: finished - 5 * MIN, started: finished - 5 * MIN, finished });
  const w = world({
    pipelines: [
      mk('j0', NOW - JUST_MS), mk('j1', NOW - JUST_MS - 1), mk('e0', NOW - EARLIER_MS), mk('e1', NOW - EARLIER_MS - 1),
      pipe({ sha: 'q0', state: 'pending', created: NOW - 3 * H }),
      pipe({ sha: 'b0', state: 'blocked', created: NOW - MIN }),
    ],
  });
  const v = flowOf(w, NOW);
  eq(bandOf(v, 'o/a@j0#push'), 'just', `finished exactly ${JUST_MS / MIN} min ago: just finished`);
  eq(bandOf(v, 'o/a@j1#push'), 'earlier', '1 ms older: earlier');
  eq(bandOf(v, 'o/a@e0#push'), 'earlier', 'finished exactly 2 h ago: earlier');
  eq(bandOf(v, 'o/a@e1#push'), undefined, 'older than 2 h: dropped');
  eq(bandOf(v, 'o/a@q0#push'), 'now', 'queued for 3 h: still now (anything live is now)');
  eq(bandOf(v, 'o/a@b0#push'), 'now', 'blocked (waiting on approval): now');
  eq(v.events.map((e) => e.band), [...v.events.map((e) => e.band)].sort((a, b) => ['now', 'just', 'earlier'].indexOf(a) - ['now', 'just', 'earlier'].indexOf(b)), 'events in band order: now, just, earlier');
}

// ── kind classification ──
{
  const k = (names: string[], o: P = {}) => kindOf(pipe({ workflows: names.map((name) => ({ name, state: 'success', steps: [] })), ...o }) as any);
  eq(k(['ci']), 'ci', 'kind: `ci` stays ci');
  eq(k(['ci', 'deploy']), 'deploy', 'kind: a deploy workflow → deploy');
  eq(k(['ci'], { deploy: true }), 'deploy', 'kind: Pipeline.deploy → deploy');
  eq(k(['ci'], { event: 'tag' }), 'release', 'kind: a tag → release');
  eq(k(['release']), 'release', 'kind: release');
  eq(k(['Deploy Docs'], { lane: 'gha' }), 'deploy', 'kind: GHA "Deploy Docs" → deploy');
  eq(k(['lint']), 'lint', 'kind: lint');
  eq(k(['Security Scan']), 'lint', 'kind: a security scan counts as lint (a static check)');
  eq(k(['unit-tests', 'e2e']), 'test', 'kind: tests');
  eq(k(['image', 'build']), 'build', 'kind: build');
  eq(k(['notification-outbox']), 'ci', 'kind: unknown names → ci');
  eq(k(['release-lint']), 'lint', 'kind: a name goes by its last keyword (release-lint lints)');
  eq(k(['Windows preview installer'], { lane: 'gha' }), 'release', 'kind: an installer is a release artifact');
  eq(k(['Artifact compatibility'], { lane: 'gha' }), 'test', 'kind: a compatibility check is a test');
  eq(k(['deploy-staging']), 'deploy', 'kind: staging is not a tag');
  eq(k(['ci', 'pr-check']), 'ci', 'kind: ci + pr-check stays ci');
  eq(k(['ml']), 'build', 'kind: ml → build');
  eq(k([], { lane: 'gha', title: 'Deploy App' }), 'deploy', 'kind: a GHA run without jobs goes by its title');
  eq(nameKind('esign-sync'), null, 'nameKind: no keyword → null');
  eq(jobName(pipe({ workflows: ['ci', 'deploy', 'docs', 'image', 'ci'].map((name) => ({ name, state: 'success', steps: [] })) }) as any), 'ci · deploy · docs +1', 'job name: ≤ 3 workflow names, then +N');
}

// ── machines and slots ──
{
  const engines = [
    { id: 'wp-agent-2', kind: 'wp_agent', label: 'dagger-ci-153-2', host: 'VM 153', online: true, slots: 3, busy: 1, running: ['wp:o/a:r2'] },
    { id: 'wp-agent-1', kind: 'wp_agent', label: 'dagger-ci-153-1', host: 'VM 153', online: true, slots: 3, busy: 2, running: ['wp:o/a:r0', 'wp:o/a:r1'] },
    { id: 'wp-agent-3', kind: 'wp_agent', label: 'dagger-ci-154-1', host: 'VM 154', online: false, slots: 3, busy: 0, running: [] },
    { id: 'wp-agent-9', kind: 'wp_agent', label: 'rr-mac-mini-1', host: 'Mac mini', online: true, slots: 2, busy: 1, running: ['wp:o/b:mac'] },
    { id: 'dagger:VM 153', kind: 'dagger', host: 'VM 153', online: true, slots: 6, busy: 3, running: [], agents: ['wp-agent-1', 'wp-agent-2'] },
  ];
  const run = (id: string, engine: string, o: P = {}) => pipe({ id, engine, state: 'running', started: NOW - MIN, sha: id, ...o });
  const w = world({
    engines,
    pipelines: [
      run('wp:o/a:r0', 'dagger-ci-153-1'), run('wp:o/a:r1', 'dagger-ci-153-1'), run('wp:o/a:r2', 'dagger-ci-153-2'),
      run('wp:o/b:mac', 'rr-mac-mini-1', { repo: 'o/b' }), run('wp:o/a:old', 'dagger-ci-154-1', { state: 'success', finished: NOW - MIN }),
      pipe({ id: 'gha:1', lane: 'gha', state: 'running', started: NOW - MIN, sha: 'g1', title: 'CI', workflows: [{ name: 'CI', state: 'running', steps: [] }] }),
    ],
  });
  const v = flowOf(w, NOW);
  eq(v.machines.map((m) => [m.id, m.label, m.busy, m.slots, m.online]), [
    ['m:VM 153', 'VM 153', 3, 6, true], ['m:VM 154', 'VM 154', 0, 3, false], ['m:Mac mini', 'Mac mini', 1, 2, true], ['m:gha', 'GitHub runner', 1, undefined, undefined],
  ], 'machines: one per host (agents summed, the Dagger host not double-counted), VMs by number, then the Mac mini, then GitHub');
  const job = (id: string) => v.events.flatMap((e) => e.jobs).find((j) => j.id === id)!;
  eq([job('wp:o/a:r0').machine?.label, job('wp:o/a:r0').machine?.slot, job('wp:o/a:r0').machine?.agent], ['VM 153', 1, 'dagger-ci-153-1'], 'slot: the first job on agent 153-1 is VM 153 slot 1');
  eq(job('wp:o/a:r1').machine?.slot, 2, 'slot: its second job is slot 2');
  eq(job('wp:o/a:r2').machine?.slot, 4, 'slot: agent 153-2 numbers after 153-1’s 3 slots (slot 4 of 6)');
  eq([job('wp:o/b:mac').machine?.label, job('wp:o/b:mac').machine?.slot], ['Mac mini', 1], 'the Mac mini agent');
  eq([job('wp:o/a:old').machine?.label, job('wp:o/a:old').machine?.slot], ['VM 154', undefined], 'a finished job keeps its machine (no slot)');
  eq([job('gha:1').machine?.label, job('gha:1').ci], ['GitHub runner', 'gha'], 'GHA → GitHub runner');
  const m = flowMachine(w, 'm:VM 153', NOW)!;
  eq(m.running.map((j) => j.id).sort(), ['wp:o/a:r0', 'wp:o/a:r1', 'wp:o/a:r2'], 'flowMachine(host): what else it runs now');
  eq(flowMachine(w, 'wp-agent-2', NOW)?.machine.id, 'm:VM 153', 'flowMachine takes an engine id (its host)');
  eq(flowMachine(w, 'dagger-ci-153-1', NOW)?.machine.id, 'm:VM 153', 'flowMachine takes an agent label');
  eq(flowMachine(w, 'm:gha', NOW)?.running.map((j) => j.id), ['gha:1'], 'flowMachine(gha): the running GHA runs');
  eq(flowMachine(w, 'nope', NOW), null, 'flowMachine: unknown → null');
  const w2 = world({ engines, pipelines: [run('wp:o/a:r0', 'dagger-ci-153-1', { workflows: [
    { name: 'ci', state: 'success', engine: 'dagger-ci-153-2', steps: [] }, { name: 'deploy', state: 'running', engine: 'dagger-ci-153-1', steps: [] },
  ] })] });
  eq(flowJob(w2, 'wp:o/a:r0', NOW)?.workflows.map((x) => [x.machine?.agent, x.machine?.slot]), [['dagger-ci-153-2', undefined], ['dagger-ci-153-1', 1]], 'flowJob: each workflow on its own agent (the slot where the pipeline runs now)');
  eq([hostOfName('dagger-ci-154-2'), hostOfName('rr-mac-mini-1'), hostOfName('custom')], ['VM 154', 'Mac mini', 'custom'], 'host from an unknown agent name');
}

// ── failing step + error line; deploy + health ──
{
  const w = world({
    clusters: [{ id: 'f:abc', signature: 'test · test · assertion failed', step: 'test', class: 'test', line: 'assertion failed: left == right', count: 1, count_1h: 1, repos: ['o/a'], repo_count: 1, groups: [], first_seen: 0, last_seen: 0, examples: [], open: 1 }],
    pipelines: [
      pipe({ id: 'wp:o/a:f', sha: 'f1', state: 'failure', started: NOW - 6 * MIN, finished: NOW - 2 * MIN, workflows: [
        { name: 'ci', state: 'success', steps: [{ name: 'clone', state: 'success', started: NOW - 6 * MIN, finished: NOW - 5 * MIN }] },
        { name: 'test', state: 'failure', steps: [{ name: 'unit', state: 'success', cached: true }, { name: 'test', state: 'failure', cluster: 'f:abc', started: NOW - 5 * MIN, finished: NOW - 2 * MIN }, { name: 'later', state: 'failure' }] },
      ] }),
      pipe({ id: 'wp:o/a:d', sha: 'd1', deploy: true, state: 'success', started: NOW - 6 * MIN, finished: NOW - MIN, workflows: [{ name: 'ci', state: 'success', steps: [] }, { name: 'deploy', state: 'success', steps: [] }] }),
      pipe({ id: 'gha:sec', lane: 'gha', sha: 'd1', title: 'Security Scan', state: 'success', finished: NOW - 3 * MIN, workflows: [{ name: 'Security Scan', state: 'success', steps: [] }] }),
      pipe({ id: 'wp:o/a:x', sha: 'x1', state: 'canceled', started: NOW - 6 * MIN, finished: NOW - 4 * MIN }),
    ],
    deploys: [{ id: 'o/a@d1', app: 'alpha', repo: 'o/a', sha: 'd1', via: 'roadrunner', state: 'success', started: NOW - 3 * MIN, finished: NOW - MIN, pipeline: 'wp:o/a:d' }],
    apps: [{ id: 'alpha', repo: 'o/a', url: 'https://alpha.example.com/', health: 'degraded', checked: NOW }],
  });
  const v = flowOf(w, NOW);
  const f = v.events.find((e) => e.sha === 'f1')!.jobs[0];
  eq([f.result.state, f.result.failStep, f.result.failWorkflow, f.result.errorLine, f.result.durationMs], ['fail', 'test', 'test', 'assertion failed: left == right', 4 * MIN], 'fail: the first failed step, its workflow, the cluster’s error line, the duration');
  const d = v.events.find((e) => e.sha === 'd1')!;
  eq(d.jobs[0].result.deploy, { app: 'alpha', sha: 'd1', state: 'pass', via: 'roadrunner', url: 'https://alpha.example.com/', health: 'degraded' }, 'deploy: which app got which sha, its url and health now');
  ok(!d.jobs[1].result.deploy, 'the deploy result sits on the pipeline that ran it only');
  eq(v.events.find((e) => e.sha === 'x1')?.state, 'cancelled', 'cancelled');
  eq(v.events.find((e) => e.sha === 'f1')?.state, 'fail', 'event state: the worst finish');
  const det = flowJob(w, 'wp:o/a:f', NOW)!;
  eq(det.workflows.map((x) => [x.name, x.state, x.steps.length]), [['ci', 'pass', 1], ['test', 'fail', 3]], 'flowJob: the workflows');
  eq(det.workflows[1].steps[1], { name: 'test', state: 'fail', started: NOW - 5 * MIN, ms: 3 * MIN, errorLine: 'assertion failed: left == right' }, 'flowJob: a failed step: state, duration, error line');
  eq(det.workflows[1].steps[0].cached, true, 'flowJob: a cached step');
  eq(flowJob(w, 'wp:o/a:d', NOW)?.result.deploy?.app, 'alpha', 'flowJob: the deploy result');
  eq(flowJob(w, 'nope', NOW), null, 'flowJob: unknown → null');
}

// ── filters ──
{
  const w = world({
    commits: [commit({ sha: 'a1', author: 'Dev-A' }), commit({ repo: 'o/b', sha: 'b1', author: 'dev-b', branch: 'feat' })],
    pipelines: [
      pipe({ sha: 'a1', state: 'running', started: NOW - MIN }),
      pipe({ repo: 'o/b', sha: 'b1', branch: 'feat', finished: NOW - MIN }),
    ],
  });
  const ids = (f: any) => flowOf(w, NOW, f).events.map((e) => e.sha).sort();
  eq(ids(undefined), ['a1', 'b1'], 'no filter: everything');
  eq(ids({ repo: 'o/b' }), ['b1'], 'filter: repo');
  eq(ids({ group: 'team:web' }), ['a1'], 'filter: team (group)');
  eq(ids({ branch: 'feat' }), ['b1'], 'filter: branch');
  eq(ids({ author: '@dev-a' }), ['a1'], 'filter: mine (author handle, case-insensitive, @ optional)');
  eq(ids({ author: '' }), ['a1', 'b1'], 'filter: an empty handle is no filter');
  const none = flowOf(w, NOW, { repo: 'o/none' });
  eq([none.events.length, none.idle, none.running, none.queued], [0, true, 0, 0], 'a filter matching nothing: idle, no rows');
  const fb = flowOf(w, NOW, { repo: 'o/b' });
  eq([fb.idle, fb.running, fb.events[0]?.band, fb.lastEventAt], [true, 0, 'just', NOW - 10 * MIN], 'idle under a filter still shows just-finished and the last event time');
}

// ── caps ──
{
  const pipelines: P[] = [];
  for (let i = 0; i < 60; i++) pipelines.push(pipe({ sha: `n${i}`, state: 'running', created: NOW - i * 1000, started: NOW - i * 1000 }));
  for (let i = 0; i < 35; i++) pipelines.push(pipe({ sha: `j${i}`, created: NOW - 20 * MIN, finished: NOW - i * 10_000 }));
  for (let i = 0; i < 50; i++) pipelines.push(pipe({ sha: `e${i}`, created: NOW - H, finished: NOW - 20 * MIN - i * MIN }));
  for (let i = 0; i < 20; i++) pipelines.push(pipe({ sha: 'fan', state: 'running', created: NOW - 1000 - i, started: NOW - 1000 }));
  const v = flowOf(world({ pipelines }), NOW);
  const n = (b: string) => v.events.filter((e) => e.band === b).length;
  eq([n('now'), n('just'), n('earlier')], [NOW_CAP, JUST_CAP, EARLIER_CAP], `caps: now ${NOW_CAP}, just ${JUST_CAP}, earlier ${EARLIER_CAP}`);
  eq(v.running, 80, 'the running count is the whole fleet, not the capped rows');
  const fan = v.events.find((e) => e.sha === 'fan')!;
  eq([fan.jobs.length, fan.more], [JOBS_CAP, 20 - JOBS_CAP], `jobs per row capped at ${JOBS_CAP} (+ more)`);
  const nowT = v.events.filter((e) => e.band === 'now').map((e) => Math.max(e.at, ...e.jobs.map((j) => j.created)));
  ok(nowT.every((t, i) => i === 0 || nowT[i - 1] >= t), 'now: the newest event first');
  const justT = v.events.filter((e) => e.band === 'just').map((e) => e.finished!);
  ok(justT.every((t, i) => i === 0 || justT[i - 1] >= t) && justT[0] === NOW, 'just: the newest finish first');
  const earlyT = v.events.filter((e) => e.band === 'earlier').map((e) => e.finished!);
  ok(earlyT.every((t, i) => i === 0 || earlyT[i - 1] >= t) && earlyT[0] <= justT.at(-1)!, 'earlier: newest finish first, continuing just’s order');
}

// ── memoization ──
{
  const w = world({ pipelines: [pipe({ sha: 'm', state: 'running', started: NOW - MIN })] });
  const a = flowOf(w, NOW + 100);
  ok(flowOf(w, NOW + 900) === a, 'memo: the same second and world version → the same object');
  ok(flowOf(w, NOW + 100, { repo: '' }) === a && flowOf(w, NOW + 100, {}) === a, 'memo: empty filters are the same key');
  ok(flowOf(w, NOW + 1100) !== a, 'memo: a new second → a new view');
  const f1 = flowOf(w, NOW + 1100, { repo: 'o/a' });
  ok(flowOf(w, NOW + 1100, { repo: 'o/a' }) === f1, 'memo: an equal filter (new object) hits');
  w.apply({ t: 'delta', seq: 5, at: NOW, ops: [{ op: 'patch', kind: 'pipeline', id: [...w.pipelines.keys()][0], v: { state: 'success', finished: NOW } }] } as any);
  const b = flowOf(w, NOW + 1100, { repo: 'o/a' });
  ok(b !== f1 && b.events[0].state === 'pass', 'memo: a world change → recomputed');
}

// ───────────────────────── the recorded fleet ─────────────────────────
{
  const snap = JSON.parse(readFileSync(`${fixtures}/snapshot.json`, 'utf8'));
  const w = new World();
  w.load(snap);
  const v = flowOf(w, snap.at);
  const running = [...w.pipelines.values()].filter((p) => p.state === 'running').length;
  eq(v.running, running, `fixtures: ${running} running pipelines counted`);
  ok(v.events.length > 0 && v.events.length <= NOW_CAP + JUST_CAP + EARLIER_CAP, `fixtures: ${v.events.length} rows (now ${v.events.filter((e) => e.band === 'now').length}, just ${v.events.filter((e) => e.band === 'just').length}, earlier ${v.events.filter((e) => e.band === 'earlier').length})`);
  eq(new Set(v.events.map((e) => e.id)).size, v.events.length, 'fixtures: event ids unique');
  eq(new Set(v.events.flatMap((e) => e.jobs.map((j) => j.id))).size, v.events.reduce((n, e) => n + e.jobs.length, 0), 'fixtures: every pipeline in one row only');
  eq(v.machines.map((m) => `${m.label} ${m.busy}/${m.slots ?? '-'}`), ['VM 153 0/6', 'VM 154 2/6', 'GitHub runner 1/-'], 'fixtures: the machines strip');
  const job70 = v.events.flatMap((e) => e.jobs).find((j) => j.id === 'wp:Northwind-Labs/vivid-lantern:70');
  eq([job70?.machine?.label, job70?.machine?.slot, job70?.step?.name, job70?.step?.index, job70?.step?.count], ['VM 154', 4, 'test-server-2', 5, 11], 'fixtures: a running PR job on VM 154 slot 4, at step 5/11');
  const keen = v.events.find((e) => e.id.startsWith('Northwind-Labs/keen-anvil@') && e.kind === 'merge' || e.id.startsWith('Northwind-Labs/keen-anvil@') && e.kind === 'push');
  eq(keen?.jobs.map((j) => j.ci).sort(), ['gha', 'gha', 'roadrunner'], 'fixtures: a push fans out to Roadrunner + 2 GitHub Actions runs in one row');
  const hr = v.events.filter((e) => e.repo === 'Northwind-Labs/hollow-relay' && e.kind === 'cron');
  ok(hr.length > 1 && hr.every((e) => e.jobs.length <= 2), `fixtures: hollow-relay's cron firings are separate rows (${hr.length} in 2 h, ≤ 2 jobs each)`);
  const dep = v.events.flatMap((e) => e.jobs).filter((j) => j.result.deploy);
  ok(dep.length > 0 && dep.every((j) => j.result.deploy!.app && j.result.deploy!.sha), `fixtures: ${dep.length} jobs carry their deploy (app + sha)`);
  const failed = v.events.flatMap((e) => e.jobs).filter((j) => j.state === 'fail');
  ok(failed.length > 0 && failed.every((j) => j.result.failStep || (!w.pipelines.get(j.id)!.workflows.length && j.result.errorLine)), `fixtures: every failed job names its failing step, or says it failed before any step (${failed.length})`);
  ok(failed.some((j) => j.result.errorLine), 'fixtures: failed jobs carry the cluster error line');
  // cost on the recorded fleet, warm. Full: every cache invalidated (engines + pipelines moved,
  // so every row and job is re-derived). Tick: a new second and world version (a frame that did
  // not touch pipelines, commits, repos or engines).
  const N = 200;
  const full = () => { w.ver++; w.kv.engine++; w.kv.pipeline++; };
  for (let i = 0; i < 20; i++) { full(); flowOf(w, snap.at + i * 1000); }
  const t0 = performance.now();
  for (let i = 0; i < N; i++) { full(); flowOf(w, snap.at + i * 1000); }
  const ms = (performance.now() - t0) / N;
  ok(ms <= 1, `cost: a full flowOf on the recorded fleet ${ms.toFixed(3)} ms ≤ 1 ms (warm, every cache invalidated)`);
  const t2 = performance.now();
  for (let i = 0; i < N; i++) { w.ver++; flowOf(w, snap.at + i * 1000); }
  const tick = (performance.now() - t2) / N;
  ok(tick <= 0.5, `cost: a 1 Hz tick ${tick.toFixed(3)} ms`);
  const t1 = performance.now();
  for (let i = 0; i < N; i++) flowOf(w, snap.at + 5000);
  ok((performance.now() - t1) / N < 0.01, `memo hit ${(((performance.now() - t1) / N) * 1000).toFixed(1)} µs`);

  // the hour that followed: ids stay stable while a row lives; the view stays bounded and cheap
  const lines = readFileSync(`${fixtures}/hour.jsonl`, 'utf8').split('\n').filter(Boolean);
  let maxRows = 0, flips = 0, ticks = 0, sawWait = false, sawJust = 0;
  const times: number[] = [];
  const seenBand = new Map<string, string>();
  for (const line of lines) {
    const f = JSON.parse(line);
    if (!w.apply(f)) continue;
    const at = w.at;
    const a = performance.now();
    const fv = flowOf(w, at);
    const dt = performance.now() - a;
    ticks++;
    if (ticks > 20) times.push(dt);
    maxRows = Math.max(maxRows, fv.events.length);
    for (const e of fv.events) {
      if (e.state === 'waiting') sawWait = true;
      const prev = seenBand.get(e.id);
      if (prev === 'now' && e.band === 'just') sawJust++;
      if (prev === 'just' && e.band === 'now') flips++;
      seenBand.set(e.id, e.band);
    }
    if (seenBand.size > 5000) seenBand.clear();
  }
  ok(maxRows <= NOW_CAP + JUST_CAP + EARLIER_CAP, `hour: ≤ ${NOW_CAP + JUST_CAP + EARLIER_CAP} rows at every frame (max ${maxRows})`);
  ok(sawJust > 0, `hour: ${sawJust} rows went now → just finished under the same id`);
  times.sort((a, b) => a - b);
  const pct = (q: number) => times[Math.min(times.length - 1, Math.floor(times.length * q))];
  ok(pct(0.5) < 0.5 && pct(0.99) < 2, `hour: flowOf after each of ${ticks} frames: p50 ${pct(0.5).toFixed(3)} ms, p99 ${pct(0.99).toFixed(2)} ms (< 2), max ${times.at(-1)!.toFixed(2)} ms (GC included)`);
  console.log(`  (hour: re-runs back to now ${flips}, waiting rows seen: ${sawWait})`);
}

// ───────────────────────── the decisive line in a log tail ─────────────────────────
{
  // lf-3: a failed backend step whose cluster line is a SeaweedFS master's log line, normalized
  const cl = 'I1111 N:N.N master_grpc_server_assign.go:N assign count:N expected_data_size:N {"replication":{},"ttl":{"Count":N,"Unit":N},"version":N}: failed to find writab…';
  const assign = (t: string) => `I1111 ${t} master_grpc_server_assign.go:227 assign count:1 expected_data_size:349342 {"replication":{},"ttl":{"Count":0,"Unit":0},"version":3}: failed to find writable volumes for collection: replication:000 ttl: error: no writable volumes`;
  const tail = [
    'I1111 17:43:48.263728 node.go:221 topo failed to pick 1 from  0 node candidates',
    assign('17:43:49.002593'),
    'I1111 17:43:49.002663 master_grpc_server_volume.go:143 volume grow &{Option:{"replication":{}} Count:0 Force:false Reason:grpc assign}',
    assign('17:43:59.499068'),
    'I1111 17:44:00.749306 filer_notify.go:285 metadata log write failed /topics/.system/log/2026-11-11/17-36.2d296923: AssignVolume: rpc error',
    ...Array.from({ length: 150 }, (_, i) => ` + pkg${i}==1.${i}.0`),
    'INFO  [alembic.runtime.migration] Running upgrade 0034_access_requests -> 0035_private_groups, Audit pending narrow bindings.',
    'Installed 1 package in 0.55ms',
  ];
  eq(maskLine(assign('17:43:59.499068')).startsWith(maskLine(cl)), true, 'decisive: the raw lf-3 line masks to the normalized cluster line (a prefix)');
  eq(decisiveIndex(tail, cl), 3, 'decisive: the LAST tail line matching the lf-3 cluster line (index 3, not 1)');
  eq(decisiveIndex(tail, cl, 1), 1, 'decisive: the server\'s index wins when it sends one');
  eq(decisiveIndex(tail, cl, 999), 3, 'decisive: an out-of-range server index falls back to the matcher');
  eq(decisiveIndex(tail, 'error: something else entirely happened here'), -1, 'decisive: no line matches → -1');
  eq(decisiveIndex(tail, undefined), -1, 'decisive: no cluster line → -1');
  eq(maskLine('took [19m54s] and 100ms at /usr/local/cargo/registry/src/x/y/z.rs:12:5'), maskLine('took [N] and N at …/y/z.rs:N'), 'decisive: durations, paths and line:col mask alike on both sides');
  eq(maskLine('commit 0123456789abcdef0123456789abcdef01234567 bad at 2026-01-02T03:04:05.678Z'), maskLine('commit … bad at <time>'), 'decisive: shas and timestamps mask alike');
  eq(decisiveIndex(['\x1b[31merror[E0308]: mismatched types\x1b[0m', 'noise'], 'error[E0308]: mismatched types'), 0, 'decisive: ANSI colours are ignored');
  const t0 = performance.now();
  for (let i = 0; i < 20; i++) decisiveIndex(tail, 'nothing like this line appears in the tail at all, ever');
  const per = (performance.now() - t0) / 20;
  ok(per < 2, `decisive: a full miss over ${tail.length} lines takes ${per.toFixed(3)} ms (< 2)`);
}

if (fails) { console.log(`FAIL ${fails}`); process.exit(1); }
console.log('flow: all ok');
