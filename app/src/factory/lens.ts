// THE LENS SYSTEM (fab-lens; Felipe's click grammar for the factory floor). Every object on the
// floor is a lens. A click pushes one onto a stack; the lens on top computes a RELATION SET (the
// entities, belts, stages and districts it lights), everything else dims to ~25 % and
// desaturates, and a small story, mostly graphical, is drawn over it: a different story per kind.
//
//   org dock / rail     → that org's repos lit across every stage (their PR stacks, rails, crates
//                         in the engine, apps in the city) and the org's route over the floor
//   repo (a rail car)   → its main line, open PRs, running/queued jobs and its apps
//   PR stack / pallet   → the PRs' journey so far and what blocks them (red check, review, conflict)
//   engine bay          → its job's step chips, the repos this engine served in the last hour, its
//                         utilisation sparkline
//   machine / gauges    → cpu/mem/load over time (HostHistory, client-side) and its queue
//   intake belt         → what waits, how long
//   test scanner        → the failure mix (which steps fail most, which repos)
//   a red crate / car   → its FAILURE CLUSTER: the same failing step across repos, red threads
//   deploy track        → recent deploys on it
//   app building        → the commits that fed it (live_sha, behind), deploy and health history
//   district            → the team's whole pipeline
//   a crate in flight   → its journey and the drawer (the floor's own journey, factory.ts)
//   time-strip tick     → the replay jumps to that moment
//
// Esc / ⌫ walks back up the stack (the breadcrumb, top-left; a chip pops to its level). Shift-click
// adds a second lens: both are lit in their own hue and compared on one card.
//
// Cost: a relation is computed when a lens is pushed and again at most once a second while the
// world changes, O(entities); nothing here runs in a turn that also counted the census.

import type { Ctx2D, Frame } from '../../app.contract.d.ts';
import type { App, Pipeline, Pr, Trend } from '../wire.ts';
import type { World } from '../world.ts';
import { BOTS } from '../world.ts';
import type { Gfx } from '../yard/gfx.ts';
import { C, TAU, clamp, withAlpha } from '../yard/theme.ts';
import { isRed } from '../yard/select.ts';
import { AGES, HOUR, PHASES, failingStep, phaseRow, short, teamOf } from './census.ts';
import { appHistory, beat, groupOf } from './seams.ts';
import type { Census } from './census.ts';
import type { Factory } from './factory.ts';
import { clusterOf, groupOf as insGroupOf, insights, insightsVer } from '../insights.ts';
import { Hover } from './hover.ts';
import { BOTS_LANE, floorGroups } from './groups.ts';
import { drawCompare } from './compare.ts';
import { drawLegend } from './legend.ts'; // fab-w1
import { appHist, appHist7, engineSeries, healthSegs, machineEngines, wantAppHistory, wantEngineHistory } from './lenses.ts';
import { classGlyph, clusterBody, clusterFacts, groupApps, groupFlow, groupForApps, groupForOrg, groupTrend, parkByCluster, ribbonW, trendRows } from './lenses.ts';
import type { ClusterFacts, GroupFlow, ParkGroup, Parked } from './lenses.ts';

/** What the lens system reaches inside the floor (indexed access: a rename fails the build). */
export type FactoryFx = {
  box: Factory['box']; crate: Factory['crate']; car: Factory['car']; quad: Factory['quad']; poly: Factory['poly'];
  hit: Factory['hit']; placeAt: Factory['placeAt']; dockV: Factory['dockV']; railV: Factory['railV'];
  bays: Factory['bays']; blocks: Factory['blocks']; blockAt: Factory['blockAt']; districtBox: Factory['districtBox'];
  hits: Factory['hits']; labels: Factory['labels'];
};
type Hit = Factory['hits'][number];
type Pt = [number, number];

export type LensKind = 'group' | 'org' | 'repo' | 'stack' | 'pallet' | 'pipeline' | 'bay' | 'vm' | 'queue' | 'scanner' | 'failure' | 'track' | 'app' | 'district' | 'fresh' | 'gate';
export type Lens = { kind: LensKind; id: string; name: string; sub: string };

/** The lit set of a lens. */
type Rel = {
  repos: Set<string>; orgs: Set<string>; apps: Set<string>; pipes: Set<string>; cars: Set<string>;
  /** Lit open PRs per PR-yard stack (phase row × age bucket) and per bot pallet; `stackRed` of
   *  them with CI failing. */
  stackN: Int16Array; stackRed: Int16Array; palletN: Map<string, number>;
  groups: Set<number>; tracks: Set<number>; districts: Set<number>; fails: Set<string>;
  scanner: boolean; intake: boolean;
  m: Metrics;
};
/** One lens's numbers (the story card; the compare card's rows). */
type Metrics = {
  repos: number; prs: number; merged24: number; runs: number; failed: number; waits: number[]; red: number;
  apps: number; up: number; down: number; deploys24: number; building: number; queued: number; pushes: number;
};

// palette: the lens's outline is ink; a compare lights its two sides in two group hues
// (OKLCH L .72 C .07 at 250° and 310°: away from amber, red and the green-gray of "ok").
const F_RED = '#E06464'; // the factory's red crate top (factory.ts F.redTop)
/** A parked failure whose cluster recovered (`open` 0): no longer failing, so not red. */
const F_HEALED = '#6A5C5D';
const LIT = '#F2F2F0';
export const HUE_A = '#83A8CF';
export const HUE_B = '#B299C6';
const CARD = '#111112';
const CARD_EDGE = '#2E2E30';
const OK = '#7FC48F';
const SMALL = 12;
const TITLE = 15;

const KIND_WORD: Record<LensKind, string> = {
  group: 'group', org: 'org', repo: 'repo', stack: 'PR stack', pallet: 'bot pallet', pipeline: 'run', bay: 'bay', vm: 'machine', queue: 'intake',
  scanner: 'tests', failure: 'failure cluster', track: 'deploy track', app: 'app', district: 'team', fresh: 'since you looked', gate: 'merge gate',
};

export class Lenses {
  stack: Lens[] = [];
  /** The shift-clicked second lens (compared with the one on top). */
  cmp: Lens | null = null;
  /** The key ("?"): the visual grammar, on demand. */
  legend = false;
  /** The floor's old always-on key is retired: the key is on demand. */
  readonly legacyKey = false;
  readonly hosts = new HostHistory();
  /** fab-w3: hover previews with a micro-chart per kind (hover.ts). */
  readonly hoverCard = new Hover(this);
  /** fab-w3: a press is held (the floor shows no hover while it is: factory.ts pointer). */
  down = false;
  private lastKey = '';
  private lastKeyT = -1;
  /** Failures of the last hour parked on the return conveyor by CLUSTER (fab-w3, overseer note 4):
   *  the same signature together, the biggest open cluster nearest the scanner. */
  parked: Parked[] = [];
  /** The clusters' runs of crates on the conveyor (index = Parked.k). */
  parkGroups: ParkGroup[] = [];
  private rel: Rel | null = null;
  private relB: Rel | null = null;
  private story: Story | null = null;
  private storyB: Story | null = null;
  private relVer = -1;
  private relAt = -1e12;
  parkedKey = '';
  private tick: { x: number; y: number; w: number; h: number; now: number } | null = null;

  constructor(readonly f: Factory) {}

  get fx(): FactoryFx { return this.f.fx; }
  get topLens(): Lens | null { return this.stack.length ? this.stack[this.stack.length - 1] : null; }

  // ---- the stack ---------------------------------------------------------------------------------
  push(l: Lens, t: number): void {
    const top = this.topLens;
    if (top && top.kind === l.kind && top.id === l.id) return;
    if (this.stack.length >= 6) this.stack.shift();
    this.stack.push(l);
    this.enter(t);
  }

  pop(t: number): void {
    if (this.cmp) { this.cmp = null; this.relB = null; return; }
    this.stack.pop();
    this.enter(t);
  }

  popTo(i: number, t: number): void {
    this.cmp = null; this.relB = null;
    this.stack.length = Math.max(0, Math.min(this.stack.length, i + 1));
    this.enter(t);
  }

  clear(t: number): void {
    this.stack = [];
    this.cmp = null; this.relB = null;
    this.enter(t);
  }

  /** The lens on top changed: the journey (a run's story) follows it, the relation is recomputed. */
  private enter(t: number): void {
    void t;
    const top = this.topLens;
    const f = this.f;
    if (top?.kind === 'pipeline') { if (f.selected !== top.id) f.select(top.id, top.sub || 'pipeline'); }
    else if (f.selected) f.select('', '');
    this.rel = null; this.story = null; this.relVer = -1;
    if (top && top.kind !== 'pipeline') this.refresh(true);
    // fab-w3: a lens that reads a server history asks for it here (a pointer turn may fetch; a draw
    // never does): an engine's 24 h, an app's 7 d (lenses.ts, cached a minute)
    this.want(top);
  }

  /** fab-w3: asks for the server history a lens reads (engine 24 h, app 7 d). */
  private want(l: Lens | null): void {
    const f = this.f, clk = f.tl.clock;
    // the machine's Dagger engine first (it carries cpu / mem / load), then a few of its agents
    if (l?.kind === 'vm') for (const id of machineEngines(f.world, f.census.groups[Number(l.id)]).slice(0, 2)) wantEngineHistory(id, clk);
    if (l?.kind === 'app') wantAppHistory(l.id, clk);
  }

  // ---- input -------------------------------------------------------------------------------------
  /** A key on the floor: Esc / Backspace walk back up the stack, ? toggles the key. */
  key(k: string, t: number): Hit | null {
    // fab-w3: one key press reaches both the canvas and the floor's column (both take `key`) at
    // one clock: act on it once, or Esc walks back two steps. A second press comes at a later
    // clock: every live frame advances it (app.ts draws), and the floor draws at least on its
    // 125 ms pulse.
    const dup = k === this.lastKey && t === this.lastKeyT;
    this.lastKey = k; this.lastKeyT = t;
    if (dup) { /* already handled */ } else if (k === 'Escape' || k === 'Backspace') {
      if (this.legend) this.legend = false;
      else if (this.stack.length || this.cmp) this.pop(t);
      else if (this.f.selected) this.f.select('', '');
    } else if (k === '?' || k === '/') this.legend = !this.legend;
    // what the floor shows now: the key, or the lens stack's depth and the top's kind
    if (this.legend) return { x: 0, y: 0, w: 0, h: 0, kind: 'legend', id: 'on', label: 'the key' };
    const top = this.topLens;
    return { x: 0, y: 0, w: 0, h: 0, kind: 'lens', id: String(this.stack.length), label: top ? `${top.kind}:${top.id}` : '' };
  }

  /** A hover reports what is under the pointer; the strip's buttons act on a press, never here. */
  hover(h: Hit | null): Hit | null {
    if (!h) return null;
    if (h.kind === 'replay' || h.kind === 'replay24' || h.kind === 'live' || h.kind === 'tick') return { ...h, kind: `over-${h.kind}` };
    return h;
  }

  /** A click: undefined lets the floor handle it (camera, strip); else what the press returns. */
  click(h: Hit | null, shift: boolean, t: number): Hit | null | undefined {
    if (!h) { if (this.stack.length || this.cmp) { this.clear(t); return null; } return undefined; }
    switch (h.kind) {
      case 'crumb': this.popTo(Number(h.id), t); return h;
      case 'crumbx': this.clear(t); return h;
      case 'legend': this.legend = !this.legend; return h;
      case 'cmpx': this.cmp = null; this.relB = null; return h;
      case 'tick': return { ...h, kind: 'replayAt', id: String(Math.round(this.tickAt(this.f.px))) };
      case 'close': if (this.topLens?.kind === 'pipeline') { this.pop(t); return h; } return undefined;
      case 'zoomin': case 'zoomout': case 'fit': case 'drawer': case 'live': case 'replay': case 'replay24': case 'stage': return undefined;
      default: break;
    }
    const l = this.lensFor(h);
    if (!l) return undefined;
    const top = this.topLens;
    if (shift && top && top.kind !== 'pipeline' && l.kind !== 'pipeline' && !(top.kind === l.kind && top.id === l.id)) {
      this.cmp = l;
      this.relB = null;
      this.want(l);
      this.refresh(true);
      // fab-w3: the press answers what it did: a compare of the top and this (the dock shows them)
      return { ...h, kind: 'compare', id: `${top.kind}:${top.id}|${l.kind}:${l.id}`, label: `${top.name} vs ${l.name}` };
    }
    // the bay on top, clicked again: its job's journey (the drawer)
    if (top && top.kind === 'bay' && l.kind === 'bay' && top.id === l.id && top.sub) {
      this.push({ kind: 'pipeline', id: top.sub, name: this.pipeName(top.sub), sub: 'pipeline' }, t);
      return h;
    }
    if (top && top.kind === l.kind && top.id === l.id) { this.pop(t); return h; }
    this.cmp = null; this.relB = null;
    this.push(l, t);
    return h;
  }

  private pipeName(id: string): string {
    const p = this.f.world.pipelines.get(id);
    return p ? `${repoName(p.repo)} #${p.number}` : id;
  }

  /** The lens a hit opens. */
  private lensFor(h: Hit): Lens | null {
    const f = this.f, w = f.world, c = f.census, P = f.plan;
    switch (h.kind) {
      case 'dock': case 'rail': {
        // fab-w3: a dock opens its GROUP (insights.groupOf: team:/org:); the bots siding stays an org
        const gr = h.id === BOTS ? null : groupForOrg(w, h.id);
        if (gr) return { kind: 'group', id: gr.id, name: gr.name, sub: h.id };
        const d = c.docks.find((x) => x.org === h.id);
        return { kind: 'org', id: h.id, name: d?.short ?? short(h.id), sub: '' };
      }
      case 'commit': {
        const at = h.id.indexOf('@');
        const repo = h.id.slice(0, at), sha = h.id.slice(at + 1);
        const car = c.rails.find((r) => r.org === w.orgOf(repo))?.cars.find((x) => x.repo === repo && x.sha === sha);
        if (car) {
          if (car.culprit || car.state === 'failure' || car.state === 'error') {
            const p = failedRunOf(w, repo, sha);
            if (p?.id) return { kind: 'failure', id: p.id, name: clusterOf(p.id)?.step || failingStep(p), sub: '' };
          }
          return { kind: 'repo', id: repo, name: repoName(repo), sub: sha };
        }
        return { kind: 'pipeline', id: h.id, name: h.label.slice(0, 40) || h.id, sub: 'commit' };
      }
      case 'pipeline': case 'failure': {
        const p = w.pipelines.get(h.id);
        if (p && (p.state === 'failure' || p.state === 'error')) return { kind: 'failure', id: h.id, name: clusterOf(h.id)?.step || failingStep(p), sub: '' };
        const bay = this.fx.bays.find((b) => b.pid === h.id);
        if (bay && p?.state === 'running') return { kind: 'bay', id: `${bay.group},${bay.slot}`, name: `${c.groups[bay.group]?.name ?? 'bay'} · ${bay.slot + 1}`, sub: h.id };
        return { kind: 'pipeline', id: h.id, name: p ? `${repoName(p.repo)} #${p.number}` : h.id, sub: 'pipeline' };
      }
      case 'stack': {
        const [r, b] = h.id.split(',').map(Number);
        return { kind: 'stack', id: h.id, name: `${PHASES[r]} · ${AGE_SHORT[b]}`, sub: '' };
      }
      case 'pallet': return { kind: 'pallet', id: h.id, name: h.id, sub: '' };
      case 'machine': case 'gauge': return { kind: 'vm', id: h.id, name: c.groups[Number(h.id)]?.name ?? 'machine', sub: '' };
      case 'engine': {
        const v = Number(h.id.split(',')[1]);
        const gi = clamp(Math.round((v - P.ENG_V0 - P.ENG_DV / 2) / P.ENG_STEP), 0, Math.max(0, c.groups.length - 1));
        return { kind: 'vm', id: String(gi), name: c.groups[gi]?.name ?? 'machine', sub: '' };
      }
      case 'intake': return { kind: 'queue', id: 'intake', name: 'intake', sub: '' };
      case 'gate': return { kind: 'gate', id: 'gate', name: 'merge gate', sub: '' };
      case 'scanner': case 'return': return { kind: 'scanner', id: 'tests', name: 'tests', sub: '' };
      case 'track': return { kind: 'track', id: h.id, name: VIA_WORDS[Number(h.id)] ?? 'track', sub: '' };
      case 'app': return { kind: 'app', id: h.id, name: h.id, sub: '' };
      case 'district': case 'districtArea': {
        // fab-w3: a district opens the same group lens as its team's dock ("other teams": the district)
        const team = h.label.replace(/ \d+$/, '');
        const gr = team === 'other teams' ? null : groupForApps(w, c.districts.find((x) => x.team === team)?.apps ?? []);
        if (gr) return { kind: 'group', id: gr.id, name: gr.name, sub: 'district' };
        return { kind: 'district', id: team, name: team, sub: '' };
      }
      case 'fresh': return { kind: 'fresh', id: h.id, name: h.label, sub: '' };
      default: return null;
    }
  }

  /** Hover: a quick preview, ≤ 3 short lines (null: the floor's own facts). */
  preview(h: Hit): string[] | null {
    const f = this.f, w = f.world, c = f.census, now = f.tl.playhead;
    switch (h.kind) {
      case 'dock': case 'rail': {
        const d = c.docks.find((x) => x.org === h.id), r = c.rails.find((x) => x.org === h.id);
        const gr = h.id === BOTS ? null : groupForOrg(w, h.id);
        if (gr) return [gr.name, `${gr.repos} repos · ${d?.perHour ?? 0} pushes/h`, `${gr.red} red mains · ${r?.merges1h ?? 0} merged/h`];
        return [`${d?.short ?? short(h.id)}`, `${d?.perHour ?? 0} pushes/h · ${d?.repos ?? 0} repos`, `${r?.red ?? 0} red · ${r?.merges1h ?? 0} merged/h`];
      }
      case 'stack': {
        const [r, b] = h.id.split(',').map(Number);
        const s = c.stacks[r]?.[b];
        if (!s) return null;
        return [`${PHASES[r]} · ${AGE_WORDS_L[b]}`, `${s.n} PRs${s.red ? ` · ${s.red} blocked` : ''}${s.stuck ? ` · ${s.stuck} stale` : ''}`, s.oldest > 0 ? `oldest ${ago(s.oldest)}` : 'what blocks them:'];
      }
      case 'pallet': {
        const p = c.pallets.find((x) => x.bot === h.id);
        return [`${h.id} ${p?.n ?? 0}`, `${p?.stuck ?? 0} stale`, 'click: what blocks them'];
      }
      case 'machine': case 'gauge': {
        const g = c.groups[Number(h.id)];
        if (!g) return null;
        const q = g.hosted ? c.gha.length : c.rr.length;
        return [g.name, `${g.running.length}/${g.slots} busy${g.cpu >= 0 ? ` · cpu ${Math.round(pct(g.cpu))}%` : ''}${g.mem >= 0 ? ` · mem ${Math.round(pct(g.mem))}%` : ''}`, `${q} queued · busy over time:`];
      }
      case 'intake': return ['intake', `${c.waiting} queued${c.oldestWait > 0 ? ` · oldest ${ago(c.oldestWait)}` : ''}`, 'click: each wait'];
      case 'gate': return ['merge gate', `${c.flow.merges} merged/h`, 'click: 24 h of merges'];
      case 'scanner': case 'return': {
        const f1 = c.flow;
        const sm = f.coffee.smokeWords();
        const top = this.parkGroups[0];
        return ['tests', `${f1.finished ? Math.round(((f1.finished - f1.failed) / f1.finished) * 100) : 100}% pass · ${f1.failed} failed/h`, sm ? `smoke: ${sm}` : top ? `worst: ${short2(top.step)} ×${top.n}` : 'runs and failures, 24 h:'];
      }
      case 'failure': {
        const p = w.pipelines.get(h.id);
        if (!p) return null;
        const cl = clusterOf(h.id);
        if (!cl) return [`${repoName(p.repo)} #${p.number}`, `failed at ${failingStep(p)} · ${ago(now - (p.finished ?? p.created))} ago`, p.flaky ? 'flaky: passed on the same sha' : 'click: its failure cluster'];
        return [`${repoName(p.repo)} · ${short2(cl.step)}`, `${cl.class}${p.flaky ? ' · flaky' : ''} · ${ago(now - (p.finished ?? p.created))} ago`, `${cl.count_1h} this hour · ${cl.count} in 24 h · ${cl.open ? `${cl.open} open` : 'healed'}`];
      }
      case 'pipeline': {
        const p = w.pipelines.get(h.id);
        if (!p) return null;
        const el = p.started ? (p.finished ?? now) - p.started : now - p.created;
        const step = p.state === 'running' ? (p.workflows ?? []).flatMap((x) => x.steps ?? []).find((x) => x.state === 'running')?.name : '';
        return [`${repoName(p.repo)} #${p.number}`, `${p.state} · ${ago(el)}${p.expected_ms ? ` of ~${ago(p.expected_ms)}` : ''}`, step ? `at ${step}` : `${p.event} · ${p.branch}`.slice(0, 44)];
      }
      case 'app': {
        const a = w.apps.get(h.id);
        if (!a) return null;
        return [h.id, `${a.health}${a.latency_ms ? ` · ${a.latency_ms} ms` : ''}${a.team ? ` · ${a.team}` : ''}`, `${c.deploys24.get(h.id) ?? 0} deploys in 24 h${a.behind ? ` · ${a.behind} behind` : ''}`];
      }
      case 'track': {
        const i = Number(h.id);
        return [VIA_WORDS[i] ?? 'track', `${c.flow.byVia[VIAS[i]] ?? 0} deploys/h`, 'click: recent deploys'];
      }
      case 'districtArea': case 'district': {
        const d = c.districts.find((x) => x.team === h.label.replace(/ \d+$/, ''));
        if (!d) return null;
        let down = 0;
        for (const id of d.apps) { const a = w.apps.get(id); if (a && a.health !== 'up' && a.health !== 'unknown') down++; }
        const gr = groupForApps(w, d.apps);
        return [`${gr?.name ?? d.team} · ${d.apps.length} apps`, down ? `${down} not up` : 'all up', gr ? `${gr.repos} repos · ${gr.red} red mains` : 'small teams together'];
      }
      case 'commit': {
        const at = h.id.indexOf('@');
        const repo = h.id.slice(0, at), sha = h.id.slice(at + 1);
        const car = c.rails.find((r) => r.org === w.orgOf(repo))?.cars.find((x) => x.repo === repo && x.sha === sha);
        if (!car) return null;
        return [`${repoName(repo)} · ${sha.slice(0, 7)}`, car.title.slice(0, 44), car.culprit ? 'broke main · click: its cluster' : `${car.state} · ${ago(now - car.at)} ago`];
      }
      case 'over-tick': case 'tick': {
        const at = this.tickAt(f.px);
        return [clock(at, f.offsetMin), `${ago(now - at)} ago`, 'click: replay from here'];
      }
      case 'crumb': return [h.label];
      case 'fresh': return [h.label, 'click: light them'];
      default: return null;
    }
  }

  // ---- relations -----------------------------------------------------------------------------------
  /** Recomputes the lit set when the lens changed, or at most once a second while the world does. */
  private refresh(force = false): void {
    const top = this.topLens;
    if (!top || top.kind === 'pipeline') return;
    const w = this.f.world, clk = this.f.tl.clock;
    if (!force && this.rel && (w.ver === this.relVer || clk - this.relAt < 1000)) return;
    this.relVer = w.ver; this.relAt = clk;
    const [rel, story] = this.relate(top);
    this.rel = rel; this.story = story;
    if (this.cmp) { const [rb, sb] = this.relate(this.cmp); this.relB = rb; this.storyB = sb; } else { this.relB = null; this.storyB = null; }
  }

  private relate(l: Lens): [Rel, Story] {
    const f = this.f, w = f.world, c = f.census, now = f.tl.playhead;
    const R = new Set<string>();
    const rel = newRel();
    const st: Story = { kind: l.kind };
    let onlyFails = false;
    switch (l.kind) {
      case 'org': {
        if (l.id === BOTS) { for (const p of w.prs.values()) if (isBot(p) && phaseRow(p) >= 0) R.add(p.repo); }
        else for (const r of w.repos.values()) if (r.org === l.id) R.add(r.id);
        rel.orgs.add(l.id);
        break;
      }
      case 'group': {
        for (const r of w.repos.values()) if (insGroupOf(r.id) === l.id) R.add(r.id);
        break;
      }
      case 'repo': {
        R.add(l.id);
        const r = w.repos.get(l.id);
        st.dots = (r?.main?.recent ?? []).slice(-12).map((d) => ({ state: d.state, culprit: !!d.culprit, sha: d.sha, at: d.at }));
        st.note = r && isRed(r) ? `red ${ago(now - (r.main.since || now))}` : r ? 'green' : '';
        break;
      }
      case 'stack': case 'pallet': {
        const [row, b] = l.kind === 'stack' ? l.id.split(',').map(Number) : [-1, -1];
        const counts = new Map<string, number>();
        let oldest: Pr | null = null, n = 0, stale = 0;
        const prs: [number, string][] = (st.prs = []);
        for (const p of w.prs.values()) {
          const r = phaseRow(p);
          if (r < 0) continue;
          if (l.kind === 'stack') { if (isBot(p) || r !== row || ageBucket(now - p.created) !== b) continue; }
          else if (!isBot(p) || botName(p.author) !== l.id) continue;
          R.add(p.repo);
          n++;
          if (p.stale_ms) stale++;
          const k = blocker(p);
          counts.set(k, (counts.get(k) ?? 0) + 1);
          if (!oldest || p.created < oldest.created) oldest = p;
          if (prs.length < 400) prs.push([Math.max(0, now - p.created), BLOCKERS.find((x) => x[0] === k)?.[1] ?? '#8A8A8E']);
        }
        st.n = n;
        st.blockers = BLOCKERS.filter(([k]) => counts.get(k)).map(([k, col]) => [k, counts.get(k) ?? 0, col] as [string, number, string]);
        st.oldest = oldest ? { label: `${repoName(oldest.repo)} #${oldest.number}`, age: now - oldest.created } : null;
        st.note = stale ? `${stale} stale` : '';
        break;
      }
      case 'bay': {
        const [gi, slot] = l.id.split(',').map(Number);
        const bay = this.fx.bays.find((b) => b.group === gi && b.slot === slot);
        const pid = bay?.pid || l.sub;
        const p = w.pipelines.get(pid);
        const g = c.groups[gi];
        const engines = new Set<string>(g?.engines ?? []);
        if (p?.engine) engines.add(p.engine);
        let served = 0;
        for (const q of w.pipelines.values()) {
          if (!q.engine || !engines.has(q.engine)) continue;
          if ((q.started ?? 0) < now - HOUR) continue;
          R.add(q.repo); served++;
        }
        if (p) R.add(p.repo);
        st.pid = pid; st.gi = gi; st.n = served;
        st.steps = [];
        for (const wf of p?.workflows ?? []) for (const s of wf.steps ?? []) st.steps.push({ name: s.name, state: s.state, wf: wf.name });
        rel.groups.add(gi);
        if (pid) rel.pipes.add(pid);
        break;
      }
      case 'vm': {
        const gi = Number(l.id), g = c.groups[gi];
        st.gi = gi;
        for (const id of g?.running ?? []) { const p = w.pipelines.get(id); if (p) { R.add(p.repo); rel.pipes.add(id); } }
        for (const id of g?.hosted ? c.gha : c.rr) { const p = w.pipelines.get(id); if (p) { R.add(p.repo); rel.pipes.add(id); } }
        rel.groups.add(gi);
        rel.intake = true;
        break;
      }
      case 'queue': {
        st.items = [];
        for (const id of [...c.rr, ...c.gha]) {
          const p = w.pipelines.get(id);
          if (!p) continue;
          R.add(p.repo); rel.pipes.add(id);
          st.items.push({ id, label: repoName(p.repo), v: Math.max(0, now - p.created) });
        }
        rel.intake = true;
        break;
      }
      case 'scanner': {
        const steps = new Map<string, number>(), repos = new Map<string, number>();
        let fin = 0;
        for (const p of w.pipelines.values()) {
          if (!p.finished || p.finished < now - 24 * HOUR || p.finished > now) continue;
          fin++;
          if (p.state !== 'failure' && p.state !== 'error') continue;
          R.add(p.repo);
          const s = failingStep(p);
          steps.set(s, (steps.get(s) ?? 0) + 1);
          repos.set(repoName(p.repo), (repos.get(repoName(p.repo)) ?? 0) + 1);
        }
        st.bars = [...steps].sort((a, b) => b[1] - a[1]).slice(0, 5);
        st.bars2 = [...repos].sort((a, b) => b[1] - a[1]).slice(0, 5);
        st.n = fin;
        rel.scanner = true;
        break;
      }
      case 'failure': {
        // fab-w3: its CLUSTER (v0.5 Step.cluster through insights.ts): the server's 24 h counts,
        // open, flaky, first/last seen and examples; the repos it hit lit across the floor
        const p = w.pipelines.get(l.id);
        const cf = clusterFacts(w, l.id);
        st.cf = cf;
        st.items = [];
        for (const r of cf?.repos ?? []) R.add(r);
        for (const [id, repo, at] of cf?.held ?? []) { rel.fails.add(id); st.items.push({ id, label: repoName(repo), v: at, state: repo }); }
        const me = this.parked.find((x) => x.id === l.id);
        const key = me?.cl ?? cf?.id ?? '';
        for (const x of this.parked) if (key && x.cl === key) rel.fails.add(x.id);
        st.k = me ? me.k : this.parkGroups.findIndex((pg) => pg.cl === key);
        st.note = cf?.step || (p ? failingStep(p) : ''); st.n = cf?.count ?? 0; st.pid = l.id;
        onlyFails = true;
        break;
      }
      case 'track': {
        const i = Number(l.id);
        st.items = [];
        for (const d of w.deploys.values()) {
          if (viaIndex(d.via) !== i || d.started < now - 24 * HOUR || d.started > now) continue;
          rel.apps.add(d.app); R.add(d.repo);
          st.items.push({ id: d.app, label: d.app, v: d.started, state: d.state });
        }
        st.items.sort((a, b) => a.v - b.v);
        rel.tracks.add(i);
        break;
      }
      case 'app': {
        const a = w.apps.get(l.id);
        rel.apps.add(l.id);
        if (a?.repo) R.add(a.repo);
        // its deploys and health over time (the seam's app history, H7)
        const hist = appHistory(l.id);
        st.items = (hist?.deploys ?? []).filter((d) => d.at >= now - 24 * HOUR && d.at <= now).map((d) => ({ id: d.sha, label: d.sha.slice(0, 7), v: d.at, state: d.state }));
        st.items.sort((a2, b2) => a2.v - b2.v);
        st.n = a?.behind ?? 0;
        st.note = a?.health ?? 'unknown';
        st.app = a ?? null;
        const tr = hist?.transitions ?? [];
        st.health = [[Math.max(now - 24 * HOUR, hist?.since ?? now), tr.length ? tr[0].from : a?.health ?? 'unknown'], ...tr.map((x) => [x.at, x.to] as [number, string])];
        break;
      }
      case 'district': {
        // the team's whole pipeline: its apps, and every repo whose group is the team
        const d = c.districts.find((x) => x.team === l.id);
        const votes = new Map<string, number>();
        for (const id of d?.apps ?? []) {
          rel.apps.add(id);
          const a = w.apps.get(id);
          if (a?.repo) { R.add(a.repo); const gid = groupOf(w, a.repo).id; if (gid.startsWith('team:')) votes.set(gid, (votes.get(gid) ?? 0) + 1); }
        }
        let team = '', most = 0;
        for (const [gid, n] of votes) if (n > most) { team = gid; most = n; }
        if (team) for (const r of w.repos.values()) if (groupOf(w, r.id).id === team) R.add(r.id);
        break;
      }
      case 'gate': {
        // 24 h of merges: the merged repos lit, merges per hour as bars
        const bars = new Array<number>(24).fill(0);
        const ttm: number[] = [];
        for (const p of w.prs.values()) {
          if (!p.merged_at || p.merged_at < now - 24 * HOUR || p.merged_at > now) continue;
          R.add(p.repo);
          bars[Math.min(23, Math.floor((now - p.merged_at) / HOUR))]++;
          ttm.push(p.merged_at - p.created);
        }
        st.hours = bars.reverse();
        ttm.sort((a, b) => a - b);
        st.p50 = ttm.length ? ttm[ttm.length >> 1] : 0;
        st.p90 = ttm.length ? ttm[Math.min(ttm.length - 1, Math.floor(ttm.length * 0.9))] : 0;
        st.n = ttm.length;
        break;
      }
      case 'fresh': {
        const set = f.coffee.freshSet(l.id);
        for (const x of set.repos) R.add(x);
        for (const x of set.apps) rel.apps.add(x);
        for (const x of set.fails) rel.fails.add(x);
        onlyFails = set.fails.length > 0;
        break;
      }
      default: break;
    }
    if (l.kind === 'group') { for (const id of groupApps(w, l.id)) rel.apps.add(id); }
    this.fill(R, rel, onlyFails);
    if (l.kind === 'group') { st.gf = groupFlow(w, l.id, rel.repos, rel.apps, now); st.trend = groupTrend(l.id); }
    return [rel, st];
  }

  /** Lights what a repo set touches across the floor and counts it: O(entities). */
  private fill(R: Set<string>, rel: Rel, onlyFails: boolean): void {
    const f = this.f, w = f.world, c = f.census, fx = this.fx, now = f.tl.playhead, m = rel.m;
    for (const r of R) { rel.repos.add(r); rel.orgs.add(w.orgOf(r)); if (isRed(w.repos.get(r))) m.red++; }
    m.repos = R.size;
    for (const rail of c.rails) for (const car of rail.cars) if (R.has(car.repo)) rel.cars.add(`${car.repo}@${car.sha}`);
    for (const p of w.pipelines.values()) {
      if (!R.has(p.repo)) continue;
      const id = p.id ?? '';
      if (p.state === 'running' || p.state === 'pending' || p.state === 'blocked') rel.pipes.add(id);
      if (p.state === 'running' && p.started) m.building++;
      if (p.state === 'pending' || p.state === 'blocked') m.queued++;
      if (p.finished && p.finished >= now - 24 * HOUR && p.finished <= now) {
        m.runs++;
        if (p.state === 'failure' || p.state === 'error') m.failed++;
      }
      if (p.started && p.started >= now - 24 * HOUR && m.waits.length < 400) m.waits.push(Math.max(0, p.started - p.created));
    }
    for (const p of w.prs.values()) {
      if (!R.has(p.repo)) continue;
      if (p.merged_at && p.merged_at >= now - 24 * HOUR && p.merged_at <= now) m.merged24++;
      const r = phaseRow(p);
      if (r < 0) continue;
      m.prs++;
      if (isBot(p)) { const b = botName(p.author); rel.palletN.set(b, (rel.palletN.get(b) ?? 0) + 1); continue; }
      const si = r * 6 + ageBucket(now - p.created);
      rel.stackN[si]++;
      if (p.ci === 'failure' || p.ci === 'error') rel.stackRed[si]++;
    }
    for (const a of w.apps.values()) if (a.repo && R.has(a.repo) && a.id) rel.apps.add(a.id);
    for (const id of rel.apps) {
      const a = w.apps.get(id);
      m.apps++;
      if (a?.health === 'up') m.up++; else if (a?.health === 'down' || a?.health === 'degraded') m.down++;
      const b = fx.blockAt.get(id);
      if (b) rel.districts.add(b.district);
    }
    for (const d of w.deploys.values()) if (rel.apps.has(d.app) && d.started >= now - 24 * HOUR && d.started <= now) m.deploys24++;
    for (const b of fx.bays) if (b.pid && rel.pipes.has(b.pid)) rel.groups.add(b.group);
    if (!onlyFails) for (const x of this.parked) if (R.has(x.repo)) rel.fails.add(x.id);
    for (const cm of w.commits.values()) if (R.has(cm.repo) && cm.at >= now - HOUR && cm.at <= now) m.pushes++;
  }

  // ---- the floor: hits for every object, failures parked on the return conveyor ---------------------
  under(g: Gfx, t: number): void {
    const f = this.f;
    this.hosts.sample(f.census, f.world);
    this.park();
    this.floorHits();
    this.drawParked(g);
    f.coffee.under(g, t);
  }

  /** fab-w3: the last hour's failures parked along the return conveyor BY CLUSTER (lenses.ts
   *  parkByCluster): each signature a tight run of crates, a gap between clusters, the biggest open
   *  cluster nearest the scanner. Recounted with the census (≤ 1/s) or when the clusters change. */
  private park(): void {
    const c = this.f.census, P = this.f.plan;
    const key = `${c.at}|${c.failing.length}|${insightsVer('clusters')}`;
    if (key === this.parkedKey) return;
    this.parkedKey = key;
    const r = parkByCluster(c.failing, this.f.world, P.SCAN_U - 22, 40);
    this.parked = r.parked;
    this.parkGroups = r.groups;
  }

  /** fab-w3: parked failures, grouped. Each cluster of ≥ 2 a thin bracket on the conveyor's front
   *  edge with a tiny count (the nearest open one also names its step); open clusters red, those
   *  that recovered (`open` 0) muted; a flaky failure hatched. */
  private drawParked(g: Gfx): void {
    const f = this.f, P = f.plan, cam = f.cam, fx = this.fx, V = P.RETURN_V;
    if (!this.parked.length) return;
    // perf: small on screen (fleet zoom), parked failures are squares in one path per colour (on
    // native every canvas call is a host round trip); zoomed in, crates
    const small = 8 * cam.s < 11;
    const r = Math.max(2.5, 4 * cam.s);
    if (small) {
      for (const open of [true, false]) {
        let any = false;
        g.begin_();
        for (const x of this.parked) if (x.open === open) { g.ctx.rect(cam.x(x.u, V) - r, cam.y(x.u, V, 6) - r, r * 2, r * 2); any = true; }
        if (any) g.fill(open ? F_RED : F_HEALED);
      }
    } else for (const x of this.parked) this.parkedCrate(g, x);
    // flaky: hatched (it passed on the same sha: noise, not breakage)
    let fl = false;
    g.begin_();
    for (const x of this.parked) {
      if (!x.flaky) continue;
      fl = true;
      if (small) {
        const cx = cam.x(x.u, V), cy = cam.y(x.u, V, 6);
        g.move(cx - r, cy + r * 0.2); g.line(cx - r * 0.2, cy - r);
        g.move(cx - r * 0.6, cy + r); g.line(cx + r, cy - r * 0.6);
        g.move(cx + r * 0.2, cy + r); g.line(cx + r, cy + r * 0.2);
      } else {
        const z = 2 + 6.4, u0 = x.u - 4, v0 = V - 4;
        for (const k of [0.45, 0.95, 1.45]) {
          const a: Pt = k <= 1 ? [u0 + 8 * k, v0] : [u0 + 8, v0 + 8 * (k - 1)], b: Pt = k <= 1 ? [u0, v0 + 8 * k] : [u0 + 8 * (k - 1), v0 + 8];
          g.move(cam.x(a[0], a[1]), cam.y(a[0], a[1], z)); g.line(cam.x(b[0], b[1]), cam.y(b[0], b[1], z));
        }
      }
    }
    if (fl) g.stroke(withAlpha(C.canvas, 0.85), Math.max(1, r * 0.32));
    this.brackets(g, -1);
    for (const x of this.parked) fx.hit(cam.x(x.u, V) - 5, cam.y(x.u, V, 8) - 7, 10, 14, 'failure', x.id, `${repoName(x.repo)} · ${x.step}`);
  }

  /** A parked failure, zoomed in: a red crate, or (its cluster healed) a muted maroon one. */
  private parkedCrate(g: Gfx, x: Parked): void {
    if (x.open) { this.fx.crate(g, x.u, this.f.plan.RETURN_V, 8, true, false); return; }
    this.fx.box(g, x.u - 4, this.f.plan.RETURN_V - 4, 8, 8, 6.4, F_HEALED, '#4A3E3F', '#3E3435', '#7A6A6B', g.hair);
  }

  /** The clusters' brackets on the conveyor's front edge and their counts; `only` ≥ 0 draws that
   *  group alone, lit (the cluster lens). */
  private brackets(g: Gfx, only: number): void {
    const f = this.f, P = f.plan, cam = f.cam, V = P.RETURN_V, vb = V + 8.5, vt = V + 5;
    const gs = this.parkGroups;
    for (const open of only >= 0 ? [true] : [true, false]) {
      let any = false;
      g.begin_();
      gs.forEach((pg, k) => {
        if (only >= 0 ? k !== only : pg.n < 2 || pg.open !== open) return;
        const a = pg.u1 + 4.5, b = pg.u0 - 4.5;
        g.move(cam.x(b, vt), cam.y(b, vt, 0.5)); g.line(cam.x(b, vb), cam.y(b, vb, 0.5)); g.line(cam.x(a, vb), cam.y(a, vb, 0.5)); g.line(cam.x(a, vt), cam.y(a, vt, 0.5));
        any = true;
      });
      if (any) g.stroke(only >= 0 ? LIT : open ? withAlpha(C.red, 0.8) : '#5E5E62', only >= 0 ? 1.4 : 1);
    }
    let named = only >= 0;
    gs.forEach((pg, k) => {
      if (only >= 0 ? k !== only : pg.n < 2) return;
      const um = (pg.u0 + pg.u1) / 2, x = cam.x(um, vb), y = cam.y(um, vb, 0.5) + 14;
      const n = String(pg.n);
      const name = !named && pg.open ? ` ${short2(pg.step)}` : '';
      if (name) named = true;
      const wv = g.width(n, SMALL, true) + (name ? g.width(name, SMALL) : 0);
      const x0 = Math.round(x - g.width(n, SMALL, true) / 2);
      if (only >= 0 || f.floor.level > 0 || f.floor.focusId) { // fab-w1: at fleet zoom the bracket's width says it (hover: the count; the text budget)
      g.fillRect(x0 - 3, y - 11, wv + 6, 14, withAlpha(C.canvas, 0.8));
      g.runs([[n, only >= 0 ? C.ink : pg.open ? C.redText : C.ink3, true], [name, C.ink3]], x0, y, SMALL);
      } // fab-w1
      if (only < 0) this.fx.hit(cam.x(pg.u0 - 4, vb), cam.y(pg.u1, V - 4, 8) - 4, cam.x(pg.u1 + 4, V) - cam.x(pg.u0 - 4, vb), y - cam.y(pg.u1, V - 4, 8) + 8, 'failure', pg.newest, `${pg.step} · ${pg.n} failures`);
    });
  }

  /** The screen rectangle around a floor box (u0, v0, du, dv, h). */
  private rectOf(u0: number, v0: number, du: number, dv: number, h: number): [number, number, number, number] {
    const cam = this.f.cam;
    const x0 = cam.x(u0, v0 + dv), x1 = cam.x(u0 + du, v0);
    const y0 = cam.y(u0, v0, h), y1 = cam.y(u0 + du, v0 + dv, 0);
    return [x0, y0, x1 - x0, y1 - y0];
  }

  private boxHit(u0: number, v0: number, du: number, dv: number, h: number, kind: string, id: string, label: string): void {
    const [x, y, w, hh] = this.rectOf(u0, v0, du, dv, h);
    this.fx.hit(x, y, w, hh, kind, id, label);
  }

  /** Hits along a long thin thing (the scanner, a track, the return conveyor), in short pieces so
   *  a diagonal never claims the floor around it. */
  private segHits(a: Pt, b: Pt, hw: number, h: number, step: number, kind: string, id: string, label: string): void {
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const n = Math.max(1, Math.ceil(len / step));
    for (let i = 0; i < n; i++) {
      const u0 = a[0] + ((b[0] - a[0]) * i) / n, v0 = a[1] + ((b[1] - a[1]) * i) / n;
      const u1 = a[0] + ((b[0] - a[0]) * (i + 1)) / n, v1 = a[1] + ((b[1] - a[1]) * (i + 1)) / n;
      this.boxHit(Math.min(u0, u1) - hw, Math.min(v0, v1) - hw, Math.abs(u1 - u0) + hw * 2, Math.abs(v1 - v0) + hw * 2, h, kind, id, label);
    }
  }

  /** Every object on the floor is a target. Registered first: what the floor draws later (crates,
   *  cars, bays, blocks, labels) is picked before the ground it stands on. */
  private floorHits(): void {
    const f = this.f, c = f.census, P = f.plan, fx = this.fx;
    for (const d of fx.districtBox) this.boxHit(d.u0 - 4, d.v0 - 4, d.u1 - d.u0 + 8, d.v1 - d.v0 + 8, 8, 'districtArea', d.team, `${d.team} ${d.n}`);
    if (!f.w2.on) c.docks.forEach((d) => this.boxHit(P.DOCK_U0, fx.dockV(d.org) - 30, P.DOCK_U1 - P.DOCK_U0, 60, 14, 'dock', d.org, `${d.short} dock`)); // fab-w3: W2 hits its group docks
    if (!f.floor.on) c.rails.forEach((r, i) => this.boxHit(P.RAIL_U0, P.RAIL_V[i] - 9, P.RAIL_U1 - P.RAIL_U0, 18, 6, 'rail', r.org, `${r.short} main lines`));
    if (!f.floor.on) for (let r = 0; r < 4; r++) for (let b = 0; b < 6; b++) { // fab-w1: the lanes hit their own cells, posts, pallets (floor.ts)
      const s = c.stacks[r][b];
      const layers = Math.min(16, Math.ceil(s.n / 3));
      this.boxHit(P.ROW_U[r] - P.ROW_DU / 2, P.AGE_V[b], P.ROW_DU, P.STACK_DV, 4 + layers * 2.6, 'stack', `${r},${b}`, `${PHASES[r]} ${s.n}`);
    }
    if (!f.floor.on) c.pallets.forEach((p, i) => this.boxHit(P.YARD_U0 + 8 + i * 76, P.PALLET_V - 16, 64, 34, 30, 'pallet', p.bot, `${p.bot} ${p.n}`)); // fab-w1
    this.boxHit(P.INTAKE_U0, 258, P.INTAKE_U1 - P.INTAKE_U0, 66, 6, 'intake', 'intake', 'intake');
    this.boxHit(P.GATE_U - 2, P.AISLE_V - 38, 12, 76, 40, 'gate', 'gate', 'merge gate');
    c.groups.forEach((_g, gi) => {
      const v0 = P.ENG_V0 + gi * P.ENG_STEP;
      this.boxHit(P.ENG_U0, v0, P.ENG_U1 - P.ENG_U0, P.ENG_DV, P.ENG_H, 'machine', String(gi), c.groups[gi].name);
      this.boxHit(P.ENG_U1 + 12, v0 + 34, 22, 9, 64, 'gauge', String(gi), c.groups[gi].name);
    });
    this.segHits([P.SCAN_U, 30], [P.SCAN_U, 598], 6, 56, 40, 'scanner', 'tests', 'tests');
    this.segHits([24, P.RETURN_V], [P.SCAN_U, P.RETURN_V], 7, 4, 60, 'return', 'tests', 'return conveyor');
    P.TRACK_V.forEach((v, i) => this.segHits([P.SCAN_U + 12, v], [P.TRACK_U1, v], 8, 3, 36, 'track', String(i), VIA_WORDS[i]));
  }

  // ---- the lens on the floor ---------------------------------------------------------------------
  /** After the floor's labels: the rest dims to ~25 % and desaturates, the relation is lit and the
   *  lens's story is drawn where its things are. A run's lens is the floor's own journey. */
  draw(g: Gfx, ctx: Ctx2D, fr: Frame, t: number): void {
    const top = this.topLens;
    if (!top || top.kind === 'pipeline') return;
    this.refresh();
    const rel = this.rel;
    if (!rel) return;
    this.veil(g, ctx, fr);
    this.fx.labels.length = 0; // the dimmed words no longer claim their places
    const two = !!(this.cmp && this.relB);
    const tint = two ? HUE_A : LIT;
    this.route(g, rel, tint);
    if (two) this.route(g, this.relB!, HUE_B);
    this.lit(g, rel, tint, t);
    if (two) this.lit(g, this.relB!, HUE_B, t);
    this.storyFloor(g, top, t);
    // fab-w3: a compared group draws its own ribbon too (each side in its compare hue)
    if (two && this.cmp?.kind === 'group' && this.storyB) this.groupStory(g, this.storyB, HUE_B, this.relB!);
  }

  /** Dims to ~25 % and desaturates what is drawn so far: a saturation pass (the live layer's
   *  colours go gray, the floor beneath gets a 75 % veil) and a darkening one over the live
   *  layer's own pixels. Under budget pressure, one plain veil. */
  private veil(g: Gfx, ctx: Ctx2D, fr: Frame): void {
    ctx.save();
    if (this.f.budget.quality < 2) {
      ctx.globalCompositeOperation = 'saturation';
      g.fillRect(0, 0, fr.width, fr.height, withAlpha(C.canvas, 0.75));
      ctx.globalCompositeOperation = 'source-atop';
      g.fillRect(0, 0, fr.width, fr.height, withAlpha(C.canvas, 0.62));
    } else g.fillRect(0, 0, fr.width, fr.height, withAlpha(C.canvas, 0.75));
    ctx.restore();
  }

  /** The group's route over the floor: dock → yard → gate → its rails → intake → its bays, and the
   *  tracks to its districts. Faint and dashed: the way, not a thing. */
  private route(g: Gfx, rel: Rel, tint: string): void {
    const f = this.f, c = f.census, P = f.plan, cam = f.cam, fx = this.fx;
    const k = this.topLens?.kind;
    if (k !== 'org' && k !== 'district' && k !== 'repo' && k !== 'fresh' && k !== 'stack' && k !== 'pallet') return;
    const seg: Pt[][] = [];
    // fab-w3: from each lit dock (W2's group lanes, else the org docks) to the aisle; then, past
    // the gate, onto each lit org's rail
    if (f.floor.on) for (const id of this.litLanes(rel)) { const lp = f.floor.lanePath(id); if (lp) seg.push(k === 'stack' || k === 'pallet' ? lp[0] : [...lp[0], ...lp[1]]); } // fab-w1: each lit lane's way
    else for (const dk of this.litDocks(rel)) seg.push([[P.DOCK_U1, dk.v], [P.COLLECT_U, dk.v], [P.COLLECT_U, P.AISLE_V]]);
    if (k !== 'stack' && k !== 'pallet' && !f.floor.on) for (const d of c.docks) {
      if (!rel.orgs.has(d.org)) continue;
      const ri = c.rails.findIndex((r) => r.org === d.org);
      if (ri >= 0) seg.push([[P.COLLECT_U, P.AISLE_V], [P.YARD_U1, P.AISLE_V], [P.GATE_U + 4, P.AISLE_V], [P.RAIL_U0, P.RAIL_V[ri]], [P.RAIL_U1, P.RAIL_V[ri]], [P.INTAKE_U0, 291]]);
    }
    if (k !== 'stack' && k !== 'pallet') {
      for (const b of fx.bays) if (b.pid && rel.pipes.has(b.pid)) seg.push([[P.INTAKE_U1, 291], [P.DIST_U, 291], [P.DIST_U, b.v + b.dv / 2], [b.u, b.v + b.dv / 2]]);
      for (const di of rel.districts) {
        const d = fx.districtBox[di];
        if (d) seg.push([[P.SCAN_U, 330], [P.TRACK_U1, P.TRACK_V[1]], [P.CITY_U0 - 4, (d.v0 + d.v1) / 2], [d.u0, (d.v0 + d.v1) / 2]]);
      }
    }
    g.dash(true, 5, 4);
    g.begin_();
    for (const path of seg) path.forEach(([u, v], i) => (i ? g.line(cam.x(u, v), cam.y(u, v, 1)) : g.move(cam.x(u, v), cam.y(u, v, 1))));
    g.stroke(withAlpha(tint, 0.42), 1.5);
    g.dash(false);
  }

  /** fab-w3: the docks a relation lights. With W2's group docks on: the lanes of its repos (and
   *  the bots siding for a bot org), each at its footprint (v0..v1) and height (groupfloor.ts's
   *  dockH: 4 + 2.6 √pushes/h, ≤ 24); else the lit orgs' own docks. */
  private litDocks(rel: Rel): { v: number; v0: number; v1: number; h: number }[] {
    const f = this.f, c = f.census, fx = this.fx;
    if (!f.w2.on) return c.docks.filter((d) => rel.orgs.has(d.org)).map((d) => { const v = fx.dockV(d.org); return { v, v0: v - 30, v1: v + 30, h: 14 }; });
    const G = floorGroups(), lanes = new Set<string>();
    for (const r of rel.repos) lanes.add(G.laneOfRepo(r));
    if (rel.orgs.has(BOTS)) lanes.add(BOTS_LANE);
    const out: { v: number; v0: number; v1: number; h: number }[] = [];
    for (const gg of f.w2.layout()) {
      if (!lanes.has(gg.lane.id)) continue;
      const p = G.stats(gg.lane.id)?.pushes1h ?? 0;
      out.push({ v: gg.v, v0: gg.v0, v1: gg.v1, h: Math.min(24, 4 + 2.6 * Math.sqrt(Math.max(0, p))) });
    }
    return out;
  }

  /** fab-w1: the lanes a relation lights (its repos' groups; the bots siding for a bot org). */
  private litLanes(rel: Rel): Set<string> {
    const G = floorGroups(), lanes = new Set<string>();
    for (const r of rel.repos) lanes.add(G.laneOfRepo(r));
    if (rel.orgs.has(BOTS)) lanes.add(BOTS_LANE);
    return lanes;
  }

  /** A repo's dock v: its group lane's (W2) when on, else its org's dock. */
  private repoDockV(repo: string): number { return this.f.w2.on ? this.fx.dockV(repo) : this.fx.dockV(this.f.world.orgOf(repo)); }

  /** The relation, lit: each thing redrawn at full colour over the veil, outlined in the tint. */
  private lit(g: Gfx, rel: Rel, tint: string, t: number): void {
    const f = this.f, fx = this.fx, P = f.plan, cam = f.cam, c = f.census, w = f.world, now = f.tl.playhead;
    void t;
    const hw = Math.max(1, g.hair * 2.5);
    // a compare's second side writes its counts beside the first's, in its hue
    const side = tint === HUE_B ? 1 : 0, ncol = side ? HUE_B : tint === HUE_A ? HUE_A : C.ink, ndx = side ? 14 : tint === HUE_A ? -14 : 0;
    // docks: the lit repos' docks (fab-w3: W2's group lanes when on, at their footprint and height)
    for (const dk of this.litDocks(rel)) fx.box(g, P.DOCK_U0, dk.v0, P.DOCK_U1 - P.DOCK_U0, dk.v1 - dk.v0, dk.h, '#2C2C2F', '#1E1E21', '#19191B', tint, hw);
    // the PR yard (fab-w3, overseer note 2): in each stack, the lens's share of its open PRs as a
    // core as tall as that share of the stack, its outline heavier and its top fuller the more PRs
    // it holds, its red slice (CI failing) on the front; the count on top. The card's key says so.
    if (f.floor.on) f.floor.lit(g, rel.repos, rel.cars, rel.palletN, tint, hw, (s, x, y, red) => this.num(g, s, x + ndx, y, red ? (side ? HUE_B : C.redText) : ncol)); // fab-w1: the relation on the lanes
    let maxN = 1;
    for (let i = 0; i < 24; i++) if (rel.stackN[i] > maxN) maxN = rel.stackN[i];
    if (!f.floor.on) for (let r = 0; r < 4; r++) for (let b = 0; b < 6; b++) { // fab-w1
      const i = r * 6 + b, n = rel.stackN[i];
      if (!n) continue;
      const all = Math.max(n, c.stacks[r]?.[b]?.n ?? n);
      const full = 2 + Math.min(16, Math.ceil(all / 3)) * 2.6, z = Math.max(3, full * (n / all));
      const k = Math.sqrt(n / maxN);
      const u0 = P.ROW_U[r] - P.ROW_DU / 2 + 9, v0 = P.AGE_V[b] + 9, du = P.ROW_DU - 18, dv = P.STACK_DV - 18;
      fx.box(g, u0, v0, du, dv, z, '#3E3E42', '#2C2C2F', '#252528', withAlpha(tint, 0.55 + 0.45 * k), hw * (0.6 + 1.8 * k));
      g.begin_(); fx.quad(g, u0, v0, u0 + du, v0 + dv, z); g.fill(withAlpha(tint, 0.08 + 0.42 * k));
      const red = rel.stackRed[i];
      if (red) { g.begin_(); fx.poly(g, [u0, v0 + dv, 0, u0 + du, v0 + dv, 0, u0 + du, v0 + dv, z * (red / n), u0, v0 + dv, z * (red / n)]); g.fill(withAlpha(C.red, 0.8)); }
      const x = cam.x(u0 + du / 2, v0 + dv / 2), y = cam.y(u0 + du / 2, v0 + dv / 2, Math.max(z, full)) - 5;
      this.num(g, String(n), x + ndx, y, red ? (side ? HUE_B : C.redText) : ncol);
    }
    if (!f.floor.on) c.pallets.forEach((p, i) => { // fab-w1
      const n = rel.palletN.get(p.bot);
      if (!n) return;
      const u0 = P.YARD_U0 + 8 + i * 76, v0 = P.PALLET_V - 16;
      g.begin_(); fx.quad(g, u0, v0, u0 + 64, v0 + 34, 3); g.stroke(tint, hw);
      this.num(g, String(n), cam.x(u0 + 32, v0 + 17) + ndx, cam.y(u0 + 32, v0 + 17, 30), ncol);
    });
    // main lines: the lit org's rails, then the lit repos' cars
    if (!f.floor.on) c.rails.forEach((r, i) => { // fab-w1
      if (!rel.orgs.has(r.org)) return;
      const v = P.RAIL_V[i];
      g.begin_();
      g.move(cam.x(P.RAIL_U0, v - 3), cam.y(P.RAIL_U0, v - 3)); g.line(cam.x(P.RAIL_U1, v - 3), cam.y(P.RAIL_U1, v - 3));
      g.move(cam.x(P.RAIL_U0, v + 3), cam.y(P.RAIL_U0, v + 3)); g.line(cam.x(P.RAIL_U1, v + 3), cam.y(P.RAIL_U1, v + 3));
      g.stroke(withAlpha(tint, 0.55), g.hair * 2);
      const n = r.cars.length;
      r.cars.forEach((car, k) => {
        if (!rel.cars.has(`${car.repo}@${car.sha}`)) return;
        const u = P.RAIL_U1 - 12 - (n - 1 - k) * 10;
        if (u < P.RAIL_U0 + 4) return;
        const run = car.state === 'running' || car.state === 'pending';
        fx.car(g, u, v, car.culprit, !run && !car.culprit);
      });
    });
    // intake: the lit queued crates
    [c.rr, c.gha].forEach((ids, lane) => ids.slice(0, 8).forEach((id, k) => {
      if (!rel.pipes.has(id)) return;
      const u = P.INTAKE_U1 - 10 - k * 11, v = P.LANE_V[lane];
      fx.crate(g, u, v, 8, false, true);
      this.ring(g, u, v, 7, 2, tint);
    }));
    if (rel.intake) { g.begin_(); fx.quad(g, P.INTAKE_U0, 258, P.INTAKE_U1, 324, 6); g.stroke(withAlpha(tint, 0.7), hw); }
    // the engine: lit machines, lit bays with their crates and progress
    for (const gi of rel.groups) {
      const v0 = P.ENG_V0 + gi * P.ENG_STEP;
      g.begin_(); fx.quad(g, P.ENG_U0, v0, P.ENG_U1, v0 + P.ENG_DV, P.ENG_H); g.stroke(withAlpha(tint, 0.8), hw);
    }
    for (const b of fx.bays) {
      if (!b.pid || !rel.pipes.has(b.pid)) continue;
      const p = w.pipelines.get(b.pid);
      g.begin_(); fx.quad(g, b.u, b.v, b.u + b.du, b.v + b.dv, P.ENG_H); g.fill('#2A2216');
      g.begin_(); fx.quad(g, b.u, b.v, b.u + b.du, b.v + b.dv, P.ENG_H); g.stroke(C.packet, hw);
      const exp = p?.expected_ms ?? w.stats.p50_build_ms ?? 0;
      const el = p?.started ? Math.max(0, now - p.started) : 0;
      const u01 = exp > 0 ? clamp(el / exp, 0.03, 1) : 0.5;
      g.begin_(); fx.quad(g, b.u, b.v + b.dv + 4, b.u + b.du * u01, b.v + b.dv + 9, P.ENG_H); g.fill(exp > 0 && el > exp * 1.5 ? C.red : C.packet);
      fx.crate(g, b.u + 6 + (b.du - 12) * u01, b.v + b.dv / 2, 10, false, false, P.ENG_H - 3);
    }
    // the scanner, the tracks
    if (rel.scanner) {
      g.begin_(); fx.quad(g, P.SCAN_U - 4, 30, P.SCAN_U + 4, 598, 56); g.fill(withAlpha(C.red, 0.35));
      g.begin_(); fx.quad(g, P.SCAN_U - 4, 30, P.SCAN_U + 4, 598, 56); g.stroke(withAlpha(tint, 0.8), hw);
    }
    for (const i of rel.tracks) {
      const v = P.TRACK_V[i];
      g.begin_();
      g.move(cam.x(P.SCAN_U + 10, v - 3), cam.y(P.SCAN_U + 10, v - 3)); g.line(cam.x(P.TRACK_U1, v - 3), cam.y(P.TRACK_U1, v - 3));
      g.move(cam.x(P.SCAN_U + 10, v + 3), cam.y(P.SCAN_U + 10, v + 3)); g.line(cam.x(P.TRACK_U1, v + 3), cam.y(P.TRACK_U1, v + 3));
      g.stroke(tint, g.hair * 2.5);
    }
    // the city: lit blocks with their health lights, deploys in flight to them
    const lights = new Map<string, number[]>();
    for (const b of fx.blocks) {
      if (!rel.apps.has(b.id)) continue;
      fx.box(g, b.u, b.v, b.d, b.d, b.h, '#3C3C40', '#28282B', '#202023', withAlpha(tint, 0.9), g.hair * 1.5);
      const col = healthCol(w.apps.get(b.id)?.health);
      let l = lights.get(col); if (!l) lights.set(col, (l = []));
      l.push(cam.x(b.u + b.d / 2, b.v + b.d / 2), cam.y(b.u + b.d / 2, b.v + b.d / 2, b.h + 1.5));
    }
    const r = Math.max(1.4, Math.min(3, cam.s * 2.2));
    for (const [col, xy] of lights) { g.begin_(); for (let i = 0; i < xy.length; i += 2) g.circle(xy[i], xy[i + 1], r); g.fill(col); }
    const lanes = [0, 0, 0];
    for (const d of [...c.deploying].sort((a, b) => a.started - b.started)) {
      const k = clamp(Math.min((now - d.started) / 90_000, 0.92 - lanes[d.via]++ * 0.09), 0.05, 0.92);
      if (!rel.apps.has(d.app)) continue;
      const u = P.SCAN_U + 16 + (P.TRACK_U1 - P.SCAN_U - 24) * k;
      fx.crate(g, u, P.TRACK_V[d.via], 8, false, false);
    }
    // failures parked on the return conveyor: the lit ones over the veil, as the floor draws them
    // (fab-w3: no ring per crate; a cluster's run reads as one group)
    const small = 8 * cam.s < 11, pr = Math.max(2.5, 4 * cam.s);
    let anyP = false;
    g.begin_();
    for (const x of this.parked) {
      if (!rel.fails.has(x.id)) continue;
      if (small) { g.ctx.rect(cam.x(x.u, P.RETURN_V) - pr, cam.y(x.u, P.RETURN_V, 6) - pr, pr * 2, pr * 2); anyP = true; } else this.parkedCrate(g, x);
    }
    if (anyP) g.fill(F_RED);
  }

  // ---- stories on the floor ------------------------------------------------------------------------
  private storyFloor(g: Gfx, l: Lens, t: number): void {
    const st = this.story;
    if (!st) return;
    switch (l.kind) {
      case 'repo': return this.repoStory(g, l, st);
      case 'stack': case 'pallet': return this.stackStory(g, l, st);
      case 'bay': return this.bayStory(g, st, t);
      case 'vm': return this.vmStory(g, st);
      case 'queue': return this.queueStory(g, st);
      case 'scanner': return this.scannerStory(g, st);
      case 'failure': return this.clusterStory(g, st, t);
      case 'group': return this.groupStory(g, st, this.cmp && this.relB ? HUE_A : '', this.rel!);
      case 'track': return this.trackStory(g, l, st);
      case 'app': return this.appStory(g, l, st);
      case 'gate': return this.gateStory(g);
      case 'fresh': return this.freshStory(g, l);
      default: return;
    }
  }

  /** repo: its main line called out over its newest car, the last 12 runs of main as squares. */
  private repoStory(g: Gfx, l: Lens, st: Story): void {
    const f = this.f, c = f.census, P = f.plan, cam = f.cam;
    let u = 0, v = 0;
    if (f.floor.on) { // fab-w1: the repo's car on its lane's rail (else its post)
      const at = (l.sub ? f.floor.carSpot(`${l.id}@${l.sub}`) : null) ?? f.floor.repoSpot(l.id);
      if (!at) return;
      [u, v] = at;
      this.ring(g, u, v, 7, 5, LIT);
    } else {
    const ri = c.rails.findIndex((r) => r.org === f.world.orgOf(l.id));
    const rail = c.rails[ri];
    if (!rail) return;
    const n = rail.cars.length;
    let k = -1;
    for (let i = n - 1; i >= 0; i--) if (rail.cars[i].repo === l.id && (k < 0 || rail.cars[i].sha === l.sub)) { k = i; if (!l.sub || rail.cars[i].sha === l.sub) break; }
    u = k >= 0 ? P.RAIL_U1 - 12 - (n - 1 - k) * 10 : P.RAIL_U1 - 12; v = P.RAIL_V[ri];
    if (k >= 0) this.ring(g, u, v, 7, 5, LIT);
    } // fab-w1
    const dots = st.dots ?? [];
    const name = repoName(l.id);
    const wv = g.width(name, SMALL, true) + 10 + dots.length * 9;
    const at = this.place(cam.x(u, v), cam.y(u, v, 6), wv, 38);
    if (!at) return;
    const [x, y] = at;
    g.fillRect(x - 4, y - 14, wv + 8, 20, withAlpha(CARD, 0.92));
    g.text(name, x, y, C.ink, SMALL, true);
    let dx = x + g.width(name, SMALL, true) + 10;
    for (const d of dots) {
      const bad = d.state === 'failure' || d.state === 'error', run = d.state === 'running' || d.state === 'pending';
      g.fillRect(dx, y - 9, 7, 9, bad ? C.red : run ? C.packet : '#5A6E5F');
      if (d.culprit) { g.begin_(); g.rect(dx - 1.5, y - 10.5, 10, 12); g.stroke(C.redText, 1); }
      if (d.sha === l.sub) g.fillRect(dx, y + 2, 7, 1.5, C.ink);
      dx += 9;
    }
  }

  /** stack / pallet: what blocks these PRs, as one stacked bar over the stack; the PRs came from
   *  their docks (the route) and wait for the merge gate ahead (dashed). */
  private stackStory(g: Gfx, l: Lens, st: Story): void {
    const f = this.f, P = f.plan, cam = f.cam, c = f.census;
    let u = 0, v = 0, z = 0;
    if (l.kind === 'stack') {
      const [r, b] = l.id.split(',').map(Number);
      u = P.ROW_U[r]; v = P.AGE_V[b] + P.STACK_DV / 2; z = 4 + Math.min(16, Math.ceil((c.stacks[r]?.[b]?.n ?? 0) / 3)) * 2.6;
    } else {
      const i = c.pallets.findIndex((p) => p.bot === l.id);
      u = P.YARD_U0 + 40 + i * 76; v = P.PALLET_V + 1; z = 30;
      const pb = f.floor.on ? f.floor.palletBox(l.id) : null; // fab-w1: its pallet on the bots' siding
      if (pb) { u = pb[0] + pb[2] / 2; v = pb[1] + pb[3] / 2; z = pb[4]; }
    }
    // ahead: the aisle to the merge gate
    g.dash(true, 3, 4);
    g.begin_(); g.move(cam.x(u, v), cam.y(u, v, 1)); g.line(cam.x(u, P.AISLE_V), cam.y(u, P.AISLE_V, 1)); g.line(cam.x(P.GATE_U + 4, P.AISLE_V), cam.y(P.GATE_U + 4, P.AISLE_V, 1));
    g.stroke(withAlpha(C.ink3, 0.7), 1.2);
    g.dash(false);
    this.ring(g, u, v, 18, z, LIT);
    const bl = st.blockers ?? [];
    const total = bl.reduce((a, x) => a + x[1], 0);
    if (!total) return;
    const W = 150;
    const at = this.place(cam.x(u, v), cam.y(u, v, z), W, 44);
    if (!at) return;
    const [x, y] = at;
    g.fillRect(x - 6, y - 26, W + 12, 36, withAlpha(CARD, 0.92));
    let bx = x;
    for (const [, n, col] of bl) { const ww = (n / total) * W; g.fillRect(bx, y - 20, Math.max(1, ww - 1), 9, col); bx += ww; }
    // the two biggest named, by their colour
    const top2 = [...bl].sort((a, b) => b[1] - a[1]).slice(0, 2);
    let tx = x;
    for (const [k, n, col] of top2) { tx = g.runs([[`${n} `, C.ink, true], [k, textCol(col)]], tx, y + 4, SMALL) + 12; }
  }

  /** fab-w3: the stack FANNED OUT by age (FACTORY-SPEC \u00a7D "its PRs exploded by age; age
   *  ladder"), in the story card: a log-age axis (young left, old right) across the stack's age
   *  band, every PR one tile in its blocker's colour, stacked where ages coincide. Returns its height. */
  private ageLadder(g: Gfx, l: Lens, st: Story, x: number, y: number, W: number, paint: boolean): number {
    const prs = st.prs ?? [];
    if (!prs.length) return 0;
    if (!paint) return 52;
    const b = l.kind === 'stack' ? Number(l.id.split(',')[1]) : -1;
    const ages = prs.map((p) => p[0]);
    const maxAge = Math.max(...ages), minAge = Math.min(...ages);
    const lo = b > 0 ? AGES[b - 1] : b === 0 ? 60_000 : Math.max(60_000, minAge), hi = b >= 0 && b < 5 ? AGES[b] : Math.max(lo * 2, maxAge);
    const H = 30, y0 = y + H, cols = Math.floor(W / 6);
    const col = (age: number) => clamp(Math.floor((Math.log(Math.max(age, lo) / lo) / Math.log(hi / lo)) * cols), 0, cols - 1);
    const n = new Array<number>(cols).fill(0);
    const sorted = [...prs].sort((p, q) => p[0] - q[0]);
    for (const [age, c] of sorted) {
      const k = col(age), r = n[k]++;
      if (r >= 7) continue;
      g.fillRect(x + k * 6, y0 - (r + 1) * 4.2, 5, 3.4, c);
    }
    g.hline(x, x + W, y0 + 1.5, '#3A3A3E', 1);
    const word = (ms: number) => (ms >= 24 * HOUR ? `${Math.round(ms / (24 * HOUR))} d` : ms >= HOUR ? `${Math.round(ms / HOUR)} h` : `${Math.max(1, Math.round(ms / 60_000))} m`);
    g.text(word(lo), x, y0 + 15, C.ink3, SMALL);
    g.text('age (log)', x + W / 2, y0 + 15, '#5E5E62', SMALL, false, 'center');
    g.text(word(hi === Infinity ? maxAge : hi), x + W, y0 + 15, C.ink3, SMALL, false, 'right');
    return 52;
  }

  /** bay: its job's steps as a strip of chips over the bay (dashed: pending; amber: running; red:
   *  failed; gray-green: passed), the running step named. */
  private bayStory(g: Gfx, st: Story, t: number): void {
    const f = this.f, fx = this.fx, cam = f.cam, P = f.plan;
    const bay = fx.bays.find((b) => b.pid === st.pid);
    if (!bay) return;
    const steps = st.steps ?? [];
    const ax = cam.x(bay.u + bay.du / 2, bay.v), ay = cam.y(bay.u + bay.du / 2, bay.v, P.ENG_H);
    const cw = 11, gap = 3, n = Math.min(28, steps.length);
    const run = steps.find((s) => s.state === 'running');
    const words = run ? run.name : steps.length ? `${steps.filter((s) => s.state === 'success').length}/${steps.length} steps` : 'no steps reported';
    const wv = n * (cw + gap) + 8 + g.width(words, SMALL);
    const at = this.place(ax, ay, wv, 40);
    if (!at) return;
    const [x, y] = at;
    g.fillRect(x - 6, y - 20, wv + 12, 26, withAlpha(CARD, 0.92));
    g.begin_(); g.move(ax, ay); g.line(Math.min(Math.max(ax, x), x + wv), y + 6); g.stroke('#5A5A5E', 1);
    for (let i = 0; i < n; i++) {
      const s = steps[i], cx = x + i * (cw + gap);
      const bad = s.state === 'failure' || s.state === 'error', on = s.state === 'running';
      if (bad || on || s.state === 'success' || s.state === 'skipped') g.fillRect(cx, y - 14, cw, 14, bad ? C.red : on ? withAlpha(C.packet, 0.55 + 0.45 * beat(t)) : s.state === 'skipped' ? '#2A2A2D' : '#5A6E5F');
      else { g.dash(true, 2, 2); g.begin_(); g.rect(cx + 0.5, y - 13.5, cw - 1, 13); g.stroke('#6A6A6E', 1); g.dash(false); }
    }
    g.text(words, x + n * (cw + gap) + 6, y - 2, run ? C.amberText : C.ink2, SMALL);
  }

  /** machine: its queue walks to it (the intake's crates for its lane, a dashed line). */
  private vmStory(g: Gfx, st: Story): void {
    const f = this.f, P = f.plan, cam = f.cam, c = f.census;
    const gi = st.gi ?? 0, gr = c.groups[gi];
    if (!gr) return;
    const v0 = P.ENG_V0 + gi * P.ENG_STEP + P.ENG_DV / 2;
    const lane = gr.hosted ? 1 : 0;
    g.dash(true, 4, 3);
    g.begin_(); g.move(cam.x(P.INTAKE_U1, P.LANE_V[lane]), cam.y(P.INTAKE_U1, P.LANE_V[lane], 1)); g.line(cam.x(P.DIST_U, P.LANE_V[lane]), cam.y(P.DIST_U, P.LANE_V[lane], 1));
    g.line(cam.x(P.DIST_U, v0), cam.y(P.DIST_U, v0, 1)); g.line(cam.x(P.ENG_U0, v0), cam.y(P.ENG_U0, v0, 1));
    g.stroke(withAlpha(LIT, 0.6), 1.5);
    g.dash(false);
    // the gauges, lit at their values
    const vals = [gr.cpu, gr.mem];
    vals.forEach((val, k) => {
      if (val < 0) return;
      const hh = 2 + 60 * clamp(pct(val) / 100, 0, 1);
      const u0 = P.ENG_U1 + 12 + k * 13, vv = P.ENG_V0 + gi * P.ENG_STEP + 34;
      this.fx.box(g, u0, vv, 9, 9, hh, pct(val) >= 90 ? C.red : '#C9C9CC', '#8A8A8E', '#6E6E72', LIT, g.hair);
    });
    // fab-w3: the machine's back wall becomes its 24 h chart (FACTORY-SPEC §D): busy share as an
    // amber tide, cpu and mem as lines, a red tick under every stretch with every slot busy
    const es = engineSeries(this.hosts, gr, machineEngines(f.world, gr));
    if (!es || es.busy.length < 2) return;
    const fx = this.fx, vb = P.ENG_V0 + gi * P.ENG_STEP, z0 = P.ENG_H + 1, WH = 54, ua = P.ENG_U0 + 4, ub = P.ENG_U1 - 4;
    const n = es.busy.length, du = (ub - ua) / (n - 1);
    const X = (i: number) => cam.x(ua + du * i, vb), Y = (i: number, k: number) => cam.y(ua + du * i, vb, z0 + clamp(k, 0, 1) * WH);
    g.begin_(); fx.poly(g, [ua, vb, z0, ub, vb, z0, ub, vb, z0 + WH, ua, vb, z0 + WH]); g.fill(withAlpha('#111113', 0.94));
    g.begin_(); fx.poly(g, [ua, vb, z0, ub, vb, z0, ub, vb, z0 + WH, ua, vb, z0 + WH]); g.stroke('#3A3A3E', 1);
    // the hours: a hairline every 6 h of a 24 h wall
    if (es.span === '24 h') { g.begin_(); for (let hh = 6; hh < 24; hh += 6) { const i = (hh / 24) * (n - 1); g.move(X(i), Y(i, 0)); g.line(X(i), Y(i, 1)); } g.stroke('#232326', 1); }
    g.begin_(); g.move(X(0), Y(0, 0));
    for (let i = 0; i < n; i++) g.line(X(i), Y(i, (es.busy[i] ?? 0) / 100));
    g.line(X(n - 1), Y(n - 1, 0)); g.ctx.closePath(); g.fill(withAlpha(C.packet, 0.5));
    const ln = (s: (number | null)[], col: string) => {
      g.begin_(); let first = true;
      for (let i = 0; i < s.length; i++) { const v = s[i]; if (v === null) { first = true; continue; } if (first) { g.move(X(i), Y(i, v / 100)); first = false; } else g.line(X(i), Y(i, v / 100)); }
      g.stroke(col, 1.2);
    };
    ln(es.cpu, C.ink); ln(es.mem, '#7E8FA6');
    g.begin_(); for (let i = 0; i < n; i++) if (es.full[i]) g.rect(X(i) - 1, Y(i, 0) - 1, Math.max(2, X(Math.min(n - 1, i + 1)) - X(i)), 3); g.fill(C.red);
    // its words: the span, and the line colours
    const lx = X(0) + 4, ly = Y(0, 1) + 14;
    g.fillRect(lx - 3, ly - 11, g.width(`${es.span}  busy  cpu  mem`, SMALL, true) + 6, 15, withAlpha('#111113', 0.9));
    g.runs([[es.span, C.ink2, true], ['  busy', C.amberText], ['  cpu', C.ink], ['  mem', '#9AA8BC']], lx, ly, SMALL);
  }

  /** intake: each queued crate's wait as a bar over it. */
  private queueStory(g: Gfx, st: Story): void {
    const f = this.f, P = f.plan, cam = f.cam, c = f.census;
    const max = Math.max(60_000, ...(st.items ?? []).map((x) => x.v));
    [c.rr, c.gha].forEach((ids, lane) => ids.slice(0, 8).forEach((id, k) => {
      const it = st.items?.find((x) => x.id === id);
      if (!it) return;
      const u = P.INTAKE_U1 - 10 - k * 11, v = P.LANE_V[lane];
      const x = cam.x(u, v), y = cam.y(u, v, 8);
      const h = 6 + (it.v / max) * 54;
      g.fillRect(x - 2, y - h - 4, 4, h, withAlpha(C.packet, 0.75));
    }));
    const oldest = (st.items ?? []).reduce((a, b) => (b.v > a.v ? b : a), { id: '', label: '', v: 0 });
    if (oldest.id) {
      const x = cam.x(P.INTAKE_U1, P.LANE_V[0]), y = cam.y(P.INTAKE_U1, P.LANE_V[0], 8) - 70;
      const at = this.place(x, y + 40, g.width(`${oldest.label} waits ${ago(oldest.v)}`, SMALL), 20);
      if (at) { g.fillRect(at[0] - 4, at[1] - 13, g.width(`${oldest.label} waits ${ago(oldest.v)}`, SMALL) + 8, 18, withAlpha(CARD, 0.92)); g.runs([[oldest.label, C.ink], [` waits ${ago(oldest.v)}`, C.amberText]], at[0], at[1], SMALL); }
    }
  }

  /** tests: red threads from the scanner to the rails of the repos that fail. */
  private scannerStory(g: Gfx, st: Story): void {
    void st;
    const f = this.f, P = f.plan, cam = f.cam, c = f.census, rel = this.rel;
    if (!rel) return;
    const kx = cam.x(P.SCAN_U, 300), ky = cam.y(P.SCAN_U, 300, 56);
    g.begin_();
    if (f.floor.on) for (const repo of rel.repos) { const at = f.floor.culpritSpot(repo); if (at) this.thread(g, kx, ky, cam.x(at[0], at[1]), cam.y(at[0], at[1], 6)); } // fab-w1: the lanes' culprits
    if (!f.floor.on) c.rails.forEach((r, i) => { // fab-w1
      const n = r.cars.length;
      r.cars.forEach((car, k) => {
        if (!car.culprit || !rel.repos.has(car.repo)) return;
        const u = P.RAIL_U1 - 12 - (n - 1 - k) * 10;
        if (u < P.RAIL_U0 + 4) return;
        this.thread(g, kx, ky, cam.x(u, P.RAIL_V[i]), cam.y(u, P.RAIL_V[i], 6));
      });
    });
    for (const x of this.parked) if (rel.fails.has(x.id)) this.thread(g, kx, ky, cam.x(x.u, P.RETURN_V), cam.y(x.u, P.RETURN_V, 8));
    g.stroke(withAlpha(C.red, 0.55), 1);
    g.begin_(); g.circle(kx, ky, 4); g.fill(C.red);
  }

  /** a failure: its CLUSTER, every failure of the same step (or the same workflow/step) across
   *  repos, lit and tied to one knot over the scanner by thin red threads. */
  private clusterStory(g: Gfx, st: Story, t: number): void {
    const f = this.f, P = f.plan, cam = f.cam, c = f.census, w = f.world, rel = this.rel;
    if (!rel) return;
    // fab-w3: the knot rides over the cluster's own run of crates on the return conveyor (its
    // bracket lit), threads from there to every repo the cluster hit
    const pg = st.k !== undefined && st.k >= 0 ? this.parkGroups[st.k] : undefined;
    const ku = pg ? (pg.u0 + pg.u1) / 2 : P.SCAN_U - 30;
    const kx = cam.x(ku, P.RETURN_V), ky = cam.y(ku, P.RETURN_V, 8) - 46;
    if (pg) {
      this.brackets(g, st.k ?? -1);
      // the pressed failure, outlined in its run
      const me = this.parked.find((x) => x.id === st.pid);
      if (me) { const r = Math.max(3.5, 5 * cam.s), mx = cam.x(me.u, P.RETURN_V), my = cam.y(me.u, P.RETURN_V, 6); g.begin_(); g.rect(mx - r, my - r, r * 2, r * 2); g.stroke(LIT, 1.4); }
      g.begin_(); g.move(kx, ky); g.line(cam.x(ku, P.RETURN_V), cam.y(ku, P.RETURN_V, 8) - 6); g.stroke(withAlpha(C.red, 0.5), 1);
    }
    const ends: [number, number, string][] = [];
    const seen = new Set<string>();
    // members: at their repo's red car on its rail, else at their org's dock
    const repos = [...new Set([...(st.cf?.repos ?? []), ...(st.items ?? []).map((i) => i.state ?? '')])];
    for (const repo of repos) {
      if (!repo || seen.has(repo)) continue;
      seen.add(repo);
      const it = { label: repoName(repo) };
      const cs = f.floor.on ? f.floor.culpritSpot(repo) : null; // fab-w1: its red car (or post) on its lane
      if (cs) { ends.push([cam.x(cs[0], cs[1]), cam.y(cs[0], cs[1], 6), it.label]); continue; }
      const ri = f.floor.on ? -1 : c.rails.findIndex((r) => r.org === w.orgOf(repo));
      const rail = c.rails[ri];
      const k = rail ? rail.cars.findIndex((x) => x.repo === repo && x.culprit) : -1;
      if (rail && k >= 0) {
        const u = P.RAIL_U1 - 12 - (rail.cars.length - 1 - k) * 10;
        if (u >= P.RAIL_U0 + 4) { ends.push([cam.x(u, P.RAIL_V[ri]), cam.y(u, P.RAIL_V[ri], 6), it.label]); continue; }
      }
      const dv = this.repoDockV(repo);
      ends.push([cam.x(P.DOCK_U1, dv), cam.y(P.DOCK_U1, dv, 14), it.label]);
    }
    g.begin_();
    for (const [x, y] of ends) this.thread(g, kx, ky, x, y);
    g.stroke(withAlpha(C.red, 0.7), 1);
    // members: a red diamond each, the nearest named
    g.begin_();
    for (const [x, y] of ends) { g.move(x, y - 4); g.line(x + 4, y); g.line(x, y + 4); g.line(x - 4, y); g.ctx.closePath(); }
    g.fill(C.red);
    let named = 0;
    for (const [x, y, s] of ends) {
      if (named >= 8) break;
      const wv = g.width(s, SMALL);
      const at = this.fx.placeAt(Math.round(x + 7), Math.round(y + 4), wv, 14, 3, true);
      if (!at) continue;
      g.fillRect(at[0] - 3, at[1] - 11, wv + 6, 15, withAlpha(CARD, 0.88));
      g.text(s, at[0], at[1], C.redText, SMALL);
      named++;
    }
    // the knot, beating slowly
    const pulse = beat(t);
    g.begin_(); g.circle(kx, ky, 7 + pulse * 3); g.fill(withAlpha(C.red, 0.18));
    g.begin_(); g.circle(kx, ky, 4.5); g.fill(C.red);
    // its signature, by its class glyph, and the 24 h count
    const s = `${short2(st.note ?? '')} ×${st.cf?.count ?? (st.items ?? []).length}`;
    const wv = g.width(s, SMALL, true) + 16;
    const at = this.fx.placeAt(Math.round(kx - wv / 2), Math.round(ky - 12), wv, 15, 4, true);
    if (at) {
      g.fillRect(at[0] - 4, at[1] - 12, wv + 8, 16, withAlpha(CARD, 0.92));
      classGlyph(g, st.cf?.cls ?? '', at[0] + 5, at[1] - 4, C.redText);
      g.text(s, at[0] + 16, at[1], C.redText, SMALL, true);
    }
  }

  /** fab-w3, group: ONE coloured ribbon in the group's hue through every stage (FACTORY-SPEC §D,
   *  a one-group Sankey), its width the group's share of the fleet's flow there: commits from each
   *  of its orgs' docks, open PRs through the yard, merges over the gate onto the rails, runs
   *  through the intake and the engine, deploys down the track into its districts; at the scanner
   *  a red side-ribbon (its failures) peels off home along the return conveyor. */
  private groupStory(g: Gfx, st: Story, hue: string, rel: Rel): void {
    const gf0 = st.gf;
    if (!gf0 || !rel) return;
    const gf = hue ? { ...gf0, hue } : gf0;
    const f = this.f, P = f.plan, cam = f.cam, c = f.census, fx = this.fx, z = cam.zoom;
    const F_ = gf.fleet, share = (a: number, b: number) => (b > 0 ? a / b : 0);
    const segs: [Pt[], number, string][] = [];
    const MID = 291;
    // a stage the group sent nothing through keeps a hairline thread, so the way stays legible
    const thin = 'thin';
    // the dock strand(s): from the group's lane (W2's group docks), else from each org's dock
    if (f.floor.on) for (const id of this.litLanes(rel)) { // fab-w1: along each of its lanes: dock → belt → gate (its PRs), gate → rail → intake (its merges)
      const lp = f.floor.lanePath(id);
      if (!lp) continue;
      segs.push([lp[0], gf.prs || gf.commits ? ribbonW(share(gf.prs || gf.commits, gf.prs ? F_.prs : F_.commits), z) : 1.2, gf.prs || gf.commits ? gf.hue : thin]);
      segs.push([lp[1], gf.merged ? ribbonW(share(gf.merged, F_.merged), z) : 1.2, gf.merged ? gf.hue : thin]);
    }
    if (f.w2.on && !f.floor.on) for (const dk of this.litDocks(rel)) segs.push([[[P.DOCK_U1, dk.v], [P.COLLECT_U, dk.v], [P.COLLECT_U, P.AISLE_V]], gf.commits ? ribbonW(share(gf.commits, F_.commits), z) : 1.2, gf.commits ? gf.hue : thin]);
    if (f.w2.on && !f.floor.on) segs.push([[[P.COLLECT_U, P.AISLE_V], [P.YARD_U1, P.AISLE_V]], gf.prs ? ribbonW(share(gf.prs, F_.prs), z) : 1.2, gf.prs ? gf.hue : thin]);
    if (!f.floor.on) for (const [org, o] of gf.byOrg) { // fab-w1
      if (!o.commits && !o.prs && !o.merged) continue;
      const dv = fx.dockV(org), ri = c.rails.findIndex((r) => r.org === org);
      if (!f.w2.on) segs.push([[[P.DOCK_U1, dv], [P.COLLECT_U, dv], [P.COLLECT_U, P.AISLE_V]], o.commits ? ribbonW(share(o.commits, F_.commits), z) : 1.2, o.commits ? gf.hue : thin]);
      if (!f.w2.on) segs.push([[[P.COLLECT_U, P.AISLE_V], [P.YARD_U1, P.AISLE_V]], o.prs ? ribbonW(share(o.prs, F_.prs), z) : 1.2, o.prs ? gf.hue : thin]);
      if (ri >= 0) segs.push([[[P.YARD_U1, P.AISLE_V], [P.GATE_U + 4, P.AISLE_V], [P.RAIL_U0, P.RAIL_V[ri]], [P.RAIL_U1, P.RAIL_V[ri]], [P.INTAKE_U0, MID]], o.merged ? ribbonW(share(o.merged, F_.merged), z) : 1.2, o.merged ? gf.hue : thin]);
    }
    segs.push([[[P.INTAKE_U0, MID], [P.DIST_U, MID], [P.SCAN_U, MID]], gf.runs ? ribbonW(share(gf.runs, F_.runs), z) : 1.2, gf.runs ? gf.hue : thin]);
    if (gf.deploys) {
      const wd = ribbonW(share(gf.deploys, F_.deploys), z);
      segs.push([[[P.SCAN_U, MID], [P.SCAN_U + 12, P.TRACK_V[1]], [P.TRACK_U1, P.TRACK_V[1]]], wd, gf.hue]);
      for (const di of rel.districts) {
        const d = fx.districtBox[di];
        if (d) segs.push([[[P.TRACK_U1, P.TRACK_V[1]], [P.CITY_U0 - 4, (d.v0 + d.v1) / 2], [d.u0 + 6, (d.v0 + d.v1) / 2]], Math.max(2, wd * 0.7), gf.hue]);
      }
    }
    if (gf.failed) {
      // home along the return conveyor, as far as the group's own parked failures
      let uEnd = P.SCAN_U - 160;
      for (const x of this.parked) if (rel.repos.has(x.repo) && x.u - 8 < uEnd) uEnd = x.u - 8;
      segs.push([[[P.SCAN_U, MID], [P.SCAN_U, P.RETURN_V], [uEnd, P.RETURN_V]], ribbonW(share(gf.failed, F_.runs), z), C.red]);
    }
    const ctx = g.ctx;
    ctx.save();
    ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    for (const [pts, wv, col] of segs) {
      g.begin_();
      pts.forEach(([u, v], i) => (i ? g.line(cam.x(u, v), cam.y(u, v, 1)) : g.move(cam.x(u, v), cam.y(u, v, 1))));
      g.stroke(col === 'thin' ? withAlpha(gf.hue, 0.32) : withAlpha(col, col === C.red ? 0.7 : 0.62), wv);
    }
    ctx.restore();
    // the peel's words: its failures, where it leaves the flow
    if (gf.failed) {
      const s = `${gf.failed} failed`, wv = g.width(s, SMALL, true);
      const at = this.place(cam.x(P.SCAN_U, 470), cam.y(P.SCAN_U, 470, 1), wv, 0);
      if (at) { g.fillRect(at[0] - 4, at[1] - 12, wv + 8, 16, withAlpha(CARD, 0.9)); g.text(s, at[0], at[1], C.redText, SMALL, true); }
    }
  }

  /** deploy track: thin lines from the track's end to every app it deployed in 24 h. */
  private trackStory(g: Gfx, l: Lens, st: Story): void {
    void st;
    const f = this.f, P = f.plan, cam = f.cam, fx = this.fx, rel = this.rel;
    if (!rel) return;
    const v = P.TRACK_V[Number(l.id)] ?? P.TRACK_V[0];
    const x0 = cam.x(P.TRACK_U1, v), y0 = cam.y(P.TRACK_U1, v, 2);
    g.begin_();
    let n = 0;
    for (const id of rel.apps) {
      const b = fx.blockAt.get(id);
      if (!b || n++ > 80) continue;
      const x = cam.x(b.u + b.d / 2, b.v + b.d / 2), y = cam.y(b.u + b.d / 2, b.v + b.d / 2, b.h + 1);
      g.move(x0, y0); g.ctx.quadraticCurveTo((x0 + x) / 2, Math.min(y0, y) - 30, x, y);
    }
    g.stroke(withAlpha(LIT, 0.32), 1);
  }

  /** app: GHOST STOREYS (one hollow, faint floor per commit on main not yet live, stacked on
   *  its roof; never a crane) and, while behind, an amber tether from its org's main-line rail to
   *  it; the live commit's car ringed when it is still on the rail. */
  private appStory(g: Gfx, l: Lens, st: Story): void {
    const f = this.f, P = f.plan, cam = f.cam, c = f.census, fx = this.fx, w = f.world;
    const a = st.app;
    const b = fx.blockAt.get(l.id);
    if (!a || !b) return;
    const cu = b.u + b.d / 2, cv = b.v + b.d / 2;
    this.healthRing(g, l.id, cam.x(cu, cv), cam.y(cu, cv, 0), 9 * cam.s + 9);
    const behind = Math.min(12, a.behind ?? 0);
    // ghost storeys: dashed, hollow, faint; each a commit main has and the app does not
    g.dash(true, 2, 2);
    for (let i = 0; i < behind; i++) {
      const z0 = b.h + 1 + i * 3.4;
      g.begin_(); fx.poly(g, [b.u, b.v + b.d, z0, b.u + b.d, b.v + b.d, z0, b.u + b.d, b.v + b.d, z0 + 2.6, b.u, b.v + b.d, z0 + 2.6]); g.stroke(withAlpha(C.amberText, 0.75 - i * 0.04), 1);
      g.begin_(); fx.poly(g, [b.u + b.d, b.v, z0, b.u + b.d, b.v + b.d, z0, b.u + b.d, b.v + b.d, z0 + 2.6, b.u + b.d, b.v, z0 + 2.6]); g.stroke(withAlpha(C.amberText, 0.55 - i * 0.03), 1);
    }
    g.dash(false);
    const ri = c.rails.findIndex((r) => r.org === w.orgOf(a.repo ?? ''));
    let anchor: Pt = [0, 0];
    if (f.floor.on) { // fab-w1: the live commit's car on its lane (else the repo's newest, else its post)
      const live = a.live_sha ? f.floor.carSpot(`${a.repo}@${a.live_sha}`) : null;
      const at = live ?? f.floor.repoSpot(a.repo ?? '');
      if (!at) return;
      if (live) this.ring(g, live[0], live[1], 6, 5, OK);
      anchor = at;
    } else {
    if (ri < 0) return;
    const rail = c.rails[ri], n = rail.cars.length, v = P.RAIL_V[ri];
    anchor = [P.RAIL_U1 - 6, v];
    rail.cars.forEach((car, k) => {
      if (car.repo !== a.repo) return;
      const u = P.RAIL_U1 - 12 - (n - 1 - k) * 10;
      if (u < P.RAIL_U0 + 4) return;
      if (car.sha === a.live_sha) this.ring(g, u, v, 6, 5, OK);
      anchor = [u, v];
    });
    } // fab-w1
    const x0 = cam.x(anchor[0], anchor[1]), y0 = cam.y(anchor[0], anchor[1], 6);
    const x1 = cam.x(cu, cv), y1 = cam.y(cu, cv, b.h + 1 + behind * 3.4);
    g.begin_(); g.move(x0, y0); g.ctx.quadraticCurveTo((x0 + x1) / 2, Math.min(y0, y1) - 70, x1, y1);
    if (behind) g.stroke(withAlpha(C.packet, 0.8), 1.4);
    else { g.dash(true, 3, 4); g.stroke(withAlpha(LIT, 0.35), 1); g.dash(false); }
  }

  /** fab-w3: an app's 7-day HEALTH RING round its building (FACTORY-SPEC §D): from the back,
   *  clockwise, a week of health (the server's GET /app/{id}; else what the stream reported since
   *  the app opened) with a pin out of the ring for each deploy (green ok, red failed, amber in
   *  flight); now is at the back, ticked. */
  private healthRing(g: Gfx, id: string, x: number, y: number, rx: number): void {
    const now = this.f.tl.playhead, ry = rx * 0.6, span = 7 * 24 * HOUR;
    const h7 = appHist7(id), ah = appHist(id), a = this.f.world.apps.get(id);
    const hist = h7?.health ?? (ah?.transitions ?? []).map((t) => ({ from: t.from, to: t.to, at: t.at }));
    const segs = healthSegs(hist, a?.health ?? 'unknown', now, h7?.since ?? ah?.since ?? 0);
    const ang = (k: number) => -Math.PI / 2 + k * TAU;
    g.begin_(); g.ctx.ellipse(x, y, rx, ry, 0, 0, TAU); g.stroke('#2A2A2D', 4);
    for (const [k0, k1, col] of segs) { g.begin_(); g.ctx.ellipse(x, y, rx, ry, 0, ang(k0), ang(Math.max(k0 + 0.002, k1))); g.stroke(col, 3); }
    const deps = h7?.deploys?.length ? h7.deploys.map((d) => ({ at: d.at || d.started, state: d.state })) : (ah?.deploys ?? []).map((d) => ({ at: d.at, state: d.state as string }));
    for (const d of deps) {
      const k = 1 - (now - d.at) / span;
      if (k < 0 || k > 1) continue;
      const t = ang(k), cx = Math.cos(t), cy = Math.sin(t);
      g.begin_(); g.move(x + cx * (rx + 2), y + cy * (ry + 1.5)); g.line(x + cx * (rx + 8), y + cy * (ry + 5)); g.stroke(d.state === 'success' ? OK : d.state === 'failure' ? C.red : C.packet, 1.6);
    }
    g.vline(x, y - ry - 6, y - ry + 3, LIT, 1.4);
  }

  /** since you looked: a ring on each counted thing where it is (its newest car, its block). */
  private freshStory(g: Gfx, l: Lens): void {
    const f = this.f, cam = f.cam, set = f.coffee.freshSet(l.id);
    const { culpritAt, repoAt } = f.coffee.carSpots();
    const col = l.id === 'fixed' ? OK : l.id === 'red' || l.id === 'failed' || l.id === 'down' ? C.red : LIT;
    for (const r of set.repos) { const at = (l.id === 'red' ? culpritAt.get(r) : undefined) ?? repoAt.get(r); if (at) this.ring(g, at[0], at[1], 6, 5, col); }
    for (const id of set.apps) { const b = this.fx.blockAt.get(id); if (b) this.ring(g, b.u + b.d / 2, b.v + b.d / 2, 6, b.h, col); }
    void cam;
  }

  /** merge gate: the gate ringed (its 24 h of merges are the card's bars; the merged repos lit). */
  private gateStory(g: Gfx): void {
    const P = this.f.plan, cam = this.f.cam;
    this.ring(g, P.GATE_U + 4, P.AISLE_V, 30, 40, LIT);
    const x = cam.x(P.GATE_U + 4, P.AISLE_V), y = cam.y(P.GATE_U + 4, P.AISLE_V, 40);
    g.begin_(); g.circle(x, y, 3); g.fill(LIT);
  }

  // ---- over everything: the breadcrumb, the story card, the compare card, the key -----------------
  top(g: Gfx, fr: Frame, t: number): void {
    const f = this.f;
    const right = f.selected ? fr.width - 372 : fr.width;
    // the glance takes the hint's place in the top row, after the zoom readout (factory.ts drawControls)
    const lod = f.cam.zoom >= 2.6 ? 'apps' : f.cam.zoom >= 1.6 ? 'org districts' : 'fleet';
    const x0 = 16 + 86 + g.width(`${Math.round(f.cam.zoom * 100)}%  ${lod}`, SMALL) + 22;
    f.coffee.glance(g, fr, t, x0, right - 16 - 24 - 12);
    this.crumbs(g);
    const top = this.topLens;
    if (top && top.kind !== 'pipeline' && this.rel && this.story) {
      this.card(g, top, this.story, this.rel, t, fr.height);
      // fab-w3: shift-click's second subject: the compare dock, bottom-right, 360 × 140 (compare.ts)
      if (this.cmp && this.relB) drawCompare(this, g, { lens: top, m: this.rel.m, cf: this.story.cf }, { lens: this.cmp, m: this.relB.m, cf: this.storyB?.cf }, right - 16, fr.height - 58 - 12);
    }
    // the key: a small "?" at the floor's top right
    const kx = right - 16 - 24, ky = 46;
    g.fillRect(kx, ky, 24, 22, this.legend ? '#2C2C2E' : '#1A1A1C');
    g.begin_(); g.rect(kx + 0.5, ky + 0.5, 23, 21); g.stroke(this.legend ? '#5A5A5E' : '#2E2E30', 1);
    g.text('?', kx + 12, ky + 15, this.legend ? C.ink : C.ink2, 12, true, 'center');
    this.fx.hit(kx, ky, 24, 22, 'legend', 'legend', 'the key');
    if (this.legend) drawLegend(g, this.f, right - 16, ky + 30, t); // fab-w1: the key, from grammar.ts (legend.ts)
    // the strip under the pointer: the moment a click replays from
    const tk = this.tick;
    // since you last looked: a bright bracket on the strip from then to now (§E)
    if (tk && !f.coffee.first && f.coffee.since > 0 && f.tl.mode !== 'replay') {
      const k = clamp(1 - (tk.now - f.coffee.since) / (24 * HOUR), 0, 1);
      const bx = tk.x + k * tk.w, by = tk.y - 6;
      g.fillRect(bx, by, Math.max(2, tk.x + tk.w - bx), 2, withAlpha(LIT, 0.85));
      g.vline(g.crisp(bx), by, by + 7, LIT, 1.5);
      g.vline(g.crisp(tk.x + tk.w), by, by + 7, LIT, 1.5);
    }
    if (tk && f.hoverId === 'strip' && f.px >= tk.x && f.px <= tk.x + tk.w) {
      g.vline(g.crisp(f.px), tk.y - 4, tk.y + tk.h + 3, C.ink, 1);
    }
    this.logAnchors();
    this.hoverCard.draw(g, fr, this.down); // fab-w3: over everything, the hovered thing's micro-chart
  }

  /** For drivers (tools/factory-shots.mjs lens): one target of each kind, logged once per layout
   *  at the fit zoom, as the floor logs a busy bay. */
  private logAnchors(): void {
    const f = this.f;
    if (f.cam.zoom !== 1 || this.stack.length) return;
    const key = `${f.cam.key}|${f.census.sig}|${this.parked.length}|${f.census.focal?.sha ?? ''}`;
    if (key === this.logged) return;
    this.logged = key;
    const out: Record<string, number[]> = {};
    const mid = (h: Hit) => [Math.round(h.x + h.w / 2), Math.round(h.y + h.h / 2)];
    const culprits = new Set<string>();
    for (const r of f.census.rails) for (const car of r.cars) if (car.culprit || car.state === 'failure' || car.state === 'error') culprits.add(`${car.repo}@${car.sha}`);
    let best = -1;
    const open = (h: Hit) => { const [mx, my] = mid(h); return f.hitAt(mx, my) === h; }; // not covered by something drawn later
    for (const h of this.fx.hits) {
      let k = h.kind;
      if (k === 'pipeline' && this.fx.bays.some((b) => b.pid === h.id)) k = 'bay';
      if (k === 'commit' && culprits.has(h.id)) k = 'culprit';
      if (k === 'stack') { const n = Number(h.label.split(' ').pop()); if (n > best && open(h)) { best = n; out.stack = mid(h); } continue; }
      if (k === 'app' && !out.appBehind && (f.world.apps.get(h.id)?.behind ?? 0) > 0 && open(h)) out.appBehind = mid(h);
      if (k === 'dock' || k === 'districtArea' || k === 'district' || k === 'track') { const re = new RegExp(`^${k}\\d+$`); const i = Object.keys(out).filter((x) => re.test(x)).length; if (i < 3 && open(h)) out[`${k}${i}`] = mid(h); continue; }
      if (!out[k] && open(h)) out[k] = mid(h);
    }
    // fab-w3: the parked clusters' first crates (cluster0: nearest the scanner), a flaky one, and
    // one whose repos have open PRs (its lens lights PR-yard cores)
    const cam = f.cam, V = f.plan.RETURN_V, w = f.world;
    const prRepos = new Set<string>();
    for (const p of w.prs.values()) if (p.phase !== 'merged' && p.phase !== 'closed' && p.phase !== 'deployed') prRepos.add(p.repo);
    this.parkGroups.slice(0, 6).forEach((pg, k) => { const x = this.parked.find((q) => q.k === k); if (x) out[`cluster${k}`] = [Math.round(cam.x(x.u, V)), Math.round(cam.y(x.u, V, 8))]; });
    const fl = this.parked.find((q) => q.flaky);
    if (fl) out.flaky = [Math.round(cam.x(fl.u, V)), Math.round(cam.y(fl.u, V, 8))];
    const withPrs = this.parked.find((q) => (clusterFacts(w, q.id)?.repos ?? [q.repo]).some((r) => prRepos.has(r)));
    if (withPrs) out.clusterPrs = [Math.round(cam.x(withPrs.u, V)), Math.round(cam.y(withPrs.u, V, 8))];
    console.log(`factory-lens: anchors ${JSON.stringify(out)}`);
  }
  private logged = '';

  /** The time strip's geometry (factory.ts drawStrip): one target, the moment from the pointer. */
  strip(g: Gfx, x: number, y: number, w: number, h: number, now: number): void {
    void g;
    const live = this.f.tl.mode === 'live' ? now : this.f.tl.liveNow();
    this.tick = { x, y, w, h, now: live };
    this.fx.hit(x, y - 4, w, h + 8, 'tick', 'strip', 'replay from here');
  }

  private tickAt(px: number): number {
    const tk = this.tick;
    if (!tk) return 0;
    return tk.now - (1 - clamp((px - tk.x) / tk.w, 0, 1)) * 24 * HOUR;
  }

  private crumbs(g: Gfx): void {
    if (!this.stack.length) return;
    const fx = this.fx;
    let x = 16;
    const y = 74, h = 20;
    this.stack.forEach((l, i) => {
      const last = i === this.stack.length - 1;
      const name = l.name.length > 26 ? `${l.name.slice(0, 25)}…` : l.name;
      const wv = 22 + g.width(name, SMALL, last) + 8;
      g.fillRect(x, y, wv, h, last ? '#232325' : '#18181A');
      g.begin_(); g.rect(x + 0.5, y + 0.5, wv - 1, h - 1); g.stroke(last ? (this.cmp ? HUE_A : '#6A6A6E') : '#2E2E30', 1);
      glyph(g, l.kind, x + 11, y + h / 2, last ? C.ink : C.ink3);
      g.text(name, x + 20, y + 14, last ? C.ink : C.ink2, SMALL, last);
      fx.hit(x, y, wv, h, 'crumb', String(i), `${KIND_WORD[l.kind]} · ${l.name}`);
      x += wv + 4;
      if (!last) { g.text('›', x + 1, y + 14, C.ink3, SMALL); x += 12; }
    });
    if (this.cmp) {
      const name = `+ ${this.cmp.name}`;
      const wv = 22 + g.width(name, SMALL, true) + 8;
      x += 6;
      g.fillRect(x, y, wv, h, '#232325');
      g.begin_(); g.rect(x + 0.5, y + 0.5, wv - 1, h - 1); g.stroke(HUE_B, 1);
      glyph(g, this.cmp.kind, x + 11, y + h / 2, HUE_B);
      g.text(name, x + 20, y + 14, HUE_B, SMALL, true);
      fx.hit(x, y, wv, h, 'cmpx', 'cmp', 'stop comparing');
      x += wv + 4;
    }
    // esc: back · ×: out
    g.fillRect(x, y, 20, h, '#18181A');
    g.begin_(); g.rect(x + 0.5, y + 0.5, 19, h - 1); g.stroke('#2E2E30', 1);
    g.text('×', x + 10, y + 14, C.ink3, 13, false, 'center');
    fx.hit(x, y, 20, h, 'crumbx', 'x', 'leave the lens (esc walks back)');
  }

  /** The story card, top-left under the breadcrumb: a few numbers and one small graphic per kind. */
  private card(g: Gfx, l: Lens, st: Story, rel: Rel, t: number, fh: number): void {
    const f = this.f, c = f.census, w = f.world, now = f.tl.playhead, m = rel.m;
    void t;
    // bottom-left, over the floor's emptiest corner (the lens's own things stay in view)
    const x = 16, W = 324, P = 12;
    const body = this.cardBody(g, l, st, rel, x + P, 0, W - P * 2, false);
    // fab-w3 (overseer note 2): what the lit cores in the PR yard are, when this lens lights some
    let yn = 0, yr = 0;
    if (l.kind !== 'stack' && l.kind !== 'pallet') for (let i = 0; i < 24; i++) { yn += rel.stackN[i]; yr += rel.stackRed[i]; }
    const H = 46 + body + (yn ? 22 : 0) + 10;
    const y = Math.max(102, fh - 58 - 12 - H);
    g.fillRect(x, y, W, H, withAlpha(CARD, 0.95));
    g.begin_(); g.rect(x + 0.5, y + 0.5, W - 1, H - 1); g.stroke(CARD_EDGE, 1);
    glyph(g, l.kind, x + P + 5, y + 19, C.ink);
    g.text(KIND_WORD[l.kind], x + P + 16, y + 23, C.ink3, SMALL);
    const name = g.fit(l.name, TITLE, W - P * 2, true);
    g.text(name, x + P, y + 40, l.kind === 'failure' ? C.redText : C.ink, TITLE, true);
    this.cardBody(g, l, st, rel, x + P, y + 46, W - P * 2, true);
    if (yn) this.yardKey(g, x + P, y + 46 + body + 4, W - P * 2, yn, yr);
    void c; void w; void now; void m;
  }

  /** The PR yard's key under a story card: a lit core (its red slice: CI failing) = these repos'
   *  open PRs, by phase × age. */
  private yardKey(g: Gfx, x: number, y: number, W: number, n: number, red: number): void {
    g.hline(x, x + W, y + 0.5, '#232325', 1);
    const cx = x + 8, cy = y + 13;
    g.begin_(); g.move(cx - 7, cy); g.line(cx, cy - 4); g.line(cx + 7, cy); g.line(cx, cy + 4); g.ctx.closePath(); g.fill(withAlpha(LIT, 0.3));
    g.begin_(); g.move(cx - 7, cy); g.line(cx, cy - 4); g.line(cx + 7, cy); g.line(cx, cy + 4); g.ctx.closePath(); g.stroke(LIT, 1.2);
    if (red) { g.begin_(); g.move(cx - 7, cy); g.line(cx, cy + 4); g.line(cx, cy + 7); g.line(cx - 7, cy + 3); g.ctx.closePath(); g.fill(C.red); }
    g.runs([[`${n}`, C.ink, true], [` open PR${n === 1 ? '' : 's'} of these repos`, C.ink3], [red ? ` · ${red} CI red` : '', C.redText]], x + 22, y + 17, SMALL, W - 22);
  }

  /** Draws (or, `paint` false, measures) the card's body; returns its height. */
  private cardBody(g: Gfx, l: Lens, st: Story, rel: Rel, x: number, y: number, W: number, paint: boolean): number {
    const f = this.f, c = f.census, w = f.world, now = f.tl.playhead, m = rel.m;
    let h = 0;
    const line = (parts: [string, string, boolean?][]) => { if (paint) g.runs(parts, x, y + h + 16, SMALL, W); h += 18; };
    switch (l.kind) {
      case 'fresh': {
        // what the chip counts, by name, worst first
        const set = f.coffee.freshSet(l.id);
        const names = [...set.repos.map((r) => repoName(r)), ...set.apps].slice(0, 8);
        const col = l.id === 'fixed' ? C.greenInk : l.id === 'red' || l.id === 'failed' || l.id === 'down' ? C.redText : C.ink2;
        for (let i = 0; i < names.length; i += 2) {
          if (paint) { g.text(g.fit(names[i], SMALL, W / 2 - 8), x, y + h + 14, col, SMALL); if (names[i + 1]) g.text(g.fit(names[i + 1], SMALL, W / 2 - 8), x + W / 2, y + h + 14, col, SMALL); }
          h += 16;
        }
        const more = set.repos.length + set.apps.length - names.length;
        if (more > 0) line([[`+${more} more, lit on the floor`, C.ink3]]);
        h += 4;
        h += this.flowCells(g, rel, x, y + h + 4, W, paint) + 4;
        break;
      }
      case 'gate': {
        const bars = st.hours ?? [];
        const mx = Math.max(1, ...bars);
        if (paint) {
          const bw = W / 24;
          bars.forEach((n, i) => { if (n) g.fillRect(x + i * bw, y + h + 30 - (n / mx) * 26, bw - 1, (n / mx) * 26, '#9A9AA0'); });
          g.hline(x, x + W, y + h + 30.5, '#2A2A2C');
          g.text('24 h', x, y + h + 44, C.ink3, SMALL); g.text('now', x + W, y + h + 44, C.ink3, SMALL, false, 'right');
        }
        h += 48;
        line([[`${st.n ?? 0}`, C.ink, true], [' merged in 24 h · open → merged ', C.ink3], [`p50 ${ago(st.p50 ?? 0)}`, C.ink, true], [` · p90 ${ago(st.p90 ?? 0)}`, C.ink3]]);
        break;
      }
      case 'group': {
        // fab-w3: what the group is, its flow by stage, and its v0.5 Trend as small multiples
        const gr = insights().group(l.id), hue = st.gf?.hue ?? C.ink3;
        if (paint) {
          g.fillRect(x, y + h + 6, 10, 10, hue);
          g.runs([[gr?.kind === 'team' ? 'team' : 'org', C.ink2, true], [` · ${gr?.repos ?? rel.repos.size} repos · ${gr?.apps ?? rel.apps.size} apps`, C.ink3], [gr?.red ? ` · ${gr.red} red` : '', C.redText]], x + 16, y + h + 15, SMALL, W - 16);
        }
        h += 20;
        h += this.flowCells(g, rel, x, y + h + 6, W, paint) + 10;
        if (paint) { g.hline(x, x + W, y + h + 0.5, '#232325', 1); g.text('last 24 h, by the hour', x, y + h + 15, C.ink3, SMALL); g.text('now', x + W, y + h + 15, C.ink3, SMALL, false, 'right'); }
        h += 20;
        h += trendRows(g, st.trend ?? null, x, y + h, W, paint, hue);
        break;
      }
      case 'org': case 'district': case 'repo': {
        h += this.flowCells(g, rel, x, y + h + 6, W, paint) + 6;
        if (l.kind === 'repo') {
          const dots = st.dots ?? [];
          if (paint) {
            dots.forEach((d, i) => {
              const bad = d.state === 'failure' || d.state === 'error', run = d.state === 'running' || d.state === 'pending';
              g.fillRect(x + i * 12, y + h + 6, 9, 11, bad ? C.red : run ? C.packet : '#5A6E5F');
              if (d.culprit) { g.begin_(); g.rect(x + i * 12 - 1.5, y + h + 4.5, 12, 14); g.stroke(C.redText, 1); }
            });
            g.text(`main · ${st.note ?? ''}`, x + dots.length * 12 + 8, y + h + 16, st.note?.startsWith('red') ? C.redText : C.ink3, SMALL);
          }
          h += 22;
        }
        break;
      }
      case 'stack': case 'pallet': {
        const bl = st.blockers ?? [];
        const total = bl.reduce((a, b) => a + b[1], 0) || 1;
        if (paint) { let bx = x; for (const [, n, col] of bl) { const ww = (n / total) * W; g.fillRect(bx, y + h + 8, Math.max(1, ww - 1), 10, col); bx += ww; } }
        h += 24;
        for (let i = 0; i < bl.length; i += 2) {
          if (paint) {
            const [k1, n1, c1] = bl[i];
            g.fillRect(x, y + h + 7, 8, 8, c1); g.runs([[`${n1} `, C.ink, true], [k1, C.ink2]], x + 13, y + h + 15, SMALL);
            if (bl[i + 1]) { const [k2, n2, c2] = bl[i + 1]; g.fillRect(x + W / 2, y + h + 7, 8, 8, c2); g.runs([[`${n2} `, C.ink, true], [k2, C.ink2]], x + W / 2 + 13, y + h + 15, SMALL); }
          }
          h += 17;
        }
        if (st.oldest) line([['oldest ', C.ink3], [st.oldest.label, C.ink2], [` · ${ago(st.oldest.age)}`, C.ink3], [st.note ? ` · ${st.note}` : '', C.ink3]]);
        h += this.ageLadder(g, l, st, x, y + h + 6, W, paint) + 6;
        break;
      }
      case 'bay': {
        const p = w.pipelines.get(st.pid ?? '');
        const el = p?.started ? now - p.started : 0, exp = p?.expected_ms ?? 0;
        if (p) line([[`${repoName(p.repo)} #${p.number}`, C.ink], [`  ${ago(el)}`, exp && el > exp * 1.5 ? C.redText : C.amberText], [exp ? ` of ~${ago(exp)}` : '', C.ink3]]);
        h += this.sparkRow(g, 'busy', this.hosts.series(c.groups[st.gi ?? 0]?.id ?? '', 'busy'), x, y + h + 4, W, paint, C.packet, 100, '%') + 4;
        line([[`${st.n ?? 0} ${st.n === 1 ? 'run' : 'runs'}`, C.ink, true], [` in the last hour · ${rel.repos.size} ${rel.repos.size === 1 ? 'repo' : 'repos'} lit`, C.ink3]]);
        break;
      }
      case 'vm': {
        // fab-w3: the server's 24 h (GET /engine/{id}/history) when it answered, else since open
        const gr = c.groups[st.gi ?? 0];
        const es = engineSeries(this.hosts, gr, machineEngines(w, gr));
        const nan = (a: (number | null)[] | undefined) => (a ?? []).map((v) => (v === null ? NaN : v));
        if (paint) g.text(es ? es.span : 'no samples yet', x + W, y + h + 12, C.ink3, SMALL, false, 'right');
        h += 16;
        h += this.sparkRow(g, 'busy', nan(es?.busy), x, y + h + 4, W, paint, C.packet, 100, '%');
        h += this.sparkRow(g, 'cpu', nan(es?.cpu), x, y + h + 2, W, paint, C.ink, 100, '%');
        h += this.sparkRow(g, 'mem', nan(es?.mem), x, y + h + 2, W, paint, C.ink2, 100, '%');
        h += this.sparkRow(g, 'load', nan(es?.load), x, y + h + 2, W, paint, C.ink3, 0, '') + 4;
        const full = es ? es.full.filter(Boolean).length : 0;
        if (es && full) line([[`${Math.round((full / es.full.length) * 100)}%`, C.redText, true], [` of ${es.span} with every slot busy`, C.ink3]]);
        const top3 = (es?.repos ?? []).slice().sort((a, b) => b.runs - a.runs).slice(0, 3);
        if (top3.length) line([['served ', C.ink3], [top3.map((r) => `${repoName(r.repo)} ${r.runs}`).join(' · '), C.ink2]]);
        const q = gr?.hosted ? c.gha.length : c.rr.length;
        line([[`${gr?.running.length ?? 0}/${gr?.slots ?? 0}`, C.amberText, true], [' busy · ', C.ink3], [`${q} queued`, q ? C.ink : C.ink3, true], [c.oldestWait > 0 && q ? ` · oldest ${ago(c.oldestWait)}` : '', C.ink3]]);
        break;
      }
      case 'queue': {
        const items = (st.items ?? []).slice().sort((a, b) => b.v - a.v).slice(0, 6);
        const max = Math.max(60_000, ...items.map((i) => i.v));
        for (const it of items) {
          if (paint) {
            g.text(g.fit(it.label, SMALL, 130), x, y + h + 14, C.ink2, SMALL);
            g.fillRect(x + 136, y + h + 6, Math.max(2, ((W - 190) * it.v) / max), 8, withAlpha(C.packet, 0.8));
            g.text(ago(it.v), x + W, y + h + 14, C.ink3, SMALL, false, 'right');
          }
          h += 16;
        }
        if (!items.length) line([['nothing waits', C.ink3]]);
        break;
      }
      case 'scanner': {
        const fl = c.flow;
        const pass = fl.finished ? Math.round(((fl.finished - fl.failed) / fl.finished) * 100) : 100;
        line([[`${pass}%`, C.ink, true], [' pass this hour · ', C.ink3], [`${fl.failed} failed`, fl.failed ? C.redText : C.ink3, true], [` · ${st.n ?? 0} runs in 24 h`, C.ink3]]);
        // the last 24 h: failures per half hour (red) over all runs (gray)
        if (paint) this.density(g, x, y + h + 4, W, 22);
        h += 30;
        const bars = st.bars ?? [];
        const max = Math.max(1, ...bars.map((b) => b[1]));
        for (const [name, n] of bars) {
          if (paint) {
            g.fillRect(x, y + h + 6, Math.max(2, (n / max) * 90), 9, C.red);
            g.runs([[`${n} `, C.ink, true], [name, C.ink2]], x + 98, y + h + 15, SMALL, W - 98);
          }
          h += 16;
        }
        const reps = (st.bars2 ?? []).slice(0, 3).map(([r, n]) => `${r} ${n}`).join(' · ');
        if (reps) line([[reps, C.redText]]);
        break;
      }
      case 'failure': {
        h += clusterBody(g, st.cf, w, st.pid ?? '', x, y + h, W, paint, now);
        break;
      }
      case 'track': {
        const items = st.items ?? [];
        const ok = items.filter((i) => i.state === 'success').length, bad = items.filter((i) => i.state === 'failure').length;
        line([[`${items.length}`, C.ink, true], [' deploys in 24 h · ', C.ink3], [`${ok} ok`, C.greenInk], [bad ? ` · ${bad} failed` : '', C.redText], [` · ${rel.apps.size} apps`, C.ink3]]);
        if (paint) this.ticks(g, items, x, y + h + 4, W, now);
        h += 34;
        break;
      }
      case 'app': {
        const a = st.app;
        const hl = a?.health ?? 'unknown';
        if (paint) { g.begin_(); g.circle(x + 4, y + h + 11, 4); g.fill(healthCol(hl)); }
        if (paint) g.runs([[hl, hl === 'up' ? C.greenInk : hl === 'down' ? C.redText : hl === 'degraded' ? C.amberText : C.ink3, true], [a?.latency_ms ? ` · ${a.latency_ms} ms` : '', C.ink3], [a?.team ? ` · ${a.team}` : '', C.ink3]], x + 14, y + h + 15, SMALL, W - 14);
        h += 18;
        const behind = st.n ?? 0;
        if (paint) {
          g.text(behind ? `${behind} behind main` : 'live = main', x, y + h + 15, behind ? C.amberText : C.ink3, SMALL);
          const bx = x + g.width(behind ? `${behind} behind main` : 'live = main', SMALL) + 10;
          for (let i = 0; i < Math.min(behind, 14); i++) { g.dash(true, 2, 2); g.begin_(); g.rect(bx + i * 11 + 0.5, y + h + 6.5, 8, 9); g.stroke(C.amberText, 1); g.dash(false); }
        }
        h += 20;
        // fed by: the repo's last main-line commits, the live one ringed, the ones not yet live hollow
        const r = w.repos.get(a?.repo ?? '');
        const dots = (r?.main?.recent ?? []).slice(-14);
        if (dots.length) {
          if (paint) {
            g.text('fed by', x, y + h + 13, C.ink3, SMALL);
            const liveK = dots.findIndex((dd) => dd.sha === a?.live_sha);
            dots.forEach((dd, i) => {
              const dx = x + 56 + i * 13, bad = dd.state === 'failure' || dd.state === 'error';
              if (liveK >= 0 && i > liveK) { g.dash(true, 2, 2); g.begin_(); g.rect(dx + 0.5, y + h + 3.5, 9, 10); g.stroke(C.amberText, 1); g.dash(false); }
              else g.fillRect(dx, y + h + 3, 10, 11, bad ? C.red : '#5A6E5F');
              if (i === liveK) { g.begin_(); g.rect(dx - 1.5, y + h + 1.5, 13, 14); g.stroke(C.ink, 1.2); }
            });
          }
          h += 20;
        }
        if (paint) this.ticks(g, st.items ?? [], x, y + h + 2, W, now);
        h += 32;
        // fab-w3: 7 d of health (the server's GET /app/{id}) and its up share; else 24 h seen since open
        const h7 = appHist7(l.id);
        if (h7) {
          if (paint) {
            const segs = healthSegs(h7.health ?? [], a?.health ?? 'unknown', now, h7.since);
            g.text('7 d', x, y + h + 13, C.ink3, SMALL);
            const hx = x + 30, hw = W - 30 - 80;
            for (const [k0, k1, col] of segs) g.fillRect(hx + k0 * hw, y + h + 5, Math.max(1, (k1 - k0) * hw), 8, col);
            const m = h7.health_ms, up = m?.up ?? 0, tot = up + (m?.degraded ?? 0) + (m?.down ?? 0) + (m?.unknown ?? 0);
            g.text(tot ? `${(Math.floor((up / tot) * 1000) / 10).toFixed(1)}% up` : '–', x + W, y + h + 13, tot && up / tot < 0.99 ? C.amberText : C.greenInk, SMALL, false, 'right');
          }
          h += 18;
          break;
        }
        const hlog = st.health ?? [];
        if (paint && hlog.length) {
          g.text('health', x, y + h + 13, C.ink3, SMALL); // seen since this window opened (H7: the server's history later)
          const hx = x + 56, hw = W - 56;
          for (let i = 0; i < hlog.length; i++) {
            const [at, s] = hlog[i];
            const next = hlog[i + 1]?.[0] ?? now;
            const k0 = 1 - clamp((now - at) / (24 * HOUR), 0, 1), k1 = 1 - clamp((now - next) / (24 * HOUR), 0, 1);
            g.fillRect(hx + k0 * hw, y + h + 6, Math.max(1, (k1 - k0) * hw), 7, healthCol(s));
          }
        }
        if (hlog.length) h += 18;
        break;
      }
      default: break;
    }
    return h;
  }

  /** The group's flow, one cell per stage: pushes · PRs · merged · running · failures · apps. */
  private flowCells(g: Gfx, rel: Rel, x: number, y: number, W: number, paint: boolean): number {
    const m = rel.m;
    const fail = m.runs ? Math.round((m.failed / m.runs) * 100) : 0;
    const cells: [LensKind, string, string, string][] = [
      ['stack', String(m.prs), 'PRs', C.ink],
      ['repo', String(m.merged24), 'merged', C.ink],
      ['pipeline', String(m.building + m.queued), 'in CI', m.building ? C.amberText : C.ink],
      ['failure', `${fail}%`, 'fail', fail >= 25 ? C.redText : C.ink],
      ['repo', String(m.red), 'red', m.red ? C.redText : C.ink],
      ['app', String(m.apps), m.down ? `${m.down} down` : 'apps', m.down ? C.redText : C.ink],
    ];
    if (!paint) return 50;
    const cw = W / cells.length;
    cells.forEach(([k, n, word, col], i) => {
      const cx = x + i * cw;
      glyph(g, k, cx + 6, y + 7, col === C.ink ? C.ink3 : col);
      g.text(n, cx, y + 31, col, 13, true);
      g.text(word, cx, y + 46, C.ink3, SMALL);
      if (i) g.vline(g.crisp(cx - 6), y, y + 46, '#232325');
    });
    return 50;
  }

  private sparkRow(g: Gfx, word: string, s: number[], x: number, y: number, W: number, paint: boolean, col: string, max: number, unit: string): number {
    if (!paint) return 18;
    g.text(word, x, y + 12, C.ink3, SMALL);
    const sx = x + 40, sw = W - 40 - 44;
    const vals = s.filter((v) => Number.isFinite(v));
    const mx = max || Math.max(1, ...vals);
    g.hline(sx, sx + sw, y + 14, '#232325');
    if (s.length >= 2) {
      g.begin_();
      let first = true;
      s.forEach((v, i) => {
        if (!Number.isFinite(v)) { first = true; return; }
        const px = sx + (i / (s.length - 1)) * sw, py = y + 14 - clamp(v / mx, 0, 1) * 12;
        if (first) { g.move(px, py); first = false; } else g.line(px, py);
      });
      g.stroke(col, 1.2);
    }
    const last = vals.length ? vals[vals.length - 1] : NaN;
    g.text(Number.isFinite(last) ? `${max ? Math.round(last) : last.toFixed(1)}${unit}` : '–', x + W, y + 12, Number.isFinite(last) ? C.ink2 : C.ink3, SMALL, false, 'right');
    return 18;
  }

  /** The last 24 h of the floor's run density (gray) and failures (red), 48 bars. */
  private density(g: Gfx, x: number, y: number, W: number, H: number): void {
    const c = this.f.census;
    const n = 48, per = 288 / n;
    const all = new Float32Array(n), red = new Float32Array(n);
    for (let i = 0; i < 288; i++) { all[(i / per) | 0] += c.dens[i]; red[(i / per) | 0] += c.densRed[i]; }
    const mx = Math.max(1, ...all);
    const bw = W / n;
    for (let i = 0; i < n; i++) {
      const h1 = (all[i] / mx) * H, h2 = (red[i] / mx) * H;
      if (h1 > 0.3) g.fillRect(x + i * bw, y + H - h1, bw - 1, h1, '#3A3A3E');
      if (h2 > 0.3) g.fillRect(x + i * bw, y + H - h2, bw - 1, Math.max(1, h2), C.red);
    }
  }

  /** Deploys on a 24 h axis: a tick each, green ok, red failed, amber in flight. */
  private ticks(g: Gfx, items: { v: number; state?: string }[], x: number, y: number, W: number, now: number): void {
    g.hline(x, x + W, y + 14, '#2A2A2C');
    for (const it of items) {
      const k = 1 - clamp((now - it.v) / (24 * HOUR), 0, 1);
      const col = it.state === 'success' ? OK : it.state === 'failure' ? C.red : C.packet;
      g.fillRect(x + k * (W - 2), y + 2, 2, 12, col);
    }
    g.text('24 h', x, y + 28, C.ink3, SMALL);
    g.text('now', x + W, y + 28, C.ink3, SMALL, false, 'right');
  }



  // ---- small drawing helpers ----------------------------------------------------------------------
  private ring(g: Gfx, u: number, v: number, r: number, z: number, col: string): void {
    const cam = this.f.cam;
    const x = cam.x(u, v), y = cam.y(u, v, z);
    g.begin_(); g.ctx.ellipse(x, y, r * cam.s + 3, (r * cam.s + 3) * 0.6, 0, 0, TAU); g.stroke(col, 1.3);
  }

  private num(g: Gfx, s: string, x: number, y: number, col: string): void {
    const wv = g.width(s, SMALL, true);
    g.fillRect(x - wv / 2 - 3, y - 11, wv + 6, 14, withAlpha(CARD, 0.85));
    g.text(s, x, y, col, SMALL, true, 'center');
  }

  /** A thin thread from (x0, y0) to (x1, y1), sagging a little (added to the current path). */
  private thread(g: Gfx, x0: number, y0: number, x1: number, y1: number): void {
    g.move(x0, y0);
    g.ctx.quadraticCurveTo((x0 + x1) / 2, Math.max(y0, y1) + Math.abs(x1 - x0) * 0.08, x1, y1);
  }

  /** A story label's place near its anchor (the floor's greedy placer), with a leader. */
  private place(ax: number, ay: number, w: number, lift: number): [number, number] | null {
    const at = this.fx.placeAt(Math.round(ax - 6), Math.round(ay - lift), w, 22, 6, true);
    return at;
  }
}

// ---- data helpers ------------------------------------------------------------------------------------
type Story = {
  kind: LensKind;
  dots?: { state: string; culprit: boolean; sha: string; at: number }[];
  blockers?: [string, number, string][];
  oldest?: { label: string; age: number } | null;
  steps?: { name: string; state: string; wf: string }[];
  bars?: [string, number][];
  bars2?: [string, number][];
  items?: { id: string; label: string; v: number; state?: string }[];
  gi?: number; pid?: string; n?: number; note?: string;
  hours?: number[]; p50?: number; p90?: number;
  app?: App | null;
  health?: [number, string][];
  /** fab-w3: the cluster lens's facts and its run on the conveyor (index into parkGroups). */
  cf?: ClusterFacts | null; k?: number;
  /** fab-w3: the group lens's flow against the fleet's and its Trend. */
  gf?: GroupFlow; trend?: Trend | null;
  /** fab-w3: a PR stack's PRs, [age, blocker colour], for its age ladder. */
  prs?: [number, string][];
};

function newRel(): Rel {
  return {
    repos: new Set(), orgs: new Set(), apps: new Set(), pipes: new Set(), cars: new Set(), stackN: new Int16Array(24), stackRed: new Int16Array(24), palletN: new Map(),
    groups: new Set(), tracks: new Set(), districts: new Set(), fails: new Set(), scanner: false, intake: false,
    m: { repos: 0, prs: 0, merged24: 0, runs: 0, failed: 0, waits: [], red: 0, apps: 0, up: 0, down: 0, deploys24: 0, building: 0, queued: 0, pushes: 0 },
  };
}

const VIAS = ['roadrunner', 'gha', 'gha_fallback'] as const;
const VIA_WORDS = ['roadrunner', 'gha', 'fallback'];
const AGE_SHORT = ['< 1 h', '< 1 d', '< 3 d', '< 1 wk', '< 30 d', '30 d +'];
const AGE_WORDS_L = ['under an hour', 'under a day', 'under 3 days', 'under a week', 'under 30 days', 'over 30 days'];
function viaIndex(via: string): number { return via === 'gha' ? 1 : via === 'roadrunner' ? 0 : 2; }

/** What blocks a PR, worst first (the card's bar and the stack's story). */
export const BLOCKERS: [string, string][] = [
  ['red check', C.red], ['conflict', '#B04848'], ['changes', C.redText], ['checks', C.packet], ['review', '#8A8A8E'], ['draft', '#4E4E52'], ['ready', '#5A6E5F'],
];
export function blocker(p: Pr): string {
  const b = (p.blocked_by ?? '').toLowerCase();
  if (p.ci === 'failure' || p.ci === 'error' || b.startsWith('failing')) return 'red check';
  if (p.phase === 'conflict' || b.includes('conflict')) return 'conflict';
  if (p.phase === 'changes_requested' || b.includes('changes')) return 'changes';
  if (p.phase === 'draft' || p.draft) return 'draft';
  if (p.phase === 'checks') return 'checks';
  if (p.phase === 'review' || b.includes('review')) return 'review';
  return 'ready';
}
function textCol(col: string): string { return col === C.red || col === '#B04848' ? C.redText : col === C.packet ? C.amberText : col === '#5A6E5F' ? C.greenInk : C.ink2; }

export function isBot(p: Pr): boolean { return !!p.bot || /bot|dependabot|renovate|autofix/i.test(p.author); }
export function botName(a: string): string {
  const s = a.toLowerCase();
  if (s.includes('dependabot')) return 'dependabot';
  if (s.includes('renovate')) return 'renovate';
  if (s.includes('autofix')) return 'autofix';
  if (s.includes('woodpecker')) return 'woodpecker';
  return s.replace(/\[bot\]$/, '').replace(/^northwind-/, '');
}
export function ageBucket(age: number): number { let b = 0; while (b < AGES.length - 1 && Math.max(0, age) >= AGES[b]) b++; return b; }
/** A failure's workflow/step (a cluster's second key: the same workflow and step across repos). */
function wfStep(p: Pipeline): string {
  for (const wf of p.workflows ?? []) for (const s of wf.steps ?? []) if (s.state === 'failure' || s.state === 'error') return `${wf.name}/${s.name}`;
  for (const wf of p.workflows ?? []) if (wf.state === 'failure' || wf.state === 'error') return wf.name;
  return '';
}
/** The failed run of a commit (or of its repo's newest failure). */
function failedRunOf(w: World, repo: string, sha: string): Pipeline | null {
  const cm = w.commits.get(`${repo}@${sha}`);
  let best: Pipeline | null = null;
  for (const id of cm?.pipelines ?? []) { const p = w.pipelines.get(id); if (p && (p.state === 'failure' || p.state === 'error')) best = p; }
  if (best) return best;
  for (const p of w.pipelines.values()) if (p.repo === repo && (p.state === 'failure' || p.state === 'error') && (!best || (p.finished ?? 0) > (best.finished ?? 0))) best = p;
  return best;
}
export function repoName(repo: string): string { return repo.split('/')[1] ?? repo; }
/** A step's words for a 12 px label: whole, or cut at a separator before 22 characters. */
export function short2(step: string): string {
  if (step.length <= 22) return step;
  const cut = Math.max(step.lastIndexOf(' / ', 22), step.lastIndexOf('/', 22), step.lastIndexOf(' ', 22));
  return cut > 6 ? `${step.slice(0, cut).trim()}…` : `${step.slice(0, 21)}…`;
}
export function pct(v: number): number { return v <= 1 ? v * 100 : v; }
function p50(a: number[]): number { if (!a.length) return 0; const s = a.slice().sort((x, y) => x - y); return s[s.length >> 1]; }
export function healthCol(h: string | undefined): string { return h === 'down' ? C.red : h === 'degraded' ? C.packet : h === 'up' ? '#6FA27C' : C.ink4; }
export function ago(ms: number): string {
  if (!(ms > 0)) return '0s';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h${m % 60 ? ` ${m % 60}m` : ''}`;
  return `${Math.floor(h / 24)}d`;
}
function clock(at: number, offsetMin: number): string {
  const d = new Date(at + offsetMin * 60_000);
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
}
void teamOf;

/** A small isometric cube in screen space (the key's shapes). */
export function cube(g: Gfx, x: number, y: number, s: number, top: string, side: string, front: string): void {
  const k = 0.87;
  g.begin_(); g.move(x - s * k, y - s * 0.5); g.line(x, y); g.line(x, y + s); g.line(x - s * k, y + s * 0.5); g.ctx.closePath(); g.fill(front);
  g.begin_(); g.move(x, y); g.line(x + s * k, y - s * 0.5); g.line(x + s * k, y + s * 0.5); g.line(x, y + s); g.ctx.closePath(); g.fill(side);
  g.begin_(); g.move(x, y - s); g.line(x + s * k, y - s * 0.5); g.line(x, y); g.line(x - s * k, y - s * 0.5); g.ctx.closePath(); g.fill(top);
}

/** A lens kind's glyph, ~10 px, centred on (x, y): the floor's shapes in miniature. */
export function glyph(g: Gfx, k: LensKind, x: number, y: number, col: string): void {
  switch (k) {
    case 'group': g.begin_(); g.move(x - 6, y + 4); g.line(x - 1, y - 4); g.line(x + 6, y - 4); g.line(x + 1, y + 4); g.ctx.closePath(); g.fill(col); return;
    case 'org': g.begin_(); g.rect(x - 5, y - 4, 10, 8); g.stroke(col, 1); g.fillRect(x + 2, y - 2, 3, 4, col); return;
    case 'repo': g.hline(x - 6, x + 6, y - 2, col, 1); g.hline(x - 6, x + 6, y + 2, col, 1); g.fillRect(x - 2, y - 4, 4, 4, col); return;
    case 'stack': case 'pallet': for (let i = 0; i < 3; i++) g.fillRect(x - 5, y + 2 - i * 3.5, 10, 2.5, col); return;
    case 'pipeline': cube(g, x, y - 1, 5, col, withAlpha(col, 0.7), withAlpha(col, 0.5)); return;
    case 'bay': g.begin_(); g.rect(x - 5, y - 5, 10, 10); g.stroke(col, 1); g.fillRect(x - 2, y - 2, 4, 4, col); return;
    case 'vm': g.begin_(); g.rect(x - 5, y - 5, 10, 10); g.stroke(col, 1); g.hline(x - 3, x + 3, y - 1.5, col, 1); g.hline(x - 3, x + 3, y + 1.5, col, 1); return;
    case 'queue': for (let i = 0; i < 3; i++) g.fillRect(x - 6 + i * 4.5, y - 1.5, 3, 3, col); return;
    case 'scanner': g.begin_(); g.move(x - 5, y + 5); g.line(x - 5, y - 4); g.line(x + 5, y - 4); g.line(x + 5, y + 5); g.stroke(col, 1.2); return;
    case 'failure': g.begin_(); g.move(x, y - 5); g.line(x + 5, y); g.line(x, y + 5); g.line(x - 5, y); g.ctx.closePath(); g.fill(col === C.ink || col === C.ink3 ? C.red : col); return;
    case 'track': g.hline(x - 6, x + 6, y - 2.5, col, 1); g.hline(x - 6, x + 6, y + 2.5, col, 1); for (let i = -4; i <= 4; i += 4) g.vline(x + i, y - 3.5, y + 3.5, col, 1); return;
    case 'app': cube(g, x, y - 1, 5, withAlpha(col, 0.9), withAlpha(col, 0.6), withAlpha(col, 0.45)); return;
    case 'district': for (let i = 0; i < 4; i++) g.fillRect(x - 5 + (i % 2) * 6, y - 5 + Math.floor(i / 2) * 6, 4, 4, col); return;
    case 'fresh': g.begin_(); g.circle(x, y, 4.5); g.stroke(col, 1); g.begin_(); g.circle(x, y, 1.6); g.fill(col); return;
    case 'gate': g.vline(x - 4, y - 5, y + 5, col, 1.4); g.vline(x + 4, y - 5, y + 5, col, 1.4); g.hline(x - 5, x + 5, y - 4.5, col, 1.4); return;
    default: return;
  }
}

/** Each machine's busy share, cpu, mem and load over the last half hour, one sample per 5 s of
 *  the world's clock (src/enginehist.ts keeps each engine's five minutes; this keeps a host's
 *  half hour for the machine lens). O(machines) a sample, fixed memory. */
export class HostHistory {
  static readonly N = 360;
  static readonly STEP = 5_000;
  private s = new Map<string, { busy: Float32Array; cpu: Float32Array; mem: Float32Array; load: Float32Array; n: number; head: number }>();
  private lastAt = 0;

  sample(c: Census, w: World): void {
    if (!w.loaded || !w.at) return;
    if (w.at < this.lastAt - HostHistory.STEP) { this.s.clear(); this.lastAt = 0; }
    if (w.at - this.lastAt < HostHistory.STEP) return;
    this.lastAt = w.at;
    for (const g of c.groups) {
      let s = this.s.get(g.id);
      if (!s) {
        if (this.s.size >= 16) continue;
        const N = HostHistory.N;
        s = { busy: new Float32Array(N), cpu: new Float32Array(N), mem: new Float32Array(N), load: new Float32Array(N), n: 0, head: 0 };
        this.s.set(g.id, s);
      }
      s.busy[s.head] = g.slots ? (g.running.length / g.slots) * 100 : NaN;
      s.cpu[s.head] = g.cpu >= 0 ? pct(g.cpu) : NaN;
      s.mem[s.head] = g.mem >= 0 ? pct(g.mem) : NaN;
      s.load[s.head] = g.load >= 0 ? g.load : NaN;
      s.head = (s.head + 1) % HostHistory.N;
      if (s.n < HostHistory.N) s.n++;
    }
  }

  /** The series, oldest first. */
  series(id: string, k: 'busy' | 'cpu' | 'mem' | 'load'): number[] {
    const s = this.s.get(id);
    if (!s) return [];
    const out: number[] = [];
    for (let i = 0; i < s.n; i++) out.push(s[k][(s.head - s.n + i + HostHistory.N) % HostHistory.N]);
    return out;
  }
}
