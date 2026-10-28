# Fault injection

Version 2 scenarios can apply bounded faults to the same local transport used by the real Bot. Plans belong to one session, activate after SDK/webhook readiness, and are cleared when that run stops.

```yaml
faults:
  - id: slow-webhook
    kind: delay
    method: POST
    route: /interactions
    delayMs: 100
    count: 1
```

## Supported plans

| Kind          | Target  | Required effect fields          | Optional target filters |
| ------------- | ------- | ------------------------------- | ----------------------- |
| `delay`       | HTTP    | `delayMs`, 0–30000              | `method`, `route`       |
| `timeout`     | HTTP    | `delayMs`, 1–30000              | `method`, `route`       |
| `http-status` | HTTP    | `status`: 429, 500, 502, or 503 | `method`, `route`       |
| `disconnect`  | Gateway | —                               | Uppercase `event` name  |
| `duplicate`   | Gateway | —                               | Uppercase `event` name  |

Each plan requires a unique `id`; `count` defaults to 1 and is limited to 100. There may be at most 100 plans. The first eligible plan in declaration order consumes an occurrence. Plans use explicit targets and counts rather than unbounded probabilistic traffic.

Raw signed webhook dispatch uses `POST /interactions`. SDK requests use their API paths, for example `/interactions/:id/:token/callback`. Routes accept literal segments, `*`, or `:parameter` segments. Plan matching does not log raw token values.

## Results and cleanup

Receipts record plan ID, kind, target, occurrence, and selected/ready/cancelled phase. Receipt selection establishes that the transport selected an effect, not that a socket delivered it. Bot behavior still needs its own assertions.

A declared plan that is never selected fails the version 2 run. This catches mistyped routes and faults that never reached the intended path. An intentional timeout or denial needs an explicit `error` assertion; unconsumed errors fail. The configured risk severity policy remains independent of expected-error matching.

Pending fault waits are cancellable. Reset starts a fresh plan scope; stop removes plans and pending waits so they cannot affect the next session. Receipt retention is bounded and dropped receipts mark evidence incomplete. Reports preserve the run's fault evidence before teardown.

## Model controls

Version 1 scenarios retain their explicit virtual-time actions: schedule acknowledgements, cross token expiry, disconnect/resume the model, repeat modeled requests, and mutate resources before assertions. These do not intercept arbitrary Bot dependencies or host timers.

## Outside this profile

Packet reorder, malformed/partial responses, arbitrary missed-heartbeat/burst policies, DNS/database/disk faults, CPU/memory pressure, and commit-then-lose-response semantics are not exposed. A fault plan never enables live Discord traffic or changes unrelated host resources.

See [Scenario v2](scenario-v2.md) for the complete saved format and failure policy.
