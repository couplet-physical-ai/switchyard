// Switchyard's data module. The fleet lives here: the timeline (live and shown worlds), the
// motion system and the yard's canvas layers. Contract asks small questions (sources below);
// the canvases read the world directly every frame (`draw`).

import type { Answer, Ctx2D, Frame, Result, Sources, Store } from './app.contract.d.ts';
import { HttpUpstream, resolveBase, wsUrl, type Upstream } from './src/api.ts';
import { DemoUpstream } from './src/demo.ts';
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
  if (demo) {
    const frames = demo.pump(epochAtZero + clock);
    for (const f of frames) tl.ingest(f, clock);
  }
  tl.tick(clock);
  if (tl.epoch !== seenEpoch) {
    seenEpoch = tl.epoch;
    motion.sync(tl.shown);
  }
}

function ensureLayout(w: number, h: number): Layout {
  const world = tl.shown;
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
      const start = Math.floor((epoch0 + clock) / 1000) * 1000;
      if (!demo || demo.now < start - 3_600_000) demo = new DemoUpstream(start);
      up = demo;
      tl.load(await demo.snapshot(), clock);
      motion.sync(tl.shown);
      return { ...none, ok: true, status: 'demo', seq: tl.live.seq, label: demo.label, kind: 'demo' };
    }
    demo = null;
    const base = resolveBase(server);
    if (!base) {
      up = null;
      return { ...none, status: 'not connected', needsSetup: true };
    }
    up = new HttpUpstream(base, token);
    const snap = await up.snapshot();
    tl.load(snap, clock);
    motion.sync(tl.shown);
    return { ...none, ok: true, status: 'connected', seq: tl.live.seq, label: up.label, kind: 'http' };
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
    exactStream(ev) {
      if (ev.type === 'open') status = 'live';
      else if (ev.type === 'message' && typeof ev.data === 'string') {
        status = 'live';
        for (const f of parseFrames(ev.data)) {
          if (!tl.ingest(f, clock)) { status = 'reset'; break; }
        }
      } else if (ev.type === 'error') status = 'error';
      else if (ev.type === 'close') status = status === 'reset' ? 'reset' : 'closed';
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
  const w = tl.shown;
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
      const p = tl.shown.pipelines.get(id);
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
  connect: ([server, token, _gen, epoch0]) => connect(server, token, epoch0),
  liveFeed: ([server, token, seq, _gen, ok]) => liveFeed(server, token, seq, ok),
  overview: ([t]) => { if (t > 0) advance(t); return overview(); },
  timeControl: ([what, speed]) => {
    if (what === 'pause') tl.pause();
    else if (what === 'play') tl.play(speed);
    else tl.goLive();
    return { ok: true, status: tl.mode };
  },
  replayHour: async ([t]) => {
    if (t > 0) advance(t);
    if (!up) return { ok: false, status: 'not connected' };
    const to = tl.liveNow();
    try {
      const h = await up.history(to - 3_600_000, to);
      return { ok: tl.startReplay(h, null), status: 'replay' };
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
    return { hits: search(tl.shown, q, tl.playhead).map((h) => ({ kind: h.kind, id: h.id, title: h.title, subtitle: h.subtitle, route: route(h.kind, h.id) })) };
  },
  mainlines: ([t, org, filter, q]) => mainlines(tl.shown, t > 0 ? tl.playhead : tl.playhead, org, filter, q),
  prs: ([_t, org, filter, q]) => prs(tl.shown, tl.playhead, org, filter, q),
  fleet: () => fleet(tl.shown, tl.playhead),
  journey: async ([_s, _tok, repo, sha]) => {
    if (!repo || !sha) return journeyView(null, tl.playhead, ' ');
    try {
      return journeyView(up ? await up.journey(repo, sha) : null, tl.playhead);
    } catch (e) {
      return journeyView(null, tl.playhead, String((e as Error).message ?? e));
    }
  },
  prDetail: async ([_s, _tok, repo, number]) => {
    if (!repo) return prDetailView(null, tl.playhead, tl.shown);
    try {
      return prDetailView(up ? await up.pr(repo, Number(number)) : null, tl.playhead, tl.shown);
    } catch {
      return prDetailView(null, tl.playhead, tl.shown);
    }
  },
};

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
    motion.update(clock, tl.shown, dt);
    liveLayer.draw(ctx, lay, tl, motion, clock, motion.reduced);
    return true;
  }
  if (surface === 'rowDots') {
    const r = tl.shown.repos.get(String(args[0]));
    ctx.clearRect(0, 0, frame.width, frame.height);
    if (r) dotLine(ctx, r.main?.recent ?? [], 6, frame.width - 30, frame.height / 2 + 3, 15, clock, { red: isRed(r), culprit: isRed(r) ? r.main.culprit : null, r: 4.5 });
    return false;
  }
  return false;
}
