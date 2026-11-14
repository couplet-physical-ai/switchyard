#!/usr/bin/env bun
// Switchyard mock server (contract v0.5). All I/O and wall-clock live here; the simulation
// (server/sim.ts) is pure. Both sources serve the v0.5 Factory Floor (server/floor.ts):
// the simulation keeps it as it runs, and the fixtures (v0.4 recordings) get it derived
// deterministically and kept as their frames loop (extra ops appended to each frame).
// Usage:
//   bun server/mock.ts [--port N] [--frozen] [--rate N] [--burst] [--fixtures DIR [--v04]]
// --fixtures DIR serves DIR/snapshot.json and loops DIR/hour.jsonl (contract/fixtures, read at
// run time); with --frozen nothing moves, which is how the tests run it (app.json's
// `commands.server`: `bun exact.mjs test` starts it at src/api.ts's FIXTURES address).
// Env: PORT, SEED (default 7), EPOCH (ms; default now rounded down to the minute),
//      SWITCHYARD_TOKEN (require bearer/?token= on /api/v1/*), HISTORY_HOURS (default 3).

import type { Changes, Frame, Insights, Journey, Op, PrDetail, SearchResults, DemoSnapshot as Snapshot } from '../src/wire.ts';
import { Floor, type FloorKind, seedRecorded } from './floor.ts';
import { FrameLog, historyJson } from './history.ts';
import { applyFrame } from './reduce.ts';
import { createSim, PROTOCOL } from './sim.ts';
import { makeRng } from './util.ts';
import { journeyOf, prDetailOf, searchFleet } from './views.ts';

/** The surface the HTTP layer needs; the Sim and the fixture replayer both provide it. */
type Source = {
  readonly seq: number;
  readonly now: number;
  step(ms: number): number;
  framesSince(since: number): string[] | null;
  snapshotJson(): string;
  historyJson(from: number, to: number): string;
  journey(repo: string, sha: string): Journey | null;
  prDetail(repo: string, number: number): PrDetail | null;
  search(q: string): SearchResults;
  insights(): Insights;
  changes(since: number, until?: number): Changes;
  /** A v0.4 recording served as recorded: no /insights or /changes (404, as a v0.4 server). */
  v04?: boolean;
  burst?(n: number): number;
  orgs(): string[];
};

// ───────────────────────────── CLI ─────────────────────────────

const argv = process.argv.slice(2);
const flag = (name: string): boolean => argv.includes(name);
const opt = (name: string): string | undefined => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const port = Number(opt('--port') ?? process.env.PORT ?? 4790);
const frozen = flag('--frozen');
const rate = Number(opt('--rate') ?? 1);
const burst = flag('--burst');
const fixtures = opt('--fixtures');
/** --fixtures only: serve the recording as recorded (contract v0.4: no Factory Floor). */
const v04 = flag('--v04');
const seed = Number(process.env.SEED ?? 7);
const epoch = process.env.EPOCH ? Number(process.env.EPOCH) : Math.floor(Date.now() / 60000) * 60000;
const token = process.env.SWITCHYARD_TOKEN || undefined;
const historyMs = Number(process.env.HISTORY_HOURS ?? 3) * 3600000;
if (!Number.isFinite(port) || !Number.isFinite(rate) || rate <= 0 || !Number.isFinite(epoch)) {
  console.error('usage: bun server/mock.ts [--port N] [--frozen] [--rate N] [--burst] [--fixtures DIR]');
  process.exit(2);
}

// ───────────────────────────── fixture replay ─────────────────────────────

const TIME_KEYS = new Set(['at', 'since', 'created', 'updated', 'started', 'finished', 'checked', 'start', 'end', 'last_ok']);
function shiftTimes(x: unknown, d: number): void {
  if (Array.isArray(x)) { for (const v of x) shiftTimes(v, d); return; }
  if (!x || typeof x !== 'object') return;
  const o = x as Record<string, unknown>;
  for (const k in o) {
    const v = o[k];
    if (typeof v === 'number' && TIME_KEYS.has(k) && v > 1e12) o[k] = v + d;
    else if (v && typeof v === 'object') shiftTimes(v, d);
  }
}

/** Serves fixtures/snapshot.json as the base and loops fixtures/hour.jsonl, shifted to now. */
async function fixtureSource(dir: string, start: number): Promise<Source> {
  const snapF = Bun.file(`${dir}/snapshot.json`);
  const hourF = Bun.file(`${dir}/hour.jsonl`);
  if (!(await snapF.exists()) || !(await hourF.exists())) {
    console.error(`--fixtures ${dir}: need ${dir}/snapshot.json and ${dir}/hour.jsonl (the server thread's sanitized fixtures); not found.`);
    process.exit(1);
  }
  // v0.2+ fixtures carry each collection as an array of entities with their own ids; the
  // reducer and the views here work on id-keyed maps, and the snapshot goes out as arrays again.
  const base = toMaps(await snapF.json()) as Snapshot;
  const frames = (await hourF.text()).split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l) as Frame)
    .filter((f): f is Extract<Frame, { t: 'delta' }> => f.t === 'delta');
  if (!frames.length) { console.error(`${dir}/hour.jsonl has no delta frames`); process.exit(1); }
  const f0 = frames[0]!.at;
  const loopMs = Math.max(1000, frames[frames.length - 1]!.at - f0 + 1000);
  shiftTimes(base, start - base.at);
  const state = base;
  state.seq = 0;
  state.at = start;
  // v0.5: the Factory Floor, derived from the recording (its marks become extra ops per frame).
  // `--v04` serves the recording as it is (protocol 0.4, no Floor): the client's approximations.
  const marks = new Map<string, [FloorKind, string]>();
  const floor = new Floor({ state, mark: (k, id) => { if (!v04) marks.set(`${k}\u0000${id}`, [k, id]); } });
  if (!v04) {
    seedRecorded(floor, start, makeRng(0xf1a7));
    state.protocol = PROTOCOL;
  } else {
    // the recording may be v0.5 itself (contract c04559f+): a v0.4 server knows none of it
    for (const k of ['groups', 'clusters', 'flakes', 'trends'] as const) delete (state as Partial<Snapshot>)[k];
    state.protocol = '0.4';
    for (const r of Object.values(state.repos)) strip05(r);
    for (const p of Object.values(state.pipelines)) strip05(p);
    for (const f of frames) (f as { ops: Op[] }).ops = (f.ops as Op[]).filter((op) => !('kind' in op) || !FLOOR_KINDS.has(op.kind as string)).map((op) => { if ('v' in op && op.v && typeof op.v === 'object') strip05(op.v); return op; });
  }
  marks.clear();
  /** The ops for what the Floor changed since the last call. */
  const floorOps = (): Op[] => {
    const out: Op[] = [];
    for (const [k, id] of marks.values()) {
      if (k === 'pipeline') {
        const p = state.pipelines[id];
        if (p) out.push({ op: 'patch', kind: 'pipeline', id, v: { workflows: p.workflows, ...(p.flaky ? { flaky: true } : {}) } });
      } else if (k === 'repo') {
        const r = state.repos[id];
        if (r) out.push({ op: 'patch', kind: 'repo', id, v: { group: r.group ?? null } });
      } else {
        const v = (state[`${k}s` as 'groups'] as Record<string, unknown>)[id];
        out.push(v === undefined ? { op: 'remove', kind: k, id } : { op: 'upsert', kind: k, id, v });
      }
    }
    marks.clear();
    return out;
  };
  const log = new FrameLog(historyMs, 20000);
  log.checkpoint(0, start, JSON.stringify(state));
  let seq = 0, now = start, next = 0, loop = 0, lastCk = start;
  const src: Source = {
    get seq() { return seq; },
    get now() { return now; },
    step(ms: number): number {
      const ops: unknown[] = [];
      for (;;) {
        const f = frames[next]!;
        const shift = start + loop * loopMs - f0;
        if (f.at + shift > ms) break;
        const copy = JSON.parse(JSON.stringify(f)) as typeof f;
        shiftTimes(copy.ops, shift);
        ops.push(...copy.ops);
        if (++next === frames.length) { next = 0; loop++; }
      }
      now = ms;
      const tickDue = !v04 && ms - floor.lastTick >= 5 * 60_000;
      if (!ops.length && !tickDue) return 0;
      // a recorded repo upsert carries no group: the Floor's goes in before it lands
      if (!v04) for (const op of ops as Op[]) if (op.op === 'upsert' && op.kind === 'repo' && op.v && typeof op.v === 'object') (op.v as { group?: string }).group = floor.groupOf(op.id);
      const frame = { t: 'delta', seq: ++seq, at: ms, ops } as Frame;
      applyFrame(state, frame);
      if (v04) { log.push(seq, ms, JSON.stringify(frame)); if (ms - lastCk >= 600000) { log.checkpoint(seq, ms, JSON.stringify(state)); lastCk = ms; } return 1; }
      // v0.5: what the frame changed, read by the Floor (failed steps cluster, flips, rollups,
      // red/green, deploys, health), its own changes appended as ops of the same frame
      const touched = new Set<string>();
      let appsChanged = false;
      for (const op of ops as Op[]) {
        if (op.op === 'event') floor.onEvent(op.e);
        else if ((op.op === 'upsert' || op.op === 'patch') && op.kind === 'pipeline') touched.add(op.id);
        else if ((op.op === 'upsert' || op.op === 'patch' || op.op === 'remove') && (op.kind === 'app' || op.kind === 'repo') && (op.op !== 'patch' || 'team' in (op.v as object) || op.kind === 'repo' && 'app' in (op.v as object))) appsChanged = true;
      }
      for (const id of touched) { const p = state.pipelines[id]; if (p) floor.observe(id, p, ms); }
      if (appsChanged) floor.catalog();
      if (tickDue) { floor.tick(ms); floor.tickTrends(ms); }
      const extra = floorOps();
      if (extra.length) (frame as { ops: Op[] }).ops.push(...extra); // (already in `state`: the Floor changed it in place)
      log.push(seq, ms, JSON.stringify(frame));
      if (ms - lastCk >= 600000) { log.checkpoint(seq, ms, JSON.stringify(state)); lastCk = ms; }
      return 1;
    },
    framesSince: (since) => log.since(since, seq),
    snapshotJson: () => { state.seq = seq; state.at = now; return JSON.stringify(toArrays(state)); },
    historyJson: (from, to) => historyJson(log.window(from, to, now)),
    journey: (repo, sha) => journeyOf({ state }, repo, sha),
    prDetail: (repo, n) => prDetailOf({ state }, repo, n),
    search: (q) => searchFleet({ state }, q),
    insights: () => floor.insights(now),
    changes: (since, until) => floor.changes(since, until, now),
    v04,
    orgs: () => Object.keys(state.orgs),
  };
  return src;
}

const FLOOR_KINDS = new Set(['group', 'cluster', 'flake', 'trend']);
/** `--v04`: a v0.5 entity (or patch) without its v0.5 fields (Repo.group, Pipeline.flaky, Step.cluster). */
function strip05(v: unknown): void {
  const o = v as { group?: unknown; flaky?: unknown; workflows?: { steps?: { cluster?: unknown }[] }[] };
  delete o.group; delete o.flaky;
  if (Array.isArray(o.workflows)) for (const w of o.workflows) if (Array.isArray(w.steps)) for (const st of w.steps) delete st.cluster;
}

const COLLECTIONS = ['orgs', 'repos', 'commits', 'pipelines', 'prs', 'deploys', 'apps', 'engines', 'queues', 'lanes', 'groups', 'clusters', 'flakes', 'trends'] as const;

/** A snapshot's array collections as id-keyed maps (a map stays a map). */
function toMaps(s: Record<string, unknown>): Record<string, unknown> {
  for (const k of COLLECTIONS) {
    const v = s[k];
    if (!Array.isArray(v)) { s[k] ??= {}; continue; }
    const m: Record<string, unknown> = {};
    for (const e of v) if (e && typeof e === 'object' && (e as { id?: unknown }).id != null) m[String((e as { id: unknown }).id)] = e;
    s[k] = m;
  }
  return s;
}

/** The wire's shape (contract v0.2+): each collection an array sorted by id. */
function toArrays(s: Snapshot): Record<string, unknown> {
  const out: Record<string, unknown> = { ...s };
  for (const k of COLLECTIONS) {
    const m = (s as unknown as Record<string, Record<string, unknown> | undefined>)[k];
    if (m === undefined) continue; // (--v04: no Factory Floor tables at all)
    out[k] = Object.keys(m).sort().map((id) => m[id]);
  }
  return out;
}

// ───────────────────────────── source setup ─────────────────────────────

const t0 = performance.now();
let src: Source;
if (fixtures) src = await fixtureSource(fixtures, epoch);
else {
  const sim = createSim({ seed, epoch, historyMs });
  src = Object.assign(sim, { orgs: () => Object.keys(sim.state.orgs) }) as unknown as Source;
}
const warmMs = Math.round(performance.now() - t0);

// ───────────────────────────── streaming ─────────────────────────────

type WsData = { since?: number };
const sockets = new Set<import('bun').ServerWebSocket<WsData>>();
const sse = new Set<ReadableStreamDefaultController<Uint8Array>>();
const enc = new TextEncoder();

/** Merges `jsons` (delta frames, in order) into at most `max` frames, keeping op order. */
function coalesce(jsons: string[], max: number): string[] {
  if (jsons.length <= max) return jsons;
  const size = Math.ceil(jsons.length / max);
  const out: string[] = [];
  for (let i = 0; i < jsons.length; i += size) {
    const chunk = jsons.slice(i, i + size);
    const last = JSON.parse(chunk[chunk.length - 1]!) as { seq: number; at: number };
    const ops = chunk.map((j) => j.slice(j.indexOf('"ops":[') + 7, -2)).filter((s) => s.length);
    out.push(`{"t":"delta","seq":${last.seq},"at":${last.at},"ops":[${ops.join(',')}]}`);
  }
  return out;
}

function sendAll(jsons: string[]): void {
  for (const j of jsons) {
    for (const ws of sockets) ws.send(j);
    const chunk = enc.encode(`data: ${j}\n\n`);
    for (const c of sse) { try { c.enqueue(chunk); } catch { sse.delete(c); } }
  }
}

/** Frames a new subscriber should get first: nothing, a replay (≤ 30 frames), or a reset. */
function catchUp(since: number | undefined): string[] {
  if (since === undefined || Number.isNaN(since)) return [];
  const missed = src.framesSince(since);
  return missed === null ? ['{"t":"reset"}'] : coalesce(missed, 30);
}

let lastSeq = src.seq;
// default EPOCH = now rounded down to the minute: run sim time on the wall clock from there
const wallStart = process.env.EPOCH || fixtures ? Date.now() : epoch;
const simNow = (): number => epoch + (Date.now() - wallStart) * rate;
function pump(): void {
  if (!frozen) src.step(simNow());
  if (src.seq === lastSeq) return;
  const fresh = src.framesSince(lastSeq) ?? [];
  lastSeq = src.seq;
  sendAll(coalesce(fresh, 1));
}
setInterval(pump, 50);
setInterval(() => sendAll([JSON.stringify({ t: 'hb', seq: src.seq, at: src.now })]), 5000);
if (burst && src.burst) setInterval(() => { src.burst!(1000); pump(); }, 10000);

// ───────────────────────────── HTTP ─────────────────────────────

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type, Last-Event-ID',
  'Access-Control-Max-Age': '600',
};
const gzCache = new Map<string, Uint8Array<ArrayBuffer>>();
function json(req: Request, body: string | object, status = 200, cacheKey?: string): Response {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  const headers: Record<string, string> = { ...CORS, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
  if (text.length > 4096 && (req.headers.get('accept-encoding') ?? '').includes('gzip')) {
    let gz = cacheKey ? gzCache.get(cacheKey) : undefined;
    if (!gz) {
      gz = Bun.gzipSync(enc.encode(text)) as Uint8Array<ArrayBuffer>;
      if (cacheKey) { gzCache.clear(); gzCache.set(cacheKey, gz); }
    }
    return new Response(gz, { status, headers: { ...headers, 'Content-Encoding': 'gzip', Vary: 'Accept-Encoding' } });
  }
  return new Response(text, { status, headers });
}
const err = (req: Request, status: number, error: string): Response => json(req, { error }, status);

const ADAPTERS = ['woodpecker', 'github', 'cicd', 'apps'];
function meta(): object {
  const now = frozen ? src.now : Date.now();
  return {
    protocol: src.v04 ? '0.4' : PROTOCOL, version: 'mock', git_sha: 'mock',
    adapters: ADAPTERS.map((name, i) => ({ name, state: 'ok', last_ok: now - 1000 * (i + 1), lag_ms: 200 + 150 * i })),
    orgs: src.orgs(),
  };
}

function authorized(req: Request, url: URL): boolean {
  if (!token) return true;
  return req.headers.get('authorization') === `Bearer ${token}` || url.searchParams.get('token') === token;
}

const server = Bun.serve<WsData>({
  port,
  idleTimeout: 120,
  fetch(req, srv) {
    const url = new URL(req.url);
    // `/nostream/…`: the same API with its stream refused (404), as a server or an edge that does
    // not pass the WebSocket would (the reconnect test, p5-board)
    const refuse = url.pathname.startsWith('/nostream/');
    const path = url.pathname.replace(/^\/nostream(?=\/)/, '').replace(/\/+$/, '') || '/';
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    if (req.method !== 'GET') return err(req, 405, 'method not allowed');
    if (path === '/api/healthz') return json(req, { ok: true });
    if (path === '/api/readyz') return json(req, { ready: true, adapters: ADAPTERS.map((name) => ({ name, state: 'ok' })) });
    if (!path.startsWith('/api/v1/')) return err(req, 404, 'not found');
    if (!authorized(req, url)) return err(req, 401, 'unauthorized: send Authorization: Bearer <token> or ?token=');
    const sinceRaw = url.searchParams.get('since');
    const since = sinceRaw === null || sinceRaw === '' ? undefined : Number(sinceRaw);
    const parts = path.split('/').slice(3).map(decodeURIComponent); // after /api/v1
    switch (parts[0]) {
      case 'meta': return json(req, meta());
      case 'snapshot': return json(req, src.snapshotJson(), 200, `snap:${src.seq}:${src.now}`);
      case 'history': {
        const to = Number(url.searchParams.get('to') ?? src.now);
        const from = Number(url.searchParams.get('from') ?? to - 3600000);
        if (!Number.isFinite(from) || !Number.isFinite(to) || from > to) return err(req, 400, 'from/to must be ms with from <= to');
        return json(req, src.historyJson(from, to));
      }
      case 'commit': {
        if (parts.length !== 4) return err(req, 400, 'use /api/v1/commit/{owner}/{name}/{sha}');
        const j = src.journey(`${parts[1]}/${parts[2]}`, parts[3]!);
        return j ? json(req, j) : err(req, 404, `unknown commit ${parts[1]}/${parts[2]}@${parts[3]}`);
      }
      case 'pr': {
        if (parts.length !== 4 || !/^\d+$/.test(parts[3]!)) return err(req, 400, 'use /api/v1/pr/{owner}/{name}/{number}');
        const d = src.prDetail(`${parts[1]}/${parts[2]}`, Number(parts[3]));
        return d ? json(req, d) : err(req, 404, `unknown pr ${parts[1]}/${parts[2]}#${parts[3]}`);
      }
      case 'search': return json(req, src.search(url.searchParams.get('q') ?? ''));
      case 'insights': return src.v04 ? err(req, 404, 'not found') : json(req, src.insights());
      case 'changes': {
        if (src.v04) return err(req, 404, 'not found');
        const untilRaw = url.searchParams.get('until');
        const until = untilRaw === null || untilRaw === '' ? undefined : Number(untilRaw);
        if (since === undefined || !Number.isFinite(since) || (until !== undefined && !Number.isFinite(until))) return err(req, 400, 'use /api/v1/changes?since=<ms>[&until=<ms>]');
        return json(req, src.changes(since, until));
      }
      // (`tstream`: the query-token path a device token's WebSocket takes, as the server's
      // api.rs serves it; without it a client holding a token reconnected forever, p4)
      case 'tstream':
      case 'stream': {
        if (refuse) return err(req, 404, 'not found');
        if (parts[1] === 'sse') {
          let ctl: ReadableStreamDefaultController<Uint8Array>;
          const stream = new ReadableStream<Uint8Array>({
            start(c) {
              ctl = c;
              c.enqueue(enc.encode(': switchyard mock\n\n'));
              for (const j of catchUp(since)) c.enqueue(enc.encode(`data: ${j}\n\n`));
              sse.add(c);
            },
            cancel() { sse.delete(ctl); },
          });
          return new Response(stream, { headers: { ...CORS, 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' } });
        }
        if (srv.upgrade(req, { data: { since } })) return undefined;
        return err(req, 426, 'websocket upgrade required (or use /api/v1/stream/sse)');
      }
      default: return err(req, 404, 'not found');
    }
  },
  websocket: {
    open(ws) {
      for (const j of catchUp(ws.data.since)) ws.send(j);
      sockets.add(ws);
    },
    message() { /* client → server messages are ignored in v0 */ },
    close(ws) { sockets.delete(ws); },
  },
});

console.log(`switchyard mock listening on http://localhost:${server.port} (seed ${seed}, epoch ${epoch}, ${fixtures ? `fixtures ${fixtures}` : `warm-up ${warmMs} ms`}, seq ${src.seq}${frozen ? ', frozen' : ''}${rate !== 1 ? `, rate ${rate}` : ''}${burst ? ', burst' : ''})`);

