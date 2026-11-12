// p6: what the board's one-second redraw costs, by part (boardOf, sceneOf, diffOps, the paint),
// on the recorded fleet with its runs still running (the frozen mock's picture): 60 seconds,
// one draw a second, as the 1 s timer tick asks. BUN_JSC_useJIT=0 for an interpreter's proportions.
//   BUN_JSC_useJIT=0 bun tools/f3-sec.ts [--secs 60]
import { readFileSync } from 'node:fs';
import { World } from '../src/world.ts';
import type { Snapshot } from '../src/wire.ts';
import { SlotBook, boardOf, windowMs } from '../src/factory3/model.ts';
import { layoutOf, sceneOf, type Op, type SceneOpts } from '../src/factory3/scene.ts';
import { Board3, diffOps } from '../src/factory3/board.ts';

const args = process.argv.slice(2);
const secs = Number(args.includes('--secs') ? args[args.indexOf('--secs') + 1] : 60);
const here = new URL('.', import.meta.url).pathname;
const snap = JSON.parse(readFileSync(`${here}../../contract/fixtures/snapshot.json`, 'utf8')) as Snapshot & { at: number };
const w = new World();
w.load(snap);
const L = layoutOf(1440, 840);
const OPTS: SceneOpts = { win: '30m', sel: '', mode: 'live', dock: false, hidden: new Set(), hov: '' };
const t0 = Math.floor(snap.at / 60_000) * 60_000 + 60_000;
const T: Record<string, number[]> = { boardOf: [], sceneOf: [], diffOps: [], draw: [] };
const time = (k: string, f: () => unknown) => { const s = performance.now(); const r = f(); T[k].push(performance.now() - s); return r; };
const book = new SlotBook();
let prev: Op[] | null = null;
for (let i = 0; i < secs; i++) {
  const now = t0 + i * 1000 + 137;
  const b = time('boardOf', () => boardOf(w, now, windowMs('30m'), book)) as ReturnType<typeof boardOf>;
  const s = time('sceneOf', () => sceneOf(b, L, OPTS)) as ReturnType<typeof sceneOf>;
  if (prev) { const out: number[] = []; time('diffOps', () => diffOps(prev!, s.ops, L.s, out)); }
  prev = s.ops;
}
// the whole draw, through Board3 with a canvas that does nothing
const nop = () => {};
const ctx = new Proxy({ measureText: (s: string) => ({ width: s.length * 7 }) } as Record<string, unknown>, { get: (o, k) => (k in o ? o[k as string] : nop), set: () => true });
const board = new Board3();
for (let i = 0; i < secs; i++) {
  const f = { width: 1440, height: 840, scale: 2, time: 1000 + i * 1000, cause: i ? 'args' : 'mount', causes: [i ? 'args' : 'mount'] } as never;
  time('draw', () => board.drawBoard(ctx as never, f, w, t0 + i * 1000 + 137, { win: '30m', sel: '', mode: 'live', reduced: false, dock: false, hov: '' }));
}
const q = (a: number[], p: number) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))] ?? 0; };
for (const [k, a] of Object.entries(T)) console.log(`${k.padEnd(8)} n ${String(a.length).padStart(3)} · p50 ${q(a, 0.5).toFixed(3)} · p90 ${q(a, 0.9).toFixed(3)} · mean ${(a.reduce((x, y) => x + y, 0) / Math.max(1, a.length)).toFixed(3)} ms`);
console.log(board.workLine());
