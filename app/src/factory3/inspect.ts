// Factory 3: the inspector's detail. A press on the board picks a run, a red main line or an
// app; this says what it is, where it stands, the steps or commits that explain it, and every
// link to its source of truth. Links come from the server's own data (a pipeline's `links` and
// `url`, a step's `url`, a repo's and an app's `links`, `status_url`); no host is written here.
// The log is log.ts' `logOf` (the decisive line, `around=decisive`).

import type { App, Pipeline, Repo, Step } from '../wire.ts';
import type { World } from '../world.ts';
import { flowJob } from '../flow/model.ts';
import { commitUrl, prUrl, runUrl } from '../now/view.ts';
import { ageAt, timer } from './scene.ts';

export type F3Link = { id: string; label: string; url: string };
/** A line of the middle column: a step of the run, or a commit of the main line. */
export type F3Item = { id: string; state: string; name: string; note: string };
export type F3Fact = { id: string; k: string; v: string };
export type F3Detail = {
  ok: boolean; kind: string; id: string; name: string; tag: string; title: string;
  state: string; word: string; facts: F3Fact[]; listTitle: string; items: F3Item[]; links: F3Link[];
  logId: string; logStep: string; logWorkflow: string; logLive: boolean; logFail: boolean;
};
export const NO_F3: F3Detail = {
  ok: false, kind: '', id: '', name: '', tag: '', title: '', state: '', word: '', facts: [], listTitle: '', items: [], links: [],
  logId: '', logStep: '', logWorkflow: '', logLive: false, logFail: false,
};

const isFail = (s: string) => s === 'failure' || s === 'error';
const short = (sha: string) => (sha ?? '').slice(0, 7);
const dur = (ms: number): string => {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
};
/** (the board's own ages: minutes of the clock, so the inspector and the board agree) */
const agoAt = (now: number, at: number) => { const a = ageAt(now, at); return a === 'now' ? 'just now' : `${a} ago`; };
type Linked = { links?: Record<string, string | undefined>; url?: string; status_url?: string };
const linksOf = (x: unknown): Record<string, string | undefined> => (x as Linked | undefined)?.links ?? {};

export function f3Detail(w: World, kind: string, id: string, now: number, where?: Map<string, string>): F3Detail {
  if (!id) return NO_F3;
  if (kind === 'repo') return repoDetail(w, id, now);
  if (kind === 'app') return appDetail(w, id, now);
  return runDetail(w, id, now, where);
}

type LogRow = { id: string; n: string; text: string; hot: boolean };
/** A Dagger step's lines carry its gutter ("33 : │ [5m58s] │ "): the same on every line, so it
 *  is cut and the width goes to what the line says. */
const GUTTER = /^\s*\d+\s*:\s*[│┆|!┃]?\s*(?:\[[0-9hms.]{1,10}\]\s*)?[│┆|┃]?\s?/;
export function tidyLog<T extends { rows: LogRow[] }>(v: T): T {
  if (!v.rows.length || !v.rows.some((r) => GUTTER.test(r.text) && /^\s*\d+\s*:/.test(r.text))) return v;
  return { ...v, rows: v.rows.map((r) => (/^\s*\d+\s*:/.test(r.text) ? { ...r, text: r.text.replace(GUTTER, '') } : r)) };
}

function stepState(s: string): string {
  return isFail(s) ? 'fail' : s === 'running' ? 'run' : s === 'success' ? 'pass' : s === 'pending' || s === 'blocked' ? 'wait' : 'none';
}

function runDetail(w: World, id: string, now: number, where0?: Map<string, string>): F3Detail {
  const p = w.pipelines.get(id);
  if (!p) return NO_F3;
  const r = w.repos.get(p.repo);
  const failed = isFail(p.state), running = p.state === 'running';
  // the step that explains it: the first failed one, or the newest running one
  let wfName = '', step = '', stepUrl = '', newest = -1;
  const items: F3Item[] = [];
  for (const wf of p.workflows ?? []) {
    const many = (p.workflows?.length ?? 0) > 1;
    for (const s of wf.steps ?? []) {
      const st = stepState(s.state);
      const ms = s.started ? (s.finished ?? (s.state === 'running' ? now : s.started)) - s.started : 0;
      if (items.length < 14) items.push({ id: `${wf.name}/${s.name}`, state: st, name: many ? `${wf.name} · ${s.name}` : s.name, note: st === 'run' ? timer(ms) : st === 'none' || st === 'wait' ? '' : `${dur(ms)}${s.cached ? ' cached' : ''}` });
      const mine = failed ? !step && isFail(s.state) : s.state === 'running' && (s.started ?? 0) >= newest;
      if (mine) { newest = s.started ?? 0; wfName = wf.name; step = s.name; stepUrl = (s as Step & { url?: string }).url ?? ''; }
    }
  }
  const job = flowJob(w, id, now);
  const m = job?.machine;
  // the berth the board shows it in (the board's own numbering), else where the server says it ran
  const where = where0?.get(id) ?? (!m ? '' : m.id === 'm:gha' ? 'github actions' : `${(m.host ?? m.label).toLowerCase()}${m.agent ? ` · ${m.agent}` : ''}`);
  const exp = p.expected_ms ?? r?.p50_build_ms ?? 0;
  const el = now - (p.started ?? p.created);
  const word = failed ? `failed at ${step || 'a step'} · ${agoAt(now, p.finished ?? now)}`
    : running ? `running ${step || '…'} · ${timer(el)}${exp ? ` of ~${timer(exp)}` : ''}`
    : p.state === 'pending' || p.state === 'blocked' ? `waiting ${timer(now - p.created)}`
    : p.state === 'success' ? `passed in ${dur((p.finished ?? now) - (p.started ?? p.created))} · ${agoAt(now, p.finished ?? now)}`
    : `${p.state} · ${agoAt(now, p.finished ?? p.created)}`;
  const facts: F3Fact[] = [];
  const fact = (k: string, v: string) => { if (v) facts.push({ id: k, k, v }); };
  fact('trigger', `${p.deploy ? 'deploy' : p.event === 'pull_request' ? `pr${p.pr ? ` #${p.pr}` : ''}` : p.event} on ${p.branch}`);
  fact('commit', `${short(p.sha)}${p.author ? ` · ${p.author.replace(/\[bot\]$/, '')}` : ''}`);
  fact(running ? 'runs on' : 'ran on', where);
  if (failed && job?.result.errorLine) fact('error', job.result.errorLine.slice(0, 200));
  if (p.flaky) fact('note', 'flaky: these steps passed on the same commit within 6 h');
  const links: F3Link[] = [];
  const add = (lid: string, label: string, url: string | undefined) => { if (url && !links.some((l) => l.url === url)) links.push({ id: lid, label, url }); };
  const pl = linksOf(p);
  add('rr', p.lane === 'gha' ? 'github actions' : 'roadrunner', runUrl(w, id, p.url));
  if (step) add('step', failed ? 'failing step' : 'step', stepUrl);
  add('commit', `commit ${short(p.sha)}`, pl.commit ?? commitUrl(w, p.repo, p.sha));
  if (p.pr) add('pr', `pr #${p.pr}`, pl.pr ?? prUrl(w, p.repo, p.pr));
  add('ci', 'woodpecker', p.lane === 'gha' ? '' : pl.woodpecker);
  const a = r?.app ? w.apps.get(r.app) : undefined;
  if (a) { add('app', `app ${a.id ?? ''}`, a.url); add('status', 'status', (a as Linked).status_url); }
  return {
    ok: true, kind: 'run', id, name: r?.name ?? p.repo.split('/')[1] ?? p.repo, tag: `${p.lane === 'gha' ? 'actions' : `#${p.number}`}`,
    title: (p.title ?? '').split('\n')[0].slice(0, 200), state: failed ? 'fail' : running ? 'run' : p.state === 'success' ? 'pass' : 'wait', word,
    facts, listTitle: 'steps', items, links,
    logId: step ? id : '', logStep: step, logWorkflow: wfName, logLive: running, logFail: failed,
  };
}

/** The run that turned this line red, when the world still holds it: the newest failed push on
 *  the default branch (the culprit's, else the head's, else any). */
function redRun(w: World, r: Repo): Pipeline | undefined {
  let best: Pipeline | undefined, rank = -1;
  for (const p of w.pipelines.values()) {
    if (p.repo !== r.id || !isFail(p.state) || p.branch !== r.default_branch) continue;
    const k = (p.sha === r.main.head ? 2 : p.sha === r.main.culprit ? 1 : 0) * 1e14 + (p.finished ?? p.created);
    if (k > rank) { rank = k; best = p; }
  }
  return best;
}

function repoDetail(w: World, id: string, now: number): F3Detail {
  const r = w.repos.get(id);
  if (!r) return NO_F3;
  const rec = r.main?.recent ?? [];
  const red = isFail(r.main?.state ?? '');
  const cul = rec.find((d) => d.sha === r.main.culprit) ?? (red ? rec.find((d) => isFail(d.state)) : undefined);
  const since = r.main.since || cul?.at || 0;
  const items: F3Item[] = rec.slice(-10).reverse().map((d) => ({
    id: d.sha, state: isFail(d.state) ? 'fail' : d.state === 'success' ? 'pass' : d.state === 'running' || d.state === 'pending' ? 'run' : 'none',
    name: `${short(d.sha)} ${d.title ?? ''}`.slice(0, 90), note: `${(d.author ?? '').replace(/\[bot\]$/, '')}${d.sha === r.main.culprit ? ' · culprit' : ''}`,
  }));
  const facts: F3Fact[] = [];
  const fact = (k: string, v: string) => { if (v) facts.push({ id: k, k, v }); };
  if (cul) fact('broke at', `${short(cul.sha)} · ${(cul.author ?? '').replace(/\[bot\]$/, '')}`);
  if (cul?.title) fact('commit', cul.title.split('\n')[0].slice(0, 160));
  fact('head', short(r.main.head));
  if (r.open_prs) fact('open prs', String(r.open_prs));
  if (r.lane && r.lane !== 'none') fact('lane', r.lane.replace(/_/g, ' '));
  const p = red ? redRun(w, r) : undefined;
  let step = '', wfName = '', stepUrl = '';
  if (p) for (const wf of p.workflows ?? []) { const s = (wf.steps ?? []).find((x) => isFail(x.state)); if (s) { step = s.name; wfName = wf.name; stepUrl = (s as Step & { url?: string }).url ?? ''; break; } }
  if (p && step) fact('fails at', `${step} · run #${p.number}`);
  const links: F3Link[] = [];
  const add = (lid: string, label: string, url: string | undefined) => { if (url && !links.some((l) => l.url === url)) links.push({ id: lid, label, url }); };
  if (p) add('rr', p.lane === 'gha' ? 'github actions' : 'roadrunner', runUrl(w, p.id ?? '', p.url));
  if (p && step) add('step', 'failing step', stepUrl);
  add('repo-rr', p ? 'all runs' : 'roadrunner', r.links?.cicd ?? r.links?.woodpecker);
  if (cul) add('commit', `commit ${short(cul.sha)}`, commitUrl(w, r.id, cul.sha));
  add('github', 'github', r.links?.github);
  const a = r.app ? w.apps.get(r.app) : undefined;
  if (a) { add('app', `app ${a.id ?? ''}`, a.url); add('status', 'status', (a as Linked).status_url); }
  return {
    ok: true, kind: 'repo', id, name: r.name, tag: `main line · ${r.default_branch}`, title: '',
    state: red ? 'fail' : 'pass', word: red ? `red${since ? ` for ${ageAt(now, since)}` : ''}` : 'green',
    facts, listTitle: 'last commits', items, links,
    logId: p && step ? (p.id ?? '') : '', logStep: step, logWorkflow: wfName, logLive: false, logFail: !!p,
  };
}

function appDetail(w: World, id: string, now: number): F3Detail {
  const a: App | undefined = w.apps.get(id);
  if (!a) return NO_F3;
  const r = a.repo ? w.repos.get(a.repo) : undefined;
  const changed = [...w.health].reverse().find((h) => h.app === id);
  const facts: F3Fact[] = [];
  const fact = (k: string, v: string) => { if (v) facts.push({ id: k, k, v }); };
  fact('live', `${short(a.live_sha ?? '')}${a.behind ? ` · ${a.behind} behind main` : a.live_sha && a.live_sha === a.main_sha ? ' · same as main' : ''}`);
  if (a.main_sha && a.main_sha !== a.live_sha) fact('main', short(a.main_sha));
  if (a.last_deploy) fact('last deploy', a.last_deploy.state);
  if (a.latency_ms) fact('latency', `${a.latency_ms} ms`);
  fact('checked', a.checked ? agoAt(now, a.checked) : '');
  fact('runtime', [a.runtime, a.team].filter(Boolean).join(' · '));
  if (a.note) fact('note', a.note);
  const items: F3Item[] = [];
  const deps = [...w.deploys.values()].filter((d) => d.app === id).sort((x, y) => y.started - x.started);
  for (const d of deps) items.push({ id: d.id ?? d.sha, state: d.state === 'failure' ? 'fail' : d.state === 'success' ? 'pass' : 'run', name: `${short(d.sha)} via ${d.via.replace('_', ' ')}`, note: agoAt(now, d.finished ?? d.started) });
  const links: F3Link[] = [];
  const add = (lid: string, label: string, url: string | undefined) => { if (url && !links.some((l) => l.url === url)) links.push({ id: lid, label, url }); };
  const al = linksOf(a);
  add('app', 'open app', a.url);
  add('status', 'status', (a as Linked).status_url);
  add('logs', 'logs', al.logs);
  add('repo', 'repo', al.repo ?? r?.links?.github);
  add('rr', 'roadrunner', r?.links?.cicd);
  const tone = a.health === 'up' ? 'pass' : a.health === 'down' ? 'fail' : a.health === 'degraded' ? 'run' : 'wait';
  return {
    ok: true, kind: 'app', id, name: id, tag: 'app', title: a.url.replace(/^https?:\/\//, '').replace(/\/$/, ''),
    state: tone, word: `${a.health}${changed ? ` since ${agoAt(now, changed.at)}` : ''}`,
    facts, listTitle: items.length ? 'deploys' : '', items: items.slice(0, 10), links,
    logId: '', logStep: '', logWorkflow: '', logLive: false, logFail: false,
  };
}
