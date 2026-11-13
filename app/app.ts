// Switchyard's data module. The fleet lives here: the timeline (live and shown worlds), the
// motion system and the yard's canvas layers. Contract asks small questions (sources below);
// the canvases read the world directly every frame (`draw`).

import type { Answer, Ctx2D, Frame, NativeModule, Result, Sources, Store } from './app.contract.d.ts';
import { HttpUpstream, resolveBase, setDefaultServer, wsUrl, type Upstream } from './src/api.ts';

// A release build bakes the team's server in (app/scripts/build-macos-release.sh passes the
// build's SWITCHYARD_DEFAULT_SERVER); dev and test builds leave it empty and ask on first launch.
const DEFAULT_SERVER = import.meta.env.SWITCHYARD_DEFAULT_SERVER ?? '';
const WEB_SHA = import.meta.env.SWITCHYARD_WEB_SHA ?? '';
const WEB_TREE = import.meta.env.SWITCHYARD_WEB_TREE ?? '';
// The watched orgs in display order (the server's SWITCHYARD_ORGS, baked in by the build);
// unset, the demo fleet's order.
const ORGS = import.meta.env.SWITCHYARD_ORGS ?? '';
setDefaultServer(DEFAULT_SERVER);
setOrgOrder(ORGS);
import { DEMO_REPLAY, DemoUpstream } from './src/demo.ts';
import { EngineHistory } from './src/enginehist.ts';
import { bindInsights } from './src/insights.ts';
import { search } from './src/project.ts';
import { RING, feedTicking, feedUntil, nowSources } from './src/now/view.ts';
import { Board3 } from './src/factory3/board.ts';
import { NO_F3, f3Detail, tidyLog } from './src/factory3/inspect.ts';
import { logOf } from './src/factory3/log.ts';
import { logHeap, logRoute, noteFrame } from './src/memlog.ts';
import { probeAsk, probeFlush, probeInside, probeWrap, probing } from './src/heapprobe.ts'; // leak: SWITCHYARD_HEAPLOG=1:<mode> (macOS)
import { nextChunkMs, replaySizing, Timeline } from './src/timeline.ts';
import { connectedWith, saveTokenFile, takeTokenFile, tokenFileReport } from './src/hooks.ts';
import { updateDo, updateState } from './src/update.ts';
import type { Frame as WireFrame } from './src/wire.ts';
import { Yard } from './src/yard/draw.ts';
import { InfoLayer } from './src/yard/info.ts';
import { setOrgOrder } from './src/yard/select.ts';
import { totals } from './src/totals.ts';
import { isRed } from './src/yard/layout.ts';
import { dotLine, fmtDur } from './src/yard/paint.ts';
import { buildingIds, queueTruth } from './src/yard/select.ts';

// fx-kc: no `secret.keep`. Exact reads every kept secret synchronously before boot, and a
// Keychain item an older ad-hoc build made held 0.1.2's launch windowless behind its prompt. The
// app's own module keeps the token instead, read once, async ("the token" below).
export const grants = [
  'net.fetch https:',
  'net.fetch http:',
  'net.websocket wss:',
  'net.websocket ws:',
].join('\n');

// ---- the token (fx-kc; README "Security") ---------------------------------------------------
// The device token lives in the platform module: macOS a 0600 file (modules/apple/Keychain.swift,
// moved once from the Keychain item older builds kept), the web `localStorage` under the key
// Exact used (modules/web/index.js). It is read ONCE, through `native.later`, so a Keychain
// prompt never holds the boot: the window is up and the floor drawn while it waits. It stays in
// this module's memory: Contract sees `tok` {ver, has, status, detail} only, and no answer,
// argument or log line carries it (README "Tokens never sit in kept answers").
type TokStatus = 'loading' | 'ready' | 'none' | 'denied' | 'error';
type Native = NativeModule | null | undefined;
let token = '';
let tokStatus: TokStatus = 'loading';
let tokDetail = '';
/** The read in flight or done; null before the first ask. */
let tokLoad: Promise<Asked> | null = null;
let tokLoads = 0;
/** Saves this launch: a read that started before one is let go (the saved token wins). */
let tokSaves = 0;
let tokAsked = { gen: -1, hook: '' };
/** The old Keychain item may still be there (macOS refused its delete): Settings says so. */
let kcLeft = false;

/** Answers waiting for the token: woken by the read landing, or by a save (Enter token, the
 *  hook) while the read still waits on macOS's prompt. */
const tokWaiters: Array<() => void> = [];
function untilToken(): Promise<void> {
  return new Promise((res) => { tokWaiters.push(res); });
}
const wakeTokWaiters = () => tokWaiters.splice(0).forEach((wake) => wake());
/** How one ask ended for its asker: it counted, a newer ask superseded it, or the answer that
 *  asked was let go (so a fetch it makes is refused: Exact's "let go" / "never run"). */
type Asked = 'done' | 'stale' | 'let-go';
const LET_GO = /let[- ]go|never run/i;

/** Until the token is known (read, or saved meanwhile). A waiter asks again when the ask in
 *  flight was let go with the answer that made it; when its OWN ask is let go, this answer was let
 *  go too, and it stops: an answer Exact let go never spins asking. */
async function tokenKnown(native: Native, simulate = ''): Promise<void> {
  while (tokStatus === 'loading') {
    if (!tokLoad) {
      if ((await readToken(native, simulate)) === 'let-go') throw new Error('the answer was let go while the token was read');
      continue;
    }
    await untilToken(); // a superseded or let-go read wakes it too
  }
}

/** One `tokenGet`, asked by `tok` (whose arguments change only on a save or "Try again"), or
 *  by whichever answer waits first. A `native.later` belongs to the answer that asked it and is
 *  refused when that answer is let go, as a connect's was when the hook changed the server
 *  (fx-kc, seen on the mini): then it is asked again from a waiting answer's own turn (an async
 *  function resumes in its answer's turn) or the next ask. The module's read goes on meanwhile,
 *  and the next `tokenGet` waits behind it and finds its file. */
function readToken(native: Native, simulate = ''): Promise<Asked> {
  const mine = ++tokLoads;
  const saves = tokSaves;
  tokStatus = 'loading';
  tokDetail = '';
  let asked: Promise<Record<string, unknown>>;
  try {
    asked = native?.available ? native.later(simulate ? { op: 'tokenGet', simulate } : { op: 'tokenGet' }) : Promise.resolve({ status: 'none' });
  } catch (e) {
    asked = Promise.resolve({ status: 'error', detail: String((e as Error)?.message ?? e) });
  }
  const p = asked.then(
    (r): Record<string, unknown> => r ?? {},
    (e): Record<string, unknown> => ({ status: 'error', detail: String((e as Error)?.message ?? e) }),
  ).then((r): Asked => {
    if (mine !== tokLoads) return 'stale'; // a newer read is the one that counts
    if (saves === tokSaves && r.status === 'error' && LET_GO.test(String(r.detail ?? ''))) {
      // the answer that asked was let go (its reply with it): still loading; the waiting
      // answers, or the next ask, ask again, and the module's read goes on meanwhile (a
      // tokenGet asked again joins it: one prompt)
      tokLoad = null;
      return 'let-go';
    }
    if (typeof r.keychainLeft === 'boolean') kcLeft = r.keychainLeft;
    if (saves !== tokSaves) { tokStatus = token ? 'ready' : 'none'; return 'done'; } // saved meanwhile
    const st = String(r.status ?? '');
    if (st === 'ready' && typeof r.token === 'string' && r.token) { token = r.token; tokStatus = 'ready'; return 'done'; }
    token = '';
    tokStatus = st === 'denied' || st === 'error' ? st : 'none';
    tokDetail = tokStatus === 'none' ? '' : String(r.detail ?? '').slice(0, 240);
    return 'done';
  }).finally(wakeTokWaiters);
  tokLoad = p;
  return p;
}

/** Keep `t` (the module's file, or `localStorage`); this launch uses it at once either way. An
 *  empty `t` signs out: the file goes, and the old Keychain item's delete is tried (never a read). */
async function saveToken(t: string, native: Native): Promise<{ ok: boolean; status: string }> {
  token = t.trim();
  tokStatus = token ? 'ready' : 'none';
  tokDetail = '';
  tokSaves++;
  wakeTokWaiters();
  if (!native?.available) return { ok: true, status: token ? 'saved for this session' : 'forgotten' };
  try {
    const r = await native.later(token ? { op: 'tokenSet', token } : { op: 'tokenForget' });
    if (typeof r?.keychainLeft === 'boolean') kcLeft = r.keychainLeft;
    return r?.ok === true ? { ok: true, status: token ? 'saved' : 'forgotten' } : { ok: false, status: `not saved: ${String(r?.detail ?? '?')}` };
  } catch (e) {
    return { ok: false, status: `not saved: ${String((e as Error)?.message ?? e)}` };
  }
}

const tokView = () => ({ ver: token ? tokenVer(token) : '', has: token !== '', status: tokStatus, detail: tokDetail, left: kcLeft });

/** The page's own server (the web, same-origin SSO) and the demo need no token and never wait
 *  on its read; a server that may want one waits for it. */
function needsToken(server: string): boolean {
  const s = server.trim();
  if (s === 'demo') return false;
  const origin = (globalThis as { origin?: unknown }).origin;
  if (s === '' && typeof origin === 'string' && /^https?:\/\//.test(origin)) return false;
  return resolveBase(s) !== '';
}

// ---- state ---------------------------------------------------------------------------------
/** The native data module (macOS: Hermes); the web's runs in the browser. */
const NATIVE = typeof (globalThis as { HermesInternal?: unknown }).HermesInternal !== 'undefined';
const tl = new Timeline();
/** The module clock: the runner's ms, as draws and beats report it. */
let clock = 0;
let epochAtZero = 0;
let up: Upstream | null = null;
let demo: DemoUpstream | null = null;
let seenEpoch = -1;
/** The yard: scene, LOD, frame budget, packet pool (src/yard/draw.ts). */
const yard = new Yard(tl);
/** The Factory (FACTORY3.md, src/factory3/): the berth board, at /factory (any ?v= too). */
const f3 = new Board3();
/** p6: SWITCHYARD_CANVAS=<gpu|board,info>[,noq] (macOS, a hidden A/B switch: modules/apple/Hooks.swift):
 *  those canvases claim the GPU as in pass 5; noq: the progress rings at their exact fill, not by the
 *  pixel. Asked once, from a data turn (the overview's first), before anything is drawn on top. */
let canvasAsked = false;
function canvasAsk(native: Native): void {
  if (canvasAsked) return;
  canvasAsked = true;
  try {
    const r = native?.available ? native.call({ op: 'heapLog' }) : null;
    const v = typeof r?.canvas === 'string' ? r.canvas : '';
    if (!v) return;
    const on = (k: string) => v === 'gpu' || v.split(',').includes(k);
    Board3.boardGpu = on('board');
    InfoLayer.cg = !on('info');
    if (v.split(',').includes('noq')) { Yard.ringPx = false; RING.px = 0; }
    console.log(`canvas: SWITCHYARD_CANVAS=${v}: the board ${Board3.boardGpu ? 'GPU' : 'Core Graphics'}, the Yard's info layer ${InfoLayer.cg ? 'Core Graphics' : 'GPU'}, rings ${Yard.ringPx ? 'by the pixel' : 'exact'}`);
  } catch { /* no module: the defaults */ }
}
/** Stress mode (a 10× synthetic fleet for the Yard's renderer). */
let stressOn = false;
function setStress(on: boolean): void { stressOn = on; yard.setStress(on); }
tl.listener = (e, w) => { yard.pool.onEvent(e, w, clock); };
/** Engine history feeds the Factory Floor's load indicators and insights. */
const engineHist = new EngineHistory();
/** The Factory Floor's data seam (src/insights.ts): v0.5 tables, or approximations on v0.4. */
bindInsights(tl, () => up, engineHist);

/** `asking`: called from a source's answer, so it may fetch (a fetch started elsewhere, in
 *  `draw` or a promise's continuation, is never run). */
function advance(t: number, asking = true): void {
  if (t > clock) clock = t;
  if (inbox.length) drain(); // (a draw too: a heartbeat moves the server's now, which the timers read)
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

/** A replay streams in chunks of server time, asked a lookahead ahead of the playhead, each
 *  reply bounded by REPLAY_CEILING: an hour of real history can be ~30 MB (a server's boot
 *  burst), far more than the native data module's 64 MiB heap holds beside the world. A chunk
 *  over the ceiling is refused before any of it is read, and the window halves; quiet
 *  stretches grow it back. The lookahead and the window scale with the speed
 *  (src/timeline.ts `replaySizing`: ~3 s of real time ahead, chunks of up to 6 s of it, so 6 min
 *  at 60× and 30 min at 720×). A stretch that will not stream at the speed (its window would
 *  shrink under what the playhead plays between two asks) is jumped with `/snapshot?at=`,
 *  taken when the playhead reaches it. */
const REPLAY_LOOKAHEAD = 60_000;
const REPLAY_CEILING = 1536 << 10;
let chunkMs = 60_000;
let chunking: Promise<void> | null = null;
/** A stretch that will not stream at the speed: jump the replay to the fleet at this time. */
let rebaseAt = 0;
const refused = (e: unknown) => /refus|ceiling|exceeds/i.test(`${(e as { kind?: string }).kind ?? ''} ${(e as Error).message ?? e}`);
/** A replay's streaming, measured and logged when it ends (`replayDial`): what it asked and
 *  fetched, its jumps, the most unplayed frames it held; the waits are the timeline's. */
const rs = { on: false, what: '', speed: 0, t0: 0, bytes: 0, requests: 0, refused: 0, jumps: 0, held: 0, heap0: 0, heap: 0 };
/** The JS heap in use, bytes, where the engine says (Hermes: `HermesInternal.getInstrumentedStats`,
 *  the native data module's 64 MiB heap); 0 elsewhere. */
function heapNow(): number {
  try {
    const st = (globalThis as { HermesInternal?: { getInstrumentedStats?: () => Record<string, number> } }).HermesInternal?.getInstrumentedStats?.();
    return Number(st?.js_heapSize ?? st?.js_allocatedBytes ?? 0) || 0;
  } catch { return 0; }
}
function fetchChunk(from: number): Promise<void> {
  if (!up || demo || chunking) return chunking ?? Promise.resolve();
  const z = replaySizing(tl.speed);
  chunkMs = Math.min(z.max, chunkMs);
  const to = Math.min(from + chunkMs, tl.replayTo);
  rs.requests++;
  chunking = up.history(from, to, false, REPLAY_CEILING).then(
    (h) => {
      // the last chunk ends the replay (the server ends a window at its now, if that is earlier)
      tl.appendReplay(to >= tl.replayTo ? { ...h, to: tl.replayTo } : h);
      const bytes = h.bytes ?? 0;
      rs.bytes += bytes; rs.held = Math.max(rs.held, tl.replayHeld);
      chunkMs = nextChunkMs(chunkMs, bytes, REPLAY_CEILING, z);
      // denser than the speed streams: what follows this chunk is jumped
      if (chunkMs < z.min) { chunkMs = z.min; if (to < tl.replayTo) jump(to + z.skip); }
    },
    (e) => {
      if (!refused(e)) return; // the network: asked again by the next answer
      rs.refused++;
      if (Math.floor(chunkMs / 2) >= z.min) { chunkMs = Math.floor(chunkMs / 2); return; }
      console.log(`replay: ${Math.round((to - from) / 1000)} s from ${from} is over ${REPLAY_CEILING >> 10} KB; jumping ${Math.round(z.skip / 60_000)} min`);
      jump(from + z.skip);
    },
  ).finally(() => { chunking = null; });
  return chunking;
}
/** The next answer fetches the fleet at `at` (advance), and the replay goes on from there. */
function jump(at: number): void { rebaseAt = Math.min(at, tl.replayTo); rs.jumps++; }

/** Starts a replay from `from` to now at `speed`: the demo rewinds (a simulation started at
 *  `from`, pulled by the playhead); a server sends the fleet at `from` (v0.3), then frames only. */
async function startReplayAt(from: number, to: number, speed: number, what: string): Promise<{ ok: boolean; status: string }> {
  if (!up) return { ok: false, status: 'not connected' };
  if (rs.on) logReplay();
  Object.assign(rs, { on: false, what, speed, t0: clock, bytes: 0, requests: 0, refused: 0, jumps: 0, held: 0, heap0: heapNow(), heap: 0 });
  try {
    let ok: boolean;
    if (demo) {
      demo = null;
      demo = await DemoUpstream.start(from);
      up = demo;
      tl.load(await demo.snapshot(), clock);
      tl.beginPlayback(from, to, speed);
      ok = true;
    } else {
      const z = replaySizing(speed);
      chunkMs = z.start; rebaseAt = 0;
      replayBase = (up as HttpUpstream).base;
      // never a base inside a big window
      let base = up.snapshotAt ? await up.snapshotAt(from).catch(() => null) : null;
      // a server's first moments hold no fleet (it booted, then read its upstreams): start at the
      // first with one (a few small asks, a skip apart)
      for (let k = 0; k < 6 && base && !Object.keys(base.repos ?? {}).length && base.at + z.skip < to; k++) base = await up.snapshotAt!(base.at + z.skip).catch(() => null);
      const h = base ? { from, to: from, base, frames: [] } : await up.history(from, from + 60_000, true, 12 << 20);
      ok = tl.startReplay(h, to, speed);
      if (ok && tl.world.repos.size === 0) jump(tl.playhead + z.skip); // a server's first moments (an empty fleet, then its boot burst): jumped
      else if (ok) void fetchChunk(tl.replayLoadedTo); // the first chunk now, not at the next answer
    }
    rs.on = ok;
    return { ok, status: String(speed) };
  } catch (e) {
    return { ok: false, status: String((e as Error).message ?? e) };
  }
}

/** The server a replay streams from: a reconnect to it mid-replay keeps the replay (connect). */
let replayBase = '';
function replayKeeps(base: string): boolean { return (tl.mode === 'replay' || tl.replayPaused) && !tl.replayDone() && replayBase === base; }

/** Now as the replay controls count it: the demo's wall clock, else the server's. */
const replayNow = () => (demo ? Math.floor((epochAtZero + clock) / 1000) * 1000 : tl.liveNow());

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

/** A replay's streaming in the log, once (it ended, or another replaced it, or live was asked). */
function logReplay(): void {
  rs.on = false;
  const real = ((tl.endClock || clock) - rs.t0) / 1000;
  console.log(`replay: ${rs.what} at ${rs.speed}× ${tl.endClock ? 'ended' : 'left'} after ${real.toFixed(1)} s real · ${rs.requests} chunk requests (${rs.refused} refused), ${(rs.bytes / 1048576).toFixed(1)} MB of frames, ${rs.jumps} jumps · first frames after ${Math.round(tl.startMs)} ms · ${tl.stalls} stalls, ${Math.round(tl.stallMs)} ms in all · at most ${rs.held} frames held${rs.heap ? ` · heap ${(rs.heap0 / 1048576).toFixed(1)} → peak ${(rs.heap / 1048576).toFixed(1)} MB` : ''}`);
}

/** The yard's dial in words (and, once a replay has ended, its streaming numbers in the log). */
function replayDial(): string {
  if (rs.on) rs.heap = Math.max(rs.heap, heapNow()); // (4 times a second: the overview's pulse)
  if (rs.on && tl.mode !== 'replay' && !tl.replayPaused) logReplay();
  if (tl.mode === 'replay' || tl.replayPaused) {
    const span = tl.replayTo - tl.replayFrom, p = clamp01((tl.playhead - tl.replayFrom) / Math.max(1, span));
    const at = span > 2 * 3_600_000 ? `${Math.round((p * span) / 3_600_000)} of ${Math.round(span / 3_600_000)} h` : `${Math.round((p * span) / 60_000)} of ${Math.round(span / 60_000)} min`;
    return `${tl.replayPaused ? 'paused' : 'replaying'} · ${at}`;
  }
  return tl.mode === 'paused' ? 'paused · 1 hour, sped up' : '1 hour, sped up';
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
/** Connects started: only the newest one's outcome counts for the token-file hook. */
let connects = 0;

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
    liveEpoch = String((snap as { epoch?: string }).epoch ?? '');
    if (!replayKeeps(base)) {
      // p5-board: a reload while paused (a reset's) stays paused: Contract's time control says so,
      // and the timers it would start ticking show nothing new
      const paused = tl.mode === 'paused' && !tl.replayPaused;
      tl.load(snap, clock); // fx-day: a reconnect mid-replay (a dropped or coalesced stream) leaves the replay playing
      if (paused) tl.pause();
    }
    loads++;
    yard.sync(clock);
    return { ...none, ok: true, status: 'connected', seq: snap.seq ?? tl.world.seq, label: up.label, kind: 'http' }; // fx-day: the live seq (in a replay the world's is the past's)
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

/** The stream's frames, waiting for the clock they arrived at (the mapper has none): taken in
 *  by the next source turn that advances the clock (`advance`). While the pulse is asleep or
 *  slow (ov.pace 1 or 2), the first frame to wait moves the feed's `wake`, and Contract ticks
 *  once for it (app.contract `fed`, 250 ms later, so a burst is one turn): the world, the overview and what shows them
 *  follow the stream's frames, not a clock. Paused, a frame is kept at once (nothing shows it). */
const inbox: WireFrame[] = [];
const INBOX_MAX = 4000;
/** p5-board: the stream's place, the newest seq it brought (in the inbox or taken in). A stream
 *  opened again with the fleet kept (app.contract `fgen`: it dropped, or the server refused it)
 *  resumes after it; the server answers a resume it can no longer serve with a reset, and only
 *  then is the snapshot fetched again. A new connect (`loads`: a snapshot taken) starts it at the
 *  snapshot's seq, its inbox emptied. */
let streamSeq = 0, streamKey = '', loads = 0;
/** The server process the fleet was fetched from (Snapshot.epoch). A stream opened again after a
 *  drop asks /api/v1/meta which process answers now: another one (the server restarted) means
 *  the resume may join a new numbering, so the fleet is fetched again (a reset), never trusted
 *  across processes (sy-client's stale-state audit: a restart could leave entities the new
 *  process never had, and so never removes). */
let liveEpoch = '';
const noteSeq = (f: WireFrame) => { const q = (f as { seq?: number }).seq; if (f.t === 'delta' && typeof q === 'number' && q > streamSeq) streamSeq = q; };
let feedWake = 0, wakeOwed = false;
/** The pace the last overview answered (app.contract's pulse). */
let lastPace = 0;
function drain(): boolean {
  wakeOwed = false;
  const fs = inbox.splice(0);
  for (const f of fs) if (!tl.ingest(f, clock)) return false;
  return true;
}

function liveFeed(server: string, token: string, seq: number, ok: boolean, gen: number) {
  const idle = { ok: false, status: 'idle', wake: feedWake };
  const base = !ok || server === 'demo' ? '' : resolveBase(server);
  if (!base) {
    inbox.length = 0;
    streamKey = '';
    return server === 'demo' && ok ? { ok: true, status: 'demo', wake: feedWake } : idle;
  }
  const key = `${base}|${tokenVer(token)}|${gen}|${loads}`;
  const resumed = streamKey === key;
  if (streamKey !== key) { streamKey = key; inbox.length = 0; streamSeq = seq; }
  let status = 'connecting';
  let otherProcess = false;
  if (resumed && liveEpoch && up) {
    const want = liveEpoch;
    up.meta().then((m) => { if (m?.epoch && m.epoch !== want) otherProcess = true; }, () => {});
  }
  return fetch(wsUrl(base, `/api/v1/stream?since=${Math.max(seq, streamSeq)}`, token), {
    // A resume's first message can carry many merged frames: allow 4 MiB a message. (An open
    // stream holds twice its ceiling of the native lanes' 64 MiB, beside a history read.)
    exactIndependentHttp: { maxResponseBytes: 4 << 20 },
    exactStream(ev) {
      if (otherProcess && status !== 'reset') { inbox.length = 0; status = 'reset'; }
      if (status === 'reset') return { ok: false, status, wake: feedWake };
      if (ev.type === 'open') status = 'live';
      else if (ev.type === 'message' && typeof ev.data === 'string') {
        status = 'live';
        // A coalesced message means frames were dropped on the way in: the world has a gap.
        if ((ev as { coalesced?: number }).coalesced) status = 'reset';
        else {
          const fs = parseFrames(ev.data);
          for (const f of fs) noteSeq(f);
          if (tl.mode === 'paused' && !inbox.length) {
            for (const f of fs) if (!tl.ingest(f, clock)) { status = 'reset'; break; }
          } else if (fs.some((f) => f.t === 'reset') && tl.mode !== 'replay') {
            inbox.length = 0;
            status = 'reset';
          } else if (inbox.length + fs.length > INBOX_MAX) {
            inbox.length = 0; // (never: the wake takes them within ~30 ms) a gap: refetch
            status = 'reset';
          } else {
            for (const f of fs) inbox.push(f);
            // (a heartbeat alone changes nothing shown: it waits for the next turn)
            if (!wakeOwed && lastPace !== 0 && fs.some((f) => f.t !== 'hb')) { wakeOwed = true; feedWake++; }
          }
        }
      } else if (ev.type === 'error') {
        const e = ev as { kind?: string; message?: string };
        console.log(`stream ended: ${e.kind ?? ''} ${e.message ?? ''}`);
        status = status === 'reset' ? 'reset' : e.kind === 'Network' ? 'closed' : 'error';
      } else if (ev.type === 'close') status = status === 'reset' ? 'reset' : 'closed';
      return { ok: status === 'live', status, wake: feedWake };
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
  const { building, queued, red, up: appsUp, down: appsDown, apps: appsTotal, repos } = totals(w, stressOn); // ONE count (buildingIds, queueTruth: src/totals.ts); stress mode: the 10× fleet's
  // (to the minute: no view shows it, and a field that moves each second re-sends every canvas's arguments on the web)
  const behind = tl.mode === 'live' ? '' : `${fmtDur(Math.floor(tl.behindMs() / 60_000) * 60_000)} behind`;
  const sentence = w.loaded
    ? `${repos} repos · ${building} building · ${queued} queued · ${red} main ${red === 1 ? 'line' : 'lines'} red · ${appsUp} of ${appsTotal} apps up` // fx-glance
    : 'waiting for the fleet';
  const summary = w.loaded ? `The delivery yard: ${building} pipelines building, ${queued} queued, ${red} main ${red === 1 ? 'line' : 'lines'} red, ${appsUp} of ${appsTotal} apps up.` : 'The delivery yard, waiting for data.'; // fx-glance
  const k = S?.k ?? 1;
  const dial = replayDial(); // fx-day: the dial counts a day replay's hours (and logs a replay's streaming when it ends)
  const vis = redraw(w, building + queued);
  lastPace = vis.pace;
  return {
    status: w.loaded ? 'ready' : 'waiting', mode: tl.mode, speed: tl.speed, sentence, summary, layoutKey: `${S?.key ?? ''}|${yard.budget.quality >= 3 ? 'lo' : 'hi'}`, repos: w.repos.size,
    building, queued, red, appsUp, appsTotal, appsDown, behind, seq: w.seq,
    tick: vis.tick, pace: vis.pace, wake: vis.wake, wakeKey: vis.wakeKey, host: hostLabel(), dial, dialPad: Math.round(((S?.m ?? 16) + 22) * k), dialFont: Math.round(11 * k), dialH: Math.round(34 * k),
    hud: yard.hud.on, stress: stressOn, quality: yard.budget.quality,
  };
}

/** The canvases' redraw key (`ov.tick`) and the pulse's pace (`ov.pace`) (mac-perf, "idle = still").
 *  The key moves only when something the view on top shows has changed: the world (a new
 *  version), the mode or speed, the view on top, and the clock only where a shown text follows
 *  it: each minute (clock times and ages), each second while busy and a timer shows (while only
 *  the timers tick, Contract adds the second itself: `rk`), a replay's playhead 4 times a
 *  second. Idle, it stands still: no canvas is asked for a frame and no source re-asked
 *  through it. The pace: 0, the 250 ms pulse (the demo, a replay, playing behind, the HUD,
 *  stress); 1, a shown timer runs: the 1 s
 *  tick moves `rk` and asks nothing else; 2, no pulse. Paces 1 and 2 wake a few times a minute
 *  (`wake`: a ladder of one-shot timers to the playhead's next minute, or 1 s after a change, so
 *  what the change started is seen to tick), and the stream's frames wake the clock (`fed`). */
let visTick = 0, visSig = '', visData = '', visChanged = -1e9, visWakes = 0;
const LADDER = [32, 16, 8, 4, 2, 1];
function redraw(w: { ver: number }, active: number): { tick: number; pace: number; wake: number; wakeKey: number } {
  const replaying = tl.mode === 'replay';
  // (what the view on top shows: the Yard's every running or queued job, the board's own runs,
  // deploys and checks, Live's running and waiting rows)
  // (Live and the board: as they last built; a change is looked at again a second later, `wake`)
  // (paused, the playhead stands: no timer moves)
  const ticking = tl.mode === 'paused' ? false : topView === 'factory' ? f3.ticking : topView === 'now' ? feedTicking() : topView === 'yard' ? active > 0 : false;
  const g = replaying ? 250 : ticking || tl.mode === 'behind' ? 1000 : 60_000;
  const data = `${tl.epoch}|${w.ver}|${tl.mode}|${tl.speed}|${stressOn ? 1 : 0}|${yard.hud.on ? 1 : 0}`;
  const sig = `${topView}|${data}|${Math.floor(tl.playhead / g)}`;
  if (`${topView}|${data}` !== visData) { visData = `${topView}|${data}`; visChanged = clock; }
  if (sig !== visSig) { visSig = sig; visTick++; }
  // (no fleet yet, or none to be had: the connect's answer and the reconnect timers ask again; the
  // setup and offline cards are still)
  const busy = !!demo || replaying || tl.mode === 'behind' || yard.hud.on || stressOn;
  const pace = busy ? 0 : ticking ? 1 : 2;
  // the next wake: a second after a change (the board and Live count their timers when they
  // draw what it brought), else the largest rung under the playhead's next minute
  let wake = 0;
  // p4: paused, the playhead stands, so no age, timer or hh:mm moves and `left` below never
  // shrinks: the same rung came back forever (Live's `feedUntil` could pin it to 1 s). One wake
  // every 32 s is left, for the heap line (src/memlog.ts, every 30 s).
  if (pace && tl.mode === 'paused') wake = 32;
  else if (pace) {
    let left = 60_000 - (((tl.playhead % 60_000) + 60_000) % 60_000);
    // (Live: also when its rows stop being right, a row crossing a band's edge: its feed is built again then)
    if (topView === 'now') left = Math.min(left, Math.max(0, feedUntil() - tl.playhead) + 1);
    wake = clock - visChanged < 1000 ? 1 : LADDER.find((s) => s * 1000 <= left) ?? 1;
  }
  return { tick: visTick, pace, wake, wakeKey: ++visWakes };
}

function route(kind: string, id: string): string {
  switch (kind) {
    case 'repo': return `/?repo=${encodeURIComponent(id)}`;
    case 'app': return `/?app=${encodeURIComponent(id)}`;
    case 'pr': { const [repo] = id.split('#'); return `/?repo=${encodeURIComponent(repo)}`; }
    case 'commit': return `/?sha=${encodeURIComponent(id)}`;
    case 'pipeline': {
      const p = tl.world.pipelines.get(id);
      return p ? `/?sha=${encodeURIComponent(`${p.repo}@${p.sha}`)}` : '/';
    }
    default: return '/';
  }
}

/** `switchyard://connect?server=…&token=…` (it arrives as `/connect?u=<the whole URL>`), or a
 *  web link `/connect?server=…&token=…`. Only an http(s) server or a bare host is taken, and a
 *  token of URL-safe characters; anything else leaves the link refused (ok false). */
/** `switchyard://view/<live|factory|yard>`: a tab to switch to (a script, e.g. the release soak,
 *  drives the installed app with `open`), no server, no token, no confirm. The route, else "". */
export function linkView(u: string): string {
  const m = /^switchyard:\/\/view\/(live|now|factory|yard)\/?$/.exec(u.trim());
  return !m ? '' : m[1] === 'live' || m[1] === 'now' ? '/' : `/${m[1]}`;
}

export function parseLink(u: string, server: string, token: string): { server: string; token: string; ok: boolean; view: string } {
  const view = linkView(u);
  if (view) return { server: '', token: '', ok: false, view };
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
  return okServer && okToken ? { server: sv, token: tk, ok: true, view: '' } : { server: okServer ? sv : '', token: '', ok: false, view: '' };
}

/** Is the page older than the web build the server now serves? Web only (a native app has no
 *  page origin), and only a build that knows its own commit (app/scripts/build.sh web). */
async function webVersion(): Promise<{ stale: boolean; served: string }> {
  const origin = (globalThis as { origin?: unknown }).origin;
  if (!WEB_SHA || typeof origin !== 'string' || !/^https?:\/\//.test(origin)) return { stale: false, served: '' };
  try {
    const r = await fetch(`${origin}/api/v1/meta`, { headers: { accept: 'application/json' } });
    if (!r.ok) return { stale: false, served: '' };
    const m = (await r.json()) as { web?: { sha?: string; tree?: string } | null };
    const served = m.web?.sha ?? '';
    // a server that reports the app/ tree it serves: stale only when the web itself changed (a
    // server-only deploy moves the sha, not the tree); otherwise compare commits
    if (WEB_TREE && m.web?.tree) return { stale: m.web.tree !== WEB_TREE, served };
    return { stale: !!served && served !== WEB_SHA, served };
  } catch {
    return { stale: false, served: '' };
  }
}

/** A token's version for Contract: 8 base-36 characters of FNV-1a, enough to notice a change,
 *  too few to recover anything. */
function tokenVer(t: string): string {
  let h = 2166136261;
  for (let i = 0; i < t.length; i++) { h ^= t.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(36).padStart(7, '0');
}

export const sources: Sources = {
  ...nowSources({
    world: () => tl.world,
    now: () => tl.playhead,
    offsetMin: () => yard.offsetMin,
    upstream: () => up,
    advance: (t) => advance(t),
  }) as unknown as Pick<Sources, 'nowFeed' | 'nowTick' | 'nowPanel' | 'nowLog'>,
  // the board: a press on it, the inspector's detail, its log (src/factory3/log.ts)
  f3Pick: ([x, y]) => {
    const h = f3.pick(Number(x), Number(y));
    return { kind: h?.kind ?? '', id: h?.id ?? '', label: h ? `${h.x},${h.y},${h.w},${h.h}` : '', route: h?.url ?? '' };
  },
  f3Detail: ([kind, id, _key, t]) => { if (t > 0) advance(t); return safe('f3Detail', NO_F3, () => f3Detail(tl.world, String(kind ?? ''), String(id ?? ''), tl.playhead, f3.where)); }, // (t: the timers' second, app.contract `tickMs`)
  f3Log: ([id, step, workflow, tick, failed]) => {
    const v = logOf(up, String(id ?? ''), String(step ?? ''), String(workflow ?? ''), Number(tick) || 0, !!failed);
    return v instanceof Promise ? v.then(tidyLog) : tidyLog(v);
  },
  f3Stats: () => ({ ok: f3.stillAt(clock), status: f3.statsLine(), work: f3.workLine() }), // (the clock: a still board is not drawn on macOS)
  webVersion: () => webVersion(),
  parseLink: ([u, server, token]) => parseLink(u, server, token),
  // SWITCHYARD_TOKEN_FILE (macOS, env only; src/hooks.ts): the token, once, through parseLink.
  tokenFile: (_a, _store, _storage, native) => takeTokenFile(native, DEFAULT_SERVER, parseLink),
  saveTokenFile: (_a, _store, _storage, native) => saveTokenFile((t) => saveToken(t, native)),
  tokenFileReport: (_a, _store, _storage, native) => tokenFileReport(native),
  updateState: (_a, _store, _storage, native) => updateState(native),
  updateDo: ([op], _store, _storage, native) => updateDo(op, native),
  // The token never leaves the data module: Contract sees whether one is saved, a version (a
  // short hash that changes when the token does, so conn/feed re-ask) and how its read went. A
  // resource's answer and its identifying arguments are kept on disk for the next launch
  // (exact.kept), so a token there would sit in plain text; the sources use it themselves. The
  // module scrubs older builds' kept answers holding it as it reads it (Keychain.swift).
  // `hook`: the route's `?keychain=denied` or `?keychain=left`, the agent's test hooks (one read
  // answers denied, or says an old Keychain item was left).
  loadToken: ([gen, hook], _store, _storage, native) => {
    const h = hook === 'denied' || hook === 'left' ? String(hook) : '';
    if (!tokLoad) void readToken(native, h);
    else if (h && h !== tokAsked.hook) void readToken(native, h);
    // "Try again" (tokGen) reads again after a denial or a failure, and a re-ask while the read is
    // out asks again (the earlier ask's answer is let go, and its reply with it; the module's
    // read goes on and this one finds its file); a loaded token stands.
    else if (gen !== tokAsked.gen && tokStatus !== 'ready' && tokStatus !== 'none') void readToken(native);
    tokAsked = { gen, hook: h };
    // at once when it is known, as the store's read was (a save lands in the turn it is asked)
    if (tokStatus !== 'loading') return tokView();
    return (async () => {
      await tokenKnown(native, h);
      return tokView();
    })();
  },
  saveToken: ([t, set], _store, _storage, native) => {
    if (!set || !String(t).trim()) return { ok: true, status: 'kept' };
    return saveToken(String(t), native);
  },
  // Settings' "Forget token" (sign out): the token file goes, the old item's delete is tried
  forgetToken: (_a, _store, _storage, native) => saveToken('', native),
  connect: async ([server, _ver, _gen, epoch0, offset], _store, _storage, native) => {
    yard.offsetMin = offset;
    // The demo and the page's own server never wait on the token; a server that may want one
    // waits for its read (or a save), so the first fetch carries it.
    const needs = needsToken(server);
    if (needs) await tokenKnown(native); // `tok` normally asks first
    const t = needs ? token : '';
    if (needs && !t && (tokStatus === 'denied' || tokStatus === 'error')) {
      // the saved token could not be read: the token card says why and what to do
      return { ok: false, status: 'no token', error: tokStatus === 'denied' ? 'Keychain access was denied.' : 'The saved token could not be read.', seq: 0, label: '', kind: '', needsSetup: true, signIn: '' };
    }
    const mine = ++connects;
    const c = await connect(server, t, epoch0);
    // A connect with SWITCHYARD_TOKEN_FILE's token, when no newer one started meanwhile (an
    // older one's answer is let go): how it went, for tokenFileReport to log. One let go before a
    // newer one counted itself (a save's afterSave re-asks conn mid-fetch) is not an outcome either.
    if (t && mine === connects && !(!c.ok && LET_GO.test(c.error || ''))) connectedWith(t, server === 'demo' ? '' : resolveBase(server), c.ok, c.error || c.status);
    return c;
  },
  liveFeed: ([server, _ver, seq, gen, ok]) => liveFeed(server, needsToken(server) ? token : '', seq, ok, Number(gen) || 0), // (and fgen: the stream again, the fleet kept: app.contract `retry`)
  overview: ([t, _seq, _ok, top], _store, _storage, native) => { topView = String(top ?? ''); if (t > 0) advance(t); safe('heapLog', 0, () => { probeAsk(native); canvasAsk(native); probeFlush(native); logHeap(clock, native, !!up && tl.world.loaded); return 0; }); /* leak: the heap line (src/memlog.ts) */ return safe('overview', EMPTY_OV, overview); },
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
    const to = replayNow();
    return startReplayAt(to - (demo ? DEMO_REPLAY : 3_600_000), to, 60, 'the last hour');
  },
  // fx-day: Play on a paused replay goes on with it at its speed; else plays at 1× behind live
  replayResume: ([t]) => {
    if (t > 0) advance(t);
    const was = tl.replayPaused;
    tl.resume();
    return { ok: was, status: String(tl.speed) };
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
    // (route: where the pointer is, the lens's surface argument: it is redrawn as it moves, not every frame)
    return h ? { kind: h.kind, id: h.id, label: h.label, route: `${Math.round(x)},${Math.round(y)}` } : { kind: '', id: '', label: '', route: '' };
  },
  devToggle: ([what, on]) => {
    if (what === 'hud') yard.hud.on = on === 1;
    else if (what === 'stress') setStress(on === 1);
    return { ok: true, status: `${what} ${on === 1 ? 'on' : 'off'}` };
  },
  // (asked again when the query changes or the palette opens: its second argument is a key, not a clock)
  search: ([q]) => {
    return safe('search', { hits: [] }, () => ({ hits: search(tl.world, q, tl.playhead).map((h) => ({ kind: h.kind, id: h.id, title: h.title, subtitle: h.subtitle, route: route(h.kind, h.id) })) }));
  },
  viewOnTop: ([here], _store, _storage, native) => { topView = String(here ?? ''); logRoute(topView, native); return { ok: true, status: topView }; },
};

const EMPTY_OV: Result<'overview'> = {
  status: 'waiting', mode: 'live', speed: 1, sentence: 'waiting for the fleet', summary: 'The delivery yard, waiting for data.', layoutKey: '', repos: 0,
  building: 0, queued: 0, red: 0, appsUp: 0, appsTotal: 0, appsDown: 0, behind: '', seq: 0,
  tick: 0, pace: 0, wake: 0, wakeKey: 0, host: '', dial: '1 hour, sped up', dialPad: 38, dialFont: 11, dialH: 34, hud: false, stress: false, quality: 0,
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

/** The host's entry: one function for every source, as `sources` names them. */
export const answer: Answer = ((source: keyof Sources, args: unknown, store: Store, storage: unknown, native?: unknown) =>
  (sources[source] as (a: unknown, s: Store, st: unknown, n: unknown) => unknown)(args, store, storage, native)) as Answer;

// ---- canvases ------------------------------------------------------------------------------
/** Surface → its arity (Contract passes that many arguments). */
export const surfaces: Record<string, number> = { f3Board: 6, f3Live: 1, yardStatic: 2, yardInfo: 2, yardLive: 3, yardTop: 2 };

/** The route on top (`viewOnTop`). The yard stays mounted under every other view; its live
 *  layer animating there cost 3-4× the ops of the view on top. Covered, it is not drawn (the
 *  canvas keeps its last pixels) and asks for no frame; `ov.tick` moves when the view on top
 *  changes, so it is drawn again as it comes back. */
let topView = '';

export function draw(surface: string, args: unknown[], ctx: Ctx2D, frame: Frame): boolean {
  if (probing() && !probeInside()) return probeWrap(surface, ctx, frame, () => draw(surface, args, ctx, frame)); // leak: the hidden heap probe (src/heapprobe.ts)
  // Covered, the yard sleeps too (no frame asked); `ov.tick` moves when it is on top again.
  if ((surface === 'yardLive' || surface === 'yardInfo' || surface === 'yardTop') && topView !== '' && topView !== 'yard') return false;
  // Covered, the board sleeps too.
  if ((surface === 'f3Board' || surface === 'f3Live') && topView !== '' && topView !== 'factory') {
    // (a fresh bitmap skipped here is owed its first, whole paint and the GPU claim: src/factory3/board.ts)
    f3.skipped(surface === 'f3Board' ? 'board' : 'live', frame);
    return false;
  }
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
  noteFrame(frame.time); // leak: the heap line's running frame count
  if (surface === 'f3Board') {
    advance(frame.time, false);
    return f3.drawBoard(ctx, frame, tl.world, tl.playhead, { win: String(args[0] ?? '30m'), sel: String(args[1] ?? ''), mode: String(args[2] ?? 'live'), reduced: !!args[3], dock: !!args[4], hov: String(args[5] ?? '') });
  }
  if (surface === 'f3Live') return f3.drawLive(ctx, frame);
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
  return false;
}
