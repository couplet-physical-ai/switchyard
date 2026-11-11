// NOW: the primary view's view model (views/now.contract). STUB — owned by sy-zero.
import type { Upstream } from '../api.ts';
import type { World } from '../world.ts';

export interface NowDeps {
  world: () => World;
  /** The playhead (live: the server's now). */
  now: () => number;
  /** Minutes east of UTC, for clock times. */
  offsetMin: () => number;
  upstream: () => Upstream | null;
}

export function nowSources(d: NowDeps) {
  return {
    nowFeed: (_a: unknown) => ({ ok: d.world().loaded, tick: Math.floor(d.now() / 1000) }),
    nowPanel: (_a: unknown) => ({ ok: false, id: '' }),
    nowLog: (_a: unknown) => ({ ok: false, step: '' }),
  };
}
