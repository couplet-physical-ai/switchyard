// Packets: commits moving through the yard (DESIGN.md, "Motion system"). Events from the
// shown world move packets between stations along the wires; between events a packet rests at
// its station's anchor, easing after it when the anchor shifts (a queue moving up).

import type { Event, Pipeline } from '../wire.ts';
import type { World } from '../world.ts';
import { BOTS, GHA, type Layout, type Pt, bezierAt, enginesOf, wire } from './layout.ts';
import { clamp, easeInOut } from './theme.ts';

export type Station =
  | { k: 'src'; org: string }
  | { k: 'queue'; q: 'roadrunner' | 'gha' }
  | { k: 'slot' }
  | { k: 'gate' }
  | { k: 'review' }
  | { k: 'main'; repo: string }
  | { k: 'deploy' }
  | { k: 'app'; app: string }
  | { k: 'ret'; org: string };

export type Packet = {
  id: string;
  pipeline: string;
  repo: string;
  org: string;
  bot: boolean;
  label: string;
  labelUntil: number;
  st: Station;
  pts: Pt[] | null;
  lens: number[];
  total: number;
  t0: number;
  dur: number;
  x: number;
  y: number;
  tint: 'amber' | 'red' | 'green' | 'gray';
  born: number;
  /** When set, the packet fades out from this time. */
  die: number;
  /** Hops waiting after the current one: [station, dwell ms after arrival]. */
  next: [Station, number][];
  /** A badge drawn over the packet (×N for a coalesced burst). */
  count: number;
  app: string;
};

export type Effect = { k: 'pop' | 'pulse' | 'flash' | 'port'; x: number; y: number; t0: number; color: string; dur: number; r?: number };

const MAX_PACKETS = 160;
const MAX_NEW_PER_FRAME = 24;
const SPEED = 0.26; // px per ms

export class Motion {
  packets = new Map<string, Packet>();
  effects: Effect[] = [];
  reduced = false;
  dropped = 0;
  private born = 0;
  private bornAt = -1;
  /** commit id (repo@sha) → packet id, until its pipeline is known. */
  private byCommit = new Map<string, string>();

  constructor(public L: () => Layout | null, public now: () => number) {}

  clear(): void {
    this.packets.clear();
    this.effects = [];
    this.byCommit.clear();
  }

  /** Re-seat every in-flight pipeline at its station without travel (load, jumps). */
  sync(world: World): void {
    this.clear();
    const t = this.now();
    const sorted = Array.from(world.pipelines.values()).filter((p) => p.state === 'running' || p.state === 'pending').sort((a, b) => a.created - b.created);
    for (const p of sorted) {
      const st: Station = p.state === 'running' ? { k: 'slot' } : { k: 'queue', q: p.lane };
      const pk = this.make(p.id ?? "", p, world, st, t, true);
      if (!pk) break;
      const a = this.anchor(pk, world);
      pk.x = a.x; pk.y = a.y;
      pk.labelUntil = 0;
    }
  }

  onEvent(e: Event, w: World): void {
    const t = this.now();
    switch (e.k) {
      case 'push': {
        const org = isBot(e.author, e.bot) ? BOTS : w.orgOf(e.repo);
        const id = `${e.repo}@${e.sha}`;
        if (this.packets.has(id)) return;
        const pk = this.spawn(id, '', e.repo, org, isBot(e.author, e.bot), { k: 'src', org }, t);
        if (!pk) return;
        const L = this.L();
        const row = L?.sources.find((s) => s.org === org);
        if (row) { pk.x = row.port.x + 10; pk.y = row.y; }
        this.byCommit.set(id, id);
        // A push that starts no pipeline fades where it is.
        pk.die = t + 6000;
        break;
      }
      case 'enqueue': {
        const p = w.pipelines.get(e.pipeline);
        const cid = `${e.repo}@${e.sha}`;
        let pk = this.packets.get(this.byCommit.get(cid) ?? '') ?? null;
        if (pk) {
          this.packets.delete(pk.id);
          pk.id = e.pipeline;
          pk.pipeline = e.pipeline;
          pk.die = 0;
          this.packets.set(pk.id, pk);
          this.byCommit.delete(cid);
        } else {
          const bot = !!w.commits.get(cid)?.bot;
          const org = bot ? BOTS : w.orgOf(e.repo);
          pk = this.spawn(e.pipeline, e.pipeline, e.repo, org, bot, { k: 'src', org }, t);
          if (!pk) return;
          const row = this.L()?.sources.find((s) => s.org === org);
          if (row) { pk.x = row.port.x + 10; pk.y = row.y; }
        }
        this.moveTo(pk, { k: 'queue', q: p?.lane ?? e.lane }, w, t);
        break;
      }
      case 'start': {
        let pk = this.packets.get(e.pipeline);
        const p = w.pipelines.get(e.pipeline);
        if (!pk && p) {
          pk = this.make(e.pipeline, p, w, { k: 'queue', q: p.lane }, t, false) ?? undefined;
          if (pk) { const a = this.anchor(pk, w); pk.x = a.x; pk.y = a.y; }
        }
        if (pk) this.moveTo(pk, { k: 'slot' }, w, t);
        break;
      }
      case 'finish': {
        const pk = this.packets.get(e.pipeline);
        const p = w.pipelines.get(e.pipeline);
        if (!pk || !p) return;
        const L = this.L();
        const slot = L ? slotPoint(L, w, p) : null;
        if (slot) this.effects.push({ k: 'flash', x: slot.x, y: slot.y, t0: t, color: e.state === 'success' ? '#F2F2F0' : '#E06464', dur: 420, r: slot.r });
        const onMain = isMain(w, p);
        if (e.state === 'success') {
          pk.tint = 'amber';
          this.moveTo(pk, { k: 'gate' }, w, t);
          pk.next = onMain ? [[{ k: 'main', repo: p.repo }, 220]] : [[{ k: 'review' }, 200]];
        } else if (e.state === 'failure' || e.state === 'error') {
          pk.tint = 'red';
          if (onMain) {
            this.moveTo(pk, { k: 'gate' }, w, t);
            pk.next = [[{ k: 'main', repo: p.repo }, 160], [{ k: 'ret', org: pk.org }, 500]];
          } else this.moveTo(pk, { k: 'ret', org: pk.org }, w, t);
        } else {
          pk.tint = 'gray';
          pk.die = t;
        }
        break;
      }
      case 'deploy': {
        if (e.state !== 'running') {
          if (e.state === 'success' || e.state === 'failure') {
            const id = `deploy:${e.app}:${e.sha}`;
            const pk = this.packets.get(id);
            if (pk) {
              pk.tint = e.state === 'success' ? 'green' : 'red';
              this.moveTo(pk, { k: 'app', app: e.app }, w, t);
            } else this.pulseApp(e.app, e.state === 'success' ? '#7FC48F' : '#E06464', t);
          }
          return;
        }
        const app = w.apps.get(e.app);
        const repo = app?.repo ?? '';
        const id = `deploy:${e.app}:${e.sha}`;
        if (this.packets.has(id)) return;
        const pk = this.spawn(id, '', repo, w.orgOf(repo), false, { k: 'main', repo }, t);
        if (!pk) return;
        pk.app = e.app;
        pk.label = e.app;
        const a = this.anchor(pk, w);
        pk.x = a.x; pk.y = a.y;
        this.moveTo(pk, { k: 'deploy' }, w, t);
        break;
      }
      case 'health': {
        this.pulseApp(e.app, e.to === 'up' ? '#7FC48F' : e.to === 'degraded' ? '#E5B567' : '#E06464', t);
        break;
      }
      case 'merge': {
        const L = this.L();
        if (L) this.effects.push({ k: 'flash', x: L.review.x + L.review.w / 2, y: L.review.y + L.review.h / 2, t0: t, color: '#7FC48F', dur: 500, r: 14 });
        break;
      }
      default:
        break;
    }
  }

  private pulseApp(app: string, color: string, t: number): void {
    const c = this.L()?.apps.find((a) => a.app === app);
    if (c) this.effects.push({ k: 'pulse', x: c.x + c.s / 2, y: c.y + c.s / 2, t0: t, color, dur: 900, r: c.s });
  }

  private make(id: string, p: Pipeline, w: World, st: Station, t: number, quiet: boolean): Packet | null {
    const c = w.commitOfPipeline(p);
    const bot = !!c?.bot;
    const pk = this.spawn(id, p.id ?? "", p.repo, bot ? BOTS : w.orgOf(p.repo), bot, st, t, quiet);
    return pk;
  }

  private spawn(id: string, pipeline: string, repo: string, org: string, bot: boolean, st: Station, t: number, quiet = false): Packet | null {
    if (t !== this.bornAt) { this.bornAt = t; this.born = 0; }
    if (!quiet && (this.born >= MAX_NEW_PER_FRAME || this.packets.size >= MAX_PACKETS)) {
      this.dropped++;
      // Coalesce: bump the newest packet from the same org still at its source.
      for (const pk of this.packets.values()) if (pk.org === org && pk.st.k === 'src') { pk.count++; break; }
      return null;
    }
    if (this.packets.size >= MAX_PACKETS + 40) return null;
    this.born++;
    const pk: Packet = {
      id, pipeline, repo, org, bot, label: String(repo ?? '').split('/')[1] ?? repo ?? '', labelUntil: t + 1600, st, pts: null, lens: [], total: 0,
      t0: t, dur: 0, x: 0, y: 0, tint: 'amber', born: t, die: 0, next: [], count: 1, app: '',
    };
    this.packets.set(id, pk);
    return pk;
  }

  moveTo(pk: Packet, st: Station, w: World, t: number): void {
    const L = this.L();
    const from = { x: pk.x, y: pk.y };
    const prev = pk.st;
    pk.st = st;
    if (!L) return;
    const to = this.anchor(pk, w);
    const pts = route(L, w, pk, prev, st, from, to);
    let total = 0;
    const lens = [0];
    for (let i = 1; i < pts.length; i++) { total += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y); lens.push(total); }
    pk.pts = pts;
    pk.lens = lens;
    pk.total = total;
    pk.t0 = t;
    pk.dur = this.reduced ? 0 : clamp(total / SPEED, 420, 1500);
  }

  /** Where a packet rests at its station now. */
  anchor(pk: Packet, w: World): Pt {
    const L = this.L();
    if (!L) return { x: pk.x, y: pk.y };
    const st = pk.st;
    switch (st.k) {
      case 'src': {
        const row = L.sources.find((s) => s.org === st.org);
        return row ? { x: row.port.x + 10, y: row.y } : { x: L.m, y: L.live.y1 / 2 };
      }
      case 'queue': {
        const mch = L.intake[st.q];
        if (!mch) return { x: L.m, y: L.live.y1 / 2 };
        const q = w.queues.get(st.q);
        const i = Math.max(0, q?.items?.indexOf(pk.pipeline) ?? 0);
        const cap = Math.max(1, Math.floor((mch.h - 20) / 13));
        return { x: mch.x + mch.w / 2, y: mch.y + mch.h - 12 - Math.min(i, cap - 1) * 13 };
      }
      case 'slot': {
        const p = w.pipelines.get(pk.pipeline);
        const s = p ? slotPoint(L, w, p) : null;
        return s ? { x: s.x, y: s.y } : { x: L.cols.engines + 20, y: L.engines[0]?.y ?? 120 };
      }
      case 'gate':
        return { x: L.gate.x + L.gate.w / 2, y: L.gate.y + L.gate.h / 2 };
      case 'review':
        return { x: L.review.x + L.review.w / 2, y: L.review.y + L.review.h / 2 };
      case 'deploy':
        return { x: L.deploy.x + L.deploy.w / 2, y: L.deploy.y + L.deploy.h / 2 };
      case 'main': {
        const line = L.mains.find((l) => l.repo === st.repo);
        if (line) return { x: line.x1 - 14, y: line.y };
        return { x: L.agg.x0 + 8, y: L.agg.y };
      }
      case 'app': {
        const c = L.apps.find((a) => a.app === st.app);
        return c ? { x: c.x + c.s / 2, y: c.y + c.s / 2 } : { x: L.appsBox.x, y: L.appsBox.y };
      }
      case 'ret': {
        const row = L.sources.find((s) => s.org === st.org);
        return row ? { x: row.port.x, y: row.y } : { x: L.m, y: L.ret.topY };
      }
    }
  }

  /** Advances every packet to `t`; returns whether anything is moving. */
  update(t: number, w: World, dt: number): boolean {
    let moving = false;
    const k = 1 - Math.exp(-dt / 110);
    for (const pk of this.packets.values()) {
      if (pk.die && t - pk.die > 700) { this.packets.delete(pk.id); continue; }
      if (pk.pts && t < pk.t0 + pk.dur) {
        const u = easeInOut((t - pk.t0) / pk.dur);
        const at = pointAlong(pk, u * pk.total);
        pk.x = at.x; pk.y = at.y;
        moving = true;
        continue;
      }
      if (pk.pts) {
        pk.pts = null;
        this.arrive(pk, w, t);
      }
      const a = this.anchor(pk, w);
      const dx = a.x - pk.x, dy = a.y - pk.y;
      if (Math.abs(dx) > 0.2 || Math.abs(dy) > 0.2) {
        pk.x += this.reduced ? dx : dx * k;
        pk.y += this.reduced ? dy : dy * k;
        moving = true;
      }
      if (pk.next.length && !pk.pts && t >= pk.t0 + pk.dur + pk.next[0][1]) {
        const [st] = pk.next.shift()!;
        this.moveTo(pk, st, w, t);
        moving = true;
      }
    }
    this.effects = this.effects.filter((e) => t - e.t0 < e.dur);
    return moving || this.effects.length > 0;
  }

  private arrive(pk: Packet, w: World, t: number): void {
    const L = this.L();
    const st = pk.st;
    if (st.k === 'main') {
      const a = this.anchor(pk, w);
      if (!this.reduced) this.effects.push({ k: 'pop', x: a.x, y: a.y, t0: t, color: pk.tint === 'red' ? '#E06464' : '#CFCFD1', dur: 360 });
      if (!pk.next.length && !pk.app) pk.die = t;
    } else if (st.k === 'review' || st.k === 'ret') {
      pk.die = t + 120;
    } else if (st.k === 'app') {
      this.pulseApp(st.app, pk.tint === 'red' ? '#E06464' : '#7FC48F', t);
      pk.die = t;
    } else if (st.k === 'gate' && L) {
      this.effects.push({ k: 'flash', x: L.gate.x + L.gate.w / 2, y: L.gate.y + L.gate.h / 2, t0: t, color: pk.tint === 'red' ? '#E06464' : '#E5B567', dur: 380, r: 16 });
    }
    if (L && (st.k === 'queue' || st.k === 'gate' || st.k === 'deploy')) {
      const m = st.k === 'queue' ? L.intake[st.q] : st.k === 'gate' ? L.gate : L.deploy;
      this.effects.push({ k: 'port', x: m.inPort.x, y: m.inPort.y, t0: t - 200, color: '#E5B567', dur: 520 });
    }
  }
}

function isBot(author: string | undefined, bot: boolean | undefined): boolean {
  return !!bot || !!author?.endsWith('[bot]');
}

export function isMain(w: World, p: Pipeline): boolean {
  const r = w.repos.get(p.repo);
  return p.event !== 'pull_request' && p.branch === (r?.default_branch ?? 'main');
}

/** The engine a pipeline runs on: by id, by agent label (what pipelines name), by its running
 *  list, or GitHub Actions' virtual one. */
export function engineOf(w: World, p: Pipeline) {
  const all = enginesOf(w);
  if (p.engine) {
    const e = w.engines.get(p.engine) ?? all.find((x) => x.label === p.engine);
    if (e) return e;
  }
  if (p.id) {
    const e = all.find((x) => x.running?.includes(p.id!));
    if (e) return e;
  }
  return p.lane === 'gha' ? all.find((x) => x.id === GHA) : undefined;
}

export function slotPoint(L: Layout, w: World, p: Pipeline): { x: number; y: number; r: number } | null {
  const eng = engineOf(w, p);
  if (!eng) return null;
  const slots = L.slotByEngine.get(eng.id);
  if (!slots?.length) return null;
  let i = eng.running?.indexOf(p.id ?? "") ?? 0;
  if (i < 0) i = 0;
  return slots[Math.min(i, slots.length - 1)];
}

function pointAlong(pk: Packet, d: number): Pt {
  const pts = pk.pts!, lens = pk.lens;
  if (d <= 0) return pts[0];
  if (d >= pk.total) return pts[pts.length - 1];
  let lo = 0, hi = lens.length - 1;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (lens[mid] < d) lo = mid; else hi = mid; }
  const seg = lens[hi] - lens[lo] || 1;
  const u = (d - lens[lo]) / seg;
  return { x: pts[lo].x + (pts[hi].x - pts[lo].x) * u, y: pts[lo].y + (pts[hi].y - pts[lo].y) * u };
}

function curve(out: Pt[], a: Pt, b: Pt, n = 18): void {
  const c = wire(a, b);
  for (let i = 1; i <= n; i++) out.push(bezierAt(c, i / n));
}

/** The wire a packet travels from one station to the next. */
function route(L: Layout, w: World, pk: Packet, from: Station, to: Station, a: Pt, b: Pt): Pt[] {
  const pts: Pt[] = [a];
  const engBox = () => {
    const p = w.pipelines.get(pk.pipeline);
    const eng = p ? engineOf(w, p)?.id : undefined;
    return L.engines.find((e) => eng && e.engines.includes(eng)) ?? null;
  };
  if (to.k === 'queue') {
    const m = L.intake[to.q];
    if (from.k === 'src') curve(pts, a, L.junction, 14);
    curve(pts, pts[pts.length - 1], m.inPort, 14);
    pts.push(b);
  } else if (to.k === 'slot') {
    const box = engBox();
    const q = from.k === 'queue' ? L.intake[from.q] : null;
    if (q) pts.push(q.outPort);
    if (box) { curve(pts, pts[pts.length - 1], box.inPort, 20); pts.push({ x: box.inPort.x + 10, y: b.y }); }
    pts.push(b);
  } else if (to.k === 'gate') {
    const box = engBox();
    if (box) { pts.push({ x: box.outPort.x - 8, y: a.y }); pts.push(box.outPort); }
    curve(pts, pts[pts.length - 1], L.gate.inPort, 20);
    pts.push(b);
  } else if (to.k === 'review') {
    pts.push({ x: a.x, y: L.gate.y + L.gate.h });
    pts.push({ x: a.x, y: L.review.y });
    pts.push(b);
  } else if (to.k === 'main') {
    if (from.k === 'gate') {
      pts.push(L.gate.outPort);
      pts.push({ x: L.bus.x, y: L.gate.outPort.y });
      pts.push({ x: L.bus.x, y: b.y });
      pts.push({ x: L.cols.mains, y: b.y });
    }
    pts.push(b);
  } else if (to.k === 'deploy') {
    pts.push({ x: L.cols.mains, y: a.y });
    pts.push({ x: L.bus.x, y: a.y });
    pts.push({ x: L.bus.x, y: L.deploy.outPort.y });
    pts.push(L.deploy.outPort);
    pts.push(b);
  } else if (to.k === 'app') {
    pts.push(L.deploy.outPort);
    pts.push({ x: L.bus.x, y: L.deploy.outPort.y });
    pts.push({ x: L.bus.x, y: b.y });
    pts.push({ x: L.appsBox.x - 6, y: b.y });
    pts.push(b);
  } else if (to.k === 'ret') {
    const box = from.k === 'slot' ? engBox() : null;
    const startX = from.k === 'main' ? L.bus.x : box ? box.x + box.w / 2 : a.x;
    if (from.k === 'main') { pts.push({ x: L.cols.mains, y: a.y }); pts.push({ x: L.bus.x, y: a.y }); }
    else if (box) pts.push({ x: startX, y: box.y + box.h });
    pts.push({ x: startX, y: L.ret.y });
    pts.push({ x: L.ret.x0, y: L.ret.y });
    pts.push({ x: L.ret.x0, y: b.y });
    pts.push(b);
  } else {
    curve(pts, a, b, 16);
  }
  return pts;
}
