# Getting started

This guide exercises the two authoritative v0.1 paths: deterministic CLI scenarios and the Electron raw-webhook `/ping` Preview.

## 1. Install and verify

From a source checkout:

```bash
corepack enable
corepack prepare pnpm@11.19.0 --activate
pnpm install --frozen-lockfile
pnpm run verify
```

The required runtime is Node.js `>=22.23.2 <23`.

## 2. Run the deterministic core scenario

```bash
pnpm run cli -- run scenarios/interaction-lifecycle.discord-scenario.yml --seed 42
```

This runs the version 1 scenario through the in-process core. Its assertions, final state hash, traces, and findings are authoritative for that run. It does not start an imported Discord SDK bot.

Create a report when needed:

```bash
pnpm run cli -- report scenarios/interaction-lifecycle.discord-scenario.yml --format html --out disrunner-report.html --seed 42
```

## 3. Record and verify a replay

`run` reruns a scenario; it is not the recording replay command. To create and verify a versioned recording:

```bash
pnpm run cli -- record scenarios/interaction-lifecycle.discord-scenario.yml --out recording.json --seed 42
pnpm run cli -- replay recording.json --out verification.json
```

Replay verifies the recorded scenario, canonical input, seed, state hash, assertions, events, and findings. A mismatch returns exit code `1`; invalid arguments or files return `2`.

## 4. Start the Electron Preview

```bash
pnpm run dev
```

Open **Settings → Runtime paths**, select the `examples/raw-webhook-bot` folder, and review the resolved executable, arguments, working directory, adapter, profile, and environment variable names.

The v0.1 validator accepts only `raw-interaction-webhook`. `discord.js`, `discord.py`, generic Gateway, and SDK adapters fail closed because they do not yet have adapter contract tests.

Remove real credentials from the selected project, parent shell, IDE launcher, and task runner. DisRunner injects synthetic values for its supported path, but the child process is not an OS sandbox.

## 5. Start and invoke the bundled bot

Press **Start Bot**. Electron validates the config, binds local simulator services, launches the process, and uses a signed PING request to verify the raw interaction endpoint. The runtime strip shows the phase, PID, resolved command, and latest bounded stdout/stderr entry.

Type `/ping` in the composer, or choose `/ping` in Command Explorer. In Electron this sends a real signed local interaction request to the running bundled bot and renders its callback content and measured host duration. The invocation is aborted after the desktop's 3-second host-time timeout.

The selected visual guild, channel, user, command metadata, and most inspector fields remain seeded UI fixtures. They are not proof that the same resources were delivered over Gateway or mutated through REST.

## 6. Understand the preview screens

- **Simulator:** static guild/channel/member/message fixtures plus the latest local raw-webhook callback.
- **Command Explorer:** static command descriptions; only behavior implemented by the selected raw-webhook process is real. The bundled example implements `/ping`.
- **Guild Editor and Scenario Lab:** visual interactions only; save/run controls do not persist files or execute the CLI engine.
- **Inspector:** callback outcome and duration can come from the real `/ping`; remaining payload/diff/permission/rate-limit panels are illustrative.
- **Risk Center:** can show runtime findings, but export, baselines, trends, and suppression workflows are not implemented.
- **Settings:** project selection is real; most other toggles and Save controls are preview-only.

## 7. Exercise implemented failure behavior

Use version 1 CLI scenarios for deterministic late acknowledgement, virtual-time expiry, in-process Gateway disconnect/resume, permission checks, and repeated rate-limit requests. Use only action types documented in [Scenario format](scenario-format.md).

There is no generic v0.1 `faults` field and no desktop packet drop/duplicate/reorder, arbitrary dependency latency, CPU, memory, or event-loop injection control.

## 8. Stop safely

Press **Stop Bot** before switching projects. Electron requests process-tree shutdown and closes its local services. If the process does not stop, treat that as a failure and inspect the runtime output; do not assume cleanup succeeded from the visual bot state alone.

CLI reports are sanitized before export, but redaction cannot recognize every project-specific secret. Inspect generated files before sharing them. See [Privacy](privacy.md).

Next: [Project configuration](project-configuration.md), [Scenarios](scenario-format.md), and [Assertions](assertions.md).
