// A JSON parse that yields. On native hosts each turn of a data-module answer has 100 ms
// (docs/contract-for-agents.md, "A large response needs a parse that yields"), and one
// JSON.parse of a 3 MB snapshot can take longer than that on Hermes. This splits the text at
// the top level: an object's members, and each large array into runs of whole elements of
// about CHUNK bytes, parses each piece on its own and yields between pieces.

/** Bytes of whole elements per JSON.parse (native, fast). */
const RUN = 32 * 1024;
/** Bytes the JS scanner (slow on Hermes: an interpreted loop) reads in one turn before it yields.
 *  A slow Mac (GitHub's 3-core M1 runner) ran a 2.2 MB scan in one ~300 ms turn; 48 KB is ~10 ms. */
const STEP = 32 * 1024;

type Yield = () => Promise<void>;

const defaultYield: Yield = async () => {
  const s = (globalThis as { scheduler?: { yield?: () => Promise<void> } }).scheduler;
  if (s?.yield) await s.yield();
};

/** The work done since the last yield, in bytes read (scanned or parsed). */
class Pace {
  spent = 0;
  constructor(readonly y: Yield) {}
  async add(n: number): Promise<void> {
    this.spent += n;
    if (this.spent >= STEP) { this.spent = 0; await this.y(); }
  }
}

/** Parses `text` like JSON.parse, yielding so that no turn reads much more than STEP bytes.
 *  `skip`: top-level keys left out (scanned past, never parsed: a history's `base` when the
 *  caller already has the state). Each byte is scanned about once: a container is read whole
 *  only when it is small (≤ RUN), else member by member, element by element. */
export async function parseLarge<T = unknown>(text: string, yieldTurn: Yield = defaultYield, skip?: Set<string>): Promise<T> {
  if (text.length <= RUN && !skip) return JSON.parse(text) as T;
  const p = new Pace(yieldTurn);
  const [v] = await parseValue(text, skipWs(text, 0), p, skip);
  return v as T;
}

async function parseValue(t: string, i: number, p: Pace, skip?: Set<string>): Promise<[unknown, number]> {
  const c = t.charCodeAt(i);
  if (c !== 0x7b && c !== 0x5b) {
    const e = endOfValue(t, i);
    await p.add(e - i);
    return [JSON.parse(t.slice(i, e)), e];
  }
  if (!skip) {
    const e = endBounded(t, i, RUN);
    if (e >= 0) {
      const v = JSON.parse(t.slice(i, e));
      await p.add(2 * (e - i));
      return [v, e];
    }
    await p.add(RUN);
  }
  return c === 0x5b ? parseArray(t, i, p) : parseObject(t, i, p, skip);
}

async function parseObject(t: string, i: number, p: Pace, skip?: Set<string>): Promise<[unknown, number]> {
  const out: Record<string, unknown> = {};
  i = skipWs(t, i + 1);
  if (t.charCodeAt(i) === 0x7d /* } */) return [out, i + 1];
  for (;;) {
    const ke = endOfString(t, i);
    const key = JSON.parse(t.slice(i, ke)) as string;
    i = skipWs(t, ke);
    i = skipWs(t, i + 1); // the colon
    if (skip?.has(key)) i = await skipValue(t, i, p);
    else {
      const [v, e] = await parseValue(t, i, p);
      out[key] = v;
      i = e;
    }
    i = skipWs(t, i);
    const ch = t.charCodeAt(i);
    if (ch === 0x2c /* , */) { i = skipWs(t, i + 1); continue; }
    if (ch === 0x7d) return [out, i + 1];
    throw new SyntaxError(`JSON: expected , or } at ${i}`);
  }
}

async function parseArray(t: string, i: number, p: Pace): Promise<[unknown[], number]> {
  const out: unknown[] = [];
  i = skipWs(t, i + 1);
  if (t.charCodeAt(i) === 0x5d /* ] */) return [out, i + 1];
  let runStart = -1, runEnd = -1;
  const flush = async () => {
    if (runStart < 0) return;
    const n = runEnd - runStart;
    for (const v of JSON.parse(`[${t.slice(runStart, runEnd)}]`) as unknown[]) out.push(v);
    runStart = -1;
    await p.add(n);
  };
  for (;;) {
    const c = t.charCodeAt(i);
    const e = c === 0x7b || c === 0x5b ? endBounded(t, i, RUN) : endOfValue(t, i);
    if (e < 0) {
      // one large element (a history's base inside its frames): its own piecewise parse
      await flush();
      await p.add(RUN);
      const [v, ee] = await parseValue(t, i, p);
      out.push(v);
      i = ee;
    } else {
      if (runStart < 0) runStart = i;
      runEnd = e;
      const n = e - i;
      i = e;
      if (runEnd - runStart >= RUN) await flush();
      await p.add(n);
    }
    i = skipWs(t, i);
    const ch = t.charCodeAt(i);
    if (ch === 0x2c /* , */) { i = skipWs(t, i + 1); continue; }
    if (ch === 0x5d) { await flush(); return [out, i + 1]; }
    throw new SyntaxError(`JSON: expected , or ] at ${i}`);
  }
}

/** Past a value without parsing it, yielding as it scans. */
async function skipValue(t: string, i: number, p: Pace): Promise<number> {
  const c = t.charCodeAt(i);
  if (c !== 0x7b && c !== 0x5b) return endOfValue(t, i);
  let depth = 0, from = i;
  for (let j = i; j < t.length; j++) {
    const d = t.charCodeAt(j);
    if (d === 0x22) { j = endOfString(t, j) - 1; }
    else if (d === 0x7b || d === 0x5b) depth++;
    else if (d === 0x7d || d === 0x5d) { depth--; if (depth === 0) { await p.add(j + 1 - from); return j + 1; } }
    if (j - from >= STEP) { await p.add(j - from); from = j; }
  }
  throw new SyntaxError('unterminated value');
}

/** The end of the container at `i` if it ends within `max` bytes, else -1 (read no further). */
function endBounded(t: string, i: number, max: number): number {
  let depth = 0;
  const stop = Math.min(t.length, i + max);
  for (let j = i; j < stop; j++) {
    const d = t.charCodeAt(j);
    if (d === 0x22) { j = endOfString(t, j) - 1; if (j >= stop) return -1; continue; }
    if (d === 0x7b || d === 0x5b) depth++;
    else if (d === 0x7d || d === 0x5d) { depth--; if (depth === 0) return j + 1; }
  }
  return -1;
}

function skipWs(t: string, i: number): number {
  for (;;) {
    const c = t.charCodeAt(i);
    if (c === 0x20 || c === 0x0a || c === 0x0d || c === 0x09) i++;
    else return i;
  }
}

/** The index just past the string that starts at `i` (a `"`). */
function endOfString(t: string, i: number): number {
  i++;
  for (;;) {
    const q = t.indexOf('"', i);
    if (q < 0) throw new SyntaxError('unterminated string');
    let k = q - 1, bs = 0;
    while (t.charCodeAt(k) === 0x5c /* \ */) { bs++; k--; }
    if (bs % 2 === 0) return q + 1;
    i = q + 1;
  }
}

/** The index just past the JSON value that starts at `i`. */
function endOfValue(t: string, i: number): number {
  const c = t.charCodeAt(i);
  if (c === 0x22) return endOfString(t, i);
  if (c !== 0x7b && c !== 0x5b) {
    // a number, true, false or null
    let j = i;
    for (;;) {
      const d = t.charCodeAt(j);
      if (d === 0x2c || d === 0x7d || d === 0x5d || d === 0x20 || d === 0x0a || d === 0x0d || d === 0x09 || Number.isNaN(d)) return j;
      j++;
    }
  }
  let depth = 0;
  for (let j = i; j < t.length; j++) {
    const d = t.charCodeAt(j);
    if (d === 0x22) { j = endOfString(t, j) - 1; continue; }
    if (d === 0x7b || d === 0x5b) depth++;
    else if (d === 0x7d || d === 0x5d) { depth--; if (depth === 0) return j + 1; }
  }
  throw new SyntaxError('unterminated value');
}
