// THE MACHINE WALLS' DATA (fab-w6, FACTORY-SPEC §B "engine + wall", §D "engine", §H6): each
// machine's last 24 h, read ONLY through the v0.5 seam (`insights.engineHistoryAsync`: the
// server's `GET /api/v1/engine/{id}/history`, one sample a minute, else the client seam's ≈ 2 h
// of occupancy in the same columns), folded into a few buckets the wall can paint cheaply:
//
//   busy   mean busy/slots in the bucket (the tide line), NaN where the engine was offline or
//          nothing was recorded (a gap: the line breaks, nothing is invented)
//   peak   the bucket's highest busy/slots (1 = every slot was taken at some minute: saturated)
//   cpu    mean cpu (0..1), NaN gap     mem    mean mem (0..1), NaN gap
//
// A machine (a host) is one engine id when the server knows its Dagger host (`dagger:<host>`:
// busy/slots for the whole host, cpu/mem/load), else its agents' ids, summed minute by minute.
//
// Fetching happens from a SOURCE (app.ts's overview tick calls `pump`), never from a draw; each
// id is asked at most once a minute (the seam's own 60 s TTL holds the promise). A draw reads the
// folded `Tide` and `ver` only.

import type { EngineHistoryDoc } from '../wire.ts';
import type { World } from '../world.ts';
import { engineHistoryAsync } from '../insights.ts';

export const DAY_MS = 86_400_000;
/** Wall buckets over 24 h: 15 minutes each (≈ 2 px at fleet zoom, ≈ 6 px at 272 %), the machine
 *  lens's own resolution (lenses.ts `engineSeries`), so the wall and the lens chart agree. */
export const WALL_BUCKETS = 96;
/** How often a machine's history is asked again (module-clock ms; the seam caches 60 s too). */
export const HIST_EVERY_MS = 60_000;

/** One machine's 24 h, folded for the wall. Arrays are `n` long, oldest first; the last bucket
 *  ends at `to` (the newest minute the history holds). */
export type Tide = {
  key: string; ids: string[]; source: 'server' | 'client' | 'mixed' | 'none';
  from: number; to: number; n: number; bw: number;
  busy: Float32Array; peak: Float32Array; cpu: Float32Array; mem: Float32Array;
  /** buckets with any busy/slots sample (0..1 of n) */
  covered: number;
  /** repos the machine served in the last hour, most runs first */
  repos: { repo: string; runs: number }[];
};

/** A history answer as the seam returns it (the server's columns, `source` added). */
export type HistDoc = EngineHistoryDoc & { source?: 'server' | 'client' };

export function emptyTide(key = '', n = WALL_BUCKETS, to = 0): Tide {
  const nan = () => new Float32Array(n).fill(NaN);
  return { key, ids: [], source: 'none', from: to - DAY_MS, to, n, bw: DAY_MS / n, busy: nan(), peak: nan(), cpu: nan(), mem: nan(), covered: 0, repos: [] };
}

/** Folds one machine's histories (one per engine id; a host's agents are summed minute by
 *  minute) into `n` buckets over the 24 h that end at the newest minute any of them holds. */
export function foldTide(key: string, docs: readonly (HistDoc | null | undefined)[], n = WALL_BUCKETS): Tide {
  const ok = docs.filter((d): d is HistDoc => !!d && Array.isArray(d.busy) && d.n > 0 && d.step_ms > 0);
  if (!ok.length) return emptyTide(key, n);
  let to = 0;
  for (const d of ok) to = Math.max(to, d.from + d.n * d.step_ms);
  const t = emptyTide(key, n, to);
  t.ids = ok.map((d) => d.id);
  const src = new Set(ok.map((d) => d.source ?? 'server'));
  t.source = src.size > 1 ? 'mixed' : (src.values().next().value as 'server' | 'client');
  const from = t.from, bw = t.bw;
  // per bucket: Σ busy/slots over the minutes that have them, and how many; cpu/mem the same
  const sB = new Float64Array(n), nB = new Float64Array(n), sC = new Float64Array(n), nC = new Float64Array(n), sM = new Float64Array(n), nM = new Float64Array(n);
  const peak = t.peak;
  if (ok.length === 1) {
    const d = ok[0]!;
    for (let i = 0; i < d.n; i++) {
      const at = d.from + i * d.step_ms;
      const b = Math.floor((at - from) / bw);
      if (b < 0 || b >= n) continue;
      const busy = d.busy[i], slots = d.slots[i];
      if (busy !== null && busy !== undefined && slots !== null && slots !== undefined && slots > 0) {
        const r = Math.min(1, Math.max(0, busy / slots));
        sB[b] += r; nB[b]++;
        if (!(peak[b]! >= r)) peak[b] = r;
      }
      const c = d.cpu[i], m = d.mem[i];
      if (c !== null && c !== undefined) { sC[b] += c / 100; nC[b]++; }
      if (m !== null && m !== undefined) { sM[b] += m / 100; nM[b]++; }
    }
  } else {
    // several engines (a host's agents): sum busy and slots at each instant (minute grid of the
    // finest step), then fold; cpu/mem: the highest reading of the instant
    const step = Math.min(...ok.map((d) => d.step_ms));
    const m0 = Math.floor(from / step), m1 = Math.ceil(to / step);
    for (let m = m0; m < m1; m++) {
      const at = m * step;
      const b = Math.floor((at - from) / bw);
      if (b < 0 || b >= n) continue;
      let busy = 0, slots = 0, any = false, cpu = NaN, mem = NaN;
      for (const d of ok) {
        const i = Math.floor((at - d.from) / d.step_ms);
        if (i < 0 || i >= d.n) continue;
        const bv = d.busy[i], sv = d.slots[i];
        if (bv !== null && bv !== undefined && sv !== null && sv !== undefined) { busy += bv; slots += sv; any = true; }
        const c = d.cpu[i], mm = d.mem[i];
        if (c !== null && c !== undefined && !(cpu >= c)) cpu = c;
        if (mm !== null && mm !== undefined && !(mem >= mm)) mem = mm;
      }
      if (any && slots > 0) {
        const r = Math.min(1, Math.max(0, busy / slots));
        sB[b] += r; nB[b]++;
        if (!(peak[b]! >= r)) peak[b] = r;
      }
      if (cpu === cpu) { sC[b] += cpu / 100; nC[b]++; }
      if (mem === mem) { sM[b] += mem / 100; nM[b]++; }
    }
  }
  let cov = 0;
  for (let b = 0; b < n; b++) {
    if (nB[b]) { t.busy[b] = sB[b]! / nB[b]!; cov++; }
    if (nC[b]) t.cpu[b] = Math.min(1, sC[b]! / nC[b]!);
    if (nM[b]) t.mem[b] = Math.min(1, sM[b]! / nM[b]!);
  }
  t.covered = cov / n;
  // repos served in the last hour, summed across the machine's engines
  const rs = new Map<string, number>();
  for (const d of ok) for (const r of d.repos ?? []) rs.set(r.repo, (rs.get(r.repo) ?? 0) + r.runs);
  t.repos = [...rs].map(([repo, runs]) => ({ repo, runs })).sort((a, b) => b.runs - a.runs || (a.repo < b.repo ? -1 : 1));
  return t;
}

/** A series averaged over ±r buckets, within its runs of data (a gap stays a gap, and no value
 *  leaks across one). */
export function smoothed(a: Float32Array, r: number): Float32Array {
  const out = new Float32Array(a.length).fill(NaN);
  for (const [s, e] of dataRuns(a)) {
    for (let i = s; i < e; i++) {
      let sum = 0, k = 0;
      for (let j = Math.max(s, i - r); j <= Math.min(e - 1, i + r); j++) { sum += a[j]!; k++; }
      out[i] = sum / k;
    }
  }
  return out;
}

/** The runs of a series that have data: [first, end) bucket index pairs, a gap between each. */
export function dataRuns(a: Float32Array): [number, number][] {
  const out: [number, number][] = [];
  let s = -1;
  for (let i = 0; i < a.length; i++) {
    const has = a[i] === a[i];
    if (has && s < 0) s = i;
    else if (!has && s >= 0) { out.push([s, i]); s = -1; }
  }
  if (s >= 0) out.push([s, a.length]);
  return out;
}

/** A series as polylines in the wall's unit square: x 0 (24 h ago) → 1 (the newest minute), y 0
 *  → 1 (the value), one polyline per run of data (offline minutes and the time before the record
 *  are gaps, never drawn). Each point sits at its bucket's middle; a lone bucket is a short flat
 *  stroke across it, so it shows. */
export function tidePoints(t: Tide, key: 'busy' | 'peak' | 'cpu' | 'mem'): [number, number][][] {
  const a = t[key], n = t.n;
  const out: [number, number][][] = [];
  for (const [s, e] of dataRuns(a)) {
    const pts: [number, number][] = [];
    if (e - s === 1) { pts.push([s / n, a[s]!], [(s + 1) / n, a[s]!]); }
    else for (let i = s; i < e; i++) pts.push([(i + 0.5) / n, a[i]!]);
    out.push(pts);
  }
  return out;
}

/** The engine ids one machine's history is asked for: its Dagger host when the fleet has one,
 *  else its agents. */
export function historyIds(w: World, host: string, agents: readonly string[]): string[] {
  for (const e of w.engines.values()) if (e.kind === 'dagger' && (e.host ?? e.label ?? e.id) === host && e.id) return [e.id];
  return agents.filter((id) => !!id);
}

/** The walls' histories: asked from a source (`pump`), folded once per answer, read by draws. */
export class PlantHist {
  /** Bumps whenever a machine's folded history changed (the static floor's key reads it). */
  ver = 0;
  private tides = new Map<string, Tide>();
  private asked = new Map<string, number>();
  private busy = new Set<string>();
  private gen = 0;
  /** The fetcher (the seam; tests swap it). */
  fetch: (id: string) => Promise<HistDoc | null> = engineHistoryAsync;

  /** A machine's folded 24 h (`key` is the census group id), or null before the first answer. */
  tide(key: string): Tide | null { return this.tides.get(key) ?? null; }

  /** From a source: asks each machine's history when it is due (once a minute), folds the answer.
   *  `machines`: the census groups' keys and their engine ids (hosted machines have none). */
  pump(machines: readonly { key: string; ids: readonly string[] }[], clock: number): void {
    for (const m of machines) {
      if (!m.ids.length || this.busy.has(m.key)) continue;
      const at = this.asked.get(m.key);
      if (at !== undefined && clock - at < HIST_EVERY_MS && clock >= at) continue;
      this.asked.set(m.key, clock);
      this.busy.add(m.key);
      const ids = m.ids.slice(0, 8), gen = this.gen;
      Promise.all(ids.map((id) => this.fetch(id).catch(() => null))).then((docs) => {
        if (gen !== this.gen) return; // asked of a server since forgotten
        const t = foldTide(m.key, docs);
        const prev = this.tides.get(m.key);
        if (!prev || sigOf(prev) !== sigOf(t)) { this.tides.set(m.key, t); this.ver++; }
      }, () => {}).finally(() => { this.busy.delete(m.key); });
    }
  }

  /** Forget everything (a new server, a reset). */
  clear(): void { this.tides.clear(); this.asked.clear(); this.busy.clear(); this.gen++; this.ver++; }
}

/** What the wall would paint, as a short key (a quantized copy of the series). */
function sigOf(t: Tide): string {
  let s = `${t.source}|${t.to}|`;
  const q = (x: number) => (x === x ? String.fromCharCode(48 + Math.round(x * 40)) : '_');
  for (let i = 0; i < t.n; i++) s += q(t.busy[i]!) + q(t.peak[i]!) + q(t.cpu[i]!) + q(t.mem[i]!);
  return s;
}
