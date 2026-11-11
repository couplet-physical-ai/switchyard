// The city of apps (fab-w0, from factory.ts): one block per app, packed into districts by team
// (columns of the city, back to front, a street between; the pitch shrinks until the whole city
// fits its plot), health lights on the roofs, LOD by a block's size on screen, the trouble spots
// breathing on the beat. Deploys and health changes ring their building from here.

import type { Event } from '../wire.ts';
import type { World } from '../world.ts';
import type { Gfx } from '../yard/gfx.ts';
import { C, withAlpha } from '../yard/theme.ts';
import type { Factory } from './factory.ts';
import { PLAN } from './layout.ts';
import { R_RING, breathe } from './motion.ts';
import { flushLights, hash } from './prims.ts';
import type { Block, DistrictBox, FloorPass, Layer, LiveFrame } from './types.ts';

const { SCAN_U, TRACK_V, TRACK_U1, CITY_U0, CITY_U1, CITY_V0, CITY_V1, VIAS } = PLAN;

export class City implements Layer {
  readonly name = 'city';
  blocks: Block[] = [];
  readonly blockAt = new Map<string, Block>();
  districtBox: DistrictBox[] = [];
  private cityKey = '';
  private cityRows: Block[][] = [];
  cityPitch = 19;
  private trouble: Block[] = [];
  private troubleAt = '';

  constructor(readonly f: Factory) {}

  /** Pack the city again at the next census check (stress mode toggled). */
  invalidate(): void { this.cityKey = ''; }

  census(): void { this.layoutCity(); }

  // ---- events: a deploy's crate rides its track into the city and rings its building; a
  // health change rings it at once ----
  onEvent(e: Event, w: World, t: number): void {
    void w;
    const R = this.f.reactions.rp;
    switch (e.k) {
      case 'deploy': {
        if (e.state !== 'running' && e.state !== 'success' && e.state !== 'failure') break;
        const b = this.blockAt.get(e.app);
        const vi = Math.max(0, VIAS.indexOf((e.via === 'manual' ? 'gha_fallback' : e.via) as typeof VIAS[number]));
        if (e.state === 'running' && b) {
          const cr = this.f.crates.spawn(`${e.app}@${e.sha}`, 'deploy', [[SCAN_U + 14, TRACK_V[vi]], [TRACK_U1, TRACK_V[vi]], [CITY_U0 - 4, b.v + b.d / 2], [b.u + b.d / 2, b.v + b.d / 2]], t, 2400, false, '', '');
          R.add(R_RING, b.u + b.d / 2, b.v + b.d / 2, b.h + 1.5, this.f.crates.arrives(cr, 3), false, 1200);
        }
        if (e.state !== 'running' && b) R.add(R_RING, b.u + b.d / 2, b.v + b.d / 2, b.h + 1.5, t, e.state === 'failure', 1600, e.state === 'success');
        break;
      }
      case 'health': {
        const b = this.blockAt.get(e.app);
        if (b) R.add(R_RING, b.u + b.d / 2, b.v + b.d / 2, b.h + 1.5, t, e.to === 'down' || e.to === 'degraded', 1600, e.to === 'up');
        break;
      }
      default: break;
    }
  }

  private layoutCity(): void {
    const c = this.f.census;
    const key = `${c.districts.map((d) => `${d.team}:${d.apps.length}`).join(',')}`;
    if (key === this.cityKey) return;
    this.cityKey = key;
    // Districts fill columns of the city, back to front, then the next column; a street between.
    // The pitch shrinks until the whole city fits its plot (stress mode's 2,370 apps too).
    let pitch = 19;
    for (; pitch > 4; pitch -= pitch > 10 ? 1 : 0.5) if (this.packCity(pitch, true)) break;
    this.packCity(pitch, false);
    // far first; and the rows (one v each), the floor's batches
    this.blocks.sort((a, b) => (a.u + a.v * 3.47) - (b.u + b.v * 3.47));
    const rows = new Map<number, Block[]>();
    for (const b of this.blocks) { let r = rows.get(b.v); if (!r) { r = []; rows.set(b.v, r); } r.push(b); }
    this.cityRows = [...rows.entries()].sort((a, b) => a[0] - b[0]).map((e) => e[1]);
    this.cityPitch = pitch;
  }

  /** The city's blocks at `pitch`; `dry`: only whether they fit the plot. */
  private packCity(pitch: number, dry: boolean): boolean {
    const c = this.f.census;
    const d = Math.max(3, Math.round(pitch * 0.68 * 2) / 2), street = Math.max(6, Math.round(pitch * 0.84));
    const hk = pitch / 19;
    const cols = Math.floor((CITY_U1 - CITY_U0 + 6) / pitch);
    let u = CITY_U0, v = CITY_V0;
    let colW = 0;
    if (!dry) { this.blocks = []; this.blockAt.clear(); this.districtBox = []; }
    let virt = 0;
    for (let di = 0; di < c.districts.length; di++) {
      const dist = c.districts[di];
      const n = dist.apps.length;
      // Pack districts as rectangles: width in cells chosen so the district is about square.
      let w = Math.max(2, Math.min(cols, Math.ceil(Math.sqrt(n * 1.1))));
      if (n > 60) w = Math.min(cols, Math.max(7, Math.ceil(Math.sqrt(n * 0.4))));
      const h = Math.ceil(n / w);
      if (v + h * pitch > CITY_V1 + 4) { u += colW * pitch + street; v = CITY_V0; colW = 0; }
      if (dry) {
        if (u + w * pitch > CITY_U1 + 8 || v + h * pitch > CITY_V1 + 4) return false;
        v += h * pitch + street;
        colW = Math.max(colW, w);
        continue;
      }
      const u0 = u, v0 = v;
      dist.apps.forEach((id, i) => {
        const bu = u0 + (i % w) * pitch, bv = v0 + Math.floor(i / w) * pitch;
        const deps = c.deploys24.get(id) ?? 0;
        const idle = id.startsWith('~idle');
        const hv = idle ? 4 : id.includes('~') ? -2 - virt++ : -1;
        const b: Block = { id, u: bu, v: bv, d, h: idle ? 3 + (hash(id) % 4) : (4 + Math.min(16, deps * 2.2) + (hash(id) % 3)) * hk, district: di, hv };
        this.blocks.push(b);
        this.blockAt.set(id, b);
      });
      this.districtBox.push({ team: dist.team, u0, v0, u1: u0 + w * pitch - (pitch - d), v1: v0 + h * pitch - (pitch - d), n });
      v += h * pitch + street;
      colW = Math.max(colW, w);
    }
    if (!dry) this.f.stress.ensureHealth(virt);
    return true;
  }

  /** A block's health light: 0 up, 1 degraded, 2 down, 3 unknown, 4 none (the idle floor). */
  healthOf(b: Block): number {
    if (b.hv === -1) {
      const h = this.f.world.apps.get(b.id)?.health;
      return h === 'up' ? 0 : h === 'degraded' ? 1 : h === 'down' ? 2 : 3;
    }
    if (b.hv >= 0) return b.hv;
    return this.f.stress.health[-2 - b.hv] ?? 0;
  }

  // ---- the static floor: the blocks and their lights, after every layer's extruded things ----
  floor(fp: FloorPass): void {
    const g = fp.g, lo = fp.lo, idle = fp.idle;
    // the city: one block per app, a row (one v) at a time, far to near, batched (DESIGN.md "LOD")
    fp.after(() => this.drawCity(g, lo, idle));
  }

  /** The city's blocks with their health lights. LOD by a block's size on screen:
   *  LOD0 (≥ 10 px) faces and edges, round lights; LOD1 (≥ 5 px) faces, square lights;
   *  LOD2 (≥ 4 px) the silhouette and its top, a light only where it is not up; LOD3 a
   *  district's run of blocks in a row as one low strip (a heatmap row). The ladder's low detail
   *  takes one step coarser. Rows off screen, and blocks beside it, are skipped. */
  private drawCity(g: Gfx, lo: boolean, idle: boolean): void {
    const cam = this.f.cam;
    const px = (this.blocks[0]?.d ?? 13) * cam.s;
    let lod = px >= 10 ? 0 : px >= 5 ? 1 : px >= 4 ? 2 : 3;
    if (lo) lod = Math.min(3, lod + 1);
    const hist = this.f.stat.lod;
    hist[0] = hist[1] = hist[2] = hist[3] = 0;
    const batch = this.f.bA;
    const lights = [this.f.bB, this.f.bC, this.f.bD];
    const LIGHT = ['#6FA27C', C.packet, C.red];
    const r = Math.max(1.1, Math.min(2.6, cam.s * 1.9));
    const sq = Math.max(1, Math.min(2.2, cam.s * 1.4));
    for (const row of this.cityRows) {
      const v = row[0].v;
      const d = row[0].d;
      // the row's screen band
      const yTop = cam.y(CITY_U1, v, 30), yBot = cam.y(CITY_U0, v + d, 0);
      if (yBot < -20 || yTop > cam.H + 20) { hist[3] += row.length; continue; }
      let n = 0;
      // LOD3: a district's run of blocks in this row is one low strip (a heatmap row)
      let runU0 = 0, runU1 = -1, runH = 0, runK = 0;
      for (const b of row) {
        const x0 = cam.x(b.u, b.v + b.d), x1 = cam.x(b.u + b.d, b.v);
        if (x1 < -10 || x0 > cam.W + 10) { hist[3]++; continue; }
        n++;
        if (lod < 3) { batch.add(b.u, b.v, b.d, b.d, b.h); continue; }
        if (runU1 >= 0 && b.u - runU1 <= this.cityPitch) { runU1 = b.u + b.d; runH += b.h; runK++; continue; }
        if (runU1 >= 0) batch.add(runU0, v, runU1 - runU0, d, runH / runK);
        runU0 = b.u; runU1 = b.u + b.d; runH = b.h; runK = 1;
      }
      if (lod === 3 && runU1 >= 0) batch.add(runU0, v, runU1 - runU0, d, runH / runK);
      if (!n) continue;
      hist[Math.min(2, lod)] += n;
      if (lod === 0) batch.flush(g, cam, '#202023', '#161618', '#121214', '#333337', g.hair * 1.5, 3);
      else if (lod === 1) batch.flush(g, cam, '#202023', '#161618', '#121214', '', 1, 3);
      else batch.flush(g, cam, '#1E1E21', '#141416', '#141416', '', 1, 2);
      if (idle) continue;
      // the lights on this row's roofs, one path per colour
      for (const b of row) {
        const hl = this.healthOf(b);
        if (hl > 2 || (lod >= 2 && hl === 0)) continue;
        const lx = cam.x(b.u + b.d / 2, b.v + b.d / 2);
        if (lx < -10 || lx > cam.W + 10) continue;
        lights[hl].add(b.u + b.d / 2, b.v + b.d / 2, 0, 0, 0, b.h + 1.5);
      }
      for (let k = 0; k < 3; k++) flushLights(this.f.cam, g, lights[k], LIGHT[k], lod === 0 ? r : lod === 1 ? sq : sq * 1.4, lod === 0);
    }
    // the glow under trouble breathes on the live layer (motion.ts's beat)
  }

  // ---- the live layer: a hit per block big enough to point at, the trouble breathing ----
  live(g: Gfx, fr: LiveFrame): void {
    const cam = this.f.cam, t = fr.t, q = fr.q;
    const offX = (x: number) => x < -24 || x > cam.W + 24;
    // 6. the city: its lights are the floor's (redrawn when health changes); here, a hit per
    //    block big enough to point at (LOD0/1), and deploys landing
    if ((this.blocks[0]?.d ?? 13) * cam.s >= 5) {
      for (const b of this.blocks) {
        const x = cam.x(b.u, b.v + b.d);
        if (offX(x)) continue;
        this.f.hit(x, cam.y(b.u, b.v, b.h) - 2, b.d * 1.3 * cam.s, (b.d * 0.75 + b.h) * cam.s + 4, 'app', b.id, b.id);
      }
    }
    // trouble in the city breathes on the beat (degraded amber, down red): the loud spots
    if (q < 4) {
      const trouble = this.troubleBlocks();
      const br = breathe(t);
      for (const b of trouble) {
        const x = cam.x(b.u + b.d / 2, b.v + b.d / 2);
        if (offX(x)) continue;
        const y = cam.y(b.u + b.d / 2, b.v + b.d / 2, b.h + 2);
        g.begin_(); g.circle(x, y, Math.max(2.4, cam.s * 2) * (4 + br)); g.fill(withAlpha(this.healthOf(b) === 2 ? C.red : C.packet, 0.08 + 0.14 * br));
      }
    }
  }

  /** The city's blocks that are degraded or down (recomputed when the health or the city moved). */
  private troubleBlocks(): Block[] {
    const key = `${this.f.census.healthSig}|${this.cityKey}|${this.blocks.length}`;
    if (key !== this.troubleAt) {
      this.troubleAt = key;
      this.trouble = this.blocks.filter((b) => { const h = this.healthOf(b); return h === 1 || h === 2; });
    }
    return this.trouble;
  }
}
