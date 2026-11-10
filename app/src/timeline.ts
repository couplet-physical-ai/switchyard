// The time machine (DESIGN.md, "Time"). One playhead in server milliseconds decides what the
// yard shows, and there is only ever ONE world in memory (the data module's engine has a
// 64 MiB heap; the fleet is a few MB of JSON, its objects several times that):
//
//   live    every frame is applied as it arrives; the playhead is the server's now.
//   paused  frames are kept, not applied (bounded); the world stands still.
//   behind  the kept frames are applied as the playhead (1× or ¼×) passes them.
//   replay  the world is replaced by history's base and history's frames play at 60×;
//           live frames are dropped, so going live again refetches the snapshot.
//
// The built-in demo needs no buffer: it generates frames up to the playhead on demand.

import type { Frame as WireFrame, History, Snapshot } from './wire.ts';
import { World, type Listener } from './world.ts';

export type Mode = 'live' | 'paused' | 'behind' | 'replay';

/** Paused or behind for longer than this many frames: drop them and refetch on resume. */
const MAX_KEPT = 20_000;

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
  /** The replay's frames are loaded up to here (it streams in chunks; the playhead waits). */
  replayLoadedTo = 0;
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
        this.playhead = Math.min(this.playhead + dt * this.speed, Math.max(this.replayLoadedTo, this.replayFrom));
        while (this.replayIdx < this.replay.length && atOf(this.replay[this.replayIdx]) <= this.playhead) {
          this.world.apply(this.replay[this.replayIdx++], this.listener);
        }
        if (this.playhead >= this.replayTo) this.playhead = this.replayTo;
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
    this.mode = 'paused';
  }

  /** Plays at `speed` from where the playhead is (behind live), or stays live at 1×. */
  play(speed: number): void {
    this.speed = speed;
    if (this.mode === 'replay') return;
    if (this.mode === 'live') {
      if (speed >= 1) return;
      this.playhead = this.liveNow();
      this.clearKept();
    }
    this.mode = 'behind';
  }

  /** Replaces the world with history's base and plays its frames at 60×, through `to` (later
   *  chunks arrive by `appendReplay`; by default the window is `h` alone). */
  startReplay(h: History, to = h.to): boolean {
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
    this.mode = 'replay';
    this.speed = 60;
    this.epoch++;
    return true;
  }

  /** The next chunk of a streaming replay: its frames after what is loaded. */
  appendReplay(h: History): void {
    if (this.mode !== 'replay') return;
    if (this.replayIdx > 0) { this.replay = this.replay.slice(this.replayIdx); this.replayIdx = 0; }
    for (const f of h.frames ?? []) {
      if (f.t === 'delta' && f.at > this.replayLoadedTo - 1) this.replay.push(f);
      else if (f.t === 'snapshot' && f.at > this.replayLoadedTo) this.replay.push({ t: 'delta', seq: f.seq, at: f.at, ops: [] }); // a restart: nothing to animate
    }
    this.replayLoadedTo = Math.max(this.replayLoadedTo, h.to);
  }

  /** Where the next replay chunk starts, or 0 when none is needed yet (or ever). */
  replayWants(lookaheadMs: number): number {
    if (this.mode !== 'replay' || this.replayLoadedTo >= this.replayTo) return 0;
    return this.playhead + lookaheadMs >= this.replayLoadedTo ? this.replayLoadedTo : 0;
  }

  /** A frame the demo made for the playhead (behind or rewinding): applied at once. */
  applyNow(f: WireFrame): void {
    if (f.t !== 'reset' && f.at >= this.lastAt) { this.lastAt = f.at; this.lastAtClock = this.clock; }
    this.world.apply(f, this.listener);
  }

  /** The demo's rewind: the world (already loaded at `from`) plays forward to `to` at 60×,
   *  pulled by the playhead; nothing is stale, the world it ends on is the live one. */
  beginPlayback(from: number, to: number): void {
    this.replay = [];
    this.replayIdx = 0;
    this.replayFrom = from;
    this.replayTo = to;
    this.replayLoadedTo = to;
    this.playhead = from;
    this.clearKept();
    this.stale = false;
    this.mode = 'replay';
    this.speed = 60;
    this.epoch++;
  }

  /** The demo's playback reached now (or the person asked for live): live from here. */
  resumeLive(): void {
    this.replay = [];
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
