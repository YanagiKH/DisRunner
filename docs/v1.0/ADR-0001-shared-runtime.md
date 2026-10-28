# ADR-0001: One shared session runtime for real Bot execution

Status: accepted and implemented in v1.0.

## Decision

Desktop and CLI use the Electron-free `@disrunner/runtime` package. Its `Session` API owns project selection, Bot lifecycle, authoritative state, transports, context-bound actions, scenarios and diagnostics. Neither application hosts the other.

- `packages/core` owns state, interactions, permissions, clocks, REST/Gateway, traces and redaction. It has no Electron, React or Python dependency.
- `packages/runtime` owns typed session contracts, project/workspace validation, adapter hosting and scenario v2 execution. Public project schemas are documented under `docs/schemas`.
- `packages/adapter-discordjs` and `packages/adapter-discordpy` bootstrap the pinned SDKs against local transports. Raw webhooks use the runtime's signed request and authenticated response bridge.
- Electron owns windows, dialogs, sender validation and IPC. The renderer receives bounded projections and submits explicit actions. CLI owns command parsing, report presentation and exit codes.

## Session and state

Each executor permits one active run. Selection freezes validated configuration; starting executes that selection. Successful workspace saves explicitly reload it. Each run receives independent synthetic credentials, ports and identity.

Actions capture actor, guild and channel context. Mutations validate authentication, payload, relationships and applicable permissions before committing state and publishing events. Renderer actor views filter DMs and private replies. A failed mutation cannot publish a successful state revision.

Subscriptions publish revisioned session snapshots. Consumers can request a fresh snapshot; display caps and underlying evidence loss are reported separately. Authentication credentials never form part of the public session contract.

## Time and evidence

Model scenarios use a virtual clock and seeded randomness for deterministic recording/replay. Bot scenarios launch real processes, use wall time and require actual handler responses. A Bot rerun compares semantic assertions; it does not restore arbitrary process memory, timers or external services.

SDK readiness requires the adapter and Gateway handshake. Scenario completion observes tracked handler promises, process health, diagnostics and cleanup. Invalid input, failed assertions, runner errors, cancellation and incomplete capture have separate outcomes. Missing evidence cannot produce a passing run.

## Lifecycle and offline boundary

Project preparation validates installed dependencies and runtime paths without installing or executing the Bot. Stop/dispose covers partial startup, crashes, cancellation and owned process trees; failed cleanup retains ownership for retry.

The supported SDK paths redirect REST and Gateway traffic to loopback and reject unintended Discord endpoints. Raw webhook response authentication is a DisRunner integration contract. Imported Bot code remains ordinary host code; operating-system isolation requires the separate setup documented in [Offline mode](../offline-mode.md).

## Validation

Runtime tests cover fixed selection, real responses, identity/context binding, negative controls and repeated lifecycle cleanup. The common conformance corpus exercises raw webhooks, discord.js 14.27.0 and discord.py 2.6.4. Packaged UI and installer receipts verify their own distribution layer. See the [requirements/evidence index](requirements-evidence-index.md).
