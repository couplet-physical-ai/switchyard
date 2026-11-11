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

import type { Ctx2D, Frame } from '../../app.contract.d.ts';
import type { Event, Journey, Pipeline } from '../wire.ts';
import type { Timeline } from '../timeline.ts';
import type { World } from '../world.ts';
import { BOTS } from '../world.ts';
import { Budget, type Quality } from '../yard/budget.ts';
import { Gfx, times } from '../yard/gfx.ts';
import type { Hud } from '../yard/hud.ts';
import { C, TAU, clamp, font, withAlpha } from '../yard/theme.ts';
import { BoxBatch, TrainTable } from './batch.ts';
import { AGES, AGE_WORDS, Census, PHASES, failingStep, short } from './census.ts';
import { FacHud } from './hud.ts';
import { Cam, LU, LV } from './iso.ts';
import { R_BEAM, R_DOOR, R_RING, Ripples, arrival, beltSpeedPx, blink, breathe, flash } from './motion.ts';
import { FACTOR, FactoryStress } from './stress.ts';
import { Lenses } from './lens.ts'; // fab-lens
import { Coffee } from './coffee.ts'; // fab-lens
import type { FactoryFx } from './lens.ts'; // fab-lens
import { PLAN, VIA_WORDS } from './layout.ts';
import { F, HOUR_MS, MONO, SMALL, TITLE, box as boxP, clockWords, crate as crateP, dur, easeInOut, flushLights as flushLightsP, hash, onScreen as onScreenP, pipeWords as pipeWordsP, poly as polyP, quad as quadP, ring as ringP, runningStep } from './prims.ts';
import type { Bay, Block, Crate, DistrictBox, FloorPass, HitBox, Label, Layer, LiveFrame, Pt } from './types.ts';
import { buildLayers } from './layers.ts';

export type { Plan } from './types.ts';
export { dur };

const {
  DOCK_U0, DOCK_U1, COLLECT_U, AISLE_V, YARD_U0, YARD_U1, ROW_U, ROW_DU, AGE_V, STACK_DV, PALLET_V, GATE_U,
  RAIL_U0, RAIL_U1, RAIL_V, INTAKE_U0, INTAKE_U1, LANE_V, DIST_U, ENG_U0, ENG_U1, ENG_V0, ENG_STEP, ENG_DV, ENG_H,
  SCAN_U, TRACK_V, TRACK_U1, CITY_U0, CITY_U1, CITY_V0, CITY_V1, RETURN_V, VIAS,
} = PLAN;

export class Factory {
  readonly cam = new Cam();
  readonly census = new Census();
  readonly budget = new Budget();
  private gf = new Gfx();
  private gl = new Gfx();
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
  /** Every machine's slots (plant.ts). */
  get bays(): Bay[] { return this.plant.bays; }
  /** The city's blocks, by app, and its districts (city.ts). */
  get blocks(): Block[] { return this.city.blocks; }
  get blockAt(): Map<string, Block> { return this.city.blockAt; }
  get districtBox(): DistrictBox[] { return this.city.districtBox; }
  private hits: HitBox[] = [];
  /** The labels placed this frame (the placer's, labels.ts). */
  get labels(): Label[] { return this.words.list; }
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
  /** Asleep between the calm clock's wake-ups (app.contract's `facBeat` runs while this holds). */
  get calm(): boolean { return !this.awake; }
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

  constructor(public tl: Timeline) {
    // The floor's full rung costs ~4.4 ms on Hermes at 1× (its words: ~80 texts at ~22 µs);
    // 5.2 ms (13 % under the 6 ms budget) lets it climb back there after a hitch.
    this.budget.upHeadroom = 5.2;
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
  // Each event sends its crate along its path; every reaction on the way (motion.ts) fires when
  // the crate ARRIVES there: a push flashes its dock's door as it leaves and rings the gate and
  // its rail (or the yard's cell) as it gets there; a finish lights the scanner's beam when its
  // crate passes it, and a failure's red door at its dock 9 s later; a deploy rings its
  // building when the crate reaches it.
  onEvent(e: Event, w: World, t: number): void {
    if (this.reduced) return;
    this.crates.cap();
    for (const L of this.order) L.onEvent?.(e, w, t);
  }

  private flown = false;
  /** fab-lens: every object is a lens (lens.ts); what changed since you last looked (coffee.ts). */
  readonly lens = new Lenses(this);
  readonly coffee = new Coffee(this);

  /** The v of an org's dock and of its main-line rail (floor.ts). */
  dockV(org: string): number { return this.floor.dockV(org); }
  railV(org: string): number { return this.floor.railV(org); }

  // ---- pointer, camera -------------------------------------------------------------------------
  pointer(kind: string, x: number, y: number, buttons: number, t: number): HitBox | null {
    if (kind.startsWith('key:')) return this.lens.key(kind.slice(4), t); // fab-lens: Esc/⌫ walk back, ? the key
    this.px = x; this.py = y;
    if (kind === 'down') { this.drag = { x, y, moved: false }; return null; }
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

  /** The selection's pipeline (a commit selection: its newest pipeline). */
  selPipeline(): Pipeline | null {
    const w = this.world;
    if (!this.selected) return null;
    const p = w.pipelines.get(this.selected);
    if (p) return p;
    const c = w.commits.get(this.selected);
    if (c) for (let i = c.pipelines.length - 1; i >= 0; i--) { const q = w.pipelines.get(c.pipelines[i]); if (q) return q; }
    return null;
  }

  /** repo and sha of the selection (for the journey fetch). */
  selCommit(): { repo: string; sha: string } | null {
    const p = this.selPipeline();
    if (p) return { repo: p.repo, sha: p.sha };
    const at = this.selected.indexOf('@');
    if (at > 0) return { repo: this.selected.slice(0, at), sha: this.selected.slice(at + 1) };
    return null;
  }

  // ---- geometry primitives ---------------------------------------------------------------------
  poly(g: Gfx, pts: number[]): void { polyP(this.cam, g, pts); }

  quad(g: Gfx, u0: number, v0: number, u1: number, v1: number, z = 0): void { quadP(this.cam, g, u0, v0, u1, v1, z); }

  /** An extruded block: the faces the camera sees (front +v, right +u, top), dark, tone-shaded. */
  box(g: Gfx, u0: number, v0: number, du: number, dv: number, h: number, top: string = F.top, side: string = F.side, front: string = F.front, edge: string = F.edge, lw?: number): void {
    boxP(this.cam, g, u0, v0, du, dv, h, top, side, front, edge, lw);
  }

  /** A small crate (a cube) at floor point (u, v), side `d` world units. */
  crate(g: Gfx, u: number, v: number, d: number, red: boolean, dim: boolean, z = 2): void { crateP(this.cam, g, u, v, d, red, dim, z); }

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
  get floorKey(): string { return `${this.cam.key}|${this.census.sig}|${this.census.healthSig}|${this.census.carSig}|${this.budget.quality >= 3 ? 'lo' : 'hi'}`; }

  private onScreen(u0: number, v0: number, u1: number, v1: number, h = 0, pad = 24): boolean { return onScreenP(this.cam, u0, v0, u1, v1, h, pad); }

  drawFloor(ctx: Ctx2D, f: Frame, t: number): boolean {
    this.applyStress();
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
      add: (u, v, fn, u1, v1, h) => { if (this.onScreen(u, v, u1, v1, h)) items.push({ k: u * 0.19 + v * 0.66, f: fn }); },
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
    return false;
  }

  // ---- the live layer ---------------------------------------------------------------------------
  drawLive(ctx: Ctx2D, f: Frame, t: number, wheel: number): boolean {
    this.applyStress();
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
    const g = this.gl, cam = this.cam, w = this.world, c = this.census;
    const now = this.tl.playhead;
    g.begin(ctx, f.scale);
    if (f.cause === 'font') g.resetFonts();
    ctx.resetTransform();
    ctx.clearRect(0, 0, f.width, f.height);
    this.hits = [];
    this.lens.under(g, t); // fab-lens: every floor object's hit, parked failures, fresh glows, smoke, beacons
    this.words.reset();
    const st = this.stat;
    const sec = Math.floor(t / 1000);
    if (sec !== st.sec) { st.floorRate = st.floorDraws; st.floorDraws = 0; st.sec = sec; }
    if (c.skeleton) { this.words.idle(g); this.awake = false; return false; }
    const q = this.budget.quality;
    const fr = this.fr;
    fr.ctx = ctx; fr.f = f; fr.t = t; fr.now = now; fr.q = q; fr.detail = cam.zoom >= 1.6;
    // the layers, back to front (layers.ts): each one's hits, then each one's live drawing (the
    // haze, belts and cars; the intake, bays and gauges; the city's hits and trouble; the
    // reactions; deploys on their tracks; crates in motion; the labels). One still moving keeps
    // the frames coming.
    for (const L of this.order) L.hits?.(fr);
    let moving = false;
    for (const L of this.order) if (L.live?.(g, fr)) moving = true;
    // the journey of the selection: its path lights across the floor, the rest dims to 25 %
    const selP = this.selPipeline();
    this.lens.draw(g, ctx, f, t); // fab-lens: the lens on top dims the rest and tells its story
    if (this.selected) this.drawJourney(g, ctx, f, selP, t);
    // failures riding home are named (failure is the main character), under the conveyor
    this.crates.tags(g, t, q);
    st.labels = this.labels.length;
    // 10. the drawer, the time strip, the camera controls
    if (this.selected) this.drawDrawer(g, f, selP, now);
    if (this.lens.legacyKey && !this.selected && this.cam.zoom < 1.2) this.words.legend(g, f); // fab-lens: the key is on demand (?)
    // hover: quick facts beside the pointer
    if (this.hoverId && !this.drag) {
      const h = this.hitAt(this.px, this.py);
      if (h && h.label && h.kind !== 'stage' && h.kind !== 'drawer') {
        const facts = this.facts(h);
        const wv = Math.max(...facts.map((l) => g.width(l, SMALL))) + 16;
        const bx = Math.min(this.px + 14, f.width - wv - 8), by = this.py + 18;
        g.fillRect(bx, by, wv, facts.length * 16 + 10, '#161618');
        g.begin_(); g.rect(bx + 0.5, by + 0.5, wv - 1, facts.length * 16 + 9); g.stroke('#3A3A3E', 1);
        facts.forEach((l, i) => g.text(l, bx + 8, by + 18 + i * 16, i ? C.ink2 : C.ink, SMALL, i === 0));
      }
    }
    this.drawStrip(g, f, now);
    this.drawControls(g, f);
    const b0 = this.bays.find((x) => x.pid);
    if (b0 && this.logged !== `${b0.pid}|${this.cam.key}`) {
      this.logged = `${b0.pid}|${this.cam.key}`;
      const b = b0;
      if (b && this.cam.zoom === 1) console.log(`factory: busy bay ${b.pid} at ${Math.round(cam.x(b.u + b.du / 2, b.v + b.dv / 2))},${Math.round(cam.y(b.u + b.du / 2, b.v + b.dv / 2, ENG_H))}`);
    }
    // the newest car on the first rail, for drivers and tests (once per camera)
    const r0 = c.rails[0], car0 = r0?.cars[r0.cars.length - 1];
    if (car0 && this.loggedCar !== `${car0.sha}|${this.cam.key}` && this.cam.zoom === 1) {
      this.loggedCar = `${car0.sha}|${this.cam.key}`;
      console.log(`factory: newest car ${car0.repo}@${car0.sha} at ${Math.round(cam.x(RAIL_U1 - 12, RAIL_V[0]))},${Math.round(cam.y(RAIL_U1 - 12, RAIL_V[0], 3))}`);
    }
    this.lens.top(g, f, t); // fab-lens: breadcrumb, story/compare card, the coffee glance, the key
    this.lastT = t;
    st.hits = this.hits.length;
    // the frame's cost (the cost model, budget.ts) and the ladder; the HUD draws last and
    // counts itself (it is the developer's, so it is outside the factory's own budget)
    const est = this.budget.estimate(g.ops, g.arcs, g.texts, this.crates.computed + st.crates) + (heavy === 2 && camMoving ? st.floorMs : 0);
    const allCrates = st.crates + st.stressCrates;
    const per = this.budget.host === 'hermes' ? 0.026 : 0.006;
    // a step up is predicted from what that rung cost when last drawn (30 s at most ago), else
    // from this frame: trains undone cost every crate again, other rungs ~15 % more
    this.qCost[q] = this.qCostAt[q] > t - 30_000 ? this.qCost[q] * 0.8 + est * 0.2 : est;
    this.qCostAt[q] = t;
    this.budget.record(est, g.ops, g.texts, interval, (qq: Quality) => (this.qCostAt[qq] > t - 30_000 ? this.qCost[qq] : qq < 3 && q >= 3 ? est + Math.max(0, allCrates - st.sprites) * per : est * 1.15));
    const hudOn = !!this.hud?.on;
    if (hudOn) this.drawHud(g, f);
    // Sleep when nothing moves (a game's idle frame): the canvas keeps its last picture and the
    // 250 ms tick (a surface argument) redraws it, enough for the slow progress bars. The HUD
    // and stress mode keep frames coming; so do flights, drags, hovers and replays.
    // Loud (a crate travelling, a reaction showing, a pointer, a flight, a replay, the HUD,
    // stress): every frame. Calm: sleep; the 125 ms pulse (motion.ts CALM_MS) wakes the layer for
    // the belts and the beat, 8 frames a second.
    const awake = moving || flying || !!this.drag || this.hoverId !== '' || hudOn || this.stress.on || this.tl.mode === 'replay' || this.tl.mode === 'behind';
    if (!awake) st.slept++;
    this.awake = awake;
    return awake;
  }

  /** The draw estimate (ms) each quality rung cost when it was last drawn, and when. */
  private qCost = new Float32Array(5);
  private qCostAt = new Float64Array(5).fill(-1e12);

  /** The developer HUD (⌘⇧D) over the floor: top right, left of an open drawer. */
  private drawHud(g: Gfx, f: Frame): void {
    const st = this.stat;
    const x = f.width - (this.selected ? 372 : 0) - 344 - 12, y = 44;
    const lodName = this.cam.zoom >= 2.6 ? 'apps' : this.cam.zoom >= 1.6 ? 'org districts' : 'fleet';
    const r = this.fhud.draw(g, x, y, this.budget, {
      stress: this.stress.on, lod: lodName, hist: st.lod, crates: st.crates, stressCrates: st.stressCrates, sprites: st.sprites, trains: st.trains,
      cars: st.cars, bays: st.bays, labels: st.labels, hits: st.hits, floorRate: st.floorRate, floorMs: st.floorMs, floorOps: st.floorOps, slept: st.slept,
      scale: f.scale, W: f.width, H: f.height,
    });
    this.hit(r.stress.x, r.stress.y, r.stress.w, r.stress.h, 'stress', this.stress.on ? 'off' : 'on', 'Stress mode');
    this.hit(r.quality.x, r.quality.y, r.quality.w, r.quality.h, 'quality', '', 'Pin quality');
  }

  /** One car (a lens draws a lit one over the floor's batched cars). */
  car(g: Gfx, u: number, v: number, red: boolean, settled: boolean): void { this.floor.car(g, u, v, red, settled, this.gl.hair); }

  private ring(g: Gfx, u: number, v: number, r: number, z = 0): void { ringP(this.cam, g, u, v, r, z); }

  hit(x: number, y: number, w: number, h: number, kind: string, id: string, label: string): void {
    if (x + w < 0 || y + h < 0 || x > this.cam.W || y > this.cam.H) return;
    this.hits.push({ x, y, w, h, kind, id, label });
  }

  private pipeWords(p: Pipeline | undefined): string { return pipeWordsP(p); }

  /** Greedy label placement (labels.ts), for the lens system. */
  placeAt(x: number, y: number, w: number, h: number, maxUp: number, slide: boolean): [number, number] | null { return this.words.placeAt(x, y, w, h, maxUp, slide); }

  // ---- the journey -------------------------------------------------------------------------------
  private journeyPath(p: Pipeline | null): { pts: Pt[]; red: boolean; stops: [Pt, string][] } {
    const w = this.world;
    const cm = this.selCommit();
    const repo = p?.repo ?? cm?.repo ?? '';
    const org = w.orgOf(repo);
    const dv = this.dockV(org), rv = this.railV(org);
    const pts: Pt[] = [[DOCK_U0 + 20, dv], [COLLECT_U, dv], [COLLECT_U, AISLE_V]];
    const stops: [Pt, string][] = [[[DOCK_U0 + 20, dv], 'pushed']];
    const prN = p?.pr ?? w.commits.get(`${repo}@${cm?.sha ?? ''}`)?.pr;
    if (prN || p?.event === 'pull_request') {
      pts.push([ROW_U[1], AISLE_V], [ROW_U[1], AGE_V[0] + 10], [ROW_U[3], AGE_V[0] + 10], [ROW_U[3], AISLE_V]);
      stops.push([[ROW_U[1], AGE_V[0] + 10], `PR #${prN ?? ''}`]);
    }
    pts.push([YARD_U1, AISLE_V], [GATE_U + 4, AISLE_V], [RAIL_U0, rv], [RAIL_U1, rv], [INTAKE_U0, LANE_V[p?.lane === 'gha' ? 1 : 0]], [INTAKE_U1, LANE_V[p?.lane === 'gha' ? 1 : 0]]);
    stops.push([[GATE_U + 4, AISLE_V], 'merged']);
    stops.push([[INTAKE_U0 + 20, LANE_V[p?.lane === 'gha' ? 1 : 0]], 'queued']);
    const bay = p ? (this.bays.find((b) => b.pid === p.id) ?? this.plant.lastBay.get(p.id ?? '')) : undefined;
    const gi = p?.lane === 'gha' ? this.census.groups.length - 1 : 0;
    const bv = bay ? bay.v + bay.dv / 2 : ENG_V0 + gi * ENG_STEP + ENG_DV / 2;
    const bu = bay ? bay.u + bay.du / 2 : (ENG_U0 + ENG_U1) / 2;
    pts.push([DIST_U, LANE_V[0]], [DIST_U, bv], [bu, bv]);
    stops.push([[bu, bv], p?.state === 'running' ? 'building' : 'built']);
    if (!p || p.state === 'running' || p.state === 'pending') return { pts, red: false, stops };
    pts.push([ENG_U1, bv], [SCAN_U, bv]);
    const red = p.state === 'failure' || p.state === 'error';
    stops.push([[SCAN_U, bv], red ? `failed · ${failingStep(p)}` : 'passed']);
    if (red) {
      pts.push([SCAN_U, RETURN_V], [24, RETURN_V], [24, dv]);
      return { pts, red, stops };
    }
    const dep = w.deploys.get(`${p.repo}@${p.sha}`);
    const app = dep?.app ?? w.repos.get(p.repo)?.app;
    const b = app ? this.blockAt.get(app) : undefined;
    if (b && (dep || p.deploy)) {
      const vi = Math.max(0, VIAS.indexOf(((dep?.via === 'manual' ? 'gha_fallback' : dep?.via) ?? 'roadrunner') as typeof VIAS[number]));
      pts.push([SCAN_U, TRACK_V[vi]], [TRACK_U1, TRACK_V[vi]], [b.u + b.d / 2, b.v + b.d / 2]);
      stops.push([[b.u + b.d / 2, b.v + b.d / 2], `${app} ${dep?.state === 'success' ? 'deployed' : dep?.state ?? 'deploying'}`]);
    }
    return { pts, red, stops };
  }

  private drawJourney(g: Gfx, ctx: Ctx2D, f: Frame, p: Pipeline | null, t: number): void {
    const cam = this.cam;
    // the rest of the floor dims to 25 %
    g.fillRect(0, 0, f.width, f.height, withAlpha(C.canvas, 0.75));
    const { pts, red, stops } = this.journeyPath(p);
    const col = red ? C.red : C.packet;
    const trace = () => { g.begin_(); pts.forEach(([u, v], i) => { const x = cam.x(u, v), y = cam.y(u, v, 1); if (i) g.line(x, y); else g.move(x, y); }); };
    ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    trace(); g.stroke(withAlpha(col, 0.18), 9);
    trace(); g.stroke(withAlpha(col, 0.35), 4);
    trace(); g.stroke(col, 1.5);
    // a travelling spark along the lit path (where the selection is now)
    let total = 0;
    for (let i = 1; i < pts.length; i++) total += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    const run = p?.state === 'running';
    if (run) {
      const bay = this.bays.find((b) => b.pid === p?.id);
      if (bay) this.crate(g, bay.u + bay.du / 2, bay.v + bay.dv / 2, 11, false, false, ENG_H - 3);
    }
    void total; void t;
    // stops: the stations it passed, named (the dimmed words below no longer claim space)
    this.words.reset();
    stops.forEach(([[u, v], s], i) => {
      const x = cam.x(u, v), y = cam.y(u, v, 1);
      g.begin_(); g.move(x, y - 4); g.line(x + 4, y); g.line(x, y + 4); g.line(x - 4, y); g.ctx.closePath(); g.fill(i === stops.length - 1 ? col : C.ink);
      const bad = s.startsWith('failed');
      this.words.tag(g, s, x + 7, y - 6, bad ? C.redText : C.ink2, bad ? C.red : '#5A5A5E');
    });
  }

  // ---- the drawer ----------------------------------------------------------------------------------
  private drawDrawer(g: Gfx, f: Frame, p: Pipeline | null, now: number): void {
    const w = this.world;
    const W = 372, x0 = f.width - W, y0 = 40, H = f.height - y0 - 66;
    g.fillRect(x0, y0, W, H, '#111112');
    g.vline(g.crisp(x0), y0, y0 + H, '#2E2E30');
    g.hline(x0, x0 + W, g.crisp(y0), '#2E2E30');
    this.hit(x0, y0, W, H, 'drawer', '', '');
    this.hit(x0 + W - 30, y0 + 6, 24, 22, 'close', '', 'close');
    g.text('×', x0 + W - 18, y0 + 22, C.ink3, 14, false, 'center');
    let y = y0 + 24;
    const j = this.journey && this.journeyFor === this.selected ? this.journey : null;
    // the world may no longer hold it (a replay, retention): the journey the server sent does
    if (!p && j?.pipelines?.length) p = j.pipelines.find((q) => q.id === this.selected) ?? j.pipelines[j.pipelines.length - 1];
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
      g.text(at === t0 ? clockWords(at, this.offsetMin) : `+${dur(at - t0)}`, x0 + 30, y, C.ink3, SMALL);
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

  // ---- the time strip and the fleet sentence ------------------------------------------------------
  private drawStrip(g: Gfx, f: Frame, now: number): void {
    const c = this.census, w = this.world, tl = this.tl;
    const y0 = f.height - 58, H = 58, W = f.width;
    g.fillRect(0, y0, W, H, withAlpha(C.canvas, 0.94));
    g.hline(0, W, g.crisp(y0), '#1F1F21');
    // the span control: live · last hour · 24 h
    const mode = tl.mode;
    const opts: [string, string][] = [['live', 'live'], [mode === 'replay' ? 'replaying the hour' : 'replay last hour', 'replay'], ['24 h at 60×', 'replay24']];
    let x = 16;
    g.fillRect(x, y0 + 13, 4 + opts.reduce((a, [s]) => a + g.width(s, 13) + 22, 0), 28, '#1A1A1C');
    x += 2;
    for (const [s, k] of opts) {
      const on = (k === 'live' && mode === 'live') || (k === 'replay' && mode === 'replay');
      const wv = g.width(s, 13) + 22;
      if (on) g.fillRect(x, y0 + 15, wv, 24, '#2C2C2E');
      if (k === 'live') { g.begin_(); g.circle(x + 10, y0 + 27, 3); g.fill(mode === 'live' ? C.green : C.ink4); }
      g.text(s, x + (k === 'live' ? 17 : 11), y0 + 31.5, on ? C.ink : C.ink2, 13);
      this.hit(x, y0 + 13, wv, 28, k, k, s);
      x += wv;
    }
    // the last 24 h: event density per 5 min, failures red, the playhead amber
    const sx = x + 20, sw = Math.min(460, W * 0.3), sh = 22, sy = y0 + 13;
    let mx = 1;
    for (let i = 0; i < 288; i += 2) mx = Math.max(mx, (c.dens[i] + c.dens[i + 1]) / 2);
    // ten-minute bars, each one stroke (a bar is 2 calls; a rect is 6 on the native recorder)
    const bw = Math.max(0.8, (sw / 144) * 0.75);
    for (let pass = 0; pass < 2; pass++) {
      const d = pass ? c.densRed : c.dens;
      g.begin_();
      for (let i = 0; i < 288; i += 2) {
        const h = ((d[i] + d[i + 1]) / (mx * 2)) * sh;
        if (h <= 0.3) continue;
        const x = sx + ((i + 1) / 288) * sw;
        g.move(x, sy + sh); g.line(x, sy + sh - h);
      }
      g.stroke(pass ? C.red : '#3A3A3E', bw);
    }
    g.hline(sx, sx + sw, g.crisp(sy + sh + 0.5), '#2A2A2C');
    const ph = mode === 'replay' ? 1 - (tl.liveNow() - now) / (24 * HOUR_MS) : 1;
    const px = sx + clamp(ph, 0, 1) * sw;
    g.vline(g.crisp(px), sy - 3, sy + sh + 3, C.packet, 1.5);
    this.lens.strip(g, sx, sy, sw, sh, now); // fab-lens: a tick jumps the replay there
    g.text('24 h ago', sx, sy + sh + 15, C.ink3, 12);
    g.text(mode === 'live' ? 'now' : clockWords(now, this.offsetMin), sx + sw, sy + sh + 15, mode === 'live' ? C.ink3 : C.amberText, 12, false, 'right');
    // the fleet sentence: failure first
    const red = c.redLines;
    let up = 0, down = 0;
    for (const a of w.apps.values()) { if (a.health === 'up') up++; else if (a.health === 'down') down++; }
    const bx = sx + sw + 26;
    const head: [string, string, boolean?][] = red ? [[`${red} main ${red === 1 ? 'line' : 'lines'} red`, C.redText, true]] : [['every main line green', C.green, true]];
    if (down) head.push([` · ${down} ${down === 1 ? 'app' : 'apps'} down`, C.redText, true]);
    const slots = c.groups.reduce((a, gr) => a + (gr.hosted ? 0 : gr.slots), 0);
    const busy = c.groups.reduce((a, gr) => a + (gr.hosted ? 0 : gr.running.length), 0);
    // one count per thing, the same words the floor and the status line use
    const tail: string[] = [`${c.building} building (${busy} of ${slots} bays)`, `${c.waiting} queued`, `${c.deploying.length} deploying`, `${c.flow.finished} builds/h`, `${c.flow.failed} failed/h`, `${up} of ${w.apps.size} apps up`];
    if (c.bottleneck) tail.push(`bottleneck: ${({ prs: 'pr yard', intake: 'intake', engines: 'the engines', deploy: 'deploy' } as Record<string, string>)[c.bottleneck]}`);
    // whole fields only: drop from the end instead of cutting one
    let room = W - bx - 16 - head.reduce((a, [s, , b]) => a + g.width(s, 13, !!b), 0);
    let line = '';
    for (const t of tail) { const add = `  ·  ${t}`; if (g.width(line + add, 13) > room) break; line += add; }
    g.runs([...head.map(([s, col]) => [s, col, true] as [string, string, boolean]), [line, C.ink2]], bx, y0 + 26, 13);
    void room;
    const parts = [`${w.repos.size} repos`, `${c.docks.length - 1} orgs`, `${this.census.phaseN.reduce((a, b) => a + b, 0) + c.botN} PRs open`];
    if (c.redNames.length) parts.push(`newest red: ${c.redNames.join(', ')}`);
    let l2 = '';
    for (const t of parts) { const add = l2 ? ` · ${t}` : t; if (g.width(l2 + add, 12) > W - bx - 16) break; l2 += add; }
    g.text(l2, bx, y0 + 44, C.ink3, 12);
  }

  private facts(h: HitBox): string[] {
    const lf = this.lens.preview(h); // fab-lens: ≤ 3 short lines per kind
    if (lf) return lf;
    const w = this.world, now = this.tl.playhead;
    if (h.kind === 'pipeline') {
      const p = w.pipelines.get(h.id);
      if (!p) return [h.label];
      const el = p.started ? (p.finished ?? now) - p.started : now - p.created;
      return [`${p.repo} #${p.number}`, `${p.state} · ${dur(el)}${p.expected_ms ? ` · typical ${dur(p.expected_ms)}` : ''}`, `${p.event} · ${p.branch}${p.engine ? ` · ${p.engine}` : ''}`, 'click: light its journey'];
    }
    if (h.kind === 'app') {
      const a = w.apps.get(h.id);
      return [h.id, `${a?.health ?? 'unknown'}${a?.latency_ms ? ` · ${a.latency_ms} ms` : ''}${a?.team ? ` · ${a.team}` : ''}`, `${this.census.deploys24.get(h.id) ?? 0} deploys in 24 h${a?.behind ? ` · ${a.behind} behind main` : ''}`];
    }
    if (h.kind === 'commit') return [h.label.slice(0, 60), 'click: light its journey'];
    return [h.label];
  }

  private drawControls(g: Gfx, f: Frame): void {
    const x = 16, y = 46;
    const btn = (s: string, k: string, xx: number) => {
      g.fillRect(xx, y, 24, 22, '#1A1A1C');
      g.begin_(); g.rect(xx + 0.5, y + 0.5, 23, 21); g.stroke('#2E2E30', 1);
      g.text(s, xx + 12, y + 15, C.ink2, 12, false, 'center');
      this.hit(xx, y, 24, 22, k, k, s);
    };
    btn('+', 'zoomin', x); btn('−', 'zoomout', x + 26); btn('⌂', 'fit', x + 52);
    const lod = this.cam.zoom >= 2.6 ? 'apps' : this.cam.zoom >= 1.6 ? 'org districts' : 'fleet';
    // the zoom and its level of detail (how to pan and zoom needs no permanent words)
    const words: [string, string][] = [[`${Math.round(this.cam.zoom * 100)}%  ${lod}`, C.ink2]];
    if (this.lens.legacyKey) words.push(['  drag to pan · wheel to zoom · click a crate', C.ink3]); // fab-lens: the coffee glance takes the hint's place
    const wv = words.reduce((a, [s]) => a + g.width(s, SMALL), 0);
    g.fillRect(x + 80, y, wv + 12, 22, withAlpha(C.canvas, 0.86));
    g.runs(words, x + 86, y + 15, SMALL);
    void f;
  }

  // ---- fab-lens hooks: the floor's plan and primitives for src/factory/lens.ts and coffee.ts ----
  /** The internals the lens system draws and picks with, typed there by indexed access
   *  (`Factory['box']`), so a rename here fails the build there instead of a draw. */
  get fx(): FactoryFx { return this as unknown as FactoryFx; }
  readonly plan = PLAN;
}

void AGES; void short; void font;
