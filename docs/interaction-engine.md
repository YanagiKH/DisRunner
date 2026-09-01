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

The bundled example receives a signed local HTTP request and verifies the raw body, Ed25519 signature, timestamp freshness, replay, and body size. Electron performs a signed PING readiness request and can send a real local command payload. The v0.1 acceptance behavior is `/ping`.

This does not imply that Gateway-delivered interactions and REST callbacks are connected end to end in the desktop, or that user/message commands, autocomplete, components, and modal submissions can be composed from the UI.

## Planned profiles

Complete chat-input/user/message/entry-point command definitions, install/context rules, option/localization bounds, autocomplete choices/order, component layouts/click authorization, modal fields/expiry, and Components V2 semantics are roadmap items. Static Command Explorer and inspector examples are design fixtures, not registration discovery or protocol evidence.

Implemented interaction finding IDs and their actual fields are documented in [Risk engine](risk-engine.md).
