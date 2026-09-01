# Threat model

This model describes the shipped v0.1 Preview: deterministic core/CLI, the Electron desktop runtime, loopback REST/Gateway services, the supported raw interaction-webhook example, workspace files, explicit CLI outputs, and release automation.

Plugins, a workspace database, archive import/export, automatic updates, telemetry, and Hybrid Mode are planned or absent, so v0.1 makes no security claim for those future boundaries.

## Assets

- Host files and credentials accessible to the current OS user.
- Imported bot source, dependencies, configuration, fixtures, and process availability.
- Synthetic runtime credentials and ephemeral interaction signing keys.
- In-memory virtual state, process output, traces, findings, and explicit CLI reports/recordings.
- Release artifacts, checksums, SBOM, provenance, and repository reputation.

## Actors and trust

- A developer can select a wrong or unsafe project/configuration.
- Imported code or a dependency can be buggy or malicious.
- Crafted configuration, fixture, process output, callback, REST, Gateway, or renderer-visible text can target parsers and boundaries.
- Another same-user local process can probe loopback services or inspect the user's process state.
- A pull request, dependency, workflow, maintainer account, runner, or signing secret can be compromised.

Discord is not part of the supported local `/ping` data path. Imported code can still contact Discord independently because it is outside the application network boundary.

## Current controls and residual risk

| Threat                                | Implemented v0.1 controls                                                                                                                                               | Residual risk                                                                                                         |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Real token injection/leakage          | production-shaped tokens rejected on supported configuration/injection paths; synthetic tokens; bounded redaction; repository secret scan                               | unknown secret shapes, files loaded by the bot, or direct host access can bypass these paths                          |
| Renderer code execution or navigation | no Node integration; context isolation; Chromium sandbox; CSP/build boundary; narrow preload; sender checks; navigation/window/permission/download/request restrictions | Electron/Chromium flaws or mistakes in an allowed local origin                                                        |
| Local-service misuse                  | explicit loopback binding; REST synthetic authorization; Gateway synthetic session token; webhook Ed25519 verification; selected body/time/capacity limits              | same-user processes can reach loopback and may learn in-process/session material                                      |
| Path or command escape                | canonical workspace paths including symlink resolution; bounded config/fixture JSON; parsed argument arrays; restricted runtime/executable rules; no shell composition  | imported code has normal OS authority after launch                                                                    |
| Resource exhaustion                   | selected payload, connection, bounded redaction traversal, trace/risk count and serialized-byte budgets, output, scenario, bucket, and process-stop bounds              | serialized budgets approximate payload size; same-process Proxy traps and child code can still exhaust host resources |
| External egress                       | core loopback URL/fetch policy; Electron renderer request allowlist; loopback adapter configuration                                                                     | child code is not intercepted or OS-sandboxed; no general blocked-egress finding exists                               |
| Evidence leakage/tampering            | supported output sanitization, stable core hashes, bounded evidence, CI checks, checksums/SBOM/provenance workflows                                                     | redaction is heuristic; runner/dependency/maintainer compromise remains possible                                      |
| Malicious release                     | immutable-action pins, test/security/package gates, checksum/SBOM/provenance jobs                                                                                       | repository rules, environments, code signing, notarization, and account security are external prerequisites           |

## Review and test cases

Security tests should continue covering:

- absolute/traversal/symlink paths and oversized or unexpected configuration fields;
- real-looking credentials in arguments/environment and secret-like output split across chunks;
- non-loopback and redirected URL targets;
- malformed, oversized, unsigned, expired, future-dated, and replayed webhook requests;
- wrong REST authorization, route-token disclosure, hostile Host values, and oversized bodies;
- Gateway authentication, idle/unidentified clients, invalid payloads, and bounded sessions;
- malicious renderer navigation/request/permission/download attempts;
- process start/stop failures, output floods, crashes, and cleanup errors;
- pull-request workflow injection, untrusted artifact input, mutable release refs, and secret disclosure in scanner output.

These are application-boundary cases. A child that directly opens a socket or reads an accessible host file requires an external OS sandbox to contain it.

## Assumptions

The host OS, Node/Electron runtime, and maintainer account are not already compromised. Users run only trusted code unless they add an external sandbox. Loopback is considered reachable by other local processes. CI success is evidence for the tested revision, not a guarantee that all vulnerabilities are absent.

## Review triggers

Revisit this model when adding a privileged IPC method, supported bot adapter, persistent store/migration, plugin system, archive/import parser, native dependency, remote content, updater, telemetry/crash upload, live/hybrid traffic, signing path, or new write-capable CI event.

See [Security model](security-model.md) and [Offline mode](offline-mode.md) for operational boundaries.
