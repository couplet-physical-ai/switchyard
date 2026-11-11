// The selection's story (fab-w0, from factory.ts): a picked run or commit lights its JOURNEY
// across the floor (dock → PR → gate → rail → intake → bay → scanner → its app, red home on a
// failure) with its stations named, and the DRAWER on the right tells it in words: the run, its
// timeline, its steps on one time axis, its deploys. Also the hover card: quick facts beside the
// pointer (the lens system's preview first).

import type { Ctx2D, Frame } from '../../app.contract.d.ts';
import type { Pipeline } from '../wire.ts';
import type { Gfx } from '../yard/gfx.ts';
import { C, withAlpha } from '../yard/theme.ts';
import { failingStep } from './census.ts';
import type { Factory } from './factory.ts';
import { PLAN, VIA_WORDS } from './layout.ts';
import { MONO, SMALL, clockWords, crate, dur } from './prims.ts';
import type { HitBox, Pt } from './types.ts';

const {
  DOCK_U0, COLLECT_U, AISLE_V, YARD_U1, ROW_U, AGE_V, GATE_U, RAIL_U0, RAIL_U1, INTAKE_U0, INTAKE_U1, LANE_V, DIST_U,
  ENG_U0, ENG_U1, ENG_V0, ENG_STEP, ENG_DV, ENG_H, SCAN_U, TRACK_V, TRACK_U1, RETURN_V, VIAS,
} = PLAN;

export class Drawer {
  constructor(readonly f: Factory) {}

  /** The selection's pipeline (a commit selection: its newest pipeline). */
  selPipeline(): Pipeline | null {
    const w = this.f.world;
    if (!this.f.selected) return null;
    const p = w.pipelines.get(this.f.selected);
    if (p) return p;
    const c = w.commits.get(this.f.selected);
    if (c) for (let i = c.pipelines.length - 1; i >= 0; i--) { const q = w.pipelines.get(c.pipelines[i]); if (q) return q; }
    return null;
  }

  /** repo and sha of the selection (for the journey fetch). */
  selCommit(): { repo: string; sha: string } | null {
    const p = this.selPipeline();
    if (p) return { repo: p.repo, sha: p.sha };
    const at = this.f.selected.indexOf('@');
    if (at > 0) return { repo: this.f.selected.slice(0, at), sha: this.f.selected.slice(at + 1) };
    return null;
  }

  private journeyPath(p: Pipeline | null): { pts: Pt[]; red: boolean; stops: [Pt, string][] } {
    const w = this.f.world;
    const cm = this.selCommit();
    const repo = p?.repo ?? cm?.repo ?? '';
    const org = w.orgOf(repo);
    const prN = p?.pr ?? w.commits.get(`${repo}@${cm?.sha ?? ''}`)?.pr;
    const iv = LANE_V[p?.lane === 'gha' ? 1 : 0];
    let pts: Pt[], stops: [Pt, string][];
    const fl = this.f.floor, lp = fl.on ? fl.lanePath(repo) : null;
    if (lp) {
      // fx-lens: on the group lanes: its lane's dock, belt (by its PR cell when a PR carried it),
      // the gate, its lane's rail (its car's spot), the merge into the intake
      const [a, b] = lp;
      pts = [...a];
      stops = [[a[0]!, 'pushed']];
      const L = fl.lanesNow[fl.laneIndex(repo)];
      if ((prN || p?.event === 'pull_request') && L && !L.s.stripe) {
        const cv = (L.s.cell0 + L.s.cell1) / 2;
        stops.push([[ROW_U[1], cv], `PR #${prN ?? ''}`]);
        pts.splice(pts.length - 1, 0, [ROW_U[1] - 20, a[a.length - 1]![1]], [ROW_U[1] - 20, cv], [ROW_U[3], cv], [ROW_U[3] + 20, a[a.length - 1]![1]]);
      }
      stops.push([b[0]!, 'merged']);
      const car = fl.carSpot(`${repo}@${p?.sha ?? cm?.sha ?? ''}`);
      pts.push(...b.slice(1, -1));
      if (car) stops.push([car, 'landed']);
      pts.push([INTAKE_U0, iv], [INTAKE_U1, iv]);
    } else {
      const dv = this.f.dockV(org), rv = this.f.railV(org);
      pts = [[DOCK_U0 + 20, dv], [COLLECT_U, dv], [COLLECT_U, AISLE_V]];
      stops = [[[DOCK_U0 + 20, dv], 'pushed']];
      if (prN || p?.event === 'pull_request') {
        pts.push([ROW_U[1], AISLE_V], [ROW_U[1], AGE_V[0] + 10], [ROW_U[3], AGE_V[0] + 10], [ROW_U[3], AISLE_V]);
        stops.push([[ROW_U[1], AGE_V[0] + 10], `PR #${prN ?? ''}`]);
      }
      pts.push([YARD_U1, AISLE_V], [GATE_U + 4, AISLE_V], [RAIL_U0, rv], [RAIL_U1, rv], [INTAKE_U0, iv], [INTAKE_U1, iv]);
      stops.push([[GATE_U + 4, AISLE_V], 'merged']);
    }
    stops.push([[INTAKE_U0 + 20, iv], 'queued']);
    const bay = p ? (this.f.bays.find((b) => b.pid === p.id) ?? this.f.plant.lastBay.get(p.id ?? '')) : undefined;
    const gi = p?.lane === 'gha' ? this.f.census.groups.length - 1 : 0;
    const bv = bay ? bay.v + bay.dv / 2 : ENG_V0 + gi * ENG_STEP + ENG_DV / 2;
    const bu = bay ? bay.u + bay.du / 2 : (ENG_U0 + ENG_U1) / 2;
    pts.push([DIST_U, LANE_V[0]], [DIST_U, bv], [bu, bv]);
    stops.push([[bu, bv], p?.state === 'running' ? 'building' : 'built']);
    if (!p || p.state === 'running' || p.state === 'pending') return { pts, red: false, stops };
    pts.push([ENG_U1, bv], [SCAN_U, bv]);
    const red = p.state === 'failure' || p.state === 'error';
    stops.push([[SCAN_U, bv], red ? `failed · ${failingStep(p)}` : 'passed']);
    if (red) {
      pts.push([SCAN_U, RETURN_V], [24, RETURN_V], [24, this.f.dockV(repo)]);
      return { pts, red, stops };
    }
    let dep = w.deploys.get(`${p.repo}@${p.sha}`);
    if (!dep) for (const d of w.deploys.values()) if (d.repo === p.repo && d.sha === p.sha) { dep = d; break; } // fx-lens: the world keys deploys by app
    const app = dep?.app ?? w.repos.get(p.repo)?.app;
    const b = app ? this.f.blockAt.get(app) : undefined;
    if (b && (dep || p.deploy)) {
      const vi = Math.max(0, VIAS.indexOf(((dep?.via === 'manual' ? 'gha_fallback' : dep?.via) ?? 'roadrunner') as typeof VIAS[number]));
      pts.push([SCAN_U, TRACK_V[vi]], [TRACK_U1, TRACK_V[vi]], [b.u + b.d / 2, b.v + b.d / 2]);
      stops.push([[b.u + b.d / 2, b.v + b.d / 2], `${app} ${dep?.state === 'success' ? 'deployed' : dep?.state ?? 'deploying'}`]);
    }
    return { pts, red, stops };
  }

  /** The selection's journey: its path lights across the floor, the rest dims to 25 %, the
   *  stations it passed named. */
  journey(g: Gfx, ctx: Ctx2D, f: Frame, p: Pipeline | null, t: number): void {
    const cam = this.f.cam;
    // the rest of the floor dims to 25 %
    g.fillRect(0, 0, f.width, f.height, withAlpha(C.canvas, 0.75));
    const { pts, red, stops } = this.journeyPath(p);
    const col = red ? C.red : C.packet;
    const trace = () => { g.begin_(); pts.forEach(([u, v], i) => { const x = cam.x(u, v), y = cam.y(u, v, 1); if (i) g.line(x, y); else g.move(x, y); }); };
    // w2-chrome (REVIEW-iter3 #7): the round joins and caps are this path's own; they used to leak
    // into the time strip, whose hour-wide bars then stroked as 26 discs
    ctx.save();
    ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    trace(); g.stroke(withAlpha(col, 0.18), 9);
    trace(); g.stroke(withAlpha(col, 0.35), 4);
    trace(); g.stroke(col, 1.5);
    ctx.restore();
    // a travelling spark along the lit path (where the selection is now)
    let total = 0;
    for (let i = 1; i < pts.length; i++) total += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    const run = p?.state === 'running';
    if (run) {
      const bay = this.f.bays.find((b) => b.pid === p?.id);
      if (bay) crate(cam, g, bay.u + bay.du / 2, bay.v + bay.dv / 2, 11, false, false, ENG_H - 3);
    }
    void total; void t;
    // stops: the stations it passed, named (the dimmed words below no longer claim space)
    this.f.words.reset();
    stops.forEach(([[u, v], s], i) => {
      const x = cam.x(u, v), y = cam.y(u, v, 1);
      g.begin_(); g.move(x, y - 4); g.line(x + 4, y); g.line(x, y + 4); g.line(x - 4, y); g.ctx.closePath(); g.fill(i === stops.length - 1 ? col : C.ink);
      const bad = s.startsWith('failed');
      this.f.words.tag(g, s, x + 7, y - 6, bad ? C.redText : C.ink2, bad ? '' : '#5A5A5E');
    });
  }

  /** The drawer (right): the run or commit, its timeline, its steps on one axis, its deploys. */
  draw(g: Gfx, f: Frame, p: Pipeline | null, now: number): void {
    const w = this.f.world;
    const W = 372, x0 = f.width - W, y0 = 40, H = f.height - y0 - 66;
    g.fillRect(x0, y0, W, H, '#111112');
    g.vline(g.crisp(x0), y0, y0 + H, '#2E2E30');
    g.hline(x0, x0 + W, g.crisp(y0), '#2E2E30');
    this.f.hit(x0, y0, W, H, 'drawer', '', '');
    this.f.hit(x0 + W - 30, y0 + 6, 24, 22, 'close', '', 'close');
    g.text('×', x0 + W - 18, y0 + 22, C.ink3, 14, false, 'center');
    let y = y0 + 24;
    const j = this.f.journey && this.f.journeyFor === this.f.selected ? this.f.journey : null;
    // the world may no longer hold it (a replay, retention): the journey the server sent does
    if (!p && j?.pipelines?.length) p = j.pipelines.find((q) => q.id === this.f.selected) ?? j.pipelines[j.pipelines.length - 1];
    const cm = this.selCommit() ?? (j ? { repo: j.repo, sha: j.sha } : null);
    const commit = (cm ? w.commits.get(`${cm.repo}@${cm.sha}`) : undefined) ?? j?.commit ?? undefined;
    const repo = p?.repo ?? cm?.repo ?? '';
    const state = p?.state ?? commit?.ci ?? '';
    const stCol = state === 'failure' || state === 'error' ? C.redText : state === 'success' ? C.green : C.amberText;
    g.text(p ? `${p.lane === 'gha' ? 'github actions' : 'roadrunner'} #${p.number}` : 'commit', x0 + 16, y, C.ink3, SMALL);
    y += 20;
    g.text(g.fit(repo, 13, W - 40, true), x0 + 16, y, C.ink, 13, true);
    y += 18;
    const title = p?.title ?? commit?.title ?? '';
    g.text(g.fit(title, MONO, W - 32), x0 + 16, y, C.ink2, MONO);
    y += 16;
    const sha = (p?.sha ?? cm?.sha ?? '').slice(0, 7);
    g.runs([[sha, C.ink3], [` · ${p?.branch ?? commit?.branch ?? ''}`, C.ink3], [` · ${p?.author ?? commit?.author ?? ''}`, C.ink3]], x0 + 16, y, SMALL, W - 32);
    y += 22;
    const el = p?.started ? (p.finished ?? now) - p.started : 0;
    const exp = p?.expected_ms ?? 0;
    g.runs([[state || 'unknown', stCol, true], [el ? `  ${dur(el)}${state === 'running' && exp ? ` of ~${dur(exp)}` : ''}` : '', C.ink2], [p?.engine ? `  on ${p.engine}` : '', C.ink3]], x0 + 16, y, MONO, W - 32);
    y += 26;
    // timeline
    const eyebrow = (s: string) => { g.hline(x0 + 16, x0 + W - 16, g.crisp(y - 12), '#232325'); g.text(s, x0 + 16, y + 2, C.ink3, SMALL); y += 18; };
    eyebrow('TIMELINE');
    const tl: [number, string, string][] = [];
    if (j?.timeline?.length) for (const e of j.timeline.slice(-9)) tl.push([e.at, e.k, e.label]);
    else {
      if (commit) tl.push([commit.at, 'push', `pushed by ${commit.author}`]);
      if (p) {
        tl.push([p.created, 'enqueue', `queued on ${p.lane}`]);
        if (p.started) tl.push([p.started, 'start', `started${p.engine ? ` on ${p.engine}` : ''}`]);
        if (p.finished) tl.push([p.finished, 'finish', `${p.state}${p.state === 'failure' ? ` at ${failingStep(p)}` : ''}`]);
      }
      const d = w.deploys.get(`${repo}@${p?.sha ?? cm?.sha ?? ''}`);
      if (d) tl.push([d.started, 'deploy', `deploy ${d.app} via ${VIA_WORDS[d.via] ?? d.via} · ${d.state}`]);
    }
    tl.sort((a, b) => a[0] - b[0]);
    const t0 = tl[0]?.[0] ?? now;
    for (const [at, k, s] of tl) {
      const bad = /fail|error/.test(s);
      g.begin_(); g.circle(x0 + 20, y - 4, 2.5); g.fill(bad ? C.red : k === 'deploy' || k === 'deployed' ? C.green : C.packet);
      g.text(at === t0 ? clockWords(at, this.f.offsetMin) : `+${dur(at - t0)}`, x0 + 30, y, C.ink3, SMALL);
      g.text(g.fit(s, SMALL, W - 120), x0 + 104, y, bad ? C.redText : C.ink2, SMALL);
      y += 16;
      if (y > y0 + H * 0.45) break;
    }
    y += 12;
    // steps: each workflow's steps as a bar on a shared axis
    eyebrow('STEPS');
    const wfs = (j?.pipelines?.find((q) => q.id === p?.id) ?? p)?.workflows ?? [];
    let sMin = Infinity, sMax = 0;
    for (const wf of wfs) for (const s of wf.steps) { if (s.started) sMin = Math.min(sMin, s.started); sMax = Math.max(sMax, s.finished ?? (s.started ? now : 0)); }
    const axisW = W - 32 - 150;
    let shown = 0;
    for (const wf of wfs) {
      if (y > y0 + H - 90) break;
      g.text(g.fit(wf.name, SMALL, W - 40), x0 + 16, y, C.ink2, SMALL, true);
      y += 15;
      for (const s of wf.steps) {
        if (y > y0 + H - 80) { g.text(`… ${wf.steps.length - shown} more`, x0 + 16, y, C.ink3, SMALL); y += 15; break; }
        shown++;
        const bad = s.state === 'failure' || s.state === 'error';
        const run = s.state === 'running';
        g.text(g.fit(s.name, SMALL, 140), x0 + 22, y, bad ? C.redText : run ? C.amberText : C.ink3, SMALL);
        if (s.started && sMax > sMin) {
          const a = x0 + 166 + ((s.started - sMin) / (sMax - sMin)) * axisW;
          const b = x0 + 166 + (((s.finished ?? now) - sMin) / (sMax - sMin)) * axisW;
          g.fillRect(a, y - 7, Math.max(2, b - a), 6, bad ? C.red : run ? C.packet : s.cached ? '#3A3A3E' : '#5A6E5F');
        }
        y += 14;
      }
    }
    if (!wfs.length) { g.text('no steps reported for this run', x0 + 16, y, C.ink3, SMALL); y += 16; }
    y += 12;
    // deploys
    if (y < y0 + H - 40) {
      eyebrow('DEPLOYS');
      const deps = j?.deploys?.length ? j.deploys : [...w.deploys.values()].filter((d) => d.repo === repo && d.sha === (p?.sha ?? cm?.sha));
      if (!deps.length) g.text(p?.deploy ? 'deploys after it passes' : 'this run deploys nothing', x0 + 16, y, C.ink3, SMALL);
      for (const d of deps.slice(0, 3)) {
        g.runs([[d.app, C.ink, true], [`  via ${VIA_WORDS[d.via] ?? d.via}`, C.ink3], [`  ${d.state}`, d.state === 'success' ? C.green : d.state === 'failure' ? C.redText : C.amberText]], x0 + 16, y, SMALL, W - 32);
        y += 16;
      }
    }
  }

  /** The hover card: hover.ts draws it (fx-lens: one card, beside its object, over the lens's
   *  story); this stays for factory.ts's call. */
  hover(_g: Gfx, _f: Frame): void {}

  /** Quick facts for a hit nothing else words (the hover card's last resort). */
  facts(h: HitBox): string[] {
    const w = this.f.world, now = this.f.tl.playhead;
    if (h.kind === 'pipeline') {
      const p = w.pipelines.get(h.id);
      if (!p) return [h.label];
      const el = p.started ? (p.finished ?? now) - p.started : now - p.created;
      return [`${p.repo} #${p.number}`, `${p.state} · ${dur(el)}${p.expected_ms ? ` · typical ${dur(p.expected_ms)}` : ''}`, `${p.event} · ${p.branch}${p.engine ? ` · ${p.engine}` : ''}`, 'click: light its journey'];
    }
    if (h.kind === 'app') {
      const a = w.apps.get(h.id);
      return [h.id, `${a?.health ?? 'unknown'}${a?.latency_ms ? ` · ${a.latency_ms} ms` : ''}${a?.team ? ` · ${a.team}` : ''}`, `${this.f.census.deploys24.get(h.id) ?? 0} deploys in 24 h${a?.behind ? ` · ${a.behind} behind main` : ''}`];
    }
    if (h.kind === 'commit') return [h.label.slice(0, 60), 'click: light its journey'];
    return [h.label];
  }
}
