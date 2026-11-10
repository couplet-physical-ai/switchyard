// The yard (DESIGN.md, "Layout of the Yard", "Rendering"): three canvas layers over one scene.
//
//   yardStatic  wires, machines, port tabs, the bus, the return wire: redrawn only when the
//               layout changes (a resize, the fleet's shape, the rows picked), at low detail
//               on the bottom rungs of the quality ladder.
//   yardInfo    panels of text and data (info.ts), each redrawn only when what it shows changed.
//   yardLive    every frame: packets (pooled, fixed-step, trains), progress rings, effects,
//               labels, the dial, the hover lens (an element promoted to LOD0), the HUD.
//
// `Yard` owns the scene, the LOD book, the frame budget, the packet pool and the aggregates,
// and keeps them in step with the world.

import type { Ctx2D, Frame } from '../../app.contract.d.ts';
import type { Pipeline } from '../wire.ts';
import type { World } from '../world.ts';
import type { Timeline } from '../timeline.ts';
import { Budget, type Quality } from './budget.ts';
import { Gfx, machine, port, times } from './gfx.ts';
import { Hud } from './hud.ts';
import { InfoLayer, type View, fmtDur, fmtShort, mainLine } from './info.ts';
import { type Leg, type Scene, census, engineGroups, enginesOf, layout, scaleFor } from './layout.ts';
import { LodBook } from './lod.ts';
import { E_FLASH, E_POP, E_PORT, E_PULSE, Pool, ST_RET, ST_SLOT, T_AMBER, T_GRAY, T_GREEN, T_RED, engineOf } from './pool.ts';
import { Aggregates, buildingIds, isRed, mainStory, queueTruth } from './select.ts';
import { StressFleet } from './stress.ts';
import { C, T, TAU, clamp, easeOut, withAlpha } from './theme.ts';

export type Hit = { kind: string; id: string; label: string };

const TINTS = [C.packet, C.red, C.green, C.dotDim];
const PICKS_MS = 8000;
const BUCKETS = 4096;

export class Yard {
  readonly lod = new LodBook();
  readonly budget = new Budget();
  readonly pool = new Pool();
  readonly agg = new Aggregates();
  readonly stress = new StressFleet();
  readonly hud = new Hud();
  readonly info = new InfoLayer();
  private gs = new Gfx();
  private gi = new Gfx();
  private gl = new Gfx();
  private gt = new Gfx();
  S: Scene | null = null;
  private sceneSig = '';
  private picks: string[] = [];
  private picksAt = -1e9;
  private picksFresh = -1;
  private laneSig = '';
  private laneSigVer = -1;
  private lastW = 0;
  private lastH = 0;
  private lastScale = 1;
  focus: Pipeline | null = null;
  private focusId = '';
  private focusSince = 0;
  private focusAt = -1e9;
  selected = '';
  offsetMin = 0;
  reduced = false;
  private stressWanted = false;
  // hover lens
  hover: Hit & { x: number; y: number; t0: number } = { kind: '', id: '', label: '', x: 0, y: 0, t0: 0 };
  private lens: Hit & { x: number; y: number; t0: number; out: number } = { kind: '', id: '', label: '', x: 0, y: 0, t0: 0, out: 0 };
  // stats
  private infoCount = 0;
  private infoSec = 0;
  infoRate = 0;
  trains = 0;
  private staticQ = -1;
  private pt = { x: 0, y: 0 };
  // trains (per frame, zero allocation)
  private bKey = new Int32Array(BUCKETS); private bGen = new Int32Array(BUCKETS); private bCount = new Int32Array(BUCKETS);
  private bLead = new Int32Array(BUCKETS); private bX = new Float32Array(BUCKETS); private bY = new Float32Array(BUCKETS);
  private bTint = new Uint8Array(BUCKETS); private bUsed = new Int32Array(BUCKETS); private nUsed = 0; private gen = 1;
  private placed = new Float32Array(4 * 8);
  private top = new Int32Array(16);
  private unknown = new Float32Array(512);

  constructor(public tl: Timeline) {}

  get world(): World { return this.tl.world; }

  setStress(on: boolean): void { this.stressWanted = on; }

  // ---- the scene ------------------------------------------------------------------------------
  /** The scene for a canvas of W×H at `scale`, rebuilt only when something it depends on moved. */
  ensure(W: number, H: number, scale: number, t: number): Scene {
    const w = this.world;
    if (W > 0) { this.lastW = W; this.lastH = H; this.lastScale = scale; }
    W = this.lastW || 1440; H = this.lastH || 860; scale = this.lastScale || 1;
    const first = !this.S;
    this.agg.update(w);
    this.agg.pump(first);
    if (this.stressWanted !== this.stress.on) {
      this.stress.on = this.stressWanted;
      if (!this.stress.on) { this.stress.clear(); this.pool.setStress(false, t); }
      this.sceneSig = '';
    }
    if (w.kv.engine !== this.laneSigVer) {
      this.laneSigVer = w.kv.engine;
      this.laneSig = enginesOf(w).map((e) => `${e.id}:${e.slots}:${e.online === false ? 0 : 1}:${e.host ?? ''}`).join(',');
    }
    const ra = this.agg.repos;
    if (t - this.picksAt > PICKS_MS || ra.fresh !== this.picksFresh || !this.picks.length) {
      this.picks = ra.ranked.slice(0, 120);
      this.picksAt = t;
      this.picksFresh = ra.fresh;
    }
    const sig = `${W}|${H}|${scale}|${w.shapeVer}|${ra.ver}|${this.agg.apps.ver}|${this.picksAt}|${this.laneSig}|${this.stress.on ? 1 : 0}|${this.lod.histogram.length}`;
    if (sig !== this.sceneSig || !this.S) {
      this.sceneSig = sig;
      const c = census(w, ra, this.agg.apps, this.stress.on ? this.stress : null);
      const S = layout(W, H, scale, c, this.lod, this.picks, t);
      this.S = S;
      this.lod.histogram = S.hist;
      const p = this.pool;
      p.S = S;
      p.repoIndex.clear();
      ra.ids.forEach((id, i) => p.repoIndex.set(id, i));
      p.appIndex.clear();
      this.agg.apps.ids.forEach((id, i) => p.appIndex.set(id, i));
      p.reseat(w, true);
      if (this.stress.on) { p.buildJourneys(); p.setStress(true, t); }
    }
    return this.S!;
  }

  /** Called when the world was replaced or jumped: packets re-seat without travel. */
  sync(t: number): void {
    if (!this.S) this.ensure(0, 0, 1, t);
    this.pool.sync(this.world, t);
  }

  private pickFocus(w: World, now: number, t: number): Pipeline | null {
    if (t - this.focusAt < 400 && (this.focus || !w.pipelines.size)) return this.focus;
    this.focusAt = t;
    const sel = this.selected ? w.pipelines.get(this.selected) : undefined;
    if (sel) return (this.focus = sel);
    // Failure is the main character: the newest red on a main line (last 10 minutes) takes NOW,
    // with its failing step and culprit, until a newer one comes or it ages out.
    let red: Pipeline | null = null;
    for (const p of w.pipelines.values()) {
      if ((p.state !== 'failure' && p.state !== 'error') || !p.finished || now - p.finished > 600_000 || p.finished > now) continue;
      if (p.event === 'pull_request' || p.branch !== (w.repos.get(p.repo)?.default_branch ?? 'main')) continue;
      if (!red || p.finished > (red.finished ?? 0)) red = p;
    }
    if (red) { this.focusId = red.id ?? ''; this.focusSince = now; return (this.focus = red); }
    const cur = w.pipelines.get(this.focusId);
    const fresh = cur && (cur.state === 'running' || now - (cur.finished ?? now) < 4000);
    if (fresh && now - this.focusSince < 9000) return (this.focus = cur!);
    const building = buildingIds(w);
    let best: Pipeline | null = null, score = -1e18;
    for (const id of building) {
      const p = w.pipelines.get(id);
      if (!p || id === this.focusId) continue;
      const heat = w.repos.get(p.repo)?.heat ?? 0;
      const s = heat * 10 + (p.workflows?.[0]?.steps?.length ?? 0) * 0.3 - (now - (p.started ?? now)) / 60000;
      if (s > score) { score = s; best = p; }
    }
    if (best) { this.focusId = best.id ?? ''; this.focusSince = now; return (this.focus = best); }
    if (cur) return (this.focus = cur);
    // Nothing building: the most recently finished pipeline.
    let last: Pipeline | null = null;
    for (const p of w.pipelines.values()) if (p.finished && (!last || p.finished > (last.finished ?? 0))) last = p;
    return (this.focus = last);
  }

  view(t: number): View {
    const S = this.S!;
    return { w: this.world, S, tl: this.tl, agg: this.agg, lod: this.lod, stress: this.stress, t, now: this.tl.playhead, q: this.budget.quality, offsetMin: this.offsetMin, focus: this.focus };
  }

  // ---- layers ------------------------------------------------------------------------------------
  drawStatic(ctx: Ctx2D, f: Frame, t: number): void {
    const S = this.ensure(f.width, f.height, f.scale, t);
    const g = this.gs;
    g.begin(ctx, f.scale * S.k);
    if (f.cause === 'font') g.resetFonts();
    ctx.resetTransform();
    ctx.clearRect(0, 0, f.width, f.height);
    if (S.k !== 1) ctx.setTransform(S.k, 0, 0, S.k, 0, 0);
    this.staticQ = this.budget.quality;
    drawStatic(g, S, this.budget.quality >= 3);
  }

  drawInfo(ctx: Ctx2D, f: Frame, t: number): boolean {
    const S = this.ensure(f.width, f.height, f.scale, t);
    const g = this.gi;
    g.begin(ctx, f.scale * S.k);
    if (f.cause === 'font') g.resetFonts();
    if (S.k !== 1) ctx.setTransform(S.k, 0, 0, S.k, 0, 0); else ctx.resetTransform();
    this.pickFocus(this.world, this.tl.playhead, t);
    const full = f.cause === 'mount' || f.cause === 'size' || f.cause === 'font' || f.cause === 'style';
    const more = this.info.draw(g, this.view(t), full);
    const sec = Math.floor(t / 1000);
    if (sec !== this.infoSec) { this.infoRate = this.infoCount; this.infoCount = 0; this.infoSec = sec; }
    this.infoCount++;
    this.lastInfoCost = this.budget.estimate(g.ops, g.arcs, g.texts, 0);
    return more;
  }
  private lastInfoCost = 0;
  /** The last info-layer redraw's estimated cost (ms), for the HUD. */
  infoMs = 0;

  /** True while the static layer was drawn at another detail than the ladder now asks. */
  get staticStale(): boolean {
    return this.staticQ >= 0 && (this.staticQ >= 3) !== (this.budget.quality >= 3);
  }

  drawLive(ctx: Ctx2D, f: Frame, t: number): boolean {
    const interval = this.budget.tick(t);
    const S = this.ensure(f.width, f.height, f.scale, t);
    const w = this.world;
    const g = this.gl;
    g.begin(ctx, f.scale * S.k);
    if (f.cause === 'font') g.resetFonts();
    ctx.resetTransform();
    ctx.clearRect(0, 0, f.width, f.height);
    if (S.k !== 1) ctx.setTransform(S.k, 0, 0, S.k, 0, 0);
    const p = this.pool;
    p.reduced = this.reduced;
    p.update(t, w);
    this.pickFocus(w, this.tl.playhead, t);
    const q = this.budget.quality;
    const paused = this.tl.mode === 'paused';
    this.rings(g, S, w, q, t, paused);
    const drawn = this.packets(g, S, q, t, paused);
    if (q < 4) this.effects(g, t);
    this.nowBob(g, t, paused);
    this.dial(g, S, t);
    if (this.tl.mode === 'replay') this.strip(g, S);
    // the cost of this frame (plus the info layer's, when it redrew this frame)
    // The info layer is a cache: its redraw is a one-off rebuild (mount, resize, new data), a
    // hitch rather than a load, so it is shown in the HUD but never steps the ladder down.
    // Only when it redraws often (over 8 times a second) does it count, averaged.
    const est = this.budget.estimate(g.ops, g.arcs, g.texts, drawn) + (this.infoRate > 8 ? this.lastInfoCost * Math.min(1, this.infoRate / 60) : 0);
    if (this.lastInfoCost) this.infoMs = this.lastInfoCost;
    this.lastInfoCost = 0;
    this.budget.record(est + this.lastTopCost, g.ops, g.texts, interval, (qq) => this.predict(qq, est, q));
    this.lastTopCost = 0;
    return true;
  }
  private lastTopCost = 0;

  /** The overlay over the info layer: the hover lens (an element promoted to LOD0) and the
   *  HUD. It animates only while a lens shows or fades, or the HUD is on. */
  drawTop(ctx: Ctx2D, f: Frame, t: number): boolean {
    const S = this.ensure(f.width, f.height, f.scale, t);
    const g = this.gt;
    g.begin(ctx, f.scale * S.k);
    if (f.cause === 'font') g.resetFonts();
    ctx.resetTransform();
    ctx.clearRect(0, 0, f.width, f.height);
    if (S.k !== 1) ctx.setTransform(S.k, 0, 0, S.k, 0, 0);
    const lensOn = this.drawLens(g, S, t);
    const p = this.pool;
    this.hud.draw(g, S.W, S.H, {
      budget: this.budget, hist: this.lod.histogram, live: p.nAct, real: p.real, pooled: p.pooled, trains: this.trains,
      infoDraws: this.infoRate, infoMs: this.infoMs, stress: this.stress.on, host: this.budget.host, scale: S.k, sceneW: S.W, sceneH: S.H,
    });
    this.lastTopCost = this.budget.estimate(g.ops, g.arcs, g.texts, 0);
    return lensOn || this.hud.on || this.hover.kind !== '';
  }

  /** The estimate at quality qq, from this frame's at q: packets are most of the difference. */
  private predict(qq: Quality, est: number, q: Quality): number {
    const n = this.pool.nAct;
    const per = this.budget.host === 'hermes' ? [0.03, 0.022, 0.006, 0, 0] : [0.008, 0.006, 0.0015, 0, 0];
    const sprites = (lv: number) => (lv >= 3 ? Math.min(n, this.trains || n) : n);
    const cost = (lv: number) => sprites(lv) * (per[lv] || per[2]) * (lv >= 3 ? 1 : 1);
    return Math.max(0, est - cost(q) + cost(qq));
  }

  // ---- live: rings ---------------------------------------------------------------------------------
  private rings(g: Gfx, S: Scene, w: World, q: Quality, t: number, paused: boolean): void {
    if (S.engines.lod >= 2) return;
    const now = this.tl.playhead;
    const building = buildingIds(w);
    const fallback = w.stats.p50_build_ms || 0;
    g.begin_();
    let anyTrack = false, anySpin = false;
    const unknown = this.unknown;
    let nUnknown = 0;
    void t; void paused;
    for (const lane of S.engines.lanes) {
      if (lane.virtual) continue;
      for (const id of lane.engines) {
        const e = w.engines.get(id) ?? enginesOf(w).find((x) => x.id === id);
        const slots = S.engines.slotByEngine.get(id);
        if (!e || !slots) continue;
        let k = 0;
        for (const pid of e.running) {
          if (!building.has(pid)) continue;
          const s = slots[Math.min(k++, slots.length - 1)];
          const pl = w.pipelines.get(pid);
          const exp = pl?.expected_ms ?? w.repos.get(pl?.repo ?? '')?.p50_build_ms ?? fallback;
          const el = pl?.started ? Math.max(0, now - pl.started) : 0;
          const r = s.r + 2.5;
          if (exp > 0) { const u = clamp(el / exp, 0.02, 0.98); g.arc(s.x, s.y, r, -Math.PI / 2, -Math.PI / 2 + u * TAU); anyTrack = true; }
          else { unknown[nUnknown++] = s.x; unknown[nUnknown++] = s.y; anySpin = true; }
        }
      }
    }
    if (anyTrack) g.stroke(C.packet, lane0(S) ? 1.5 : 1.2);
    // No typical duration known: a still dashed ring (motion is kept for events).
    if (anySpin) {
      g.begin_();
      for (let k = 0; k < nUnknown; k += 2) g.circle(unknown[k], unknown[k + 1], 7.5);
      g.dash(true, 2, 2.5); g.stroke(withAlpha(C.packet, 0.7), 1.2); g.dash(false);
    }
    if (q <= 1 && anyTrack) {
      g.begin_();
      for (const lane of S.engines.lanes) for (const s of lane.slots) if (!lane.offline) g.circle(s.x, s.y, s.r + 2.5);
      g.stroke(withAlpha(C.packet, 0.1), 1);
    }
  }

  // ---- live: packets --------------------------------------------------------------------------------
  /** Draws the packets at the ladder's level; returns how many sprites it drew. */
  private packets(g: Gfx, S: Scene, q: Quality, t: number, paused: boolean): number {
    const p = this.pool;
    const a = p.alpha;
    const W = S.W, H = S.H;
    const hideSlots = S.engines.lod >= 1;
    const pt = this.pt;
    let drawn = 0;
    if (paused) g.alpha(0.5);
    if (q >= 3) {
      drawn = this.drawTrains(g, S, q, t);
    } else {
      // one path per colour (instancing): docked amber is dim, amber in motion is full, so
      // brightness means something is happening now. Fading packets go one by one below.
      for (let pass = 0; pass < 5; pass++) {
        const tint = pass === 4 ? T_AMBER : pass;
        const docked = pass === 4;
        const col = docked ? C.packetDock : TINTS[tint];
        if (q <= 1) g.begin_(); else g.setFill(col);
        let any = false;
        for (let k = 0; k < p.nAct; k++) {
          const i = p.act[k];
          if (p.tint[i] !== tint) continue;
          if (tint === T_AMBER && !(p.flags[i] & 4) && p.moving(i) === docked) continue;
          const stress = (p.flags[i] & 4) !== 0;
          if (stress) { const dd = p.d[i] >= p.dPrev[i] ? p.dPrev[i] + (p.d[i] - p.dPrev[i]) * a : p.d[i]; p.at(i, dd, pt); }
          else {
            if (hideSlots && p.st[i] === ST_SLOT && !(p.flags[i] & 8)) continue;
            pt.x = p.px[i] + (p.x[i] - p.px[i]) * a; pt.y = p.py[i] + (p.y[i] - p.py[i]) * a;
          }
          if (pt.x < -10 || pt.y < -10 || pt.x > W + 10 || pt.y > H + 10) continue; // culled
          if (!stress && (p.die[i] || t - p.born[i] < 200)) continue; // fading: below
          if (q <= 1) g.rrect(pt.x - 4.5, pt.y - 3, 9, 6, 1.5); else g.cell(pt.x - 4.5, pt.y - 3, 9, 6);
          any = true;
          drawn++;
        }
        if (q <= 1 && any) g.fill(col);
      }
      // fading in or out: alpha per packet (few at a time)
      for (let k = 0; k < p.nAct; k++) {
        const i = p.act[k];
        if (p.flags[i] & 4) continue;
        const fade = p.die[i] ? clamp(1 - (t - p.die[i]) / 600, 0, 1) : t - p.born[i] < 200 ? clamp((t - p.born[i]) / 200, 0, 1) : 1;
        if (fade >= 1) continue;
        pt.x = p.px[i] + (p.x[i] - p.px[i]) * a; pt.y = p.py[i] + (p.y[i] - p.py[i]) * a;
        g.alpha((paused ? 0.5 : 1) * fade);
        g.begin_(); g.rrect(pt.x - 4.5, pt.y - 3, 9, 6, 1.5); g.fill(p.tint[i] === T_AMBER && !p.moving(i) ? C.packetDock : TINTS[p.tint[i]]);
        drawn++;
      }
      if (paused) g.alpha(0.5); else g.alpha(1);
      // At 60× a packet crosses the yard in a few frames: three ghosts behind each traveller
      // (where it was 1, 2, 3 sim steps ago, extrapolated) say where it came from.
      if (q <= 1 && !paused && this.tl.speed >= 30) {
        for (let gh = 1; gh <= 3; gh++) {
          g.begin_();
          let any = false;
          for (let k = 0; k < p.nAct && k < 600; k++) {
            const i = p.act[k];
            if ((p.flags[i] & 4) || !p.moving(i)) continue;
            const dx = p.x[i] - p.px[i], dy = p.y[i] - p.py[i];
            if (dx * dx + dy * dy < 4) continue;
            g.rrect(p.px[i] - dx * (gh - 1) * 1.6 - 4, p.py[i] - dy * (gh - 1) * 1.6 - 2.5, 8, 5, 1.5); any = true;
          }
          if (any) g.fill(withAlpha(C.packet, 0.42 - gh * 0.11));
        }
      }
      // the lead packets' glow and fast-move trails (full quality only)
      if (q === 0 && !paused) {
        g.begin_();
        let any = false;
        for (let k = 0; k < p.nAct && k < 400; k++) {
          const i = p.act[k];
          if (!(p.flags[i] & 8) || (p.flags[i] & 4) || p.tint[i] !== T_AMBER) continue;
          const dx = p.x[i] - p.px[i], dy = p.y[i] - p.py[i];
          if (dx * dx + dy * dy > 30) { g.rrect(p.px[i] - 4.5 - dx * 0.8, p.py[i] - 3 - dy * 0.8, 9, 6, 1.5); any = true; }
        }
        if (any) g.fill(withAlpha(C.packet, 0.22));
        g.begin_(); any = false;
        for (let k = 0; k < p.nAct && k < 400; k++) {
          const i = p.act[k];
          if (!(p.flags[i] & 8) || (p.flags[i] & 4)) continue;
          pt.x = p.px[i] + (p.x[i] - p.px[i]) * a; pt.y = p.py[i] + (p.y[i] - p.py[i]) * a;
          g.rrect(pt.x - 7, pt.y - 5, 14, 10, 4); any = true;
        }
        if (any) g.fill(withAlpha(C.packet, 0.12));
      }
      // bot marks
      if (q <= 1) {
        g.begin_();
        let any = false;
        for (let k = 0; k < p.nAct; k++) {
          const i = p.act[k];
          if (!(p.flags[i] & 2)) continue;
          pt.x = p.px[i] + (p.x[i] - p.px[i]) * a; pt.y = p.py[i] + (p.y[i] - p.py[i]) * a;
          g.move(pt.x - 2.5, pt.y); g.line(pt.x + 2.5, pt.y); any = true;
        }
        if (any) g.stroke('rgba(0,0,0,0.6)', 1.2);
      }
      this.trains = 0;
      // ×N badges on coalesced packets
      for (let k = 0; k < p.nAct; k++) {
        const i = p.act[k];
        if (p.count[i] < 2 || (p.flags[i] & 4) || !(p.flags[i] & 8)) continue;
        pt.x = p.px[i] + (p.x[i] - p.px[i]) * a; pt.y = p.py[i] + (p.y[i] - p.py[i]) * a;
        g.text(times(p.count[i]), pt.x + 7, pt.y - 4, C.amberText, T.caption);
      }
      this.labels(g, S, q, t);
    }
    if (paused || q >= 3) g.alpha(1);
    return drawn;
  }

  /** Packets sharing a stretch of wire merge into one train with a ×N badge. */
  private drawTrains(g: Gfx, S: Scene, q: Quality, t: number): number {
    const p = this.pool;
    const gen = ++this.gen;
    this.nUsed = 0;
    const span = q >= 4 ? 120 : 40;
    const hideSlots = S.engines.lod >= 1;
    const a = p.alpha;
    for (let k = 0; k < p.nAct; k++) {
      const i = p.act[k];
      const stress = (p.flags[i] & 4) !== 0;
      let key: number;
      if (stress) key = p.cellOf(i, q >= 4) | (p.tint[i] === T_RED ? 1 << 26 : 0);
      else {
        if (p.die[i] || (hideSlots && p.st[i] === ST_SLOT && !(p.flags[i] & 8))) continue;
        key = (Math.floor(p.x[i] / span) << 12) | (Math.floor(p.y[i] / span) & 0xfff) | (p.tint[i] << 24);
      }
      let hh = (Math.imul(key, 0x9e3779b1) >>> 20) & (BUCKETS - 1);
      for (let probe = 0; probe < 32; probe++) {
        if (this.bGen[hh] !== gen) {
          this.bGen[hh] = gen; this.bKey[hh] = key; this.bCount[hh] = 1; this.bLead[hh] = i; this.bTint[hh] = p.tint[i];
          this.bUsed[this.nUsed++] = hh;
          break;
        }
        if (this.bKey[hh] === key) {
          this.bCount[hh]++;
          if (stress && p.d[i] > p.d[this.bLead[hh]] && p.roff[i] === p.roff[this.bLead[hh]]) this.bLead[hh] = i;
          break;
        }
        hh = (hh + 1) & (BUCKETS - 1);
      }
    }
    const pt = this.pt;
    for (let u = 0; u < this.nUsed; u++) {
      const hh = this.bUsed[u], i = this.bLead[hh];
      if (p.flags[i] & 4) { const dd = p.d[i] >= p.dPrev[i] ? p.dPrev[i] + (p.d[i] - p.dPrev[i]) * a : p.d[i]; p.at(i, dd, pt); }
      else { pt.x = p.px[i] + (p.x[i] - p.px[i]) * a; pt.y = p.py[i] + (p.y[i] - p.py[i]) * a; }
      this.bX[hh] = pt.x; this.bY[hh] = pt.y;
    }
    let drawn = 0;
    const maxSprites = q >= 4 ? 600 : 2400;
    for (let tint = 0; tint < 4; tint++) {
      g.setFill(TINTS[tint]);
      for (let u = 0; u < this.nUsed && drawn < maxSprites; u++) {
        const hh = this.bUsed[u];
        if (this.bTint[hh] !== tint) continue;
        const n = this.bCount[hh];
        const len = n > 1 ? 9 + Math.min(9, 1.5 * Math.log2(n)) : 9;
        const x = this.bX[hh], y = this.bY[hh];
        if (x < -20 || y < -10 || x > S.W + 20 || y > S.H + 10) continue;
        g.cell(x - len / 2, y - 3, len, 6);
        drawn++;
      }
    }
    this.trains = this.nUsed;
    // badges on the biggest trains: a small sorted top-K, kept in a fixed array
    const K = q >= 4 ? 6 : 12;
    const top = this.top;
    let nTop = 0;
    for (let u = 0; u < this.nUsed; u++) {
      const hh = this.bUsed[u], n = this.bCount[hh];
      if (n < 2) continue;
      if (nTop < K) top[nTop++] = hh;
      else if (n > this.bCount[top[nTop - 1]]) top[nTop - 1] = hh;
      else continue;
      for (let j = nTop - 1; j > 0 && this.bCount[top[j]] > this.bCount[top[j - 1]]; j--) { const tmp = top[j]; top[j] = top[j - 1]; top[j - 1] = tmp; }
    }
    for (let j = 0; j < nTop; j++) {
      const hh = top[j];
      g.text(times(this.bCount[hh]), this.bX[hh] + 10, this.bY[hh] - 4, C.amberText, T.caption);
    }
    void t;
    return drawn;
  }

  /** Repo names on the packets that just set out: newest first, never overlapping. */
  private labels(g: Gfx, S: Scene, q: Quality, t: number): void {
    const max = q === 0 ? 6 : q === 1 ? 3 : 0;
    if (!max) return;
    const fast = this.tl.mode === 'replay' || this.tl.speed > 4;
    const p = this.pool;
    const a = p.alpha;
    let placed = 0;
    // newest first: a few passes picking the latest labelUntil not yet placed
    let lastU = Infinity;
    for (let pass = 0; pass < 12 && placed < max; pass++) {
      let best = -1, bu = t;
      for (let k = 0; k < p.nAct; k++) {
        const i = p.act[k];
        const u = p.labelUntil[i];
        // Names ride the first hop (source → queue) and a failure's way home, while travelling;
        // above 4× only failures are named.
        const home = p.st[i] === ST_RET && p.tint[i] === T_RED;
        if (u > bu && u < lastU && !(p.flags[i] & 4) && p.moving(i) && (home || (p.st[i] <= 1 && !fast)) && p.label[i]) { bu = u; best = i; }
      }
      if (best < 0) break;
      lastU = bu;
      const x = p.px[best] + (p.x[best] - p.px[best]) * a, y = p.py[best] + (p.y[best] - p.py[best]) * a;
      const s = p.label[best];
      const wdt = g.width(s, T.caption) + 6;
      const rx = x + 8, ry = y - 7;
      if (rx + wdt > S.W - 2) continue;
      if (overMachine(S, rx, ry, wdt, 14)) continue;
      let hit = false;
      for (let j = 0; j < placed; j++) {
        const o = j * 4;
        if (rx < this.placed[o] + this.placed[o + 2] + 4 && this.placed[o] < rx + wdt + 4 && ry < this.placed[o + 1] + this.placed[o + 3] + 2 && this.placed[o + 1] < ry + 14) { hit = true; break; }
      }
      if (hit) continue;
      const o = placed * 4;
      this.placed[o] = rx; this.placed[o + 1] = ry; this.placed[o + 2] = wdt; this.placed[o + 3] = 14;
      placed++;
      const la = clamp((bu - t) / 500, 0, 1);
      g.alpha(la);
      // a halo of the canvas colour so the name reads over wires
      g.begin_(); g.rrect(rx, ry, wdt, 13, 3); g.fill(withAlpha(C.canvas, 0.85));
      g.text(s, rx + 3, y + 3, p.tint[best] === T_RED ? C.redText : C.ink2, T.caption);
      g.alpha(1);
    }
  }

  // ---- live: effects -------------------------------------------------------------------------------
  private effects(g: Gfx, t: number): void {
    const p = this.pool;
    for (let j = 0; j < p.nFx; j++) {
      const u = clamp((t - p.et0[j]) / p.edur[j], 0, 1);
      const x = p.exx[j], y = p.eyy[j], red = p.ered[j] === 1;
      const k = p.ek[j];
      if (k === E_POP) {
        const r = u < 0.6 ? 5.5 * easeOut(u / 0.6) : 5.5 - 2 * ((u - 0.6) / 0.4);
        g.begin_(); g.circle(x, y, Math.max(0.5, r)); g.fill(red ? C.red : C.dot);
      } else if (k === E_PULSE) {
        const r = p.er[j] * (0.6 + u * 1.4);
        g.begin_(); g.rrect(x - r / 2, y - r / 2, r, r, 2); g.stroke(withAlpha(red ? C.red : C.green, 1 - u), 1.5);
      } else if (k === E_FLASH) {
        const r = p.er[j] + 2 + u * 8;
        g.begin_(); g.circle(x, y, r); g.stroke(withAlpha(red ? C.red : C.ink, 0.85 * (1 - u)), 1.2);
      } else if (k === E_PORT) {
        g.fillRect(x - 1, y - 6, 2, 12, withAlpha(C.packet, 1 - u));
      }
    }
  }

  private nowBob(g: Gfx, t: number, paused: boolean): void {
    const c = this.info.activeChip;
    if (c.x < 0) return;
    const bob = 0; // still: the chip's state says it runs; motion is for events
    void t;
    g.begin_(); g.rrect(c.x - 6, c.y - 5 + bob, 12, 7, 2); g.fill(paused ? withAlpha(C.packet, 0.5) : C.packet);
  }

  // ---- live: the dial ("1 hour, sped up"); the Contract button over it is the replay entry -------
  private dial(g: Gfx, S: Scene, t: number): void {
    const d = S.dial, tl = this.tl;
    const mode = tl.mode;
    g.begin_(); g.circle(d.x, d.y, d.r);
    if (mode === 'paused') { g.dash(true, 2, 2); g.stroke(C.packet, 1.2); g.dash(false); }
    else g.stroke(mode === 'replay' ? C.packet : C.ink2, 1.2);
    const prog = tl.replayProgress();
    // The hand moves only while replaying (it is the replay's progress); live, it rests at 12.
    const ang = mode === 'replay' ? -Math.PI / 2 + prog * TAU : -Math.PI / 2;
    void t;
    g.begin_(); g.move(d.x, d.y); g.line(d.x + Math.cos(ang) * (d.r - 2.5), d.y + Math.sin(ang) * (d.r - 2.5));
    g.stroke(mode === 'replay' || mode === 'paused' ? C.packet : C.ink, 1.4);
    if (mode === 'replay') { g.begin_(); g.arc(d.x, d.y, d.r + 2.5, -Math.PI / 2, -Math.PI / 2 + prog * TAU); g.stroke(withAlpha(C.packet, 0.7), 1.2); }
  }

  /** Replay: the hour as a 1 px event-density strip under the header, failures as red ticks,
   *  the playhead as an amber tick. */
  private strip(g: Gfx, S: Scene): void {
    const tl = this.tl, d = tl.density, f = tl.fails;
    const x0 = S.m, x1 = S.W - S.m, y = S.header.h + 2;
    const bw = (x1 - x0) / d.length;
    let mx = 1;
    for (let i = 0; i < d.length; i++) if (d[i] > mx) mx = d[i];
    g.fillRect(x0, y, x1 - x0, 1, C.rule);
    for (let lvl = 1; lvl <= 4; lvl++) {
      g.setFill(withAlpha(C.ink2, lvl * 0.22));
      for (let i = 0; i < d.length; i++) { if (!d[i]) continue; const l = Math.min(4, 1 + Math.floor((d[i] / mx) * 3.99)); if (l === lvl) g.cell(x0 + i * bw, y, Math.max(1, bw), 1); }
    }
    g.setFill(C.red);
    for (let i = 0; i < f.length; i++) if (f[i]) g.cell(x0 + i * bw, y - 2, Math.max(1, bw), 5);
    const px = x0 + tl.replayProgress() * (x1 - x0);
    g.fillRect(px - 0.5, y - 4, 1.5, 9, C.packet);
  }

  // ---- hits and the lens ---------------------------------------------------------------------------
  /** What is under a point (yard px). */
  hitAt(x: number, y: number): Hit | null {
    const S = this.S;
    if (!S) return null;
    const hb = this.hud;
    if (hb.on) {
      const inR = (r: { x: number; y: number; w: number; h: number }) => r.w > 0 && x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;
      if (inR(hb.stressBtn)) return { kind: 'stress', id: this.stress.on ? 'off' : 'on', label: 'Stress mode' };
      if (inR(hb.qualityBtn)) return { kind: 'quality', id: '', label: 'Pin quality' };
    }
    const w = this.world;
    // a slot with a pipeline in it
    for (const lane of S.engines.lanes) {
      if (y < lane.y - 4 || y > lane.y + lane.h + 4 || lane.virtual) continue;
      for (const id of lane.engines) {
        const e = w.engines.get(id) ?? enginesOf(w).find((z) => z.id === id);
        const slots = S.engines.slotByEngine.get(id);
        if (!e || !slots) continue;
        const b = buildingIds(w);
        const run = e.running.filter((pid) => b.has(pid));
        for (let k = 0; k < run.length && k < slots.length; k++) {
          const s = slots[k];
          const reach = S.engines.lod === 0 ? 46 : s.r + 4;
          if (Math.abs(x - s.x - (S.engines.lod === 0 ? 36 : 0)) <= reach && Math.abs(y - s.y) <= Math.max(8, s.r + 4)) {
            const p = w.pipelines.get(run[k]);
            return { kind: 'pipeline', id: run[k], label: p ? `${p.repo} #${p.number}` : run[k] };
          }
        }
      }
    }
    let best: Hit | null = null, bestA = Infinity;
    for (const h of S.hits) {
      if (x < h.x || x > h.x + h.w || y < h.y || y > h.y + h.h) continue;
      if (h.grid) {
        const gr = h.grid;
        const c = Math.floor((x - h.x) / gr.pitch), r = Math.floor((y - h.y) / gr.pitch);
        if (c >= gr.cols) continue;
        const idx = gr.start + r * gr.cols + c;
        if (idx >= gr.end) continue;
        if (gr.kind === 'repo') {
          const ids = this.agg.repos.ids;
          const real = idx % Math.max(1, ids.length);
          const id = ids[real];
          if (!id) continue;
          return { kind: 'repo', id, label: idx >= ids.length ? `${id} (stress copy)` : id };
        }
        const ids = this.agg.apps.ids;
        const id = ids[idx % Math.max(1, ids.length)];
        if (!id) continue;
        return { kind: 'app', id, label: id };
      }
      const area = h.w * h.h;
      if (area < bestA) { bestA = area; best = { kind: h.kind, id: h.id, label: h.label }; }
    }
    if (best?.kind === 'now') {
      const f = this.focus;
      return f ? { kind: 'pipeline', id: f.id ?? '', label: `${f.repo} #${f.number}` } : null;
    }
    if (best?.kind === 'queue') {
      // a press on the queue opens its oldest waiting pipeline
      const qt = queueTruth(w);
      const list = best.id === 'gha' ? qt.gha : qt.rr;
      if (list[0]) return { kind: 'pipeline', id: list[0].id ?? '', label: `${list[0].repo} #${list[0].number}` };
    }
    if (best?.kind === 'engine' && best.id === '*') return null;
    return best;
  }

  /** The pointer moved (yard px): what is under it is promoted to LOD0 in a lens. */
  hoverAt(x: number, y: number, t: number): Hit | null {
    const h = x < 0 ? null : this.hitAt(x, y);
    const promotable = h && (h.kind === 'repo' || h.kind === 'app' || h.kind === 'pipeline' || h.kind === 'org' || h.kind === 'engine');
    const cur = this.hover;
    if (promotable && h) {
      if (cur.kind !== h.kind || cur.id !== h.id) { cur.kind = h.kind; cur.id = h.id; cur.label = h.label; cur.t0 = t; }
      cur.x = x; cur.y = y;
      return h;
    }
    if (cur.kind) { this.lens.out = t; cur.kind = ''; cur.id = ''; }
    return null;
  }

  private drawLens(g: Gfx, S: Scene, t: number): boolean {
    const hv = this.hover, L = this.lens;
    if (hv.kind) {
      if (L.kind !== hv.kind || L.id !== hv.id) { L.kind = hv.kind; L.id = hv.id; L.label = hv.label; L.t0 = hv.t0; }
      L.x = hv.x; L.y = hv.y; L.out = 0;
    }
    if (!L.kind) return false;
    const a = L.out ? 1 - clamp((t - L.out) / 150, 0, 1) : easeOut(clamp((t - L.t0) / 150, 0, 1));
    if (a <= 0) { L.kind = ''; return false; }
    const w = this.world, now = this.tl.playhead;
    const cw = L.kind === 'repo' ? Math.min(560, S.W - 24) : 320;
    const ch = L.kind === 'repo' ? 70 : L.kind === 'engine' ? 30 + 16 * 6 : 64;
    let x = L.x + 14, y = L.y + 16;
    if (x + cw > S.W - 8) x = L.x - cw - 14;
    if (x < 8) x = 8;
    if (y + ch > S.H - 8) y = L.y - ch - 12;
    if (y < 4) y = 4;
    g.alpha(a);
    g.begin_(); g.rrect(x, y, cw, ch, 6); g.fill(C.raised); g.stroke(C.machine, 1);
    const px = T.caption;
    if (L.kind === 'repo') {
      const r = w.repos.get(L.id);
      if (r) {
        const story = mainStory(r, now, fmtDur);
        const tone = story.tone === 'red' ? C.redText : story.tone === 'green' ? C.greenInk : story.tone === 'amber' ? C.amberText : C.ink3;
        g.runs([[r.name, C.ink, true], [`  ${r.org}`, C.ink3], [`  ${story.text}`, tone]], x + 10, y + 16, T.label, cw - 20);
        mainLine(g, r, x + 12, x + cw - 22, y + 40, 12, 3.5, 0, this.budget.quality, now, true);
        const last = r.main.recent[r.main.recent.length - 1];
        if (last) g.runs([[last.sha.slice(0, 7), C.ink3], [` ${last.title}`, C.ink2], [` · ${last.author} · ${fmtShort(now - last.at)} ago`, C.ink3]], x + 10, y + 62, px, cw - 20);
      }
    } else if (L.kind === 'app') {
      const ap = w.apps.get(L.id);
      if (ap) {
        g.runs([[L.id, C.ink, true], [`  ${ap.health}`, ap.health === 'up' ? C.greenInk : ap.health === 'down' ? C.redText : C.amberText], [ap.latency_ms ? ` · ${ap.latency_ms} ms` : '', C.ink3]], x + 10, y + 18, T.label, cw - 20);
        g.runs([['live ', C.ink3], [(ap.live_sha ?? '–').slice(0, 7), C.ink2], [' · main ', C.ink3], [(ap.main_sha ?? '–').slice(0, 7), C.ink2], [ap.behind ? ` · ${ap.behind} behind` : ' · current', ap.behind ? C.amberText : C.ink3]], x + 10, y + 36, px, cw - 20);
        const d = ap.last_deploy ? w.deploys.get(ap.last_deploy.id) : undefined;
        g.runs([[d ? `deployed ${fmtShort(now - d.started)} ago via ${d.via.replace('_', ' ')}` : 'no deploy on record', C.ink3], [ap.runtime ? ` · ${ap.runtime}` : '', C.ink3]], x + 10, y + 54, px, cw - 20);
      }
    } else if (L.kind === 'pipeline') {
      const p = w.pipelines.get(L.id);
      if (p) {
        const wf = p.workflows?.find((z) => z.state === 'running') ?? p.workflows?.[0];
        const st = wf?.steps.find((z) => z.state === 'running') ?? wf?.steps[wf.steps.length - 1];
        const exp = p.expected_ms ?? w.repos.get(p.repo)?.p50_build_ms ?? 0;
        const el = p.started ? now - p.started : 0;
        g.runs([[w.repos.get(p.repo)?.name ?? p.repo, C.ink, true], [` #${p.number}`, C.ink2], [` · ${p.branch}`, C.ink3]], x + 10, y + 18, T.label, cw - 20);
        g.runs([[wf?.name ?? '', C.ink3], [st ? ` › ${st.name}` : '', C.ink2], [` · ${wf?.steps.filter((z) => z.state === 'success').length ?? 0}/${wf?.steps.length ?? 0} steps`, C.ink3]], x + 10, y + 36, px, cw - 20);
        g.runs([[fmtDur(el), exp && el > exp * 1.5 ? C.amberText : C.ink2], [exp ? ` of ~${fmtDur(exp)} typical` : '', C.ink3], [` · ${(p.engine ?? p.lane).toLowerCase()}`, C.ink3]], x + 10, y + 54, px, cw - 20);
      }
    } else if (L.kind === 'engine') {
      const g2 = engineGroups(w).find((z) => z.id === L.id);
      g.runs([[L.label, C.ink, true], [g2 ? ` · ${g2.sub}` : '', C.ink3]], x + 10, y + 18, T.label, cw - 20);
      const b = buildingIds(w);
      let ly = y + 36, n = 0;
      for (const e of g2?.engines ?? []) for (const pid of e.running) {
        if (!b.has(pid) || n >= 5) continue;
        const p = w.pipelines.get(pid);
        g.runs([[`${(e.label ?? e.id).toLowerCase()}  `, C.ink3], [w.repos.get(p?.repo ?? '')?.name ?? pid, C.ink2], [p?.started ? `  ${fmtShort(now - p.started)}` : '', C.ink3]], x + 10, ly, px, cw - 20);
        ly += 16; n++;
      }
      if (!n) g.text(g2?.engines.every((e) => e.online === false) ? 'offline' : 'every slot idle', x + 10, ly, C.ink3, px);
    } else if (L.kind === 'org') {
      g.runs([[L.label, C.ink, true], [`  ${w.rate(L.id, now)} pushes an hour`, C.amberText]], x + 10, y + 18, T.label, cw - 20);
      let red = 0, n = 0;
      for (const r of w.repos.values()) if (r.org === L.id) { n++; if (isRed(r)) red++; }
      g.runs([[`${n} repos`, C.ink2], [red ? ` · ${red} red` : ' · all green', red ? C.redText : C.greenInk]], x + 10, y + 36, px, cw - 20);
      g.text(`${w.pushesSince(L.id, now - 600_000)} pushes in the last 10 minutes`, x + 10, y + 54, C.ink3, px);
    }
    g.alpha(1);
    return true;
  }
}

/** Whether a label's box would sit on a machine (labels go where the wires are, not on boxes). */
function overMachine(S: Scene, x: number, y: number, w: number, h: number): boolean {
  const hit = (r: { x: number; y: number; w: number; h: number }) => x < r.x + r.w + 2 && r.x - 2 < x + w && y < r.y + r.h + 2 && r.y - 2 < y + h;
  if (hit(S.intake.rr) || hit(S.intake.gha) || hit(S.gates.gate) || hit(S.gates.review) || hit(S.deploy)) return true;
  for (const l of S.engines.lanes) if (hit(l)) return true;
  // the layout's text: station heads, lane labels, the source rows, everything under the
  // return wire, and the right column
  if (y < S.top.body - 2) return true;
  for (const l of S.engines.lanes) if (y < l.y && y + h > l.labelY - 10 && x + w > l.x && x < l.x + l.w) return true;
  if (hit({ x: S.sources.x, y: S.top.body - 8, w: S.sources.w, h: S.divY - 22 - S.top.body })) return true;
  if (y + h > S.divY + 8) return true;
  return x + w > S.R.x0 - 4;
}

function lane0(S: Scene): boolean {
  return S.engines.lod === 0;
}

// ---- the static layer ---------------------------------------------------------------------------
export function drawStatic(g: Gfx, S: Scene, low: boolean): void {
  const L = S.legs;
  // wires: every leg in one path
  g.begin_();
  const leg = (l: Leg | undefined) => {
    if (!l) return;
    const p = l.pts;
    g.move(p[0], p[1]);
    // low detail: every 4th point of a long curve (short polylines keep their corners)
    const step = low && p.length > 12 ? 8 : 2;
    for (let i = step; i < p.length; i += step) g.line(p[i], p[i + 1]);
    if (step > 2) g.line(p[p.length - 2], p[p.length - 1]);
  };
  for (const l of L.fan) leg(l);
  leg(L.jRr); leg(L.jGha);
  for (const l of L.toLane) leg(l);
  for (const l of L.fromLane) leg(l);
  leg(L.gateBus); leg(L.review); leg(L.deploy); leg(L.apps);
  // the bus and its ticks to the rows and the heatmap
  g.move(S.bus.x, Math.min(S.bus.y0, S.divY)); g.line(S.bus.x, S.bus.y1);
  for (const r of S.mains.rows) { g.move(S.bus.x, r.y); g.line(r.x0 - 4, r.y); }
  const hb = S.mains.heat.blocks[0];
  if (hb) { g.move(S.bus.x, hb.y + 2); g.line(S.mains.x0 - 4, hb.y + 2); }
  g.stroke(C.wire, 1);
  // the return wire, a shade brighter: it is the band's edge and the way home for reds
  g.begin_();
  leg(L.ret); leg(L.reject);
  for (const l of L.retTicks) leg(l);
  g.stroke('#343436', 1);
  // band rules in the lower left
  g.hline(S.L.x0, S.L.x1, S.queue.y - 7, C.rule);
  g.hline(S.L.x0, S.L.x1, S.pulse.y - 7, C.rule);
  // machines
  const I = S.intake;
  for (const m of [I.rr, I.gha]) {
    machine(g, m.x, m.y, m.w, m.h, 5, C.machine, low);
    if (!low) { port(g, m.inPort.x, m.inPort.y, Math.min(14, m.h - 6)); port(g, m.outPort.x, m.outPort.y, Math.min(14, m.h - 6)); }
  }
  for (const ln of S.engines.lanes) {
    machine(g, ln.x, ln.y, ln.w, ln.h, ln.lod === 0 ? 6 : 4, ln.offline ? C.machineDim : C.machine, low, ln.offline);
    if (!low && !ln.offline) { port(g, ln.inPort.x, ln.inPort.y, Math.min(14, ln.h - 6)); port(g, ln.outPort.x, ln.outPort.y, Math.min(14, ln.h - 6)); }
    // empty slots
    g.begin_();
    for (const s of ln.slots) g.circle(s.x, s.y, s.r);
    if (ln.offline) { g.dash(true, 1.5, 2); g.stroke(C.machineDim, 1); g.dash(false); } else g.stroke(C.machineDim, 1);
  }
  const G = S.gates.gate;
  machine(g, G.x, G.y, G.w, G.h, 6, C.machine, low);
  if (!low) { port(g, G.inPort.x, G.inPort.y, 14); port(g, G.outPort.x, G.outPort.y, 14); }
  {
    // the integrator's clamp
    const cx = G.x + G.w / 2, cy = G.y + G.h / 2;
    g.begin_(); g.move(cx, G.y + 7); g.line(cx, G.y + G.h - 7); g.stroke(C.machine, 1.5);
    g.begin_(); g.rect(cx - 15, G.y + 5, 30, 2.5); g.rect(cx - 15, G.y + G.h - 7.5, 30, 2.5); g.fill('#3A3A3C');
    g.begin_(); g.rect(cx - 9, cy - 3, 18, 6); g.stroke(C.machine, 1);
  }
  const Rv = S.gates.review;
  machine(g, Rv.x, Rv.y, Rv.w, Rv.h, 6, C.machine, low);
  g.begin_(); g.circle(Rv.x + Rv.w / 2, Rv.y + Rv.h / 2, 6); g.stroke(C.machineDim, 1);
  if (!low) { g.begin_(); g.rrect(Rv.x + Rv.w / 2 - 10, Rv.y - 2.5, 20, 5, 2); g.fill(C.port); g.stroke(C.portEdge, 1); }
  const D = S.deploy;
  machine(g, D.x, D.y, D.w, D.h, 6, C.machine, low);
  g.begin_(); g.move(D.x + 12, D.y + D.h / 2); g.line(D.x + D.w - 16, D.y + D.h / 2); g.stroke(C.machine, 1.5);
  if (!low) { port(g, D.inPort.x, D.inPort.y, 12); port(g, D.outPort.x, D.outPort.y, 12); }
}

export { T_GRAY, T_GREEN, T_RED, engineOf, scaleFor };
