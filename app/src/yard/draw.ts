// The yard's two layers. `drawStatic` paints what only a resize or a layout change moves
// (wires, machines, titles); `drawLive` paints every frame: packets, rings, dots, numbers.

import type { Ctx2D } from '../../app.contract.d.ts';
import type { Pipeline, Repo, Step } from '../wire.ts';
import type { World } from '../world.ts';
import type { Timeline } from '../timeline.ts';
import { type Layout, type Pt, BOTS, isRed, wire } from './layout.ts';
import { type Motion, slotPoint } from './motion.ts';
import { arrow, chip, dotLine, eyebrow, fmtClock, fmtDur, machine, port, runs, text, withAlpha } from './paint.ts';
import { C, TAU, clamp, easeOut, font } from './theme.ts';

export type Hit = { x: number; y: number; w: number; h: number; kind: string; id: string; label: string };

function bez(ctx: Ctx2D, a: Pt, b: Pt): void {
  const c = wire(a, b);
  ctx.moveTo(c[0].x, c[0].y);
  ctx.bezierCurveTo(c[1].x, c[1].y, c[2].x, c[2].y, c[3].x, c[3].y);
}

function drainX(L: Layout): number {
  return L.cols.engines + (L.engines[0]?.w ?? 200) + 16;
}

export function drawStatic(ctx: Ctx2D, L: Layout): void {
  ctx.clearRect(0, 0, L.W, L.H);
  ctx.lineCap = 'round';
  // band rules
  ctx.beginPath();
  for (const y of [L.now.y0, L.queue.y0]) if (y < L.H - 2) { ctx.moveTo(L.m, y + 0.5); ctx.lineTo(L.W - L.m, y + 0.5); }
  ctx.strokeStyle = C.rule;
  ctx.lineWidth = 1;
  ctx.stroke();

  // wires
  ctx.beginPath();
  for (const s of L.sources) bez(ctx, s.port, L.junction);
  bez(ctx, L.junction, L.intake.roadrunner.inPort);
  bez(ctx, L.junction, L.intake.gha.inPort);
  for (const e of L.engines) {
    bez(ctx, e.kind === 'gha_runner' ? L.intake.gha.outPort : L.intake.roadrunner.outPort, e.inPort);
    bez(ctx, e.outPort, L.gate.inPort);
  }
  // gate → bus → main lines; bus → deploy → apps
  ctx.moveTo(L.gate.outPort.x, L.gate.outPort.y);
  ctx.lineTo(L.bus.x, L.gate.outPort.y);
  ctx.moveTo(L.bus.x, Math.min(L.bus.y0, L.gate.outPort.y));
  ctx.lineTo(L.bus.x, L.ret.y);
  for (const l of L.mains) { ctx.moveTo(L.bus.x, l.y); ctx.lineTo(l.x0, l.y); }
  ctx.moveTo(L.bus.x, L.agg.y); ctx.lineTo(L.agg.x0, L.agg.y);
  ctx.moveTo(L.deploy.outPort.x, L.deploy.outPort.y); ctx.lineTo(L.bus.x, L.deploy.outPort.y);
  ctx.moveTo(L.bus.x, L.appsBox.y + L.appsBox.h / 2); ctx.lineTo(L.appsBox.x - 6, L.appsBox.y + L.appsBox.h / 2);
  // gate → review
  ctx.moveTo(L.gate.x + L.gate.w / 2, L.gate.y + L.gate.h);
  ctx.lineTo(L.review.x + L.review.w / 2, L.review.y);
  // return wire: drain beside the engines, the long run home, up to the sources
  const dx = drainX(L);
  ctx.moveTo(dx, (L.engines[0]?.outPort.y ?? L.gate.y));
  ctx.lineTo(dx, L.ret.y - 10);
  ctx.arcTo(dx, L.ret.y, dx - 10, L.ret.y, 10);
  ctx.moveTo(L.bus.x, L.ret.y - 10);
  ctx.arcTo(L.bus.x, L.ret.y, L.bus.x - 10, L.ret.y, 10);
  ctx.lineTo(L.ret.x0 + 10, L.ret.y);
  ctx.arcTo(L.ret.x0, L.ret.y, L.ret.x0, L.ret.y - 10, 10);
  ctx.lineTo(L.ret.x0, L.sources[0].y + 10);
  ctx.arcTo(L.ret.x0, L.sources[0].y, L.ret.x0 + 10, L.sources[0].y, 10);
  for (const e of L.engines) { ctx.moveTo(e.outPort.x, e.outPort.y); ctx.lineTo(dx, e.outPort.y); }
  ctx.strokeStyle = C.wire;
  ctx.lineWidth = 1;
  ctx.stroke();
  text(ctx, 'failures go back to whoever pushed them', (L.ret.x0 + L.bus.x) / 2, L.ret.y + 17, C.ink4, 12, false, 'center');

  // column titles
  const ty = L.titleY;
  runs(ctx, [['sources', C.ink, true], [' · pushes', C.ink3]], L.cols.sources, ty);
  runs(ctx, [['intake', C.ink, true]], L.cols.intake, ty);
  runs(ctx, [['engines', C.ink, true], [' · slots', C.ink3]], L.cols.engines, ty);
  runs(ctx, [['gates', C.ink, true]], L.cols.gates, ty);
  runs(ctx, [['main lines', C.ink, true], [' · newest right', C.ink3]], L.cols.mains, ty);

  // machines
  for (const m of [L.intake.roadrunner, L.intake.gha]) {
    machine(ctx, m.x, m.y, m.w, m.h, 12);
    port(ctx, m.inPort.x, m.inPort.y);
    port(ctx, m.outPort.x, m.outPort.y);
    text(ctx, m.title, m.x + m.w / 2, m.y + m.h + 16, C.ink2, 12, false, 'center');
  }
  for (const e of L.engines) {
    machine(ctx, e.x, e.y, e.w, e.h, 10);
    port(ctx, e.inPort.x, e.inPort.y);
    port(ctx, e.outPort.x, e.outPort.y);
    text(ctx, e.title, e.x, e.y - 7, C.ink2, 12);
    ctx.beginPath();
    for (const s of e.slots) { ctx.moveTo(s.x + s.r, s.y); ctx.arc(s.x, s.y, s.r, 0, TAU); }
    ctx.strokeStyle = C.machineDim;
    ctx.lineWidth = 1.2;
    ctx.stroke();
  }
  // gates: the integrator's clamp
  {
    const g = L.gate;
    machine(ctx, g.x, g.y, g.w, g.h, 12);
    port(ctx, g.inPort.x, g.inPort.y);
    port(ctx, g.outPort.x, g.outPort.y);
    const cx = g.x + g.w / 2, cy = g.y + g.h / 2;
    ctx.beginPath();
    ctx.moveTo(cx, g.y + 10); ctx.lineTo(cx, g.y + g.h - 10);
    ctx.strokeStyle = C.machine; ctx.lineWidth = 2; ctx.stroke();
    for (const yy of [g.y + 6, g.y + g.h - 6]) {
      ctx.beginPath(); ctx.roundRect(cx - 22, yy - 2, 44, 4, 2); ctx.fillStyle = '#3A3A3C'; ctx.fill();
    }
    text(ctx, 'required checks', g.x + g.w / 2, g.y + g.h + 16, C.ink3, 12, false, 'center');
  }
  {
    const r = L.review;
    machine(ctx, r.x, r.y, r.w, r.h, 12);
    ctx.beginPath(); ctx.roundRect(r.x + r.w / 2 - 14, r.y - 3, 28, 6, 2.5); ctx.fillStyle = C.port; ctx.fill(); ctx.strokeStyle = C.portEdge; ctx.lineWidth = 1.2; ctx.stroke();
    ctx.beginPath(); ctx.arc(r.x + r.w / 2, r.y + r.h / 2, 12, 0, TAU); ctx.strokeStyle = C.machineDim; ctx.lineWidth = 1.2; ctx.stroke();
    text(ctx, 'review · pull requests', r.x + r.w / 2, r.y + r.h + 16, C.ink3, 12, false, 'center');
  }
  {
    const d = L.deploy;
    machine(ctx, d.x, d.y, d.w, d.h, 12);
    port(ctx, d.outPort.x, d.outPort.y);
    ctx.beginPath(); ctx.moveTo(d.x + 18, d.y + d.h / 2); ctx.lineTo(d.x + d.w - 22, d.y + d.h / 2); ctx.strokeStyle = C.machine; ctx.lineWidth = 2; ctx.stroke();
    runs(ctx, [['deploy', C.ink, true], [' · provisioning', C.ink3]], d.x, d.y - 9, 13);
  }
  // dial frame
  ctx.beginPath(); ctx.arc(L.dial.x, L.dial.y, L.dial.r, 0, TAU); ctx.strokeStyle = C.ink2; ctx.lineWidth = 1.5; ctx.stroke();
}

type Focus = { pipeline: string; since: number };

export class LiveLayer {
  hits: Hit[] = [];
  private focus: Focus = { pipeline: '', since: 0 };
  selected = '';
  hover = '';
  offsetMin = 0;

  draw(ctx: Ctx2D, L: Layout, tl: Timeline, mo: Motion, t: number, reduced: boolean): void {
    const w = tl.shown;
    const now = tl.playhead;
    ctx.clearRect(0, 0, L.W, L.H);
    ctx.lineCap = 'round';
    this.hits = [];
    this.header(ctx, L, tl, w, t, reduced);
    this.sources(ctx, L, w, now);
    this.intake(ctx, L, w, now);
    this.engines(ctx, L, w, now, t, reduced);
    this.mains(ctx, L, w, now, t);
    this.apps(ctx, L, w);
    this.lower(ctx, L, w);
    this.effects(ctx, mo, t);
    this.packets(ctx, mo, t);
    if (L.now.y1 > L.now.y0) this.nowBand(ctx, L, w, now, t);
    if (L.queue.y1 > L.queue.y0) this.queueBand(ctx, L, w, now);
  }

  private header(ctx: Ctx2D, L: Layout, tl: Timeline, w: World, t: number, reduced: boolean): void {
    const y = 38;
    const mode = tl.mode;
    const tag: [string, string] = mode === 'live' ? ['live', C.green] : mode === 'paused' ? ['paused', C.packet] : mode === 'replay' ? ['replay', C.packet] : ['behind', C.amberText];
    const parts: [string, string][] = [tag, [' · ', C.ink4]];
    if (mode === 'live') parts.push([`all orgs · ${w.repos.size} repos`, C.ink3]);
    else if (mode === 'replay') parts.push([`${fmtClock(tl.replayFrom, this.offsetMin)} → ${fmtClock(tl.replayTo, this.offsetMin)} · at ${fmtClock(tl.playhead, this.offsetMin)} · 60×`, C.ink3]);
    else parts.push([`${fmtDur(tl.behindMs())} behind live${mode === 'behind' ? ` · ${tl.speed === 1 ? '1×' : '¼×'}` : ''}`, C.ink3]);
    eyebrow(ctx, parts, L.m, y);
    // the dial: "1 hour, sped up"
    const d = L.dial;
    text(ctx, mode === 'replay' ? `${Math.round(tl.replayProgress() * 60)} of 60 min` : '1 hour, sped up', d.x - d.r - 12, d.y + 4, mode === 'replay' ? C.amberText : C.ink3, 13, false, 'right');
    const ang = mode === 'replay' ? -Math.PI / 2 + tl.replayProgress() * TAU : reduced ? -Math.PI / 4 : -Math.PI / 2 + ((t / 60000) % 1) * TAU;
    ctx.beginPath(); ctx.moveTo(d.x, d.y); ctx.lineTo(d.x + Math.cos(ang) * (d.r - 4), d.y + Math.sin(ang) * (d.r - 4));
    ctx.strokeStyle = mode === 'replay' ? C.packet : C.ink; ctx.lineWidth = 1.8; ctx.stroke();
    if (mode === 'replay') {
      ctx.beginPath(); ctx.arc(d.x, d.y, d.r + 3, -Math.PI / 2, -Math.PI / 2 + tl.replayProgress() * TAU); ctx.strokeStyle = withAlpha(C.packet, 0.7); ctx.lineWidth = 1.5; ctx.stroke();
    }
    ctx.font = font(13);
    const tw = ctx.measureText('1 hour, sped up').width;
    this.hits.push({ x: d.x - d.r - 16 - tw, y: d.y - 14, w: tw + d.r * 2 + 20, h: 28, kind: 'replay', id: 'replay', label: 'Replay the last hour, sped up' });
  }

  private sources(ctx: Ctx2D, L: Layout, w: World, now: number): void {
    for (const s of L.sources) {
      const n10 = w.pushesSince(s.org, now - 600_000);
      const rate = w.rate(s.org, now);
      // the source glyph: a document with one line per recent push (a robot for bots)
      const gx = s.x, gy = s.y - 9;
      ctx.beginPath(); ctx.roundRect(gx, gy, 24, 18, 3); ctx.strokeStyle = n10 ? C.ink2 : C.machineDim; ctx.lineWidth = 1.3; ctx.stroke();
      if (s.bot) {
        ctx.beginPath(); ctx.arc(gx + 8.5, gy + 9, 1.8, 0, TAU); ctx.arc(gx + 15.5, gy + 9, 1.8, 0, TAU); ctx.fillStyle = n10 ? C.ink : C.ink4; ctx.fill();
        ctx.beginPath(); ctx.moveTo(gx + 12, gy); ctx.lineTo(gx + 12, gy - 4); ctx.strokeStyle = n10 ? C.ink2 : C.machineDim; ctx.stroke();
      } else {
        ctx.beginPath();
        const lines = Math.min(3, n10);
        for (let i = 0; i < lines; i++) { ctx.moveTo(gx + 5, gy + 5 + i * 4); ctx.lineTo(gx + 19 - (i % 2) * 5, gy + 5 + i * 4); }
        ctx.strokeStyle = C.ink2; ctx.lineWidth = 1.3; ctx.stroke();
      }
      const lx = runs(ctx, [[s.label, n10 ? C.ink2 : C.ink3]], gx + 34, s.y + 4.5, 13);
      text(ctx, `${rate}/h`, s.port.x - 8, s.y + 4.5, C.ink4, 11, false, 'right');
      void lx;
      this.hits.push({ x: gx - 4, y: s.y - 14, w: s.port.x - gx + 8, h: 28, kind: 'org', id: s.org, label: s.bot ? 'Bots' : s.org });
    }
  }

  private intake(ctx: Ctx2D, L: Layout, w: World, now: number): void {
    for (const id of ['roadrunner', 'gha'] as const) {
      const m = L.intake[id];
      const q = w.queues.get(id);
      const pend = q?.pending ?? 0;
      const visible = Math.max(1, Math.floor((m.h - 20) / 13));
      if (pend > visible) text(ctx, `+${pend - visible}`, m.x + m.w / 2, m.y + 15, C.amberText, 11, false, 'center');
      const sub = pend ? `${pend} waiting · ${fmtDur(q?.oldest_wait_ms ?? 0)}` : 'nothing waiting';
      text(ctx, sub, m.x + m.w / 2, m.y + m.h + 31, pend ? C.amberText : C.ink4, 11, false, 'center');
      this.hits.push({ x: m.x - 6, y: m.y - 6, w: m.w + 12, h: m.h + 40, kind: 'queue', id, label: `${id} queue` });
    }
    void now;
    if (w.watcher.tripped) text(ctx, `github ${w.watcher.gh_status}`, L.intake.gha.x + L.intake.gha.w / 2, L.intake.gha.y - 8, C.redText, 11, false, 'center');
  }

  private engines(ctx: Ctx2D, L: Layout, w: World, now: number, t: number, reduced: boolean): void {
    const ringOk: number[] = [], ringRun: [number, number, number, number][] = [];
    for (const box of L.engines) {
      let busy = 0, slots = 0, cpu = 0, ncpu = 0;
      for (const id of box.engines) {
        const e = w.engines.get(id);
        if (!e) continue;
        busy += e.running.length; slots += e.slots;
        if (e.cpu != null) { cpu += e.cpu; ncpu++; }
      }
      const load = ncpu ? ` · cpu ${Math.round((cpu / ncpu) * (cpu / ncpu <= 1 ? 100 : 1))}%` : '';
      text(ctx, `${busy}/${slots}${load}`, box.x + box.w, box.y - 7, busy ? C.amberText : C.ink4, 11, false, 'right');
      this.hits.push({ x: box.x - 4, y: box.y - 20, w: box.w + 8, h: box.h + 24, kind: 'engine', id: box.id, label: box.title });
      for (const id of box.engines) {
        const e = w.engines.get(id);
        if (!e) continue;
        const slotsOf = L.slotByEngine.get(id) ?? [];
        e.running.forEach((pid, i) => {
          const s = slotsOf[Math.min(i, slotsOf.length - 1)];
          if (!s) return;
          const p = w.pipelines.get(pid);
          const exp = p?.expected_ms ?? w.repos.get(p?.repo ?? '')?.p50_build_ms ?? 0;
          const el = p?.started ? Math.max(0, now - p.started) : 0;
          if (exp > 0) ringRun.push([s.x, s.y, s.r + 3.5, clamp(el / exp, 0.02, 0.98)]);
          else ringOk.push(s.x, s.y, s.r + 3.5);
          this.hits.push({ x: s.x - s.r - 3, y: s.y - s.r - 3, w: s.r * 2 + 6, h: s.r * 2 + 6, kind: 'pipeline', id: pid, label: p ? `${p.repo} #${p.number}` : pid });
        });
      }
    }
    // progress rings (elapsed over typical), an indeterminate quarter when unknown
    ctx.lineWidth = 2;
    ctx.strokeStyle = C.packet;
    ctx.beginPath();
    for (const [x, y, r, u] of ringRun) { const a0 = -Math.PI / 2; ctx.moveTo(x + Math.cos(a0) * r, y + Math.sin(a0) * r); ctx.arc(x, y, r, a0, a0 + u * TAU); }
    const spin = reduced ? 0 : ((t / 900) % 1) * TAU;
    for (let i = 0; i < ringOk.length; i += 3) { const [x, y, r] = [ringOk[i], ringOk[i + 1], ringOk[i + 2]]; ctx.moveTo(x + Math.cos(spin) * r, y + Math.sin(spin) * r); ctx.arc(x, y, r, spin, spin + Math.PI / 2); }
    ctx.stroke();
    ctx.beginPath();
    for (const [x, y, r, u] of ringRun) { const a0 = -Math.PI / 2 + u * TAU; ctx.moveTo(x + Math.cos(a0) * r, y + Math.sin(a0) * r); ctx.arc(x, y, r, a0, -Math.PI / 2 + TAU); }
    ctx.strokeStyle = withAlpha(C.packet, 0.16);
    ctx.stroke();
  }

  private mains(ctx: Ctx2D, L: Layout, w: World, now: number, t: number): void {
    for (const l of L.mains) {
      const r = w.repos.get(l.repo);
      if (!r) continue;
      const red = isRed(r);
      const name = r.name;
      const parts: [string, string, boolean?][] = [[name, l.repo === this.selected ? C.packet : C.ink, true]];
      if (red) {
        parts.push([` · red ${fmtDur(now - r.main.since)}`, C.redText]);
        const c = r.main.culprit ? r.main.recent.find((d) => d.sha === r.main.culprit) : undefined;
        if (c) parts.push([` · culprit ${c.sha.slice(0, 7)} by ${c.author.replace(/\[bot\]$/, '')}`, C.ink3]);
      } else if (r.main.state === 'running' || r.main.state === 'pending') parts.push([' · building', C.amberText]);
      else parts.push([' · green', C.ink3]);
      fitRuns(ctx, parts, l.x0, l.y - 13, l.x1 + 22 - l.x0, 12.5);
      dotLine(ctx, r.main.recent ?? [], l.x0, l.x1 - 14, l.y, l.step, t, { red, culprit: red ? r.main.culprit : null, label: false });
      this.hits.push({ x: l.x0 - 4, y: l.y - 26, w: l.x1 - l.x0 + 26, h: 36, kind: 'repo', id: l.repo, label: l.repo });
    }
    // the rest, as one row
    const shown = new Set(L.mains.map((l) => l.repo));
    let rest = 0, red = 0, building = 0;
    for (const r of w.repos.values()) {
      if (shown.has(r.id)) continue;
      rest++;
      if (isRed(r)) red++;
      else if (r.main?.state === 'running') building++;
    }
    const parts: [string, string][] = [[`+${rest} more`, C.ink2]];
    if (red) parts.push([` · ${red} red`, C.redText]);
    if (building) parts.push([` · ${building} building`, C.amberText]);
    parts.push([' · mainlines ›', C.ink4]);
    runs(ctx, parts, L.agg.x0, L.agg.y + 4, 12);
    this.hits.push({ x: L.agg.x0 - 4, y: L.agg.y - 12, w: L.agg.x1 - L.agg.x0, h: 24, kind: 'view', id: 'mainlines', label: 'All main lines' });
  }

  private apps(ctx: Ctx2D, L: Layout, w: World): void {
    let up = 0;
    const down: string[] = [];
    const groups: Record<string, number[]> = { up: [], degraded: [], down: [], unknown: [] };
    for (const c of L.apps) {
      const a = w.apps.get(c.app);
      const h = a?.health ?? 'unknown';
      if (h === 'up') up++;
      else if (h === 'down' || h === 'degraded') down.push(c.app);
      (groups[h] ?? groups.unknown).push(c.x, c.y, c.s);
      this.hits.push({ x: c.x - 2, y: c.y - 2, w: c.s + 4, h: c.s + 4, kind: 'app', id: c.app, label: c.app });
    }
    const fill = (xs: number[], color: string, stroke = false) => {
      if (!xs.length) return;
      ctx.beginPath();
      for (let i = 0; i < xs.length; i += 3) ctx.roundRect(xs[i], xs[i + 1], xs[i + 2], xs[i + 2], 2);
      if (stroke) { ctx.strokeStyle = color; ctx.lineWidth = 1; ctx.stroke(); } else { ctx.fillStyle = color; ctx.fill(); }
    };
    fill(groups.up, '#3B4A40');
    fill(groups.degraded, C.packet);
    fill(groups.down, C.red);
    fill(groups.unknown, C.machineDim, true);
    const total = L.apps.length;
    const parts: [string, string, boolean?][] = [['apps', C.ink, true], [` · ${up} of ${total} up`, C.ink3]];
    if (down.length) parts.push([` · ${down.slice(0, 3).join(', ')}${down.length > 3 ? ` +${down.length - 3}` : ''}`, C.redText]);
    runs(ctx, parts, L.appsBox.x, L.appsBox.y - 9, 12.5);
  }

  private lower(ctx: Ctx2D, L: Layout, w: World): void {
    const s = w.stats;
    text(ctx, `${Math.round((s.success_rate_24h <= 1 ? s.success_rate_24h * 100 : s.success_rate_24h))}% green · 24 h`, L.gate.x + L.gate.w / 2, L.gate.y + L.gate.h + 31, C.ink4, 11, false, 'center');
    let deploying = 0, rr = 0, gha = 0, fb = 0;
    for (const d of w.deploys.values()) {
      if (d.state === 'running' || d.state === 'pending') deploying++;
      if (d.via === 'roadrunner') rr++; else if (d.via === 'gha') gha++; else if (d.via === 'gha_fallback') fb++;
    }
    text(ctx, deploying ? `${deploying} deploying` : `${s.deploys_24h} today`, L.deploy.x + L.deploy.w / 2, L.deploy.y + L.deploy.h + 16, deploying ? C.amberText : C.ink4, 11, false, 'center');
    text(ctx, `rr ${rr} · gha ${gha} · fallback ${fb}`, L.deploy.x + L.deploy.w / 2, L.deploy.y + L.deploy.h + 31, fb ? C.amberText : C.ink4, 11, false, 'center');
    this.hits.push({ x: L.deploy.x - 4, y: L.deploy.y - 22, w: L.deploy.w + 8, h: L.deploy.h + 40, kind: 'view', id: 'fleet', label: 'Deploys and apps' });
    this.hits.push({ x: L.review.x - 4, y: L.review.y - 6, w: L.review.w + 120, h: L.review.h + 12, kind: 'view', id: 'prs', label: 'Pull requests' });
  }

  private effects(ctx: Ctx2D, mo: Motion, t: number): void {
    for (const e of mo.effects) {
      const u = clamp((t - e.t0) / e.dur, 0, 1);
      if (e.k === 'pop') {
        const r = u < 0.6 ? 6.5 * easeOut(u / 0.6) : 6.5 - 2 * ((u - 0.6) / 0.4);
        ctx.beginPath(); ctx.arc(e.x, e.y, r, 0, TAU); ctx.fillStyle = e.color; ctx.fill();
      } else if (e.k === 'pulse') {
        const r = (e.r ?? 10) * (0.6 + u * 1.4);
        ctx.beginPath(); ctx.roundRect(e.x - r / 2, e.y - r / 2, r, r, 3); ctx.strokeStyle = withAlpha(e.color, 1 - u); ctx.lineWidth = 2; ctx.stroke();
      } else if (e.k === 'flash') {
        const r = (e.r ?? 10) + 3 + u * 9;
        ctx.beginPath(); ctx.arc(e.x, e.y, r, 0, TAU); ctx.strokeStyle = withAlpha(e.color, 0.9 * (1 - u)); ctx.lineWidth = 1.5; ctx.stroke();
      } else if (e.k === 'port') {
        ctx.beginPath(); ctx.roundRect(e.x - 1, e.y - 8, 2, 16, 1); ctx.fillStyle = withAlpha(e.color, 1 - u); ctx.fill();
      }
    }
  }

  private packets(ctx: Ctx2D, mo: Motion, t: number): void {
    const groups: Record<string, Packet2[]> = { amber: [], red: [], green: [], gray: [] };
    for (const pk of mo.packets.values()) {
      const a = pk.die ? clamp(1 - (t - pk.die) / 600, 0, 1) : clamp((t - pk.born) / 200, 0, 1);
      groups[pk.tint].push({ x: pk.x, y: pk.y, a, bot: pk.bot, label: t < pk.labelUntil ? pk.label : '', la: clamp((pk.labelUntil - t) / 500, 0, 1), count: pk.count });
    }
    const col: Record<string, string> = { amber: C.packet, red: C.red, green: C.green, gray: C.dotDim };
    for (const k of Object.keys(groups)) {
      const list = groups[k];
      if (!list.length) continue;
      // full-opacity packets in one path; fading ones one by one
      ctx.beginPath();
      for (const p of list) if (p.a >= 1) ctx.roundRect(p.x - 6.5, p.y - 4.5, 13, 9, 2);
      ctx.fillStyle = col[k];
      ctx.fill();
      for (const p of list) if (p.a < 1) { ctx.beginPath(); ctx.roundRect(p.x - 6.5, p.y - 4.5, 13, 9, 2); ctx.fillStyle = withAlpha(col[k], p.a); ctx.fill(); }
    }
    // bot marks and labels
    ctx.beginPath();
    for (const k of Object.keys(groups)) for (const p of groups[k]) if (p.bot) { ctx.moveTo(p.x - 3.5, p.y); ctx.lineTo(p.x + 3.5, p.y); }
    ctx.strokeStyle = 'rgba(0,0,0,0.55)'; ctx.lineWidth = 1.5; ctx.stroke();
    for (const k of Object.keys(groups)) for (const p of groups[k]) {
      if (p.count > 1) text(ctx, `×${p.count}`, p.x + 9, p.y - 6, C.amberText, 10);
      if (p.label) {
        ctx.globalAlpha = p.la * p.a;
        text(ctx, p.label, p.x + 10, p.y + 3.5, C.ink2, 10.5);
        ctx.globalAlpha = 1;
      }
    }
  }

  /** NOW: one pipeline up close, its steps as dashed chips, its repo's main line beside it. */
  private nowBand(ctx: Ctx2D, L: Layout, w: World, now: number, t: number): void {
    const y0 = L.now.y0;
    const p = this.pickFocus(w, now);
    if (!p) {
      eyebrow(ctx, [['now', C.ink3], [' · ', C.ink4], ['nothing building', C.ink4]], L.m, y0 + 30);
      return;
    }
    const r = w.repos.get(p.repo);
    const el = p.started ? now - p.started : 0;
    const where = p.state === 'running' ? `building on ${(p.engine ?? '').toLowerCase()} · ${fmtDur(el)}` : p.state === 'pending' ? `queued ${fmtDur(now - p.created)}` : `${p.state} · ${fmtDur((p.finished ?? now) - (p.started ?? p.created))}`;
    eyebrow(ctx, [['now', C.ink3], [' · ', C.ink4], [`${p.repo.split('/')[1]} #${p.number}`, C.ink2], [` · ${p.branch} · ${where}`, C.ink3]], L.m, y0 + 30);
    this.hits.push({ x: L.m, y: y0 + 12, w: L.W * 0.5, h: 26, kind: 'pipeline', id: p.id ?? "", label: `${p.repo} #${p.number}` });
    // steps: the first workflow's, up to 7
    const wf = p.workflows?.[0];
    const steps: Step[] = (wf?.steps ?? []).slice(0, 7);
    let x = L.m + 150;
    const cy = y0 + 70;
    arrow(ctx, L.m + 60, x - 4, cy);
    text(ctx, wf?.name ?? 'pipeline', L.m, cy + 4, C.ink3, 12);
    let activeX = -1;
    steps.forEach((s, i) => {
      const st = s.state === 'success' ? 'ok' : s.state === 'failure' || s.state === 'error' ? 'bad' : s.state === 'running' ? 'active' : s.state === 'skipped' || s.state === 'canceled' ? 'skip' : 'idle';
      const cw = chip(ctx, s.name + (s.cached ? ' ⟳' : ''), x, cy, st);
      if (s.state === 'running') activeX = x + cw / 2;
      x += cw;
      if (i < steps.length - 1) { arrow(ctx, x + 3, x + 17, cy); x += 20; }
    });
    if (activeX >= 0) {
      const bob = Math.sin(t / 380) * 1.2;
      ctx.beginPath(); ctx.roundRect(activeX - 9, cy - 27 + bob, 18, 11, 2.5); ctx.fillStyle = C.packet; ctx.fill();
    }
    // the sentence under the chips
    const exp = p.expected_ms ?? r?.p50_build_ms ?? 0;
    const done = steps.filter((s) => s.state === 'success').length;
    const line = [`${done} of ${steps.length} steps`, exp ? `typical ${fmtDur(exp)}` : '', p.lane === 'gha' ? 'github actions' : 'roadrunner', p.event === 'pull_request' ? 'pull request' : `push to ${p.branch}`].filter(Boolean).join(' · ');
    text(ctx, line, L.m + 150, cy + 30, C.ink3, 12);
    // other workflows as small chips
    let x2 = L.m + 150 + Math.max(320, x - L.m - 150 + 30);
    const others = (p.workflows ?? []).slice(1, 5);
    if (others.length && x2 < L.cols.mains - 60) {
      text(ctx, 'also', x2, cy + 4, C.ink4, 12);
      x2 += 40;
      for (const o of others) {
        const st = o.state === 'success' ? 'ok' : o.state === 'failure' || o.state === 'error' ? 'bad' : o.state === 'running' ? 'active' : 'idle';
        x2 += chip(ctx, o.name, x2, cy, st) + 8;
      }
    }
    // the repo's main line, its culprit labelled
    if (r) {
      const red = isRed(r);
      const x0 = L.cols.mains, x1 = L.W - L.m - 30;
      runs(ctx, [[r.name, C.ink, true], [red ? ` · red ${fmtDur(now - r.main.since)}` : ' · main', red ? C.redText : C.ink3]], x0, cy - 20, 12.5);
      dotLine(ctx, r.main.recent ?? [], x0, x1, cy, 18, t, { red, culprit: red ? r.main.culprit : null, r: 5 });
      text(ctx, red ? 'red → fix forward; the culprit is named' : 'green · each dot is a commit on main', x0, cy + 30, red ? C.redText : C.ink4, 12);
    }
  }

  private pickFocus(w: World, now: number): Pipeline | null {
    const sel = this.selected ? w.pipelines.get(this.selected) : undefined;
    if (sel) return sel;
    const cur = w.pipelines.get(this.focus.pipeline);
    const fresh = cur && (cur.state === 'running' || now - (cur.finished ?? now) < 4000);
    if (fresh && now - this.focus.since < 9000) return cur!;
    let best: Pipeline | null = null, score = -1;
    for (const p of w.pipelines.values()) {
      if (p.state !== 'running' || p.id === this.focus.pipeline) continue;
      const heat = w.repos.get(p.repo)?.heat ?? 0;
      const s = heat * 10 + (p.workflows?.[0]?.steps?.length ?? 0) - (now - (p.started ?? now)) / 60000;
      if (s > score) { score = s; best = p; }
    }
    if (best) { this.focus = { pipeline: best.id ?? "", since: now }; return best; }
    return cur ?? null;
  }

  /** QUEUE: what runs next, in order. */
  private queueBand(ctx: Ctx2D, L: Layout, w: World, now: number): void {
    const y0 = L.queue.y0;
    const items: Pipeline[] = [];
    for (const id of ['roadrunner', 'gha']) for (const pid of w.queues.get(id)?.items ?? []) { const p = w.pipelines.get(pid); if (p) items.push(p); }
    items.sort((a, b) => a.created - b.created);
    const oldest = items.length ? now - items[0].created : 0;
    eyebrow(ctx, [['queue', C.ink3], [' · in order', C.ink3], [items.length ? ` · ${items.length} waiting · oldest ${fmtDur(oldest)}` : ' · nothing waiting', C.ink4]], L.m, y0 + 30);
    const rows = items.slice(0, 3);
    rows.forEach((p, i) => {
      const y = y0 + 62 + i * 30;
      const repo = p.repo.split('/')[1] ?? p.repo;
      runs(ctx, [[`#${p.number} `, C.ink2], [trim(repo, 20), C.ink3]], L.m, y + 4, 12.5);
      let x = L.m + 250;
      const chips = [`${p.event === 'pull_request' ? 'pr' : 'push'} · ${trim(p.branch, 18)}`, `waiting ${fmtDur(now - p.created)}`, p.lane === 'gha' ? 'gha runner' : 'roadrunner', `~${fmtDur(p.expected_ms ?? w.repos.get(p.repo)?.p50_build_ms ?? 0)} build`];
      chips.forEach((c, j) => {
        x += chip(ctx, c, x, y, j === 1 && now - p.created > 120_000 ? 'bad' : 'idle');
        if (j < chips.length - 1) { arrow(ctx, x + 3, x + 19, y); x += 22; }
      });
      this.hits.push({ x: L.m, y: y - 12, w: x - L.m, h: 24, kind: 'pipeline', id: p.id ?? "", label: `${p.repo} #${p.number}` });
    });
    if (items.length > 3) {
      const x0 = L.cols.mains;
      const n = Math.min(items.length - 3, 18);
      ctx.beginPath();
      for (let i = 0; i < n; i++) ctx.roundRect(x0 + i * 15, y0 + 55, 10, 10, 2);
      ctx.strokeStyle = C.chipEdge; ctx.lineWidth = 1; ctx.stroke();
      text(ctx, `${items.length - 3} more behind these`, x0, y0 + 85, C.ink4, 12);
    }
    if (!items.length) text(ctx, 'every slot can take the next push', L.m, y0 + 64, C.ink4, 12);
  }
}

type Packet2 = { x: number; y: number; a: number; bot: boolean; label: string; la: number; count: number };

/** Runs of text cut to fit `maxW`, the last run losing its tail first. */
function fitRuns(ctx: Ctx2D, parts: [string, string, boolean?][], x: number, y: number, maxW: number, px: number): void {
  let used = 0;
  const out: [string, string, boolean?][] = [];
  for (const [s, c, b] of parts) {
    ctx.font = font(px, !!b);
    const w = ctx.measureText(s).width;
    if (used + w <= maxW) { out.push([s, c, b]); used += w; continue; }
    let k = s.length;
    while (k > 1 && ctx.measureText(`${s.slice(0, k)}…`).width + used > maxW) k--;
    if (k > 1) out.push([`${s.slice(0, k)}…`, c, b]);
    break;
  }
  runs(ctx, out, x, y, px);
}

function trim(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

export { BOTS, slotPoint };
export type { Repo };
