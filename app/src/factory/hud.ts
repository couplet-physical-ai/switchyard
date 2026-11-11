// The factory floor's developer HUD (⌘⇧D, or `hud` in the status line): what the renderer is
// doing, drawn on the live canvas. Its three buttons (stress 10×, pin quality, and the static
// floor's dirty tiles on or off: fab-w7c, floorcache.ts) are ordinary floor hits (kinds `stress`,
// `quality` and `tiles`) that app.ts's `facPointer` acts on.

import type { Budget } from '../yard/budget.ts';
import { QUALITY_NAMES } from '../yard/budget.ts';
import type { Gfx } from '../yard/gfx.ts';
import { C } from '../yard/theme.ts';

export type FacHudInfo = {
  stress: boolean; lod: string; hist: readonly number[];
  crates: number; stressCrates: number; sprites: number; trains: number; cars: number; bays: number;
  labels: number; hits: number; floorRate: number; floorMs: number; floorOps: number; slept: number;
  scale: number; W: number; H: number;
  /** fab-w7c: the static floor repaints by dirty tiles ('on'), sends every data repaint whole
   *  ('whole'), or is painted directly as before the cache ('off') */
  tiles: 'on' | 'whole' | 'off';
};
type Rect = { x: number; y: number; w: number; h: number };

export class FacHud {
  draw(g: Gfx, x: number, y: number, b: Budget, i: FacHudInfo): { stress: Rect; quality: Rect; tiles: Rect } {
    const s = b.stats();
    const px = 12, lh = 16;
    const lines: [string, string][][] = [
      [['fps ', C.ink3], [s.fps.toFixed(1), s.fps < 55 ? C.redText : C.green], ['  frame ', C.ink3], [`${s.frameAvg.toFixed(1)} avg · ${s.frameP95.toFixed(1)} p95 ms`, C.ink2]],
      [['draw ', C.ink3], [`~${s.drawAvg.toFixed(2)} avg · ${s.drawP95.toFixed(2)} p95 ms`, s.drawP95 > 6 ? C.redText : C.ink2], [`  ${b.ops} ops · ${b.texts} txt`, C.ink3]],
      [['quality ', C.ink3], [`${b.quality} ${QUALITY_NAMES[b.quality]}`, b.quality ? C.amberText : C.green], [b.pinned >= 0 ? '  pinned' : '  auto', C.ink3], [`  gain ${b.gain.toFixed(2)} · ${b.host}`, C.ink3]],
      [['lod ', C.ink3], [i.lod, C.ink2], [`  city 0:${i.hist[0]} 1:${i.hist[1]} 2:${i.hist[2]} culled ${i.hist[3]}`, C.ink3]],
      [['crates ', C.ink3], [`${i.crates} real${i.stress ? ` + ${i.stressCrates} stress` : ''}`, C.ink2], [` → ${i.sprites} drawn · ${i.trains} trains`, C.ink3]],
      [['floor ', C.ink3], [`cars ${i.cars} · bays ${i.bays} · labels ${i.labels} · hits ${i.hits}`, C.ink2]],
      [['static ', C.ink3], [`${i.floorRate}/s redraws · ~${i.floorMs.toFixed(1)} ms · ${i.floorOps} ops`, i.floorRate > 10 ? C.amberText : C.ink2], [`  slept ${i.slept}`, C.ink3]],
      [['scene ', C.ink3], [`${Math.round(i.W)}×${Math.round(i.H)} @${i.scale.toFixed(2)}`, C.ink3]],
    ];
    const w = 344, h = lines.length * lh + 34;
    g.begin_(); g.rrect(x, y, w, h, 6); g.fill('rgba(10,10,10,0.92)'); g.stroke(C.edge, 1);
    let ly = y + 18;
    for (const l of lines) { g.runs(l, x + 10, ly, px, w - 20); ly += lh; }
    const by = y + h - 22;
    const sw = g.width('stress 10× off', px) + 14;
    const stress = { x: x + 10, y: by, w: sw, h: 16 };
    g.begin_(); g.rrect(stress.x, by, sw, 16, 4); if (i.stress) g.fill(C.redFill); g.stroke(i.stress ? C.redEdge : C.chipEdge, 1);
    g.text(i.stress ? 'stress 10× on' : 'stress 10× off', stress.x + 7, by + 12, i.stress ? C.redText : C.ink2, px);
    const qs = b.pinned >= 0 ? `quality ${b.pinned} pinned` : 'quality auto';
    const qw = g.width(qs, px) + 14;
    const quality = { x: stress.x + sw + 8, y: by, w: qw, h: 16 };
    g.begin_(); g.rrect(quality.x, by, qw, 16, 4); g.stroke(C.chipEdge, 1);
    g.text(qs, quality.x + 7, by + 12, C.ink2, px);
    const ts = `tiles ${i.tiles}`, tw = g.width('tiles whole', px) + 14, on = i.tiles === 'on';
    const tiles = { x: quality.x + qw + 8, y: by, w: tw, h: 16 };
    g.begin_(); g.rrect(tiles.x, by, tw, 16, 4); g.stroke(on ? C.chipEdge : C.redEdge, 1);
    g.text(ts, tiles.x + 7, by + 12, on ? C.ink2 : C.redText, px);
    if (tiles.x + tw + 8 + g.width('⌘⇧D', px) <= x + w - 10) g.text('⌘⇧D', x + w - 10, by + 12, C.ink3, px, false, 'right');
    return { stress, quality, tiles };
  }
}
