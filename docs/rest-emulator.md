# REST emulator

`LocalRestEmulator` serves the declared API v10 subset over loopback. Desktop and CLI share its identity, resources, message authority, command registry, rate limits, and transport faults. The supported SDK adapters direct their real HTTP requests to this service.

## Transport contract

- Bind `127.0.0.1` on an explicit or operating-system-selected port.
- Accept API v10 paths; compatibility core callers may also use v9-prefixed or unprefixed paths without implying separate v9 parity.
- Authenticate ordinary resource routes with the current synthetic Bot credential.
- Authenticate interaction callback/original/followup routes by their bound token/application identity.
- Reject non-loopback Host headers and enforce bounded request/response bodies.
- Record redacted trace metadata and return configured rate-limit headers or 429 bodies.

JSON requests default to a 1 MiB body limit. The extended profile also accepts the supported SDK multipart subset. Unknown routes return a non-success response, while absent known resources use their resource-specific not-found errors.

## Route catalog

| Methods          | Route                                            | Local behavior                                                                       |
| ---------------- | ------------------------------------------------ | ------------------------------------------------------------------------------------ |
| GET              | `/gateway`, `/gateway/bot`                       | Actual session Gateway URL and single-shard startup profile                          |
| GET              | `/users/@me`, `/oauth2/applications/@me`         | Session Bot/application bootstrap identity                                           |
| GET/PATCH/DELETE | `/channels/{channel}`                            | Declared channel read/mutation profile                                               |
| GET/POST         | `/guilds/{guild}/channels`                       | Guild channel list/create                                                            |
| GET              | `/guilds/{guild}`                                | Loaded guild                                                                         |
| GET/POST         | `/guilds/{guild}/roles`                          | Extended-profile role list/create                                                    |
| GET/PATCH/DELETE | `/guilds/{guild}/roles/{role}`                   | Extended-profile role read/update/delete                                             |
| GET              | `/guilds/{guild}/members`                        | Extended-profile fixture members                                                     |
| GET/PATCH        | `/guilds/{guild}/members/{user}`                 | Extended-profile member read/update; `@me` selects the session Bot                   |
| GET/POST         | `/channels/{channel}/messages`                   | Bounded history or validated message creation                                        |
| GET/PATCH/DELETE | `/channels/{channel}/messages/{message}`         | Supported message fetch/edit/delete                                                  |
| GET/POST/PUT     | `/applications/{app}/commands` and guild variant | Local command list/upsert/bulk overwrite                                             |
| GET/PATCH/DELETE | Command item path                                | Local command read/update/delete                                                     |
| POST             | `/interactions/{interaction}/{token}/callback`   | Applicable one-time initial callback; optional `with_response`                       |
| POST             | `/webhooks/{app}/{token}`                        | Followup or supported deferred-original completion                                   |
| GET/PATCH/DELETE | `/webhooks/{app}/{token}/messages/@original`     | Original response lifecycle                                                          |
| GET/PATCH/DELETE | `/webhooks/{app}/{token}/messages/{message}`     | Owned followup lifecycle                                                             |
| GET              | `/attachments/{attachment}`                      | Authenticated retained local attachment bytes within the declared visibility profile |

The guild command variant is `/applications/{app}/guilds/{guild}/commands`; append `/{command}` for an item. SDK projects use the extended `command-registry-v2` profile. Legacy raw/core projects may explicitly select the narrower v1 registry.

## State and authorization

Supported message and extended channel/role/member mutations use shared state and explicit Gateway event mappings. Resource mutations check their declared permission and hierarchy requirements before committing; rejection does not publish a successful mutation. This is a bounded profile, not the complete Discord moderation catalog.

`guild-text-own-messages-v1` enforces live guild/member/role/overwrite permissions for its ordinary message subset. Raw projects opt in, while SDK projects use it by default. DMs retain the documented local behavior; they do not claim full Discord authorization parity. See [Ordinary message permissions](ordinary-message-permissions.md).

Interaction original/followup routes enforce token expiry, application identity, message ownership, and immutable visibility. PATCH retains omitted fields and deletion cannot be undone by editing. Public messages may emit Gateway events; ephemeral responses stay in the owning actor's private view. Legacy model-only interactions reject unsupported item routes. See [Interaction engine](interaction-engine.md).

## Local attachments

The extended profile accepts multipart `payload_json` and numbered file parts emitted by the pinned SDKs. The default limits are 2 MiB per file, ten files, and an 8 MiB multipart request. Metadata includes local IDs, filename, content type, size, loopback URL, and SHA-256.

Attachment storage is session-scoped and bounded, with default retention of 1,024 files and 64 MiB. Stop clears retained bytes. Local path imports must remain inside the allowed project boundary; SDK transport does not download Discord CDN assets. General CDN behavior and arbitrary upload protocols are unsupported.

## Rate limits and faults

The runtime uses a representative shared message-create bucket of five requests per five realtime seconds. The core supports configured route/shared/global buckets and major-resource isolation. These values are a local test profile, not Discord's current production quotas. Extended interaction-token routes are exempt from the Bot global limit while retaining their route rules.

Version 2 may inject bounded HTTP delay, timeout, or 429/500/502/503 responses into the actual local transport. Faults are selected after the relevant authentication checks and are cleared on session stop. See [Fault injection](fault-injection.md).

Reactions, pins, threads/forums, voice, general webhooks, full pagination/audit-log semantics, malformed response injection, and commit-then-lose-response policies are outside the catalog. A local loopback duration is not a production latency forecast.
