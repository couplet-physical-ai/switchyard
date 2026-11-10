// Where the data comes from: the Switchyard server over HTTP + WebSocket (contract v0), or
// the built-in demo (a seeded simulation of a fleet, no network). Both answer the same calls.

import type { History, Journey, Meta, PrDetail, SearchResults, Snapshot } from './wire.ts';

export interface Upstream {
  readonly kind: 'http' | 'demo';
  readonly label: string;
  snapshot(): Promise<Snapshot>;
  history(from: number, to: number): Promise<History>;
  journey(repo: string, sha: string): Promise<Journey | null>;
  pr(repo: string, number: number): Promise<PrDetail | null>;
  search(q: string): Promise<SearchResults>;
  meta(): Promise<Meta | null>;
}

/** The server's base URL: the setting, else (on the web) the page's own origin. */
export function resolveBase(server: string): string {
  const s = server.trim().replace(/\/+$/, '');
  if (s && s !== 'demo') return /^https?:\/\//.test(s) ? s : `https://${s}`;
  const origin = (globalThis as { origin?: unknown }).origin;
  return typeof origin === 'string' && /^https?:\/\//.test(origin) ? origin : '';
}

export function wsUrl(base: string, path: string, token: string): string {
  const u = base.replace(/^http/, 'ws') + path;
  return token ? `${u}${u.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}` : u;
}

export class HttpUpstream implements Upstream {
  readonly kind = 'http' as const;
  constructor(readonly base: string, readonly token: string) {}
  get label(): string {
    return this.base.replace(/^https?:\/\//, '');
  }
  private async get<T>(path: string, timeout = 15000): Promise<T> {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (this.token) headers.authorization = `Bearer ${this.token}`;
    const r = await fetch(this.base + path, { headers, exactTimeout: timeout } as RequestInit);
    if (r.status === 404) return null as T;
    if (!r.ok) throw new Error(r.status === 401 || r.status === 403 ? `the server refused the token (${r.status})` : `${path} answered ${r.status}`);
    return (await r.json()) as T;
  }
  async snapshot(): Promise<Snapshot> {
    const s = await this.get<Snapshot | null>('/api/v1/snapshot', 30000);
    if (!s || typeof s !== 'object' || !('repos' in s)) throw new Error('it has no Switchyard API here (no /api/v1/snapshot)');
    return s;
  }
  history(from: number, to: number): Promise<History> {
    return this.get<History>(`/api/v1/history?from=${Math.floor(from)}&to=${Math.floor(to)}`, 60000);
  }
  journey(repo: string, sha: string): Promise<Journey | null> {
    return this.get<Journey | null>(`/api/v1/commit/${repo}/${sha}`);
  }
  pr(repo: string, number: number): Promise<PrDetail | null> {
    return this.get<PrDetail | null>(`/api/v1/pr/${repo}/${number}`);
  }
  search(q: string): Promise<SearchResults> {
    return this.get<SearchResults>(`/api/v1/search?q=${encodeURIComponent(q)}`);
  }
  meta(): Promise<Meta | null> {
    return this.get<Meta | null>('/api/v1/meta');
  }
}
