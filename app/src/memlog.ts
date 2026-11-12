// One bounded, periodic memory line for a session. No object-graph census or history.
//
// macOS (Hermes): every 30 s the module's `heapLog` op (modules/apple/Hooks.swift) writes
//   heap: <live+external MB> MB · live <MB> · ext <MB> · cap 512 · frames <n>
// to ~/Library/Logs/Switchyard/switchyard.log with the `pid <pid>` prefix. The release soak
// (scripts/release/soak-mini.sh) reads the first `<n> MB` as the heap that counts toward Hermes's
// cap: Hades counts external bytes (ArrayBuffers, big strings) toward it, so the first number is
// live + external. `frames` is the canvas frames drawn since launch, a running count (the soak
// derives fps from it). The web logs its console line (performance.memory) while connected.

import type { NativeModule } from '../app.contract.d.ts';

const PERIOD_MS = 30_000;
/** The heap ceiling our Exact runs with (app/scripts/exact-patches/0001-heap-512m.patch). */
const CAP_MB = 512;
const MB = (bytes: number) => (bytes / 1_048_576).toFixed(1);
let lastAt = -Infinity;

type HeapStats = Record<string, number>;
type WebMemory = { usedJSHeapSize?: number; totalJSHeapSize?: number; jsHeapSizeLimit?: number };
type RuntimeMemory = {
  HermesInternal?: { getInstrumentedStats?: () => HeapStats };
  performance?: { memory?: WebMemory };
};

/** Canvas frames drawn since launch: display frames in which at least one surface drew. */
let frames = 0, frameAt = NaN;
/** From each draw that records (app.ts drawSurface): counts its frame once, however many
 *  surfaces draw in it. */
export function noteFrame(time: number): void {
  if (time !== frameAt) { frameAt = time; frames++; }
}
export const framesDrawn = (): number => frames;

/** Hermes's instrumented stats, or null off Hermes (the web, Bun). Cheap: a struct read. */
export function hermesStats(): HeapStats | null {
  try {
    const s = (globalThis as RuntimeMemory).HermesInternal?.getInstrumentedStats?.();
    return s && Number(s.js_allocatedBytes) >= 0 ? s : null;
  } catch {
    return null;
  }
}

/** The macOS line, from Hermes's stats. */
export function heapLine(s: HeapStats, n = frames): string {
  const live = Number(s.js_allocatedBytes ?? s.js_heapSize ?? 0) || 0, ext = Number(s.js_externalBytes ?? 0) || 0;
  return `heap: ${MB(live + ext)} MB · live ${MB(live)} · ext ${MB(ext)} · cap ${CAP_MB} · frames ${n}`;
}

/** Called from the overview source (a data turn, 4 times a second), with the module's native
 *  side. `connected` gates the web's console line only: the native line runs from launch. */
export function logHeap(at: number, native: NativeModule | null | undefined, connected: boolean): void {
  if (!Number.isFinite(at) || at - lastAt < PERIOD_MS) return;
  const stats = hermesStats();
  if (stats) {
    lastAt = at;
    const line = heapLine(stats);
    try {
      if (native?.available) { native.call({ op: 'heapLog', line }); return; }
    } catch { /* a module with no heapLog: the console has it */ }
    console.log(line);
    return;
  }
  if (!connected) return;
  lastAt = at;
  const memory = (globalThis as RuntimeMemory).performance?.memory;
  const used = Number(memory?.usedJSHeapSize ?? 0) || 0;
  if (used <= 0) return;
  const total = Number(memory?.totalJSHeapSize ?? 0) || 0;
  const limit = Number(memory?.jsHeapSizeLimit ?? 0) || 0;
  console.log(`heap: ${MB(used)} MB live${total > 0 ? ` · ${MB(total)} MB total` : ''}${limit > 0 ? ` · ${MB(limit)} MB limit` : ''}`);
}
