// The updater's two sources (views/update.contract): the macOS module's state, and its
// check/install calls. The web has no module: `native` is absent or unavailable there, so
// the pill and the menu item never show (the server always serves the newest web build).

import type { NativeModule, Result } from '../app.contract.d.ts';

type Upd = Result<'updateState'>;

const NONE: Upd = {
  supported: false, state: 'idle', current: '', latest: '', progress: 0, notes: '', error: '', notice: '',
  line: '', show: false, canInstall: false, auto: false, autoInstall: false, prerelease: false, checks: 0,
};

/** What the pill says, from the module's raw state (modules/apple/Updater.swift). */
export function present(raw: Record<string, unknown>): Upd {
  const s = (k: string) => (typeof raw[k] === 'string' ? (raw[k] as string) : '');
  const n = (k: string) => (typeof raw[k] === 'number' ? (raw[k] as number) : 0);
  const b = (k: string) => raw[k] === true;
  const state = s('state') || 'idle';
  const latest = s('latest');
  const notice = s('notice');
  const line =
    state === 'ready' ? `Switchyard ${latest} is ready · Restart to update`
    : state === 'installing' ? `Installing Switchyard ${latest}…`
    : notice;
  return {
    supported: b('supported'), state, current: s('current'), latest, progress: n('progress'), notes: s('notes'),
    error: s('error'), notice, line, show: state === 'ready' || state === 'installing' || notice !== '',
    canInstall: b('canInstall'), auto: b('auto'), autoInstall: b('autoInstall'), prerelease: b('prerelease'), checks: n('checks'),
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
