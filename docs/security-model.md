# Security model

DisRunner executes an imported local process and renders workspace-derived values. v0.1 hardens the supported raw-webhook/Electron path, but it is not an OS sandbox and does not make arbitrary project code trustworthy.

## Current security objectives

- Supported simulator services and renderer requests stay on explicitly allowed loopback/app resources.
- The supported raw-webhook path uses synthetic credentials and does not require a live Discord token.
- The renderer has no generic Node, shell, filesystem, or IPC bridge.
- Project commands/paths, local messages, and process output are validated and bounded at their implemented boundaries.
- Supported process output and CLI exports apply common secret redaction.
- Canonical release artifacts can carry checksums, SBOM, and workflow provenance.

## Electron boundary

- Node integration is disabled; context isolation and Chromium sandboxing are enabled.
- Preload exposes a narrow typed project/runtime bridge rather than generic `invoke` or filesystem access.
- Navigation, new windows, permissions, downloads, and external protocols are restricted.
- Project/config paths are canonicalized and constrained to the selected workspace.
- Runtime services bind loopback addresses and use synthetic authorization/signature material.
- Supported IPC/request bodies have explicit shape and size checks where implemented.

v0.1 does not claim that every local HTTP/WebSocket service validates Origin/Host/path, authenticates every possible client, or enforces an idle timeout. Treat the same-user host as a trust boundary.

## Bot process boundary

- The reviewed `startCommand` is parsed into an executable/arguments rather than composed with untrusted payload text in a shell command.
- Entry point, working directory, fixtures, and executable resolution are checked against the selected project.
- Explicit environment values are allowlisted; protected simulator variables and production-shaped tokens fail closed.
- stdout/stderr are bounded and redacted. They are not causally correlated with every core trace span.
- Stop/app exit attempts to terminate the registered process tree and close simulator services.
- Opening a project does not run dependency installation scripts.

The imported process still inherits the current OS user's filesystem/network/process capabilities unless an external sandbox removes them. It can ignore DisRunner environment variables, load its own `.env`, spawn children, or open direct network connections. See [Offline mode](offline-mode.md).

## Data and plugin status

v0.1 has no workspace database, versioned data migration system, archive importer/exporter, diagnostics bundle, or persistent retention manager. CLI writes only explicitly requested scenario/recording/report files and sanitizes supported output values.

The public plugin SDK and capability sandbox are planned. No plugin isolation, signature, permission, or audit guarantee should be inferred from preview Settings labels.

## Release security

The repository defines formatting, lint, type, test, security, package, checksum, SBOM, and provenance jobs. A completed release run proves only the jobs that actually succeeded. Branch/tag rules, environment reviewers, immutable-release settings, signing, and notarization are external repository/release prerequisites.

## Secure operating posture

Use only trusted local projects, remove production credentials, keep simulator endpoints on loopback, inspect generated reports, and use a disposable VM/container or OS firewall/sandbox for unknown code. Weakening a boundary should be explicit and reversible; v0.1 preview toggles that are not persisted are not security controls.
