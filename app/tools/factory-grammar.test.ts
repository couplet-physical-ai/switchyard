// The factory's visual grammar (src/factory/grammar.ts; FACTORY-SPEC §B, §C): the kind → channels
// table is complete, the state colours keep their reserve (red and amber chroma ≥ 0.11), and no
// group hue the floor can show comes within ΔE 20 (CIEDE2000) of a state colour, takes the red
// or amber hue zones, or exceeds the group chroma; adjacent hued lanes stay apart. The palettes
// checked are the ones the floor really shows: the recorded fixtures' 11 lanes, every hue slot a
// fleet can reach (insights.ts: 4 team slots, 5 org slots), and the demo's lanes. Also the lane
// map (layout.ts): base lanes tile the zone, the accordion's vmap is monotone and gives the focus
// 45 % of the floor's depth. Run: bun app/tools/factory-grammar.test.ts
import { bindInsights, insights } from '../src/insights.ts';
import { Timeline } from '../src/timeline.ts';
import { createSim } from '../server/sim.ts';
import { Groups } from '../src/factory/groups.ts';
import { GRAMMAR, RESERVE, STATE, STAGES, TEXT_BUDGET, deltaE, deltaOk, hueSpec, hueViolations, laneInk, oklch, paletteReport, type HueSpec, type Kind } from '../src/factory/grammar.ts';
import { LaneMap, LANE_V0, LANE_V1, FOCUS_DV, STRIPE_DV } from '../src/factory/layout.ts';
import { LV } from '../src/factory/iso.ts';

let fails = 0;
const ok = (c: unknown, m: string) => { if (c) console.log('ok', m); else { fails++; console.log('FAIL', m); } };

// ── the table ──
const KINDS: Kind[] = ['dock', 'lane', 'stack', 'pallet', 'gate', 'post', 'car', 'stop', 'belt', 'intake', 'engine', 'bay', 'crate', 'gauge', 'scanner', 'return', 'track', 'app', 'district', 'strip']; // fx-lanes: + lane (carpet), stop (red tally)
ok(KINDS.every((k) => GRAMMAR[k]) && Object.keys(GRAMMAR).length === KINDS.length, `grammar: ${KINDS.length} kinds, one row each (§B)`);
const missing = KINDS.filter((k) => { const g = GRAMMAR[k]; return !g.word || !g.shape || !g.colour || !g.says || g.says.split(/\s+/).length > 6; });
ok(!missing.length, `grammar: every row has a word, a shape, a colour role and a short legend line${missing.length ? ` (missing: ${missing.join(', ')})` : ''}`);
const shapes = new Set(KINDS.map((k) => GRAMMAR[k].shape));
ok(shapes.size >= 15, `grammar: shape = kind (${shapes.size} distinct shapes for ${KINDS.length} kinds)`);
ok(KINDS.filter((k) => GRAMMAR[k].colour === 'group').every((k) => GRAMMAR[k].group), 'grammar: every group-coloured kind says where its group hue goes');
ok(STAGES.length === 9 && STAGES.every((s) => s.title.split(' ').length <= 2), 'grammar: nine stage titles of ≤ 2 words');
ok(TEXT_BUDGET === 40, 'grammar: the fleet text budget is 40 runs');

// ── the state reserve ──
for (const k of ['fail', 'flight'] as const) ok(oklch(STATE[k])[1] >= RESERVE.stateChroma, `reserve: state ${k} ${STATE[k]} chroma ${oklch(STATE[k])[1].toFixed(3)} ≥ ${RESERVE.stateChroma}`);
ok(deltaE(STATE.fail, STATE.flight) > 30 && deltaE(STATE.fail, STATE.ok) > 30 && deltaE(STATE.flight, STATE.ok) > 30, 'reserve: red, amber and green-gray far apart (ΔE > 30)');
// the ΔE maths against known pairs (Sharma et al.'s CIEDE2000 test data, as sRGB round trips are
// lossy: a self-distance of 0, symmetry, and the gray axis)
ok(deltaE('#808080', '#808080') === 0 && Math.abs(deltaE('#E06464', '#5A6E5F') - deltaE('#5A6E5F', '#E06464')) < 1e-9, 'ΔE: zero on itself, symmetric');
ok(Math.abs(deltaE('#000000', '#FFFFFF') - 100) < 0.5, `ΔE: black ↔ white = 100 (${deltaE('#000000', '#FFFFFF').toFixed(2)})`);
ok(deltaOk('#000000', '#FFFFFF') > 0.99 && deltaOk('#000000', '#FFFFFF') < 1.01, 'ΔE_ok: black ↔ white = 1');
// a palette that breaks every rule is caught
const bad = hueViolations([hueSpec('reddish', 0.62, 0.07, 30), hueSpec('loud', 0.62, 0.12, 250), hueSpec('greenish', 0.52, 0.035, 150), hueSpec('twin', 0.52, 0.035, 152)]);
ok(bad.some((v) => v.includes('reddish') && v.includes('hue')) && bad.some((v) => v.includes('loud') && v.includes('chroma')) && bad.some((v) => v.includes('greenish') && v.includes('ΔE')) && bad.some((v) => v.includes('adjacent')), `reserve: violations are caught (${bad.length})`);

// ── the palettes the floor shows ──
function palette(tl: Timeline): { ids: string[]; v: string[]; specs: HueSpec[]; map: string } {
  bindInsights(tl, () => null);
  const G = new Groups();
  const lanes = G.lanes();
  const specs = lanes.map((l) => ({ ...hueSpec(l.short, l.hue.l, l.hue.c, l.hue.h), hex: G.hex(l.id) }));
  return { ids: lanes.map((l) => l.short), v: hueViolations(specs), specs, map: lanes.map((l) => `${l.id}=${G.hex(l.id)}`).join(' ') };
}
/** fx-lanes: the palette's closest calls, printed (REVIEW-iter2 #1) and held to the rules. */
function closest(name: string, specs: HueSpec[]): void {
  const r = paletteReport(specs);
  console.log(`  ${name}: closest pair ${r.any[0]}↔${r.any[1]} ΔE_ok ${r.any[2].toFixed(3)} · closest neighbours ${r.nb[0]}↔${r.nb[1]} ${r.nb[2].toFixed(3)} · nearest reserved ${r.res[0]}↔${r.res[1]} ${r.res[2].toFixed(3)}`);
  ok(r.any[2] >= RESERVE.anyOk && r.nb[2] >= RESERVE.adjacentOk && r.res[2] >= RESERVE.reserveOk, `${name}: any pair ≥ ${RESERVE.anyOk} (${r.any[2].toFixed(3)}), neighbours ≥ ${RESERVE.adjacentOk} (${r.nb[2].toFixed(3)}), reserved ≥ ${RESERVE.reserveOk} (${r.res[2].toFixed(3)})`);
  const ink = specs.map((s) => oklch(laneInk(s.hex))[0]);
  ok(ink.every((L) => Math.abs(L - 0.8) < 0.02), `${name}: every lane's label ink at OKLCH L ≈ 0.80 (${ink.map((L) => L.toFixed(2)).join(' ')})`);
}
const fixture = await Bun.file(new URL('../../contract/fixtures/snapshot.json', import.meta.url)).json();
{
  const tl = new Timeline(); tl.load(JSON.parse(JSON.stringify(fixture)), 0); tl.tick(16);
  const p = palette(tl);
  ok(p.ids.length === 11 && !p.v.length, `fixtures: 11 lanes (${p.ids.join(', ')}) keep the reserve${p.v.length ? `: ${p.v.join('; ')}` : ''}`);
  closest('fixtures', p.specs);
  // the hue → group mapping is the same on every run (a fresh session on the same fleet)
  const tl2 = new Timeline(); tl2.load(JSON.parse(JSON.stringify(fixture)), 0); tl2.tick(16);
  const p2 = palette(tl2);
  ok(p2.map === p.map, `fixtures: the hue → group mapping is stable across runs`);
  bindInsights(tl, () => null);
  // every hue slot a fleet can reach: invent teams and orgs until the slots run out
  const ins = insights();
  const all = ins.groups().map((g) => ins.groupHue(g.id)).filter((h) => !h.folded);
  const v = hueViolations(all.map((h, i) => ({ ...hueSpec(`slot${h.slot}`, h.l, h.c, h.h), id: `slot${h.slot}#${i}` })).sort((a, b) => a.id.localeCompare(b.id)));
  ok(all.length === 9 && !v.filter((x) => !x.includes('adjacent')).length, `slots: the 9 hued slots keep the reserve${v.length ? `: ${v.join('; ')}` : ''}`);
  closest('slots (any order)', all.map((h) => ({ ...hueSpec(`slot${h.slot}`, h.l, h.c, h.h), hex: h.hex })).sort((a, b) => a.id.localeCompare(b.id)).filter((s, i, a) => i === 0 || s.id !== a[i - 1]!.id));
}
{
  const sim = createSim({ seed: 7, epoch: Date.UTC(2026, 10, 10, 20, 0), warmupMs: 10 * 60_000 });
  const tl = new Timeline(); tl.load(sim.snapshot() as never, 0); tl.tick(16);
  const p = palette(tl);
  ok(!p.v.length, `demo: ${p.ids.length} lanes keep the reserve${p.v.length ? `: ${p.v.join('; ')}` : ''}`);
  closest('demo', p.specs);
}

// ── the lane map (layout.ts): base lanes and the accordion ──
{
  const weights = [124, 11, 12, 10, 39, 132, 17, 21, 17, 11].map((r) => Math.sqrt(r));
  const m = new LaneMap();
  m.setLanes(weights.map((w, i) => ({ id: `l${i}`, w, fixed: 0 })).concat([{ id: 'bots', w: 0, fixed: 34 }]));
  const b = m.base;
  ok(Math.abs(b[0]! - LANE_V0) < 1e-6 && Math.abs(b[b.length - 1]! - LANE_V1) < 1e-6, `lanes: tile the zone ${LANE_V0}–${LANE_V1}`);
  ok(b.every((x, i) => i === 0 || x - b[i - 1]! >= 31.99), `lanes: every lane ≥ 32 u (min ${Math.min(...b.slice(1).map((x, i) => x - b[i]!)).toFixed(1)})`);
  m.focus(0, 1);
  const a = m.now;
  const d = (i: number) => a[i + 1]! - a[i]!;
  ok(Math.abs(d(0) - FOCUS_DV) < 1e-6 && FOCUS_DV === Math.round(0.45 * LV), `accordion: the focus lane takes 45 % of v (${d(0).toFixed(0)} u)`);
  ok([1, 2, 3, 9].every((i) => Math.abs(d(i) - STRIPE_DV) < 1e-6), `accordion: the others shrink to ${STRIPE_DV}-u stripes`);
  ok(a.every((x, i) => i === 0 || x > a[i - 1]!) && a[0]! >= LANE_V0 - 1e-6 && a[a.length - 1]! <= LANE_V1 + 1e-6, 'accordion: monotone, inside the zone');
  m.focus(5, 0.5);
  let mono = true, prev = -1e9;
  for (let v = LANE_V0; v <= LANE_V1; v += 0.5) { const x = m.vmap(v); if (x < prev - 1e-9) mono = false; prev = x; }
  ok(mono, 'vmap: monotone mid-transition (k 0.5)');
  ok(Math.abs(m.vmap(LANE_V0) - m.now[0]!) < 1e-6 && Math.abs(m.unmap(m.vmap(300)) - 300) < 1e-6, 'vmap: maps the boundaries; unmap inverts it');
  m.focus(-1, 0);
  ok(m.now.every((x, i) => Math.abs(x - b[i]!) < 1e-9), 'accordion: closed = the base lanes');
}

console.log(fails ? `FAIL: ${fails} failed` : 'ALL OK');
process.exit(fails ? 1 : 0);
