# Known limitations

DisRunner implements a bounded local Discord profile. A passing local test verifies that profile and its observed inputs; it does not guarantee identical behavior for every production service condition.

## Adapters and protocol

- SDK support is pinned to `discord.js` 14.27.0 and `discord.py` 2.6.4. Other versions/frameworks are rejected rather than connected to Discord.
- Gateway uses API v10, single-shard JSON transport, bounded cache/bootstrap data and replay history. Compression, large-guild chunking, multi-shard operation, presence/voice systems, and unlisted events are outside the profile.
- Guild-installed application commands support the documented command/option subset. User-installed command contexts, commerce, subscriptions, entitlements, and global command propagation delays are not reproduced.
- Components use legacy message buttons/selects and text-input modals. Complete Components V2 and newer modal controls are unsupported.
- DM fixtures support text messages and prefix handlers. Guild-installed command invocation requires a guild context. DM authorization does not claim full Discord permission parity.
- REST and permissions cover the declared routes. Moderator mutation, advanced hierarchy rules, threads/forums/stages, reactions, general webhooks, and the complete API catalog are not implied by an SDK method's existence.

## Messages and visibility

- Text, supported embeds/components, and bounded local attachments are represented; proprietary client rendering and CDN fetching are not.
- Ephemeral responses are visible in the owning actor's view, remain bound to their interaction token, and are omitted from public Gateway broadcasts and public snapshots.
- A selected actor is a local simulation context. It does not prevent the machine's OS user from inspecting the project's files or process memory.
- Existing unsupported fixture placeholders may be retained for editing without enabling their corresponding service behavior.

## Timing and replay

- Version 1 model scenarios control virtual time and seeded core behavior. Arbitrary Bot host timers, randomness, threads, databases, and files are not virtualized.
- Version 2 runs real processes and measures host/loopback duration. SDK collector/View timeouts use their normal host timers.
- Replaying a model recording is different from rerunning a Bot. A new Bot run begins from saved initial resources and fresh credentials; it does not restore arbitrary process memory.
- Automatic hot reload is unsupported; `hotReload: true` is rejected.

## Faults, reports, and diagnostics

- Fault plans cover bounded delay/timeout, HTTP 429/5xx, Gateway disconnect, and duplicate events. They do not inject arbitrary disk, DNS, database, CPU, or memory failures.
- Loopback timings do not predict Internet latency or Discord regional behavior. There is no arbitrary-process flamegraph or full event-loop profiler.
- Version 2 requires behavior assertions, expected-error matching, complete evidence, and the selected severity policy before returning a pass. Version 1 retains its documented model assertion policy.
- Risk baselines, expiring suppressions, historical trends, and online telemetry are not provided.
- Logs, traces, state views, fault receipts, and reports are bounded. Incomplete evidence prevents a version 2 passing verdict where completeness is required.
- Redaction removes known credential patterns and current session secrets; review project-specific confidential information before sharing reports.

## Workspace and delivery

- Workspaces are versioned local JSON files with atomic save, backups, conflict checks, and explicit recovery. They are not collaborative multi-machine databases.
- An unknown newer format cannot be overwritten by an older application. Bot process state is not recovered from a workspace backup.
- Platform targets are separate from installed-release qualification. Use the release's actual tested OS/architecture, checksum, signature, and notarization information.
- Dependencies and interpreters must be prepared separately before offline use. DisRunner does not silently install a missing SDK or contact Discord as a fallback.

## Security isolation

Supported transports use synthetic credentials and session loopback endpoints. The Electron renderer has its own navigation/IPC restrictions. These controls do not sandbox arbitrary Bot code, custom HTTP libraries, native modules, subprocesses, or filesystem access.

A local process can occupy a Bot's released dynamic port and deny startup. Raw signed readiness and response authentication prevent an unrelated listener from producing accepted callbacks without the per-run secret. A process with sufficient same-user inspection privileges may still inspect or interfere with other local processes.

Use separate OS/container/VM restrictions for untrusted code and never supply a production token. Signing, checksums, and provenance establish artifact facts; they do not prove that software contains no vulnerabilities.

Voice transport/audio/encryption, user-account automation, pixel-perfect Discord reproduction, regional infrastructure, anti-abuse systems, and undocumented client behavior are outside scope.
