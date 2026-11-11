// THE PERSISTED HOURLY RING (fab-w2; FACTORY-SPEC §H4): a 7-d baseline kept by the client for
// a server that has none (v0.4: `Metric.d7` is null there). On v0.5 the server's d7 wins
// (trendmarks.typical reads `m.d7 ?? baseline().d7(…)`); the ring then only adds what the server
// does not send: same-hour-of-day p90s (§B "ember = worse than the same hour's 7-d p90").
//
// One slot per hour per (key, metric), 168 of them (7 d), keyed on the absolute hour
// (floor(ms / 1 h) mod 168), so a gap clears the hours it skipped. Keys are 'fleet' and lane /
// group ids; metrics are a few counts (pipelines/h, failures/h, red mains, pushes/h: no server
// sends that one; the pass rate is derived from the first two). Each slot holds the hour's last observation of the rolling
// last-hour value (≈ that hour's rate by its end).
//
// Persistence: `serialize(maxBytes)` packs every series into one string (a slot is one base64url
// character, log-quantized ~10 % steps; runs of empty hours run-length coded), the fleet first,
// then lanes by size, until the budget; `load(s)` merges one back. The app's storage source
// (W4's `facSeen` in app.ts / app.contract) binds a store with `bindBaselineStore`: it is loaded
// at once and saved at most every 5 min of the module clock while dirty.

export const RING_H = 168;
const HOUR = 3_600_000;
/** The persisted metrics: everything else is derived or the server's. */
export const BASE_METRICS = ['pipelines', 'failures', 'red', 'pushes'] as const;
export type BaseMetric = typeof BASE_METRICS[number] | 'pass_rate';

const ALPHA = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const NULL_Q = 63;
const QK = 7;
/** A value → 0..62 (log2(1 + x) × 7: ~10 % steps, up to ~460). */
export function quant(x: number): number { return Math.min(62, Math.max(0, Math.round(Math.log2(1 + Math.max(0, x)) * QK))); }
export function dequant(q: number): number { return Math.round((Math.pow(2, q / QK) - 1) * 100) / 100; }

type Series = Float64Array; // NaN = no sample

export type BaselineStore = { load(): string; save(s: string): void };

export class Baseline {
  private series = new Map<string, Series>();
  /** The newest absolute hour written (−1: nothing yet). */
  lastHour = -1;
  /** Changed since the last save. */
  dirty = false;
  private store: BaselineStore | null = null;
  private savedAt = -1e15;

  private key(k: string, m: string): string { return `${k}\u0001${m}`; }

  /** Advances the ring to `hour`: the hours it skipped (and the new hour) start empty. */
  private advance(hour: number): void {
    if (this.lastHour < 0) { this.lastHour = hour; return; }
    if (hour <= this.lastHour) return;
    const gap = hour - this.lastHour;
    for (const s of this.series.values()) {
      if (gap >= RING_H) s.fill(NaN);
      else for (let h = this.lastHour + 1; h <= hour; h++) s[h % RING_H] = NaN;
    }
    this.lastHour = hour;
  }

  /** The sample of `metric` for `key` in the hour of `at` (world ms). Hours older than the ring
   *  are ignored; a newer hour advances it. */
  record(key: string, metric: BaseMetric, at: number, v: number | null | undefined): void {
    if (metric === 'pass_rate' || v === null || v === undefined || !Number.isFinite(v) || !(at > 0)) return;
    const hour = Math.floor(at / HOUR);
    if (this.lastHour >= 0 && hour <= this.lastHour - RING_H) return;
    this.advance(hour);
    let s = this.series.get(this.key(key, metric));
    if (!s) { s = new Float64Array(RING_H).fill(NaN); this.series.set(this.key(key, metric), s); }
    const q = dequant(quant(v));
    if (s[hour % RING_H] !== q) { s[hour % RING_H] = q; this.dirty = true; }
  }

  /** A 24 h spark (oldest first, the hour of `at` last) written into the hours it covers that
   *  hold no sample yet (a fresh ring starts with a day). */
  seed(key: string, metric: BaseMetric, spark: readonly (number | null)[], at: number): void {
    const hour = Math.floor(at / HOUR);
    const n = spark.length;
    for (let i = 0; i < n; i++) {
      const h = hour - (n - 1 - i);
      if (this.get(key, metric, h) === null) this.record(key, metric, h * HOUR + 1, spark[i]);
    }
  }

  /** The sample for absolute hour `hour` (null: none). `pass_rate` = 1 − failures / pipelines. */
  get(key: string, metric: BaseMetric, hour: number): number | null {
    if (metric === 'pass_rate') {
      const p = this.get(key, 'pipelines', hour), f = this.get(key, 'failures', hour);
      return p === null || f === null || p <= 0 ? null : Math.max(0, Math.min(1, 1 - f / p));
    }
    if (this.lastHour < 0 || hour > this.lastHour || hour <= this.lastHour - RING_H) return null;
    const s = this.series.get(this.key(key, metric));
    if (!s) return null;
    const v = s[hour % RING_H]!;
    return Number.isNaN(v) ? null : v;
  }

  /** Every sample of the last 7 d (oldest first); `hourOfDay` 0..23: only those hours (UTC). */
  values(key: string, metric: BaseMetric, hourOfDay = -1): number[] {
    const out: number[] = [];
    if (this.lastHour < 0) return out;
    for (let h = this.lastHour - RING_H + 1; h <= this.lastHour; h++) {
      if (hourOfDay >= 0 && ((h % 24) + 24) % 24 !== hourOfDay) continue;
      const v = this.get(key, metric, h);
      if (v !== null) out.push(v);
    }
    return out;
  }

  /** Hours with a sample (of any metric) for `key`. */
  hours(key: string): number {
    let n = 0;
    if (this.lastHour < 0) return 0;
    for (let h = this.lastHour - RING_H + 1; h <= this.lastHour; h++) if (BASE_METRICS.some((m) => this.get(key, m, h) !== null)) n++;
    return n;
  }

  /** The 7-d typical: the mean of the ring's samples, once it holds a day (null before). */
  d7(key: string, metric: string): number | null {
    if (!isBase(metric)) return null;
    const xs = this.values(key, metric);
    if (xs.length < 24) return null;
    return Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 1000) / 1000;
  }

  /** The 90th percentile: of the same hour of day over the week when it has ≥ 3 of them, else of
   *  every hour once the ring holds two days; null before. For the pass rate, the 10th (its bad
   *  side is low). `at` 0: every hour. */
  p90(key: string, metric: string, at = 0): number | null {
    if (!isBase(metric)) return null;
    const low = metric === 'pass_rate';
    if (at > 0) {
      const same = this.values(key, metric, Math.floor(at / HOUR) % 24);
      if (same.length >= 3) return pct(same, low ? 0.1 : 0.9);
    }
    const all = this.values(key, metric);
    return all.length >= 48 ? pct(all, low ? 0.1 : 0.9) : null;
  }

  // ── persistence ──

  /** Every series in one string, ≤ `maxBytes`: `b1|<lastHour>|key\u0002metric=<168 slots>;…`, the
   *  fleet first, then the keys with the most samples; a slot is one character (`_` empty), a run
   *  of ≥ 4 empty hours `~` + its length in one character. */
  serialize(maxBytes = 6000): string {
    let out = `b1|${this.lastHour}|`;
    if (this.lastHour < 0) return out;
    const keys = [...new Set([...this.series.keys()].map((k) => k.split('\u0001')[0]!))];
    keys.sort((a, b) => (a === 'fleet' ? -1 : b === 'fleet' ? 1 : this.hours(b) - this.hours(a) || (a < b ? -1 : 1)));
    for (const k of keys) {
      let chunk = '';
      for (const m of BASE_METRICS) {
        const s = this.series.get(this.key(k, m));
        if (!s) continue;
        let body = '', run = 0;
        const flush = () => { while (run > 0) { if (run >= 4) { const n = Math.min(run, 63); body += `~${ALPHA[n]}`; run -= n; } else { body += ALPHA[NULL_Q]!.repeat(run); run = 0; } } };
        for (let h = this.lastHour - RING_H + 1; h <= this.lastHour; h++) {
          const v = s[((h % RING_H) + RING_H) % RING_H]!;
          if (Number.isNaN(v)) { run++; continue; }
          flush();
          body += ALPHA[quant(v)];
        }
        flush();
        if (/^(~.)*$/.test(body)) continue;
        chunk += `${k}\u0002${m}=${body};`;
      }
      if (out.length + chunk.length > maxBytes) break;
      out += chunk;
    }
    return out;
  }

  /** Merges a serialized ring (newer hours win; a stale one is ignored hour by hour). */
  load(s: string): void {
    const m = /^b1\|(-?\d+)\|(.*)$/s.exec(s ?? '');
    if (!m) return;
    const last = Number(m[1]);
    if (!(last >= 0)) return;
    for (const part of m[2]!.split(';')) {
      const eq = part.indexOf('=');
      if (eq < 0) continue;
      const [key, metric] = part.slice(0, eq).split('\u0002');
      if (!key || !metric || !(BASE_METRICS as readonly string[]).includes(metric)) continue;
      const body = part.slice(eq + 1);
      let h = last - RING_H + 1;
      for (let i = 0; i < body.length && h <= last; i++) {
        const c = body[i]!;
        if (c === '~') { h += ALPHA.indexOf(body[++i] ?? 'A'); continue; }
        const q = ALPHA.indexOf(c);
        if (q >= 0 && q !== NULL_Q && this.get(key, metric as BaseMetric, h) === null) this.record(key, metric as BaseMetric, h * HOUR + 1, dequant(q));
        h++;
      }
    }
  }

  /** Binds the app's storage: loads it now, saves through it (see `maybeSave`). */
  bind(store: BaselineStore): void {
    this.store = store;
    try { this.load(store.load()); } catch { /* an unreadable ring starts empty */ }
    this.dirty = false;
  }

  /** Saves when dirty, at most every 5 min of the module clock `clock`. */
  maybeSave(clock: number): void {
    if (!this.store || !this.dirty || (clock - this.savedAt < 300_000 && clock >= this.savedAt)) return;
    this.savedAt = clock;
    this.dirty = false;
    try { this.store.save(this.serialize()); } catch { /* the next save tries again */ this.dirty = true; }
  }

  clear(): void { this.series.clear(); this.lastHour = -1; this.dirty = false; }
}

function isBase(m: string): m is BaseMetric { return m === 'pass_rate' || (BASE_METRICS as readonly string[]).includes(m); }

function pct(xs: number[], p: number): number {
  const s = xs.slice().sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.round(p * (s.length - 1))))]!;
}

let ring: Baseline | null = null;
/** The session's ring (one per data module). */
export function baseline(): Baseline { return (ring ??= new Baseline()); }
/** W4's storage source binds the persisted ring here (FACTORY-SPEC §I: `facSeen` persists it). */
export function bindBaselineStore(store: BaselineStore): void { baseline().bind(store); }
