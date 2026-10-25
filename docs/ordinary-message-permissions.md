# Ordinary message permission profile

This is an explicit **core API and shared-runtime opt-in**, not a Discord or SDK-wide permission guarantee. Raw-webhook projects retain **`legacy-unenforced`** by default. SDK projects default to `guild-text-own-messages-v1`; their synthetic Bot membership/bootstrap is described in [project configuration](project-configuration.md#ordinary-message-permission-opt-in). Explicit legacy raw fixtures retain their previous behavior. CLI and Desktop use the same setting.

Set `ordinaryMessagePermissions: 'guild-text-own-messages-v1'` when constructing `LocalRestEmulator` or `MessageDomainService`. Both options and the exported `OrdinaryMessagePermissionProfile` type are available from `@disrunner/core`. Unknown profile values throw `TypeError`; the option is independent of strict/lenient payload validation.

For an enforcing raw-webhook project, set `profile.ordinaryMessagePermissions` to `"guild-text-own-messages-v1"` and supply `fixtures.bot` together. The bot fixture is a version-1 `user` envelope with a canonical positive unsigned-64-bit string ID and literal `bot: true`. `fixtures.user` remains the separate invocation actor. Supply explicit `guild.members`, roles and channel overwrites; this raw profile does not generate membership or permission grants. See the [project configuration example](project-configuration.md#ordinary-message-permission-opt-in) for complete fixture envelopes and import rules. The direct core API example below uses standalone resources instead.

Runtime identity is the configured bot ID with `bot: true` across Gateway READY, REST current-user bootstrap, ordinary authors and interaction-message authors. Presentation fields can remain synthetic; a fixture username or avatar is not guaranteed on every protocol surface. Public snapshots omit ephemeral messages; actor views add only the owning actor's private responses. The broader local viewer/permission subset is documented separately and is not full Discord-client permission parity.

## Covered operations and deliberate limits

The profile protects ordinary message collection/item GET and POST/PATCH/DELETE in explicit guild text channels (`type: 0`). The same live-state policy guards HTTP reads and direct domain mutations.

- All operations require VIEW_CHANNEL. Collection GET without READ_MESSAGE_HISTORY returns an empty array; item GET requires both permissions.
- POST requires SEND_MESSAGES, and `tts: true` additionally requires SEND_TTS_MESSAGES.
- PATCH and DELETE require ownership by the authenticated bot and VIEW_CHANNEL, not SEND_MESSAGES or READ_MESSAGE_HISTORY. Other-author mutations remain forbidden even for owner, administrator or MANAGE_MESSAGES. This deliberately omits Discord moderator edits/deletes.
- An active timeout denies all non-owner/non-administrator mutations, including an identical-content PATCH. This is a conservative simulator restriction, not a claim about every Discord timeout edge case. Owner and administrator bypass overwrites and timeout only after the entire required context is validated.
- Explicit DMs (`type: 1`, no `guild_id`) keep legacy behavior. **DM authorization is not enforced.** Threads, categories and other channel types are outside this profile.
- Guild-text ordinary GET excludes interaction-origin messages, even public ones. This tighter ordinary-only boundary is not full Discord channel-history parity. Interaction callback, original and followup token routes retain their existing authorization. Ordinary mutation routes still cannot change interaction-owned messages.
- Existing content, embed, component, attachment-metadata and flag validation remains unchanged. Attachment uploads/ATTACH_FILES, EMBED_LINKS, mentions and richer composition permission parity are **not certified**. No attachment support or new moderation, pagination, intent, Gateway delivery-filter or UI functionality is implied.

## Authoritative fixture schema

Every request reads the same `VirtualState` again. Bootstrap identity is not membership, and request payloads cannot grant identity or permissions.

Required guild-text resources:

- A state `user` whose `id` is exactly `gateway.botUserId` and whose `bot` is `true`. A configured domain/bootstrap author must match that same bot.
- A `guild` referenced by `channel.guild_id`, with decimal-string `owner_id`.
- Exactly one `member` with that `guild_id` and `user_id` equal to the bot ID. Its own resource `id` is independent. Its `roles` is an array of unique decimal-string role IDs, excluding the guild ID because everyone is implicit. `member.id`, `member.user.id` and `roleIds` are not identity/role aliases.
- Standalone `role` resources with `guild_id`, `id` and canonical unsigned decimal-string `permissions`, including the everyone role whose ID equals the guild ID. Every referenced role must exist in the same guild. All roles belonging to this guild are validated, including unassigned roles. Position is irrelevant here.
- An explicit `channel.permission_overwrites` array, including `[]` when empty. Entries have decimal-string `id`, numeric `type` (`0` role, `1` member), and canonical unsigned decimal-string `allow`/`deny`. Duplicate `(type,id)` entries deny. Role targets must exist in this guild; non-actor member targets need not be materialized. Malformed unrelated entries also deny.

Permission strings must match `^(0|[1-9][0-9]*)$`, not numbers, hex, negative values or strings with whitespace. Unknown high bits are retained using bigint arithmetic. IDs are nonempty decimal strings. No parent/category overwrite substitution is performed: supply the already-resolved authoritative channel overwrite array.

Optional `member.communication_disabled_until` is absent, null, or a canonical UTC ISO timestamp such as `2023-11-14T22:13:21.000Z`. It is compared with `state.now()`; equality is expired. Invalid timeout values deny rather than being ignored.

For example, these resources grant a bot VIEW_CHANNEL, SEND_MESSAGES and READ_MESSAGE_HISTORY:

```json
[
  { "resourceType": "guild", "id": "1000", "owner_id": "9000" },
  { "resourceType": "user", "id": "2000", "bot": true, "username": "Local Bot" },
  {
    "resourceType": "member",
    "id": "2100",
    "guild_id": "1000",
    "user_id": "2000",
    "roles": ["3000"]
  },
  { "resourceType": "role", "id": "1000", "guild_id": "1000", "permissions": "0" },
  { "resourceType": "role", "id": "3000", "guild_id": "1000", "permissions": "68608" },
  {
    "resourceType": "channel",
    "id": "4000",
    "guild_id": "1000",
    "type": 0,
    "permission_overwrites": []
  }
]
```

Use a Gateway configured with `botUserId: '2000'` for this synthetic fixture. Never use a real Discord token.

## Failure and revocation behavior

Missing or malformed required context and missing operation permissions return `403 {"code":50013,"message":"Missing Permissions"}`. Invalid owner/administrator context cannot bypass validation. Overwrite precedence is everyone, combined role denies/allows, then actor member deny/allow. Role order and position do not choose a winner.

Authorization precedes message lookup, ownership, payload validation and the no-op shortcut. HTTP authentication, rate acquisition, JSON decoding and POST/PATCH object-body validation retain their earlier precedence. Collection limits are validated after authorization even when the result will be empty. Unknown channels preserve the existing simulator resource error (`404/10008`); unsupported channel types return `400/50035`.

Revoking roles, overwrites or membership takes effect on the next request without rebuilding the service. A denied request leaves message state, revision, mutation history, committed message sequence, success evidence and MESSAGE dispatches unchanged. It emits no mutation-success headers. Authenticated denied/invalid/no-op requests still consume configured rate quota, and error traces may be recorded. Invalid authentication consumes no quota. Configured limiter behavior is deterministic, not a claim to reproduce Discord production quotas.

The standalone permission calculator remains unchanged; this profile owns its administrator-timeout exemption. See the official [permissions reference](https://docs.discord.com/developers/topics/permissions) and [message resource](https://docs.discord.com/developers/resources/message) for the protocol basis and broader Discord behavior beyond these simulator limits.
