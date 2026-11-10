// Read-side views over the simulation: commit Journey (with a Dagger-like span tree),
// PrDetail, and ⌘K search. Pure and portable; results are fresh copies.

import type { Commit, Deploy, Health, Journey, Pipeline, Pr, PrDetail, PrPhase, SearchHit, SearchResults, DemoSnapshot as Snapshot, Span } from '../src/wire.ts';
import { hash32 } from './util.ts';

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;

/** What the views need; the Sim satisfies it, and so does a bare reduced state (fixtures). */
export type ViewSource = {
  state: Snapshot;
  archCommits?: Map<string, Commit>;
  archPipes?: Map<string, Pipeline>;
  archDeploys?: Map<string, Deploy>;
  appById?: Map<string, { samples: { at: number; health: Health; latency_ms?: number }[] }>;
  prs?: Map<string, PrRecord>;
  archPrs?: Map<string, PrRecord>;
};
type PrRecord = { pr: Pr; commits: string[]; pipelines: string[]; timeline: { at: number; phase: PrPhase; note?: string }[] };

const SUB: Record<string, string[]> = {
  clone: ['git.clone', 'directory.export'],
  deps: ['withMountedCache(/cache/deps)', 'withExec(install --frozen-lockfile)'],
  build: ['container.from(base-image)', 'withDirectory(/src)', 'withMountedCache(/cache/build)', 'withExec(build --release)'],
  test: ['withServiceBinding(postgres)', 'withExec(test --junit)', 'file(junit.xml).export'],
  lint: ['withExec(lint)'],
  gitleaks: ['withExec(gitleaks detect)'],
  osv: ['withExec(osv-scanner)'],
  publish: ['container.build', 'container.publish(registry)'],
  rollout: ['provision.rollout', 'healthz.wait'],
  verify: ['http.get(/api/healthz)'],
};

/** One root span per workflow, a child per step, grandchildren for the step's Dagger calls. */
export function spansOf(pid: string, p: Pipeline): Span[] {
  const out: Span[] = [];
  for (const wf of p.workflows) {
    if (wf.started === undefined) continue;
    const root = `${pid}/${wf.name}`;
    out.push({ id: root, name: wf.name, start: wf.started, ...(wf.finished !== undefined ? { end: wf.finished } : {}), state: wf.state, pipeline: pid });
    for (const st of wf.steps) {
      if (st.started === undefined) continue;
      const sid = `${root}/${st.name}`;
      out.push({ id: sid, parent: root, name: st.name, start: st.started, ...(st.finished !== undefined ? { end: st.finished } : {}), state: st.state, pipeline: pid, ...(st.cached ? { cached: true } : {}) });
      const subs = SUB[st.name] ?? [];
      if (!subs.length) continue;
      const h = hash32(sid);
      if (st.finished === undefined) {
        out.push({ id: `${sid}/0`, parent: sid, name: subs[0]!, start: st.started, state: 'running', pipeline: pid, ...(st.cached ? { cached: true } : {}) });
        continue;
      }
      const weights = subs.map((_, i) => 1 + ((h >>> (i * 3)) & 7));
      const total = weights.reduce((a, b) => a + b, 0);
      let t = st.started;
      subs.forEach((name, i) => {
        const end = i === subs.length - 1 ? st.finished! : t + Math.round(((st.finished! - st.started!) * weights[i]!) / total);
        const cached = st.cached || (i < subs.length - 1 && ((h >>> (i + 20)) & 3) === 0);
        out.push({ id: `${sid}/${i}`, parent: sid, name, start: t, end, state: i === subs.length - 1 ? st.state : 'success', pipeline: pid, ...(cached ? { cached: true } : {}) });
        t = end;
      });
    }
  }
  return out;
}

function findCommit(s: ViewSource, repo: string, sha: string): [string, Commit] | null {
  const id = `${repo}@${sha}`;
  const c = s.state.commits[id] ?? s.archCommits?.get(id);
  if (c) return [id, c];
  if (sha.length < 4) return null;
  const pre = `${repo}@${sha.toLowerCase()}`;
  for (const k in s.state.commits) if (k.startsWith(pre)) return [k, s.state.commits[k]!];
  for (const [k, v] of s.archCommits ?? []) if (k.startsWith(pre)) return [k, v];
  return null;
}

export function journeyOf(s: ViewSource, repo: string, sha: string): Journey | null {
  const found = findCommit(s, repo, sha);
  if (!found) return null;
  const [, c] = found;
  const pipelines: Pipeline[] = [];
  const spans: Span[] = [];
  for (const pid of c.pipelines) {
    const p = s.state.pipelines[pid] ?? s.archPipes?.get(pid);
    if (!p) continue;
    pipelines.push(p);
    spans.push(...spansOf(pid, p));
  }
  const deploys: Deploy[] = [];
  const d = c.deploy ? s.state.deploys[c.deploy.id] ?? s.archDeploys?.get(c.deploy.id) : undefined;
  if (d) deploys.push(d);
  const appId = s.state.repos[c.repo]?.app;
  const app = appId ? s.state.apps[appId] : undefined;
  const ax = appId ? s.appById?.get(appId) : undefined;
  const health_after = d?.finished !== undefined && ax ? ax.samples.filter((x) => x.at >= d.finished! && x.at <= d.finished! + 30 * 60000) : [];
  return clone({ commit: c, pipelines, spans, deploys, ...(app ? { app } : {}), health_after });
}

export function prDetailOf(s: ViewSource, repo: string, number: number): PrDetail | null {
  const id = `${repo}#${number}`;
  let prX = s.prs?.get(id) ?? s.archPrs?.get(id);
  if (!prX) {
    // bare state (fixtures): rebuild from the snapshot's commits that carry this PR number
    const pr = s.state.prs[id];
    if (!pr) return null;
    const commits = Object.entries(s.state.commits).filter(([, c]) => c.repo === repo && c.pr === number).map(([k]) => k);
    const pipelines = commits.flatMap((k) => s.state.commits[k]!.pipelines);
    prX = { pr, commits, pipelines, timeline: [{ at: pr.created, phase: pr.draft ? 'draft' : 'checks' }, ...(pr.updated > pr.created ? [{ at: pr.updated, phase: pr.phase }] : [])] };
  }
  const commits = prX.commits.map((k) => s.state.commits[k] ?? s.archCommits?.get(k)).filter((c): c is Commit => !!c);
  const pipelines = prX.pipelines.map((k) => s.state.pipelines[k] ?? s.archPipes?.get(k)).filter((p): p is Pipeline => !!p);
  return clone({ pr: prX.pr, commits, pipelines, timeline: prX.timeline });
}

const KIND_ORDER = { repo: 0, app: 1, pr: 2, pipeline: 3, commit: 4 } as const;

function textScore(text: string, q: string): number {
  const t = text.toLowerCase();
  if (t === q) return 100;
  if (t.startsWith(q)) return 80;
  const i = t.indexOf(q);
  if (i < 0) return 0;
  const before = t[i - 1]!;
  return before === '/' || before === ' ' || before === '-' || before === '_' || before === '(' || before === '#' ? 60 : 40;
}

/** Case-insensitive substring/prefix search; exact and prefix matches rank first; ≤ 30 hits. */
export function searchFleet(s: ViewSource, query: string): SearchResults {
  const q = query.trim().toLowerCase();
  if (!q) return { q: query, results: [] };
  const hits: (SearchHit & { tie: number })[] = [];
  const num = /^#?(\d+)$/.exec(q)?.[1];
  const n = num === undefined ? -1 : Number(num);
  const hex = /^[0-9a-f]{4,40}$/.test(q);
  for (const r of Object.values(s.state.repos)) {
    const sc = Math.max(textScore(r.id, q), textScore(r.name, q));
    if (sc) hits.push({ kind: 'repo', id: r.id, title: r.id, subtitle: `${r.lane} · main ${r.main.state}${r.app ? ` · app ${r.app}` : ''}`, score: sc + 5, tie: r.heat });
  }
  for (const [slug, a] of Object.entries(s.state.apps)) {
    const sc = textScore(slug, q);
    if (sc) hits.push({ kind: 'app', id: slug, title: slug, subtitle: `${a.health} · ${a.url}`, score: sc + 4, tie: 0 });
  }
  for (const [id, pr] of Object.entries(s.state.prs)) {
    const sc = Math.max(pr.number === n ? 90 : 0, textScore(pr.title, q), textScore(id, q) ? textScore(id, q) - 5 : 0);
    if (sc) hits.push({ kind: 'pr', id, title: `#${pr.number} ${pr.title}`, subtitle: `${pr.repo} · ${pr.phase} · ${pr.author}`, score: sc, tie: pr.updated });
  }
  for (const [id, p] of Object.entries(s.state.pipelines)) {
    const sc = Math.max(p.number === n ? 70 : 0, textScore(id, q));
    if (sc) hits.push({ kind: 'pipeline', id, title: `${p.repo} #${p.number}`, subtitle: `${p.lane} · ${p.state} · ${p.sha.slice(0, 7)}`, score: sc, tie: p.created });
  }
  for (const [id, c] of Object.entries(s.state.commits)) {
    let sc = hex && c.sha.startsWith(q) ? (c.sha === q ? 100 : 90) : 0;
    sc = Math.max(sc, Math.round(textScore(c.title, q) * 0.75));
    if (sc) hits.push({ kind: 'commit', id, title: c.title, subtitle: `${c.repo} · ${c.sha.slice(0, 7)} · ${c.author}`, score: sc, tie: c.at });
  }
  hits.sort((a, b) => b.score - a.score || KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || b.tie - a.tie || (a.id < b.id ? -1 : 1));
  return { q: query, results: hits.slice(0, 30).map(({ tie: _t, ...h }) => h) };
}
