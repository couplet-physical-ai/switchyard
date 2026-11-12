// The Yard's engines header counts each build slot once: a Dagger engine host's slots are its
// agents' slots (CONTRACT.md Engine.agents), so "x of N busy" sums the agents and the runners,
// as the host lanes do. Felipe saw "9 of 28 busy" where the fleet had 16 (2 hosts × 6 agent
// slots + the hosted GitHub runners' 4, the two hosts' own 6 + 6 counted again).
//   bun app/tools/yard-slots.test.ts
import { World } from '../src/world.ts';
import { engineGroups } from '../src/yard/layout.ts';

let failed = 0;
const eq = (a: unknown, b: unknown, what: string) => {
  const ok = JSON.stringify(a) === JSON.stringify(b);
  if (!ok) failed++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${ok ? '' : `: ${JSON.stringify(a)} != ${JSON.stringify(b)}`}`);
};
const eng = (id: string, kind: string, host: string, slots: number, agents?: string[]) => ({ id, kind, host, online: true, slots, busy: 0, running: [], ...(agents ? { agents } : {}) });
const w = new World();
w.load({
  protocol: '0.6', seq: 1, at: 1, orgs: [], repos: [], commits: [], pipelines: [], prs: [], deploys: [], apps: [], queues: [], lanes: [],
  watcher: null, stats: null, groups: [], clusters: [], flakes: [], trends: [],
  engines: [
    eng('dagger:VM 153', 'dagger', 'VM 153', 6, ['wp-agent-1', 'wp-agent-2']),
    eng('dagger:VM 154', 'dagger', 'VM 154', 6, ['wp-agent-3', 'wp-agent-4']),
    eng('wp-agent-1', 'wp_agent', 'VM 153', 3), eng('wp-agent-2', 'wp_agent', 'VM 153', 3),
    eng('wp-agent-3', 'wp_agent', 'VM 154', 3), eng('wp-agent-4', 'wp_agent', 'VM 154', 3),
  ],
} as never);
const slots = engineGroups(w).flatMap((g) => g.engines).filter((e) => e.online !== false).reduce((n, e) => n + Math.max(1, e.slots), 0);
eq(slots, 16, 'the live fleet: 4 agents × 3 + the hosted runners 4 = 16 slots (not 28)');
eq(engineGroups(w).map((g) => [g.id, g.engines.reduce((n, e) => n + e.slots, 0)]), [['host:VM 153', 6], ['host:VM 154', 6], ['runners', 4]], 'each host lane: its agents\' slots');
if (failed) { console.log(`${failed} failed`); process.exit(1); }
console.log('yard-slots: ok');
