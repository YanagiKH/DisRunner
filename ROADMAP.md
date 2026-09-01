# DisRunner Roadmap

This roadmap describes intent, not compatibility. A capability becomes supported only after implementation, documentation in [COMPATIBILITY.md](COMPATIBILITY.md), and direct automated evidence at the advertised layer.

## Current — v0.1 Preview

Implemented scope:

- deterministic core state, time, seeded IDs/randomness, snapshots/state hashes, and version 1 scenarios;
- core interaction lifecycle plus selected permission, intent, rate-limit, Gateway, REST, protocol-limit, trace, assertion, and risk behavior;
- CLI validate/run/test, versioned record/replay, and JSON/JUnit/HTML/SARIF output;
- signed raw-interaction-webhook example;
- Electron project validation/process lifecycle and a real signed local `/ping` path;
- Discord-like desktop visual fixtures and preview feature surfaces.

Known exit gaps for a broader usable preview:

- desktop fixture, REST state, Gateway events, trace panels, and renderer state are not synchronized end to end;
- editor/scenario/settings changes are not persisted;
- desktop interaction controls do not cover context commands, autocomplete, components, or modals;
- generic fault injection, imported-process performance metrics, broad risk rules, and crash recovery need implementation;
- platform support must be promoted from fresh package/E2E evidence, not workflow presence.

## Next — connected desktop preview

- Persist virtual guild, channel, role, user, message, command, component, and modal fixtures.
- Connect desktop actions to the same core state used by REST and Gateway transports.
- Emit Gateway events from REST/state mutations and display authoritative traces, diffs, permissions, buckets, and findings.
- Expose the core virtual clock and interaction 3-second/15-minute boundaries in Electron.
- Connect Scenario Lab to the versioned core/CLI scenario engine and safe report export.
- Add recovery tests for app crashes, active ports, and child-process cleanup.

**Exit evidence:** the bundled raw-webhook bot can be opened, exercised, restarted, recovered, and cleaned up through one packaged E2E; displayed evidence matches core state.

## Later — framework and Gateway adapters

- Define a versioned adapter contract for generic local HTTP/WebSocket bots.
- Add tested, pinned-version `discord.js` and `discord.py` adapters.
- Return connected fixture guilds/events over Gateway and validate reconnect/resume through the advertised dynamic URL.
- Add bounded delay/drop/duplicate/reorder/burst policies and deterministic cleanup.

**Exit evidence:** adapter contract suites plus real WebSocket/REST process E2E on each promoted platform.

## Toward 1.0

- Complete the declared interaction, permission, rate-limit, REST/Gateway event, and Components V2 profiles.
- Add bounded CPU, memory, event-loop, queue, and latency measurements with reproducible workloads.
- Stabilize config/scenario/recording/report schemas and supply migrations.
- Add risk baselines/suppressions and explicit CI severity policies.
- Produce signed/notarized packages, updater/rollback behavior, SBOM, canonical provenance, and audited release evidence.

**Exit evidence:** every 1.0 definition-of-done item maps to a green automated check and no unresolved critical/high security finding remains.

## Advanced simulation

- Sharding, large-guild, long-running, multi-bot, and distributed workload models.
- Advanced AutoMod, stage, soundboard, entitlement, subscription, and commerce resources.
- Explicit-consent live contract comparison, isolated from Offline Mode.
- Voice state at scale. Real voice transport remains out of scope unless separately specified.

## Always out of scope

- User-account automation or self-bot behavior.
- Shipping Discord logos, proprietary assets, or a pixel-perfect proprietary client copy.
- Guaranteeing undocumented Discord client behavior or production correctness.
- Claiming that application-level offline controls replace an OS sandbox.

Proposals must identify the protocol surface, evidence strategy, security impact, and compatibility/migration plan.
