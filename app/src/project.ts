// ⌘K projections for the Live view: instant matches from the shown world.

import type { Repo, Pr, SearchHit } from './wire.ts';
import type { World } from './world.ts';
import { isRed } from './yard/layout.ts';
import { fmtDur } from './yard/paint.ts';

const str = (v: unknown): string => (v == null ? '' : String(v));
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

function ago(now: number, at: number | undefined | null): string {
  if (typeof at !== 'number' || !Number.isFinite(at) || at <= 0) return '';
  const d = now - at;
  if (d < 45_000) return 'just now';
  return `${fmtDur(d)} ago`;
}

function short(sha: string | undefined | null): string {
  return String(sha ?? '').slice(0, 7);
}

/** A repo's main line in one word. Unknown or missing states read as quiet, never a throw. */
function mainState(r: Repo | undefined | null): 'red' | 'building' | 'green' | 'quiet' {
  if (isRed(r ?? undefined)) return 'red';
  const s = r?.main?.state;
  if (s === 'running' || s === 'pending') return 'building';
  if (s === 'success') return 'green';
  return 'quiet';
}

function laneText(l: string): string {
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

function phaseText(p: Pr): string {
  switch (p?.phase) {
    case 'changes_requested': return 'changes requested';
    case 'conflict': return 'conflict with base';
    case 'mergeable': return 'ready to merge';
    default: return String(p?.phase ?? 'unknown');
  }
}

/** The palette's empty state is the things that need attention, then the hottest repos. */
export function search(w: World, q: string, now: number): SearchHit[] {
  const ql = String(q ?? '').trim().toLowerCase();
  if (!ql) {
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
