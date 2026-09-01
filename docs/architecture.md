# Architecture

DisRunner v0.1 is a Preview with three deliberately different surfaces. The deterministic core and CLI are the broadest tested surface. Electron connects a raw interaction-webhook project for one real signed command path. Most Discord-like desktop editors and panels use seeded display data.

## Shipped boundaries

```text
CLI scenario/recording/report
            │
            ▼
┌──────────────── deterministic core ────────────────┐
│ clock · IDs · generic resource state · snapshots  │
│ interactions · selected permissions/intents       │
│ configurable rate limits · partial REST/Gateway   │
│ traces · small risk catalog · report data          │
└────────────────────────────────────────────────────┘

Electron renderer ── narrow IPC ── desktop runtime manager
                                      │
                                      ├─ validated project + BotRunner
                                      ├─ loopback REST/Gateway services
                                      └─ signed HTTP /ping ──► raw webhook bot
```

The core classes can be composed in tests or the CLI. Their existence does not make every combination a supported imported-bot adapter.

### Core and CLI

The core provides deterministic primitives and partial Discord-shaped protocol behavior. The CLI parses version 1 scenarios, runs supported actions/assertions, creates reports, and records or verifies deterministic replay envelopes. It does not run arbitrary bot frameworks.

### Electron runtime

The desktop runtime validates a selected version 1 project, starts its declared process, and creates loopback REST and Gateway services with a per-run synthetic token. For the only supported adapter, `raw-interaction-webhook`, it also creates an ephemeral Ed25519 key pair, verifies signed PING readiness, and sends a real signed application-command request. The bot's initial callback is validated through the core interaction lifecycle and returned to the renderer.

Electron does not currently provide a supported generic Gateway, `discord.js`, `discord.py`, or stdio adapter. The local REST/Gateway services are real core services, but desktop fixture-to-event synchronization, permission enforcement on REST routes, REST-mutation Gateway dispatch, and deferred follow-up observation are not wired in v0.1.

### Renderer

The renderer has a narrow preload bridge for project selection, runtime start/stop, command invocation, and window controls. Runtime status, bounded process output, the real signed command result, and associated runtime trace/risk entries come from Electron.

Guilds, channels, members, command/scenario editors, most inspector values, the virtual-clock control, and much of Risk Center are seeded visual previews. Their edits are not persisted and do not drive the CLI/core scenario runner.

## Determinism and state

Given the same supported scenario, seed, initial resources, and virtual-clock start, core execution is intended to be repeatable. The core offers generic resource create/update/delete, transactional rollback, history, snapshots, hashes, fixture JSON, and diffs in memory.

The Electron runtime uses a real-time core clock and launches external code. An imported process can read the host clock, use its own randomness, race, access files, or perform network I/O, so desktop runs are not fully deterministic merely because the core is seeded.

v0.1 has no workspace database, migration system, automatic fixture persistence, archive importer/exporter, or renderer undo/redo integration. The public persisted formats are limited to files explicitly written by current CLI commands and the version 1 recording envelope.

## Current event flows

### CLI/core scenario

1. The parser accepts a supported version 1 action.
2. The scenario runner advances its paused clock and invokes the relevant in-process engine.
3. Supported resource mutations, interaction transitions, rate-limit decisions, or Gateway helper events are recorded.
4. Assertions are evaluated and the final state hash, spans, findings, and events become report data.

### Electron signed command

1. The user invokes a validated `/name` command while a raw-webhook project is running.
2. Electron creates a core interaction and signs the Discord-shaped HTTP body with the per-run private key.
3. The imported loopback endpoint verifies the request and returns one callback.
4. Electron validates that callback through `InteractionEngine`, records bounded evidence, and renders the result.

This path does not currently wait for a deferred edit/follow-up, mutate the displayed seeded guild state, or generate a complete end-to-end Gateway/REST waterfall.

## Trust boundaries

- **Renderer:** Node integration is disabled; context isolation and Chromium sandboxing are enabled. Navigation, permissions, downloads, and requests are restricted to app resources and active loopback origins.
- **IPC:** only the typed preload methods are exposed, and main-process handlers verify the sender.
- **Local services:** current REST/Gateway/webhook endpoints bind explicit loopback addresses and use synthetic authentication or request signatures at their implemented boundaries.
- **Imported process:** it runs with the current OS user's authority. DisRunner validates configuration, paths, and injected environment values, but it is not an OS sandbox.
- **Plugins:** no public plugin SDK or plugin sandbox ships in v0.1.
- **Release:** workflows can produce checksums, an SBOM, and GitHub provenance; repository rules, signing, and notarization remain release-time prerequisites.

Generic fault injection, persistent workspaces, public plugins, complete protocol adapters, and imported-process profiling are planned. See [Compatibility](../COMPATIBILITY.md), [Security model](security-model.md), and [Threat model](threat-model.md).
