// The app city (src/factory/city.ts, fab-w5) on the recorded fixtures: districts are the group
// lanes in lane order, heights are deploys (never a hash), ghost storeys are App.behind (capped),
// the week's health ring, the deploy route through the fan-out, and the packing (inside the plot,
// a row's buildings apart on screen) at 1× and in stress mode. Run: bun app/tools/city.test.ts
import { bindInsights } from '../src/insights.ts';
import { Timeline } from '../src/timeline.ts';
import { Factory } from '../src/factory/factory.ts';
import { BOTS_LANE, floorGroups, lanes } from '../src/factory/groups.ts';
import { BASE, CALM_SHIFT, DIST_U0, FLEET_GHOSTS, GHOST_CAP, LADDER_U, DISTRICT_NAMES_MAX, STOREY, STOREY_CAP, type CityBlock, type CityDistrict } from '../src/factory/city.ts';
import { PLAN } from '../src/factory/layout.ts';
import type { AppHistoryResult } from '../src/insights.ts';

let fails = 0;
const ok = (c: unknown, m: string) => { if (c) console.log('ok', m); else { fails++; console.log('FAIL', m); } };
const eq = (a: unknown, b: unknown, m: string) => { const x = JSON.stringify(a), y = JSON.stringify(b); ok(x === y, x === y ? m : `${m}: ${x} != ${y}`); };
const DAY = 86_400_000;

// ── no invented heights: city.ts never hashes (FACTORY-SPEC §A: `hash(id) % 3` was fake data) ──
const src = await Bun.file(new URL('../src/factory/city.ts', import.meta.url)).text();
ok(!/\bhash\s*\(/.test(src), 'city.ts: no `hash(` anywhere (heights are deploys, never a hash)');
ok(!/\b(Math\.random|unit)\s*\(/.test(src), 'city.ts: no random or hashed unit for any mark');
ok(!/crane|boom|hoist/i.test(src.replace(/NEVER a crane|never a crane|Never dashed, never a crane/g, '')), 'city.ts: no crane, boom or hoist');

const fixture = await Bun.file(new URL('../../contract/fixtures/snapshot.json', import.meta.url)).json();
const tl = new Timeline();
tl.load(JSON.parse(JSON.stringify(fixture)), 0);
tl.tick(16);
bindInsights(tl, () => null);
const f = new Factory(tl);
const w = tl.world;
const now = tl.playhead || w.at;
const census = () => { f.census.invalidate(); for (let i = 0; i < 2; i++) f.census.update(w, now, 1000 * i); tl.clock += 2000; f.city.census(w); };
census();
const city = f.city;

// ── districts = group lanes, in lane order ──
const counts = floorGroups().settle();
const withApps = lanes().filter((l) => l.id !== BOTS_LANE && (counts.lanes.get(l.id)?.apps ?? 0) > 0);
eq(city.districtLanes, withApps.map((l) => l.id), `districts follow the lane order (${withApps.map((l) => l.short).join(' → ')})`);
eq(f.census.districts.map((d) => d.team), withApps.map((l) => l.short), 'the census districts carry the lanes\' names (the lens, coffee and labels read them)');
eq(f.census.districts.reduce((n, d) => n + d.apps.length, 0), w.apps.size, `every app in exactly one district (${w.apps.size})`);
const dbox = city.districtBox;
ok(dbox.every((d, i) => i === 0 || d.v0 > dbox[i - 1]!.v1), 'districts back → front without overlap (v)');
ok(dbox.every((d, i) => d.lane === city.districtLanes[i] && d.hex === floorGroups().hex(d.lane)), 'each plate tinted with its lane\'s hue');
ok(dbox.every((d) => d.n === f.census.districts.find((x) => x.team === d.team)?.apps.length), 'each plate sized by its app count');
for (const d of dbox) {
  const apps = f.census.districts.find((x) => x.team === d.team)!.apps;
  const bad = apps.filter((id) => city.laneOfApp(id, w) !== d.lane);
  ok(!bad.length, `${d.team}: its apps all belong to its lane (${apps.length})`);
}

// ── packing: inside the plot, a row's buildings never overlap on screen ──
const P = PLAN;
const inside = (b: CityBlock) => b.u >= DIST_U0 - 0.01 && b.u + b.d <= P.CITY_U1 + 0.01 && b.v >= P.CITY_V0 - 0.01 && b.v + b.d <= P.CITY_V1 + 2.01;
ok(city.blocks.every(inside), `every building inside the city's plot (pitch ${city.cityPitch})`);
ok(city.blocks.every((b) => (b.kind ? b.d / 0.74 : b.d) / city.cityPitch <= 0.705 + 1e-6), 'footprint ≤ 0.705 of the lot: a row batches without overlap');
// fx-city (#11): every fixture app is up, so the city is calm: compact, its districts start
// ~CALM_SHIFT of the plot further from the ladder, the spurs take that ground; dense inside it
const upAll = [...w.apps.values()].every((a) => a.health !== 'down' && a.health !== 'degraded');
ok(upAll && city.calm && city.cityU0 > DIST_U0 + 0.2 * (P.CITY_U1 - DIST_U0) && city.cityU0 < DIST_U0 + (CALM_SHIFT + 0.1) * (P.CITY_U1 - DIST_U0), `all up → calm: the districts start at u ${city.cityU0} (the ladder's district start ${DIST_U0})`);
ok(dbox.every((d) => d.u0 === city.cityU0), 'calm: every district starts at the calm city\'s edge');
const plotOf = (u0: number) => (P.CITY_U1 - u0) * (P.CITY_V1 - P.CITY_V0);
const area = dbox.reduce((a, d) => a + (d.u1 - d.u0) * (d.v1 - d.v0), 0), plot = plotOf(city.cityU0);
ok(area / plot >= 0.75, `districts cover ${(100 * area / plot).toFixed(0)} % of the calm plot (dense, ≥ 75 %)`);
ok(dbox.at(-1)!.v1 >= P.CITY_V1 - 20, `calm: the front district reaches the plot's front (v ${dbox.at(-1)!.v1.toFixed(0)} of ${P.CITY_V1})`);
ok(area / plotOf(DIST_U0) < 0.8, `calm: the footprint shrank (${(100 * area / plotOf(DIST_U0)).toFixed(0)} % of the whole plot)`);
// a sig that never churns: data turns with nothing new leave it alone
{
  const s0 = city.sig;
  for (let i = 0; i < 4; i++) census();
  eq(city.sig, s0, 'city.sig: unchanged across census turns with nothing new (never per tick)');
}
// one app down: loud at once (the whole plot, the full pitch); back up: loud until CALM_MS held
{
  const id = f.census.districts.at(-1)!.apps[0]!, a0 = w.apps.get(id)!, s0 = city.sig;
  w.apps.set(id, { ...a0, health: 'down' }); w.kv.app++;
  census();
  ok(!city.calm && city.cityU0 === DIST_U0 && city.districtBox.every((d) => d.u0 === DIST_U0), 'an app down → loud at once: the city takes the whole plot');
  ok(city.sig !== s0, 'city.sig changed with the layout');
  const names = city.fleetNames();
  ok(names.some((d) => d.lane === city.blockAt.get(id)!.lane) && names.length === Math.min(DISTRICT_NAMES_MAX, city.districtBox.length), `fleet names: every district (${names.map((d) => d.team).join(', ')}), the down app's included`);
  w.apps.set(id, { ...a0 }); w.kv.app++;
  census();
  ok(!city.calm, 'back up: still loud (no flapping re-pack)');
  tl.clock += 61_000;
  census();
  ok(city.calm && city.cityU0 > DIST_U0, 'up for a minute: calm again');
}
// ≤ DISTRICT_NAMES_MAX names however many districts (14 here: copies of the real ones)
{
  const real = city.districtBox.slice();
  for (let k = 0; city.districtBox.length < 14; k++) city.districtBox.push({ ...real[k % real.length]!, team: `x${k}`, n: 500 + k } as CityDistrict);
  // the down app's district (the front one) is named before bigger ones
  const id = f.census.districts.at(-1)!.apps[0]!, a0 = w.apps.get(id)!;
  w.apps.set(id, { ...a0, health: 'down' }); w.kv.app++; f.census.invalidate(); f.census.update(w, now, 0);
  const n = city.fleetNames();
  w.apps.set(id, { ...a0 }); w.kv.app++;
  const di = city.blockAt.get(id)!.district;
  ok(n.includes(city.districtBox[di]!), `the down app's district (${city.districtBox[di]!.team}, ${city.districtBox[di]!.n} apps) is among the names, before bigger ones`);
  ok(n.length === DISTRICT_NAMES_MAX, `district names ≤ ${DISTRICT_NAMES_MAX} (14 districts → ${n.length})`);
  ok(n[0] === city.districtBox[di] && n.slice(1).every((d, i) => i === 0 || d.n <= n[i]!.n), `placing order: trouble first, then by size (${n.slice(0, 4).map((d) => `${d.team} ${d.n}`).join(', ')}, …)`);
  city.districtBox.length = 0; city.districtBox.push(...real);
}

// ── heights: one storey per successful deploy in the last 7 d, capped; nothing else ──
const quiet = [...w.apps.keys()].find((id) => ![...w.deploys.values()].some((d) => d.app === id))!;
const hist = (deploys: { at: number; state: string; sha: string }[], health: { from: string; to: string; at: number }[] = [], since = now - 2 * DAY): AppHistoryResult => ({
  id: quiet, app: null, source: 'server', complete: false, since, health: health as AppHistoryResult['health'], health_ms: { up: 1 },
  deploys: deploys.map((d) => ({ sha: d.sha, via: 'roadrunner', state: d.state as 'success', started: d.at - 60_000, at: d.at })),
});
city.take(quiet, hist([{ at: now - DAY, state: 'success', sha: 'a1' }, { at: now - 2 * DAY, state: 'success', sha: 'a2' }, { at: now - 3_600_000, state: 'failure', sha: 'a3' }, { at: now - 8 * DAY, state: 'success', sha: 'a4' }]), tl.clock);
census();
let b = city.blockAt.get(quiet)!;
eq([b.storeys, b.h], [2, BASE + 2 * STOREY], `${quiet}: 2 successful deploys in 7 d → 2 storeys (a failure and an 8-day-old one do not count)`);
ok(!b.idle, `${quiet}: deployed within 30 d → not idle`);
city.take(quiet, hist(Array.from({ length: 14 }, (_, i) => ({ at: now - (i + 1) * 3_600_000, state: 'success', sha: `b${i}` }))), tl.clock);
census();
b = city.blockAt.get(quiet)!;
eq(b.storeys, STOREY_CAP, `14 deploys in 7 d → capped at ${STOREY_CAP} storeys`);
const none = [...w.apps.keys()].find((id) => id !== quiet && ![...w.deploys.values()].some((d) => d.app === id))!;
city.take(none, { ...hist([{ at: now - 40 * DAY, state: 'success', sha: 'c1' }]), id: none }, tl.clock);
census();
const nb = city.blockAt.get(none)!;
eq([nb.storeys, nb.h, nb.idle], [0, BASE, true], `${none}: last deploy 40 d ago → ground floor only, idle (desaturated)`);

// ── ghost storeys = App.behind, capped at GHOST_CAP (a "+N" notch past it) ──
const ids = [...w.apps.keys()].slice(0, 4);
const setBehind = (id: string, n: number | undefined) => { const a = w.apps.get(id)!; w.apps.set(id, { ...a, behind: n }); w.kv.app++; };
setBehind(ids[0]!, 3); setBehind(ids[1]!, 9); setBehind(ids[2]!, 0);
{ const a = w.apps.get(ids[3]!)!; w.apps.set(ids[3]!, { ...a, behind: undefined, main_sha: 'aaa', live_sha: 'bbb' }); w.kv.app++; }
census();
const gh = ids.map((id) => [city.blockAt.get(id)!.ghosts, city.blockAt.get(id)!.behind]);
eq(gh, [[3, 3], [GHOST_CAP, 9], [0, 0], [1, 1]], 'ghost storeys = behind (3 → 3; 9 → 5 + notch; 0 → 0; main_sha ≠ live_sha → 1)');
// fx-city: at the fleet zoom only ≥ FLEET_GHOSTS behind shows ghost storeys (1–2: a roof tick)
eq(ids.map((id) => city.shownGhosts(city.blockAt.get(id)!, true)), [3, GHOST_CAP, 0, 0], `fleet zoom: ghost storeys only from ${FLEET_GHOSTS} behind (3 → 3; 9 → 5; 0 → 0; 1 → a tick, no storey)`);
eq(ids.map((id) => city.shownGhosts(city.blockAt.get(id)!, false)), [3, GHOST_CAP, 0, 1], 'group zoom and closer (and the app lens): every ghost storey');
const an = city.buildingAnchor(ids[1]!)!;
eq([an.roof, an.top], [city.blockAt.get(ids[1]!)!.h, city.blockAt.get(ids[1]!)!.h + GHOST_CAP * STOREY], 'buildingAnchor: roof and the top of the ghost storeys (W4)');

// ── the week's health ring (the app lens's runs) ──
city.take(quiet, hist([], [{ from: 'up', to: 'down', at: now - 3 * 3_600_000 }, { from: 'down', to: 'up', at: now - 3_600_000 }]), tl.clock);
census();
b = city.blockAt.get(quiet)!;
const red = b.ring?.find((x) => x[2] === '#E06464');
ok(b.loud && red && Math.abs(red[0] - (1 - 3 / 168)) < 1e-6 && Math.abs(red[1] - (1 - 1 / 168)) < 1e-6, 'ring: a 2 h outage 3 h ago is a red run just before now (from the back, clockwise)');
ok(b.ring?.[0]?.[2] === '#38383C' && Math.abs(b.ring[0][1] - 5 / 7) < 1e-6, 'ring: the 5 days before the history began are gray');

// ── a deploy's route: via track → ladder → its district's spur → its building ──
const d0 = dbox[0]!, app0 = f.census.districts[0]!.apps[5]!;
const r = city.route(app0, 1), b0 = city.blockAt.get(app0)!;
ok(r[0]![1] === P.TRACK_V[1] && r.some((p) => p[0] === LADDER_U) && r.some((p) => p[1] === d0.spurV) && r.at(-1)![0] === b0.u + b0.d / 2 && r.at(-1)![1] === b0.v + b0.d / 2, 'route: gha track → ladder → the district\'s spur → the building');

// ── a deploy rides in: its crate leaves on `running`, its storey is built when the crate arrives ──
{
  const id = none, before = city.blockAt.get(id)!.storeys, t0 = tl.clock + 10_000;
  f.onEvent({ k: 'deploy', app: id, sha: 'd1', state: 'running', via: 'roadrunner', at: now - 60_000 } as never, w, t0);
  const crate = f.crates.list.find((c) => c.kind === 'deploy' && c.id.endsWith('@d1'));
  ok(crate && crate.route.at(-1)![1] === city.blockAt.get(id)!.v + city.blockAt.get(id)!.d / 2, 'deploy running: a crate rides to the building');
  f.onEvent({ k: 'deploy', app: id, sha: 'd1', state: 'success', via: 'roadrunner', at: now - 1000 } as never, w, t0 + 500);
  census();
  eq(city.blockAt.get(id)!.storeys, before, 'deploy success while the crate rides: no storey yet');
  const arrive = f.crates.arrives(crate!, crate!.route.length - 1);
  (city as unknown as { landDue(t: number): void }).landDue(arrive + 1);
  tl.clock += 2000; f.city.census(w);
  eq(city.blockAt.get(id)!.storeys, before + 1, 'the crate arrived: the building has its new storey');
}

// ── stress mode: ten times the apps still fit, in the same order ──
f.census.factor = 10;
city.invalidate();
census();
eq(city.blocks.length, w.apps.size * 10, `stress: ${w.apps.size * 10} buildings`);
ok(city.blocks.every(inside), `stress: every building inside the plot (pitch ${city.cityPitch})`);
eq(city.districtLanes, withApps.map((l) => l.id), 'stress: the same district order');

console.log(fails ? `\n${fails} FAILED` : '\nall ok');
process.exit(fails ? 1 : 0);
