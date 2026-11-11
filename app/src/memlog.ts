// oom: what the data module holds, measured (macOS 0.1.3 died of a Hermes OOM after ~18 min live:
// the native data module has a 64 MiB heap). Two instruments, both off unless asked (the HUD, or a
// test's `memLog.on`):
//
//   - the heap line, every 30 s of the module clock: the engine's heap (Hermes: its live bytes; Exact
//     collects between calls, so after a turn it is ~ the live set) and the size of every structure
//     that could accumulate (app.ts `memStats`);
//   - a census by path (`Census`): a breadth-first walk of the object graph from the module's roots,
//     a slice of objects per data turn (never one long turn), summing per path pattern the entries of
//     the Maps, Sets and arrays found there; two censuses diffed name what grew. Closures and
//     promises are opaque to it.

/** The switches: `on` a test's (tools/soak.ts), `hud` the HUD's (app.ts sets it each tick), `env`
 *  SWITCHYARD_HEAPLOG=1's (macOS); `every`
 *  ms between heap lines, `census` ms between censuses; `high` bytes (live + external) over which a
 *  turn logs its name (the spikes). */
export const memLog = { on: false, hud: false, env: false, every: 30_000, census: 120_000, high: 40 << 20, highWas: 0 };
/** On: a test's switch, the HUD, or SWITCHYARD_HEAPLOG=1 (macOS: the module says, Hooks.swift). */
export const memOn = (): boolean => memLog.on || memLog.hud || memLog.env;

/** Hermes' live and external bytes now (0, 0 elsewhere). */
export function heapBytes(): { live: number; ext: number } {
  try {
    const st = (globalThis as { HermesInternal?: { getInstrumentedStats?: () => Record<string, number> } }).HermesInternal?.getInstrumentedStats?.();
    return { live: Number(st?.js_allocatedBytes ?? 0) || 0, ext: Number(st?.js_externalBytes ?? 0) || 0 };
  } catch { return { live: 0, ext: 0 }; }
}
const MB = (b: number) => (b / 1048576).toFixed(1);

/** A fetch's reply as it is read (`bytes` of text) and parsed: `heap: fetch <path> …`, with the heap
 *  before the read, after it and after the parse. Only while the instruments are on. */
export async function noteParse<T>(path: string, text: string, before: { live: number; ext: number }, parse: () => Promise<T>): Promise<T> {
  if (!memOn()) return parse();
  const read = heapBytes();
  const v = await parse();
  const done = heapBytes();
  console.log(`heap: fetch ${path.slice(0, 80)} ${text.length} B · live ${MB(before.live)} → ${MB(read.live)} read → ${MB(done.live)} MB parsed · ext ${MB(done.ext)} MB`);
  return v;
}

/** External bytes (Hermes: array buffers, external strings) gained per kind of turn since the last
 *  heap line, and between turns (collections, continuations): which turn grows them. */
const extBy = new Map<string, number>();
let extStart = -1, extEnd = -1;
/** At a turn's start (a draw, a source's answer, a stream message). */
export function turnStart(): void {
  if (!memOn()) return;
  const e = heapBytes().ext;
  if (extEnd >= 0) extBy.set('between', (extBy.get('between') ?? 0) + e - extEnd);
  extStart = e;
}
/** The biggest gains (and losses) since the last call, in MB, and starts afresh. */
export function extByLine(): string {
  const xs = [...extBy].filter(([, v]) => Math.abs(v) >= 1024).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1])).slice(0, 6);
  extBy.clear();
  return xs.map(([k, v]) => `${k} ${v >= 0 ? '+' : ''}${(v / 1048576).toFixed(2)}`).join(', ');
}

/** After a turn (a draw, a source's answer, a stream message): when live + external bytes pass
 *  `memLog.high` (and each 4 MB above it), `heap: high <MB> after <what>`. */
export function noteTurn(what: string): void {
  if (!memOn()) return;
  const h = heapBytes(), t = h.live + h.ext;
  if (extStart >= 0) extBy.set(what, (extBy.get(what) ?? 0) + h.ext - extStart);
  extStart = -1; extEnd = h.ext;
  if (t < memLog.high) { memLog.highWas = 0; return; }
  if (t < memLog.highWas + (4 << 20)) return;
  memLog.highWas = t;
  console.log(`heap: high ${MB(t)} MB (live ${MB(h.live)} · ext ${MB(h.ext)}) after ${what}`);
}

/** The engine's heap numbers: Hermes' `getInstrumentedStats` (js_*), {} elsewhere. */
export function engineStats(): Record<string, number> {
  try {
    const st = (globalThis as { HermesInternal?: { getInstrumentedStats?: () => Record<string, unknown> } }).HermesInternal?.getInstrumentedStats?.();
    const out: Record<string, number> = {};
    if (st) for (const k of Object.keys(st)) { const v = st[k]; if (typeof v === 'number') out[k] = v; }
    return out;
  } catch { return {}; }
}

export type PathSize = { n: number; entries: number; bytes: number };
const ARR = '[]', MAPV = '{}', SETV = '<>';

/** A census of the object graph, walked a slice at a time. */
export class Census {
  readonly paths = new Map<string, PathSize>();
  objects = 0;
  done = false;
  private seen = new Set<object>();
  private qObj: unknown[] = [];
  private qPath: string[] = [];
  private i = 0;

  constructor(roots: Record<string, unknown>, private max = 400_000) {
    for (const k of Object.keys(roots)) this.push(roots[k], k);
  }

  private note(path: string, entries: number, bytes: number): void {
    let p = this.paths.get(path);
    if (!p) this.paths.set(path, (p = { n: 0, entries: 0, bytes: 0 }));
    p.n++; p.entries += entries; p.bytes += bytes;
  }

  private push(v: unknown, path: string): void {
    if (v === null || typeof v !== 'object') {
      if (typeof v === 'string' && v.length > 1024) this.note(`${path}:str`, 1, v.length);
      return;
    }
    if (this.seen.has(v)) return;
    this.seen.add(v);
    this.qObj.push(v); this.qPath.push(path);
  }

  /** Walks up to `budget` more objects; true once the walk is over. */
  step(budget: number): boolean {
    if (this.done) return true;
    let left = budget;
    while (left-- > 0) {
      if (this.i >= this.qObj.length || this.objects >= this.max) {
        this.done = true;
        this.seen = new Set(); this.qObj = []; this.qPath = [];
        return true;
      }
      const o = this.qObj[this.i] as object, p = this.qPath[this.i]!;
      this.qObj[this.i] = undefined; this.i++;
      this.objects++;
      if (o instanceof Map) {
        this.note(p, o.size, 0);
        for (const [k, v] of o) { if (k !== null && typeof k === 'object') this.push(k, `${p}{k}`); this.push(v, `${p}${MAPV}`); }
      } else if (o instanceof Set) {
        this.note(p, o.size, 0);
        for (const v of o) this.push(v, `${p}${SETV}`);
      } else if (Array.isArray(o)) {
        this.note(p, o.length, 0);
        for (let j = 0; j < o.length; j++) this.push(o[j], `${p}${ARR}`);
      } else if (ArrayBuffer.isView(o)) {
        this.note(p, (o as unknown as { length?: number }).length ?? 0, o.byteLength);
      } else if (o instanceof ArrayBuffer) {
        this.note(p, 0, o.byteLength);
      } else if (typeof o === 'function' || o instanceof Promise || o instanceof WeakMap || o instanceof WeakSet) {
        // opaque
      } else {
        let keys: string[];
        try { keys = Object.keys(o); } catch { continue; }
        // a record keyed by data (ids, shas) is a map in all but name
        if (keys.length > 64 && Object.getPrototypeOf(o) === Object.prototype) {
          this.note(`${p}#obj`, keys.length, 0);
          for (const k of keys) this.push((o as Record<string, unknown>)[k], `${p}${MAPV}`);
          continue;
        }
        for (const k of keys) {
          let v: unknown;
          try { v = (o as Record<string, unknown>)[k]; } catch { continue; }
          this.push(v, `${p}.${k}`);
        }
      }
    }
    return false;
  }

  /** The whole walk at once (tools; a data turn walks it in slices). */
  run(): this { while (!this.step(50_000)); return this; }
}

/** The path patterns whose entries grew most from `a` to `b`. */
export function grew(a: Census, b: Census, top = 12): { path: string; from: number; to: number; d: number }[] {
  const out: { path: string; from: number; to: number; d: number }[] = [];
  for (const [p, v] of b.paths) {
    const was = a.paths.get(p)?.entries ?? 0;
    if (v.entries > was) out.push({ path: p, from: was, to: v.entries, d: v.entries - was });
  }
  out.sort((x, y) => y.d - x.d);
  return out.slice(0, top);
}

/** A census's typed-array bytes and long-string characters in all, and the biggest byte holders. */
export function bytesOf(c: Census, top = 6): string {
  let all = 0;
  const xs: [string, number][] = [];
  for (const [p, v] of c.paths) if (v.bytes) { all += v.bytes; xs.push([p, v.bytes]); }
  xs.sort((a, b) => b[1] - a[1]);
  return `${(all / 1048576).toFixed(1)} MB of buffers and long strings (${xs.slice(0, top).map(([p, b]) => `${p} ${(b / 1048576).toFixed(2)}`).join(', ')})`;
}

/** The biggest path patterns of a census (entries). */
export function biggest(c: Census, top = 12): { path: string; entries: number; n: number }[] {
  return [...c.paths].map(([path, v]) => ({ path, entries: v.entries, n: v.n })).sort((x, y) => y.entries - x.entries).slice(0, top);
}
