// The Fleet view's load panel: a row per engine, a sparkline per measure (slots busy, and
// cpu %, mem %, load1 where engines report them) from the rolling history (enginehist.ts),
// newest right, with the current value. One canvas, a few dozen ops a row; redrawn when a sample lands.

import type { Ctx2D, Frame } from '../app.contract.d.ts';
import { EngineHistory, SAMPLES, type Series } from './enginehist.ts';
import { LOAD_ROW, loadOrder } from './project.ts';
import type { World } from './world.ts';
import { GHA } from './yard/layout.ts';
import { C, font } from './yard/theme.ts';

const HEAD = 22;

export function drawFleetLoad(ctx: Ctx2D, frame: Frame, w: World, hist: EngineHistory): boolean {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.letterSpacing = '0px';
  ctx.setLineDash([]);
  const W = frame.width, H = frame.height;
  ctx.clearRect(0, 0, W, H);
  if (W <= 0 || H <= 0) return false;
  const rows = loadOrder(w);
  ctx.font = font(11);
  const adv = ctx.measureText('0000000000').width / 10 || 6.6;
  // Columns: slots busy always; cpu, mem and load1 only when some engine reports them.
  let hasCpu = false, hasMem = false, hasLoad = false;
  for (const e of rows) { if (e.cpu != null) hasCpu = true; if (e.mem != null) hasMem = true; if (e.load != null) hasLoad = true; }
  const cols: Col[] = ['busy'];
  if (hasCpu) cols.push('cpu');
  if (hasMem) cols.push('mem');
  if (hasLoad) cols.push('load');
  // A row is two lines: the engine's name, then a sparkline and its value per column, across
  // the whole width (a name column would leave four sparklines 20 px each).
  const colW = W / cols.length;
  const valW = adv * 5;
  const sparkW = Math.max(20, colW - valW - 14);
  ctx.font = font(10);
  ctx.textAlign = 'left';
  ctx.fillStyle = C.ink3;
  for (let c = 0; c < cols.length; c++) ctx.fillText(HEADS[cols[c]], c * colW, 11);
  ctx.strokeStyle = C.rule;
  ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(0, HEAD - 6.5); ctx.lineTo(W, HEAD - 6.5); ctx.stroke();
  for (let i = 0; i < rows.length; i++) {
    const e = rows[i];
    const y = HEAD + i * LOAD_ROW;
    if (y > H) break;
    const mid = y + 22;
    ctx.font = font(11);
    ctx.fillStyle = e.online === false ? C.ink3 : C.ink2;
    ctx.textAlign = 'left';
    ctx.fillText(fitName(e.id === GHA ? 'github actions' : String(e.id), W, adv), 0, y + 10);
    const s = hist.series.get(e.id);
    for (let c = 0; c < cols.length; c++) {
      const col = cols[c];
      const x0 = c * colW;
      const slots = Math.max(1, e.slots || 1);
      const nRun = Math.min(slots, Array.isArray(e.running) ? e.running.length : e.busy || 0);
      const cur = col === 'busy' ? (nRun / slots) * 100 : col === 'cpu' ? e.cpu : col === 'mem' ? e.mem : e.load;
      const val = typeof cur === 'number' && Number.isFinite(cur) ? (col === 'cpu' || col === 'mem' ? Math.round(cur <= 1 ? cur * 100 : cur) : cur) : NaN;
      const hot = col === 'busy' ? nRun >= slots : col !== 'load' && val >= 85;
      ctx.strokeStyle = C.wire;
      ctx.beginPath(); ctx.moveTo(x0, mid + 6.5); ctx.lineTo(x0 + sparkW, mid + 6.5); ctx.stroke();
      const arr = s ? (col === 'busy' ? s.busy : col === 'cpu' ? s.cpu : col === 'mem' ? s.mem : s.load) : null;
      if (s && arr && s.n > 0) spark(ctx, s, arr, col === 'load' ? Math.max(2, maxOf(s, s.load) * 1.15) : 100, x0, mid + 6, sparkW, 13, hot, col === 'busy');
      ctx.font = font(11);
      ctx.textAlign = 'left';
      ctx.fillStyle = hot ? C.amberText : C.ink3;
      const txt = col === 'busy' ? `${nRun}/${slots}` : Number.isNaN(val) ? '–' : col === 'load' ? val.toFixed(1) : `${val}%`;
      ctx.fillText(txt, x0 + sparkW + 6, mid + 4);
    }
  }
  return false;
}

type Col = 'busy' | 'cpu' | 'mem' | 'load';
const HEADS: Record<Col, string> = { busy: 'slots busy', cpu: 'cpu', mem: 'mem', load: 'load1' };

function maxOf(s: Series, a: Float32Array): number {
  let m = 0;
  for (let i = 0; i < s.n; i++) { const v = EngineHistory.at(s, a, i); if (v > m) m = v; }
  return m;
}

/** A sparkline: SAMPLES slots across `w`, newest at the right edge; the area faint, the line
 *  amber-text where the value is hot. */
function spark(ctx: Ctx2D, s: Series, a: Float32Array, max: number, x0: number, yBase: number, w: number, h: number, hot: boolean, steps = false): void {
  const dx = w / (SAMPLES - 1);
  const start = SAMPLES - s.n;
  ctx.beginPath();
  let pen = false, firstX = 0, lastX = 0, prevY = 0;
  for (let i = 0; i < s.n; i++) {
    const v = EngineHistory.at(s, a, i);
    if (!Number.isFinite(v)) { pen = false; continue; }
    const x = x0 + (start + i) * dx, y = yBase - Math.min(1, Math.max(0, v / max)) * h;
    if (!pen) { ctx.moveTo(x, y); pen = true; if (!firstX) firstX = x; } else if (steps) { ctx.lineTo(x, prevY); ctx.lineTo(x, y); } else ctx.lineTo(x, y);
    prevY = y;
    lastX = x;
  }
  ctx.strokeStyle = hot ? C.amberText : C.ink2;
  ctx.lineWidth = 1;
  ctx.stroke();
  // the newest sample, a dot
  if (lastX) {
    const v = EngineHistory.at(s, a, s.n - 1);
    if (Number.isFinite(v)) {
      ctx.beginPath();
      ctx.arc(lastX, yBase - Math.min(1, Math.max(0, v / max)) * h, 1.6, 0, Math.PI * 2);
      ctx.fillStyle = hot ? C.packet : C.ink;
      ctx.fill();
    }
  }
  void firstX;
}

function fitName(s: string, maxW: number, adv: number): string {
  const n = Math.floor(maxW / adv);
  return s.length <= n ? s : `${s.slice(0, Math.max(1, n - 1))}…`;
}
