# v1.0 requirements and evidence

The [capability manifest](capability-manifest.json) identifies the supported profiles, limits and test entry points. Source tests, real Bot conformance, packaged UI tests and installer operation receipts establish different layers of behavior. A source checkout alone does not certify a platform or a signed release.

| Requirement | Implemented surface                           | Main evidence                                                                                                                                                                                                                                       |
| ----------- | --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| V01         | Project lifecycle and diagnostics             | [runtime-command-registry-config.test.mjs](../../packages/runtime/tests/runtime-command-registry-config.test.mjs) · [adapter-boundaries.test.mjs](../../tests/conformance/adapter-boundaries.test.mjs)                                              |
| V02         | Real Bot lifecycle                            | [sdk-sessions.test.mjs](../../tests/conformance/sdk-sessions.test.mjs) · [raw-session.test.mjs](../../tests/conformance/raw-session.test.mjs)                                                                                                       |
| V03         | Fixtures and authoritative state              | [resource-domain.test.ts](../../packages/core/tests/integration/resource-domain.test.ts) · [workspace.test.mjs](../../packages/runtime/tests/workspace.test.mjs)                                                                                    |
| V04         | Application command registry                  | [application-command-v2.test.ts](../../packages/core/tests/unit/application-command-v2.test.ts) · [sdk-transports.test.mjs](../../tests/conformance/sdk-transports.test.mjs)                                                                        |
| V05         | Typed commands and autocomplete               | [runtime-action-contract.test.mjs](../../packages/runtime/tests/runtime-action-contract.test.mjs) · [sdk-transports.test.mjs](../../tests/conformance/sdk-transports.test.mjs)                                                                      |
| V06         | Interaction response lifecycle                | [interaction-v1-profile.test.ts](../../packages/core/tests/integration/interaction-v1-profile.test.ts) · [interaction-message-route-contract.test.ts](../../packages/core/tests/integration/interaction-message-route-contract.test.ts)             |
| V07         | Legacy components and modal controls          | [interaction-message-components.test.ts](../../packages/core/tests/unit/interaction-message-components.test.ts) · [sdk-transports.test.mjs](../../tests/conformance/sdk-transports.test.mjs)                                                        |
| V08         | Message rendering and local attachments       | [local-attachments.test.ts](../../packages/core/tests/integration/local-attachments.test.ts) · [sdk-ui-smoke.mjs](../../apps/desktop/tests/e2e/sdk-ui-smoke.mjs)                                                                                    |
| V09         | Permissions and intents                       | [sdk-rest-profile.test.ts](../../packages/core/tests/integration/sdk-rest-profile.test.ts) · [runtime-action-contract.test.mjs](../../packages/runtime/tests/runtime-action-contract.test.mjs)                                                      |
| V10         | Gateway lifecycle and cache bootstrap         | [gateway-fixture-bootstrap.test.ts](../../packages/core/tests/integration/gateway-fixture-bootstrap.test.ts) · [gateway-faults.test.ts](../../packages/core/tests/integration/gateway-faults.test.ts)                                               |
| V11         | Real Bot scenarios and assertions             | [scenario-v2.test.mjs](../../packages/runtime/tests/scenario-v2.test.mjs) · [scenario-v2-command.test.ts](../../apps/cli/tests/scenario-v2-command.test.ts)                                                                                         |
| V12         | Workspaces, recordings and diagnostic bundles | [reproduction.test.mjs](../../packages/runtime/tests/reproduction.test.mjs) · [recording.ts](../../apps/cli/src/recording.ts)                                                                                                                       |
| V13         | Reports and result policy                     | [scenario-v2.test.mjs](../../packages/runtime/tests/scenario-v2.test.mjs) · [reporters.test.ts](../../apps/cli/tests/reporters.test.ts)                                                                                                             |
| V14         | Scoped faults                                 | [fault-policy.test.ts](../../packages/core/tests/unit/fault-policy.test.ts) · [sdk-sessions.test.mjs](../../tests/conformance/sdk-sessions.test.mjs)                                                                                                |
| V15         | Recovery, cancellation and cleanup            | [bot-runner-lifecycle.test.ts](../../packages/core/tests/integration/bot-runner-lifecycle.test.ts) · [cleanup-failures.test.mjs](../../packages/runtime/tests/cleanup-failures.test.mjs) · [qualify-runtime.mjs](../../scripts/qualify-runtime.mjs) |
| V16         | Desktop workflows and live evidence           | [package-smoke.mjs](../../apps/desktop/tests/e2e/package-smoke.mjs) · [sdk-ui-smoke.mjs](../../apps/desktop/tests/e2e/sdk-ui-smoke.mjs)                                                                                                             |
| V17         | Platform installation and distribution        | [offline-conformance.sh](../../.github/scripts/offline-conformance.sh) · [bundle-cli.mjs](../../scripts/bundle-cli.mjs)                                                                                                                             |
| V18         | Release integrity and signing                 | [verify-windows-release.ps1](../../.github/scripts/verify-windows-release.ps1) · [verify-macos-release.sh](../../.github/scripts/verify-macos-release.sh)                                                                                           |

## Verification commands

Use Node 22.23.2, pnpm 11.19.0 and Python 3.12.14 with the locked SDK dependencies prepared before offline execution.

```bash
pnpm install --frozen-lockfile
pnpm run verify:release
DISRUNNER_TEST_PYTHON=python pnpm run test:conformance
bash .github/scripts/offline-conformance.sh
```

CI additionally executes the raw and SDK desktop workflows from packaged applications on each target. Release jobs operate the final NSIS/DMG/AppImage distributions, repeat installation with an external workspace, and verify removal/cleanup. Their source SHA, platform, installer digest and results are saved in installation receipts.

The Linux `Runtime qualification` CI job runs a three-cycle, 15-second smoke measurement for pull requests. Main pushes and manual runs require 100 cycles per adapter and a two-hour soak. Its [measurement tests](../../tests/qualification/runtime-qualification.test.mjs) and [receipt validator](../../.github/scripts/verify-runtime-qualification.mjs) check observed latency/RSS, process/listener cleanup, source identity and unchanged built artifact hashes. A smoke receipt remains unqualified. The completed run and receipt establish the measurement; the script's presence does not.

## Release evidence

A release is qualified only by its own successful workflow and downloaded artifacts. Publication requires a passing full runtime receipt from the same SHA's successful canonical main-push CI run; the publish job validates that report against freshly built runtime/adapter hashes and includes `disrunner-<tag>-runtime-qualification.json` in checksums and provenance. Stable publication also requires current trusted checks, native signing/notarization verification, four installation receipts, the offline CLI archive and SBOM. Beta/RC assets are explicitly prereleases.

The runtime measurement covers the shared runtime and three example Bot processes on a Linux host. It does not establish desktop rendering, installer behavior, minimum OS certification or CPU utilization.

Hosted CI currently uses Windows Server, Ubuntu and macOS runners; this is distinct from a direct test of every minimum OS target. [Installation](../installation.md) states the corresponding boundary.

## Data and replay boundaries

Workspace and model recordings are versioned. Real Bot scenarios start fresh processes and compare semantic assertions. Diagnostic bundles contain scenarios, fixtures, hashes and redacted results, require the original project, and explicitly do not claim to restore Bot memory or include its dependencies. Incomplete observation, unsupported settings, uncaught handler errors and cancelled/failed cleanup cannot yield a passing test.

## Supported scope

The first release covers the declared legacy component, command, message, permission, intent and transport profiles. Components V2, voice, arbitrary SDK versions, sharding and general untrusted-code isolation remain outside that scope. See [Compatibility](../../COMPATIBILITY.md) and [Limitations](../limitations.md).
