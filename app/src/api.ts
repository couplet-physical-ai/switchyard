// Where the data comes from: the Switchyard server over HTTP + WebSocket (contract v0), or
// the built-in demo (a seeded simulation of a fleet, no network). Both answer the same calls.

import { parseLarge } from './json.ts';
import type { History, Journey, Meta, PrDetail, SearchResults, Snapshot } from './wire.ts';

export interface Upstream {
  readonly kind: 'http' | 'demo';
  readonly label: string;
  snapshot(): Promise<Snapshot>;
  history(from: number, to: number, withBase?: boolean, ceiling?: number): Promise<History>;
  /** The fleet as it was at `at` (contract v0.3 `/snapshot?at=`); null where the server has none. */
  snapshotAt?(at: number): Promise<Snapshot | null>;
  journey(repo: string, sha: string): Promise<Journey | null>;
  pr(repo: string, number: number): Promise<PrDetail | null>;
  search(q: string): Promise<SearchResults>;
  meta(): Promise<Meta | null>;
}

/** The server's base URL: the setting, else (on the web) the page's own origin. */
/** The server a release build talks to when none is set and no page origin exists (native):
 *  app.ts sets it from the build's SWITCHYARD_DEFAULT_SERVER. Empty in dev and test builds. */
let defaultServer = '';
export function setDefaultServer(s: string): void { defaultServer = s.trim().replace(/\/+$/, ''); }

export function resolveBase(server: string): string {
  const s = server.trim().replace(/\/+$/, '');
  if (s && s !== 'demo') return /^https?:\/\//.test(s) ? s : `https://${s}`;
  const origin = (globalThis as { origin?: unknown }).origin;
  if (typeof origin === 'string' && /^https?:\/\//.test(origin)) return origin;
  return s === 'demo' ? '' : defaultServer;
}

/** The stream's WebSocket URL. A WebSocket cannot carry the Bearer header, so with a device
 *  token it is `/api/v1/tstream?token=` (the one query-token path the platform edge passes,
 *  contract v0.3); without one (the web, same origin, signed in by the edge) `/api/v1/stream`. */
export function wsUrl(base: string, path: string, token: string): string {
  let p = path;
  if (token) p = p.replace('/api/v1/stream', '/api/v1/tstream');
  const u = base.replace(/^http/, 'ws') + p;
  return token ? `${u}${u.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}` : u;
}

const NO_BASE = new Set(['base']);

export class HttpUpstream implements Upstream {
  readonly kind = 'http' as const;
  constructor(readonly base: string, readonly token: string) {}
  get label(): string {
    return this.base.replace(/^https?:\/\//, '');
  }
  /** `ceiling`: the largest reply accepted (Exact refuses a reply over it; 1 MiB unless given).
   *  Reads with one are independent: they need no order with the other requests. */
  private async text(path: string, timeout: number, ceiling: number): Promise<string> {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (this.token) headers.authorization = `Bearer ${this.token}`;
    const r = await fetch(this.base + path, { headers, exactTimeout: timeout, exactIndependentHttp: { maxResponseBytes: ceiling } } as RequestInit);
    if (!r.ok) throw new Error(`${path} answered ${r.status}`);
    return r.text();
  }

  private async get<T>(path: string, timeout = 15000, ceiling = 0, skip?: Set<string>): Promise<T> {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (this.token) headers.authorization = `Bearer ${this.token}`;
    const init: Record<string, unknown> = { headers, exactTimeout: timeout };
    if (ceiling) init.exactIndependentHttp = { maxResponseBytes: ceiling };
    const r = await fetch(this.base + path, init as RequestInit);
    if (r.status === 404) return null as T;
    if (!r.ok) throw new Error(r.status === 401 || r.status === 403 ? `the server refused the token (${r.status})` : `${path} answered ${r.status}`);
    const body = await r.text();
    // With no token the platform's SSO edge redirects to its sign-in page: a page, not JSON.
    if (/^\s*</.test(body)) throw new Error('the server needs sign-in (it answered with a sign-in page)');
    // Large replies (the snapshot, history) parse piece by piece across turns.
    return parseLarge<T>(body, undefined, skip);
  }
  async snapshot(): Promise<Snapshot> {
    const s = await this.get<Snapshot | null>('/api/v1/snapshot', 30000, 12 << 20);
    if (!s || typeof s !== 'object' || !('repos' in s)) throw new Error('it has no Switchyard API here (no /api/v1/snapshot)');
    return s;
  }
  /** `withBase` false: the caller already has the state at `from` (a later chunk of a
   *  replay), so the base is not parsed (and, where the server allows, not sent). */
  async snapshotAt(at: number): Promise<Snapshot | null> {
    const s = await this.get<Snapshot | null>(`/api/v1/snapshot?at=${Math.floor(at)}`, 30000, 12 << 20);
    return s && typeof s === 'object' && 'repos' in s ? s : null;
  }

  /** A window of history. `ceiling` bounds the reply (a bigger one fails as `Refused` before any
   *  of it is in memory: the caller asks for a shorter window). */
  async history(from: number, to: number, withBase = true, ceiling = 20 << 20): Promise<History> {
    const path = `/api/v1/history?from=${Math.floor(from)}&to=${Math.floor(to)}${withBase ? '' : '&base=0'}`;
    if (withBase) return this.get<History>(path, 60000, ceiling);
    // The server writes {"from","to","base","frames"} in that order, and a snapshot has no
    // "frames" key: jump past the base (never scanned) to the frames array.
    const text = await this.text(path, 60000, ceiling);
    const head = /"from":(-?\d+),"to":(-?\d+)/.exec(text.slice(0, 200));
    const k = text.indexOf('"frames":[');
    if (k < 0) return parseLarge<History>(text, undefined, NO_BASE);
    const frames = await parseLarge<History['frames']>(text.slice(k + 9, text.lastIndexOf(']') + 1));
    return { from: head ? Number(head[1]) : from, to: head ? Number(head[2]) : to, frames, bytes: text.length };
  }
  journey(repo: string, sha: string): Promise<Journey | null> {
    return this.get<Journey | null>(`/api/v1/commit/${repo}/${sha}`, 15000, 4 << 20);
  }
  pr(repo: string, number: number): Promise<PrDetail | null> {
    return this.get<PrDetail | null>(`/api/v1/pr/${repo}/${number}`, 15000, 4 << 20);
  }
  search(q: string): Promise<SearchResults> {
    return this.get<SearchResults>(`/api/v1/search?q=${encodeURIComponent(q)}`);
  }
  meta(): Promise<Meta | null> {
    return this.get<Meta | null>('/api/v1/meta');
  }
}
