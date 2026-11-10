// A same-origin stand-in for the platform edge, for driving the WEB build against a server that
// wants a token (the live one) from a headless browser: it serves a web build and forwards
// /api/* there with the token added, as the SSO edge adds a session. The page sees exactly
// production's shape: same-origin /api/v1/* and ws(s)://<page>/api/v1/stream, no token.
//   bun app/tools/live-proxy.ts --dist /tmp/sy-web --upstream https://switchyard.apps.example.com \
//     --token-file ~/.config/switchyard/e2e-token [--port 8095]
// The token is read from the file and never printed. Local use only (it binds 127.0.0.1).
import { join, normalize } from 'node:path';

const arg = (name: string, def = '') => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] ?? def : def;
};
const dist = arg('dist', 'dist');
const upstream = arg('upstream', 'https://switchyard.apps.example.com').replace(/\/+$/, '');
const port = Number(arg('port', '8095'));
const tokenFile = arg('token-file');
const token = tokenFile ? (await Bun.file(tokenFile.replace(/^~/, process.env.HOME ?? '')).text()).trim() : '';
if (!token) console.log('no --token-file: forwarding without a token');

type Up = { up: WebSocket | null; queue: string[]; since: string };

const server = Bun.serve<Up, unknown>({
  hostname: '127.0.0.1',
  port,
  async fetch(req, srv) {
    const url = new URL(req.url);
    if (url.pathname === '/api/v1/stream' && req.headers.get('upgrade')?.toLowerCase() === 'websocket') {
      return srv.upgrade(req, { data: { up: null, queue: [], since: url.searchParams.get('since') ?? '' } }) ? undefined : new Response('upgrade failed', { status: 400 });
    }
    // A development page the agent serves elsewhere may read through it too (local only).
    const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'authorization, accept', 'access-control-allow-methods': 'GET' };
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (url.pathname.startsWith('/api/')) {
      const headers = new Headers({ accept: req.headers.get('accept') ?? 'application/json' });
      if (token) headers.set('authorization', `Bearer ${token}`);
      const r = await fetch(upstream + url.pathname + url.search, { method: req.method, headers, redirect: 'manual' });
      const h = new Headers(cors);
      for (const k of ['content-type', 'etag', 'cache-control', 'x-switchyard-seq']) { const v = r.headers.get(k); if (v) h.set(k, v); }
      return new Response(r.body, { status: r.status, headers: h });
    }
    // The web build: a file if it exists, else the shell (client routes), as the server does.
    const path = normalize(url.pathname).replace(/^(\.\.[/\\])+/, '');
    let f = Bun.file(join(dist, path === '/' ? 'index.html' : path));
    if (!(await f.exists())) f = Bun.file(join(dist, 'index.html'));
    return new Response(f);
  },
  websocket: {
    open(ws) {
      // Upstream, a header-less socket takes the token in the query on /tstream (contract v0.3).
      const q = new URLSearchParams();
      if (ws.data.since) q.set('since', ws.data.since);
      if (token) q.set('token', token);
      const up = new WebSocket(`${upstream.replace(/^http/, 'ws')}/api/v1/${token ? 'tstream' : 'stream'}?${q}`);
      ws.data.up = up;
      up.onopen = () => { for (const m of ws.data.queue.splice(0)) up.send(m); };
      up.onmessage = (m) => ws.send(typeof m.data === 'string' ? m.data : new Uint8Array(m.data as ArrayBuffer));
      up.onclose = (e) => ws.close(e.code === 1005 || e.code === 1006 ? 1011 : e.code, e.reason);
      up.onerror = () => ws.close(1011, 'upstream failed');
    },
    message(ws, msg) { const u = ws.data.up; if (u && u.readyState === 1) u.send(msg); else ws.data.queue.push(String(msg)); },
    close(ws) { ws.data.up?.close(); },
  },
});

console.log(`live proxy: http://127.0.0.1:${server.port} → ${upstream} (web from ${dist})`);
