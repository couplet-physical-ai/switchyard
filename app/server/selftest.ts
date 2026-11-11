// Self-test for the Switchyard mock server. Run: timeout 120 bun server/selftest.ts
// Starts mock.ts on random ports (frozen + fixed EPOCH for determinism, plus a live one) and
// checks snapshot shape, determinism, history replay == snapshot, WS/SSE, search, journey,
// PR detail, auth, the burst frame, and the v0.5 Factory Floor (/insights, /changes, the
// snapshot's tables) for the simulation and the fixtures.

import type { Changes, Frame, History, Insights, Journey, PrDetail, SearchResults, DemoSnapshot as Snapshot } from '../src/wire.ts';
import { CLUSTER_LINE } from './stories.ts';
import { applyFrame } from './reduce.ts';

const EPOCH = Date.UTC(2026, 10, 10, 20, 0); // a weekday afternoon (US Central)
const MOCK = `${import.meta.dir}/mock.ts`;
let failures = 0;
let passes = 0;
function ok(cond: unknown, msg: string): void {
  if (cond) { passes++; console.log(`  ok   ${msg}`); }
  else { failures++; console.log(`  FAIL ${msg}`); }
}

type Server = { base: string; port: number; kill: () => void };
async function start(args: string[], env: Record<string, string> = {}): Promise<Server> {
  const proc = Bun.spawn([process.execPath, MOCK, '--port', '0', ...args], {
    env: { ...process.env, EPOCH: String(EPOCH), SEED: '7', SWITCHYARD_TOKEN: '', ...env },
    stdout: 'pipe', stderr: 'inherit',
  });
  const reader = proc.stdout.getReader();
  let buf = '';
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += new TextDecoder().decode(value);
    const m = /listening on http:\/\/localhost:(\d+)/.exec(buf);
    if (m) {
      console.log(`  [${args.join(' ') || 'live'}] ${buf.trim().split('\n').pop()}`);
      const port = Number(m[1]);
      return { base: `http://127.0.0.1:${port}`, port, kill: () => proc.kill() };
    }
  }
  proc.kill();
  throw new Error(`mock did not start: ${buf}`);
}
const get = async <T>(s: Server, path: string, init?: RequestInit): Promise<T> => {
  const r = await fetch(s.base + path, init);
  if (!r.ok) throw new Error(`${path} → ${r.status}`);
  return (await r.json()) as T;
};
const text = async (s: Server, path: string): Promise<string> => (await fetch(s.base + path, { headers: { 'Accept-Encoding': 'identity' } })).text();
const strip = (x: Snapshot): Snapshot => { const y = { ...x } as Partial<Snapshot>; delete y.at; return y as Snapshot; };

function checkShape(snap: Snapshot): void {
  console.log('snapshot shape');
  const repos = Object.entries(snap.repos);
  ok(snap.protocol === '0.5' && snap.at === EPOCH, `protocol "0.5", at == EPOCH (${snap.at})`);
  ok(repos.length >= 380 && repos.length <= 440, `~410 repos (${repos.length}) across ${Object.keys(snap.orgs).length} orgs`);
  ok(repos.every(([k, r]) => k === r.id && r.id === `${r.org}/${r.name}` && r.main.recent.length <= 40), 'repo keys == id == org/name; main.recent <= 40');
  const red = repos.filter(([, r]) => r.main.state === 'failure');
  ok(red.length >= 0.03 * repos.length && red.length <= 0.1 * repos.length, `red mains ${red.length} (${((100 * red.length) / repos.length).toFixed(1)}%)`);
  ok(red.every(([, r]) => r.main.culprit && r.main.recent.some((d) => d.culprit) || !r.main.recent.length), 'red repos carry a culprit (sha + dot)');
  ok(Object.entries(snap.commits).every(([k, c]) => k === `${c.repo}@${c.sha}` && snap.repos[c.repo]), 'commit keys == repo@sha');
  ok(Object.keys(snap.commits).length <= 3000, `commits capped (${Object.keys(snap.commits).length})`);
  const pipes = Object.entries(snap.pipelines);
  ok(pipes.every(([k, p]) => (p.lane === 'roadrunner' ? k === `wp:${p.repo}:${p.number}` : /^gha:\d+$/.test(k)) && snap.repos[p.repo]), `pipeline ids wp:/gha: (${pipes.length})`);
  ok(Object.entries(snap.prs).every(([k, p]) => k === `${p.repo}#${p.number}`), 'pr keys == repo#number');
  ok(Object.entries(snap.deploys).every(([k, d]) => k === `${d.app}:${d.sha}` && snap.apps[d.app]), 'deploy keys == app:sha');
  ok(Object.keys(snap.apps).length === 64 && Object.entries(snap.apps).every(([k, a]) => a.url === `https://${k}.apps.example.com`), '64 apps with apps.example.com urls');
  const notUp = Object.values(snap.apps).filter((a) => a.health !== 'up').length;
  ok(notUp >= 1 && notUp <= 4, `apps degraded/down: ${notUp}`);
  ok(Object.entries(snap.lanes).every(([k, l]) => k === l.id && snap.repos[k]?.lane === l.mode), 'lanes keyed by repo, mode == repo.lane');
  let busy = 0;
  ok(Object.values(snap.engines).every((e) => {
    busy += e.busy;
    return e.busy === e.running.length && e.busy <= e.slots && e.running.every((id) => snap.pipelines[id]?.state === 'running' && snap.pipelines[id]?.engine === e.id);
  }), 'engines: busy == running.length <= slots; running pipelines point back');
  ok(busy === pipes.filter(([, p]) => p.state === 'running').length, `running pipelines == sum(busy) (${busy})`);
  for (const q of Object.values(snap.queues)) {
    const pend = pipes.filter(([, p]) => p.lane === q.id && p.state === 'pending').map(([k]) => k);
    const run = pipes.filter(([, p]) => p.lane === q.id && p.state === 'running').length;
    ok(q.pending === pend.length && q.running === run && q.items.length <= 50 && q.items.every((i) => pend.includes(i)), `queue ${q.id}: pending ${q.pending}, running ${q.running}, oldest ${q.oldest_wait_ms} ms`);
  }
  const open = Object.values(snap.prs).filter((p) => !['merged', 'closed', 'deployed'].includes(p.phase));
  ok(open.length >= 110 && open.length <= 200 && snap.stats.prs_open === open.length, `open PRs ${open.length} == stats.prs_open`);
  ok(repos.every(([k, r]) => r.open_prs === open.filter((p) => p.repo === k).length), 'repo.open_prs matches open PRs');
  ok(snap.stats.commits_24h > 1000 && snap.stats.success_rate_24h > 0.8 && snap.stats.p50_build_ms > 30000, `stats ${JSON.stringify(snap.stats)}`);
}

const FIXTURES = `${import.meta.dir}/../../contract/fixtures`;
const COLLS = ['orgs', 'repos', 'commits', 'pipelines', 'prs', 'deploys', 'apps', 'engines', 'queues', 'lanes', 'groups', 'clusters', 'flakes', 'trends'];
/** The wire's arrays (fixtures mode) as the id-keyed maps the checks read. */
function toMaps(s: Record<string, unknown>): Snapshot {
  for (const k of COLLS) {
    const v = s[k];
    if (!Array.isArray(v)) continue;
    const m: Record<string, unknown> = {};
    for (const e of v) m[(e as { id: string }).id] = e;
    s[k] = m;
  }
  return s as unknown as Snapshot;
}

/** The first entity where two snapshots differ ('' when none; `at`/`seq` aside). */
function firstDiff(a: Record<string, unknown>, b: Record<string, unknown>): string {
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (k === 'at' || k === 'seq' || JSON.stringify(a[k]) === JSON.stringify(b[k])) continue;
    const x = a[k] as Record<string, unknown> | undefined, y = b[k] as Record<string, unknown> | undefined;
    if (!x || !y || typeof x !== 'object') return `${k}: ${JSON.stringify(x)?.slice(0, 160)} vs ${JSON.stringify(y)?.slice(0, 160)}`;
    for (const id of new Set([...Object.keys(x), ...Object.keys(y)])) {
      if (JSON.stringify(x[id]) !== JSON.stringify(y[id])) return `${k}[${id}]: ${JSON.stringify(x[id])?.slice(0, 240)} vs ${JSON.stringify(y[id])?.slice(0, 240)}`;
    }
  }
  return '';
}

/** The v0.5 Factory Floor: the snapshot's tables agree with /insights and with the fleet. */
function checkFloor(snap: Snapshot, ins: Insights, recorded = false): void {
  console.log(`factory floor (v0.5${recorded ? ', fixtures' : ''})`);
  const repos = Object.values(snap.repos);
  ok(repos.every((r) => r.group && snap.groups[r.group]), 'every repo has a group from the groups table');
  ok(ins.groups.length === Object.keys(snap.groups).length && ins.groups.reduce((n, g) => n + g.repos, 0) === repos.length, `groups cover every repo once (${ins.groups.length}: ${ins.groups.slice(0, 5).map((g) => `${g.name} ${g.repos}`).join(', ')}…)`);
  ok(ins.groups.every((g) => g.red === repos.filter((r) => r.group === g.id && (r.main.state === 'failure' || r.main.state === 'error')).length), 'Group.red == red mains in the group');
  const failed: string[] = [];
  for (const p of Object.values(snap.pipelines)) for (const w of p.workflows) for (const st of w.steps) if (st.state === 'failure' || st.state === 'error') failed.push(st.cluster ?? '');
  ok(failed.length > 0 && failed.every((c) => c && snap.clusters[c]), `every failed step names its cluster (${failed.length} steps, ${Object.keys(snap.clusters).length} clusters)`);
  const order = ins.clusters.every((c, i) => i === 0 || (ins.clusters[i - 1]!.open > 0 ? 1 : 0) > (c.open > 0 ? 1 : 0) || ((ins.clusters[i - 1]!.open > 0) === (c.open > 0) && ins.clusters[i - 1]!.count_1h >= c.count_1h));
  ok(order && ins.clusters.every((c) => /^f:[0-9a-f]{12}$/.test(c.id) && c.repo_count >= c.repos.length && c.count >= c.count_1h && c.signature.startsWith(`${c.step} · ${c.class}`)), 'clusters: ids f:<12 hex>, signatures, open first then count_1h');
  if (!recorded) {
    const story = ins.clusters[0];
    ok(story?.line === CLUSTER_LINE && story.step === 'test-web-#' && story.repo_count >= 4 && story.repo_count <= 6 && story.groups.length >= 2 && story.groups.length <= 3,
      `the story cluster leads: "${story?.signature}" ${story?.count} failures, ${story?.repo_count} repos, ${story?.groups.length} groups, open ${story?.open}`);
    ok(story && story.open < story.repo_count, 'one of its repos is fixed already (open < repos)');
  }
  ok(ins.flakes.length >= 1 && ins.flakes[0]!.flips_24h >= 2 && (recorded || Object.values(snap.pipelines).some((p) => p.flaky)), `flakes: ${ins.flakes.slice(0, 3).map((f) => `${f.id} ${f.flips_24h} flips`).join(', ')}`);
  const metrics = ['intake_ms', 'run_ms', 'pass_rate', 'pipelines', 'deploys', 'pr_age_ms', 'red'] as const;
  ok(ins.trends[0]?.id === 'fleet' && ins.trends.length === ins.groups.length + 1 && ins.trends.every((t) => metrics.every((m) => t[m].spark.length === 24 && [-1, 0, 1].includes(t[m].dir))), `trends: fleet + ${ins.trends.length - 1} groups, 7 metrics, 24-hour sparks`);
  const down = ins.trends.filter((t) => t.id !== 'fleet' && t.pass_rate.dir === -1 && t.pass_rate.bad);
  const up = ins.trends.filter((t) => t.id !== 'fleet' && t.pass_rate.dir === 1 && !t.pass_rate.bad);
  ok(recorded || (down.length >= 1 && up.length >= 1), `pass rate trending down (bad): ${down.map((t) => `${t.id} ${t.pass_rate.h1}/${t.pass_rate.d7}`).join(', ')}; up: ${up.map((t) => `${t.id} ${t.pass_rate.h1}/${t.pass_rate.d7}`).join(', ')}`);
}

async function wsFrames(s: Server, query: string, ms: number): Promise<Frame[]> {
  const out: Frame[] = [];
  const ws = new WebSocket(`ws://127.0.0.1:${s.port}/api/v1/stream${query}`);
  ws.onmessage = (e) => out.push(JSON.parse(String(e.data)) as Frame);
  await new Promise<void>((res, rej) => { ws.onopen = () => res(); ws.onerror = () => rej(new Error('ws error')); });
  await Bun.sleep(ms);
  ws.close();
  return out;
}

async function main(): Promise<void> {
  const t0 = performance.now();
  const [a, b] = await Promise.all([start(['--frozen']), start(['--frozen'])]);
  try {
    const snapText = await text(a, '/api/v1/snapshot');
    const snap = JSON.parse(snapText) as Snapshot;
    checkShape(snap);

    console.log('determinism');
    ok(snapText === (await text(b, '/api/v1/snapshot')), `two runs → byte-identical snapshot (${(snapText.length / 1e6).toFixed(2)} MB)`);
    const hText = await text(a, `/api/v1/history?from=${EPOCH - 3600000}&to=${EPOCH}`);
    ok(hText === (await text(b, `/api/v1/history?from=${EPOCH - 3600000}&to=${EPOCH}`)), `two runs → byte-identical history (${(hText.length / 1e6).toFixed(1)} MB)`);

    console.log('history');
    const h = JSON.parse(hText) as History;
    ok(h.base && h.from === EPOCH - 3600000 && h.to === EPOCH, `window ${h.from}..${h.to}, ${h.frames.length} frames`);
    const deltas = h.frames.filter((f): f is Extract<Frame, { t: 'delta' }> => f.t === 'delta');
    ok(deltas.every((f, i) => f.at > h.from && f.at <= h.to && (i === 0 || f.seq === deltas[i - 1]!.seq + 1)), 'frames: from < at <= to, contiguous seq');
    const kinds: Record<string, number> = {};
    for (const f of deltas) for (const op of f.ops) { const k = op.op === 'event' ? op.e.k : `${op.op}:${op.kind}`; kinds[k] = (kinds[k] ?? 0) + 1; }
    ok(['push', 'enqueue', 'start', 'step', 'finish', 'pr', 'merge', 'deploy', 'main'].every((k) => kinds[k]), `the hour has every event kind: ${Object.entries(kinds).filter(([k]) => !k.includes(':')).map(([k, n]) => `${k}=${n}`).join(' ')}`);
    const replay = h.base!;
    for (const f of h.frames) applyFrame(replay, f);
    ok(JSON.stringify(strip(replay)) === JSON.stringify(strip(snap)), 'history base + frames through reduce.ts == /snapshot (minus at)');
    const mid = EPOCH - 1800000;
    const h2 = await get<History>(a, `/api/v1/history?from=${mid}&to=${EPOCH}`);
    for (const f of h2.frames) applyFrame(h2.base!, f);
    ok(JSON.stringify(strip(h2.base!)) === JSON.stringify(strip(snap)), 'mid-window base (checkpoint + partial replay) also converges');

    console.log('reads');
    const sr = await get<SearchResults>(a, '/api/v1/search?q=cicd');
    ok(sr.results[0]?.id === 'Northwind-Labs/cicd' && sr.results.length <= 30, `search "cicd" → ${sr.results.slice(0, 3).map((r) => `${r.kind}:${r.id}`).join(', ')}`);
    const someCommit = Object.values(snap.commits).filter((c) => c.pipelines.some((p) => snap.pipelines[p]?.state === 'success')).pop()!;
    const sh = await get<SearchResults>(a, `/api/v1/search?q=${someCommit.sha.slice(0, 6)}`);
    ok(sh.results[0]?.kind === 'commit' && sh.results[0].id === `${someCommit.repo}@${someCommit.sha}`, 'search by sha prefix finds the commit first');
    const sp = await get<SearchResults>(a, '/api/v1/search?q=%2312');
    ok(sp.results.length > 0, `search "#12" → ${sp.results.length} hits (${sp.results[0]?.kind})`);
    const j = await get<Journey>(a, `/api/v1/commit/${someCommit.repo}/${someCommit.sha}`);
    const roots = j.spans.filter((x) => !x.parent);
    ok(j.pipelines.length > 0 && roots.length === j.pipelines.reduce((n, p) => n + p.workflows.filter((w) => w.started).length, 0), `journey: ${j.pipelines.length} pipeline(s), ${j.spans.length} spans, ${roots.length} roots`);
    ok(j.spans.some((x) => x.cached) && j.spans.every((x) => !x.parent || j.spans.some((y) => y.id === x.parent)), 'journey spans: tree is closed, some cached');
    const dep = Object.values(snap.commits).find((c) => c.deploy?.state === 'success' && c.at > EPOCH - 3600000);
    if (dep) {
      const jd = await get<Journey>(a, `/api/v1/commit/${dep.repo}/${dep.sha}`);
      ok(jd.deploys.length === 1 && jd.app && jd.health_after.length > 0, `deployed commit journey: deploy ${jd.deploys[0]?.state} via ${jd.deploys[0]?.via}, ${jd.health_after.length} health samples`);
    }
    ok((await fetch(`${a.base}/api/v1/commit/Northwind-Labs/cicd/deadbeef00`)).status === 404, 'unknown commit → 404');
    const openPr = Object.entries(snap.prs).find(([, p]) => p.phase === 'review')!;
    const pd = await get<PrDetail>(a, `/api/v1/pr/${openPr[1].repo}/${openPr[1].number}`);
    ok(pd.pr.number === openPr[1].number && pd.commits.length > 0 && pd.timeline.length > 0, `pr detail ${openPr[0]}: ${pd.commits.length} commits, ${pd.pipelines.length} pipelines, ${pd.timeline.length} timeline`);
    const metaR = await get<{ protocol: string; adapters: { state: string }[] }>(a, '/api/v1/meta');
    ok(metaR.protocol === '0.5' && metaR.adapters.length === 4 && metaR.adapters.every((x) => x.state === 'ok'), 'meta: protocol 0.5, 4 adapters ok');
    ok((await get<{ ok: boolean }>(a, '/api/healthz')).ok && (await get<{ ready: boolean }>(a, '/api/readyz')).ready, 'healthz / readyz');
    const pre = await fetch(`${a.base}/api/v1/snapshot`, { method: 'OPTIONS' });
    ok(pre.status === 204 && pre.headers.get('access-control-allow-origin') === '*', 'CORS preflight');
    const fz = await wsFrames(a, `?since=${snap.seq}`, 300);
    ok(fz.length === 0, 'frozen WS with since=current → nothing old');
    const rp = await wsFrames(a, `?since=${snap.seq - 500}`, 300);
    const rpOps = rp.reduce((n, f) => n + (f.t === 'delta' ? f.ops.length : 0), 0);
    ok(rp.length > 0 && rp.length <= 30 && rp[rp.length - 1]!.t === 'delta' && (rp[rp.length - 1] as { seq: number }).seq === snap.seq, `replay since=seq-500 → ${rp.length} coalesced frames, ${rpOps} ops, ends at seq ${snap.seq}`);
    const rs = await wsFrames(a, '?since=999999999', 300);
    ok(rs.length === 1 && rs[0]!.t === 'reset', 'since from the future → {t:"reset"}');
    checkFloor(snap, await get<Insights>(a, '/api/v1/insights'));
    console.log('changes');
    const ch = await get<Changes>(a, `/api/v1/changes?since=${EPOCH - 30 * 60_000}`);
    ok(ch.complete && ch.since === EPOCH - 30 * 60_000 && ch.until === EPOCH, `since 30 min: complete, window ${ch.since}..${ch.until}`);
    ok(ch.red.length >= 3 && ch.counts.red === ch.red.length && ch.red.every((r) => snap.repos[r.repo]?.main.state === 'failure' && r.at > ch.since), `new reds: ${ch.red.length} (${ch.red.slice(0, 4).map((r) => r.repo.split('/')[1]).join(', ')}…)`);
    ok(ch.red.filter((r) => r.cluster && snap.clusters[r.cluster]?.line === CLUSTER_LINE).length >= 3, 'the story cluster is behind 3+ of the new reds');
    ok(ch.recovered.length >= 1 && ch.recovered.every((r) => snap.repos[r.repo]?.main.state !== 'failure' && r.red_ms >= 0), `recoveries: ${ch.recovered.length}`);
    ok(ch.counts.pipelines > 0 && ch.counts.failed > 0 && ch.groups.length > 0 && ch.groups[0]!.red >= ch.groups[ch.groups.length - 1]!.red, `counts ${JSON.stringify(ch.counts)}`);
    const old = await get<Changes>(a, `/api/v1/changes?since=${EPOCH - 48 * 3600_000}`);
    ok(!old.complete && old.since === EPOCH - 24 * 3600_000, 'since 48 h: complete false, clamped to 24 h');
    ok((await fetch(`${a.base}/api/v1/changes`)).status === 400, '/changes without since → 400');
  } finally { a.kill(); b.kill(); }

  console.log('fixtures (v0.4 recordings → v0.5)');
  const fx = await start(['--fixtures', FIXTURES, '--rate', '60']);
  try {
    await Bun.sleep(6500); // 6.5 min of the recording at 60×: frames, a Floor tick
    const fsnap = toMaps(await get<Record<string, unknown>>(fx, '/api/v1/snapshot'));
    ok(fsnap.protocol === '0.5' && Object.keys(fsnap.groups).length > 5, `fixtures snapshot: protocol ${fsnap.protocol}, ${Object.keys(fsnap.groups).length} groups`);
    const fins = await get<Insights>(fx, '/api/v1/insights');
    checkFloor(fsnap, fins, true);
    const sec = fins.clusters.find((c) => c.step === 'security-scan');
    ok(sec && sec.repo_count === 5 && sec.class === 'security' && !!sec.line, `security-scan: ${sec?.count} failures, ${sec?.repo_count} repos, groups ${sec?.groups.join(', ')}`);
    const fch = await get<Changes>(fx, `/api/v1/changes?since=${EPOCH - 8 * 3600_000}`);
    ok(fch.complete && fch.red.length > 0 && fch.recovered.length > 0 && fch.deploys.length > 0, `fixtures changes (8 h): ${fch.red.length} red, ${fch.recovered.length} recovered, ${fch.counts.deploys} deploys`);
    const now = toMaps(await get<Record<string, unknown>>(fx, '/api/v1/snapshot'));
    const h = await get<History>(fx, `/api/v1/history?from=${EPOCH}&to=${now.at}`);
    const hb = toMaps(h.base as unknown as Record<string, unknown>);
    let n = 0;
    for (const f of h.frames) {
      if (f.t !== 'delta' || f.seq > now.seq) continue;
      applyFrame(hb, f as Frame);
      n += f.ops.filter((o) => o.op !== 'event' && o.op !== 'dot' && ['cluster', 'group', 'trend', 'flake'].includes(o.kind)).length;
    }
    const diff = firstDiff(now as unknown as Record<string, unknown>, hb as unknown as Record<string, unknown>);
    ok(n > 0 && !diff, `fixtures history replay (base + ${h.frames.length} frames, ${n} Floor ops) == snapshot at seq ${now.seq}${diff ? `: differs at ${diff}` : ''}`);
  } finally { fx.kill(); }
  const f4 = await start(['--fixtures', FIXTURES, '--frozen', '--v04']);
  try {
    const s4 = await get<{ protocol: string; groups?: unknown; repos: { group?: string }[] }>(f4, '/api/v1/snapshot');
    ok(s4.protocol === '0.4' && s4.groups === undefined && s4.repos.every((r) => r.group === undefined), '--v04: the recording as recorded (protocol 0.4, no Floor)');
    ok((await fetch(`${f4.base}/api/v1/insights`)).status === 404 && (await fetch(`${f4.base}/api/v1/changes?since=0`)).status === 404, '--v04: /insights and /changes → 404 (as a v0.4 server)');
  } finally { f4.kill(); }

  console.log('live');
  const live = await start(['--rate', '10']);
  try {
    const t = Date.now();
    const [frames, sseText] = await Promise.all([
      wsFrames(live, '', 6000),
      (async () => {
        const r = await fetch(`${live.base}/api/v1/stream/sse`);
        const reader = r.body!.getReader();
        let s = '';
        const end = Date.now() + 2500;
        while (Date.now() < end) {
          const x = await Promise.race([reader.read(), Bun.sleep(end - Date.now()).then(() => null)]);
          if (!x || x.done) break;
          s += new TextDecoder().decode(x.value);
        }
        await reader.cancel();
        return s;
      })(),
    ]);
    const secs = (Date.now() - t) / 1000;
    const d = frames.filter((f): f is Extract<Frame, { t: 'delta' }> => f.t === 'delta');
    ok(d.length > 10 && d.every((f, i) => i === 0 || f.seq > d[i - 1]!.seq), `WS live: ${d.length} delta frames with increasing seq`);
    ok(d.length / secs <= 30, `frame rate ${(d.length / secs).toFixed(1)}/s <= 30`);
    ok(frames.some((f) => f.t === 'hb'), 'heartbeat received');
    const sseFrames = sseText.split('\n\n').filter((x) => x.startsWith('data: ')).map((x) => JSON.parse(x.slice(6)) as Frame);
    ok(sseFrames.length > 0 && sseFrames.every((f) => f.t === 'delta' || f.t === 'hb'), `SSE: ${sseFrames.length} frames`);
  } finally { live.kill(); }

  console.log('auth + burst');
  const sec = await start(['--frozen'], { SWITCHYARD_TOKEN: 's3cret' });
  try {
    ok((await fetch(`${sec.base}/api/v1/snapshot`)).status === 401, 'no token → 401');
    ok((await fetch(`${sec.base}/api/v1/meta`, { headers: { Authorization: 'Bearer s3cret' } })).status === 200, 'Bearer token → 200');
    ok((await fetch(`${sec.base}/api/v1/meta?token=s3cret`)).status === 200, '?token= → 200');
    ok((await fetch(`${sec.base}/api/healthz`)).status === 200, 'healthz needs no token');
  } finally { sec.kill(); }
  const bu = await start(['--frozen', '--burst']);
  try {
    const fr = await wsFrames(bu, '', 10600);
    const big = fr.find((f) => f.t === 'delta' && f.ops.length >= 1000);
    ok(big, `--burst: one frame with ${big && big.t === 'delta' ? big.ops.length : 0} ops`);
  } finally { bu.kill(); }

  console.log(`\n${passes} passed, ${failures} failed in ${((performance.now() - t0) / 1000).toFixed(1)} s`);
  process.exit(failures ? 1 : 0);
}

await main();
