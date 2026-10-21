# Scenario format

Scenarios are versioned YAML or JSON programs that initialize virtual state, schedule actions, and assert evidence. YAML files use the `.discord-scenario.yml` suffix. Version 1 accepts two equivalent input styles: a concise absolute-time `actions` dialect and the canonical engine `steps` dialect. Supply exactly one of `steps` and `actions`, even when either array is empty; supplying both is an error. Either array accepts the supported action forms below, including normalized `timeline-*` forms returned by the parser.

The JSON Schema is [docs/schemas/discord-scenario.schema.json](schemas/discord-scenario.schema.json).

## Concise timeline dialect

This style is convenient for latency and lifecycle demonstrations. `at` is virtual milliseconds from run start.

```yaml
version: 1
name: interaction-lifecycle
description: Immediate, deferred, late, permission, rate-limit, and resume coverage.
seed: 42042
mode: strict
initialState:
  guilds:
    - id: '1000'
      name: Foundation Lab
  channels:
    - id: '2000'
      guildId: '1000'
      name: bot-testing
actions:
  - at: 0
    type: interaction
    command: ping
    acknowledgeAfterMs: 120
  - at: 1000
    type: interaction
    command: deferred
    acknowledgeAfterMs: 2800
    followUpAfterMs: 4200
  - at: 7000
    type: interaction
    command: late
    acknowledgeAfterMs: 3001
  - at: 12000
    type: gateway-disconnect
    resumable: true
  - at: 12500
    type: gateway-resume
  - at: 14000
    type: permission-check
    permission: MANAGE_MESSAGES
    expected: denied
  - at: 15000
    type: rest-request
    route: POST /channels/2000/messages
    repeat: 6
assertions:
  - type: interaction-acknowledged
    command: ping
    withinMs: 3000
  - type: risk-detected
    ruleId: INTERACTION_ACK_LATE
  - type: gateway-resumed
  - type: no-secret-leak
```

The repository includes this runnable example at [scenarios/interaction-lifecycle.discord-scenario.yml](../scenarios/interaction-lifecycle.discord-scenario.yml).

## Canonical step dialect

The engine dialect exposes explicit state and protocol operations. Array order is execution order; `advance-time` changes the virtual clock.

```yaml
version: 1
name: message-state
seed: 42
initialState:
  - resourceType: user
    id: '3000'
    username: DevUser
  - resourceType: channel
    id: '2000'
    name: bot-testing
steps:
  - type: send-message
    channelId: '2000'
    authorId: '3000'
    content: Pong!
    saveAs: reply
  - type: advance-time
    ms: 250
  - type: gateway-dispatch
    event: MESSAGE_CREATE
    data:
      id: '${reply.id}'
      channel_id: '2000'
assertions:
  - type: resource-exists
    resourceType: message
    id: '${reply.id}'
  - type: event-received
    event: MESSAGE_CREATE
    count: 1
  - type: risk-absent
    ruleId: SECRET_IN_REPORT
```

Canonical actions in version 1 are `advance-time`, `create-resource`, `update-resource`, `delete-resource`, `send-message`, `gateway-dispatch`, `gateway-disconnect`, `gateway-resume`, `interaction-create`, `interaction-respond`, `interaction-followup`, and `rate-limit-request`.

## Common fields

- `version`: optional format version; omission defaults to 1. Any supplied value other than the number `1`, including `null`, is rejected.
- `name`/`description`/`tags`: stable identity and filtering metadata.
- `seed`: deterministic ID, randomness, jitter, and selection input.
- `mode`: `strict` or `lenient` in either dialect. Neither mode permits an expectation mismatch or unasserted operation error to pass.
- `initialState`: concise resource collections or canonical records with `resourceType`.
- `actions` or `steps`: exactly one execution dialect per scenario.
- `assertions`: checks evaluated after execution.

### Validation and compatibility

The scenario root, each action, and each assertion are closed configuration objects: unknown keys are errors, not ignored settings. Optional fields must have their documented type when supplied (`description` is a string, `tags` is an array of non-empty strings, `saveAs` is a non-empty string, `resumable` is a boolean, and interaction `data` is an object). The optional `$schema` string is editor metadata, not an instruction to load a remote schema. Seeds may be any safe integer. Resource types and collection names remain extensible, and resource records, `data`, `changes`, and assertion `expected` payloads remain open dictionaries/values; application-specific nested keys are not rejected as unknown configuration. Inputs must contain JSON-compatible data, not explicit `undefined` values.

For compatibility, `action` may replace `type`, but supplying both is an error. The standalone `{ advance: '250ms' }` shorthand also accepts a non-negative number of milliseconds or a duration string with `ms`, `s`, or `m`; it cannot be combined with other action fields. Concise `interaction`, `permission-check`, and `rest-request` actions default omitted `at` to zero. Normalized `timeline-*` actions require `at`. Array order remains execution order; an `at` earlier than the current virtual time does not rewind the clock.

Only timeline actions accept `at`. Gateway disconnect accepts `resumable` only with a timeline `at`; canonical disconnect has no options. Canonical Gateway resume accepts an optional non-negative safe-integer `sequence`, while timeline resume uses the recorded sequence and rejects a supplied `sequence`. These distinctions prevent ineffective settings from being silently dropped. Assertion event counts are non-negative safe integers, permission names must be known permission constants, and interaction-state assertions accept only `pending`, `deferred`, `responded`, `deleted`, or `expired`.

### What makes a run fail

A permission-check `expected` mismatch always sets `report.passed` to `false` and `report.status` to `failed`, even with no assertions, in either mode. An assertion for `SCENARIO_EXPECTATION_MISMATCH` cannot excuse it. An explicitly expected denial is still valid and can pass while reporting the missing-permission risk.

Scheduled interaction acknowledgement/follow-up errors cannot pass just because a risk was collected. An explicit, passing `risk-present` or `risk-detected` assertion for a risk associated with that failing operation can describe an intentional negative test. For example, `INTERACTION_ACK_LATE` can cover a deliberately late acknowledgement, `FOLLOWUP_BEFORE_ACK` an early follow-up, and `EXPIRED_INTERACTION_TOKEN` an expired follow-up. Unrelated passing assertions do not cover other failures. Unexpected non-API exceptions still reject execution; canonical operation exceptions also continue to reject rather than return success. Rejected timeline Gateway resumes fail the run. Report metadata includes total and unhandled operation-failure counts for returned reports.

Risks alone are not a blanket failure criterion: permission-denial observations and rate-limit acquisition probes can intentionally produce warnings. `rest-request`/`rate-limit-request` probe the rate-limit engine; they do not perform a Discord REST operation. Negative-test compatibility does not authorize swallowing unrelated operation errors.

These scenarios exercise the offline execution model. The runner's generated interaction replies, Gateway packets, and reports are not evidence that a real Discord bot or SDK is compatible. No live Discord connection or production token is required.

## Capacity limits

The default parser/runner accepts at most 1 MiB of logical input, including the fully expanded value after YAML aliases are resolved. It also limits a scenario to 10,000 actions, 1,000 repetitions per action, 10,000 initial resources, 10,000 assertions, 50,000 retained Gateway events, 64 MiB of retained Gateway-event data, 64 nested levels, 100,000 visited nodes, and 100 YAML aliases. Arrays must be dense data arrays without custom or symbol properties, and unsupported JavaScript containers/accessors are rejected. These limits are configurable through `ScenarioLimits`; a failure occurs before the oversized event batch is appended.

## References

`saveAs` creates a scenario-local alias. Use references such as `${reply.id}` instead of hard-coding a generated ID. Interpolation is constrained to saved values; it does not evaluate arbitrary JavaScript or read the host environment.

## CLI

```bash
pnpm run cli -- validate scenarios/interaction-lifecycle.discord-scenario.yml
pnpm run cli -- run scenarios/interaction-lifecycle.discord-scenario.yml --seed 42
pnpm run cli -- report scenarios/interaction-lifecycle.discord-scenario.yml --format html --out disrunner-report.html
pnpm run cli -- record scenarios/interaction-lifecycle.discord-scenario.yml --out trace.json
pnpm run cli -- replay trace.json
```

Formats are `json`, `html`, `junit`, and `sarif`. A failed assertion exits `1`; invalid input or command usage exits `2`.

## Reproducibility contract

The same DisRunner/profile/adapter versions, normalized scenario, seed, start state, and clock should produce the same scheduler order and state hash. Imported bot code can still introduce host-clock, random, network, filesystem, or concurrency nondeterminism. Replay currently reports aggregate integrity, final-state-hash, assertion, and exact-event checks; it does not locate the first divergence.
