# Project configuration

Desktop and CLI use the same `discord-simulator.config.json` in the selected project directory. Review its executable and entry point before running a project. Dependencies must already be installed; DisRunner does not install them during a session.

## Configuration shape

```json
{
  "$schema": "https://raw.githubusercontent.com/YanagiKH/DisRunner/main/docs/schemas/discord-simulator.config.schema.json",
  "version": 1,
  "bot": {
    "name": "Local Bot",
    "runtime": "node",
    "startCommand": "node bot.mjs",
    "entryPoint": "bot.mjs",
    "workingDirectory": "."
  },
  "adapter": { "type": "discord.js" },
  "environment": {},
  "profile": {
    "mode": "strict",
    "seed": 42,
    "intents": ["GUILDS", "GUILD_MESSAGES", "MESSAGE_CONTENT"],
    "networkPolicy": "offline",
    "hotReload": false
  },
  "fixtures": { "guild": "fixtures/guild.json", "user": "fixtures/user.json" }
}
```

Use the schema shipped with the selected release when available. The `main` schema follows current source. Unknown configuration keys and unsupported adapter names are rejected.

## Bot and interpreter

| Field                  | Meaning                                             |
| ---------------------- | --------------------------------------------------- |
| `version`              | Configuration format, currently `1`                 |
| `bot.name`             | Display name, 1–100 characters                      |
| `bot.runtime`          | `node`, `python`, or `executable`                   |
| `bot.startCommand`     | Executable and arguments, parsed without a shell    |
| `bot.entryPoint`       | Project-relative file, required for Node and Python |
| `bot.workingDirectory` | Project-relative working directory                  |

For Node/Python, the start command must name the configured entry point from its working directory. DisRunner replaces that argument with the validated absolute entry path. An executable name such as `node` or `python3` resolves through the inherited `PATH`. A quoted absolute interpreter path is also accepted:

```json
{
  "runtime": "python",
  "startCommand": "\"/home/developer/My Bot/.venv/bin/python\" bot.py",
  "entryPoint": "bot.py",
  "workingDirectory": "."
}
```

On Windows, quote the absolute `.venv\\Scripts\\python.exe` path and escape its quotes and backslashes in JSON. The interpreter must be an existing Node or Python executable. Python virtual-environment paths retain their environment selection.

`executable` launches a project-contained regular file and is available only with the raw-webhook contract; it is not a generic Gateway or stdio adapter. Pipes, redirects, variable assignments, and chained commands are not interpreted as shell syntax. Credential arguments are rejected.

Entry points, working directories, and fixture files must stay inside the selected project after path resolution. Config files are limited to 1 MiB and each fixture to 8 MiB. Paths are limited to 4,096 characters. Escaping symlinks are rejected; internal symlinks may be used.

## Adapters

| `adapter.type`            | Runtime                          | Prepared dependency          | Interaction transport                     |
| ------------------------- | -------------------------------- | ---------------------------- | ----------------------------------------- |
| `raw-interaction-webhook` | Node, Python, or executable      | User's signed webhook server | `adapter.interactionEndpoint` is required |
| `discord.js`              | Node.js 22, tested with 22.23.2  | `discord.js` 14.27.0         | Local JSON Gateway and API v10            |
| `discord.py`              | Python 3.12, tested with 3.12.14 | `discord.py` 2.6.4           | Local JSON Gateway and API v10            |

SDK versions are exact pins. An incompatible SDK or interpreter produces a startup diagnostic. JavaScript entry points may be ESM or CommonJS; compile TypeScript with the project's normal build command first. SDK projects must not set `interactionEndpoint` because their interactions arrive through Gateway. See [SDK adapters](sdk-adapters.md) for setup.

A raw webhook adapter uses:

```json
{
  "type": "raw-interaction-webhook",
  "interactionEndpoint": "http://127.0.0.1:${DISRUNNER_BOT_PORT}/interactions"
}
```

The runtime binds REST and Gateway on dynamic loopback ports. Optional `adapter.restBaseUrl` and `adapter.gatewayUrl` are retained for configuration compatibility and validated as loopback templates; the runtime supplies its actual bound endpoints. They do not select a remote server or fixed listener port.

## Profile

`profile.mode` accepts `strict` or `lenient`; individual payload validators define what warnings lenient mode permits. Invalid lifecycle transitions, authentication, and permissions still fail. `profile.seed` is an integer from 0 through 4294967295, and `networkPolicy` must be `offline`.

`profile.intents` contains unique names from the Gateway intent catalog. It supplies the local privileged-intent allowlist. The SDK still chooses its requested intents in its own code; enabling a profile intent does not add an event implementation. Invalid or disallowed SDK intents close the Gateway with 4013 or 4014. Message-content filtering distinguishes guild messages from DM, mention, and own-message exceptions.

`hotReload` must be omitted or `false`. `true` is rejected. Stop and restart after code or fixture changes; reselect the project to reload edited configuration.

## Command registry opt-in

Raw-webhook projects leave command registration disabled unless configured. SDK projects default to `command-registry-v2` for global commands and all loaded guilds. An explicit descriptor overrides that default:

```json
{
  "commandRegistry": {
    "profile": "command-registry-v2",
    "guildIds": ["1000"]
  }
}
```

Both `profile` and `guildIds` are required within the descriptor. `command-registry-v1` preserves the earlier empty-slash-option subset. `command-registry-v2` adds typed options, subcommands/groups, choices, autocomplete definitions, context commands, and supported SDK registration fields. See [Application command registry](application-command-registry.md).

`guildIds` contains at most 128 unique canonical positive decimal uint64 strings. Every ID must reference a loaded guild. `[]` enables global-only registration. The runtime checks numeric range and fixture relationships in addition to the schema's structural checks. Command registration does not publish anything to Discord.

## Ordinary message permission opt-in

`profile.ordinaryMessagePermissions` accepts `legacy-unenforced` or `guild-text-own-messages-v1`. Raw projects default to the legacy profile. SDK projects default to the enforcing profile.

An enforcing raw project requires `fixtures.bot`; a legacy raw project must omit it. SDK projects may provide a bot fixture to select its identity, or use a synthetic bot identity and membership created for the local session. An absent SDK everyone role receives the local basic-text permission profile; existing fixture roles and permission values are retained. Use explicit permission fixtures when testing denial or hierarchy behavior.

```json
{ "version": 1, "user": { "id": "5000", "username": "Local Bot", "bot": true } }
```

The separate `fixtures.user` file provides a human invocation actor:

```json
{ "version": 1, "user": { "id": "3000", "username": "Developer", "bot": false } }
```

The bot is excluded from selectable human actors. Guild fixtures use a version-1 envelope with a `guild` object and optional `roles`, `channels`, and `members` arrays. A member binds to a user through `user_id`; resource IDs and permission bitfields are strings. Enforcing guild contexts require explicit membership for the selected human actor as well as the Bot's membership. Give each the permissions needed for the behavior being tested. Nested records inherit the parent guild ID and explicit conflicting IDs are rejected in the enforcing profile. See [Ordinary message permissions](ordinary-message-permissions.md) for the route-level subset.

## Workspace precedence

After a workspace is saved, `.disrunner/workspace.json` supplies resources, scenarios, seed, and mode for subsequent runs. The project config continues to supply the executable, adapter, environment, and remaining profile fields. Invalid, corrupted, or future-version workspace data is diagnosed before starting a Bot. See [Workspaces](workspaces.md) for backups, conflicts, and recovery.

## Environment injection

`environment` accepts non-secret strings. It cannot alter `PATH`, Node/Python module resolution, or dynamic-library injection. Production-shaped credentials are rejected. Supervisor-owned credentials and endpoints override protected environment names. Project `.env` files are not imported by DisRunner; a Bot's own code may still load them.

An environment can contain up to 252 project variables; four slots are reserved for runtime ports and the raw-webhook public key. Names use ASCII letters, digits and underscores, begin with a letter or underscore, and contain at most 256 characters. Each value is limited to 32,768 UTF-16 code units and 65,536 UTF-8 bytes; all names and values together must fit within 1 MiB. The complete config file also has a 1 MiB limit.

Every run receives fresh synthetic credentials and local endpoints. Raw projects also receive an ephemeral Ed25519 public key and a protected response-authentication secret. The raw server verifies signed requests and authenticates its response bytes with the bundled peer-auth helper; that HMAC protocol belongs to DisRunner, not Discord's public API.

Bot output and reports are bounded and redacted. The selected process still runs with the current OS user's filesystem and process privileges. Supported SDK transports reject external endpoints, but arbitrary project networking is outside that adapter boundary. See [Offline mode](offline-mode.md).

## Port behavior

REST and Gateway bind `127.0.0.1` on operating-system-selected ports. A raw Bot receives a dynamically selected webhook port. A competing local process can occupy that port and prevent startup; signed readiness and response authentication prevent accepting an unrelated listener as the Bot. Stop the active run before selecting another project.
