# Assertions

Assertions evaluate observable simulator evidence—state, interaction lifecycle, trace, permission decision, REST/Gateway traffic, risks, runtime, and reports. They should not depend on private implementation details.

## Version 1 assertion types

- `resource-exists`: a resource type/ID exists after the run.
- `resource-field-equals`: one resource field equals a JSON/YAML value.
- `event-received`: a Gateway event occurs, optionally an exact count.
- `risk-present` / `risk-absent`: a stable risk rule ID is present/absent.
- `interaction-state`: an interaction alias/ID reaches the named lifecycle state.
- `state-hash`: the final deterministic state hash equals a known value.
- Concise timeline compatibility assertions: `interaction-acknowledged`, `risk-detected`, `gateway-resumed`, and `no-secret-leak`.

Message, permission, REST, trace, and runtime behavior is asserted through the relevant resource/event/risk evidence in version 1. More expressive nested assertion families are roadmap items until listed by the shipped scenario schema.

## Examples

```yaml
assertions:
  - type: resource-field-equals
    resourceType: message
    id: '${reply.id}'
    field: content
    expected: Done
  - type: event-received
    event: MESSAGE_CREATE
    count: 1
  - type: risk-present
    ruleId: MISSING_BOT_PERMISSION
```

## Failure evidence

The version 1 runner returns the assertion definition, assertion type, optional description, pass/fail state, a human-readable message, and an optional actual value. Reports serialize that bounded, redacted result. Structured assertion paths, nearest-event or state-diff correlation, reproduction commands, and snapshot-update workflows are not implemented.

## Good assertion design

- Derive expectations from protocol rules or scenario intent, not from the implementation's own output.
- Test boundary values and negative outcomes.
- Assert the cause/explanation for permission/rate/timing decisions, not only the status code.
- Prefer stable aliases and semantic fields to generated IDs or UI pixel positions.
- Keep performance thresholds tied to a named environment/profile and report variance.
