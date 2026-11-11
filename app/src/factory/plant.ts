// The plant (fab-w0, from factory.ts): the intake's holding belt and its queued crates, THE
// CONSUMPTION ENGINE (one machine per host, its slots as recessed bays lit while they build, a
// progress rail along each, red past 1.5× the expected time, the job's crate riding it), the
// machines' cpu and mem gauges, and the test scanner. Enqueues, starts and finishes send their
// crates from here (a failure rides the return conveyor home). The deploy tracks' traffic is
// `Tracks`, below (the track beds are the floor's steel, floor.ts).

import type { Event } from '../wire.ts';
import type { World } from '../world.ts';
import type { Gfx } from '../yard/gfx.ts';
import { C, clamp, withAlpha } from '../yard/theme.ts';
import { failingStep } from './census.ts';
import type { Factory } from './factory.ts';
import { PLAN } from './layout.ts';
import { R_BEAM, R_DOOR, R_RING, breathe } from './motion.ts';
import { F, box, pipeWords, poly, quad, ring } from './prims.ts';
import type { Bay, FloorPass, Layer, LiveFrame, Pt } from './types.ts';

const {
  DOCK_U0, DOCK_U1, RAIL_U1, INTAKE_U0, INTAKE_U1, LANE_V, DIST_U, ENG_U0, ENG_U1, ENG_V0, ENG_STEP, ENG_DV, ENG_H,
  SCAN_U, TRACK_V, TRACK_U1, RETURN_V,
} = PLAN;

export class Plant implements Layer {
  readonly name = 'plant';
  /** Every machine's slots this frame (rebuilt at each census check). */
  bays: Bay[] = [];
  /** The bay each run was last seen in (a finished run leaves from there). */
  readonly lastBay = new Map<string, Bay>();

  constructor(readonly f: Factory) {}

  census(w: World): void { this.layoutBays(w); }

  // ---- events: a run queues at the intake, starts in its bay, finishes through the scanner
  // (a failure turns red there and rides the return conveyor to its dock) ----
  onEvent(e: Event, w: World, t: number): void {
    const orgOf = (repo: string) => w.orgOf(repo);
    const R = this.f.reactions.rp;
    switch (e.k) {
      case 'enqueue': {
        const org = orgOf(e.repo);
        const lane = e.lane === 'gha' ? 1 : 0;
        const q = lane ? this.f.census.gha.length : this.f.census.rr.length;
        const end = Math.max(INTAKE_U0 + 8, INTAKE_U1 - 8 - q * 11);
        const cr = this.f.crates.spawn(e.pipeline, 'pipeline', [[RAIL_U1 - 10, this.f.railV(org)], [RAIL_U1 + 12, this.f.railV(org)], [INTAKE_U0, LANE_V[lane]], [end, LANE_V[lane]]], t, 1800, false, '', org);
        R.add(R_RING, end, LANE_V[lane], 4, this.f.crates.arrives(cr, 3), false, 900);
        break;
      }
      case 'start': {
        const p = w.pipelines.get(e.pipeline);
        const bay = this.bayOf(e.pipeline, w);
        const lane = p?.lane === 'gha' ? 1 : 0;
        if (bay) {
          const cr = this.f.crates.spawn(e.pipeline, 'pipeline', [[INTAKE_U1 - 6, LANE_V[lane]], [DIST_U, LANE_V[lane]], [DIST_U, bay.v + bay.dv / 2], [bay.u + 6, bay.v + bay.dv / 2]], t, 1600, false, '', p ? orgOf(p.repo) : '');
          R.add(R_RING, bay.u + bay.du / 2, bay.v + bay.dv / 2, ENG_H, this.f.crates.arrives(cr, 3), false, 1000);
        }
        break;
      }
      case 'finish': {
        const p = w.pipelines.get(e.pipeline);
        if (!p) break;
        const red = e.state === 'failure' || e.state === 'error';
        if (e.state === 'canceled' || e.state === 'skipped') break;
        const from = this.lastBay.get(e.pipeline);
        const v0 = from ? from.v + from.dv / 2 : ENG_V0 + ENG_DV / 2;
        const u0 = from ? from.u + from.du / 2 : ENG_U1 - 20;
        const org = orgOf(p.repo);
        const route: Pt[] = [[u0, v0], [ENG_U1 + 6, v0], [SCAN_U, v0]];
        let dur = 1600;
        if (red) {
          route.push([SCAN_U, RETURN_V], [24, RETURN_V], [24, this.f.dockV(p.repo)], [DOCK_U0 + 8, this.f.dockV(p.repo)]); // fab-w2: home to its group dock
          dur = 9000;
        } else route.push([SCAN_U + 14, v0]);
        const cr = this.f.crates.spawn(e.pipeline, 'pipeline', route, t, dur, red, red ? `${p.repo.split('/')[1]} · ${failingStep(p)}` : '', org);
        R.add(R_BEAM, SCAN_U, v0, 56, this.f.crates.arrives(cr, 2), red, 700);
        if (red) { R.add(R_DOOR, DOCK_U1, this.f.dockV(p.repo), 6, this.f.crates.arrives(cr, 6), true, 1400); R.add(R_RING, DOCK_U0 + 8, this.f.dockV(p.repo), 8, this.f.crates.arrives(cr, 6), true, 1400); } // fab-w2
        break;
      }
      default: break;
    }
  }

  bayOf(pid: string, w: World): Bay | null {
    this.layoutBays(w);
    const b = this.bays.find((x) => x.pid === pid) ?? null;
    if (b) this.lastBay.set(pid, b);
    return b;
  }

  /** Bays: each machine's slots, the k-th running pipeline of a host in bay k. */
  private layoutBays(w: World): void {
    void w;
    const out: Bay[] = [];
    this.f.census.groups.forEach((g, gi) => {
      const v0 = ENG_V0 + gi * ENG_STEP;
      const n = Math.max(1, g.slots);
      const span = ENG_U1 - ENG_U0 - 28;
      const du = span / n;
      for (let k = 0; k < n; k++) {
        out.push({ u: ENG_U0 + 14 + k * du + 3, v: v0 + 16, du: du - 6, dv: ENG_DV - 40, group: gi, slot: k, pid: g.running[k] ?? '' });
      }
    });
    this.bays = out;
    for (const b of out) if (b.pid) this.lastBay.set(b.pid, b);
  }

  // ---- the static floor: the intake's frame, the machines, their gauges, the scanner ----
  floor(fp: FloorPass): void {
    const g = fp.g, cam = this.f.cam, lo = fp.lo, add = fp.add;
    // intake: the holding belt's frame (two rails along it)
    add(INTAKE_U0, 256, () => {
      box(cam, g, INTAKE_U0, 258, INTAKE_U1 - INTAKE_U0, 4, 6);
      box(cam, g, INTAKE_U0, 320, INTAKE_U1 - INTAKE_U0, 4, 6);
      g.begin_(); quad(cam, g, INTAKE_U0, 291 - 1, INTAKE_U1, 291 + 1, 0.6); g.fill(F.beltEdge);
    }, INTAKE_U1, 324, 6);
    // the consumption engine: one big machine per host
    this.f.census.groups.forEach((gr, gi) => {
      const v0 = ENG_V0 + gi * ENG_STEP;
      add(ENG_U0, v0, () => this.engineBlock(g, gr.online, gr.hosted, v0, gi, lo), ENG_U1 + 4, v0 + ENG_DV + 4, ENG_H);
      // cpu / mem gauges: two towers at the machine's right end
      add(ENG_U1 + 10, v0 + 40, () => {
        box(cam, g, ENG_U1 + 12, v0 + 34, 9, 9, 64, '#1B1B1D');
        box(cam, g, ENG_U1 + 25, v0 + 34, 9, 9, 64, '#1B1B1D');
      }, ENG_U1 + 34, v0 + 43, 64);
    });
    // the test scanner: a tall frame across the floor
    add(SCAN_U - 4, 30, () => {
      box(cam, g, SCAN_U - 4, 30, 8, 8, 56);
      box(cam, g, SCAN_U - 4, 590, 8, 8, 56);
      g.begin_(); quad(cam, g, SCAN_U - 4, 30, SCAN_U + 4, 598, 56); g.fill(F.topHi);
      g.begin_(); quad(cam, g, SCAN_U - 4, 30, SCAN_U + 4, 598, 56); g.stroke(F.edgeHi, g.hair * 1.5);
    }, SCAN_U + 4, 598, 56);
  }

  private engineBlock(g: Gfx, online: boolean, hosted: boolean, v0: number, gi: number, lo = false): void {
    const cam = this.f.cam;
    const edge = online ? F.edgeHi : F.edge;
    // the plinth, then the machine: a long block with recessed bays on its top
    box(cam, g, ENG_U0 - 4, v0 - 4, ENG_U1 - ENG_U0 + 8, ENG_DV + 8, 3, '#141416', '#101012', '#0E0E10', F.floorEdge);
    box(cam, g, ENG_U0, v0, ENG_U1 - ENG_U0, ENG_DV, ENG_H, hosted ? '#1F1F22' : '#252528', '#19191B', '#151517', edge, g.hair * 2);
    // bays: dark recesses, every bay of the machine in one path per part. A bay narrower than
    // 6 px on screen (stress mode's ten times the slots) is a recess and its rail only.
    const fine = !lo && (this.bays.find((b) => b.group === gi)?.du ?? 0) * cam.s >= 6;
    const rec = this.f.bA, wall = this.f.bB, rail = this.f.bC;
    for (const b of this.bays) {
      if (b.group !== gi) continue;
      rec.add(b.u, b.v, b.du, b.dv, 0, ENG_H);
      rail.add(b.u, b.v + b.dv + 4, b.du, 5, 0, ENG_H);
    }
    rec.flushQuads(g, cam, F.bay);
    if (fine) {
      // the recess's inner walls (the far wall shows) and its rim
      g.begin_();
      for (const b of this.bays) if (b.group === gi) poly(cam, g, [b.u, b.v, ENG_H, b.u + b.du, b.v, ENG_H, b.u + b.du, b.v, ENG_H - 5, b.u, b.v, ENG_H - 5]);
      g.fill('#0B0B0C');
      for (const b of this.bays) if (b.group === gi) wall.add(b.u, b.v, b.du, b.dv, 0, ENG_H);
      wall.flushQuads(g, cam, '#38383C', true, g.hair);
    }
    // the progress rail along each bay's front lip
    rail.flushQuads(g, cam, '#101012');
    // vents on the front face
    if (!lo) {
      g.begin_();
      for (let u = ENG_U0 + 12; u < ENG_U1 - 10; u += 9) { g.move(cam.x(u, v0 + ENG_DV), cam.y(u, v0 + ENG_DV, 8)); g.line(cam.x(u, v0 + ENG_DV), cam.y(u, v0 + ENG_DV, ENG_H - 8)); }
      g.stroke('#1F1F22', g.hair * 1.5);
    }
    if (hosted) {
      // hosted: dashed outline, a machine we do not own
      g.dash(true, 3, 3);
      g.begin_(); quad(cam, g, ENG_U0 - 4, v0 - 4, ENG_U1 + 4, v0 + ENG_DV + 4, 3); g.stroke(F.edge, g.hair * 1.5);
      g.dash(false);
    }
  }

  // ---- the live layer: the intake's queue, the lit bays, the gauges ----
  live(g: Gfx, fr: LiveFrame): void {
    const cam = this.f.cam, w = this.f.world, c = this.f.census, st = this.f.stat, t = fr.t, q = fr.q, now = fr.now;
    const offX = (x: number) => x < -24 || x > cam.W + 24;
    // 4. intake: queued crates in a visible line, the oldest nearest the engines
    const dim = this.f.bA;
    [c.rr, c.gha].forEach((ids, lane) => {
      ids.slice(0, 8).forEach((id, k) => {
        const u = INTAKE_U1 - 10 - k * 11, v = LANE_V[lane];
        dim.crate(u, v, 8);
        this.f.hit(cam.x(u, v) - 7, cam.y(u, v, 8) - 7, 14, 14, 'pipeline', id, pipeWords(w.pipelines.get(id)));
      });
    });
    dim.flush(g, cam, F.dockTop, F.dockSide, F.dockFront, '', 1, q >= 2 ? 1 : 3);
    // 5. the consumption engine: lit bays, progress along each bay, the job's crate inside. A
    //    stress copy's slots are busy by a hash of (slot, 3 s); bays narrower than 6 px drop
    //    their rims and crates (LOD1).
    const lit = this.f.bA, rim = this.f.bB, prog = this.f.bC, crates = this.f.bD;
    const progRed: number[] = [];
    let selBay: Bay | null = null;
    st.bays = 0;
    const F_ = c.factor;
    for (const b of this.bays) {
      const gr = c.groups[b.group];
      const virtual = F_ > 1 && !b.pid && b.slot >= Math.round((gr?.slots ?? 0) / F_) && this.f.stress.busy(b.group, b.slot, t);
      if (!b.pid && !virtual) continue;
      if (offX(cam.x(b.u + b.du / 2, b.v + b.dv / 2))) continue;
      st.bays++;
      const p = b.pid ? w.pipelines.get(b.pid) : undefined;
      lit.add(b.u, b.v, b.du, b.dv, 0, ENG_H);
      rim.add(b.u, b.v, b.du, b.dv, 0, ENG_H);
      let u01: number, over = false;
      if (virtual) u01 = this.f.stress.progress(b.group, b.slot, t);
      else {
        const exp = p?.expected_ms ?? w.repos.get(p?.repo ?? '')?.p50_build_ms ?? w.stats.p50_build_ms ?? 0;
        const el = p?.started ? Math.max(0, now - p.started) : 0;
        u01 = exp > 0 ? clamp(el / exp, 0.03, 1) : 0.5;
        over = exp > 0 && el > exp * 1.5;
      }
      if (over) progRed.push(b.u, b.v + b.dv + 4, b.du * u01);
      else if (!virtual || q < 4) prog.add(b.u, b.v + b.dv + 4, b.du * u01, 5, 0, ENG_H);
      // the job's crate rides the bay with its progress
      crates.crate(b.u + 6 + (b.du - 12) * u01, b.v + b.dv / 2, Math.min(10, b.du * 0.8), ENG_H - 3);
      if (!virtual) {
        this.f.hit(cam.x(b.u, b.v + b.dv), cam.y(b.u, b.v, ENG_H) - 4, (b.du * 0.86 + b.dv * 0.4) * cam.s, (b.dv * 0.66 + b.du * 0.19) * cam.s + 10, 'pipeline', b.pid, pipeWords(p));
        if (this.f.selected === b.pid) selBay = b;
      }
    }
    const bayFine = (this.bays[0]?.du ?? 0) * cam.s >= 6;
    lit.flushQuads(g, cam, F.bayLit);
    if (bayFine) rim.flushQuads(g, cam, withAlpha(C.packet, 0.45 + 0.4 * breathe(t)), true, g.hair * 2); else rim.n = 0;
    prog.flushQuads(g, cam, C.packet);
    for (let i = 0; i < progRed.length; i += 3) prog.add(progRed[i], progRed[i + 1], progRed[i + 2], 5, 0, ENG_H);
    prog.flushQuads(g, cam, C.red);
    if (bayFine) crates.flush(g, cam, F.crateTop, F.crateSide, F.crateFront, '', 1, q >= 2 ? 1 : 3); else crates.n = 0;
    if (selBay) ring(cam, g, selBay.u + selBay.du / 2, selBay.v + selBay.dv / 2, 14, ENG_H);
    // gauges: the engines' cpu and mem towers (a sample every few seconds; a few boxes)
    this.drawGauges(g);
  }

  /** cpu and mem fill each machine's two towers (gray; a red cap over 90 %); no reading: the
   *  slots' utilization in a darker gray. */
  private drawGauges(g: Gfx): void {
    const cam = this.f.cam, c = this.f.census;
    const gauge = this.f.bA, util = this.f.bB, cap = this.f.bC;
    c.groups.forEach((gr, gi) => {
      const v0 = ENG_V0 + gi * ENG_STEP;
      const used = gr.slots ? gr.running.length / gr.slots : 0;
      const vals = [gr.cpu >= 0 ? gr.cpu : -1, gr.mem >= 0 ? gr.mem : -1];
      vals.forEach((val, k) => {
        const u0 = ENG_U1 + 12 + k * 13;
        if (val < 0) {
          if (k === 0) util.add(u0, v0 + 34, 9, 9, 2 + 60 * used);
          return;
        }
        const hh = 2 + 60 * clamp(val / 100, 0, 1);
        gauge.add(u0, v0 + 34, 9, 9, hh);
        if (val >= 90) cap.add(u0, v0 + 34, 9, 9, 0, hh);
      });
    });
    util.flush(g, cam, '#3E3E42', '#2C2C30', '#262629', '', 1, 3);
    gauge.flush(g, cam, '#9A9A9E', '#6A6A6E', '#58585C', '', 1, 3);
    cap.flushQuads(g, cam, C.red);
  }
}

/** The deploy tracks' traffic: deploys in flight sit on their track, nearer the city the longer
 *  they have run, a ring on the building they head for. */
export class Tracks implements Layer {
  readonly name = 'tracks';

  constructor(readonly f: Factory) {}

  live(g: Gfx, fr: LiveFrame): void {
    const cam = this.f.cam, w = this.f.world, c = this.f.census, q = fr.q, now = fr.now;
    // deploys in flight sit on their track, nearer the city the longer they have run
    const lanes = [0, 0, 0];
    const dep = this.f.bA;
    g.begin_();
    let rings = 0;
    for (const d of [...c.deploying].sort((a, b) => a.started - b.started)) {
      const b = this.f.blockAt.get(d.app);
      // the oldest leads; the ones behind it queue a crate's length back on the same track
      const k = clamp(Math.min((now - d.started) / 90_000, 0.92 - lanes[d.via]++ * 0.09), 0.05, 0.92);
      const v = TRACK_V[d.via];
      const u = SCAN_U + 16 + (TRACK_U1 - SCAN_U - 24) * k;
      dep.crate(u, v, 8);
      if (d.sha.charCodeAt(0) !== 126) this.f.hit(cam.x(u, v) - 7, cam.y(u, v, 8) - 7, 14, 14, 'commit', `${w.apps.get(d.app)?.repo ?? ''}@${d.sha}`, `deploy ${d.app}`);
      if (b) { g.circle(cam.x(b.u + b.d / 2, b.v + b.d / 2), cam.y(b.u + b.d / 2, b.v + b.d / 2, b.h + 1.5), 3.2); rings++; }
    }
    if (rings) g.stroke(withAlpha(C.packet, 0.9), 1);
    dep.flush(g, cam, F.crateTop, F.crateSide, F.crateFront, '', 1, q >= 2 ? 1 : 3);
  }
}
