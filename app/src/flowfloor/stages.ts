// The Factory's model (ZERO.md "FACTORY REDO"): the fleet as ONE flow of work, by stage, never by
// team. Sources → intake → engines → tests → main lines → deploy → apps. Each stage says what is
// in it now, what moved through it in the last hour, and what broke there.
//
// Read-only over the World and the shared selectors (queueTruth, buildingIds, isRed, flowOf);
// memoised per World version, so a frame never rebuilds it.

import type { App, Pipeline, Repo } from '../wire.ts';
import type { World } from '../world.ts';
import { buildingIds, isRed, queueTruth } from '../yard/select.ts';
import { flowOf } from '../flow/model.ts';

export const HOUR = 3_600_000;

export type Kind = 'push' | 'pr' | 'cron' | 'tag' | 'manual' | 'deploy';
/** One unit of work on the floor: a CI run (a crate). */
export type Item = {
  id: string; repo: string; name: string; kind: Kind; number: number; sha: string; branch: string;
  state: 'wait' | 'run' | 'pass' | 'fail'; at: number; started?: number; finished?: number;
  /** elapsed / usual while running, 0..1 (−1 when the usual is unknown) */
  pct: number; expectedMs: number; step: string; url: string; deploy: boolean;
};
export type Bay = { slot: number; item: Item | null };
export type Machine = { id: string; label: string; slots: number; busy: number; online: boolean; url: string; bays: Bay[] };
export type RedMain = { repo: string; name: string; since: number; sha: string; title: string; author: string; url: string };
/** A main line's row in the yard: its name, red or not, its recent runs oldest → newest (beads). */
export type MainRow = { repo: string; name: string; red: boolean; since: number; at: number; beads: ('pass' | 'fail' | 'run')[]; url: string };
export type AppCell = { id: string; health: string; url: string; statusUrl: string; repo: string };

export type Stages = {
  at: number;
  sources: { perHour: number; push: number; pr: number; cron: number; other: number; arrivals: Item[] };
  intake: { items: Item[]; waiting: number; oldestAt: number };
  engines: { machines: Machine[]; running: number; slots: number };
  tests: { total: number; failed: number; passRate: number; fails: Item[] };
  mains: { total: number; red: RedMain[]; green: number; rows: MainRow[] };
  deploy: { running: Item[]; today: number; failed: Item[] };
  apps: { total: number; up: number; down: AppCell[]; cells: AppCell[] };
  /** Runs that moved between stages in the last hour (the belts' density). */
  flow: { intake: number; engines: number; tests: number; mains: number; deploy: number };
};

const kindOf = (p: Pipeline): Kind =>
  p.deploy ? 'deploy' : p.event === 'pull_request' ? 'pr' : p.event === 'cron' ? 'cron' : p.event === 'tag' ? 'tag' : p.event === 'manual' ? 'manual' : 'push';

function stepOf(p: Pipeline, failed: boolean): string {
  for (const wf of p.workflows ?? []) for (const s of wf.steps ?? []) {
    if (failed ? s.state === 'failure' || s.state === 'error' : s.state === 'running') return s.name;
  }
  return '';
}

function item(w: World, p: Pipeline, now: number): Item {
  const r = w.repos.get(p.repo);
  const st = p.state === 'running' ? 'run' : p.state === 'pending' || p.state === 'blocked' ? 'wait' : p.state === 'success' ? 'pass' : 'fail';
  const exp = p.expected_ms ?? r?.p50_build_ms ?? w.stats.p50_build_ms ?? 0;
  const el = p.started ? now - p.started : 0;
  return {
    id: p.id ?? `${p.repo}#${p.number}`, repo: p.repo, name: r?.name ?? p.repo.split('/')[1] ?? p.repo, kind: kindOf(p),
    number: p.number, sha: p.sha, branch: p.branch, state: st, at: p.created, started: p.started, finished: p.finished,
    pct: st === 'run' ? (exp > 0 ? Math.min(0.98, Math.max(0.02, el / exp)) : -1) : 0, expectedMs: exp,
    step: stepOf(p, st === 'fail'), url: p.url, deploy: !!p.deploy,
  };
}

const memo = new WeakMap<World, { key: string; v: Stages }>();

export function stagesOf(w: World, now: number): Stages {
  const key = `${w.seq}:${Math.floor(now / 5000)}`;
  const hit = memo.get(w);
  if (hit && hit.key === key) return hit.v;
  const v = build(w, now);
  memo.set(w, { key, v });
  return v;
}

function build(w: World, now: number): Stages {
  const h0 = now - HOUR;
  const pipes = [...w.pipelines.values()];
  // ---- sources: what arrived (distinct repo@sha#event) in the last hour; the newest arrivals
  const seen = new Set<string>();
  let push = 0, pr = 0, cron = 0, other = 0;
  const arrivals: Item[] = [];
  for (const p of pipes) {
    if (p.created < h0) continue;
    const k = `${p.repo}@${p.sha}#${p.event}`;
    if (seen.has(k)) continue;
    seen.add(k);
    if (p.event === 'push') push++; else if (p.event === 'pull_request') pr++; else if (p.event === 'cron') cron++; else other++;
    if (now - p.created < 10 * 60_000) arrivals.push(item(w, p, now));
  }
  arrivals.sort((a, b) => b.at - a.at);
  // ---- intake: the queue in order
  const qt = queueTruth(w);
  const intake = { items: qt.items.map((p) => item(w, p, now)), waiting: qt.waiting, oldestAt: qt.oldestAt };
  // ---- engines: each host and its slots, the runs in them (the flow model's slot map)
  const fv = flowOf(w, now);
  const building = buildingIds(w);
  const byMachine = new Map<string, Bay[]>();
  for (const e of fv.events) for (const j of e.jobs) {
    if (j.state !== 'running' || !j.machine) continue;
    const p = w.pipelines.get(j.id);
    if (!p || !building.has(j.id)) continue;
    const bays = byMachine.get(j.machine.id) ?? [];
    bays.push({ slot: j.machine.slot ?? bays.length + 1, item: item(w, p, now) });
    byMachine.set(j.machine.id, bays);
  }
  let running = 0, slots = 0;
  const machines: Machine[] = fv.machines.map((m) => {
    const got = (byMachine.get(m.id) ?? []).sort((a, b) => a.slot - b.slot);
    const n = Math.max(m.slots ?? 0, got.length, m.id === 'm:gha' ? Math.max(4, got.length) : 0);
    const bays: Bay[] = Array.from({ length: n }, (_, i) => ({ slot: i + 1, item: null }));
    let k = 0;
    for (const b of got) {
      const i = b.slot >= 1 && b.slot <= n && !bays[b.slot - 1].item ? b.slot - 1 : bays.findIndex((x) => !x.item);
      if (i >= 0) bays[i].item = b.item; else k++;
    }
    running += got.length - k; slots += m.id === 'm:gha' ? 0 : (m.slots ?? 0);
    const eng = [...w.engines.values()].find((e) => (e.host ?? e.label ?? e.id) === m.host && e.kind === 'dagger') ?? [...w.engines.values()].find((e) => (e.host ?? '') === m.host);
    return { id: m.id, label: m.label === 'GitHub runner' ? 'github actions' : m.label.toLowerCase(), slots: m.slots ?? 0, busy: got.length, online: m.online !== false, url: (eng as { url?: string } | undefined)?.url ?? '', bays };
  });
  // ---- tests: what finished in the last hour, and what failed (the reject pile)
  let total = 0, failed = 0;
  const fails: Item[] = [];
  for (const p of pipes) {
    if (!p.finished || p.finished < h0) continue;
    if (p.state === 'canceled' || p.state === 'skipped') continue;
    total++;
    if (p.state === 'failure' || p.state === 'error') { failed++; fails.push(item(w, p, now)); }
  }
  fails.sort((a, b) => (b.finished ?? 0) - (a.finished ?? 0));
  // ---- main lines: red ones (oldest red first), the rest green
  const red: RedMain[] = [];
  let mainsTotal = 0;
  for (const r of w.repos.values()) {
    if (!r.main?.recent?.length && r.main?.state === 'none') continue;
    mainsTotal++;
    if (!isRed(r)) continue;
    red.push(redMain(r));
  }
  red.sort((a, b) => a.since - b.since);
  // the yard's rows: every red line first (oldest red first), then the green ones that moved last
  const rows: MainRow[] = [];
  const greens: MainRow[] = [];
  for (const r of w.repos.values()) {
    const rec = r.main?.recent ?? [];
    if (!rec.length) continue;
    const row: MainRow = {
      repo: r.id, name: r.name, red: isRed(r), since: r.main.since || 0, at: rec[rec.length - 1]?.at ?? 0,
      beads: rec.slice(-10).map((d) => (d.state === 'failure' || d.state === 'error' ? 'fail' : d.state === 'running' || d.state === 'pending' ? 'run' : 'pass')),
      url: r.links?.cicd ?? r.links?.github ?? '',
    };
    (row.red ? rows : greens).push(row);
  }
  rows.sort((a, b) => b.since - a.since); // newest broken first
  greens.sort((a, b) => b.at - a.at);
  rows.push(...greens.slice(0, 40));
  // ---- deploy: deploys running now, today's count, the failed ones still failed
  const dRunning: Item[] = [], dFailed: Item[] = [];
  for (const p of pipes) {
    if (!p.deploy) continue;
    if (p.state === 'running' || p.state === 'pending') dRunning.push(item(w, p, now));
  }
  const day0 = now - 24 * HOUR;
  let today = 0;
  const lastByApp = new Map<string, { state: string; at: number; p?: Pipeline }>();
  for (const d of w.deploys.values()) {
    if (d.started >= day0) today++;
    const was = lastByApp.get(d.app);
    if (!was || d.started > was.at) lastByApp.set(d.app, { state: d.state, at: d.started, p: d.pipeline ? w.pipelines.get(d.pipeline) : undefined });
  }
  for (const [, d] of lastByApp) if (d.state === 'failure' && d.p) dFailed.push(item(w, d.p, now));
  // ---- apps: every app, health on its top
  const cells: AppCell[] = [];
  let up = 0;
  for (const a of w.apps.values()) {
    const c = appCell(a);
    cells.push(c);
    if (a.health === 'up') up++;
  }
  cells.sort((a, b) => a.id.localeCompare(b.id));
  const down = cells.filter((c) => c.health === 'down' || c.health === 'degraded');
  // ---- the belts: runs that moved through each stage in the last hour
  let fIntake = 0, fEng = 0, fMains = 0;
  for (const p of pipes) {
    if (p.created >= h0) fIntake++;
    if (p.started && p.started >= h0) fEng++;
    if (p.finished && p.finished >= h0 && p.state === 'success' && p.event === 'push' && p.branch === (w.repos.get(p.repo)?.default_branch ?? 'main')) fMains++;
  }
  let fDeploy = 0;
  for (const d of w.deploys.values()) if (d.started >= h0) fDeploy++;
  return {
    at: now,
    sources: { perHour: seen.size, push, pr, cron, other, arrivals: arrivals.slice(0, 12) },
    intake,
    engines: { machines, running, slots },
    tests: { total, failed, passRate: total ? (total - failed) / total : 1, fails: fails.slice(0, 40) },
    mains: { total: mainsTotal, red, green: mainsTotal - red.length, rows },
    deploy: { running: dRunning, today, failed: dFailed },
    apps: { total: cells.length, up, down, cells },
    flow: { intake: fIntake, engines: fEng, tests: total, mains: fMains, deploy: fDeploy },
  };
}

function redMain(r: Repo): RedMain {
  const rec = r.main.recent ?? [];
  const cul = rec.find((d) => d.sha === r.main.culprit) ?? [...rec].reverse().find((d) => d.state === 'failure' || d.state === 'error') ?? rec[rec.length - 1];
  return {
    repo: r.id, name: r.name, since: r.main.since || cul?.at || 0, sha: (cul?.sha ?? r.main.head ?? '').slice(0, 7),
    title: cul?.title ?? '', author: (cul?.author ?? '').replace(/\[bot\]$/, ''), url: r.links?.cicd ?? r.links?.github ?? '',
  };
}

function appCell(a: App): AppCell {
  const x = a as App & { status_url?: string; links?: { status?: string } };
  return { id: a.id ?? a.url, health: a.health, url: a.url, statusUrl: x.status_url ?? x.links?.status ?? '', repo: a.repo ?? '' };
}

/** The FAILED bin (ZERO.md): runs that failed inside the window (minutes), newest first; one
 *  that a later run of the same repo, branch and trigger fixed (passed after it) leaves the bin. */
export function failedIn(w: World, now: number, windowMs: number): Item[] {
  const t0 = now - windowMs;
  const lastPass = new Map<string, number>();
  for (const p of w.pipelines.values()) {
    if (p.state !== 'success' || !p.finished) continue;
    const k = `${p.repo}|${p.branch}|${p.event}`;
    if ((lastPass.get(k) ?? 0) < p.finished) lastPass.set(k, p.finished);
  }
  const out: Item[] = [];
  for (const p of w.pipelines.values()) {
    if (p.state !== 'failure' && p.state !== 'error') continue;
    if (!p.finished || p.finished < t0 || p.finished > now + 60_000) continue;
    if ((lastPass.get(`${p.repo}|${p.branch}|${p.event}`) ?? 0) > p.finished) continue;
    out.push(item(w, p, now));
  }
  return out.sort((a, b) => (b.finished ?? 0) - (a.finished ?? 0));
}

/** The tests' pass rate over the same window as the FAILED bin: of the runs that finished inside
 *  it (canceled and skipped ones aside), how many passed. */
export function passIn(w: World, now: number, windowMs: number): { total: number; failed: number; rate: number } {
  const t0 = now - windowMs;
  let total = 0, failed = 0;
  for (const p of w.pipelines.values()) {
    if (!p.finished || p.finished < t0 || p.finished > now + 60_000) continue;
    if (p.state === 'canceled' || p.state === 'skipped') continue;
    total++;
    if (p.state === 'failure' || p.state === 'error') failed++;
  }
  return { total, failed, rate: total ? (total - failed) / total : 1 };
}
