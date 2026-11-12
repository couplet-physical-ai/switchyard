# Phantom and stale data on Live, the board and the Yard

On 2026-11-12, Switchyard showed things that were not so. Pipelines sat in the waiting column with nothing behind them. Runs that had finished stayed "running" for minutes after a deploy, and on some clients for good. Main lines were red when their CI was green, deploys read "failed" after a redeploy had passed, and the Yard counted engine slots twice. There was no single cause. A user report and an audit that compared the served snapshot with each upstream found six, in the client, the server's warm boot, the stream's resume, and two upstream adapters. All were fixed the same day; the fixed server and web client were live at 19:14 UTC. This report is blameless: it describes mechanisms, not people.

## Impact

Switchyard only reads its upstreams, so no CI run, deploy, or upstream record was changed and no data was lost. The harm was trust: a control room that shows a phantom sends people to look at work that does not exist, and hides real work among false reds.

| What was shown | Why it was wrong | On the live fleet |
|---|---|---|
| Pipelines "waiting" with no run behind them | Woodpecker had deleted them; Switchyard never pruned them | 3 when traced, on every client |
| Runs "running" 8–20 min after they finished | the server held their finish during its warm boot after each deploy | after every deploy |
| Removed runs that never left a client's view | the client applied deltas to a stale fleet after a reset | until the app reloaded |
| Red main lines | CodeQL, Dependabot, or pull-request runs counted as the main line's CI | 24 red, 12 real |
| "Deploy failed" | a manual redeploy that passed did not supersede the failed push deploy | for up to a day |
| Yard engine slots | a Dagger host's slots were counted once for the host and again for its agents | 28 shown, 16 real |
| A push without CI as waiting intake | the commit had no CI to wait for | each such push |

"Needs a human", the count of things that want someone's attention, fell from 28 to 13 once the fixes were live.

## Timeline (UTC)

| When | Event |
|---|---|
| 05:40 | The warm boot ships: after a restart the server serves its last state and holds entity changes until the store settles, about six minutes later. It fixes a half-empty fleet after each deploy, and starts the frozen-run problem below. |
| 16:50 | Phantom waiting pipelines are traced to Woodpecker's created-then-deleted pipelines and fixed (`b23b922`). The fix is live at 17:40; after the warm boot settles, the known phantoms are gone. |
| 17:40–18:05 | Phantoms are still reported. The client and server teams audit the served snapshot against the upstreams. |
| 18:05 | The client bug is found: a server reset could be cancelled by the next frame. Fixed in `0a02dd2`, with the resume reset on the server in `a65ad31`. |
| 18:17 | The upstream audit's fixes for main lines, deploys, and pushes without CI land (`f95db94`). Against the live fleet, they make the GitHub inventory pages too slow: GitHub answers some pages without data and one organization's list stops at 200 repositories, leaving 113 blank main lines. |
| 18:35 | `6b6135b` reads per-commit checks only for red commits and keeps the last list when a page has no data. |
| about 18:40 | Runs finishing during a deploy's warm boot are reported as still running. |
| 18:50–19:03 | The warm boot lets runs, deploys, engines and the queue through (`9bb1679`), and the served snapshot follows them (`03a3e12`). |
| 19:14 | Server `03a3e12` and web client `6b6135b` are live. Across a restart, a finished run shows finished within 5 s. |
| 19:18 | A failed GitHub Actions deploy run no longer keeps a main line red once the commit's deploy succeeded (`844f290`). |

## Causes and fixes

### 1. A reset cancelled by the next frame (client)

When the server cannot resume a client's stream, it sends a reset, and the client must discard its fleet and fetch the snapshot again. The client marked the stream `reset` and armed a refetch 250 ms later, as a gated task. In Exact, a gated task's timer lives only while its gate holds. The next frame on the stream set the status back to `live`, which disarmed the refetch. Later deltas landed on the stale fleet. An entity removed between the old fleet and the new one never received a removal, so it stayed on the client's board for good.

**Fix** (`0a02dd2`): a reset is sticky until the fleet has been fetched again; frames after it are dropped, not applied. A stream reopened after a drop also asks `/api/v1/meta` which server process answers; a different `epoch` means the server restarted, and the client refetches rather than trusting its fleet across processes. `ad702e9` adds `app/tools/stale.test.ts`, which proves that an upsert replaces a pipeline in every view and a removal takes it out of every view. It also hardens two spots the test found: the intake no longer counts a queued id the fleet removed or holds finished, and Live's machine no longer shows a removed run as busy.

The web client got the fix with the 19:14 deploy. The macOS app gets it in 0.1.8.

### 2. Resuming across a restart (server)

A client that resumed at a sequence number from before a restart received the new process's frames after that number. Its fleet came from the old process, which the new one never diffed against, so entities only the old process had (a pipeline Woodpecker deleted meanwhile) were never removed.

**Fix** (`a65ad31`): the hub records `boot_seq`, the sequence it started numbering after. A resume at or before it gets a reset. `server/tests/restart_resume.rs` covers it. The client's epoch check (cause 1) closes the same gap from the other side.

### 3. The warm boot froze runs (server)

The warm boot held every entity change until the store settled, 6–10 minutes after a restart. A run that finished during that window stayed "running" on Live and the board, and `/api/v1/snapshot` kept serving the frozen last state. A client that connected or refetched mid-boot, and the audit script, saw finished runs as running while the stream already carried their finish.

**Fix** (`9bb1679`, `03a3e12`): only the half-built fleet's churn is held. Pipelines the last state holds or that are running now, running deploys, engines, and the queue go out at once, as whole entities applied to the warm state, so the settle diff starts from what clients hold. Removals go out only for runs the last state holds; repositories, commits, and derived views still wait for the settle. The served snapshot follows what went out. `server/tests/warm_boot.rs` covers a run finishing during the boot (finished at once) and a historic one (waits for the settle). See [Server architecture](../../architecture/server.md#metadata-and-warm-boot).

### 4. Woodpecker's created-then-deleted pipelines (server)

Woodpecker stores a pipeline as `created` on every webhook before it reads the repository's configuration, then deletes it unpublished when no workflow matches the event (a merged or closed pull request, a label change). The reconcile and feed polls caught such pipelines in that window and mapped them to Pending. The later 404 was ignored, and Pending pipelines are never pruned, so they sat in the waiting column forever.

**Fix** (`b23b922`): a `created` pipeline without workflows maps to no facts; a real one is published again with its workflows moments later. A 404 on a pipeline's detail sends `Fact::PipelineGone`, and the store removes it through `Store::remove_pipeline`, the same path as the age-based prune. Timeouts, 401s, and 5xx responses change nothing. `server/tests/pipeline_gone.rs` covers it.

### 5. False red main lines and false failed deploys (server)

The main line read GitHub's combined `statusCheckRollup.state`. That state counts CodeQL and Dependabot scanning and runs triggered by pull requests, so 11 of 24 red main lines were red only for a CodeQL "Analyze" job, one for a superseded push deploy and one for a pull request's run. Separately, a failed push deploy stayed "failed" after a manual redeploy passed, because a manually dispatched workflow run is not in the commit's check rollup.

**Fix** (`f95db94`, `6b6135b`, `844f290`):

- A main line reads its red commits' own check contexts: scanning and pull-request runs are out, and a newer Roadrunner push or manual status wins.
- A manual Roadrunner run that runs the deploy workflow counts as a deploy, so a passing redeploy supersedes the failed one. A cancelled deploy workflow, superseded by a newer push, is not a failed deploy.
- A failed GitHub Actions deploy is read again over REST until a deploy run of that commit passes; once it has, the failed run no longer reds the main line.
- GitHub Actions runs that no poll reports any more are read after 3 minutes and closed, never "running" for good.

The first version read every history commit's contexts and made the inventory pages slow enough to fail; see the timeline. Reading contexts only for the commits the rollup calls red, 25 per call, fixed that, and a page answered without data now leaves the organization's list as it was. `server/tests/phantoms.rs` covers the cases on real response shapes.

### 6. Counting and intake (client)

The Yard's engine header counted a Dagger host's slots and then its agents' slots again (28 shown, 16 real); `app/tools/yard-slots.test.ts` pins the count. Live showed a push to a repository without CI as "no CI run has started yet" and counted it as waiting intake. A commit now waits for CI only where CI will run (`0a02dd2`, `f95db94`).

## What went well

- The audit compared the served snapshot with each upstream directly instead of reasoning from screenshots, which separated six causes that looked like one.
- Every fix has a test on the real upstream shapes, and each was deployed as soon as it was green.
- The read-only design held: nothing upstream needed repair.

## Lessons

- **A timer gate is not a latch.** State that must survive until something happens (a pending reset) has to be stored, not implied by a gate the next event can flip.
- **Never carry a fleet across server processes.** Sequence numbers from another process mean nothing to this one. Both sides now check: the server by `boot_seq`, the client by `epoch`.
- **Holding everything trades one wrong picture for another.** The warm boot fixed a half-empty fleet by freezing it. Hold only what is half-built; let what is already known keep moving.
- **"Created" does not mean "exists".** An upstream record can vanish. A 404 is information, and a state that is never pruned needs a way out.
- **A combined status is not CI status.** Read what the main line's own CI said, and treat scanning and pull-request runs as separate signals.
- **A fix can regress elsewhere.** A heavier query fixed the reds and broke the inventory. Read the expensive detail only where it changes the answer, and never let an empty upstream page truncate a list.
- **Audit against the source.** Phantoms survive in views because each view trusts the one before it.

See also [Server architecture](../../architecture/server.md), [Deploying and operating](../../guides/deploying.md), and the [wire contract](../../reference/contract.md).
