// What the factory floor shows, counted from the world (one copy of the fleet, Timeline.world).
// Recounted at most once a second of the module clock and only when the world changed: every
// count here is O(entities), the draws read the result.

import type { App, Pipeline, Pr } from '../wire.ts';
import type { World } from '../world.ts';
import { BOTS } from '../world.ts';
import { ORG_ORDER, buildingIds, isRed, queueTruth } from '../yard/select.ts';
import { hash, unit } from '../yard/stress.ts';

export const HOUR = 3_600_000;
export const PHASES = ['draft', 'checks', 'review', 'approved'] as const;
export const AGES = [HOUR, 24 * HOUR, 3 * 24 * HOUR, 7 * 24 * HOUR, 30 * 24 * HOUR, Infinity];
export const AGE_WORDS = ['< 1 h', '< 1 d', '< 3 d', '< 1 wk', '< 30 d', '30 d +'];

export type Stack = { n: number; stuck: number; red: number; oldest: number; ids: string[] };
export type Pallet = { bot: string; n: number; stuck: number };
export type Car = { sha: string; repo: string; at: number; state: string; title: string; culprit: boolean; deployed: boolean };
export type Rail = { org: string; short: string; cars: Car[]; merges1h: number; red: number; repos: number };
export type Dock = { org: string; short: string; perHour: number; repos: number };
export type Group = {
  id: string; name: string; platform: string; slots: number; running: string[]; engines: string[];
  cpu: number; mem: number; load: number; online: boolean; hosted: boolean;
};
export type District = { team: string; apps: string[] };
export type Flow = { pushes: number; merges: number; enqueued: number; started: number; finished: number; failed: number; deploys: number; byVia: Record<string, number> };

export const SHORT: Record<string, string> = {
  'Northwind-Labs': 'labs', 'Northwind-EMS': 'ems', 'Northwind-Forge': 'forge', 'couplet-physical-ai': 'couplet', 'copper-browser': 'copper', [BOTS]: 'bots',
};
export const short = (org: string) => SHORT[org] ?? org.toLowerCase().slice(0, 10);

export class Census {
  ver = -1;
  at = -1e12;
  now = 0;
  docks: Dock[] = [];
  stacks: Stack[][] = PHASES.map(() => AGES.map(() => ({ n: 0, stuck: 0, red: 0, oldest: 0, ids: [] })));
  phaseN = [0, 0, 0, 0];
  pallets: Pallet[] = [];
  botN = 0;
  rails: Rail[] = [];
  groups: Group[] = [];
  rr: string[] = [];
  gha: string[] = [];
  waiting = 0;
  oldestWait = 0;
  districts: District[] = [];
  deploys24 = new Map<string, number>();
  flow: Flow = { pushes: 0, merges: 0, enqueued: 0, started: 0, finished: 0, failed: 0, deploys: 0, byVia: {} };
  /** Per-stage backlog growth over the last 15 min (in − out), the bottleneck's heat. */
  heat: Record<string, number> = {};
  bottleneck = '';
  redLines = 0;
  building = 0;
  deploying: { app: string; via: number; started: number; sha: string }[] = [];
  /** The focal story: the newest commit that broke a main line (last 24 h). */
  focal: { repo: string; sha: string; at: number; author: string; title: string } | null = null;
  redNames: string[] = [];
  failing: { id: string; repo: string; at: number; step: string }[] = [];
  /** Event density over the last 24 h, 288 five-minute buckets: activity, failures. */
  dens = new Float32Array(288);
  densRed = new Float32Array(288);
  /** A shape signature: when it changes the static floor redraws. */
  sig = '';
  /** The apps' health, as the static floor paints it (counts and which ones are not up). */
  healthSig = '';
  /** The main lines' cars and the engines' gauges, as the static floor paints them. */
  carSig = '';
  /** Stress mode: every count × FACTOR, engines with ten times the slots, a city ten times as
   *  big (virtual app ids `<id>~<k>`; nothing here is an entity). */
  factor = 1;
  /** No fleet yet (connecting, offline, setup): an idle floor of the usual shape. */
  skeleton = false;

  /** The count runs in two turns (sources/PRs/main lines, then queues/engines/apps/flow), so
   *  no single turn walks the whole world. */
  private half = 0;
  private carry: { opened15: number; merged15: number; merges: number } = { opened15: 0, merged15: 0, merges: 0 };

  /** Recount at the next draw (stress toggled, a reset). */
  invalidate(): void { this.ver = -1; this.at = -1e12; this.half = 0; }

  update(w: World, now: number, t: number): boolean {
    if (!w.loaded) {
      if (this.skeleton) return false;
      this.idle();
      return true;
    }
    if (this.half === 1) { this.half = 0; this.countB(w, this.now); this.stretch(); return true; }
    if (w.ver === this.ver && t - this.at < 5000 && !this.skeleton) return false;
    if (t - this.at < 250 && this.ver >= 0 && !this.skeleton) return false;
    this.skeleton = false;
    this.ver = w.ver; this.at = t; this.now = now;
    this.countA(w, now);
    this.half = 1;
    return true;
  }

  /** The idle floor: every stage in its usual shape, nothing on it (no fleet loaded). */
  private idle(): void {
    this.skeleton = true;
    this.ver = -1;
    this.docks = [...ORG_ORDER, BOTS].map((o) => ({ org: o, short: short(o), perHour: 0, repos: 0 }));
    for (const row of this.stacks) for (const s of row) { s.n = 0; s.stuck = 0; s.red = 0; s.oldest = 0; s.ids.length = 0; }
    this.phaseN = [0, 0, 0, 0];
    this.pallets = [];
    this.botN = 0;
    this.rails = ORG_ORDER.map((o) => ({ org: o, short: short(o), cars: [], merges1h: 0, red: 0, repos: 0 }));
    const machine = (id: string, slots: number, hosted: boolean): Group => ({ id, name: '', platform: '', slots, running: [], engines: [], cpu: -1, mem: -1, load: -1, online: false, hosted });
    this.groups = [machine('a', 6, false), machine('b', 6, false), machine('gha', 6, true)];
    this.rr = []; this.gha = []; this.waiting = 0; this.oldestWait = 0;
    const n = [48, 36, 24, 16, 12, 10];
    this.districts = n.map((k, d) => ({ team: '', apps: Array.from({ length: k }, (_, i) => `~idle${d}.${i}`) }));
    this.deploys24.clear();
    this.flow = { pushes: 0, merges: 0, enqueued: 0, started: 0, finished: 0, failed: 0, deploys: 0, byVia: {} };
    this.heat = {}; this.bottleneck = ''; this.redLines = 0; this.building = 0; this.deploying = [];
    this.focal = null; this.redNames = []; this.failing = [];
    this.dens.fill(0); this.densRed.fill(0);
    this.sig = 'idle';
    this.healthSig = 'idle';
    this.carSig = 'idle';
  }

  /** Stress mode: the counts the floor shows, × factor (after a real count; never entities). */
  private stretch(): void {
    const F = this.factor;
    if (F <= 1) return;
    for (const d of this.docks) d.perHour *= F;
    for (const row of this.stacks) for (const s of row) { s.n *= F; s.stuck *= F; s.red *= F; }
    this.phaseN = this.phaseN.map((n) => n * F);
    for (const p of this.pallets) { p.n *= F; p.stuck *= F; }
    this.botN *= F;
    // main lines: every rail as full as it gets (18 cars), the real cars newest
    for (const r of this.rails) {
      r.merges1h *= F; r.red *= F;
      const real = r.cars.length;
      const fake: Car[] = [];
      for (let k = 0; fake.length + real < 18; k++) {
        const u = unit(k, r.org.length * 7 + 3);
        fake.push({ sha: `~${k}`, repo: r.cars[0]?.repo ?? r.org, at: 0, state: u < 0.06 ? 'failure' : u < 0.2 ? 'running' : 'success', title: '', culprit: u < 0.06, deployed: false });
      }
      r.cars = [...fake, ...r.cars];
    }
    this.redLines *= F;
    this.building *= F;
    // engines: ten times the slots (their busy bays are hashed per frame, stress.ts)
    for (const g of this.groups) g.slots *= F;
    // the queue: ten times as long (the line shows its first crates and a count)
    this.waiting *= F;
    // the city: nine copies of every app beside it, in its district
    let vi = 0;
    for (const d of this.districts) {
      const real = d.apps.length;
      for (let k = 1; k < F; k++) {
        for (let i = 0; i < real; i++) {
          const id = `${d.apps[i]}~${k}`;
          d.apps.push(id);
          const n = hash(vi++, 17) % 7;
          if (n > 2) this.deploys24.set(id, n - 2);
        }
      }
    }
    const dep = this.deploying.length;
    for (let k = 0; this.deploying.length < Math.min(36, dep * F + 12); k++) this.deploying.push({ app: '', via: k % 3, started: this.now - (k % 9) * 9000, sha: `~${k}` });
    const f = this.flow;
    f.pushes *= F; f.merges *= F; f.enqueued *= F; f.started *= F; f.finished *= F; f.failed *= F; f.deploys *= F;
    for (const k in f.byVia) f.byVia[k] *= F;
    for (let i = 0; i < 288; i++) { this.dens[i] *= F; this.densRed[i] *= F; }
    this.sig += `|x${F}`;
  }

  private countA(w: World, now: number): void {
    // sources
    const orgs = [...ORG_ORDER.filter((o) => w.orgs.has(o)), ...[...w.orgs.keys()].filter((o) => !ORG_ORDER.includes(o))].slice(0, 5);
    const repoN = new Map<string, number>();
    for (const r of w.repos.values()) repoN.set(r.org, (repoN.get(r.org) ?? 0) + 1);
    this.docks = [...orgs, BOTS].map((o) => {
      const list = w.pushes.get(o) ?? [];
      let n = 0;
      for (let i = list.length - 1; i >= 0 && list[i] >= now - HOUR; i--) if (list[i] <= now) n++;
      return { org: o, short: short(o), perHour: n, repos: repoN.get(o) ?? 0 };
    });
    // PR yard
    for (const row of this.stacks) for (const s of row) { s.n = 0; s.stuck = 0; s.red = 0; s.oldest = 0; s.ids.length = 0; }
    this.phaseN = [0, 0, 0, 0];
    const bots = new Map<string, Pallet>();
    this.botN = 0;
    let opened15 = 0, merged15 = 0;
    const merges1h = new Map<string, number>();
    for (const p of w.prs.values()) {
      if (p.merged_at && p.merged_at >= now - HOUR && p.merged_at <= now) {
        const o = w.orgOf(p.repo);
        merges1h.set(o, (merges1h.get(o) ?? 0) + 1);
      }
      if (p.merged_at && p.merged_at >= now - 15 * 60_000) merged15++;
      if (p.created >= now - 15 * 60_000) opened15++;
      const row = phaseRow(p);
      if (row < 0) continue;
      const stuck = !!p.stale_ms;
      if (p.bot || /bot|dependabot|renovate|autofix/i.test(p.author)) {
        const name = botName(p.author);
        let pl = bots.get(name);
        if (!pl) { pl = { bot: name, n: 0, stuck: 0 }; bots.set(name, pl); }
        pl.n++; if (stuck) pl.stuck++;
        this.botN++;
        continue;
      }
      const age = Math.max(0, now - p.created);
      let b = 0;
      while (age >= AGES[b]) b++;
      const s = this.stacks[row][b];
      s.n++;
      if (stuck) s.stuck++;
      if (p.phase === 'conflict' || p.phase === 'changes_requested' || p.ci === 'failure') s.red++;
      if (s.ids.length < 24) s.ids.push(p.id ?? `${p.repo}#${p.number}`);
      s.oldest = Math.max(s.oldest, age);
      this.phaseN[row]++;
    }
    this.pallets = [...bots.values()].sort((a, b) => b.n - a.n).slice(0, 4);
    // main lines: one rail per org, its newest merged commits as cars
    const cars = new Map<string, Car[]>();
    let red = 0;
    const redNames: string[] = [];
    const redBy = new Map<string, number>();
    for (const r of w.repos.values()) {
      if (isRed(r)) { red++; redBy.set(r.org, (redBy.get(r.org) ?? 0) + 1); if (redNames.length < 3 && now - (r.main.since || 0) < 24 * HOUR) redNames.push(r.name); }
      const list = cars.get(r.org) ?? [];
      for (const d of r.main?.recent ?? []) if (d.at >= now - 24 * HOUR && d.at <= now) list.push({ sha: d.sha, repo: r.id, at: d.at, state: d.state, title: d.title, culprit: !!d.culprit, deployed: !!d.deployed });
      cars.set(r.org, list);
    }
    this.redLines = red;
    this.focal = null;
    for (const r of w.repos.values()) {
      if (!isRed(r)) continue;
      for (const d of r.main?.recent ?? []) if (d.culprit && d.at <= now && (!this.focal || d.at > this.focal.at)) this.focal = { repo: r.id, sha: d.sha, at: d.at, author: d.author, title: d.title };
    }
    this.redNames = redNames;
    this.rails = orgs.map((o) => {
      const list = (cars.get(o) ?? []).sort((a, b) => a.at - b.at);
      return { org: o, short: short(o), cars: list.slice(-18), merges1h: merges1h.get(o) ?? 0, red: redBy.get(o) ?? 0, repos: repoN.get(o) ?? 0 };
    });
    let mergesAll = 0;
    for (const n of merges1h.values()) mergesAll += n;
    this.carry = { opened15, merged15, merges: mergesAll };
  }

  private countB(w: World, now: number): void {
    const { opened15, merged15 } = this.carry;
    // intake
    const qt = queueTruth(w);
    this.rr = qt.rr.map((p) => p.id ?? '');
    this.gha = qt.gha.map((p) => p.id ?? '');
    this.waiting = qt.waiting;
    this.oldestWait = qt.oldestAt ? Math.max(0, now - qt.oldestAt) : 0;
    // engines: one machine per host, its agents' slots as bays
    const building = buildingIds(w);
    this.building = building.size;
    const hosts = new Map<string, Group>();
    const placed = new Set<string>();
    for (const e of w.engines.values()) {
      const host = e.host ?? e.label ?? e.id;
      let g = hosts.get(host);
      if (!g) { g = { id: host, name: host, platform: e.platform ?? '', slots: 0, running: [], engines: [], cpu: -1, mem: -1, load: -1, online: false, hosted: false }; hosts.set(host, g); }
      if (e.cpu !== undefined) g.cpu = Math.max(g.cpu, e.cpu);
      if (e.mem !== undefined) g.mem = Math.max(g.mem, e.mem);
      if (e.load !== undefined) g.load = Math.max(g.load, e.load);
      if (e.kind === 'dagger') continue; // the host's gauges; its slots are its agents'
      g.engines.push(e.id);
      g.slots += e.slots;
      if (e.online !== false) g.online = true;
      if (!g.platform && e.platform) g.platform = e.platform;
      // one crate is one pipeline: a pipeline on two agents takes one bay (the counts agree)
      for (const id of e.running) if (building.has(id) && !placed.has(id)) { placed.add(id); g.running.push(id); }
    }
    const groups = [...hosts.values()].filter((g) => g.slots > 0).sort((a, b) => a.name.localeCompare(b.name, 'en', { numeric: true })).slice(0, 3);
    const hosted: Group = { id: 'gha', name: 'GitHub Actions', platform: 'hosted runners', slots: 0, running: [], engines: [], cpu: -1, mem: -1, load: -1, online: true, hosted: true };
    for (const id of building) { const p = w.pipelines.get(id); if (p?.lane === 'gha') hosted.running.push(id); }
    hosted.slots = Math.max(6, hosted.running.length);
    groups.push(hosted);
    this.groups = groups;
    // apps: districts by team (tiny teams share one); their health as the floor paints it
    const teams = new Map<string, string[]>();
    let hUp = 0, hDeg = 0, hDown = 0, hSum = 0;
    for (const a of w.apps.values()) {
      const t = teamOf(a);
      const l = teams.get(t) ?? [];
      l.push(a.id ?? '');
      teams.set(t, l);
      if (a.health === 'up') hUp++;
      else {
        const code = a.health === 'down' ? 3 : a.health === 'degraded' ? 2 : 1;
        if (code === 3) hDown++; else if (code === 2) hDeg++;
        hSum = (hSum + Math.imul(strHash(a.id ?? ''), code)) | 0;
      }
    }
    this.healthSig = `${hUp}.${hDeg}.${hDown}.${hSum}`;
    const big: District[] = [], small: string[] = [];
    for (const [team, apps] of teams) { if (apps.length >= 5 && team !== 'other') big.push({ team, apps }); else small.push(...apps); }
    big.sort((a, b) => b.apps.length - a.apps.length);
    if (small.length) big.push({ team: 'other teams', apps: small });
    for (const d of big) d.apps.sort();
    this.districts = big;
    // flow, last hour
    const f: Flow = { pushes: 0, merges: 0, enqueued: 0, started: 0, finished: 0, failed: 0, deploys: 0, byVia: { roadrunner: 0, gha: 0, gha_fallback: 0 } };
    for (const d of this.docks) f.pushes += d.perHour;
    f.merges = this.carry.merges;
    let enq15 = 0, st15 = 0, fin15 = 0;
    this.failing = [];
    this.dens.fill(0); this.densRed.fill(0);
    const bucket = (at: number) => { const k = Math.floor((at - (now - 24 * HOUR)) / 300_000); return k >= 0 && k < 288 ? k : -1; };
    for (const p of w.pipelines.values()) {
      if (p.created >= now - HOUR && p.created <= now) f.enqueued++;
      if (p.started && p.started >= now - HOUR && p.started <= now) f.started++;
      if (p.finished && p.finished >= now - HOUR && p.finished <= now) {
        f.finished++;
        if (p.state === 'failure' || p.state === 'error') {
          f.failed++;
          this.failing.push({ id: p.id ?? '', repo: p.repo, at: p.finished, step: failingStep(p) });
        }
      }
      if (p.created >= now - 15 * 60_000) enq15++;
      if (p.started && p.started >= now - 15 * 60_000) st15++;
      if (p.finished && p.finished >= now - 15 * 60_000) fin15++;
      if (p.finished) { const k = bucket(p.finished); if (k >= 0) { this.dens[k]++; if (p.state === 'failure' || p.state === 'error') this.densRed[k]++; } }
    }
    for (const c of w.commits.values()) { const k = bucket(c.at); if (k >= 0) this.dens[k] += 0.5; }
    this.failing.sort((a, b) => b.at - a.at);
    this.deploys24.clear();
    let dep15 = 0, depDone15 = 0;
    this.deploying = [];
    for (const d of w.deploys.values()) {
      if ((d.state === 'running' || d.state === 'pending') && d.started <= now && this.deploying.length < 12) this.deploying.push({ app: d.app, via: d.via === 'gha' ? 1 : d.via === 'roadrunner' ? 0 : 2, started: d.started, sha: d.sha });
      if (d.started >= now - 24 * HOUR) this.deploys24.set(d.app, (this.deploys24.get(d.app) ?? 0) + 1);
      if (d.started >= now - HOUR && d.started <= now) { f.deploys++; f.byVia[d.via === 'manual' ? 'gha_fallback' : d.via] = (f.byVia[d.via === 'manual' ? 'gha_fallback' : d.via] ?? 0) + 1; }
      if (d.started >= now - 15 * 60_000) dep15++;
      if (d.finished && d.finished >= now - 15 * 60_000) depDone15++;
    }
    this.flow = f;
    // the bottleneck: the stage whose backlog grows (in − out over 15 min), weighted by what waits
    const slots = groups.reduce((a, g) => a + (g.hosted ? 0 : g.slots), 0);
    const busy = groups.reduce((a, g) => a + (g.hosted ? 0 : g.running.length), 0);
    this.heat = {
      prs: Math.max(0, opened15 - merged15) / 6,
      intake: Math.max(0, enq15 - st15) / 4 + this.rr.length / 6 + (this.oldestWait > 120_000 ? 0.5 : 0),
      engines: (slots ? busy / slots : 0) >= 0.85 ? 0.6 + this.rr.length / 6 : Math.max(0, st15 - fin15) / 8,
      deploy: Math.max(0, dep15 - depDone15) / 4,
    };
    let best = '', bv = 0.25;
    for (const k in this.heat) if (this.heat[k] > bv) { bv = this.heat[k]; best = k; }
    this.bottleneck = best;
    let cs = 0;
    for (const r of this.rails) for (const car of r.cars) cs = (Math.imul(cs, 31) + strHash(car.sha) + (car.culprit ? 7 : car.state === 'running' || car.state === 'pending' ? 3 : 1)) | 0;
    this.carSig = `${cs}|${groups.map((g) => `${g.cpu < 0 ? -1 : Math.round(g.cpu / 5)}.${g.mem < 0 ? -1 : Math.round(g.mem / 5)}.${g.running.length}`).join(',')}`;
    this.sig = `${this.docks.length}|${this.stacks.map((r) => r.map((s) => Math.min(60, s.n)).join(',')).join(';')}|${this.pallets.map((p) => p.n).join(',')}|${groups.map((g) => `${g.id}:${g.slots}`).join(',')}|${this.districts.map((d) => d.apps.length).join(',')}|${w.apps.size}|${[...this.deploys24.values()].reduce((a, b) => a + b, 0)}`;
  }
}

/** A string's 32-bit hash (FNV-1a). */
export function strHash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return h >>> 0;
}

export function phaseRow(p: Pr): number {
  switch (p.phase) {
    case 'draft': return 0;
    case 'checks': case 'conflict': return 1;
    case 'review': case 'changes_requested': return 2;
    case 'mergeable': return 3;
    default: return p.draft ? 0 : -1;
  }
}

function botName(a: string): string {
  const s = a.toLowerCase();
  if (s.includes('dependabot')) return 'dependabot';
  if (s.includes('renovate')) return 'renovate';
  if (s.includes('autofix')) return 'autofix';
  if (s.includes('woodpecker')) return 'woodpecker';
  return s.replace(/\[bot\]$/, '').replace(/^northwind-/, '');
}

export function teamOf(a: App): string {
  const t = (a.team ?? '').toLowerCase().replace(/-team$/, '');
  if (!t || t === 'unknown') return 'other';
  return t;
}

export function failingStep(p: Pipeline): string {
  for (const wf of p.workflows ?? []) for (const s of wf.steps ?? []) if (s.state === 'failure' || s.state === 'error') return s.name;
  for (const wf of p.workflows ?? []) if (wf.state === 'failure' || wf.state === 'error') return wf.name;
  return 'failed';
}
