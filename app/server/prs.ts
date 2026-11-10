// Pull-request lifecycle and bot waves: draft → checks → review → mergeable → merged →
// deployed (plus changes_requested / conflict / closed). Pure and portable; operates on Sim.

import type { CiState, Pr, PrPhase } from '../src/wire.ts';
import * as N from './names.ts';
import type { PipeX, PrX, RepoX, Sim } from './sim.ts';
import { MIN, SEC, TICK } from './util.ts';

export const ACTIVE: PrPhase[] = ['draft', 'checks', 'review', 'changes_requested', 'mergeable', 'conflict'];

export function checksFor(s: Sim, rx: RepoX): Pr['checks'] {
  return [
    { name: s.laneFor(rx) === 'gha' ? 'ci / build-test' : 'woodpecker/ci', state: 'pending' },
    ...(rx.sec ? [{ name: 'woodpecker/security', state: 'pending' as CiState }] : []),
    { name: 'pr-title', state: 'success' },
  ];
}

export function createPr(s: Sim, rx: RepoX, author: string, phase: PrPhase, at = s.now): PrX {
  const number = ++rx.prNum;
  const repo = rx.r.id;
  const id = `${repo}#${number}`;
  const bot = author.endsWith('[bot]');
  const pr: Pr = {
    repo, number, title: N.prTitle(author, s.rng), author, ...(bot ? { bot } : {}), draft: phase === 'draft',
    created: at, updated: at, head_sha: '', base: rx.r.default_branch, phase, checks: checksFor(s, rx),
    review: { ai: bot ? 'skipped' : 'pending' }, url: `https://github.com/${repo}/pull/${number}`,
  };
  const prX: PrX = { id, pr, rx, commits: [], pipelines: [], timeline: [{ at, phase }], gen: 0, lastCi: 'pending', branch: N.branchName(author, s.rng) };
  s.state.prs[id] = pr;
  s.prs.set(id, prX);
  s.mark('pr', id);
  if (ACTIVE.includes(phase)) {
    rx.prs.push(prX);
    rx.r.open_prs++;
    s.openPrs++;
    s.mark('repo', repo);
  }
  return prX;
}

export function newPr(s: Sim, rx: RepoX, author: string): void {
  const draft = !author.endsWith('[bot]') && s.rng.chance(0.15);
  const prX = createPr(s, rx, author, draft ? 'draft' : 'checks');
  s.ev({ k: 'pr', repo: rx.r.id, number: prX.pr.number, phase: prX.pr.phase, at: s.now });
  prCommit(s, prX, prX.pr.title);
  if (draft) scheduleReady(s, prX);
}

export function prCommit(s: Sim, prX: PrX, title: string): void {
  const prev = s.state.commits[`${prX.rx.r.id}@${prX.pr.head_sha}`];
  if (prev && prev.stage === 'gating') { prev.stage = 'done'; s.mark('commit', `${prX.rx.r.id}@${prX.pr.head_sha}`); }
  const cid = s.push(prX.rx, prX.branch, prX.pr.author, title, prX);
  prX.commits.push(cid);
  prX.pr.head_sha = s.state.commits[cid]!.sha;
  for (const ch of prX.pr.checks) if (ch.name !== 'pr-title') ch.state = 'pending';
  prX.lastCi = 'pending';
  touch(s, prX);
}

export function prPush(s: Sim, prX: PrX): void {
  const pr = prX.pr;
  if (!ACTIVE.includes(pr.phase)) return;
  prX.gen++;
  const title = pr.bot ? 'chore: rebase onto main' : s.rng.pick(['address review comments', 'fix tests', 'wip', 'rebase on main', N.commitTitle(pr.author, s.rng)]);
  prCommit(s, prX, title);
  delete pr.blocked_by;
  if (pr.phase === 'draft') scheduleReady(s, prX);
  else prPhase(s, prX, 'checks');
}

export function touch(s: Sim, prX: PrX): void {
  prX.pr.updated = s.now;
  delete prX.pr.stale_ms;
  s.mark('pr', prX.id);
}

export function prPhase(s: Sim, prX: PrX, phase: PrPhase, note?: string): void {
  const pr = prX.pr;
  if (pr.phase === phase) return;
  const wasActive = ACTIVE.includes(pr.phase);
  pr.phase = phase;
  touch(s, prX);
  prX.timeline.push(note ? { at: s.now, phase, note } : { at: s.now, phase });
  s.ev({ k: 'pr', repo: pr.repo, number: pr.number, phase, at: s.now });
  if (wasActive && !ACTIVE.includes(phase)) {
    const rx = prX.rx;
    rx.prs = rx.prs.filter((p) => p !== prX);
    rx.r.open_prs = Math.max(0, rx.r.open_prs - 1);
    s.openPrs--;
    s.mark('repo', rx.r.id);
  }
}

/** Schedules `fn` for this PR; any later push/phase action supersedes it. */
export function later(s: Sim, prX: PrX, delayMs: number, fn: () => void): void {
  const g = ++prX.gen;
  s.agenda.add(s.now + Math.max(TICK, Math.round(delayMs / TICK) * TICK), () => { if (prX.gen === g) fn(); });
}

export function scheduleReady(s: Sim, prX: PrX): void {
  later(s, prX, s.rng.range(10, 120) * MIN, () => {
    const pr = prX.pr;
    if (pr.phase !== 'draft') return;
    pr.draft = false;
    if (prX.lastCi === 'success') toReview(s, prX);
    else {
      prPhase(s, prX, 'checks', 'ready for review');
      if (prX.lastCi === 'failure' || prX.lastCi === 'error') later(s, prX, s.rng.range(5, 60) * MIN, () => prPush(s, prX));
    }
  });
}

export function prOnPipeline(s: Sim, prX: PrX, px: PipeX): void {
  const pr = prX.pr;
  if (px.p.sha !== pr.head_sha) return;
  const wfs = px.p.workflows;
  pr.checks[0]!.state = px.p.state === 'canceled' ? 'canceled' : wfs[0]!.state;
  if (prX.rx.sec && wfs[1] && pr.checks[1]) pr.checks[1].state = wfs[1].state;
  prX.lastCi = px.p.state;
  touch(s, prX);
  if (pr.phase !== 'checks') return;
  const st = px.p.state;
  if (st === 'success') toReview(s, prX);
  else if (st === 'canceled') later(s, prX, s.rng.range(1, 10) * MIN, () => prPush(s, prX));
  else if (pr.author === 'renovate[bot]' && s.rng.chance(0.5)) later(s, prX, s.rng.range(30, 120) * MIN, () => prPhase(s, prX, 'closed', 'superseded'));
  else later(s, prX, s.rng.range(5, 60) * MIN, () => prPush(s, prX));
}

export function toReview(s: Sim, prX: PrX): void {
  const pr = prX.pr;
  prPhase(s, prX, 'review');
  if (pr.author === 'renovate[bot]' || pr.author === 'autofix[bot]') {
    later(s, prX, s.rng.range(2, 15) * MIN, () => toMergeable(s, prX));
    return;
  }
  later(s, prX, s.rng.range(5, 180) * MIN, () => reviewResult(s, prX));
  const g = prX.gen;
  s.agenda.add(s.now + s.rng.int(60, 300) * SEC, () => {
    if (prX.gen !== g || pr.phase !== 'review') return;
    const r = s.rng();
    pr.review.ai = r < 0.4 ? 'commented' : r < 0.9 ? 'approved' : 'skipped';
    touch(s, prX);
  });
}

export function reviewResult(s: Sim, prX: PrX): void {
  const pr = prX.pr;
  if (pr.phase !== 'review') return;
  let who = s.rng.pick(N.HUMANS);
  if (who === pr.author) who = N.HUMANS[(N.HUMANS.indexOf(who) + 1) % N.HUMANS.length]!;
  pr.review.human = who;
  if (s.rng.chance(0.22)) {
    prPhase(s, prX, 'changes_requested', `${who} requested changes`);
    later(s, prX, s.rng.range(10, 90) * MIN, () => prPush(s, prX));
  } else toMergeable(s, prX);
}

export function toMergeable(s: Sim, prX: PrX): void {
  const blocked = s.rng.chance(0.15);
  if (blocked) prX.pr.blocked_by = s.rng.pick(N.BLOCKERS);
  prPhase(s, prX, 'mergeable');
  later(s, prX, s.rng.range(blocked ? 20 : 2, blocked ? 120 : 60) * MIN, () => {
    if (prX.pr.phase !== 'mergeable') return;
    delete prX.pr.blocked_by;
    const r = s.rng();
    if (r < 0.08) {
      prPhase(s, prX, 'conflict', 'merge conflict with main');
      later(s, prX, s.rng.range(10, 60) * MIN, () => prPush(s, prX));
    } else if (r < 0.11) prPhase(s, prX, 'closed');
    else prMerge(s, prX);
  });
}

export function prMerge(s: Sim, prX: PrX): void {
  const pr = prX.pr;
  const rx = prX.rx;
  const sha = s.rng.hex(40);
  prX.gen++;
  prPhase(s, prX, 'merged');
  s.ev({ k: 'merge', repo: rx.r.id, number: pr.number, sha, at: s.now });
  const head = s.state.commits[`${rx.r.id}@${pr.head_sha}`];
  if (head && !['pushed', 'queued', 'building'].includes(head.stage)) { head.stage = 'merged'; s.mark('commit', `${rx.r.id}@${pr.head_sha}`); }
  const cid = s.push(rx, rx.r.default_branch, pr.author, `${pr.title} (#${pr.number})`, undefined, sha);
  s.state.commits[cid]!.pr = pr.number;
  s.mergedFrom.set(cid, prX);
  if (s.mergedFrom.size > 5000) s.mergedFrom.delete(s.mergedFrom.keys().next().value!);
  prX.commits.push(cid);
}

export function autofixMerge(s: Sim, rx: RepoX): void {
  const prX = createPr(s, rx, 'autofix[bot]', 'mergeable');
  prX.pr.head_sha = s.rng.hex(40);
  for (const ch of prX.pr.checks) ch.state = 'success';
  prMerge(s, prX);
}

export function renovatePush(s: Sim, rx: RepoX): void {
  const open = rx.prs.find((p) => p.pr.author === 'renovate[bot]');
  if (open) prPush(s, open);
  else newPr(s, rx, 'renovate[bot]');
}

export function wave(s: Sim): void {
  s.nextWave = s.now + Math.round(s.rng.range(4, 7) * 600) * TICK;
  const lm = s.rng.chance(0.5);
  const k = lm ? s.rng.int(3, 8) : s.rng.int(5, 15);
  for (let i = 0; i < k; i++) {
    const rx = lm && s.rng.chance(0.6) ? s.repos[s.rng.weighted(s.cum)]! : s.rng.pick(s.repos);
    if (rx.r.lane === 'none') continue;
    s.agenda.add(s.now + s.rng.int(0, lm ? 200 : 300) * TICK, () => (lm ? autofixMerge(s, rx) : renovatePush(s, rx)));
  }
}
