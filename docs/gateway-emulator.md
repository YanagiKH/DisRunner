# Gateway emulator

DisRunner v0.1 contains a partial Discord-shaped Gateway core and loopback WebSocket transport. It is primarily a core/contract-test surface; it is not yet a supported imported-bot desktop adapter.

## Implemented core subset

The in-process model covers:

1. `HELLO` with a configured heartbeat interval;
2. synthetic-token `IDENTIFY` and requested/allowed intent validation;
3. heartbeat and `HEARTBEAT_ACK`;
4. `READY`, session ID, sequence numbers, and bounded replay history;
5. programmatic dispatch with monotonically increasing sequence numbers;
6. disconnect/invalidate and accepted/rejected `RESUME` with replay/`RESUMED`;
7. explicit `RECONNECT` and `INVALID_SESSION` packets from the core API.

The local WebSocket server exposes selected identify/heartbeat/resume behavior and records core trace spans. v0.1 does not declare URL encoding/compression negotiation, full close-code/zombie behavior, proactive failure packets, or a complete production-client reconnect path.

Electron starts the local Gateway service, but it does not bootstrap the renderer's synthetic guilds, dispatch UI actions, or emit REST mutations over Gateway. A connected socket is therefore not proof of a complete virtual Discord session.

## Replay capacity

Replay retention is bounded by packet count and encoded size. Defaults allow at most 1,000 retained packets and 16 MiB per session, 1 MiB for one UTF-8 JSON dispatch packet, and 64 MiB across all sessions. Callers can lower those limits with `replayLimit`, `maxDispatchBytes`, `maxReplayBytesPerSession`, and `maxTotalReplayBytes`.

An oversized or non-JSON dispatch is rejected before its sequence advances. Event names are limited to 256 encoded JSON bytes. Retained data accepts finite JSON primitives, dense plain arrays, and plain objects; special JavaScript containers, accessors, symbol keys, cycles/shared references, more than 32 nested levels, and more than 100,000 nodes are rejected instead of being undercounted. Strings, keys, primitives, and container syntax consume the packet budget while the safe clone is built, so an oversized value is stopped before a complete serialized copy is allocated. When a session exceeds its count or byte budget, the oldest retained packets are evicted; resume from a sequence older than the remaining replay window is rejected. The cross-session budget fails closed instead of retaining more data.

## Intent filtering

The core can validate requested privileged intents against a supplied allowed set and map selected event names to required intents. Selected message events can have content-bearing fields stripped when `MESSAGE_CONTENT` is unavailable.

Desktop project `profile.intents` is parsed but not wired into the runtime Gateway session in v0.1. Intent decisions shown in most renderer panels are visual fixtures.

## Scenario controls

Version 1 scenarios can dispatch an event, disconnect the in-process session, resume it, and assert that resume occurred. There is no generic scenario policy for delay, missed heartbeat, drop, duplicate, reorder, partial payload, or burst delivery.

Those delivery faults, idempotency checks, and a real imported-bot reconnect/resume E2E remain roadmap work. See [Fault injection status](fault-injection.md).

## Sharding and findings

Shard routing, identify concurrency, per-shard failure/latency, and cross-shard metrics are not implemented as a supported v0.1 profile.

The Gateway core does not currently emit the broad intent/reconnect/idempotency risk catalog previously proposed for this project. Scenarios can assert delivered events and `gateway-resumed`; implemented risk IDs are listed in [Risk engine](risk-engine.md).
