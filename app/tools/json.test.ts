// parseLarge (src/json.ts) is JSON.parse, in turns: the fixtures, the hour's frames, and arrays
// built to fool its fast path (a run cut where `,{"<first key>":` sits inside a string or a
// nested object must not parse as a run).   bun app/tools/json.test.ts
import { readFileSync } from 'node:fs';
import { parseLarge } from '../src/json.ts';

let failed = 0;
const ok = (c: boolean, what: string) => { console.log(`${c ? 'ok' : 'FAIL'} ${what}`); if (!c) failed++; };
const same = async (what: string, text: string) => {
  let y = 0;
  const v = await parseLarge(text, async () => { y++; });
  ok(JSON.stringify(v) === JSON.stringify(JSON.parse(text)), `${what}: = JSON.parse (${text.length} B, ${y} yields)`);
};
const fx = new URL('../../contract/fixtures/', import.meta.url).pathname;
const snap = readFileSync(`${fx}snapshot.json`, 'utf8');
await same('the snapshot', snap);
await same('the snapshot, indented', JSON.stringify(JSON.parse(snap), null, 1));
let frames = 0, bad = 0;
for (const l of readFileSync(`${fx}hour.jsonl`, 'utf8').split('\n').filter(Boolean)) { frames++; if (JSON.stringify(await parseLarge(l, async () => {})) !== JSON.stringify(JSON.parse(l))) bad++; }
ok(bad === 0, `the hour's ${frames} frames = JSON.parse`);
const mk = (i: number) => ({ id: `p${i}`, title: i % 7 === 0 ? `x},{"id":"evil${i}` : `t${i}`, steps: Array.from({ length: i % 5 }, (_, k) => ({ id: `s${k}`, name: `n},{"id":${k}`, sub: [{ id: 'z' }, { id: 'y', q: '"},{"id":' }] })), nested: { id: i, more: [{ id: i }] } });
await same('objects whose strings and nested objects hold the cut', JSON.stringify({ pipelines: Array.from({ length: 3000 }, (_, i) => mk(i)), other: [1, 2, 3], s: 'a' }));
await same('a top-level array', JSON.stringify(Array.from({ length: 2000 }, (_, i) => mk(i))));
await same('escapes', JSON.stringify({ a: Array.from({ length: 4000 }, (_, i) => ({ id: `q\\"},{\\"id\\":${i}\\\\`, v: '\u2028 ü 😀 }]', w: [[{ id: 1 }], { id: 2 }] })) }));
await same('mixed first keys', JSON.stringify({ a: Array.from({ length: 4000 }, (_, i) => (i % 3 ? { id: i, x: 'y'.repeat(i % 50) } : { other: i, id: 'k' })) }));
await same('elements larger than a run', JSON.stringify({ a: Array.from({ length: 30 }, (_, i) => ({ id: i, blob: 'z'.repeat(60_000 + i) })) }));
console.log(failed ? `${failed} FAILED` : 'json: all ok');
process.exit(failed ? 1 : 0);
