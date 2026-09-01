# REST emulator

`LocalRestEmulator` is a partial, core-tested HTTP service. Electron starts an instance and injects its loopback API base URL into the selected process, but REST use is not the supported raw-webhook command path and is not a claim of Discord REST parity.

## Current transport contract

- Binds `127.0.0.1` on an explicit or operating-system-selected port.
- Accepts `/api/v10`, `/api/v9`, or unversioned route paths.
- Requires the per-instance synthetic `Authorization` value for ordinary routes.
- Authenticates interaction callback and follow-up routes by their synthetic route token instead.
- Rejects a non-loopback `Host` header.
- Reads JSON only, with a configurable bounded body size (1 MiB by default).
- Applies an injected `RateLimitEngine` before routing and returns its headers or `429` body.
- Emits bounded REST trace metadata when a `TraceCollector` is supplied.

It does not currently parse multipart uploads, implement audit-log reasons, or provide a general pagination framework.

## Implemented routes

| Method                   | Route                                          | Current behavior                                                          |
| ------------------------ | ---------------------------------------------- | ------------------------------------------------------------------------- |
| `GET`                    | `/gateway`, `/gateway/bot`                     | Returns the configured local Gateway URL and a fixed single-shard preview |
| `GET`                    | `/users/@me`                                   | Returns the first bot user in state or a synthetic fallback user          |
| `GET`, `PATCH`, `DELETE` | `/channels/{channel_id}`                       | Reads, updates, or deletes a generic channel resource                     |
| `GET`, `POST`            | `/channels/{channel_id}/messages`              | Lists up to 100 state messages or creates a validated message             |
| `GET`, `PATCH`, `DELETE` | `/channels/{channel_id}/messages/{message_id}` | Reads, edits, or deletes one message                                      |
| `GET`                    | `/guilds/{guild_id}`                           | Reads one guild resource                                                  |
| `GET`, `POST`            | `/guilds/{guild_id}/channels`                  | Lists or creates guild channels                                           |
| `POST`                   | `/interactions/{id}/{token}/callback`          | Applies one supported initial interaction response                        |
| `POST`                   | `/webhooks/{application_id}/{token}`           | Creates an in-process interaction follow-up                               |

Unknown routes return `404`. Missing resources use the core not-found error. Message create/edit runs the selected message/embed/component validator; other resource bodies remain generic records rather than complete Discord schemas.

## State and permission boundary

Accepted channel, guild-channel, and message routes mutate `VirtualState`. Transactions, snapshots, and diffs are available through the core state API, but each REST request is not wrapped in a cross-engine transaction or rendered automatically in Electron.

v0.1 REST routes do **not** calculate member permissions or role hierarchy, and REST mutations do **not** emit corresponding Gateway dispatches. The permission engine and Gateway emulator are independently core-tested primitives. A successful local route therefore does not prove that Discord would authorize the same production request.

## Rate limits

The emulator uses the rules provided by its caller. The scenario runner and Electron currently configure a representative shared `POST /channels/:channelId/messages` bucket of five requests per five virtual seconds. This is a test profile, not Discord's current production quota.

## Not implemented

Application-command registration, reactions, pins, threads, polls, moderation/member/role mutations, DMs, general webhooks, original-response edit/delete routes, the full REST catalog, idempotency modeling, latency phases, connection reset, malformed/partial responses, server-error injection, and “commit then lose response” faults are planned.

Local loopback duration is useful for regression evidence but is not a production latency forecast. See [Compatibility](../COMPATIBILITY.md) for the release declaration.
