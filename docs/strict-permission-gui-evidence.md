# Strict ordinary-message packaged evidence

The G1 packaged harness now includes a separate opt-in permission matrix after all
legacy controls. This is test infrastructure, not an assertion that an unexecuted
candidate has passed GUI qualification or complete parity.

Three explicit project configurations select `guild-text-own-messages-v1`. Each
loads a human invocation actor, a distinct bot, bot and human members, guild roles,
and channel overwrites. The bot is not the guild owner. The allow project grants
VIEW_CHANNEL, SEND_MESSAGES and READ_MESSAGE_HISTORY. The negative projects deny
SEND_MESSAGES or VIEW_CHANNEL using an explicit bot-role channel overwrite.

The existing project picker and Start action launch a real child. It authenticates
ordinary HTTP operations using the Session-issued credential held only in memory.
The allow case verifies create/edit/delete statuses, stable message identity, bot
author rather than human invoker, distinct event headers, exact core revision
increments, retained resource contents, and renderer updates. Interaction callbacks
remain separate ephemeral diagnostics. These callbacks also commit hidden core
resources: the harness observes the callback's exact one-step revision and
unchanged ordinary rows first, then records the ordinary-operation baseline.
A test-only filesystem permit tied to the authenticated interaction ID and
operation releases the real child's HTTP request. Stale permits cannot release a
new interaction or run. Callback snapshots are retained separately; callback
revisions are not counted as ordinary-message mutation revisions. Denials require literal 403/50013 with
`Missing Permissions`, absent committed-event and revision headers, identical retained core
resources/revision and metadata (excluding advancing realtime clock readings), and no ordinary renderer row. Session publication revisions may
advance for diagnostics and are not core mutation revisions.

The public packaged seam does not expose the private commit dispatch bus. Absent
HTTP commit headers plus unchanged public core state are the observed denial
contract; these tests do not claim direct observation of internal dispatch counts.

Each project is stopped and started again. Every stop verifies direct-child death
and closure of all owned loopback ports. Every start requires a new run ID and no
retained messages. Completed traces are saved before the trace file is cleared for
a restart. This is not late successful old-run callback rejection evidence.

## Evidence and execution

Run the existing packaged G1 command only in an authorized display-equipped
validation environment with the exact built candidate. The harness hashes strict
fixtures and the independent oracle alongside source, build trees, package files,
and executable identity. Each operation saves before/after snapshots, screenshot,
DOM, HTTP-safe evidence, and hashes. First failures are retained. A fresh evidence
directory is mandatory; existing expectations are never overwritten.

Pure, non-GUI contracts can be checked with:

    node --test apps/desktop/tests/e2e/g1-strict-oracle.test.mjs

Syntax, pure helper tests and static checks do not prove packaged renderer
behavior. No local GUI execution, hosted execution or publication is implied by
this change. Windows/macOS, complete parity, SDK support, viewer permission
filtering, editor UI and late-success stale callback qualification remain outside
this bounded matrix.
