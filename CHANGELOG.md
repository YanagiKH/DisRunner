# Changelog

All notable changes to DisRunner are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and releases follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

No changes yet.

## [0.1.0] - 2026-09-01

Initial Preview. See [COMPATIBILITY.md](COMPATIBILITY.md) for the layer-by-layer support boundary.

### Added

- Deterministic core primitives for virtual Discord-shaped resources, seeded IDs/randomness, virtual time, snapshots/state hashes, and selected diffs.
- Core interaction lifecycle, permission, intent, rate-limit, partial Gateway/REST, selected protocol-limit, trace, assertion, and risk behavior.
- CLI commands for scenario validation/run/test, versioned recording/replay, and JSON/JUnit/HTML/SARIF output.
- Signed raw-interaction-webhook example with replay/staleness/body-size checks.
- Electron Preview that validates and starts a raw-webhook project, performs signed PING readiness, captures bounded process output, invokes the real local `/ping`, and renders its callback.
- Discord-like desktop visual fixtures and preview surfaces for guilds, channels, commands, scenarios, inspectors, risks, and settings.
- CI, security, packaging, SBOM, checksum, and canonical release workflow definitions. A release is evidence only for jobs that completed successfully in that release run.
- Installation, configuration, protocol, security, limitation, debugging, and release documentation with original DisRunner artwork.

### Security

- Per-run synthetic credentials for the supported raw-webhook/runtime path, with production-shaped token rejection in project configuration.
- Loopback validation for supported simulator endpoints and Electron navigation/request restrictions.
- Bounded/redacted bot output and sanitized supported CLI report/export values. Source scenario files are not rewritten or guaranteed secret-free.
- Webhook verification for missing, invalid, stale, replayed, and oversized signed requests.
- Commit-pinned release actions and workflow refusal to overwrite an existing canonical release. Repository rules, environment reviewers, signing, notarization, and immutable-release settings remain external release prerequisites.

### Known Preview boundaries

- `discord.js`, `discord.py`, generic Gateway/stdio, and simulator SDK adapters are not accepted in v0.1.
- Most desktop editor/inspector surfaces are visual previews and are not persisted or wired end to end.
- Generic latency/drop/duplicate/reorder fault injection and imported-process performance profiling are not implemented.
- REST, Gateway, object-limit, risk-rule, and desktop interaction catalogs are partial.

[Unreleased]: https://github.com/YanagiKH/DisRunner/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/YanagiKH/DisRunner/releases/tag/v0.1.0
