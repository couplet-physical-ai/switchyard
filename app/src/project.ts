// Projections: what each Contract view reads, computed from the shown world. Every answer is
// small and flat (rows of strings and numbers) so Contract diffs it cheaply.

import type { Journey, Pr, PrDetail, PrPhase, Repo, SearchHit } from './wire.ts';
import type { World } from './world.ts';
import type { Engine } from './wire.ts';
import { engineGroups, GHA, isRed } from './yard/layout.ts';
import { fmtClock, fmtDur } from './yard/paint.ts';

export const PHASES: PrPhase[] = ['draft', 'checks', 'review', 'mergeable', 'merged', 'deployed'];

export function ago(now: number, at: number | undefined | null): string {
  if (typeof at !== 'number' || !Number.isFinite(at) || at <= 0) return '';
  const d = now - at;
  if (d < 45_000) return 'just now';
  return `${fmtDur(d)} ago`;
}

export function short(sha: string | undefined | null): string {
  return String(sha ?? '').slice(0, 7);
}

/** A repo's main line in one word. Unknown or missing states read as quiet, never a throw. */
export function mainState(r: Repo | undefined | null): 'red' | 'building' | 'green' | 'quiet' {
  if (isRed(r ?? undefined)) return 'red';
  const s = r?.main?.state;
  if (s === 'running' || s === 'pending') return 'building';
  if (s === 'success') return 'green';
  return 'quiet';
}

// Mainlines and PRs rows are projected by their canvas tables (src/table/*), cached on the
// world's version and the filter; Contract reads only their headers.

export function laneText(l: string): string {
  switch (l) {
    case 'roadrunner_first': return 'roadrunner first';
    case 'gha_first': return 'gha first';
    case 'primary': return 'roadrunner';
    case 'ci': return 'roadrunner ci';
    case 'failsafe': return 'failsafe';
    case 'ci_only': return 'ci only';
    default: return 'no lane';
  }
}

export function phaseIndex(p: PrPhase | undefined): number {
  if (p === 'changes_requested') return 2;
  if (p === 'conflict') return 3;
  if (p === 'closed') return -1;
  return PHASES.indexOf(p as PrPhase);
}

export function phaseText(p: Pr): string {
  switch (p?.phase) {
    case 'changes_requested': return 'changes requested';
    case 'conflict': return 'conflict with base';
    case 'mergeable': return 'ready to merge';
    default: return String(p?.phase ?? 'unknown');
  }
}

const isFail = (s: unknown) => s === 'failure' || s === 'error';

/** A PR as the detail view's track and checks read it. Every field the wire may omit has a
 *  default here, so a sparse PR renders instead of throwing. */
export function prRow(pr: Pr, now: number, w: World) {
  const req = (Array.isArray(pr.checks) ? pr.checks : []).filter((c) => c && typeof c === 'object');
  // v0.4 lists only required and not-passed checks; the others that passed are a count.
  const passed = Math.max(0, Number(pr.checks_passed) || 0);
  const ok = req.filter((c) => c.state === 'success').length + passed;
  const failed = req.filter((c) => isFail(c.state)).length;
  const running = req.filter((c) => c.state === 'running' || c.state === 'pending').length;
  const stale = Number(pr.stale_ms) || 0;
  const repo = String(pr.repo ?? '');
  const author = String(pr.author ?? '');
  const review = pr.review && typeof pr.review === 'object' ? pr.review : {};
  return {
    id: `${repo}#${pr.number}`, repo, name: repo.split('/')[1] ?? repo, number: Number(pr.number) || 0, title: String(pr.title ?? ''),
    author: author.replace(/\[bot\]$/, ''), bot: !!pr.bot || author.endsWith('[bot]'), phase: String(pr.phase ?? ''), phaseIdx: phaseIndex(pr.phase),
    phaseText: phaseText(pr), checksOk: ok, checksTotal: req.length + passed, checksFailed: failed, checksRunning: running,
    checks: req.slice(0, 12).map((c) => String(c.state ?? 'none')),
    ai: String(review.ai ?? ''), human: String(review.human ?? ''), stale: stale > 86_400_000 ? `stale ${fmtDur(stale)}` : '', staleOld: stale > 3 * 86_400_000,
    blockedBy: String(pr.blocked_by ?? ''), updated: ago(now, pr.updated), url: String(pr.url ?? ''), org: w.orgOf(repo),
    bad: pr.phase === 'conflict' || pr.phase === 'changes_requested' || failed > 0,
    // The chip that is red: where the PR is stuck, not where it is.
    badIdx: pr.phase === 'conflict' ? 3 : pr.phase === 'changes_requested' ? 2 : failed > 0 && phaseIndex(pr.phase) <= 1 ? 1 : -1,
    // A PR that was never a draft has no draft phase behind it (review #17).
    draft: !!pr.draft || pr.phase === 'draft',
  };
}

const str = (v: unknown): string => (v == null ? '' : String(v));
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const arr = <T>(v: T[] | undefined | null): T[] => (Array.isArray(v) ? v.filter((x) => x != null) : []);

export function fleet(w: World, now: number) {
  const apps = Array.from(w.apps.entries()).filter(([, a]) => a && typeof a === 'object').map(([id, a]) => ({
    id, url: str(a.url), health: str(a.health) || 'unknown', latency: a.latency_ms != null ? `${Math.round(num(a.latency_ms))} ms` : '–',
    live: short(a.live_sha), main: short(a.main_sha), behind: num(a.behind),
    behindText: num(a.behind) > 0 ? `${a.behind} behind main` : a.live_sha ? 'at main' : 'never deployed',
    lastDeploy: a.last_deploy?.id ? deployText(w, a.last_deploy.id, now) : '', runtime: str(a.runtime), team: str(a.team), repo: str(a.repo),
    lane: laneText(w.repos.get(str(a.repo))?.lane ?? 'none'), checked: ago(now, a.checked),
    meta: [a.runtime, a.team].filter((x) => !!x).map(str).join(' · '),
    version: a.live_sha ? (a.main_sha && a.main_sha !== a.live_sha ? `${short(a.live_sha)} → ${short(a.main_sha)}` : short(a.live_sha)) : '',
    deployBad: !!a.last_deploy?.id && w.deploys.get(a.last_deploy.id)?.state === 'failure',
  }));
  const hOrder: Record<string, number> = { down: 0, degraded: 1, unknown: 2, up: 3 };
  apps.sort((a, b) => (hOrder[a.health] ?? 2) - (hOrder[b.health] ?? 2) || b.behind - a.behind || a.id.localeCompare(b.id));
  // Engines as the Yard groups them: a host (VM 153) with its agents under it, Dagger engine
  // hosts, GitHub Actions' runners (or the hosted pool when none are reported).
  const hosts = engineGroups(w).map((g) => {
    const engines = g.engines.map((e) => engineRow(w, e));
    const stat = g.stats.length ? g.stats.map((id) => w.engines.get(id)).filter((e): e is Engine => !!e) : g.engines;
    let busy = 0, slots = 0;
    for (const e of engines) { busy += e.busy; slots += e.slots; }
    // One engine is its own host (a Dagger VM): its row says its load, not the header too.
    return { id: g.id, title: g.title, sub: g.sub, busy, slots, load: g.engines.length > 1 ? loadWords(stat) : '', offline: g.engines.length > 0 && g.engines.every((e) => e.online === false), engines };
  });
  const engines = hosts.flatMap((h) => h.engines);
  const queues = Array.from(w.queues.values()).filter((q) => q && typeof q === 'object').map((q) => ({ id: str(q.id), pending: num(q.pending), running: num(q.running), oldest: q.pending ? fmtDur(num(q.oldest_wait_ms)) : '–' }));
  const s = w.stats ?? ({} as World['stats']);
  const pct = (v: number) => `${Math.round(v <= 1 ? v * 100 : v)}%`;
  const stats = [
    { label: 'commits · 24 h', value: fmtNum(num(s.commits_24h)) },
    { label: 'pipelines · 24 h', value: fmtNum(num(s.pipelines_24h)) },
    { label: 'green · 24 h', value: pct(num(s.success_rate_24h)) },
    { label: 'median wait', value: fmtDur(num(s.p50_queue_ms)) },
    { label: 'median build', value: fmtDur(num(s.p50_build_ms)) },
    { label: 'deploys · 24 h', value: fmtNum(num(s.deploys_24h)) },
  ];
  const up = apps.filter((a) => a.health === 'up').length;
  const wt = w.watcher ?? { id: 'outage', tripped: false, gh_status: 'unknown' };
  const gh = str(wt.gh_status) || 'unknown';
  const attention = apps.filter((a) => a.health === 'down' || a.health === 'degraded' || a.behind > 0 || a.deployBad).slice(0, 40);
  // The apps that need attention are listed once, above; the table holds the others.
  const above = new Set(attention.map((a) => a.id));
  const never = apps.filter((a) => !a.live).length;
  const loadRows = loadOrder(w).length;
  return {
    apps: apps.filter((a) => !above.has(a.id)), engines, hosts, queues, stats, up, total: apps.length, down: apps.filter((a) => a.health === 'down').length,
    degraded: apps.filter((a) => a.health === 'degraded').length,
    attention, behindN: apps.filter((a) => a.behind > 0).length, never,
    hasLatency: apps.some((a) => a.latency !== '–'),
    watcher: wt.tripped ? `tripped ${ago(now, wt.since)} · github ${gh}${wt.note ? ` · ${wt.note}` : ''}` : `calm · github ${gh}`,
    watcherTripped: !!wt.tripped,
    loadRows, loadH: loadRows ? 22 + loadRows * LOAD_ROW : 0,
    ...deploys24(w, now, num(s.deploys_24h)),
    ...laneSplit(w),
  };
}

/** One engine as the Fleet lists it: "wp-agent-1 · vm 153", its slots, cpu/mem, what runs. */
function engineRow(w: World, e: Engine) {
  const running = arr(e.running);
  const id = str(e.id);
  const host = str(e.host).toLowerCase();
  const label = id === GHA ? 'hosted runners'
    : e.kind === 'dagger' ? `${str(e.label ?? e.id).toLowerCase()} · dagger`
    : host ? `${id} · ${host}` : id;
  const slots = Math.max(1, num(e.slots));
  const cpu = pctText(e.cpu), mem = pctText(e.mem);
  // A GitHub Actions run's id is eleven digits that say nothing: "(actions)", as the Yard has it.
  const runningText = running.map((rid) => { const p = w.pipelines.get(rid); const name = p ? str(p.repo).split('/')[1] ?? p.repo : ''; return p ? (p.lane === 'gha' ? `${name} (actions)` : `${name} #${p.number}`) : str(rid); }).slice(0, 8).join(', ');
  const sub = [cpu !== '–' ? `cpu ${cpu}` : '', mem !== '–' ? `mem ${mem}` : '', e.online === false ? 'offline' : '', runningText].filter(Boolean).join(' · ');
  return {
    id, label, kind: e.kind === 'dagger' ? 'dagger engine' : e.kind === 'wp_agent' ? 'woodpecker agent' : 'gha runner',
    slots, busy: Math.min(slots, running.length), online: e.online !== false, cpu, mem, running: runningText, sub,
  };
}

const pctText = (v: number | undefined): string => (typeof v === 'number' && Number.isFinite(v) ? `${Math.round(v <= 1 ? v * 100 : v)}%` : '–');

/** A host's load in words: its Dagger engine's, else its agents' average. */
function loadWords(list: Engine[]): string {
  const avg = (f: (e: Engine) => number | undefined) => {
    let t = 0, n = 0;
    for (const e of list) { const v = f(e); if (typeof v === 'number' && Number.isFinite(v)) { t += v <= 1 && f !== loadOf ? v * 100 : v; n++; } }
    return n ? t / n : NaN;
  };
  const cpu = avg((e) => e.cpu), mem = avg((e) => e.mem), load = avg(loadOf);
  const out: string[] = [];
  if (!Number.isNaN(cpu)) out.push(`cpu ${Math.round(cpu)}%`);
  if (!Number.isNaN(mem)) out.push(`mem ${Math.round(mem)}%`);
  if (!Number.isNaN(load)) out.push(`load ${load.toFixed(1)}`);
  return out.join(' · ');
}
const loadOf = (e: Engine) => e.load;

/** The load canvas's rows: every engine, in the Yard's order (each has its slots busy; cpu,
 *  mem and load where the engine reports them). */
export const LOAD_ROW = 32;
export function loadOrder(w: World): Engine[] {
  const out: Engine[] = [];
  for (const g of engineGroups(w)) for (const e of g.engines) out.push(e);
  return out;
}

/** Deploys over 24 h: the server's count, the last hour, a bar an hour (ok / failed), by lane. */
function deploys24(w: World, now: number, total: number) {
  const H = 3_600_000;
  const ok = new Array<number>(24).fill(0), bad = new Array<number>(24).fill(0);
  let hour = 0, deploying = 0, rr = 0, gha = 0, fb = 0, failed = 0;
  for (const d of w.deploys.values()) {
    if (!d) continue;
    if (d.state === 'running' || d.state === 'pending') deploying++;
    const t = num(d.started ?? d.finished);
    const age = now - t;
    if (!t || age < 0 || age >= 24 * H) continue;
    const b = 23 - Math.floor(age / H);
    if (d.state === 'failure') { bad[b]++; failed++; } else ok[b]++;
    if (age < H) hour++;
    if (d.via === 'roadrunner') rr++; else if (d.via === 'gha') gha++; else if (d.via === 'gha_fallback') fb++;
  }
  let mx = 1;
  for (let i = 0; i < 24; i++) mx = Math.max(mx, ok[i] + bad[i]);
  const BAR = 38;
  const n24 = total || ok.reduce((a, b) => a + b, 0) + failed;
  return {
    deploysN: fmtNum(n24),
    deploysText: `${(n24 / 24).toFixed(1)}/h avg · ${hour} in the last hour${deploying ? ` · ${deploying} deploying` : ''}`,
    deploysVia: `roadrunner ${rr} · gha ${gha} · fallback ${fb}${failed ? ` · ${failed} failed` : ''}`,
    deployBars: ok.map((o, i) => ({ id: i, ok: o ? Math.max(2, Math.round((o / mx) * BAR)) : 0, bad: bad[i] ? Math.max(2, Math.round((bad[i] / mx) * BAR)) : 0 })),
    deployMax: mx,
  };
}

const LANE_ORDER: [string, string, string][] = [
  ['roadrunner_first', 'roadrunner first', 'sy.amber'], ['primary', 'roadrunner', 'sy.amber-text'], ['ci', 'roadrunner ci', 'sy.ink2'],
  ['ci_only', 'ci only', 'sy.ink3'], ['failsafe', 'failsafe', 'sy.red'], ['gha_first', 'gha first', 'sy.green'], ['none', 'no lane', 'sy.machine'],
];

/** How many repos deploy on each lane mode (the lane's own record, else the repo's), as a
 *  stacked bar's segments. */
function laneSplit(w: World) {
  const n = new Map<string, number>();
  let fallback = 0, held = 0;
  for (const [id, r] of w.repos) {
    const l = w.lanes.get(id);
    const m = str(l?.mode ?? r?.lane) || 'none';
    const k = LANE_ORDER.some((o) => o[0] === m) ? m : 'none';
    n.set(k, (n.get(k) ?? 0) + 1);
    if (l?.fallback) fallback++;
    if (l?.held) held++;
  }
  const total = Math.max(1, w.repos.size);
  const lanes = LANE_ORDER.filter(([k]) => (n.get(k) ?? 0) > 0).map(([k, label, color]) => {
    const c = n.get(k) ?? 0;
    return { id: k, label, n: c, color, width: `${((c / total) * 100).toFixed(2)}%` };
  });
  const notes = [fallback ? `${fallback} on fallback` : '', held ? `${held} held` : ''].filter(Boolean).join(' · ');
  return { lanes, lanesTotal: w.repos.size, lanesNote: notes };
}

function deployText(w: World, id: string, now: number): string {
  const d = w.deploys.get(id);
  if (!d) return '';
  const v = d.via === 'gha_fallback' ? 'gha fallback' : str(d.via) || 'unknown';
  return `${d.state === 'success' ? 'deployed' : str(d.state)} ${ago(now, d.finished ?? d.started)} via ${v}`;
}

function fmtNum(n: number): string {
  return n >= 10_000 ? `${(n / 1000).toFixed(1)}k` : n.toLocaleString('en-US');
}

/** The commit journey as rows on one time axis. */
const EMPTY_JOURNEY = {
  ok: false, error: '', repo: '', sha: '', short: '', title: '', author: '', branch: '', stage: '', pushed: '', total: '',
  spans: [] as JSpan[], pipelines: [] as JPipe[], deploys: [] as JDep[], deployVia: '', app: '', health: '', healthText: '', url: '', events: [] as JEv[], ciState: '', deployState: '', ticks: [] as string[],
};
type JSpan = { id: string; name: string; depth: number; start: number; width: number; state: string; dur: string; cached: boolean };
type JPipe = { id: string; number: number; lane: string; state: string; dur: string; wait: string; url: string; engine: string };
type JDep = { app: string; via: string; state: string; dur: string; start: number; width: number };
type JEv = { id: string; k: string; label: string; at: string; ago: string };

const via = (v: unknown) => (v === 'gha_fallback' ? 'gha fallback' : str(v));

/** One commit end to end: its pipelines' workflows and steps (or cicd's spans) on one axis.
 *  Spans are v0.2's (start/end/parent/state) or v0.3's (start + ms, one per Dagger call). */
export function journeyView(j: Journey | null, now: number, error = '', offsetMin = 0) {
  if (!j || typeof j !== 'object') return { ...EMPTY_JOURNEY, error: error || 'No such commit in the last day.' };
  const pipes = arr(j.pipelines).slice().sort((a, b) => num(a.created) - num(b.created));
  const c = j.commit && typeof j.commit === 'object' ? j.commit : null;
  const repo = str(c?.repo ?? j.repo ?? pipes[0]?.repo);
  const sha = str(c?.sha ?? j.sha ?? pipes[0]?.sha);
  const dot = arr(j.repo_state?.main?.recent).find((d) => d.sha === sha);
  const title = str(c?.title ?? pipes[0]?.title ?? dot?.title);
  const author = str(c?.author ?? pipes[0]?.author ?? dot?.author);
  const t0 = num(c?.at ?? dot?.at ?? pipes[0]?.created) || now;
  let t1 = t0 + 1000;
  const spans0 = arr(j.spans).filter((sp) => typeof sp.start === 'number');
  const endOf = (sp: { start: number; end?: number; ms?: number }) => (typeof sp.end === 'number' ? sp.end : typeof sp.ms === 'number' ? sp.start + sp.ms : now);
  for (const sp of spans0) t1 = Math.max(t1, endOf(sp as { start: number; end?: number; ms?: number }));
  for (const p of pipes) t1 = Math.max(t1, num(p.finished ?? (p.state === 'running' || p.state === 'pending' ? now : p.started ?? p.created)));
  for (const d of arr(j.deploys)) t1 = Math.max(t1, num(d.finished ?? now));
  const total = Math.max(1000, t1 - t0);
  const pos = (a: number) => Math.max(0, Math.min(1, (a - t0) / total));
  const wid = (a: number, b: number) => Math.max(0.004, Math.min(1, (b - a) / total));
  const rows: JSpan[] = [];
  if (spans0.length) {
    const depth = new Map<string, number>();
    for (const sp of spans0.slice().sort((a, b) => a.start - b.start)) {
      const d = sp.parent ? (depth.get(sp.parent) ?? 0) + 1 : 0;
      depth.set(str(sp.id), d);
      const end = endOf(sp as { start: number; end?: number; ms?: number });
      const name = sp.call ? `${str(sp.name)} ${sp.call}` : str(sp.name);
      const label = sp.pipeline != null && pipes.length > 1 ? `#${sp.pipeline} ${name}` : name;
      rows.push({ id: `${str(sp.id) || sp.name}:${sp.start}`, name: label, depth: d, start: pos(sp.start), width: wid(sp.start, end), state: str(sp.state) || 'success', dur: fmtDur(end - sp.start) + (sp.spans ? ` · ${sp.spans}` : ''), cached: !!sp.cached });
    }
  } else {
    // No traces: the workflows and their steps, as Roadrunner and GitHub report them.
    for (const p of pipes) {
      for (const wf of arr(p.workflows)) {
        const ws = wf.started ?? p.started;
        if (ws == null) continue;
        const we = wf.finished ?? (wf.state === 'running' ? now : ws);
        rows.push({ id: `${p.id}/${wf.name}`, name: pipes.length > 1 ? `#${p.number} ${str(wf.name)}` : str(wf.name), depth: 0, start: pos(ws), width: wid(ws, we), state: str(wf.state), dur: fmtDur(we - ws), cached: false });
        for (const st of arr(wf.steps)) {
          if (st.started == null) continue;
          const se = st.finished ?? (st.state === 'running' ? now : st.started);
          rows.push({ id: `${p.id}/${wf.name}/${st.name}`, name: str(st.name), depth: 1, start: pos(st.started), width: wid(st.started, se), state: str(st.state), dur: fmtDur(se - st.started), cached: !!st.cached });
        }
      }
    }
  }
  const app = j.app && typeof j.app === 'object' ? j.app : null;
  const deploys = arr(j.deploys);
  const stage = str(c?.stage) || (pipes.some((p) => p.state === 'running') ? 'building' : pipes.some((p) => isFail(p.state)) ? 'failed' : pipes.length ? 'done' : 'pushed');
  return {
    ok: true, error: '', repo, sha, short: short(sha), title, author, branch: str(c?.branch ?? pipes[0]?.branch), stage,
    pushed: ago(now, t0), total: fmtDur(total), spans: rows.slice(0, 160),
    pipelines: pipes.map((p) => ({ id: str(p.id) || `${p.repo}:${p.number}`, number: num(p.number), lane: str(p.lane), state: str(p.state), dur: fmtDur(num(p.finished ?? now) - num(p.started ?? p.created)), wait: fmtDur(num(p.started ?? now) - num(p.created)), url: str(p.url), engine: str(p.engine).toLowerCase() })),
    deploys: deploys.map((d) => ({ app: str(d.app), via: via(d.via), state: str(d.state), dur: fmtDur(num(d.finished ?? now) - num(d.started)), start: pos(num(d.started)), width: wid(num(d.started), num(d.finished ?? now)) })),
    deployVia: deploys[0] ? via(deploys[0].via) : 'none',
    app: app ? str(app.url).replace(/^https?:\/\//, '') : '', health: str(app?.health),
    healthText: app
      ? (deploys.length === 0 ? `not deployed by this commit${app.live_sha ? ` · it still runs ${short(app.live_sha)}` : ''} · ` : '')
        + `${str(app.health)}${app.latency_ms != null ? ` · ${Math.round(num(app.latency_ms))} ms` : ''}${app.behind ? ` · ${app.behind} behind main` : ''}`
      : '',
    url: repo && sha ? `https://github.com/${repo}/commit/${sha}` : '',
    events: arr(j.timeline).slice()
      .sort((a, b) => num(a.at) - num(b.at) || (EV_ORDER[str(a.k)] ?? 9) - (EV_ORDER[str(b.k)] ?? 9))
      .slice(-24).map((e, i) => ({ id: `${i}:${e.at}`, k: str(e.k), label: str(e.label), at: fmtClock(num(e.at), offsetMin), ago: ago(now, e.at) })),
    ciState: pipes.some((p) => isFail(p.state)) ? 'failure' : pipes.some((p) => p.state === 'running' || p.state === 'pending') ? 'running' : pipes.length ? 'success' : '',
    deployState: deploys.some((d) => d.state === 'failure') ? 'failure' : deploys.some((d) => d.state === 'running' || d.state === 'pending') ? 'running' : deploys.length ? 'success' : '',
    ticks: [0, 1, 2, 3, 4].map((k) => fmtDur((total * k) / 4)),
  };
}

/** Same-instant events read in the order they happen: a push, then its queueing, start, end. */
const EV_ORDER: Record<string, number> = { push: 0, enqueue: 1, queued: 1, start: 2, finish: 3, deploy: 4, deployed: 5, health: 6 };

const EMPTY_PR_DETAIL = { ok: false, row: null, commits: [], pipelines: [], timeline: [], meta: '', blocked: '', checkList: [], passed: 0, landsName: '', landsState: '', landsWords: '', landsNote: '', lands: [], deploys: [], note: '', links: [] };

export function prDetailView(d: PrDetail | null, now: number, w: World) {
  if (!d || typeof d !== 'object' || !d.pr || typeof d.pr !== 'object') return EMPTY_PR_DETAIL;
  const pr = d.pr;
  const all = Array.isArray(d.checks) ? d.checks.filter((c) => c && typeof c === 'object') : [];
  // v0.4's detail lists every check, so its passes replace the count; a detail that lists only
  // the unpassed ones (an older server, a sparse fixture) keeps the PR's own count.
  const listsPasses = all.some((c) => c.state === 'success');
  const passed = listsPasses ? all.filter((c) => c.state === 'success').length : num(pr.checks_passed);
  const checks = all.length ? all : arr(pr.checks);
  const rank = (st: string) => (st === 'failure' || st === 'error' ? 0 : st === 'running' || st === 'pending' ? 1 : st === 'success' ? 3 : 2);
  const checkList = checks
    .map((c) => ({ name: str(c.name), state: str(c.state) || 'pending', required: !!c.required }))
    .sort((a, b) => rank(a.state) - rank(b.state) || a.name.localeCompare(b.name))
    .slice(0, 40);
  const repo = d.repo_state && typeof d.repo_state === 'object' ? d.repo_state : w.repos.get(str(pr.repo));
  const recent = arr(repo?.main?.recent).slice(-12);
  const st = repo ? mainState(repo) : '';
  const since = num(repo?.main?.since);
  const branch = [str(pr.head), str(pr.base)].filter(Boolean).join(' → ');
  const meta = [pr.bot ? `${str(pr.author)} · bot` : str(pr.author), branch, pr.created ? `opened ${ago(now, pr.created)}` : '', pr.updated ? `updated ${ago(now, pr.updated)}` : '']
    .filter(Boolean).join(' · ');
  const links: { label: string; url: string }[] = [];
  if (str(pr.url)) links.push({ label: 'github ↗', url: str(pr.url) });
  const cicd = str((repo as { links?: { cicd?: string } } | undefined)?.links?.cicd);
  if (cicd) links.push({ label: 'cicd ↗', url: cicd });
  const commits = arr(d.commits).slice(-20).reverse().map((c) => ({ sha: str(c.sha), short: short(c.sha), title: str(c.title), author: str(c.author), ci: str(c.ci), ago: ago(now, c.at), repo: str(c.repo) }));
  const pipelines = arr(d.pipelines).slice(-12).reverse().map((p) => ({ number: num(p.number), lane: str(p.lane), state: str(p.state), dur: fmtDur(num(p.finished ?? now) - num(p.started ?? p.created)), sha: short(p.sha), ago: ago(now, p.created) }));
  return {
    ok: true,
    row: prRow(all.length ? { ...pr, checks: all.filter((c) => c.state !== 'success' || c.required), checks_passed: listsPasses ? all.filter((c) => c.state === 'success' && !c.required).length : num(pr.checks_passed) } : pr, now, w),
    commits,
    pipelines,
    timeline: arr(d.timeline).map((t) => ({ phase: str(t.phase), note: str(t.note), ago: ago(now, t.at) })),
    meta,
    blocked: str(pr.blocked_by),
    checkList,
    passed,
    landsName: repo ? `${str(repo.name) || str(pr.repo)} · ${str(repo.default_branch) || 'main'}` : '',
    landsState: st,
    landsWords: !repo ? '' : st === 'red' ? `red ${since ? fmtDur(now - since) : ''}`.trim() : st === 'green' && since ? `green since ${ago(now, since).replace(/ ago$/, '')}` : st,
    landsNote: repo && str(pr.base) && str(pr.base) !== (str(repo.default_branch) || 'main') ? `this pull request targets ${str(pr.base)}, not ${str(repo.default_branch) || 'main'}` : '',
    lands: recent.map((x) => ({ state: str(x.state), sha: short(x.sha), title: str(x.title) })),
    deploys: arr(d.deploys).slice(-6).reverse().map((x) => ({ app: str(x.app), state: str(x.state), via: str(x.via), ago: ago(now, x.started) })),
    note: !commits.length && !pipelines.length ? 'No commit or pipeline of this pull request ran in the server\'s window (the last 24 h).' : '',
    links,
  };
}

/** ⌘K: instant matches from the shown world. */
export function search(w: World, q: string, now: number): SearchHit[] {
  const ql = String(q ?? '').trim().toLowerCase();
  if (!ql) {
    // Nothing typed: what is on fire, then the hottest repos.
    const out: SearchHit[] = [];
    for (const r of w.repos.values()) if (r?.id && isRed(r)) out.push({ kind: 'repo', id: r.id, title: r.id, subtitle: r.main?.since ? `red ${fmtDur(now - r.main.since)}` : 'red', score: 100 });
    for (const [id, a] of w.apps) if (a?.health === 'down') out.push({ kind: 'app', id, title: id, subtitle: 'down', score: 90 });
    const hot = Array.from(w.repos.values()).filter((r) => r?.id).sort((a, b) => num(b.heat) - num(a.heat)).slice(0, 8);
    for (const r of hot) if (!out.some((o) => o.id === r.id)) out.push({ kind: 'repo', id: r.id, title: r.id, subtitle: `${num(r.open_prs)} open PRs · ${laneText(r.lane)}`, score: 50 });
    return out.slice(0, 12);
  }
  const hits: SearchHit[] = [];
  const score = (v: unknown) => { const l = str(v).toLowerCase(); if (!l) return 0; return l === ql ? 100 : l.startsWith(ql) ? 80 : l.includes(`/${ql}`) ? 70 : l.includes(ql) ? 40 : 0; };
  for (const r of w.repos.values()) { if (!r?.id) continue; const s = Math.max(score(r.name), score(r.id)); if (s) hits.push({ kind: 'repo', id: r.id, title: r.id, subtitle: `main ${mainState(r)} · ${num(r.open_prs)} open PRs`, score: s + 5 }); }
  for (const [id, a] of w.apps) { if (!a) continue; const s = score(id); if (s) hits.push({ kind: 'app', id, title: id, subtitle: `${str(a.health) || 'unknown'} · ${str(a.url).replace(/^https?:\/\//, '')}`, score: s + 3 }); }
  const n = ql.replace(/^#/, '');
  for (const pr of w.prs.values()) {
    if (!pr?.repo) continue;
    const s = String(pr.number) === n ? 90 : score(pr.title) ? score(pr.title) - 10 : 0;
    if (s > 0) hits.push({ kind: 'pr', id: `${pr.repo}#${pr.number}`, title: `${pr.repo.split('/')[1] ?? pr.repo} #${pr.number} ${str(pr.title)}`, subtitle: `${phaseText(pr)} · ${str(pr.author)}`, score: s });
  }
  if (ql.length >= 4 && /^[0-9a-f]+$/.test(ql)) {
    for (const c of w.commits.values()) if (str(c?.sha).startsWith(ql)) hits.push({ kind: 'commit', id: `${c.repo}@${c.sha}`, title: `${short(c.sha)} ${str(c.title)}`, subtitle: `${str(c.repo)} · ${str(c.author)} · ${ago(now, c.at)}`, score: 95 });
  } else if (ql.length >= 3) {
    let k = 0;
    for (const c of w.commits.values()) {
      if (k > 40) break;
      if (str(c?.title).toLowerCase().includes(ql)) { hits.push({ kind: 'commit', id: `${c.repo}@${c.sha}`, title: `${short(c.sha)} ${str(c.title)}`, subtitle: `${str(c.repo)} · ${str(c.author)} · ${ago(now, c.at)}`, score: 20 }); k++; }
    }
  }
  for (const p of w.pipelines.values()) if (p && (`#${p.number}` === ql || String(p.number) === n)) hits.push({ kind: 'pipeline', id: str(p.id), title: `${str(p.repo).split('/')[1] ?? p.repo} #${p.number}`, subtitle: `${str(p.state)} · ${str(p.lane)}`, score: 60 });
  hits.sort((a, b) => b.score - a.score || a.title.localeCompare(b.title));
  return hits.slice(0, 30);
}
