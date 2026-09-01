# Privacy

DisRunner v0.1 is local-first and has no implemented telemetry or crash-upload service. Its supported runtime path does not send project or simulation data to Discord.

## Data handled in v0.1

- The selected project path and validated non-secret launch configuration are held by Electron while the app runs.
- Fixture JSON is read into local core state.
- Bounded bot stdout/stderr and runtime trace/risk entries are held in memory for the current session. Core trace retention uses count and serialized-byte limits with oldest-completed eviction; risk retention fails closed when its count or byte capacity is exhausted.
- Scenario files, CLI recordings, and JSON/JUnit/HTML/SARIF reports exist at paths explicitly chosen by the user.
- Renderer guilds, members, messages, commands, and most inspector content are bundled synthetic preview data.

v0.1 does not implement a workspace database, recent-project store, retention manager, risk-baseline store, screenshot export, or diagnostics bundle. Preview Settings controls do not establish storage or deletion behavior.

## Minimize collection

Use synthetic users/content and the smallest fixture needed for a test. Project paths, filenames, aliases, message content, stack traces, process output, payloads, and reports can still contain confidential information even without live Discord data.

## Redaction boundary

The bot runner redacts common credential-shaped values in bounded stdout/stderr. CLI report/recording output passes through the supported export sanitizer. String fixtures are rejected before `JSON.parse` when their UTF-8 input exceeds the 1 MiB default; callers may configure a smaller or larger positive `maxInputBytes` up to the 64 MiB hard ceiling. Redaction traversal has depth, node, per-container entry, per-string, and total source-string limits; truncation or an unsupported structure is marked explicitly, and secret detection treats incomplete inspection as unsafe. Accessor getters are not invoked. This does not rewrite source scenarios or fixtures and does not guarantee that every renderer field, third-party screenshot, copied terminal line, encoded value, split log fragment, JavaScript Proxy trap, or project-specific secret is removed.

The app does not currently generate screenshots or diagnostics bundles, so it cannot promise redaction of those artifacts. Inspect every file and screenshot manually before sharing it.

## Imports and sharing

Do not import production Discord payloads. There is no v0.1 anonymized archive-import feature. Prefer synthetic fixtures and remove credentials, identifying IDs/names/content, attachments, URLs, IP addresses, and sensitive timestamps.

Exports are written only by explicit CLI commands. DisRunner does not upload or publish them. Delete generated files from their chosen paths and separately check backups, synced folders, CI artifacts, issue attachments, and OS trash.

For a suspected disclosure, stop sharing the artifact, rotate affected secrets, preserve minimal safe evidence, and follow [private vulnerability reporting](../SECURITY.md).
