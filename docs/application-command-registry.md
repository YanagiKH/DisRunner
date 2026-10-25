# Application command registry

The local registry stores global and guild commands in the shared `VirtualState`. `command-registry-v1` preserves the earlier restricted payload contract; `command-registry-v2` adds the command/option profile used by supported SDKs. Registration stays local and does not publish commands to Discord.

Desktop and CLI use the same registry. Raw-webhook projects enable it explicitly. SDK projects default to v2 for global commands and loaded guilds, allowing `commands.set` and `CommandTree.sync` through the real SDK. Command Explorer reads current registration, and the action driver validates invocation options against those definitions. Registration itself emits no Gateway command event and does not execute a handler.

## Project enablement and raw-Bot registration

Add this descriptor inside the existing `profile` in `discord-simulator.config.json`:

```json
{
  "commandRegistry": {
    "profile": "command-registry-v1",
    "guildIds": ["1000"]
  }
}
```

This is a profile fragment, not a complete project. Guild `1000` must exist in the loaded guild fixture. Use `guildIds: []` for global-only registration, which needs no guild fixture. For a raw project, omit `commandRegistry` to disable it; `null` and booleans are not descriptors. SDK projects use the v2 default when omitted. See [project configuration](project-configuration.md#command-registry-opt-in) for validation and fixture requirements.

The setting is independent of `profile.mode` and `profile.ordinaryMessagePermissions`. It does not install the bot into every fixture guild or infer installation from membership or permissions. Raw-webhook projects retain signed readiness and response authentication; the supported SDK adapters use Gateway interactions.

The supervised child uses the existing `DISCORD_API_BASE_URL` and `DISRUNNER_FAKE_TOKEN` environment values. Discover the authoritative application ID with authenticated `GET /oauth2/applications/@me`, then use that ID in registration routes. For example, this code runs inside the supervised Node raw-webhook process; it is not a standalone adapter:

```js
const apiBase = process.env.DISCORD_API_BASE_URL;
const authorization = `Bot ${process.env.DISRUNNER_FAKE_TOKEN}`;
const bootstrap = await fetch(`${apiBase}/oauth2/applications/@me`, {
  headers: { Authorization: authorization },
});
if (!bootstrap.ok) throw new Error('Local application discovery failed.');
const application = await bootstrap.json();
const registration = await fetch(`${apiBase}/applications/${application.id}/commands`, {
  method: 'POST',
  headers: { Authorization: authorization, 'Content-Type': 'application/json' },
  body: JSON.stringify({ name: 'ping', description: 'Ping' }),
});
if (!registration.ok) throw new Error('Local command registration failed.');
```

Do not supply a production credential, invent an application-ID environment variable, or use a fixture user/bot ID as the application ID. Runtime REST uses the same per-run bootstrap application identity as Gateway READY and signed interactions. A valid authenticated registry route without the opt-in returns `501` with `Command registry profile is not enabled.`

## Version 2 command profile

Choose `"profile": "command-registry-v2"` in the same descriptor to enable typed slash options (string, integer, boolean, user, channel, role, mentionable, number, and local attachment), subcommands/groups, required options, choices, autocomplete definitions, and user/message context commands. Supported SDK registration fields are validated rather than silently dropped. Command option trees and payload sizes are bounded. User-installed contexts, Components V2, commerce, and unlisted fields remain unsupported.

SDK registration/sync runs over the local REST service; command invocation still arrives through the normal SDK interaction pipeline. The action driver supplies resolved local users, roles, channels, messages, and attachments and rejects unknown option names or incorrect types. See [SDK adapters](sdk-adapters.md) and [Scenario v2](scenario-v2.md).

The detailed empty-options payload/response catalog below describes v1 where labeled; it is retained for existing integrations. Shared identity, route, atomic replacement, and capacity rules also apply to v2.

## Core enablement and identity

Supply `commandRegistry` to `LocalRestEmulator` together with a validated [REST bootstrap identity](rest-bootstrap.md). REST binds the registry application exclusively to `bootstrap.application.id`. The registry option is a copied, frozen descriptor, not an injected service or request-controlled identity.

This TypeScript helper extends an existing core REST setup and uses the actual public constructor and address API. `base` must contain the state, Gateway, interaction and rate-limit engines and a complete bootstrap profile. Its configured synthetic credential is inherited; never use a production Discord token.

```ts
import { LocalRestEmulator, type RestEmulatorOptions } from '@disrunner/core';

async function startRegistry(
  base: RestEmulatorOptions & {
    bootstrap: NonNullable<RestEmulatorOptions['bootstrap']>;
  },
  guildIds: readonly string[] = [],
) {
  const rest = new LocalRestEmulator({
    ...base,
    commandRegistry: { profile: 'command-registry-v1', guildIds },
  });
  const address = await rest.start();
  return {
    rest, // Call await rest.stop() when finished.
    commandsUrl: `${address.apiBaseUrl}/applications/${base.bootstrap.application.id}/commands`,
  };
}
```

An empty `guildIds` enables global registration only. To register guild commands, provide up to 128 distinct guild IDs and corresponding `guild` fixtures in the same state before construction. This is an explicit local installation allowlist, not an inference from message permissions, bot membership, or `MANAGE_GUILD`. Each operation rechecks that the allowed guild fixture still exists.

IDs are strings of canonical positive decimal digits, at most `18446744073709551615`. Leading zeros, whitespace, signs, exponent notation, JSON numbers, and percent-encoded ID aliases are not accepted or normalized. This applies to configuration, routes, explicit bulk IDs, stored IDs and generated IDs.

The exported `ApplicationCommandRegistry(state, applicationId, profile)` also exposes `list(app, guild?)`, `get(app, guild, id)`, `post(app, guild, input)`, `patch(app, guild, id, input)`, `put(app, guild, input)`, and `delete(app, guild, id)`. Pass `undefined` for the global scope in methods requiring the guild argument. Direct construction explicitly binds its own application ID; it does not provide HTTP authentication or rate limiting. `post` returns `{ created, command }`; other read/write results are command objects or arrays, and `delete` returns no value. REST constructs its own instance from bootstrap identity.

## Routes and mutation semantics

Use either collection path:

- Global: `/applications/{application_id}/commands`
- Guild: `/applications/{application_id}/guilds/{guild_id}/commands`

An item path appends `/{command_id}`. The existing `/api/v10`, `/api/v9`, and unprefixed transport forms are accepted; this document describes v10-shaped behavior, not separate v9 parity.

| Target     | Method   | Behavior                                                                                                             |
| ---------- | -------- | -------------------------------------------------------------------------------------------------------------------- |
| Collection | `GET`    | `200`, list ordered by numeric type, Unicode code-point name, then numeric ID                                        |
| Collection | `POST`   | Complete-create upsert by exact scope, type and name; new command `201`, existing command `200` with its ID retained |
| Collection | `PUT`    | `200`, atomic full-scope replacement across all three types; response follows request order                          |
| Item       | `GET`    | `200`, one exact-scope command                                                                                       |
| Item       | `PATCH`  | `200`, replace supplied fields, retain omitted fields; ID and type are immutable                                     |
| Item       | `DELETE` | `204`, zero response bytes; deleting a missing command is `404`, not a no-op                                         |

For example, POST the JSON body `{"name":"ping","description":"Ping"}` to the global collection to create a slash command. POST `{"type":2,"name":"Inspect User"}` to create a USER command. Authenticate using the instance's synthetic credential with the `Bot ` prefix.

POST uses complete-create defaults, not PATCH semantics. An empty PATCH `{}` is valid. Exact names are case-sensitive keys; identical names may coexist across types, scopes, or applications.

PUT accepts an array of complete-create entries, optionally with `id`. An explicit ID must already exist in the exact scope and keep its type; it may rename the command. Without an ID, an entry matches an existing exact type/name or creates a new command. Duplicate final keys, duplicate explicit IDs, multiple entries resolving to the same old record, foreign/unknown IDs, and rename collisions are rejected. Commands omitted from the result are deleted; `[]` clears only that scope. Unchanged records retain their ID and version.

## Accepted fields and rejected features

Unknown keys are rejected rather than silently dropped. POST/PATCH reject `id`, `application_id`, `guild_id`, `version`, `registry_profile`, and `resourceType`; only PUT entries permit `id`. PATCH rejects `type` even when its value is unchanged.

| Field                                             | Accepted behavior                                                                             |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `type`                                            | Creation defaults to `1` (CHAT_INPUT); integer `2` (USER) and `3` (MESSAGE) are supported     |
| `name`                                            | Required on creation; 1–32 Unicode code points, no control characters or all-whitespace names |
| `description`                                     | Slash: required on creation, 1–100 code points. USER/MESSAGE: omitted or `""` only            |
| `options`                                         | Slash: omitted or `[]` only. USER/MESSAGE: must be omitted, including rejecting `[]`          |
| `default_member_permissions`                      | Omitted or `null` only; permission strings are unsupported                                    |
| `nsfw`                                            | Omitted or `false` only                                                                       |
| `name_localizations`, `description_localizations` | Omitted or `null` only; localization objects are unsupported                                  |
| `default_permission`                              | Omitted or `true` only; accepted `true` is normalized away                                    |
| `integration_types`, `contexts`                   | Global only: omitted or exactly `[0]`                                                         |
| `dm_permission`                                   | Global only: omitted or `false`                                                               |

Slash names must satisfy `^[-_\p{L}\p{N}\p{sc=Devanagari}\p{sc=Thai}]+$` in Unicode mode and equal their lowercase form. Input is not normalized. USER/MESSAGE names preserve case and spaces. All accepted strings reject lone surrogates.

Nonempty options are unsupported regardless of their contents. Choices, subcommands, autocomplete, attachments, command permissions, localization, other command types, DM/private-channel contexts, and other installation types are not implemented. Guild payloads reject all three global-only fields, even their neutral values. Wrong primitive types are invalid payloads. `null` is not omission: only the three explicitly nullable fields in the table accept it; `default_permission: null` and global `contexts: null` / `integration_types: null` are unsupported features.

Core inputs must be descriptor-inspectable plain JSON records/arrays. Proxies, accessors, symbols, custom prototypes, inherited payload fields, cycles, repeated object references, sparse arrays, pollution keys, and excessive nesting are rejected without invoking caller getters or Proxy traps. Inspection is bounded to depth 16, 8,192 visited values, arrays of at most 1,024 entries, and 64 KiB of string data. These are input safety bounds, not support for recursive command options.

## Legacy v1 canonical responses

Every command contains exactly these common wire fields:

`id`, `type`, `application_id`, `name`, `description`, `default_member_permissions`, `nsfw`, `version`.

- `default_member_permissions` is always `null`; `nsfw` is always `false`.
- Slash commands add `options: []`; USER/MESSAGE commands have `description: ""` and no `options` field.
- Guild commands add `guild_id`.
- Global commands add `integration_types: [0]`, `contexts: [0]`, and `dm_permission: false`. These deliberately restricted defaults are local behavior, not a claim about production global availability.
- No localization fields, `default_permission`, private state markers, or Gateway/event fields are returned.

Responses are copies, not live state references. Successful REST responses include `X-DisRunner-State-Revision` and applicable local rate-limit headers.

## State, versions, undo and capacity

The authoritative records are `application-command` resources in `VirtualState`. There is no independent registry cache: undo, redo, reset, or snapshot restore is reflected by subsequent operations. Invalid stored records fail closed with `503`; overwrite does not silently repair corruption or return a misleading partial list. Malformed records outside the requested scope can also cause failure; unrelated well-formed records are left untouched.

The shared runtime uses the same per-run state for registration and ordinary/interaction messages, not a separate command cache or persistence file. A successful restart creates fresh credentials and fresh command state; the child must register again. Editing the config file after project selection does not change the selected configuration: reselect the project to load changes.

Existing core `VirtualState` undo, redo and snapshot restore immediately affect subsequent REST operations. `state.reset()` clears **all** resources, not just commands: global listing is empty and an allowlisted guild returns `404` / `10004` until its resource is restored, for example by restoring the initial snapshot. Restoring a same-run snapshot containing commands restores those records too. These are core state operations; this profile adds no public Session reset/restore API or GUI action.

Renderer snapshots and state events still project only guild, channel, user and message resources. Command records and their private registry markers are excluded. Command writes can advance `stateRevision`, increase `totalResources` and make `truncated` true without adding command rows to the displayed resources. This is not Command Explorer integration.

A substantive mutation commits exactly once. Canonically unchanged POST/PATCH/PUT operations return `200` without changing revision, version, or history. Every mutating call, including no-ops, still enters the state-scoped mutation guard and an outermost transaction. Caller-owned active transactions, nested registry writes, and commit-listener writes are rejected. Commit listeners may read the fully committed state; listener failures do not undo a successful commit.

`version` is a local positive-decimal uint64 approximation, **not a timestamp-bearing Discord Snowflake**. New commands use the anticipated next state revision. A forward edit uses the greater of that revision and the currently stored command version plus one. Undo or restore can rewind versions. There is no historical uniqueness or global monotonicity guarantee across replay.

Per scope, limits are 100 slash, 15 USER and 15 MESSAGE commands; PUT accepts at most 130 entries. Canonical serialized commands are bounded to 64 KiB. Existing state resource-count, resource-byte and total-byte limits still apply. Even a replacement whose final state would fit can safely fail because intermediate state requires more capacity.

Failed transactions restore resources, snapshot hash, revision, history/redo, and commit visibility without publishing partial results. **The ID allocator is not rolled back**: late allocation/capacity failures may consume IDs. Rate buckets, traces, clocks, and bot memory are also outside registry rollback.

History retention follows `VirtualState`: history-entry trimming remains in effect, and a successful change whose diff exceeds the history-byte budget commits but establishes an undo barrier. History overflow is not a failed mutation or a promise that every successful change can be undone.

## HTTP safety, queries and rate limits

The listener remains loopback-only with Host validation. Missing, wrong, or `Bearer` credentials receive `401`; the existing exact bare synthetic-token form is also accepted. Never send production credentials. Registry traces use a sanitized family template rather than request paths, identities, bodies, or credentials.

Within the registry family, processing order is Host validation, authentication, raw-route validation, profile/method support, configured application and guild checks, authoritative state/item checks, rate limiting, then query/body validation and execution. Consequently authentication precedes malformed-route errors; disabled valid routes return `501` before identity or body checks; missing items and invalid state do not consume an item-specific bucket; and `429` precedes malformed query/body errors.

Raw paths reject dot segments, encoded aliases, backslashes, encoded separators, absolute-form targets, malformed escapes, and noncanonical IDs before URL normalization. Permission suffixes and unsupported methods return `501` for an otherwise valid enabled family route.

Only collection GET accepts a query: exactly `with_localizations=false`, or no query. `true` is unsupported; unknown, duplicate, encoded, empty, or other lexical query values are invalid. Item GET and all writes accept no query.

GET and DELETE require zero body bytes: even whitespace or JSON `null` is invalid. A declared body larger than `maxBodyBytes` receives `413`; a positive in-bounds declared body is rejected immediately. Chunked bodies are rejected at the first nonempty chunk. JSON mutations inherit the REST body bound (`maxBodyBytes`, 1 MiB by default) and malformed-JSON handling.

All supported collection and item methods normalize to the same verified app/scope collection path before the injected `RateLimitEngine` is called. Configure one **methodless** rule per intended collection template, with distinct global/guild rule IDs and `majorParameters: ['applicationId']` or `['applicationId', 'guildId']`. The corresponding templates are `/applications/:applicationId/commands` and `/applications/:applicationId/guilds/:guildId/commands`. Reads can therefore consume the same local bucket as writes. The emulator does not install or overwrite these rules for you. The shared runtime adds no registry-specific rate rule; existing injected/global limiting is unchanged. Production quotas, daily-create limits, and real Discord bucket identities are not modeled.

## Fixed registry errors

These errors do not echo submitted field values:

| HTTP | Code  | Message                                                           |
| ---- | ----- | ----------------------------------------------------------------- |
| 401  | 0     | `401: Unauthorized`                                               |
| 400  | 50035 | `Invalid application command route.`                              |
| 501  | 0     | `Command registry profile is not enabled.`                        |
| 501  | 0     | `Unsupported application command route.`                          |
| 403  | 50001 | `Missing access.`                                                 |
| 404  | 10004 | `Unknown guild.`                                                  |
| 404  | 10063 | `Unknown application command.`                                    |
| 400  | 50035 | `Invalid application command payload.`                            |
| 400  | 50035 | `Unsupported application command feature in command-registry-v1.` |
| 503  | 0     | `Command registry state is invalid.`                              |
| 503  | 0     | `Command registry capacity exceeded.`                             |
| 409  | 0     | `Command registry mutation is not allowed in this state context.` |

Capacity failures include scope/state limits, generator failures, invalid generated IDs, and version exhaustion. Transport syntax/body-limit errors and `429` retain the existing REST contracts. Error responses need not include a state-revision header.
