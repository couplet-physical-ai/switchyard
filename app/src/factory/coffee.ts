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
import type { World } from '../world.ts';
import { beat, beatPhase, changesSince, clusterStep, clusters, type Changes as SrvChanges, type Cluster } from './seams.ts';

type Changes = {
  newRed: string[]; fixed: string[]; acute: string[]; failed: string[]; deployApps: string[]; deploys: number; deployFails: number;
  merged: string[]; down: string[]; recovered: string[];
};

export type Verdict = 'flowing' | 'slowed' | 'jammed' | 'broken';
type Visit = { at: number; r: string; d: string };
type Digest = Changes & {
  verdict: Verdict; why: string;
  /** the biggest failure cluster of the last hour when it spans ≥ 3 repos (smoke), else null */
  smoke: Cluster | null; smokeQueue: number; smokeDeploy: number;
  beacons: { di: number; down: boolean }[]; jam: number;
  /** counts from the seam when they reach further than the world's own lists (-1: the lists') */
  failCount: number; mergedCount: number;
};

const GLOW_MAX = 48;
const FRESH_MS = 120_000;
const OK = '#7FC48F';
const SMALL = 12;
const HOUR = 3_600_000;

function emptyDigest(): Digest {
  return {
    newRed: [], fixed: [], acute: [], failed: [], deployApps: [], deploys: 0, deployFails: 0, merged: [], down: [], recovered: [],
    verdict: 'flowing', why: '', smoke: null, smokeQueue: 0, smokeDeploy: 0, beacons: [], jam: 0, failCount: -1, mergedCount: -1,
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
  private dgN = 0;
  /** Fresh thing → the module clock when it was first drawn (its pulse fades from then). */
  private seen = new Map<string, number>();
  /** The queue's length every 15 s of the world, the last 5 minutes (a growing queue jams). */
  private qlen: number[] = [];
  private qAt = 0;
  /** The seam's answer for `since` (the server's /changes on v0.5 and the demo, approximated on
   *  0.4): re-asked every 30 s of looking. */
  private srv: SrvChanges | null = null;
  private srvFor = 0;
  private srvAt = -1e12;
  private srvBusy = false;

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
      this.srv = null; this.srvAt = -1e12;
      this.dgVer = -1; this.dgAt = -1e12; this.job = null;
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
    if (d.failed.length || d.failCount > 0) parts.push(`${Math.max(d.failed.length, d.failCount)} failed`);
    if (d.down.length) parts.push(`${d.down.length} down`);
    if (d.deploys) parts.push(`${d.deploys} deploys`);
    if (d.merged.length || d.mergedCount > 0) parts.push(`${Math.max(d.merged.length, d.mergedCount)} merged`);
    parts.push(this.sinceWords());
    return parts.join(' · ');
  }

  private sinceWords(): string {
    if (this.first) return 'first look, last 24 h';
    if (this.srv && !this.srv.complete) return 'since over 24 h ago';
    return `since ${ago(this.f.tl.liveNow() - this.since)} ago`;
  }

  /** Asks the seam what changed since the visit (async; the digest blends it in when it lands). */
  private ask(t: number): void {
    if (this.srvBusy || !this.since || (this.srvFor === this.since && t - this.srvAt < 30_000)) return;
    this.srvBusy = true;
    this.srvAt = t;
    const since = this.since;
    changesSince(since).then((c) => { if (since === this.since) { this.srv = c; this.srvFor = since; this.dgAt = -1e12; this.job = null; } })
      .catch(() => {}).finally(() => { this.srvBusy = false; });
  }

  // ---- the digest --------------------------------------------------------------------------------
  /** Advances the digest one slice a turn (≈ 0.3 ms each: the world's entities in three passes,
   *  then the clusters and the verdict); a new digest starts at most every 2 s while the world
   *  changes, every 10 s while it stands still. */
  private update(t: number): void {
    const f = this.f, w = f.world;
    if (!w.loaded || t === this.stepT) return;
    this.stepT = t;
    if (!this.job) {
      if (t - this.dgAt < 2000 || (w.ver === this.dgVer && t - this.dgAt < 10_000)) return;
      this.dgVer = w.ver; this.dgAt = t;
      if (f.tl.mode === 'live') this.ask(t);
      this.job = this.digest(w, f.tl.playhead);
    }
    const r = this.job.next();
    if (r.done) { this.job = null; if (r.value) { this.dg = r.value; this.dgN++; } }
  }

  private job: Generator<void, Digest | null, void> | null = null;
  private stepT = -1;

  private *digest(w: World, now: number): Generator<void, Digest | null, void> {
    const f = this.f, c = f.census;
    if (!this.since) this.since = now - 24 * HOUR;
    const lc = yield* localChanges(w, this.since, now, this.baseRed, this.baseDown);
    if (w !== f.world) return null;
    const d: Digest = { ...emptyDigest(), ...lc };
    // the seam's answer: red/recovered/apps from it unless the visit's own baseline says (exact on
    // any server); counts from it (it reaches past the pipelines the world holds)
    const sv = this.srv && this.srvFor === this.since && f.tl.mode === 'live' ? this.srv : null;
    if (sv) {
      if (!this.baseRed) {
        d.newRed = [...new Set(sv.red.map((r) => r.repo))].filter((r) => isRed(w.repos.get(r)));
        d.fixed = [...new Set(sv.recovered.map((r) => r.repo))].filter((r) => !isRed(w.repos.get(r)));
      }
      if (!this.baseDown) {
        const last = new Map<string, string>();
        for (const a of sv.apps) last.set(a.app, a.to);
        d.down = [...last].filter(([, to]) => to === 'down' || to === 'degraded').map(([a]) => a);
        d.recovered = [...last].filter(([, to]) => to === 'up').map(([a]) => a);
      }
      d.failCount = Math.max(d.failed.length, sv.counts.failed);
      d.deploys = Math.max(d.deploys, sv.counts.deploys);
      d.deployFails = Math.max(d.deployFails, sv.counts.deploys_failed);
      d.mergedCount = Math.max(d.merged.length, sv.counts.prs_merged);
    }
    let downNow = 0;
    const downApps = new Set<string>();
    for (const a of w.apps.values()) {
      const id = a.id ?? '';
      if (a.health === 'down') { downNow++; downApps.add(id); }
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
    yield;
    if (w !== f.world) return null;
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
    return d;
  }


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
    // perf: the cars move only when the census recounts (≤ 1/s); one Map set per recount, not per frame
    if (this.spotsAt === c.at && this.spots) return this.spots;
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
    this.spotsAt = c.at; this.spots = { carAt, repoAt, culpritAt };
    return this.spots;
  }
  private spotsAt = -1;
  private spots: { carAt: Map<string, [number, number]>; repoAt: Map<string, [number, number]>; culpritAt: Map<string, [number, number]> } | null = null;
  /** perf: the fresh items' screen spots, rebuilt only when the census, the digest or the camera moved. */
  private glowKey = '';
  private glowItems: [string, number, number, number, string][] = [];
  private glowSeenFor = '';
  private glowSeen: number[] = [];
  private glowCols: string[] = [];
  private glowColOf: number[] = [];
  private glowBuckets: number[][] = [];

  /** Fresh things pulse where they are, on the shared beat, fading over ~2 min once seen. */
  private freshGlows(g: Gfx, t: number): void {
    const f = this.f, P = f.plan, cam = f.cam, fx = f.fx, d = this.dg;
    const gk = `${f.census.at}|${cam.ver}|${this.dgN}|${f.lens.parked.length}|${f.lens.parkedKey}`;
    if (gk !== this.glowKey) {
    this.glowKey = gk;
    const { carAt, repoAt, culpritAt } = this.carSpots();
    const items: [string, number, number, number, string][] = (this.glowItems = []); // key, x, y, r, colour
    const add = (key: string, u: number, v: number, z: number, r: number, col: string) => items.push([key, cam.x(u, v), cam.y(u, v, z), r, col]);
    for (const id of d.newRed) { const at = culpritAt.get(id) ?? repoAt.get(id); if (at) add(`red:${id}`, at[0], at[1], 5, 6, C.red); }
    const parked = new Map(f.lens.parked.map((x) => [x.id, x.u]));
    for (const id of d.failed) { const u = parked.get(id); if (u !== undefined) add(`fail:${id}`, u, P.RETURN_V, 8, 6, C.red); }
    for (const id of d.fixed) { const at = repoAt.get(id); if (at) add(`fix:${id}`, at[0], at[1], 5, 6, OK); }
    const down = new Set(d.down), rec = new Set(d.recovered);
    for (const id of new Set([...d.deployApps, ...d.down, ...d.recovered])) {
      const b = fx.blockAt.get(id);
      if (!b) continue;
      add(`app:${id}`, b.u + b.d / 2, b.v + b.d / 2, b.h + 1.5, 4, down.has(id) ? C.red : rec.has(id) ? OK : '#9FB8A6');
    }
    for (const k of d.merged) { const at = carAt.get(k); if (at) add(`mrg:${k}`, at[0], at[1], 5, 5, C.ink2); }
    // perf + calm: at most GLOW_MAX pulse, most important first (new reds, failures, fixes, apps, merges)
    if (items.length > GLOW_MAX) items.length = GLOW_MAX;
    }
    const items = this.glowItems;
    if (!items.length) return;
    // perf: each item's first-seen time resolved once per rebuild; per frame only numbers, no
    // strings or Maps. Expired items drop out of the list for good.
    if (this.glowSeenFor !== this.glowKey) {
      this.glowSeenFor = this.glowKey;
      this.glowSeen = items.map(([key]) => { let s0 = this.seen.get(key); if (s0 === undefined) { s0 = t; this.seen.set(key, s0); } return s0; });
      this.glowCols = [...new Set(items.map((it) => it[4]))];
      this.glowColOf = items.map((it) => this.glowCols.indexOf(it[4]));
      if (this.seen.size > 4000) this.seen.clear();
    }
    const b = beat(t), ph = beatPhase(t);
    const nc = this.glowCols.length;
    const buckets: number[][] = this.glowBuckets;
    for (let i = 0; i < nc * 4; i++) { if (buckets[i]) buckets[i].length = 0; else buckets[i] = []; }
    let live = 0;
    for (let i = 0; i < items.length; i++) {
      const a = 1 - (t - this.glowSeen[i]) / FRESH_MS;
      if (a <= 0) continue;
      live++;
      const it = items[i];
      buckets[this.glowColOf[i] * 4 + Math.min(3, Math.ceil(a * 4) - 1)].push(it[1], it[2], it[3]);
    }
    if (!live) { this.glowItems = []; return; }
    for (let ci = 0; ci < nc; ci++) for (let qi = 0; qi < 4; qi++) {
      const xy = buckets[ci * 4 + qi];
      if (!xy.length) continue;
      const col = this.glowCols[ci], q = (qi + 1) / 4;
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
    // smoke: one signature failing ≥ 3 repos this hour, over the scanner, wisps over each dock;
    // its hotspot callout (≤ 1 here) when no lens tells another story
    if (d.smoke) {
      const k = clamp(0.45 + d.smoke.repos.size / 10, 0.45, 1);
      const sx = cam.x(P.SCAN_U, 320), sy = cam.y(P.SCAN_U, 320, 56);
      smoke(sx, sy, k, true);
      if (!f.lens.topLens) {
        const s1 = clusterStep(d.smoke.key), s2 = ` · ${d.smoke.repos.size} repos`;
        const wv = g.width(s1, SMALL, true) + g.width(s2, SMALL);
        const at = fx.placeAt(Math.round(sx + 26 * sz), Math.round(sy - 70 * sz), wv, 14, 4, true);
        if (at) { g.fillRect(at[0] - 4, at[1] - 12, wv + 8, 16, withAlpha('#111112', 0.9)); g.runs([[s1, C.redText, true], [s2, C.ink2]], at[0], at[1], SMALL); }
      }
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
    // cracks: a bay running over 3× its expected time (§E)
    const now = f.tl.playhead;
    g.begin_();
    let cracked = 0;
    for (const bay of fx.bays) {
      const p = bay.pid ? w.pipelines.get(bay.pid) : undefined;
      const exp = p?.expected_ms ?? 0;
      if (!p?.started || exp <= 0 || now - p.started < 3 * exp) continue;
      cracked++;
      const z = P.ENG_H + 0.5, u0 = bay.u + bay.du * 0.15, v0 = bay.v + bay.dv * 0.2;
      const pts = [[0, 0], [0.22, 0.18], [0.3, 0.42], [0.52, 0.5], [0.6, 0.78], [0.78, 0.86]];
      pts.forEach(([a, b2], i) => { const x = cam.x(u0 + a * bay.du * 0.8, v0 + b2 * bay.dv * 0.7), y = cam.y(u0 + a * bay.du * 0.8, v0 + b2 * bay.dv * 0.7, z); if (i) g.line(x, y); else g.move(x, y); });
      const bx = cam.x(u0 + 0.3 * bay.du * 0.8, v0 + 0.42 * bay.dv * 0.7), by = cam.y(u0 + 0.3 * bay.du * 0.8, v0 + 0.42 * bay.dv * 0.7, z);
      g.move(bx, by); g.line(bx + 6 * sz, by - 3 * sz);
    }
    if (cracked) g.stroke(withAlpha('#E8E8EA', 0.85), 1.1);
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
      const nf = d.failCount >= 0 ? d.failCount : d.failed.length, nm = d.mergedCount >= 0 ? d.mergedCount : d.merged.length;
      if (nf) chips.push({ key: 'failed', arrow: 0, n: `${nf}`, w: 'failed', col: C.redText, arrowCol: C.red });
      if (d.deploys) chips.push({ key: 'deploys', arrow: 0, n: `${d.deploys}`, w: 'deploys', col: C.ink2, arrowCol: C.ink2 });
      if (nm) chips.push({ key: 'merged', arrow: 0, n: `${nm}`, w: 'merged', col: C.ink2, arrowCol: C.ink2 });
    }
    const since = replay ? '' : this.first ? 'last 24 h' : this.sinceWords();
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

/** What changed in (since, now] from the world: red/green main lines against the visit's baseline
 *  (or, a first look, `main.since` and the recent dots), the failures, deploys and merges the
 *  world holds, app health. The ids say WHERE (the glows); the seam's counts reach further. */
function* localChanges(w: World, since: number, now: number, baseRed: Set<string> | null, baseDown: Set<string> | null): Generator<void, Changes, void> {
  const d: Changes = { newRed: [], fixed: [], acute: [], failed: [], deployApps: [], deploys: 0, deployFails: 0, merged: [], down: [], recovered: [] };
  for (const r of w.repos.values()) {
    const red = isRed(r);
    if (red && (r.main?.since ?? 0) >= now - HOUR) d.acute.push(r.id);
    if (baseRed) {
      const was = baseRed.has(h36(r.id));
      if (red && !was) d.newRed.push(r.id); else if (!red && was) d.fixed.push(r.id);
    } else if (red) { if ((r.main?.since ?? 0) >= since) d.newRed.push(r.id); }
    else for (const dot of r.main?.recent ?? []) if (dot.at >= since && (dot.state === 'failure' || dot.state === 'error')) { d.fixed.push(r.id); break; }
  }
  for (const p of w.pipelines.values()) if ((p.state === 'failure' || p.state === 'error') && p.finished && p.finished > since && p.finished <= now) d.failed.push(p.id ?? '');
  yield;
  const apps = new Set<string>();
  for (const dp of w.deploys.values()) {
    if (dp.started <= since || dp.started > now) continue;
    d.deploys++;
    if (dp.state === 'failure') d.deployFails++;
    apps.add(dp.app);
  }
  d.deployApps = [...apps];
  for (const p of w.prs.values()) if (p.merged_at && p.merged_at > since && p.merged_at <= now) d.merged.push(`${p.repo}@${p.merge_sha ?? ''}`);
  yield;
  for (const a of w.apps.values()) {
    const id = a.id ?? '';
    const bad = a.health === 'down' || a.health === 'degraded';
    if (baseDown) {
      const was = baseDown.has(h36(id));
      if (bad && !was) d.down.push(id); else if (!bad && was && a.health === 'up') d.recovered.push(id);
    } else if (bad) d.down.push(id);
  }
  return d;
}
