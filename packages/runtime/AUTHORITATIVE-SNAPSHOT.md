# Retained runtime state snapshots

SessionSnapshot.coreState projects the actual VirtualState
created for the current bot run. The runtime retains that state and its realtime
clock, rather than rebuilding renderer state from configuration fixtures.

The optional v1 field is always emitted by the current runtime. An absent field
(from older clients), or null, means unavailable, never revision zero.

The projection has schemaVersion 1, runId, stateRevision, revisioned, clock,
resources, totalResources and truncated. SessionSnapshot.revision remains a
publication sequence (including output/lifecycle updates); it is never a state
revision. The clock is labeled bot/realtime and no timer acceleration is exposed.
The runtime passes the same runId with clockDomain realtime to LocalRestEmulator's
messageDomain context.

The revision-aware state adapter consumes revisionedSnapshot() atomically and
subscribeCommits(listener). When either API is absent, the actual snapshot is
still available but revisioned is false and stateRevision is null. This is an
explicit compatibility state, not revision-qualified M2 evidence. The State
revision getter belongs to core; runtime does not synthesize a revision counter.

Snapshots use an explicit guild/channel/user/message display-field allowlist,
including only id/username/global_name/bot in nested message authors. Arbitrary
fixture fields, metadata, embeds, components, attachments and unsupported resource
kinds are omitted. The source store is not modified. Snapshots are detached, sanitized using this run's secret redaction context, and
limited to 1,000 resources / 1 MiB of serialized resource-array data. Omitted resource kinds and count/byte truncation
set truncated; clients must not treat a truncated projection as complete. Raw
store hashes and raw commits are not exported. Invalid revisions, failed
sanitization, or invalid clocks return null instead of falling back to raw data.
This is a local diagnostic view, not a multi-user visibility or ephemeral-message filter.

Message resources keep their type: ordinary and followup messages are type 0 and
interaction originals are type 20. An interaction message is included only when its
core record is consistent (interaction origin, matching kind and type, interaction ID,
application ID equal to webhook ID, matching channel and guild, bot author). This is
a data consistency check, not proof of origin. Ephemeral, loading and deleted messages
are excluded. Context-bound chat-input invocations use the chat-input message profile
with the same runId as the REST emulator; see [Interaction engine](../../docs/interaction-engine.md).

Commit notifications republish the Session snapshot. Subscription generations
and runtime ownership guards reject obsolete callbacks. Stop suppresses updates;
failed resource closure retains state, clock, subscription and sanitizer so a
retry still owns the original run. Only confirmed cleanup releases them. A failed
unsubscribe also retains ownership, blocks restart and permits cleanup retry.

## Test boundaries

The authoritative-snapshot.test.mjs contract double isolates ownership and projection
behavior. authoritative-lifecycle.test.mjs checks real Session cleanup and restart.
The authoritative-message-pipeline.test.mjs suite requires revisioned State and uses
a real BotRunner with a capture-only credential wrapper and local REST/WebSocket
transport. It correlates CRUD and disconnected replay with domain evidence, checks
published snapshot records, rejected-input atomicity, cleanup retry and restart
isolation. Test definitions are not evidence of successful execution.

The pipeline tests preserve original role fixtures and require truncated:true plus
expected guild/channel/user/message projections. Role resources remain in the actual
store; only the diagnostic DTO omits them. This explicitly prevents an incomplete
projection being mistaken for a full-state export. These tests do not establish role
or permission evaluation, SDK handler delivery, UI integration, scenario mutation
integration, or host-timer control.
