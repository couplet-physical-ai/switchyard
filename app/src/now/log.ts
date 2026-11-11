// The log tail of one step (GET /api/v1/pipeline/{id}/log, only when meta.caps has
// "pipeline_log"). Same auth as every call (the Bearer header; never a token in a URL). Asked with
// tail=500 (the server's decisive error line often sits 65–350 lines from the end) and `decisive`
// (its index in the reply). ONE tail is held at a time and dropped when the selection changes;
// refreshed every ~10 s only while the step runs. What the view gets is bounded: the decisive line
// with a few lines around it, then the last lines (≤ SHOW rows in all), each ≤ COLS chars.
import type { Upstream } from '../api.ts';
import type { World } from '../world.ts';

export type LogRow = { id: string; n: string; text: string; hot: boolean };
export type Log = { ok: boolean; step: string; rows: LogRow[]; note: string; gap: boolean };
export const NO_LOG: Log = { ok: false, step: '', rows: [], note: '', gap: false };
/** [selection "job:<id>", step, workflow, tick (changes every ~10 s while running, else 0), capable, failed (ask the window around the decisive line)] */
export type LogArgs = [string, string, string, number, boolean, boolean];

const TAIL = 500, COLS = 240, SHOW = 48, WINDOW = 120, BEFORE = 6, AFTER = 10, LAST = 24;
const BYTES = 256 << 10;

/** The rows to show: around the decisive line, then the tail's end (pure; tested). */
export function pickRows(lines: readonly string[], decisive: number, whole = false): { rows: LogRow[]; gap: boolean } {
  const n = lines.length;
  // the server's window around the decisive line (≤ 81 lines) shows whole
  if (whole && n <= WINDOW) return { rows: lines.map((l, i) => ({ id: `l${i}`, n: String(i + 1), text: String(l ?? '').slice(0, COLS), hot: i === decisive })), gap: false };
  const take = new Set<number>();
  if (decisive >= 0 && decisive < n) for (let i = Math.max(0, decisive - BEFORE); i <= Math.min(n - 1, decisive + AFTER); i++) take.add(i);
  for (let i = Math.max(0, n - LAST); i < n; i++) take.add(i);
  if (take.size < SHOW) for (let i = n - 1; i >= 0 && take.size < SHOW; i--) take.add(i);
  const idx = [...take].sort((a, b) => a - b).slice(-SHOW);
  let gap = false;
  const rows: LogRow[] = [];
  for (let k = 0; k < idx.length; k++) {
    const i = idx[k];
    if (k > 0 && i !== idx[k - 1] + 1) { gap = true; rows.push({ id: `gap${i}`, n: '', text: '⋯', hot: false }); }
    rows.push({ id: `l${i}`, n: String(i + 1), text: String(lines[i] ?? '').slice(0, COLS), hot: i === decisive });
  }
  return { rows, gap };
}

let held: { key: string; tick: number; v: Log; p: Promise<Log> | null } | null = null;

export function logAnswer(d: { upstream: () => Upstream | null; world: () => World }, [sel, step, workflow, tick, cap, failed]: LogArgs): Log | Promise<Log> {
  const id = String(sel ?? '').startsWith('job:') ? String(sel).slice(4) : '';
  if (!id || !step || !cap) { held = null; return NO_LOG; }
  const up = d.upstream();
  if (!up || up.kind !== 'http') { held = null; return NO_LOG; }
  const key = `${id}|${workflow}|${step}|${failed ? 'f' : ''}`;
  if (held && held.key !== key) held = null;
  if (held && (held.tick === tick || held.p)) return held.p ?? held.v;
  const u = up as unknown as { base: string; token: string };
  const headers: Record<string, string> = { accept: 'application/json' };
  if (u.token) headers.authorization = `Bearer ${u.token}`;
  const path = `/api/v1/pipeline/${encodeURIComponent(id)}/log?step=${encodeURIComponent(step)}${workflow ? `&workflow=${encodeURIComponent(workflow)}` : ''}&tail=${TAIL}${failed ? '&around=decisive' : ''}`;
  const gha = id.startsWith('gha:');
  const prev = held?.v ?? { ...NO_LOG, step, note: 'loading the log…' };
  const slot = { key, tick, v: prev, p: null as Promise<Log> | null };
  held = slot;
  slot.p = fetch(u.base + path, { headers, exactTimeout: 10000, exactIndependentHttp: { maxResponseBytes: BYTES } } as RequestInit)
    .then(async (r): Promise<Log> => {
      if (!r.ok) return { ...NO_LOG, step, note: 'log unavailable' };
      const j = (await r.json()) as { lines?: unknown; truncated?: boolean; state?: string; decisive?: number; around?: string; after?: number };
      const all = Array.isArray(j.lines) ? j.lines : [];
      const lines = all.slice(-TAIL).map((l) => String(l));
      const dec = typeof j.decisive === 'number' ? j.decisive - Math.max(0, all.length - lines.length) : -1;
      const { rows, gap } = pickRows(lines, dec, j.around === 'decisive');
      let note = j.around === 'decisive' ? `the error and the ${lines.length - 1} lines around it${j.after ? ` · ${j.after} more after` : ''}` : `last ${lines.length} ${lines.length === 1 ? 'line' : 'lines'}${j.truncated ? ' (truncated)' : ''}${gap ? ' · the error and the end' : ''}`;
      if (!lines.length) note = gha && j.state === 'running' ? 'GitHub publishes the log when the job ends' : j.state === 'running' ? 'no output yet' : 'no output';
      return { ok: true, step, rows, note, gap };
    }, (): Log => ({ ...NO_LOG, step, note: 'log unavailable' }))
    .then((v) => { if (held === slot) { slot.v = v; slot.p = null; } return v; });
  return slot.p;
}
