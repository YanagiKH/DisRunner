# ADR-0001: One shared session runtime for real Bot execution

Status: proposed, not accepted or implemented. Scope: M0-01 design supporting M1. Identity: DisRunner main `9f57ab6c8f9688513b880ccb283f8365b45be681`; roadmap SHA256 `560ea8156d4b2b38656d1f38ee852aeb2db4188d4fdd51edef2ec1ea4b370739`, sections 5.1–5.6 and M1. The [requirements/evidence index](./requirements-evidence-index.md) defines promotion rules.

## Problem

The current documented raw Desktop `/ping` path is narrower than the in-process simulation model. Existing CLI model scenarios do not launch the user's Bot. UI preview state, transport state and engine state must not become competing authorities. Reimplementing the orchestration separately in CLI and Desktop would preserve this gap and weaken lifecycle and evidence consistency.

## Proposed decision

Preserve TypeScript, pnpm, Electron and React. Introduce an Electron-free `packages/runtime` containing project loading, `SimulationSession`, adapter hosting, cancellation, lifecycle and scenario orchestration. CLI and Desktop each instantiate the same implementation, rather than requiring one application process to host the other.

- `packages/core` owns domain commands, rules, state, clock and projections. It must not depend on Electron, React or a Python runtime.
- New `packages/contracts` owns versioned runtime schemas/types for project, fixtures, scenarios, events and reports, with generated JSON Schema. Do not maintain mutually drifting validators.
- New adapter packages own raw signed transport/peer-auth, pinned discord.js bootstrap and pinned discord.py bridge. SDK/runtime pins remain M0 spike decisions. No package names here imply an existing public SDK.
- Electron retains windows, dialogs, IPC sender validation and a runtime bridge. Renderer stores only selections/drafts plus session projections. CLI owns presentation and exit mapping, not alternate simulation semantics.
- Preserve current redaction, synthetic credentials, peer authentication, limits and path checks throughout extraction. The raw response HMAC bridge is a DisRunner integration contract, not a claim about Discord's native protocol.

## Session and domain contract

One active run per executor; CLI batch is sequential in v1. Different processes still isolate workspace, port and run ID. A session owns identity, state, interaction registry, rate buckets, clock, Gateway sessions, trace, fault policy and Bot lifecycle.

Capture request ID, actor, guild and channel when invoking. Never select the first fixture implicitly or consult the renderer's later selection when a response arrives. For every mutation: validate source/session/capability/payload; enforce route-specific authentication, limits and permission ordering; validate relationships; mutate transactionally; commit state revision and events; project the committed result to REST/Gateway/UI/scenario observers. Failed commands cannot publish success or leave partial state. Ephemeral messages may share the authoritative store but must not leak through general Gateway broadcasts or another actor's projection.

Event envelopes carry schemaVersion, runId, eventId, sequence, stateRevision, correlationId, causationId, origin, clockDomain, timestamp and payload. Never include authentication tokens. Renderer subscribes to revisioned deltas and obtains a new snapshot after gaps/reconnects. Resource IDs and retry/replay IDs have distinct roles. PATCH distinguishes omitted, cleared and changed fields; deletion is not undone by editing.

## Time, replay and execution truth

- `model` uses controlled virtual time and seed. Its success is model evidence only.
- `bot` uses real processes and loopback I/O, monotonic deadlines and an independent host watchdog. It never supplies synthetic successful responses on behalf of an absent Bot.
- Controlled Bot clock is unsupported unless a particular adapter explicitly passes a clock contract.
- Trace playback executes no Bot; model replay tests controlled deterministic state; Bot rerun compares declared semantic assertions. Arbitrary Bot host timers, randomness and side effects are not claimed bitwise deterministic.
- Local timing profile boundaries remain explicit: initial response accepted at 2,999 ms and rejected at 3,000 ms; token valid at 899,999 ms and expired at 900,000 ms. This is a simulator profile, not a real-network precision guarantee.

## Adapter lifecycle and failure

Versioned lifecycle: validateProject → prepare → start → waitReady → dispatch/observe → stop → dispose. Preparation diagnoses missing preinstalled dependencies and runtime paths; it does not implicitly execute arbitrary package installation scripts. Readiness must be observable, not a fixed sleep or process-alive proxy. Stop/dispose must be idempotent and work after partial startup, crash, timeout and cancellation; cleanup is bounded and covers child processes, listeners and ports.

Keep failed assertions, invalid input, runner errors, cancellation and incomplete evidence separate from success. A risk finding fails only under a declared policy; it must never replace actual assertions or disguise absent execution. Reports carry execution mode, exact adapter/runtime pins, identity and completeness counters.

## Offline and security boundary

The product targets Discord-independent operation after dependencies are prepared. Endpoints are loopback with synthetic identities, with no fallback to real Discord. SDK transport spikes must prove REST and Gateway redirection and rejection of unintended endpoints. Do not accept production tokens in normal operation. This is not a general operating-system sandbox: arbitrary Bot code may access host files, subprocesses or network unless separately constrained. Do not advertise containment based solely on loopback transport configuration.

## Incremental implementation and acceptance

1. Freeze contracts and transport spikes; extract raw orchestration without relaxing peer-auth or IPC protections. Keep existing tests and failure evidence.
2. Add a headless raw session API used by both applications. Same project, fixture and minimal scenario must observe the real Bot response in both CLI and Desktop.
3. Positive `/ping` passes; wrong reply, missing reply, unstarted Bot and early crash do not pass. Changing Bot code changes the result. Assert `execution: bot` and actual launch/transport observations.
4. Validate failure/abort/timeout cleanup and 20 consecutive start/stop cycles without residual processes/listeners. A shared API or successful compilation alone does not close G1.
5. Extend pinned JS first, then Python using the same applicable conformance corpus. A required Python gap keeps release beta. Package exports, build order and packaged dependency inclusion are verified, not merely monorepo resolution.

## Alternatives and consequences

Rejected: separate CLI/Desktop orchestrators (divergent semantics); renderer-owned domain state (stale context and false evidence); full rewrite (discards useful protections); unconditional fake SDK responses (false compatibility). A shared runtime adds package boundaries and migration work but makes one lifecycle and evidence contract enforceable. Full protocol/SDK certification remains separate work; this ADR does not declare it achieved.

## Open decisions before acceptance

Exact SDK/language pins and bootstrap hooks; profile route/field limits; generated schema tool choice; dependency/build order; remaining full-v1 named owners; evidence storage conventions. Persistent formats should start as bounded versioned JSON/YAML/NDJSON with atomic save and backup, not an unnecessary native database dependency. Each open decision needs reviewed evidence rather than an invented version or placeholder success.
