// LIGHT PACKETS (w2-engine2, REVIEW-iter3 (D) WOW #1): the factory breathes along its real paths.
//
// On every 4th beat of the master clock (motion.ts), every lane that ran something in the last
// hour sends ONE light packet out of its dock, in its hue, along the route its newest run really
// took (drawer.ts `journeyPath`, read only): its dock and belt, the gate, its rail, the intake, the
// bay that ran it, the scanner, and on down its deploy track into its district. Brightness ∝ the
// lane's runs in the last hour (√, against the busiest lane). Passing the lane's main lines with a
// main red now, it FLARES red; if the run failed, it turns red at the scanner and drops down to the
// return conveyor into its failure's heap. 29 runs an hour ≈ ten packets; a busy morning a stream.
// You see which teams are shipping without reading a word.
//
// Cost: a pooled packet per lane (routes rebuilt once a launch, screen points once a camera move);
// a frame strokes one path per lane (its hue) and one for the packets' heads (two when one flares),
// and only while packets fly (2 s of every 4); the layer sleeps otherwise. None under a lens, a
// selection's journey, reduced motion, or the ladder's rungs ≥ 3.

import type { Pipeline } from '../wire.ts';
import type { Gfx } from '../yard/gfx.ts';
import { C, withAlpha } from '../yard/theme.ts';
import { heapsOf } from './clusters.ts';
import type { Factory } from './factory.ts';
import { floorGroups } from './groups.ts';
import { PLAN } from './layout.ts';
import { BEAT_MS } from './motion.ts';
import type { Layer, LiveFrame, Pt } from './types.ts';

const { RAIL_U0, RAIL_U1, SCAN_U, RETURN_V } = PLAN;

/** A packet leaves on every EVERY-th beat and travels for FLY_MS; each lane EASE_STAGGER ms after
 *  the one behind it (a ripple down the docks). */
export const EVERY = 4, FLY_MS = 2000, STAGGER_MS = 45, TRAIL_PX = 84, TAIL_MS = 320;
/** The run counted: created within the last hour. */
const HOUR = 3_600_000;
/** The flare: the head is red while it runs along the first FLARE_DU of its rail (the red posts
 *  stand there, red first) and the rail's last FLARE_DU (its end's tally). */
const FLARE_DU = 34;

type Packet = {
  lane: string; hex: string; alpha: number; flare: boolean; failed: boolean; delay: number;
  /** world route (u, v pairs) and screen points (x, y) with cumulative screen lengths */
  w: number[]; s: Float32Array; cum: Float32Array; n: number; total: number;
};

/** Where a failed run's packet stops: its failure's heap on the return conveyor (by member id),
 *  else just past the scanner's foot. */
export function cutAtHeap(route: Pt[], u: number): Pt[] {
  const out: Pt[] = [];
  for (let i = 0; i < route.length; i++) {
    const p = route[i]!;
    out.push(p);
    if (p[1] === RETURN_V && i > 0 && route[i - 1]![1] !== RETURN_V) { out.push([u, RETURN_V]); break; }
  }
  return out;
}

export class Packets implements Layer {
  readonly name = 'packets';
  private pool: Packet[] = [];
  private n = 0;
  private cycle = -1;
  private t0 = 0;
  private camVer = -1;
  /** For the HUD and the tests: packets in the air this frame. */
  flying = 0;

  constructor(readonly f: Factory) {}

  live(g: Gfx, fr: LiveFrame): boolean {
    const f = this.f;
    this.flying = 0;
    if (f.reduced || fr.q >= 3 || f.census.skeleton || f.lens.topLens || f.selected || !f.w2.on) return false;
    const bi = Math.floor(fr.t / BEAT_MS), cy = Math.floor(bi / EVERY);
    if (cy !== this.cycle && bi % EVERY === 0) { this.cycle = cy; this.t0 = bi * BEAT_MS; this.launch(fr.now); this.camVer = -1; }
    const el = fr.t - this.t0;
    if (!this.n || el < 0 || el > FLY_MS + TAIL_MS + STAGGER_MS * this.n) return false;
    if (this.camVer !== f.cam.ver) { this.camVer = f.cam.ver; for (let i = 0; i < this.n; i++) this.project(this.pool[i]!); }
    const heads: number[] = [], flares: number[] = [];
    for (let i = 0; i < this.n; i++) {
      const p = this.pool[i]!, e = el - p.delay;
      if (e < 0 || e > FLY_MS + TAIL_MS || p.total <= 0) continue;
      const k = Math.min(1, e / FLY_MS), ease = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
      const head = p.total * ease;
      const tail = Math.max(0, e > FLY_MS ? head - TRAIL_PX * (1 - (e - FLY_MS) / TAIL_MS) : head - TRAIL_PX);
      if (head - tail < 0.5) continue;
      this.flying++;
      // the trail: one path in the lane's hue
      g.begin_();
      this.trace(g, p, tail, head);
      g.stroke(withAlpha(p.hex, p.alpha), 2.4);
      // the head: white-hot, red where it flares (a red main on its rail, past the scanner when failed)
      const [hx, hy, hu, hv] = this.at(p, head);
      const red = (p.flare && hv !== RETURN_V && ((hu >= RAIL_U0 && hu <= RAIL_U0 + FLARE_DU) || (hu >= RAIL_U1 - FLARE_DU && hu <= RAIL_U1 + 4))) || (p.failed && (hu >= SCAN_U - 0.5 || hv >= RETURN_V - 0.5) && head > p.total * 0.5);
      (red ? flares : heads).push(hx, hy, p.alpha);
    }
    if (heads.length) { g.begin_(); for (let i = 0; i < heads.length; i += 3) g.rect(heads[i]! - 2, heads[i + 1]! - 2, 4, 4); g.fill(withAlpha(C.ink, 0.95)); }
    if (flares.length) { g.begin_(); for (let i = 0; i < flares.length; i += 3) g.rect(flares[i]! - 3, flares[i + 1]! - 3, 6, 6); g.fill(C.red); }
    return true;
  }

  /** A launch: each lane's newest run of the last hour, its route, its brightness. */
  private launch(now: number): void {
    const f = this.f, w = f.world, G = floorGroups();
    const newest = new Map<string, Pipeline>(), runs = new Map<string, number>();
    for (const p of w.pipelines.values()) {
      if (p.created < now - HOUR || p.created > now) continue;
      const lane = G.laneOfRepo(p.repo);
      runs.set(lane, (runs.get(lane) ?? 0) + 1);
      const q = newest.get(lane);
      if (!q || p.created > q.created) newest.set(lane, p);
    }
    let max = 1;
    for (const n of runs.values()) max = Math.max(max, n);
    const order = G.lanes().map((l) => l.id);
    const lanes = [...newest.keys()].sort((a, b) => order.indexOf(a) - order.indexOf(b));
    const jp = (f.drawer as unknown as { journeyPath(p: Pipeline | null): { pts: Pt[]; red: boolean } }).journeyPath.bind(f.drawer);
    const heaps = heapsOf(f.lens.parked) ?? [];
    this.n = 0;
    lanes.forEach((lane, i) => {
      const p = newest.get(lane)!;
      let route: Pt[];
      let failed = false;
      try {
        const r = jp(p);
        route = r.pts;
        failed = r.red;
      } catch { return; }
      if (route.length < 2) return;
      if (failed) {
        const h = heaps.find((x) => x.ids.includes(p.id ?? '')) ?? heaps.find((x) => x.repoList.includes(p.repo));
        route = cutAtHeap(route, h ? (h.u0 + h.u1) / 2 : SCAN_U - 22);
      }
      const pk = (this.pool[this.n] ??= { lane: '', hex: '', alpha: 1, flare: false, failed: false, delay: 0, w: [], s: new Float32Array(0), cum: new Float32Array(0), n: 0, total: 0 });
      pk.lane = lane; pk.hex = G.hex(lane); pk.failed = failed; pk.delay = i * STAGGER_MS;
      pk.alpha = 0.45 + 0.55 * Math.sqrt((runs.get(lane) ?? 0) / max);
      pk.flare = (G.stats(lane)?.redMains ?? 0) > 0;
      pk.w.length = 0;
      for (const [u, v] of route) pk.w.push(u, v);
      this.n++;
    });
  }

  /** A packet's screen points (at the floor, z 1) and cumulative lengths, for this camera. */
  private project(p: Packet): void {
    const cam = this.f.cam, m = p.w.length >> 1;
    if (p.s.length < m * 2) { p.s = new Float32Array(m * 2 + 8); p.cum = new Float32Array(m + 4); }
    let total = 0;
    for (let i = 0; i < m; i++) {
      const x = cam.x(p.w[2 * i]!, p.w[2 * i + 1]!), y = cam.y(p.w[2 * i]!, p.w[2 * i + 1]!, 1);
      if (i) total += Math.hypot(x - p.s[2 * i - 2]!, y - p.s[2 * i - 1]!);
      p.s[2 * i] = x; p.s[2 * i + 1] = y; p.cum[i] = total;
    }
    p.n = m; p.total = total;
  }

  /** The screen point at length `d` along the packet's route, and the world (u, v) there. */
  private at(p: Packet, d: number): [number, number, number, number] {
    let i = 1;
    while (i < p.n - 1 && p.cum[i]! < d) i++;
    const a = p.cum[i - 1]!, b = p.cum[i]!, t = b > a ? Math.min(1, Math.max(0, (d - a) / (b - a))) : 1;
    return [
      p.s[2 * i - 2]! + (p.s[2 * i]! - p.s[2 * i - 2]!) * t, p.s[2 * i - 1]! + (p.s[2 * i + 1]! - p.s[2 * i - 1]!) * t,
      p.w[2 * i - 2]! + (p.w[2 * i]! - p.w[2 * i - 2]!) * t, p.w[2 * i - 1]! + (p.w[2 * i + 1]! - p.w[2 * i - 1]!) * t,
    ];
  }

  /** The route from length `a` to `b` into the current path. */
  private trace(g: Gfx, p: Packet, a: number, b: number): void {
    const [x0, y0] = this.at(p, a);
    g.move(x0, y0);
    for (let i = 1; i < p.n; i++) { const c = p.cum[i]!; if (c <= a) continue; if (c >= b) break; g.line(p.s[2 * i]!, p.s[2 * i + 1]!); }
    const [x1, y1] = this.at(p, b);
    g.line(x1, y1);
  }
}
