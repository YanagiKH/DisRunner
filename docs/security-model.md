# Security model

DisRunner executes a local Bot process and renders project-derived values. The supported raw, discord.js 14.27.0, and discord.py 2.6.4 paths share Session validation and local services. DisRunner is not an OS sandbox and does not make arbitrary project code trustworthy.

## Current security objectives

- Supported simulator services and renderer requests stay on explicitly allowed loopback/app resources.
- The supported raw-webhook path uses synthetic credentials, Ed25519-authenticated requests, and per-run HMAC-authenticated responses; it does not require a live Discord token.
- Pinned SDK adapters use synthetic credentials and local Gateway/REST targets. Unsupported SDK versions fail validation; dependency preparation remains a separate trusted step.
- The renderer has no generic Node, shell, filesystem, or IPC bridge.
- Project commands/paths, local messages, and process output are validated and bounded at their implemented boundaries.
- Supported process output and CLI exports apply common secret redaction.
- Canonical release artifacts can carry checksums, SBOM, and workflow provenance.

## Electron boundary

- Node integration is disabled; context isolation and Chromium sandboxing are enabled.
- Preload exposes a narrow typed project/runtime bridge rather than generic `invoke` or filesystem access.
- Navigation, new windows, permissions, downloads, and external protocols are restricted.
- Project/config paths are canonicalized and constrained to the selected workspace.
- Runtime services bind loopback addresses and use synthetic authorization/signature material. Raw response authentication is verified on bounded bytes before HTTP status or JSON/callback handling.
- Supported IPC/request bodies have explicit shape and size checks where implemented.
- Actor views omit other actors' ephemeral responses and DMs; enforcing profiles filter guild channels/messages by VIEW_CHANNEL. Public diagnostic snapshots are a trusted runtime API, not a replacement for the selected actor view.

Treat the same-user host as a trust boundary. Endpoint credentials authenticate a simulator session, not a separate OS user, and supported route/connection checks do not provide general isolation from other local processes.

## Bot process boundary

- The reviewed `startCommand` is parsed into an executable/arguments rather than composed with untrusted payload text in a shell command.
- Entry point, working directory, and fixtures are constrained to the selected project. Executable resolution validates the supported runtime, including an explicitly configured absolute interpreter path.
- Explicit project environment values are bounded; credential-like names cannot override supervisor values, protected values are written last, and production-shaped token values fail closed.
- The per-run webhook peer secret is injected only through a dedicated supervisor-owned `BotRunner` field, is required whenever an interaction endpoint is configured, and is included in child-output and supported-export redaction.
- stdout/stderr are bounded and redacted. They are not causally correlated with every core trace span.
- Stop/app exit attempts to terminate the registered process tree and close simulator services.
- Opening a project does not run dependency installation scripts.

The imported process still inherits the current OS user's filesystem/network/process capabilities unless an external sandbox removes them. It can read its own peer secret, ignore DisRunner environment variables, load its own `.env`, spawn children, or open direct network connections. A blind same-user port claimant can cause denial of service but cannot authenticate a response; a process able to inspect another process's environment or memory remains inside the documented same-user trust boundary. See [Offline mode](offline-mode.md).

## Data and extension boundaries

Workspace saves validate resources, reject secret-bearing data, use a lock and expected-file hash, and atomically replace the file while retaining a previous valid backup. Unknown newer versions are not overwritten. These controls prevent common accidental corruption/conflicts; the host user can still modify project files directly.

Explicit Desktop/CLI exports apply the supported redaction boundaries. Reproduction bundles verify scenario/fixture/report digests and identify changed run inputs, but omit source/dependencies and require the original project. Hash integrity is not publisher authentication. See [Privacy](privacy.md) and [Scenario v2](scenario-v2.md#diagnostic-reproduction-bundles).

No public plugin SDK, loader, or capability sandbox is available. Built-in SDK adapters are part of the application; their presence does not establish a third-party plugin API.

## Release security

The repository defines formatting, lint, type, test, security, package, checksum, SBOM, and provenance jobs. Stable Windows/macOS publication additionally requires native signing/notarization verification and receipts; previews are marked separately. A completed release run establishes only the target jobs that succeeded. Branch/tag rules, environment reviewers, immutable-release settings, and signing credentials still require repository configuration. See [Release process](release-process.md).

## Secure operating posture

Use trusted local projects, remove production credentials, keep simulator endpoints on loopback, inspect generated reports, and use a disposable VM/container or OS firewall/sandbox for unknown code. Scoped simulator faults affect only the current run; they do not establish host network isolation or permission to run unknown code.
