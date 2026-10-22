# Changelog

All notable changes to DisRunner are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and releases follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Add an explicit core-only ordinary guild-text message permission profile backed by live state, with own-message mutation and revocation checks. Legacy behavior remains the default; DM, runtime/Desktop activation and full Discord permission parity are not claimed. See [the profile contract](docs/ordinary-message-permissions.md).

### Fixed

- Reject permission expectation mismatches and unasserted scheduled operation failures instead of reporting false success in model scenarios.
- Align strict scenario parsing with the published schema, reject simultaneous `steps` and `actions`, and reject unknown closed configuration keys without closing arbitrary payload dictionaries.
- Preserve Gateway intent close codes 4013/4014 over the local WebSocket transport.
- Reject invalid application-command callbacks, prevent edits from reviving deleted originals, and merge interaction message PATCH fields with atomic capacity checks.
- Apply the documented simulator policies for content-edit mention settings and immutable ephemeral identity. Unknown interaction labels now fail callback validation rather than inheriting component behavior; existing scenarios using custom labels must use a modeled kind.

### Maintenance

- Refresh compatible dependencies, constrain vulnerable build transitives, and migrate the test runner to Vitest 4 while retaining coverage thresholds and an explicit source scope.
- Add a proposed v1.0 capability/evidence baseline and shared-runtime ADR. SDK adapters and target-platform certification remain pending; these documents are not a v1.0 support claim.

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

[Unreleased]: https://github.com/YanagiKH/DisRunner/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/YanagiKH/DisRunner/releases/tag/v0.1.0
