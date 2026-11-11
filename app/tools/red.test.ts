// Red means broken NOW (w2-red, REVIEW-iter3 #2, #4, #5): the red roles in grammar.ts, the age
// tiers, the beat membership in fx.ts, and the floor's tiers on the recorded fixtures (lanes.ts's
// count → floor.ts's per-lane tiers, the old-PR scan, the dock gauge's share). Run:
//   bun app/tools/red.test.ts
import { C, PR_OLD_MS, RED_HOT_MS, RED_RUST_MS, STATE, TIER_HOT, TIER_RED, TIER_RUST, deltaE, oklch, redFor, redTier, tierFlipIn } from '../src/factory/grammar.ts';
import { inBeat } from '../src/factory/fx.ts';
import { C as THEME } from '../src/yard/theme.ts';

let fails = 0;
const ok = (c: unknown, m: string) => { if (c) console.log('ok', m); else { fails++; console.log('FAIL', m); } };
const H = 3_600_000, D = 24 * H;

// ── the palette roles ──
ok(C.red === THEME.red && C.canvas === THEME.canvas, 'grammar C: the app palette, unchanged (C.red is the theme red)');
const [Lpr, Cpr, hpr] = oklch(C.redPR);
ok(C.redPR === '#8A4A44', `C.redPR is the brief's brick #8A4A44`);
ok(Lpr >= 0.42 && Lpr <= 0.5, `C.redPR: a dark brick, OKLCH L ${Lpr.toFixed(3)} (the review's ≈ 0.45; the state red is ${oklch(STATE.fail)[0].toFixed(3)})`);
ok(Cpr < oklch(STATE.fail)[1] * 0.75, `C.redPR: desaturated against the state red (chroma ${Cpr.toFixed(3)} vs ${oklch(STATE.fail)[1].toFixed(3)})`);
ok(hpr < 50 || hpr > 340, `C.redPR: still a red-family hue (${hpr.toFixed(0)}°): failing, not broken`);
ok(deltaE(C.redPR, STATE.fail) >= 15, `C.redPR: ΔE ${deltaE(C.redPR, STATE.fail).toFixed(1)} ≥ 15 from the state red (never read as a broken main)`);
ok(C.rust === '#6E3B36', 'C.rust is the brief\'s #6E3B36');
ok(oklch(C.rust)[0] < Lpr && oklch(C.rust)[0] < oklch(STATE.fail)[0] - 0.2, `rust: darker than brick and well below the red (L ${oklch(C.rust)[0].toFixed(3)})`);
ok(deltaE(C.rust, STATE.fail) >= 20, `rust: ΔE ${deltaE(C.rust, STATE.fail).toFixed(1)} ≥ 20 from the state red`);
ok(oklch(C.hot)[0] > 0.95, 'hot: a white-hot core (L > 0.95)');
// v4-heaps (REVIEW-iter3b #2, #3): the failing-flow role: gray-red, never read as the state red
const [Lff, Cff, hff] = oklch(C.failFlow);
ok(deltaE(C.failFlow, STATE.fail) >= 20 && Cff < oklch(STATE.fail)[1] * 0.5, `failFlow: ΔE ${deltaE(C.failFlow, STATE.fail).toFixed(1)} ≥ 20 from the state red, chroma ${Cff.toFixed(3)} under half its`);
ok((hff < 50 || hff > 340) && Lff > 0.4 && Lff < 0.56, `failFlow: a red-family gray (${hff.toFixed(0)}°, L ${Lff.toFixed(3)})`);
ok(deltaE(C.failFlowText, STATE.fail) >= 15 && oklch(C.failFlowText)[0] >= 0.68, `failFlowText: readable (L ${oklch(C.failFlowText)[0].toFixed(3)}) and ΔE ${deltaE(C.failFlowText, STATE.fail).toFixed(1)} from the red`);
ok(oklch(C.quietTop)[0] < oklch(C.failFlowTop)[0] && oklch(C.quietTop)[1] <= oklch(C.failFlowTop)[1], 'quiet heap: darker and no more chroma than the failing-flow one');

// ── the tiers ──
ok(redTier(0) === TIER_HOT && redTier(RED_HOT_MS - 1) === TIER_HOT, 'tier: under an hour is hot');
ok(redTier(RED_HOT_MS) === TIER_RED && redTier(7.4 * H) === TIER_RED && redTier(RED_RUST_MS - 1) === TIER_RED, 'tier: 1 h – 7 d is red (net-control-plane at 7.4 h)');
ok(redTier(RED_RUST_MS) === TIER_RUST && redTier(106 * D) === TIER_RUST, 'tier: 7 d and more is rust (PhiCad-Studio-Shared at 106 d)');
ok(redTier(-1) === TIER_RED && redTier(NaN) === TIER_RED, 'tier: an unknown age is red (the middle, never hot)');
ok(tierFlipIn(30 * 60_000) === 30 * 60_000 && tierFlipIn(2 * D) === 5 * D && tierFlipIn(8 * D) === Infinity, 'tier: the next flip (hot → red at 1 h, red → rust at 7 d, rust never)');
ok(redFor(106 * D) === 'red 106 d' && redFor(7.4 * H) === 'red 7 h' && redFor(12 * 60_000) === 'red 12 min', `hover words: ${redFor(106 * D)}, ${redFor(7.4 * H)}, ${redFor(12 * 60_000)}`);
ok(PR_OLD_MS === 14 * D, 'PRs untouched 14 d and more desaturate');

// ── the beat ──
ok(inBeat(TIER_HOT) && !inBeat(TIER_RED) && !inBeat(TIER_RUST), 'beat: only the hot tier moves; red holds still, rust is out of the beat');

console.log(fails ? `FAIL: ${fails} failed` : 'red: all ok');
if (fails) process.exit(1);
