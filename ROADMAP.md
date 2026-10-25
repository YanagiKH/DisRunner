# DisRunner Roadmap

The supported profiles are defined in [Compatibility](COMPATIBILITY.md). New features require protocol, real Bot and packaged application tests at the layer they affect.

## Current — v1.0

- Shared Desktop/CLI Session with real raw-webhook, discord.js and discord.py processes.
- Local API v10 REST/Gateway, command registry, supported message/interaction lifecycles, permissions and intents.
- Typed commands, autocomplete, context commands, legacy buttons/selects/modals, DMs and local attachments.
- Actor-specific state, live diagnostics, saved fixtures/scenarios, atomic storage, backups and conflict recovery.
- Real Bot Scenario v2, meaningful assertions, cancellation, scoped faults, four report formats and redacted diagnostic bundles.
- Deterministic model scenarios and recordings remain separate from real Bot reruns.
- Packaged raw/SDK UI and installer roundtrips, offline network-namespace tests, standalone CLI distribution and release integrity checks.

Platform installation and signing results are published with each release. See the [evidence index](docs/v1.0/requirements-evidence-index.md) and [release process](docs/release-process.md).

## Next — broader supported profiles

- Additional SDK versions after independent conformance runs.
- More fixture editor forms, command/profile options and supported REST resources.
- Further Components V2 and newer modal controls behind explicit profiles.
- More fault policies and workload measurements.
- Additional migration/recovery and minimum-OS coverage.

## Later — advanced simulation

- Multiple Bots, sharding and larger guild workloads.
- Threads/forums, reactions, presence and additional event families.
- Process CPU, memory and event-loop profiling.
- Optional update delivery and richer historical reports.

## Always out of scope

- User-account automation or self-bot behavior.
- Shipping proprietary Discord client assets or promising pixel-perfect client behavior.
- Claiming complete Discord parity or arbitrary process memory checkpoints.
- Treating loopback adapters as an OS sandbox for untrusted code.

Proposals should identify the protocol surface, compatibility impact and observable test cases.
