# Troubleshooting

Use [Debugging](debugging.md) for the complete evidence checklist.

| Symptom                                             | Check first                                                             | Current v0.1 direction                                                                                |
| --------------------------------------------------- | ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| App opens blank                                     | main/renderer error and blocked CSP/request                             | fix the bundle/content; keep Electron isolation enabled                                               |
| Project selection fails                             | version 1 config, canonical paths, supported adapter                    | use the shipped raw-webhook example as the schema reference                                           |
| Bot stays `starting`                                | command/cwd, injected loopback port, readiness and signed PING          | make the raw webhook bind and verify the generated key; process start alone is not readiness          |
| Bot tries Discord                                   | child code, its `.env`, and SDK configuration                           | stop it, remove live credentials, and use OS-level network isolation; v0.1 cannot block child sockets |
| Real `/ping` times out                              | runtime phase, endpoint, handler duration, one callback within 3,000 ms | return a valid initial callback before slow work                                                      |
| Deferred follow-up is absent                        | callback type and current Electron boundary                             | later edit/follow-up observation is planned; use a core interaction scenario for lifecycle tests      |
| Permission result surprises in core/CLI             | IDs, roles, overwrites, timeout/`nowMs`, separate hierarchy helper      | correct the scenario inputs; desktop permission panels are seeded and REST does not enforce them      |
| REST returns `401`/`404`                            | synthetic authorization, exact implemented route, state resource IDs    | use only the partial route table; unsupported routes fail closed                                      |
| Repeated core `429`                                 | configured rule, channel major parameter, virtual clock/reset           | respect the returned `Retry-After`; no automatic retry queue ships                                    |
| Gateway client cannot connect/resume in a core test | local URL/token, identify, heartbeat/ACK, session/sequence              | fix the partial core protocol contract; no supported desktop Gateway adapter ships                    |
| Browser preview changes after restart               | seeded renderer state                                                   | persistence is not implemented in v0.1                                                                |
| Stop leaves PID/port                                | runtime phase, selected PID, shutdown output                            | report a reproducible cleanup defect; do not kill unrelated names broadly                             |
| Replay differs                                      | recording/scenario hash, seed/mode, first mismatching check             | replay covers CLI/core evidence, not an imported Electron bot run                                     |
| Mirror release has not appeared                     | target repository mirror workflow run and canonical release assets      | dispatch the target poll only after the canonical release is complete and attested                    |
| OS warns that a package is unsigned                 | release notes, checksum/provenance, signing status                      | do not bypass an unexpected warning; packaging does not itself prove signing/notarization             |

## Resetting the Preview UI

v0.1 has no persistent workspace database or supported clear-data/archive workflow. Stop the selected process and restart the app to reset in-memory/seeded UI state. Do not recursively delete an unknown application-data or project directory.

CLI-created reports and recordings are ordinary explicitly requested files; preserve or remove them using their exact paths after review.

## Getting help

Search existing issues, then use the appropriate GitHub issue form with the minimal redacted evidence from [Debugging](debugging.md#high-quality-bug-report). Report vulnerabilities privately under [SECURITY.md](../SECURITY.md).
