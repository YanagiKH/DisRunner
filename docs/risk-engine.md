# Risk engine

The v0.1 risk collector turns selected core/desktop evidence into findings. Its rule catalog is intentionally small. Absence of a finding does not prove that a bot is safe, correct, or production-ready.

## Finding shape

Implemented findings contain a rule ID, severity, confidence, title, evidence, impact, and recommendation. Trace/event/source/reproduction/documentation/suppression/timestamp fields are optional and appear only when the emitting path supplies them.

v0.1 does not implement a persistent baseline, suppression editor, owner/expiry policy, historical trend store, or automatic CI severity threshold. A CLI run fails for failed assertions; findings fail it only when the scenario asserts that the finding must be absent.

## Implemented rule IDs

| Source                | Rules                                                                                                    |
| --------------------- | -------------------------------------------------------------------------------------------------------- |
| Interaction lifecycle | `DOUBLE_INTERACTION_RESPONSE`, `FOLLOWUP_BEFORE_ACK`, `EXPIRED_INTERACTION_TOKEN`, `INTERACTION_TIMEOUT` |
| Trace analysis        | `INTERACTION_ACK_LATE`, `BLOCKING_HANDLER`                                                               |
| Scenario helper paths | `RATE_LIMIT_HOT_BUCKET`, `MISSING_BOT_PERMISSION`, `SCENARIO_EXPECTATION_MISMATCH`                       |

Rules listed elsewhere as design ideas—such as event-loop lag, memory growth, reconnect handling, unsafe mentions, unexpected outbound network, PII retention, or source-code injection findings—are not implemented merely because the underlying domain has a validator or exception.

## Timing evidence

Core interaction timing is evaluated from virtual receipt to a valid initial response. Trace analysis can flag an interaction span at or beyond the configured deadline and a bot-handler span above its blocking threshold. Electron `/ping` records host duration and runtime timeout evidence, but the desktop does not yet separate handler, queue, dependency, REST, delivery, and render spans end to end.

CPU, memory, event-loop, queue, and imported-process throughput measurements are planned. The current core performance suite is a deterministic workload guard, not host-process profiling.

## Reports and UI

- JSON/HTML include current findings.
- JUnit represents scenario/assertion outcomes.
- SARIF converts current findings into result entries; source location exists only when the finding provides one.
- Risk Center can display runtime findings in Electron. Its score trend, export, baseline, suppression, and historical workflows are preview-only.

Recommendations should stay specific to collected evidence. New rules require a deterministic reproducer, negative case, severity rationale, bounded evidence, and a declaration of which layer—core, CLI, or Electron—emits them.
