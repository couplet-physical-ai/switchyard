// Factory 3 (FACTORY3.md), "the berth board": the model. The delivery line as six stations in
// flow order (waiting → building → checks → main lines → deploy → apps) and a ledger of the
// last events traced through the same stations. Every item is one real thing: a run, a slot, a
// main line, a deploy, an app. Read-only over the World and the shared selectors.
//
// Nothing here depends on wall time except what is live work (a running or waiting run's
// timers): a finished thing's age is said in whole minutes by the scene, so an idle fleet's
// model is the same from one second to the next.

import type { App, Engine, Pipeline, Repo } from '../wire.ts';
import type { World } from '../world.ts';
import { buildingIds, isRed, queueTruth } from '../yard/select.ts';
import { flowOf, hostOfName, type FlowEvent, type FlowJob } from '../flow/model.ts';

export const WINDOWS: [string, number][] = [['10m', 600_000], ['30m', 1_800_000], ['1h', 3_600_000], ['2h', 7_200_000]];
export const windowMs = (w: string): number => (WINDOWS.find(([k]) => k === w) ?? WINDOWS[1])[1];

export type RunState = 'wait' | 'run' | 'pass' | 'fail' | 'cancel';
/** One CI run (a crate). */
export type Run = {
  id: string; repo: string; name: string; num: string; kind: string; branch: string; sha: string;
  state: RunState; created: number; started: number; finished: number;
  /** the usual duration (0 when unknown) */
  expectedMs: number;
  /** the step it runs or failed at */
  step: string; lane: 'roadrunner' | 'gha'; deploy: boolean;
  /** failed, and a later run of the same repo, branch and trigger passed */
  fixed: boolean;
};
/** A berth of a machine: 1-based, on an agent; the run in it. */
export type Slot = { n: number; agent: string; run: Run | null; step: string };
export type Machine = { id: string; label: string; url: string; online: boolean; cols: number; slots: Slot[]; busy: number; over: number };
export type FailGroup = { run: Run; count: number };
export type Bead = 'pass' | 'fail' | 'run' | 'none';
export type RedLine = { repo: string; name: string; since: number; beads: Bead[]; url: string };
export type Dep = { id: string; app: string; repo: string; sha: string; via: string; state: 'run' | 'fail' | 'pass'; started: number; finished: number; pipeline: string; expectedMs: number };
export type AppCell = { id: string; health: string; since: number };
export type CellState = 'na' | 'none' | 'wait' | 'run' | 'pass' | 'fail' | 'warn' | 'cancel';
/** One stage of an event's trace. `t0`: when a live stage started (its timer). */
export type Cell = { state: CellState; word: string; t0: number; id: string };
export type Row = {
  id: string; kind: string; repo: string; name: string; ref: string; title: string; author: string; at: number;
  /** the run a press opens: the failing one, else the running one, else the first */
  pid: string; ranOn: string; folded: number;
  checks: Cell; main: Cell; deploy: Cell; app: Cell;
};

export type Board = {
  at: number;
  waiting: { items: Run[]; total: number; oldestAt: number; url: string };
  machines: Machine[]; busy: number; slots: number;
  checks: { results: Run[]; ran: number; failed: number; bin: FailGroup[]; binTotal: number };
  mains: { red: RedLine[]; green: number };
  /** `landed`: deploys that succeeded in the last half minute (a transit's end: their app's cell) */
  deploy: { running: Dep[]; failed: Dep[]; landed: Dep[]; today: number };
  apps: { cells: AppCell[]; total: number; up: number; bad: AppCell[] };
  ledger: Row[];
  /** a running run → the berth it is in ("vm 153 · slot 2") */
  where: Map<string, string>;
  /** nothing runs, waits or deploys: the board changes only with the world or the minute */
  quiet: boolean;
};

const isFail = (s: string) => s === 'failure' || s === 'error';
const kindWord = (p: Pipeline) => (p.deploy ? 'deploy' : p.event === 'pull_request' ? 'pr' : p.event === 'deployment' ? 'deploy' : p.event);

function runStep(p: Pipeline, failed: boolean, agent = ''): string {
  const ws = p.workflows ?? [];
  if (failed) {
    for (const wf of ws) for (const s of wf.steps ?? []) if (isFail(s.state)) return s.name;
    for (const wf of ws) if (isFail(wf.state)) return wf.name;
    return '';
  }
  // the newest running step, of the workflow on this agent when the run spans several
  let best = '', at = -1;
  for (const wf of ws) {
    if (agent && wf.engine && wf.engine !== agent) continue;
    for (const s of wf.steps ?? []) if (s.state === 'running' && (s.started ?? 0) >= at) { best = s.name; at = s.started ?? 0; }
  }
  if (best || !agent) return best;
  return runStep(p, false);
}

function runOf(w: World, p: Pipeline, fixed = false): Run {
  const r = w.repos.get(p.repo);
  const failed = isFail(p.state);
  const state: RunState = p.state === 'running' ? 'run' : p.state === 'pending' || p.state === 'blocked' ? 'wait' : p.state === 'success' ? 'pass' : failed ? 'fail' : 'cancel';
  return {
    id: p.id ?? `${p.repo}#${p.number}`, repo: p.repo, name: r?.name ?? p.repo.split('/')[1] ?? p.repo,
    num: p.lane === 'gha' ? '' : `#${p.number}`, kind: kindWord(p), branch: p.branch, sha: p.sha,
    state, created: p.created, started: p.started ?? 0, finished: p.finished ?? 0,
    expectedMs: p.expected_ms ?? r?.p50_build_ms ?? 0, step: runStep(p, failed), lane: p.lane, deploy: !!p.deploy, fixed,
  };
}

// ---- sticky slots --------------------------------------------------------------------------

/** Which berth a run sits in. The server lists what an agent runs, in an order that closes up
 *  when a run leaves; a berth must not: a run keeps the berth it took until it leaves, and a
 *  new one takes the lowest free berth. One book per board (it is the board's memory). */
export class SlotBook {
  private held = new Map<string, (string | null)[]>();
  place(agent: string, slots: number, running: string[]): (string | null)[] {
    const was = this.held.get(agent) ?? [];
    const n = Math.max(slots, 0);
    const out: (string | null)[] = Array.from({ length: n }, (_, i) => (i < was.length && was[i] && running.includes(was[i]!) ? was[i] : null));
    for (const id of running) {
      if (out.includes(id)) continue;
      const free = out.indexOf(null);
      if (free >= 0) out[free] = id; else out.push(id);
    }
    this.held.set(agent, out);
    return out;
  }
}

const GHA_SLOTS = 4;

function hostOf(e: Engine): string {
  if (e.host) return e.host;
  if (e.kind === 'dagger' && e.id.startsWith('dagger:')) return e.id.slice(7);
  return hostOfName(e.label ?? e.id);
}
function hostOrder(h: string): number {
  const m = /^VM (\d+)/.exec(h);
  return m ? Number(m[1]) : /mac/i.test(h) ? 10_000 : 20_000;
}

function machinesOf(w: World, book: SlotBook, building: Set<string>): { machines: Machine[]; busy: number; slots: number } {
  type Host = { host: string; agents: Engine[]; url: string; online: boolean };
  const hosts = new Map<string, Host>();
  let ghaSlots = 0;
  for (const e of w.engines.values()) {
    if (e.kind === 'gha_runner') { ghaSlots += e.slots || 1; continue; }
    const host = hostOf(e);
    let h = hosts.get(host);
    if (!h) hosts.set(host, (h = { host, agents: [], url: '', online: false }));
    h.agents.push(e);
    const url = (e as Engine & { url?: string }).url;
    if (url && (!h.url || e.kind === 'dagger')) h.url = url;
    if (e.online !== false) h.online = true;
  }
  const placed = new Set<string>();
  const machines: Machine[] = [];
  let busy = 0, slots = 0;
  const list = [...hosts.values()].sort((a, b) => hostOrder(a.host) - hostOrder(b.host) || (a.host < b.host ? -1 : 1));
  // a run the engines do not list yet goes by the agent it names
  const byAgent = new Map<string, string[]>();
  for (const id of building) {
    const p = w.pipelines.get(id);
    if (!p || p.lane === 'gha') continue;
    let listed = false;
    for (const e of w.engines.values()) if (e.running?.includes(id)) { listed = true; break; }
    if (listed) continue;
    const name = p.engine ?? p.workflows?.find((x) => x.state === 'running' && x.engine)?.engine;
    if (name) byAgent.set(name, [...(byAgent.get(name) ?? []), id]);
  }
  for (const h of list) {
    // a Dagger host that lists its agents counts through them (the same slots)
    const wp = h.agents.filter((e) => e.kind === 'wp_agent');
    const agents = (wp.length ? wp : h.agents).sort((a, b) => ((a.label ?? a.id) < (b.label ?? b.id) ? -1 : 1));
    const out: Slot[] = [];
    let mBusy = 0, over = 0;
    for (const e of agents) {
      const label = e.label ?? e.id;
      const ids = (e.running ?? []).filter((id) => building.has(id));
      for (const id of [...(byAgent.get(label) ?? []), ...(byAgent.get(e.id) ?? [])]) if (!ids.includes(id)) ids.push(id);
      const at = book.place(e.id, e.slots ?? 0, ids);
      const n = Math.max(e.slots ?? 0, 1);
      for (let i = 0; i < n; i++) {
        const id = at[i] ?? null;
        const p = id ? w.pipelines.get(id) : undefined;
        if (p) { mBusy++; placed.add(p.id ?? ''); }
        out.push({ n: out.length + 1, agent: label, run: p ? runOf(w, p) : null, step: p ? runStep(p, false, label) : '' });
      }
      over += Math.max(0, at.length - n);
    }
    busy += mBusy; slots += out.length;
    machines.push({ id: `m:${h.host}`, label: h.host.toLowerCase(), url: h.url, online: h.online, cols: Math.max(1, agents.length), slots: out, busy: mBusy, over });
  }
  // GitHub Actions: hosted slots, no agents
  const gha: string[] = [];
  for (const id of building) if (w.pipelines.get(id)?.lane === 'gha') gha.push(id);
  gha.sort();
  const gn = Math.max(GHA_SLOTS, ghaSlots);
  const at = book.place('gha', gn, gha);
  const gs: Slot[] = [];
  let gBusy = 0;
  for (let i = 0; i < gn; i++) {
    const p = at[i] ? w.pipelines.get(at[i]!) : undefined;
    if (p) gBusy++;
    gs.push({ n: i + 1, agent: 'github', run: p ? runOf(w, p) : null, step: p ? runStep(p, false) : '' });
  }
  busy += gBusy; slots += gn;
  machines.push({ id: 'm:gha', label: 'actions', url: '', online: true, cols: 2, slots: gs, busy: gBusy, over: Math.max(0, at.length - gn) });
  return { machines, busy, slots };
}

// ---- the ledger ----------------------------------------------------------------------------

const NA: Cell = { state: 'na', word: '', t0: 0, id: '' };
const dur = (ms: number): string => {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s` : `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
};

function rowOf(w: World, e: FlowEvent, where: Map<string, string>): Row {
  const r = w.repos.get(e.repo);
  const jobs = e.jobs;
  const ci = jobs.filter((j) => j.kind !== 'deploy');
  const pick = (list: FlowJob[]) => list.find((j) => j.state === 'fail') ?? list.find((j) => j.state === 'running') ?? list.find((j) => j.state === 'queued' || j.state === 'waiting') ?? list[0];
  const head = pick(ci.length ? ci : jobs);
  // ---- checks: the runs that are not deploys, as one verdict
  let checks: Cell = NA;
  if (ci.length) {
    const fail = ci.find((j) => j.state === 'fail');
    const run = ci.find((j) => j.state === 'running');
    const wait = ci.find((j) => j.state === 'queued' || j.state === 'waiting');
    if (fail) checks = { state: 'fail', word: fail.result.failStep ? `failed at ${fail.result.failStep}` : 'failed', t0: 0, id: fail.id };
    else if (run) checks = { state: 'run', word: run.step?.name ?? 'running', t0: run.started ?? run.created, id: run.id };
    else if (wait) checks = { state: 'wait', word: 'waiting', t0: wait.created, id: wait.id };
    else if (ci.every((j) => j.state === 'cancelled' || j.state === 'skipped')) checks = { state: 'cancel', word: 'canceled', t0: 0, id: ci[0].id };
    else {
      let ms = 0;
      for (const j of ci) if (j.result.durationMs && j.result.durationMs > ms) ms = j.result.durationMs;
      checks = { state: 'pass', word: ms ? `passed ${dur(ms)}` : 'passed', t0: 0, id: ci[0].id };
    }
  } else if (e.state === 'waiting') checks = { state: 'wait', word: 'no run yet', t0: e.at, id: '' };
  // ---- main: a push or a merge on the default branch lands on the main line
  let main: Cell = NA;
  const onMain = (e.kind === 'push' || e.kind === 'merge') && !!r && e.branch === r.default_branch;
  if (onMain) {
    const dot = r!.main?.recent?.find((d) => d.sha === e.sha);
    const s = dot?.state;
    if (s && isFail(s)) main = { state: 'fail', word: 'red', t0: 0, id: e.repo };
    else if (s === 'success') main = { state: 'pass', word: 'green', t0: 0, id: e.repo };
    else if (s === 'running' || s === 'pending') main = { state: 'run', word: 'checking', t0: 0, id: e.repo };
    else main = { state: 'none', word: '', t0: 0, id: e.repo };
  }
  // ---- deploy, and the app it reached
  let deploy: Cell = NA, app: Cell = NA;
  // (a cron or a PR on a deployed sha did not deploy it: only what can trigger a deploy says so)
  const d = e.kind === 'cron' || e.kind === 'pr' ? undefined : w.deploys.get(`${e.repo}@${e.sha}`);
  const appId = d?.app ?? (onMain ? r?.app : undefined);
  if (d) {
    const pid = d.pipeline && w.pipelines.has(d.pipeline) ? d.pipeline : (jobs.find((j) => j.kind === 'deploy')?.id ?? '');
    const via = d.via === 'roadrunner' ? 'roadrunner' : d.via === 'gha_fallback' ? 'actions fallback' : d.via === 'gha' ? 'actions' : d.via;
    const took = d.finished ? d.finished - d.started : 0;
    if (d.state === 'success') deploy = { state: 'pass', word: took > 0 && took < 3_600_000 ? `${via} ${dur(took)}` : via, t0: 0, id: pid };
    else if (d.state === 'failure') deploy = { state: 'fail', word: 'failed', t0: 0, id: pid };
    else if (d.state === 'running') deploy = { state: 'run', word: 'deploying', t0: d.started, id: pid };
    else deploy = { state: 'wait', word: 'waiting', t0: d.started, id: pid };
  } else if (appId && onMain) deploy = { state: 'none', word: '', t0: 0, id: '' };
  if (appId) {
    const a = w.apps.get(appId);
    if (d?.state === 'success' && a) {
      app = a.health === 'up' ? { state: 'pass', word: 'up', t0: 0, id: appId }
        : a.health === 'down' ? { state: 'fail', word: 'down', t0: 0, id: appId }
        : a.health === 'degraded' ? { state: 'warn', word: 'degraded', t0: 0, id: appId }
        : { state: 'none', word: 'unknown', t0: 0, id: appId };
    } else if (deploy.state !== 'na') app = { state: 'none', word: '', t0: 0, id: appId };
  }
  const m = head?.machine;
  const ranOn = (head && where.get(head.id)) ?? (!m ? '' : m.id === 'm:gha' ? 'actions' : (m.host ?? m.label).toLowerCase());
  return {
    id: e.id, kind: e.kind, repo: e.repo, name: r?.name ?? e.repo.split('/')[1] ?? e.repo,
    ref: e.kind === 'pr' && e.pr ? `#${e.pr}` : e.branch, title: (e.title ?? '').split('\n')[0], author: (e.author ?? '').replace(/\[bot\]$/, ''),
    at: e.at, pid: head?.id ?? '', ranOn, folded: 0, checks, main, deploy, app,
  };
}

/** The last events, newest first by the time they happened: a row keeps its place until a newer
 *  event arrives (a board that reorders on every state change cannot be read). A cron that fires
 *  again and again on one repo is one row (`×N`). */
function ledgerOf(w: World, now: number, cap: number, where: Map<string, string>): Row[] {
  const events = [...flowOf(w, Math.floor(now / 60_000) * 60_000).events].sort((a, b) => b.at - a.at || (a.id < b.id ? -1 : 1));
  const out: Row[] = [];
  const crons = new Map<string, Row>();
  for (const e of events) {
    if (e.kind === 'cron') {
      const head = crons.get(e.repo);
      if (head) { head.folded += 1 + (e.folded ? e.folded - 1 : 0); continue; }
    }
    if (out.length >= cap) continue;
    const row = rowOf(w, e, where);
    if (e.kind === 'cron') { row.folded = e.folded ?? 1; crons.set(e.repo, row); }
    out.push(row);
  }
  return out;
}

// ---- the board -----------------------------------------------------------------------------

export function boardOf(w: World, now: number, win: number, book: SlotBook): Board {
  const pipes = [...w.pipelines.values()];
  // ---- waiting: the queue in order
  const qt = queueTruth(w);
  let qUrl = '';
  for (const q of w.queues.values()) { const u = (q as { url?: string }).url; if (u && (!qUrl || q.id === 'roadrunner')) qUrl = u; }
  const waiting = { items: qt.items.map((p) => ({ ...runOf(w, p), state: 'wait' as RunState })), total: qt.waiting, oldestAt: qt.oldestAt, url: qUrl };
  // ---- building: the machines and their berths
  const { machines, busy, slots } = machinesOf(w, book, buildingIds(w));
  // ---- checks: every run that finished inside the window, oldest first; the failed bin
  // (the window's edge moves on the minute, with every age on the board)
  const t0 = Math.floor(now / 60_000) * 60_000 - win;
  const lastPass = new Map<string, number>();
  for (const p of pipes) {
    if (p.state !== 'success' || !p.finished) continue;
    const k = `${p.repo}|${p.branch}|${p.event}`;
    if ((lastPass.get(k) ?? 0) < p.finished) lastPass.set(k, p.finished);
  }
  const results: Run[] = [];
  let ran = 0, failed = 0;
  for (const p of pipes) {
    if (!p.finished || p.finished < t0 || p.finished > now + 60_000) continue;
    if (p.state === 'skipped' || p.state === 'running' || p.state === 'pending' || p.state === 'blocked' || p.state === 'none') continue;
    const f = isFail(p.state);
    if (p.state !== 'canceled') { ran++; if (f) failed++; }
    results.push(runOf(w, p, f && (lastPass.get(`${p.repo}|${p.branch}|${p.event}`) ?? 0) > p.finished));
  }
  results.sort((a, b) => a.finished - b.finished || (a.id < b.id ? -1 : 1));
  const groups = new Map<string, FailGroup>();
  let binTotal = 0;
  for (let i = results.length - 1; i >= 0; i--) {
    const r = results[i];
    if (r.state !== 'fail' || r.fixed) continue;
    binTotal++;
    const k = `${r.repo}|${r.branch}|${r.kind}|${r.step}`;
    const g = groups.get(k);
    if (g) g.count++; else groups.set(k, { run: r, count: 1 });
  }
  // ---- main lines: the red ones, newest broken first
  const red: RedLine[] = [];
  let lines = 0;
  for (const r of w.repos.values()) {
    if (!r.main?.recent?.length && (r.main?.state ?? 'none') === 'none') continue;
    lines++;
    if (isRed(r)) red.push(redLine(r));
  }
  red.sort((a, b) => b.since - a.since || (a.repo < b.repo ? -1 : 1));
  // ---- deploy: running now; the apps whose last deploy failed; a day's count
  const running: Dep[] = [], landed: Dep[] = [];
  const lastByApp = new Map<string, Dep>();
  let today = 0;
  for (const d of w.deploys.values()) {
    if (d.started >= now - 86_400_000) today++;
    const p = d.pipeline ? w.pipelines.get(d.pipeline) : undefined;
    const dep: Dep = {
      id: d.id ?? `${d.repo}@${d.sha}`, app: d.app, repo: d.repo, sha: d.sha, via: d.via, state: d.state === 'failure' ? 'fail' : d.state === 'success' ? 'pass' : 'run',
      started: d.started, finished: d.finished ?? 0, pipeline: p?.id ?? '', expectedMs: p?.expected_ms ?? 0,
    };
    if (dep.state === 'run') running.push(dep);
    else if (dep.state === 'pass' && dep.finished && now - dep.finished < 30_000) landed.push(dep);
    const was = lastByApp.get(d.app);
    if (!was || d.started > was.started) lastByApp.set(d.app, dep);
  }
  running.sort((a, b) => a.started - b.started || (a.id < b.id ? -1 : 1));
  const dFailed = [...lastByApp.values()].filter((d) => d.state === 'fail').sort((a, b) => b.started - a.started || (a.id < b.id ? -1 : 1));
  // ---- apps: every app, by name
  const cells: AppCell[] = [];
  let up = 0;
  const changed = new Map<string, number>();
  for (const h of w.health) changed.set(h.app, h.at);
  for (const a of w.apps.values()) {
    const id = a.id ?? a.url;
    cells.push({ id, health: a.health, since: changed.get(id) ?? 0 });
    if (a.health === 'up') up++;
  }
  cells.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const bad = cells.filter((c) => c.health === 'down' || c.health === 'degraded');
  bad.sort((a, b) => (a.health === b.health ? 0 : a.health === 'down' ? -1 : 1));
  const where = new Map<string, string>();
  for (const m of machines) for (const sl of m.slots) if (sl.run && !where.has(sl.run.id)) where.set(sl.run.id, `${m.label} · slot ${sl.n}`);
  const ledger = ledgerOf(w, now, 40, where);
  return {
    at: now, waiting, machines, busy, slots, where, quiet: busy === 0 && waiting.total === 0 && running.length === 0 && !ledger.some((r) => r.checks.t0 || r.deploy.t0),
    checks: { results, ran, failed, bin: [...groups.values()], binTotal },
    mains: { red, green: lines - red.length },
    deploy: { running, failed: dFailed, landed, today },
    apps: { cells, total: cells.length, up, bad },
    ledger,
  };
}

function redLine(r: Repo): RedLine {
  const rec = r.main.recent ?? [];
  const cul = rec.find((d) => d.sha === r.main.culprit) ?? rec.find((d) => isFail(d.state));
  const beads: Bead[] = rec.slice(-8).map((d) => (isFail(d.state) ? 'fail' : d.state === 'running' || d.state === 'pending' ? 'run' : d.state === 'success' ? 'pass' : 'none'));
  return { repo: r.id, name: r.name, since: r.main.since || cul?.at || 0, beads, url: r.links?.cicd ?? r.links?.woodpecker ?? r.links?.github ?? '' };
}

export const appStatusUrl = (a: App | undefined): string => (a as (App & { status_url?: string }) | undefined)?.status_url ?? '';
