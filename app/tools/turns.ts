// The data module's turns on the boot path, measured in Bun (JIT). On native hosts every turn of
// a data-module answer has 100 ms of CPU on Hermes, and a slow Mac (GitHub's 3-core M1 runner, a
// loaded laptop on efficiency cores) runs Hermes several times slower than the build Mac, so the
// boot path keeps every turn small: this finds the big ones. A turn ends where the module awaits
// `scheduler.yield()` or a fetch, and starts when the host calls a source or resumes one.
//
//   bun app/tools/turns.ts [demo|fixtures|<server url>] [--max <ms>]   (default: demo; --max fails
//   over it; `fixtures` serves contract/fixtures with server/mock.ts for the run)
//
// The budget in Bun's milliseconds: Hermes (an interpreter) runs this code ~10-25x slower than
// Bun's JIT on the same core, and a slow Mac 2-4x slower again, so a Bun turn of 2 ms is ~80 ms
// on the slowest Mac we ship to. tools/turns.test.ts holds the boot path to that.

type Turn = { at: string; ms: number };

let runs = 0;
export async function measure(server: string, size = { w: 1440, h: 900 }): Promise<Turn[]> {
  const turns: Turn[] = [];
  // a fresh data module each run (the demo and the world live in it), as a launch has
  let label = 'import';
  let last = performance.now();
  const end = (why: string) => { turns.push({ at: `${label} → ${why}`, ms: performance.now() - last }); };
  const resume = () => { last = performance.now(); };
  (globalThis as { scheduler?: unknown }).scheduler = {
    yield: () => new Promise<void>((r) => { end('yield'); setTimeout(() => { resume(); r(); }, 0); }),
  };
  const t0 = performance.now();
  const { sources, draw } = await import(`../app.ts?run=${++runs}`);
  turns.push({ at: 'import → module evaluated', ms: performance.now() - t0 });
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string, init?: RequestInit & { exactStream?: unknown }) => {
    if (init?.exactStream) return new Response('', { status: 200 }); // the stream: not on the boot path
    end(`fetch ${String(input).replace(/^https?:\/\/[^/]+/, '').slice(0, 40)}`);
    const r = await realFetch(input, init);
    const body = await r.arrayBuffer();
    resume();
    return new Response(body, { status: r.status, headers: r.headers });
  }) as typeof fetch;
  const call = async (name: string, args: unknown[]) => {
    label = name;
    resume();
    const v = await (sources as Record<string, (a: unknown[], s: unknown, st: unknown) => unknown>)[name](args, { get: () => '', set() {} }, {});
    end('answer');
    return v;
  };
  const noop = () => {};
  const ctx = new Proxy({}, {
    get: (_t, k) => (k === 'measureText' ? (s: string) => ({ width: 6.6 * String(s).length }) : k === 'canvas' ? { width: size.w, height: size.h } : k === 'createLinearGradient' || k === 'createRadialGradient' ? () => ({ addColorStop: noop }) : noop),
    set: () => true,
  }) as never;
  const paint = (surface: string, args: unknown[], t: number) => {
    label = `draw ${surface}`;
    resume();
    draw(surface, args, ctx, { time: t, width: size.w, height: size.h, dpr: 2 } as never);
    end('frame');
  };
  try {
    const epoch0 = Date.UTC(2026, 10, 10, 20);
    const conn = (await call('connect', [server, '', 1, epoch0, 0])) as { ok: boolean; status: string; error?: string };
    if (!conn.ok) throw new Error(`connect: ${conn.status} ${conn.error ?? ''}`);
    await call('overview', [16]);
    // the factory floor is the default view: its two layers on the boot path
    paint('factoryFloor', ['', '', 0], 24);
    paint('factoryFloor', ['', '', 0], 25);
    paint('factoryFloor', ['', '', 0], 26);
    for (let f = 0; f < 4; f++) paint('factoryLive', ['full', '', 0, f], 24 + 16 * f);
    for (const s of ['yardStatic', 'yardInfo', 'yardLive', 'yardTop']) paint(s, s === 'yardLive' ? ['full', '', 0] : ['', 0], 32);
    for (let f = 2; f < 6; f++) for (const s of ['yardInfo', 'yardLive', 'yardTop']) paint(s, s === 'yardLive' ? ['full', '', f] : ['', f], 16 * f + 32);
    await call('overview', [300]);
    await call('mainlines', ['', '', '', '', 300]);
    paint('mainlinesTable', [1, '', 0, 0, 0, '', '', '', 0], 320);
    await call('prs', ['', '', '', '', 300]);
    paint('prsTable', [1, '', 0, 0, 0, '', '', '', 0], 340);
    await call('fleet', [300]);
    await call('search', ['zinc', 300]);
  } finally {
    globalThis.fetch = realFetch;
  }
  return turns;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const max = args.includes('--max') ? Number(args[args.indexOf('--max') + 1]) : Infinity;
  let server = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--max') ?? 'demo';
  let mock: ReturnType<typeof Bun.spawn> | null = null;
  if (server === 'fixtures') {
    const port = 4800 + Math.floor((process.pid % 500));
    mock = Bun.spawn(['bun', 'server/mock.ts', '--fixtures', '../contract/fixtures', '--frozen', '--port', String(port)], { cwd: new URL('..', import.meta.url).pathname, stdout: 'ignore', stderr: 'inherit' });
    server = `http://127.0.0.1:${port}`;
    for (let k = 0; k < 100; k++) {
      try { if ((await fetch(`${server}/api/v1/meta`)).ok) break; } catch { /* not up yet */ }
      await Bun.sleep(100);
    }
  }
  process.on('exit', () => mock?.kill());
  // the first run also compiles (Bun's JIT warming up); then the median of three runs, turn by
  // turn (the boot path is deterministic, so turn i is the same work each run), so a GC pause in
  // one run is not taken for the code's cost
  await measure(server);
  const runs3 = [await measure(server), await measure(server), await measure(server)];
  const n = Math.min(...runs3.map((r) => r.length));
  const turns = Array.from({ length: n }, (_, i) => {
    const ms = runs3.map((r) => r[i]!.ms).sort((a, b) => a - b)[1]!;
    return { at: runs3[0]![i]!.at, ms };
  });
  const top = [...turns].sort((a, b) => b.ms - a.ms).slice(0, 12);
  for (const t of top) console.log(`${t.ms.toFixed(2).padStart(8)} ms  ${t.at}`);
  const worst = top[0]?.ms ?? 0;
  console.log(`${turns.length} turns · longest ${worst.toFixed(2)} ms (Bun)`);
  if (worst > max) { console.log(`FAIL: a turn over ${max} ms (Bun); on a slow Mac's Hermes that is over its 100 ms budget`); process.exit(1); }
  process.exit(0);
}
