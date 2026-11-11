// fab-lens SEAMS: the few things the lens system and the coffee check read that another branch
// will own at merge. Each is one small function here, so the swap is one import:
//   beat          → src/factory/motion.ts (fab-base's shared 1 Hz beat)
//   groupOf       → src/insights.ts (contract v0.5 `Repo.group` / `groups`)
//   clusterKey    → src/insights.ts (v0.5 `Step.cluster` / `clusters`)
//   changesSince  → src/insights.ts (v0.5 `/api/v1/changes?since`)
// Until then each approximates from the world (FACTORY-SPEC §C, §E): O(entities), no fetch.

import type { App, Pipeline, Repo } from '../wire.ts';
import type { World } from '../world.ts';
import { isRed } from '../yard/select.ts';

// ---- the beat ---------------------------------------------------------------------------------
/** THE shared 1 Hz beat, 0..1 (1 on the beat): every pulse, glow and blink reads it, so they are
 *  all in phase (FACTORY-SPEC §G). `t` is the module clock (ms). */
export function beat(t: number): number { return 0.5 + 0.5 * Math.cos((2 * Math.PI * t) / 1000); }
/** Where in the current beat we are, 0..1 (0 = on the beat): rings that expand once a beat. */
export function beatPhase(t: number): number { return ((t % 1000) + 1000) % 1000 / 1000; }

// ---- groups -----------------------------------------------------------------------------------
export type GroupRef = { id: string; kind: 'team' | 'org' | 'bots'; name: string };

/** A team name, normalised (FACTORY-SPEC §C.1): lowercase, no `-team`; '' for none. */
export function teamName(t: string | undefined): string {
  const s = (t ?? '').toLowerCase().trim().replace(/-team$/, '');
  return s === 'unknown' || s === 'none' ? '' : s;
}

const groupCache = new WeakMap<World, { key: number; byRepo: Map<string, string> }>();
/** repo → team via its apps (`App.repo`, the team with the most apps wins), else `Repo.app`'s
 *  team. Cached per world on the repo/app counters. */
function repoTeams(w: World): Map<string, string> {
  const key = w.kv.app * 100003 + w.kv.repo;
  const hit = groupCache.get(w);
  if (hit && hit.key === key) return hit.byRepo;
  const votes = new Map<string, Map<string, number>>();
  const vote = (repo: string, team: string) => {
    if (!repo || !team) return;
    let m = votes.get(repo); if (!m) votes.set(repo, (m = new Map()));
    m.set(team, (m.get(team) ?? 0) + 1);
  };
  for (const a of w.apps.values()) vote(a.repo ?? '', teamName(a.team));
  for (const r of w.repos.values()) if (r.app && !votes.has(r.id)) vote(r.id, teamName(w.apps.get(r.app)?.team));
  const byRepo = new Map<string, string>();
  for (const [repo, m] of votes) { let best = '', n = 0; for (const [t, k] of m) if (k > n || (k === n && t < best)) { best = t; n = k; } byRepo.set(repo, best); }
  groupCache.set(w, { key, byRepo });
  return byRepo;
}

/** The group a repo belongs to: its team (from the apps catalog), else its org. */
export function groupOf(w: World, repo: string): GroupRef {
  const t = repoTeams(w).get(repo);
  if (t) return { id: `team:${t}`, kind: 'team', name: t };
  const org = w.orgOf(repo);
  return { id: `org:${org}`, kind: 'org', name: org };
}

/** An app's team group id (`team:<name>`), or '' when it has none. */
export function appGroup(a: App | undefined): string { const t = teamName(a?.team); return t ? `team:${t}` : ''; }

// ---- failure clusters -------------------------------------------------------------------------
/** A failure's signature (FACTORY-SPEC §E smoke): workflow + failing step, digits stripped
 *  (`test-web-1/2/3` → `test-web`); '' when the run names no failing step. */
export function clusterKey(p: Pipeline): string {
  let wfName = '', step = '';
  outer: for (const wf of p.workflows ?? []) for (const s of wf.steps ?? []) if (s.state === 'failure' || s.state === 'error') { wfName = wf.name; step = s.name; break outer; }
  if (!step) for (const wf of p.workflows ?? []) if (wf.state === 'failure' || wf.state === 'error') { wfName = wf.name; step = wf.name; break; }
  if (!step) return '';
  const norm = (s: string) => s.toLowerCase().replace(/[-_ ]?\d+$/g, '').replace(/\d+/g, '').replace(/[-_ ]+$/, '');
  return `${norm(wfName)}/${norm(step)}`;
}

/** The step part of a signature, for words. */
export function clusterStep(key: string): string { return key.slice(key.indexOf('/') + 1); }

export type Cluster = { key: string; n: number; repos: Set<string>; ids: string[]; last: number };
/** Failure clusters among the runs finished in (from, to]: by signature, biggest first. */
export function clusters(w: World, from: number, to: number): Cluster[] {
  const m = new Map<string, Cluster>();
  for (const p of w.pipelines.values()) {
    if (p.state !== 'failure' && p.state !== 'error') continue;
    const at = p.finished ?? p.created;
    if (at <= from || at > to) continue;
    const k = clusterKey(p);
    if (!k) continue;
    let c = m.get(k); if (!c) m.set(k, (c = { key: k, n: 0, repos: new Set(), ids: [], last: 0 }));
    c.n++; c.repos.add(p.repo); if (c.ids.length < 64) c.ids.push(p.id ?? ''); c.last = Math.max(c.last, at);
  }
  return [...m.values()].sort((a, b) => b.repos.size - a.repos.size || b.n - a.n);
}

// ---- changes since the last visit -------------------------------------------------------------
export type Baseline = { red: Set<string> | null; down: Set<string> | null };
export type Changes = {
  newRed: string[]; fixed: string[]; acute: string[]; failed: string[]; deployApps: string[]; deploys: number; deployFails: number;
  merged: string[]; down: string[]; recovered: string[];
};

/** What changed in (since, now]: red/green main lines against the baseline the last visit kept
 *  (or, a first look, `main.since` and the recent dots), failures, deploys, merges, app health. */
export function changesSince(w: World, since: number, now: number, base: Baseline, hash: (s: string) => string): Changes {
  const d: Changes = { newRed: [], fixed: [], acute: [], failed: [], deployApps: [], deploys: 0, deployFails: 0, merged: [], down: [], recovered: [] };
  for (const r of w.repos.values()) {
    const red = isRed(r);
    if (red && (r.main?.since ?? 0) >= now - 3_600_000) d.acute.push(r.id);
    if (base.red) {
      const was = base.red.has(hash(r.id));
      if (red && !was) d.newRed.push(r.id); else if (!red && was) d.fixed.push(r.id);
    } else if (red) { if ((r.main?.since ?? 0) >= since) d.newRed.push(r.id); }
    else if (wentRedSince(r, since)) d.fixed.push(r.id);
  }
  for (const p of w.pipelines.values()) if ((p.state === 'failure' || p.state === 'error') && p.finished && p.finished > since && p.finished <= now) d.failed.push(p.id ?? '');
  const apps = new Set<string>();
  for (const dp of w.deploys.values()) {
    if (dp.started <= since || dp.started > now) continue;
    d.deploys++;
    if (dp.state === 'failure') d.deployFails++;
    apps.add(dp.app);
  }
  d.deployApps = [...apps];
  for (const p of w.prs.values()) if (p.merged_at && p.merged_at > since && p.merged_at <= now) d.merged.push(`${p.repo}@${p.merge_sha ?? ''}`);
  for (const a of w.apps.values()) {
    const id = a.id ?? '';
    const bad = a.health === 'down' || a.health === 'degraded';
    if (base.down) {
      const was = base.down.has(hash(id));
      if (bad && !was) d.down.push(id); else if (!bad && was && a.health === 'up') d.recovered.push(id);
    } else if (bad) d.down.push(id);
  }
  return d;
}

function wentRedSince(r: Repo, since: number): boolean {
  for (const dot of r.main?.recent ?? []) if (dot.at >= since && (dot.state === 'failure' || dot.state === 'error')) return true;
  return false;
}
