// How fast the built-in demo's simulation runs (fx-demo, for a sped-up demo replay): the demo
// started `--hours` back (as `replayAt` starts it), then pumped to now in turns of `--slice` ms of
// fleet time each, as the app's `advance()` pumps it (DemoUpstream.pump: the simulation, its frames
// made and parsed) plus the world applying them (World.apply, no listener). Per turn: CPU ms;
// overall and per fleet hour: fleet-ms per CPU-ms; and the biggest slice whose turns stay under
// `--max` ms (Bun's budget for a data turn), i.e. the fastest replay a 250 ms tick could feed.
//
//   bun tools/demo-speed.ts [--hours 24] [--slice 10000] [--max 4] [--sweep]
//   BUN_JSC_useJIT=0 bun tools/demo-speed.ts …   (an interpreter: closer to the native module's Hermes)

import { DemoUpstream } from '../src/demo.ts';
import { World } from '../src/world.ts';

(globalThis as { scheduler?: unknown }).scheduler ??= { yield: async () => {} };
const args = process.argv.slice(2);
const opt = (k: string, d: number) => { const i = args.indexOf(k); return i >= 0 ? Number(args[i + 1]) : d; };
const HOURS = opt('--hours', 24), MAX = opt('--max', 4);
const NOW = Date.UTC(2026, 10, 11, 12);

type Run = { slice: number; turns: number[]; byHour: { fleet: number; cpu: number }[]; startMs: number };

async function run(slice: number, hours: number): Promise<Run> {
  const from = NOW - hours * 3_600_000;
  const t0 = performance.now();
  const d = await DemoUpstream.start(from);
  const w = new World();
  w.load(await d.snapshot());
  const startMs = performance.now() - t0;
  const turns: number[] = [];
  const byHour = Array.from({ length: Math.ceil(hours) }, () => ({ fleet: 0, cpu: 0 }));
  for (let at = from; at < NOW;) {
    const to = Math.min(NOW, at + slice);
    const a = performance.now();
    while (d.now + 100 <= to) for (const f of d.pump(to)) w.apply(f);
    const ms = performance.now() - a;
    turns.push(ms);
    const h = byHour[Math.min(byHour.length - 1, Math.floor((at - from) / 3_600_000))]!;
    h.fleet += to - at; h.cpu += ms;
    at = to;
  }
  return { slice, turns, byHour, startMs };
}

const q = (xs: number[], p: number) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(s.length * p))] ?? 0; };
const line = (r: Run) => {
  const cpu = r.turns.reduce((a, b) => a + b, 0), fleet = r.slice * r.turns.length;
  return `slice ${r.slice / 1000} s: ${r.turns.length} turns · per turn p50 ${q(r.turns, 0.5).toFixed(2)} p95 ${q(r.turns, 0.95).toFixed(2)} max ${q(r.turns, 1).toFixed(2)} ms · ${(fleet / cpu).toFixed(0)} fleet-ms per CPU-ms`;
};

if (args.includes('--sweep')) {
  // which slice keeps a turn's p95 under MAX (2 h of the busiest stretch: the day's middle)
  for (const s of [1_000, 2_000, 5_000, 10_000, 20_000, 30_000, 60_000]) {
    const r = await run(s, 2);
    console.log(`${line(r)}${q(r.turns, 0.95) <= MAX ? '' : `  (p95 over ${MAX} ms)`} → at 4 turns/s: ${(4 * s / 1000).toFixed(0)}× real time`);
  }
} else {
  const r = await run(opt('--slice', 10_000), HOURS);
  console.log(`demo started ${HOURS} h back in ${r.startMs.toFixed(0)} ms (seed + 10 min warm-up, sliced in the app)`);
  console.log(line(r));
  console.log('per fleet hour (fleet-ms per CPU-ms): ' + r.byHour.map((h) => (h.fleet / Math.max(1e-3, h.cpu)).toFixed(0)).join(' '));
  const all = r.byHour.reduce((a, h) => a + h.cpu, 0);
  console.log(`${HOURS} h of fleet in ${(all / 1000).toFixed(2)} s of CPU: a ${HOURS} h replay in 2 min needs ${(all / 120 / 10).toFixed(1)} % of a core (${(HOURS * 3600 / 120).toFixed(0)}×)`);
}
