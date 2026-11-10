// Projections: what each Contract view reads, computed from the shown world. Every answer is
// small and flat (rows of strings and numbers) so Contract diffs it cheaply.

import type { CiState, Journey, Pr, PrDetail, PrPhase, Repo, SearchHit } from './wire.ts';
import type { World } from './world.ts';
import { isRed, orgLabel } from './yard/layout.ts';
import { fmtDur } from './yard/paint.ts';

export const PHASES: PrPhase[] = ['draft', 'checks', 'review', 'mergeable', 'merged', 'deployed'];

export function ago(now: number, at: number | undefined): string {
  if (!at) return '';
  const d = now - at;
  if (d < 45_000) return 'just now';
  return `${fmtDur(d)} ago`;
}

export function short(sha: string): string {
  return (sha ?? '').slice(0, 7);
}

function mainState(r: Repo): string {
  if (isRed(r)) return 'red';
  const s = r.main?.state;
  if (s === 'running' || s === 'pending') return 'building';
  if (s === 'success') return 'green';
  return 'quiet';
}

export function mainlines(w: World, now: number, org: string, filter: string, q: string) {
  const ql = q.trim().toLowerCase();
  const rows = [];
  for (const r of w.repos.values()) {
    if (org && r.org !== org) continue;
    const st = mainState(r);
    if (filter === 'red' && st !== 'red') continue;
    if (filter === 'building' && st !== 'building') continue;
    if (ql && !r.id.toLowerCase().includes(ql)) continue;
    let stateText = st === 'red' ? `red ${fmtDur(now - (r.main?.since ?? now))}` : st === 'building' ? 'building' : st === 'green' ? 'green' : 'no runs';
    if (st === 'red' && r.main.culprit) {
      const c = r.main.recent.find((d) => d.sha === r.main.culprit);
      stateText += ` · culprit ${short(r.main.culprit)}${c ? ` by ${c.author}` : ''}`;
    } else if (st === 'green') {
      const fixed = lastFix(r);
      if (fixed) stateText += ` · fixed by ${short(fixed)}`;
    }
    rows.push({
      id: r.id, name: r.name, org: r.org, orgLabel: orgLabel(r.org), lane: laneText(r.lane), state: st, stateText,
      heat: r.heat ?? 0, prs: r.open_prs ?? 0, app: r.app ?? '', last: ago(now, r.main?.recent?.at(-1)?.at),
      ver: (r.main?.recent?.length ?? 0) * 1000 + hashState(r.main?.recent?.at(-1)?.state) + (r.main?.recent?.at(-1)?.at ?? 0) % 997,
    });
  }
  const order: Record<string, number> = { red: 0, building: 1, green: 2, quiet: 3 };
  rows.sort((a, b) => order[a.state] - order[b.state] || b.heat - a.heat || a.id.localeCompare(b.id));
  const red = rows.filter((r) => r.state === 'red').length;
  return { total: rows.length, red, rows: rows.slice(0, 600) };
}

function lastFix(r: Repo): string {
  const d = r.main?.recent ?? [];
  for (let i = d.length - 1; i > 0; i--) if (d[i].state === 'success' && (d[i - 1].state === 'failure' || d[i - 1].state === 'error')) return i >= d.length - 3 ? d[i].sha : '';
  return '';
}

function hashState(s: CiState | undefined): number {
  return s ? s.charCodeAt(0) + s.length : 0;
}

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

export function phaseIndex(p: PrPhase): number {
  if (p === 'changes_requested') return 2;
  if (p === 'conflict') return 3;
  if (p === 'closed') return -1;
  return PHASES.indexOf(p);
}

export function phaseText(p: Pr): string {
  switch (p.phase) {
    case 'changes_requested': return 'changes requested';
    case 'conflict': return 'conflict with base';
    case 'mergeable': return 'ready to merge';
    default: return p.phase;
  }
}

export function prRow(pr: Pr, now: number, w: World) {
  const req = pr.checks ?? [];
  const ok = req.filter((c) => c.state === 'success').length;
  const failed = req.filter((c) => c.state === 'failure' || c.state === 'error').length;
  const running = req.filter((c) => c.state === 'running' || c.state === 'pending').length;
  const stale = pr.stale_ms ?? 0;
  return {
    id: `${pr.repo}#${pr.number}`, repo: pr.repo, name: pr.repo.split('/')[1] ?? pr.repo, number: pr.number, title: pr.title,
    author: pr.author.replace(/\[bot\]$/, ''), bot: !!pr.bot || pr.author.endsWith('[bot]'), phase: pr.phase, phaseIdx: phaseIndex(pr.phase),
    phaseText: phaseText(pr), checksOk: ok, checksTotal: req.length, checksFailed: failed, checksRunning: running,
    checks: req.slice(0, 12).map((c) => c.state as string),
    ai: pr.review?.ai ?? '', human: pr.review?.human ?? '', stale: stale > 86_400_000 ? `stale ${fmtDur(stale)}` : '', staleOld: stale > 3 * 86_400_000,
    blockedBy: pr.blocked_by ?? '', updated: ago(now, pr.updated), url: pr.url, org: w.orgOf(pr.repo),
    bad: pr.phase === 'conflict' || pr.phase === 'changes_requested' || failed > 0,
  };
}

export function prs(w: World, now: number, org: string, filter: string, q: string) {
  const ql = q.trim().toLowerCase();
  const rows = [];
  let open = 0, ready = 0, blocked = 0, bots = 0;
  for (const pr of w.prs.values()) {
    if (org && w.orgOf(pr.repo) !== org) continue;
    const isOpen = pr.phase !== 'merged' && pr.phase !== 'closed' && pr.phase !== 'deployed';
    if (isOpen) open++;
    if (pr.phase === 'mergeable') ready++;
    if (pr.phase === 'conflict' || pr.phase === 'changes_requested' || pr.blocked_by) blocked++;
    const bot = !!pr.bot || pr.author.endsWith('[bot]');
    if (bot && isOpen) bots++;
    if (filter === 'open' && !isOpen) continue;
    if (filter === 'ready' && pr.phase !== 'mergeable') continue;
    if (filter === 'blocked' && !(pr.phase === 'conflict' || pr.phase === 'changes_requested' || pr.blocked_by)) continue;
    if (filter === 'bots' && !bot) continue;
    if (filter === 'shipped' && isOpen) continue;
    if (ql && !(`${pr.repo}#${pr.number} ${pr.title} ${pr.author}`.toLowerCase().includes(ql))) continue;
    rows.push(prRow(pr, now, w));
  }
  rows.sort((a, b) => Number(b.bad) - Number(a.bad) || (w.prs.get(b.id)?.updated ?? 0) - (w.prs.get(a.id)?.updated ?? 0));
  return { open, ready, blocked, bots, total: rows.length, rows: rows.slice(0, 400) };
}

export function fleet(w: World, now: number) {
  const apps = Array.from(w.apps.entries()).map(([id, a]) => ({
    id, url: a.url, health: a.health, latency: a.latency_ms != null ? `${Math.round(a.latency_ms)} ms` : '–',
    live: short(a.live_sha ?? ''), main: short(a.main_sha ?? ''), behind: a.behind ?? 0,
    behindText: (a.behind ?? 0) > 0 ? `${a.behind} behind main` : a.live_sha ? 'at main' : 'never deployed',
    lastDeploy: a.last_deploy ? deployText(w, a.last_deploy.id, now) : '', runtime: a.runtime ?? '', team: a.team ?? '', repo: a.repo ?? '',
    lane: laneText(w.repos.get(a.repo ?? '')?.lane ?? 'none'), checked: ago(now, a.checked),
  }));
  const hOrder: Record<string, number> = { down: 0, degraded: 1, unknown: 2, up: 3 };
  apps.sort((a, b) => hOrder[a.health] - hOrder[b.health] || b.behind - a.behind || a.id.localeCompare(b.id));
  const engines = Array.from(w.engines.values()).sort((a, b) => a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id)).map((e) => ({
    id: e.id, kind: e.kind === 'dagger' ? 'dagger engine' : e.kind === 'wp_agent' ? 'woodpecker agent' : 'gha runner',
    slots: e.slots, busy: e.running.length, cpu: e.cpu != null ? `${Math.round(e.cpu <= 1 ? e.cpu * 100 : e.cpu)}%` : '–',
    mem: e.mem != null ? `${Math.round(e.mem <= 1 ? e.mem * 100 : e.mem)}%` : '–',
    running: e.running.map((id) => { const p = w.pipelines.get(id); return p ? `${p.repo.split('/')[1]} #${p.number}` : id; }).slice(0, 8).join(', '),
  }));
  const queues = Array.from(w.queues.values()).map((q) => ({ id: q.id, pending: q.pending, running: q.running, oldest: q.pending ? fmtDur(q.oldest_wait_ms) : '–' }));
  const s = w.stats;
  const pct = (v: number) => `${Math.round(v <= 1 ? v * 100 : v)}%`;
  const stats = [
    { label: 'commits · 24 h', value: fmtNum(s.commits_24h) },
    { label: 'pipelines · 24 h', value: fmtNum(s.pipelines_24h) },
    { label: 'green · 24 h', value: pct(s.success_rate_24h) },
    { label: 'median wait', value: fmtDur(s.p50_queue_ms) },
    { label: 'median build', value: fmtDur(s.p50_build_ms) },
    { label: 'deploys · 24 h', value: fmtNum(s.deploys_24h) },
  ];
  const up = apps.filter((a) => a.health === 'up').length;
  return {
    apps, engines, queues, stats, up, total: apps.length, down: apps.filter((a) => a.health === 'down').length,
    degraded: apps.filter((a) => a.health === 'degraded').length,
    watcher: w.watcher.tripped ? `outage watcher tripped ${ago(now, w.watcher.since)} · github ${w.watcher.gh_status}${w.watcher.note ? ` · ${w.watcher.note}` : ''}` : `outage watcher calm · github ${w.watcher.gh_status}`,
    watcherTripped: !!w.watcher.tripped,
  };
}

function deployText(w: World, id: string, now: number): string {
  const d = w.deploys.get(id);
  if (!d) return '';
  const via = d.via === 'gha_fallback' ? 'gha fallback' : d.via;
  return `${d.state === 'success' ? 'deployed' : d.state} ${ago(now, d.finished ?? d.started)} via ${via}`;
}

function fmtNum(n: number): string {
  return n >= 10_000 ? `${(n / 1000).toFixed(1)}k` : n.toLocaleString('en-US');
}

/** The commit journey as rows on one time axis. */
export function journeyView(j: Journey | null, now: number, error = '') {
  if (!j) return { ok: false, error: error || 'No such commit in the last day.', repo: '', sha: '', short: '', title: '', author: '', branch: '', stage: '', pushed: '', total: '', spans: [], pipelines: [], deploys: [], deployVia: '', app: '', health: '', healthText: '', url: '' };
  const c = j.commit;
  const t0 = c.at;
  let t1 = t0 + 1000;
  for (const s of j.spans ?? []) t1 = Math.max(t1, s.end ?? now);
  for (const d of j.deploys ?? []) t1 = Math.max(t1, d.finished ?? now);
  const span = Math.max(1000, t1 - t0);
  const depth = new Map<string, number>();
  const spans = (j.spans ?? []).slice().sort((a, b) => a.start - b.start).map((s) => {
    const d = s.parent ? (depth.get(s.parent) ?? 0) + 1 : 0;
    depth.set(s.id, d);
    const end = s.end ?? now;
    return {
      id: s.id, name: s.name, depth: d, start: Math.max(0, (s.start - t0) / span), width: Math.max(0.004, (end - s.start) / span),
      state: s.state, dur: fmtDur(end - s.start), cached: !!s.cached,
    };
  });
  const app = j.app;
  const after = j.health_after ?? [];
  return {
    ok: true, error: '', repo: c.repo, sha: c.sha, short: short(c.sha), title: c.title, author: c.author, branch: c.branch, stage: c.stage,
    pushed: ago(now, c.at), total: fmtDur(span), spans: spans.slice(0, 120),
    pipelines: (j.pipelines ?? []).map((p) => ({ id: `${p.lane === 'gha' ? 'gha' : 'wp'}:${p.repo}:${p.number}`, number: p.number, lane: p.lane, state: p.state, dur: fmtDur((p.finished ?? now) - (p.started ?? p.created)), wait: fmtDur((p.started ?? now) - p.created), url: p.url, engine: (p.engine ?? '').toLowerCase() })),
    deploys: (j.deploys ?? []).map((d) => ({ app: d.app, via: d.via === 'gha_fallback' ? 'gha fallback' : d.via, state: d.state, dur: fmtDur((d.finished ?? now) - d.started), start: Math.max(0, (d.started - t0) / span), width: Math.max(0.004, ((d.finished ?? now) - d.started) / span) })),
    deployVia: j.deploys?.[0] ? (j.deploys[0].via === 'gha_fallback' ? 'gha fallback' : j.deploys[0].via) : 'none',
    app: app ? app.url.replace(/^https?:\/\//, '') : '', health: app?.health ?? '',
    healthText: app ? `${app.health}${after.length ? ` · ${after.length} checks since deploy` : ''}${app.latency_ms != null ? ` · ${Math.round(app.latency_ms)} ms` : ''}` : '',
    url: `https://github.com/${c.repo}/commit/${c.sha}`,
  };
}

export function prDetailView(d: PrDetail | null, now: number, w: World) {
  if (!d) return { ok: false, row: null, commits: [], pipelines: [], timeline: [] };
  return {
    ok: true,
    row: prRow(d.pr, now, w),
    commits: (d.commits ?? []).slice(-20).reverse().map((c) => ({ sha: c.sha, short: short(c.sha), title: c.title, author: c.author, ci: c.ci, ago: ago(now, c.at), repo: c.repo })),
    pipelines: (d.pipelines ?? []).slice(-12).reverse().map((p) => ({ number: p.number, lane: p.lane, state: p.state, dur: fmtDur((p.finished ?? now) - (p.started ?? p.created)), sha: short(p.sha), ago: ago(now, p.created) })),
    timeline: (d.timeline ?? []).map((t) => ({ phase: t.phase, note: t.note ?? '', ago: ago(now, t.at) })),
  };
}

/** ⌘K: instant matches from the shown world. */
export function search(w: World, q: string, now: number): SearchHit[] {
  const ql = q.trim().toLowerCase();
  if (!ql) {
    // Nothing typed: what is on fire, then the hottest repos.
    const out: SearchHit[] = [];
    for (const r of w.repos.values()) if (isRed(r)) out.push({ kind: 'repo', id: r.id, title: r.id, subtitle: `red ${fmtDur(now - r.main.since)}`, score: 100 });
    for (const a of w.apps.values()) if (a.health === 'down') out.push({ kind: 'app', id: appId(w, a.url), title: appId(w, a.url), subtitle: 'down', score: 90 });
    const hot = Array.from(w.repos.values()).sort((a, b) => (b.heat ?? 0) - (a.heat ?? 0)).slice(0, 8);
    for (const r of hot) if (!out.some((o) => o.id === r.id)) out.push({ kind: 'repo', id: r.id, title: r.id, subtitle: `${r.open_prs ?? 0} open PRs · ${laneText(r.lane)}`, score: 50 });
    return out.slice(0, 12);
  }
  const hits: SearchHit[] = [];
  const score = (s: string) => { const l = s.toLowerCase(); return l === ql ? 100 : l.startsWith(ql) ? 80 : l.includes(`/${ql}`) ? 70 : l.includes(ql) ? 40 : 0; };
  for (const r of w.repos.values()) { const s = Math.max(score(r.name), score(r.id)); if (s) hits.push({ kind: 'repo', id: r.id, title: r.id, subtitle: `main ${mainState(r)} · ${r.open_prs ?? 0} open PRs`, score: s + 5 }); }
  for (const [id, a] of w.apps) { const s = score(id); if (s) hits.push({ kind: 'app', id, title: id, subtitle: `${a.health} · ${a.url.replace(/^https?:\/\//, '')}`, score: s + 3 }); }
  const num = ql.replace(/^#/, '');
  for (const pr of w.prs.values()) {
    const s = String(pr.number) === num ? 90 : score(pr.title) ? score(pr.title) - 10 : 0;
    if (s > 0) hits.push({ kind: 'pr', id: `${pr.repo}#${pr.number}`, title: `${pr.repo.split('/')[1]} #${pr.number} ${pr.title}`, subtitle: `${phaseText(pr)} · ${pr.author}`, score: s });
  }
  if (ql.length >= 4 && /^[0-9a-f]+$/.test(ql)) {
    for (const c of w.commits.values()) if (c.sha.startsWith(ql)) hits.push({ kind: 'commit', id: `${c.repo}@${c.sha}`, title: `${short(c.sha)} ${c.title}`, subtitle: `${c.repo} · ${c.author} · ${ago(now, c.at)}`, score: 95 });
  } else if (ql.length >= 3) {
    let n = 0;
    for (const c of w.commits.values()) {
      if (n > 40) break;
      if (c.title.toLowerCase().includes(ql)) { hits.push({ kind: 'commit', id: `${c.repo}@${c.sha}`, title: `${short(c.sha)} ${c.title}`, subtitle: `${c.repo} · ${c.author} · ${ago(now, c.at)}`, score: 20 }); n++; }
    }
  }
  for (const p of w.pipelines.values()) if (`#${p.number}` === ql || String(p.number) === num) hits.push({ kind: 'pipeline', id: p.id ?? "", title: `${p.repo.split('/')[1]} #${p.number}`, subtitle: `${p.state} · ${p.lane}`, score: 60 });
  hits.sort((a, b) => b.score - a.score || a.title.localeCompare(b.title));
  return hits.slice(0, 30);
}

function appId(w: World, url: string): string {
  for (const [id, a] of w.apps) if (a.url === url) return id;
  return url;
}
