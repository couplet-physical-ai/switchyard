// Switchyard's data module. The fleet lives here: the timeline (live and shown worlds), the
// motion system and the yard's canvas layers. Contract asks small questions (sources below);
// the canvases read the world directly every frame (`draw`).

import type { Answer, Ctx2D, Frame, Result, Sources, Store } from './app.contract.d.ts';
import { HttpUpstream, resolveBase, setDefaultServer, wsUrl, type Upstream } from './src/api.ts';

// A release build bakes the team's server in (app/scripts/build-macos-release.sh sets it);
// dev and test builds leave it empty and ask on first launch.
const DEFAULT_SERVER = import.meta.env.SWITCHYARD_DEFAULT_SERVER ?? '';
setDefaultServer(DEFAULT_SERVER);
import { DEMO_REPLAY, DemoUpstream } from './src/demo.ts';
import { fleet, journeyView, prDetailView, search } from './src/project.ts';
import { MainlinesModel, stateWords } from './src/table/mainlines.ts';
import { PrsModel } from './src/table/prs.ts';
import { Timeline } from './src/timeline.ts';
import type { Frame as WireFrame } from './src/wire.ts';
import { drawStatic, LiveLayer } from './src/yard/draw.ts';
import { isRed, layout, pickMains, type Layout } from './src/yard/layout.ts';
import { Motion } from './src/yard/motion.ts';
import { fmtDur } from './src/yard/paint.ts';

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
/** The canvas tables (src/table/): one per view, alive across visits (scroll and focus kept). */
const mlTable = new MainlinesModel();
const prTable = new PrsModel();
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
  const none: Conn = { ok: false, status: 'not connected', error: '', seq: 0, label: '', kind: '', needsSetup: false, signIn: '' };
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
    const base = resolveBase(server);
    const msg = String((e as Error).message ?? e);
    // The server is there but wants a device token: its /connect page (behind SSO) mints one
    // and hands it back as a switchyard:// link.
    if (base && (/ answered 40[13]\b/.test(msg) || /refused the token|needs sign-in/.test(msg))) {
      return { ...none, status: 'sign in', error: `${base.replace(/^https?:\/\//, '')} needs a device token: sign in on the web to get one.`, needsSetup: true, signIn: `${base}/connect` };
    }
    return { ...none, status: 'offline', error: `Could not reach ${base || 'the server'}: ${msg}`, needsSetup: !base };
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

/** `switchyard://connect?server=…&token=…` (it arrives as `/connect?u=<the whole URL>`), or a
 *  web link `/connect?server=…&token=…`. Only an http(s) server or a bare host is taken, and a
 *  token of URL-safe characters; anything else leaves the link refused (ok false). */
export function parseLink(u: string, server: string, token: string): { server: string; token: string; ok: boolean } {
  let sv = server, tk = token;
  if (u) {
    sv = ''; tk = '';
    const q = u.indexOf('?');
    const query = q < 0 ? '' : u.slice(q + 1).split('#')[0];
    for (const part of query.split('&')) {
      const eq = part.indexOf('=');
      if (eq < 0) continue;
      let v = '';
      try { v = decodeURIComponent(part.slice(eq + 1).replace(/\+/g, ' ')); } catch { continue; }
      const k = part.slice(0, eq);
      if (k === 'server') sv = v; else if (k === 'token') tk = v;
    }
  }
  sv = sv.trim(); tk = tk.trim();
  const okServer = /^(https?:\/\/)?[A-Za-z0-9.-]+(:\d{1,5})?(\/[A-Za-z0-9._~\/-]*)?$/.test(sv);
  const okToken = tk === '' || /^[A-Za-z0-9._~-]{1,512}$/.test(tk);
  return okServer && okToken ? { server: sv, token: tk, ok: true } : { server: okServer ? sv : '', token: '', ok: false };
}

export const sources: Sources = {
  parseLink: ([u, server, token]) => parseLink(u, server, token),
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
  overview: ([t]) => { if (t > 0) advance(t); return safe('overview', EMPTY_OV, overview); },
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
    return safe('search', { hits: [] }, () => ({ hits: search(tl.world, q, tl.playhead).map((h) => ({ kind: h.kind, id: h.id, title: h.title, subtitle: h.subtitle, route: route(h.kind, h.id) })) }));
  },
  mainlines: ([_t, org, filter, q, focus]) => safe('mainlines', EMPTY_ML, () => mainlinesHeader(org, filter, q, focus)),
  prs: ([_t, org, filter, q, repo]) => safe('prs', EMPTY_PRS, () => prsHeader(org, filter, q, repo)),
  tablePick: ([table, x, y]) => safe('tablePick', NO_HIT, () => tablePick(table, x, y)),
  viewOnTop: ([here]) => { topView = String(here ?? ''); return { ok: true, status: topView }; },
  tableKey: ([table, key]) => safe('tableKey', NO_HIT, () => tableKey(table, key)),
  fleet: () => safe('fleet', EMPTY_FLEET, () => fleet(tl.world, tl.playhead)),
  journey: async ([_s, _tok, repo, sha, t]) => {
    if (t > 0) advance(t);
    if (!repo || !sha) return journeyView(null, tl.playhead, ' ');
    try {
      const j = await cached(`j:${repo}@${sha}`, () => (up ? up.journey(repo, sha) : Promise.resolve(null)));
      return journeyView(j, tl.playhead, '', liveLayer.offsetMin);
    } catch (e) {
      return journeyView(null, tl.playhead, String((e as Error)?.message ?? e));
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

// ---- the canvas tables' sources --------------------------------------------------------------
// Contract asks for headers (counts, a tick that changes when the rows or their words do) every
// 250 ms; the rows themselves are projected once per world change and filter, and painted by
// the canvas, only those in view.

type Ml = Result<'mainlines'>;
type Pl = Result<'prs'>;
const EMPTY_ML: Ml = { total: 0, red: 0, building: 0, shown: 0, tick: 0, top: '', atEnd: false, focusText: '', focusShown: false, summary: 'Main lines' };
const EMPTY_PRS: Pl = { open: 0, ready: 0, blocked: 0, bots: 0, total: 0, tick: 0, top: '', atEnd: false, summary: 'Pull requests', repo: '' };
const NO_HIT = { kind: '', id: '', label: '', route: '' };
const EMPTY_OV: Result<'overview'> = {
  status: 'waiting', mode: 'live', speed: 1, sentence: 'waiting for the fleet', summary: 'The delivery yard, waiting for data.', layoutKey: '', repos: 0,
  building: 0, queued: 0, red: 0, appsUp: 0, appsTotal: 0, behind: '', seq: 0,
};
const EMPTY_FLEET = { apps: [], engines: [], queues: [], stats: [], up: 0, total: 0, down: 0, degraded: 0, attention: [], behindN: 0, never: 0, hasLatency: false, watcher: '', watcherTripped: false };

/** A source that throws answers its empty value instead (and says so once in the log): a sparse
 *  or surprising entity costs a view its rows, never the app. */
const warned = new Set<string>();
function safe<T>(name: string, empty: T, f: () => T): T {
  try {
    return f();
  } catch (e) {
    if (!warned.has(name)) { warned.add(name); console.log(`${name}: ${(e as Error)?.stack ?? e}`); }
    return empty;
  }
}

/** Changes when the rows change, and each second (their ages): what the canvas redraws on. */
const tickOf = (seq: number) => seq * 100_000 + (Math.floor(tl.playhead / 1000) % 100_000);

function mainlinesHeader(org: string, filter: string, q: string, focus: string): Ml {
  const now = tl.playhead;
  mlTable.project(tl.world, org, filter, q);
  const c = mlTable.counts;
  const row = focus ? mlTable.row(focus) : undefined;
  const focusText = row ? `${row.r.name ?? row.id} · ${stateWords(row, now)}` : '';
  return {
    total: c.total, red: c.red, building: c.building, shown: c.shown, tick: tickOf(mlTable.seq), top: mlTable.table.topKey(), atEnd: mlTable.table.atEnd(), focusText,
    focusShown: !!focus && mlTable.table.visible(focus),
    summary: `Main lines: ${c.shown} repos, ${c.red} red, ${c.building} building.${focusText ? ` Focused: ${focusText}.` : ''} Arrow keys move, Return opens.`,
  };
}

function prsHeader(org: string, filter: string, q: string, repo: string): Pl {
  prTable.project(tl.world, org, filter, q, repo);
  const c = prTable.counts;
  return {
    ...c, tick: tickOf(prTable.seq), top: prTable.table.topKey(), atEnd: prTable.table.atEnd(), repo,
    summary: `Pull requests: ${c.total} shown, ${c.open} open, ${c.ready} ready to merge, ${c.blocked} blocked. Arrow keys move, Return opens.`,
  };
}

function tableOf(name: string): MainlinesModel | PrsModel {
  return name === 'prs' ? prTable : mlTable;
}

/** A press on a table: an open row's own target (a link, a dot), else the row. */
function tablePick(name: string, x: number, y: number) {
  const m = tableOf(name);
  const p = m.table.pick(x, y);
  if (!p) return NO_HIT;
  if (p.sub) return { kind: p.sub.kind, id: p.sub.id, label: p.sub.label, route: p.sub.route };
  return { kind: 'row', id: p.key, label: p.key, route: m.routeOf(p.key) };
}

/** A key on a table: arrows move the focus, Return opens it, the page keys scroll. */
function tableKey(name: string, key: string) {
  const m = tableOf(name);
  const t = m.table;
  const focus = (id: string) => ({ kind: 'focus', id, label: id, route: '' });
  switch (key) {
    case 'ArrowDown': case 'j': return focus(t.neighbour(1));
    case 'ArrowUp': case 'k': return focus(t.neighbour(-1));
    case 'PageDown': case ' ': t.scrollBy(t.H * 0.9); return { ...NO_HIT, kind: 'scroll' };
    case 'PageUp': t.scrollBy(-t.H * 0.9); return { ...NO_HIT, kind: 'scroll' };
    case 'Home': t.scrollTo(0); return focus(t.keys[0] ?? '');
    case 'End': t.scrollTo(Infinity); return focus(t.keys.at(-1) ?? '');
    case 'Escape': return focus('');
    case 'Enter': return t.focus ? { kind: 'open', id: t.focus, label: t.focus, route: m.routeOf(t.focus) } : NO_HIT;
    default: return NO_HIT;
  }
}

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
export const surfaces: Record<string, number> = { yardStatic: 1, yardLive: 2, mainlinesTable: 9, prsTable: 9 };

/** The route on top (`viewOnTop`). The yard stays mounted under every other view; its live
 *  layer animating there cost 3-4× the ops of the view on top. Covered, it is not drawn (the
 *  canvas keeps its last pixels) and asks for frames still, so it resumes on its first frame. */
let topView = '';

export function draw(surface: string, args: unknown[], ctx: Ctx2D, frame: Frame): boolean {
  if (surface === 'yardLive' && topView !== '' && topView !== 'yard') return true;
  try {
    return drawSurface(surface, args, ctx, frame);
  } catch (e) {
    // A draw that throws paints a line saying so, and the app goes on.
    if (!warned.has(`draw:${surface}`)) { warned.add(`draw:${surface}`); console.log(`draw ${surface}: ${(e as Error)?.stack ?? e}`); }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.clearRect(0, 0, frame.width, frame.height);
    ctx.font = "12px 'Commit Mono', ui-monospace, monospace";
    ctx.fillStyle = '#8A8A8A';
    ctx.fillText(`This view could not be drawn: ${String((e as Error)?.message ?? e).slice(0, 120)}`, 16, 24);
    return false;
  }
}

function drawSurface(surface: string, args: unknown[], ctx: Ctx2D, frame: Frame): boolean {
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
  if (surface === 'mainlinesTable') {
    // (tick, focus, wheel, px, py, org, filter, q, kick)
    const [, focus, wheel, px, py, org, filter, q] = args as [number, string, number, number, number, string, string, string, number];
    mlTable.project(tl.world, String(org ?? ''), String(filter ?? ''), String(q ?? ''));
    const t = mlTable.table;
    t.syncWheel(Number(wheel) || 0);
    t.pointer(Number(px), Number(py));
    t.setFocus(String(focus ?? ''));
    return mlTable.draw(ctx, frame, tl.playhead, tl.world.loaded);
  }
  if (surface === 'prsTable') {
    // (tick, focus, wheel, px, py, filter, q, repo, kick)
    const [, focus, wheel, px, py, filter, q, repo] = args as [number, string, number, number, number, string, string, string, number];
    prTable.project(tl.world, '', String(filter ?? ''), String(q ?? ''), String(repo ?? ''));
    const t = prTable.table;
    t.syncWheel(Number(wheel) || 0);
    t.pointer(Number(px), Number(py));
    t.setFocus(String(focus ?? ''));
    return prTable.draw(ctx, frame, tl.playhead, tl.world.loaded);
  }
  return false;
}
