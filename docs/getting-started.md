# Getting started

DisRunner can run a real local Bot from Desktop or CLI without a Discord connection or production token. Prepare the runtime and Bot dependencies first, then keep the project offline while developing.

## 1. Prepare the source checkout

Use Node.js 22.23.2 and pnpm 11.19.0:

```sh
corepack enable
corepack prepare pnpm@11.19.0 --activate
pnpm install --frozen-lockfile
pnpm run build
```

For packaged Desktop or the standalone CLI bundle, follow [Installation](installation.md). Python projects additionally need the documented [SDK environment](sdk-adapters.md).

## 2. Run the raw-webhook example

The bundled raw example uses Node's built-in modules and needs no Discord token:

```sh
pnpm run cli -- validate scenarios/v2/raw-ping.json
pnpm run cli -- test scenarios/v2/raw-ping.json
pnpm run cli -- report scenarios/v2/raw-ping.json --format html --out ping-report.html
```

This starts the real example process, waits for authenticated readiness, sends `/ping`, checks the Bot's actual message, and stops the process. Editing the expected response to a different value fails the test. A missing response, crash, invalid project, or cancellation does not produce a pass.

## 3. Open Desktop

```sh
pnpm run dev
```

In Settings, browse to `examples/raw-webhook-bot`. Review the selected executable, entry point, working directory, adapter, and fixture context, then press **Start Bot**. The runtime strip shows phase, PID, errors, and bounded process output.

Select an actor and channel, send `/ping`, and inspect the message and trace. The reply stays attached to its initiating channel even if you navigate elsewhere. Supported buttons/selects send real component interactions; modal submission sends its entered fields, while cancellation sends nothing.

## 4. Try a JavaScript or Python Bot

The repository includes [discord.js](../examples/discordjs-bot/README.md) and [discord.py](../examples/discordpy-bot/README.md) examples. Their exact SDK versions are 14.27.0 and 2.6.4. Python tests use 3.12.14; point the start command at the intended virtual environment.

Open the example directory as a project and start it. Command Explorer reads its local command registration. Text such as `!ping` uses the actual SDK message event pipeline. Use your own Bot's normal startup code and prepared dependencies, then choose its matching adapter in [Project configuration](project-configuration.md).

## 5. Save your fixtures and scenarios

Stop the Bot and open Guild Editor to edit validated resource JSON. Scenario Lab supports JSON/YAML scenario editing, validation, saving, running, cancellation, and report export. Save before a run so it uses the intended initial resources.

Saved project data lives in `.disrunner/workspace.json`. Reopening the project restores fixtures, scenarios, seed, and mode. External edits cause a save conflict; a previous valid save is retained for explicit recovery. See [Workspaces](workspaces.md).

## 6. Understand the two execution modes

[Version 2 scenarios](scenario-v2.md) run a real Bot with host timers and loopback transport. They support bounded faults and a declared failure policy.

[Version 1 scenarios](scenario-format.md) exercise the core model with virtual time. They are useful for exact acknowledgement/token deadlines and deterministic state tests:

```sh
pnpm run cli -- run scenarios/interaction-lifecycle.discord-scenario.yml --seed 42
pnpm run cli -- record scenarios/interaction-lifecycle.discord-scenario.yml --out recording.json --seed 42
pnpm run cli -- replay recording.json --out verification.json
```

Model recordings do not capture arbitrary Bot process memory. To repeat a real Bot test, rerun its version 2 scenario from the saved initial project.

## 7. Stop and inspect failures

Stop the Bot before switching projects. Cancellation waits for cleanup and returns a cancelled result. Startup errors identify unsupported versions, missing dependencies, invalid fixtures, or transport failures. Inspect runtime output and the [troubleshooting guide](troubleshooting.md) when a run cannot start.

The supported SDK transports stay local, but a selected Bot still has the current OS user's process and file access. Keep production secrets out of the project and use separate OS isolation for untrusted code. See [Offline mode](offline-mode.md) and [Privacy](privacy.md).
