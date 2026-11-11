// Crates in motion (fab-w0, from factory.ts): every event's token riding its route across the
// floor (a push from its dock, a run from the intake to its bay, a failure home along the return
// conveyor, a deploy into the city), the stress mode's synthesized ones, the trains the ladder
// folds them into, the failures named as they ride home; and the reactions each crate sets off
// where and when it ARRIVES (motion.ts ripples: rings, the scanner's beam, a dock's door).
//
// The layers that own a route send its crates (`spawn`) and schedule its reactions
// (`reactions.rp.add`) from their `onEvent`; this module moves and draws them.

import type { Gfx } from '../yard/gfx.ts';
import { times } from '../yard/gfx.ts';
import { C, clamp, withAlpha } from '../yard/theme.ts';
import { TrainTable } from './batch.ts';
import type { Factory } from './factory.ts';
import { PLAN } from './layout.ts';
import { R_BEAM, R_DOOR, Ripples, arrival } from './motion.ts';
import { F, SMALL, easeInOut, poly, quad } from './prims.ts';
import type { Crate, Layer, LiveFrame, Pt } from './types.ts';

const {
  DOCK_U0, DOCK_U1, COLLECT_U, AISLE_V, YARD_U1, ROW_U, AGE_V, GATE_U, RAIL_U0, RAIL_U1, RAIL_V, INTAKE_U0, INTAKE_U1,
  LANE_V, DIST_U, ENG_U0, ENG_U1, ENG_V0, ENG_STEP, ENG_DV, SCAN_U, TRACK_V, TRACK_U1, CITY_U0, RETURN_V,
} = PLAN;

/** A crate's wake on its belt: a step lighter than the slats. */
const cr0Wake = '#38383E';

export class Crates implements Layer {
  readonly name = 'crates';
  /** The crates in flight, oldest first. */
  list: Crate[] = [];
  /** Crates whose position this frame computed (the cost model's packets). */
  computed = 0;
  private trains = new TrainTable();
  private routeIds = new Map<string, number>();
  private pt = new Float32Array(2);
  private top = new Int32Array(16);

  constructor(readonly f: Factory) {}

  /** At most 160 in flight: an event drops the oldest beyond that. */
  cap(): void {
    if (this.list.length > 160) this.list.splice(0, this.list.length - 160);
  }

  spawn(id: string, kind: Crate['kind'], route: Pt[], t: number, dur: number, red: boolean, label: string, org: string): Crate {
    const cum = [0];
    let len = 0;
    for (let i = 1; i < route.length; i++) { len += Math.hypot(route[i][0] - route[i - 1][0], route[i][1] - route[i - 1][1]); cum.push(len); }
    // a crate waits its turn on the same route start so bursts read as a line, not a blob
    let hold = 0;
    for (const c of this.list) if (c.route[0][0] === route[0][0] && c.route[0][1] === route[0][1] && t - c.t0 < 400) hold = Math.max(hold, c.t0 + 260 - t);
    const cr: Crate = { id, kind, route, len, cum, t0: t + Math.max(0, hold), dur, red, label, org, hold: 0, rid: -1 };
    this.list.push(cr);
    return cr;
  }

  /** When crate `cr` reaches its route's point `k` (the frame clock). */
  arrives(cr: Crate, k: number): number {
    const i = Math.min(k, cr.cum.length - 1);
    return cr.t0 + cr.dur * arrival(cr.len ? cr.cum[i] / cr.len : 1);
  }

  /** Has the crate passed the scanner (a failure turns red there)? */
  pastScanner(cr: Crate, u: number): boolean {
    const [cu] = this.along(cr, easeInOut(u));
    return cu <= SCAN_U + 1 && this.along(cr, easeInOut(u))[1] > cr.route[0][1] + 2 || cu < SCAN_U - 2 && cr.route[0][0] > SCAN_U - 60;
  }

  /** The floor point a fraction `u` of the way along the crate's route. */
  along(cr: Crate, u: number): Pt {
    const d = u * cr.len;
    let i = 1;
    while (i < cr.cum.length - 1 && cr.cum[i] < d) i++;
    const a = cr.route[i - 1], b = cr.route[i];
    const seg = cr.cum[i] - cr.cum[i - 1] || 1;
    const k = clamp((d - cr.cum[i - 1]) / seg, 0, 1);
    return [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k];
  }

  live(g: Gfx, fr: LiveFrame): boolean { return this.draw(g, fr.t, fr.q); }

  /** Real crates (events in flight) and, in stress mode, the synthesized ones. Returns whether
   *  any real crate is still travelling (or waiting to). One path per face and colour; on the
   *  ladder's train rungs, crates on the same stretch of the same route ride as one with a ×N
   *  badge. */
  private draw(g: Gfx, t: number, q: number): boolean {
    const f = this.f, cam = f.cam, st = f.stat;
    const amber = f.bA, red = f.bB;
    const trains = q >= 3;
    const tt = this.trains;
    tt.reset();
    // a train's stretch: 32 units on the trains rung, 56 on survival
    const bin = q >= 4 ? 56 : 32;
    let moving = false, crates = 0, sprites = 0;
    this.computed = 0;
    // the wake: the belt brightens under each travelling crate, a short stretch behind it
    if (q < 3 && !f.reduced) {
      g.begin_();
      let any = false;
      for (const cr of this.list) {
        const u = (t - cr.t0) / cr.dur;
        if (u < 0 || u > 1 || !cr.len) continue;
        const d = easeInOut(u) * cr.len;
        for (let k = 0; k < 4; k++) {
          const [wu, wv] = this.along(cr, Math.max(0, d - k * 9) / cr.len);
          const x = cam.x(wu, wv), y = cam.y(wu, wv, 0.7);
          if (k) g.line(x, y); else g.move(x, y);
        }
        any = true;
      }
      if (any) { g.ctx.lineCap = 'round'; g.ctx.lineJoin = 'round'; g.stroke(cr0Wake, Math.max(2, 5 * cam.s)); g.ctx.lineCap = 'butt'; }
    }
    for (let i = this.list.length - 1; i >= 0; i--) {
      const cr = this.list[i];
      const u = (t - cr.t0) / cr.dur;
      if (u > 1) { this.list.splice(i, 1); continue; }
      moving = true;
      if (u < 0) continue;
      crates++;
      const e = easeInOut(u);
      const [cu, cv] = this.along(cr, e);
      const isRed = cr.red && (cr.route.length < 4 || this.pastScanner(cr, u));
      const x = cam.x(cu, cv), y = cam.y(cu, cv);
      if (x < -20 || x > cam.W + 20 || y < -20 || y > cam.H + 20) continue;
      f.hit(x - 7, cam.y(cu, cv, 8) - 7, 14, 14, cr.kind === 'pipeline' ? 'pipeline' : 'commit', cr.id, cr.label || cr.id);
      if (trains) { if (!tt.add(this.routeId(cr) * 4096 + Math.floor((e * cr.len) / bin), cu, cv, isRed)) (isRed ? red : amber).crate(cu, cv, 8); }
      else { (isRed ? red : amber).crate(cu, cv, 8); sprites++; }
    }
    // stress: STRESS_CRATES more on the floor's routes, a pure function of (route, index, time)
    let sc = 0;
    if (f.stress.on && !f.reduced) {
      this.stressRoutes();
      const S = f.stress, pt = this.pt;
      // survival computes every 4th crate and counts it 4 times (the trains' sizes hold)
      const stride = q >= 4 ? 4 : 1;
      for (let ri = 0; ri < S.routes.length; ri++) {
        const r = S.routes[ri];
        for (let i = 0; i < r.n; i += stride) {
          const d = S.dist(r, ri, i, t);
          S.at(r, d, pt);
          sc += stride;
          this.computed++;
          const x = cam.x(pt[0], pt[1]);
          if (x < -20 || x > cam.W + 20) continue;
          const y = cam.y(pt[0], pt[1]);
          if (y < -20 || y > cam.H + 20) continue;
          if (trains) { for (let k = 0; k < stride; k++) tt.add((1000 + ri) * 4096 + Math.floor(d / bin), pt[0], pt[1], r.red); }
          else { (r.red ? red : amber).crate(pt[0], pt[1], 8); sprites++; }
        }
      }
    }
    // the trains: one crate leads each, the biggest get a ×N badge
    let nTrains = 0;
    const badges = this.top;
    let nb = 0;
    if (trains) {
      const cap = q >= 4 ? 60 : Infinity;
      const K = q >= 4 ? 6 : 12;
      for (let j = 0; j < tt.nUsed; j++) {
        const h = tt.used[j];
        if (sprites >= cap) break;
        (tt.red[h] ? red : amber).crate(tt.u[h], tt.v[h], 8);
        sprites++;
        nTrains++;
        if (tt.count[h] < 2) continue;
        // keep the K biggest (insertion into a short sorted list)
        let k: number;
        if (nb < K) k = nb++;
        else if (tt.count[h] > tt.count[badges[K - 1]]) k = K - 1;
        else continue;
        badges[k] = h;
        while (k > 0 && tt.count[badges[k - 1]] < tt.count[badges[k]]) { const s = badges[k - 1]; badges[k - 1] = badges[k]; badges[k] = s; k--; }
      }
    }
    const faces = q >= 2 ? 1 : 3;
    amber.flush(g, cam, F.crateTop, F.crateSide, F.crateFront, '', 1, faces);
    red.flush(g, cam, F.redTop, F.redSide, F.redFront, '', 1, faces);
    for (let k = 0; k < nb; k++) {
      const h = badges[k];
      const x = cam.x(tt.u[h], tt.v[h]) + 6, y = cam.y(tt.u[h], tt.v[h], 8) - 3;
      g.text(times(tt.count[h]), x, y, tt.red[h] ? C.redText : C.amberText, SMALL);
    }
    st.crates = crates;
    st.stressCrates = sc;
    st.sprites = sprites;
    st.trains = nTrains;
    return moving;
  }

  /** Failures riding home are named (failure is the main character), under the conveyor; drawn
   *  over the lens and the journey. */
  tags(g: Gfx, t: number, q: number): void {
    const cam = this.f.cam;
    let tags = 0;
    for (const cr of this.list) {
      if (!cr.red || !cr.label) continue;
      if (q >= 4 && tags >= 3) break;
      const u = (t - cr.t0) / cr.dur;
      if (u < 0 || u > 1 || !this.pastScanner(cr, u)) continue;
      const [cu, cv] = this.along(cr, easeInOut(u));
      const x = cam.x(cu, cv), y = cam.y(cu, cv);
      if (cv < RETURN_V - 4) continue;
      g.vline(x, y + 4, y + 16, withAlpha(C.red, 0.6));
      this.f.words.tag(g, cr.label, x - 4, y + 28, C.redText, C.red);
      tags++;
    }
  }

  /** A crate's route as a small integer (the trains' key): routes repeat (a dock's belt, a rail). */
  private routeId(cr: Crate): number {
    if (cr.rid >= 0) return cr.rid;
    const k = cr.route.map((p) => `${Math.round(p[0])},${Math.round(p[1])}`).join(' ');
    let id = this.routeIds.get(k);
    if (id === undefined) { id = this.routeIds.size % 4000; if (this.routeIds.size > 4000) this.routeIds.clear(); this.routeIds.set(k, id); }
    cr.rid = id;
    return id;
  }

  /** Stress mode's routes: the floor's real ones (each dock's belt to the yard, the gate onto
   *  each rail, each rail to the intake, the intake to each machine, each machine through the
   *  scanner, the deploy tracks into the city, and the return conveyor), weighted by flow. */
  private stressRoutes(): void {
    const c = this.f.census;
    const key = `${c.docks.length}|${c.rails.length}|${c.groups.length}`;
    const list: [number, number][][] = [], wts: number[] = [], red: boolean[] = [];
    const add = (pts: [number, number][], wt: number, isRed = false) => { list.push(pts); wts.push(wt); red.push(isRed); };
    c.docks.forEach((_d, i) => {
      const dv = 66 + i * 96;
      add([[DOCK_U1 - 6, dv], [COLLECT_U, dv], [COLLECT_U, AISLE_V], [ROW_U[1], AISLE_V], [ROW_U[1], AGE_V[0]]], 3);
    });
    c.rails.forEach((_r, i) => {
      add([[COLLECT_U, AISLE_V], [YARD_U1, AISLE_V], [GATE_U + 10, AISLE_V], [RAIL_U0 + 10, RAIL_V[i]], [RAIL_U1 - 10, RAIL_V[i]]], 3);
      add([[RAIL_U1 - 10, RAIL_V[i]], [RAIL_U1 + 12, RAIL_V[i]], [INTAKE_U0, LANE_V[i % 2]], [INTAKE_U1 - 8, LANE_V[i % 2]]], 1.5);
    });
    c.groups.forEach((_g, gi) => {
      const v = ENG_V0 + gi * ENG_STEP + ENG_DV / 2;
      add([[INTAKE_U1 - 6, LANE_V[gi % 2]], [DIST_U, LANE_V[gi % 2]], [DIST_U, v], [ENG_U0 + 10, v]], 2);
      add([[ENG_U1 - 10, v], [ENG_U1 + 6, v], [SCAN_U, v], [SCAN_U + 14, v]], 2);
    });
    TRACK_V.forEach((v) => add([[SCAN_U + 14, v], [TRACK_U1, v], [CITY_U0 - 4, v]], 1.5));
    add([[SCAN_U, RETURN_V], [24, RETURN_V], [24, 66], [DOCK_U0 + 8, 66]], 4, true);
    this.f.stress.setRoutes(key, list, wts, red);
  }
}

/** The reactions (motion.ts ripples) each crate sets off where it arrives: rings, the scanner's
 *  beam, a dock's door; true while one still shows. */
export class Reactions implements Layer {
  readonly name = 'reactions';
  /** Reactions scheduled for when a crate arrives (motion.ts). */
  readonly rp = new Ripples();

  constructor(readonly f: Factory) {}

  live(g: Gfx, fr: LiveFrame): boolean {
    const cam = this.f.cam, t = fr.t, q = fr.q;
    const offX = (x: number) => x < -24 || x > cam.W + 24;
    const offY = (y: number) => y < -24 || y > cam.H + 24;
    let pulsing = false;
    const Rp = this.rp;
    for (let i = 0; i < Rp.dur.length; i++) {
      const d = Rp.dur[i];
      if (!d) continue;
      const age = t - Rp.at[i];
      if (age > d) continue;
      pulsing = true;
      if (age < 0 || q >= 4) continue;
      const e = age / d;
      const col = Rp.red[i] ? C.red : Rp.green[i] ? C.green : C.packet;
      const u = Rp.u[i], v = Rp.v[i], zz = Rp.z[i];
      if (Rp.kind[i] === R_BEAM) {
        g.begin_(); quad(cam, g, SCAN_U - 1, 36, SCAN_U + 1, 594, 54); g.fill(withAlpha(col, 0.55 * (1 - e)));
        g.begin_(); g.circle(cam.x(u, v), cam.y(u, v, zz * 0.5), 4 + 10 * e); g.stroke(withAlpha(col, 0.7 * (1 - e)), 1.2);
      } else if (Rp.kind[i] === R_DOOR) {
        g.begin_(); poly(cam, g, [DOCK_U1, v - 12, 1, DOCK_U1, v + 12, 1, DOCK_U1, v + 12, 10, DOCK_U1, v - 12, 10]); g.fill(withAlpha(col, 0.85 * (1 - e)));
      } else {
        const x = cam.x(u, v), y = cam.y(u, v, zz);
        if (offX(x) || offY(y)) continue;
        g.begin_(); g.circle(x, y, 3 + e * 18 * Math.max(0.8, cam.s)); g.stroke(withAlpha(col, 0.8 * (1 - e)), 1.2);
      }
    }
    return pulsing;
  }
}
