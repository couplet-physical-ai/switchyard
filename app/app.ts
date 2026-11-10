// Switchyard's data module. The fleet lives here: the timeline (live and shown worlds), the
// motion system and the yard's canvas layers. Contract asks small questions (sources below);
// the canvases read the world directly every frame (`draw`).

import type { Answer, Ctx2D, Frame, Result, Sources, Store } from './app.contract.d.ts';
import { HttpUpstream, resolveBase, wsUrl, type Upstream } from './src/api.ts';
import { DEMO_REPLAY, DemoUpstream } from './src/demo.ts';
import { fleet, journeyView, mainlines, prDetailView, prs, search } from './src/project.ts';
import { Timeline } from './src/timeline.ts';
import type { Frame as WireFrame } from './src/wire.ts';
import { drawStatic, LiveLayer } from './src/yard/draw.ts';
import { isRed, layout, pickMains, type Layout } from './src/yard/layout.ts';
import { Motion } from './src/yard/motion.ts';
import { dotLine, fmtDur } from './src/yard/paint.ts';

export const grants = [
  'net.fetch https:',
  'net.fetch http:',
  'net.websocket wss:',
  'net.websocket ws:',
  'secret.keep switchyard.token',
].join('\n');

const TOKEN = 'switchyard.token';

// ---- state ---------------------------------------------------------------------------------
const tl = new Timeline();
let L: Layout | null = null;
let mains: string[] = [];
let mainsAt = -1e9;
let mainsShape = -1;
/** The module clock: the runner's ms, as draws and beats report it. */
let clock = 0;
let lastLive = 0;
let epochAtZero = 0;
let up: Upstream | null = null;
let demo: DemoUpstream | null = null;
let seenEpoch = -1;
const motion = new Motion(() => L, () => clock);
const liveLayer = new LiveLayer();
tl.listener = (e, w) => motion.onEvent(e, w);

function advance(t: number): void {
  if (t > clock) clock = t;
  tl.tick(clock);
  if (demo) {
    // The demo makes frames up to where the playhead needs them; paused, it stands still.
    const target = tl.mode === 'live' ? epochAtZero + clock : tl.mode === 'paused' ? 0 : tl.playhead;
    if (target > demo.now) {
      for (const f of demo.pump(target)) {
        if (tl.mode === 'live') tl.ingest(f, clock);
        else tl.applyNow(f);
      }
    }
    if (tl.replayDone()) tl.resumeLive();
  } else if (tl.replayDone()) {
    void reloadLive();
  } else {
    const next = tl.replayWants(REPLAY_LOOKAHEAD);
    if (next) void fetchChunk(next);
  }
  if (tl.epoch !== seenEpoch) {
    seenEpoch = tl.epoch;
    motion.sync(tl.world);
  }
}

/** A replay streams in chunks of this much server time, fetched this far ahead of the
 *  playhead: an hour of real frames is ~10 MB, too much to hold beside the world at once. */
const REPLAY_CHUNK = 6 * 60_000;
const REPLAY_LOOKAHEAD = 3 * 60_000;
let chunking: Promise<void> | null = null;
function fetchChunk(from: number): Promise<void> {
  if (!up || demo || chunking) return chunking ?? Promise.resolve();
  const to = Math.min(from + REPLAY_CHUNK, tl.replayTo);
  chunking = up.history(from, to, false).then(
    (h) => { tl.appendReplay(h); },
    () => { /* asked again on the next frame */ },
  ).finally(() => { chunking = null; });
  return chunking;
}

/** The world stopped following the server (a replay, a long pause, a reset): refetch it. */
let reloading: Promise<void> | null = null;
function reloadLive(): Promise<void> {
  if (!up || demo) return Promise.resolve();
  reloading ??= up.snapshot().then(
    (s) => { tl.load(s, clock); },
    () => { /* the feed's reconnect retries */ },
  ).finally(() => { reloading = null; });
  return reloading;
}

/** Live again in the demo: a short gap is simulated, a long one starts the demo afresh at now. */
async function demoLive(): Promise<void> {
  const wall = Math.floor((epochAtZero + clock) / 1000) * 1000;
  if (demo && wall - demo.now <= 120_000) {
    tl.resumeLive();
    return;
  }
  demo = null;
  demo = await DemoUpstream.start(wall);
  up = demo;
  tl.load(await demo.snapshot(), clock);
}

function ensureLayout(w: number, h: number): Layout {
  const world = tl.world;
  const n = 10;
  if (clock - mainsAt > 8000 || mainsShape !== world.shapeVer || !mains.length) {
    // Red lines join at once; otherwise the selection changes at most every 8 s.
    mains = pickMains(world, n, mains);
    mainsAt = clock;
    mainsShape = world.shapeVer;
  } else if (Array.from(world.repos.values()).some((r) => isRed(r) && !mains.includes(r.id) && mains.length > 0)) {
    mains = pickMains(world, n, mains);
  }
  const key = `${w}|${h}|${mains.join(',')}|${world.shapeVer}`;
  if (!L || key !== lkey) {
    L = layout(w, h, world, mains);
    lkey = key;
  }
  return L;
}
let lkey = '';

// ---- sources -------------------------------------------------------------------------------
type Conn = Result<'connect'>;

async function connect(server: string, token: string, epoch0: number): Promise<Conn> {
  epochAtZero = epoch0;
  const none: Conn = { ok: false, status: 'not connected', error: '', seq: 0, label: '', kind: '', needsSetup: false };
  try {
    if (server === 'demo') {
      tl.wallNow = (c) => epochAtZero + c;
      const start = Math.floor((epoch0 + clock) / 1000) * 1000;
      if (!demo || Math.abs(demo.now - start) > 120_000) {
        demo = null;
        demo = await DemoUpstream.start(start);
      }
      up = demo;
      tl.load(await demo.snapshot(), clock);
      motion.sync(tl.world);
      return { ...none, ok: true, status: 'demo', seq: tl.world.seq, label: demo.label, kind: 'demo' };
    }
    demo = null;
    tl.wallNow = null;
    const base = resolveBase(server);
    if (!base) {
      up = null;
      return { ...none, status: 'not connected', needsSetup: true };
    }
    up = new HttpUpstream(base, token);
    const snap = await up.snapshot();
    tl.load(snap, clock);
    motion.sync(tl.world);
    return { ...none, ok: true, status: 'connected', seq: tl.world.seq, label: up.label, kind: 'http' };
  } catch (e) {
    return { ...none, status: 'offline', error: `Could not reach ${resolveBase(server) || 'the server'}: ${(e as Error).message ?? e}`, needsSetup: !resolveBase(server) };
  }
}

function liveFeed(server: string, token: string, seq: number, ok: boolean) {
  if (!ok) return { ok: false, status: 'idle' };
  if (server === 'demo') return { ok: true, status: 'demo' };
  const base = resolveBase(server);
  if (!base) return { ok: false, status: 'idle' };
  let status = 'connecting';
  return fetch(wsUrl(base, `/api/v1/stream?since=${seq}`, token), {
    // A resume's first message can carry many merged frames: allow 4 MiB a message. (An open
    // stream holds twice its ceiling of the native lanes' 64 MiB, beside a history read.)
    exactIndependentHttp: { maxResponseBytes: 4 << 20 },
    exactStream(ev) {
      if (ev.type === 'open') status = 'live';
      else if (ev.type === 'message' && typeof ev.data === 'string') {
        status = 'live';
        // A coalesced message means frames were dropped on the way in: the world has a gap.
        if ((ev as { coalesced?: number }).coalesced) status = 'reset';
        else for (const f of parseFrames(ev.data)) {
          if (!tl.ingest(f, clock)) { status = 'reset'; break; }
        }
      } else if (ev.type === 'error') {
        const e = ev as { kind?: string; message?: string };
        console.log(`stream ended: ${e.kind ?? ''} ${e.message ?? ''}`);
        status = status === 'reset' ? 'reset' : e.kind === 'Network' ? 'closed' : 'error';
      } else if (ev.type === 'close') status = status === 'reset' ? 'reset' : 'closed';
      return { ok: status === 'live', status };
    },
  });
}

function parseFrames(data: string): WireFrame[] {
  try {
    const v = JSON.parse(data);
    return Array.isArray(v) ? v : [v];
  } catch {
    return [];
  }
}

function overview(): Result<'overview'> {
  const w = tl.world;
  let building = 0, queued = 0, red = 0, appsUp = 0;
  for (const p of w.pipelines.values()) { if (p.state === 'running') building++; else if (p.state === 'pending') queued++; }
  for (const r of w.repos.values()) if (isRed(r)) red++;
  for (const a of w.apps.values()) if (a.health === 'up') appsUp++;
  const behind = tl.mode === 'live' ? '' : `${fmtDur(tl.behindMs())} behind`;
  const sentence = w.loaded
    ? `${w.repos.size} repos · ${building} building · ${queued} queued · ${red} main ${red === 1 ? 'line' : 'lines'} red · ${appsUp} of ${w.apps.size} apps up`
    : 'waiting for the fleet';
  const summary = w.loaded ? `The delivery yard: ${building} pipelines building, ${queued} queued, ${red} main ${red === 1 ? 'line' : 'lines'} red, ${appsUp} of ${w.apps.size} apps up.` : 'The delivery yard, waiting for data.';
  return {
    status: w.loaded ? 'ready' : 'waiting', mode: tl.mode, speed: tl.speed, sentence, summary, layoutKey: L?.key ?? '', repos: w.repos.size,
    building, queued, red, appsUp, appsTotal: w.apps.size, behind, seq: w.seq,
  };
}

function route(kind: string, id: string): string {
  switch (kind) {
    case 'repo': return `/mainlines?repo=${encodeURIComponent(id)}`;
    case 'app': return `/fleet?app=${encodeURIComponent(id)}`;
    case 'pr': { const [repo, n] = id.split('#'); return `/pr/${repo}/${n}`; }
    case 'commit': { const [repo, sha] = id.split('@'); return `/commit/${repo}/${sha}`; }
    case 'pipeline': {
      const p = tl.world.pipelines.get(id);
      return p ? `/commit/${p.repo}/${p.sha}` : '/';
    }
    default: return '/';
  }
}

export const sources: Sources = {
  loadToken: (_a, store: Store) => {
    const t = store.get(TOKEN) ?? '';
    return { token: t, has: t !== '' };
  },
  saveToken: ([token, set], store: Store) => {
    if (set) store.set(TOKEN, token);
    return { ok: true, status: set ? 'saved' : 'kept' };
  },
  connect: ([server, token, _gen, epoch0, offset]) => {
    liveLayer.offsetMin = offset;
    return connect(server, token, epoch0);
  },
  liveFeed: ([server, token, seq, _gen, ok]) => liveFeed(server, token, seq, ok),
  overview: ([t]) => { if (t > 0) advance(t); return overview(); },
  timeControl: async ([what, speed]) => {
    if (what === 'pause') tl.pause();
    else if (what === 'play') {
      if (tl.mode === 'replay') tl.speed = speed;
      else tl.play(speed);
    } else if (demo) await demoLive();
    else if (!tl.goLive()) await reloadLive();
    return { ok: true, status: tl.mode };
  },
  replayHour: async ([t]) => {
    if (t > 0) advance(t);
    if (!up) return { ok: false, status: 'not connected' };
    try {
      if (demo) {
        const to = Math.floor((epochAtZero + clock) / 1000) * 1000;
        const from = to - DEMO_REPLAY;
        demo = null;
        demo = await DemoUpstream.start(from);
        up = demo;
        tl.load(await demo.snapshot(), clock);
        tl.beginPlayback(from, to);
        return { ok: true, status: 'replay' };
      }
      const to = tl.liveNow();
      const from = to - 3_600_000;
      const h = await up.history(from, from + REPLAY_CHUNK);
      return { ok: tl.startReplay(h, to), status: 'replay' };
    } catch (e) {
      return { ok: false, status: String((e as Error).message ?? e) };
    }
  },
  pickAt: ([x, y]) => {
    let best: { kind: string; id: string; label: string } | null = null;
    for (const h of liveLayer.hits) if (x >= h.x && x <= h.x + h.w && y >= h.y && y <= h.y + h.h) best = h;
    if (!best) { liveLayer.selected = ''; return { kind: '', id: '', label: '', route: '' }; }
    if (best.kind === 'pipeline') liveLayer.selected = liveLayer.selected === best.id ? '' : best.id;
    return { kind: best.kind, id: best.id, label: best.label, route: route(best.kind, best.id) };
  },
  search: ([q, t]) => {
    if (t > 0) advance(t);
    return { hits: search(tl.world, q, tl.playhead).map((h) => ({ kind: h.kind, id: h.id, title: h.title, subtitle: h.subtitle, route: route(h.kind, h.id) })) };
  },
  mainlines: ([t, org, filter, q]) => mainlines(tl.world, t > 0 ? tl.playhead : tl.playhead, org, filter, q),
  prs: ([_t, org, filter, q]) => prs(tl.world, tl.playhead, org, filter, q),
  fleet: () => fleet(tl.world, tl.playhead),
  journey: async ([_s, _tok, repo, sha, t]) => {
    if (t > 0) advance(t);
    if (!repo || !sha) return journeyView(null, tl.playhead, ' ');
    try {
      const j = await cached(`j:${repo}@${sha}`, () => (up ? up.journey(repo, sha) : Promise.resolve(null)));
      return journeyView(j, tl.playhead, '', liveLayer.offsetMin);
    } catch (e) {
      return journeyView(null, tl.playhead, String((e as Error).message ?? e));
    }
  },
  prDetail: async ([_s, _tok, repo, number, t]) => {
    if (t > 0) advance(t);
    if (!repo) return prDetailView(null, tl.playhead, tl.world);
    try {
      const d = await cached(`p:${repo}#${number}`, () => (up ? up.pr(repo, Number(number)) : Promise.resolve(null)));
      return prDetailView(d, tl.playhead, tl.world);
    } catch {
      return prDetailView(null, tl.playhead, tl.world);
    }
  },
};

/** A detail fetched at most every 5 s of the module clock while its view is open (the views
 *  re-ask every 250 ms so their ages tick; the server is asked far less). */
const details = new Map<string, { at: number; p: Promise<unknown> }>();
function cached<T>(key: string, get: () => Promise<T>): Promise<T> {
  const hit = details.get(key);
  if (hit && clock - hit.at < 5000) return hit.p as Promise<T>;
  const p = get();
  details.set(key, { at: clock, p });
  p.catch(() => details.delete(key));
  if (details.size > 16) details.delete(details.keys().next().value as string);
  return p;
}

/** The host's entry: one function for every source, as `sources` names them. */
export const answer: Answer = ((source: keyof Sources, args: unknown, store: Store, storage: unknown) =>
  (sources[source] as (a: unknown, s: Store, st: unknown) => unknown)(args, store, storage)) as Answer;

// ---- canvases ------------------------------------------------------------------------------
export const surfaces: Record<string, number> = { yardStatic: 1, yardLive: 2, rowDots: 2 };

export function draw(surface: string, args: unknown[], ctx: Ctx2D, frame: Frame): boolean {
  if (surface === 'yardStatic') {
    advance(frame.time);
    const lay = ensureLayout(frame.width, frame.height);
    drawStatic(ctx, lay);
    return false;
  }
  if (surface === 'yardLive') {
    const dt = Math.max(0, Math.min(100, frame.time - lastLive));
    lastLive = frame.time;
    advance(frame.time);
    const lay = ensureLayout(frame.width, frame.height);
    motion.reduced = args[0] === 'reduced';
    motion.update(clock, tl.world, dt);
    liveLayer.draw(ctx, lay, tl, motion, clock, motion.reduced);
    return true;
  }
  if (surface === 'rowDots') {
    const r = tl.world.repos.get(String(args[0]));
    ctx.clearRect(0, 0, frame.width, frame.height);
    if (r) dotLine(ctx, r.main?.recent ?? [], 6, frame.width - 30, frame.height / 2 + 3, 15, clock, { red: isRed(r), culprit: isRed(r) ? r.main.culprit : null, r: 4.5 });
    return false;
  }
  return false;
}
