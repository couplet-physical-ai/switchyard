// LIVE: the primary view's view model (views/now.contract). ZERO.md: one vertical, time-ordered
// feed that reads as event → what it started, where → how it ended. On top: what needs a human;
// then what runs right now; then what just finished (15 min) and earlier (2 h), dimmer.
//
// Built from the one World through the flow model (src/flow/model.ts). Every line carries the
// deep links it needs (built from server data only: Pipeline.url, Pr.url, App.url, Repo.links,
// and the optional Step.url / Engine.url / Queue.url / App.status_url when the server sends them).
// Bounded: the model caps its bands (40 / 20 / 30 events, 12 jobs each); the view caps what it
// adds (BROKEN_CAP needs, JOBS_SHOWN jobs a row, CHAIN_SHOWN results a done row).

import type { Upstream } from '../api.ts';
import type { World } from '../world.ts';
import type { App, Engine, Pipeline, Repo } from '../wire.ts';
import { flowJob, flowMachine, flowOf, type FlowEvent, type FlowJob, type FlowMachine, type FlowState, type FlowView } from '../flow/model.ts';
import { logAnswer, NO_LOG, type Log, type LogArgs } from './log.ts';

export interface NowDeps {
  world: () => World;
  /** The playhead (live: the server's now). */
  now: () => number;
  /** Minutes east of UTC, for clock times. */
  offsetMin: () => number;
  upstream: () => Upstream | null;
}

// ---- caps ----
export const BROKEN_CAP = 60;
export const BROKEN_SHOWN = 3;
export const JOBS_SHOWN = 8;
export const CHAIN_SHOWN = 4;
const STEPS_CAP = 80;
const RUNS_CAP = 24;
/** A running job this many times over its usual time (and over STUCK_MIN_MS) needs a human. */
const STUCK_X = 3;
const STUCK_MIN_MS = 15 * 60_000;
const QUEUE_STUCK_MS = 10 * 60_000;

// ---- words ----
export function fit(s: string, n: number): string {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  if (t.length <= n) return t;
  if (n <= 1) return '…';
  const head = t.slice(0, n - 1);
  let k = -1;
  for (let i = head.length - 1; i >= Math.floor(n * 0.5); i--) {
    if (' /-_.:,;('.includes(head[i])) { k = head[i] === ' ' ? i : i + 1; break; }
  }
  return (k > 0 ? head.slice(0, k) : head).trimEnd() + '…';
}
/** A ticking timer: 0:42, 4:05, 1:02:05. */
export function timer(ms: number): string {
  if (!isFinite(ms) || ms < 0) ms = 0;
  const s = Math.floor(ms / 1000), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  const ss = r < 10 ? `0${r}` : `${r}`;
  return h ? `${h}:${m < 10 ? '0' : ''}${m}:${ss}` : `${m}:${ss}`;
}
/** A finished duration: 42s, 3m 12s, 14m, 1h 05m. */
export function dur(ms: number | undefined): string {
  if (ms == null || !isFinite(ms) || ms < 0) return '';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return m < 10 && s % 60 ? `${m}m ${s % 60}s` : `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60 < 10 ? '0' : ''}${m % 60}m`;
}
export function ago(ms: number): string {
  if (ms < 45_000) return 'now';
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  const h = Math.floor(ms / 3_600_000), m = Math.floor((ms % 3_600_000) / 60_000);
  if (h >= 24) return `${Math.floor(h / 24)}d`;
  return m ? `${h}h ${m}m` : `${h}h`;
}
function hhmm(at: number, offsetMin: number, secs = false): string {
  const d = new Date(at + offsetMin * 60_000);
  const h = d.getUTCHours(), m = d.getUTCMinutes(), s = d.getUTCSeconds();
  const two = (x: number) => (x < 10 ? `0${x}` : `${x}`);
  return secs ? `${two(h)}:${two(m)}:${two(s)}` : `${two(h)}:${two(m)}`;
}
const sha7 = (sha: string) => String(sha ?? '').slice(0, 7);
const repoName = (repo: string) => { const i = repo.indexOf('/'); return i < 0 ? repo : repo.slice(i + 1); };
export const ciWord = (ci: string) => (ci === 'gha' ? 'GitHub Actions' : 'Roadrunner');

// ---- deep links (server data only) ----
export type Link = { id: string; label: string; url: string };
const L = (id: string, label: string, url: string | undefined): Link[] => (url ? [{ id, label, url }] : []);
const gh = (w: World, repo: string) => (w.repos.get(repo) as Repo | undefined)?.links?.github ?? '';
export function commitUrl(w: World, repo: string, sha: string): string { const g = gh(w, repo); return g && sha ? `${g}/commit/${sha}` : ''; }
export function branchUrl(w: World, repo: string, branch: string): string { const g = gh(w, repo); return g && branch ? `${g}/tree/${encodeURI(branch)}` : ''; }
export function prUrl(w: World, repo: string, pr?: number): string {
  if (!pr) return '';
  const p = w.prs.get(`${repo}#${pr}`);
  if (p?.url) return p.url;
  const g = gh(w, repo);
  return g ? `${g}/pull/${pr}` : '';
}
type PLinks = { cicd?: string; woodpecker?: string; github?: string; commit?: string; branch?: string; release?: string; pr?: string };
const plinks = (p: Pipeline | undefined): PLinks => ((p as Pipeline & { links?: PLinks } | undefined)?.links ?? {});
/** "Open in Roadrunner" (the console run) or the GitHub Actions run. */
export function runUrl(w: World, id: string, fallback = ''): string {
  const p = w.pipelines.get(id);
  const l = plinks(p);
  return (p?.lane === 'gha' ? l.github : l.cicd) || p?.url || fallback;
}
/** The Roadrunner base, from the server's own URLs (a repo's woodpecker link or a pipeline's). */
function rrBase(w: World): string {
  for (const r of w.repos.values()) { const u = r.links?.woodpecker; if (u) { const m = /^(https?:\/\/[^/]+)/.exec(u); if (m) return m[1]; } }
  return '';
}
/** A step's own page when the server sends it (Step.url, contract ≥ 0.6), else ''. */
function stepUrl(p: Pipeline | undefined, workflow: string | undefined, step: string | undefined): string {
  if (!p || !step) return '';
  for (const wf of p.workflows ?? []) {
    if (workflow && wf.name !== workflow) continue;
    for (const s of wf.steps ?? []) if (s.name === step) { const u = (s as { url?: string }).url; if (u) return u; }
  }
  return '';
}
function appUrl(w: World, id: string): string {
  const a = w.apps.get(id) as (App & { links?: { status?: string } }) | undefined;
  return a?.url ?? '';
}
function statusUrl(w: World, id: string): string {
  const a = w.apps.get(id) as (App & { links?: { status?: string } }) | undefined;
  return a?.links?.status ?? '';
}
function engineUrl(w: World, m: FlowMachine | undefined): string {
  if (!m) return '';
  if (m.id === 'm:gha') return '';
  const host = m.host ?? m.label;
  for (const e of w.engines.values()) {
    const u = (e as Engine & { url?: string }).url;
    if (u && (e.label === m.agent || (e.kind === 'dagger' && (e.host ?? e.label) === host))) return u;
  }
  const base = rrBase(w);
  return base ? `${base}/admin/agents` : '';
}
function eventLinks(w: World, e: FlowEvent): Link[] {
  const out: Link[] = [];
  const c = w.commits.get(`${e.repo}@${e.sha}`) as { links?: { commit?: string; branch?: string; pr?: string } } | undefined;
  const pl = e.jobs.length ? plinks(w.pipelines.get(e.jobs[0].id)) : {};
  if (e.pr) out.push(...L('pr', `PR #${e.pr}`, pl.pr || c?.links?.pr || prUrl(w, e.repo, e.pr)));
  else if (e.kind === 'tag') out.push(...L('tag', 'Release', pl.release || e.url));
  else out.push(...L('commit', 'Commit', pl.commit || c?.links?.commit || commitUrl(w, e.repo, e.sha) || e.url));
  return out;
}

// ---- states ----
export function glyph(s: FlowState | string): string {
  switch (s) {
    case 'running': return '●';
    case 'queued': case 'waiting': return '○';
    case 'fail': return '✕';
    case 'cancelled': case 'skipped': return '–';
    default: return '✓';
  }
}
/** The tone a state's glyph and word take: run (orange), fail (red), wait, pass, off (neutral). */
export function tone(s: FlowState | string): string {
  return s === 'running' ? 'run' : s === 'fail' ? 'fail' : s === 'queued' || s === 'waiting' ? 'wait' : s === 'pass' ? 'pass' : 'off';
}
const live = (s: FlowState) => s === 'running' || s === 'queued' || s === 'waiting';

// ---- the shapes views/now.contract reads ----
export type Cell = { id: string; on: boolean };
export type Mach = { id: string; label: string; text: string; cells: Cell[]; busy: number; slots: number; offline: boolean; url: string };
export type JobLine = {
  id: string; sel: string; state: string; tone: string; glyph: string; last: boolean;
  kind: string; name: string; where: string; machine: string; machineSel: string;
  step: string; pct: number; hasPct: boolean; over: boolean; timer: string; usual: string;
  result: string; err: string; app: string; health: string; dur: string;
  links: Link[];
};
export type ChainItem = { id: string; glyph: string; tone: string; text: string; app: string; health: string };
export type EvBlock = {
  id: string; sel: string; band: string; state: string; tone: string; glyph: string;
  time: string; ago: string; kind: string; repo: string; repoFull: string; branch: string; sha: string;
  title: string; who: string; bot: boolean;
  jobs: JobLine[]; more: string; chain: ChainItem[]; chainMore: string; result: string; links: Link[];
};
export type Need = { id: string; kind: string; what: string; word: string; detail: string; ago: string; links: Link[] };
export type NowFeed = {
  ok: boolean; tick: number; clock: string;
  running: number; queued: number; waiting: number; busy: number; slots: number;
  machines: Mach[];
  needs: Need[]; needsN: number; needsMore: string;
  now: EvBlock[]; just: EvBlock[]; earlier: EvBlock[];
  idle: boolean; idleText: string;
  filtered: boolean; filterText: string;
  summary: string;
};
export const EMPTY_FEED: NowFeed = {
  ok: false, tick: 0, clock: '', running: 0, queued: 0, waiting: 0, busy: 0, slots: 0, machines: [],
  needs: [], needsN: 0, needsMore: '', now: [], just: [], earlier: [], idle: true, idleText: '', filtered: false, filterText: '', summary: '',
};

function kindText(e: FlowEvent): string {
  switch (e.kind) {
    case 'pr': return e.pr ? `PR #${e.pr}` : 'PR';
    case 'merge': return 'merge';
    case 'deployment': return 'deploy';
    default: return e.kind;
  }
}

function whereOf(j: FlowJob): string {
  const m = j.machine;
  if (j.ci === 'gha') return 'GitHub Actions';
  if (j.state === 'queued' || j.state === 'waiting') return j.queuePos ? `Roadrunner · queue #${j.queuePos}` : 'Roadrunner · queued';
  if (!m) return 'Roadrunner';
  return `Roadrunner · ${m.label}${m.slot ? ` · slot ${m.slot}` : ''}`;
}

function jobLine(w: World, j: FlowJob, last: boolean, now: number): JobLine {
  const p = w.pipelines.get(j.id);
  const r = j.result, d = r.deploy;
  const kindName = j.name && j.name !== j.kind ? fit(j.name.replace(new RegExp(`^${j.kind}\\b ?·? ?`), ''), 36) : '';
  let step = '', pct = 0, hasPct = false, over = false, tmr = '', usual = '', result = '', err = '';
  if (j.state === 'running') {
    const el = now - (j.started ?? j.created);
    tmr = timer(el);
    if (j.step) step = fit(`${j.step.index}/${j.step.count} ${j.step.name}`, 40);
    if (j.expectedMs) { hasPct = true; pct = Math.min(1, el / j.expectedMs); over = el > j.expectedMs + 1000; usual = over ? `usual ${timer(j.expectedMs)}` : `of ~${timer(j.expectedMs)}`; }
  } else if (j.state === 'queued' || j.state === 'waiting') {
    tmr = timer(now - j.created);
    step = j.state === 'waiting' ? 'waiting for CI' : 'waiting for a slot';
  } else if (j.state === 'fail') {
    result = fit(r.failStep ? `failed at ${r.failStep}` : 'failed', 48);
    err = fit(r.errorLine ?? '', 160);
  } else if (j.state === 'pass') result = 'passed';
  else result = j.state;
  let app = '', health = '';
  if (d) {
    app = d.app;
    if (d.state === 'pass') health = d.health ?? (w.apps.get(d.app) as App | undefined)?.health ?? 'unknown';
  }
  const links: Link[] = [];
  const failUrl = j.state === 'fail' ? stepUrl(p, r.failWorkflow, r.failStep) : '';
  const stepNowUrl = j.state === 'running' && j.step ? stepUrl(p, j.step.workflow, j.step.name) : '';
  links.push(...L('ci', j.state === 'fail' && failUrl ? 'Failing step' : ciWord(j.ci), failUrl || stepNowUrl || runUrl(w, j.id, j.url)));
  if (d) links.push(...L('app', 'Open app', appUrl(w, d.app)));
  return {
    id: j.id, sel: `job:${j.id}`, state: j.state, tone: tone(j.state), glyph: glyph(j.state), last,
    kind: j.kind, name: kindName, where: whereOf(j), machine: j.machine?.label ?? '', machineSel: j.machine ? `machine:${j.machine.id}` : '',
    step, pct, hasPct, over, timer: tmr, usual, result, err, app, health,
    dur: !live(j.state) ? dur(r.durationMs ?? (j.finished && j.started ? j.finished - j.started : undefined)) : '',
    links,
  };
}

function block(w: World, e: FlowEvent, now: number, off: number): EvBlock {
  const shown = e.jobs.slice(0, JOBS_SHOWN);
  const more = e.jobs.length - shown.length + (e.more ?? 0);
  const jobs = shown.map((j, i) => jobLine(w, j, i === shown.length - 1 && more <= 0, now));
  const chain: ChainItem[] = e.band === 'now' ? [] : e.jobs.slice(0, CHAIN_SHOWN).map((j) => {
    const d = j.result.deploy;
    const health = d && d.state === 'pass' ? d.health ?? (w.apps.get(d.app) as App | undefined)?.health ?? '' : '';
    return { id: j.id, glyph: glyph(j.state), tone: tone(j.state), text: j.kind, app: d ? d.app : '', health };
  });
  const fail = e.jobs.find((j) => j.state === 'fail');
  const dep = e.jobs.find((j) => j.result.deploy)?.result.deploy;
  const links = eventLinks(w, e);
  if (e.band !== 'now') {
    const p = fail ? w.pipelines.get(fail.id) : undefined;
    const lead = fail ?? e.jobs[0];
    if (lead) links.push(...L('ci', fail ? 'Failing step' : ciWord(lead.ci), (fail ? stepUrl(p, fail.result.failWorkflow, fail.result.failStep) : '') || runUrl(w, lead.id, lead.url)));
    if (dep) links.push(...L('app', 'Open app', appUrl(w, dep.app)));
  }
  const at = e.band === 'now' ? e.at : e.finished ?? e.at;
  const who = e.kind === 'cron' ? '' : e.author;
  return {
    id: e.id, sel: `ev:${e.id}`, band: e.band, state: e.state, tone: tone(e.state), glyph: glyph(e.state),
    time: hhmm(at, off), ago: ago(Math.max(0, now - at)), kind: kindText(e), repo: repoName(e.repo), repoFull: e.repo,
    branch: fit(e.branch, 40), sha: sha7(e.sha), title: fit(e.title, 120), who: fit(who, 28), bot: e.bot,
    jobs, more: more > 0 ? `+${more} more` : '', chain, chainMore: e.jobs.length > CHAIN_SHOWN ? `+${e.jobs.length - CHAIN_SHOWN}` : '',
    result: fail ? fit(fail.result.failStep ? `failed at ${fail.result.failStep}` : 'failed', 40) : e.state === 'cancelled' ? 'cancelled' : '',
    links,
  };
}

// ---- needs a human ----
function needs(w: World, v: FlowView, now: number, filter: Filter): Need[] {
  const out: (Need & { rank: number; at: number })[] = [];
  const match = (repo: string, app?: string) => (!filter.repo || filter.repo === repo) && (!filter.app || filter.app === app) && (!filter.sha || filter.sha.startsWith(`${repo}@`));
  for (const a of w.apps.values()) {
    if (a.health !== 'down' && a.health !== 'degraded') continue;
    if (!match(a.repo ?? '', a.id)) continue;
    out.push({ id: `app:${a.id}`, kind: 'app', what: String(a.id ?? ''), word: a.health, detail: fit(a.note ?? (a.url ?? ''), 80), ago: ago(Math.max(0, now - a.checked)), at: a.checked, rank: 0,
      links: [...L('app', 'Open app', a.url), ...L('status', 'Status', statusUrl(w, String(a.id ?? '')))] });
  }
  const lastByApp = new Map<string, { app: string; repo: string; sha: string; state: string; started: number; finished?: number; url?: string; via: string; pipeline?: string }>();
  for (const d of w.deploys.values()) { const o = lastByApp.get(d.app); if (!o || d.started > o.started) lastByApp.set(d.app, d); }
  for (const d of lastByApp.values()) {
    if (d.state !== 'failure' || !match(d.repo, d.app)) continue;
    const a = w.apps.get(d.app) as App | undefined;
    const p = d.pipeline ? w.pipelines.get(d.pipeline) : undefined;
    const at = d.finished ?? d.started;
    out.push({ id: `deploy:${d.app}`, kind: 'deploy', what: d.app, word: 'deploy failed', detail: `${repoName(d.repo)} ${sha7(d.sha)}`, ago: ago(Math.max(0, now - at)), at, rank: 1,
      links: [...L('ci', d.via === 'roadrunner' ? 'Roadrunner' : 'GitHub Actions', (d as { links?: { cicd?: string } }).links?.cicd || d.url || (p ? runUrl(w, String(p.id)) : '') || ''), ...L('app', 'Open app', a?.url), ...L('status', 'Status', statusUrl(w, d.app))] });
  }
  for (const e of v.events) {
    if (e.band !== 'now') continue;
    for (const j of e.jobs) {
      if (j.state !== 'running' || !j.expectedMs || !j.started) continue;
      const el = now - j.started;
      if (el < STUCK_MIN_MS || el < STUCK_X * j.expectedMs) continue;
      out.push({ id: `stuck:${j.id}`, kind: 'stuck', what: `${repoName(e.repo)} ${j.kind}`, word: 'stuck', detail: `running ${dur(el)}, usually ${dur(j.expectedMs)}${j.machine ? ` · ${j.machine.label}` : ''}`, ago: ago(el), at: j.started, rank: 2,
        links: [...L('ci', ciWord(j.ci), runUrl(w, j.id, j.url)), ...L('machine', j.machine?.label ?? 'Machine', engineUrl(w, j.machine))] });
    }
  }
  if (!filter.repo && !filter.app && !filter.sha) {
    for (const q of w.queues.values()) {
      if (!(q.paused || (q.pending > 0 && q.oldest_wait_ms > QUEUE_STUCK_MS))) continue;
      const base = rrBase(w);
      out.push({ id: `queue:${q.id}`, kind: 'queue', what: 'Roadrunner queue', word: q.paused ? 'paused' : 'stuck', detail: `${q.pending} waiting, oldest ${dur(q.oldest_wait_ms)}`, ago: ago(q.oldest_wait_ms), at: now - q.oldest_wait_ms, rank: 3,
        links: L('queue', 'Queue', (q as { url?: string }).url ?? (base ? `${base}/admin/queue` : '')) });
    }
    for (const e of w.engines.values()) {
      if (e.kind !== 'dagger' || e.online) continue;
      out.push({ id: `machine:${e.id}`, kind: 'machine', what: e.label ?? e.id, word: 'offline', detail: e.last_seen ? `last seen ${ago(Math.max(0, now - e.last_seen))} ago` : '', ago: e.last_seen ? ago(Math.max(0, now - e.last_seen)) : '', at: e.last_seen ?? now, rank: 4,
        links: L('machine', 'Machine', (e as Engine & { url?: string }).url ?? (rrBase(w) ? `${rrBase(w)}/admin/agents` : '')) });
    }
  }
  for (const r of w.repos.values()) {
    const st = r.main?.state;
    if (st !== 'failure' && st !== 'error') continue;
    if (!match(r.id, r.app)) continue;
    const culprit = r.main.culprit ?? r.main.head;
    const dot = r.main.recent?.find((d) => d.sha === culprit) ?? r.main.recent?.at(-1);
    let red: Pipeline | undefined;
    for (const p of w.pipelines.values()) {
      if (p.repo !== r.id || p.branch !== r.default_branch || (p.state !== 'failure' && p.state !== 'error')) continue;
      if (!red || (p.finished ?? p.created) > (red.finished ?? red.created)) red = p;
    }
    const since = r.main.since || dot?.at || 0;
    out.push({ id: `main:${r.id}`, kind: 'main', what: repoName(r.id), word: 'main failing', detail: fit(dot ? `${sha7(dot.sha)} ${dot.title}${dot.author ? ` · ${dot.author}` : ''}` : '', 96), ago: since ? ago(Math.max(0, now - since)) : '', at: since, rank: 5,
      links: [...L('commit', 'Commit', commitUrl(w, r.id, culprit)), ...L('ci', red?.lane === 'gha' ? 'GitHub Actions' : 'Roadrunner', red ? runUrl(w, String(red.id)) : (r.links as { cicd?: string } | undefined)?.cicd ?? r.links?.woodpecker ?? '')] });
  }
  out.sort((a, b) => a.rank - b.rank || b.at - a.at);
  return out.slice(0, BROKEN_CAP).map(({ rank: _r, at: _a, ...n }) => n);
}
function needsMore(all: Need[], shown: number): string {
  if (all.length <= shown) return '';
  const c = new Map<string, number>();
  for (const n of all.slice(shown)) c.set(n.kind, (c.get(n.kind) ?? 0) + 1);
  const word: Record<string, string> = { main: 'failing mains', deploy: 'failed deploys', app: 'unhealthy apps', stuck: 'stuck jobs', queue: 'stuck queues', machine: 'machines offline' };
  return `${all.length - shown} more: ${[...c].map(([k, n]) => `${n} ${word[k] ?? k}`).join(' · ')}`;
}

// ---- the feed ----
type Filter = { repo: string; app: string; sha: string };
export type FeedArgs = [number, string, string, string];
let memo: { w: World; key: string; v: NowFeed } | null = null;

export function feedAnswer(d: NowDeps, [tick, repo, app, sha]: FeedArgs): NowFeed {
  const w = d.world();
  if (!w.loaded) return EMPTY_FEED;
  const now = d.now();
  const off = d.offsetMin();
  const filter: Filter = { repo: String(repo ?? ''), app: String(app ?? ''), sha: String(sha ?? '') };
  const key = `${w.ver}|${Math.floor(now / 1000)}|${filter.repo}|${filter.app}|${filter.sha}|${off}`;
  if (memo && memo.w === w && memo.key === key) return memo.v;
  // an app filter is its repo's events (the app's own needs stay the app's)
  const appRepo = filter.app ? (w.apps.get(filter.app) as App | undefined)?.repo ?? '' : '';
  const shaRepo = filter.sha.includes('@') ? filter.sha.slice(0, filter.sha.indexOf('@')) : '';
  const fRepo = filter.repo || appRepo || shaRepo;
  const v = flowOf(w, now, fRepo ? { repo: fRepo } : undefined);
  const shaOnly = filter.sha.includes('@') ? filter.sha.slice(filter.sha.indexOf('@') + 1) : filter.sha;
  const keep = (e: FlowEvent) => !shaOnly || e.sha.startsWith(shaOnly);
  const nowEv = v.events.filter((e) => e.band === 'now' && keep(e)).map((e) => block(w, e, now, off));
  const just = v.events.filter((e) => e.band === 'just' && keep(e)).map((e) => block(w, e, now, off));
  const earlier = v.events.filter((e) => e.band === 'earlier' && keep(e)).map((e) => block(w, e, now, off));
  const all = needs(w, v, now, filter);
  let busy = 0, slots = 0;
  const machines: Mach[] = v.machines.map((m) => {
    const b = m.busy ?? 0, s = m.slots ?? 0;
    if (m.id !== 'm:gha') { busy += b; slots += s; }
    return {
      id: m.id, label: m.label === 'GitHub runner' ? 'GitHub' : m.label, text: s ? `${b}/${s}` : `${b}`,
      cells: s ? Array.from({ length: Math.min(s, 16) }, (_, i) => ({ id: `${m.id}#${i}`, on: i < b })) : [],
      busy: b, slots: s, offline: m.online === false, url: engineUrl(w, m),
    };
  });
  const last = v.lastEventAt;
  const filterText = filter.sha ? `commit ${sha7(shaOnly)}${shaRepo ? ` in ${repoName(shaRepo)}` : ''}` : filter.app ? `app ${filter.app}` : filter.repo ? `repo ${repoName(filter.repo)}` : '';
  const feed: NowFeed = {
    ok: true, tick, clock: hhmm(now, off, true),
    running: v.running, queued: v.queued, waiting: v.waiting ?? 0, busy, slots, machines,
    needs: all, needsN: all.length, needsMore: needsMore(all, BROKEN_SHOWN),
    now: nowEv, just, earlier,
    idle: nowEv.length === 0, idleText: `Nothing running right now.${last ? ` Last event ${ago(Math.max(0, now - last))} ago.` : ''}`,
    filtered: filterText !== '', filterText,
    summary: `${v.running} running, ${v.queued} queued, ${all.length} need a human`,
  };
  memo = { w, key, v: feed };
  return feed;
}

// ---- the selected item, inline under its row: a job's steps + log; a machine's runs; an event's jobs ----
export type StepLine = { id: string; glyph: string; tone: string; name: string; dur: string; depth: number; err: string; url: string; cached: boolean };
export type RunLine = { id: string; sel: string; glyph: string; tone: string; repo: string; kind: string; step: string; timer: string; url: string };
export type NowPanel = {
  ok: boolean; kind: string; id: string; title: string; sub: string; links: Link[];
  steps: StepLine[]; runs: RunLine[]; empty: string;
  logCap: boolean; logStep: string; logWorkflow: string; logLive: boolean; logFail: boolean;
};
export const EMPTY_PANEL: NowPanel = { ok: false, kind: '', id: '', title: '', sub: '', links: [], steps: [], runs: [], empty: '', logCap: false, logStep: '', logWorkflow: '', logLive: false, logFail: false };

export function panelAnswer(d: NowDeps, [sel]: [string, number]): NowPanel {
  const w = d.world();
  if (!sel || !w.loaded) return EMPTY_PANEL;
  const now = d.now();
  const i = sel.indexOf(':');
  const kind = sel.slice(0, i), id = sel.slice(i + 1);
  if (kind === 'job') {
    const j = flowJob(w, id, now);
    if (!j) return { ...EMPTY_PANEL, ok: true, kind, id, empty: 'This pipeline has left the server’s 2-hour window.' };
    const p = w.pipelines.get(id);
    const steps: StepLine[] = [];
    for (const wf of j.workflows) {
      if (steps.length >= STEPS_CAP) break;
      const wfMs = wf.started ? (wf.finished ?? (wf.state === 'running' ? now : wf.started)) - wf.started : undefined;
      steps.push({ id: `w:${wf.name}`, glyph: glyph(wf.state), tone: tone(wf.state), name: fit(`${wf.name}${wf.machine ? ` · ${wf.machine.label}` : ''}`, 60), dur: wf.state === 'running' && wf.started ? timer(now - wf.started) : dur(wfMs), depth: 0, err: '', url: '', cached: false });
      for (const s of wf.steps) {
        if (steps.length >= STEPS_CAP) break;
        steps.push({ id: `s:${wf.name}/${s.name}`, glyph: glyph(s.state), tone: tone(s.state), name: fit(s.name, 60), dur: s.state === 'running' ? timer(s.ms ?? 0) : dur(s.ms), depth: 1, err: s.errorLine ? fit(s.errorLine, 160) : '', url: stepUrl(p, wf.name, s.name), cached: !!s.cached });
      }
    }
    const runWf = j.workflows.find((wf) => wf.steps.some((s) => s.state === 'running'));
    const running = runWf?.steps.find((s) => s.state === 'running');
    const logStep = j.result.failStep ?? running?.name ?? j.step?.name ?? '';
    const logWorkflow = j.result.failStep ? j.result.failWorkflow ?? '' : runWf?.name ?? j.step?.workflow ?? '';
    const m = j.machine;
    const links = [
      ...L('ci', `Open in ${ciWord(j.ci)}`, runUrl(w, j.id, j.url)),
      ...L('step', j.result.failStep ? 'Failing step' : 'Step', stepUrl(p, logWorkflow, logStep)),
      ...L('machine', m?.label ?? 'Machine', engineUrl(w, m)),
      ...L('commit', 'Commit', commitUrl(w, j.repo, j.sha)),
    ];
    return {
      ok: true, kind, id, title: `${j.kind}${j.name && j.name !== j.kind ? ` · ${fit(j.name, 40)}` : ''}`,
      sub: `${ciWord(j.ci)}${m ? ` · ${m.label}${m.slot ? ` slot ${m.slot}` : ''}${m.agent ? ` (${m.agent})` : ''}` : ''}${p?.number ? ` · #${p.number}` : ''}`,
      links, steps, runs: [], empty: '', logCap: logCapable(d.upstream()), logStep, logWorkflow, logLive: j.state === 'running', logFail: !!j.result.failStep,
    };
  }
  if (kind === 'machine') {
    const r = flowMachine(w, id, now);
    if (!r) return { ...EMPTY_PANEL, ok: true, kind, id, empty: 'This machine is not in the fleet now.' };
    const runs = r.running.slice(0, RUNS_CAP).map((j): RunLine => {
      const p = w.pipelines.get(j.id);
      return { id: j.id, sel: `job:${j.id}`, glyph: glyph(j.state), tone: tone(j.state), repo: repoName(p?.repo ?? ''), kind: j.kind, step: j.step ? fit(`${j.step.index}/${j.step.count} ${j.step.name}`, 32) : '', timer: j.state === 'running' ? timer(now - (j.started ?? j.created)) : '', url: runUrl(w, j.id, j.url) };
    });
    const busy = r.machine.busy ?? r.running.length;
    return { ...EMPTY_PANEL, ok: true, kind, id, title: r.machine.label, sub: r.machine.slots ? `${busy} of ${r.machine.slots} slots busy` : `${busy} running`, links: L('machine', 'Open in Roadrunner', engineUrl(w, r.machine)), runs, empty: runs.length ? '' : 'Nothing runs here right now.' };
  }
  return EMPTY_PANEL;
}

// ---- the log tail (behind meta.caps "pipeline_log") ----
type Caps = { base: string; cap: boolean; asked: boolean };
let caps: Caps = { base: '', cap: false, asked: false };
function logCapable(up: Upstream | null): boolean {
  if (!up || up.kind !== 'http') return false;
  const base = (up as unknown as { base?: string }).base ?? '';
  if (caps.base !== base) caps = { base, cap: false, asked: false };
  if (!caps.asked) {
    caps.asked = true;
    const mine = caps;
    up.meta().then((m) => {
      const mm = m as unknown as { caps?: unknown } | null;
      mine.cap = Array.isArray(mm?.caps) && (mm!.caps as unknown[]).includes('pipeline_log');
    }, () => { mine.asked = false; });
  }
  return caps.cap;
}

export function nowSources(d: NowDeps) {
  return {
    nowFeed: (a: FeedArgs) => safe('nowFeed', EMPTY_FEED, () => feedAnswer(d, a)),
    nowPanel: (a: [string, number]) => safe('nowPanel', EMPTY_PANEL, () => panelAnswer(d, a)),
    nowLog: (a: LogArgs) => safe('nowLog', NO_LOG as Log | Promise<Log>, () => logAnswer(d, a)),
  };
}

const warned = new Set<string>();
function safe<T>(name: string, empty: T, f: () => T): T {
  try { return f(); } catch (e) {
    if (!warned.has(name)) { warned.add(name); console.log(`${name}: ${(e as Error)?.stack ?? e}`); }
    return empty;
  }
}
