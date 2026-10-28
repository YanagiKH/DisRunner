# Troubleshooting

Use [Debugging](debugging.md) for a detailed report checklist. Record the DisRunner version, adapter, exact SDK/interpreter, first error, and a minimal redacted scenario.

| Symptom                            | Check first                                                                       | Action                                                                                       |
| ---------------------------------- | --------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| App opens blank                    | Main/renderer error and blocked request                                           | Check package resources; keep Electron isolation enabled                                     |
| Project selection fails            | Config version, supported adapter, entry/cwd paths, workspace status              | Compare with the matching shipped example and [configuration](project-configuration.md)      |
| SDK version rejected               | Dependency resolved from the entry file or Python environment                     | Prepare discord.js 14.27.0 or discord.py 2.6.4 in that exact project/environment             |
| Wrong Python environment           | Quoted absolute interpreter path in `startCommand`                                | Use the intended virtual environment's executable and verify `--version`/`pip show` there    |
| Bot stays starting                 | Process output, normal SDK login, selected intents, raw readiness                 | Fix the startup diagnostic; a live PID alone is not readiness                                |
| Raw response authentication fails  | Presence of injected key/secret, exact timestamp/status/body bytes                | Use the bundled peer-auth helper and avoid reserializing after computing the HMAC            |
| Command is absent                  | SDK registration/sync, registry profile, guild allowlist                          | Start the correct project and register into the local application/guild                      |
| Prefix command receives no text    | Guild/DM context and requested MESSAGE_CONTENT intent                             | Enable the matching local allowlist and SDK intent, or test the documented exempt context    |
| Deferred reply remains loading     | Initial callback, later original edit, token expiry, output                       | Inspect the actual callback/REST failure and await the completed message in the scenario     |
| Component/modal does nothing       | Source message, custom ID, disabled state, selected actor, modal fields           | Use the current message instance and supported legacy component profile                      |
| Ephemeral message is missing       | Selected actor and interaction ownership                                          | Select its owning actor; private messages are omitted from other/public views                |
| Permission denied                  | Explicit guild/member/role/overwrite state and hierarchy                          | Correct fixtures; lenient payload mode does not grant permissions                            |
| REST returns 401/404/501           | Synthetic authorization, route token/application, supported route and resource ID | Use the documented local profile and inspect the first route error                           |
| Repeated 429                       | Bucket/major resource, retry headers, configured fault plan                       | Respect retry timing and inspect intentional faults; quotas are a local profile              |
| Gateway cannot resume              | READY's dynamic URL, session/token/sequence, retained replay window               | Reconnect within the valid session/window or start a fresh session                           |
| Scenario unexpectedly passes/fails | Execution version, saved resources, actual assertions and severity policy         | Keep model and real Bot modes distinct; inspect expected/unconsumed errors and completeness  |
| Declared fault never activates     | Route/method/event filter and actual adapter path                                 | Match `/interactions` for raw dispatch or the SDK's API route; unused plans fail             |
| Workspace save conflict            | Another instance or external edit                                                 | Reload, reconcile, and save again rather than replacing unseen changes                       |
| Workspace is corrupt/newer         | Format version and valid backup                                                   | Use explicit recovery for supported data; do not overwrite a newer version with an older app |
| Stop leaves a PID/port             | Selected process, phase and cleanup error                                         | Retry reported cleanup or report a minimal defect; do not target unrelated processes by name |
| Bot contacts an external service   | Custom networking, `.env`, native code or subprocess                              | Remove live secrets and use OS network isolation; SDK guards do not sandbox arbitrary code   |
| OS reports an unsigned package     | Canonical release, checksum, publisher and signing notes                          | Verify the actual artifact; a build target is not a signature                                |

## Resetting or restoring project data

Stop the active run before reloading a workspace. Settings can reload saved data or explicitly restore a valid previous save. Recovery preserves replaced bytes separately and does not start a Bot. See [Workspaces](workspaces.md).

The browser demo's in-memory examples are separate from project workspaces. Restarting the application is not a substitute for saving or restoring project files. Exported reports and recordings are ordinary files at the paths you chose.

## Getting help

Search existing issues, then submit the smallest redacted reproduction through the appropriate issue form. Include the first failing assertion and distinguish a model test, real Bot run, and installed Desktop result. Follow [SECURITY.md](../SECURITY.md) for vulnerability reports.
