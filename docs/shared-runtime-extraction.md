# Shared runtime extraction (M1-01)

`@disrunner/runtime` is a private, Node-only ESM workspace package. Its only
production dependency is `@disrunner/core`. It has no Electron or React dependency.
The public `RuntimeManager` export aliases the preserved `DesktopRuntimeManager`
class. Both names share one implementation and unchanged constructor, snapshot,
selectProject, start, stop and invoke(string) semantics.

The four former Desktop modules are moved without behavior changes. Local imports
now use ESM `.js` paths. Runtime DTOs live in `contracts.ts`; Desktop re-exports
those types and retains only window and application information types. Electron
main caches a dynamic ESM import, awaits it before exposing the window, and routes
its IPC methods to that instance. Sender checks, renderer origin restrictions,
preload and window handling remain in Desktop.

## Build and tests

Build order is core → runtime → CLI/Desktop, encoded by workspace dependencies.
`pnpm run build:runtime` builds core first. Direct Desktop dev/package and the
Desktop runtime test script also build the runtime dependency chain. Root lint,
typecheck and targeted app build scripts prepare runtime declarations first.
The CLI depends on the package but does not yet introduce a real-Bot command.

`pnpm run test:runtime` builds and runs the seven preserved peer-auth tests and
plain-Node headless checks. The authentication vector and all original expected
values are unchanged. Tests consume built ESM output instead of using the previous
Desktop TypeScript loader. Headless checks cover import, construction, selection,
snapshot isolation and repeated stop without spawning children or listening on
sockets. They are not a running-Bot lifecycle or cleanup qualification.

## Explicit limitations

This is extraction only, not Gate G1 or SDK compatibility certification. Current
implicit first-fixture context, startup/stop ordering, child-exit polling and
cleanup semantics are unchanged. There is no new dispose API or cancellation
contract; those belong to M1-04. No bot-test command, actor/context API, event
schema, token configuration, compiler/model semantics or dependency-version
upgrade is included. Real CLI/Desktop parity, packaged interactive Desktop
smoke, cancellation, process-tree cleanup and cross-platform qualification remain
separate acceptance work.
