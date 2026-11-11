// The page module (fx-kc; README "Security"): the web's side of the token ops the macOS module
// answers in modules/apple/Keychain.swift. The web has no Keychain: the token is the page's
// `localStorage`, under the key Exact used for `secret.keep switchyard.token`
// (`exact.secret.<name>`, host/web glue), so a token a 0.1.2 page kept carries over. The data
// module asks `native.later({op: "tokenGet" | "tokenSet" | "tokenForget"})`; nothing else.

const KEY = 'exact.secret.switchyard.token';
let agent = false;

export function connect(context) {
  agent = !!context?.agent;
}

const store = () => {
  try { return globalThis.localStorage ?? null; } catch { return null; }
};

export async function later(request) {
  const op = request?.op;
  const s = store();
  if (op === 'tokenGet') {
    // The agent's test hook (tests/token.test.contract): a read that answers denied.
    if (agent && request.simulate === 'denied') return { status: 'denied', detail: 'denied by the test hook (agent only)' };
    if (!s) return { status: 'none' };
    try {
      const token = (s.getItem(KEY) ?? '').trim();
      return token ? { status: 'ready', token, source: 'web' } : { status: 'none' };
    } catch (e) {
      return { status: 'error', detail: String(e?.message ?? e) };
    }
  }
  if (op === 'tokenSet') {
    const token = String(request.token ?? '').trim();
    if (!token) return { ok: false, detail: 'no token to keep' };
    if (!s) return { ok: false, detail: 'this browser keeps no storage for this page' };
    try { s.setItem(KEY, token); return { ok: true }; } catch (e) { return { ok: false, detail: String(e?.message ?? e) }; }
  }
  if (op === 'tokenForget') {
    try { s?.removeItem(KEY); return { ok: true }; } catch (e) { return { ok: false, detail: String(e?.message ?? e) }; }
  }
  throw new Error('the page module answers tokenGet, tokenSet and tokenForget');
}
