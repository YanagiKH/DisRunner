# Ordinary channel message lifecycle

## Scope and architecture

This document covers ordinary channel-message creation, editing and deletion. It
does not describe the complete M2 roadmap or v1.0 release requirements.

Architecture and test oracles:

1. One explicit ordinary-message service validates bot identity, channel context,
   message ownership and mutable fields, then commits through a synchronous outer
   state transaction. Handwritten expected resource fields and revisions are the
   oracle; no tested mapper generates expected wire objects.
2. An explicit deep projection creates MESSAGE_CREATE/UPDATE/DELETE payloads;
   generic store mutations never trigger wire events. Real HTTP and WebSocket
   clients observe the same resource identifiers and context.
3. Advisory Gateway preflight simulates combined bounded replay capacity. After
   commit, current eligible sessions receive intent-filtered, independently
   retained dispatches. Disconnect/mutate/resume tests expect exactly one replay.
4. Runtime retains its actual store and realtime clock. Its bounded sanitized
   snapshot revision is separate from Session publication revision. Independent
   state-contract tests and real lifecycle tests cover stale callbacks, failed
   cleanup retention, retry and fresh-run identity.

## Authority and deliberately narrow profile

POST/PATCH/DELETE use the same service. REST authentication, rate-limit acquisition,
body limits and store capacity checks remain in their original order. Actor identity
comes from the validated bootstrap profile matching Gateway.botUserId, or the state
user with that exact ID. No first-bot heuristic or payload author is accepted.
Only the authenticated bot's own messages can be edited/deleted. Full permission,
member overwrite and moderation-delete semantics are deferred, not certified here.

Channels must explicitly be guild text (`type: 0`, existing guild) or DM (`type: 1`,
no guild ID). Unknown channel contexts fail closed. DM recipient membership and the
full Discord authorization matrix are outside this single-bot profile.

Mutable request fields are content, embeds, components, attachments, flags and tts.
IDs, author, channel/guild and timestamps cannot be supplied by the caller. Supported
ordinary flags are 0, 4, 4096 and 4100; ephemeral and unknown flags are rejected.
Unknown nested request fields are rejected rather than silently stored. Legacy
components use a bounded explicit projection. This does not certify uploads/CDN,
Components V2, interactions or every Discord message option.

Omitted PATCH fields are preserved; empty strings/arrays clear their fields; null
content follows the existing strict validator rejection. A payload-equivalent PATCH
is a no-op: no timestamp update, revision, domain sequence or Gateway event. Delete
cannot be followed by edit resurrection. Stored unknown/private visibility cannot
be mutated on these routes. GET/list omit private and unknown visibility; message
responses and Gateway use the same deep wire allowlist, without internal visibility,
resourceType or arbitrary fixture metadata. Explicitly visible fixture messages may
be read; mutation still checks bot ownership and authoritative context.

## Required state contract

Required state API: revision (safe nonnegative integer) and transactionActive
(boolean) getters, with synchronous atomic transactions. Runtime additionally uses
revisionedSnapshot() and subscribeCommits(). Missing API rejects ordinary message
mutation with a diagnostic 503; no fake local state revision or legacy bypass exists.
An already active outer transaction is rejected before mutation, even if its caller
catches the rejection. A shared per-store busy guard spans validation, transaction,
commit observers, event fanout and evidence recording, rejecting reentrant commands.

The state store must reject mutation from commit observers and notify them only
after commit. Tests of the complete State/REST/Gateway/runtime path are required;
a state-contract double alone cannot establish end-to-end behavior.

## Commit versus delivery failure policy

Preflight is advisory validation, NOT a reserved audience or cross-component atomic
commit. It checks normalized data, per-session sequence/intent/packet limits and
combined replay-byte budget with eviction simulation. It changes neither retained
history nor sequences. Validation failure inside the state transaction rolls back
without an event. The projected payload is detached before commit.

After commit, fanout uses currently eligible sessions: commit observers can change
the audience or capacity. Each recipient failure is isolated and later recipients
are attempted. `accepted` means retained in replay history, never peer receipt;
`filtered` is intentional intent suppression. `transportFailed` is separately counted.
Disconnected sessions can accept backlog without having a live socket. No automatic
retry or rollback occurs after a successful state mutation.

A postcommit fanout failure returns the committed resource (or DELETE 204), never a
retryable mutation error. Local diagnostic response headers X-DisRunner-State-Revision,
X-DisRunner-Event-Id, X-DisRunner-Delivery and X-DisRunner-Delivery-Failures distinguish
partial dispatch. These are DisRunner extensions, not Discord compatibility claims.
Socket enqueue success does not establish delivery; later asynchronous socket failure
requires resume semantics, not a claim of receipt.

Domain evidence has schemaVersion/runId/eventId/sequence/stateRevision/correlationId/
causationId/origin/clockDomain/timestamp/payload. Only implemented origin `rest` is
emitted. Request and event IDs differ from Discord resource IDs. REST trace completion
records event ID/revision/delivery diagnostic linkage. Authentication values are not
passed into envelopes. Evidence uses an explicit deep message projection and redacts
known synthetic credentials. At most 100 records and 1 MiB are retained, with dropped
count; this is incomplete bounded evidence, not durable event sourcing.

## Test coverage and limitations

The ordinary-message integration suite constructs real VirtualState and subscribes
to commit notifications. It checks CRUD identity/context, wrong channel/token/author,
protected fields, visibility, guild/DM intent audiences, no-op, preflight rollback,
reentry, caller-owned transactions, audience changes, partial dispatch, resume once,
fixture metadata exclusion and bounded redacted evidence. Expected wire fields are
handwritten rather than generated by the production mapper.

The runtime pipeline suite uses real Session, BotRunner, REST and WebSocket resources.
It compares published snapshot records and revision metadata with HTTP responses and
domain evidence, and independently checks socket, listening-port and child-process cleanup.
Contract-double tests separately isolate snapshot ownership and sanitization; they
are not a substitute for the real-state transport tests. Test definitions describe
expected behavior, not successful execution or release qualification.

REST auth/rate-limit fixtures supply the exact authenticated bot user and required
guild. Sparse ScenarioRunner fixtures use a separate legacy path, not this service.
Scenario integration, SDK handler delivery, GUI integration, full role/permission
semantics and complete M2 conformance remain outside this profile.
