# Runtime lifecycle cleanup (M1)

This page describes how `BotRunner` (core) owns and terminates a bot process tree, and how the
M1 lifecycle oracles L01–L13 check the shared `createSession()` runtime end to end. It covers
Linux evidence only; Windows and macOS behaviour is pending until it is executed on those systems.

## BotRunner ownership model (core)

- On non-Windows platforms the bot is spawned with `detached: true`, so it leads a new process
  group whose PGID equals its PID. That group, plus the leader's `/proc` start time, is the
  **owned group** of the current run. Signals target only the recorded group, never global,
  port-based or PID-pattern matches.
- The owned group is retained after the direct child exits, including an unexpected exit with code
  `0`, for as long as any live member of that group remains. It is discarded as soon as the group is
  confirmed empty. Captured leader start time detects observed identity reuse. This is not an
  absolute PID/PGID reuse guarantee: identity checks and signalling have a check-to-signal race.
- A group is **empty** when `kill(-pgid, 0)` reports `ESRCH`, or, on Linux, when every remaining
  member is a zombie. If a live process now holds the PGID number but its start time differs from
  the recorded leader, the owned group is already gone, because a PGID cannot be reused while any
  member exists. Unreadable or malformed proc records and `EPERM` are uncertainty, not proof of
  death. An uncertain group probe rejects signalling and retains ownership for retry. If the
  original leader identity was never captured and the leader is now missing, only `ESRCH`
  releases ownership; a live group might belong to a reused leader that has also exited.
- `stop(graceMs)` sends `SIGTERM` to the owned group and waits up to `graceMs` for both the direct
  child's exit and an empty group. It then sends `SIGKILL` and waits up to
  `Math.min(2000, graceMs || 2000)`. `graceMs = 0` keeps its existing meaning: force almost
  immediately, then wait up to 2 s.
- On Linux, `stop()` resolves only after termination is confirmed. Otherwise it **rejects** and keeps
  ownership of both the child and the group, so a later `stop()` can retry. `start()` refuses to run
  while ownership is retained. Concurrent `stop()` calls share one operation.
- Wait helpers detach their losing listener: the `exit` listener when the timer wins, and the
  `spawn`/`error` pair in `waitForSpawn`. Child event handlers are generation-guarded, so a stale
  event cannot change a newer run's snapshot.
- Windows: when cleaning up a live owned child, `stop()` requires a zero exit from `taskkill /T`
  (graceful or forced) and awaits the direct child's termination, escalating with `/F` if that child remains live.
  Each taskkill command is bounded by `Math.min(2000, graceMs || 2000)` milliseconds, separately
  from the child-exit waits. On timeout, only the owned taskkill helper is best-effort terminated.
  A completed nonzero graceful command permits exactly one `/F` attempt only while the same
  owned direct child remains live. A departed child is never targeted again. The forced command
  must exit zero and the direct child must terminate within the bounded force wait; otherwise
  cleanup rejects. A thrown spawn error, emitted error, signal-only command exit, or command
  timeout never triggers automatic escalation and rejects cleanup. A nonzero forced command also
  rejects cleanup. Unconfirmed cleanup retains ownership and
  blocks `start()`, even if the direct child subsequently exits. A live owned child permits retry
  after command failure, but not after a command timeout: the timed-out mutating helper may still
  execute, so timeout uncertainty is conservatively latched even if helper termination was requested.
  Once the bot has exited, retry also continues to reject rather than targeting a potentially reused PID.
  Recovery from that retained uncertainty requires external, independently verified cleanup; there
  is no automatic ownership-reset API. Deterministic mocked tests cover these control-flow
  boundaries only. Successful taskkill plus direct-child exit is not independent descendant-death
  evidence. A leader that exited before cleanup without a recorded failure still has no retained
  Windows tree handle; no-op stops do not run taskkill. Unexpected-leader-exit descendant cleanup,
  real Windows process-tree qualification and macOS execution remain pending.
- Existing `start`, `stop`, `restart` and `snapshot` signatures are unchanged. Snapshots remain
  event-driven: terminal status and exit code are classified by Node's exit callback, never guessed.
  The additive `observeExit()` supervision method returns `alive`, `exited` or `unknown`; Linux
  runtime supervision uses it to detect a proven direct-child exit before Node dispatches that
  callback. It never releases ownership or replaces waiting for reaping. Runtime supervision gates
  observation on actual start/exit evidence, so a never-started `stopped` snapshot is not an exit.
- Missing, unreadable or malformed procfs is uncertainty, not proof of child death. A per-PID
  missing record is interpreted only after a valid `/proc/self/stat` availability check and an
  `ESRCH` result from a non-destructive PID probe. A successful group-existence probe with no visible
  matching members is also unknown, not empty. Restricted procfs visibility can prevent cleanup confirmation; uncertainty retains ownership rather than
  authorizing destructive signals or reporting confirmed cleanup.

## Runtime oracles (`packages/runtime/tests/lifecycle.test.mjs`)

The tests use the public `createSession()` / `Session` API only. The fixture project in
`packages/runtime/tests/fixtures/lifecycle/` is an offline, loopback-only raw-interaction-webhook bot.
That bot starts a grandchild in its own process group. Each process reports its identity
(`role`, `pid`, `ppid`, `pgid`, `starttime`) and lifecycle events as JSON lines.

Fixture modes are selected by an ordinary, non-secret control file,
`<TMPDIR>/disrunner-lifecycle-control.json`, which holds `{ "mode", "reportPath" }`. `TMPDIR` is
one of `BotRunner`'s default inherited environment keys. No credentials, tokens or network
addresses pass through it.

| Mode             | Behaviour                                                                      |
| ---------------- | ------------------------------------------------------------------------------ |
| `normal`         | Answers signed PING and commands, and exits on `SIGTERM`.                      |
| `stubborn-tree`  | The bot and its grandchild both ignore `SIGTERM`.                              |
| `stall-tcp`      | Never listens, so TCP readiness stalls.                                        |
| `stall-ping`     | Listens but holds every signed PING open.                                      |
| `exit-startup-N` | Exits with code `N` (`0` or `1`) after the grandchild is up, before readiness. |

In `normal` mode, these commands are available:

- `/stall-body` sends valid authenticated headers, then stalls the body.
- `/slow` answers after 400 ms.
- `/exit0` and `/exit1` send a valid callback, then exit with that code 100 ms later.

| Oracle                    | What is checked                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| L01 abort-before-spawn    | A pre-aborted `start` rejects with `cancelled`. No PID is reported, no endpoints are published, and handles stay at baseline.                                                                                                                                                                                                                                                                                                                                                                                          |
| L02 abort-readiness       | Aborting during TCP readiness or a held signed PING settles with `cancelled` within 3 s. No command is sent, the parent and grandchild are dead, and ports are closed.                                                                                                                                                                                                                                                                                                                                                 |
| L03 abort-body            | After authenticated headers arrive with a stalled body, `invoke` rejects with `cancelled` (abort) or `timeout` (deadline). Nothing is accepted, the bot sees the socket close, and the later `stop` is `ok`.                                                                                                                                                                                                                                                                                                           |
| L04 stop-start-race       | `stop` at the starting snapshot, after endpoints are listening, after spawn but before PING, and at the running snapshot. `start` rejects with `cancelled`, `stop` returns `ok` within 3 s without waiting for readiness, and the tree is dead with ports closed.                                                                                                                                                                                                                                                      |
| L05 repeat-dispose        | Concurrent `stop` and `dispose` calls coalesce, and the parent gets exactly one `SIGTERM`. After dispose, `start` and `invoke` reject with `invalid`, and a repeated `dispose` returns `ok`.                                                                                                                                                                                                                                                                                                                           |
| L06 / L07 unexpected exit | Exit code `0` or `1` during startup rejects `start` with `child-exited`. Exit after a valid callback but before shutdown makes `stop` return `ok:false` with `child-exited`. The surviving grandchild is terminated in both cases.                                                                                                                                                                                                                                                                                     |
| L08 generation-isolation  | A late `/slow` success cannot overwrite the stopped state. A stale `runId` is rejected with `not-running`. Event `runId` values never revert, and the sequence strictly increases.                                                                                                                                                                                                                                                                                                                                     |
| L09 wait-listener-balance | Handle counts return to the settled baseline after the success, failure and cancel paths. Listener counts are not measured.                                                                                                                                                                                                                                                                                                                                                                                            |
| L10 stubborn-tree         | A parent and grandchild that both ignore `SIGTERM` are both confirmed dead after `stop`. Otherwise `stop` returns `ok:false` with a `cleanup` issue.                                                                                                                                                                                                                                                                                                                                                                   |
| L11 / L12 / L13           | Twenty success cycles (start, invoke, stop), twenty failure cycles (`exit-startup-1`) and twenty cancel cycles (abort during a held PING) on one session, then `dispose`. Each cycle records its tree PIDs with `pgid` and start time, its error code or abort time, and its ports. Every PID is checked dead and every port closed, handles return to baseline, and the last cycle's ports are reused. After the failure cycles, `dispose` reports only the last run's `child-exited` issue, with no `cleanup` issue. |

## Runtime cleanup failures (`packages/runtime/tests/cleanup-failures.test.mjs`)

The runtime manager owns three resources per run: the bot process (`BotRunner`), the local REST
emulator and the local Gateway server. Cleanup behaves as follows when one of them cannot be
confirmed closed:

- **Every resource is attempted.** Cleanup withdraws published endpoints and per-run interaction
  secrets first, then stops the bot, REST and Gateway in that order, awaiting each one. A failure
  does not skip later resources. Each unconfirmed resource adds one `cleanup` issue to
  `ShutdownResult.errors` that names the resource. The thrown error text is never copied into
  issues, events or snapshots.
- **Unconfirmed resources stay owned.** A resource is released only when its own `stop()`
  resolves (for the bot, with a terminal status). While anything is still owned, `start` and
  `selectProject` reject with `invalid` and read nothing, `invoke` rejects with `not-running`,
  endpoints stay `null`, and the phase is `error`. The legacy `RuntimeManager.selectProject`
  rejects the same way, before reading or replacing the project configuration, and leaves the
  state, ownership and recorded failures unchanged.
- **`pid: null` is not proof of exit.** After a failed cleanup the snapshot no longer publishes an
  active PID, but the process may still be running. Judge the outcome from `ok: false`, the
  `cleanup` issues and independent process evidence. A possibly stale PID is never published
  again.
- **Retry is caller-driven.** A later `stop()` or `dispose()` calls `stop()` again only on the
  resources still owned. Resources already released are not closed a second time. There is no
  timer, background or automatic retry. Each further attempt goes through the resource's own
  existing `stop()`, so `BotRunner`'s idempotent stop and its Windows timeout latch decide the
  outcome, and the runtime never resets ownership on its own.
- **Concurrent calls coalesce.** Concurrent `stop()` and `dispose()` calls share one cleanup
  attempt. A `stop()` requested while `start()` is failing waits for the startup cleanup and then
  makes one further attempt on whatever is still owned. `start()` still rejects with the original
  startup error.
- **Issues are kept apart.** A successful retry clears `cleanup` issues but keeps an unexpected
  `child-exited` issue from the same run until the next `start()`. A startup failure combined
  with a cleanup failure reports both parts in the state error, and `start()` rejects with the
  startup error. After an unexpected exit whose cleanup failed, the state error keeps the cleanup
  message next to the exit message.
- **A failed dispose stays disposed.** Later `dispose()` or `stop()` calls may retry cleanup, but
  `start`, `invoke` and `selectProject` remain rejected.

The tests inject failures through an internal, instance-scoped dependency seam. The optional third
`RuntimeManager` constructor argument and the internal `createSessionWithDependencies` factory in
`session.ts` accept `wrapBot`, `wrapRest` and `wrapGateway`. The legacy `RuntimeManager` remains
exported, with an additive optional constructor argument. The internal factory and standalone
dependency symbols are not exported from the package entry point. The callbacks are copied when
the session is constructed. Each real resource is
assigned to its owned field before it is wrapped, so a throwing wrapper still leaves the original
owned for cleanup. Production `createSession()` uses identity defaults. There is no CLI, IPC,
configuration or environment fault switch.

Test-owned wrappers keep two append-only logs. A journal records `{resource, operation, attempt,
phase}` for every wrapper call. A delegation log records only the calls that actually reach the
real resource. A failure injected before delegation (the real method never ran) is distinguished
from delegate-then-reject (the real method ran) only by where it was injected. Real effects are
checked independently, using `/proc` identity for fixture-reported PIDs, closed and reusable
ports, handle counts, and a control process that must survive.

| Group   | What is checked                                                                                                                                                                                                                             |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C01–C05 | Bot, REST or Gateway stop fails before delegation, singly or together. Every resource is attempted, siblings truly close, failed ones stay alive or listening and owned, `pid` is `null`, and a healthy retry stops only the retained ones. |
| R01–R13 | Blocked `start` and `selectProject`, coalesced stop/stop and stop/dispose, failed dispose and its retry, unexpected exit plus cleanup failure, manager `selectProject`, and stop during a failing start (exactly two bot stop calls).       |
| A01–A11 | Wrapper creation and each start boundary fail (before and after delegation), plus cancellation and the startup deadline at every boundary. Every acquired original is cleaned exactly once and the startup error stays primary.             |
| U01–U04 | Delegate-then-reject at stop retains ownership with no automatic retry until a caller stop. A mocked latched helper timeout launches its helper once. Unknown liveness is `transport`, not `child-exited`.                                  |
| V01–V04 | Endpoints are withdrawn before the first close settles, `invoke` is blocked, nothing is republished, and a later run gets a new run ID.                                                                                                     |
| S01–S10 | The seam copies callbacks, passes only the real instance, keeps the receiver and the live `address` getter, is absent from the public entry point and is scoped per session. A disposed session stays unusable.                             |

The mocked latched-timeout case is control-flow evidence only, not a Windows process-tree test.
Per-run key and peer-secret destruction is checked by code review: cleanup drops the references
and each start creates new material. It is not observed dynamically.

Core-level oracles live in `packages/core/tests/integration/bot-runner-lifecycle.test.ts`, with
fixtures in `packages/core/tests/fixtures/bot-runner-lifecycle/`. They cover:

- D4-A, unexpected clean parent exit.
- D2/D4-B, a graceful parent exit while a `SIGTERM`-ignoring grandchild survives.
- Release of ownership.
- `graceMs = 0`.
- L09 handle balance.
- An L10 core variant.

### Evidence rules

- Liveness comes from `/proc/<pid>/stat`. A process is dead if the entry is missing, if it is a
  zombie (`Z`), or if its start time has changed (the PID was reused). `kill(pid, 0)` alone is never
  used.
- The fixtures report grandchild PIDs themselves, because the direct child's PID disappears from
  snapshots once it exits.
- Each test records a test-owned process outside the runner's group as a control. It must survive.
- Each test has a bounded timeout. Containment kills only recorded PIDs whose start time matches.
  If containment has to kill anything, the test fails; containment is never treated as proof of
  cleanup.

### Not covered

- **Listener counts** on `BotRunner`'s private child (D1, D5, L09). By decision, there is no
  test-only hook and no private access. Only behaviour and handle counts are asserted.
- **A grandchild that calls `setsid`** or otherwise leaves the owned process group. It is not owned
  and is not killed, by design, with no global kill.
- **D2's real-process rejection path on Linux.** Real-process tests do not force `SIGKILL` failure.
  The separate deterministic `bot-runner-boundaries.test.ts` uses fake child/proc observations and
  a mocked signal function to test uncertainty rejection, retained ownership and successful retry;
  these results are not evidence of real-kernel signal failure recovery.
- **D5's stale-event corruption** through the public API. A spawn failure (`ENOENT`) emits `error`
  but no `exit`. A post-spawn child `error` cannot be produced publicly. The generation guard and
  the retained ownership are covered by code review only.
- **D3 real Windows `taskkill`**, and macOS process-tree behaviour. These are pending until
  executed on those systems; mocked command/child events do not qualify a real Windows tree.
- **L04's "close every resource even if one fails"** and **L05's "failed cleanup is retried"**
  are not covered by real-process failures. They are covered by the injected cases in
  `cleanup-failures.test.mjs` (see above), which use the internal dependency seam.

## Permission opt-in and run identity

The shared-runtime [ordinary-message permission opt-in](project-configuration.md#ordinary-message-permission-opt-in) validates its paired bot fixture and initial state before starting listeners or a child. Missing permission grants are not a startup error when the fixture is otherwise structurally admitted: the ordinary REST operation denies at request time.

The configured bot ID is stable across starts of that selected project. It does not make credentials reusable: each run still gets a fresh run ID, synthetic token, signing key and peer secret, and stale invocations remain invalid. Application/application-owner IDs remain synthetic and distinct from the bot. The opt-in does not change resource ownership, cleanup or retry rules above.

## Live conversation projection

Desktop displays a read-only projection of ordinary messages from the current running
session's retained core store. A message is eligible only when its visibility is explicitly
`channel`, its type is `0`, its flags are one of `0`, `4`, `4096`, or `4100`, and it belongs
to an existing type-0 guild text channel in the same guild. Unknown visibility, private or
ephemeral messages, unsupported flags, and mismatched channel/guild references are excluded
before renderer IPC. This is a bounded supported-channel view, not a general Discord
permission system or support for direct messages. Even with ordinary-message permission
enforcement enabled, this remains a diagnostic state projection, not a viewer-permission-filtered
view. Renderer snapshots do not expose role/member resources or raw user roles, channel
permission overwrites or guild owner permission context.

The projection is capped by resource count and serialized bytes. Truncation and unavailable
snapshots are shown explicitly; absence from this view does not prove a resource was deleted.
Session publication revision and core state revision are separate counters. Desktop consumes
only the accepted current session/run snapshot, clears the feed while resynchronizing or when
stopped, and does not append optimistic messages. A failed cleanup can retain the underlying
store for a retry without presenting it as a running conversation.

Command callback responses remain invocation diagnostics, not state-backed conversation rows.
The model-only browser mode retains its separate example messages. Invocation validation and
wire actor identity read the full retained live store, never the truncated display projection.
Deleted actors/channels/guilds and unsupported or reassociated channels invalidate contexts;
pre-run validation still uses the selected, frozen project fixtures.

## Signed PING readiness retries

A readiness transport failure reported as `TypeError('fetch failed')` can happen
after the bot has accepted a request but before its response reaches the runtime.
Readiness retries therefore wait until the actual wall-clock signing second is
later than the previous attempt. The PING body and authentication protocol are
unchanged, and peer-authentication failures still stop startup without retrying.

Polling remains cancellable at 50 ms intervals under the original startup
deadline. Under normal clocks, a retry can take roughly one extra second; slow
startup or connection-refusal polling can consequently exhaust that deadline
with fewer attempts. A frozen or backward-adjusted wall clock waits for recovery
or cancellation/deadline expiry, rather than inventing a future timestamp. A
clock rollback between checking time and signing is rejected before dispatch.

The focused readiness regression injects loss of an authenticated response from
the actual loopback fixture. This establishes the controlled retry/replay hazard;
it does not attribute any historical intermittent startup failure to that cause.
