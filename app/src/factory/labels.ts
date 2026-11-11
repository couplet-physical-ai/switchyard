// The floor's words (fab-w0, from factory.ts): the greedy label placer every layer places with
// (measured boxes, a 12 px gap, nudged up in 15 px rows and slid sideways; never a cut word), and
// the labels themselves: the nine stage titles with their stat lines, the machines' names, the
// busy bays' jobs, the PR yard's phases, ages and pallets, the docks' and rails' orgs, the deploy
// tracks, the districts, the culprit's callout and, zoomed in, the apps' names. Also the idle
// floor's titles and the (retired, on-demand) legend.

import type { Frame } from '../../app.contract.d.ts';
import { BOTS } from '../world.ts';
import type { Gfx } from '../yard/gfx.ts';
import { C, withAlpha } from '../yard/theme.ts';
import { AGE_WORDS, PHASES } from './census.ts';
import type { Factory } from './factory.ts';
import { PLAN, VIA_WORDS } from './layout.ts';
import { MONO, SMALL, TITLE, dur, runningStep } from './prims.ts';
import type { Bay, Block, Label, Layer, LiveFrame } from './types.ts';

const {
  DOCK_U0, AISLE_V, YARD_U0, ROW_U, ROW_DU, AGE_V, STACK_DV, PALLET_V, GATE_U, RAIL_U0, RAIL_U1, RAIL_V, INTAKE_U0,
  ENG_U0, ENG_U1, ENG_V0, ENG_STEP, ENG_DV, ENG_H, SCAN_U, TRACK_V, CITY_U0, CITY_V0, VIAS,
} = PLAN;

export class Labels implements Layer {
  readonly name = 'labels';
  /** The boxes placed this frame (the placer's memory; reset each live frame and by a lens or
   *  the journey, whose dimmed words no longer claim their places). */
  list: Label[] = [];
  private nameOrder: Block[] = [];
  private nameOrderAt = -1;

  constructor(readonly f: Factory) {}

  /** A new frame: nothing placed yet. */
  reset(): void { this.list = []; }

  live(g: Gfx, fr: LiveFrame): void { this.draw(g, fr.detail, fr.now); }

  /** Reserve a label rect, nudged up in 15 px rows until it touches no other label. */
  place(x: number, y: number, w: number, h: number, maxUp = 9): number {
    const r = this.placeAt(x, y, w, h, maxUp, false);
    return r ? r[1] : -1;
  }

  /** Greedy placement over candidate positions (rows up, and with `slide` shifts sideways),
   *  measured boxes, a 12 px gap; null when nothing is free. */
  placeAt(x: number, y: number, w: number, h: number, maxUp: number, slide: boolean): [number, number] | null {
    const G = 12;
    const free = (xx: number, yy: number) => {
      if (yy - h < 40 || xx < 4 || xx + w > this.f.cam.W - 4) return false;
      for (const l of this.list) if (xx < l.x + l.w + G && xx + w + G > l.x && yy - h - 3 < l.y && yy + 3 > l.y - l.h) return false;
      return true;
    };
    const shifts = slide ? [0, 28, -28, 56, -56, 90, -90] : [0];
    for (let k = 0; k <= maxUp; k++) {
      for (const dx of shifts) {
        const xx = x + dx, yy = y - k * 15;
        if (free(xx, yy)) { this.list.push({ x: xx, y: yy, w, h }); return [xx, yy]; }
      }
    }
    if (maxUp === 0 && !slide) return null;
    return null;
  }

  /** A label with its leader line: from the object's anchor (ax, ay) up to a label band. */
  leader(g: Gfx, ax: number, ay: number, lift: number, parts: [string, string, boolean?][], px = MONO): [number, number] {
    let wsum = 0;
    for (const [s, , b] of parts) wsum += g.width(s, px, !!b);
    const at = this.placeAt(Math.round(ax - 3), Math.round(ay - lift), wsum, px + 3, 8, true);
    if (!at) return [0, -1];
    const [x, y] = at;
    const lx = Math.min(Math.max(ax, x + 2), x + wsum - 2);
    g.begin_(); g.move(ax, ay - 1); g.line(lx, y + 4); g.stroke('#4A4A4E', g.hair * 1.5);
    g.begin_(); g.circle(ax, ay, 1.6); g.fill('#6A6A6E');
    // a dark band under the words so nothing behind them competes
    g.fillRect(x - 3, y - px, wsum + 6, px + 5, withAlpha(C.canvas, 0.86));
    g.runs(parts, x, y, px);
    return [x, y];
  }

  tag(g: Gfx, s: string, x: number, y: number, ink: string, edge: string): void {
    // (x moves with the placement)
    const w = g.width(s, SMALL) + 10;
    const at = this.placeAt(x, y, w, 16, 3, true);
    if (!at) return;
    const [xt, yy] = at;
    x = xt;
    g.fillRect(x, yy - 12, w, 16, withAlpha(C.canvas, 0.9));
    g.begin_(); g.rect(x + 0.5, yy - 11.5, w - 1, 15); g.stroke(withAlpha(edge, 0.7), 1);
    g.text(s, x + 5, yy, ink, SMALL);
  }

  private draw(g: Gfx, detail: boolean, now: number): void {
    const cam = this.f.cam, c = this.f.census, w = this.f.world, f = c.flow;
    // the ladder thins the words: q1 fewer job names, q2 no stack counts or age axis, q3 no
    // rail, track or pallet names; stage titles, counts and failures always stay
    const q = this.f.budget.quality;
    const jobsPer = q === 0 ? (detail ? 3 : 2) : q === 1 ? (detail ? 2 : 1) : 0;
    const num = (n: number) => n.toLocaleString('en-US');
    // the stage titles: anchored at each stage's back edge, lifted into the band above it
    const stage = (n: string, title: string, u: number, v: number, z: number, stat: string, why: string, id: string, statCol: string = C.ink2) => {
      const ax = cam.x(u, v), ay = cam.y(u, v, z);
      const l1 = g.width(`${n} `, SMALL) + g.width(title, TITLE, true), sub = stat + (why ? ` · ${why}` : '');
      const wv = Math.max(l1, g.width(sub, SMALL));
      const x = Math.round(ax - 3);
      // two lines placed as one block, so a neighbour's second line never lands on ours
      const yb = this.place(x, Math.round(ay - 34), wv, 36, 8);
      if (yb < 60) return;
      const y = yb - 17;
      g.vline(g.crisp(ax), yb + 3, ay - 1, '#4A4A4E');
      g.begin_(); g.circle(ax, ay, 1.8); g.fill('#7A7A7E');
      g.fillRect(x - 4, y - TITLE, wv + 8, 38, withAlpha(C.canvas, 0.86));
      g.runs([[`${n} `, C.ink3], [title, C.ink, true]], x, y, TITLE);
      g.runs([[stat, statCol], [why ? ` · ${why}` : '', C.ink3]], x, y + 17, SMALL);
      this.f.hit(x - 3, y - 14, wv + 6, 36, 'stage', id, title);
    };
    const pushes = c.docks.reduce((a, d) => a + d.perHour, 0);
    const busiest = [...c.docks].sort((a, b) => b.perHour - a.perHour)[0];
    stage('01', 'sources', 36, 30, 14, `${pushes} pushes/h`, busiest && busiest.perHour ? `${busiest.short} busiest` : 'quiet hour', '36,300,2');
    const open = c.phaseN.reduce((a, b) => a + b, 0);
    const stuck = c.stacks.reduce((a, r) => a + r.reduce((b, s) => b + s.stuck, 0), 0);
    stage('02', 'pr yard', YARD_U0 + 30, 92, 2, `${num(open)} open`, `${num(c.botN)} bot · depth = age`, '270,330,2');
    stage('03', 'merge gate', GATE_U + 4, AISLE_V - 36, 40, `${f.merges} merged/h`, '', `${GATE_U},${AISLE_V},2.6`);
    stage('04', 'main lines', RAIL_U0 + 40, RAIL_V[0] - 8, 0, `${c.redLines} red`, `one rail per org`, '550,290,2.4', C.redText);
    const waiting = c.waiting;
    stage('05', 'intake', INTAKE_U0 + 10, 258, 6, `${waiting} queued`, c.oldestWait > 60_000 ? `oldest ${dur(c.oldestWait)}` : `p50 ${dur(w.stats.p50_queue_ms || 0)}`, '705,291,3');
    const slots = c.groups.reduce((a, gr) => a + (gr.hosted ? 0 : gr.slots), 0);
    const busy = c.groups.reduce((a, gr) => a + (gr.hosted ? 0 : gr.running.length), 0);
    stage('06', 'consumption engine', ENG_U0 + 10, ENG_V0, ENG_H, `${c.building} building · ${busy} of ${slots} bays`, `${f.started} jobs/h · p50 ${dur(w.stats.p50_build_ms || 0)}`, '915,300,1.9', C.amberText);
    const pass = f.finished ? Math.round(((f.finished - f.failed) / f.finished) * 100) : Math.round((w.stats.success_rate_24h || 0) * 100);
    stage('07', 'tests', SCAN_U, 30, 56, `${pass}% pass`, `${f.failed} failed/h`, `${SCAN_U},330,2.4`);
    stage('08', 'deploy', SCAN_U + 40, TRACK_V[0] - 6, 0, `${c.deploying.length} deploying · ${f.deploys}/h`, '', `1165,330,2.6`, c.deploying.length ? C.amberText : C.ink2);
    let up = 0;
    for (const a of w.apps.values()) if (a.health === 'up') up++;
    stage('09', 'apps', CITY_U0 + 20, CITY_V0, 6, `${up} of ${w.apps.size} up`, `${c.districts.length} districts`, '1360,320,2');
    // engines: one label per machine (host · platform · busy/slots · cpu mem)
    c.groups.forEach((gr, gi) => {
      const v0 = ENG_V0 + gi * ENG_STEP;
      const ax = cam.x(ENG_U1 - 6, v0 + ENG_DV), ay = cam.y(ENG_U1 - 6, v0 + ENG_DV, 0);
      void ax; void ay;
      // the machine's name on its front face, screen-aligned, left
      const x = cam.x(ENG_U0 + 6, v0 + ENG_DV) + 4, y = cam.y(ENG_U0 + 6, v0 + ENG_DV, 0) + 16;
      const util = gr.slots ? Math.round((gr.running.length / gr.slots) * 100) : 0;
      const gauges = gr.cpu >= 0 ? `cpu ${Math.round(gr.cpu)}% · mem ${Math.round(gr.mem)}%` : gr.hosted ? 'hosted' : 'no gauges';
      const parts: [string, string, boolean?][] = [[gr.name, gr.online ? C.ink : C.ink3, true], [`  ${gr.hosted ? `${gr.running.length} running` : `${gr.running.length}/${gr.slots} · ${util}%`}`, gr.running.length ? C.amberText : C.ink3], [`  ${gauges}`, C.ink3]];
      let wsum = 0; for (const [s, , b] of parts) wsum += g.width(s, SMALL, !!b);
      const at = this.placeAt(x, y, wsum, 14, 2, true);
      let xx = x, yy = y;
      if (at) [xx, yy] = at; else this.list.push({ x, y, w: wsum, h: 14 });
      const x2 = xx;
      g.fillRect(x2 - 3, yy - 11, wsum + 6, 15, withAlpha(C.canvas, 0.82));
      g.runs(parts, x2, yy, SMALL);
      this.f.hit(x2 - 3, yy - 11, wsum + 6, 15, 'engine', `915,${v0 + ENG_DV / 2},2.4`, gr.name);
    });
    // busy bays: the job's repo and how long it has run (red over 1.5× typical). At fleet
    // zoom only the four that matter most are named (overruns, then the longest running).
    const busyBays = this.f.bays.filter((b) => b.pid && w.pipelines.get(b.pid));
    const el = (b: Bay) => { const p = w.pipelines.get(b.pid)!; return p.started ? Math.max(0, now - p.started) : 0; };
    const over = (b: Bay) => { const p = w.pipelines.get(b.pid)!; return p.expected_ms ? el(b) / p.expected_ms : 0; };
    busyBays.sort((a, b) => (over(b) > 1.5 ? 1 : 0) - (over(a) > 1.5 ? 1 : 0) || el(b) - el(a));
    const perMachine = new Map<number, number>();
    const named = busyBays.filter((b) => {
      if (b.pid === this.f.hoverId) return true;
      const n = perMachine.get(b.group) ?? 0;
      if (n >= jobsPer) return false;
      perMachine.set(b.group, n + 1);
      return true;
    });
    named.sort((a, b) => a.group - b.group || a.slot - b.slot);
    for (const b of named) {
      const p = w.pipelines.get(b.pid)!;
      const e = el(b), exp = p.expected_ms ?? 0;
      const name = p.repo.split('/')[1] ?? p.repo;
      const ax = cam.x(b.u + b.du * 0.5, b.v), ay = cam.y(b.u + b.du * 0.5, b.v, ENG_H);
      const step = detail ? runningStep(p) : '';
      this.leader(g, ax, ay, 18 + (b.slot % 2) * 16, [[name, C.ink], [` ${dur(e)}`, exp && e > exp * 1.5 ? C.redText : C.amberText], [step.length >= 3 ? ` · ${step}` : '', C.ink3]], SMALL);
    }
    if (!detail && busyBays.length > named.length) {
      const gx = cam.x(ENG_U1 - 40, ENG_V0), gy = cam.y(ENG_U1 - 40, ENG_V0, ENG_H);
      void gx; void gy;
    }
    // PR yard: phase names along the front, counts on stacks when zoomed, pallet names
    PHASES.forEach((ph, r) => {
      const x = cam.x(ROW_U[r] - ROW_DU / 2, AGE_V[0] + STACK_DV + 14), y = cam.y(ROW_U[r] - ROW_DU / 2, AGE_V[0] + STACK_DV + 14) + 4;
      const s = `${ph} ${c.phaseN[r]}`;
      const yy = this.place(x, y, g.width(s, SMALL), 13, 0);
      if (yy >= 0) g.text(s, x, yy, C.ink2, SMALL);
      if (detail && q < 2) {
        AGE_V.forEach((v, b) => {
          const st = c.stacks[r][b];
          if (!st.n) return;
          const layers = Math.min(16, Math.ceil(st.n / 3));
          const sx = cam.x(ROW_U[r], v + STACK_DV / 2), sy = cam.y(ROW_U[r], v + STACK_DV / 2, 4 + layers * 2.6) - 4;
          const col = st.red >= st.n / 2 && st.red ? C.redText : st.stuck >= st.n / 2 ? C.ink : C.ink2;
          g.text(String(st.n), sx, sy, col, SMALL, true, 'center');
        });
      }
    });
    // the age axis along the yard's right edge (depth = age)
    {
      const ages = detail && q < 2 ? [0, 1, 2, 3, 4, 5] : [];
      for (const b of ages) {
        const x = cam.x(YARD_U0 + 4, AGE_V[b] + STACK_DV / 2) - 4, y = cam.y(YARD_U0 + 4, AGE_V[b] + STACK_DV / 2) + 4;
        g.fillRect(x - g.width(AGE_WORDS[b], SMALL) - 2, y - 10, g.width(AGE_WORDS[b], SMALL) + 4, 13, withAlpha(C.canvas, 0.8));
        g.text(AGE_WORDS[b], x, y, C.ink3, SMALL, false, 'right');
      }
    }
    if (q < 3) c.pallets.forEach((p, i) => {
      const u0 = YARD_U0 + 8 + i * 76;
      const x = cam.x(u0, PALLET_V + 18) + 2, y = cam.y(u0, PALLET_V + 18) + 14;
      const yy = this.place(x, y, g.width(`${p.bot} ${p.n}`, SMALL), 13, 0);
      if (yy >= 0) g.text(`${p.bot} ${p.n}`, x, yy, C.ink3, SMALL);
    });
    // sources: each dock's org and push rate
    c.docks.forEach((d, i) => {
      const v = 66 + i * 96;
      const x = cam.x(DOCK_U0, v + 30) - 4, y = cam.y(DOCK_U0, v + 30) + 14;
      const s = `${d.short} ${d.perHour}/h`;
      const wv = g.width(s, SMALL);
      const yy = this.place(x - wv, y, wv, 13, 0);
      if (yy >= 0) g.text(s, x - wv, yy, d.org === BOTS ? C.ink3 : C.ink2, SMALL);
    });
    // rails: the org at the rail's start
    if (q < 3) c.rails.forEach((r, i) => {
      const x = cam.x(RAIL_U0 + 2, RAIL_V[i] - 18), y = cam.y(RAIL_U0 + 2, RAIL_V[i] - 18) - 2;
      const s = `${r.short}${r.red ? ` ${r.red} red` : ''}`;
      const yy = this.place(x, y, g.width(s, SMALL), 13, 0);
      if (yy >= 0 && r.red) g.runs([[r.short, C.ink3], [` ${r.red} red`, C.redText]], x, yy, SMALL);
      else if (yy >= 0) g.text(r.short, x, yy, C.ink3, SMALL);
    });
    // deploy tracks
    if (q < 3) VIAS.forEach((via, i) => {
      const x = cam.x(SCAN_U + 16, TRACK_V[i] - 30), y = cam.y(SCAN_U + 16, TRACK_V[i] - 30) - 2;
      const s = `${VIA_WORDS[via]} ${f.byVia[via] ?? 0}/h`;
      const yy = this.place(x, y, g.width(s, SMALL), 13, 0);
      if (yy >= 0) g.text(s, x, yy, C.ink3, SMALL);
    });
    // city districts: team names; zoomed, the apps' names too
    for (const d of this.f.districtBox) {
      const x = cam.x(d.u0, d.v1) - 2, y = cam.y(d.u0, d.v1) + 12;
      const s = `${d.team} ${d.n}`;
      const yy = this.place(x, y, g.width(s, SMALL), 13, 0);
      if (yy >= 0) {
        g.fillRect(x - 2, yy - 10, g.width(s, SMALL) + 4, 13, withAlpha(C.canvas, 0.75));
        g.text(s, x, yy, C.ink2, SMALL);
        this.f.hit(x - 2, yy - 10, g.width(s, SMALL) + 4, 13, 'district', `${(d.u0 + d.u1) / 2},${(d.v0 + d.v1) / 2},3.2`, d.team);
      }
    }
    // the focal story: the newest commit that broke a main line, named over its car
    const fc = c.focal;
    if (fc && !this.f.selected) {
      const ri = c.rails.findIndex((r) => r.org === w.orgOf(fc.repo));
      const rail = c.rails[ri];
      const k = rail ? rail.cars.findIndex((x) => x.sha === fc.sha && x.repo === fc.repo) : -1;
      if (rail && k >= 0) {
        const u = RAIL_U1 - 12 - (rail.cars.length - 1 - k) * 10, v = RAIL_V[ri];
        const ax = cam.x(u, v), ay = cam.y(u, v, 6);
        const name = fc.repo.split('/')[1] ?? fc.repo;
        this.leader(g, ax, ay, 46, [[name, C.redText, true], [' broke main', C.redText], [` · ${fc.sha.slice(0, 7)} · ${fc.author} · ${dur(now - fc.at)} ago`, C.ink2]], SMALL);
      }
    }
    if (cam.zoom >= 2.6) {
      // apps by name, whole names only: those that deployed today first, then the rest while
      // the placer finds room (never a cut name)
      if (this.nameOrderAt !== c.at || this.nameOrder.length !== this.f.blocks.length) {
        this.nameOrderAt = c.at;
        this.nameOrder = [...this.f.blocks].sort((a, b) => (c.deploys24.get(b.id) ?? 0) - (c.deploys24.get(a.id) ?? 0));
      }
      const order = this.nameOrder;
      let n = 0;
      const most = [48, 24, 12, 0, 0][q];
      for (const b of order) {
        if (n >= most) break;
        const x = cam.x(b.u + b.d, b.v + b.d / 2) + 3, y = cam.y(b.u + b.d, b.v + b.d / 2, b.h) + 4;
        if (x < 0 || x > cam.W - 380 * (this.f.selected ? 1 : 0) - 8 || y < 60 || y > cam.H - 70) continue;
        const wv = g.width(b.id, SMALL);
        if (this.place(x, y, wv, 13, 0) < 0) continue;
        g.fillRect(x - 2, y - 10, wv + 4, 13, withAlpha(C.canvas, 0.78));
        g.text(b.id, x, y, (c.deploys24.get(b.id) ?? 0) > 0 ? C.ink2 : C.ink3, SMALL);
        n++;
      }
    }
  }

  /** The idle floor (no fleet yet): the stage titles only, quiet. */
  idle(g: Gfx): void {
    const cam = this.f.cam;
    const titles: [string, string, number, number, number][] = [['01', 'sources', 36, 30, 14], ['02', 'pr yard', YARD_U0 + 30, 92, 2], ['04', 'main lines', RAIL_U0 + 40, RAIL_V[0] - 8, 0], ['06', 'consumption engine', ENG_U0 + 10, ENG_V0, ENG_H], ['07', 'tests', SCAN_U, 30, 56], ['09', 'apps', CITY_U0 + 20, CITY_V0, 6]];
    for (const [n, s, u, v, z] of titles) {
      const x = Math.round(cam.x(u, v) - 3), y = Math.round(cam.y(u, v, z) - 30);
      g.vline(g.crisp(cam.x(u, v)), y + 6, cam.y(u, v, z) - 1, '#2E2E30');
      g.runs([[`${n} `, C.ink3], [s, C.ink3, true]], x, y, TITLE);
    }
  }

  /** The key, in the floor's empty front-left corner: what each physical thing is. */
  legend(g: Gfx, f: Frame): void {
    const x = 18, y = f.height - 58 - 26;
    const items: [string, string][] = [['crate', 'a pipeline (amber: in flight)'], ['car', 'a merged commit on its org\'s main line'], ['stack', 'open PRs by phase; height = count, depth = age'], ['bay', 'an engine slot, lit while it builds']];
    let yy = y - (items.length - 1) * 17;
    for (const [k, s] of items) {
      g.runs([[k.padEnd(6, ' '), C.ink2, true], [s, C.ink3]], x, yy, SMALL);
      yy += 17;
    }
    g.text('failed crates turn red at the scanner and ride the return conveyor home', x, yy + 2, C.redText, SMALL);
  }
}
