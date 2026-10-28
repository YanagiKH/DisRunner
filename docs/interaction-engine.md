# Interaction engine

The interaction engine supplies the shared state and lifecycle for raw-webhook and supported SDK sessions. The `interactions-v1` profile handles the declared command, component, autocomplete, and text-input modal subset; earlier model and chat-input profiles remain available for compatibility.

## Core lifecycle subset

The in-process engine stores an interaction ID, synthetic token, caller-supplied type/data, receive time, initial deadline, token expiry, response, and follow-ups. It supports:

- one initial `message`, `defer`, `update`, `defer-update`, `autocomplete`, or `modal` response where the basic type transition permits it;
- immediate/deferred/responded/deleted/expired state;
- create/edit/delete follow-up records;
- edit/delete original response;
- ephemeral flag recognition from response data;
- double-response, follow-up-before-acknowledgement, timeout, and expired-token errors/findings.

The generic engine alone is not the command registry or action validator. In a real Session, the action driver adds registered command/option and resolved-resource checks, component availability, submitted modal-field validation, and actor context checks. User-installed application contexts and unlisted callback/control types remain unsupported.

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

Version 1 model scenarios evaluate this using virtual time. Raw/SDK Sessions use realtime, with a default 3-second dispatch timeout and bounded Scenario v2 action/await overrides. Their token expiry follows the realtime core clock; Desktop does not advance arbitrary Bot timers or expose virtual-time token travel.

## Raw webhook path

The bundled raw example receives a signed local HTTP request and verifies the raw body, Ed25519 signature, timestamp freshness, replay, and body size. A separate protected 32-byte secret authenticates each accepted response. The HMAC covers a versioned domain, request timestamp, HTTP status, request digest, and exact response digest; the shared runtime verifies bounded bytes before status checks, JSON parsing, or callback validation. This transport handles readiness and supported command, autocomplete, component, and modal payloads.

Pinned SDK sessions instead deliver interactions through the local Gateway and accept actual SDK callbacks on the shared REST routes. Command Explorer, message controls, and modal dialogs use that path. Both adapters commit supported original/followup changes to the same retained state; they do not provide unlisted Discord interaction types.

## Chat-input message profile

`chat-input-messages-v1` is the legacy opt-in profile for chat-input commands created with a context (`engine.create({ ..., messageProfile: 'chat-input-messages-v1' })`). The engine needs a `messageAuthority` (`state`, `gateway`, `author`, `context`), and its application ID must equal the Gateway application ID. Raw `Session.invoke` selects this compatibility profile when the project uses an earlier registry profile or no registry; contextless calls retain model behavior. Raw projects with `command-registry-v2`, structured Session actions and Scenario v2 use `interactions-v1` below. The following narrow callback/query rules describe the legacy profile.

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

These are the legacy public projection rules. The current Desktop actor view additionally supports the richer `interactions-v1` records described below, including that actor's ephemeral replies. Callback diagnostics and retained conversation messages remain separate observations.

## Shared runtime interaction profile

`interactions-v1` uses the same authoritative message model for slash/context commands, legacy components, autocomplete, and modal submissions. It binds actor/channel/guild context, validates applicable callback kinds, and preserves original/followup identity through fetch, partial edit, and deletion. A deferred original is completed by edit or the documented first-followup behavior; editing a deleted response does not recreate it.

Public snapshots omit ephemeral messages and DMs. `snapshotForActor(actorId)` includes only that actor's private responses and recipient DMs; enforcing profiles also filter guild channels/messages by VIEW_CHANNEL. Private replies do not become guild Gateway broadcasts. Desktop uses the selected actor, while callback diagnostics retain their initiating request context. The earlier public-only projection remains available through the public snapshot API.

## Unsupported extensions

Full user-installed/entry-point command contexts, new modal controls, Components V2, and unlisted callback/resource fields remain outside the local profile. Command Explorer reads current command registration. The action driver validates registered options, resolved resources, component state, and submitted modal fields before dispatching to the actual Bot.

Implemented interaction finding IDs and their actual fields are documented in [Risk engine](risk-engine.md).
