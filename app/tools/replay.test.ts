// The replays' streaming (fx-day): the chunk and lookahead sizing by speed, the timeline's waits,
// jumps, pause and resume, and the day replay's speed through the data module (the demo).
// Run: bun app/tools/replay.test.ts
import { Timeline, nextChunkMs, replaySizing } from '../src/timeline.ts';
import type { Frame, History, Snapshot } from '../src/wire.ts';

let fails = 0;
const ok = (c: boolean, m: string) => { if (c) console.log('ok', m); else { console.log('FAIL', m); fails++; } };
const MIN = 60_000;

// ---- sizing ------------------------------------------------------------------------------------
for (const speed of [1, 60, 180, 720]) {
  const z = replaySizing(speed);
  // ~3 s of real time ahead (never under a minute)
  ok(z.lookahead === Math.max(MIN, speed * 3000), `${speed}×: lookahead ${z.lookahead / 1000} s of fleet = ${(z.lookahead / speed / 1000).toFixed(1)} s real`);
  ok(z.max <= 30 * MIN && z.max >= 6 * MIN, `${speed}×: chunks up to ${z.max / MIN} min (6..30)`);
  ok(z.min <= z.start && z.start <= z.max, `${speed}×: the first chunk ${z.start / 1000} s within [${z.min / 1000}, ${z.max / 1000}] s`);
  ok(z.min >= 5000 && z.skip >= z.min && z.skip <= z.max, `${speed}×: min ${z.min / 1000} s, skip ${z.skip / 1000} s`);
  // a chunk takes at least one 250 ms ask at this speed (else the stream cannot keep up and jumps)
  ok(z.min >= Math.min(z.max / 4, speed * 250), `${speed}×: min covers a 250 ms ask`);
}
ok(replaySizing(60).max === 6 * MIN && replaySizing(60).start === MIN, '60× (the hour) keeps 6 min chunks and a 1 min first one');
ok(replaySizing(720).max === 30 * MIN && replaySizing(720).lookahead === 36 * MIN, '720× (the day): 30 min chunks, 36 min (3 s) ahead');
const C = 1536 << 10, z720 = replaySizing(720);
ok(nextChunkMs(10 * MIN, 100 << 10, C, z720) === 15 * MIN, 'a quiet chunk grows by half');
ok(nextChunkMs(20 * MIN, 100 << 10, C, z720) === 30 * MIN && nextChunkMs(30 * MIN, 100 << 10, C, z720) === 30 * MIN, '…up to the max');
ok(nextChunkMs(30 * MIN, 1000 << 10, C, z720) === 15 * MIN, 'a chunk over half the ceiling halves');
ok(nextChunkMs(30 * MIN, 600 << 10, C, z720) === 30 * MIN, 'between a quarter and a half it stays');
// a normal live day (~1-2 MB an hour, measured on the live server 2026-11-11) streams in chunks
// that stay over the minimum and under the ceiling, and keeps the lookahead ahead of the asks
{
  let ms = z720.start, at = 0, n = 0, maxBytes = 0;
  const perMin = (1.9 * 1048576) / 60;
  while (at < 24 * 60 * MIN) { const b = (ms / MIN) * perMin; maxBytes = Math.max(maxBytes, b); at += ms; n++; ms = nextChunkMs(ms, b, C, z720); }
  ok(maxBytes < C, `a 1.9 MB/h day: every chunk under the ceiling (max ${(maxBytes / 1048576).toFixed(2)} MB)`);
  ok(n <= 100, `a 1.9 MB/h day in ${n} requests (15 min chunks: a 30 min one is over half the ceiling)`);
  ok(ms >= z720.min, 'and never under the minimum (no jumps)');
}
// a boot burst (~30 MB an hour): the window shrinks under the minimum: a jump, not a crawl
{
  let ms = z720.start, steps = 0;
  const perMin = (30 * 1048576) / 60;
  while (ms >= z720.min && steps < 10) { const b = (ms / MIN) * perMin; ms = b > C ? Math.floor(ms / 2) : nextChunkMs(ms, b, C, z720); steps++; }
  ok(ms < z720.min && steps <= 3, `a 30 MB/h burst falls under the minimum in ${steps} asks (then it is jumped)`);
}

// ---- the timeline: waits, a jump, pause and resume ------------------------------------------------
const T0 = Date.UTC(2026, 10, 11, 0);
const snap = (at: number): Snapshot => ({ protocol: '0.5', seq: 1, at, repos: [{ id: 'o/r', org: 'o', name: 'r', default_branch: 'main', lane: 'roadrunner', main: { state: 'success', recent: [] } }], orgs: [], commits: [], pipelines: [], prs: [], deploys: [], apps: [], engines: [], queues: [], lanes: [], watcher: { id: 'outage', tripped: false, gh_status: 'ok' }, stats: {} } as unknown as Snapshot);
const delta = (at: number, seq: number): Frame => ({ t: 'delta', seq, at, ops: [{ op: 'patch', kind: 'repo', id: 'o/r', v: { heat: seq } }] } as unknown as Frame);
const chunk = (from: number, to: number, every = MIN): History => ({ from, to, base: null, frames: Array.from({ length: Math.floor((to - from) / every) }, (_, i) => delta(from + (i + 1) * every, 10 + Math.floor((from - T0) / every) + i)) } as unknown as History);
{
  const tl = new Timeline();
  let clock = 0;
  const run = (ms: number) => { for (let t = 0; t < ms; t += 16) { clock += 16; tl.tick(clock); } };
  tl.load(snap(T0 + 24 * 60 * MIN), 0);
  ok(tl.startReplay({ from: T0, to: T0, base: snap(T0), frames: [] } as unknown as History, T0 + 24 * 60 * MIN, 720), 'a day replay starts');
  ok(tl.mode === 'replay' && tl.speed === 720 && tl.replaySpeed === 720, 'at 720×');
  ok(tl.replayWants(MIN) === T0, 'it wants its first chunk at once');
  run(500);
  ok(tl.playhead === T0 && tl.waiting && tl.stalls === 0 && tl.startMs > 400, `before its first chunk it waits (start ${Math.round(tl.startMs)} ms, not a stall)`);
  tl.appendReplay(chunk(T0, T0 + 30 * MIN));
  run(1000);
  const p1 = tl.playhead - T0;
  ok(Math.abs(p1 - 720 * 1000) < 720 * 50, `1 s real plays ~12 min (${(p1 / MIN).toFixed(1)} min)`);
  ok(!tl.waiting && tl.replayWants(MIN) === T0 + 30 * MIN, 'within 3 s of the loaded end it asks for the next chunk');
  run(2000);
  ok(tl.playhead === T0 + 30 * MIN && tl.waiting && tl.stalls === 1, 'at the loaded end it waits: one stall');
  run(300);
  // (it reached the end ~1.5 s into the 2 s: ~0.5 s + 0.3 s held)
  ok(tl.stalls === 1 && tl.stallMs >= 750 && tl.stallMs < 870, `one stall, its time counted (${Math.round(tl.stallMs)} ms)`);
  // a jump: the next 30 min too dense; the fleet at +60 min arrives while the playhead is short of +45
  tl.appendReplay(chunk(T0 + 30 * MIN, T0 + 45 * MIN));
  run(500);
  const w0 = tl.world;
  tl.rebaseReplay(snap(T0 + 75 * MIN));
  ok(tl.rebasing && tl.world === w0 && tl.playhead < T0 + 45 * MIN, 'a jump waits for the playhead to play what is loaded before it');
  ok(tl.replayWants(MIN) === T0 + 75 * MIN, 'meanwhile its far side loads');
  tl.appendReplay(chunk(T0 + 75 * MIN, T0 + 105 * MIN));
  const stalls = tl.stalls;
  run(2000);
  ok(!tl.rebasing && tl.world !== w0 && tl.playhead > T0 + 75 * MIN && tl.stalls === stalls, `the jump is taken at +45 min and plays on from +75 without a wait (${((tl.playhead - T0) / MIN).toFixed(0)} min)`);
  ok(tl.world.repos.get('o/r')?.heat > 0, 'the frames past the jump apply to the jumped world');
  // pause keeps the replay; play resumes it at its speed
  tl.pause();
  const ph = tl.playhead;
  run(1000);
  ok(tl.mode === 'paused' && tl.replayPaused && tl.playhead === ph, 'paused, the replay holds');
  ok(tl.resume() && tl.mode === 'replay' && tl.speed === 720, 'resume: the replay again, at 720×');
  tl.pause();
  tl.play(1);
  ok(tl.mode === 'replay' && tl.speed === 1, '1× on a paused replay plays the replay at 1×');
  ok(!tl.goLive() && tl.mode === 'live' && !tl.replayPaused, 'live leaves it (and asks for the snapshot)');
  tl.load(snap(T0 + 24 * 60 * MIN), clock);
  tl.pause();
  ok(!tl.resume() && tl.mode === 'behind' && tl.speed === 1, 'a paused live world resumes behind live at 1×, as before');
  // the end of the window answered at the server's now: the replay ends there
  const t2 = new Timeline();
  t2.load(snap(T0), 0);
  t2.startReplay({ from: T0, to: T0, base: snap(T0), frames: [] } as unknown as History, T0 + 10 * MIN + 0.7, 60);
  ok(t2.replayTo === T0 + 10 * MIN, 'the replay ends on a whole ms (the server answers whole ms)');
}

// ---- the data module: the demo's day ---------------------------------------------------------------
{
  const { sources } = await import('../app.ts');
  const call = (name: string, a: unknown[]) => (sources as Record<string, (a: unknown[], s: unknown, st: unknown) => unknown>)[name](a, { get: () => '', set() {} }, {});
  const ov = async (t: number) => (await call('overview', [t])) as { mode: string; speed: number; dial: string };
  const c = (await call('connect', ['demo', '', 1, T0, 0])) as { ok: boolean };
  ok(c.ok, 'the demo connects');
  await ov(16);
  const d = (await call('replayDay', [20])) as { ok: boolean; status: string };
  let o = await ov(30);
  ok(d.ok && d.status === '180' && o.mode === 'replay' && o.speed === 180, `the demo's day: its last 6 h at 180× (${d.status}, ${o.mode} ${o.speed}×, ${o.dial})`);
  for (let t = 46; t <= 10_046; t += 16) await call('overview', [t]);
  o = await ov(10_050);
  ok(/replaying · (0|1) of 6 h/.test(o.dial), `10 s later it is ~30 min in (${o.dial})`);
  const a = (await call('replayAt', [10_060, T0 - 3 * 60 * MIN])) as { ok: boolean; status: string };
  o = await ov(10_070);
  ok(a.ok && a.status === '180' && o.speed === 180 && o.mode === 'replay', `a tick in the day replay keeps its speed (${a.status}×)`);
  await call('timeControl', ['pause', 1]);
  o = await ov(10_100);
  ok(o.mode === 'paused', 'paused');
  const r = (await call('replayResume', [10_200])) as { ok: boolean; status: string };
  o = await ov(10_210);
  ok(r.ok && r.status === '180' && o.mode === 'replay' && o.speed === 180, 'resumed at the day speed');
  await call('timeControl', ['live', 1]);
  const h = (await call('replayHour', [10_300])) as { ok: boolean; status: string };
  o = await ov(10_310);
  ok(h.ok && h.status === '60' && o.speed === 60, 'the hour stays 60×');
  const b = (await call('replayAt', [10_400, T0 - 2 * 60 * MIN])) as { ok: boolean; status: string };
  ok(b.ok && b.status === '60', 'and a tick in it replays at 60×');
}

if (fails) { console.log(`${fails} failed`); process.exit(1); }
console.log('all passed');
process.exit(0);
