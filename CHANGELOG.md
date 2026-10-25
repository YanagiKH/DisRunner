# Changelog

All notable changes to DisRunner are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and releases follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.0.0] - 2026-10-25

### Added

- Pinned discord.js 14.27.0 and discord.py 2.6.4 adapters, with genuine offline SDK dispatch, cache synchronization, ESM/CommonJS support and runtime diagnostics.
- Shared Desktop/CLI Bot execution, typed commands, context commands, autocomplete, buttons, selects, modals, DM views and local attachments.
- Versioned workspaces with fixture/scenario editing, atomic saves, backups, conflict detection, undo/redo and explicit recovery.
- Real Bot Scenario v2, cancellation, bounded fault plans, JSON/JUnit/HTML/SARIF reports and redacted reproduction bundles.
- Packaged application and installer operation tests, isolated offline conformance, and a standalone CLI archive with dependency notices.
- Stable release signing/notarization checks, installation receipts, prerelease channels and complete artifact integrity verification.

### Fixed

- Keep message state, REST results, Gateway events and actor-specific desktop views consistent.
- Preserve original/followup lifecycle, PATCH fields, ephemeral visibility, component source messages and interaction acknowledgement rules.
- Enforce live permission/intent decisions, correct resume URLs/backlogs, command scope precedence and SDK retry behavior.
- Reject invalid settings, vacuous assertions, missing responses, incomplete evidence and handler exceptions after an acknowledgement.
- Bound logs/traces/diagnostics, redact configured secrets, and preserve process/port cleanup on failure or cancellation.

### Compatibility

- Project version 1 and model scenarios remain readable; real Bot workflows use Scenario v2.
- Bot reruns use real process time. Deterministic model replay does not restore arbitrary Bot memory or timers.
- Components V2, voice, arbitrary SDK versions, automatic dependency installation and OS sandboxing are outside the supported profile.

## [0.1.0] - 2026-09-01

Initial Preview. See [COMPATIBILITY.md](COMPATIBILITY.md) for the layer-by-layer support boundary.

### Added

- Deterministic core primitives for virtual Discord-shaped resources, seeded IDs/randomness, virtual time, snapshots/state hashes, and selected diffs.
- Core interaction lifecycle, permission, intent, rate-limit, partial Gateway/REST, selected protocol-limit, trace, assertion, and risk behavior.
- CLI commands for scenario validation/run/test, versioned recording/replay, and JSON/JUnit/HTML/SARIF output.
- Mutually authenticated raw-interaction-webhook example with request-signature, response-HMAC, replay, staleness, and body-size checks.
- Electron Preview that validates and starts a raw-webhook project, performs signed PING readiness with authenticated raw response bytes, captures bounded process output, invokes the real local `/ping`, and renders its verified callback.
- Discord-like desktop visual fixtures and preview surfaces for guilds, channels, commands, scenarios, inspectors, risks, and settings.
- CI, security, packaging, SBOM, checksum, and canonical release workflow definitions. A release is evidence only for jobs that completed successfully in that release run.
- Installation, configuration, protocol, security, limitation, debugging, and release documentation with original DisRunner artwork.

### Security

- Per-run synthetic credentials for the supported raw-webhook/runtime path, including a protected 32-byte response-authentication secret, with production-shaped token rejection in project configuration.
- Loopback validation for supported simulator endpoints and Electron navigation/request restrictions.
- Bounded/redacted bot output and sanitized supported CLI report/export values. Source scenario files are not rewritten or guaranteed secret-free.
- Webhook verification for missing, invalid, stale, replayed, and oversized signed requests; every accepted PING or command response is HMAC-bound to the per-run secret, timestamp, HTTP status, request bytes, and response bytes before parsing.
- A same-user process that wins the dynamic webhook port race can still deny startup, but cannot impersonate a successful bot response without the protected per-run secret.
- Commit-pinned release actions and workflow refusal to overwrite an existing canonical release. Repository rules, environment reviewers, signing, notarization, and immutable-release settings remain external release prerequisites.

### Known Preview boundaries

- `discord.js`, `discord.py`, generic Gateway/stdio, and simulator SDK adapters are not accepted in v0.1.
- Most desktop editor/inspector surfaces are visual previews and are not persisted or wired end to end.
- Generic latency/drop/duplicate/reorder fault injection and imported-process performance profiling are not implemented.
- REST, Gateway, object-limit, risk-rule, and desktop interaction catalogs are partial.

[Unreleased]: https://github.com/YanagiKH/DisRunner/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/YanagiKH/DisRunner/releases/tag/v1.0.0
[0.1.0]: https://github.com/YanagiKH/DisRunner/releases/tag/v0.1.0
