# Shared runtime extraction (M1-01)

`@disrunner/runtime` is a private, Node-only ESM workspace package. Its only production dependency is `@disrunner/core`; it has no Electron or React dependency. CLI and Desktop use its shared `createSession()` API rather than separate child-process launchers.

## Extraction history and current API

The initial M1-01 extraction moved four Desktop runtime modules into this package, changed local imports to ESM `.js` paths, and moved runtime DTOs into `contracts.ts`. That extraction was intended to preserve behavior, not to qualify the full Bot lifecycle. Later M1 work added the Session API and updated the lifecycle implementation. Statements about the original extraction are not a description of the current feature set.

The package still exports `RuntimeManager` as an alias of `DesktopRuntimeManager`. Both names refer to the same class, with the legacy constructor, snapshot, `selectProject`, `start`, `stop` and `invoke(string)` entry points retained. This legacy manager has no `dispose()` method; disposal belongs to Session.

The current `createSession()` facade provides:

- Project selection and validation of an explicit actor/guild/text-channel context.
- Start and invoke operations with cancellation signals and bounded timeouts.
- Invocation requests carrying a run ID, unique request ID, input and context; concurrent or duplicate requests and stale run IDs are rejected.
- Exact normalized authenticated responses for case evaluation, rejecting responses changed by export redaction or truncation rather than treating transformed content as exact.
- Versioned snapshots and snapshot events with session/run identity and increasing sequence numbers.
- Awaited `stop()` and `dispose()` results with structured cleanup issues. Disposal prevents further selection, startup and invocation; repeated disposal remains available for cleanup.

The package also exports `parseBotCase`, `evaluateBotStep` and their case/assertion types. The CLI's implemented [bot-test command](bot-test.md) runs local Bot cases through Session, handles SIGINT/SIGTERM and writes its final report after disposal. The existing model-based `run` and `test` commands remain separate.

Electron main caches a dynamic ESM import and creates a Session before exposing the window. It forwards runtime snapshot events and IPC operations to that session, stops it on window closure and awaits disposal before completing application quit. Desktop retains sender checks, renderer origin restrictions, preload and window handling; these are not moved into the Node runtime package. Desktop re-exports runtime DTOs and retains its window/application types.

## Build and tests

Build order is core → runtime → CLI/Desktop, encoded by workspace dependencies. `pnpm run build:runtime` builds core first. Direct Desktop dev/package and the Desktop runtime test script also build the runtime dependency chain. Repository-level lint, typecheck and targeted app build scripts prepare runtime declarations first.

`pnpm run test:runtime` builds the runtime and runs its Node test files. These include the seven preserved peer-auth tests, headless checks, case parsing/evaluation, explicit contexts, events, exact-response transport and lifecycle tests. The authentication vectors and original expected values from the extraction remain in the peer-auth suite. Tests consume built ESM output rather than the former Desktop TypeScript loader.

The headless checks cover import, construction, selection, snapshot isolation, repeated stop and Session disposal without spawning children or listening on sockets. They establish the Node-only boundary, not a running-Bot lifecycle or cleanup qualification. Authenticated child and process-tree tests are separate; see [Runtime lifecycle cleanup](runtime-lifecycle.md) for their evidence, ownership model and gaps.

## Security and qualification limits

The shared runtime uses the offline raw-interaction-webhook adapter. Offline transport is not an OS sandbox for arbitrary local Bot code. It does not imply support for real Discord connections, token configuration or SDK compatibility.

Shared source and successful headless checks do not establish real CLI/Desktop parity, packaged interactive Desktop acceptance, Gate G1 or SDK certification. Linux lifecycle evidence does not qualify Windows or macOS behavior. Process-group cleanup does not own a descendant that escapes that group, and uncertain process identity or cleanup must not be treated as confirmed termination. Consult the lifecycle documentation for the more specific platform limits and untested failure paths.

This extraction and its subsequent M1 APIs do not change compiler/model semantics or establish a dependency-version upgrade. The initial extraction-only checks remain historical evidence of the package boundary, not acceptance evidence for later cancellation, disposal or real-child behavior.
