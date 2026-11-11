// The factory floor's frame budget in one table (FACTORY-SPEC §I-W7): what the live and top canvases
// send a frame and a second, calm against loud, at 1× and with 10× stress, through Exact's own
// recorder (the bytes are the native cost: PERF.md "Where the native frame goes").
//
//   EXACT2=… bun tools/factory-perf.mjs [--frames 600] [--calm fixtures] [--loud demo] [--max-calm 0.15]
//
// Calm is the recorded fixtures server, frozen (nothing arrives: only the belts move and the live
// layer sleeps between the 125 ms calm pulses); loud is the built-in demo (events every second).
// For each it runs tools/factory-bench.ts (no HUD: the HUD keeps every frame; --hermes: the ladder
// prices frames as the macOS data module does) and reports, per canvas, the KB a drawn frame sends
// and the KB and calls a second. Exit 1 when the calm floor's
// live calls a second are over --max-calm of the loud one's (the acceptance: ≤ 15 %).
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const arg = (name, def) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : def; };
const frames = Number(arg('--frames', '600'));
const calm = arg('--calm', 'fixtures'), loud = arg('--loud', 'demo');
const maxCalm = Number(arg('--max-calm', '0.15'));
const app = fileURLToPath(new URL('..', import.meta.url));

function bench(source, extra) {
  const r = spawnSync('bun', ['tools/factory-bench.ts', source, '--frames', String(frames), '--hermes', ...extra], { cwd: app, encoding: 'utf8', timeout: 600_000, env: process.env });
  const line = (r.stdout ?? '').split('\n').find((l) => l.startsWith('{'));
  if (!line) { console.error(`factory-bench ${source} ${extra.join(' ')} failed (exit ${r.status}):\n${(r.stderr ?? '').slice(-2000)}`); process.exit(2); }
  return JSON.parse(line);
}

const rows = [];
for (const [name, source, extra] of [['calm 1×', calm, []], ['loud 1×', loud, []], ['calm 10×', calm, ['--stress']], ['loud 10×', loud, ['--stress']]]) {
  const calls = bench(source, extra);
  const bytes = bench(source, [...extra, '--real']);
  const secs = frames / 60;
  rows.push({
    name,
    drawn: calls.liveCalls.framesDrawn,
    liveCallsPerS: Math.round((calls.liveCalls.mean * frames) / secs),
    topCallsPerS: Math.round((calls.topCalls.mean * frames) / secs),
    // per drawn live frame; the top canvas averaged over every frame (most send nothing)
    liveKBPerFrame: +((bytes.liveBytes.mean * frames) / Math.max(1, bytes.liveBytes.framesDrawn) / 1024).toFixed(1),
    topKBPerFrame: +(bytes.topBytes.mean / 1024).toFixed(1),
    sentKBPerS: Math.round(bytes.sentKBPerFrame * 60),
    // the floor's rung at the end (the HUD line's first word: ov.quality is the yard's)
    quality: Number(/^q(\d)/.exec(calls.stats ?? '')?.[1] ?? calls.quality),
  });
}
const pad = (s, n) => String(s).padStart(n);
console.log(`${'window'.padEnd(10)}${pad('live frames', 13)}${pad('live calls/s', 14)}${pad('top calls/s', 13)}${pad('live KB/drawn', 15)}${pad('top KB/frame', 14)}${pad('sent KB/s', 11)}${pad('rung', 6)}`);
for (const r of rows) console.log(`${r.name.padEnd(10)}${pad(`${r.drawn}/${frames}`, 13)}${pad(r.liveCallsPerS, 14)}${pad(r.topCallsPerS, 13)}${pad(r.liveKBPerFrame, 15)}${pad(r.topKBPerFrame, 14)}${pad(r.sentKBPerS, 11)}${pad(`q${r.quality}`, 6)}`);
const ratio = rows[0].liveCallsPerS / Math.max(1, rows[1].liveCallsPerS);
console.log(`calm/loud live calls a second: ${(ratio * 100).toFixed(1)} % (max ${(maxCalm * 100).toFixed(0)} %)`);
console.log(JSON.stringify({ frames, rows, calmOverLoud: +ratio.toFixed(3) }));
process.exit(ratio <= maxCalm ? 0 : 1);
