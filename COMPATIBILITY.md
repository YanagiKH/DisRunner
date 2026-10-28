# Compatibility

DisRunner provides a bounded local Discord API v10 profile for development and regression tests. Desktop and CLI share the same runtime, project configuration, action driver, state, and real Bot scenario runner. It does not reproduce every Discord feature or certify arbitrary SDK versions.

## Toolchain and platform targets

The tested source toolchain is Node.js `22.23.2` and pnpm `11.19.0`. Source manifests accept Node.js `>=22.23.2 <23`. Python adapter tests use Python `3.12.14`.

| Platform         | Package target | Qualification                                                        |
| ---------------- | -------------- | -------------------------------------------------------------------- |
| Windows 11 x64   | NSIS installer | Consult the release's actual installation and signing results        |
| Ubuntu 24.04 x64 | AppImage       | Consult the release's actual launch and dependency requirements      |
| macOS 14+ arm64  | DMG            | Consult the release's actual OS, signature, and notarization results |
| macOS 14+ x64    | DMG            | Consult the release's actual OS, signature, and notarization results |

Build targets are separate from installed-platform qualification. A successful run on one OS or architecture does not qualify another. Published artifacts and their stated platform results are listed on [Releases](https://github.com/YanagiKH/DisRunner/releases).

## Bot integration modes

| Adapter                       | Version                 | Contract                                                                            |
| ----------------------------- | ----------------------- | ----------------------------------------------------------------------------------- |
| Raw interaction webhook       | API v10 callback subset | Real child process, signed requests, authenticated response bytes, actual callbacks |
| `discord.js`                  | 14.27.0                 | Node.js 22; ESM/CommonJS bootstrap, local REST/Gateway, actual SDK event dispatch   |
| `discord.py`                  | 2.6.4                   | Python 3.12; local REST/Gateway, normal Client/Bot and command-tree/View dispatch   |
| Other SDK versions/frameworks | Unsupported             | Explicit adapter/version diagnostics; no Discord fallback                           |
| Generic Gateway/stdio process | Unsupported             | A process executable alone does not define an adapter                               |
| User-account/self-bot clients | Out of scope            | Bot applications only                                                               |

Prepare dependencies before an offline run. The SDK profiles require their exact versions and use synthetic credentials. See [SDK adapters](docs/sdk-adapters.md).

## Capability matrix

| Capability                       | Supported path                             | Boundary                                                                                                                     |
| -------------------------------- | ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| State, virtual clock, seeded IDs | Core and version 1 scenarios               | Controls modeled code; not arbitrary Bot timers/randomness                                                                   |
| Real Bot lifecycle               | Shared Desktop/CLI runtime                 | Start, ready, invoke/observe, cancel, stop, restart; [platform cleanup limits](docs/runtime-lifecycle.md)                    |
| Fixtures and workspaces          | Guild Editor and workspace files           | Guild/channel/DM/role/user/member/message resources, validation, atomic save, backup/recovery                                |
| Commands                         | Local registry and Command Explorer        | Global/guild registration; typed options, subcommands/groups, choices, autocomplete, user/message targets                    |
| Command registry v1              | Explicit compatibility profile             | Slash options remain restricted to empty arrays                                                                              |
| Command registry v2              | SDK default; raw opt-in                    | Supported API v10 command fields; no global publication delay or user-installed application profile                          |
| Interaction responses            | Runtime, REST, and real SDKs               | Initial reply/defer, original/followup fetch/edit/delete, token ownership, partial edit, ephemeral visibility                |
| Components and modals            | Legacy message profile                     | Buttons, string/entity selects, text-input modals; no Components V2                                                          |
| Messages                         | State, SDK events, REST, live Desktop feed | Text, embeds, local bounded attachments, edit/delete; no CDN fetching                                                        |
| Permissions and intents          | Declared route/event profiles              | Guild role/member overwrites, ordinary guild-text own-message authorization, requested/allowed intents and content filtering |
| Gateway                          | Single-shard JSON transport                | Cache bootstrap, heartbeat, close, reconnect/resume, bounded replay history                                                  |
| Version 1 scenarios              | Core/CLI                                   | Explicit model actions and virtual time; these do not execute a user Bot                                                     |
| Version 2 scenarios              | Shared Desktop/CLI runner                  | Actual Bot actions, bounded awaits, state/response/error assertions, cancellation, severity policy                           |
| Reports                          | JSON, JUnit, HTML, SARIF                   | Shared version 2 verdict, run metadata, fault receipts, redaction, completeness checks                                       |
| Recording/replay                 | Versioned model recording                  | Model replay; repeat a version 2 scenario for a fresh Bot rerun                                                              |
| Fault injection                  | Session-scoped transport plans             | Delay, timeout, HTTP 429/5xx, Gateway disconnect/duplicate; bounded occurrences and teardown                                 |
| Inspector and risks              | Current runtime evidence                   | Live trace/output/state and supported findings; no sample evidence in an active project run                                  |
| Performance                      | Core measurements and host duration        | No arbitrary-process CPU/flamegraph profiler or Internet latency prediction                                                  |

The [protocol guide](docs/protocol-compatibility.md), [REST catalog](docs/rest-emulator.md), and [limitations](docs/limitations.md) describe the operation-level boundaries. An event or method present in an SDK is not automatically implemented by the local service.

## Permissions and viewing context

Raw projects preserve `legacy-unenforced` ordinary-message behavior unless `guild-text-own-messages-v1` is selected with an explicit bot fixture. SDK projects default to the enforcing profile and a synthetic local Bot membership. Existing fixture permissions remain authoritative. This profile is independent of strict/lenient payload mode and does not imply complete Discord authorization or moderation parity.

Public snapshots omit ephemeral messages. Actor-specific views include only that actor's ephemeral responses. Role/member context and channel selection come from the loaded state; a response retains the actor and channel that initiated it. This local visibility model does not replace an OS security boundary.

## Compatibility policy

1. Adapter support is pinned to the documented SDK/runtime profile and exercised through real processes.
2. Configuration and scenario formats reject unknown closed fields. Resource payload extension fields have their own validation rules.
3. Project configs, workspaces, scenarios, recordings, and version 2 reports carry explicit format versions. Unknown newer workspace versions are not overwritten.
4. Virtual model replay, trace playback, and real Bot rerun are different operations. Bot reruns do not restore arbitrary process memory.
5. Feature declarations and platform qualification follow the corresponding release and tests; signing and notarization must be verified on the actual artifacts.

Report protocol drift with a minimal redacted fixture and the DisRunner/SDK versions. Never attach production credentials or private production conversations.
