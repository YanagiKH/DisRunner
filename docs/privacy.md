# Privacy

DisRunner runs locally and has no telemetry or crash-upload service. Its supported raw/SDK transports use the local simulator rather than Discord. Imported Bot code still has the host user's network access unless an external sandbox restricts it.

## Data handled locally

- The selected project path is remembered in `preferences.json` under Electron's application user-data directory. Packaged example copies are also stored there.
- Fixture JSON is read into local core state.
- `.disrunner/workspace.json` stores edited fixtures, scenarios, seed, and mode. Previous saves, recovery files, and a save lock live beside it.
- Bounded bot stdout/stderr and runtime trace/risk entries are held in memory for the current session. Core trace retention uses count and serialized-byte limits with oldest-completed eviction; risk retention fails closed when its count or byte capacity is exhausted.
- Scenario files, model recordings, diagnostic reproduction bundles, and JSON/JUnit/HTML/SARIF reports exist at explicitly chosen paths.
- Live Desktop messages and actor-specific private responses come from the local Bot run; the separate browser demo uses synthetic data. Attachment bytes are bounded local data, and project files remain on disk.

There is no automatic retention manager or historical risk-baseline store. Saving a workspace or exporting a report creates persistent files; stopping a Bot does not delete them. Public snapshots omit DMs/ephemeral messages, while an authorized actor view can contain private local conversation content.

## Minimize collection

Use synthetic users/content and the smallest fixture needed for a test. Project paths, filenames, aliases, message content, stack traces, process output, payloads, and reports can still contain confidential information even without live Discord data.

## Redaction boundary

The bot runner redacts common credential-shaped values in bounded stdout/stderr. CLI report/recording output passes through the supported export sanitizer. String fixtures are rejected before `JSON.parse` when their UTF-8 input exceeds the 1 MiB default; callers may configure a smaller or larger positive `maxInputBytes` up to the 64 MiB hard ceiling. Redaction traversal has depth, node, per-container entry, per-string, and total source-string limits; truncation or an unsupported structure is marked explicitly, and secret detection treats incomplete inspection as unsafe. Accessor getters are not invoked. This does not rewrite source scenarios or fixtures and does not guarantee that every renderer field, third-party screenshot, copied terminal line, encoded value, split log fragment, JavaScript Proxy trap, or project-specific secret is removed.

Reproduction bundles redact configured environment values, known credential patterns, and private project paths. They include supported fixtures and run results but omit source code, dependencies, environment values, and attachment file bytes. Their hashes detect changes to the exported bundle; they do not make confidential message content safe to publish. Inspect every export and screenshot before sharing it.

## Imports and sharing

Prefer synthetic fixtures and remove credentials, identifying IDs/names/content, attachments, URLs, IP addresses, and sensitive timestamps. There is no general anonymized Discord archive importer.

Desktop save/export actions and explicit CLI commands write local files; DisRunner does not upload or publish them. Delete generated files from their chosen paths and separately check workspace backups/recovery files, synced folders, CI artifacts, issue attachments, and OS trash. Close the app before removing its recent-project preferences or copied examples. Application removal does not delete external project workspaces.

For a suspected disclosure, stop sharing the artifact, rotate affected secrets, preserve minimal safe evidence, and follow [private vulnerability reporting](../SECURITY.md).
