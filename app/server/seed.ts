// Initial fleet at warm-up start (t0): repos with ~40 main dots of history, apps, engines,
// queues, lanes, ~150 open PRs, and the last 24 h of main commits/pipelines/deploys
// (synthesized as already-finished). Pure and portable.

import type { App, CiState, Commit, Deploy, DeployVia, Dot, LaneMode, Pipeline, PrPhase, Repo } from '../src/wire.ts';
import * as N from './names.ts';
import { createPr, later, prPush, reviewResult, scheduleReady, toMergeable } from './prs.ts';
import type { AppX, Lane, PrX, RepoX, Sim } from './sim.ts';
import { DAY, HOUR, MIN, SEC, TICK, round2 } from './util.ts';

const ENGINES: [string, 'dagger' | 'wp_agent' | 'gha_runner', number][] = [
  ['VM 153', 'dagger', 8], ['VM 154', 'dagger', 8],
  ['wp-agent-1', 'wp_agent', 4], ['wp-agent-2', 'wp_agent', 4], ['wp-agent-3', 'wp_agent', 4],
  ['gha-runner-1', 'gha_runner', 1], ['gha-runner-2', 'gha_runner', 1], ['gha-runner-3', 'gha_runner', 1], ['gha-runner-4', 'gha_runner', 1],
];
const TEAM_BY_ORG: Record<string, string[]> = {
  'Northwind-Labs': ['platform', 'devex', 'finance-eng', 'data'], 'Northwind-EMS': ['ems'], 'Northwind-Forge': ['forge'],
  'couplet-physical-ai': ['physical-ai'], 'copper-browser': ['copper'],
};

type Cand = { id: string; c: Commit; p?: Pipeline; d?: Deploy };

export function seedFleet(s: Sim): void {
  const r = s.rng;
  const T0 = s.t0;
  const st = s.state;

  // ── repos, ranked by a power law: ~25 hot, ~100 warm, the rest cold
  const taken = new Set<string>();
  const drafts: { org: string; name: string; key: number }[] = [];
  for (const o of N.ORGS) {
    const flags = new Set(N.FLAGSHIPS[o.id] ?? []);
    for (const name of N.repoNames(o.id, o.count, r, taken)) drafts.push({ org: o.id, name, key: flags.has(name) ? r() * 0.35 : 0.2 + r() });
    st.orgs[o.id] = { id: o.id, repos: o.count };
  }
  const rank = new Map<number, number>();
  drafts.map((d, i) => [d.key, i] as const).sort((a, b) => a[0] - b[0]).forEach(([, i], k) => rank.set(i, k));
  drafts.forEach((d, i) => {
    const k = rank.get(i)!;
    const tier: 0 | 1 | 2 = k < 25 ? 0 : k < 125 ? 1 : 2;
    const heat = round2(tier === 0 ? 0.6 + 0.4 * r() : tier === 1 ? 0.15 + 0.45 * r() : 0.01 + 0.14 * r());
    const x = r();
    const lane: LaneMode = tier === 0
      ? (x < 0.85 ? 'roadrunner_first' : x < 0.95 ? 'primary' : 'failsafe')
      : x < 0.64 ? 'roadrunner_first' : x < 0.7 ? 'gha_first' : x < 0.8 ? 'primary' : x < 0.84 ? 'ci' : x < 0.87 ? 'ci_only' : x < 0.95 ? 'failsafe' : 'none';
    const size = round2(r.range(0.25, 1.0));
    const id = `${d.org}/${d.name}`;
    const note = r.chance(0.025) ? (lane === 'gha_first' ? N.LANE_NOTES[0] : lane === 'failsafe' ? N.LANE_NOTES[1] : r.pick(N.LANE_NOTES)) : undefined;
    const repo: Repo = {
      id, org: d.org, name: d.name, default_branch: r.chance(0.06) ? 'master' : 'main', lane, ...(note ? { lane_note: note } : {}),
      main: { head: '', state: lane === 'none' ? 'none' : 'success', since: T0, culprit: null, recent: [] },
      heat, open_prs: 0,
      links: { github: `https://github.com/${id}`, ...(lane === 'ci' || lane === 'ci_only' || lane === 'none' ? {} : { woodpecker: `https://ci.dev.example.com/repos/${1000 + i}` }), cicd: `https://cicd.apps.example.com/repos/${id}` },
      p50_build_ms: Math.round(30 + 120 * size) * 1000,
    };
    const rx: RepoX = {
      r: repo, idx: i, w: heat * heat, tier, size, sec: r.chance(tier === 0 ? 0.6 : 0.3), via: 'roadrunner',
      wpNum: r.int(40, 3000), ghaNum: r.int(20, 900), prNum: r.int(5, 900), mainCount: 0, ord: new Map(), settledOrd: 0, pushes: [], prs: [],
    };
    s.repos.push(rx);
    s.repoById.set(id, rx);
    st.repos[id] = repo;
    st.lanes[id] = { id, mode: lane, ...(note ? { note } : {}) };
  });
  s.cum = new Float64Array(s.repos.length);
  let acc = 0;
  s.repos.forEach((rx, i) => { acc += rx.r.lane === 'none' ? rx.w * 0.3 : rx.w; s.cum[i] = acc; });

  // ── apps: ~64 deployable repos, mostly hot/warm
  const lib = /-(lib|sdk|cli|rs|py|bench)$/;
  const pool = s.repos.filter((rx) => rx.r.lane !== 'none' && !lib.test(rx.r.name));
  const warm = pool.filter((rx) => rx.tier < 2).sort((a, b) => a.idx - b.idx);
  const cold = pool.filter((rx) => rx.tier === 2);
  const chosen: RepoX[] = [];
  while (chosen.length < 50 && warm.length) chosen.push(warm.splice(r.int(0, warm.length - 1), 1)[0]!);
  while (chosen.length < 64 && cold.length) chosen.push(cold.splice(r.int(0, cold.length - 1), 1)[0]!);
  chosen.sort((a, b) => a.idx - b.idx);
  for (const rx of chosen) {
    const slug = rx.r.name;
    rx.appId = slug;
    rx.r.app = slug;
    const x = r();
    rx.via = x < 0.8 ? 'roadrunner' : x < 0.93 ? 'gha' : 'manual';
    const a: App = {
      repo: rx.r.id, url: `https://${slug}.apps.example.com`, health: 'up', checked: T0, runtime: r.pick(N.RUNTIMES),
      team: r.pick(TEAM_BY_ORG[rx.r.org] ?? N.TEAMS),
    };
    const ax: AppX = { id: slug, a, rx, baseLat: r.int(35, 220), pinned: false, samples: [] };
    s.apps.push(ax);
    s.appById.set(slug, ax);
    st.apps[slug] = a;
  }
  s.appSlots = Array.from({ length: 600 }, () => [] as AppX[]);
  s.apps.forEach((ax, i) => {
    const slot = Math.floor((i * 600) / s.apps.length);
    s.appSlots[slot]!.push(ax);
    ax.a.checked = T0 - (600 - slot) * TICK;
  });
  const down = s.apps.filter((ax) => ax.rx.tier === 2);
  const pinned = down.length ? down[r.int(0, down.length - 1)]! : s.apps[s.apps.length - 1]!;
  pinned.pinned = true;
  pinned.a.health = 'down';
  const deg = s.apps.filter((ax) => !ax.pinned)[r.int(0, s.apps.length - 2)]!;
  deg.a.health = 'degraded';
  s.agenda.add(T0 + r.int(5, 20) * MIN, () => s.setHealth(deg, 'up'));
  for (const ax of s.apps) { const l = s.latency(ax); if (l !== undefined) ax.a.latency_ms = l; }

  // ── engines, queues
  for (const [id, kind, slots] of ENGINES) st.engines[id] = { id, kind, slots, busy: 0, cpu: 0.03, mem: 0.18, load: round2(r() * 0.4), running: [] };
  st.queues.roadrunner = { id: 'roadrunner', pending: 0, running: 0, oldest_wait_ms: 0, items: [] };
  st.queues.gha = { id: 'gha', pending: 0, running: 0, oldest_wait_ms: 0, items: [] };

  // ── main history per repo
  const cands: Cand[] = [];
  const wsum = acc;
  for (const rx of s.repos) {
    const lam = (0.0002 * 0.72 * 0.55 * rx.w) / wsum; // main pushes per ms, day-averaged
    const times: number[] = [];
    let t = T0 - 8 * MIN - r.exp(1 / lam) * 0.3;
    while (times.length < 40 && t > T0 - 60 * DAY) { times.push(Math.round(t / SEC) * SEC); t -= Math.max(30 * SEC, r.exp(1 / lam)); }
    times.reverse();
    const none = rx.r.lane === 'none';
    const endRed = !none && r.chance(0.065);
    let red = false;
    let since = times[0] ?? T0 - DAY;
    let culprit: string | null = null;
    const dots: Dot[] = times.map((at) => {
      const author = s.pickAuthor(true);
      const bot = author.endsWith('[bot]');
      const sha = r.hex(40);
      let state: CiState = 'success';
      if (none) state = 'none';
      else if (r.chance(0.08)) state = 'skipped';
      else if (r.chance(0.03)) state = r.chance(0.5) ? 'canceled' : 'error';
      else if (red ? r.chance(0.18) : r.chance(0.05)) state = 'failure';
      const d: Dot = { sha, at, state, author, ...(bot ? { bot } : {}), title: N.commitTitle(author, r) };
      if (state === 'failure' && !red) { red = true; since = at; culprit = sha; d.culprit = true; }
      if (state === 'success' && red) { red = false; since = at; culprit = null; }
      return d;
    });
    const last = dots[dots.length - 1];
    if (last && endRed && !red) { last.state = 'failure'; last.culprit = true; red = true; since = last.at; culprit = last.sha; }
    if (last && !endRed && red) {
      if (last.culprit) { delete last.culprit; culprit = null; }
      last.state = 'success'; red = false; since = last.at;
    }
    const m = rx.r.main;
    m.recent = dots;
    m.head = last?.sha ?? r.hex(40);
    if (!none) m.state = red ? 'failure' : 'success';
    m.since = since;
    m.culprit = culprit;
    dots.forEach((d, i) => rx.ord.set(d.sha, i + 1));
    rx.mainCount = rx.settledOrd = dots.length;

    // deploy marks for app repos
    let live: Dot | undefined;
    if (rx.appId) {
      const behind = r.chance(0.6) ? 0 : r.int(1, 3);
      for (let i = dots.length - 1 - behind; i >= 0; i--) if (dots[i]!.state === 'success') { live = dots[i]; break; }
      for (const d of dots) if (d === live || (live && d.at < live.at && d.state === 'success' && r.chance(0.7))) d.deployed = true;
      const a = s.appById.get(rx.appId)!.a;
      a.main_sha = m.head;
      if (live) { a.live_sha = live.sha; a.behind = rx.mainCount - rx.ord.get(live.sha)!; }
    }
    for (const d of dots) {
      if (d.at < T0 - DAY + 30 * MIN) continue;
      const id = `${rx.r.id}@${d.sha}`;
      const c: Commit = { repo: rx.r.id, sha: d.sha, branch: rx.r.default_branch, title: d.title, author: d.author, ...(d.bot ? { bot: true } : {}), at: d.at, stage: 'done', ci: d.state, pipelines: [] };
      const cand: Cand = { id, c };
      if (d.state !== 'none' && d.state !== 'skipped') {
        const p = synthPipeline(s, rx, d.sha, c.branch, d.at, d.state, true, false);
        cand.p = p;
        c.pipelines.push(pid(p));
        c.stage = d.state === 'success' ? 'done' : d.state === 'canceled' ? 'done' : 'failed';
        if (d.deployed && rx.appId) {
          const did = `${rx.appId}:${d.sha}`;
          const via: DeployVia = rx.via;
          cand.d = { app: rx.appId, repo: rx.r.id, sha: d.sha, via, state: 'success', started: p.finished! - 60 * SEC, finished: p.finished!, url: s.appById.get(rx.appId)!.a.url };
          c.deploy = { id: did, state: 'success' };
          c.stage = 'deployed';
          if (d === live) s.appById.get(rx.appId)!.a.last_deploy = { id: did, state: 'success' };
        }
      }
      cands.push(cand);
    }
  }

  // ── pull requests: ~150 open + recently merged/closed
  const phases: [PrPhase, number][] = [['draft', 0.12], ['checks', 0.26], ['review', 0.6], ['changes_requested', 0.7], ['mergeable', 0.94], ['conflict', 1]];
  const ciRepos = s.repos.filter((rx) => rx.r.lane !== 'none');
  const pickRepo = (): RepoX => { for (;;) { const rx = s.repos[r.weighted(s.cum)]!; if (rx.r.lane !== 'none') return rx; } };
  for (let i = 0; i < 150; i++) {
    const rx = i % 5 === 4 ? r.pick(ciRepos) : pickRepo();
    const author = s.pickAuthor(false);
    const x = r();
    const phase = phases.find(([, p]) => x < p)![0];
    const created = Math.round(T0 - Math.min(30 * DAY, r.exp(1.5 * DAY)) - 10 * MIN);
    const prX = createPr(s, rx, author, phase, created);
    const pr = prX.pr;
    const updated = Math.max(created, Math.round(T0 - 5 * MIN - r.exp(4 * HOUR)));
    const ci: CiState = phase === 'checks' ? (r.chance(0.8) ? 'failure' : 'error') : phase === 'draft' && r.chance(0.4) ? 'failure' : 'success';
    const sha = r.hex(40);
    const at = Math.max(created, updated - r.int(60, 600) * SEC);
    const c: Commit = { repo: rx.r.id, sha, branch: prX.branch, title: phase === 'draft' ? 'wip' : pr.title, author, ...(pr.bot ? { bot: true } : {}), at, pr: pr.number, stage: ci === 'success' ? 'gating' : 'failed', ci, pipelines: [] };
    const p = synthPipeline(s, rx, sha, prX.branch, at, ci, false, true);
    c.pipelines.push(pid(p));
    const cid = `${rx.r.id}@${sha}`;
    cands.push({ id: cid, c, p });
    prX.commits.push(cid);
    prX.pipelines.push(pid(p));
    prX.lastCi = ci;
    pr.head_sha = sha;
    pr.checks[0]!.state = p.workflows[0]!.state;
    if (rx.sec && pr.checks[1]) pr.checks[1].state = p.workflows[1]?.state ?? 'success';
    pr.updated = updated;
    if (phase !== 'draft' && phase !== 'checks') prX.timeline.push({ at: Math.max(created, updated - HOUR), phase: 'review' });
    if (phase !== 'review' && phase !== 'draft' && phase !== 'checks') prX.timeline.push({ at: updated, phase });
    const reviewer = r.pick(N.HUMANS.filter((h) => h !== author));
    if (!pr.bot && phase !== 'draft' && phase !== 'checks') pr.review.ai = phase === 'review' ? r.pick(['pending', 'commented', 'approved'] as const) : r.pick(['commented', 'approved'] as const);
    if (phase === 'changes_requested' || phase === 'mergeable' || phase === 'conflict') pr.review.human = reviewer;
    if (T0 - updated >= 30 * MIN) pr.stale_ms = Math.floor((T0 - updated) / (5 * MIN)) * 5 * MIN;
    const soon = (lo: number, hi: number): number => r.range(lo, hi) * MIN;
    if (phase === 'draft') scheduleReady(s, prX);
    else if (phase === 'checks') later(s, prX, soon(2, 90), () => prPush(s, prX));
    else if (phase === 'review') {
      if (pr.author === 'renovate[bot]') later(s, prX, soon(2, 30), () => toMergeable(s, prX));
      else later(s, prX, soon(2, 150), () => reviewResult(s, prX));
    } else if (phase === 'mergeable') toMergeable(s, prX);
    else later(s, prX, soon(5, 120), () => prPush(s, prX));
  }
  for (let i = 0; i < 45; i++) {
    const rx = pickRepo();
    const author = s.pickAuthor(false);
    const x = r();
    const phase: PrPhase = x < 0.1 ? 'closed' : rx.appId && x < 0.75 ? 'deployed' : 'merged';
    const updated = Math.round(T0 - r.range(5 * MIN, 23 * HOUR));
    const created = Math.round(updated - r.exp(DAY) - 20 * MIN);
    const prX: PrX = createPr(s, rx, author, phase, created);
    const pr = prX.pr;
    pr.head_sha = r.hex(40);
    pr.updated = updated;
    for (const ch of pr.checks) ch.state = 'success';
    if (!pr.bot) { pr.review.ai = 'approved'; pr.review.human = r.pick(N.HUMANS.filter((h) => h !== author)); }
    prX.timeline = [{ at: created, phase: 'checks' }, { at: created + 20 * MIN, phase: 'review' }, { at: updated - 10 * MIN, phase: 'mergeable' }, { at: updated - (phase === 'deployed' ? 4 * MIN : 0), phase: phase === 'closed' ? 'closed' : 'merged' }];
    if (phase === 'deployed') prX.timeline.push({ at: updated, phase });
  }

  // ── commits/pipelines/deploys of the last 24 h, oldest first, capped
  cands.sort((a, b) => a.c.at - b.c.at);
  const keepFrom = Math.max(0, cands.length - 2400);
  cands.forEach((cd, i) => {
    const inState = i >= keepFrom;
    if (inState) st.commits[cd.id] = cd.c; else s.archCommits.set(cd.id, cd.c);
    if (cd.p) {
      const id = pid(cd.p);
      if (inState && cd.p.finished! >= T0 - 2 * HOUR) st.pipelines[id] = cd.p; else s.archPipes.set(id, cd.p);
    }
    if (cd.d) { if (inState) st.deploys[`${cd.d.app}:${cd.d.sha}`] = cd.d; else s.archDeploys.set(`${cd.d.app}:${cd.d.sha}`, cd.d); }
  });

  s.nextWave = T0 + Math.round(r.range(0.5, 4) * 600) * TICK;
  s.nextTrip = T0 + Math.round(r.range(8, 45) * 600) * TICK;
  s.nextIncident = T0 + Math.round(r.exp(8 * MIN) / TICK) * TICK;
}

const pidOf = new WeakMap<Pipeline, string>();
const pid = (p: Pipeline): string => pidOf.get(p)!;

/** A finished pipeline for seeded history, with consistent step timing and outcome. */
function synthPipeline(s: Sim, rx: RepoX, sha: string, branch: string, at: number, outcome: CiState, isMain: boolean, isPr: boolean): Pipeline {
  const r = s.rng;
  const lane: Lane = s.laneFor(rx);
  const { id, number, url } = s.newPipeId(rx, lane);
  const pl = s.plan(rx, isMain, lane);
  const created = at + r.int(3, 20) * TICK;
  const started = created + r.int(30, 400) * TICK;
  const failIdx = outcome === 'failure' ? r.pick([2, 3, 3, 3, 4]) : outcome === 'error' ? r.int(0, 1) : outcome === 'canceled' ? r.int(0, 4) : -1;
  let end = started;
  pl.wfs.forEach((wf, wi) => {
    if (wi === pl.deployWf) return;
    let t = started;
    wf.state = 'success';
    wf.started = t;
    let stopped = false;
    wf.steps.forEach((step, si) => {
      if (stopped) { step.state = 'skipped'; return; }
      step.started = t;
      t += pl.dur[wi]![si]!;
      if (pl.cached[wi]![si]) step.cached = true;
      if (wi === 0 && si === failIdx) {
        if (outcome === 'canceled') t = step.started + Math.round(pl.dur[wi]![si]! / 2 / TICK) * TICK;
        step.state = outcome;
        step.exit_code = outcome === 'error' ? 137 : outcome === 'failure' ? 1 : undefined;
        if (step.exit_code === undefined) delete step.exit_code;
        wf.state = outcome;
        stopped = true;
      } else { step.state = 'success'; step.exit_code = 0; }
      step.finished = t;
    });
    wf.finished = t;
    end = Math.max(end, t);
  });
  if (pl.deployWf >= 0) {
    const dw = pl.wfs[pl.deployWf]!;
    if (outcome === 'success') {
      let t = pl.wfs[0]!.finished! + 2 * SEC;
      dw.state = 'success';
      dw.started = t;
      dw.steps.forEach((step, si) => { step.started = t; t += pl.dur[pl.deployWf]![si]!; step.finished = t; step.state = 'success'; step.exit_code = 0; });
      dw.finished = t;
      end = Math.max(end, t);
    } else { dw.state = 'skipped'; dw.steps.forEach((x) => (x.state = 'skipped')); }
  }
  const engines = lane === 'gha' ? ['gha-runner-1', 'gha-runner-2', 'gha-runner-3', 'gha-runner-4'] : ['VM 153', 'VM 154', 'wp-agent-1', 'wp-agent-2', 'wp-agent-3'];
  const p: Pipeline = {
    lane, repo: rx.r.id, number, sha, branch, event: isPr ? 'pull_request' : 'push', state: outcome, created, workflows: pl.wfs, url,
    expected_ms: (rx.r.p50_build_ms ?? 150000) + (pl.deployWf >= 0 ? 60000 : 0), started, engine: r.pick(engines), finished: end,
  };
  pidOf.set(p, id);
  return p;
}

