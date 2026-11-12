// Factory 3, "the berth board" (src/factory3/): the model, the scene and the motion rule, on the
// recorded fleet (contract/fixtures) and on small hand-made changes to it. Run:
//   bun app/tools/factory3.test.ts
//
// The rule it proves (FACTORY3.md, "Motion is data"): with no work running and no new event, the
// frame is the same from one second to the next (the same draw list, so the same pixels), the
// board canvas is painted once, and the moving layer never. A transit starts only when a run
// changes place between two versions of the world, one transit per square.
import { readFileSync } from 'node:fs';
import { World } from '../src/world.ts';
import type { Frame as WireFrame, Pipeline, Snapshot } from '../src/wire.ts';
import { SlotBook, WINDOWS, boardAt, boardOf, windowMs } from '../src/factory3/model.ts';
import { PLACE, ageAt, layoutOf, sceneOf, timer, type SceneOpts } from '../src/factory3/scene.ts';
import { Board3, diffOps } from '../src/factory3/board.ts';
import { f3Detail, tidyLog } from '../src/factory3/inspect.ts';

let fails = 0;
const ok = (c: unknown, m: string) => { if (c) console.log('ok', m); else { fails++; console.log('FAIL', m); } };
const eq = (a: unknown, b: unknown, m: string) => {
  const x = JSON.stringify(a), y = JSON.stringify(b);
  if (x === y) console.log('ok', m); else { fails++; console.log('FAIL', m, x, '!=', y); }
};
const here = new URL('.', import.meta.url).pathname;
const snap = JSON.parse(readFileSync(`${here}../../contract/fixtures/snapshot.json`, 'utf8')) as Snapshot & { at: number };
const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const OPTS: SceneOpts = { win: '30m', sel: '', mode: 'live', dock: false, hidden: new Set(), hov: '' };
const L = layoutOf(1440, 840);
/** the first second of a minute: 59 more seconds before any age turns */
const minuteOf = (t: number) => Math.floor(t / 60_000) * 60_000;

/** The recorded fleet with nothing running, waiting or deploying: an idle fleet. */
function idleSnap(): Snapshot & { at: number } {
  const s = clone(snap) as any;
  const live = new Set<string>();
  s.pipelines = s.pipelines.filter((p: Pipeline) => {
    const l = p.state === 'running' || p.state === 'pending' || p.state === 'blocked';
    if (l && p.id) live.add(p.id);
    return !l;
  });
  for (const e of s.engines) { e.running = []; e.busy = 0; }
  for (const q of s.queues) { q.items = []; q.pending = 0; q.running = 0; q.waiting = 0; q.oldest_wait_ms = 0; q.pipelines_running = 0; }
  s.deploys = s.deploys.filter((d: any) => d.state === 'success' || d.state === 'failure');
  for (const c of s.commits ?? []) if (c.stage === 'pushed') c.stage = 'merged';
  return s;
}

/** A canvas that records what is drawn on it (the calls board.ts makes). */
function recorder() {
  const calls: string[] = [];
  const ctx = {
    fillStyle: '', font: '', textAlign: 'left', globalAlpha: 1,
    resetTransform() { /* identity */ },
    save() { calls.push('save'); }, restore() { calls.push('restore'); }, beginPath() { /* a path */ },
    rect(x: number, y: number, w: number, h: number) { calls.push(`clip-rect ${x},${y},${w},${h}`); }, clip() { calls.push('clip'); },
    clearRect(x: number, y: number, w: number, h: number) { calls.push(`clear ${x},${y},${w},${h}`); },
    fillRect(x: number, y: number, w: number, h: number) { calls.push(`rect ${this.fillStyle} ${x},${y},${w},${h}`); },
    fillText(s: string, x: number, y: number) { calls.push(`text ${this.fillStyle} ${this.font} ${this.textAlign} ${s} ${x},${y}`); },
    measureText(s: string) { const px = Number(/([\d.]+)px/.exec(this.font)?.[1] ?? 10); return { width: s.length * px * 0.6 }; },
  };
  return { ctx: ctx as any, calls };
}
const frame = (time: number, cause = 'args'): any => ({ width: 1440, height: 840, scale: 2, time, cause, causes: [cause] });
const ARGS = { win: '30m', sel: '', mode: 'live', reduced: false, dock: false, hov: '' };

// ───────────────────────── idle is still ─────────────────────────
{
  const w = new World();
  w.load(idleSnap());
  const t0 = minuteOf(snap.at) + 60_000;
  const book = new SlotBook();
  const b0 = boardOf(w, t0, windowMs('30m'), book);
  ok(b0.quiet, 'idle: the board says it is quiet (nothing runs, waits or deploys)');
  eq([b0.busy, b0.waiting.total, b0.deploy.running.length], [0, 0, 0], 'idle: 0 building, 0 waiting, 0 deploying');
  const s0 = sceneOf(b0, L, OPTS);
  ok(s0.ops.length > 300, `idle: the scene has ${s0.ops.length} marks and words (${s0.counts.squares} squares, ${s0.counts.texts} words)`);
  let same = true, anchorsSame = true;
  const a0 = JSON.stringify([...s0.anchors]);
  for (let sec = 1; sec < 60; sec++) {
    const s = sceneOf(boardOf(w, t0 + sec * 1000 + 137, windowMs('30m'), book), L, OPTS);
    if (s.key !== s0.key) { same = false; console.log('  differs at +', sec, 's'); break; }
    if (JSON.stringify([...s.anchors]) !== a0) anchorsSame = false;
  }
  ok(same, 'idle: 60 consecutive seconds give the same draw list (the same frame)');
  ok(anchorsSame, 'idle: nothing changes place in those 60 seconds');
  ok(!s0.ops.some((op) => op[0] === 't' && /\d:\d\d/.test(op[1])), 'idle: no m:ss timer anywhere on an idle board');
  const next = sceneOf(boardOf(w, t0 + 60_000, windowMs('30m'), book), L, OPTS);
  ok(next.key !== s0.key, 'idle: the next minute, the ages turn (once, all together)');
  // (the failed bin's window moves with the minute too: a result may leave it, nothing else)
  ok(Math.abs(next.counts.squares - s0.counts.squares) <= 6 && Math.abs(next.counts.texts - s0.counts.texts) <= 6, `idle: on the minute the ages turn and the window's edge moves (${next.counts.squares - s0.counts.squares} squares, ${next.counts.texts - s0.counts.texts} words)`);

  // the painter: one paint, then none; the moving layer never
  const board = new Board3();
  const A = recorder(), B = recorder();
  let more = board.drawBoard(A.ctx, frame(1000, 'mount'), w, t0, ARGS);
  const liveClaim = board.drawLive(B.ctx, frame(1000, 'mount'));
  const painted = A.calls.length;
  // (p5-board: the live layer's first draw on a fresh bitmap asks for ONE more frame, so macOS
  // gives the canvas to its GPU module: Board3.gpuClaim. p6: the board asks for none, so Core
  // Graphics keeps it: its second's repaint is a few boxes into the bitmap, not a GPU replay)
  ok(painted > 300 && !more && liveClaim, `idle: the first frame paints the board (${painted} calls); the moving layer asks for one more (the GPU claim), the board for none`);
  const firstPaint = A.calls.findIndex((c) => c.startsWith('clear') || c.startsWith('rect') || c.startsWith('text'));
  ok(firstPaint > 0 && A.calls[firstPaint] === 'clear 0,0,1440,840' && A.calls.slice(0, firstPaint).join('|') === 'save|clip-rect 0,0,1440,840|clip' && A.calls[firstPaint + 1] === 'restore',
    'p6: the whole paint\'s clear is clipped to the canvas (the host never takes the board\'s list for a cover: Core Animation never records it)');
  more = board.drawBoard(A.ctx, frame(1016), w, t0 + 16, ARGS);
  const liveNext = board.drawLive(B.ctx, frame(1016));
  ok(!more && !liveNext && A.calls.length === painted, 'idle: that frame paints nothing and asks for no other');
  eq(board.stats.claims, 1, 'idle: one claim, the moving layer\'s');
  const liveFirst = B.calls.length;
  let asked = false;
  for (let i = 1; i <= 240; i++) {
    // 60 s of frames, four a second (the view's tick), the clock moving on
    more = board.drawBoard(A.ctx, frame(1000 + i * 250), w, t0 + i * 250 - 1, ARGS) || more;
    asked = board.drawLive(B.ctx, frame(1000 + i * 250)) || asked;
  }
  eq(A.calls.length, painted, 'idle: 240 more frames over 60 s paint nothing on the board canvas');
  eq(B.calls.length, liveFirst, 'idle: the moving layer is never painted');
  ok(!more && !asked, 'idle: no frame is ever asked for');
  eq([board.stats.paints, board.stats.livePaints, board.stats.transits], [1, 0, 0], 'idle: 1 paint, 0 live paints, 0 transits');
  // a mount skipped while covered (app.ts): the next draw is the fresh bitmap's first, whole (p6: and asks for no frame)
  const C = recorder(), b3 = new Board3();
  b3.skipped('board', frame(500, 'mount'));
  ok(!b3.drawBoard(C.ctx, frame(600), w, t0, ARGS) && C.calls.includes('clear 0,0,1440,840'), 'covered mount: the next draw paints the board whole and asks for no frame');
  // the A/B switch (SWITCHYARD_CANVAS=board): the board claims the GPU and clears unclipped, as in pass 5
  Board3.boardGpu = true;
  const G = recorder(), b4 = new Board3(), G2 = recorder();
  ok(b4.drawBoard(G.ctx, frame(700, 'mount'), w, t0, ARGS) && b4.drawLive(G2.ctx, frame(700, 'mount')) && !G.calls.includes('clip') && b4.stats.claims === 2, 'SWITCHYARD_CANVAS=board: both layers claim the GPU, the clear unclipped (pass 5)');
  Board3.boardGpu = false;
  ok(board.stats.builds <= 3, `idle: the scene is not even rebuilt each second (${board.stats.builds} builds in 60 s)`);
  ok(board.still, 'idle: the board reports itself still');
}

// ───────────────────────── live work ticks, and only its own words ─────────────────────────
{
  const w = new World();
  w.load(clone(snap));
  const t0 = minuteOf(snap.at) + 60_000;
  const book = new SlotBook();
  const b = boardOf(w, t0, windowMs('30m'), book);
  ok(!b.quiet, 'live: with runs on slots the board is not quiet');
  eq(b.machines.map((m) => `${m.label} ${m.busy}/${m.slots.length}`), ['vm 153 0/6', 'vm 154 2/6', 'actions 1/4'], 'live: the machines and their berths');
  eq([b.busy, b.slots, b.waiting.total], [3, 16, 1], 'live: 3 of 16 berths busy, 1 waiting');
  const s0 = sceneOf(b, L, OPTS), s1 = sceneOf(boardOf(w, t0 + 1000, windowMs('30m'), book), L, OPTS);
  ok(s0.key !== s1.key, 'live: a second later the frame differs');
  const diff = s1.ops.filter((op, i) => JSON.stringify(op) !== JSON.stringify(s0.ops[i]));
  ok(diff.length > 0 && diff.length <= 12, `live: ${diff.length} marks differ (the timers and fills of what runs)`);
  ok(diff.every((op) => (op[0] === 't' ? /\d:\d\d|\dh \d\dm/.test(op[1]) : true)), 'live: every word that changed is a timer');
  eq(JSON.stringify([...s0.anchors]), JSON.stringify([...s1.anchors]), 'live: a timer ticking moves nothing');
  // every run is in one place
  for (const [id, a] of s0.anchors) if (!id.endsWith('#bin') && !id.startsWith('d:')) { if (new Set(a.map((x) => x.place)).size !== 1) ok(false, `one place: ${id}`); }
  ok(true, 'live: every run is in exactly one station');
  const slotIds = b.machines.flatMap((m) => m.slots.filter((x) => x.run).map((x) => x.run!.id));
  ok(slotIds.every((id) => s0.anchors.get(id)?.[0].place === PLACE.slot), 'live: each running run is anchored in its berth');
  ok(b.waiting.items.every((r) => s0.anchors.get(r.id)?.[0].place === PLACE.wait), 'live: each waiting run is anchored in the waiting bay');
}

// ───────────────────────── a run changes place: one transit, then still again ─────────────────────────
{
  const w = new World();
  w.load(clone(snap));
  const t0 = minuteOf(snap.at) + 60_000;
  const board = new Board3();
  const A = recorder(), B = recorder();
  board.drawBoard(A.ctx, frame(1000, 'mount'), w, t0, ARGS);
  board.drawLive(B.ctx, frame(1000, 'mount'));
  eq(board.stats.transits, 0, 'move: opening the board on running work starts no transit');
  // one second later, nothing new: still no transit
  const before = A.calls.length;
  board.drawBoard(A.ctx, frame(2000), w, t0 + 1000, ARGS);
  eq(board.stats.transits, 0, 'move: a tick of the clock starts no transit');
  // the tick repaints its timers and crates only: cleared and clipped boxes, not the whole board
  const tickCalls = A.calls.slice(before);
  ok(board.stats.dirty > 0 && board.stats.dirty <= 0.01 && !tickCalls.includes('clear 0,0,1440,840') && tickCalls.includes('clip'), `tick: a second repaints ${(board.stats.dirty * 100).toFixed(2)} % of the board (≤ 1 %), ${board.stats.redrawn} of ${board.stats.ops} marks`);
  // a running run finishes (a real frame from the server)
  const eng = [...w.engines.values()].find((e) => e.running.some((id) => w.pipelines.get(id)?.state === 'running'))!;
  const run = w.pipelines.get(eng.running[0])!;
  const f: WireFrame = {
    t: 'delta', seq: w.seq + 1, at: t0 + 2000, ops: [
      { op: 'patch', kind: 'pipeline', id: run.id!, v: { state: 'success', finished: t0 + 2000 } },
      { op: 'patch', kind: 'engine', id: eng.id, v: { running: eng.running.filter((x) => x !== run.id), busy: Math.max(0, eng.busy - 1) } },
    ],
  } as WireFrame;
  ok(w.apply(f), 'move: the server says a run finished');
  let more = board.drawBoard(A.ctx, frame(3000), w, t0 + 2000, ARGS);
  eq(board.stats.transits, 1, 'move: one transit starts (berth → result)');
  ok(more && board.moving, 'move: the board asks for frames while it travels');
  let livePaints = 0;
  for (let t = 3000; t <= 4400; t += 16) {
    board.drawBoard(A.ctx, frame(t), w, t0 + 2000 + (t - 3000), ARGS);
    const n = B.calls.length;
    board.drawLive(B.ctx, frame(t));
    if (B.calls.some((c, i) => i >= n && c.startsWith('rect'))) livePaints++;
  }
  ok(livePaints > 10 && livePaints < 70, `move: the square is drawn for ${livePaints} frames (under a second), then no more`);
  ok(!board.moving, 'move: it has landed');
  eq(B.calls[B.calls.length - 1].startsWith('clear'), true, 'move: the moving layer is left empty');
  const n = B.calls.length, paints = board.stats.paints;
  for (let t = 4400; t <= 6400; t += 250) { board.drawBoard(A.ctx, frame(t), w, t0 + 2000 + (t - 3000), ARGS); board.drawLive(B.ctx, frame(t)); }
  eq(B.calls.length, n, 'move: after it lands the moving layer is not painted again');
  eq(board.stats.transits, 1, 'move: and no other transit starts');
  ok(board.stats.paints - paints <= 3, 'move: the board repaints only as its timers tick (once a second)');
  // p6: a fresh bitmap (a new size, the board shown again) while a square travels: it lands at
  // once, the board's first paint asks for no frame (Core Graphics keeps it), the moving layer clears
  {
    const w3 = new World(); w3.load(clone(snap));
    const b3 = new Board3(), D = recorder(), E = recorder();
    b3.drawBoard(D.ctx, frame(1000, 'mount'), w3, t0, ARGS); b3.drawLive(E.ctx, frame(1000, 'mount'));
    w3.apply(clone(f));
    ok(b3.drawBoard(D.ctx, frame(3000), w3, t0 + 2000, ARGS) && b3.drawLive(E.ctx, frame(3016)) && b3.moving, 'p6 fresh: a square travels');
    const more3 = b3.drawBoard(D.ctx, frame(3100, 'size'), w3, t0 + 2100, ARGS);
    ok(!more3 && !b3.moving, 'p6 fresh: a new bitmap lands it at once, and its first paint asks for no frame');
    const n3 = E.calls.length;
    b3.drawLive(E.ctx, frame(3116, 'size'));
    ok(E.calls.slice(n3).some((c) => c.startsWith('clear')) && !E.calls.slice(n3).some((c) => c.startsWith('rect')), 'p6 fresh: the moving layer is cleared');
  }
  // reduced motion: the same change, no transit
  const w2 = new World(); w2.load(clone(snap));
  const b2 = new Board3(); const C2 = recorder();
  b2.drawBoard(C2.ctx, frame(1000, 'mount'), w2, t0, { ...ARGS, reduced: true });
  w2.apply(clone(f));
  b2.drawBoard(C2.ctx, frame(2000), w2, t0 + 2000, { ...ARGS, reduced: true });
  eq(b2.stats.transits, 0, 'move: with reduced motion the run is simply in its new place');
}

// ───────────────────────── p6: a second on, only the second's parts of the model ─────────────────────────
{
  const w = new World();
  w.load(clone(snap));
  const t0 = minuteOf(snap.at) + 60_000;
  const book = new SlotBook();
  const b0 = boardOf(w, t0 + 137, windowMs('30m'), book);
  let same = 0;
  for (let sec = 1; sec < 60; sec++) {
    const now = t0 + sec * 1000 + 137;
    const fresh = sceneOf(boardOf(w, now, windowMs('30m'), book), L, OPTS), kept = sceneOf(boardAt(b0, w, now), L, OPTS);
    if (JSON.stringify(fresh.ops) === JSON.stringify(kept.ops) && JSON.stringify([...fresh.anchors]) === JSON.stringify([...kept.anchors]) && JSON.stringify(fresh.hits) === JSON.stringify(kept.hits)) same++;
  }
  eq(same, 59, 'p6: 59 seconds of boardAt (the minute\'s model, the second\'s parts) draw what boardOf draws');
  // a deploy that landed a moment ago leaves "landed" after half a minute, second by second
  const d = [...w.deploys.values()].find((x) => x.state === 'success' && x.finished);
  if (d) {
    const was = d.finished;
    d.finished = t0 + 5_000;
    const at = (s: number) => boardAt(b0, w, t0 + s * 1000).deploy.landed.some((x) => x.app === d.app);
    ok(at(10) && at(34) && !at(35), 'p6: a deploy is "landed" for 30 s, to the second, in boardAt as in boardOf');
    d.finished = was;
  }
  // the board: one model a minute while the world stands
  const board = new Board3(), A = recorder();
  for (let i = 0; i < 30; i++) board.drawBoard(A.ctx, frame(1000 + i * 1000, i ? 'args' : 'mount'), w, t0 + i * 1000 + 137, ARGS);
  ok(board.stats.builds === 30 && board.stats.paints >= 29, `p6: 30 seconds, 30 scenes, ${board.stats.paints} paints (the timers)`);
}

// ───────────────────────── p5-board: marks that came and went repaint only themselves ─────────────────────────
{
  const w = new World();
  w.load(clone(snap));
  const t0 = minuteOf(snap.at) + 60_000;
  const ops = sceneOf(boardOf(w, t0, windowMs('30m'), new SlotBook()), L, OPTS).ops;
  const n = ops.length;
  // two marks gone from the middle, one new near the end, a timer's digit in between
  const next = ops.slice();
  const gone = next.splice(100, 2);
  next.splice(n - 40, 0, ['r', 5, 5, 7, 7, '#ff0000']);
  const tt = next.findIndex((op, i) => i > 150 && i < n - 60 && op[0] === 't' && /\d$/.test(op[1]));
  ok(tt > 0, 'diff: (a word ending in a digit between them)');
  const old = next[tt] as [string, string, ...unknown[]];
  next[tt] = [old[0], old[1].slice(0, -1) + (old[1].endsWith('9') ? '0' : '9'), ...old.slice(2)] as never;
  const out: number[] = [];
  ok(diffOps(ops, next, 1, out), 'diff: two lists a few marks apart align');
  eq(out.length / 4, 4, 'diff: one box each for the two marks gone, the mark new, the timer');
  const same: number[] = [];
  ok(diffOps(ops, ops.slice(), 1, same) && same.length === 0, 'diff: the same scene, no box');
  ok(gone.length === 2, 'diff: (the marks taken out)');
  // a whole scene's other half: too far apart to align within the budget, or boxes over most of it
  const far: number[] = [];
  const shifted = ops.map((op) => (op[0] === 'r' ? ['r', op[1] + 3, op[2], op[3], op[4], op[5]] : op)) as typeof ops;
  ok(!diffOps(ops, shifted, 1, far) || far.length / 4 > n / 3, 'diff: a board whose squares all moved is not small');
}

// ───────────────────────── a berth is a place ─────────────────────────
{
  const book = new SlotBook();
  eq(book.place('a', 3, ['x', 'y']), ['x', 'y', null], 'berths: two runs take the first two');
  eq(book.place('a', 3, ['y']), [null, 'y', null], 'berths: when the first leaves, the second stays where it is');
  eq(book.place('a', 3, ['y', 'z']), ['z', 'y', null], 'berths: a new run takes the lowest free berth');
  eq(book.place('a', 3, ['y', 'z', 'p', 'q']).length, 4, 'berths: more runs than berths are kept (said as "+1 more")');
}

// ───────────────────────── the failed bin and its window ─────────────────────────
{
  const w = new World();
  w.load(clone(snap));
  const t0 = minuteOf(snap.at) + 60_000;
  let prev = -1, grows = true;
  for (const [k, ms] of WINDOWS) {
    const b = boardOf(w, t0, ms, new SlotBook());
    if (b.checks.binTotal < prev) grows = false;
    prev = b.checks.binTotal;
    const sum = b.checks.bin.reduce((n, g) => n + g.count, 0);
    eq(sum, b.checks.binTotal, `bin ${k}: the groups hold every failure of the window (${b.checks.binTotal})`);
    ok(b.checks.bin.every((g) => g.run.state === 'fail' && !g.run.fixed && g.run.finished >= minuteOf(t0) - ms), `bin ${k}: only failures inside the window, none already fixed`);
    ok(b.checks.results.every((r, i, a) => i === 0 || a[i - 1].finished <= r.finished), `bin ${k}: the results strip runs oldest → newest`);
  }
  ok(grows, 'bin: a wider window never holds fewer failures');
  const b = boardOf(w, t0, windowMs('30m'), new SlotBook());
  const s = sceneOf(b, L, OPTS);
  eq(s.hits.filter((h) => h.kind === 'window').map((h) => h.id), ['10m', '30m', '1h', '2h'], 'bin: four window chips, pressable');
  ok(s.ops.some((op) => op[0] === 't' && op[1] === 'failed') && s.ops.some((op) => op[0] === 't' && op[1] === ' · last 30m · '), 'bin: the header reads "failed · last 30m · N"');
  ok(s.hits.some((h) => h.kind === 'run' && h.id === b.checks.bin[0].run.id), 'bin: its newest strip is pressable');
  eq(windowMs('nonsense'), 1_800_000, 'bin: an unknown window is 30 minutes');
}

// ───────────────────────── the ledger: an event, traced through the stations ─────────────────────────
{
  const w = new World();
  w.load(clone(snap));
  const t0 = minuteOf(snap.at) + 60_000;
  const b = boardOf(w, t0, windowMs('30m'), new SlotBook());
  ok(b.ledger.length >= 10, `ledger: ${b.ledger.length} events`);
  ok(b.ledger.every((r, i, a) => i === 0 || a[i - 1].at >= r.at), 'ledger: newest first, by when the event happened');
  eq(new Set(b.ledger.map((r) => r.id)).size, b.ledger.length, 'ledger: each event once');
  ok(b.ledger.every((r) => r.kind !== 'pr' || (r.main.state === 'na' && r.deploy.state === 'na')), 'ledger: a PR never claims a main line or a deploy');
  ok(b.ledger.every((r) => r.app.state === 'na' || r.deploy.state !== 'na'), 'ledger: an app cell only after a deploy cell');
  const failed = b.ledger.find((r) => r.checks.state === 'fail');
  ok(!failed || /^failed/.test(failed.checks.word), 'ledger: a failed check says where it failed');
  const s = sceneOf(b, L, OPTS);
  const cols = L.cols;
  const rowY = (i: number) => s.hits.filter((h) => h.kind === 'run' && h.x === 12)[i]?.y;
  ok(rowY(0) !== undefined && rowY(0)! > L.split, 'ledger: its rows are under the stations');
  const cellHits = s.hits.filter((h) => h.y > L.split && h.x !== 12);
  ok(cellHits.length > 0 && cellHits.every((h) => cols.some((c) => Math.abs(c.x - 2 - h.x) < 0.01)), 'ledger: every cell sits under its station (the same x)');
  const docked = sceneOf(b, L, { ...OPTS, dock: true });
  ok(docked.hits.every((h) => h.y < L.split) && docked.ops.length < s.ops.length, 'ledger: with the inspector docked it is not drawn, and the stations do not move');
  eq(JSON.stringify(docked.ops.slice(0, 40)), JSON.stringify(s.ops.slice(0, 40)), 'ledger: (the stations draw the same with and without the dock)');
}

// ───────────────────────── the fit: any window, no scroll ─────────────────────────
{
  const w = new World();
  w.load(clone(snap));
  const t0 = minuteOf(snap.at) + 60_000;
  for (const [cw, ch] of [[1440, 840], [2880, 1730], [1280, 660], [1024, 700], [1920, 1010], [3440, 1370], [820, 1100]]) {
    const l = layoutOf(cw, ch);
    const s = sceneOf(boardOf(w, t0, windowMs('2h'), new SlotBook()), l, { ...OPTS, win: '2h' });
    let maxX = 0, maxY = 0, minX = 1e9;
    for (const op of s.ops) {
      if (op[0] === 'r') { maxX = Math.max(maxX, op[1] + op[3]); maxY = Math.max(maxY, op[2] + op[4]); minX = Math.min(minX, op[1]); }
      else maxY = Math.max(maxY, op[3]);
    }
    ok(maxX <= l.W + 0.5 && maxY <= l.H + 0.5 && minX >= 0, `fit ${cw}×${ch}: every mark is inside the window (scale ${l.s.toFixed(2)}, ${s.ops.length} marks)`);
    const floor = s.ops.filter((op) => op[0] === 'r' && op[2] < l.split - 12 && op[2] + op[4] > l.split + 1);
    eq(floor.length, 0, `fit ${cw}×${ch}: no station mark runs into the ledger`);
  }
}

// ───────────────────────── the inspector: links from the server's data ─────────────────────────
{
  const w = new World();
  w.load(clone(snap));
  const t0 = minuteOf(snap.at) + 60_000;
  const b = boardOf(w, t0, windowMs('2h'), new SlotBook());
  const run = b.checks.bin[0].run;
  const d = f3Detail(w, 'run', run.id, t0);
  ok(d.ok && d.kind === 'run' && d.state === 'fail', 'inspect: a failed run opens as failed');
  ok(d.logFail && d.logStep === run.step && d.logId === run.id, 'inspect: its log is asked at the failing step (around=decisive)');
  ok(d.links.some((l) => l.id === 'rr') && d.links.some((l) => l.id === 'commit'), 'inspect: Roadrunner ↗ and commit ↗');
  const p = w.pipelines.get(run.id)!;
  ok(d.links.every((l) => /^https?:\/\//.test(l.url)), 'inspect: every link is a URL');
  const fromData = JSON.stringify([p, w.repos.get(p.repo), [...w.apps.values()]]);
  ok(d.links.every((l) => fromData.includes(new URL(l.url).host)), 'inspect: every link host comes from the server’s data');
  const red = b.mains.red[0];
  const r = f3Detail(w, 'repo', red.repo, t0);
  ok(r.ok && r.kind === 'repo' && r.state === 'fail' && r.items.length > 0, 'inspect: a red main line opens with its last commits');
  const app = [...w.apps.values()][0];
  const a = f3Detail(w, 'app', app.id ?? '', t0);
  ok(a.ok && a.kind === 'app' && a.links.some((l) => l.id === 'app'), 'inspect: an app opens with its link');
  eq(f3Detail(w, 'run', 'nope', t0).ok, false, 'inspect: an unknown id opens nothing');
  const tidy = tidyLog({ rows: [{ id: '1', n: '1', text: '33 : │ [5m58s] │ FAIL src/x.test.ts', hot: true }, { id: '2', n: '2', text: '33 : │ [5m58s] │ ', hot: false }] });
  eq(tidy.rows.map((x) => x.text), ['FAIL src/x.test.ts', ''], 'inspect: a Dagger gutter is cut from the log lines');
  const plain = { rows: [{ id: '1', n: '1', text: 'error: 3 : 4', hot: true }] };
  eq(tidyLog(plain), plain, 'inspect: a plain log is left alone');
}

// ───────────────────────── words ─────────────────────────
{
  eq([timer(0), timer(65_000), timer(3_599_000), timer(3_600_000), timer(5_400_000)], ['0:00', '1:05', '59:59', '1h 00m', '1h 30m'], 'words: a timer is m:ss, then hours and minutes');
  const t = 1_800_000_000_000;
  eq([ageAt(t + 59_000, t), ageAt(t + 60_000, t), ageAt(t + 3_600_000, t), ageAt(t + 3 * 86_400_000, t)], ['now', '1m', '1h', '3d'], 'words: an age is whole minutes, hours, days');
  eq(ageAt(t + 60_000 + 1, t + 59_999), '1m', 'words: ages turn with the clock’s minute, all at once');
}

console.log(fails ? `${fails} FAILED` : 'all ok');
process.exit(fails ? 1 : 0);
