// FrameLog: the in-memory frame ring + history store. Frames are kept as compact JSON
// strings; periodic state checkpoints (also JSON) let `window(from, to)` rebuild the state at
// `from` by replaying frames through the contract reducer. Pure and portable.

import type { Frame, DemoSnapshot as Snapshot } from '../src/wire.ts';
import { applyFrame } from './reduce.ts';

type Rec = { seq: number; at: number; json: string };

export type HistoryParts = { from: number; to: number; baseJson: string; frames: string[] };

export class FrameLog {
  private recs: Rec[] = [];
  private head = 0;
  private ckpts: Rec[] = [];
  bytes = 0;

  constructor(readonly keepMs: number, readonly ringFrames: number) {}

  get lastSeq(): number { return this.recs.length > this.head ? this.recs[this.recs.length - 1]!.seq : this.ckptSeq(); }
  get oldestAt(): number { return this.ckpts.length ? this.ckpts[0]!.at : 0; }
  get frameCount(): number { return this.recs.length - this.head; }
  private ckptSeq(): number { return this.ckpts.length ? this.ckpts[this.ckpts.length - 1]!.seq : 0; }

  /** Forgets every frame (the in-app demo keeps none: it hands frames over as it makes them). */
  drop(): void {
    this.recs = [];
    this.head = 0;
    this.bytes = 0;
  }

  push(seq: number, at: number, json: string): void {
    this.recs.push({ seq, at, json });
    this.bytes += json.length;
  }

  /** Records the full state (JSON) as of `seq`/`at`, then drops anything older than keepMs. */
  checkpoint(seq: number, at: number, stateJson: string): void {
    this.ckpts.push({ seq, at, json: stateJson });
    const cutoff = at - this.keepMs;
    // keep the newest checkpoint at or before the cutoff so the window start stays rebuildable
    let k = 0;
    while (k + 1 < this.ckpts.length && this.ckpts[k + 1]!.at <= cutoff) k++;
    if (k > 0) this.ckpts.splice(0, k);
    const floorSeq = this.ckpts[0]!.seq;
    while (this.head < this.recs.length && this.recs[this.head]!.seq <= floorSeq) {
      this.bytes -= this.recs[this.head]!.json.length;
      this.head++;
    }
    if (this.head > 4096 && this.head * 2 > this.recs.length) {
      this.recs = this.recs.slice(this.head);
      this.head = 0;
    }
  }

  private indexAfterSeq(seq: number): number {
    let lo = this.head, hi = this.recs.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.recs[mid]!.seq <= seq) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }
  private indexAfterAt(at: number): number {
    let lo = this.head, hi = this.recs.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.recs[mid]!.at <= at) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  /** Frames after `since` as JSON, or null when the client must reset (too old / unknown). */
  since(since: number, currentSeq: number): string[] | null {
    if (!Number.isFinite(since) || since > currentSeq || since < 0) return null;
    if (since === currentSeq) return [];
    if (currentSeq - since > this.ringFrames) return null;
    const i = this.indexAfterSeq(since);
    if (i >= this.recs.length || this.recs[i]!.seq !== since + 1) return null; // pruned gap
    const out: string[] = [];
    for (let j = i; j < this.recs.length; j++) out.push(this.recs[j]!.json);
    return out;
  }

  /** State at `from` plus the frames with from < at <= to, both clamped to what is kept. */
  window(from: number, to: number, nowAt: number): HistoryParts {
    if (!this.ckpts.length) throw new Error('no checkpoint');
    const f = Math.max(this.oldestAt, Math.min(from, nowAt));
    const t = Math.max(f, Math.min(to, nowAt));
    let c = 0;
    while (c + 1 < this.ckpts.length && this.ckpts[c + 1]!.at <= f) c++;
    const ck = this.ckpts[c]!;
    const base = JSON.parse(ck.json) as Snapshot;
    const end = this.indexAfterAt(f);
    for (let j = this.indexAfterSeq(ck.seq); j < end; j++) applyFrame(base, JSON.parse(this.recs[j]!.json) as Frame);
    base.at = f;
    const frames: string[] = [];
    const stop = this.indexAfterAt(t);
    for (let j = Math.max(end, this.head); j < stop; j++) frames.push(this.recs[j]!.json);
    return { from: f, to: t, baseJson: JSON.stringify(base), frames };
  }
}

export const historyJson = (h: HistoryParts): string =>
  `{"from":${h.from},"to":${h.to},"base":${h.baseJson},"frames":[${h.frames.join(',')}]}`;
