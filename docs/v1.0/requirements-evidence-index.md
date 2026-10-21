# DisRunner M0-01 requirements and evidence index — proposal

Status: draft for review, not G0 completion or v1 certification. No project execution occurred in this task.

## Identity and source of truth

- Repository base: `9f57ab6c8f9688513b880ccb283f8365b45be681`.
- Roadmap: `DisRunner_v1.0_Implementation_Roadmap(2).md`, 94,824 bytes; SHA256 `560ea8156d4b2b38656d1f38ee852aeb2db4188d4fdd51edef2ec1ea4b370739`. Sections 4.2–4.5, 5 and M0/M1 govern this summary.
- [`capability-manifest.json`](./capability-manifest.json) holds the authoritative proposed 18-row inventory. This index supplies evidence rules and review work, rather than another independently maintained feature matrix.
- Source paths in the manifest are repository-root-relative. The user-supplied roadmap is identified by hash and is not bundled here.
- Existing [`COMPATIBILITY.md`](../../COMPATIBILITY.md) uses “Core-tested” for previous declarations. Here that is a **reviewed declaration**, not a new test result. Existing source is not treated as proven correct.

## Evidence register

| ID                  | Kind                             | Identity / location                                                                                                                            | Meaning and limits                                                                           |
| ------------------- | -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| E-ROADMAP           | Supplied planning document       | Hash above, sections 4–5 and M0/M1                                                                                                             | Defines target requirements, not implementation evidence.                                    |
| E-SOURCE            | Read-only source/document review | [fixed base](https://github.com/YanagiKH/DisRunner/tree/9f57ab6c8f9688513b880ccb283f8365b45be681); `COMPATIBILITY.md` and per-row source paths | Confirms declared boundaries and file locations; no runtime qualification.                   |
| E-ADAPTER-VALIDATOR | Static code review               | `apps/desktop/electron/project-config.cts:100–119` at fixed base                                                                               | Validator only accepts supported raw adapter. Does not establish raw end-to-end correctness. |

Future run evidence MUST include: evidence ID, exact source commit and tree, artifact/build identity, adapter/SDK/runtime pins, OS version and architecture, fixture/corpus revision, execution mode and clock, full command, exit/status, raw output location and SHA256, expected versus actual counts, failure/skip/incomplete labels, reviewer and timestamp. Never overwrite first failures. Store no credentials. Missing evidence is pending, not success.

## Requirement navigation and proposed ownership

M0 ownership is assigned: miku owns the capability baseline/shared contracts, dependency/security baseline audit and Gateway F08; fufu owns interaction F05; kuro owns scenario result trust F04 and strict scenario validation F09. These are bounded M0 slices, not acceptance of entire V requirements. The full-v1 roles below remain proposed and require named assignments before their work begins.

| ID  | Requirement                       | Proposed owner role   | Target milestones |
| --- | --------------------------------- | --------------------- | ----------------- |
| V01 | Project lifecycle and diagnostics | project/runtime       | M1 / M6           |
| V02 | Real Bot lifecycle                | runtime/adapters      | M1 / M3           |
| V03 | Fixture domain                    | domain                | M2                |
| V04 | Command registry                  | protocol              | M2 / M3           |
| V05 | Command invocation                | protocol/adapters     | M2 / M3           |
| V06 | Interaction responses             | domain/protocol       | M0 / M2 / M3      |
| V07 | Legacy components and modals      | protocol/adapters     | M2 / M3           |
| V08 | Message rendering                 | desktop               | M4                |
| V09 | Authorization and intents         | domain/protocol       | M0 / M2 / M3      |
| V10 | Bounded Gateway                   | gateway/adapters      | M0 / M2 / M3      |
| V11 | Real Bot scenarios                | scenario/runtime      | M0 / M1 / M5      |
| V12 | Persistence and repro             | persistence/contracts | M5 / M6           |
| V13 | Reports and exit policy           | reports/scenario      | M0 / M5           |
| V14 | Bounded fault injection           | runtime/protocol      | M5                |
| V15 | Recovery and cleanup              | runtime               | M1 / M7           |
| V16 | Real-data UI                      | desktop               | M4                |
| V17 | Platform qualification            | release/platform      | M7 / M8 / M9      |
| V18 | Release trust                     | release/security      | M0 / M8 / M9      |

## Admission and promotion checklist

1. Freeze each adapter profile using an M0 spike: exact SDK/language versions, lock identities, official compatibility constraints, bootstrap/transport interception, required startup routes, offline installation/preparation and licensing. Raw has no SDK requirement; its runtime and bridge protocol still need a versioned contract. No guessed pins.
2. Run the same applicable corpus through raw, discord.js and discord.py. “Not applicable” requires a profile reason, not a shortcut around the shared v1 requirement. V10 is a Gateway requirement for SDK adapters, not an extra requirement for the outgoing webhook transport. JS first does not waive Python; missing Python keeps release beta.
3. Keep source review, model units, actual Bot integration and packaged platform qualification distinct. Pin capability result to its tested identity; retain failed/skipped evidence. A table or green package build cannot promote a platform.
4. First shared-runtime gate: identical project/fixture/scenario via CLI and Desktop; correct raw `/ping` passes, altered/wrong response, no reply, not started and early crash fail. Changing Bot code must change results. No automatic model reply in Bot mode.
5. Resolve M0 F04/F05/F08/F09 regressions, strict v1 scenario corpus, exact-head required checks and security audit. Reachability exceptions need owner, proof and expiry; reachable shipped high/critical blocks release. This draft does not certify these gates.
6. For Windows 11 x64, Ubuntu 24.04 x64, macOS 14+ arm64 and x64, collect actual target installation and packaged UI/IPC/Bot/cleanup evidence plus applicable signing, Gatekeeper, upgrade/removal evidence. Latest hosted runner success is not minimum-OS proof.

## Explicit exclusions

No full Discord parity: full Components V2/new modal controls, voice/CDN/media, advanced threads/forums, reactions/presence, multi-bot/sharding/large-guild behavior, arbitrary SDK versions, arbitrary Bot time/random virtualization or memory checkpoint, general untrusted-code OS sandbox, automatic updater, plugin marketplace and advanced profiler are deferred. Unsupported operations must fail explicitly, not silently degrade.

## Remaining M0-01 work

Manifest/ADR review; assign remaining full-v1 owners; version/transport spikes and evidence; freeze schemas/profile limits; choose machine-readable schema home and documentation generation path. These repository documents remain proposals until reviewed and backed by the required evidence. No SDK, platform or v1 support is newly declared by this bundle.

## Architecture decision

See [ADR-0001: shared runtime](./ADR-0001-shared-runtime.md). It remains proposed; extraction and SDK certification are not established by documentation.
