# Linux raw G1: bounded packaged qualification

This harness exercises the shared runtime through the CLI and packaged Desktop.
Qualification requires evidence tied to the exact tested source and build; equal
trees do not make different commit/check identities interchangeable.

## Frozen independent case

The nine files under `apps/desktop/tests/fixtures/g1-parity` contain one guild
(`1000`), two text channels (`2000`, `2001`), and one user per loaded project.
Cases A/B invoke `/ping` in non-first channel `2001`, with literal expected text
`G1 parity reply.`. Actor A is `3000`; actor B is `3001` in a separate project
copy with its alternate template copied to the canonical config filename. No
multi-user loader or guild-membership guarantee is added.

The harness copies fixtures to its evidence directory and replaces exactly one
marked bot constant. Finite modes are normal, wrong-safe, pong-only,
exit-startup-0/1, delayed-reply, stalled-startup and stalled-command. The wrong
response is the authenticated literal `Different G1 reply.`; expected JSON is
never changed. Fixture request signatures and response peer authentication are
real. Trace files contain only process/context/port observations, not keys,
headers, signed bodies or tokens. The unchanged raw example is a separate
positive control.

A config-fault control changes only the temporary project's
`bot.startCommand` to a deliberately missing executable. Its fixed expectation is
invalid/exit 2 and no child trace. This is not a bot-constant mode or product API;
the original fixture hash and before/after config hashes are retained.

## Running with existing local prerequisites

Build core, runtime, CLI, Desktop renderer and Electron main/preload first, using
the pinned existing toolchain. No harness installation or bootstrap step exists.
Run `node apps/desktop/tests/e2e/g1-parity.mjs` from the repository, with:

- `G1_EVIDENCE_DIR`: a fresh directory; existing expectations cannot be overwritten.
- `G1_PACKAGED_EXECUTABLE`: a packaged candidate built from these source outputs.
- An already available graphical display on Linux.

`--cli-only` executes the built CLI subprocess matrix, but always records
`completeParity: false`. CLI results must never stand in for GUI acceptance.
The main GUI path uses Playwright Electron, a real file-backed packaged renderer,
real preload/IPC/Session, authenticated child and actual composer/start/stop UI.
Only native file-dialog selection is substituted. Packaged Desktop/core/runtime
file hashes must match the candidate's local build outputs before acceptance.
There is no browser preview, fake bridge, RUN_AS_NODE parity fallback, sandbox
relaxation, live Discord access or network-negative probe.

The GUI oracle isolates new DOM message IDs from retained conversation history,
asserts complete message text and rejects extra new bot replies. Delayed replies
must be observed in channel 2001, then remain absent when revisiting 2000.
Pending startup and partial command-body stop controls require real trace events
and resource release. Identity-aware Linux direct-child death and all three
recorded loopback-port closures are checked; this is not grandchild or private
listener-count qualification. Restarts verify cancellation and replacement actor
identity. They do not establish receipt/rejection of a successful old-run callback
after restart: that stronger stale-result predicate remains pending separately.

## Evidence and limits

Expectations are handwritten before execution. Every run records commands,
source HEAD/tree and dirty status, harness/fixture/lock/build digests, process
stdout/stderr, CLI reports, and a first-failure artifact. GUI runs additionally
save DOM, screenshots, real bridge corroboration and packaged artifact identity.
Containment is failure, never cleanup success. Read-only independent review is
required; corrected assertions need new evidence rather than overwritten runs.

[PR #35](https://github.com/YanagiKH/DisRunner/pull/35) completed the packaged
Linux G1 matrix and the bounded strict ordinary-message permission matrix. The
[merged-main evidence artifact](https://github.com/YanagiKH/DisRunner/actions/runs/39810441560/artifacts/12439657356)
records source commit `0564eb74950451f53d3760319d34c0c4c3473d8c` and tree
`be532f20f297c275d638850db4af2207c11e2a72`, with `harnessMatrixPassed`,
`guiMatrixPassed` and `strictPermissionMatrixPassed` true. `completeParity` remains false.
This qualification applies to that recorded source/build, not automatically to later
changes, including shared-runtime command registration.

The strict matrix covers two fresh runs each of allow, missing-SEND and missing-VIEW
fixtures. Ten ordinary HTTP operations and their separately measured callbacks
establish allowed create/edit/delete rows and denied creates without ordinary
state changes or rows. Six distinct runs include stopped-state and direct-child/port
cleanup evidence. Callback diagnostics and callback commits are not proof that a
separate ordinary operation succeeded.

All platform package-smoke jobs passed; this does not qualify the strict matrix on
Windows or macOS. Existing security/forged-peer smoke checks remain separate; the
parity harness adds no live-host negative probe. Executable/ASAR identity was
recorded by the hosted harness, but those binary bytes were not included for
independent rehashing. CLI-only checks and renderer unit tests alone do not
establish GUI acceptance.

G0 SDK experiments, actual late-success stale-result qualification, accessibility,
Windows/macOS strict qualification and G8 installed-release acceptance remain
separate gates. No release or installed-package acceptance is implied. Direct
component checks must be reported individually, never relabelled an aggregate pass.

## Cleanup recovery scope

Desktop recovery uses the existing ShutdownResult and phase contracts. Start and
project changes remain blocked after runtime errors until explicit cleanup is
confirmed. The recovery action does not promise that a Windows termination
uncertainty latch can be resolved by retrying. A disposed session never restarts.
Only ready/idle results with no non-child-exited issues confirm cleanup; an empty
failure does not. Child-exited history remains visible even after cleanup succeeds.

Stop responses are correlated to their captured session/run. Intermediate events
may advance revision without invalidating that operation. A response never replaces
a newer snapshot, and newer conflicting terminal evidence or a replacement run
prevents the response from clearing recovery. Failed snapshot refreshes require an
explicit status refresh; they never enable Start or accept the triggering event as
proof. Renderer unit tests test these presentation/dispatch decisions, not physical
resource release.

The packaged harness explicitly completes error recovery before selecting another
project. Its independent process/socket release assertions remain unchanged.
The qualified Linux harness covers its packaged recovery and shutdown paths with
process/socket evidence. This is not comprehensive recovery-button visual, focus
or screen-reader qualification, Windows uncertainty behavior, or all lifecycle
failure combinations. Do not infer those qualifications from unit tests or the
bounded Linux result.

## Hosted Linux qualification wiring

The existing CI E2E matrix retains every platform and its original package smoke.
Only the Linux x64 entry adds the G1 harness after smoke succeeds. It
builds the CLI separately, reuses the unpacked desktop package at
`apps/desktop/release/linux-unpacked/disrunner`, and uses the existing `xvfb-run -a`
launch mechanism. No Electron sandbox flags, credentials, live Discord calls,
installation steps, or dependency changes are added by this wiring. The original
smoke's behavior is unchanged; the new parity step adds no live-host probe.

The step has a six-minute outer limit. Harness deadlines remain unchanged: CLI
execution has a 4-second command timeout and 12/15-second containment timers;
GUI launch and ordinary UI waits are bounded at 15 seconds, the GUI watchdog at
180 seconds, and close at 5 seconds. Any timeout or containment is failure, not
proof of cleanup. The existing 30-minute matrix job limit also still applies.

A dedicated `g1-parity-linux-x64-<sha>` artifact is uploaded after attempted
success or failure, with missing evidence treated as an error. It includes
identity, expectations, results/first-failure JSON, CLI process reports, child
traces, DOM and screenshots when available, but excludes the Electron user-data
profile. Failure before the harness starts may produce no G1 artifact and does
not qualify the run. Existing E2E failure evidence remains unchanged. The new
step is blocking within `cross-platform-e2e`, preserving the `All green` chain.

Before claiming hosted Linux qualification, inspect a successful exact-head run,
its HEAD/tree/build/package identities, `guiMatrixPassed`, complete CLI/GUI case
results and cleanup evidence. Pull-request runs normally test a merge ref;
correlate its recorded HEAD/tree with the exact PR head rather than treating the
artifact SHA suffix as that head. Preserve first-failure evidence and investigate
any timeout or survivors before rerunning. A green result still records
`completeParity: false`: the stronger late-success stale-result gate, G0 SDK,
Windows/macOS and G8 installed-release qualification remain pending. Local
syntax checks of this wiring are not a hosted run or GUI acceptance.
