# Project configuration

The Electron v0.1 Preview reads one `discord-simulator.config.json` from the selected project folder. Treat it as code: review the command, keep paths inside the project, and never store real credentials.

## Runnable v0.1 shape

```json
{
  "$schema": "https://raw.githubusercontent.com/YanagiKH/DisRunner/main/docs/schemas/discord-simulator.config.schema.json",
  "version": 1,
  "bot": {
    "name": "example-bot",
    "runtime": "node",
    "startCommand": "node src/server.mjs",
    "entryPoint": "src/server.mjs",
    "workingDirectory": "."
  },
  "adapter": {
    "type": "raw-interaction-webhook",
    "interactionEndpoint": "http://127.0.0.1:${DISRUNNER_BOT_PORT}/interactions"
  },
  "environment": {
    "DISRUNNER_OFFLINE": "1"
  },
  "profile": {
    "mode": "strict",
    "seed": 42,
    "networkPolicy": "offline"
  },
  "fixtures": {
    "guild": "fixtures/foundation-lab.discord-fixture.json",
    "user": "fixtures/developer.discord-fixture.json"
  }
}
```

Keep fixture paths inside the selected project. Paths that escape the workspace, traverse through an unsafe symlink, or resolve to the config file itself fail validation.

Use the schema shipped with a release when possible. The `main` URL can change. The bundled [raw-webhook example](../examples/raw-webhook-bot/discord-simulator.config.json) is exercised by repository tests.

## Implemented fields

- `version`: must be `1`.
- `bot.name`: display name.
- `bot.runtime`: launch-runtime label (`node`, `python`, or `executable`). This label does not provide a framework adapter.
- `bot.startCommand`: parsed into an executable and arguments; shell operators/interpolation are not accepted as a generic script surface.
- `bot.entryPoint`: optional project-relative regular file checked during validation.
- `bot.workingDirectory`: project-relative directory constrained to the selected workspace.
- `adapter.type`: v0.1 accepts only `raw-interaction-webhook`; other adapter names fail closed.
- `adapter.interactionEndpoint`: loopback HTTP template for the bot-owned endpoint. `${DISRUNNER_BOT_PORT}` is the supported dynamic port placeholder.
- `environment`: explicit non-secret string values. Credential-like names cannot override supervisor-owned values: they are dropped by the process boundary and protected values are written afterward. Production-shaped token values are rejected; the UI displays names, not a value preview.
- `profile.mode`: passed to the current core/REST profile. It is not a promise that every parser has universal strict/lenient behavior.
- `profile.ordinaryMessagePermissions`: optional `legacy-unenforced` (the default) or `guild-text-own-messages-v1`. Unknown or non-string values fail validation. Independent of `profile.mode`; either payload-validation mode can use either permission profile.
- `profile.seed`: deterministic input for runtime core IDs/randomness.
- `profile.networkPolicy`: must be `offline`.
- `fixtures.guild` / `fixtures.user`: optional bounded JSON files loaded into runtime core state. `fixtures.user` supplies the invocation actor, not the authenticated bot.
- `fixtures.bot`: required only with `guild-text-own-messages-v1`; forbidden with omitted or explicit `legacy-unenforced`. See below. Desktop diagnostic projections do not guarantee viewer permissions.

## Ordinary message permission opt-in

Keep the existing runnable example unchanged for legacy behavior. To opt in, replace its `profile` and `fixtures` sections with:

```json
{
  "profile": {
    "mode": "strict",
    "seed": 42,
    "networkPolicy": "offline",
    "ordinaryMessagePermissions": "guild-text-own-messages-v1"
  },
  "fixtures": {
    "guild": "fixtures/permission-guild.json",
    "user": "fixtures/human.json",
    "bot": "fixtures/bot.json"
  }
}
```

This is a configuration fragment, not a replacement for the required bot and adapter fields. Create `fixtures/bot.json`:

```json
{ "version": 1, "user": { "id": "5000", "username": "Local Bot", "bot": true } }
```

`user.id` must be a string from `"1"` through `"18446744073709551615"`, without leading zeros, signs or whitespace; numeric JSON values are rejected. `user.bot` must be literal `true`. The `version: 1` and `user` object envelope are required. The ID and `bot: true` identify the bot across Gateway READY, REST current-user bootstrap, ordinary messages and interaction messages. Display fields remain synthetic on bootstrap/READY surfaces; fixture presentation is not guaranteed everywhere. Application and application-owner identities remain separately generated.

Create `fixtures/human.json` for the separate invocation actor:

```json
{ "version": 1, "user": { "id": "3000", "username": "Developer", "bot": false } }
```

The configured bot is excluded from selectable/default invocation contexts. Explicitly using its ID as `actorId` fails context preflight, rather than substituting a human. Omitting a usable actor fixture does not generate one. Legacy actor selection is unchanged.

Create `fixtures/permission-guild.json`:

```json
{
  "version": 1,
  "guild": {
    "id": "1000",
    "owner_id": "9000",
    "roles": [
      { "id": "1000", "permissions": "0" },
      { "id": "1100", "permissions": "68608" }
    ],
    "channels": [{ "id": "2000", "name": "bot-tests", "type": 0, "permission_overwrites": [] }],
    "members": [{ "id": "5100", "user_id": "5000", "roles": ["1100"] }]
  }
}
```

`68608` grants VIEW_CHANNEL, SEND_MESSAGES and READ_MESSAGE_HISTORY. The member resource ID `5100` is not the bot identity: membership is bound by `user_id: "5000"`, not `member.id` or nested `member.user.id`.

In the enforcing profile, optional `guild.roles`, `guild.channels` and `guild.members` must be arrays of objects when present and become standalone resources. Missing collections stay empty. Nested records inherit the parent guild ID only when `guild_id` is absent; any explicitly different value is rejected. Resources load in guild, roles, channels, members, human user, bot user order. Duplicate `(resourceType, id)` pairs are rejected, including a shared ID between the human and bot fixtures; the guild and its everyone role may share an ID because their resource types differ.

No everyone role, membership, assigned role, owner, administrator privilege or channel overwrite is inferred. Keep negative fixtures explicit: otherwise structurally admitted fixtures with no bot membership, zero permissions, missing roles/overwrites, malformed permission context or ambiguous bot membership can start, then deny ordinary guild-text operations with `403 {"code":50013,"message":"Missing Permissions"}`. Two differently identified member resources with the same bot `user_id` are an ambiguous-membership negative case, not duplicate resource keys. See [Ordinary message permissions](ordinary-message-permissions.md) for exact operation rules and exclusions.

Configuration/fixture structural validation and initial-state preflight happen before listeners or the child start. Config JSON is limited to 1 MiB, each fixture to 8 MiB, and configured paths to 4,096 characters. Fixture paths must resolve to regular files inside the project; escaping symlinks are rejected, internal relative symlinks are allowed. Existing core resource/state capacity limits still apply. These checks do not repair permission-negative fixtures or change legacy fixture interpretation.

## Accepted but not connected in v0.1

The schema retains `adapter.restBaseUrl`, `adapter.gatewayUrl`, `profile.intents`, and `profile.hotReload` for forward compatibility. Do not rely on them in v0.1:

- Electron binds and injects its own REST/Gateway loopback endpoints; config URL overrides are not used.
- `profile.intents` is validated but not applied to the desktop Gateway session.
- `profile.hotReload` does not watch or restart the process.

Omit these fields unless you are testing schema compatibility itself.

## Environment injection

For each run, Electron creates a synthetic `disrunner.offline.*` credential, an ephemeral Ed25519 interaction key pair, and an independent random 32-byte webhook peer secret. It injects local REST/Gateway URLs, `DISRUNNER_PUBLIC_KEY`, and the protected `DISRUNNER_WEBHOOK_PEER_SECRET` into the supervised child. The peer secret is not a project-config field, cannot be overridden through `environment`, is added to output/export redaction, and is replaced on every start. A conforming raw-webhook process uses it only to HMAC-authenticate response status and exact bytes back to Electron.

Bot stdout/stderr and supported exports are bounded/redacted, but arbitrary child code can still read its own environment, inspect files, or open network connections. A process with sufficient same-user inspection rights may also read another process's memory or environment; that remains outside the application-level isolation boundary.

The project `.env` file is not imported by DisRunner. A bot's own launcher may still load it, so remove live secrets or use an isolated project copy.

## Port behavior

Electron binds its REST and Gateway services to loopback dynamic ports. It probes a loopback port for the bot-owned interaction server before process launch and substitutes `${DISRUNNER_BOT_PORT}`. Because the bot binds after the probe is released, another same-user process can still win the port race and deny startup. Mere port ownership is not accepted as bot identity: readiness sends an Ed25519-signed PING and verifies the returned HMAC before parsing JSON. A listener without the per-run peer secret fails readiness or command invocation and cannot fabricate successful callback evidence.

Hard-coded ports reduce parallel reliability. Do not use hostnames other than explicit loopback addresses.

## One profile per project config

Version 1 has one `profile` object and one fixed config filename. Multiple named profiles, inheritance, hot reload, and profile switching are planned. Use separate trusted project copies/config revisions when different settings are required.

The desktop validator must succeed before **Start Bot** is enabled. CLI `validate` validates scenario files, not project configuration. Validation is not a trust decision; use [hard isolation](offline-mode.md#hard-isolation) for unknown code.
