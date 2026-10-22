# Authoritative interaction messages

The opt-in `chat-input-messages-v1` profile stores chat-input original and followup
messages in the same `VirtualState` namespace as ordinary channel messages. It
covers callback 4 and 5 and token-owned original/followup creation, reading,
editing, and deletion. It is a deliberately restricted local profile, not full
Discord API, SDK, component-execution, upload, or role-permission compatibility.

## Selection and identity

Direct `InteractionEngine` callers remain in the legacy `model` profile unless
creation explicitly selects `messageProfile: 'chat-input-messages-v1'`. Configure
`messageAuthority` with the shared state, Gateway, authenticated bot author, and
message-domain run context. The application ID must match the Gateway application;
the author must match the Gateway bot. Keep those same state and Gateway instances
in the REST stack. Missing authority never silently falls back to model behavior.

An authoritative interaction requires a chat-input command (`type: 'command'`,
`data.type: 1`) and copied canonical actor/channel context, with an optional guild
ID. The actor and explicit text/DM channel must exist, and guild association must
match. This is resource-context validation, not complete permission validation.
The profile cannot change after creation. Component authority is not enabled.

`executeMessage` returns a detached interaction and full message record, actual
state revision, and optional public event/delivery metadata. Deletion returns the
pre-delete message; a legal non-message callback returns `message: null`. The
existing lifecycle convenience methods delegate to this same command path for
authoritative interactions while retaining their legacy return shapes.

The new `getOriginalMessage` and `getFollowupMessage` readers enforce lifetime and
ownership. New message APIs reject model interactions with 501/code 0 rather than
fabricating state resources. Existing model callback/followup behavior is unchanged.

## Lifecycle

- Callback 4 acknowledges and creates one original, type 20, in one logical commit.
- Callback 5 acknowledges and creates a stable original loading record, including
  flag 128 and its captured visibility. It is token-readable but not public.
- The first original edit or first followup after defer materializes that same ID.
  The first followup does not create a separate followup reference. Materialization
  removes flag 128 and must contain nonempty content, embeds, or components.
- A first-followup materialization accepts create-only `tts` and flag 4096 while
  retaining deferred visibility. Original PATCH still accepts only PATCH fields.
- Later followups are independent type-0 messages. Each request chooses its own
  visibility, independently of the original; visibility cannot subsequently change.
- A legal modal ACK creates no original. A later followup creates a followup, not
  an original. Original operations return 404/code 10008.
- Deleted references cannot be fetched, edited, or resurrected. The original ID
  remains a tombstone. New followups remain allowed while the token is live.
- Token expiry and registry eviction do not delete committed state messages.
  Resource deletion, state capacity, and explicit state/run resets remain separate.

Legacy-shaped snapshots hydrate message data from current state rather than a
second retained body. Deleted authoritative message views have empty `data`.
Inspection and authentication reads derive expiry without altering authoritative
registry accounting. Explicit `sweepExpired` performs lifecycle refresh. Legacy
model refresh semantics are preserved.

## Payload subset

All inputs must be bounded plain JSON data. Unknown fields, accessors, proxies,
shared references, cycles, sparse arrays, and non-JSON values are rejected. Strings
use UTF-16 code-unit limits. No coercion or unsupported-key dropping occurs.

| Field              | Create                          | PATCH                                                                  |
| ------------------ | ------------------------------- | ---------------------------------------------------------------------- |
| `content`          | Optional string, maximum 2,000  | String replaces, null clears, omitted preserves                        |
| `embeds`           | 0–10 exact rich embeds          | Array replaces, null clears, omitted preserves                         |
| `components`       | 0–5 button action rows          | Array replaces, null clears, omitted preserves                         |
| `attachments`      | Empty array only                | Empty array or null clears                                             |
| `tts`              | Optional boolean, default false | Rejected                                                               |
| `flags`            | Only bits 4, 64, 4096           | Only bits 4 and 64, or null                                            |
| `allowed_mentions` | Exactly `{parse: []}`           | Same object or null; a content replacement drops an omitted old policy |

Create must have nonempty content, embeds, or components (400/code 50006 otherwise).
PATCH may clear the final content field. Payload-equivalent normalized PATCH is a
no-op: no timestamp, state revision, public sequence, or delivery change.

PATCH applies only mutable suppress-embeds bit 4. Supplied visibility-bit flips are
ignored; 64 and creation-only 4096 retain their original values. Null clears only
bit 4. Loading flag 128 is server-owned. Defer accepts absent/empty data or exactly
`{flags: 0}` / `{flags: 64}`.

Rich embeds accept only `type`, `title`, `description`, `url`, `timestamp`, `color`,
`footer`, `image`, `thumbnail`, `author`, and `fields`. Type defaults to `rich` and
cannot be another value. Limits are title 256, description 4,096, footer text 2,048,
author name 256, up to 25 fields with name 256/value 1,024, and combined text 6,000.
Text fields are nonempty. Color is an integer 0–16,777,215. Timestamp must round-trip
as exact `YYYY-MM-DDTHH:mm:ss.sssZ` UTC ISO. A text field, nonempty fields, image, or
thumbnail is required; styling alone is insufficient.

Nested shapes are exact: footer `{text, icon_url?}`, author `{name, url?, icon_url?}`,
image/thumbnail `{url}`, and field `{name, value, inline?}` with optional boolean
inline. Provider, video, dimensions, proxy URLs, and other keys are not writable.
URLs are absolute HTTP(S), maximum 2,048, with hostname and no whitespace, controls,
or username/password. URL validation never fetches a URL or guarantees its safety.

Rows are exactly `{type: 1, components: [...]}` with 1–5 buttons. Buttons are exactly
`{type: 2, style, label, disabled?, custom_id?, url?}`. Styles 1–4 require custom IDs
of length 1–100, unique across the message, and forbid URLs. Style 5 requires an
HTTP(S) URL of at most **512**, separately from the embed URL limit, and forbids a
custom ID. Labels have length 1–80 and disabled is boolean. Emoji, select menus,
text inputs, premium buttons, and Components V2 are unsupported.

Authoritative schema errors use fixed value-free diagnostics and code 50035. They
do not reflect submitted keys, custom IDs, URLs, fragments, or exception text.
Rejection cannot ACK, mutate messages, evict registry entries, or consume public
sequence numbers. Transport adapters must also reject malformed callback wrappers
and JSON without reflecting private input.

## Atomicity, events, and privacy

A shared per-state command guard spans validation, the outer synchronous state
transaction, commit observers, and fanout. Both message domains use one sequence
per state/run. Reentrant message commands and engine lifecycle mutations are
rejected; passive reads during notification remain detached and nonrefreshing.
ACK/reference/accounting candidates are installed before commit notifications.
Transaction-finalization failure restores registry/accounting alongside state
rollback, including any planned expired-entry eviction. No generic state hook is
required. Consumed IDs may have gaps after rejection.

Only committed public events advance sequence. Immediate public originals and
first public materialization emit MESSAGE_CREATE; later edits emit MESSAGE_UPDATE;
public deletion emits MESSAGE_DELETE. Private/loading-only operations may advance
state revision without a public event. Loading deletion has no public event.
No-op edits have null event/delivery fields. Non-message ACKs can change lifecycle
without changing state revision.

Gateway delivery failure after commit produces partial-delivery metadata, never a
retryable mutation error or state rollback. Event origin is `interaction`, correlation
is the owning interaction ID, and causation is a distinct command ID. Tokens are
never event identities. Ordinary events retain origin `rest`. Existing message evidence readers share the
bounded state/run ledger for both origins, retaining at most 100 events and 1 MiB
per run. Evidence trimming never resets sequence numbers. A state admits at most
128 distinct run IDs that commit public events; a new run beyond that local limit
fails before commit with 503/code 0. Existing run handles remain valid. Use a fresh
state for a new runtime run rather than treating evidence eviction as run reset.

Stored provenance (`message_origin`, owning interaction, original/followup kind,
visibility, and private recipient) is internal. HTTP/Gateway output uses an explicit
message projection with application/webhook IDs, not a spread of the state record.
Public originals retain type 20; followups retain type 0. Ordinary bot-token mutation
rejects interaction-owned messages, including type-0 followups. Public messages may
still be read through ordinary channel reads. Ephemeral/loading records are not
public Gateway events or shared chat rows. Raw callback payloads alone are not rows.

## HTTP compatibility boundary

For the authoritative profile, followup POST returns a Message-shaped body:
`body.content`, not the legacy wrapper's `body.data.content`. Model POST routes
retain the wrapper. Callback POST remains 204 by default; authoritative
`with_response=true` returns an explicit callback envelope rather than an internal
interaction object. Original/followup GET/PATCH return Message bodies and DELETE
returns 204. New item routes reject model-only interactions with 501.

Transport authentication, quota ordering, query/body wrappers, token-family trace
redaction, shared-runtime construction, and bounded UI projection are adapter
responsibilities. This core capability alone does not certify those integrations.
