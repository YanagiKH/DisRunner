# REST emulator

`LocalRestEmulator` is a partial, core-tested HTTP service. Electron starts an instance and injects its loopback API base URL into the selected process, including selected ordinary-message routes and context-bound chat-input original/follow-up routes, with explicit project opt-ins for supported REST behavior. Registration is separate from raw-webhook invocation and does not establish Discord REST parity.

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

| Method                   | Route                                                      | Current behavior                                                                                |
| ------------------------ | ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `GET`                    | `/gateway`, `/gateway/bot`                                 | Returns the configured local Gateway URL and a fixed single-shard preview                       |
| `GET`                    | `/users/@me`                                               | Returns the configured bot identity when supplied, otherwise the legacy state/fallback identity |
| `GET`, `PATCH`, `DELETE` | `/channels/{channel_id}`                                   | Reads, updates, or deletes a generic channel resource                                           |
| `GET`, `POST`            | `/channels/{channel_id}/messages`                          | Lists up to 100 state messages or creates a validated message                                   |
| `GET`, `PATCH`, `DELETE` | `/channels/{channel_id}/messages/{message_id}`             | Reads, edits, or deletes one message                                                            |
| `GET`                    | `/guilds/{guild_id}`                                       | Reads one guild resource                                                                        |
| `GET`, `POST`            | `/guilds/{guild_id}/channels`                              | Lists or creates guild channels                                                                 |
| `POST`                   | `/interactions/{id}/{token}/callback`                      | Applies one supported initial interaction response                                              |
| `POST`                   | `/webhooks/{application_id}/{token}`                       | Creates a follow-up under the selected interaction profile                                      |
| `GET`, `PATCH`, `DELETE` | `/webhooks/{application_id}/{token}/messages/@original`    | Reads, edits or deletes the original under `chat-input-messages-v1`                             |
| `GET`, `PATCH`, `DELETE` | `/webhooks/{application_id}/{token}/messages/{message_id}` | Reads, edits or deletes an owned follow-up under that profile                                   |

Unknown routes return `404`. Missing resources use the core not-found error. Message create/edit runs the selected message/embed/component validator; other resource bodies remain generic records rather than complete Discord schemas.

## State and permission boundary

Accepted channel, guild-channel, and message routes mutate `VirtualState`. Selected ordinary and public interaction message commits emit Gateway message dispatches and are eligible for the bounded Desktop live projection. This does not make all resource routes transactional across engines or automatically visible in Electron.

Ordinary guild-text reads and own-message mutations enforce live permissions only with the explicit `guild-text-own-messages-v1` profile and its required bot fixture. The default remains legacy-unenforced; there is no general role-hierarchy enforcement or viewer-permission-filtered Desktop view. See [Ordinary message permissions](ordinary-message-permissions.md).

The `chat-input-messages-v1` profile supports public originals (type 20) and follow-ups (type 0), including retrieval, edits and deletion. Model-only interactions reject original/follow-up item routes with `501`. Public committed messages, rather than raw callback diagnostics, drive the live projection; ephemeral, loading-only and deleted messages are excluded. See [Interaction engine](interaction-engine.md) for authentication, ownership, validation, evidence and delivery boundaries. A successful local route does not prove that Discord would authorize the same production request.

## Rate limits

The emulator uses the rules provided by its caller. The scenario runner and Electron currently configure a representative shared `POST /channels/:channelId/messages` bucket of five requests per five virtual seconds. This is a test profile, not Discord's current production quota.

## Application-command registration

The explicit [registry profile](application-command-registry.md) supports global and allowlisted guild collection `GET`/`POST`/`PUT` and item `GET`/`PATCH`/`DELETE`. It is available through core REST options and shared-runtime `profile.commandRegistry` configuration used by Desktop and CLI `bot-test`, but remains disabled when omitted. The raw child discovers the per-run application ID through authenticated `GET /oauth2/applications/@me` and uses the existing injected local API URL and synthetic Bot credential.

Registration uses the run's existing state and credentials, with no additional registry-specific rate rule. It neither invokes commands nor emits Gateway command events. Command records remain excluded from renderer projections. Options beyond empty slash options, SDK integration and Command Explorer are not supported; see the registry contract for exact payloads and errors.

## Not implemented

Reactions, pins, threads, polls, moderation/member/role mutations, DMs, general webhooks beyond the interaction-token profile, the full REST catalog, idempotency modeling, latency phases, connection reset, malformed/partial responses, server-error injection, and “commit then lose response” faults are planned.

Local loopback duration is useful for regression evidence but is not a production latency forecast. See [Compatibility](../COMPATIBILITY.md) for the release declaration.
