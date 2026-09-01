# Known limitations

DisRunner v0.1 is a Preview testing foundation, not Discord and not proof that production will be failure-free.

## Current product boundary

- The authoritative v0.1 behavior is the deterministic core/CLI, bundled signed raw-webhook example, and Electron's real local `/ping` path.
- `discord.js`, `discord.py`, generic Gateway/stdio, and simulator SDK adapters are not implemented and fail project validation.
- Most desktop guild, command, scenario, inspector, risk, and settings content is seeded visual-preview data.
- Desktop fixtures, REST mutations, Gateway dispatches, and renderer state are not synchronized end to end.
- Guild Editor/Scenario Lab/Settings changes and Risk Center exports are not persisted.
- Desktop interactions do not cover context commands, autocomplete, components, modals, real follow-up observation, or a controllable 15-minute token clock.

## Protocol and service drift

- Discord can change payloads, limits, errors, API versions, and rollout behavior independently.
- REST, Gateway, interaction, object-limit, permission, intent, and rate-limit coverage is partial and layer-specific.
- An unlisted route/event/object is not implicitly supported.
- The core Gateway resume model does not establish a fully connected imported-bot desktop reconnect path.
- Undocumented client behavior, anti-abuse systems, regional routing, CDN caching, platform incidents, and rollout experiments are not reproduced.

## Timing, faults, and performance

- Core virtual time precisely controls modeled actions; imported bot code still uses host timers unless explicitly adapted.
- Electron's raw-webhook request uses host time and a 3-second abort, not the core virtual clock.
- Version 1 scenarios can schedule late acknowledgement, expiry, in-process disconnect/resume, permission checks, and repeated rate-limit requests.
- There is no generic latency/timeout/reset/drop/duplicate/reorder/dependency/storage/process fault engine in v0.1.
- There is no imported-process CPU, memory, event-loop, queue, or throughput profiler. Loopback timing cannot predict Internet or Discord regional latency.

## Risks and reports

- The implemented risk-rule set is limited to the IDs in [Risk engine](risk-engine.md).
- Findings do not automatically fail CLI runs unless an assertion requires their absence.
- Baselines, suppressions, risk-count policies, historical trends, and CI severity thresholds are not implemented.
- CLI recording files are versioned; not every trace/report/snapshot envelope has a stable public format version.
- Redaction is bounded and cannot recognize every confidential value.

## Security isolation

- Offline controls cover supported DisRunner paths and the Electron renderer; they do not sandbox arbitrary bot/plugin/dependency/child-process code.
- A selected bot can independently access the filesystem, network, native modules, subprocesses, and credentials available to the current OS user.
- A blind same-user process can race the released bot-owned dynamic port and deny startup, but cannot produce an accepted PING/command response without the per-run peer secret. A same-user compromise able to inspect process environment/memory, inject code, or control the child can still observe or interfere with loopback traffic and process state.
- Signing/checksums/provenance establish specific artifact facts; they do not prove absence of vulnerabilities.

Use a disposable VM/container or OS firewall/sandbox for untrusted code. Never provide a production bot token.

## Out of scope

- User-account/self-bot automation.
- Pixel-perfect proprietary Discord client reproduction or proprietary assets.
- Voice transport, encryption, audio, and media-quality simulation.
- Full CDN, regional infrastructure, anti-abuse, and undocumented-client parity.
- A guarantee that simulation predicts every production outcome.

The deterministic engine controls its own state for fixed inputs. Imported code can still read wall time/randomness, race threads/processes, contact databases, or change external files. Use DisRunner alongside unit/contract tests, controlled staging where policy permits, least privilege, rollback, and production monitoring.
