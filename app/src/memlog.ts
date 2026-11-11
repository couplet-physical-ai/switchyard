// One bounded, periodic memory line for a connected session. No object-graph census or history.

const PERIOD_MS = 30_000;
const MB = (bytes: number) => (bytes / 1_048_576).toFixed(1);
let lastAt = 0;

type HeapStats = Record<string, number>;
type WebMemory = { usedJSHeapSize?: number; totalJSHeapSize?: number; jsHeapSizeLimit?: number };
type RuntimeMemory = {
  HermesInternal?: { getInstrumentedStats?: () => HeapStats };
  performance?: { memory?: WebMemory };
};

/** Called from the overview source; its module-clock cadence is stable on web and native. */
export function logHeap(at: number): void {
  if (!Number.isFinite(at) || at - lastAt < PERIOD_MS) return;
  lastAt = at;

  const runtime = globalThis as RuntimeMemory;
  try {
    const stats = runtime.HermesInternal?.getInstrumentedStats?.();
    const live = Number(stats?.js_allocatedBytes ?? stats?.js_heapSize ?? 0) || 0;
    if (live > 0) {
      const external = Number(stats?.js_externalBytes ?? 0) || 0;
      console.log(`heap: ${MB(live)} MB live${external > 0 ? ` · ${MB(external)} MB external` : ''}`);
      return;
    }
  } catch { /* the browser memory report below may still be available */ }

  const memory = runtime.performance?.memory;
  const used = Number(memory?.usedJSHeapSize ?? 0) || 0;
  if (used <= 0) return;
  const total = Number(memory?.totalJSHeapSize ?? 0) || 0;
  const limit = Number(memory?.jsHeapSizeLimit ?? 0) || 0;
  console.log(`heap: ${MB(used)} MB live${total > 0 ? ` · ${MB(total)} MB total` : ''}${limit > 0 ? ` · ${MB(limit)} MB limit` : ''}`);
}
