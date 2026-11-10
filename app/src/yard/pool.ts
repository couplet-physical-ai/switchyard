// Packets (DESIGN.md, "Motion system" and "Rendering"): commits moving through the yard, run the
// way a game runs its particles.
//
// - Pooled: every packet lives in fixed typed arrays (structure of arrays) sized once; a free
//   list hands out slots. A frame allocates nothing, so Hermes never collects mid-animation.
// - Routes: a hop's path is composed once, when the hop starts (an event, not a frame), from
//   the layout's wire legs, resampled every 4 px into a ring arena; a packet reads its point
//   at distance d with one index and one lerp.
// - Fixed step: the simulation advances in 1/60 s steps (at most 4 a frame) and the render
//   interpolates between the last two steps, so motion is the same at 30, 60 or 120 Hz.
// - Coalesced: a frame starts at most 24 new packets; a burst beyond that bumps the ×N count
//   of a packet already on its way, and at the "trains" quality level packets sharing a stretch
//   of wire draw as one sprite with a ×N badge: 1,000 events become a few trains.
// - Stress: 10,000 extra packets flow along precomputed journeys (stress.ts), the same code.

import type { Event, Pipeline } from '../wire.ts';
import { BOTS, type World } from '../world.ts';
import { GHA, enginesOf, type Leg, type Scene } from './layout.ts';
import { queueTruth } from './select.ts';
import { STRESS_PACKETS, hash, unit } from './stress.ts';
import { clamp, easeInOut } from './theme.ts';

export const STEP_MS = 1000 / 60;
const SP = 4; // route sample spacing, yard px
const CAP = 12_288;
const REAL_CAP = 1024;
const MAX_TRAVEL = 200;
const MAX_NEW_PER_FRAME = 24;
const SPEED = 0.26; // yard px per ms at 1×

// station kinds
export const ST_SRC = 0, ST_QUEUE = 1, ST_SLOT = 2, ST_GATE = 3, ST_REVIEW = 4, ST_MAIN = 5, ST_DEPLOY = 6, ST_APP = 7, ST_RET = 8;
// tints
export const T_AMBER = 0, T_RED = 1, T_GREEN = 2, T_GRAY = 3;
// flags
const F_ALIVE = 1, F_BOT = 2, F_STRESS = 4, F_TRAVEL = 8;

// effects
export const E_POP = 0, E_FLASH = 1, E_PULSE = 2, E_PORT = 3;
const ECAP = 256;

export class Pool {
  // ---- packets (SoA)
  readonly x = new Float32Array(CAP); readonly y = new Float32Array(CAP);
  readonly px = new Float32Array(CAP); readonly py = new Float32Array(CAP);
  private ox = new Float32Array(CAP); private oy = new Float32Array(CAP);
  private ex = new Float32Array(CAP); private ey = new Float32Array(CAP);
  private tx = new Float32Array(CAP); private ty = new Float32Array(CAP);
  /** Route: arena offset (in points) and point count; stress packets: template index. */
  readonly roff = new Int32Array(CAP); readonly rn = new Int32Array(CAP);
  readonly rlen = new Float32Array(CAP);
  readonly d = new Float32Array(CAP); readonly dPrev = new Float32Array(CAP);
  private v = new Float32Array(CAP);
  private t0 = new Float64Array(CAP); private dur = new Float64Array(CAP);
  readonly born = new Float64Array(CAP); readonly die = new Float64Array(CAP);
  readonly labelUntil = new Float64Array(CAP);
  readonly tint = new Uint8Array(CAP); readonly flags = new Uint8Array(CAP);
  readonly count = new Uint16Array(CAP);
  readonly st = new Uint8Array(CAP);
  private srcRow = new Int16Array(CAP);
  readonly stArg: string[] = new Array(CAP).fill('');
  readonly pid: string[] = new Array(CAP).fill('');
  readonly label: string[] = new Array(CAP).fill('');
  private cid: string[] = new Array(REAL_CAP).fill('');
  // pending hops after the current one: [kind, arg, dwell]
  private nKind = new Uint8Array(CAP * 2); private nArg: string[] = new Array(CAP * 2).fill('');
  private nDwell = new Float32Array(CAP * 2); private nNext = new Uint8Array(CAP);
  // active lists (dense), free lists
  readonly act = new Int32Array(CAP); nAct = 0;
  private pos = new Int32Array(CAP).fill(-1);
  private freeReal = new Int32Array(REAL_CAP); private nFreeReal = 0;
  private freeStress = new Int32Array(CAP - REAL_CAP); private nFreeStress = 0;
  readonly byId = new Map<string, number>();
  private byCommit = new Map<string, number>();

  // ---- route arena (ring) and the stress journeys
  readonly arena = new Float32Array(1 << 18);
  private head = 0;
  private scratch = new Float32Array(1 << 14);
  private sn = 0;
  readonly tmpl = new Float32Array(1 << 17);
  readonly tOff = new Int32Array(64); readonly tN = new Int32Array(64); readonly tLen = new Float32Array(64);
  nTmpl = 0;

  // ---- effects (SoA)
  readonly ek = new Uint8Array(ECAP); readonly exx = new Float32Array(ECAP); readonly eyy = new Float32Array(ECAP);
  readonly et0 = new Float64Array(ECAP); readonly edur = new Float32Array(ECAP); readonly er = new Float32Array(ECAP);
  readonly ered = new Uint8Array(ECAP);
  nFx = 0;

  // ---- bookkeeping
  S: Scene | null = null;
  reduced = false;
  /** Packets alpha (the paused look draws them at half). */
  traveling = 0;
  real = 0;
  stressN = 0;
  dropped = 0;
  private bornAt = -1;
  private bornN = 0;
  private acc = 0;
  private simT = -1;
  /** Interpolation alpha between the last two steps. */
  alpha = 1;
  private stressCycle = new Uint32Array(CAP);

  constructor() {
    for (let i = REAL_CAP - 1; i >= 0; i--) this.freeReal[this.nFreeReal++] = i;
    for (let i = CAP - 1; i >= REAL_CAP; i--) this.freeStress[this.nFreeStress++] = i;
  }

  get pooled(): number { return this.nFreeReal + this.nFreeStress; }

  // ---- slots ----------------------------------------------------------------------------------
  private alloc(stress: boolean): number {
    let i: number;
    if (stress) { if (!this.nFreeStress) return -1; i = this.freeStress[--this.nFreeStress]; }
    else { if (!this.nFreeReal) return -1; i = this.freeReal[--this.nFreeReal]; }
    this.pos[i] = this.nAct;
    this.act[this.nAct++] = i;
    this.flags[i] = F_ALIVE | (stress ? F_STRESS : 0);
    this.nNext[i] = 0; this.count[i] = 1; this.die[i] = 0; this.labelUntil[i] = 0; this.tint[i] = T_AMBER;
    this.ox[i] = this.oy[i] = this.ex[i] = this.ey[i] = 0;
    if (stress) this.stressN++; else this.real++;
    return i;
  }

  private release(i: number): void {
    const p = this.pos[i];
    if (p < 0) return;
    const last = this.act[--this.nAct];
    this.act[p] = last;
    this.pos[last] = p;
    this.pos[i] = -1;
    if (this.flags[i] & F_TRAVEL) this.traveling--;
    if (this.flags[i] & F_STRESS) { this.freeStress[this.nFreeStress++] = i; this.stressN--; }
    else {
      this.freeReal[this.nFreeReal++] = i; this.real--;
      if (this.pid[i]) { if (this.byId.get(this.pid[i]) === i) this.byId.delete(this.pid[i]); }
      if (this.cid[i]) { if (this.byCommit.get(this.cid[i]) === i) this.byCommit.delete(this.cid[i]); this.cid[i] = ''; }
      this.pid[i] = ''; this.label[i] = ''; this.stArg[i] = '';
    }
    this.flags[i] = 0;
  }

  clear(): void {
    while (this.nAct) this.release(this.act[this.nAct - 1]);
    this.byId.clear();
    this.byCommit.clear();
    this.nFx = 0;
    this.traveling = 0;
  }

  // ---- routes ---------------------------------------------------------------------------------
  private rBegin(x: number, y: number): void { this.sn = 0; this.rTo(x, y); }
  private rTo(x: number, y: number): void {
    if (this.sn >= this.scratch.length - 2) return;
    const s = this.scratch;
    if (this.sn >= 2 && Math.abs(s[this.sn - 2] - x) < 0.01 && Math.abs(s[this.sn - 1] - y) < 0.01) return;
    s[this.sn++] = x; s[this.sn++] = y;
  }
  private rLeg(l: Leg | undefined, reverse = false): void {
    if (!l) return;
    const p = l.pts;
    if (!reverse) for (let i = 0; i < p.length; i += 2) this.rTo(p[i], p[i + 1]);
    else for (let i = p.length - 2; i >= 0; i -= 2) this.rTo(p[i], p[i + 1]);
  }
  /** Resamples the scratch polyline every SP px into `out` at `off` (points); returns [n, len]. */
  private resample(out: Float32Array, off: number, cap: number): [number, number] {
    const s = this.scratch, n = this.sn >> 1;
    let total = 0;
    for (let i = 1; i < n; i++) total += Math.hypot(s[i * 2] - s[i * 2 - 2], s[i * 2 + 1] - s[i * 2 - 1]);
    const m = Math.max(2, Math.min(cap, Math.ceil(total / SP) + 1));
    const step = total / (m - 1 || 1);
    let seg = 1, segStart = 0, segLen = n > 1 ? Math.hypot(s[2] - s[0], s[3] - s[1]) : 0;
    for (let k = 0; k < m; k++) {
      const dd = k * step;
      while (seg < n - 1 && dd > segStart + segLen) { segStart += segLen; seg++; segLen = Math.hypot(s[seg * 2] - s[seg * 2 - 2], s[seg * 2 + 1] - s[seg * 2 - 1]); }
      const u = segLen > 0 ? clamp((dd - segStart) / segLen, 0, 1) : 0;
      const ax = s[seg * 2 - 2] ?? s[0], ay = s[seg * 2 - 1] ?? s[1], bx = s[seg * 2] ?? ax, by = s[seg * 2 + 1] ?? ay;
      out[(off + k) * 2] = ax + (bx - ax) * u;
      out[(off + k) * 2 + 1] = ay + (by - ay) * u;
    }
    return [m, total];
  }
  private rCommit(i: number): void {
    const capPts = this.arena.length >> 1;
    let need = Math.ceil(2000 / SP);
    if (this.head + need > capPts) this.head = 0;
    const [n, len] = this.resample(this.arena, this.head, Math.min(need, capPts - this.head));
    this.roff[i] = this.head; this.rn[i] = n; this.rlen[i] = len;
    this.head += n;
    need = 0;
  }

  /** The point at distance `dd` along packet i's route (into `out`). */
  at(i: number, dd: number, out: { x: number; y: number }): void {
    const stress = (this.flags[i] & F_STRESS) !== 0;
    const buf = stress ? this.tmpl : this.arena;
    const off = stress ? this.tOff[this.roff[i]] : this.roff[i];
    const n = stress ? this.tN[this.roff[i]] : this.rn[i];
    const len = stress ? this.tLen[this.roff[i]] : this.rlen[i];
    if (n < 2) { out.x = buf[off * 2]; out.y = buf[off * 2 + 1]; return; }
    const f = clamp(dd / (len || 1), 0, 1) * (n - 1);
    const k = Math.min(n - 2, Math.floor(f)), u = f - k;
    const a = (off + k) * 2;
    out.x = buf[a] + (buf[a + 2] - buf[a]) * u;
    out.y = buf[a + 1] + (buf[a + 3] - buf[a + 1]) * u;
  }

  // ---- anchors ----------------------------------------------------------------------------------
  private pt = { x: 0, y: 0 };

  /** Where a packet at station (kind, arg) rests, into this.pt. */
  private anchor(i: number, kind: number, arg: string, w: World): { x: number; y: number } {
    const S = this.S!, p = this.pt;
    switch (kind) {
      case ST_SRC: case ST_RET: {
        const row = S.sources.rows[Math.min(S.sources.rows.length - 1, Math.max(0, this.srcRow[i]))];
        p.x = kind === ST_SRC ? (row?.port.x ?? S.sources.x) + 8 : (row?.x ?? S.m) - 2; p.y = row?.y ?? S.top.body;
        return p;
      }
      case ST_QUEUE: {
        const q = arg === 'gha' ? S.intake.gha : S.intake.rr;
        const qt = queueTruth(w);
        const list = arg === 'gha' ? qt.gha : qt.rr;
        let k = 0;
        for (let j = 0; j < list.length; j++) if (list[j].id === this.pid[i]) { k = j; break; }
        const cap = Math.max(1, Math.floor((q.w - 14) / 11));
        p.x = q.x + q.w - 10 - Math.min(k, cap - 1) * 11; p.y = q.y + q.h / 2;
        return p;
      }
      case ST_SLOT: {
        const pl = w.pipelines.get(this.pid[i]);
        const s = pl ? this.slotOf(pl, w) : null;
        if (s) { p.x = s.x; p.y = s.y; } else { p.x = S.engines.x + 12; p.y = S.engines.cells.y + 10; }
        return p;
      }
      case ST_GATE: p.x = S.gates.gate.x + S.gates.gate.w / 2; p.y = S.gates.gate.y + S.gates.gate.h / 2; return p;
      case ST_REVIEW: p.x = S.gates.review.x + S.gates.review.w / 2; p.y = S.gates.review.y + S.gates.review.h / 2; return p;
      case ST_DEPLOY: p.x = S.deploy.x + S.deploy.w / 2; p.y = S.deploy.y + S.deploy.h / 2; return p;
      case ST_MAIN: return this.mainPt(arg);
      case ST_APP: return this.appPt(arg);
    }
    p.x = S.m; p.y = S.top.body;
    return p;
  }

  /** The newest dot of a repo's row, or its heatmap cell. */
  mainPt(repo: string): { x: number; y: number } {
    const S = this.S!, p = this.pt;
    for (const r of S.mains.rows) if (r.repo === repo) { p.x = r.dx1; p.y = r.y; return p; }
    const idx = this.repoIndex.get(repo) ?? -1;
    for (const b of S.mains.heat.blocks) {
      if (idx >= b.start && idx < b.end) {
        const j = idx - b.start, pc = S.mains.heat.pitch;
        p.x = b.x + (j % b.cols) * pc + S.mains.heat.cell / 2; p.y = b.y + Math.floor(j / b.cols) * pc + S.mains.heat.cell / 2;
        return p;
      }
    }
    p.x = S.mains.x0 + 4; p.y = S.mains.heat.y;
    return p;
  }

  appPt(app: string): { x: number; y: number } {
    const S = this.S!, p = this.pt;
    const idx = this.appIndex.get(app) ?? 0;
    p.x = S.apps.x + (idx % S.apps.cols) * S.apps.pitch + S.apps.cell / 2;
    p.y = S.apps.y + Math.floor(idx / S.apps.cols) * S.apps.pitch + S.apps.cell / 2;
    return p;
  }

  /** Repo and app positions in the heatmap and the apps grid (set with the scene). */
  repoIndex = new Map<string, number>();
  appIndex = new Map<string, number>();

  slotOf(p: Pipeline, w: World): { x: number; y: number; r: number; lane: number } | null {
    const S = this.S!;
    const eng = engineOf(w, p);
    if (!eng) return null;
    const slots = S.engines.slotByEngine.get(eng.id);
    if (!slots?.length) return null;
    let k = eng.running.indexOf(p.id ?? '');
    if (k < 0) k = 0;
    return slots[Math.min(k, slots.length - 1)];
  }

  private laneIndexOf(i: number, w: World): number {
    const pl = w.pipelines.get(this.pid[i]);
    if (!pl) return 0;
    const s = this.slotOf(pl, w);
    if (s) return s.lane;
    if (pl.lane === 'gha') { const k = this.S!.engines.lanes.findIndex((l) => l.kind === 'gha_runner'); return Math.max(0, k); }
    return 0;
  }

  // ---- hops ---------------------------------------------------------------------------------------
  /** Starts packet i's hop from where it is to station (kind, arg). */
  private hop(i: number, kind: number, arg: string, w: World, t: number): void {
    const S = this.S;
    const from = this.st[i];
    const fromArg = this.stArg[i];
    this.st[i] = kind;
    this.stArg[i] = arg;
    if (!S) return;
    const a = this.anchor(i, kind, arg, w);
    const bx = a.x, by = a.y;
    this.tx[i] = bx; this.ty[i] = by;
    const sx = this.x[i], sy = this.y[i];
    const L = S.legs;
    this.rBegin(sx, sy);
    switch (kind) {
      case ST_QUEUE: {
        const row = Math.max(0, Math.min(L.fan.length - 1, this.srcRow[i]));
        if (from === ST_SRC) this.rLeg(L.fan[row]);
        this.rLeg(arg === 'gha' ? L.jGha : L.jRr);
        break;
      }
      case ST_SLOT: {
        const q = from === ST_QUEUE && fromArg === 'gha' ? S.intake.gha : S.intake.rr;
        this.rTo(q.outPort.x, q.outPort.y);
        const li = this.laneIndexOf(i, w);
        this.rLeg(L.toLane[Math.min(li, L.toLane.length - 1)]);
        const lane = S.engines.lanes[li];
        if (lane) this.rTo(lane.inPort.x + 6, by);
        break;
      }
      case ST_GATE: {
        const li = this.laneIndexOf(i, w);
        const lane = S.engines.lanes[li];
        if (lane) { this.rTo(lane.outPort.x - 6, sy); this.rTo(lane.outPort.x, lane.outPort.y); }
        this.rLeg(L.fromLane[Math.min(li, L.fromLane.length - 1)]);
        break;
      }
      case ST_REVIEW: this.rLeg(L.review); break;
      case ST_MAIN: {
        this.rTo(S.gates.gate.outPort.x, S.gates.gate.outPort.y);
        this.rTo(S.bus.x, S.gates.gate.outPort.y);
        this.rTo(S.bus.x, by);
        this.rTo(S.mains.x0, by);
        break;
      }
      case ST_RET: {
        const row = S.sources.rows[Math.max(0, Math.min(S.sources.rows.length - 1, this.srcRow[i]))];
        const retX = S.L.x0 - 6;
        if (from === ST_MAIN) { this.rTo(S.mains.x0, sy); this.rTo(S.bus.x, sy); this.rTo(S.bus.x, S.divY); }
        else { this.rLeg(L.reject); }
        this.rTo(retX, S.divY);
        this.rTo(retX, row?.y ?? S.top.body);
        break;
      }
      case ST_DEPLOY: {
        this.rTo(S.mains.x0, sy);
        this.rTo(S.bus.x, sy);
        this.rTo(S.bus.x, S.deploy.inPort.y);
        this.rTo(S.deploy.inPort.x, S.deploy.inPort.y);
        break;
      }
      case ST_APP: this.rLeg(L.apps); break;
    }
    this.rTo(bx, by);
    this.rCommit(i);
    // The route starts and ends exactly where the packet and its anchor are.
    this.ox[i] = 0; this.oy[i] = 0; this.ex[i] = 0; this.ey[i] = 0;
    this.t0[i] = t;
    const len = this.rlen[i];
    this.dur[i] = this.reduced ? 1 : clamp(len / SPEED, 420, 1500);
    if (!(this.flags[i] & F_TRAVEL)) { this.flags[i] |= F_TRAVEL; this.traveling++; }
  }

  private queueNext(i: number, kind: number, arg: string, dwell: number): void {
    const n = this.nNext[i];
    if (n >= 2) return;
    this.nKind[i * 2 + n] = kind; this.nArg[i * 2 + n] = arg; this.nDwell[i * 2 + n] = dwell;
    this.nNext[i] = n + 1;
  }

  private spawn(id: string, pipeline: string, repo: string, srcRow: number, bot: boolean, t: number, quiet: boolean, w: World): number {
    if (t !== this.bornAt) { this.bornAt = t; this.bornN = 0; }
    if (!quiet && (this.bornN >= MAX_NEW_PER_FRAME || this.traveling >= MAX_TRAVEL)) {
      // Coalesce: the newest packet of the same source still on its way takes the count.
      this.dropped++;
      for (let k = this.nAct - 1; k >= 0; k--) {
        const j = this.act[k];
        if (!(this.flags[j] & F_STRESS) && this.srcRow[j] === srcRow && (this.st[j] === ST_SRC || this.st[j] === ST_QUEUE)) { this.count[j]++; break; }
      }
      return -1;
    }
    const i = this.alloc(false);
    if (i < 0) return -1;
    this.bornN++;
    this.pid[i] = pipeline;
    this.label[i] = repo.split('/')[1] ?? repo;
    this.labelUntil[i] = quiet ? 0 : t + 1600;
    this.born[i] = t;
    this.srcRow[i] = srcRow;
    this.st[i] = ST_SRC;
    this.stArg[i] = '';
    if (bot) this.flags[i] |= F_BOT;
    if (id) this.byId.set(id, i);
    const a = this.anchor(i, ST_SRC, '', w);
    this.x[i] = this.px[i] = this.tx[i] = a.x; this.y[i] = this.py[i] = this.ty[i] = a.y;
    return i;
  }

  private rowOf(org: string): number {
    const rows = this.S?.sources.rows;
    if (!rows || rows.length <= 1) return 0;
    for (let k = 0; k < rows.length; k++) if (rows[k].org === org) return k;
    return rows.length - 1;
  }

  /** Re-seats every in-flight pipeline at its station without travel (load, jumps, a resize). */
  sync(w: World, t: number): void {
    const keepStress = this.stressN;
    for (let k = this.nAct - 1; k >= 0; k--) { const i = this.act[k]; if (!(this.flags[i] & F_STRESS)) this.release(i); }
    this.byId.clear();
    this.byCommit.clear();
    if (!this.S) return;
    const q = queueTruth(w);
    const sorted = Array.from(w.pipelines.values()).filter((p) => p.state === 'running' || p.state === 'pending').sort((a, b) => a.created - b.created);
    for (const p of sorted) {
      if (!p.id) continue;
      const queued = q.ids.has(p.id);
      const bot = !!w.commitOfPipeline(p)?.bot;
      const i = this.spawn(p.id, p.id, p.repo, this.rowOf(bot ? BOTS : w.orgOf(p.repo)), bot, t, true, w);
      if (i < 0) break;
      const kind = queued || p.state === 'pending' ? ST_QUEUE : ST_SLOT;
      this.st[i] = kind;
      this.stArg[i] = p.lane === 'gha' ? 'gha' : 'roadrunner';
      const a = this.anchor(i, kind, this.stArg[i], w);
      this.x[i] = this.px[i] = this.tx[i] = a.x; this.y[i] = this.py[i] = this.ty[i] = a.y;
    }
    void keepStress;
  }

  /** Recomputes resting targets (the queue moved up, a slot changed, the layout changed). */
  reseat(w: World): void {
    if (!this.S) return;
    for (let k = 0; k < this.nAct; k++) {
      const i = this.act[k];
      if (this.flags[i] & (F_STRESS | F_TRAVEL)) continue;
      const a = this.anchor(i, this.st[i], this.stArg[i], w);
      this.tx[i] = a.x; this.ty[i] = a.y;
    }
  }

  // ---- events ------------------------------------------------------------------------------------
  onEvent(e: Event, w: World, t: number): void {
    if (!this.S) return;
    switch (e.k) {
      case 'push': {
        const bot = !!e.bot || !!e.author?.endsWith('[bot]');
        const org = bot ? BOTS : w.orgOf(e.repo);
        const id = `${e.repo}@${e.sha}`;
        if (this.byCommit.has(id)) return;
        const i = this.spawn('', '', e.repo, this.rowOf(org), bot, t, false, w);
        if (i < 0) return;
        this.byCommit.set(id, i);
        this.cid[i] = id;
        this.die[i] = t + 6000; // a push that starts no pipeline fades where it is
        break;
      }
      case 'enqueue': {
        const cid = `${e.repo}@${e.sha}`;
        let i = this.byCommit.get(cid) ?? -1;
        if (i >= 0 && (this.flags[i] & F_ALIVE) && !this.pid[i] && this.cid[i] === cid) {
          this.byCommit.delete(cid);
          this.cid[i] = '';
          this.pid[i] = e.pipeline;
          this.byId.set(e.pipeline, i);
          this.die[i] = 0;
        } else {
          const bot = !!w.commits.get(cid)?.bot;
          i = this.spawn(e.pipeline, e.pipeline, e.repo, this.rowOf(bot ? BOTS : w.orgOf(e.repo)), bot, t, false, w);
          if (i < 0) return;
        }
        const lane = w.pipelines.get(e.pipeline)?.lane ?? e.lane;
        this.hop(i, ST_QUEUE, lane === 'gha' ? 'gha' : 'roadrunner', w, t);
        break;
      }
      case 'start': {
        let i = this.byId.get(e.pipeline) ?? -1;
        const p = w.pipelines.get(e.pipeline);
        if (i < 0 && p) {
          const bot = !!w.commitOfPipeline(p)?.bot;
          i = this.spawn(e.pipeline, e.pipeline, p.repo, this.rowOf(bot ? BOTS : w.orgOf(p.repo)), bot, t, true, w);
          if (i >= 0) {
            this.st[i] = ST_QUEUE; this.stArg[i] = p.lane === 'gha' ? 'gha' : 'roadrunner';
            const a = this.anchor(i, ST_QUEUE, this.stArg[i], w);
            this.x[i] = this.px[i] = a.x; this.y[i] = this.py[i] = a.y;
          }
        }
        if (i >= 0) this.hop(i, ST_SLOT, '', w, t);
        break;
      }
      case 'finish': {
        const i = this.byId.get(e.pipeline) ?? -1;
        const p = w.pipelines.get(e.pipeline);
        if (i < 0 || !p) return;
        const s = this.slotOf(p, w);
        if (s) this.fx(E_FLASH, s.x, s.y, t, 420, s.r, e.state !== 'success');
        const onMain = isMain(w, p);
        if (e.state === 'success') {
          this.tint[i] = T_AMBER;
          this.hop(i, ST_GATE, '', w, t);
          this.queueNext(i, onMain ? ST_MAIN : ST_REVIEW, onMain ? p.repo : '', 220);
        } else if (e.state === 'failure' || e.state === 'error') {
          this.tint[i] = T_RED;
          this.hop(i, ST_GATE, '', w, t);
          if (onMain) { this.queueNext(i, ST_MAIN, p.repo, 160); this.queueNext(i, ST_RET, '', 500); }
          else this.queueNext(i, ST_RET, '', 160);
        } else {
          this.tint[i] = T_GRAY;
          this.die[i] = t;
        }
        break;
      }
      case 'deploy': {
        const id = `deploy:${e.app}:${e.sha}`;
        if (e.state !== 'running') {
          const i = this.byId.get(id) ?? -1;
          if (e.state === 'success' || e.state === 'failure') {
            if (i >= 0) { this.tint[i] = e.state === 'success' ? T_GREEN : T_RED; this.hop(i, ST_APP, e.app, w, t); }
            else { const a = this.appPt(e.app); this.fx(E_PULSE, a.x, a.y, t, 900, this.S.apps.cell + 4, e.state !== 'success'); }
          }
          return;
        }
        if (this.byId.has(id)) return;
        const repo = w.apps.get(e.app)?.repo ?? '';
        const i = this.spawn(id, '', repo, 0, false, t, false, w);
        if (i < 0) return;
        this.label[i] = e.app;
        this.st[i] = ST_MAIN;
        const a = this.mainPt(repo);
        this.x[i] = this.px[i] = a.x; this.y[i] = this.py[i] = a.y;
        this.hop(i, ST_DEPLOY, '', w, t);
        break;
      }
      case 'health': {
        const a = this.appPt(e.app);
        this.fx(E_PULSE, a.x, a.y, t, 900, (this.S.apps.cell || 4) + 4, e.to !== 'up');
        break;
      }
      case 'merge': {
        const r = this.S.gates.review;
        this.fx(E_FLASH, r.x + r.w / 2, r.y + r.h / 2, t, 500, 9, false);
        break;
      }
      default: break;
    }
  }

  fx(kind: number, x: number, y: number, t: number, dur: number, r: number, red: boolean): void {
    if (this.reduced && kind !== E_PULSE) return;
    let j = this.nFx;
    if (j >= ECAP) {
      // Replace the oldest.
      j = 0;
      for (let k = 1; k < ECAP; k++) if (this.et0[k] < this.et0[j]) j = k;
    } else this.nFx++;
    this.ek[j] = kind; this.exx[j] = x; this.eyy[j] = y; this.et0[j] = t; this.edur[j] = dur; this.er[j] = r; this.ered[j] = red ? 1 : 0;
  }

  // ---- simulation -----------------------------------------------------------------------------------
  /** Advances to `t` in fixed steps (stress packets advance their distance only; their points
   *  are read at render time, and only for those drawn one by one). */
  update(t: number, w: World): void {
    if (this.simT < 0) this.simT = t;
    let dt = t - this.simT;
    if (dt < 0 || dt > 250) { dt = STEP_MS; this.simT = t - STEP_MS; }
    this.acc += dt;
    this.simT = t;
    let steps = 0;
    while (this.acc >= STEP_MS && steps < 4) {
      this.acc -= STEP_MS;
      steps++;
      this.step(t - this.acc, w);
    }
    if (this.acc > STEP_MS) this.acc = STEP_MS; // a long frame: drop the rest (no spiral)
    this.alpha = clamp(this.acc / STEP_MS, 0, 1);
    // effects expire
    let n = 0;
    for (let j = 0; j < this.nFx; j++) {
      if (t - this.et0[j] < this.edur[j]) {
        if (n !== j) { this.ek[n] = this.ek[j]; this.exx[n] = this.exx[j]; this.eyy[n] = this.eyy[j]; this.et0[n] = this.et0[j]; this.edur[n] = this.edur[j]; this.er[n] = this.er[j]; this.ered[n] = this.ered[j]; }
        n++;
      }
    }
    this.nFx = n;
  }

  private step(t: number, w: World): void {
    const k = 1 - Math.exp(-STEP_MS / 110);
    const pt = this.pt;
    for (let a = 0; a < this.nAct; a++) {
      const i = this.act[a];
      const f = this.flags[i];
      if (f & F_STRESS) {
        this.dPrev[i] = this.d[i];
        let dd = this.d[i] + this.v[i] * STEP_MS;
        const tl = this.tLen[this.roff[i]];
        if (dd >= tl) { this.nextJourney(i); dd = 0; this.dPrev[i] = 0; }
        this.d[i] = dd;
        continue;
      }
      this.px[i] = this.x[i]; this.py[i] = this.y[i];
      if (this.die[i] && t - this.die[i] > 700) { this.release(i); a--; continue; }
      if (f & F_TRAVEL) {
        const u = (t - this.t0[i]) / this.dur[i];
        if (u < 1) {
          const e = easeInOut(u);
          this.at(i, e * this.rlen[i], pt);
          this.x[i] = pt.x; this.y[i] = pt.y;
          continue;
        }
        this.flags[i] &= ~F_TRAVEL;
        this.traveling--;
        this.x[i] = this.tx[i]; this.y[i] = this.ty[i];
        this.arrive(i, w, t);
        if (!(this.flags[i] & F_ALIVE)) { a--; continue; }
      } else {
        const dx = this.tx[i] - this.x[i], dy = this.ty[i] - this.y[i];
        if (dx > 0.2 || dx < -0.2 || dy > 0.2 || dy < -0.2) {
          this.x[i] += this.reduced ? dx : dx * k;
          this.y[i] += this.reduced ? dy : dy * k;
        }
      }
      if (this.nNext[i] && !(this.flags[i] & F_TRAVEL) && t >= this.t0[i] + this.dur[i] + this.nDwell[i * 2]) {
        const kind = this.nKind[i * 2], arg = this.nArg[i * 2];
        this.nKind[i * 2] = this.nKind[i * 2 + 1]; this.nArg[i * 2] = this.nArg[i * 2 + 1]; this.nDwell[i * 2] = this.nDwell[i * 2 + 1];
        this.nNext[i]--;
        this.hop(i, kind, arg, w, t);
      }
    }
  }

  private arrive(i: number, w: World, t: number): void {
    const S = this.S;
    const kind = this.st[i];
    if (kind === ST_MAIN) {
      if (!this.reduced) this.fx(E_POP, this.x[i], this.y[i], t, 360, 3.5, this.tint[i] === T_RED);
      if (!this.nNext[i]) this.die[i] = t;
    } else if (kind === ST_REVIEW || kind === ST_RET) {
      this.die[i] = t + 120;
    } else if (kind === ST_APP) {
      this.fx(E_PULSE, this.x[i], this.y[i], t, 900, (S?.apps.cell ?? 4) + 4, this.tint[i] === T_RED);
      this.die[i] = t;
    } else if (kind === ST_GATE && S) {
      const g = S.gates.gate;
      this.fx(E_FLASH, g.x + g.w / 2, g.y + g.h / 2, t, 380, 12, this.tint[i] === T_RED);
    }
    // A coalesced burst is delivered where it docks: the count travels, it does not stay.
    if (kind === ST_QUEUE || kind === ST_SLOT) this.count[i] = 1;
    if (S && (kind === ST_QUEUE || kind === ST_GATE || kind === ST_DEPLOY)) {
      const m = kind === ST_QUEUE ? (this.stArg[i] === 'gha' ? S.intake.gha : S.intake.rr) : kind === ST_GATE ? S.gates.gate : S.deploy;
      this.fx(E_PORT, m.inPort.x, m.inPort.y, t - 200, 520, 0, false);
    }
    void w;
  }

  // ---- stress -----------------------------------------------------------------------------------------
  /** Composes the stress journeys over the current scene (source → queue → slot → gate → out). */
  buildJourneys(): void {
    const S = this.S;
    this.nTmpl = 0;
    if (!S) return;
    const L = S.legs;
    let off = 0;
    const capPts = this.tmpl.length >> 1;
    const lanes = Math.max(1, L.toLane.length);
    for (let j = 0; j < 48 && this.nTmpl < this.tOff.length; j++) {
      const row = hash(j, 1) % Math.max(1, L.fan.length);
      const li = hash(j, 2) % lanes;
      const gha = S.engines.lanes[li]?.kind === 'gha_runner';
      const q = gha ? S.intake.gha : S.intake.rr;
      const srow = S.sources.rows[row];
      this.rBegin((srow?.port.x ?? S.sources.x) + 6, srow?.y ?? S.top.body);
      this.rLeg(L.fan[row]);
      this.rLeg(gha ? L.jGha : L.jRr);
      this.rTo(q.x + q.w / 2, q.y + q.h / 2);
      this.rTo(q.outPort.x, q.outPort.y);
      this.rLeg(L.toLane[li]);
      const lane = S.engines.lanes[li];
      if (lane) {
        const s = lane.slots[hash(j, 3) % Math.max(1, lane.slots.length)];
        if (s) { this.rTo(s.x, s.y); this.rTo(lane.outPort.x - 4, s.y); }
        this.rTo(lane.outPort.x, lane.outPort.y);
      }
      this.rLeg(L.fromLane[li]);
      const g = S.gates.gate;
      this.rTo(g.x + g.w / 2, g.y + g.h / 2);
      const out = hash(j, 4) % 10;
      if (out < 6 && S.mains.rows.length) {
        const r = S.mains.rows[hash(j, 5) % S.mains.rows.length];
        this.rTo(g.outPort.x, g.outPort.y); this.rTo(S.bus.x, g.outPort.y); this.rTo(S.bus.x, r.y); this.rTo(S.mains.x0, r.y); this.rTo(r.dx1, r.y);
      } else if (out < 8) {
        const b = S.mains.heat.blocks[hash(j, 6) % Math.max(1, S.mains.heat.blocks.length)];
        this.rTo(g.outPort.x, g.outPort.y); this.rTo(S.bus.x, g.outPort.y);
        if (b) { this.rTo(S.bus.x, b.y + 2); this.rTo(b.x + (hash(j, 7) % Math.max(1, b.cols)) * S.mains.heat.pitch, b.y + 2); }
      } else {
        this.rLeg(L.reject);
        const retX = S.L.x0 - 6;
        this.rTo(retX, S.divY);
        this.rTo(retX, srow?.y ?? S.top.body);
      }
      const need = 1200;
      if (off + need > capPts) break;
      const [n, len] = this.resample(this.tmpl, off, need);
      this.tOff[this.nTmpl] = off; this.tN[this.nTmpl] = n; this.tLen[this.nTmpl] = len;
      this.nTmpl++;
      off += n;
    }
  }

  setStress(on: boolean, t: number): void {
    if (!on) {
      for (let k = this.nAct - 1; k >= 0; k--) { const i = this.act[k]; if (this.flags[i] & F_STRESS) this.release(i); }
      return;
    }
    if (!this.nTmpl) this.buildJourneys();
    if (!this.nTmpl) return;
    while (this.stressN < STRESS_PACKETS) {
      const i = this.alloc(true);
      if (i < 0) break;
      this.stressCycle[i] = 0;
      this.roff[i] = hash(i, 9) % this.nTmpl;
      this.d[i] = this.dPrev[i] = unit(i, 10) * this.tLen[this.roff[i]];
      this.v[i] = 0.12 + unit(i, 12) * 0.2;
      this.tint[i] = unit(i, 13) < 0.08 ? T_RED : T_AMBER;
      this.born[i] = t - 1000;
      this.at(i, this.d[i], this.pt);
      this.x[i] = this.px[i] = this.pt.x; this.y[i] = this.py[i] = this.pt.y;
    }
  }

  private nextJourney(i: number): void {
    const c = ++this.stressCycle[i];
    this.roff[i] = hash(i, c) % Math.max(1, this.nTmpl);
  }
}

function isMain(w: World, p: Pipeline): boolean {
  const r = w.repos.get(p.repo);
  return p.event !== 'pull_request' && p.branch === (r?.default_branch ?? 'main');
}

/** The engine a pipeline runs on: by id, by agent label (what pipelines name), by its running
 *  list, or GitHub Actions' virtual one. */
export function engineOf(w: World, p: Pipeline) {
  const all = enginesOf(w);
  if (p.id) for (const x of all) if (x.running.includes(p.id)) return x;
  if (p.engine) {
    const e = w.engines.get(p.engine) ?? all.find((x) => x.label === p.engine);
    if (e) return e;
  }
  return p.lane === 'gha' ? all.find((x) => x.id === GHA) : undefined;
}
