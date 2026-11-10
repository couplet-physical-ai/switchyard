// Synthetic word lists for the Switchyard mock fleet. Nothing here names a real person:
// authors are fixed handles, bots are the four fleet bots.

export const ORGS: { id: string; count: number }[] = [
  { id: 'Northwind-Labs', count: 240 },
  { id: 'Northwind-EMS', count: 70 },
  { id: 'Northwind-Forge', count: 45 },
  { id: 'couplet-physical-ai', count: 30 },
  { id: 'copper-browser', count: 25 },
];

/** Hand-picked "flagship" repos per org (always present, always hot or warm). */
export const FLAGSHIPS: Record<string, string[]> = {
  'Northwind-Labs': [
    'cicd', 'roster', 'atlas-desk', 'shell', 'mobile-fork', 'planner', 'access-broker', 'agent-hub', 'sim',
    'switchyard', 'tracker', 'pipelines', 'provisioning-api', 'feedback-hub', 'reports',
    'platform-ops', 'paper-studio', 'autofix', 'apps-template-fastapi', 'docs-site',
  ],
  'Northwind-EMS': ['plant-controller', 'cloud-fleet-api', 'cloud-fleet-web', 'fleet-gateway', 'plant-console', 'storage-driver'],
  'Northwind-Forge': ['thermal-model', 'forge-sim', 'optics-lab', 'mirror-control'],
  'couplet-physical-ai': ['couplet-core', 'rollout-farm', 'policy-zoo'],
  'copper-browser': ['copper', 'copper-extension', 'jev'],
};

const PREFIX = [
  'grid', 'lens', 'thermal', 'site', 'fleet', 'cell', 'pack', 'solar', 'storage', 'inverter',
  'meter', 'weather', 'forecast', 'tariff', 'billing', 'asset', 'field', 'sensor', 'edge',
  'cloud', 'ops', 'data', 'event', 'audit', 'auth', 'config', 'deploy', 'build', 'cache',
  'queue', 'trace', 'log', 'alarm', 'dispatch', 'market', 'bid', 'ledger', 'report', 'map',
  'heliostat', 'receiver', 'salt', 'turbine', 'pump', 'valve', 'charge', 'power', 'load',
  'policy', 'rollout', 'robot', 'gripper', 'vision', 'tab', 'page', 'dom', 'session', 'mesh',
];
const MIDDLE = [
  'telemetry', 'calibrator', 'model', 'sync', 'bridge', 'router', 'scheduler', 'planner',
  'ingest', 'exporter', 'collector', 'watcher', 'controller', 'agent', 'monitor', 'store',
  'index', 'replay', 'simulator', 'estimator', 'optimizer', 'registry', 'gateway', 'relay',
  'parser', 'renderer', 'inspector', 'notifier', 'archiver', 'compactor', 'tuner', 'probe',
];
const SUFFIX = ['', '', '', '', '-api', '-web', '-cli', '-sdk', '-worker', '-ui', '-svc', '-lib', '-rs', '-py', '-bench'];

/** Deterministically produce `n` unique repo names for an org using `rnd` (0..1). */
export function repoNames(org: string, n: number, rnd: () => number, taken: Set<string>): string[] {
  const out: string[] = [];
  for (const f of FLAGSHIPS[org] ?? []) {
    if (out.length >= n) break;
    if (!taken.has(f)) { taken.add(f); out.push(f); }
  }
  let guard = 0;
  while (out.length < n && guard++ < 100000) {
    const a = PREFIX[Math.floor(rnd() * PREFIX.length)]!;
    const b = MIDDLE[Math.floor(rnd() * MIDDLE.length)]!;
    const c = SUFFIX[Math.floor(rnd() * SUFFIX.length)]!;
    const name = `${a}-${b}${c}`;
    if (taken.has(name)) continue;
    taken.add(name);
    out.push(name);
  }
  return out;
}

export const HUMANS = [
  'mira', 'tbaker', 'jcho', 'ana-r', 'dkim', 'felipe', 'sol-v', 'okafor', 'lwen', 'priya-n',
  'mhale', 'rtorres', 'quinn', 'bsato', 'emmaj', 'kpatel', 'nadia-o', 'hugo', 'zli', 'carmen-g',
  'theo', 'ivanov', 'yusuf', 'gracel', 'fern', 'oduya', 'mattk', 'reina', 'sasha', 'wbell',
];
export const BOTS = ['autofix[bot]', 'renovate[bot]', 'phi-agent[bot]', 'copilot-swe[bot]'];

export const TEAMS = ['platform', 'ems', 'forge', 'physical-ai', 'copper', 'finance-eng', 'devex', 'data'];
export const RUNTIMES = ['fastapi', 'fastapi', 'fastapi', 'streamlit', 'node', 'node', 'static', 'rust'];

const VERBS = ['add', 'fix', 'drop', 'rework', 'speed up', 'harden', 'simplify', 'retry', 'cache', 'validate', 'expose', 'rename', 'split', 'guard'];
const AREAS = ['api', 'ui', 'ci', 'db', 'auth', 'deploy', 'sim', 'ingest', 'cli', 'docs', 'tests', 'cache', 'metrics', 'queue'];
const OBJECTS = [
  'pagination on the deploy list', 'stale lane cache', 'healthz timeout', 'flaky SOC test',
  'telemetry backfill', 'empty tariff window', 'websocket reconnect', 'migration ordering',
  'retry budget', 'site topology parser', 'dark mode tokens', 'build matrix', 'export to csv',
  'rate limiter', 'null culprit', 'dagger cache key', 'heartbeat drift', 'batch writer',
  'timezone handling', 'pre-commit hooks', 'error toast', 'trace sampling', 'search ranking',
  'queue starvation', 'settings form', 'session expiry', 'BESS setpoint clamp', 'map tiles',
];
const PR_TITLES = [
  'Add {o}', 'Fix {o}', 'Rework {o}', 'Speed up {o}', 'Harden {o}', 'Remove {o}',
  'Support {o} in {a}', '{a}: {v} {o}', 'WIP: {o}',
];
export const DEPS = [
  'fastapi', 'pydantic', 'uvicorn', 'sqlalchemy', 'httpx', 'react', 'vite', 'typescript',
  'eslint', 'tokio', 'serde', 'axum', 'clap', 'pytest', 'ruff', 'numpy', 'pandas', 'streamlit',
  'actions/checkout', 'actions/setup-node', 'dagger', 'zod', 'tailwindcss', 'prisma', 'reqwest',
];
const TEMPLATES = ['workflow', 'woodpecker', 'renovate', 'pre-commit', 'codeowners', 'dockerfile', 'lint config'];

const pick = <T>(xs: readonly T[], rnd: () => number): T => xs[Math.floor(rnd() * xs.length)]!;

export function commitTitle(author: string, rnd: () => number): string {
  if (author === 'renovate[bot]') return `chore(deps): update ${pick(DEPS, rnd)} to v${1 + Math.floor(rnd() * 9)}.${Math.floor(rnd() * 20)}.${Math.floor(rnd() * 10)}`;
  if (author === 'autofix[bot]') return `chore(autofix): sync ${pick(TEMPLATES, rnd)} template`;
  if (author === 'copilot-swe[bot]') return `Fix ${pick(OBJECTS, rnd)}`;
  const kind = pick(['feat', 'fix', 'fix', 'chore', 'refactor', 'test', 'perf', 'docs'], rnd);
  return `${kind}(${pick(AREAS, rnd)}): ${pick(VERBS, rnd)} ${pick(OBJECTS, rnd)}`;
}

export function prTitle(author: string, rnd: () => number): string {
  if (author === 'renovate[bot]') return `chore(deps): update dependency ${pick(DEPS, rnd)} to v${1 + Math.floor(rnd() * 9)}`;
  if (author === 'autofix[bot]') return `chore(autofix): sync ${pick(TEMPLATES, rnd)} template`;
  const t = pick(PR_TITLES, rnd);
  return t.replace('{o}', pick(OBJECTS, rnd)).replace('{a}', pick(AREAS, rnd)).replace('{v}', pick(VERBS, rnd));
}

export function branchName(author: string, rnd: () => number): string {
  if (author === 'renovate[bot]') return `renovate/${pick(DEPS, rnd).replace('/', '-')}-${Math.floor(rnd() * 9) + 1}.x`;
  if (author === 'autofix[bot]') return `autofix/sync-${Math.floor(rnd() * 9000) + 1000}`;
  const who = author.replace('[bot]', '');
  return `${who}/${pick(VERBS, rnd).replace(' ', '-')}-${pick(AREAS, rnd)}-${Math.floor(rnd() * 900) + 100}`;
}

export const LANE_NOTES = [
  'pinned to GHA until dagger cache fix lands',
  'failsafe: deploys via GHA when roadrunner is down',
  'migrating to roadrunner this week',
  'self-hosted runner only (needs GPU)',
  'held: release freeze',
];

export const BLOCKERS = [
  'required review from @platform', 'waiting on cicd#412', 'merge queue', 'needs rebase',
  'blocked on migration window', 'CODEOWNERS approval missing',
];
