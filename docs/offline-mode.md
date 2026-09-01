# Offline Mode

DisRunner v0.1 runs its supported simulator paths without Discord and without a real bot token. This is an application boundary, not a network sandbox for the imported bot process.

## Implemented application controls

### Core services and helpers

- REST and Gateway servers bind `127.0.0.1`.
- Per-run synthetic tokens use a reserved `disrunner.offline.*` namespace; production-shaped Discord tokens fail validation on supported injection paths.
- `assertOfflineUrl` accepts only loopback HTTP(S) or WebSocket targets and explicitly rejects Discord host suffixes, credentials in URLs, unsupported protocols, and non-loopback hosts.
- `createOfflineFetch` manually follows a bounded number of redirects, revalidates every target, and removes sensitive headers when the origin changes.
- supported export/process-output paths redact configured values and common credential shapes.

These URL/fetch helpers protect only callers that use them. They do not intercept arbitrary sockets opened by imported code.

### Electron and raw webhook path

- The packaged renderer loads only app files and exact active loopback origins; navigation, new windows, permissions, downloads, and other renderer requests are denied.
- Project configuration accepts only explicit loopback adapter URL templates and `profile.networkPolicy: "offline"`.
- The desktop runtime injects synthetic REST/Gateway credentials and an ephemeral Ed25519 public key, not a Discord bot token.
- The bundled raw-webhook example binds loopback, fails closed without offline mode/key material, verifies `timestamp + raw body` signatures, and limits request size, age, replay, connections, and socket reuse.

The current application does not turn denied renderer requests into the general risk finding promised by the product roadmap. The Settings “Audit blocked requests” control is a visual preview, not a shipped audit log.

## Imported-process boundary

The Electron project loader resolves the declared executable/entry point and canonical project paths, parses the start command without a shell, and restricts execution-control environment variables. `BotRunner` independently canonicalizes the workspace/current directory, validates synthetic endpoints and selected environment values, bounds/redacts output, starts the process without a shell, and attempts process-tree cleanup on stop.

The child still runs with the current OS user's filesystem, network, and process privileges. It can ignore injected endpoints, load its own `.env`, open a direct Discord or external connection, read accessible files, or spawn other programs. DisRunner v0.1 does not install a firewall, hook every socket API, or prove process-level egress denial.

> Offline Mode means DisRunner's supported traffic stays local. It does not make arbitrary imported code offline.

## Test evidence

Current automated coverage checks core URL policy, redirect revalidation, synthetic-token handling, local-service constraints, redaction boundaries, the raw webhook's signed-request controls, and packaged Electron renderer request blocking on macOS/Linux. The Windows package smoke is intentionally narrower: because Electron's Windows CDP connection can deadlock, it validates the real executable, packaged identity, ASAR presence, stability, and process-tree cleanup; it does not execute the packaged renderer or runtime. Separate Windows renderer E2E, runtime-manager, webhook, and security suites cover those layers before packaging. No target runs a cross-platform OS-level egress canary for the imported process.

Run the applicable suites:

```bash
pnpm run test:offline
pnpm run test:security
pnpm run test:raw-webhook
pnpm run test:e2e
```

Passing them proves only the exercised application paths and build.

## Running untrusted code

Use an external security boundary for an unknown project:

1. Copy only the reviewed bot files and fixtures into a disposable VM/container.
2. Remove production tokens, cloud credentials, SSH keys, browser profiles, and home-directory mounts.
3. Disable network access at the VM/container/firewall layer, including IPv4, IPv6, and DNS.
4. Run as a non-administrator with minimal filesystem/process permissions.
5. Review dependency install scripts before the environment is isolated.
6. Export only manually reviewed, redacted outputs, then destroy the environment.

Exact controls vary by OS; validate the external boundary independently.

## Planned modes

Hybrid/live traffic is not implemented. Any future mode must be explicit, visibly separate from Offline Mode, tightly scoped to a test guild and route allowlist, and backed by credential storage and audit controls. No current Preview toggle enables it.
