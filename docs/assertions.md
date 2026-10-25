# Assertions

This page describes core/model assertions. Real Bot version 2 assertions and error/completeness policy are documented in [Scenario v2](scenario-v2.md).

Assertions evaluate observable simulator evidence—state, interaction lifecycle, trace, permission decision, REST/Gateway traffic, risks, runtime, and reports. They should not depend on private implementation details.

## Version 1 assertion types

- `resource-exists`: a resource type/ID exists after the run.
- `resource-field-equals`: one resource field equals a JSON/YAML value.
- `event-received`: a Gateway event occurs, optionally an exact count.
- `risk-present` / `risk-absent`: a stable risk rule ID is present/absent.
- `interaction-state`: an interaction alias/ID reaches the named lifecycle state.
- `state-hash`: the final deterministic state hash equals a known value.
- Concise timeline compatibility assertions: `interaction-acknowledged`, `risk-detected`, `gateway-resumed`, and `no-secret-leak`.

Message, permission, REST, trace, and runtime behavior is asserted through the relevant resource/event/risk evidence in version 1. Version 2 adds real Bot message content/count, response type, interaction status, visibility, trace, and request-error assertions. Neither format accepts arbitrary undeclared assertion expressions.

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

The version 1 runner returns the assertion definition, type, optional description, pass/fail state, message, and optional actual value. Reports serialize that bounded, redacted result. Arbitrary structured paths, nearest-event correlation, and automatic snapshot updates are not supported.

Version 2 results include expected/actual evidence, run/input identities, faults, cleanup issues, and completeness policy. Unconsumed request errors, unexpected SDK handler diagnostics, incomplete evidence, or cleanup failure cannot pass even if a content assertion matched. Its severity policy is independent of expected-error matching. Use `repro <scenario> --out <bundle>` or Desktop export to save a redacted diagnostic bundle for a fresh rerun with the original project; this does not change the run's verdict or update expectations.

## Good assertion design

- Derive expectations from protocol rules or scenario intent, not from the implementation's own output.
- Test boundary values and negative outcomes.
- Assert the cause/explanation for permission/rate/timing decisions, not only the status code.
- Prefer stable aliases and semantic fields to generated IDs or UI pixel positions.
- Keep performance thresholds tied to a named environment/profile and report variance.
