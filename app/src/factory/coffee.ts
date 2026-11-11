// THE COFFEE CHECK (fab-w4; FACTORY-SPEC §E): the five minutes a day Felipe sits down with the
// factory. This module runs it; anomaly.ts decides (the window, the fingerprint, the fresh set,
// the marks, the verdict), fx.ts paints the marks, glance.ts draws the header and the replay.
//
//   The first 10 seconds after the floor opens:
//     0–0.3 s   the cached floor paints;
//     0.3–1.5 s the verdict dial's needle swings to where now sits in the week (w2-glance2: the
//               verdict is flowing · steady · worse than usual · broken, NOW against USUAL) and
//               the glyph counters count up (what changed in the window);
//     1.5–7 s   the window replays, compressed (≤ 5.5 s): a playhead sweeps the strip's bracket,
//               and as it passes each thing's time it lands where it happened: failures ride
//               home on the return belt, red main lines ignite their beacons, fixes flash, apps
//               ring; the marks of that moment fade in;
//     7–10 s    it settles: ≤ 3 hotspot callouts where it is broken (the worst cluster, the
//               worst group, the jam).
//   Any input skips the replay; `S` replays it; reduced motion shows the settled floor.
//
//   The window: the "since" chip picks it (since your last visit · 1 h · 24 h · 7 d; `W` cycles
//   it). The glance's numbers, the fresh set (rims) and the marks all follow it, and the time
//   strip brackets it. The server answers /changes up to 7 d back (a persisted ledger) through
//   the v0.5 seam (insights.changesSince); fetched from the `coffee` source, never from a draw.
//
//   The last visit: per server in the persisted `visits` (Contract), a fingerprint (anomaly.ts)
//   marked after 20 s of looking, every minute after, and on leaving the floor. The baseline is
//   latched for the session (the previous visit stays the one `S` replays from).
//
// Cost: the digest runs one slice a turn (≈ 0.3 ms each) and starts at most every 2 s while the
// world changes; screen spots are laid out only when the census, the camera or the digest moved;
// a frame paints from numbers (no Map, no string, no array growth per frame).

import type { Frame } from '../../app.contract.d.ts';
import type { Changes, Cluster } from '../wire.ts';
import type { World } from '../world.ts';
import type { Gfx } from '../yard/gfx.ts';
import { C, clamp } from '../yard/theme.ts';
import { short } from './census.ts';
import type { Factory } from './factory.ts';
import { insights } from '../insights.ts';
import {
  DAY, HOUR, VERDICT_WORD, WINS, age, ago, emptyFresh, fingerprint, freshSince, h36, isRedMain, marks, noMarks, noTotals, packVisit, shortWindow, totals, totalsWords, unpackVisit, windowStart,
  type Fingerprint, type Fresh, type Marks, type QueueState, type Totals, type VisitRec, type Win,
} from './anomaly.ts';
import { floorGroups } from './groups.ts';
import { heapGroups, heapsOf } from './clusters.ts'; // v4-verdict: the concentrated repo's heap group (its one plume)
import { emberPass } from './trendmarks.ts';
import { FACTOR } from './stress.ts';
import { K_AMBER, K_BLACK, K_INK, K_OK, K_RED, Nums, beacons, chevrons, crackAt, cracks, dodge, embers, rings, smoke, tint } from './fx.ts';
import { Glance, T_DONE, T_SETTLE, T_SWEEP } from './glance.ts';
import { beatPhase, changesSince } from './seams.ts';

export { ago, h36 } from './anomaly.ts';
export type { Verdict } from './anomaly.ts';

/** One digest: the window it covers, what changed in it, the marks, the words. */
export type Digest = { win: Win; since: number; now: number; fresh: Fresh; marks: Marks; complete: boolean };

const GLOW_MAX = 48;
const FRESH_MS = 120_000;
/** The one flash of a fixed / recovered / deployed / merged thing (ms). */
const FLASH_MS = 1400;
/** Green-gray: ok, recovered (one flash, never a pulse). */
const OK = '#9DB8A4';
/** The rim on what is new (a main line newly red). */
const RIM = '#F2F2F0';

export class Coffee {
  /** The server whose last visit is latched: the baseline holds for the whole session. */
  private server: string | null = null;
  /** The latched last visit (null: a first look). */
  private fp: Fingerprint | null = null;
  /** The chosen window. */
  win: Win = 'visit';
  /** The window's start in server ms (lens.ts brackets the strip from it). */
  since = 0;
  /** The "since" menu is open. */
  menu = false;
  dg: Digest = { win: 'visit', since: 0, now: 0, fresh: emptyFresh(), marks: noMarks(), complete: true };
  /** Bumps with every finished digest (the layout and the glance re-read on it). */
  dgN = 0;
  private dgAt = -1e12;
  private dgVer = -1;
  private dgWin: Win | '' = '';
  private job: Generator<void, Digest | null, void> | null = null;
  private stepT = -1;
  /** The server's answers: for the window, and 7 d back (how long apps have been down). */
  private srv: Changes | null = null;
  private srvWin: Win | '' = '';
  private srvSince = 0;
  private srvAt = -1e12;
  private srvBusy = false;
  private ages: Changes | null = null;
  private agesAt = -1e12;
  private agesBusy = false;
  /** The queue's length every 15 s of the world, the last 5 minutes (a growing queue jams). */
  private qlen: number[] = [];
  private qAt = 0;
  /** The intro: when the floor opened (module clock; -1 not yet), when it was skipped. */
  openAt = -1;
  skipAt = -1;
  private camAt = -1;
  /** Fresh thing → the module clock when it was first drawn (its pulse fades from then). */
  private seen = new Map<string, number>();
  readonly glance0: Glance;

  constructor(readonly f: Factory) { this.glance0 = new Glance(this); }

  /** lens.ts draws the strip's bracket when this is false. fx-glance: true, the strip draws its
   *  own (strip.ts, a bright since-visit bracket over the butterfly). */
  get first(): boolean { return true; }

  // ---- the totals (fx-glance): ONE count for the status line and the coffee header ------------
  /** The fleet's totals as the status line last asked for them (app.ts overview, every 250 ms),
   *  and when (module clock); the header draws these, never a count of its own. */
  now: Totals = noTotals();
  nowN = 0;
  private nowAt = -1e12;
  private copiesOf: Uint8Array | null = null;
  private copies = { up: 0, down: 0, n: 0 };

  /** The status line's numbers (red main lines, building, queued, apps up and down) for the world
   *  on screen; in stress mode the 10× fleet's own (the floor's census multiplies the same way,
   *  the city's copies carry their hashed health). The coffee header shows the same object. */
  status(w: World, stress: boolean, t: number): Totals {
    const h = this.f.stress.health;
    if (stress && h.length && h !== this.copiesOf) {
      this.copiesOf = h;
      let up = 0, down = 0;
      for (let i = 0; i < h.length; i++) { if (h[i] === 0) up++; else if (h[i] === 2) down++; }
      this.copies = { up, down, n: h.length };
    }
    this.now = totals(w, stress ? FACTOR : 1, stress && h.length ? this.copies : null);
    this.nowN++;
    this.nowAt = t;
    return this.now;
  }

  /** The header's totals in words: what the status line says, the same numbers. */
  headWords(): string { return totalsWords(this.now); }

  /** For a floor no status line asks for (tools, tests): counts when the last count is over 1 s
   *  old (module clock). */
  ensureNow(t: number): void { if (t - this.nowAt > 1000 || t < this.nowAt) this.status(this.f.world, this.f.stress.on, t); }
  /** No last visit kept for this server: the "visit" window is the last 24 h. */
  get noVisit(): boolean { return !this.fp; }
  get visitAt(): number { return this.fp?.at ?? 0; }

  // ---- the last visit (the `coffee` / `coffeeMark` sources) ------------------------------------
  /** Latches this session's baseline for `server` from the persisted visits, asks the server what
   *  changed in the window when due (a source may fetch; a draw never does); the glance in words. */
  open(server: string, visits: string, ok: boolean, t = 0): string {
    if (!ok || !this.f.world.loaded) return '';
    if (this.server !== server) {
      this.server = server;
      const now = this.f.tl.liveNow();
      const fp = unpackVisit(parseVisits(visits)[serverKey(server)]);
      this.fp = fp && fp.at < now ? fp : null;
      this.seen.clear();
      this.srv = null; this.srvAt = -1e12; this.ages = null; this.agesAt = -1e12;
      this.restart();
    }
    this.pump(t);
    return this.words();
  }

  /** The visits with this server's fingerprint now (live only): '' leaves them as they are. */
  mark(server: string, visits: string): string {
    const tl = this.f.tl, w = tl.world;
    if (tl.mode !== 'live' || !w.loaded) return '';
    const all = parseVisits(visits);
    const me = serverKey(server);
    all[me] = packVisit(fingerprint(w, insights().clusters(), tl.liveNow()));
    // the four most recent servers (a persisted state keeps ≤ 16 KB)
    const keys = Object.keys(all).sort((a, b) => all[b].at - all[a].at).slice(0, 4);
    const out: Record<string, VisitRec> = {};
    for (const k of keys) out[k] = all[k];
    let s = JSON.stringify(out);
    if (s.length > 14_000) s = JSON.stringify({ [me]: all[me] });
    return s.length > 14_000 ? JSON.stringify({ [me]: { at: all[me].at, r: '', d: '' } }) : s;
  }

  /** Fetches what changed in the window when due: at once when the window moved, else every 30 s
   *  while looking; and once every 5 min, 7 d back (for how long apps have been down). */
  private pump(t: number): void {
    const tl = this.f.tl;
    if (tl.mode !== 'live') return;
    const now = tl.liveNow(), since = windowStart(this.win, now, this.visitAt);
    const moved = this.srvWin !== this.win || (this.win === 'visit' && this.srvSince !== since);
    if (!this.srvBusy && (moved || t - this.srvAt >= 30_000)) {
      this.srvBusy = true;
      this.srvAt = t;
      const win = this.win;
      changesSince(Math.round(since)).then((c) => {
        if (win !== this.win) return;
        this.srv = c; this.srvWin = win; this.srvSince = since;
        this.dgAt = -1e12; this.job = null;
      }).catch(() => {}).finally(() => { this.srvBusy = false; });
    }
    if (!this.agesBusy && t - this.agesAt >= 300_000 && this.srv) {
      this.agesBusy = true;
      this.agesAt = t;
      if (this.win === '7d') { this.ages = this.srv; this.agesBusy = false; return; }
      changesSince(Math.round(now - 7 * DAY)).then((c) => { this.ages = c; }).catch(() => {}).finally(() => { this.agesBusy = false; });
    }
  }

  /** The verdict in words (w2-glance2): now against usual, and the one fact that decided it:
   *  "worse than usual · pass 69% (usual 76%)", "steady · 40 red (usual 36)", "broken · x down 3m". */
  verdictWords(): string {
    const m = this.dg.marks;
    return m.fact ? `${VERDICT_WORD[m.verdict]} · ${m.fact}` : VERDICT_WORD[m.verdict];
  }

  /** The focal car's words (labels.ts, w2-glance2 #6): "x broke main · 12m" only while its main
   *  line has been red under an hour, else "x · red 7h" (it is not news). */
  focalParts(repo: string, name: string): [string, string, boolean?][] {
    const r = this.f.world.repos.get(repo), now = this.f.tl.playhead, s = r?.main?.since ?? 0;
    if (!(s > 0) || s > now) return [[`${name} broke main`, C.redText, true]];
    if (now - s < HOUR) return [[`${name} broke main`, C.redText, true], [` · ${age(now - s)}`, C.ink2]];
    return [[name, C.redText, true], [` · red ${age(now - s)}`, C.ink2]];
  }

  /** A lane dock's hover title tail (lens.ts, w2-glance2 #10): the group's metric that glows,
   *  " · pass 40% (usual 49%)", '' when none does. */
  emberWord(lane: string): string { return this.emberWords.get(lane) ?? ''; }
  private emberWords = new Map<string, string>();

  /** The glance in words (the floor's accessible mirror, and tests). */
  words(): string {
    const d = this.dg, m = d.marks, fr = d.fresh;
    const v = this.verdictWords();
    const parts: string[] = [v];
    if (fr.newRed.length) parts.push(`${fr.newRed.length} newly red`);
    if (fr.fixed.length) parts.push(`${fr.fixed.length} fixed`);
    const nf = Math.max(fr.failed.length, fr.failCount);
    if (nf > 0) parts.push(`${nf} failed`);
    if (fr.down.length) parts.push(`${fr.down.length} down`);
    if (fr.deploys) parts.push(`${fr.deploys} deploys`);
    const nm = Math.max(fr.merged.length, fr.mergedCount);
    if (nm > 0) parts.push(`${nm} merged`);
    parts.push(this.windowWords());
    parts.push(`now ${this.headWords()}`);
    return parts.join(' · ');
  }

  /** The window in words: "since 3h ago", "last hour", "last 24 h", "last 7 d". */
  windowWords(): string {
    if (this.win === '1h') return 'last hour';
    if (this.win === '24h') return 'last 24 h';
    if (this.win === '7d') return 'last 7 d';
    if (this.noVisit) return 'first look · 24 h';
    return `since ${ago(this.f.tl.liveNow() - this.visitAt)} ago`;
  }

  // ---- input -------------------------------------------------------------------------------------
  /** Any input on the floor skips the replay (a press, a key; the wheel and drags move the camera,
   *  which the intro watches). */
  input(kind: string, t: number): void {
    if (kind === 'down' || kind.startsWith('key:')) this.skip(t);
  }

  skip(t: number): void { if (this.openAt >= 0 && this.skipAt < 0 && t - this.openAt < T_DONE) this.skipAt = t; }

  /** A press on the glance: the "since" chip opens its menu; a menu row picks the window. Any
   *  other press closes the menu. True when the press was the coffee check's. */
  click(h: { kind: string; id: string } | null, t: number): boolean {
    if (h?.kind === 'since') {
      if (h.id === 'menu') this.menu = !this.menu;
      else { this.pick(h.id as Win, t); this.menu = false; }
      return true;
    }
    this.menu = false;
    // the verdict is a lens too: on the fact that decided it (w2-glance2): the main lines red in
    // the last hour or the apps down, the tests (pass rate, failures), the red main lines, the
    // intake (a jam)
    if (h?.kind === 'verdict') {
      const m = this.dg.marks, fr = this.dg.fresh;
      const k = m.factKey;
      if (k === 'acute') this.f.lens.push({ kind: 'fresh', id: 'acute', name: `${fr.acute.length} main ${fr.acute.length === 1 ? 'line' : 'lines'} red in the last hour`, sub: '' }, t);
      else if (k === 'down' || k === 'watcher') this.f.lens.push({ kind: 'fresh', id: 'down', name: `${this.now.down} ${this.now.down === 1 ? 'app' : 'apps'} down`, sub: '' }, t);
      else if (k === 'jam') this.f.lens.push({ kind: 'queue', id: 'intake', name: 'intake', sub: '' }, t);
      else if (k === 'pass' || k === 'fails') this.f.lens.push({ kind: 'scanner', id: 'tests', name: 'tests', sub: '' }, t);
      else if (k === 'red' && this.now.red) this.f.lens.push({ kind: 'fresh', id: 'red', name: `${this.now.red} main lines red`, sub: '' }, t);
      else if (k === 'conc' && m.conc && this.f.world.repos.has(m.conc.repo)) this.f.lens.push({ kind: 'repo', id: m.conc.repo, name: m.conc.label, sub: '' }, t); // v4-verdict (#1): the repo the verdict names
      return true;
    }
    return false;
  }

  /** Keys: `s` replays the window, `w` cycles it. */
  key(k: string, t: number): { kind: string; id: string; label: string } | null {
    if (k === 's' || k === 'S') { this.replay(t); return { kind: 'coffee', id: 'replay', label: this.windowWords() }; }
    if (k === 'w' || k === 'W') { this.pick(WINS[(WINS.indexOf(this.win) + 1) % WINS.length], t); return { kind: 'since', id: this.win, label: this.windowWords() }; }
    return null;
  }

  /** Picks the window: a new digest (and a new answer from the server) right away. */
  pick(win: Win, t: number): void {
    if (!WINS.includes(win) || win === this.win) return;
    this.win = win;
    this.restart();
    this.pump(t);
  }

  /** Replays the window from the top (the intro without the dial's swing). */
  replay(t: number): void { this.openAt = t - T_SWEEP; this.skipAt = -1; this.camAt = this.f.cam.ver; }

  private restart(): void {
    this.dgAt = -1e12; this.dgVer = -1; this.job = null; this.dgWin = '';
  }

  /** Whether the intro is playing (the live layer keeps drawing every frame while it does). */
  busy(t: number): boolean { return this.openAt < 0 ? this.f.world.loaded : this.skipAt < 0 && t - this.openAt < T_DONE; }

  /** Milliseconds into the intro (T_DONE+ once it is over or skipped). */
  introT(t: number): number {
    if (this.openAt < 0) return 0;
    if (this.skipAt >= 0 || this.f.reduced || this.f.tl.mode === 'replay') return T_DONE + 1;
    return t - this.openAt;
  }

  // ---- the digest --------------------------------------------------------------------------------
  /** Advances the digest one slice a turn; a new one starts at most every 2 s while the world
   *  changes, every 10 s while it stands still, at once when the window or the server's answer
   *  changed. The first finished digest opens the floor's intro. */
  private update(t: number): void {
    const f = this.f, w = f.world;
    if (!w.loaded || t === this.stepT) return;
    this.stepT = t;
    this.opening(t);
    if (!this.job) {
      const fresh = this.dgWin !== this.win;
      if (!fresh && (t - this.dgAt < 2000 || (w.ver === this.dgVer && t - this.dgAt < 10_000))) return;
      this.dgVer = w.ver; this.dgAt = t; this.dgWin = this.win;
      this.job = this.digest(w, f.tl.playhead);
    }
    const r = this.job.next();
    if (!r.done) return;
    this.job = null;
    if (!r.value) return;
    this.dg = r.value;
    this.since = r.value.since;
    this.dgN++;
  }

  /** The floor opens (the intro starts) on the first digest that has the server's answer, or
   *  1.5 s after the first digest started without one. */
  private opening(t: number): void {
    if (this.openAt >= 0 || !this.dgN) return;
    if (!(this.srv && this.dg.win === this.srvWin) && this.f.tl.mode === 'live' && t - this.firstT < 1500) return;
    this.openAt = t; this.skipAt = -1; this.camAt = this.f.cam.ver;
    console.log(`coffee: open at ${Math.round(t)} · ${this.words()}`);
    const m = this.dg.marks; // w2-glance2: the evidence tools read what decided the verdict and the callouts' candidates
    console.log(`coffee: verdict ${m.verdict} · ${m.fact} · smoke ${m.smoke.map((s) => `${s.step}${s.heap ? '@heap' : ''}`).join(',')} · pct ${m.usual.pct.toFixed(2)} (${m.usual.pctOf}) · embers ${m.embers.map((e) => `${e.kind}:${e.id}[${e.metrics.join(',')}]`).join(' ')} · hot ${m.hot.map((h) => `${h.kind}:${h.lead}${h.rest}`).join(' | ')}`);
  }
  private firstT = -1;

  private *digest(w: World, now: number): Generator<void, Digest | null, void> {
    const f = this.f, c = f.census, ins = insights();
    if (this.firstT < 0) this.firstT = this.stepT;
    const win = this.win;
    const since = windowStart(win, now, this.visitAt);
    const srv = this.srv && this.srvWin === win && f.tl.mode === 'live' ? this.srv : null;
    const clusters: readonly Cluster[] = ins.clusters();
    const fresh = yield* freshSince(w, since, now, win === 'visit' ? this.fp : null, srv, clusters);
    if (w !== f.world) return null;
    yield;
    // the queue: a sample every 15 s of the world, growing = up by ≥ 2 over the samples
    let slots = 0, busy = 0;
    for (const g of c.groups) if (!g.hosted) { slots += g.slots; busy += g.running.length; }
    if (w.at - this.qAt >= 15_000) { this.qAt = w.at; this.qlen.push(c.waiting); if (this.qlen.length > 20) this.qlen.shift(); }
    let low = Infinity;
    for (let i = 0; i < this.qlen.length - 1; i++) low = Math.min(low, this.qlen[i]);
    const queue: QueueState = { waiting: c.waiting, oldestWait: c.oldestWait, slots, busy, growing: this.qlen.length >= 3 && c.waiting - low >= 2, p50: w.stats.p50_queue_ms || 60_000 };
    // how long apps have been down: the stream's health events, then the server's 7 d ledger
    const downAt = new Map<string, number>();
    const note = (app: string, to: string, at: number) => {
      if (to === 'down' || to === 'degraded') { if (at > (downAt.get(app) ?? 0)) downAt.set(app, at); }
      else if (to === 'up' && (downAt.get(app) ?? 0) < at) downAt.delete(app);
    };
    for (const src of [this.ages, srv]) if (src) for (const x of [...src.apps].sort((a, b) => a.at - b.at)) note(x.app, x.to, x.at);
    for (const h of w.health) note(h.app, h.to, h.at);
    const agesKnown = !!this.ages || win === '7d';
    const groups = ins.groups();
    const mk = marks({
      w, now, since, short: shortWindow(win, now, this.visitAt), clusters, trend: (id) => ins.trend(id), srv, fresh, queue,
      downSince: (app) => downAt.get(app) ?? (agesKnown ? now - 8 * DAY : 0),
      groups, groupWord: (id) => groupWord(id, ins.group(id)?.name), groupOf: (repo) => ins.groupOf(repo),
      replay: replayed(f.tl), // v4-verdict (#7): the replayed hour's own runs
    });
    return { win, since, now, fresh, marks: mk, complete: srv ? srv.complete : true };
  }

  /** What a glance chip lights (the "since you looked" lens). */
  freshSet(k: string): { repos: string[]; apps: string[]; fails: string[] } {
    const d = this.dg.fresh, w = this.f.world;
    switch (k) {
      case 'red': {
        // every main line red now, the window's new ones first (the chip: "32 red · 26 new")
        const fresh = new Set(d.newRed), rest: string[] = [];
        for (const r of w.repos.values()) if (isRedMain(r.main?.state) && !fresh.has(r.id)) rest.push(r.id);
        return { repos: [...d.newRed, ...rest], apps: [], fails: [] };
      }
      case 'newRed': return { repos: d.newRed, apps: [], fails: [] };
      case 'acute': return { repos: d.acute, apps: [], fails: [] }; // w2-glance2: red in the last hour
      case 'down': {
        // every app down now (the chip: "2 apps down"), the window's first
        const apps: string[] = [...d.down];
        for (const a of w.apps.values()) if (a.health === 'down' && !d.down.includes(a.id ?? '')) apps.push(a.id ?? '');
        return { repos: [], apps, fails: [] };
      }
      case 'fixed': return { repos: d.fixed, apps: [], fails: [] };
      case 'failed': return { repos: [...new Set(d.failed.map((id) => w.pipelines.get(id)?.repo ?? ''))].filter(Boolean), apps: [], fails: d.failed };
      case 'back': return { repos: [], apps: d.recovered, fails: [] };
      case 'deploys': return { repos: [], apps: d.deployApps, fails: [] };
      case 'merged': return { repos: [...new Set(d.merged.map((k2) => k2.slice(0, k2.indexOf('@'))))], apps: [], fails: [] };
      case 'clusters': {
        const ins = insights(), repos = new Set<string>();
        for (const id of d.newClusters) for (const r of ins.cluster(id)?.repos ?? []) repos.add(r);
        return { repos: [...repos], apps: [], fails: [] };
      }
      default: return { repos: [], apps: [], fails: [] };
    }
  }

  /** The smoke cluster's words for the lens (scanner hover). */
  smokeWords(): string { const s = this.dg.marks.smoke[0]; return s ? `${s.step} · ${s.repoN} repos` : ''; }

  /** Where each repo's newest car (and newest culprit) sits on its rail, and each car by key. */
  carSpots(): { carAt: Map<string, [number, number]>; repoAt: Map<string, [number, number]>; culpritAt: Map<string, [number, number]> } {
    const lanes = this.f.floor.carSpots(); if (lanes) return lanes; // fab-w1: the lanes' cars and posts (floor.ts)
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

  // ---- on the floor ------------------------------------------------------------------------------
  // Masters, laid out when the census, the camera or the digest moved (the last field of each
  // entry is when it happened, server ms: the replay gates on it); per-frame scratch beside them.
  private layKey = [-1, -1, -1, -1];
  private layParked: unknown = null;
  private mSmoke = new Nums();   // x, y, k, size, puffs, rise, base | at
  private mBeacon = new Nums();  // x, yFloor, yLamp, mode, 0 | at
  private mEmber = new Nums();   // x, y, rx, k | at
  private mCrack = new Nums();   // painter runs (chronic: shown from the start)
  private mChev = new Nums();    // x, y
  private jamUV: number[] = [];  // the jam's crates (floor u, v)
  /** w2-glance2: each group ember's hover box (screen), naming its metric. */
  private emberBoxes: { x: number; y: number; w: number; h: number; kind: string; id: string; label: string }[] = [];
  private ev = new Nums();       // replay events: x, y, r, fire (intro ms), colour, u (a failure's spot on the return belt, else -1), v
  /** Each hotspot's anchor on screen (glance.ts draws the callouts from them). */
  hotXY: number[] = [];
  /** Each beacon's lamp on screen (x, y): the callouts keep 24 px clear of them. */
  beaconXY: number[] = [];
  private sSmoke = new Nums(); private sBeacon = new Nums(); private sEmber = new Nums(); private sRings = new Nums();
  // the fresh glows (rims), as phase 1 had them, gated by time in the replay
  private glowItems: [string, number, number, number, string][] = [];
  private glowAt: number[] = [];
  private glowSeenFor = -1;
  private glowSeen: number[] = [];
  private glowCols: string[] = [];
  private glowColOf: number[] = [];
  private glowBuckets: number[][] = [];
  private glowN = 0;

  under(g: Gfx, t: number): void {
    this.update(t);
    const f = this.f;
    if (!f.world.loaded || f.census.skeleton) return;
    if (this.openAt >= 0 && this.skipAt < 0 && f.cam.ver !== this.camAt && t - this.openAt < T_DONE) this.skip(t); // the wheel / a drag moved the camera
    this.layout();
    const it = this.introT(t), d = this.dg;
    // the data moment the replay has reached (server ms); +∞ once settled
    const span = Math.max(1, d.now - d.since);
    const T = it >= T_SETTLE - 300 ? Infinity : d.since + clamp((it - T_SWEEP) / (T_SETTLE - 300 - T_SWEEP), 0, 1) * span;
    const sz = clamp(f.cam.s * 1.3, 0.7, 3);
    // reduced motion: the marks hold still (no rising smoke, no breathing), rims only
    const tm = f.reduced ? 0 : t;
    this.liveG = g; this.lookVeil(g, t); // wow 4: off the worst path the floor dims · fx-demo: the live canvas remembered for look()
    gate(this.mEmber, 5, T, this.sEmber); embers(g, this.sEmber, tm);
    // w2-glance2: the bare glowing floor says why it glows (the bottom of the frame's hit list:
    // anything standing on the glow answers first, as plant.ts's embers do)
    const hl = (f as unknown as { hits?: unknown }).hits;
    if (this.sEmber.n && this.emberBoxes.length && Array.isArray(hl)) hl.unshift(...this.emberBoxes);
    cracks(g, this.mCrack);
    gate(this.mSmoke, 8, T, this.sSmoke); smoke(g, this.sSmoke, tm, 1, f.labels);
    if (this.jamUV.length && T === Infinity) {
      const P = f.plan;
      for (let i = 0; i < this.jamUV.length; i += 3) f.fx.crate(g, this.jamUV[i], this.jamUV[i + 1], 7, false, true, this.jamUV[i + 2]);
      chevrons(g, this.mChev, d.marks.jam?.k ?? 0, f.reduced ? 0 : beatPhase(t), sz);
      void P;
    }
    gate(this.mBeacon, 6, T, this.sBeacon); dodge(this.sBeacon, f.labels, 15 * Math.min(1.6, sz) + 4); beacons(g, this.sBeacon, tm, sz);
    if (f.tl.mode !== 'replay' && !f.lens.topLens) this.freshGlows(g, t, T);
    if (it < T_SETTLE) this.replayEvents(g, it);
  }

  /** Lays the marks and the replay's events out on screen, when the census, the camera, the
   *  digest or the parked failures moved. */
  private layout(): void {
    const f = this.f, c = f.census, cam = f.cam, k = this.layKey;
    if (k[0] === c.at && k[1] === cam.ver && k[2] === this.dgN && k[3] === c.waiting && this.layParked === f.lens.parked) return;
    k[0] = c.at; k[1] = cam.ver; k[2] = this.dgN; k[3] = c.waiting; this.layParked = f.lens.parked;
    const P = f.plan, fx = f.fx, w = f.world, d = this.dg, m = d.marks;
    const sz = clamp(cam.s * 1.3, 0.7, 3);
    const { culpritAt, repoAt } = this.carSpots();
    const railOf = (repo: string) => { const i = c.rails.findIndex((r) => r.org === w.orgOf(repo)); return i < 0 ? -1 : Math.min(P.RAIL_V.length - 1, i); };
    const spread = new Map<number, number>();
    const repoSpot = (repo: string): [number, number] | null => {
      const at = culpritAt.get(repo) ?? repoAt.get(repo);
      if (at) return at;
      const i = railOf(repo);
      if (i < 0) return null;
      const n = spread.get(i) ?? 0; spread.set(i, n + 1);
      return [P.RAIL_U1 + 6 - (n % 8) * 9, P.RAIL_V[i] - 10];
    };
    // smoke (fx-glance): ≤ 3 plumes of dark, red-tinged wisps over the scanner, as many wisps as
    // the cluster hits repos; a few over the docks of the repos each cluster hits
    const sm = this.mSmoke; sm.reset();
    const wisp = new Map<string, [number, number]>();
    const ws = Math.min(1.2, sz);
    // v4-verdict: a concentrated repo's ONE plume rises from its heap group on the return belt
    const hg = m.smoke.some((s) => s.heap) ? heapGroups(heapsOf(f.lens.parked) ?? []) : [];
    let slot = 0;
    m.smoke.forEach((s) => {
      const g = s.heap ? hg.find((x) => x.repo === s.heap) : undefined;
      let u = P.SCAN_U, v = 300 + slot * 70;
      if (g) { let u0 = Infinity, u1 = -Infinity; for (const h of g.heaps) { u0 = Math.min(u0, h.u0); u1 = Math.max(u1, h.u1); } u = (u0 + u1) / 2; v = P.RETURN_V; }
      else slot++;
      const top = cam.y(u, v, 40);
      pushN(sm, cam.x(u, v), top, s.k, ws, clamp(2 + s.repoN, 3, 12), 40, s.fresh ? cam.y(u, v, 0) - top : 0, s.at);
      for (const r of s.repos) { const o = w.orgOf(r), x = wisp.get(o); wisp.set(o, [Math.max(x?.[0] ?? 0, s.k * 0.7), (x?.[1] ?? 0) + 1]); }
    });
    for (const [o, [kk, n]] of wisp) { const v = fx.dockV(o); pushN(sm, cam.x(P.DOCK_U0 + 20, v), cam.y(P.DOCK_U0 + 20, v, 14), kk, ws, clamp(1 + n, 2, 6), 24, 0, m.smoke[0]?.at ?? d.now); }
    // beacons: ≤ 3 pulse (on the beat while < 10 min old, breathing while < 1 h), the rest steady
    const bc = this.mBeacon; bc.reset();
    m.beacons.forEach((b, i) => {
      const mode = i < 3 ? (d.now - b.at < 600_000 ? 1 : 2) : 0;
      if (b.kind === 'red') {
        const at = repoSpot(b.id);
        if (at) pushN(bc, cam.x(at[0], at[1]), cam.y(at[0], at[1], 0), cam.y(at[0], at[1], 40), mode, 0, b.at);
      } else if (b.kind === 'down') {
        const bl = fx.blockAt.get(b.id);
        if (bl) { const u = bl.u + bl.d / 2, v = bl.v + bl.d / 2; pushN(bc, cam.x(u, v), cam.y(u, v, bl.h), cam.y(u, v, bl.h + 30), mode, 0, b.at); }
      } else {
        const u = (P.SCAN_U + P.TRACK_U1) / 2, v = P.TRACK_V[1];
        pushN(bc, cam.x(u, v), cam.y(u, v, 0), cam.y(u, v, 40), mode, 0, b.at);
      }
    });
    // the lamps the callouts keep clear of (glance.ts)
    this.beaconXY = [];
    for (let i = 0; i < bc.n; i += 6) this.beaconXY.push(bc.a[i], bc.a[i + 2]);
    // cracks: chronic reds fracture their org's rail (more lines, more of them), chronic downs
    // their building's roof, a job past 3× its expected time its bay
    const cr = this.mCrack; cr.reset();
    const perRail = new Map<number, number>();
    for (const x of m.cracks) {
      if (x.kind === 'red') { const i = railOf(x.id); if (i >= 0) perRail.set(i, (perRail.get(i) ?? 0) + 1); continue; }
      const bl = fx.blockAt.get(x.id);
      if (bl) { const u = bl.u + bl.d / 2, v = bl.v + bl.d / 2; crackAt(cr, cam.x(u, v), cam.y(u, v, bl.h + 0.5), sz * 0.8, hashN(x.id), 1); }
    }
    for (const [i, n] of perRail) {
      const lines = Math.min(4, 1 + Math.floor(n / 4));
      for (let j = 0; j < Math.min(3, 1 + Math.floor(n / 6)); j++) {
        const u = P.RAIL_U0 + 16 + j * 34, v = P.RAIL_V[i] + 9;
        crackAt(cr, cam.x(u, v), cam.y(u, v, 0.4), sz, i * 977 + j * 131, lines);
      }
    }
    const now = f.tl.playhead;
    for (const bay of fx.bays) {
      const p = bay.pid ? w.pipelines.get(bay.pid) : undefined, exp = p?.expected_ms ?? 0;
      if (!p?.started || exp <= 0 || now - p.started < 3 * exp) continue;
      const u = bay.u + bay.du * 0.4, v = bay.v + bay.dv * 0.5;
      crackAt(cr, cam.x(u, v), cam.y(u, v, P.ENG_H + 0.5), sz * 0.7, hashN(bay.pid), 2);
    }
    // embers (w2-glance2, #10): only where the hover names the bad metric. A stage's is the floor's
    // own (groupfloor.ts glows the worst stage, its hover in plant.ts, its arrow on the wall): not
    // twice, and never one the wall's arrow contradicts (anomaly.ts metricBad). A group's sits at
    // its OWN lane's dock (a team folded into "other teams" has no place of its own, so no glow
    // over a district whose hover names another team), where the dock's hover title says what
    // glows (lens.ts) and the bare floor round it too; not where groupfloor already glows a dock
    const em = this.mEmber; em.reset();
    this.emberWords.clear();
    this.emberBoxes = [];
    const fl = f.floor, G = floorGroups(), ins = insights();
    const w2v: number[] = [];
    for (const a of emberPass.painted) if (!a.zone) w2v.push(a.v0);
    const shortW = shortWindow(d.win, d.now, this.visitAt);
    // the hottest per lane: a team folded into "other teams" glows at that dock, whose hover then
    // names the team ("other teams dock · platform builds 45s (usual 39s)")
    const ge = m.embers.filter((e) => e.kind === 'group').sort((a, b) => b.k - a.k);
    for (const e of ge) {
      const lane = fl.on ? G.laneOfGroup(e.id) : e.id;
      if (this.emberWords.has(lane) || (fl.on && fl.laneIndex(lane) < 0)) continue;
      const fact = emberFact(ins.trend(e.id), e.metrics, shortW);
      if (!fact) continue;
      const words = lane === e.id ? fact : `${groupWord(e.id, ins.group(e.id)?.name)} ${fact}`;
      this.emberWords.set(lane, ` · ${words}`);
      // the floor's lanes off (the old docks): an org's dock only (a team has no door there)
      if (!fl.on && !e.id.startsWith('org:')) { this.emberWords.delete(lane); continue; }
      const v = fl.on ? fl.dockV(lane) : fx.dockV(e.id.slice(4));
      if (w2v.some((x) => Math.abs(x - v) < 14)) continue; // groupfloor glows this dock already
      const u = P.DOCK_U0 + 27, x = cam.x(u, v), y = cam.y(u, v, 0), rx = 44 * cam.s * 0.95;
      pushN(em, x, y, rx, e.k, d.now - 1);
      this.emberBoxes.push({ x: x - rx * 0.8, y: y - rx * 0.4, w: rx * 1.6, h: rx * 0.8, kind: 'ember', id: `group:${e.id}`, label: lane === e.id ? `${groupWord(e.id, ins.group(e.id)?.name)} · ${words}` : `other teams · ${words}` });
    }
    // the jam: crates bunch at the intake's mouth, chevrons push behind them
    this.jamUV = [];
    this.mChev.reset();
    if (m.jam) {
      const n = 3 + Math.round(m.jam.k * 4);
      for (let q = n - 1; q >= 0; q--) this.jamUV.push(P.DIST_U - 6 - q * 4.6, 291 + ((q % 2) * 2 - 1) * 1.2, 2 + (q % 3 === 1 ? 3 : 0));
      for (let q = 0; q < 3; q++) { const u = P.INTAKE_U0 + 6 + q * 9, v = P.LANE_V[0] - 22; this.mChev.push2(cam.x(u, v), cam.y(u, v, 1)); }
    }
    // the hotspots' anchors
    this.hotXY = [];
    for (const h of m.hot) {
      let at: [number, number, number] | null = null;
      if (h.kind === 'cluster' || h.kind === 'flaky') {
        // w2-glance2: at its heap on the return belt when the last hour parked one, else the scanner
        const pg = f.lens.parkGroups.find((x) => x.cl === h.id);
        at = pg ? [(pg.u0 + pg.u1) / 2, P.RETURN_V, 8] : [P.SCAN_U, 300, 70];
      } else if (h.kind === 'red' || h.kind === 'conc') { const sp = repoSpot(h.id); if (sp) at = [sp[0], sp[1], 6]; } // v4-verdict: the concentrated repo at its rail
      else if (h.kind === 'jam') at = [(P.INTAKE_U0 + P.INTAKE_U1) / 2, 291, 10];
      else if (h.kind === 'down') { const bl = f.blockAt.get(h.id); if (bl) at = [bl.u + bl.d / 2, bl.v + bl.d / 2, bl.h + 2]; }
      else if (fl.on && G.laneOfGroup(h.id) === h.id && fl.laneIndex(h.id) >= 0) at = [P.DOCK_U1, fl.dockV(h.id), 4]; // w2-glance2: the group's own dock's right edge (its lane; the callout sits beside it)
      else { const s = this.groupSpot(h.id); if (s) at = [s[0], s[1], s[3]]; }
      this.hotXY.push(at ? cam.x(at[0], at[1]) : -1, at ? cam.y(at[0], at[1], at[2]) : -1);
    }
    this.layoutEvents(repoSpot);
    this.layoutGlows(repoSpot);
    this.layoutLook();
  }

  // ---- wow 4 (fx-glance): the floor looks at the problem --------------------------------------
  // When the fleet reads worse than usual, everything off the worst path dims ~15 % (a veil over
  // the static floor with holes for the worst group's lane, the intake, the scanner and the
  // worst cluster's heap) and a slow light walks that path, dock → failure, every 6 beats.
  /** The worst path on screen: x, y pairs, and each point's distance along it. */
  private lookXY: number[] = [];
  private lookLen: number[] = [];
  /** The veil's holes on screen: quads (8 numbers each), wound against the veil. */
  private lookHoles: number[] = [];
  private lookFrom = -1;
  private liveG: Gfx | null = null; // fx-demo: the live canvas's Gfx (under() draws there): the walking light's glow moves every frame, so it goes there, not on the retained top canvas (PERF.md, "The demo's last misses")

  private layoutLook(): void {
    const f = this.f, cam = f.cam, P = f.plan, m = this.dg.marks;
    this.lookXY = []; this.lookLen = []; this.lookHoles = [];
    if (m.usual.rel !== 'worse' || m.verdict === 'flowing' || m.verdict === 'steady') return;
    const grp = m.hot.find((h) => h.kind === 'group'), cl = m.hot.find((h) => h.kind === 'cluster');
    if (!grp && !cl) return;
    const fl = f.floor, gi = grp ? fl.laneIndex(grp.id) : -1, geo = gi >= 0 ? fl.lanesNow[gi] : undefined;
    const pg = cl ? f.lens.parkGroups.find((x) => x.cl === cl.id) : undefined;
    const pts: [number, number][] = [];
    if (geo && grp) pts.push([P.DOCK_U0 + 14, fl.dockV(grp.id)], [P.RAIL_U1 + 4, fl.railV(grp.id)]);
    pts.push([P.INTAKE_U0 + 10, P.LANE_V[0]], [P.DIST_U, 300], [P.SCAN_U - 8, 300], [P.SCAN_U - 8, P.RETURN_V]);
    if (pg) pts.push([(pg.u0 + pg.u1) / 2, P.RETURN_V]);
    let len = 0;
    pts.forEach(([u, v], i) => {
      const x = cam.x(u, v), y = cam.y(u, v, 2);
      if (i) len += Math.hypot(x - this.lookXY[this.lookXY.length - 2], y - this.lookXY[this.lookXY.length - 1]);
      this.lookXY.push(x, y); this.lookLen.push(len);
    });
    const hole = (u0: number, v0: number, u1: number, v1: number) => {
      const q = [cam.x(u0, v0), cam.y(u0, v0, 0), cam.x(u1, v0), cam.y(u1, v0, 0), cam.x(u1, v1), cam.y(u1, v1, 0), cam.x(u0, v1), cam.y(u0, v1, 0)];
      // the veil runs clockwise on screen: each hole the other way round
      let a = 0;
      for (let i = 0; i < 8; i += 2) { const j = (i + 2) % 8; a += q[i] * q[j + 1] - q[j] * q[i + 1]; }
      if (a > 0) this.lookHoles.push(q[0], q[1], q[6], q[7], q[4], q[5], q[2], q[3]);
      else this.lookHoles.push(...q);
    };
    if (geo) hole(-112, geo.v0, P.RAIL_U1 + 12, geo.v1);
    hole(P.RAIL_U1 + 12, P.LANE_V[0] - 16, P.ENG_U0, P.LANE_V[1] + 16);
    hole(P.SCAN_U - 22, 140, P.SCAN_U + 22, P.RETURN_V - 16);
    if (pg) hole(pg.u0 - 10, P.RETURN_V - 15, pg.u1 + 10, P.RETURN_V + 15);
  }

  /** Whether the floor looks at the problem now: worse than usual, settled, at the fleet zoom,
   *  live, nothing picked, motion allowed. */
  private looking(t: number): boolean {
    const f = this.f;
    return this.lookXY.length >= 4 && !f.reduced && f.tl.mode === 'live' && !f.lens.topLens && !f.selected && f.cam.zoom < 1.6 && this.introT(t) >= T_DONE;
  }

  /** The veil (under the live layers, over the static floor): ~15 %, fading in over a second. */
  private lookVeil(g: Gfx, t: number): void {
    if (!this.looking(t)) { this.lookFrom = -1; return; }
    if (this.lookFrom < 0) this.lookFrom = t;
    const a = 0.15 * clamp((t - this.lookFrom) / 1000, 0, 1), cam = this.f.cam;
    if (a <= 0.005) return;
    const L = 0, T = 68, R = cam.W, B = cam.H - 58, h = this.lookHoles;
    g.begin_();
    g.ctx.moveTo(L, T); g.ctx.lineTo(R, T); g.ctx.lineTo(R, B); g.ctx.lineTo(L, B); g.ctx.closePath();
    for (let i = 0; i < h.length; i += 8) { g.ctx.moveTo(h[i], h[i + 1]); g.ctx.lineTo(h[i + 2], h[i + 3]); g.ctx.lineTo(h[i + 4], h[i + 5]); g.ctx.lineTo(h[i + 6], h[i + 7]); g.ctx.closePath(); }
    g.ops += 5 + h.length / 2;
    g.fill(tint(K_BLACK, a));
  }

  /** The light walking the worst path, every 6 beats, eased (fx-demo: its glow on the live canvas; no faint path line under it: on macOS that 1.2 px, 9 % white stroke cost ~2 fps wherever it was drawn, PERF.md "The demo's last misses"; the veil's holes mark the path). */
  look(g: Gfx, t: number): void {
    if (!this.looking(t) || this.lookFrom < 0) return;
    const xy = this.lookXY, ln = this.lookLen, total = ln[ln.length - 1];
    if (!(total > 0)) return;
    const fade = clamp((t - this.lookFrom) / 1000, 0, 1);
    const p = (t / (6 * 1000)) % 1, e = p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2, d = e * total;
    let k = 1;
    while (k < ln.length - 1 && ln[k] < d) k++;
    const s = (d - ln[k - 1]) / Math.max(1e-6, ln[k] - ln[k - 1]);
    const x = xy[(k - 1) * 2] + (xy[k * 2] - xy[(k - 1) * 2]) * s, y = xy[(k - 1) * 2 + 1] + (xy[k * 2 + 1] - xy[(k - 1) * 2 + 1]) * s;
    const env = Math.sin(Math.PI * p) * fade;
    const lg = this.liveG ?? g; for (const [r, al] of LOOK_GLOW) { lg.begin_(); lg.circle(x, y, r); lg.fill(tint(K_INK, al * env)); } // fx-demo: it moves every frame: on the live canvas, not the retained top one (which it re-sent every frame)
  }

  /** A group's place on the floor: an org's dock, a team's district ([u, v, r, z]). */
  groupSpot(id: string): [number, number, number, number] | null {
    const f = this.f, P = f.plan, fx = f.fx;
    if (id.startsWith('org:')) {
      const org = id.slice(4);
      if (!f.census.docks.some((d) => d.org === org)) return null;
      return [P.DOCK_U0 + 27, fx.dockV(org), 44, 18];
    }
    const slug = id.slice(id.indexOf(':') + 1);
    let di = fx.districtBox.findIndex((b) => b.team.toLowerCase().replace(/\s+/g, '-') === slug);
    if (di < 0) for (const a of f.world.apps.values()) {
      if (String(a.team ?? '').toLowerCase().replace(/[\s_]+/g, '-').replace(/-team$/, '') !== slug) continue;
      const bl = fx.blockAt.get(a.id ?? '');
      if (bl) { di = bl.district; break; }
    }
    const b = fx.districtBox[di];
    if (!b) return null;
    return [(b.u0 + b.u1) / 2, (b.v0 + b.v1) / 2, Math.max(24, Math.min(90, Math.max(b.u1 - b.u0, b.v1 - b.v0) * 0.55)), 6];
  }

  /** The replay's events: each thing that changed in the window, where it is, when it lands in
   *  the compressed sweep. ≤ 80, in time order. */
  private layoutEvents(repoSpot: (repo: string) => [number, number] | null): void {
    const f = this.f, cam = f.cam, P = f.plan, fx = f.fx, d = this.dg, fr = d.fresh;
    const ev = this.ev; ev.reset();
    const span = Math.max(1, d.now - d.since);
    const parked = new Map(f.lens.parked.map((x) => [x.id, x.u]));
    const items = [...fr.at].sort((a, b) => a[1] - b[1]);
    if (items.length > 80) items.splice(0, items.length - 80);
    const down = new Set(fr.down);
    for (const [key, at] of items) {
      const i = key.indexOf(':'), kind = key.slice(0, i), id = key.slice(i + 1);
      const fire = T_SWEEP + clamp((at - d.since) / span, 0, 1) * (T_SETTLE - 300 - T_SWEEP);
      let x = -1, y = -1, col = K_INK, u = -1, r = 6;
      if (kind === 'red' || kind === 'fix') {
        const s = repoSpot(id);
        if (!s) continue;
        x = cam.x(s[0], s[1]); y = cam.y(s[0], s[1], 5); col = kind === 'red' ? K_RED : K_OK;
      } else if (kind === 'fail') {
        const pu = parked.get(id);
        if (pu === undefined) continue;
        x = cam.x(pu, P.RETURN_V); y = cam.y(pu, P.RETURN_V, 6); col = K_RED; u = pu; r = 5;
      } else if (kind === 'dep' || kind === 'app') {
        const bl = fx.blockAt.get(id);
        if (!bl) continue;
        const bu = bl.u + bl.d / 2, bv = bl.v + bl.d / 2;
        x = cam.x(bu, bv); y = cam.y(bu, bv, bl.h + 1.5); r = 4;
        col = kind === 'dep' ? K_OK : down.has(id) ? K_RED : K_OK;
      } else continue;
      ev.push3(x, y, r); ev.push3(fire, col, u); ev.a[ev.n++] = P.RETURN_V;
    }
  }

  /** The events landing now in the replay: a ring where each lands; a failure's crate rides the
   *  return belt from the scanner to its spot first. */
  private replayEvents(g: Gfx, it: number): void {
    const f = this.f, ev = this.ev, rs = this.sRings, P = f.plan;
    rs.reset();
    for (let i = 0; i < ev.n; i += 7) {
      const fire = ev.a[i + 3], u = ev.a[i + 5];
      const ride = u >= 0 ? 600 : 0;
      const e = (it - fire - ride) / 700;
      if (u >= 0 && it >= fire && it < fire + ride) {
        const k = (it - fire) / ride;
        f.fx.crate(g, P.SCAN_U - 10 - (P.SCAN_U - 10 - u) * k * (2 - k), ev.a[i + 6], 7, true, false, 2);
      }
      if (e < 0 || e > 1) continue;
      rs.push3(ev.a[i], ev.a[i + 1], ev.a[i + 2]); rs.push2(e, ev.a[i + 4]);
    }
    rings(g, rs);
  }

  private layoutGlows(repoSpot: (repo: string) => [number, number] | null): void {
    const f = this.f, P = f.plan, cam = f.cam, fx = f.fx, fr = this.dg.fresh;
    const items: [string, number, number, number, string][] = (this.glowItems = []); // key, x, y, r, colour
    const at: number[] = (this.glowAt = []);
    const add = (key: string, u: number, v: number, z: number, r: number, col: string, when: string) => { items.push([key, cam.x(u, v), cam.y(u, v, z), r, col]); at.push(fr.at.get(when) ?? this.dg.since); };
    const { carAt } = this.carSpots();
    // a main line newly red: a WHITE rim (§E; its beacon is the red), still, until it fades
    // sy-client: one rim per spot (a lane's rail end holds many repos' newest cars: stacked rims
    // read as a spiral), at most 6
    const rimAt: [number, number][] = [];
    for (const id of fr.newRed) {
      const s = repoSpot(id);
      if (!s || rimAt.length >= 6) continue;
      const x = cam.x(s[0], s[1]), y = cam.y(s[0], s[1], 5);
      if (rimAt.some(([a, b]) => Math.abs(a - x) < 10 && Math.abs(b - y) < 10)) continue;
      rimAt.push([x, y]);
      add(`red:${id}`, s[0], s[1], 5, 6, RIM, `red:${id}`);
    }
    // fresh failures: one ring per CLUSTER on the conveyor (fab-w3's parked groups), sized to its
    // run, so tight-packed crates do not melt into one red blob; it starts with the newest
    const parkedK = new Map(f.lens.parked.map((x) => [x.id, x.k]));
    const groupAt = new Map<number, number>();
    for (const id of fr.failed) {
      const k = parkedK.get(id);
      if (k === undefined) continue;
      const when = fr.at.get(`fail:${id}`) ?? 0;
      if (when > (groupAt.get(k) ?? -1)) groupAt.set(k, when);
    }
    // sy-client: the biggest 3 heaps only (fx-engine heaps every signature: a ring on each read as
    // a train of rings along the belt)
    const ringed = [...groupAt].filter(([k]) => f.lens.parkGroups[k]).sort((a, b) => f.lens.parkGroups[b[0]]!.n - f.lens.parkGroups[a[0]]!.n).slice(0, 3);
    for (const [k, when] of ringed) {
      const pg = f.lens.parkGroups[k];
      if (!pg) continue;
      const um = (pg.u0 + pg.u1) / 2, half = Math.abs(cam.x(pg.u1, P.RETURN_V) - cam.x(pg.u0, P.RETURN_V)) / 2;
      items.push([`failc:${pg.cl}`, cam.x(um, P.RETURN_V), cam.y(um, P.RETURN_V, 8), Math.max(6, half + 4), C.red]);
      at.push(when || this.dg.since);
    }
    for (const id of fr.fixed) { const s = repoSpot(id); if (s) add(`fix:${id}`, s[0], s[1], 5, 6, OK, `fix:${id}`); }
    const down = new Set(fr.down), rec = new Set(fr.recovered);
    for (const id of new Set([...fr.down, ...fr.recovered, ...fr.deployApps])) {
      const b = fx.blockAt.get(id);
      if (!b) continue;
      add(`app:${id}`, b.u + b.d / 2, b.v + b.d / 2, b.h + 1.5, 4, down.has(id) ? C.red : rec.has(id) ? OK : '#9FB8A6', down.has(id) || rec.has(id) ? `app:${id}` : `dep:${id}`);
    }
    for (const k of fr.merged) { const s = carAt.get(k); if (s) add(`mrg:${k}`, s[0], s[1], 5, 5, C.ink2, `mrg:${k}`); }
    // perf + calm: at most GLOW_MAX pulse, most important first (new reds, failures, fixes, apps, merges)
    if (items.length > GLOW_MAX) { items.length = GLOW_MAX; at.length = GLOW_MAX; }
    // their colours (one path per colour and opacity step) and which give one flash (not red)
    this.glowCols = [...new Set(items.map((it) => it[4]))];
    this.glowColOf = items.map((it) => this.glowCols.indexOf(it[4]));
    this.glowFlash = items.map((it) => it[4] !== C.red && it[4] !== RIM);
    this.glowN++;
  }

  /** Fresh things rimmed where they are (fx-glance: still, the green ones one flash first), fading over ~2 min once seen; in the
   *  replay only those whose moment has passed. */
  private freshGlows(g: Gfx, t: number, T: number): void {
    const items = this.glowItems;
    if (!items.length) return;
    // perf: each item's first-seen time resolved once per layout; per frame only numbers
    if (this.glowSeenFor !== this.glowN) {
      this.glowSeenFor = this.glowN;
      const seen = this.glowSeen;
      seen.length = items.length;
      for (let i = 0; i < items.length; i++) seen[i] = this.seen.get(items[i][0]) ?? -1;
      if (this.seen.size > 4000) this.seen.clear();
    }
    // fx-glance: the rims hold still (the beacons, ≤ 3, are what pulses, on the one eased beat);
    // new reds and failures a steady rim, the rest (fixed, recovered, deployed, merged) ONE flash
    // when first drawn (eased up and down over FLASH_MS), then a still rim; all fade over 2 min
    const nc = this.glowCols.length;
    const buckets = this.glowBuckets;
    for (let i = 0; i < nc * 4; i++) { if (buckets[i]) buckets[i].length = 0; else buckets[i] = []; }
    let live = 0;
    for (let i = 0; i < items.length; i++) {
      if (this.glowAt[i] > T) continue;
      // first drawn now: its two minutes start (the replay's late arrivals get theirs too)
      if (this.glowSeen[i] < 0) { this.glowSeen[i] = t; this.seen.set(items[i][0], t); }
      const age = t - this.glowSeen[i], fade = 1 - age / FRESH_MS;
      if (fade <= 0) continue;
      const it = items[i], r = it[3];
      let a: number, rf: number, rr: number;
      if (!this.glowFlash[i]) { a = fade * 0.75; rf = r * 1.4; rr = r + 4; }
      else if (age < FLASH_MS && !this.f.reduced) { const e = age / FLASH_MS, env = Math.sin(Math.PI * e); a = fade * env; rf = r * (1.2 + 0.6 * e); rr = r + 3 + 9 * e; }
      else { a = 0.3 * fade; rf = 0; rr = r + 3; }
      if (a < 0.02) continue;
      live++;
      buckets[this.glowColOf[i] * 4 + Math.min(3, Math.max(0, Math.ceil(a * 4) - 1))].push(it[1], it[2], rf, rr);
    }
    if (!live) return;
    for (let ci = 0; ci < nc; ci++) for (let qi = 0; qi < 4; qi++) {
      const xy = buckets[ci * 4 + qi];
      if (!xy.length) continue;
      const col = this.glowCols[ci], q = (qi + 1) / 4;
      g.begin_();
      let fills = 0;
      for (let i = 0; i < xy.length; i += 4) { const rf = xy[i + 2]; if (rf <= 0) continue; fills++; g.ctx.moveTo(xy[i] + rf, xy[i + 1]); g.ctx.arc(xy[i], xy[i + 1], rf, 0, 2 * Math.PI); }
      if (fills) g.fill(alphaOf(col, 0.16 * q));
      g.begin_();
      for (let i = 0; i < xy.length; i += 4) { const rr = xy[i + 3]; g.ctx.moveTo(xy[i] + rr, xy[i + 1]); g.ctx.arc(xy[i], xy[i + 1], rr, 0, 2 * Math.PI); }
      g.stroke(alphaOf(col, 0.7 * q), 1.2);
    }
  }
  private glowFlash: boolean[] = [];

  // ---- the glance (glance.ts) --------------------------------------------------------------------
  /** The floor's top row after the zoom readout (lens.ts calls it), the strip's replay playhead,
   *  the hotspot callouts and the "since" menu. */
  glance(g: Gfx, fr: Frame, t: number, x0: number, right: number): void {
    this.update(t);
    this.glance0.draw(g, fr, t, x0, right);
  }
}

/** The walking light's glow: radius, opacity (outer to inner). */
const LOOK_GLOW: [number, number][] = [[22, 0.05], [13, 0.09], [6, 0.2], [2.5, 0.6]];

/** w2-glance2: a group ember's words, its first bad metric now against its 7 d, in the window's
 *  terms (the last hour's for a short window, the day's for a long one): "pass 40% (usual 49%)",
 *  "10 red (usual 8)", "builds 45s (usual 39s)". '' when the trend cannot say. */
export function emberFact(t: import('../wire.ts').Trend | null, metrics: readonly string[], short: boolean): string {
  if (!t) return '';
  const k = metrics[0];
  const m = k === 'pass_rate' ? t.pass_rate : k === 'red' ? t.red : k === 'intake_ms' ? t.intake_ms : k === 'run_ms' ? t.run_ms : k === 'pr_age_ms' ? t.pr_age_ms : null;
  if (!m) return '';
  const v = m.h1 ?? m.h24, ty = m.d7; // now (the card's last hour, the verdict's now), whatever the window
  void short;
  if (v === null || v === undefined) return '';
  const sec = (x: number) => (x >= 3_600_000 ? `${Math.round(x / 86_400_000)}d` : `${Math.round(x / 1000)}s`);
  const u = (s: string) => (ty === null || ty === undefined ? '' : ` (usual ${s})`);
  switch (k) {
    case 'pass_rate': return `pass ${Math.round(v * 100)}%${u(`${Math.round((ty ?? 0) * 100)}%`)}`;
    case 'red': return `${Math.round(v)} red${u(String(Math.round(ty ?? 0)))}`;
    case 'intake_ms': return `waits ${sec(v)}${u(sec(ty ?? 0))}`;
    case 'run_ms': return `builds ${sec(v)}${u(sec(ty ?? 0))}`;
    default: return `PRs ${sec(v)} old${u(sec(ty ?? 0))}`;
  }
}

/** Copies the entries (`stride` numbers, the last one a time) whose time is ≤ T into `dst`
 *  without it. */
function gate(src: Nums, stride: number, T: number, dst: Nums): void {
  dst.reset();
  const a = src.a, o = dst.a;
  for (let i = 0; i < src.n; i += stride) {
    if (a[i + stride - 1] > T) continue;
    for (let j = 0; j < stride - 1; j++) o[dst.n++] = a[i + j];
  }
}

function pushN(n: Nums, ...xs: number[]): void { for (const x of xs) n.a[n.n++] = x; }

function hashN(s: string): number { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return h >>> 0; }

const ALPHA_KIND: Record<string, number> = { [C.red]: K_RED, [OK]: K_OK, [C.packet]: K_AMBER, [RIM]: K_INK };
/** A glow colour at an opacity, from fx.ts's table when it has the colour. */
function alphaOf(col: string, a: number): string {
  const k = ALPHA_KIND[col];
  return k !== undefined ? tint(k, a) : withA(col, a);
}
const withACache = new Map<string, string[]>();
function withA(col: string, a: number): string {
  let row = withACache.get(col);
  if (!row) {
    const n = parseInt(col.slice(1), 16);
    row = Array.from({ length: 33 }, (_, q) => `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${(q / 32).toFixed(3)})`);
    withACache.set(col, row);
  }
  return row[Math.round(clamp(a, 0, 1) * 32)];
}

/** A group's word on the floor: an org's short name (`labs`), a team's name. */
export function groupWord(id: string, name?: string): string {
  if (id.startsWith('org:')) return short(id.slice(4));
  const n = name ?? id.slice(id.indexOf(':') + 1);
  return n.length <= 4 && n === n.toUpperCase() ? n : n.toLowerCase();
}

/** v4-verdict (#7): the floor shows a replayed moment (a replay, or a world held off the server: a
 *  replay paused, too much kept), so the verdict reads that hour, and the header says when. */
export function replayed(tl: { mode: string; stale: boolean }): boolean { return tl.mode === 'replay' || (tl.mode !== 'live' && tl.stale); }

function serverKey(server: string): string { return server.trim() || 'origin'; }

function parseVisits(s: string): Record<string, VisitRec> {
  if (!s) return {};
  try {
    const v = JSON.parse(s) as Record<string, VisitRec>;
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch { return {}; }
}

void HOUR; void K_AMBER; void tint;
