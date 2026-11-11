// THE FACTORY FLOOR (concept B; DESIGN.md "Factory"). The whole software factory as a 2.5-D
// isometric floor seen from above, flowing left → right through eight stages:
//
//   sources (org docks) → PR yard (stacks by phase × age, bot pallets) → merge gate → main-line
//   rails (one per org, merged commits as cars) → intake (a holding belt) → THE CONSUMPTION
//   ENGINE (one machine per host, its slots as lit bays) → the test scanner (failures kicked
//   onto the return conveyor along the front edge) → three deploy tracks → the city of apps.
//
// Two canvas layers: `factoryFloor` (the floor, belts, machines, stacks, the city: redrawn only
// when the camera or the fleet's shape moved) and `factoryLive` (belt motion, crates, bays,
// gauges, health lights, heat, labels, the journey, the drawer, the time strip: every frame
// while anything moves). Every word is drawn in screen space at a projected anchor.
//
// This file is the loop: the camera, the pointer, the census check, the frame budget, and the
// hook surface the lens system reaches (types.ts lists it). The stages are layers (layers.ts,
// one line each, run back to front): floor.ts, plant.ts, city.ts, crates.ts, labels.ts; the
// chrome is drawer.ts (journey, drawer, hover card) and strip.ts; the plan is layout.ts; the
// shared shapes and paint are types.ts and prims.ts.

import type { Ctx2D, Frame } from '../../app.contract.d.ts';
import type { Event, Journey, Pipeline } from '../wire.ts';
import type { Timeline } from '../timeline.ts';
import type { World } from '../world.ts';
import { Budget, FRAME_MS, type Quality } from '../yard/budget.ts';
import { Gfx } from '../yard/gfx.ts';
import type { Hud } from '../yard/hud.ts';
import { C, clamp } from '../yard/theme.ts';
import { BoxBatch } from './batch.ts';
import { Retained, fastArcs } from './cache.ts';
import { Census } from './census.ts';
import { Drawer } from './drawer.ts';
import { FacHud, type FacHudInfo } from './hud.ts';
import { Cam } from './iso.ts';
import { buildLayers } from './layers.ts';
import { PLAN } from './layout.ts';
import { F, box, crate, dur, onScreen, poly, quad } from './prims.ts';
import { FACTOR, FactoryStress } from './stress.ts';
import { Strip } from './strip.ts';
import type { Bay, Block, DistrictBox, FloorPass, HitBox, Label, Layer, Lens, LiveFrame } from './types.ts';
import { Lenses } from './lens.ts'; // fab-lens
import { Coffee } from './coffee.ts'; // fab-lens
import { GroupFloor } from './groupfloor.ts'; // fab-w2: group docks, stripes, trend marks
import type { FactoryFx } from './lens.ts'; // fab-lens

export type { Plan } from './types.ts';

/** The floor's ladder (yard/budget.ts) with one difference: a missed frame counts against the
 *  floor only when its own drawing is a real part of the frame. On the mini the floor's frame at
 *  full quality is ~2.2 ms (estimate) of a budget of 6, its work ends ~7 ms before the deadline,
 *  and the 1-3 frames a minute the host still misses (no work of ours late) used to step the
 *  ladder down from full and back every few seconds. The yard's threshold for "a real part" is a
 *  third of the budget; the floor's is three quarters (the native cost is the list's bytes: the
 *  calibration in PERF.md holds 59.8 fps up to ~6 ms of them). Over the budget it still steps. */
export class FacBudget extends Budget {
  /** Below this estimate (ms) a missed frame is the host's. */
  shareMs = 4.5;
  record(estMs: number, ops: number, texts: number, interval: number, predictUp: (q: Quality) => number): void {
    // an interval of 0 is "not a frame of ours to judge": the window keeps a good one in its slot
    // (the yard's window counts a frame over 1.25 periods as a miss; so does this)
    if (interval > FRAME_MS * 1.25 && estMs < this.shareMs) interval = 0;
    super.record(estMs, ops, texts, interval, predictUp);
  }
}

/** The layers whose live drawing goes to the top canvas (the last in `order`: words over all). */
const TOP_LAYERS = new Set(['groups', 'labels']);

/** The host made this canvas a new bitmap (it mounted, or its size changed). */
function freshBitmap(f: Frame): boolean {
  return f.causes.length ? f.causes.includes('mount') || f.causes.includes('size') : f.cause === 'mount' || f.cause === 'size';
}
export { dur };

const { RAIL_U1, RAIL_V, ENG_H } = PLAN;

export class Factory {
  readonly cam = new Cam();
  readonly census = new Census();
  readonly budget = new FacBudget();
  private gf = new Gfx();
  private gl = new Gfx();
  /** The words and the chrome: drawn into a retained list (cache.ts) that the `factoryTop` canvas,
   *  over the live one, is sent only the changes of. */
  readonly ret = new Retained();
  private gt = new Gfx();
  /** When the top canvas last drew (it routes nothing until it has: an older Contract has none). */
  private topAt = -1e9;
  private topFresh = true;
  /** The last live frame was in the coffee check's intro (see drawLive). */
  private settling = true;
  private qWas = 0;
  private toTopWas = false;
  /** The HUD's numbers, sampled four times a second (its box redraws then, not every frame). */
  private hudSnap: { at: number; b: Budget; info: FacHudInfo; key: string } | null = null;
  // ---- the layers (layers.ts): every stage of the floor, and the registry the loop runs ----
  private readonly L = buildLayers(this);
  readonly floor = this.L.floor;
  readonly plant = this.L.plant;
  readonly city = this.L.city;
  readonly crates = this.L.crates;
  readonly reactions = this.L.reactions;
  readonly words = this.L.words;
  /** Back to front: every hook of every layer runs in this order. */
  readonly order: Layer[] = this.L.order;
  /** The chrome over the lens: the selection's journey and drawer, the hover card (drawer.ts);
   *  the time strip and the camera's controls (strip.ts). */
  readonly drawer = new Drawer(this);
  readonly strip = new Strip(this);
  /** What the pointer can pick, drawn this frame (`hit`, `hitAt`). */
  private hits: HitBox[] = [];
  private floorSig = '';
  // ---- the frame budget's plumbing (DESIGN.md "Factory", "Rendering") ----
  /** Stress mode: a 10× fleet for the renderer (stress.ts); `stressWanted` lands at the next draw. */
  readonly stress = new FactoryStress();
  private stressWanted = false;
  /** The developer HUD's switch (shared with the yard's, ⌘⇧D) and the factory's own panel. */
  hud: Hud | null = null;
  private fhud = new FacHud();
  /** Scratch batches: a section fills and flushes them before the next one draws. */
  readonly bA = new BoxBatch(); readonly bB = new BoxBatch(); readonly bC = new BoxBatch(); readonly bD = new BoxBatch();
  /** This live frame (the layers' hooks read it). */
  private fr: LiveFrame = { ctx: null as unknown as Ctx2D, f: null as unknown as Frame, t: 0, now: 0, q: 0, detail: false };
  /** Did the last live frame ask for another (false: it slept, so the next interval is no frame). */
  private awake = false;
  /** Since the last live frame: 1 the census recounted, 2 the static floor redrew. */
  private heavy = 0;
  private lastWheel = 0;
  /** The draw estimate (ms) each quality rung cost when it was last drawn, and when. */
  private qCost = new Float32Array(5);
  private qCostAt = new Float64Array(5).fill(-1e12);
  /** Asleep between the calm clock's wake-ups (app.contract's `facBeat` runs while this holds). */
  get calm(): boolean { return !this.awake; }
  /** Where the live frames' canvas work goes, by phase (the bench and the HUD read it): per
   *  phase, the frames it ran in and the ops, arcs and texts it recorded, summed since `profReset`. */
  readonly profNames: string[] = [];
  readonly prof: Float64Array[] = [];
  private pAt = new Float64Array(4);
  /** The bench's probe: the bytes the context has recorded so far (Exact's recorder), or null. */
  static probe: ((ctx: Ctx2D) => number) | null = null;
  private pi = 0;
  profReset(): void { for (const a of this.prof) a.fill(0); }
  /** Closes phase `name` (the work since the previous mark) of this frame. */
  private pm(name: string, g: Gfx): void {
    let a = this.prof[this.pi];
    if (this.profNames[this.pi] !== name) {
      const k = this.profNames.indexOf(name);
      if (k < 0) { this.profNames.push(name); a = new Float64Array(5); this.prof.push(a); this.pi = this.prof.length - 1; } else { this.pi = k; a = this.prof[k]; }
    }
    const b = Factory.probe ? Factory.probe(g.ctx) : 0;
    a[0]++; a[1] += g.ops - this.pAt[0]; a[2] += g.arcs - this.pAt[1]; a[3] += g.texts - this.pAt[2]; a[4] += b - this.pAt[3];
    this.pAt[0] = g.ops; this.pAt[1] = g.arcs; this.pAt[2] = g.texts; this.pAt[3] = b;
    this.pi++;
  }
  /** The phases by average ops a frame: `name ops/arcs/texts`, biggest first. */
  profLine(): string {
    const rows = this.profNames.map((n, i) => [n, this.prof[i]] as const).filter(([, a]) => a[0] > 0);
    rows.sort((x, y) => y[1][1] / y[1][0] - x[1][1] / x[1][0]);
    return rows.map(([n, a]) => `${n} ${(a[1] / a[0]).toFixed(0)}/${(a[2] / a[0]).toFixed(0)}/${(a[3] / a[0]).toFixed(1)}${a[4] ? `/${(a[4] / a[0] / 1024).toFixed(1)}K` : ''}`).join(' · ');
  }
  /** The last Factory made (the bench reaches the loop through it). */
  static last: Factory | null = null;
  /** What the last live frame drew, for the HUD and the bench. */
  readonly stat = { crates: 0, stressCrates: 0, sprites: 0, trains: 0, cars: 0, bays: 0, labels: 0, hits: 0, floorDraws: 0, floorRate: 0, floorMs: 0, floorOps: 0, sec: 0, lod: [0, 0, 0, 0], slept: 0 };
  selected = '';
  selKind = '';
  journey: Journey | null = null;
  journeyFor = '';
  reduced = false;
  /** The last pointer position (screen px), the wheel's zoom anchor. */
  px = -1;
  py = -1;
  private wheelSeen = 0;
  private drag: { x: number; y: number; moved: boolean } | null = null;
  hoverId = '';
  offsetMin = 0;
  private lastT = 0;
  /** Logged once per layout for drivers (a busy bay's screen position). */
  private logged = '';
  private loggedCar = '';
  span = 'live';
  private flown = false;
  /** fab-lens: every object is a lens (lens.ts); what changed since you last looked (coffee.ts). */
  readonly lens = new Lenses(this);
  readonly coffee = new Coffee(this);
  readonly w2 = new GroupFloor(this); // fab-w2: groups and trends on the floor (groupfloor.ts)

  constructor(public tl: Timeline) {
    // The floor's full rung costs ~4.4 ms on Hermes at 1× (its words: ~80 texts at ~22 µs);
    // 5.2 ms (13 % under the 6 ms budget) lets it climb back there after a hitch.
    this.budget.upHeadroom = 5.2;
    Factory.last = this;
  }

  get world(): World { return this.tl.world; }

  /** What the floor holds (tests read these): city blocks, cars on the rails, busy bays. */
  counts(): { facCity: number; facCars: number; facBays: number; facLens: number; facLensTop: string } {
    let bays = 0;
    for (const b of this.bays) if (b.pid) bays++;
    const top = this.lens.topLens;
    return { facCity: this.blocks.length, facCars: this.stat.cars, facBays: bays, facLens: this.lens.stack.length, facLensTop: top ? `${top.kind}:${top.id}` : '' };
  }

  /** One line of what the renderer did (drives read it as `state ov.facStats`). */
  statsLine(): string {
    const st = this.stat, b = this.budget, s = b.stats();
    return `q${b.quality} ${s.fps.toFixed(0)}fps draw~${s.drawAvg.toFixed(2)}ms ops${b.ops} txt${b.texts} crates${st.crates}+${st.stressCrates} drawn${st.sprites} trains${st.trains} cars${st.cars} bays${st.bays} labels${st.labels} floor${st.floorRate}/s~${st.floorMs.toFixed(1)}ms city${st.lod.join('/')} slept${st.slept}`;
  }

  /** Stress mode on or off (from Settings or the HUD), taken at the next draw. */
  setStress(on: boolean): void { this.stressWanted = on; }

  private applyStress(): void {
    if (this.stressWanted === this.stress.on) return;
    this.stress.on = this.stressWanted;
    if (!this.stress.on) this.stress.clear();
    this.census.factor = this.stress.on ? FACTOR : 1;
    this.census.invalidate();
    this.qCostAt.fill(-1e12);
    this.city.invalidate();
  }

  // ---- events → crates -----------------------------------------------------------------------
  // Each event sends its crate along its path, from the layer that owns the route (floor.ts:
  // pushes, merges; plant.ts: runs; city.ts: deploys, health); every reaction on the way
  // (motion.ts) fires when the crate ARRIVES there.
  onEvent(e: Event, w: World, t: number): void {
    if (this.reduced) return;
    this.crates.cap();
    for (const L of this.order) L.onEvent?.(e, w, t);
  }

  // ---- pointer, camera -------------------------------------------------------------------------
  pointer(kind: string, x: number, y: number, buttons: number, t: number): HitBox | null {
    if (kind.startsWith('key:')) return this.lens.key(kind.slice(4), t); // fab-lens: Esc/⌫ walk back, ? the key
    this.px = x; this.py = y;
    if (kind === 'down') { this.drag = { x, y, moved: false }; this.lens.down = true; return null; } // fab-w3: no hover card while pressed
    if (kind === 'move') {
      if (this.drag && (buttons & 1)) {
        const dx = x - this.drag.x, dy = y - this.drag.y;
        if (this.drag.moved || Math.abs(dx) + Math.abs(dy) > 4) {
          this.drag.moved = true;
          this.cam.pan(dx, dy);
          this.drag.x = x; this.drag.y = y;
        }
        return null;
      }
      const h = this.hitAt(x, y);
      this.hoverId = h ? h.id : '';
      return this.lens.hover(h); // fab-lens: a hover never presses (the strip's buttons act on up)
    }
    if (kind === 'up') {
      const d = this.drag;
      this.drag = null;
      this.lens.down = false; // fab-w3
      if (d?.moved) return null;
      const h = this.hitAt(x, y);
      // fab-lens: a click pushes a lens (shift-click compares; the pointer's buttons carry shift as 256)
      const lh = this.lens.click(h, (buttons & 256) !== 0, t);
      if (lh !== undefined) return lh;
      if (!h) { this.select('', ''); return null; }
      if (h.kind === 'zoomin') this.cam.zoomAt(1.5, this.cam.W / 2, this.cam.H / 2);
      else if (h.kind === 'zoomout') this.cam.zoomAt(1 / 1.5, this.cam.W / 2, this.cam.H / 2);
      else if (h.kind === 'fit') this.cam.reset(t);
      else if (h.kind === 'close') this.select('', '');
      else if (h.kind === 'district' || h.kind === 'engine' || h.kind === 'stage') {
        const [u, v, z] = h.id.split(',').map(Number);
        this.cam.flyToPoint(u, v, z || 2.2, t);
      } else if (h.kind === 'app') {
        // an app: fly down to its block (its name, health and deploys show at that zoom)
        const b = this.blockAt.get(h.id);
        if (b) this.cam.flyToPoint(b.u + b.d / 2, b.v + b.d / 2, Math.max(3.2, this.cam.zoom), t);
      } else if (h.kind === 'pipeline' || h.kind === 'commit') this.select(h.id, h.kind);
      return h;
    }
    return null;
  }

  select(id: string, kind: string): void {
    if (this.selected === id || !id) { if (this.flown) { this.flown = false; this.cam.flyTo(1, 0, 0, this.lastT); } this.selected = ''; this.selKind = ''; return; }
    this.selected = id; this.selKind = kind;
    if (id && !this.flown) { this.flown = true; this.cam.flyTo(0.8, -176, 10, this.lastT); }
    if (id !== this.journeyFor) this.journey = null;
  }

  wheel(total: number): void {
    const d = total - this.wheelSeen;
    this.wheelSeen = total;
    if (!d) return;
    const x = this.px >= 0 ? this.px : this.cam.W / 2, y = this.py >= 0 ? this.py : this.cam.H / 2;
    this.cam.zoomAt(Math.exp(-clamp(d, -400, 400) / 320), x, y);
  }

  hitAt(x: number, y: number): HitBox | null {
    let best: HitBox | null = null;
    for (let i = this.hits.length - 1; i >= 0; i--) {
      const h = this.hits[i];
      if (x >= h.x && x <= h.x + h.w && y >= h.y && y <= h.y + h.h) { best = h; break; }
    }
    return best;
  }

  /** The selection's pipeline (a commit selection: its newest) and its repo and sha (drawer.ts). */
  selPipeline(): Pipeline | null { return this.drawer.selPipeline(); }
  selCommit(): { repo: string; sha: string } | null { return this.drawer.selCommit(); }

  // ---- the floor layer -------------------------------------------------------------------------
  /** Fits the camera and recounts the census when due; true when it counted this turn (the
   *  count is the heavy part: a draw that counted leaves its painting to the next frame, so
   *  no turn does both). */
  ensure(f: Frame, t: number): boolean {
    this.cam.fit(f.width, f.height, 84, 58);
    const now = this.tl.playhead;
    const counted = this.census.update(this.world, now, t);
    if (counted) this.heavy = 1;
    for (const L of this.order) L.census?.(this.world);
    return counted;
  }

  /** The static floor's key: the camera, the fleet's shape, the apps' health (the lights are
   *  painted here, not every frame), and whether the ladder wants the low-detail floor. */
  get floorKey(): string { return `${this.cam.key}|${this.census.sig}|${this.census.healthSig}|${this.census.carSig}|${this.budget.quality >= 3 ? 'lo' : 'hi'}|${this.w2.sig}|${this.plant.sig}|${this.city.sig}`; } // fab-w2: |w2.sig · fab-w6: |plant.sig (the machine walls' 24 h) · fab-w5: |city.sig (heights, ghosts, rings)

  drawFloor(ctx: Ctx2D, f: Frame, t: number): boolean {
    this.applyStress();
    if (freshBitmap(f)) this.floorFresh = true;
    if (this.ensure(f, t)) return true;
    // Contract hands the layer its arguments again whenever the overview it reads from
    // answers (every 250 ms), equal or not: the floor repaints only when what it shows moved
    // (the canvas keeps its picture meanwhile).
    const want = `${this.floorKey}|${this.selected ? 's' : ''}`;
    if (want === this.floorSig && (f.causes.length ? f.causes.every((c) => c === 'args' || c === 'frame') : f.cause === 'args')) return false;
    const g = this.gf, cam = this.cam;
    const lo = this.budget.quality >= 3;
    const idle = this.census.skeleton;
    g.begin(ctx, f.scale);
    if (f.cause === 'font') { g.resetFonts(); this.gl.resetFonts(); }
    ctx.resetTransform();
    ctx.clearRect(0, 0, f.width, f.height);
    g.fillRect(0, 0, f.width, f.height, C.canvas);
    this.floorSig = want;
    // the layers, back to front: each paints its ground now and hands its extruded things to one
    // depth sort (far to near across every layer, each culled by its floor box); then what sits
    // over them (the cars, the city), in the order asked
    const items: { k: number; f: () => void }[] = [];
    const afters: (() => void)[] = [];
    const fp: FloorPass = {
      g, lo, idle,
      add: (u, v, fn, u1, v1, h) => { if (onScreen(cam, u, v, u1, v1, h)) items.push({ k: u * 0.19 + v * 0.66, f: fn }); },
      after: (fn) => { afters.push(fn); },
    };
    for (const L of this.order) L.floor?.(fp);
    items.sort((a, b) => a.k - b.k);
    for (const it of items) it.f();
    for (const fn of afters) fn();
    const st = this.stat;
    st.floorDraws++;
    st.floorOps = g.ops;
    st.floorMs = this.budget.estimate(g.ops, g.arcs, g.texts, 0);
    if (!this.heavy) this.heavy = 2;
    // fab-w1: the accordion's 600 ms keeps the floor redrawing
    return this.gpuClaim('floor') || this.floor.animating;
  }

  /** A canvas is given to the macOS host's GPU module (Vello, Metal) only if the first draw with
   *  anything in it after a fresh bitmap (a mount, a new size) asks for the next frame; otherwise
   *  Core Graphics keeps it for the bitmap's life: the floor's repaints rasterise on the CPU, and
   *  the live layer is recorded and replayed by Core Animation on the main thread every frame
   *  (measured on the mini: 0 GPU replays, 56 recorded a second, work 24-48 ms a frame). So that
   *  first draw always asks for one more (the next one draws nothing unless it has to). */
  private floorFresh = true;
  private liveFresh = true;
  private gpuClaim(which: 'floor' | 'live'): boolean {
    if (which === 'floor') { if (!this.floorFresh) return false; this.floorFresh = false; return true; }
    if (!this.liveFresh) return false;
    this.liveFresh = false;
    return true;
  }

  // ---- the live layer ---------------------------------------------------------------------------
  /** What the live layer's last draw answered: asking for the next frame, or asleep until an
   *  argument wakes it (the top canvas follows it: drawTop). */
  private liveWants = false;
  drawLive(ctx: Ctx2D, f: Frame, t: number, wheel: number): boolean {
    const wants = this.drawLive0(ctx, f, t, wheel);
    this.liveWants = wants;
    return wants;
  }

  private drawLive0(ctx: Ctx2D, f: Frame, t: number, wheel: number): boolean {
    this.applyStress();
    if (freshBitmap(f)) this.liveFresh = true;
    // Only the display's own frames time the budget: a draw woken by an argument (the calm
    // clock, a pointer) lands between them, and a frame after a sleep is no interval.
    const own = f.causes.length ? f.causes.every((k) => k === 'frame') : f.cause === 'frame';
    let interval = own ? (this.awake ? this.budget.tick(t) : (this.budget.tick(t), 0)) : 0;
    this.wheel(wheel);
    const flying = this.cam.step(t);
    // a turn that recounted paints the previous frame's picture again next frame; the interval
    // across it is the count's, not the drawing's (the ladder cannot buy it back)
    if (this.ensure(f, t)) return true;
    // Since the last live frame the census was recounted (heavy 1) or the static floor redrew
    // (heavy 2). A recount's interval is not the drawing's: the ladder cannot buy it back. A
    // floor redraw while the camera moves (a pan, a zoom) is: its cost joins this frame's.
    const heavy = this.heavy;
    this.heavy = 0;
    const camMoving = flying || !!this.drag || wheel !== this.lastWheel;
    this.lastWheel = wheel;
    if (heavy === 1 || (heavy === 2 && !camMoving)) interval = 0;
    // The coffee check's intro (its first 10 s, or a replay of it) is a transient: the fleet
    // loading, the floor drawn again, a minute's events replayed. Its frames do not teach the
    // ladder, and when it ends the ladder starts again from full (it used to learn the load's
    // misses there and sit at its survival rung for good: PERF.md, "Factory B, W7").
    const settling = this.introHolds(t);
    if (settling) interval = 0;
    else if (this.settling && this.budget.pinned < 0) {
      if (this.budget.quality) console.log(`factory: the intro is over: quality q${this.budget.quality} → q0`);
      this.budget.quality = 0; this.budget.gain = 1; this.qWas = 0;
    }
    this.settling = settling;
    const g = this.gl, cam = this.cam, c = this.census;
    const now = this.tl.playhead;
    g.begin(ctx, f.scale);
    fastArcs(ctx, f.scale);
    if (f.cause === 'font') { g.resetFonts(); this.gt.resetFonts(); }
    ctx.resetTransform();
    ctx.clearRect(0, 0, f.width, f.height);
    this.hits = [];
    // The words and the chrome go to the top canvas (its retained list) unless a lens is open:
    // the lens's veil desaturates and darkens what is drawn under it on the same canvas
    // (composite operators), so then everything draws here, in the order it always has.
    const ret = this.ret;
    const veiled = !!this.lens.topLens && this.lens.topLens.kind !== 'pipeline';
    const toTop = t - this.topAt < 1000 && !veiled;
    if (toTop !== this.toTopWas) { this.toTopWas = toTop; console.log(`factory: words and chrome on the ${toTop ? 'top' : 'live'} canvas at ${Math.round(t)} ms${veiled ? ' (a lens veils the floor)' : ''}`); }
    ret.begin(f.width, f.height);
    ret.measurer = ctx;
    const gt = toTop ? this.gt : g;
    if (toTop) gt.begin(ret as unknown as Ctx2D, f.scale);
    this.pAt.fill(0); this.pAt[3] = Factory.probe ? Factory.probe(ctx) : 0; this.pi = 0;
    this.pm('clear', g);
    this.lens.under(g, t); // fab-lens: every floor object's hit, parked failures, fresh glows, smoke, beacons
    this.pm('under', g);
    this.words.reset();
    const st = this.stat;
    const sec = Math.floor(t / 1000);
    if (sec !== st.sec) { st.floorRate = st.floorDraws; st.floorDraws = 0; st.sec = sec; }
    if (c.skeleton) { this.words.idle(gt); ret.end(); this.awake = false; return this.gpuClaim('live'); }
    const q = this.budget.quality;
    const fr = this.fr;
    fr.ctx = ctx; fr.f = f; fr.t = t; fr.now = now; fr.q = q; fr.detail = cam.zoom >= 1.6;
    // the layers, back to front (layers.ts): each one's hits, then each one's live drawing (the
    // haze, belts and cars; the intake, bays and gauges; the city's hits and trouble; the
    // reactions; deploys on their tracks; crates in motion; the groups' stripes and names, the
    // labels: these last two on the top canvas). One still moving keeps the frames coming.
    for (const L of this.order) L.hits?.(fr);
    let moving = false;
    for (const L of this.order) {
      const top = toTop && TOP_LAYERS.has(L.name);
      fr.ctx = top ? gt.ctx : ctx;
      if (L.live?.(top ? gt : g, fr)) moving = true;
      this.pm(L.name, g);
    }
    fr.ctx = ctx;
    // over the layers: the lens on top, the selection's journey, failures named as they ride home
    const selP = this.selPipeline();
    this.lens.draw(g, ctx, f, t); // fab-lens: the lens on top dims the rest and tells its story
    this.plant.jobLive(g, this.fr); // fab-w6
    if (this.selected) this.drawer.journey(gt, gt.ctx, f, selP, t);
    this.crates.tags(gt, t, q);
    this.pm('lens', g);
    st.labels = this.labels.length;
    // the drawer, the hover card, the time strip, the camera controls
    if (this.selected) this.drawer.draw(gt, f, selP, now);
    if (this.lens.legacyKey && !this.selected && this.cam.zoom < 1.2) this.words.legend(gt, f); // fab-lens: the key is on demand (?)
    if (this.hoverId && !this.drag) this.drawer.hover(gt, f);
    this.pm('drawer', g);
    this.strip.draw(gt, f, now);
    this.strip.controls(gt, f);
    this.pm('strip', g);
    this.logAnchors();
    this.lens.top(gt, f, t); // fab-lens: breadcrumb, story/compare card, the coffee glance, the key
    this.pm('top', g);
    this.lastT = t;
    st.hits = this.hits.length;
    // the frame's cost (the cost model, budget.ts) and the ladder: what this canvas recorded and
    // what the top canvas was last sent; the HUD draws last and counts itself (it is the
    // developer's, so it is outside the factory's own budget)
    const tl = ret.last;
    const est = this.budget.estimate(g.ops + tl.ops, g.arcs, g.texts + tl.texts, this.crates.computed + st.crates) + (heavy === 2 && camMoving ? st.floorMs : 0);
    const allCrates = st.crates + st.stressCrates;
    const per = this.budget.host === 'hermes' ? 0.026 : 0.006;
    // a step up is predicted from what that rung cost when last drawn (30 s at most ago), else
    // from this frame: trains undone cost every crate again, other rungs ~15 % more
    this.qCost[q] = this.qCostAt[q] > t - 30_000 ? this.qCost[q] * 0.8 + est * 0.2 : est;
    this.qCostAt[q] = t;
    this.budget.record(est, g.ops + tl.ops, g.texts + tl.texts, interval, (qq: Quality) => (this.qCostAt[qq] > t - 30_000 ? this.qCost[qq] : qq < 3 && q >= 3 ? est + Math.max(0, allCrates - st.sprites) * per : est * 1.15));
    if (this.budget.quality !== this.qWas) {
      // every rung change, said once (drivers read the ladder's story from the log)
      const sb = this.budget.stats();
      console.log(`factory: quality q${this.qWas} → q${this.budget.quality} at ${Math.round(t)} ms · est ${est.toFixed(2)} ms (live ${g.ops} ops, top ${tl.ops} ops${tl.whole ? ' whole' : ''}) · interval ${interval.toFixed(1)} · fps ${sb.fps.toFixed(1)} p95 ${sb.frameP95.toFixed(1)} ms · gain ${this.budget.gain.toFixed(2)}`);
      this.qWas = this.budget.quality;
    }
    const hudOn = !!this.hud?.on;
    if (hudOn) this.drawHud(gt, f, t);
    ret.end();
    // Sleep when nothing moves (a game's idle frame): the canvas keeps its last picture and the
    // 250 ms tick (a surface argument) redraws it, enough for the slow progress bars. The HUD
    // and stress mode keep frames coming; so do flights, drags, hovers and replays.
    // Loud (a crate travelling, a reaction showing, a pointer, a flight, a replay, the HUD,
    // stress): every frame. Calm: sleep; the 125 ms pulse (motion.ts CALM_MS) wakes the layer for
    // the belts and the beat, 8 frames a second.
    const awake = moving || flying || !!this.drag || this.hoverId !== '' || hudOn || this.stress.on || this.tl.mode === 'replay' || this.tl.mode === 'behind'
      || settling; // fab-w4: the coffee check's first 10 s draw every frame (introHolds)
    if (!awake) st.slept++;
    this.awake = awake;
    return this.gpuClaim('live') || awake;
  }

  /** The coffee check's intro holds the frames (its first 10 s, or a replay of it, coffee.ts
   *  `busy`), and only it: before the intro opens (its digest not in yet) `busy` reads "the world
   *  is loaded", which would keep a calm floor awake for good if the digest never came; that
   *  wait holds frames 12 s at most. */
  private loadedAt = -1;
  private introHolds(t: number): boolean {
    if (!this.world.loaded) return false;
    if (this.loadedAt < 0 || t < this.loadedAt) this.loadedAt = t;
    const c = this.coffee;
    if (c.openAt >= 0) return c.busy(t);
    return t - this.loadedAt < 12_000 && c.busy(t);
  }

  // ---- the top canvas ---------------------------------------------------------------------------
  /** The `factoryTop` canvas, over the live one (pointer-events none): the words and the chrome
   *  the live frame recorded into `ret`, sent as changes only (cache.ts). It asks for frames while
   *  the live layer does (whose last draw asked for one: a live layer awake through its own
   *  frames wakes nothing else, so the top canvas must not sleep then), and once more after any
   *  argument: woken with the live one (they share their arguments), it may draw first, and the
   *  next frame flushes what the live one records. */
  drawTop(ctx: Ctx2D, f: Frame, t: number): boolean {
    if (freshBitmap(f) || this.topAt < 0) { this.ret.invalidate(); this.topFresh = true; }
    const was = this.topAt;
    this.topAt = t;
    // routing starts with the next live frame; until then the live canvas still draws the words
    if (t - was >= 1000) this.ret.invalidate();
    fastArcs(ctx, f.scale);
    this.ret.flush(ctx, f.width, f.height, f.scale);
    const claim = this.topFresh;
    this.topFresh = false;
    const args = f.causes.length ? f.causes.some((k) => k !== 'frame') : f.cause !== 'frame';
    return claim || args || this.liveWants || this.ret.pending;
  }

  /** For drivers and tests, once per camera at the fit: a busy bay's and the first rail's
   *  newest car's screen positions. */
  private logAnchors(): void {
    const cam = this.cam, c = this.census;
    const b0 = this.bays.find((x) => x.pid);
    if (b0 && this.logged !== `${b0.pid}|${cam.key}`) {
      this.logged = `${b0.pid}|${cam.key}`;
      if (cam.zoom === 1) console.log(`factory: busy bay ${b0.pid} at ${Math.round(cam.x(b0.u + b0.du / 2, b0.v + b0.dv / 2))},${Math.round(cam.y(b0.u + b0.du / 2, b0.v + b0.dv / 2, ENG_H))}`);
    }
    const r0 = c.rails[0], car0 = r0?.cars[r0.cars.length - 1];
    if (car0 && this.loggedCar !== `${car0.sha}|${cam.key}` && cam.zoom === 1) {
      this.loggedCar = `${car0.sha}|${cam.key}`;
      console.log(`factory: newest car ${car0.repo}@${car0.sha} at ${Math.round(cam.x(RAIL_U1 - 12, RAIL_V[0]))},${Math.round(cam.y(RAIL_U1 - 12, RAIL_V[0], 3))}`);
    }
  }

  /** The developer HUD (⌘⇧D) over the floor: top right, left of an open drawer. */
  private drawHud(g: Gfx, f: Frame, t: number): void {
    const st = this.stat, b = this.budget;
    const x = f.width - (this.selected ? 372 : 0) - 344 - 12, y = 44;
    const lodName = this.cam.zoom >= 2.6 ? 'apps' : this.cam.zoom >= 1.6 ? 'org districts' : 'fleet';
    // sampled four times a second, at once when a button changed what it says
    const key = `${b.quality}|${b.pinned}|${this.stress.on}|${lodName}`;
    let snap = this.hudSnap;
    if (!snap || t - snap.at >= 250 || t < snap.at || snap.key !== key) {
      const s = b.stats();
      const frozen = { stats: () => s, ops: b.ops, texts: b.texts, quality: b.quality, pinned: b.pinned, gain: b.gain, host: b.host } as unknown as Budget;
      snap = this.hudSnap = {
        at: t, b: frozen, key,
        info: {
          stress: this.stress.on, lod: lodName, hist: st.lod.slice(), crates: st.crates, stressCrates: st.stressCrates, sprites: st.sprites, trains: st.trains,
          cars: st.cars, bays: st.bays, labels: st.labels, hits: st.hits, floorRate: st.floorRate, floorMs: st.floorMs, floorOps: st.floorOps, slept: st.slept,
          scale: f.scale, W: f.width, H: f.height,
        },
      };
    }
    const r = this.fhud.draw(g, x, y, snap.b, snap.info);
    this.hit(r.stress.x, r.stress.y, r.stress.w, r.stress.h, 'stress', this.stress.on ? 'off' : 'on', 'Stress mode');
    this.hit(r.quality.x, r.quality.y, r.quality.w, r.quality.h, 'quality', '', 'Pin quality');
  }

  // ---- THE HOOK SURFACE (types.ts lists every member reached from outside) -------------------
  // fab-lens: the floor's plan and primitives for src/factory/lens.ts and coffee.ts.
  /** The internals the lens system draws and picks with, typed there by indexed access
   *  (`Factory['box']`), so a rename here fails the build there instead of a draw. */
  get fx(): FactoryFx { return this as unknown as FactoryFx; }
  readonly plan = PLAN;
  /** Every machine's slots (plant.ts). */
  get bays(): Bay[] { return this.plant.bays; }
  /** The city's blocks, by app, and its districts (city.ts). */
  get blocks(): Block[] { return this.city.blocks; }
  get blockAt(): Map<string, Block> { return this.city.blockAt; }
  get districtBox(): DistrictBox[] { return this.city.districtBox; }
  /** The labels placed this frame (the placer's, labels.ts). */
  get labels(): Label[] { return this.words.list; }

  poly(g: Gfx, pts: number[]): void { poly(this.cam, g, pts); }
  quad(g: Gfx, u0: number, v0: number, u1: number, v1: number, z = 0): void { quad(this.cam, g, u0, v0, u1, v1, z); }
  /** An extruded block: the faces the camera sees (front +v, right +u, top), dark, tone-shaded. */
  box(g: Gfx, u0: number, v0: number, du: number, dv: number, h: number, top: string = F.top, side: string = F.side, front: string = F.front, edge: string = F.edge, lw?: number): void {
    box(this.cam, g, u0, v0, du, dv, h, top, side, front, edge, lw);
  }
  /** A small crate (a cube) at floor point (u, v), side `d` world units. */
  crate(g: Gfx, u: number, v: number, d: number, red: boolean, dim: boolean, z = 2): void { crate(this.cam, g, u, v, d, red, dim, z); }
  /** One car (a lens draws a lit one over the floor's batched cars). */
  car(g: Gfx, u: number, v: number, red: boolean, settled: boolean): void { this.floor.car(g, u, v, red, settled, this.gl.hair); }
  /** Something the pointer can pick this frame (screen px; off screen is dropped). */
  hit(x: number, y: number, w: number, h: number, kind: string, id: string, label: string): void {
    if (x + w < 0 || y + h < 0 || x > this.cam.W || y > this.cam.H) return;
    this.hits.push({ x, y, w, h, kind, id, label });
  }
  /** Greedy label placement (labels.ts), for the lens system. */
  placeAt(x: number, y: number, w: number, h: number, maxUp: number, slide: boolean): [number, number] | null { return this.words.placeAt(x, y, w, h, maxUp, slide); }
  /** The v of an org's dock and of its main-line rail (floor.ts). */
  dockV(org: string): number { return this.floor.dockV(org); }
  railV(org: string): number { return this.floor.railV(org); }
  /** The layers' story for the lens on top (`Layer.overlay`): the first layer that owns its kind
   *  draws it; false when none does (lens.ts draws its own). */
  overlay(g: Gfx, lens: Lens): boolean {
    for (const L of this.order) if (L.overlay?.(g, lens, this.fr)) return true;
    return false;
  }
}
