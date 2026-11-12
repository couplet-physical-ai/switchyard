// The board inspector's log (GET /api/v1/pipeline/{id}/log): the decisive line and the lines
// around it for a failure (`around=decisive`), the tail for a running step. Its own fetch slot
// (Live's log has its own).

import type { Upstream } from '../api.ts';
import { pickRows } from '../now/log.ts';

export type FlRow = { id: string; n: string; text: string; hot: boolean };
export type FlLog = { ok: boolean; rows: FlRow[]; note: string };
export const NO_LOG: FlLog = { ok: false, rows: [], note: '' };

// ---- the log (GET /api/v1/pipeline/{id}/log), its own single slot ----
const TAIL = 400, BYTES = 256 << 10;
let held: { key: string; tick: number; v: FlLog; p: Promise<FlLog> | null } | null = null;

export function logOf(up: Upstream | null, id: string, step: string, workflow: string, tick: number, failed: boolean): FlLog | Promise<FlLog> {
  if (!id || !step || !up || up.kind !== 'http') { held = null; return NO_LOG; }
  const key = `${id}|${workflow}|${step}|${failed ? 'f' : ''}`;
  if (held && held.key !== key) held = null;
  if (held && (held.tick === tick || held.p)) return held.p ?? held.v;
  const u = up as unknown as { base: string; token: string };
  const headers: Record<string, string> = { accept: 'application/json' };
  if (u.token) headers.authorization = `Bearer ${u.token}`;
  const path = `/api/v1/pipeline/${encodeURIComponent(id)}/log?step=${encodeURIComponent(step)}${workflow ? `&workflow=${encodeURIComponent(workflow)}` : ''}&tail=${TAIL}${failed ? '&around=decisive' : ''}`;
  const slot = { key, tick, v: held?.v ?? { ...NO_LOG, note: 'loading the log…' }, p: null as Promise<FlLog> | null };
  held = slot;
  slot.p = fetch(u.base + path, { headers, exactTimeout: 10000, exactIndependentHttp: { maxResponseBytes: BYTES } } as RequestInit)
    .then(async (res): Promise<FlLog> => {
      if (!res.ok) return { ...NO_LOG, note: 'log unavailable' };
      const j = (await res.json()) as { lines?: unknown; decisive?: number; around?: string; after?: number; state?: string };
      const all = Array.isArray(j.lines) ? j.lines.map((l) => String(l)) : [];
      const lines = all.slice(-TAIL);
      const dec = typeof j.decisive === 'number' ? j.decisive - Math.max(0, all.length - lines.length) : -1;
      // the inspector never scrolls: the decisive line with 8 before and 12 after, or the last 22
      const lo = dec >= 0 ? Math.max(0, dec - 8) : Math.max(0, lines.length - 22);
      const hi = dec >= 0 ? Math.min(lines.length, dec + 13) : lines.length;
      const { rows } = pickRows(lines.slice(lo, hi), dec >= 0 ? dec - lo : -1, true);
      const off = lo;
      const out = rows.map((r) => ({ ...r, n: String(Number(r.n) + off), id: `${off}:${r.id}` }));
      const note = !lines.length ? (j.state === 'running' ? 'no output yet' : 'no output') : dec >= 0 ? 'the decisive line and the lines around it' : `the last ${out.length} lines`;
      return { ok: true, rows: out, note };
    }, (): FlLog => ({ ...NO_LOG, note: 'log unavailable' }))
    .then((v) => { if (held === slot) { slot.v = v; slot.p = null; } return v; });
  return slot.p;
}
