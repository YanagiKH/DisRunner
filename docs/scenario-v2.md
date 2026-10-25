# Real Bot scenarios

Version 2 scenarios start the selected project, send actions to the real Bot, inspect its responses, and stop the process before returning. Desktop Scenario Lab and the CLI use the same runner and report formats.

Version 1 scenarios retain their model behavior. A model action that specifies a reply is not accepted in version 2. The `record` and `replay` commands remain model recording tools; repeat a version 2 scenario with `run` or `test` to perform a new Bot run.

```yaml
version: 2
name: local-ping
execution:
  kind: bot
  project: ../../examples/raw-webhook-bot
  clock: realtime
  timeoutMs: 10000
context:
  actor: '3000'
  guild: '1000'
  channel: '2000'
steps:
  - action: invoke-command
    command: ping
    saveAs: ping
    timeoutMs: 3000
  - action: await-response
    interaction: ${ping.id}
    timeoutMs: 3000
assertions:
  - type: message-content
    interaction: ${ping.id}
    equals: Pong! Offline and deterministic.
  - type: no-unexpected-error
policy:
  failOnSeverity: high
```

`execution.project` resolves relative to the scenario file, independently of the terminal's current directory. It may name the project directory or its `discord-simulator.config.json`. In Scenario Lab, paths resolve from the selected project. The project configuration supplies fixtures, adapter, seed, and process settings. Dependencies must already be installed; running a scenario does not install packages.

```sh
pnpm cli validate scenarios/v2/raw-ping.json
pnpm cli test scenarios/v2/raw-ping.json
pnpm cli run scenarios/v2/raw-ping.json --format json
pnpm cli report scenarios/v2/raw-ping.json --format junit --out result.xml
```

`run` and `report` accept `json`, `junit`, `html`, or `sarif`. Report files are written through a temporary file and replaced after a complete write. A failed write does not truncate a previous report. `--seed` applies to model scenarios; version 2 uses the project seed.

## Actions and context

Each step inherits `context`, or supplies its own `actor` and `channel` IDs plus `guild` for a guild context. Omit `guild` for an explicit DM channel. Guild-installed command and autocomplete actions require a guild. IDs are quoted positive decimal strings, and context is captured when the action starts.

| Action             | Required fields                        | Optional fields                      |
| ------------------ | -------------------------------------- | ------------------------------------ |
| `invoke-command`   | `command`                              | `commandType`, `targetId`, `options` |
| `autocomplete`     | `command`                              | `options`                            |
| `invoke-component` | `customId`, `componentType`, `message` | `values`                             |
| `submit-modal`     | `customId`, `fields`                   | `message`                            |
| `send-message`     | `content`                              | —                                    |
| `edit-message`     | `message`, `content`                   | —                                    |
| `delete-message`   | `message`                              | —                                    |
| `await-response`   | `interaction`                          | —                                    |
| `await-message`    | `content`                              | —                                    |

Every step may specify `saveAs` and `timeoutMs`. A step timeout is between 1 and 30,000 ms. The whole scenario has an independent deadline of at most 300,000 ms, including startup. Waiting for a message observes Bot-authored messages in the selected channel. Message injection does not generate a fabricated Bot reply.

A DM prefix scenario uses a recipient-bound DM fixture and no guild ID:

```yaml
context: { actor: '3000', channel: '9000' }
steps:
  - { action: send-message, content: '!ping', saveAs: prefix }
  - { action: await-message, content: 'Pong!', timeoutMs: 3000 }
assertions:
  - { type: message-content, channel: '9000', equals: 'Pong!' }
```

Use the actual prefix response implemented by your Bot. This is a scenario fragment; retain its version, name, and execution fields.

`commandType` is 1 for slash commands, 2 for user context commands, or 3 for message context commands. `options` uses Discord's option objects, including subcommands and focused autocomplete options. Component and modal actions follow the project's supported adapter profile. Unsupported actions return an error instead of silently invoking a different handler.

`fields` maps modal input custom IDs to strings. `message` accepts an actual message ID or `${saved.id}` when a preceding response includes an observed message ID. `interaction` accepts the name from `saveAs` or `${saved.id}`. References to future or missing steps are rejected.

## Assertions and failure policy

| Type                  | Comparison                                                                                                                      |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `message-content`     | One observed Bot message equals `equals` or includes `contains`; optional `interaction`, `channel`, and viewing `actor` filters |
| `message-count`       | Bot message count in the selected `channel` and viewing `actor` equals `equals`                                                 |
| `response-type`       | Actual callback for `interaction` matches `equals`                                                                              |
| `interaction-status`  | Observed interaction state for `interaction` matches `equals`                                                                   |
| `visibility`          | Response for `interaction` is `channel`, `ephemeral`, or `absent`; optional `actor` selects its viewing context                 |
| `error`               | Error from saved `request` matches optional `code` and `contains`                                                               |
| `trace`               | Retained trace `name` and optional `kind` appear; optional `count` requires an exact count                                      |
| `no-unexpected-error` | Runtime remains running without a session failure                                                                               |

A scenario needs at least one behavior assertion. `no-unexpected-error` alone does not establish a passing Bot test. An error assertion consumes only its matching request error; all other operation errors fail the run. For example, an intentional timeout can be tested with an `error` assertion naming that request and `code: timeout`.

Structured SDK handler errors also fail the run, even if an initial reply matched and the severity policy is `none`. Request-scoped `error` assertions do not consume a later run-wide handler exception. Ordinary stderr output is not treated as an exception merely because it contains a warning or error word.

After the final step, the runner waits for tracked SDK handlers to finish within the scenario's overall deadline, then allows 100 ms for immediate error delivery. It continues collecting structured errors through shutdown. A hanging handler cannot produce a pass. This tracks actual SDK handler work, not arbitrary background timers after the process has stopped; add explicit waits and assertions for separate work that completes later.

Adapter controls are validated separately from redacted console output. Malformed controls, output that cannot be drained within the shutdown limit, and handlers left unfinished after the Bot exits make the evidence incomplete. Lines beginning with `DISRUNNER_` are reserved for adapter controls; use a different prefix for your Bot's own log messages.

The runner also checks evidence completeness and the severity policy. Dropped or truncated evidence cannot establish a passing result. `policy.failOnSeverity` accepts `low`, `medium`, `high`, `critical`, or `none`, and defaults to `high`. Explicitly expecting an operation error does not suppress an independent risk finding; select the appropriate policy for a deliberate negative test.

| Result                                                               | Exit code |
| -------------------------------------------------------------------- | --------- |
| Passed                                                               | 0         |
| Assertion mismatch, missing Bot response, unexpected operation error | 1         |
| Invalid scenario, project settings, or unsupported action            | 2         |
| Startup, process, cleanup, or report output failure                  | 3         |
| Cancelled with SIGINT                                                | 130       |
| Cancelled with SIGTERM                                               | 143       |

Reports identify `execution: bot`, realtime clock mode, adapter, run ID, normalized scenario hash, elapsed time, and evidence completeness. `metadata.inputs` preserves the initial fixture-resource and profile hashes plus the entry-file hash when available; later state changes do not replace that identity. An entry-file hash is not a hash of every file or external dependency in the Bot project. Rerunning a Bot restarts its process from the project's initial state. It does not restore arbitrary process memory or promise identical host timing or randomness.

## Transport faults

Optional `faults` apply after the Bot becomes ready and last only for that run. For example:

```yaml
faults:
  - id: slow-callback
    kind: delay
    method: POST
    route: /interactions
    delayMs: 100
    count: 1
```

HTTP plans support `delay`, `timeout`, and `http-status`. A delay or timeout requires `delayMs` up to 30,000 ms; `http-status` requires `status` 429, 500, 502, or 503. Optional `method` and `route` restrict the target. Raw webhook dispatch uses `POST /interactions`; SDK requests use their API paths, such as `/interactions/:interactionId/:token/callback`. Route segments may use `*` or `:parameter` to match an ID.

Gateway plans support `disconnect` and `duplicate`, with an optional uppercase `event` filter. Every plan requires a unique `id`; `count` defaults to one and is limited to 100. Plans consume eligible operations in declaration order. Stopping the run clears all active plans and pending waits.

Reports retain bounded fault receipts in `metadata.faultEvidence`. A receipt records selection by the transport rather than proof of delivery. A declared plan that was never selected fails the scenario, so a mismatched route cannot produce a passing fault test. Assertions still verify the Bot's resulting behavior; selecting a fault does not establish that the Bot handled it correctly.

## Diagnostic reproduction bundles

```sh
pnpm run cli -- repro scenarios/v2/raw-ping.json --out ping-bundle.json
```

`repro` runs the real version 2 scenario and exports a versioned, redacted JSON diagnostic bundle. It contains the scenario, supported fixtures, profile, run report, SDK/version metadata, entry-file digest, and SHA-256 integrity data. The command retains the actual run's exit code: exporting a bundle does not turn a failed Bot test into a pass. An output failure returns 3, and invalid/model input returns 2.

The bundle omits Bot source code, dependencies, environment values, and attachment file bytes. It is marked `replayable: false` and `requiresOriginalProject: true`; use the original prepared project for a fresh rerun. It does not restore process memory or provide a standalone Bot archive. If inputs changed after the run, the manifest identifies that difference rather than claiming the exported fixtures are identical to the original inputs.

Bundle content and overall integrity can be checked with the exported `parseReproductionBundle` API. Review a bundle before sharing it, especially for confidential content that does not match a known redaction pattern. Keep `record`/`replay` for version 1 model recordings.
