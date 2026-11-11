// The updater's two sources (views/update.contract): the macOS module's state, worded for the
// pill and the Settings section, and its check/install calls. The web has no module: `native`
// is absent or unavailable there, so nothing shows (the server always serves the newest web
// build).

import type { NativeModule, Result } from '../app.contract.d.ts';

type Upd = Result<'updateState'>;

const NONE: Upd = {
  supported: false, state: 'idle', current: '', latest: '', progress: 0, notes: '', error: '', line: '', status: '',
  show: false, canInstall: false, auto: false, autoInstall: false, prerelease: false, checks: 0, stub: false,
};

/** What the pill and Settings say, from the module's raw state (modules/apple/Updater.swift). */
export function present(raw: Record<string, unknown>): Upd {
  const s = (k: string) => (typeof raw[k] === 'string' ? (raw[k] as string) : '');
  const n = (k: string) => (typeof raw[k] === 'number' ? (raw[k] as number) : 0);
  const b = (k: string) => raw[k] === true;
  const state = s('state') || 'idle';
  const current = s('current');
  const v = s('latest') ? `v${s('latest')}` : '';
  const pct = Math.max(0, Math.min(100, Math.floor(n('progress'))));
  const error = s('error');
  const canInstall = b('canInstall');
  const flash = b('flash');
  // The pill: an update's progress always; a failure unless it was an automatic check that
  // could not reach the feed (offline is not news); "checking" and "up to date" only for a
  // few seconds after a check somebody asked for.
  const line =
    state === 'checking' ? 'Checking for updates…'
    : state === 'current' ? `Switchyard ${current} is up to date`
    : state === 'available' ? `Update available · ${v}`
    : state === 'downloading' ? `Downloading ${v} · ${pct}%`
    : state === 'ready' ? 'Update ready · Relaunch to update'
    : state === 'installing' ? `Installing ${v}…`
    : state === 'error' ? `Update failed: ${error}`
    : '';
  const show =
    state === 'available' || state === 'downloading' || state === 'ready' || state === 'installing'
    || (state === 'error' && !b('quiet'))
    || (flash && (state === 'checking' || state === 'current'));
  const status =
    state === 'checking' ? 'Checking for updates…'
    : state === 'current' ? 'Up to date'
    : state === 'available' ? `${v} is available${canInstall ? '' : ' · this copy is not in Applications, so it cannot update itself'}`
    : state === 'downloading' ? `Downloading ${v} · ${pct}%`
    : state === 'ready' ? `${v} is ready`
    : state === 'installing' ? `Installing ${v}…`
    : state === 'error' ? `Update failed: ${error}`
    : b('auto') ? 'Checks every 6 hours'
    : 'Checks when asked (this copy is not installed in Applications)';
  return {
    supported: b('supported'), state, current, latest: s('latest'), progress: pct, notes: s('notes'), error, line, status, show,
    canInstall, auto: b('auto'), autoInstall: b('autoInstall'), prerelease: b('prerelease'), checks: n('checks'), stub: b('stub'),
  };
}

export function updateState(native: NativeModule | null | undefined): Upd {
  if (!native?.available) return NONE;
  native.watch('update');
  try {
    return present(native.call({ op: 'state' }));
  } catch {
    return NONE; // no updater module in this build
  }
}

export async function updateDo(op: string, native: NativeModule | null | undefined): Promise<Result<'updateDo'>> {
  if (!native?.available) return { ok: false, installed: false, error: 'no updater here' };
  try {
    const r = await native.later(op === 'install' ? { op: 'install' } : { op: 'check', manual: true });
    return { ok: true, installed: r.installed === true, error: typeof r.error === 'string' ? r.error : '' };
  } catch (e) {
    return { ok: false, installed: false, error: String((e as Error).message ?? e) };
  }
}
