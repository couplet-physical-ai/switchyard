// THE COFFEE CHECK (fab-lens; FACTORY-SPEC §E): the five minutes a day Felipe sits down with the
// factory. On open: what changed SINCE YOU LAST LOOKED, one glance in the floor's top row (a
// verdict, flowing · slowed · jammed · broken, with its glyph, and a few numbers with arrows vs the
// last visit, each a lens on what it counts), and on the floor itself, where they are: fresh
// things pulse on the shared beat, fading over ~2 min once seen; anomalies pop: smoke over the
// scanner when one failure signature hits ≥ 3 repos within the hour (wisps over each dock
// involved), a red beacon over a district with an app down and over a main line red < 1 h
// (≤ 3 pulse at once, the rest hold steady), crates bunching at the intake when it jams.
//
// The last visit is kept per server in the app's own storage (Contract's persisted `visits`,
// beside the persisted `server`): when it was, and which main lines were red and which apps
// were down then (short hashes), so "new red", "fixed", "down" and "recovered" are exact. It is
// marked after 2 minutes of looking, every minute after, and when you leave the floor.
// The digest is recomputed at most every 2 s while the world changes: O(entities).

import type { Frame } from '../../app.contract.d.ts';
import type { Gfx } from '../yard/gfx.ts';
import { C, TAU, clamp, withAlpha } from '../yard/theme.ts';
import { isRed } from '../yard/select.ts';
import type { Factory } from './factory.ts';
import { ago } from './lens.ts';
import { beat, beatPhase, changesSince, clusterStep, clusters, type Changes, type Cluster } from './seams.ts';

export type Verdict = 'flowing' | 'slowed' | 'jammed' | 'broken';
type Visit = { at: number; r: string; d: string };
type Digest = Changes & {
  verdict: Verdict; why: string;
  /** the biggest failure cluster of the last hour when it spans ≥ 3 repos (smoke), else null */
  smoke: Cluster | null; smokeQueue: number; smokeDeploy: number;
  beacons: { di: number; down: boolean }[]; jam: number;
};

const FRESH_MS = 120_000;
const OK = '#7FC48F';
const SMALL = 12;
const HOUR = 3_600_000;

function emptyDigest(): Digest {
  return {
    newRed: [], fixed: [], acute: [], failed: [], deployApps: [], deploys: 0, deployFails: 0, merged: [], down: [], recovered: [],
    verdict: 'flowing', why: '', smoke: null, smokeQueue: 0, smokeDeploy: 0, beacons: [], jam: 0,
  };
}

export class Coffee {
  /** The server whose last visit is latched: the baseline holds for the whole session. */
  private server: string | null = null;
  /** Server ms of the last visit (or 24 h ago, a first look). */
  since = 0;
  first = true;
  private baseRed: Set<string> | null = null;
  private baseDown: Set<string> | null = null;
  dg: Digest = emptyDigest();
  private dgVer = -1;
  private dgAt = -1e12;
  /** Fresh thing → the module clock when it was first drawn (its pulse fades from then). */
  private seen = new Map<string, number>();
  /** Health seen per app this session: [server ms, health] transitions. */
  private health = new Map<string, [number, string][]>();
  /** The queue's length every 15 s of the world, the last 5 minutes (a growing queue jams). */
  private qlen: number[] = [];
  private qAt = 0;

  constructor(readonly f: Factory) {}

  // ---- the last visit ----------------------------------------------------------------------------
  /** Latches this session's baseline for `server` from the persisted visits; the glance in words. */
  open(server: string, visits: string, ok: boolean): string {
    if (!ok || !this.f.world.loaded) return '';
    if (this.server !== server) {
      this.server = server;
      const v = parseVisits(visits)[serverKey(server)];
      const now = this.f.tl.liveNow();
      if (v && v.at > 0 && v.at < now) {
        this.since = v.at; this.first = false;
        this.baseRed = new Set(v.r ? v.r.split(',') : []); this.baseDown = new Set(v.d ? v.d.split(',') : []);
      } else {
        this.since = now - 24 * HOUR; this.first = true; this.baseRed = null; this.baseDown = null;
      }
      this.seen.clear();
      this.dgVer = -1; this.dgAt = -1e12;
    }
    return this.words();
  }

  /** The visits with this server's marked now (live only): '' leaves them as they are. */
  mark(server: string, visits: string): string {
    const tl = this.f.tl, w = tl.world;
    if (tl.mode !== 'live' || !w.loaded) return '';
    const all = parseVisits(visits);
    const red: string[] = [], down: string[] = [];
    for (const r of w.repos.values()) if (isRed(r)) red.push(h36(r.id));
    for (const a of w.apps.values()) if (a.health === 'down' || a.health === 'degraded') down.push(h36(a.id ?? ''));
    const me = serverKey(server);
    all[me] = { at: Math.round(tl.liveNow()), r: red.join(','), d: down.join(',') };
    // the four most recent servers (a persisted state keeps ≤ 16 KB)
    const keys = Object.keys(all).sort((a, b) => all[b].at - all[a].at).slice(0, 4);
    const out: Record<string, Visit> = {};
    for (const k of keys) out[k] = all[k];
    let s = JSON.stringify(out);
    if (s.length > 14_000) s = JSON.stringify({ [me]: all[me] });
    return s.length > 14_000 ? JSON.stringify({ [me]: { at: all[me].at, r: '', d: '' } }) : s;
  }

  /** The glance in words (the floor's accessible mirror, and tests). */
  words(): string {
    const d = this.dg;
    const parts: string[] = [d.why ? `${d.verdict}: ${d.why}` : d.verdict];
    if (d.newRed.length) parts.push(`${d.newRed.length} newly red`);
    if (d.fixed.length) parts.push(`${d.fixed.length} fixed`);
    if (d.failed.length) parts.push(`${d.failed.length} failed`);
    if (d.down.length) parts.push(`${d.down.length} down`);
    if (d.deploys) parts.push(`${d.deploys} deploys`);
    if (d.merged.length) parts.push(`${d.merged.length} merged`);
    parts.push(this.first ? 'first look, last 24 h' : `since ${ago(this.f.tl.liveNow() - this.since)} ago`);
    return parts.join(' · ');
  }

  // ---- the digest --------------------------------------------------------------------------------
  private update(t: number): void {
    const f = this.f, w = f.world, c = f.census;
    if (!w.loaded) return;
    if (t - this.dgAt < 2000 || (w.ver === this.dgVer && t - this.dgAt < 10_000)) return;
    this.dgVer = w.ver; this.dgAt = t;
    const now = f.tl.playhead;
    if (!this.since) this.since = now - 24 * HOUR;
    const d: Digest = { ...emptyDigest(), ...changesSince(w, this.since, now, { red: this.baseRed, down: this.baseDown }, h36) };
    let downNow = 0;
    const downApps = new Set<string>();
    for (const a of w.apps.values()) {
      const id = a.id ?? '';
      if (a.health === 'down') { downNow++; downApps.add(id); }
      let log = this.health.get(id);
      if (!log) { log = []; this.health.set(id, log); }
      if (!log.length || log[log.length - 1][1] !== a.health) { log.push([now, a.health]); if (log.length > 24) log.shift(); }
    }
    // the jam (§E): something waits, every slot is busy, and the oldest waits over 2× the p50
    // queue time; or the queue grew by ≥ 3 in five minutes and ≥ 3 wait
    let slots = 0, busy = 0;
    for (const g of c.groups) if (!g.hosted) { slots += g.slots; busy += g.running.length; }
    if (w.at - this.qAt >= 15_000) { this.qAt = w.at; this.qlen.push(c.waiting); if (this.qlen.length > 20) this.qlen.shift(); }
    const grew = this.qlen.length >= 4 ? c.waiting - Math.min(...this.qlen.slice(0, -1)) : 0;
    const p50q = w.stats.p50_queue_ms || 60_000;
    const full = slots > 0 && busy >= slots;
    const jammed = (c.waiting > 0 && full && c.oldestWait > 2 * p50q) || (grew >= 3 && c.waiting >= 3);
    d.jam = jammed ? clamp(0.5 + c.waiting / 12 + grew / 10, 0.5, 1) : 0;
    // failures: the hour's clusters (smoke: one signature across ≥ 3 repos)
    const cl = clusters(w, now - HOUR, now);
    d.smoke = cl.length && cl[0].repos.size >= 3 ? cl[0] : null;
    const fl = c.flow;
    const failRate = fl.finished >= 4 ? fl.failed / fl.finished : 0;
    const typical = Math.max(0.2, (1 - (w.stats.success_rate_24h || 0.85)) * 1.5);
    let depFail1h = 0;
    for (const dp of w.deploys.values()) if (dp.state === 'failure' && dp.started >= now - HOUR && dp.started <= now) depFail1h++;
    d.smokeDeploy = depFail1h >= 2 ? clamp(depFail1h / 5, 0.4, 1) : 0;
    d.smokeQueue = !jammed && c.oldestWait > 4 * p50q && c.waiting >= 2 ? 0.5 : 0;
    // the verdict (§E): broken = a main line red < 1 h, an app down, a jam or the outage watcher;
    // slowed = a wait over 2× its p50 or a failure rate over the typical; else flowing
    if (downNow) { d.verdict = 'broken'; d.why = `${downNow} ${downNow === 1 ? 'app' : 'apps'} down`; }
    else if (w.watcher?.tripped) { d.verdict = 'broken'; d.why = 'outage watcher tripped'; }
    else if (d.acute.length) { d.verdict = 'broken'; d.why = `${d.acute.length} main ${d.acute.length === 1 ? 'line' : 'lines'} red < 1 h`; }
    else if (jammed) { d.verdict = 'jammed'; d.why = `${c.waiting} waiting, every bay busy`; }
    else if (failRate > typical && fl.failed >= 3) { d.verdict = 'slowed'; d.why = `${Math.round(failRate * 100)}% of runs fail`; }
    else if (c.waiting > 0 && c.oldestWait > 2 * p50q) { d.verdict = 'slowed'; d.why = `oldest waits ${ago(c.oldestWait)}`; }
    // beacons: districts with an app down
    c.districts.forEach((dist, i) => { for (const id of dist.apps) if (downApps.has(id)) { d.beacons.push({ di: i, down: true }); break; } });
    this.dg = d;
  }

  /** This session's health transitions of an app (the app lens's strip). */
  healthLog(id: string): [number, string][] { return this.health.get(id) ?? []; }

  /** What a glance chip lights (the "since you looked" lens). */
  freshSet(k: string): { repos: string[]; apps: string[]; fails: string[] } {
    const d = this.dg, w = this.f.world;
    switch (k) {
      case 'red': return { repos: d.newRed, apps: [], fails: [] };
      case 'fixed': return { repos: d.fixed, apps: [], fails: [] };
      case 'failed': return { repos: [...new Set(d.failed.map((id) => w.pipelines.get(id)?.repo ?? ''))].filter(Boolean), apps: [], fails: d.failed };
      case 'down': return { repos: [], apps: [...d.down, ...d.recovered], fails: [] };
      case 'deploys': return { repos: [], apps: d.deployApps, fails: [] };
      case 'merged': return { repos: [...new Set(d.merged.map((k2) => k2.slice(0, k2.indexOf('@'))))], apps: [], fails: [] };
      default: return { repos: [], apps: [], fails: [] };
    }
  }

  // ---- on the floor ------------------------------------------------------------------------------
  under(g: Gfx, t: number): void {
    this.update(t);
    if (this.f.tl.mode !== 'replay' && !this.f.lens.topLens) this.freshGlows(g, t);
    this.anomalies(g, t);
  }

  /** Where each repo's newest car (and newest culprit) sits on its rail, and each car by key. */
  carSpots(): { carAt: Map<string, [number, number]>; repoAt: Map<string, [number, number]>; culpritAt: Map<string, [number, number]> } {
    const c = this.f.census, P = this.f.plan;
    const carAt = new Map<string, [number, number]>(), repoAt = new Map<string, [number, number]>(), culpritAt = new Map<string, [number, number]>();
    c.rails.forEach((r, i) => {
      const n = r.cars.length;
      r.cars.forEach((car, k) => {
        const u = P.RAIL_U1 - 12 - (n - 1 - k) * 10;
        if (u < P.RAIL_U0 + 4) return;
        const at: [number, number] = [u, P.RAIL_V[i]];
        carAt.set(`${car.repo}@${car.sha}`, at);
        repoAt.set(car.repo, at);
        if (car.culprit) culpritAt.set(car.repo, at);
      });
    });
    return { carAt, repoAt, culpritAt };
  }

  /** Fresh things pulse where they are, on the shared beat, fading over ~2 min once seen. */
  private freshGlows(g: Gfx, t: number): void {
    const f = this.f, P = f.plan, cam = f.cam, fx = f.fx, d = this.dg;
    const { carAt, repoAt, culpritAt } = this.carSpots();
    const items: [string, number, number, number, string][] = []; // key, x, y, r, colour
    const add = (key: string, u: number, v: number, z: number, r: number, col: string) => items.push([key, cam.x(u, v), cam.y(u, v, z), r, col]);
    for (const id of d.newRed) { const at = culpritAt.get(id) ?? repoAt.get(id); if (at) add(`red:${id}`, at[0], at[1], 5, 6, C.red); }
    for (const id of d.fixed) { const at = repoAt.get(id); if (at) add(`fix:${id}`, at[0], at[1], 5, 6, OK); }
    for (const k of d.merged) { const at = carAt.get(k); if (at) add(`mrg:${k}`, at[0], at[1], 5, 5, C.ink2); }
    const parked = new Map(f.lens.parked.map((x) => [x.id, x.u]));
    for (const id of d.failed) { const u = parked.get(id); if (u !== undefined) add(`fail:${id}`, u, P.RETURN_V, 8, 6, C.red); }
    const down = new Set(d.down), rec = new Set(d.recovered);
    for (const id of new Set([...d.deployApps, ...d.down, ...d.recovered])) {
      const b = fx.blockAt.get(id);
      if (!b) continue;
      add(`app:${id}`, b.u + b.d / 2, b.v + b.d / 2, b.h + 1.5, 4, down.has(id) ? C.red : rec.has(id) ? OK : '#9FB8A6');
    }
    if (!items.length) return;
    const b = beat(t), ph = beatPhase(t);
    const byCol = new Map<string, number[]>();
    for (const [key, x, y, r, col] of items) {
      let s = this.seen.get(key);
      if (s === undefined) { s = t; this.seen.set(key, s); }
      const a = 1 - (t - s) / FRESH_MS;
      if (a <= 0) continue;
      const k = `${col}|${Math.ceil(a * 4) / 4}`;
      let l = byCol.get(k); if (!l) byCol.set(k, (l = []));
      l.push(x, y, r);
    }
    if (this.seen.size > 4000) this.seen.clear();
    for (const [k, xy] of byCol) {
      const [col, qs] = k.split('|');
      const q = Number(qs);
      g.begin_();
      for (let i = 0; i < xy.length; i += 3) g.circle(xy[i], xy[i + 1], xy[i + 2] * (1.3 + 0.5 * b));
      g.fill(withAlpha(col, 0.18 * q));
      g.begin_();
      for (let i = 0; i < xy.length; i += 3) g.circle(xy[i], xy[i + 1], xy[i + 2] + 2 + ph * 10);
      g.stroke(withAlpha(col, 0.7 * q * (1 - ph)), 1.2);
    }
  }

  /** Smoke, beacons, the jam. Quiet when the factory is healthy. */
  private anomalies(g: Gfx, t: number): void {
    const f = this.f, P = f.plan, cam = f.cam, d = this.dg, fx = f.fx, w = f.world;
    const sz = clamp(cam.s * 1.3, 0.7, 3);
    const smoke = (x: number, y: number, k: number, ember: boolean, puffs = 9, rise = 74) => {
      if (k <= 0) return;
      if (ember) { g.begin_(); g.ctx.ellipse(x, y + 2, 16 * sz, 7 * sz, 0, 0, TAU); g.fill(withAlpha(C.red, 0.1 + 0.12 * k)); }
      for (let i = 0; i < puffs; i++) {
        const p = ((t / 5600) + i / puffs) % 1;
        const fade = p < 0.12 ? p / 0.12 : 1 - (p - 0.12) / 0.88;
        const px = x + (Math.sin(p * 4 + i * 1.7) * 6 + p * 22) * sz, py = y - (6 + p * rise) * sz;
        g.begin_(); g.circle(px, py, (4 + p * 15 * (rise / 74)) * sz);
        g.fill(withAlpha(i % 3 ? '#8E8E94' : '#A6A6AC', 0.22 * fade * k));
      }
    };
    // smoke: one signature failing ≥ 3 repos this hour, over the scanner, wisps over each dock
    if (d.smoke) {
      const k = clamp(0.45 + d.smoke.repos.size / 10, 0.45, 1);
      smoke(cam.x(P.SCAN_U, 320), cam.y(P.SCAN_U, 320, 56), k, true);
      const orgs = new Set([...d.smoke.repos].map((r) => w.orgOf(r)));
      for (const o of orgs) { const v = fx.dockV(o); smoke(cam.x(P.DOCK_U0 + 20, v), cam.y(P.DOCK_U0 + 20, v, 14), k * 0.7, false, 4, 34); }
    }
    smoke(cam.x((P.SCAN_U + P.TRACK_U1) / 2, P.TRACK_V[1]), cam.y((P.SCAN_U + P.TRACK_U1) / 2, P.TRACK_V[1], 4), d.smokeDeploy, true);
    smoke(cam.x((P.INTAKE_U0 + P.INTAKE_U1) / 2, 291), cam.y((P.INTAKE_U0 + P.INTAKE_U1) / 2, 291, 8), d.smokeQueue, false, 5, 40);
    // beacons: districts with an app down, then main lines red < 1 h; ≤ 3 pulse, the rest steady
    const spots: [number, number][] = [];
    for (const bc of d.beacons) { const b = fx.districtBox[bc.di]; if (b) spots.push([b.u0 + 4, b.v0 + 4]); }
    if (d.acute.length) {
      const { culpritAt, repoAt } = this.carSpots();
      for (const id of d.acute) { const at = culpritAt.get(id) ?? repoAt.get(id); if (at && spots.length < 12) spots.push(at); }
    }
    const b = beat(t);
    spots.forEach(([u, v], i) => {
      const live = i < 3 ? b : 0.6;
      const x = cam.x(u, v), y0 = cam.y(u, v, 0), y1 = cam.y(u, v, 40);
      g.vline(x, y1, y0, withAlpha(C.red, 0.55), 1.5);
      g.begin_(); g.circle(x, y1, (8 + live * 7) * Math.min(1.6, sz)); g.fill(withAlpha(C.red, 0.1 + 0.14 * live));
      g.begin_(); g.circle(x, y1, 3.4 + live); g.fill(C.red);
    });
    // a jam: crates bunch at the intake's mouth, pressed together; chevrons push behind them
    if (d.jam > 0) {
      const n = 3 + Math.round(d.jam * 4);
      for (let k = n - 1; k >= 0; k--) fx.crate(g, P.DIST_U - 6 - k * 4.6, 291 + ((k % 2) * 2 - 1) * 1.2, 7, false, true, 2 + (k % 3 === 1 ? 3 : 0));
      const ph = beatPhase(t);
      g.begin_();
      for (let i = 0; i < 3; i++) {
        const u = P.INTAKE_U0 + 6 + i * 9 + ph * 9, v = P.LANE_V[0] - 22;
        const x = cam.x(u, v), y = cam.y(u, v, 1);
        g.move(x - 3, y - 4); g.line(x + 1, y); g.line(x - 3, y + 4);
      }
      g.stroke(withAlpha(C.packet, 0.6 * d.jam), 1.4);
    }
  }

  // ---- the glance --------------------------------------------------------------------------------
  /** The floor's top row, after the zoom readout (the verdict replaces the hint, §E): the verdict
   *  word with its glyph, up to five numbers vs the last visit (each a lens on what it counts),
   *  and how long ago that was. Chips drop from the end rather than run into the key. */
  glance(g: Gfx, fr: Frame, t: number, x0: number, right: number): void {
    void fr;
    this.update(t);
    const f = this.f, d = this.dg, replay = f.tl.mode === 'replay';
    const col = d.verdict === 'broken' ? C.red : d.verdict === 'jammed' ? C.packet : d.verdict === 'slowed' ? C.amberText : OK;
    const word = replay ? `${d.verdict} · replay` : d.verdict;
    type Chip = { key: string; arrow: 0 | 1 | -1; n: string; w: string; col: string; arrowCol: string };
    const chips: Chip[] = [];
    if (!replay) {
      if (d.newRed.length) chips.push({ key: 'red', arrow: 1, n: `${d.newRed.length}`, w: 'red', col: C.redText, arrowCol: C.red });
      if (d.fixed.length) chips.push({ key: 'fixed', arrow: -1, n: `${d.fixed.length}`, w: 'fixed', col: C.greenInk, arrowCol: OK });
      if (d.down.length) chips.push({ key: 'down', arrow: 1, n: `${d.down.length}`, w: 'down', col: C.redText, arrowCol: C.red });
      else if (d.recovered.length) chips.push({ key: 'down', arrow: -1, n: `${d.recovered.length}`, w: 'recovered', col: C.greenInk, arrowCol: OK });
      if (d.failed.length) chips.push({ key: 'failed', arrow: 0, n: `${d.failed.length}`, w: 'failed', col: C.redText, arrowCol: C.red });
      if (d.deploys) chips.push({ key: 'deploys', arrow: 0, n: `${d.deploys}`, w: 'deploys', col: C.ink2, arrowCol: C.ink2 });
      if (d.merged.length) chips.push({ key: 'merged', arrow: 0, n: `${d.merged.length}`, w: 'merged', col: C.ink2, arrowCol: C.ink2 });
    }
    const since = replay ? '' : this.first ? 'last 24 h' : `since ${ago(f.tl.liveNow() - this.since)} ago`;
    const ww = 24 + g.width(word, 15, true) + 12;
    const cwOf = (ch: Chip) => (ch.arrow ? 12 : 0) + g.width(ch.n, SMALL, true) + 5 + g.width(ch.w, SMALL) + 14;
    const sw = since ? g.width(since, SMALL) + 12 : 0;
    let shown = chips.slice(0, 5);
    while (shown.length && x0 + ww + shown.reduce((a, ch) => a + cwOf(ch) + 5, 0) + sw > right) shown = shown.slice(0, -1);
    let x = x0;
    const y = 46;
    this.verdictGlyph(g, d.verdict, x + 9, y + 11, col, t);
    g.text(word, x + 24, y + 16.5, col, 15, true);
    f.fx.hit(x - 4, y, ww + 4, 22, 'verdict', d.verdict, d.why || d.verdict);
    x += ww;
    for (const ch of shown) {
      const w = cwOf(ch);
      g.fillRect(x, y + 1, w, 20, '#161618');
      g.begin_(); g.rect(x + 0.5, y + 1.5, w - 1, 19); g.stroke('#2E2E30', 1);
      let cx = x + 7;
      if (ch.arrow) {
        g.begin_();
        if (ch.arrow > 0) { g.move(cx, y + 15); g.line(cx + 4, y + 8); g.line(cx + 8, y + 15); }
        else { g.move(cx, y + 8); g.line(cx + 4, y + 15); g.line(cx + 8, y + 8); }
        g.ctx.closePath(); g.fill(ch.arrowCol);
        cx += 12;
      }
      cx += g.text(ch.n, cx, y + 15, ch.col, SMALL, true) + 5;
      g.text(ch.w, cx, y + 15, C.ink3, SMALL);
      f.fx.hit(x, y + 1, w, 20, 'fresh', ch.key, `${ch.n} ${ch.w} since you looked`);
      x += w + 5;
    }
    if (since && x + sw <= right) g.text(since, x + 5, y + 15, C.ink3, SMALL);
  }

  /** The verdict's glyph: chevrons that flow, slow, bunch or break. */
  private verdictGlyph(g: Gfx, v: Verdict, x: number, y: number, col: string, t: number): void {
    const chev = (cx: number, a = 1) => { g.begin_(); g.move(cx - 2, y - 4); g.line(cx + 2, y); g.line(cx - 2, y + 4); g.stroke(withAlpha(col, a), 1.6); };
    if (v === 'flowing') { const o = beatPhase(t) * 5; for (let i = 0; i < 3; i++) chev(x - 6 + i * 5 + o, i === 0 ? 1 - o / 5 : i === 2 ? 0.4 + o / 8 : 1); }
    else if (v === 'slowed') { chev(x - 6); chev(x + 1); chev(x + 8, 0.35); }
    else if (v === 'jammed') { chev(x - 3); chev(x); chev(x + 3); g.vline(x + 8, y - 6, y + 6, col, 1.6); }
    else {
      g.begin_(); g.move(x - 8, y); g.line(x - 2, y); g.move(x + 3, y); g.line(x + 8, y); g.stroke(col, 1.6);
      g.begin_(); g.move(x - 1, y - 5); g.line(x + 2, y + 5); g.stroke(withAlpha(col, 0.6 + 0.4 * beat(t)), 1.6);
    }
  }

  /** The smoke cluster's words for the lens (scanner hover). */
  smokeWords(): string { const s = this.dg.smoke; return s ? `${clusterStep(s.key)} · ${s.repos.size} repos` : ''; }
}

function serverKey(server: string): string { return server.trim() || 'origin'; }

function parseVisits(s: string): Record<string, Visit> {
  if (!s) return {};
  try {
    const v = JSON.parse(s) as Record<string, Visit>;
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch { return {}; }
}

/** A short stable hash (base 36) of an id: the visit keeps these, not names. */
export function h36(s: string): string {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(36);
}
