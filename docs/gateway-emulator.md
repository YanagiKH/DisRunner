# Gateway emulator

DisRunner provides a bounded API v10 JSON Gateway over loopback. The shared runtime uses it for the pinned JavaScript/Python SDK adapters and exposes the same state to Desktop and CLI.

## Implemented core subset

The in-process model covers:

1. `HELLO` with a configured heartbeat interval;
2. synthetic-token `IDENTIFY` and requested/allowed intent validation;
3. heartbeat and `HEARTBEAT_ACK`;
4. `READY`, session ID, sequence numbers, and bounded replay history;
5. programmatic dispatch with monotonically increasing sequence numbers;
6. disconnect/invalidate and accepted/rejected `RESUME` with replay/`RESUMED`;
7. explicit `RECONNECT` and `INVALID_SESSION` packets from the core API.

The local WebSocket server supports identify/heartbeat/resume, validates intent close codes, records trace spans, and enforces authenticated heartbeat deadlines. Single-shard JSON is supported; compression, large-guild chunking, presence, and voice are outside this profile.

When configured with the session bootstrap state, READY lists fixture guilds and GUILD_CREATE supplies their channels, roles, members, and Bot identity. Supported message and resource mutations publish the corresponding Gateway events after a state commit. Desktop actions and SDK REST requests use that same state.

## Bootstrap heartbeats before authentication

After HELLO, a client may send a heartbeat before IDENTIFY or RESUME. The loopback transport accepts `d: null` or a nonnegative safe integer and responds with exactly `{ "op": 11, "d": null }`. A prior connection's sequence is not compared against any session before authentication. Malformed sequences close with 4002.

This bootstrap ACK is transport-only: it does not authenticate, allocate or bind a session, emit dispatches, or reset/cancel the original identify timeout. Heartbeat-only connections still close with 4003 when that deadline expires. Rejected RESUME leaves the connection unauthenticated; subsequent valid bootstrap heartbeats may be ACKed without changing the rejection or granting session ownership. IDENTIFY token validation remains unchanged.

After successful IDENTIFY or RESUME, heartbeats continue through the session engine, including sequence validation and heartbeat-ACK fault injection. The engine's disabled-ACK fault setting does not suppress transport-only bootstrap ACKs. These protocol checks isolate heartbeat ordering; the adapter suites separately exercise actual SDK startup.

## Local reconnect endpoint and backlog

`LocalGatewayServer.start(0)` binds an ephemeral loopback port and sets the engine's advertised `READY.resume_gateway_url` to that actual endpoint before accepting IDENTIFY. Clients can reconnect using the READY URL alone. Custom transports can call `GatewayEmulator.bindTransportEndpoint(url)` before creating sessions; it applies the existing offline WebSocket URL policy. Rebinding the same canonical endpoint is harmless. Changing endpoints while any live or unexpired resumable session exists fails explicitly; callers must invalidate those sessions or wait for expiry. A failed server endpoint bind closes the newly opened listener and leaves no published server address.

A disconnected, unexpired session can accumulate dispatches using the same intent/content filters and replay limits as a connected session. Filtered events consume no sequence number. Buffering does not extend session expiry. Invalid or expired sessions still reject dispatch. Oversized packets and global replay-budget failures leave sequence and retained history unchanged.

`LocalGatewayServer.dispatch(...)` returns `true` only when it sends the packet to an open socket. It returns `false` both for filtered events and accepted buffered events; it is not a backlog-admission acknowledgment. RESUME replays retained packets after the supplied sequence, then emits RESUMED. Expired/invalid sessions, wrong credentials, future sequences, or missing replay history reject without partial replay. Duplicate session ownership is rejected rather than stealing a live socket.

Bootstrap data is optional for direct core callers. The shared SDK runtime supplies it so READY/GUILD_CREATE can populate the tested SDK caches. Resume history is bounded, and a client outside that retained window receives explicit session rejection.

## Replay capacity

Replay retention is bounded by packet count and encoded size. Defaults allow at most 1,000 retained packets and 16 MiB per session, 1 MiB for one UTF-8 JSON dispatch packet, and 64 MiB across all sessions. Callers can lower those limits with `replayLimit`, `maxDispatchBytes`, `maxReplayBytesPerSession`, and `maxTotalReplayBytes`.

An oversized or non-JSON dispatch is rejected before its sequence advances. Event names are limited to 256 encoded JSON bytes. Retained data accepts finite JSON primitives, dense plain arrays, and plain objects; special JavaScript containers, accessors, symbol keys, cycles/shared references, more than 32 nested levels, and more than 100,000 nodes are rejected instead of being undercounted. Strings, keys, primitives, and container syntax consume the packet budget while the safe clone is built, so an oversized value is stopped before a complete serialized copy is allocated. When a session exceeds its count or byte budget, the oldest retained packets are evicted; resume from a sequence older than the remaining replay window is rejected. The cross-session budget fails closed instead of retaining more data.

## Intent filtering

The core can validate requested privileged intents against a supplied allowed set and map selected event names to required intents. Selected message events can have content-bearing fields stripped when `MESSAGE_CONTENT` is unavailable.

Project `profile.intents` supplies the local privileged-intent allowlist. The SDK requests its own intents; unknown bits retain close code 4013 and disallowed privileged intents retain 4014. Enabling a known intent does not implement every event associated with it.

## Scenario controls

Version 1 scenarios can dispatch an event, disconnect the in-process session, resume it, and assert the model result. Version 2 scenarios inject actions into a real Bot and may select bounded Gateway `disconnect` or `duplicate` fault plans. Plans are session-scoped and cleared on stop; unused plans fail the scenario. Reorder, malformed-payload, burst, and arbitrary missed-heartbeat policies are not exposed. See [Fault injection](fault-injection.md).

## Sharding and findings

Shard routing, identify concurrency, per-shard failure/latency, and cross-shard metrics are not implemented as a supported local profile.

The Gateway core does not currently emit the broad intent/reconnect/idempotency risk catalog previously proposed for this project. Scenarios can assert delivered events and `gateway-resumed`; implemented risk IDs are listed in [Risk engine](risk-engine.md).
