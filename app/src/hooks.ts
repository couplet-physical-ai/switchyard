// SWITCHYARD_TOKEN_FILE's data-module side (README "Test hooks"; the native side is
// modules/apple/Hooks.swift, the Contract side views/hooks.contract). The module reads the token
// at launch and hands it over once. It goes through the switchyard:// link's checks (parseLink)
// and is stored as Connect stores one (app.ts `saveToken`: the token file on macOS,
// modules/apple/Keychain.swift), with the server in the stored `server`; no confirm sheet. The
// connect that follows is reported to the module, which logs it. The token stays in this
// module's memory and the token store: no answer carries it, so no answer kept across launches
// holds it. The web's page module answers no `call`, so nothing happens there.

import type { NativeModule } from '../app.contract.d.ts';

type Link = { server: string; token: string; ok: boolean };
type Check = (u: string, server: string, token: string) => Link;
type Taken = { server: string; ok: boolean };

/** The token the hook handed over, until a connect with it is reported. */
let pending: { token: string } | null = null;
/** How the latest connect with it went, until it is reported. */
let outcome: { ok: boolean; server: string; reason: string } | null = null;

/** The module logs `token-file: connected <server>` or `token-file: failed <reason>`. A `call`,
 *  inside the answer that asks: a native call from a continuation is not one. */
function report(native: NativeModule | null | undefined, ok: boolean, server: string, reason: string): boolean {
  if (!native?.available) return false;
  try {
    native.call({ op: 'tokenFileResult', ok, server, reason });
    return true;
  } catch {
    return false; // a module with no hook
  }
}

/** `{server, ok}` once, when SWITCHYARD_TOKEN_FILE named a readable token (the module refused
 *  and logged anything else). The server is SWITCHYARD_SERVER, else the build's default, else ""
 *  (the action keeps the stored one). */
export function takeTokenFile(native: NativeModule | null | undefined, defaultServer: string, check: Check): Taken {
  const none: Taken = { server: '', ok: false };
  if (!native?.available) return none;
  let r: Record<string, unknown>;
  try {
    r = native.call({ op: 'tokenFile' });
  } catch {
    return none; // a module with no hook
  }
  if (r.has !== true || typeof r.token !== 'string') return none;
  const server = (typeof r.server === 'string' && r.server.trim() ? r.server : defaultServer).trim();
  // The link's own checks: an http(s) server or a bare host, a token of URL-safe characters.
  const link = check('', server || 'localhost', r.token);
  if (!link.ok || !link.token) {
    report(native, false, server, !link.ok && link.server === '' ? `${server} is not an http(s) server or a host` : 'the token has characters a device token never has');
    return none;
  }
  pending = { token: link.token };
  return { server: server ? link.server : '', ok: true };
}

/** Connect's `saveToken(token, true)` for the hook's token, which never leaves this module. */
export async function saveTokenFile(save: (token: string) => Promise<{ ok: boolean; status: string }>): Promise<{ ok: boolean; status: string }> {
  if (!pending) return { ok: false, status: 'no token from SWITCHYARD_TOKEN_FILE' };
  return save(pending.token);
}

/** After the newest connect (app.ts skips one a newer connect overtook, whose answer is let go):
 *  when it used the hook's token, keep how it went, until the report is made. */
export function connectedWith(token: string, base: string, ok: boolean, why: string): void {
  if (!pending || token !== pending.token) return;
  outcome = !base
    ? { ok: false, server: '', reason: 'no server: set SWITCHYARD_SERVER (this build has no built-in one and none is stored)' }
    : { ok, server: base, reason: ok ? '' : `${base}: ${why}` };
}

/** Asked every tick while the hook waits (views/hooks.contract): reports the outcome once there
 *  is one, and answers ok then. */
export function tokenFileReport(native: NativeModule | null | undefined): { ok: boolean; status: string } {
  const o = outcome;
  if (!o) return { ok: false, status: pending ? 'waiting' : 'idle' };
  outcome = null;
  pending = null;
  report(native, o.ok, o.server, o.reason);
  return { ok: true, status: o.ok ? 'connected' : 'failed' };
}

// The kept-answer scrub with the stored token's value (f3ab409) runs in the module as it reads
// the token (modules/apple/Keychain.swift `onRead`): the read is async now, and a native call
// from a continuation is not one.
