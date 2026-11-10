// A JSON parse that yields. On native hosts each turn of a data-module answer has 100 ms
// (docs/contract-for-agents.md, "A large response needs a parse that yields"), and one
// JSON.parse of a 3 MB snapshot can take longer than that on Hermes. This splits the text at
// the top level: an object's members, and each large array into runs of whole elements of
// about CHUNK bytes, parses each piece on its own and yields between pieces.

const CHUNK = 192 * 1024;

type Yield = () => Promise<void>;

const defaultYield: Yield = async () => {
  const s = (globalThis as { scheduler?: { yield?: () => Promise<void> } }).scheduler;
  if (s?.yield) await s.yield();
};

/** Parses `text` like JSON.parse, yielding between pieces. */
export async function parseLarge<T = unknown>(text: string, yieldTurn: Yield = defaultYield): Promise<T> {
  if (text.length <= CHUNK) return JSON.parse(text) as T;
  const i = skipWs(text, 0);
  const [v] = await parseValue(text, i, endOfValue(text, i), yieldTurn);
  return v as T;
}

/** The value in text[i, end): small ones in one JSON.parse, large objects and arrays piece by piece. */
async function parseValue(text: string, i: number, end: number, yieldTurn: Yield): Promise<[unknown, number]> {
  const c = text.charCodeAt(i);
  if (end - i <= CHUNK || (c !== 0x7b && c !== 0x5b)) return [JSON.parse(text.slice(i, end)), end];
  if (c === 0x5b) return parseArray(text, i, yieldTurn);
  const out: Record<string, unknown> = {};
  i++;
  let budget = 0;
  for (;;) {
    i = skipWs(text, i);
    if (text.charCodeAt(i) === 0x7d /* } */) return [out, i + 1];
    const keyEnd = endOfString(text, i);
    const key = JSON.parse(text.slice(i, keyEnd)) as string;
    i = skipWs(text, keyEnd);
    i = skipWs(text, i + 1); // the colon
    const vEnd = endOfValue(text, i);
    const [v] = await parseValue(text, i, vEnd, yieldTurn);
    out[key] = v;
    budget += vEnd - i;
    i = vEnd;
    if (budget > CHUNK) { await yieldTurn(); budget = 0; }
    i = skipWs(text, i);
    if (text.charCodeAt(i) === 0x2c /* , */) i++;
  }
}

async function parseArray(text: string, start: number, yieldTurn: Yield): Promise<[unknown[], number]> {
  const out: unknown[] = [];
  let i = skipWs(text, start + 1);
  if (text.charCodeAt(i) === 0x5d /* ] */) return [out, i + 1];
  let runStart = i;
  for (;;) {
    const end = endOfValue(text, i);
    if (end - i > CHUNK) {
      // one huge element (a history's base inside its frames): its own piecewise parse
      if (i > runStart) {
        for (const v of JSON.parse(`[${text.slice(runStart, skipBackComma(text, i))}]`) as unknown[]) out.push(v);
      }
      const [v] = await parseValue(text, i, end, yieldTurn);
      out.push(v);
      runStart = -1;
    }
    let j = skipWs(text, end);
    const last = text.charCodeAt(j) === 0x5d;
    if (runStart >= 0 && (last || end - runStart >= CHUNK)) {
      for (const v of JSON.parse(`[${text.slice(runStart, end)}]`) as unknown[]) out.push(v);
      if (!last) await yieldTurn();
      runStart = -1;
    }
    if (last) return [out, j + 1];
    j = skipWs(text, j + 1); // past the comma
    i = j;
    if (runStart < 0) runStart = i;
  }
}

/** The index of the comma before `i` (exclusive end of the run before an element at `i`). */
function skipBackComma(t: string, i: number): number {
  let k = i - 1;
  while (k > 0 && t.charCodeAt(k) !== 0x2c) k--;
  return k;
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
