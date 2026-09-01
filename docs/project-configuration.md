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
- `environment`: explicit non-secret string values. Protected names and production-shaped tokens are rejected; the UI displays names, not a value preview.
- `profile.mode`: passed to the current core/REST profile. It is not a promise that every parser has universal strict/lenient behavior.
- `profile.seed`: deterministic input for runtime core IDs/randomness.
- `profile.networkPolicy`: must be `offline`.
- `fixtures.guild` / `fixtures.user`: optional bounded JSON files loaded into runtime core state. The desktop guild/channel UI remains a separate static preview in v0.1.

## Accepted but not connected in v0.1

The schema retains `adapter.restBaseUrl`, `adapter.gatewayUrl`, `profile.intents`, and `profile.hotReload` for forward compatibility. Do not rely on them in v0.1:

- Electron binds and injects its own REST/Gateway loopback endpoints; config URL overrides are not used.
- `profile.intents` is validated but not applied to the desktop Gateway session.
- `profile.hotReload` does not watch or restart the process.

Omit these fields unless you are testing schema compatibility itself.

## Environment injection

For each run, Electron creates a synthetic `disrunner.offline.*` credential and injects local runtime variables including the chosen REST/Gateway URLs and raw interaction values. Configuration cannot override protected variables. Bot stdout/stderr and supported exports are bounded/redacted, but arbitrary child code can still read files or open its own network connections.

The project `.env` file is not imported by DisRunner. A bot's own launcher may still load it, so remove live secrets or use an isolated project copy.

## Port behavior

Electron binds its REST and Gateway services to loopback dynamic ports. It probes a loopback port for the bot-owned interaction server before process launch and substitutes `${DISRUNNER_BOT_PORT}`. Because the bot binds that port after the probe is released, another process can win the race; startup/readiness then fails visibly.

Hard-coded ports reduce parallel reliability. Do not use hostnames other than explicit loopback addresses.

## One profile per project config

Version 1 has one `profile` object and one fixed config filename. Multiple named profiles, inheritance, hot reload, and profile switching are planned. Use separate trusted project copies/config revisions when different settings are required.

The desktop validator must succeed before **Start Bot** is enabled. CLI `validate` validates scenario files, not project configuration. Validation is not a trust decision; use [hard isolation](offline-mode.md#hard-isolation) for unknown code.
