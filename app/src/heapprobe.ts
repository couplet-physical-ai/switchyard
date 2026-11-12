// A hidden probe of Hermes's external-memory accounting (macOS only): SWITCHYARD_HEAPLOG=1:<mode>
// (modules/apple/Hooks.swift `heapLog` answers the mode). The yard's live canvas then runs one
// synthetic churn per frame in its draw turn (every other surface draws nothing), asks for the
// next frame, and every 10 s logs Hermes's `js_externalBytes` and `js_allocatedBytes` to
// switchyard.log. Off by default: with no mode, nothing here runs.
//
//   a  `+=` string building, 4 characters at a time to ~100 KB (the recorder's base64), discarded
//   b  an ArrayBuffer of 256 B doubled (with its copy) to 128 KB (the recorder's Writer), discarded
//   c  JSON.stringify of an object holding a 100 KB string (the recorder's draw reply)
//   d  a canvas draw recording ~3000 ops (the whole recorder path: Writer, base64, JSON)
//   e  nothing (the baseline: an empty draw at 60 fps)
//   f  base64 of 100 KB into a Uint8Array, then String.fromCharCode per 8 KB chunk + join
//   t  ~400 fillText runs a frame across 3 fonts (the host's text measure, every run)
//   r  ~300 regex uses a frame (literal replace, split, a RegExp made from a string)
//   L  (with others) a ~12 MB live set, 1 % of it replaced each frame (old-generation churn, as
//      the fleet's world in a live session)
//   A  as a, to ~400 KB (a big canvas's base64: past the size where Hermes keeps a string outside its heap)
//   C  as c, with a 400 KB string
//   X,Y,…  the listed modes in turn, 90 s each (e.g. 1:A,C)
//   cycle  a, b, c, d, e, f in turn, 2 minutes each, round and round (one launch, every mode)
//   real  no churn: the app draws as it does, and every 10 s the line adds each surface's draws
//         and the external bytes its draw turns added (before the collections between calls)

import type { Ctx2D, Frame, NativeModule } from '../app.contract.d.ts';
import { hermesStats } from './memlog.ts';

const EVERY_MS = 10_000;
const PHASE_MS = 120_000, PHASES = ['a', 'b', 'c', 'd', 'e', 'f'];
let mode = '';
let asked = false;
let frames = 0, t0 = NaN, lastAt = -Infinity;
const lines: string[] = [];
let sink = 0;
let big = '';
let ballast: { i: number; s: string; o: number[] }[] = [];

/** The probe's mode ('' when off), asked of the native side once, from a data turn. */
export function probeAsk(native: NativeModule | null | undefined): string {
  if (asked) return mode;
  asked = true;
  try {
    const r = native?.available ? native.call({ op: 'heapLog' }) : null;
    mode = typeof r?.probe === 'string' ? r.probe : '';
  } catch { mode = ''; }
  if (mode) lines.push(`probe: mode ${mode} on (the yard's live canvas churns every frame; every 10 s ext/live)`);
  return mode;
}
export const probing = (): string => mode;

/** From a data turn: the probe's lines so far, to switchyard.log (and the console). */
export function probeFlush(native: NativeModule | null | undefined): void {
  while (lines.length) {
    const line = lines.shift() as string;
    console.log(line);
    try { if (native?.available) native.call({ op: 'heapLog', line }); } catch { /* the console has it */ }
  }
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64C = Array.from(B64, (c) => c.charCodeAt(0));

/** The mode this frame runs: the env's, or cycle's phase. */
const phaseAt = (time: number): string => {
  if (mode === 'cycle') return PHASES[Math.floor((time - t0) / PHASE_MS) % PHASES.length];
  if (!mode.includes(',')) return mode;
  const list = mode.split(',');
  return list[Math.floor((time - t0) / 90_000) % list.length];
};

function stat(time: number): void {
  if (Number.isNaN(t0)) t0 = time;
  if (time - lastAt < EVERY_MS) return;
  lastAt = time;
  const s = hermesStats();
  if (!s) return;
  const MB = (b: number) => (b / 1_048_576).toFixed(2);
  let by = '';
  for (const [k, v] of per) by += ` · ${k} ${v.n}/${(v.ext / 1_048_576).toFixed(2)}`;
  per.clear();
  lines.push(`probe ${phaseAt(time)}: ${Math.round((time - t0) / 1000)} s · frames ${frames} · ext ${MB(s.js_externalBytes ?? 0)} MB · live ${MB(s.js_allocatedBytes ?? 0)} MB · heap ${MB(s.js_heapSize ?? 0)} MB · gcs ${s.js_numGCs ?? 0} · alloc ${MB(s.js_totalAllocatedBytes ?? 0)} MB · sink ${sink}${by}`);
}

let inside = false;
export const probeInside = (): boolean => inside;
/** app.ts `draw` while probing: the churn on the yard's live canvas (nothing elsewhere), or, in
 *  `real` mode, the app's own draw, measured. */
export function probeWrap(surface: string, ctx: Ctx2D, frame: Frame, real: () => boolean): boolean {
  if (mode !== 'real') return surface === 'yardLive' ? probeDraw(ctx, frame) : false;
  probeBefore(frame.time);
  inside = true;
  try { return real(); } finally { inside = false; probeAfter(surface); }
}

/** `real`: each surface's draws and the external bytes its draw turns added, this window. */
const per = new Map<string, { n: number; ext: number }>();
let extBefore = 0;
/** Around each real draw (app.ts `draw`), in `real` mode only. */
function probeBefore(time: number): void {
  stat(time);
  extBefore = Number(hermesStats()?.js_externalBytes ?? 0);
}
function probeAfter(surface: string): void {
  frames++;
  const d = Number(hermesStats()?.js_externalBytes ?? 0) - extBefore;
  const e = per.get(surface) ?? { n: 0, ext: 0 };
  e.n++; e.ext += d;
  per.set(surface, e);
}

/** The churn, in a draw turn; wants the next frame. */
function probeDraw(ctx: Ctx2D, frame: Frame): boolean {
  stat(frame.time);
  frames++;
  const m = phaseAt(frame.time);
  if (mode.includes('L')) {
    if (!ballast.length) for (let i = 0; i < 120_000; i++) ballast.push({ i, s: `repo-${i}-${frames}`, o: [i, i + 1, i + 2] });
    for (let k = 0; k < 1200; k++) { const j = (frames * 1201 + k * 97) % ballast.length; ballast[j] = { i: j, s: `repo-${j}-${frames}`, o: [j, frames, k] }; }
  }
  if (m.includes('t')) {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, frame.width, frame.height);
    const fonts = ["12px 'Commit Mono', ui-monospace, monospace", "700 12px 'Commit Mono', ui-monospace, monospace", "11px 'Commit Mono', ui-monospace, monospace"];
    ctx.fillStyle = '#8A8A8A';
    for (let i = 0; i < 400; i++) {
      if (i % 50 === 0) ctx.font = fonts[(i / 50) % 3];
      const label = `${i} · ${(frames + i) % 997} s · repo-${i % 37}`;
      const w = ctx.measureText(label).width;
      ctx.fillText(label, (i % 8) * 170, 14 + Math.floor(i / 8) * 16 + (w > 1e9 ? 1 : 0));
    }
    sink = frames;
  }
  if (m.includes('r')) {
    let n = 0;
    for (let i = 0; i < 100; i++) {
      const label = `team-${i % 7} ${frames % 50}`;
      n += label.replace(/ \d+$/, '').length + `a,b;c,${i}`.split(/[,;]/).length + (new RegExp(`^dock${i % 9}\\d+$`).test(`dock${i % 9}${frames}`) ? 1 : 0);
    }
    sink = n;
  }
  if (m.includes('a') || m.includes('A')) {
    const n = m.includes('A') ? 400_000 : 100_000;
    let s = '';
    while (s.length < n) s += B64[frames & 63] + B64[(frames >> 6) & 63] + B64[sink & 63] + 'x';
    sink = s.length;
  }
  if (m.includes('b')) {
    let buf = new ArrayBuffer(256), view = new DataView(buf);
    while (buf.byteLength < 128 << 10) {
      const grown = new ArrayBuffer(buf.byteLength * 2);
      new Uint8Array(grown).set(new Uint8Array(buf));
      buf = grown; view = new DataView(grown);
      view.setFloat64(0, frames, true);
    }
    sink = new Uint8Array(buf, 0, buf.byteLength >> 1).length;
  }
  if (m.includes('c') || m.includes('C')) {
    const k = m.includes('C') ? 4000 : 1000;
    if (big.length !== k * 102) { const parts: string[] = []; for (let i = 0; i < k; i++) parts.push('ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijkl'); big = parts.join(''); }
    sink = JSON.stringify({ lists: [big], frame: true, error: null, notes: [] }).length;
  }
  if (m.includes('d')) {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, frame.width, frame.height);
    for (let i = 0; i < 1500; i++) {
      ctx.fillStyle = i & 1 ? '#151515' : '#161616';
      ctx.fillRect((i * 7 + frames) % Math.max(1, frame.width), (i * 13) % Math.max(1, frame.height), 2, 2);
    }
    sink = frames;
  }
  if (m.includes('f')) {
    const n = 75_000, bytes = new Uint8Array(n);
    for (let i = 0; i < n; i++) bytes[i] = (i * 31 + frames) & 255;
    const out = new Uint8Array(((n + 2) / 3 | 0) * 4);
    let o = 0, i = 0;
    for (; i + 2 < n; i += 3) {
      const v = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
      out[o++] = B64C[v >> 18]; out[o++] = B64C[(v >> 12) & 63]; out[o++] = B64C[(v >> 6) & 63]; out[o++] = B64C[v & 63];
    }
    const parts: string[] = [];
    for (let k = 0; k < o; k += 8192) parts.push(String.fromCharCode.apply(null, out.subarray(k, Math.min(o, k + 8192)) as unknown as number[]));
    sink = parts.join('').length;
  }
  return true;
}
