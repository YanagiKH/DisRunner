# Compatibility

DisRunner v0.1 is a Preview. This matrix separates behavior tested directly in the core/CLI from the narrower behavior connected through Electron. It does not claim Discord or SDK parity.

Legend: **Core-tested** = covered through the in-process core or CLI; **Desktop preview** = usable in the stated Electron path but incomplete; **Visual preview** = illustrative UI, not an authoritative runtime surface; **Planned** = rejected or unavailable in v0.1; **Out** = intentionally out of scope.

## Toolchain and platform targets

The source toolchain is Node.js `>=22.23.2 <23` with pnpm `11.19.0`.

| Platform            | Source/package target | v0.1 declaration                                                   |
| ------------------- | --------------------- | ------------------------------------------------------------------ |
| Windows 11 x64      | NSIS                  | Preview target; promote only from a green platform release run     |
| macOS 14+ arm64/x64 | DMG                   | Preview target; signing/notarization is release-configuration data |
| Ubuntu 24.04+ x64   | AppImage              | Preview target; promote only from a green platform release run     |
| Other environments  | None                  | No compatibility declaration                                       |

A workflow or package target is not by itself proof that a host is supported. Check the release notes for the platforms actually exercised by that release.

## Bot integration modes

| Framework/mode                | v0.1 status     | Current contract                                                                            |
| ----------------------------- | --------------- | ------------------------------------------------------------------------------------------- |
| Raw interaction webhook       | Desktop preview | Bundled Node example, signed PING readiness, signed local command request, `/ping` callback |
| Generic executable            | Planned adapter | A bounded process-runner primitive exists, but there is no generic health/stdio protocol    |
| Generic Gateway bot           | Planned adapter | Core Gateway transport is not wired as a supported imported-bot desktop adapter             |
| `discord.js`                  | Planned         | Project validation fails closed; no compatible SDK version is declared                      |
| `discord.py`                  | Planned         | Project validation fails closed; no compatible SDK version is declared                      |
| Simulator SDK                 | Planned         | No public TypeScript or Python SDK package                                                  |
| User-account/self-bot clients | Out             | Prohibited project scope                                                                    |

The `bot.runtime` label in a raw-webhook project describes how to launch that webhook process. It does not imply framework compatibility.

## Capability matrix

| Surface                                 | v0.1 status     | Current boundary                                                                   |
| --------------------------------------- | --------------- | ---------------------------------------------------------------------------------- |
| Deterministic state/clock/IDs/snapshots | Core-tested     | In-process version 1 scenarios and tests                                           |
| Scenario run and assertions             | Core-tested     | CLI/core schema; unsupported actions fail validation                               |
| Recording and deterministic replay      | Core-tested     | Versioned CLI recording envelope and verification output                           |
| JSON/JUnit/HTML/SARIF reports           | Core-tested     | Generated from CLI scenario results; findings do not fail a run unless asserted    |
| Interaction lifecycle                   | Core-tested     | Immediate/deferred/follow-up state and 3,000/900,000 ms virtual-time contracts     |
| Electron raw-webhook interaction        | Desktop preview | Real local `/ping` request/callback; no complete component/modal/autocomplete UI   |
| Permission calculation                  | Core-tested     | `BigInt` roles, overwrites, administrator and implicit channel removals            |
| Intent filtering                        | Core-tested     | In-process requested/allowed intent behavior; desktop config intents are not wired |
| Rate-limit engine                       | Core-tested     | Configurable programmatic buckets; not a desktop project-profile feature           |
| REST emulator                           | Core-tested     | Partial user/channel/message/guild/callback/follow-up routes; no command registry  |
| Gateway lifecycle                       | Core-tested     | Partial in-process/WebSocket lifecycle; no desktop fixture/event synchronization   |
| Protocol/object limits                  | Core-tested     | Selected message/embed/attachment/component/custom-ID checks only                  |
| Risk findings                           | Core-tested     | Small implemented rule set listed in `docs/risk-engine.md`                         |
| Desktop runtime status/output           | Desktop preview | Project validation, PID/status, bounded stdout/stderr, start/stop and cleanup      |
| Guild/command/scenario editor surfaces  | Visual preview  | Seeded display state; edits/runs are not persisted or connected to the CLI engine  |
| Inspector and Risk Center               | Visual preview  | Some `/ping` timing/callback and runtime risks; remaining panels are illustrative  |
| Generic fault injection                 | Planned         | No version 1 `faults` schema or packet/network fault policy                        |
| Imported-process performance profiling  | Planned         | No CPU/memory/event-loop/queue instrumentation                                     |
| Components V2 catalog                   | Planned         | Selected validators do not constitute complete support                             |
| Voice state/transport/audio/encryption  | Out             | Not implemented                                                                    |
| CDN/regional/anti-abuse behavior        | Out             | Not reproduced                                                                     |

## Compatibility policy

1. A release declares only behavior backed by tests at the layer named above.
2. Version 1 parsers validate documented fields but do not promise lossless preservation of unknown fields.
3. CLI recording files carry a format version. Other scenario, fixture, snapshot, trace, and report formats are Preview unless their own schema states otherwise.
4. Strict/lenient behavior is surface-specific; see [Protocol compatibility](docs/protocol-compatibility.md). Lenient validation warnings are not yet surfaced consistently across all runtime paths.
5. Framework support is promoted only after an adapter and pinned-version contract suite land.

Report protocol drift with a minimal redacted fixture. Never attach a production token or private production data.
