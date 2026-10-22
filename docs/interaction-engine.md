# Interaction engine

DisRunner v0.1 provides a generic core interaction lifecycle and one narrow Electron raw-webhook `/ping` path. It does not provide a complete command/context/component/modal/autocomplete profile.

## Core lifecycle subset

The in-process engine stores an interaction ID, synthetic token, caller-supplied type/data, receive time, initial deadline, token expiry, response, and follow-ups. It supports:

- one initial `message`, `defer`, `update`, `defer-update`, `autocomplete`, or `modal` response where the basic type transition permits it;
- immediate/deferred/responded/deleted/expired state;
- create/edit/delete follow-up records;
- edit/delete original response;
- ephemeral flag recognition from response data;
- double-response, follow-up-before-acknowledgement, timeout, and expired-token errors/findings.

The core does not fully validate command definitions, installation contexts, resolved options, component authorization/staleness, modal field catalogs, visibility transitions, or every Discord callback restriction.

## Capacity limits

The in-process engine defaults to 10,000 retained interactions, 1,000 retained follow-ups per interaction, 1 MiB for each interaction/response/follow-up data object, 8 MiB of serialized data per interaction, and 64 MiB across the engine. Payloads must be dense, data-only JSON objects with finite numbers and may contain at most 10,000 nodes and 32 nesting levels. Sparse arrays, custom or symbol properties, accessors, `toJSON`, cycles/shared references, and non-JSON containers are rejected before retention. IDs and type labels are UTF-8 byte bounded, and duplicate interaction tokens are rejected.

When an interaction count or global byte limit is full, expired entries are reclaimed oldest-first before a new interaction is accepted. If active entries still fill the configured capacity, or if a payload, follow-up, per-interaction, or global byte limit is exceeded, the operation fails before changing the lifecycle state. Byte accounting uses the engine's serialized retained representation, including keys and JSON syntax. The limits are configurable through `InteractionEngineOptions`; they bound simulator retention rather than claiming undocumented Discord server quotas.

## Timing state machine

```text
received
  ├─ no initial response before 3,000 ms → expired/error
  ├─ immediate response → responded
  └─ deferred response → deferred → edit/follow-up
                               └─ token expires at 900,000 ms
```

Core/CLI scenarios evaluate this using virtual time. Electron's raw-webhook invocation instead uses a 3-second host-time abort and does not expose a controllable 15-minute token lifecycle.

## Raw webhook path

The bundled example receives a signed local HTTP request and verifies the raw body, Ed25519 signature, timestamp freshness, replay, and body size. A separate protected 32-byte secret authenticates each accepted HTTP response back to Electron. The HMAC covers a versioned domain, the request timestamp, HTTP status, request digest, and exact response digest; Electron verifies it on bounded bytes before status checks, JSON parsing, or callback validation. Electron uses this mutually authenticated transport for PING readiness and real local command payloads. The v0.1 acceptance behavior is `/ping`.

This does not imply that Gateway-delivered interactions and REST callbacks are connected end to end in the desktop, or that user/message commands, autocomplete, components, and modal submissions can be composed from the UI.

## Chat-input message profile

`chat-input-messages-v1` is an opt-in profile for chat-input commands that are created with a context (`engine.create({ ..., messageProfile: 'chat-input-messages-v1' })`). The engine needs a `messageAuthority` (`state`, `gateway`, `author`, `context`), and its application ID must equal the Gateway application ID. Interactions created without the profile keep the model behavior described above. The shared runtime selects the profile for its context-bound chat-input invocations; its contextless path stays model-only.

### Routes

| Route                                                    | Methods            | Result                                     |
| -------------------------------------------------------- | ------------------ | ------------------------------------------ |
| `/interactions/{id}/{token}/callback`                    | POST               | `204`, or `200` with `?with_response=true` |
| `/webhooks/{applicationId}/{token}`                      | POST               | `200` with the followup Message body       |
| `/webhooks/{applicationId}/{token}/messages/@original`   | GET, PATCH, DELETE | `200` Message body, or `204` for DELETE    |
| `/webhooks/{applicationId}/{token}/messages/{messageId}` | GET, PATCH, DELETE | `200` Message body, or `204` for DELETE    |

Callback types 4 (message), 5 (defer) and 9 (modal) are accepted. An original is a type 20 Message and a followup is a type 0 Message; both carry `application_id` and `webhook_id`. The followup body has `content` at the top level and no `data` wrapper. The only accepted query on the callback is `with_response=true` or `with_response=false`. With `true`, the body is `{ interaction: { id, type: 2, response_message_id, response_message_loading, response_message_ephemeral }, resource: { type: 4, message } }`; a deferred response has no `resource`, and a modal response returns only `{ interaction: { id, type: 2 } }`.

### Check order and errors

Each request is checked in this order: identity and expiry, then quota, then the bounded body or query parse, then profile, payload and ownership validation.

- Callback route with an unknown interaction, a wrong token or an expired interaction: `404` / `10062`.
- Webhook routes with a wrong application, a wrong token or an expired token: `404` / `10015`. These are rejected before the body is read and before any quota is spent, and the lookup does not change the interaction.
- A token with invalid percent-encoding: `400` / `50035`, before quota.
- A body that is not valid JSON, including an empty body: `400` with the fixed text `Invalid JSON body.`
- Callback `data` that is present but not an object (for example `null`, `[]` or `'x'`), or a wrapper, body or payload that does not match the profile: `400` / `50035` with `Invalid interaction message payload.`
- A message callback with `data` omitted (for example `{ "type": 4 }`) is an empty message: `400` / `50006`.
- None of these rejections acknowledges the interaction, changes state or adds an evidence record. Diagnostics never echo submitted values or exception text.
- An unknown or already deleted original or followup: `404` / `10008`.
- GET, PATCH and DELETE on `@original` or `/messages/{messageId}` for a model-only interaction: `501` / `0` with the fixed text `This interaction does not support message routes.` This answer comes at the validation step, so it uses quota.

These routes are token routes and need no bot `Authorization` header.

### Rate-limit buckets

The bucket path is the verified application ID and token plus the recognized suffix: `/webhooks/{applicationId}/{token}/messages/@original` or `/webhooks/{applicationId}/{token}/messages/:messageId`. The message ID is not a major parameter, so all followup items of one interaction share a bucket. Rules for the bare `/webhooks/:webhookId/:token` route do not cover these suffixes; each suffix needs its own rule. This is not full Discord quota parity.

### Headers

Only a committed public message mutation carries `X-DisRunner-State-Revision`, `X-DisRunner-Delivery` (`accepted` or `partial`), `X-DisRunner-Delivery-Failures` and `X-DisRunner-Event-Id`, with the same names as the ordinary channel message routes. Ephemeral, loading-only, modal, no-op and rejected requests carry no event or delivery headers. No header contains the interaction token.

### Message evidence

`rest.messageEvidence()` returns `{ records, dropped }` for one state and run ID. Records from ordinary channel routes (`origin: 'rest'`) and from interaction messages (`origin: 'interaction'`) share one ordered list and one increasing sequence when the REST emulator and the engine use the same state and the same `context.runId`. Interaction records use the owning interaction ID as `correlationId` and a separate command ID as `causationId`. Ephemeral, loading-only, modal, no-op and rejected operations add no record and use no sequence number.

Each run keeps at most 100 records and 1,048,576 bytes. The oldest records are removed first and counted in `dropped`; sequence numbers continue and are never reset. A state accepts at most 128 run IDs; a public commit under another run ID fails with `503` / `0` before anything is committed.

A Gateway delivery failure does not undo a committed message: the response is still `200` with `X-DisRunner-Delivery: partial`, and the record keeps the partial delivery counts without the failure text.

### Runtime and desktop projection

`SessionSnapshot.coreState.resources` keeps a public original as type 20 and a public followup as type 0. An interaction message is projected only when its core record is consistent: interaction origin, a kind that matches its type, an interaction ID, an application ID equal to the webhook ID, matching channel and guild, and a bot author. This is a data consistency check on local records, not proof of where a message came from. Ephemeral (flag 64), loading (flag 128) and deleted messages are not projected, and the projection adds no origin field.

The desktop live feed shows type 0 and type 20 messages with flags 0, 4, 4096 or 4100 for the selected context. Its status line reads: Public interaction responses appear once posted; raw callback data, responses still loading and ephemeral responses are not shown.

## Planned profiles

Complete chat-input/user/message/entry-point command definitions, install/context rules, option/localization bounds, autocomplete choices/order, component layouts/click authorization, modal fields/expiry, and Components V2 semantics are roadmap items. Static Command Explorer and inspector examples are design fixtures, not registration discovery or protocol evidence.

Implemented interaction finding IDs and their actual fields are documented in [Risk engine](risk-engine.md).
