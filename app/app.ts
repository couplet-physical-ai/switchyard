// Switchyard's data module. The fleet lives here: the timeline (live and shown worlds), the
// motion system and the yard's canvas layers. Contract asks small questions (sources below);
// the canvases read the world directly every frame (`draw`).

import type { Answer, Ctx2D, Frame, NativeModule, Result, Sources, Store } from './app.contract.d.ts';
import { HttpUpstream, resolveBase, setDefaultServer, wsUrl, type Upstream } from './src/api.ts';

// A release build bakes the team's server in (app/scripts/build-macos-release.sh sets it);
// dev and test builds leave it empty and ask on first launch.
const DEFAULT_SERVER = import.meta.env.SWITCHYARD_DEFAULT_SERVER ?? '';
const WEB_SHA = import.meta.env.SWITCHYARD_WEB_SHA ?? '';
const WEB_TREE = import.meta.env.SWITCHYARD_WEB_TREE ?? '';
setDefaultServer(DEFAULT_SERVER);
import { DEMO_REPLAY, DemoUpstream } from './src/demo.ts';
import { EngineHistory } from './src/enginehist.ts';
import { bindInsights } from './src/insights.ts';
import { search } from './src/project.ts';
import { nowSources } from './src/now/view.ts';
import { FlowFloor } from './src/flowfloor/floor.ts';
import { Board3 } from './src/factory3/board.ts';
import { NO_F3, f3Detail, tidyLog } from './src/factory3/inspect.ts';
import { detailOf, logOf, NO_DETAIL } from './src/flowfloor/inspect.ts';
import { logHeap } from './src/memlog.ts';
import { nextChunkMs, replaySizing, Timeline } from './src/timeline.ts';
import { bindBaselineStore } from './src/factory/agg/baseline.ts';
import { connectedWith, saveTokenFile, takeTokenFile, tokenFileReport } from './src/hooks.ts';
import { updateDo, updateState } from './src/update.ts';
import type { Frame as WireFrame } from './src/wire.ts';
import { Yard } from './src/yard/draw.ts';
import { Factory } from './src/factory/factory.ts';
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
/** The Factory redo (ZERO.md "FACTORY REDO", src/flowfloor/): one fixed, fitted line of work. */
const flow = new FlowFloor();
/** Factory 3 (FACTORY3.md, src/factory3/): the berth board, at /factory?v=3. */
const f3 = new Board3();
factory.hud = yard.hud;
/** Stress mode (a 10× synthetic fleet for the renderers): one switch for the yard and the floor. */
let stressOn = false;
function setStress(on: boolean): void { stressOn = on; yard.setStress(on); factory.setStress(on); }
tl.listener = (e, w) => { yard.pool.onEvent(e, w, clock); factory.onEvent(e, w, clock); };
/** Engine history feeds the Factory Floor's load indicators and insights. */
const engineHist = new EngineHistory();
/** The Factory Floor's data seam (src/insights.ts): v0.5 tables, or approximations on v0.4. */
bindInsights(tl, () => up, engineHist);

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
/** The day: the last 24 h at DAY_SPEED (two minutes), then live again. One constant, to retune. */
const DAY_SPEED = 720;
const DAY_MS = 24 * 3_600_000;
/** The built-in demo has no history: its simulation runs forward as the playhead pulls it (a
 *  call a frame), and a fleet hour costs it more the longer it has run (Bun: 0.3 s of CPU at hour
 *  1, 1.9 s at hour 24). fx-demo measured it at ~4,800 fleet ms per CPU ms without a JIT (Hermes-
 *  like): 720× (12 s of fleet a frame) is 10-75 ms a frame on Hermes, far over budget. So its
 *  "day" is the last 2 h at 120× (2 s of fleet a frame, twice the hour replay's), and the strip
 *  says so: "2 h at 120×". */
const DEMO_DAY_MS = 2 * 3_600_000;
const DEMO_DAY_SPEED = 120;
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
/** A day replay is playing (or paused): a seek keeps its speed. */
const dayReplay = () => (tl.mode === 'replay' || tl.replayPaused) && tl.replaySpeed === (demo ? DEMO_DAY_SPEED : DAY_SPEED);

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
    if (!replayKeeps(base)) tl.load(snap, clock); // fx-day: a reconnect mid-replay (a dropped or coalesced stream) leaves the replay playing
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
  if (up && w.loaded) logHeap(clock);
  // Never builds the scene here (a source turn has 100 ms on Hermes): the first draw does.
  const S = yard.S;
  // One truth for building and queued: the yard, the status line and the QUEUE band agree.
  const { building, queued, red, up: appsUp, down: appsDown, apps: appsTotal, repos } = factory.coffee.status(w, stressOn, clock); // fx-glance: ONE count (buildingIds, queueTruth) for the status line and the coffee header; stress mode: the 10× fleet's own
  const behind = tl.mode === 'live' ? '' : `${fmtDur(tl.behindMs())} behind`;
  const sentence = w.loaded
    ? `${repos} repos · ${building} building · ${queued} queued · ${red} main ${red === 1 ? 'line' : 'lines'} red · ${appsUp} of ${appsTotal} apps up` // fx-glance
    : 'waiting for the fleet';
  const summary = w.loaded ? `The delivery yard: ${building} pipelines building, ${queued} queued, ${red} main ${red === 1 ? 'line' : 'lines'} red, ${appsUp} of ${appsTotal} apps up.` : 'The delivery yard, waiting for data.'; // fx-glance
  const k = S?.k ?? 1;
  factory.city.pump(clock); // fab-w5: the city's app histories (H7), a few fetches per data turn, never from a draw
  const dial = replayDial(); // fx-day: the dial counts a day replay's hours (and logs a replay's streaming when it ends)
  return {
    status: w.loaded ? 'ready' : 'waiting', mode: tl.mode, speed: tl.speed, sentence, summary, layoutKey: `${S?.key ?? ''}|${yard.budget.quality >= 3 ? 'lo' : 'hi'}`, repos: w.repos.size,
    building, queued, red, appsUp, appsTotal, appsDown, facHead: factory.coffee.glance0.drawn, behind, seq: w.seq, // fx-glance: the coffee header's totals as drawn
    tick: Math.floor(clock / 250), host: hostLabel(), dial, dialPad: Math.round(((S?.m ?? 16) + 22) * k), dialFont: Math.round(11 * k), dialH: Math.round(34 * k),
    hud: yard.hud.on, stress: stressOn, quality: yard.budget.quality, facKey: factory.floorKey,
    facDrawer: factory.selected !== '', facQ: factory.budget.quality, facStress: factory.stress.on, facCalm: factory.calm, facStats: factory.statsLine(), ...factory.counts(),
  };
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

let baseBound = false, basePending = '';

export const sources: Sources = {
  ...nowSources({
    world: () => tl.world,
    now: () => tl.playhead,
    offsetMin: () => yard.offsetMin,
    upstream: () => up,
  }) as unknown as Pick<Sources, 'nowFeed' | 'nowPanel' | 'nowLog'>,
  // the Factory redo: a press on the floor, the inspector's run, its log (src/flowfloor/)
  flowPick: ([x, y]) => {
    const h = flow.pick(Number(x), Number(y));
    return { kind: h?.kind ?? '', id: h?.id ?? '', label: h?.label ?? '', route: h?.url ?? '' };
  },
  flowDetail: ([id]) => safe('flowDetail', NO_DETAIL, () => detailOf(tl.world, String(id ?? ''), tl.playhead)),
  flowLog: ([id, step, workflow, tick, failed]) => logOf(up, String(id ?? ''), String(step ?? ''), String(workflow ?? ''), Number(tick) || 0, !!failed),
  // Factory 3: a press on the board, the inspector's detail (its log is flowLog's)
  f3Pick: ([x, y]) => {
    const h = f3.pick(Number(x), Number(y));
    return { kind: h?.kind ?? '', id: h?.id ?? '', label: h ? `${h.x},${h.y},${h.w},${h.h}` : '', route: h?.url ?? '' };
  },
  f3Detail: ([kind, id]) => safe('f3Detail', NO_F3, () => f3Detail(tl.world, String(kind ?? ''), String(id ?? ''), tl.playhead, f3.where)),
  f3Log: ([id, step, workflow, tick, failed]) => {
    const v = logOf(up, String(id ?? ''), String(step ?? ''), String(workflow ?? ''), Number(tick) || 0, !!failed);
    return v instanceof Promise ? v.then(tidyLog) : tidyLog(v);
  },
  f3Stats: () => ({ ok: f3.still, status: f3.statsLine() }),
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
  liveFeed: ([server, _ver, seq, _gen, ok]) => liveFeed(server, needsToken(server) ? token : '', seq, ok),
  overview: ([t]) => { if (t > 0) advance(t); safe('plantHist', 0, () => { factory.plant.pump(clock); return 0; }); return safe('overview', EMPTY_OV, overview); }, // fab-w6: the machine walls' 24 h histories are asked here (a source), never in a draw
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
  // fx-day: the last 24 h at DAY_SPEED (the demo: its last 2 h at 120×), then live
  replayDay: async ([t]) => {
    if (t > 0) advance(t);
    const to = replayNow();
    // (a minute inside the server's 24 h: its clock is a little ahead of ours)
    return demo ? startReplayAt(to - DEMO_DAY_MS, to, DEMO_DAY_SPEED, 'the demo day') : startReplayAt(to - DAY_MS + 60_000, to, DAY_SPEED, '24 h');
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
    return h ? { kind: h.kind, id: h.id, label: h.label, route: '' } : { kind: '', id: '', label: '', route: '' };
  },
  facPointer: ([kind, x, y, buttons]) => {
    // fab-w4: any input skips the coffee check's replay; S replays it, W cycles its window
    factory.coffee.input(String(kind), clock);
    const ck = String(kind).startsWith('key:') ? factory.coffee.key(String(kind).slice(4), clock) : null;
    if (ck) return { kind: ck.kind, id: ck.id, label: ck.label, route: `${factory.cam.key}|${factory.selected}|${factory.coffee.win}` };
    const h = factory.pointer(String(kind), Number(x), Number(y), Number(buttons) || 0, clock);
    if (kind === 'up') factory.coffee.click(h, clock); // fab-w4: the "since" chip and its menu
    // the HUD's buttons are floor hits too
    if (kind === 'up' && h?.kind === 'stress') setStress(!stressOn);
    else if (kind === 'up' && h?.kind === 'quality') factory.budget.pinned = factory.budget.pinned >= 4 ? -1 : factory.budget.pinned + 1;
    else if (kind === 'up' && h?.kind === 'tiles') factory.toggleTiles(); // fab-w7c: the static floor's dirty tiles off/on
    // a newly picked crate: fetch its journey for the drawer (a source may fetch; a draw never does)
    const sel = factory.selected;
    if (sel && factory.journeyFor !== sel && up) {
      const cm = factory.selCommit();
      factory.journeyFor = sel;
      if (cm) void cached(`j:${cm.repo}@${cm.sha}`, () => up!.journey(cm.repo, cm.sha)).then((j) => { if (factory.journeyFor === sel) factory.journey = j; }, () => {});
    }
    factory.offsetMin = yard.offsetMin;
    return { kind: h?.kind ?? '', id: h?.id ?? '', label: h?.label ?? '', route: `${factory.cam.key}|${factory.selected}|${factory.coffee.win}${factory.coffee.menu ? '+' : ''}` };
  },
  // fab-lens: the coffee check's last visit per server (src/factory/coffee.ts), kept by Contract
  coffeeOpen: ([server, visits, _seq, ok]) => ({ ok: !!ok, status: safe('coffeeOpen', '', () => factory.coffee.open(String(server ?? ''), String(visits ?? ''), !!ok, clock)) }),
  // the hourly baseline ring (agg/baseline.ts): bound once to Contract's persisted facBase; its
  // saves wait in `basePending` until the next visit mark hands them to Contract
  baselineBind: ([s]) => {
    if (!baseBound) { baseBound = true; safe('baselineBind', 0, () => { bindBaselineStore({ load: () => String(s ?? ''), save: (v) => { basePending = v; } }); return 0; }); }
    return { ok: true, status: '' };
  },
  baselineSave: () => { const v = basePending; basePending = ''; return { ok: v !== '', status: v }; },
  coffeeMark: ([server, visits]) => {
    const v = safe('coffeeMark', '', () => factory.coffee.mark(String(server ?? ''), String(visits ?? '')));
    return { ok: v !== '', status: v };
  },
  // fab-lens: a time-strip tick replays from that moment at 60×; in a day replay, at its speed (fx-day)
  replayAt: async ([t, at]) => {
    if (t > 0) advance(t);
    const to = replayNow(), day = dayReplay();
    const from = Math.min(to - 60_000, Math.max(to - DAY_MS + 60_000, Number(at) || to - 3_600_000));
    return startReplayAt(from, to, day ? tl.replaySpeed : 60, day ? (demo ? 'the demo day, from a tick' : '24 h, from a tick') : 'from a tick');
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
  viewOnTop: ([here]) => { topView = String(here ?? ''); return { ok: true, status: topView }; },
};

const EMPTY_OV: Result<'overview'> = {
  status: 'waiting', mode: 'live', speed: 1, sentence: 'waiting for the fleet', summary: 'The delivery yard, waiting for data.', layoutKey: '', repos: 0,
  building: 0, queued: 0, red: 0, appsUp: 0, appsTotal: 0, appsDown: 0, facHead: '', behind: '', seq: 0, // fx-glance
  tick: 0, host: '', dial: '1 hour, sped up', dialPad: 38, dialFont: 11, dialH: 34, hud: false, stress: false, quality: 0, facKey: '', facDrawer: false, facQ: 0, facStress: false, facCalm: true, facStats: '', facCity: 0, facCars: 0, facBays: 0, facLens: 0, facLensTop: '',
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

/** The Factory's selected commit journey is cached briefly: it is fetched in a source answer,
 *  never while painting a canvas. */
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
/** Surface → its arity (Contract passes that many arguments). */
export const surfaces: Record<string, number> = { factoryFloor: 3, factoryLive: 4, factoryTop: 4 /* fab-w7 */, flowFloor: 5, f3Board: 6, f3Live: 1, yardStatic: 2, yardInfo: 2, yardLive: 3, yardTop: 2 };

/** The route on top (`viewOnTop`). The yard stays mounted under every other view; its live
 *  layer animating there cost 3-4× the ops of the view on top. Covered, it is not drawn (the
 *  canvas keeps its last pixels) and asks for frames still, so it resumes on its first frame. */
let topView = '';

export function draw(surface: string, args: unknown[], ctx: Ctx2D, frame: Frame): boolean {
  if ((surface === 'yardLive' || surface === 'yardInfo' || surface === 'yardTop') && topView !== '' && topView !== 'yard') return true;
  // Covered, the floor's live layer sleeps; the 250 ms tick (a surface argument) wakes it when
  // it is on top again.
  if ((surface === 'factoryLive' || surface === 'factoryTop' /* fab-w7 */) && topView !== '' && topView !== 'factory') return false;
  if ((surface === 'flowFloor' || surface === 'f3Board' || surface === 'f3Live') && topView !== '' && topView !== 'factory') return false;
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
  if (surface === 'flowFloor') {
    advance(frame.time, false);
    return flow.draw(ctx, frame, tl.world, tl.playhead, { win: String(args[0] ?? '30m'), sel: String(args[1] ?? ''), mode: String(args[2] ?? 'live'), reduced: !!args[3] });
  }
  if (surface === 'f3Board') {
    advance(frame.time, false);
    return f3.drawBoard(ctx, frame, tl.world, tl.playhead, { win: String(args[0] ?? '30m'), sel: String(args[1] ?? ''), mode: String(args[2] ?? 'live'), reduced: !!args[3], dock: !!args[4], hov: String(args[5] ?? '') });
  }
  if (surface === 'f3Live') return f3.drawLive(ctx, frame);
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
  if (surface === 'factoryTop') return factory.drawTop(ctx, frame, clock); // fab-w7: the words and the chrome, as changes (src/factory/cache.ts)
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
