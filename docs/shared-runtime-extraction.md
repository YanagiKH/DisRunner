# Shared runtime extraction (M1-01 historical checkpoint)

## Current-state correction

This page retains the original extraction history. Current CLI and Desktop use
`createSession`, explicit actor contexts, subscription snapshots, cancellation,
and awaited disposal. Scenario v2 runs real raw/SDK Bots through the same runner;
`bot-test` retains the older case format. For current features and limits, see
[Architecture](architecture.md), [SDK adapters](sdk-adapters.md), and
[Scenario v2](scenario-v2.md). Historical checkpoint results are not a platform
or SDK compatibility declaration.

## Historical extraction scope

`@disrunner/runtime` is a private, Node-only ESM workspace package with no Electron or React dependency. The initial extraction depended only on `@disrunner/core`; the current package also uses the built-in SDK adapters and YAML parsing. CLI and Desktop use its shared `createSession()` API rather than separate child-process launchers.

## Extraction history and current API

The initial M1-01 extraction moved four Desktop runtime modules into this package, changed local imports to ESM `.js` paths, and moved runtime DTOs into `contracts.ts`. That extraction was intended to preserve behavior, not to qualify the full Bot lifecycle. Later M1 work added the Session API and updated the lifecycle implementation. Statements about the original extraction are not a description of the current feature set.

The package still exports `RuntimeManager` as an alias of `DesktopRuntimeManager`. Both names refer to the same class, with the legacy constructor, snapshot, `selectProject`, `start`, `stop` and `invoke(string)` entry points retained. This legacy manager has no `dispose()` method; disposal belongs to Session.

The current `createSession()` facade provides:

- Project selection and validation of an explicit actor/channel context, with a guild for guild interactions and explicit recipients for DMs.
- Start and invoke operations with cancellation signals and bounded timeouts.
- Invocation requests carrying a run ID, unique request ID, input and context; concurrent or duplicate requests and stale run IDs are rejected.
- Exact normalized authenticated responses for case evaluation, rejecting responses changed by export redaction or truncation rather than treating transformed content as exact.
- Versioned snapshots and snapshot events with session/run identity and increasing sequence numbers.
- Structured action dispatch, current command registration, actor-specific private views, local attachments, and session-scoped faults.
- Awaited `stop()` and `dispose()` results with structured cleanup issues. Disposal prevents further selection, startup and invocation; repeated disposal remains available for cleanup.

The package also exports `parseBotCase`, `evaluateBotStep`, the Scenario v2 parser/runner/reporters, workspace APIs, and diagnostic reproduction bundle APIs. The [bot-test command](bot-test.md) retains its version 1 case contract. CLI `run` and `test` select model execution for version 1 scenarios and real Session execution for version 2; cancellation and final reporting include cleanup.

Electron main caches a dynamic ESM import and creates a Session before exposing the window. It forwards runtime snapshot events and IPC operations to that session, stops it on window closure and awaits disposal before completing application quit. Desktop retains sender checks, renderer origin restrictions, preload and window handling; these are not moved into the Node runtime package. Desktop re-exports runtime DTOs and retains its window/application types.

## Build and tests

Build order is core → runtime → CLI/Desktop, encoded by workspace dependencies. `pnpm run build:runtime` builds core first. Direct Desktop dev/package and the Desktop runtime test script also build the runtime dependency chain. Repository-level lint, typecheck and targeted app build scripts prepare runtime declarations first.

`pnpm run test:runtime` builds the runtime and runs its Node test files. These include the seven preserved peer-auth tests, headless checks, case parsing/evaluation, explicit contexts, events, exact-response transport and lifecycle tests. The authentication vectors and original expected values from the extraction remain in the peer-auth suite. Tests consume built ESM output rather than the former Desktop TypeScript loader.

The headless checks cover import, construction, selection, snapshot isolation, repeated stop and Session disposal without spawning children or listening on sockets. They establish the Node-only boundary, not a running-Bot lifecycle or cleanup qualification. Authenticated child and process-tree tests are separate; see [Runtime lifecycle cleanup](runtime-lifecycle.md) for their evidence, ownership model and gaps.

## Security and qualification limits

The shared runtime supports the raw adapter and the exact SDK/runtime versions in [Compatibility](../COMPATIBILITY.md). Offline transport is not an OS sandbox for arbitrary local Bot code. It does not enable real Discord connections, live tokens, or other SDK versions.

Headless import checks establish only the Node package boundary. Real-child conformance, renderer tests, and packaged distribution tests establish their own narrower results; consult completed platform jobs before making a platform claim. Process-group cleanup does not own a descendant that escapes that group, and uncertain process identity or cleanup is not confirmed termination. See [Runtime lifecycle cleanup](runtime-lifecycle.md) and [Release process](release-process.md).

The initial extraction preserved model semantics. Its checks remain historical evidence of the package boundary; later Session, adapter, and lifecycle behavior has separate contracts and tests.
