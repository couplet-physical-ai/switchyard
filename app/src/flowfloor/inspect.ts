// The Factory's inspector (ZERO.md "FACTORY REDO"): one run, picked on the floor (a failed crate
// in the bin, a crate in a machine or in the intake). What it is, where it stands (failed at a
// step / running a step / waiting), its links, and the log: the decisive line and the lines
// around it for a failure, the tail for a running step. Own fetch slot (Live's log has its own).

import type { Upstream } from '../api.ts';
import type { Pipeline } from '../wire.ts';
import type { World } from '../world.ts';
import { pickRows } from '../now/log.ts';
import { commitUrl, prUrl, runUrl } from '../now/view.ts';

export type FlLink = { id: string; label: string; url: string };
export type FlRow = { id: string; n: string; text: string; hot: boolean };
export type FlDetail = {
  ok: boolean; id: string; name: string; num: string; kind: string; branch: string; title: string;
  state: string; word: string; step: string; workflow: string; meta: string; links: FlLink[];
  logStep: string; logWorkflow: string; logLive: boolean; logFail: boolean;
};
export const NO_DETAIL: FlDetail = { ok: false, id: '', name: '', num: '', kind: '', branch: '', title: '', state: '', word: '', step: '', workflow: '', meta: '', links: [], logStep: '', logWorkflow: '', logLive: false, logFail: false };
export type FlLog = { ok: boolean; rows: FlRow[]; note: string };
export const NO_LOG: FlLog = { ok: false, rows: [], note: '' };

function ago(ms: number): string {
  if (ms < 60_000) return 'just now';
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m ago`;
  return `${Math.floor(ms / 3_600_000)}h ${Math.round((ms % 3_600_000) / 60_000)}m ago`;
}
function timer(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
const kindWord = (p: Pipeline) => (p.deploy ? 'deploy' : p.event === 'pull_request' ? 'pr' : p.event);

function stepOwnUrl(p: Pipeline, wf: string, step: string): string {
  for (const w of p.workflows ?? []) if (w.name === wf) for (const s of w.steps ?? []) if (s.name === step) return (s as { url?: string }).url ?? '';
  return '';
}

export function detailOf(w: World, id: string, now: number): FlDetail {
  const p = id ? w.pipelines.get(id) : undefined;
  if (!p) return NO_DETAIL;
  const r = w.repos.get(p.repo);
  const failed = p.state === 'failure' || p.state === 'error';
  const running = p.state === 'running';
  let wfName = '', step = '';
  for (const wf of p.workflows ?? []) {
    const s = (wf.steps ?? []).find((x) => (failed ? x.state === 'failure' || x.state === 'error' : x.state === 'running'));
    if (s) { wfName = wf.name; step = s.name; break; }
  }
  if (!step && running) { const wf = p.workflows?.find((x) => x.state === 'running'); if (wf) wfName = wf.name; }
  const exp = p.expected_ms ?? r?.p50_build_ms ?? 0;
  const word = failed ? `failed at ${step || 'a step'}` : running ? `running ${step || '…'} · ${timer(now - (p.started ?? p.created))}${exp ? ` / ~${timer(exp)}` : ''}`
    : p.state === 'pending' || p.state === 'blocked' ? `waiting ${timer(now - p.created)}` : p.state === 'success' ? 'passed' : p.state;
  const when = failed || p.state === 'success' ? ago(now - (p.finished ?? now)) : '';
  const meta = [wfName, when, (p.author ?? '').replace(/\[bot\]$/, '')].filter(Boolean).join(' · ');
  const links: FlLink[] = [];
  const add = (lid: string, label: string, url: string) => { if (url) links.push({ id: lid, label, url }); };
  add('rr', p.lane === 'gha' ? 'github' : 'roadrunner', runUrl(w, id, p.url));
  if (step) add('step', failed ? 'failing step' : 'step', stepOwnUrl(p, wfName, step));
  add('commit', `commit ${p.sha.slice(0, 7)}`, commitUrl(w, p.repo, p.sha));
  if (p.pr) add('pr', `pr #${p.pr}`, prUrl(w, p.repo, p.pr));
  return {
    ok: true, id, name: r?.name ?? p.repo.split('/')[1] ?? p.repo, num: p.lane === 'gha' ? 'actions' : `#${p.number}`, kind: kindWord(p), branch: p.branch,
    title: (p.title ?? '').split('\n')[0].slice(0, 160), state: failed ? 'fail' : running ? 'run' : p.state === 'success' ? 'pass' : 'wait',
    word, step, workflow: wfName, meta, links,
    logStep: step, logWorkflow: wfName, logLive: running, logFail: failed,
  };
}

// ---- the log (GET /api/v1/pipeline/{id}/log), its own single slot ----
const TAIL = 400, BYTES = 256 << 10;
let held: { key: string; tick: number; v: FlLog; p: Promise<FlLog> | null } | null = null;

export function logOf(up: Upstream | null, id: string, step: string, workflow: string, tick: number, failed: boolean): FlLog | Promise<FlLog> {
  if (!id || !step || !up || up.kind !== 'http') { held = null; return NO_LOG; }
  const key = `${id}|${workflow}|${step}|${failed ? 'f' : ''}`;
  if (held && held.key !== key) held = null;
  if (held && (held.tick === tick || held.p)) return held.p ?? held.v;
  const u = up as unknown as { base: string; token: string };
  const headers: Record<string, string> = { accept: 'application/json' };
  if (u.token) headers.authorization = `Bearer ${u.token}`;
  const path = `/api/v1/pipeline/${encodeURIComponent(id)}/log?step=${encodeURIComponent(step)}${workflow ? `&workflow=${encodeURIComponent(workflow)}` : ''}&tail=${TAIL}${failed ? '&around=decisive' : ''}`;
  const slot = { key, tick, v: held?.v ?? { ...NO_LOG, note: 'loading the log…' }, p: null as Promise<FlLog> | null };
  held = slot;
  slot.p = fetch(u.base + path, { headers, exactTimeout: 10000, exactIndependentHttp: { maxResponseBytes: BYTES } } as RequestInit)
    .then(async (res): Promise<FlLog> => {
      if (!res.ok) return { ...NO_LOG, note: 'log unavailable' };
      const j = (await res.json()) as { lines?: unknown; decisive?: number; around?: string; after?: number; state?: string };
      const all = Array.isArray(j.lines) ? j.lines.map((l) => String(l)) : [];
      const lines = all.slice(-TAIL);
      const dec = typeof j.decisive === 'number' ? j.decisive - Math.max(0, all.length - lines.length) : -1;
      // the inspector never scrolls: the decisive line with 8 before and 12 after, or the last 22
      const lo = dec >= 0 ? Math.max(0, dec - 8) : Math.max(0, lines.length - 22);
      const hi = dec >= 0 ? Math.min(lines.length, dec + 13) : lines.length;
      const { rows } = pickRows(lines.slice(lo, hi), dec >= 0 ? dec - lo : -1, true);
      const off = lo;
      const out = rows.map((r) => ({ ...r, n: String(Number(r.n) + off), id: `${off}:${r.id}` }));
      const note = !lines.length ? (j.state === 'running' ? 'no output yet' : 'no output') : dec >= 0 ? 'the decisive line and the lines around it' : `the last ${out.length} lines`;
      return { ok: true, rows: out, note };
    }, (): FlLog => ({ ...NO_LOG, note: 'log unavailable' }))
    .then((v) => { if (held === slot) { slot.v = v; slot.p = null; } return v; });
  return slot.p;
}
