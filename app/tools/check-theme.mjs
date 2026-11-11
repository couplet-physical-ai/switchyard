#!/usr/bin/env bun
// The yard's canvas palette (src/yard/theme.ts) and the app's tokens (app.tamber) must agree:
// every colour in theme.ts's "tokens shared with app.tamber" block equals its `sy.<name>` token
// (camelCase → kebab-case; `packet` is `sy.amber`), and no ink meant for words is darker than
// ink3 (#8A8A8A, 5.6:1 on the canvas). Exits 1 on a mismatch. Usage, from app/: bun tools/check-theme.mjs
import { readFileSync } from 'node:fs';

const theme = readFileSync('src/yard/theme.ts', 'utf8');
const tamber = readFileSync('app.tamber', 'utf8');
const block = theme.slice(theme.indexOf('// tokens shared with app.tamber'), theme.indexOf('// canvas-only'));
const tokens = new Map([...tamber.matchAll(/^\s*sy\.([a-z0-9-]+)\s*=\s*(#[0-9A-Fa-f]{6})/gm)].map((m) => [m[1], m[2].toUpperCase()]));
const lum = (hex) => {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
};
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
let bad = 0, n = 0;
for (const [, key, hex] of block.matchAll(/^\s*([a-zA-Z0-9]+):\s*'(#[0-9A-Fa-f]{6})'/gm)) {
  const name = key === 'packet' ? 'amber' : key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
  const want = tokens.get(name);
  n++;
  if (!want) { console.error(`theme.ts ${key}: no sy.${name} in app.tamber`); bad++; }
  else if (want !== hex.toUpperCase()) { console.error(`theme.ts ${key} = ${hex}, app.tamber sy.${name} = ${want}`); bad++; }
}
const canvas = tokens.get('canvas') ?? '#0E0E0E';
for (const ink of ['ink', 'ink2', 'ink3', 'amber-text', 'red-text', 'green']) {
  const r = ratio(tokens.get(ink), canvas);
  if (r < 4.5) { console.error(`sy.${ink} is ${r.toFixed(2)}:1 on the canvas, under 4.5:1`); bad++; }
}
console.log(bad ? `${bad} problem(s)` : `theme.ts and app.tamber agree (${n} shared tokens); text inks ≥ 4.5:1 on the canvas`);
process.exit(bad ? 1 : 0);
