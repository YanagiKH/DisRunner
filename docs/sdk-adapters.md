# SDK adapters

DisRunner runs the Bot's normal SDK event pipeline against local API v10 and JSON Gateway endpoints. It starts a separate process, waits for SDK readiness, injects actions, observes actual responses, and cleans up the process when stopped.

| Adapter      | Exact SDK | Tested interpreter | Entry files                                                  |
| ------------ | --------- | ------------------ | ------------------------------------------------------------ |
| `discord.js` | 14.27.0   | Node.js 22.23.2    | ESM `.mjs` or CommonJS `.cjs`/`.js` according to the project |
| `discord.py` | 2.6.4     | Python 3.12.14     | Python entry script                                          |

The JavaScript bootstrap accepts Node.js 22.23.2 or newer within major 22. The Python bootstrap accepts Python 3.12. These interpreter ranges do not imply certification of every patch release. Other SDK versions are rejected with a startup diagnostic.

## JavaScript

Prepare the dependency in your own Bot project while package downloads are available:

```sh
npm install --save-exact discord.js@14.27.0
```

Keep the project's lockfile. If the Bot uses TypeScript, compile it first using its existing build process. Configure the generated JavaScript entry:

```json
{
  "bot": {
    "name": "My JavaScript Bot",
    "runtime": "node",
    "startCommand": "node dist/bot.js",
    "entryPoint": "dist/bot.js",
    "workingDirectory": "."
  },
  "adapter": { "type": "discord.js" }
}
```

This is a fragment; retain the required `version`, `profile`, and fixtures described in [Project configuration](project-configuration.md). The runtime inserts its bootstrap before the entry point. The Bot still creates its normal `Client`, registers commands, and receives SDK events. Its login credential is replaced with the current synthetic session credential.

The [JavaScript example](../examples/discordjs-bot/README.md) includes prefix/slash commands, subcommands, autocomplete, context commands, deferred responses, followups, components, and a modal.

## Python

Create a Python 3.12.14 environment and prepare dependencies before disconnecting:

```sh
python3.12 -m venv .venv
.venv/bin/python -m pip install discord.py==2.6.4
```

For the repository's complete pinned Python dependency set, install [requirements.txt](../packages/adapter-discordpy/requirements.txt) in that environment. A predownloaded wheel directory can be installed without an index:

```sh
.venv/bin/python -m pip install --no-index --find-links /path/to/wheels -r /path/to/requirements.txt
```

On Windows, use `.venv\Scripts\python.exe`. Set `bot.startCommand` to the interpreter's absolute path followed by the entry script, quoting paths with spaces. For example:

```json
{
  "bot": {
    "name": "My Python Bot",
    "runtime": "python",
    "startCommand": "\"/home/developer/My Bot/.venv/bin/python\" bot.py",
    "entryPoint": "bot.py",
    "workingDirectory": "."
  },
  "adapter": { "type": "discord.py" }
}
```

Use normal `discord.Client` or `commands.Bot` startup, `CommandTree.sync`, and supported View/Modal callbacks. The bootstrap replaces login credentials and points SDK HTTP/Gateway requests at the local session. It rejects external aiohttp requests for the running process. The [Python example](../examples/discordpy-bot/README.md) provides a complete configuration and fixtures.

## What the local profile covers

The supported profile includes single-shard login and cache bootstrap, command registration, typed command invocation, text messages, original/followup response fetch/edit/delete, legacy message buttons and selects, text-input modals, autocomplete, and the documented Gateway lifecycle. Desktop and [Scenario v2](scenario-v2.md) use the same action path.

Collector and View behavior runs inside the real SDK, including its filters and host timers. DisRunner does not accelerate those timers. A new run starts a fresh process; persistent Views across process restarts are outside the profile.

Guild command invocation requires a guild context. DM fixtures support text message events and prefix handlers; omit the guild ID for a DM context. User-installed application-command contexts, Components V2, voice transport, compression, multi-shard sessions, and unlisted REST/Gateway operations are not supported.

## Startup diagnostics

For an SDK/version error, use the displayed interpreter and working directory to check the actual environment:

```sh
node --version
npm ls discord.js
/absolute/path/to/.venv/bin/python --version
/absolute/path/to/.venv/bin/python -m pip show discord.py
```

DisRunner resolves JavaScript dependencies relative to the Bot entry file and Python packages through the selected interpreter. Installing a package into a different directory or environment does not make it available to the Bot. No startup failure falls back to Discord.

The supported SDK transports stay on the session's loopback endpoints. This is not an OS sandbox for arbitrary networking or filesystem access in user code. See [Offline mode](offline-mode.md) and [Known limitations](limitations.md).
