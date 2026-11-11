// The LIVE flow's view model (flow-view): the model's FlowView (src/flow/model.ts, flow-model's)
// as the rows views/flow.contract lays out. One row per EVENT, left → right: the event, every
// pipeline it started (HANDLED BY), each one's RESULT, with the connectors' geometry. Words are
// cut to their column here (Commit Mono: every character is 0.6 em, so a column holds a known
// number of them), at a token bound, never mid-word. Plus the side panel (a pipeline's steps, a
// machine's runs, an app) and the log tail behind the server's capability.
//
// Everything here is bounded: the model caps the events (40 now, 20 just, 30 earlier), a row
// shows at most JOBS_NOW / JOBS_JUST pipelines (then "+N more"), the filters' options are capped,
// the panel's steps and runs are capped, and one log tail is held at a time (dropped when the
// panel closes).

import type { Upstream } from '../api.ts';
import type { World } from '../world.ts';
import type { App } from '../wire.ts';
import { decisiveIndex, flowJob, flowMachine, flowOf, type FlowEvent, type FlowFilter, type FlowJob, type FlowMachine, type FlowState, type FlowView } from './model.ts';

// ---- geometry (views/flow.contract writes the same numbers) ----------------------------------
/** Column widths, CSS px: EVENT · fan · HANDLED BY · hop · RESULT (the rest, ≥ RESULT_MIN). */
export const COL = { event: 400, fan: 40, job: 480, hop: 32, result: 440 } as const;
/** A pipeline's sub-row: two lines in flight (the progress line), one line once finished. */
export const SUB_NOW = 44, SUB_JUST = 24;
/** A pipeline's sub-row height: two lines while it is in flight in the now band (its progress) or
 *  when it failed with an error line (the line under the result), else one. */
const SUB_ERR = 42;
const subH = (band: string, state: FlowState, err: boolean) => (band === 'now' && live(state) ? SUB_NOW : err ? SUB_ERR : SUB_JUST);
/** The event cell's first line's centre: where the fan starts. */
const ANCHOR_NOW = 12, ANCHOR_JUST = 12;
/** The event cell's height in the now band (three lines and padding) and the just band (two). */
const CARD_NOW = 42, CARD_JUST = 42;
/** Pipelines a row shows before "+N more". */
export const JOBS_NOW = 6, JOBS_JUST = 4;
/** Commit Mono's advance: 0.6 em. */
const ch = (px: number) => px * 0.6;
const cols = (width: number, px = 12) => Math.max(4, Math.floor(width / ch(px)));
/** A finished pipeline or event this recent is "fresh": its result flashes in once. */
const FRESH_MS = 20_000;

// ---- words -----------------------------------------------------------------------------------
/** `s` in at most `n` characters, cut at a token bound (a space, `/`, `-`, `_`, `.`, `:`) with an
 *  ellipsis; a single token longer than the column keeps its head (a long branch name). */
export function fit(s: string, n: number): string {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  if (t.length <= n) return t;
  if (n <= 1) return '…';
  const head = t.slice(0, n - 1);
  let k = -1;
  for (let i = head.length - 1; i >= Math.floor(n * 0.45); i--) {
    if (' /-_.:,;('.includes(head[i])) { k = head[i] === ' ' ? i : i + 1; break; }
  }
  return (k > 0 ? head.slice(0, k) : head).trimEnd() + '…';
}

/** A ticking timer: 0:42, 4:05, 1:02:05. */
export function clockDur(ms: number): string {
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
  if (ms < 10_000) return 'just now';
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s ago`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
  const h = Math.floor(ms / 3_600_000), m = Math.floor((ms % 3_600_000) / 60_000);
  return m ? `${h}h ${m}m ago` : `${h}h ago`;
}
function hhmm(at: number, offsetMin: number): string {
  const d = new Date(at + offsetMin * 60_000);
  const h = d.getUTCHours(), m = d.getUTCMinutes();
  return `${h < 10 ? '0' : ''}${h}:${m < 10 ? '0' : ''}${m}`;
}
const short = (sha: string) => String(sha ?? '').slice(0, 7);
const repoName = (repo: string) => { const i = repo.indexOf('/'); return i < 0 ? repo : repo.slice(i + 1); };
export const ciWord = (ci: string) => (ci === 'gha' ? 'GitHub Actions' : 'Roadrunner');

// ---- the shapes views/flow.contract reads ----------------------------------------------------
export type Opt = { value: string; label: string };
export type Mach = { id: string; label: string; busy: number; slots: number; text: string; hot: boolean; full: boolean; pips: number[] };
export type Pip = { id: string; state: string };
export type JobRow = {
  id: string; kind: string; ci: string; name: string; state: string;
  where: string; machine: string; machineId: string;
  step: string; timer: string; usual: string; pct: number; over: boolean; note: string;
  /** tone: the pipeline's state (run/wait/pass/fail/off); rtone: its result's words. */
  result: string; tone: string; rtone: string; err: string; app: string; health: string; healthText: string;
  target: string; fresh: boolean; fan: string; live: boolean; hgt: number;
};
export type EvRow = {
  id: string; band: string; kind: string; kindText: string; repo: string; name: string; group: string;
  branch: string; sha: string; author: string; bot: boolean; title: string; ref: string; who: string; ago: string; at: string;
  url: string; route: string; state: string; jobs: JobRow[]; more: number; moreText: string; moreFan: string;
  h: number; fresh: boolean; pips: Pip[]; pipsMore: string; summary: string; result: string; tone: string;
};
export type Flow = {
  ok: boolean; running: number; queued: number; idle: boolean; idleTitle: string; idleSub: string;
  machines: Mach[]; now: EvRow[]; just: EvRow[]; earlier: EvRow[];
  repos: Opt[]; teams: Opt[]; branches: Opt[]; filtered: boolean; summary: string; tick: number;
};

const stateWordOf = (s: FlowState) => (s === 'pass' ? 'deployed' : s === 'fail' ? 'failed' : s);
const live = (s: FlowState) => s === 'running' || s === 'queued' || s === 'waiting';
const toneOf = (s: FlowState): string => (s === 'running' ? 'run' : s === 'queued' || s === 'waiting' ? 'wait' : s === 'fail' ? 'fail' : s === 'pass' ? 'pass' : 'off');

function eventState(e: FlowEvent): FlowState {
  if (e.state) return e.state;
  if (e.jobs.length === 0) return 'waiting';
  let q = false, f = false, all = true;
  for (const j of e.jobs) {
    if (j.state === 'running') return 'running';
    if (j.state === 'queued' || j.state === 'waiting') q = true;
    if (j.state === 'fail') f = true;
    if (j.state !== 'cancelled' && j.state !== 'skipped') all = false;
  }
  return q ? 'queued' : f ? 'fail' : all ? 'cancelled' : 'pass';
}

function kindText(e: FlowEvent): string {
  switch (e.kind) {
    case 'pr': return e.pr ? `PR #${e.pr}` : 'PR';
    case 'merge': return e.pr ? `merge #${e.pr}` : 'merge';
    case 'deployment': return 'deploy';
    default: return e.kind;
  }
}

/** The fan from the event's anchor to a sub-row's first line. */
const fanPath = (a: number, y: number) => `M0 ${a} C${COL.fan / 2} ${a} ${COL.fan / 2} ${y} ${COL.fan} ${y}`;

/** Where it runs: the CI, then the machine and slot ("Roadrunner" "VM 153 · slot 2/6",
 *  "GH Actions" "GitHub runner"); a queued Roadrunner job its place in the queue. */
function where(j: FlowJob, n: number): { where: string; machine: string } {
  const m = j.machine;
  let mach = '';
  if (j.ci === 'gha') mach = m?.label || 'GitHub runner';
  else if (m) mach = `${m.label}${m.slot ? ` · slot ${m.slot}${m.slots ? `/${m.slots}` : ''}` : ''}`;
  else if (j.state === 'queued') mach = j.queuePos ? `queue #${j.queuePos}` : 'in the queue';
  return { where: j.ci === 'gha' ? 'GH Actions' : 'Roadrunner', machine: fit(mach, n) };
}

function resultOf(j: FlowJob, w: World, now: number, budget: number): Pick<JobRow, 'result' | 'rtone' | 'err' | 'app' | 'health' | 'healthText' | 'target'> {
  const r = j.result, d = r.deploy;
  const out = { result: '', rtone: toneOf(j.state), err: '', app: '', health: '', healthText: '', target: 'job' };
  if (d) {
    out.app = d.app; out.target = 'app';
    // the app's health is its health NOW: a result only once the deploy has passed
    const h = d.health ?? (w.apps.get(d.app) as App | undefined)?.health ?? 'unknown';
    if (d.state === 'pass') { out.result = fit(`${d.app} ← ${short(d.sha)}`, budget - 14); out.health = h; out.healthText = h === 'unknown' ? 'health ?' : h; out.rtone = 'pass'; }
    else if (live(j.state) || d.state === 'running' || d.state === 'queued' || d.state === 'waiting') { out.result = fit(`deploying ${short(d.sha)} → ${d.app}`, budget); out.rtone = 'wait'; }
    else if (d.state === 'fail' || j.state === 'fail') { out.result = fit(`${d.app} not deployed`, budget); out.rtone = 'fail'; }
    else out.result = fit(`${d.app} · ${d.state}`, budget);
    if (j.state === 'fail' && r.failStep) out.err = r.errorLine ?? '';
    return out;
  }
  switch (j.state) {
    case 'pass': out.result = `passed${r.durationMs ? ` in ${dur(r.durationMs)}` : ''}`; break;
    case 'fail': out.result = fit(r.failStep ? `failed at ${r.failStep}` : 'failed', budget); out.err = r.errorLine ?? ''; break;
    case 'cancelled': out.result = `cancelled${r.durationMs ? ` after ${dur(r.durationMs)}` : ''}`; break;
    case 'skipped': out.result = 'skipped'; break;
    case 'running': {
      // in flight: when it should be done (its usual), what it will deploy
      const el = now - (j.started ?? j.created);
      const app = j.kind === 'deploy' ? w.repos.get(w.pipelines.get(j.id)?.repo ?? '')?.app : undefined;
      // (past its usual, the pipeline's own line says by how much)
      out.result = j.expectedMs && el < j.expectedMs ? `due in ~${clockDur(j.expectedMs - el)}` : '';
      if (app) out.result = fit(`${out.result ? `${out.result} · ` : ''}→ ${app}`, budget);
      out.rtone = 'wait';
      break;
    }
    default: out.result = '';
  }
  void now;
  return out;
}

function jobRow(j: FlowJob, top: number, band: string, w: World, now: number): JobRow {
  const two = band === 'now';
  const a = two ? ANCHOR_NOW : ANCHOR_JUST;
  const inner = COL.job - 16;
  const wh = where(j, 24);
  const whereW = (wh.where.length + 3 + wh.machine.length) * ch(12) + 8;
  // kind chip (its word + 12 px padding) and the gap
  const chipW = j.kind.length * ch(12) + 12 + 8;
  const durW = two ? 0 : (j.finished && j.started ? dur(j.finished - j.started).length : 0) * ch(12) + 12;
  const name = fit(j.name, cols(inner - chipW - whereW - durW - 8, 12));
  let step = '', timer = '', usual = '', pct = 0, over = false, note = '';
  if (j.state === 'running') {
    const el = now - (j.started ?? j.created);
    timer = clockDur(el);
    if (j.expectedMs) { usual = `usual ${clockDur(j.expectedMs)}`; pct = Math.min(1, el / j.expectedMs); over = el - j.expectedMs >= 1000; }
    else if (j.step?.count) pct = Math.min(0.97, (j.step.index - 0.5) / j.step.count);
    if (over) usual = `${clockDur(el - (j.expectedMs ?? 0))} over usual`;
    if (j.step) step = fit(`${j.step.index}/${j.step.count} ${j.step.name}`, cols(inner - 140 - 12 - (timer.length + 3 + usual.length) * ch(12) - 8, 12));
    else step = 'starting';
  } else if (j.state === 'queued') {
    note = fit(`queued${j.queuePos ? ` · #${j.queuePos} in line` : ''} · waiting ${clockDur(now - j.created)}`, cols(inner, 12));
  } else if (j.state === 'waiting') {
    note = `waiting for CI · ${clockDur(now - j.created)}`;
  }
  const res = resultOf(j, w, now, cols(COL.result - 24, 12));
  return {
    id: j.id, kind: j.kind, ci: j.ci, name, state: j.state, tone: toneOf(j.state), where: wh.where, machine: wh.machine, machineId: j.machine?.id ?? (j.ci === 'gha' ? 'm:gha' : ''),
    step, timer, usual, pct: Math.round(pct * 1000) / 1000, over, note,
    ...res, err: res.err ? fit(res.err, cols(COL.result - 24, 12) * (two ? 1 : 1)) : '',
    fresh: !!j.finished && now - j.finished >= 0 && now - j.finished < FRESH_MS,
    fan: fanPath(a, top + a), live: j.state === 'running', hgt: subH(band, j.state, !!res.err),
  };
}

function evRow(e: FlowEvent, w: World, now: number, offsetMin: number): EvRow {
  const band = e.band;
  const two = band === 'now';
  const a = two ? ANCHOR_NOW : ANCHOR_JUST;
  const cap = two ? JOBS_NOW : band === 'just' ? JOBS_JUST : 0;
  const state = eventState(e);
  const kt = kindText(e);
  // line 1: [kind] repo  branch · sha ……… ago;  line 2: author · title ……… github ↗
  const innerW = COL.event - 22;
  const agoT = ago(Math.max(0, now - e.at));
  const name = fit(repoName(e.repo), Math.min(26, cols(innerW - (kt.length * ch(12) + 12 + 8) - agoT.length * ch(12) - 70, 13)));
  const refW = innerW - (kt.length * ch(12) + 12 + 8) - name.length * ch(13) - 10 - agoT.length * ch(12) - 10;
  const ref = fit([e.branch, short(e.sha)].filter(Boolean).join(' · '), cols(refW, 12));
  const who = e.author ? fit(e.author, 18) : '';
  const titleW = innerW - 'github ↗'.length * ch(12) - 10 - (who ? (who.length + 3) * ch(12) : 0);
  let jobs: JobRow[] = [];
  let more = 0;
  if (cap) {
    const shown = e.jobs.slice(0, cap);
    more = e.jobs.length - shown.length + (e.more ?? 0);
    let top = 0;
    jobs = shown.map((j) => { const r = jobRow(j, top, band, w, now); top += r.hgt; return r; });
    if (e.jobs.length === 0 && two) {
      // a push that no CI has picked up yet: "waiting for CI"
      jobs = [{
        id: `${e.id}#wait`, kind: 'ci', ci: '', name: 'waiting for CI', state: 'waiting', where: '', machine: '', machineId: '', step: '', timer: '', usual: '', pct: 0, over: false,
        note: `pushed ${clockDur(now - e.at)} ago · no pipeline yet`, result: '', tone: 'wait', rtone: 'wait', err: '', app: '', health: '', healthText: '', target: 'none', fresh: false,
        fan: fanPath(a, a), live: false, hgt: SUB_NOW,
      }];
    }
  }
  const jobsH = jobs.reduce((t, j) => t + j.hgt, 0) + (more > 0 ? SUB_JUST : 0);
  const fin = e.finished ?? e.jobs.reduce((m, j) => Math.max(m, j.finished ?? 0), 0);
  // the earlier band: one line, the pipelines as pips, the result in words
  const pips = e.jobs.slice(0, 10).map((j) => ({ id: j.id, state: j.state }));
  let summary = '', result = '', tone = toneOf(state);
  if (!two) {
    const names = [...new Set(e.jobs.map((j) => j.kind))].join(', ');
    const nJobs = e.jobs.length + (e.more ?? 0);
    // a cron that fired many times on one sha is one row: "×N (M failed)"
    const folded = e.folded && e.folded > 1 ? `×${e.folded}${e.foldedFail ? ` (${e.foldedFail} failed)` : ''} · ` : '';
    summary = fit(`${folded}${nJobs} ${nJobs === 1 ? 'pipeline' : 'pipelines'}${names ? ` · ${names}` : ''}`, cols(COL.job - 16 - 12 * 10 - 20, 12));
    const failed = e.jobs.filter((j) => j.state === 'fail');
    const dep = e.jobs.find((j) => j.result.deploy && j.state === 'pass')?.result.deploy;
    if (failed.length) result = fit(`${failed.length > 1 ? `${failed.length} failed · ` : ''}failed at ${failed[0].result.failStep ?? failed[0].name}${failed[0].result.errorLine ? ` · ${failed[0].result.errorLine}` : ''}`, cols(COL.result - 16, 12));
    else if (dep) result = fit(`passed · ${dep.app} ← ${short(dep.sha)}${dep.health && dep.health !== 'unknown' ? ` · ${dep.health}` : ''}`, cols(COL.result - 16, 12));
    else if (state === 'cancelled') result = 'cancelled';
    else result = 'passed';
  }
  return {
    id: e.id, band, kind: e.kind, kindText: kt, repo: e.repo, name, group: e.group ?? '', branch: e.branch, sha: short(e.sha), author: e.author, bot: e.bot,
    title: fit(e.title, cols(titleW, 12)), ref, who, ago: agoT, at: hhmm(e.at, offsetMin), url: e.url,
    route: `/commit/${e.repo}/${e.sha}`, state, jobs, more, moreText: more > 0 ? `+${more} more ${more === 1 ? 'pipeline' : 'pipelines'}` : '',
    moreFan: more > 0 ? fanPath(a, jobsH - SUB_JUST + a) : '',
    h: two ? Math.max(CARD_NOW, jobsH) : band === 'just' ? Math.max(CARD_JUST, jobsH) : 22,
    fresh: band === 'just' && fin > 0 && now - fin < FRESH_MS, pips, pipsMore: e.jobs.length > 10 ? `+${e.jobs.length - 10}` : '', summary, result, tone,
  };
}

function machRow(m: FlowMachine): Mach {
  const busy = Math.max(0, m.busy ?? 0), slots = Math.max(0, m.slots ?? 0);
  const n = Math.min(slots, 12);
  const off = m.online === false;
  return {
    id: m.id, label: m.id === 'm:gha' || m.label === 'GitHub runner' ? 'GHA' : m.label, busy, slots,
    text: off ? 'offline' : slots ? `${busy}/${slots}` : `${busy} running`, hot: !off && busy > 0, full: slots > 0 && busy >= slots,
    pips: Array.from({ length: n }, (_, i) => (i < busy ? 1 : 0)),
  };
}

const OPT_CAP = 40;
function options(v: FlowView, groupName: (id: string) => string): { repos: Opt[]; teams: Opt[]; branches: Opt[] } {
  const repos = new Map<string, number>(), teams = new Map<string, number>(), branches = new Map<string, number>();
  for (const e of v.events) {
    repos.set(e.repo, (repos.get(e.repo) ?? 0) + 1);
    if (e.group) teams.set(e.group, (teams.get(e.group) ?? 0) + 1);
    if (e.branch) branches.set(e.branch, (branches.get(e.branch) ?? 0) + 1);
  }
  const top = (m: Map<string, number>) => [...m.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, OPT_CAP).map(([k]) => k).sort();
  return {
    // the select shows its label in ~20 columns: the repo's name, its owner only when two share it
    repos: top(repos).map((r) => ({ value: r, label: [...repos.keys()].filter((x) => repoName(x) === repoName(r)).length > 1 ? r : repoName(r) })).sort((a, b) => (a.label < b.label ? -1 : 1)),
    teams: top(teams).map((g) => ({ value: g, label: groupName(g) })),
    branches: top(branches).map((b) => ({ value: b, label: fit(b, 40) })),
  };
}

// ---- the sources -----------------------------------------------------------------------------
export interface FlowDeps {
  world(): World;
  /** The fleet's now (the playhead: live, or a replay's moment). */
  now(): number;
  offsetMin(): number;
  upstream(): Upstream | null;
  /** The module clock (ms since launch): the log tail's refresh. */
  clock(): number;
}

type FlowArgs = [number, string, string, string, string];
let flowMemo: { key: string; v: Flow } | null = null;
const EMPTY_FLOW: Flow = {
  ok: false, running: 0, queued: 0, idle: true, idleTitle: 'Waiting for the fleet', idleSub: '', machines: [], now: [], just: [], earlier: [],
  repos: [], teams: [], branches: [], filtered: false, summary: 'Live flow, waiting for the fleet.', tick: 0,
};

/** The first answer, and one after a load or a change in the fleet's shape (World.shapeVer), builds
 *  the model from scratch: that answer yields between the model and the rows, so it is two turns
 *  on a slow Mac's Hermes (the data module has no clock to time a turn by). */
let sliceShape = -1;
const yieldTurn = async () => {
  const sc = (globalThis as { scheduler?: { yield?: () => Promise<void> } }).scheduler;
  if (sc?.yield) await sc.yield();
};

export function flowAnswer(d: FlowDeps, [tick, repo, team, branch, author]: FlowArgs): Flow | Promise<Flow> {
  const w = d.world();
  if (!w.loaded) return EMPTY_FLOW;
  const now = d.now(), off = d.offsetMin();
  const key = `${w.ver}|${Math.floor(now / 1000)}|${repo}|${team}|${branch}|${author}|${off}`;
  if (flowMemo?.key === key) return flowMemo.v;
  const filter: FlowFilter = {};
  if (repo) filter.repo = repo;
  if (team) filter.group = team;
  if (branch) filter.branch = branch;
  if (author) filter.author = author;
  const filtered = !!(repo || team || branch || author);
  const cold = sliceShape !== w.shapeVer;
  sliceShape = w.shapeVer;
  const all = flowOf(w, now);
  const v = filtered ? flowOf(w, now, filter) : all;
  const rows = () => flowRows(w, now, off, all, v, filtered, repo, team, branch, Number(tick) || 0, key);
  return cold ? yieldTurn().then(rows) : rows();
}

function flowRows(w: World, now: number, off: number, all: FlowView, v: FlowView, filtered: boolean, repo: string, team: string, branch: string, tick: number, key: string): Flow {
  const groupName = (id: string) => w.groups.get(id)?.name ?? id.replace(/^(team|org):/, '');
  const opts = options(all, groupName);
  // keep a chosen value among the options even when it has gone quiet
  if (repo && !opts.repos.some((o) => o.value === repo)) opts.repos.unshift({ value: repo, label: repoName(repo) });
  if (team && !opts.teams.some((o) => o.value === team)) opts.teams.unshift({ value: team, label: groupName(team) });
  if (branch && !opts.branches.some((o) => o.value === branch)) opts.branches.unshift({ value: branch, label: fit(branch, 40) });
  const now_: EvRow[] = [], just: EvRow[] = [], earlier: EvRow[] = [];
  for (const e of v.events) {
    const r = evRow(e, w, now, off);
    (e.band === 'now' ? now_ : e.band === 'just' ? just : earlier).push(r);
  }
  let idleTitle = '', idleSub = '';
  if (v.idle) {
    idleTitle = filtered ? 'Nothing running for these filters' : 'Nothing running right now';
    const last = v.lastEventAt ?? all.lastEventAt;
    const lastEv = [...v.events].sort((a, b) => b.at - a.at)[0];
    const what = lastEv ? `${kindText(lastEv)} ${lastEv.kind === 'cron' || lastEv.kind === 'manual' ? 'on' : 'to'} ${repoName(lastEv.repo)}${lastEv.author ? ` by ${lastEv.author}` : ''}` : '';
    idleSub = last ? `Last event ${ago(Math.max(0, now - last))}${what ? `: ${what}` : ''}. Machines: ${all.machines.map((m) => `${m.id === 'm:gha' ? 'GHA' : m.label} ${m.slots ? `${m.busy ?? 0}/${m.slots}` : `${m.busy ?? 0}`}`).join(' · ')}` : 'No events in the last 2 hours';
  }
  const flow: Flow = {
    ok: true, running: v.running, queued: v.queued, idle: v.idle, idleTitle, idleSub,
    machines: all.machines.slice(0, 8).map(machRow), now: now_, just, earlier, ...opts, filtered,
    summary: `Live flow: ${v.running} running, ${v.queued} queued; ${now_.length} events in flight, ${just.length} just finished, ${earlier.length} earlier.`,
    tick,
  };
  flowMemo = { key, v: flow };
  return flow;
}

// ---- the side panel: a pipeline, a machine, an app --------------------------------------------
export type Fact = { k: string; v: string; tone: string };
export type StepRow = { id: string; name: string; depth: number; state: string; dur: string; cached: boolean; err: string; where: string };
export type Mini = { id: string; repo: string; name: string; step: string; timer: string; state: string };
export type Panel = {
  ok: boolean; kind: string; id: string; title: string; sub: string; state: string; tone: string; facts: Fact[]; steps: StepRow[];
  failStep: string; errorLine: string; url: string; urlLabel: string; route: string; routeLabel: string; jobs: Mini[];
  logCap: boolean; logStep: string; logWorkflow: string; logLive: boolean; empty: string;
};
const EMPTY_PANEL: Panel = {
  ok: false, kind: '', id: '', title: '', sub: '', state: '', tone: 'off', facts: [], steps: [], failStep: '', errorLine: '', url: '', urlLabel: '', route: '', routeLabel: '',
  jobs: [], logCap: false, logStep: '', logWorkflow: '', logLive: false, empty: '',
};
const STEP_CAP = 80, MINI_CAP = 20;

function mini(j: FlowJob, w: World, now: number): Mini {
  const p = w.pipelines.get(j.id);
  return {
    id: j.id, repo: fit(repoName(p?.repo ?? ''), 22), name: fit(j.name, 24),
    step: j.step ? fit(`${j.step.index}/${j.step.count} ${j.step.name}`, 22) : j.state === 'queued' ? 'queued' : j.state,
    timer: j.state === 'running' ? clockDur(now - (j.started ?? j.created)) : '', state: j.state,
  };
}

export function panelAnswer(d: FlowDeps, [kind, id]: [string, string, number]): Panel {
  const w = d.world();
  if (!id || !w.loaded) return EMPTY_PANEL;
  const now = d.now();
  if (kind === 'job') {
    const j = flowJob(w, id, now);
    if (!j) return { ...EMPTY_PANEL, ok: true, kind, id, title: 'This pipeline has left the fleet', empty: 'It is no longer in the server’s window.' };
    const p = w.pipelines.get(id);
    const c = w.commits.get(`${j.repo}@${j.sha}`);
    const facts: Fact[] = [];
    const st = j.state;
    if (st === 'running') facts.push({ k: 'running', v: `${clockDur(now - (j.started ?? j.created))}${j.expectedMs ? ` of usual ${clockDur(j.expectedMs)}` : ''}${j.step ? ` · step ${j.step.index}/${j.step.count}` : ''}`, tone: 'run' });
    else if (st === 'queued') facts.push({ k: 'queued', v: `${clockDur(now - j.created)}${j.queuePos ? ` · #${j.queuePos} in line` : ''}`, tone: 'wait' });
    else facts.push({ k: st === 'pass' ? 'passed' : st === 'fail' ? 'failed' : st, v: `${dur(j.result.durationMs) || '–'}${j.finished ? ` · ${ago(Math.max(0, now - j.finished))}` : ''}`, tone: toneOf(st) });
    const m = j.machine;
    facts.push({ k: 'where', v: `${ciWord(j.ci)}${m ? ` · ${m.label}${m.slot ? ` · slot ${m.slot}${m.slots ? `/${m.slots}` : ''}` : ''}` : ''}`, tone: 'off' });
    // the author is the trigger's only for a push, a PR or a tag (a cron's commit is not its doing)
    const by = p && (p.event === 'push' || p.event === 'pull_request' || p.event === 'tag') ? c?.author ?? p.author ?? '' : '';
    if (p) facts.push({ k: 'trigger', v: fit(`${p.event === 'pull_request' ? `PR #${p.pr ?? c?.pr ?? ''}` : p.event} · ${j.branch} · ${short(j.sha)}${by ? ` · ${by}` : ''}`, 48), tone: 'off' });
    if (j.result.deploy) {
      const dd = j.result.deploy;
      // in flight: where it goes; done: what the app got and (once it passed) its health now
      if (live(st)) facts.push({ k: 'deploy', v: fit(`deploying ${short(dd.sha)} → ${dd.app}`, 48), tone: 'off' });
      else facts.push({ k: 'deploy', v: fit(`${dd.app} ← ${short(dd.sha)} · ${stateWordOf(dd.state)}${dd.state === 'pass' && dd.health ? ` · ${dd.health}` : ''}`, 48), tone: dd.state === 'fail' ? 'fail' : dd.state === 'pass' ? (dd.health === 'down' ? 'fail' : 'pass') : 'off' });
    }
    const steps: StepRow[] = [];
    for (const wf of j.workflows) {
      if (steps.length >= STEP_CAP) break;
      const wfMs = wf.started ? (wf.finished ?? (wf.state === 'running' ? now : wf.started)) - wf.started : undefined;
      steps.push({ id: `w:${wf.name}`, name: fit(wf.name, 30), depth: 0, state: wf.state, dur: wf.state === 'running' && wf.started ? clockDur(now - wf.started) : dur(wfMs), cached: false, err: '', where: wf.machine ? fit(wf.machine.label, 14) : '' });
      for (const s of wf.steps) {
        if (steps.length >= STEP_CAP) break;
        steps.push({ id: `s:${wf.name}/${s.name}`, name: fit(s.name, 30), depth: 1, state: s.state, dur: s.state === 'running' ? clockDur(s.ms ?? 0) : dur(s.ms), cached: !!s.cached, err: s.errorLine ? fit(s.errorLine, 120) : '', where: '' });
      }
    }
    // the log tail: the failed step, else the running one
    const runWf = j.workflows.find((wf) => wf.steps.some((s) => s.state === 'running'));
    const running = runWf?.steps.find((s) => s.state === 'running');
    const logStep = j.result.failStep ?? running?.name ?? j.step?.name ?? '';
    const logWorkflow = j.result.failStep ? j.result.failWorkflow ?? '' : runWf?.name ?? j.step?.workflow ?? '';
    return {
      ok: true, kind, id, title: fit(j.name, 40), sub: fit(`${j.repo} · ${j.kind}${p?.number ? ` · #${p.number}` : ''}`, 56), state: st, tone: toneOf(st), facts, steps,
      failStep: j.result.failStep ?? '', errorLine: j.result.errorLine ?? '', url: j.url, urlLabel: `Open in ${ciWord(j.ci)}`,
      route: `/commit/${j.repo}/${j.sha}`, routeLabel: 'Commit journey', jobs: [],
      logCap: logCapable(d.upstream()), logStep, logWorkflow, logLive: st === 'running', empty: '',
    };
  }
  if (kind === 'machine') {
    const r = flowMachine(w, id, now);
    if (!r) return { ...EMPTY_PANEL, ok: true, kind, id, title: id, empty: 'This machine is not in the fleet now.' };
    const busy = r.machine.busy ?? r.running.length;
    const jobs = r.running.slice(0, MINI_CAP).map((j) => mini(j, w, now));
    return {
      ...EMPTY_PANEL, ok: true, kind, id, title: r.machine.label, sub: r.machine.slots ? `${busy} of ${r.machine.slots} slots busy` : `${busy} running`,
      state: busy > 0 ? 'running' : 'idle', tone: busy > 0 ? 'run' : 'off', jobs,
      empty: jobs.length ? '' : 'Nothing running here right now.',
    };
  }
  if (kind === 'app') {
    const a = w.apps.get(id);
    if (!a) return { ...EMPTY_PANEL, ok: true, kind, id, title: id, empty: 'This app is not in the catalog.' };
    const dep = w.deploys.get(`${a.repo ?? ''}@${a.live_sha ?? ''}`);
    const facts: Fact[] = [
      { k: 'health', v: `${a.health}${a.latency_ms ? ` · ${a.latency_ms} ms` : ''}${a.checked ? ` · checked ${ago(Math.max(0, now - a.checked))}` : ''}`, tone: a.health === 'up' ? 'pass' : a.health === 'down' ? 'fail' : 'off' },
      { k: 'live', v: a.live_sha ? `${short(a.live_sha)}${a.behind ? ` · ${a.behind} behind main` : ' · main'}` : 'never deployed', tone: 'off' },
    ];
    if (a.last_deploy) facts.push({ k: 'deploy', v: `${a.last_deploy.state}${dep ? ` · via ${dep.via} · ${ago(Math.max(0, now - (dep.finished ?? dep.started)))}` : ''}`, tone: a.last_deploy.state === 'failure' ? 'fail' : 'off' });
    if (a.repo) facts.push({ k: 'repo', v: a.repo, tone: 'off' });
    return {
      ...EMPTY_PANEL, ok: true, kind, id, title: id, sub: fit(a.url ?? '', 56), state: a.health, tone: a.health === 'up' ? 'pass' : a.health === 'down' ? 'fail' : 'off', facts,
      url: a.url ?? '', urlLabel: 'Open the app', route: `/fleet?app=${encodeURIComponent(id)}`, routeLabel: 'In the fleet',
    };
  }
  return EMPTY_PANEL;
}

// ---- the log tail (behind the server's `pipeline_log` capability) ------------------------------
// meta.caps (absent on older servers: none) includes "pipeline_log" →
// GET /api/v1/pipeline/{id}/log?step=<Step.name>&workflow=<Workflow.name>&tail=200 → { id, step,
// workflow?, state, lines (oldest first, ≤ 400 chars each), truncated, bytes (≤ 64 KB), fetched }.
// The same auth as the other calls (the Bearer header, never a token in the URL). Polled every
// ~10 s while the job runs (the server caches 10 s), never once it has finished; ONE tail is held,
// dropped when the panel closes. Roadrunner (wp:) gives a running step's live tail; GitHub (gha:)
// publishes a job's log only when the job ends. Errors (404, 400, 502) are a quiet "log
// unavailable" (the panel's CI link stays).
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
      const mm = m as unknown as { caps?: unknown; features?: Record<string, unknown> } | null;
      mine.cap = (Array.isArray(mm?.caps) && (mm!.caps as unknown[]).includes('pipeline_log')) || mm?.features?.pipeline_log === true;
      console.log(`flow: ${base} ${mine.cap ? 'offers' : 'does not offer'} pipeline logs`);
    }, (e) => { mine.asked = false; console.log(`flow: meta failed: ${String((e as Error)?.message ?? e).slice(0, 120)}`); });
  }
  return caps.cap;
}

/** One tail line; `hot` the decisive one (the failure's line, ruled red in the view). */
export type LogRow = { id: string; text: string; hot: boolean };
/** `rows`: the tail, oldest first (the view's list opens at its end and follows it).
 *  `decisive`: the failure's line in it (the server's `decisive` index, else matched to the
 *  cluster's normalized line), -1 if none; `raw` its text. `jump`: that row's key when it sits
 *  too far above the end to show there (the view scrolls to it once), else "". */
export type Log = { ok: boolean; step: string; rows: LogRow[]; note: string; pin: number; decisive: number; raw: string; jump: string };
const NO_LOG: Log = { ok: false, step: '', rows: [], note: '', pin: 0, decisive: -1, raw: '', jump: '' };
let fetches = 0;
const LOG_LINES = 200, LOG_COLS = 400, LOG_BYTES = 192 << 10;
/** Lines that show at the tail's end in its 500 px port (16 px a line, some wrap). */
const LOG_NEAR_END = 18;
let held: { key: string; tick: number; v: Log; p: Promise<Log> | null } | null = null;

/** The failed step's cluster line (normalized), from the World: what the tail is matched to. */
function clusterLineOf(w: World, id: string, step: string, workflow: string): string {
  const p = w.pipelines.get(id);
  if (!p) return '';
  for (const wf of p.workflows ?? []) {
    if (workflow && wf.name !== workflow) continue;
    for (const s of wf.steps ?? []) {
      if (s.name !== step || !s.cluster) continue;
      const line = w.clusters.get(s.cluster)?.line;
      if (line) return line;
    }
  }
  return '';
}

/** The tail's rows with its decisive line found and marked (pure: tested in tools/flow.test.ts). */
export function logRows(lines: readonly string[], clusterLine: string, decisive?: number): Pick<Log, 'rows' | 'decisive' | 'raw' | 'jump'> {
  const k = clusterLine || decisive != null ? decisiveIndex(lines, clusterLine, decisive) : -1;
  const rows = lines.map((text, i) => ({ id: `l${i}`, text, hot: i === k }));
  return { rows, decisive: k, raw: k >= 0 ? lines[k] : '', jump: k >= 0 && lines.length - 1 - k > LOG_NEAR_END ? `l${k}` : '' };
}
type LogArgs = [string, string, string, number, boolean];

export function logAnswer(d: FlowDeps, [id, step, workflow, tick, cap]: LogArgs): Log | Promise<Log> {
  if (!id || !step || !cap) { held = null; return NO_LOG; }
  const up = d.upstream();
  if (!up || up.kind !== 'http') { held = null; return NO_LOG; }
  const key = `${id}|${workflow}|${step}`;
  if (held && held.key !== key) held = null;
  if (held && (held.tick === tick || held.p)) return held.p ?? held.v;
  const u = up as unknown as { base: string; token: string };
  const headers: Record<string, string> = { accept: 'application/json' };
  if (u.token) headers.authorization = `Bearer ${u.token}`;
  const path = `/api/v1/pipeline/${encodeURIComponent(id)}/log?step=${encodeURIComponent(step)}${workflow ? `&workflow=${encodeURIComponent(workflow)}` : ''}&tail=${LOG_LINES}`;
  const gha = id.startsWith('gha:');
  const prev = held?.v ?? { ...NO_LOG, step, note: 'loading the log…' };
  const slot = { key, tick, v: prev, p: null as Promise<Log> | null };
  held = slot;
  slot.p = fetch(u.base + path, { headers, exactTimeout: 10000, exactIndependentHttp: { maxResponseBytes: LOG_BYTES } } as RequestInit)
    .then(async (r): Promise<Log> => {
      if (!r.ok) return { ...NO_LOG, step, note: 'log unavailable' };
      const j = (await r.json()) as { lines?: unknown; truncated?: boolean; state?: string; decisive?: number };
      const lines = (Array.isArray(j.lines) ? j.lines : []).slice(-LOG_LINES).map((l) => String(l).slice(0, LOG_COLS));
      let note = j.truncated ? `showing last ${lines.length} lines · truncated` : `${lines.length} ${lines.length === 1 ? 'line' : 'lines'}`;
      if (!lines.length) note = gha && j.state === 'running' ? 'GitHub publishes the log when the job ends' : j.state === 'running' ? 'no output yet' : 'no output';
      // the failure's line: the server's index when it sends one, else matched to the cluster's
      const cl = j.state === 'running' ? '' : clusterLineOf(d.world(), id, step, workflow);
      const dec = typeof j.decisive === 'number' ? j.decisive - Math.max(0, (Array.isArray(j.lines) ? j.lines.length : 0) - lines.length) : undefined;
      return { ok: true, step, note, pin: 1_000_000 + (++fetches % 1000), ...logRows(lines, cl, dec) };
    }, (): Log => ({ ...NO_LOG, step, note: 'log unavailable' }))
    .then((v) => { if (held === slot) { slot.v = v; slot.p = null; } return v; });
  return slot.p;
}

/** The three sources app.ts spreads into its `sources`. */
export function flowSources(d: FlowDeps) {
  return {
    flow: (a: FlowArgs) => safe('flow', EMPTY_FLOW as Flow | Promise<Flow>, () => flowAnswer(d, a)),
    flowPanel: (a: [string, string, number]) => safe('flowPanel', EMPTY_PANEL, () => panelAnswer(d, a)),
    flowLog: (a: LogArgs) => safe('flowLog', NO_LOG as Log | Promise<Log>, () => logAnswer(d, a)),
  };
}

const warned = new Set<string>();
function safe<T>(name: string, empty: T, f: () => T): T {
  try { return f(); } catch (e) {
    if (!warned.has(name)) { warned.add(name); console.log(`${name}: ${(e as Error)?.stack ?? e}`); }
    return empty;
  }
}
