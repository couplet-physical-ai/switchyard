// Tap a running Switchyard server's stream and print events/s by kind.
// Usage: timeout 60 bun server/tap.ts [ws://127.0.0.1:4790/api/v1/stream] [seconds=20]

import type { Frame } from '../src/wire.ts';

const url = process.argv[2] ?? 'ws://127.0.0.1:4790/api/v1/stream';
const secs = Number(process.argv[3] ?? 20);
const ev: Record<string, number> = {};
const up: Record<string, number> = {};
let frames = 0, hbs = 0, bytes = 0, maxOps = 0;
const ws = new WebSocket(url);
ws.onmessage = (m) => {
  const s = String(m.data);
  bytes += s.length;
  const f = JSON.parse(s) as Frame;
  if (f.t === 'hb') { hbs++; return; }
  if (f.t !== 'delta') return;
  frames++;
  maxOps = Math.max(maxOps, f.ops.length);
  for (const op of f.ops) {
    if (op.op === 'event') ev[op.e.k] = (ev[op.e.k] ?? 0) + 1;
    else up[`${op.op} ${op.kind}`] = (up[`${op.op} ${op.kind}`] ?? 0) + 1;
  }
};
await new Promise<void>((res, rej) => { ws.onopen = () => res(); ws.onerror = () => rej(new Error(`cannot connect to ${url}`)); });
await Bun.sleep(secs * 1000);
ws.close();
const rate = (n: number): string => (n / secs).toFixed(2).padStart(7);
console.log(`${secs}s on ${url}: ${frames} delta frames (${(frames / secs).toFixed(1)}/s, max ${maxOps} ops/frame), ${hbs} heartbeats, ${(bytes / 1024 / secs).toFixed(1)} KiB/s`);
console.log('events/s by kind:');
for (const [k, n] of Object.entries(ev).sort((a, b) => b[1] - a[1])) console.log(`  ${k.padEnd(10)}${rate(n)}  (${n})`);
console.log('entity ops/s:');
for (const [k, n] of Object.entries(up).sort((a, b) => b[1] - a[1])) console.log(`  ${k.padEnd(18)}${rate(n)}  (${n})`);
process.exit(0);
