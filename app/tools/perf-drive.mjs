// A drive like `bun exact.mjs agent <host> …`, with the app on a normal event loop (EXACT_AGENT=live)
// so `perf frames live <ms>` and the yard's HUD measure real frames, not the agent's stepped clock.
// Build first with any `bun exact.mjs agent <host> …` drive; then, from app/:
//   EXACT2=… bun tools/perf-drive.mjs macos --size 1440x900 "clock data" … "perf frames live 5000" "screenshot x.png"
// The numbers go in PERF.md.
const exact2 = process.env.EXACT2;
if (!exact2) { console.error('EXACT2 names the exact checkout'); process.exit(1); }
const { main, open } = await import(`${exact2}/scripts/agent.mjs`);
const [host, ...rest] = process.argv.slice(2);
process.exit(await main([host, '--app', 'app', ...rest], { open: (o) => open({ ...o, env: { ...(o.env ?? {}), EXACT_AGENT: 'live' } }) }) ?? 0);
