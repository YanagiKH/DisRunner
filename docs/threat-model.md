# Threat model

This model covers the deterministic model runner, shared real Bot Session, Electron desktop, local REST/Gateway services, raw and pinned SDK adapters, versioned workspaces, diagnostic exports, and release automation.

Public plugins, general Discord archive import, automatic updates, telemetry, and live/Hybrid Mode are not provided. The workspace is a validated local JSON file, not a host isolation boundary.

## Assets

- Host files and credentials accessible to the current OS user.
- Imported bot source, dependencies, configuration, fixtures, and process availability.
- Synthetic runtime credentials, ephemeral interaction signing keys, and per-run webhook response peer secrets.
- In-memory state, bounded attachment bytes, process output, traces, findings, saved workspaces/backups, recent-project paths, reports, recordings, and reproduction bundles.
- Release artifacts, checksums, SBOM, provenance, and repository reputation.

## Actors and trust

- A developer can select a wrong or unsafe project/configuration.
- Imported code or a dependency can be buggy or malicious.
- Crafted configuration, fixture, process output, callback, REST, Gateway, or renderer-visible text can target parsers and boundaries.
- Another same-user local process can probe loopback services or inspect the user's process state.
- A pull request, dependency, workflow, maintainer account, runner, or signing secret can be compromised.

Discord is not part of the supported local raw/SDK data path. Imported code can still contact Discord independently because it is outside the application network boundary.

## Current controls and residual risk

| Threat                                | Implemented controls                                                                                                                                                                                         | Residual risk                                                                                                                  |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| Real token injection/leakage          | production-shaped tokens rejected on supported configuration/injection paths; synthetic tokens; bounded redaction; repository secret scan                                                                    | unknown secret shapes, files loaded by the bot, or direct host access can bypass these paths                                   |
| Renderer code execution or navigation | no Node integration; context isolation; Chromium sandbox; CSP/build boundary; narrow preload; sender checks; navigation/window/permission/download/request restrictions                                      | Electron/Chromium flaws or mistakes in an allowed local origin                                                                 |
| Local-service misuse                  | explicit loopback binding; REST synthetic authorization; Gateway synthetic session token; webhook Ed25519 request verification plus per-run HMAC response authentication; selected body/time/capacity limits | a blind same-user port claimant can deny availability; a process with same-user inspection rights may obtain session material  |
| Path or command escape                | canonical workspace paths including symlink resolution; bounded config/fixture JSON; parsed argument arrays; restricted runtime/executable rules; no shell composition                                       | imported code has normal OS authority after launch                                                                             |
| Resource exhaustion                   | selected payload, connection, bounded redaction traversal, trace/risk count and serialized-byte budgets, output, scenario, bucket, and process-stop bounds                                                   | serialized budgets approximate payload size; same-process Proxy traps and child code can still exhaust host resources          |
| External egress                       | core loopback URL/fetch policy; Electron renderer request allowlist; loopback adapter configuration                                                                                                          | child code is not intercepted or OS-sandboxed; no general blocked-egress finding exists                                        |
| Evidence leakage/tampering            | output sanitization, actor-specific private views, bounded evidence/completeness checks, frozen input digests, reproduction integrity hashes, checksums/SBOM/provenance                                      | redaction is heuristic; local hashes do not authenticate a publisher; runner/dependency/maintainer compromise remains possible |
| Workspace corruption/conflicts        | resource/reference validation, secret rejection, save lock, expected-file hashes, atomic replacement, previous-save backup and explicit recovery                                                             | the host user or external tools can modify/delete files and backups; storage failure can still lose data                       |
| Malicious release                     | pinned actions, trusted main/tag checks, test/package gates, checksums/SBOM/provenance, stable native signing/notarization verification                                                                      | repository rules, environments, credential security, runner integrity, and account security remain external prerequisites      |

## Review and test cases

Security tests should continue covering:

- absolute/traversal/symlink paths and oversized or unexpected configuration fields;
- real-looking credentials in arguments/environment and secret-like output split across chunks;
- non-loopback and redirected URL targets;
- malformed, oversized, unsigned, expired, future-dated, and replayed webhook requests;
- missing/malformed peer secrets; port claimants returning valid-looking JSON without HMAC; wrong-key, status-changed, request-changed, response-changed, and replayed response authentication;
- wrong REST authorization, route-token disclosure, hostile Host values, and oversized bodies;
- Gateway authentication, idle/unidentified clients, invalid payloads, and bounded sessions;
- malicious renderer navigation/request/permission/download attempts;
- process start/stop failures, output floods, crashes, and cleanup errors;
- cross-actor ephemeral/DM and denied-channel views, stale actor context, and attachment access;
- concurrent workspace saves, corrupt/newer versions, backup recovery, and changed-input/tampered reproduction bundles;
- scoped fault cancellation/reset and rejection of incomplete evidence;
- pull-request workflow injection, untrusted artifact input, mutable release refs, and secret disclosure in scanner output.

These are application-boundary cases. A child that directly opens a socket or reads an accessible host file requires an external OS sandbox to contain it.

## Assumptions

The host OS, Node/Electron runtime, and maintainer account are not already compromised. Users run only trusted code unless they add an external sandbox. Loopback is reachable by other local processes and is not itself identity; application-level peer authentication assumes the per-run secret is not extracted from the supervised child or main process. CI success is evidence for the tested revision, not a guarantee that all vulnerabilities are absent.

## Review triggers

Revisit this model when changing privileged IPC, supported adapters, workspace versions/recovery, reproduction formats, fault scope, native dependencies, signing paths, or write-capable CI events, and before introducing plugins, remote content, updates, telemetry/crash upload, or live/hybrid traffic.

See [Security model](security-model.md) and [Offline mode](offline-mode.md) for operational boundaries.
