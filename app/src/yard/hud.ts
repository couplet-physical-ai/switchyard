// The developer HUD (⌘⇧D): what the renderer is doing, drawn on the live canvas. Its two
// buttons (stress 10×, pin quality) are canvas hit regions the press handler reads.

import type { Budget } from './budget.ts';
import { QUALITY_NAMES } from './budget.ts';
import type { Gfx } from './gfx.ts';
import type { Rect } from './layout.ts';
import { C } from './theme.ts';

export type HudInfo = {
  budget: Budget; hist: readonly number[]; live: number; real: number; pooled: number; trains: number;
  infoDraws: number; stress: boolean; host: string; scale: number; sceneW: number; sceneH: number;
};

export class Hud {
  on = false;
  /** Hit regions of the HUD's buttons (empty when hidden). */
  stressBtn: Rect = { x: -1, y: -1, w: 0, h: 0 };
  qualityBtn: Rect = { x: -1, y: -1, w: 0, h: 0 };

  draw(g: Gfx, W: number, H: number, i: HudInfo): void {
    if (!this.on) { this.stressBtn.w = 0; this.qualityBtn.w = 0; return; }
    const b = i.budget;
    const s = b.stats();
    const w = 330, h = 132, x = W - w - 12, y = H - h - 12;
    g.begin_(); g.rrect(x, y, w, h, 6); g.fill('rgba(10,10,10,0.92)'); g.stroke(C.edge, 1);
    const px = 11, lx = x + 10;
    let ly = y + 18;
    const over = s.drawP95 > 6;
    g.runs([['fps ', C.ink3], [s.fps.toFixed(1), s.fps < 55 ? C.redText : C.green], ['  frame ', C.ink3], [`${s.frameAvg.toFixed(1)} avg · ${s.frameP95.toFixed(1)} p95 ms`, C.ink2]], lx, ly, px);
    ly += 16;
    g.runs([['draw ', C.ink3], [`~${s.drawAvg.toFixed(2)} avg · ${s.drawP95.toFixed(2)} p95 ms`, over ? C.redText : C.ink2], [`  ${b.ops} ops · ${b.texts} txt`, C.ink3]], lx, ly, px);
    ly += 16;
    g.runs([['quality ', C.ink3], [`${b.quality} ${QUALITY_NAMES[b.quality]}`, b.quality ? C.amberText : C.green], [b.pinned >= 0 ? '  pinned' : '  auto', C.ink3], [`  gain ${b.gain.toFixed(2)} · ${b.host}`, C.ink3]], lx, ly, px);
    ly += 16;
    g.runs([['lod ', C.ink3], [`0:${i.hist[0]}  1:${i.hist[1]}  2:${i.hist[2]}  3:${i.hist[3]}`, C.ink2]], lx, ly, px);
    ly += 16;
    g.runs([['packets ', C.ink3], [`live ${i.live} (${i.real} real) · pooled ${i.pooled} · trains ${i.trains}`, C.ink2]], lx, ly, px);
    ly += 16;
    g.runs([['scene ', C.ink3], [`${Math.round(i.sceneW)}×${Math.round(i.sceneH)} @${i.scale.toFixed(2)} · info ${i.infoDraws}/s · sim 60 Hz fixed`, C.ink3]], lx, ly, px);
    ly += 12;
    // buttons
    const by = y + h - 22;
    const sw = g.width('stress 10× on', px) + 14;
    this.stressBtn = { x: lx, y: by, w: sw, h: 16 };
    g.begin_(); g.rrect(lx, by, sw, 16, 4); if (i.stress) g.fill(C.redFill); g.stroke(i.stress ? C.redEdge : C.chipEdge, 1);
    g.text(i.stress ? 'stress 10× on' : 'stress 10× off', lx + 7, by + 12, i.stress ? C.redText : C.ink2, px);
    const qx = lx + sw + 8;
    const qs = b.pinned >= 0 ? `quality ${b.pinned} pinned` : 'quality auto';
    const qw = g.width(qs, px) + 14;
    this.qualityBtn = { x: qx, y: by, w: qw, h: 16 };
    g.begin_(); g.rrect(qx, by, qw, 16, 4); g.stroke(C.chipEdge, 1);
    g.text(qs, qx + 7, by + 12, C.ink2, px);
    g.text('⌘⇧D', x + w - 10, by + 12, C.ink3, px, false, 'right');
  }
}
