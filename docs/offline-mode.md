# Offline Mode

DisRunner's supported transport paths use synthetic credentials and local endpoints, without connecting to Discord. Prepare the application, interpreter, and Bot dependencies before disconnecting. Offline transport is separate from OS isolation of arbitrary user code.

## Local services and credentials

- REST and Gateway bind `127.0.0.1` on dynamic ports.
- Each run receives a fresh `disrunner.offline.*` credential and its own endpoints.
- Project configuration rejects production-shaped credentials and non-loopback adapter endpoints.
- The raw webhook server receives an ephemeral Ed25519 public key and a separate protected response-authentication secret.
- Supported logs, traces, and exports redact common credential shapes and current runtime secrets.

Raw readiness verifies a signed PING and its response HMAC over exact request/response bytes before accepting the Bot as ready. The same peer authentication protects command callbacks. Body size, age, replay, connection, and timeout limits remain independent checks.

## SDK transport guards

The pinned JavaScript bootstrap redirects SDK REST/Gateway requests to the current session and rejects connections outside those endpoints. The Python bootstrap similarly directs SDK traffic locally and rejects external aiohttp requests while active. Neither adapter falls back to Discord after a startup or route failure.

These guards cover their supported transport hooks. A Bot using another networking library, native module, or child process can have other behavior. They do not replace a firewall or OS sandbox. See [SDK adapters](sdk-adapters.md) for the exact dependency/runtime profiles.

## Desktop boundary

The Electron renderer loads application files and the active permitted local origins. Navigation, new windows, permissions, downloads, and IPC senders are restricted. The browser demo has no local process/file bridge.

Project paths and entry files are validated, the command is executed without a shell, execution-control environment overrides are rejected, and process output is bounded. The runtime owns its Bot process and local services and performs bounded cleanup on stop or cancellation.

## Imported-process boundary

The selected Bot still runs with the current OS user's filesystem, network, and process privileges. It may load its own `.env`, read accessible files, open custom connections, or spawn programs. DisRunner does not install a system firewall, virtualize every socket, or provide a general untrusted-code sandbox.

Never provide a production credential to a local project. A local process with sufficient same-user inspection privileges may inspect another process's environment or memory despite the application-level guards.

## Running untrusted code

Use a disposable VM/container or an OS sandbox with restricted mounts and networking. Prepare dependencies before isolating it, remove live credentials, and verify that IPv4/IPv6/DNS and filesystem restrictions match the intended boundary. Export only reviewed reports and fixtures.

## Verification

The repository provides URL/network-policy, local-service, synthetic-token, redaction, peer-authentication, and real adapter conformance checks. Run the relevant suites for a source checkout:

```sh
pnpm run test:offline
pnpm run test:security
pnpm run test:runtime
pnpm run test:raw-webhook
pnpm run test:conformance
```

These checks establish the paths they exercise. They do not prove process-wide containment of arbitrary Bot code or qualify an untested installed platform. Published platform/artifact results belong to the corresponding release.

Hybrid/live traffic, online synchronization, and an online updater are not required for local use.
