// The time machine (DESIGN.md, "Time"). One playhead in server milliseconds decides what the
// yard shows. `live` takes every frame as it arrives; `shown` is `live` in LIVE mode, and a
// separate world otherwise: paused (frozen), behind (playing buffered frames at 1× or ¼×) or
// replay (an hour of history at 60×). The motion listener hears events only from `shown`.

import type { Frame as WireFrame, History, Snapshot } from './wire.ts';
import { World, type Listener } from './world.ts';

export type Mode = 'live' | 'paused' | 'behind' | 'replay';

export class Timeline {
  live = new World();
  shown: World = this.live;
  mode: Mode = 'live';
  speed = 1;
  /** Server time shown, ms. */
  playhead = 0;
  /** The module clock (the runner's ms, as draws and beats report it) at the last tick. */
  clock = 0;
  /** Server time of the newest frame and the module clock when it arrived. */
  private lastAt = 0;
  private lastAtClock = 0;
  private buffer: WireFrame[] = [];
  private replay: WireFrame[] = [];
  private replayIdx = 0;
  replayFrom = 0;
  replayTo = 0;
  /** Bumps when `shown` is replaced or jumps: the motion system re-syncs. */
  epoch = 0;
  listener: Listener | undefined;
  /** Frames applied in the last second, for the coalescing readout. */
  framesSeen = 0;
  eventsSeen = 0;

  load(s: Snapshot, clock: number): void {
    this.live = new World();
    this.live.load(s);
    this.lastAt = this.live.at;
    this.lastAtClock = clock;
    this.buffer = [];
    if (this.mode !== 'replay') {
      this.mode = 'live';
      this.shown = this.live;
      this.playhead = this.live.at;
      this.epoch++;
    }
  }

  /** A frame from the server (or the demo). False: the client must refetch the snapshot. */
  ingest(f: WireFrame, clock: number): boolean {
    if (f.t === 'reset') return false;
    if (f.t !== 'hb') {
      this.framesSeen++;
      this.eventsSeen += f.ops.length;
    }
    const inLive = this.mode === 'live';
    const ok = this.live.apply(f, inLive ? this.listener : undefined);
    if (!ok) return false;
    if (atOf(f) >= this.lastAt) {
      this.lastAt = atOf(f);
      this.lastAtClock = clock;
    }
    if ((this.mode === 'paused' || this.mode === 'behind') && f.t === 'delta') {
      this.buffer.push(f);
      if (this.buffer.length > 40_000) this.goLive();
    }
    return true;
  }

  /** The server's now, extrapolated from the newest frame by the module clock (≤ 15 s). */
  liveNow(clock = this.clock): number {
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
        let i = 0;
        while (i < this.buffer.length && atOf(this.buffer[i]) <= this.playhead) this.shown.apply(this.buffer[i++], this.listener);
        if (i) this.buffer.splice(0, i);
        if (this.speed >= 1 && !this.buffer.length && this.playhead >= this.liveNow(clock) - 250) this.goLive();
        break;
      }
      case 'replay': {
        this.playhead += dt * this.speed;
        while (this.replayIdx < this.replay.length && atOf(this.replay[this.replayIdx]) <= this.playhead) {
          this.shown.apply(this.replay[this.replayIdx++], this.listener);
        }
        if (this.playhead >= this.replayTo) this.goLive();
        break;
      }
    }
  }

  pause(): void {
    if (this.mode === 'paused') return;
    if (this.mode === 'live') {
      this.shown = this.live.clone();
      this.playhead = this.liveNow();
      this.buffer = [];
      this.epoch++;
    }
    this.mode = 'paused';
  }

  /** Plays at `speed` from where the playhead is (behind live), or stays live at 1×. */
  play(speed: number): void {
    this.speed = speed;
    if (this.mode === 'replay') return;
    if (this.mode === 'live') {
      if (speed >= 1) return;
      this.shown = this.live.clone();
      this.playhead = this.liveNow();
      this.buffer = [];
      this.epoch++;
    }
    this.mode = 'behind';
  }

  startReplay(h: History, base: Snapshot | null): boolean {
    const b = h.base ?? base;
    if (!b) return false;
    const w = new World();
    w.load(b);
    this.shown = w;
    this.replay = (h.frames ?? []).filter((f) => f.t === 'delta').sort((a, b) => atOf(a) - atOf(b));
    this.replayIdx = 0;
    this.replayFrom = h.from;
    this.replayTo = h.to;
    this.playhead = h.from;
    this.mode = 'replay';
    this.speed = 60;
    this.epoch++;
    return true;
  }

  goLive(): void {
    this.mode = 'live';
    this.speed = 1;
    this.shown = this.live;
    this.buffer = [];
    this.replay = [];
    this.playhead = this.liveNow();
    this.epoch++;
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
  return f.t === 'reset' ? 0 : f.at;
}
