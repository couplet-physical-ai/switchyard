// Switchyard's data module. The fleet lives here: the timeline (live and shown worlds), the
// motion system and the yard's canvas layers. Contract asks small questions (sources below);
// the canvases read the world directly every frame (`draw`).

import type { Answer, Ctx2D, Frame, Result, Sources, Store } from './app.contract.d.ts';
import { HttpUpstream, resolveBase, setDefaultServer, wsUrl, type Upstream } from './src/api.ts';

// A release build bakes the team's server in (app/scripts/build-macos-release.sh sets it);
// dev and test builds leave it empty and ask on first launch.
const DEFAULT_SERVER = import.meta.env.SWITCHYARD_DEFAULT_SERVER ?? '';
const WEB_SHA = import.meta.env.SWITCHYARD_WEB_SHA ?? '';
setDefaultServer(DEFAULT_SERVER);
import { DEMO_REPLAY, DemoUpstream } from './src/demo.ts';
import { EngineHistory } from './src/enginehist.ts';
import { bindInsights } from './src/insights.ts';
import { drawFleetLoad } from './src/fleetload.ts';
import { fleet, journeyView, prDetailView, search } from './src/project.ts';
import { MainlinesModel, stateWords } from './src/table/mainlines.ts';
import { PrsModel } from './src/table/prs.ts';
import { Timeline } from './src/timeline.ts';
import { updateDo, updateState } from './src/update.ts';
import type { Frame as WireFrame } from './src/wire.ts';
import { Yard } from './src/yard/draw.ts';
import { Factory } from './src/factory/factory.ts';
import { isRed } from './src/yard/layout.ts';
import { dotLine, fmtDur } from './src/yard/paint.ts';
import { buildingIds, queueTruth } from './src/yard/select.ts';

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
/** The module clock: the runner's ms, as draws and beats report it. */
let clock = 0;
let epochAtZero = 0;
let up: Upstream | null = null;
let demo: DemoUpstream | null = null;
let seenEpoch = -1;
/** The yard: scene, LOD, frame budget, packet pool (src/yard/draw.ts). */
const yard = new Yard(tl);
/** The factory floor (src/factory/): the default view, the same world. */
const factory = new Factory(tl);
factory.hud = yard.hud;
/** Stress mode (a 10× synthetic fleet for the renderers): one switch for the yard and the floor. */
let stressOn = false;
function setStress(on: boolean): void { stressOn = on; yard.setStress(on); factory.setStress(on); }
tl.listener = (e, w) => { yard.pool.onEvent(e, w, clock); factory.onEvent(e, w, clock); };
/** The canvas tables (src/table/): one per view, alive across visits (scroll and focus kept). */
const mlTable = new MainlinesModel();
/** The engines' cpu/mem/load, the last few minutes of it (the Fleet view's sparklines). */
const engineHist = new EngineHistory();
/** The Factory Floor's data seam (src/insights.ts): v0.5 tables, or approximations on v0.4. */
bindInsights(tl, () => up, engineHist);
const prTable = new PrsModel();

/** `asking`: called from a source's answer, so it may fetch (a fetch started elsewhere, in
 *  `draw` or a promise's continuation, is never run). */
function advance(t: number, asking = true): void {
  if (t > clock) clock = t;
  tl.tick(clock);
  engineHist.sample(tl.world);
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
  } else if (!asking) {
    // draw: no requests from here; the next answer asks
  } else if (tl.replayDone()) {
    void reloadLive();
  } else if (rebaseAt && up?.snapshotAt && !chunking) {
    const at = rebaseAt, u = up;
    rebaseAt = 0;
    chunking = u.snapshotAt!(at).then((s) => { if (s) tl.rebaseReplay(s); }, () => { rebaseAt = at; }).finally(() => { chunking = null; });
  } else {
    const next = tl.replayWants(REPLAY_LOOKAHEAD);
    if (next) void fetchChunk(next);
  }
  if (tl.epoch !== seenEpoch) {
    seenEpoch = tl.epoch;
    yard.sync(clock);
  }
}

/** A replay streams in chunks of server time, fetched this far ahead of the playhead, each
 *  reply bounded by REPLAY_CEILING: an hour of real history can be ~30 MB (a server's boot
 *  burst), far more than the native data module's 64 MiB heap holds beside the world. A chunk
 *  over the ceiling is refused before any of it is read, and the window halves; quiet
 *  stretches grow it back. A window that will not fit even at REPLAY_MIN jumps over the gap
 *  with `/snapshot?at=`. */
const REPLAY_MAX = 6 * 60_000;
const REPLAY_MIN = 5_000;
const REPLAY_LOOKAHEAD = 60_000;
const REPLAY_CEILING = 1536 << 10;
let chunkMs = 60_000;
let chunking: Promise<void> | null = null;
/** A window that will not fit even at REPLAY_MIN: jump the replay to the fleet at this time. */
let rebaseAt = 0;
const refused = (e: unknown) => /refus|ceiling|exceeds/i.test(`${(e as { kind?: string }).kind ?? ''} ${(e as Error).message ?? e}`);
function fetchChunk(from: number): Promise<void> {
  if (!up || demo || chunking) return chunking ?? Promise.resolve();
  const to = Math.min(from + chunkMs, tl.replayTo);
  chunking = up.history(from, to, false, REPLAY_CEILING).then(
    (h) => {
      tl.appendReplay(h);
      const bytes = h.bytes ?? 0;
      if (bytes < REPLAY_CEILING / 4) chunkMs = Math.min(REPLAY_MAX, Math.round(chunkMs * 1.5));
      else if (bytes > REPLAY_CEILING / 2) chunkMs = Math.max(REPLAY_MIN, Math.floor(chunkMs / 2));
    },
    (e) => {
      if (!refused(e)) return; // the network: asked again by the next answer
      if (chunkMs > REPLAY_MIN) { chunkMs = Math.max(REPLAY_MIN, Math.floor(chunkMs / 2)); return; }
      console.log(`replay: ${Math.round((to - from) / 1000)} s from ${from} is over ${REPLAY_CEILING >> 10} KB; jumping it`);
      rebaseAt = to;
    },
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
      yard.sync(clock);
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
    yard.sync(clock);
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

/** The server as a person names it: its host, never a loopback address. */
function hostLabel(): string {
  if (!up) return '';
  if (up.kind === 'demo') return 'built-in demo';
  const m = /^(\[[^\]]+\]|[^/:]+)(?::(\d+))?/.exec(up.label);
  const host = m?.[1] ?? up.label, port = m?.[2];
  if (/^(localhost|127\.\d+\.\d+\.\d+|0\.0\.0\.0|\[::1?\])$/i.test(host)) return port ? `local server :${port}` : 'local server';
  return host;
}

function overview(): Result<'overview'> {
  const w = tl.world;
  // Never builds the scene here (a source turn has 100 ms on Hermes): the first draw does.
  const S = yard.S;
  // One truth for building and queued: the yard, the status line and the QUEUE band agree.
  const building = buildingIds(w).size;
  const queued = queueTruth(w).waiting;
  let red = 0, appsUp = 0;
  for (const r of w.repos.values()) if (isRed(r)) red++;
  for (const a of w.apps.values()) if (a.health === 'up') appsUp++;
  const behind = tl.mode === 'live' ? '' : `${fmtDur(tl.behindMs())} behind`;
  const sentence = w.loaded
    ? `${w.repos.size} repos · ${building} building · ${queued} queued · ${red} main ${red === 1 ? 'line' : 'lines'} red · ${appsUp} of ${w.apps.size} apps up`
    : 'waiting for the fleet';
  const summary = w.loaded ? `The delivery yard: ${building} pipelines building, ${queued} queued, ${red} main ${red === 1 ? 'line' : 'lines'} red, ${appsUp} of ${w.apps.size} apps up.` : 'The delivery yard, waiting for data.';
  const k = S?.k ?? 1;
  const dial = tl.mode === 'replay' ? `replaying · ${Math.round(tl.replayProgress() * 60)} of 60 min` : tl.mode === 'paused' ? `paused · 1 hour, sped up` : '1 hour, sped up';
  return {
    status: w.loaded ? 'ready' : 'waiting', mode: tl.mode, speed: tl.speed, sentence, summary, layoutKey: `${S?.key ?? ''}|${yard.budget.quality >= 3 ? 'lo' : 'hi'}`, repos: w.repos.size,
    building, queued, red, appsUp, appsTotal: w.apps.size, behind, seq: w.seq,
    tick: Math.floor(clock / 250), host: hostLabel(), dial, dialPad: Math.round(((S?.m ?? 16) + 22) * k), dialFont: Math.round(11 * k), dialH: Math.round(34 * k),
    hud: yard.hud.on, stress: stressOn, quality: yard.budget.quality, facKey: factory.floorKey,
    facDrawer: factory.selected !== '', facQ: factory.budget.quality, facStress: factory.stress.on, facCalm: factory.calm, facStats: factory.statsLine(), ...factory.counts(),
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

/** Is the page older than the web build the server now serves? Web only (a native app has no
 *  page origin), and only a build that knows its own commit (app/scripts/build.sh web). */
async function webVersion(): Promise<{ stale: boolean; served: string }> {
  const origin = (globalThis as { origin?: unknown }).origin;
  if (!WEB_SHA || typeof origin !== 'string' || !/^https?:\/\//.test(origin)) return { stale: false, served: '' };
  try {
    const r = await fetch(`${origin}/api/v1/meta`, { headers: { accept: 'application/json' } });
    if (!r.ok) return { stale: false, served: '' };
    const m = (await r.json()) as { web?: { sha?: string } | null };
    const served = m.web?.sha ?? '';
    return { stale: !!served && served !== WEB_SHA, served };
  } catch {
    return { stale: false, served: '' };
  }
}

export const sources: Sources = {
  webVersion: () => webVersion(),
  parseLink: ([u, server, token]) => parseLink(u, server, token),
  updateState: (_a, _store, _storage, native) => updateState(native),
  updateDo: ([op], _store, _storage, native) => updateDo(op, native),
  loadToken: (_a, store: Store) => {
    const t = store.get(TOKEN) ?? '';
    return { token: t, has: t !== '' };
  },
  saveToken: ([token, set], store: Store) => {
    if (set) store.set(TOKEN, token);
    return { ok: true, status: set ? 'saved' : 'kept' };
  },
  connect: ([server, token, _gen, epoch0, offset]) => {
    yard.offsetMin = offset;
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
      chunkMs = 60_000;
      // The fleet at `from` (v0.3), then frames only: never a base inside a big window.
      const base = up.snapshotAt ? await up.snapshotAt(from).catch(() => null) : null;
      const h = base ? { from, to: from, base, frames: [] } : await up.history(from, from + 60_000, true, 12 << 20);
      return { ok: tl.startReplay(h, to), status: 'replay' };
    } catch (e) {
      return { ok: false, status: String((e as Error).message ?? e) };
    }
  },
  pickAt: ([x, y]) => {
    const k = yard.S?.k ?? 1;
    const best = yard.hitAt(x / k, y / k);
    if (!best) { yard.selected = ''; return { kind: '', id: '', label: '', route: '' }; }
    if (best.kind === 'pipeline') yard.selected = yard.selected === best.id ? '' : best.id;
    else if (best.kind === 'stress') setStress(!stressOn);
    else if (best.kind === 'quality') yard.budget.pinned = yard.budget.pinned >= 4 ? -1 : yard.budget.pinned + 1;
    return { kind: best.kind, id: best.id, label: best.label, route: route(best.kind, best.id) };
  },
  hoverAt: ([x, y]) => {
    const k = yard.S?.k ?? 1;
    const h = yard.hoverAt(x < 0 ? -1 : x / k, y / k, clock);
    return h ? { kind: h.kind, id: h.id, label: h.label, route: '' } : { kind: '', id: '', label: '', route: '' };
  },
  facPointer: ([kind, x, y, buttons]) => {
    const h = factory.pointer(String(kind), Number(x), Number(y), Number(buttons) || 0, clock);
    // the HUD's buttons are floor hits too
    if (kind === 'up' && h?.kind === 'stress') setStress(!stressOn);
    else if (kind === 'up' && h?.kind === 'quality') factory.budget.pinned = factory.budget.pinned >= 4 ? -1 : factory.budget.pinned + 1;
    // a newly picked crate: fetch its journey for the drawer (a source may fetch; a draw never does)
    const sel = factory.selected;
    if (sel && factory.journeyFor !== sel && up) {
      const cm = factory.selCommit();
      factory.journeyFor = sel;
      if (cm) void cached(`j:${cm.repo}@${cm.sha}`, () => up!.journey(cm.repo, cm.sha)).then((j) => { if (factory.journeyFor === sel) factory.journey = j; }, () => {});
    }
    factory.offsetMin = yard.offsetMin;
    return { kind: h?.kind ?? '', id: h?.id ?? '', label: h?.label ?? '', route: `${factory.cam.key}|${factory.selected}` };
  },
  // fab-lens: the coffee check's last visit per server (src/factory/coffee.ts), kept by Contract
  coffeeOpen: ([server, visits, _seq, ok]) => ({ ok: !!ok, status: safe('coffeeOpen', '', () => factory.coffee.open(String(server ?? ''), String(visits ?? ''), !!ok)) }),
  coffeeMark: ([server, visits]) => {
    const v = safe('coffeeMark', '', () => factory.coffee.mark(String(server ?? ''), String(visits ?? '')));
    return { ok: v !== '', status: v };
  },
  // fab-lens: a time-strip tick replays from that moment at 60×
  replayAt: async ([t, at]) => {
    if (t > 0) advance(t);
    if (!up) return { ok: false, status: 'not connected' };
    const to = demo ? Math.floor((epochAtZero + clock) / 1000) * 1000 : tl.liveNow();
    const from = Math.min(to - 60_000, Math.max(to - 24 * 3_600_000, Number(at) || to - 3_600_000));
    try {
      if (demo) {
        demo = null;
        demo = await DemoUpstream.start(from);
        up = demo;
        tl.load(await demo.snapshot(), clock);
        tl.beginPlayback(from, to);
        return { ok: true, status: 'replay' };
      }
      chunkMs = 60_000;
      const base = up.snapshotAt ? await up.snapshotAt(from).catch(() => null) : null;
      const h = base ? { from, to: from, base, frames: [] } : await up.history(from, from + 60_000, true, 12 << 20);
      return { ok: tl.startReplay(h, to), status: 'replay' };
    } catch (e) {
      return { ok: false, status: String((e as Error).message ?? e) };
    }
  },
  devToggle: ([what, on]) => {
    if (what === 'hud') yard.hud.on = on === 1;
    else if (what === 'stress') setStress(on === 1);
    return { ok: true, status: `${what} ${on === 1 ? 'on' : 'off'}` };
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
  fleet: () => safe('fleet', EMPTY_FLEET, () => ({ ...fleet(tl.world, tl.playhead), loadTick: engineHist.ver })),
  journey: async ([_s, _tok, repo, sha, t]) => {
    if (t > 0) advance(t);
    if (!repo || !sha) return journeyView(null, tl.playhead, ' ');
    try {
      const j = await cached(`j:${repo}@${sha}`, () => (up ? up.journey(repo, sha) : Promise.resolve(null)));
      return journeyView(j, tl.playhead, '', yard.offsetMin);
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
  tick: 0, host: '', dial: '1 hour, sped up', dialPad: 38, dialFont: 11, dialH: 34, hud: false, stress: false, quality: 0, facKey: '', facDrawer: false, facQ: 0, facStress: false, facCalm: true, facStats: '', facCity: 0, facCars: 0, facBays: 0, facLens: 0, facLensTop: '',
};
const EMPTY_FLEET = {
  apps: [], engines: [], queues: [], stats: [], up: 0, total: 0, down: 0, degraded: 0, attention: [], behindN: 0, never: 0, hasLatency: false, watcher: '', watcherTripped: false,
  hosts: [], loadRows: 0, loadH: 0, deploysN: '', deploysText: '', deploysVia: '', deployBars: [], deployMax: 0, lanes: [], lanesTotal: 0, lanesNote: '', loadTick: 0,
};

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
export const answer: Answer = ((source: keyof Sources, args: unknown, store: Store, storage: unknown, native?: unknown) =>
  (sources[source] as (a: unknown, s: Store, st: unknown, n: unknown) => unknown)(args, store, storage, native)) as Answer;

// ---- canvases ------------------------------------------------------------------------------
/** Surface → its arity (Contract passes that many arguments); the tables' lifetime is 9. */
export const surfaces: Record<string, number> = { factoryFloor: 3, factoryLive: 4, yardStatic: 2, yardInfo: 2, yardLive: 3, yardTop: 2, mainlinesTable: 9, prsTable: 9, fleetLoad: 2 };

/** The route on top (`viewOnTop`). The yard stays mounted under every other view; its live
 *  layer animating there cost 3-4× the ops of the view on top. Covered, it is not drawn (the
 *  canvas keeps its last pixels) and asks for frames still, so it resumes on its first frame. */
let topView = '';

export function draw(surface: string, args: unknown[], ctx: Ctx2D, frame: Frame): boolean {
  if ((surface === 'yardLive' || surface === 'yardInfo' || surface === 'yardTop') && topView !== '' && topView !== 'yard') return true;
  // Covered, the floor's live layer sleeps; the 250 ms tick (a surface argument) wakes it when
  // it is on top again.
  if (surface === 'factoryLive' && topView !== '' && topView !== 'factory') return false;
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
  if (surface === 'factoryFloor') {
    advance(frame.time, false);
    factory.wheel(Number(args[2]) || 0);
    const flying = factory.cam.step(frame.time);
    return factory.drawFloor(ctx, frame, clock) || flying;
  }
  if (surface === 'factoryLive') {
    advance(frame.time, false);
    factory.reduced = args[0] === 'reduced';
    return factory.drawLive(ctx, frame, clock, Number(args[2]) || 0);
  }
  if (surface === 'yardStatic') {
    advance(frame.time, false);
    yard.drawStatic(ctx, frame, clock);
    return false;
  }
  if (surface === 'yardInfo') {
    advance(frame.time, false);
    return yard.drawInfo(ctx, frame, clock);
  }
  if (surface === 'yardLive') {
    advance(frame.time, false);
    yard.reduced = args[0] === 'reduced';
    return yard.drawLive(ctx, frame, clock);
  }
  if (surface === 'yardTop') {
    advance(frame.time, false);
    return yard.drawTop(ctx, frame, clock);
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
  if (surface === 'fleetLoad') {
    advance(frame.time, false);
    return drawFleetLoad(ctx, frame, tl.world, engineHist);
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
