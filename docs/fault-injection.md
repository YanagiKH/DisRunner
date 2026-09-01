# Fault injection status

DisRunner v0.1 does **not** contain a general fault-injection engine or a version 1 `faults` schema. This document separates the deterministic controls available today from the planned design.

## Implemented deterministic controls

Version 1 core/CLI scenarios can currently:

- schedule an interaction acknowledgement before or after the 3-second virtual-time deadline;
- advance virtual time across interaction-token expiry;
- disconnect and resume the in-process Gateway model;
- repeat a modeled REST/rate-limit request;
- create, update, or delete resources before later permission/state assertions.

These are explicit scenario actions. They do not intercept arbitrary bot dependencies, sockets, files, or child-process behavior. See [Scenario format](scenario-format.md) for the accepted action names.

## Not implemented in v0.1

- a top-level `faults` field;
- arbitrary Gateway delay, missed heartbeat, drop, duplicate, reorder, partial payload, or burst delivery;
- REST timeout/reset/malformed-response or before/after-commit policies;
- injected database, DNS, external API, upload, disk-full, or read-only filesystem failures;
- bounded bot CPU/memory/event-loop pressure or child-process leak injection;
- desktop fault controls or visualization of a generic fault schedule.

Unsupported fields must fail scenario validation rather than silently claiming that a fault ran.

## Planned model

The following is a design example only and is intentionally invalid under the v0.1 schema:

```yaml
faults:
  - id: callback-lost-after-commit
    target: POST /interactions/:id/:token/callback
    when:
      occurrence: 1
    effect:
      commit: true
      connectionResetBeforeResponse: true
```

A future implementation must trace activation, target an exact local resource, distinguish before/after commit, derive probability from the scenario seed, bound resource pressure, and clean up only registered simulator resources/processes. It must never convert a local fault into live traffic or mutate unrelated host paths.

Planned acceptance cases include before/after-commit timeout, concurrent permission change, fractional `Retry-After`, duplicate replay after resume, crash during a deferred response, token expiry during work, and application shutdown with active ports/processes. None is a v0.1 desktop compatibility claim until its layer-specific test is listed in [COMPATIBILITY.md](../COMPATIBILITY.md).
