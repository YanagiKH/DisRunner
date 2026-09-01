# Security Policy

## Supported versions

Security fixes are provided for the latest stable release and, when feasible, the immediately preceding minor release. Development previews may receive fixes only on the default branch.

| Version        | Supported   |
| -------------- | ----------- |
| Latest stable  | Yes         |
| Previous minor | Best effort |
| Older releases | No          |

## Report a vulnerability privately

Use [GitHub private vulnerability reporting](https://github.com/YanagiKH/DisRunner/security/advisories/new). Do not open a public issue for a suspected vulnerability.

Include the affected version/commit, platform, threat scenario, reproduction, impact, and any suggested mitigation. Remove bot tokens, personal data, private message content, absolute local paths, and unrelated secrets. If a minimal proof requires a token-like value, use an obvious fake.

We aim to acknowledge a report within 3 business days, provide an initial assessment within 7 business days, and coordinate disclosure after a fix is available. Timelines may change with complexity; reporters will receive status updates.

## High-priority classes

- Offline Mode unexpectedly contacting Discord or accepting/injecting a real token.
- Secret, token, PII, or message-content disclosure through logs, traces, reports, screenshots, crash data, or release artifacts.
- Interaction signature bypass, unsafe local authentication, or a service bound beyond loopback.
- Path traversal, unsafe archive extraction/upload, shell injection, or unrestricted plugin capability.
- Renderer-to-Node privilege escalation, unsafe IPC, CSP bypass, or untrusted remote content execution.
- Release/update tampering, signature bypass, provenance failure, or dependency compromise.

## Important sandbox boundary

DisRunner's compatibility layer can enforce an offline policy for traffic routed through DisRunner. An imported bot project executes code and may create its own sockets, files, or child processes. DisRunner is not, by itself, an operating-system security sandbox. Use a disposable VM/container and deny outbound network access when evaluating untrusted code. See [Offline mode](docs/offline-mode.md) and [Threat model](docs/threat-model.md).

## Release handling

Security releases use the gated process in [docs/release-process.md](docs/release-process.md). Maintainers must ensure tests, CodeQL, dependency review, secret scanning, package signing where configured, checksums, and an SBOM complete before publication.
