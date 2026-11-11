// fx-polish (round 3): the approach roads stay on their apron and on screen, every road starts at
// an origin mark inside it, every lane curb has an end cap and a hover with its lane's failures,
// and a lens's framing (lens.ts `frameTo`) brings its subject and tethers into view without
// zooming in or past the fit. Run: bun app/tools/fxpolish.test.ts
import { bindInsights } from '../src/insights.ts';
import { Timeline } from '../src/timeline.ts';
import { Factory } from '../src/factory/factory.ts';
import { CURB, frontOf } from '../src/factory/front.ts';
import { Cam } from '../src/factory/iso.ts';
import { CARD_BOX, FRAME_BOX, frameTo } from '../src/factory/lens.ts';

let fails = 0;
const ok = (c: unknown, m: string) => { if (c) console.log('ok', m); else { fails++; console.log('FAIL', m); } };

// ── frameTo: pure camera maths ────────────────────────────────────────────────────────────────
const cam = new Cam();
cam.fit(1440, 840, 84, 58);
const box = FRAME_BOX(1440, 840), card = CARD_BOX(1440, 840);
const inside = (c: Cam, u: number, v: number, z: number, b: readonly number[]) => { const x = c.x(u, v), y = c.y(u, v, z); return x >= b[0]! - 0.5 && x <= b[2]! + 0.5 && y >= b[1]! - 0.5 && y <= b[3]! + 0.5; };
// an app lens at city zoom: the app in the city (u 1400) and its main line's car (u 560)
const pts = [1400, 300, 10, 560, 220, 5];
cam.zoom = 2.72; cam.panX = -1500; cam.panY = -300; cam.apply();
ok(!inside(cam, 560, 220, 5, box), 'at 272 % on the city the tether\'s far end is off screen (the iteration-2 bug)');
const to = frameTo(cam, pts, box, card);
ok(!!to, 'frameTo: a flight when a tether leaves the frame');
if (to) {
  const c2 = new Cam(); c2.fit(1440, 840, 84, 58); c2.zoom = to[0]; c2.panX = to[1]; c2.panY = to[2]; c2.apply();
  ok(to[0] <= 2.72 + 1e-9 && to[0] >= 1 - 1e-9, `frameTo: zooms out, never in, never past the fit (${to[0].toFixed(2)})`);
  ok(inside(c2, 1400, 300, 10, box) && inside(c2, 560, 220, 5, box), 'frameTo: the subject and the tether\'s end both land inside the frame box');
  ok(!inside(c2, 1400, 300, 10, card) && !inside(c2, 560, 220, 5, card), 'frameTo: neither lands under the story card');
}
// already in view: no flight
cam.zoom = 1.7; cam.panX = 0; cam.panY = 0; cam.apply();
const near = [cam.unproject(720, 420), cam.unproject(800, 460)].flatMap(([u, v]) => [u, v, 0]);
ok(frameTo(cam, near, box, card) === null, 'frameTo: null when the points already fit');
ok(frameTo(cam, [], box, card) === null, 'frameTo: null without points');

// ── the roads and curbs on the recorded fixtures ──────────────────────────────────────────────
const fixture = await Bun.file(new URL('../../contract/fixtures/snapshot.json', import.meta.url)).json();
const tl = new Timeline();
tl.load(JSON.parse(JSON.stringify(fixture)), 0);
tl.tick(16);
bindInsights(tl, () => null);
const f = new Factory(tl);
const w = tl.world, now = w.at;
f.cam.fit(1440, 840, 84, 58);
for (let i = 0; i < 3; i++) { f.census.invalidate(); for (let k = 0; k < 2; k++) f.census.update(w, now, 1000 * k); tl.clock += 2000; f.floor.census(w); }
const fr = frontOf(f);
ok(!!fr, 'the front layer is registered');
if (fr && f.floor.on) {
  fr.census();
  const lanes = (fr as unknown as { lanes: { id: string; road: [number, number][]; hw: number; fail: number[] }[] }).lanes;
  const aprons = (fr as unknown as { apron: [number, number][][] }).apron;
  ok(lanes.length >= 5, `a road and a curb per hued lane (${lanes.length})`);
  const LV = 640;
  ok(aprons.length >= 1 && aprons.every((A) => A.length >= 3 && A.every(([u, v]) => u <= 1e-6 || v >= LV - 1e-6)), `the apron is off the slab (${aprons.length} polygons: left of it, in front of it)`);
  const inPoly = (p: [number, number]) => aprons.some((apron) => { let c = false; for (let i = 0, j = apron.length - 1; i < apron.length; j = i++) { const a = apron[i]!, b = apron[j]!; if ((a[1] > p[1]) !== (b[1] > p[1]) && p[0] < ((b[0] - a[0]) * (p[1] - a[1])) / (b[1] - a[1] || 1e-9) + a[0]) c = !c; } return c; });
  for (const L of lanes) if (!inPoly(L.road[2]!) || !inPoly(L.road[1]!)) console.log('off apron', L.id, JSON.stringify(L.road), JSON.stringify(aprons));
  ok(lanes.every((L) => inPoly(L.road[2]!) && inPoly(L.road[1]!)), 'every road (its fan and its origin mark at the far end) lies on the apron');
  const fc = f.cam;
  ok(lanes.every((L) => { const [u, v] = L.road[2]!; const x = fc.x(u, v), y = fc.y(u, v); return x > 14 && y > 44 && y < 840; }), 'every origin mark is on screen at the fit');
  // hits: every curb (its cap included) answers with its lane
  f.fx.hits.length = 0;
  fr.hits({} as never);
  const curbs = f.fx.hits.filter((h) => fr.curbOf(h));
  const seen = new Set(curbs.map((h) => fr.curbOf(h)!.id));
  ok(lanes.every((L) => seen.has(L.id)), `every lane curb is a hit with its lane (${seen.size}/${lanes.length})`);
  ok(lanes.every((L) => curbs.some((h) => fr.curbOf(h)!.id === L.id && fc.unproject(h.x, h.y + h.h)[0] < CURB.U0)), 'every curb\'s end cap (left of its first hour) is a hit too');
  ok(curbs.every((h) => (fr.hoverFor(h) ?? [])[0]?.includes('failures an hour')), 'a curb\'s hover names its lane and its failures an hour');
} else ok(false, 'the floor is on for the fixtures');

console.log(fails ? `fxpolish.test: ${fails} FAILED` : 'fxpolish.test: all ok');
if (fails) process.exit(1);
