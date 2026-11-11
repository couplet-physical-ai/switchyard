// The Factory (ZERO.md "FACTORY REDO"): the whole fleet as one flow of work, the "square swarm"
// (swarm.ts), on a fixed camera fitted to the window (no pan, no zoom, no scroll), one canvas.
// The model is stages.ts; a press picks (`pick`), and the inspector (inspect.ts, an HTML panel
// beside the floor) shows what was picked. The floor refits whenever the window changes, and
// leaves room on the right while the inspector is open.

import type { Ctx2D, Frame } from '../../app.contract.d.ts';
import type { World } from '../world.ts';
import { Gfx } from '../yard/gfx.ts';
import { C } from '../yard/theme.ts';
import { D, WINDOWS, drawSwarmFloor, type Hit } from './swarm.ts';
import { failedIn, stagesOf } from './stages.ts';

/** the inspector panel beside the floor: 420 wide + its 18 px padding each side + its 1 px rule */
export const INSPECTOR_W = 458;
export const windowMs = (w: string): number => (WINDOWS.find(([k]) => k === w) ?? WINDOWS[1])[1];

export type FloorArgs = { win: string; sel: string; mode: string; reduced: boolean };

export class FlowFloor {
  private g = new Gfx();
  /** the fit: design units → CSS px (x·s + ox, y·s + oy) */
  fitS = 1; fitX = 0; fitY = 0;
  private hits: Hit[] = [];
  private t0 = -1;
  private said = '';
  /** For the HUD and the tests: what the last frame drew. */
  stats = { failed: 0, running: 0, waiting: 0, red: 0, apps: 0, machines: 0, ops: 0, cubes: 0 };

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
    // the camera: the design box fitted into the window under the headline (and left of the
    // inspector), centred; it never pans or zooms by hand
    const aw = W - right - 24, ah = H - headTop - 40;
    const sc = Math.max(0.2, Math.min(aw / (D.x1 - D.x0), ah / (D.y1 - D.y0)));
    this.fitS = sc;
    this.fitX = 12 + (aw - (D.x1 - D.x0) * sc) / 2 - D.x0 * sc;
    this.fitY = headTop + Math.max(0, (ah - (D.y1 - D.y0) * sc) / 2) - D.y0 * sc;
    const t = a.reduced ? 0 : f.time - this.t0;
    ctx.save();
    ctx.beginPath(); ctx.rect(0, headTop + 4, W - right, H - headTop - 4); ctx.clip();
    ctx.translate(this.fitX, this.fitY);
    ctx.scale(sc, sc);
    const r = drawSwarmFloor(g, S, now, { t, now, window: a.win, selected: a.sel, failed });
    ctx.restore();
    this.hits = r.hits.map((h) => ({ ...h, x: h.x * sc + this.fitX, y: h.y * sc + this.fitY, w: h.w * sc, h: h.h * sc }));
    // for the tests (as the old floor did): where the bin's newest crate is, once per layout
    const fh = this.hits.find((h) => h.kind === 'failed');
    const said = fh ? `${W}x${H}:${right}|${fh.id}` : '';
    if (fh && said !== this.said) { this.said = said; console.log(`flow: newest failed crate ${fh.id} at ${Math.round(fh.x + fh.w / 2)},${Math.round(fh.y + fh.h / 2)}`); }
    this.stats = { failed: failed.length, running: S.engines.running, waiting: S.intake.waiting, red: S.mains.red.length, apps: S.apps.total, machines: S.engines.machines.length, ops: g.ops, cubes: r.cubes };
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
