# Risk engine

The risk collector turns selected core/runtime evidence into findings. Its rule catalog is intentionally small. Absence of a finding does not prove that a Bot is safe, correct, or production-ready.

## Finding shape

Implemented findings contain a rule ID, severity, confidence, title, evidence, impact, and recommendation. Trace/event/source/reproduction/documentation/suppression/timestamp fields are optional and appear only when the emitting path supplies them.

Persistent baselines, suppression editing, owner/expiry policies, and historical trends are not available. Version 1 model runs fail for failed assertions; findings affect that verdict when assertions require them to be absent. Scenario v2 additionally enforces `policy.failOnSeverity`, defaulting to `high`. Expected request errors do not disable that independent policy. Unexpected structured SDK handler failures and incomplete evidence fail the run regardless of the chosen severity threshold.

## Implemented rule IDs

| Source                | Rules                                                                                                    |
| --------------------- | -------------------------------------------------------------------------------------------------------- |
| Interaction lifecycle | `DOUBLE_INTERACTION_RESPONSE`, `FOLLOWUP_BEFORE_ACK`, `EXPIRED_INTERACTION_TOKEN`, `INTERACTION_TIMEOUT` |
| Trace analysis        | `INTERACTION_ACK_LATE`, `BLOCKING_HANDLER`                                                               |
| Scenario helper paths | `RATE_LIMIT_HOT_BUCKET`, `MISSING_BOT_PERMISSION`, `SCENARIO_EXPECTATION_MISMATCH`                       |
| Electron raw webhook  | `WEBHOOK_PEER_AUTHENTICATION_FAILED`, `INVALID_INTERACTION_CALLBACK`, `INTERACTION_TIMEOUT`              |

Rules listed elsewhere as design ideas—such as event-loop lag, memory growth, reconnect handling, unsafe mentions, unexpected outbound network, PII retention, or source-code injection findings—are not implemented merely because the underlying domain has a validator or exception.

## Timing evidence

Core model timing is evaluated from virtual receipt to a valid initial response. Trace analysis can flag an interaction span at or beyond the configured deadline and a bot-handler span above its blocking threshold. Real raw/SDK sessions use host time. Desktop does not separate handler, queue, dependency, REST, delivery, and render durations end to end.

CPU, memory, event-loop, queue, and imported-process throughput are not profiled. The core performance suite is a deterministic workload guard, not host-process profiling.

## Reports and UI

- Version 1 JSON/HTML include findings, JUnit represents assertion outcomes, and SARIF converts findings into results. Source locations exist only when supplied by the emitting rule.
- Scenario v2 exports JSON/JUnit/HTML/SARIF with its actual assertion, runtime, severity-policy, and completeness verdicts; retained runtime findings are available in its snapshot.
- Risk Center displays runtime findings in Electron. Historical scores, persistent baselines, and suppression workflows are not implemented.

Recommendations should stay specific to collected evidence. New rules require a deterministic reproducer, negative case, severity rationale, bounded evidence, and a declaration of which layer—core, CLI, or Electron—emits them.
