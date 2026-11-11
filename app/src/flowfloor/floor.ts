// The Factory (ZERO.md "FACTORY REDO"): the whole fleet as one line of work on a fixed,
// auto-fitted isometric floor (no pan, no zoom, no scroll), one canvas. The stations and the
// bin are line.ts; the model is stages.ts; a press picks (`pick`), and the inspector (inspect.ts,
// an HTML panel beside the floor) shows what was picked. The floor refits whenever the window
// changes, and leaves room on the right while the inspector is open.

import type { Ctx2D, Frame } from '../../app.contract.d.ts';
import type { World } from '../world.ts';
import { Gfx } from '../yard/gfx.ts';
import { C } from '../yard/theme.ts';
import { Cam } from './iso.ts';
import { L, WINDOWS, drawHeads, drawLine, type Hit } from './line.ts';
import { failedIn, stagesOf } from './stages.ts';

export const INSPECTOR_W = 420;
export const windowMs = (w: string): number => (WINDOWS.find(([k]) => k === w) ?? WINDOWS[1])[1];

export type FloorArgs = { win: string; sel: string; mode: string; reduced: boolean };

export class FlowFloor {
  private g = new Gfx();
  readonly cam = new Cam();
  private hits: Hit[] = [];
  private t0 = -1;
  private said = '';
  /** For the HUD and the tests: what the last frame drew. */
  stats = { failed: 0, running: 0, waiting: 0, red: 0, apps: 0, machines: 0, ops: 0 };

  draw(ctx: Ctx2D, f: Frame, w: World, now: number, a: FloorArgs): boolean {
    if (this.t0 < 0) this.t0 = f.time;
    const g = this.g;
    g.begin(ctx, f.scale);
    if (f.cause === 'font') g.resetFonts();
    ctx.resetTransform();
    ctx.clearRect(0, 0, f.width, f.height);
    const W = f.width, H = f.height;
    const S = stagesOf(w, now);
    const failed = failedIn(w, now, windowMs(a.win));
    const right = a.sel ? INSPECTOR_W : 0;
    const top = 16;
    // the headline (the Yard's): LIVE, what builds and waits, then the rest in a muted caption
    let x = 16;
    const y0 = top + 18;
    const live = a.mode === 'live';
    x += g.text(live ? 'LIVE' : a.mode.toUpperCase(), x, y0 - 2, live ? C.green : C.amberText, 11) + 12;
    x += g.text(`${S.engines.running}`, x, y0 + 2, S.engines.running ? C.packet : C.ink, 19, true);
    x += g.text(' building · ', x, y0 + 2, C.ink, 19, true);
    x += g.text(`${S.intake.waiting}`, x, y0 + 2, C.ink, 19, true);
    x += g.text(' waiting', x, y0 + 2, C.ink, 19, true) + 16;
    g.runs([
      [`${failed.length} failed in ${a.win}`, failed.length ? C.redText : C.ink3],
      [` · ${S.mains.red.length} main lines red`, C.ink3],
      [` · ${S.apps.up} of ${S.apps.total} apps up`, C.ink3],
    ], x, y0, 11.5, W - right - x - 16);
    const headTop = top + 44;
    this.cam.fit(W, H, L.u0, L.v0, L.u1, L.v1 + 40, 70, 20, headTop + 52, W - 40 - right, H - headTop - 64);
    const phase = a.reduced ? 0 : (((f.time - this.t0) / 1600) % 1);
    this.hits = drawLine(g, this.cam, S, now, { phase, window: a.win, windowMs: windowMs(a.win), selected: a.sel, failed });
    drawHeads(g, this.cam, S, now, headTop);
    // for the tests (as the old floor did): where the bin's newest crate is, once per layout
    const fh = this.hits.find((h) => h.kind === 'failed');
    const said = fh ? `${this.cam.key}|${fh.id}` : '';
    if (fh && said !== this.said) { this.said = said; console.log(`flow: newest failed crate ${fh.id} at ${Math.round(fh.x + fh.w / 2)},${Math.round(fh.y + fh.h / 2)}`); }
    this.stats = { failed: failed.length, running: S.engines.running, waiting: S.intake.waiting, red: S.mains.red.length, apps: S.apps.total, machines: S.engines.machines.length, ops: g.ops };
    return !a.reduced;
  }

  /** What is under (x, y) (CSS px of the canvas): the topmost hit. */
  pick(x: number, y: number): Hit | null {
    for (let i = this.hits.length - 1; i >= 0; i--) {
      const h = this.hits[i];
      if (x >= h.x && x <= h.x + h.w && y >= h.y && y <= h.y + h.h) return h;
    }
    return null;
  }
}
