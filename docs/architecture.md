# Architecture

DisRunner separates deterministic model execution from real local Bot execution. The core supplies state and protocol services; CLI and Desktop share the same Session and Scenario v2 runner. Supported Bot adapters are raw interaction webhooks, discord.js 14.27.0, and discord.py 2.6.4.

## Shipped boundaries

```text
CLI version 1 scenario/recording/report
            │
            ▼
┌──────────────── deterministic core ────────────────┐
│ clock · IDs · generic resource state · snapshots  │
│ interactions · selected permissions/intents       │
│ configurable rate limits · partial REST/Gateway   │
│ traces · small risk catalog · report data          │
└────────────────────────────────────────────────────┘

CLI version 2 ───────────────┐
Electron renderer ── IPC ───┴─ shared Session / Scenario v2 runner
                                      │
                                      ├─ project/workspace + BotRunner
                                      ├─ retained core state + local REST/Gateway
                                      ├─ signed request / HMAC response ↔ raw Bot
                                      └─ local Gateway / REST ↔ pinned SDK Bot
```

The core classes can be composed in tests or the CLI. Their existence does not make every combination a supported imported-bot adapter.

### Core and CLI

The core provides deterministic primitives and the declared local Discord protocol subset. CLI version 1 scenarios run the in-process model and support deterministic recording/replay. Version 2 scenarios launch a real configured Bot through Session, await bounded observations, and evaluate assertions against retained messages, interaction state, errors, and traces. Both produce JSON/JUnit/HTML/SARIF reports. Diagnostic reproduction bundles identify the inputs for a fresh Bot rerun; they omit source/dependencies and do not restore process memory.

### Electron runtime

The shared runtime validates a selected project and workspace, starts the declared process, and creates loopback REST and Gateway services with a per-run synthetic token. The raw adapter uses an ephemeral Ed25519 key pair and an independent 32-byte peer secret. The child verifies signed requests. Accepted response HMACs bind the request timestamp, HTTP status, request digest, and exact response digest; the runtime verifies them before parsing callback data.

The pinned SDK adapters redirect the supported SDK transports to those local services and use actual Gateway events and REST callbacks. Node 22.23.2 and Python 3.12.14 are the tested runtimes; install dependencies before offline use. Commands, legacy components, autocomplete, modals, messages, attachments, and supported channel/role/member changes share retained state. SDK projects default to strict ordinary-message permissions; raw projects retain the explicit legacy default unless configured otherwise. The action driver uses `interactions-v1`, including text invocation for raw projects with `command-registry-v2`. Earlier raw profiles retain their chat-input invocation contract. See [SDK adapters](sdk-adapters.md) and [Protocol compatibility](protocol-compatibility.md).

### Renderer

The renderer uses a narrow preload bridge for project/workspace operations, runtime actions, scenario runs, exports, and window controls. Runtime status, bounded output, command registration, messages, and trace/risk entries come from Session. Public snapshots omit DMs and ephemeral messages. The selected actor view includes only that actor's private responses and applies channel visibility checks when permission enforcement is enabled.

Guild Editor saves validated resources to the workspace with bounded Undo/Redo. Command Explorer reads registered commands and validates inputs; Scenario Lab saves, validates, runs, cancels, and exports real Bot scenarios through the shared runner. The browser demo remains separate from project execution. A full dependency waterfall and CPU/memory profiler are not provided.

## Determinism and state

Given the same supported scenario, seed, initial resources, and virtual-clock start, core execution is intended to be repeatable. The core offers generic resource create/update/delete, transactional rollback, history, snapshots, hashes, fixture JSON, and diffs in memory.

The Electron runtime uses a real-time core clock and launches external code. An imported process can read the host clock, use its own randomness, race, access files, or perform network I/O, so desktop runs are not fully deterministic merely because the core is seeded.

Editable resources, saved scenarios, seed, and mode live in versioned `.disrunner/workspace.json`. Saves use validation, a lock, expected-file hashes, atomic replacement, and a previous-save backup; newer unknown versions are not overwritten. Workspace persistence and recovery do not restore a running process. See [Workspaces](workspaces.md).

## Current event flows

### Version 1 model scenario

1. The parser accepts a supported version 1 action.
2. The scenario runner advances its paused clock and invokes the relevant in-process engine.
3. Supported resource mutations, interaction transitions, rate-limit decisions, or Gateway helper events are recorded.
4. Assertions are evaluated and the final state hash, spans, findings, and events become report data.

### Real Bot action

1. Desktop or Scenario v2 dispatches an action with the current run ID, request ID, and selected actor/channel context.
2. Session validates live context, applicable permissions, registered command options or component/modal state.
3. The action reaches the real Bot over signed raw HTTP or the SDK's local Gateway transport.
4. The raw response or SDK REST callback passes through the shared interaction lifecycle and message authority.
5. Committed state drives supported Gateway events and actor-specific Desktop views; scenario assertions read that retained state.

An initial invocation may complete before a deferred edit or followup. Later commits update the live view. Scenario v2 can await those observations and waits for tracked SDK handlers within its overall deadline before final assertions; unexpected structured handler errors or incomplete evidence prevent a pass. Session-scoped faults can delay/fail selected HTTP operations or disconnect/duplicate selected Gateway events. See [Interaction engine](interaction-engine.md) and [Fault injection](fault-injection.md).

## Trust boundaries

- **Renderer:** Node integration is disabled; context isolation and Chromium sandboxing are enabled. Navigation, permissions, downloads, and requests are restricted to app resources and active loopback origins.
- **IPC:** only the typed preload methods are exposed, and main-process handlers verify the sender.
- **Local services:** current REST/Gateway/webhook endpoints bind explicit loopback addresses and use synthetic credentials. Raw-webhook requests use Ed25519 and accepted responses use a separate per-run HMAC. A same-user process can still race the released dynamic port and deny availability, but a listener without the peer secret cannot pass readiness or command-response authentication.
- **Imported process:** it runs with the current OS user's authority. DisRunner validates configuration, paths, and injected environment values, but it is not an OS sandbox.
- **Plugins:** no public plugin loader, SDK, or plugin sandbox is available.
- **Release:** the workflow requires the declared target checks, checksums, SBOM, and provenance; stable Windows/macOS packages additionally require native signing/notarization verification. Completed target jobs and receipts establish release results.

Voice, Components V2, other SDK versions, arbitrary host fault injection, and imported-process profiling remain outside the supported profile. See [Compatibility](../COMPATIBILITY.md), [Security model](security-model.md), and [Threat model](threat-model.md).
