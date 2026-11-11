// A drive like `bun exact.mjs agent <host> …`, with the app on a normal event loop (EXACT_AGENT=live)
// so `perf frames live <ms>` and the yard's HUD measure real frames, not the agent's stepped clock.
// Build first with any `bun exact.mjs agent <host> …` drive; then, from app/:
//   EXACT2=… bun tools/perf-drive.mjs macos --size 1440x900 "clock data" … "perf frames live 5000" "screenshot x.png"
// The numbers go in PERF.md. EXACT_CANVAS_STATS=1 passes through: the macOS host then logs, once a
// second, its canvas replays (GPU or bitmap) and the GPU module's ms per replay.
const exact2 = process.env.EXACT2;
if (!exact2) { console.error('EXACT2 names the exact checkout'); process.exit(1); }
const { main, open } = await import(`${exact2}/scripts/agent.mjs`);
const [host, ...rest] = process.argv.slice(2);
process.exit(await main([host, '--app', 'app', ...rest], { open: (o) => open({ ...o, env: { ...(o.env ?? {}), EXACT_AGENT: 'live', ...(process.env.EXACT_CANVAS_STATS ? { EXACT_CANVAS_STATS: process.env.EXACT_CANVAS_STATS } : {}) } }) }) ?? 0);
