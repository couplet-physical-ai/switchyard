// The time machine (DESIGN.md, "Time"). One playhead in server milliseconds decides what the
// yard shows, and there is only ever ONE world in memory (the data module's engine has a
// 64 MiB heap; the fleet is a few MB of JSON, its objects several times that):
//
//   live    every frame is applied as it arrives; the playhead is the server's now.
//   paused  frames are kept, not applied (bounded); the world stands still.
//   behind  the kept frames are applied as the playhead (1× or ¼×) passes them.
//   replay  the world is replaced by history's base and history's frames play at the replay's
//           speed (60×: the last hour; DAY_SPEED: the day); live frames are dropped, so going
//           live again refetches the snapshot. Paused, a replay stays one: play resumes it.
//
// The built-in demo needs no buffer: it generates frames up to the playhead on demand.
//
// A replay streams (app.ts `fetchChunk`): its frames arrive in chunks of server time, asked a
// lookahead ahead of the playhead; both scale with the speed (`replaySizing`), so the 24 h at
// 720× asks ~3 s of real time ahead in chunks of up to 30 min. Where the frames are too dense to
// stream at that speed (a server's boot burst), the replay jumps the stretch with a snapshot
// (`rebaseReplay`), taken when the playhead gets there. The playhead never passes what is
// loaded: it waits (`waiting`; counted in `stalls`/`stallMs`), and the strip says so.

import type { Frame as WireFrame, History, Snapshot } from './wire.ts';
import { World, type Listener } from './world.ts';

export type Mode = 'live' | 'paused' | 'behind' | 'replay';

/** Paused or behind for longer than this many frames: drop them and refetch on resume. */
const MAX_KEPT = 20_000;

/** A streaming replay's sizes at `speed` (server ms per real ms), all server ms:
 *  - `lookahead`: how far ahead of the playhead the next chunk is asked: ~3 s of real time (≥ 1 min);
 *  - `max`: the longest chunk: 6 s of real time, 6 min (60×) to 30 min (720×);
 *  - `min`: the shortest worth streaming: under it a chunk covers less than the playhead plays
 *    between two asks (a source asks every 250 ms), so the stream cannot keep up: jump instead;
 *  - `skip`: how far such a jump goes (2.5 s of real time, ≥ `min`, ≤ `max`);
 *  - `start`: the first chunk (the window grows by half on quiet chunks and halves on big ones). */
export function replaySizing(speed: number): { lookahead: number; max: number; min: number; skip: number; start: number } {
  const s = Math.max(1, speed);
  const max = Math.min(30 * 60_000, Math.max(6 * 60_000, s * 6_000));
  const min = Math.min(max / 4, Math.max(5_000, s * 250));
  return { lookahead: Math.max(60_000, s * 3_000), max, min, skip: Math.min(max, Math.max(min, s * 2_500)), start: Math.max(min, Math.min(60_000 * Math.max(1, s / 60), max / 3)) };
}

/** The next chunk's window after one of `ms` came back with `bytes` (`ceiling` the reply limit):
 *  half again on a quiet chunk (under a quarter of the ceiling), halved on a big one (over half). */
export function nextChunkMs(ms: number, bytes: number, ceiling: number, z: { max: number; min: number }): number {
  if (bytes < ceiling / 4) return Math.min(z.max, Math.round(ms * 1.5));
  if (bytes > ceiling / 2) return Math.floor(ms / 2);
  return Math.min(z.max, ms);
}

export class Timeline {
  world = new World();
  mode: Mode = 'live';
  speed = 1;
  /** Server time shown, ms. */
  playhead = 0;
  /** The module clock (the runner's ms, as draws and beats report it) at the last tick. */
  clock = 0;
  /** Server time of the newest frame and the module clock when it arrived. */
  private lastAt = 0;
  private lastAtClock = 0;
  /** Frames that arrived while paused or behind, oldest first. */
  private kept: WireFrame[] = [];
  private keptIdx = 0;
  private replay: WireFrame[] = [];
  private replayIdx = 0;
  replayFrom = 0;
  replayTo = 0;
  /** The replay's hour in 240 buckets: events per bucket and failures per bucket, filled as
   *  chunks arrive (the yard draws them as a 1 px density strip with the playhead). */
  readonly density = new Uint16Array(240);
  readonly fails = new Uint16Array(240);
  densityVer = 0;
  /** The replay's frames are loaded up to here (it streams in chunks; the playhead waits). */
  replayLoadedTo = 0;
  /** The speed the replay was started at (60× the hour, DAY_SPEED the day): a seek keeps it. */
  replaySpeed = 60;
  /** The playhead is held at `replayLoadedTo`, waiting for the next chunk (the strip says so). */
  waiting = false;
  /** This replay's waits after its first frames: how many, and their real ms in all; and the real
   *  ms before its first frames played (the base and the first chunk). */
  stalls = 0;
  stallMs = 0;
  startMs = 0;
  /** The module clock when the playhead reached the replay's end (0 before). */
  endClock = 0;
  private played = false;
  /** The world to jump the replay to once the playhead reaches `jumpFrom`, the end of what was
   *  loaded before the jump (`rebaseReplay`); chunks after the jump load meanwhile. */
  private pendingBase: World | null = null;
  private jumpFrom = 0;
  /** Paused from a replay (the frames are kept; play resumes it) and its speed then. */
  private pausedReplay = false;
  private pausedSpeed = 60;
  /** The world no longer follows the server (replay, or too much kept): refetch to go live. */
  stale = false;
  /** Bumps when the world is replaced or jumps: the motion system re-syncs. */
  epoch = 0;
  listener: Listener | undefined;
  /** For the demo: the server's now comes from the simulation's clock, not from frames. */
  wallNow: ((clock: number) => number) | null = null;

  /** Back-compat names: the world shown (and, there being one, the live one). */
  get shown(): World { return this.world; }

  load(s: Snapshot, clock: number): void {
    const w = new World();
    w.load(s);
    this.world = w;
    this.lastAt = w.at;
    this.lastAtClock = clock;
    this.clearKept();
    this.replay = [];
    this.pendingBase = null;
    this.pausedReplay = false;
    this.waiting = false;
    this.stale = false;
    this.mode = 'live';
    this.speed = 1;
    this.playhead = w.at;
    this.epoch++;
  }

  /** A frame from the server (or the demo). False: the client must refetch the snapshot. */
  ingest(f: WireFrame, clock: number): boolean {
    if (f.t === 'reset') {
      if (this.mode === 'replay') return true; // live is refetched when the replay ends
      return false;
    }
    if (f.at >= this.lastAt) {
      this.lastAt = f.at;
      this.lastAtClock = clock;
    }
    switch (this.mode) {
      case 'live':
        return this.world.apply(f, this.listener);
      case 'replay':
        this.stale = true;
        return true;
      default:
        if (f.t !== 'delta') return true;
        if (this.kept.length - this.keptIdx >= MAX_KEPT) {
          this.clearKept();
          this.stale = true;
        }
        if (!this.stale) this.kept.push(f);
        return true;
    }
  }

  /** The server's now: the demo's clock, or the newest frame plus the time since (≤ 15 s). */
  liveNow(clock = this.clock): number {
    if (this.wallNow) return this.wallNow(clock);
    return this.lastAt + Math.min(15_000, Math.max(0, clock - this.lastAtClock));
  }

  /** Advances the playhead to the module clock `clock`. */
  tick(clock: number): void {
    const dt = Math.max(0, Math.min(1000, clock - this.clock));
    this.clock = clock;
    switch (this.mode) {
      case 'live':
        this.playhead = this.liveNow(clock);
        break;
      case 'paused':
        break;
      case 'behind': {
        this.playhead += dt * this.speed;
        while (this.keptIdx < this.kept.length && this.kept[this.keptIdx].t !== 'reset' && (this.kept[this.keptIdx] as { at: number }).at <= this.playhead) {
          this.world.apply(this.kept[this.keptIdx++], this.listener);
        }
        if (this.keptIdx > 512 && this.keptIdx * 2 > this.kept.length) { this.kept = this.kept.slice(this.keptIdx); this.keptIdx = 0; }
        const live = this.liveNow(clock);
        if (this.speed > 1 && this.playhead >= live - 250) {
          // Caught up (only faster than 1× can): live again.
          this.playhead = live;
          if (!this.stale && this.keptIdx >= this.kept.length) this.toLive(false);
        }
        break;
      }
      case 'replay': {
        let want = this.playhead + dt * this.speed;
        // a jump, taken when the playhead has played what was loaded before it
        const pb = this.pendingBase;
        if (pb && want >= this.jumpFrom) { want = pb.at + (want - this.jumpFrom); this.rebaseNow(pb); }
        const cap = this.pendingBase ? this.jumpFrom : Math.max(this.replayLoadedTo, this.replayFrom);
        this.playhead = Math.min(want, cap);
        while (this.replayIdx < this.replay.length && atOf(this.replay[this.replayIdx]) <= this.playhead) {
          this.world.apply(this.replay[this.replayIdx++], this.listener);
        }
        if (this.playhead >= this.replayTo) { this.playhead = this.replayTo; if (!this.endClock) this.endClock = clock; }
        // held at what is loaded, short of the end: waiting for the stream
        // (a second draw of the same frame moves nothing: it says nothing new)
        if (dt > 0) {
          const held = want > cap && cap < this.replayTo && this.speed > 0;
          if (held) {
            if (!this.played) this.startMs += dt;
            else { if (!this.waiting) this.stalls++; this.stallMs += Math.min(dt, (want - cap) / this.speed); }
          } else this.played = true;
          this.waiting = held;
        }
        break;
      }
    }
  }

  /** True when the replay has played to its end. */
  replayDone(): boolean {
    return this.mode === 'replay' && this.playhead >= this.replayTo;
  }

  pause(): void {
    if (this.mode === 'paused') return;
    if (this.mode === 'live') {
      this.playhead = this.liveNow();
      this.clearKept();
    }
    // a replay paused stays one (its frames kept, the stream idle): play resumes it
    this.pausedReplay = this.mode === 'replay';
    if (this.pausedReplay) this.pausedSpeed = this.speed;
    this.waiting = false;
    this.mode = 'paused';
  }

  /** Paused from a replay: play goes on with it. */
  get replayPaused(): boolean { return this.mode === 'paused' && this.pausedReplay; }

  /** Resumes a paused replay at the speed it had (true), else plays at 1× behind live. */
  resume(): boolean {
    if (this.replayPaused) { this.mode = 'replay'; this.speed = this.pausedSpeed; this.pausedReplay = false; return true; }
    this.play(1);
    return false;
  }

  /** Plays at `speed` from where the playhead is (behind live), or stays live at 1×. A paused
   *  replay goes on at `speed`. */
  play(speed: number): void {
    this.speed = speed;
    if (this.replayPaused) { this.mode = 'replay'; this.pausedReplay = false; return; }
    if (this.mode === 'replay') return;
    if (this.mode === 'live') {
      if (speed >= 1) return;
      this.playhead = this.liveNow();
      this.clearKept();
    }
    this.mode = 'behind';
  }

  /** Replaces the world with history's base and plays its frames at `speed`, through `to` (later
   *  chunks arrive by `appendReplay`; by default the window is `h` alone). */
  startReplay(h: History, to = h.to, speed = 60): boolean {
    if (!h.base) return false;
    const w = new World();
    w.load(h.base);
    this.world = w;
    const frames: WireFrame[] = [];
    for (const f of h.frames ?? []) {
      if (f.t === 'delta') frames.push(f);
      else if (f.t === 'snapshot') {
        // A server restart inside the window: what came before it no longer applies.
        frames.length = 0;
        w.load(f.v);
      }
    }
    frames.sort((a, b) => atOf(a) - atOf(b));
    this.density.fill(0); this.fails.fill(0);
    to = Math.floor(to); // (whole ms, as the server's windows are asked and answered)
    this.replayFrom = h.from; this.replayTo = to;
    for (const f of frames) this.countFrame(f);
    this.replay = frames;
    this.replayIdx = 0;
    this.replayFrom = h.from;
    this.replayTo = to;
    this.playhead = Math.max(h.from, w.at);
    // History may start later than asked (a young server): the replay starts where it does.
    this.replayLoadedTo = Math.max(h.to, this.playhead);
    // Frames before `from` only fast-forward the base (no motion for them).
    while (this.replayIdx < frames.length && atOf(frames[this.replayIdx]) <= this.playhead) w.apply(frames[this.replayIdx++]);
    this.clearKept();
    this.stale = true;
    this.beginReplay(speed);
    return true;
  }

  /** The replay's own state: its speed, its waits counted afresh. */
  private beginReplay(speed: number): void {
    this.mode = 'replay';
    this.speed = speed;
    this.replaySpeed = speed;
    this.pausedReplay = false;
    this.pendingBase = null;
    this.waiting = false;
    this.played = false;
    this.stalls = 0; this.stallMs = 0; this.startMs = 0; this.endClock = 0;
    this.epoch++;
  }

  /** A stretch too dense to stream at this speed: jump the world to the fleet as it was at
   *  `s.at` and go on from there (what happened inside the gap is skipped, not wrong). The jump
   *  waits until the playhead has played the frames loaded before it. */
  rebaseReplay(s: Snapshot): void {
    if ((this.mode !== 'replay' && !this.replayPaused) || this.pendingBase) return;
    const w = new World();
    w.load(s);
    // (loaded here, in the answer's turn: the swap in a draw's tick is a pointer). Chunks go on
    // from the jump's far side while the playhead plays up to its near one.
    const near = Math.max(this.replayLoadedTo, this.replayFrom);
    if (this.playhead < near && w.at > near) {
      this.pendingBase = w;
      this.jumpFrom = near;
      this.replayLoadedTo = w.at;
      return;
    }
    this.rebaseNow(w);
  }

  /** A jump is waiting for the playhead. */
  get rebasing(): boolean { return this.pendingBase !== null; }

  private rebaseNow(w: World): void {
    this.pendingBase = null;
    this.world = w;
    // what was loaded beyond the jump stays (it was fetched after it); the rest is the gap's
    if (this.replayIdx > 0) { this.replay = this.replay.slice(this.replayIdx); this.replayIdx = 0; }
    let k = 0;
    while (k < this.replay.length && atOf(this.replay[k]) <= w.at) k++;
    if (k) this.replay = this.replay.slice(k);
    this.replayLoadedTo = Math.max(this.replayLoadedTo, w.at);
    this.playhead = Math.max(this.playhead, w.at);
    this.stale = true;
    this.epoch++;
  }

  /** The next chunk of a streaming replay: its frames after what is loaded. */
  appendReplay(h: History): void {
    if (this.mode !== 'replay' && !this.replayPaused) return;
    if (this.replayIdx > 0) { this.replay = this.replay.slice(this.replayIdx); this.replayIdx = 0; }
    for (const f of h.frames ?? []) {
      if (f.t === 'delta' && f.at > this.replayLoadedTo - 1) { this.replay.push(f); this.countFrame(f); }
      else if (f.t === 'snapshot' && f.at > this.replayLoadedTo) this.replay.push({ t: 'delta', seq: f.seq, at: f.at, ops: [] }); // a restart: nothing to animate
    }
    // (a window asked up to the end comes back ending at the server's now when that is earlier: the
    // end is loaded)
    this.replayLoadedTo = Math.max(this.replayLoadedTo, h.to);
  }

  private countFrame(f: WireFrame): void {
    if (f.t !== 'delta') return;
    const span = Math.max(1, this.replayTo - this.replayFrom);
    const b = Math.floor(((f.at - this.replayFrom) / span) * 240);
    if (b < 0 || b >= 240) return;
    for (const o of f.ops) {
      if (o.op !== 'event') continue;
      if (this.density[b] < 65535) this.density[b]++;
      if (o.e.k === 'finish' && (o.e.state === 'failure' || o.e.state === 'error') && this.fails[b] < 65535) this.fails[b]++;
    }
    this.densityVer++;
  }

  /** Where the next replay chunk starts, or 0 when none is needed yet (or ever). The lookahead is
   *  at least `lookaheadMs` and ~3 s of real time at the playing speed (`replaySizing`), past a
   *  jump waiting for the playhead (its far side loads meanwhile). */
  replayWants(lookaheadMs: number): number {
    if (this.mode !== 'replay' || this.replayLoadedTo >= this.replayTo) return 0;
    const ahead = Math.max(lookaheadMs, replaySizing(this.speed).lookahead);
    // what is left to play before the loaded end (a waiting jump's gap takes no time)
    const pb = this.pendingBase;
    const left = pb ? this.jumpFrom - this.playhead + this.replayLoadedTo - pb.at : this.replayLoadedTo - this.playhead;
    return left <= ahead ? this.replayLoadedTo : 0;
  }

  /** Unplayed replay frames held (the played ones are sliced off as chunks arrive). */
  get replayHeld(): number { return this.replay.length - this.replayIdx; }

  /** A frame the demo made for the playhead (behind or rewinding): applied at once. */
  applyNow(f: WireFrame): void {
    if (f.t !== 'reset' && f.at >= this.lastAt) { this.lastAt = f.at; this.lastAtClock = this.clock; }
    this.world.apply(f, this.listener);
  }

  /** The demo's rewind: the world (already loaded at `from`) plays forward to `to` at `speed`,
   *  pulled by the playhead; nothing is stale, the world it ends on is the live one. */
  beginPlayback(from: number, to: number, speed = 60): void {
    this.replay = [];
    this.replayIdx = 0;
    this.replayFrom = from;
    this.replayTo = to;
    this.replayLoadedTo = to;
    this.playhead = from;
    this.clearKept();
    this.stale = false;
    this.beginReplay(speed);
  }

  /** The demo's playback reached now (or the person asked for live): live from here. */
  resumeLive(): void {
    this.replay = [];
    this.pendingBase = null;
    this.pausedReplay = false;
    this.waiting = false;
    this.clearKept();
    this.stale = false;
    this.mode = 'live';
    this.speed = 1;
    this.playhead = this.liveNow();
  }

  /**
   * Back to live. True: done (the kept frames were applied at once). False: the world no
   * longer follows the server, and the caller must refetch the snapshot (`load`).
   */
  goLive(): boolean {
    return this.toLive(true);
  }

  private toLive(jump: boolean): boolean {
    this.replay = [];
    this.pendingBase = null;
    this.pausedReplay = false;
    this.waiting = false;
    if (this.stale || this.mode === 'replay') {
      this.mode = 'live';
      this.speed = 1;
      this.clearKept();
      return false;
    }
    while (this.keptIdx < this.kept.length) this.world.apply(this.kept[this.keptIdx++]);
    this.clearKept();
    this.mode = 'live';
    this.speed = 1;
    this.playhead = this.liveNow();
    if (jump) this.epoch++;
    return true;
  }

  private clearKept(): void {
    this.kept = [];
    this.keptIdx = 0;
  }

  /** How far the shown world is behind live, ms (0 in LIVE). */
  behindMs(): number {
    return this.mode === 'live' ? 0 : Math.max(0, this.liveNow() - this.playhead);
  }

  replayProgress(): number {
    if (this.mode !== 'replay' || this.replayTo <= this.replayFrom) return 0;
    return Math.min(1, Math.max(0, (this.playhead - this.replayFrom) / (this.replayTo - this.replayFrom)));
  }
}

function atOf(f: WireFrame): number {
  return f.t === 'reset' ? 0 : (f.at ?? 0);
}
