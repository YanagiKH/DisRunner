# Debugging manual

Identify the execution mode and adapter first: version 1 model, raw webhook, discord.js, or discord.py. Desktop and CLI share the runtime, while the browser demo has no process bridge.

## Evidence checklist

Record:

1. DisRunner version/commit, OS/architecture, Node `22.23.2`, pnpm `11.19.0`, and Python `3.12.14` for discord.py.
2. The exact command, first error, and exit code.
3. For CLI runs: scenario/recording path, seed, mode, first failed assertion, final state hash, and the explicitly generated redacted report.
4. For Electron: selected configuration path, runtime phase/PID, endpoint presence (not credentials), bounded stdout/stderr, command result, trace/risk entries, and a screenshot.
5. Whether the behavior came from a real project run or the browser demo; include the exact SDK and interpreter versions.

Never paste a token, private key, raw private conversation, or full environment dump.

## Verification commands

```bash
node --version
pnpm --version
pnpm run check:versions
pnpm run format:check
pnpm run lint
pnpm run typecheck
pnpm run test:unit
pnpm run test:contract
pnpm run test:integration
pnpm run test:offline
pnpm run test:security
pnpm run test:desktop
pnpm run test:runtime
pnpm run test:conformance
pnpm --filter @disrunner/desktop run test:runtime-manager
pnpm run test:raw-webhook
pnpm run test:secret-scanner
pnpm run build
```

`pnpm run verify` runs the merge-oriented gate. `pnpm run verify:release` also adds Electron E2E and the deterministic core performance guard. Investigate why a result changed; repeated reruns alone do not establish reliability.

## Install or build failures

- Run from the repository root with Node `>=22.23.2 <23` and pnpm exactly `11.19.0`.
- Keep `pnpm-lock.yaml`; use `pnpm install --frozen-lockfile` for reproduction.
- Read the first package/lifecycle error and verify available disk space, proxy/certificate policy, platform architecture, and native packaging prerequisites.
- Do not delete the lockfile/cache as a first response; that changes the evidence.
- `apps/*`, `packages/*`, and `examples/*` must be present. Run the failing workspace script directly to isolate orchestration from package code.

## Electron startup

### Blank or blocked window

Check the main-process and renderer errors separately. `pnpm run dev:web` exercises only the browser renderer; it does not exercise Electron IPC, security settings, project loading, process control, or the mutually authenticated webhook path. Do not disable CSP, context isolation, request filtering, or sandboxing to hide an error.

### Project remains `ready` or enters `error`

Check `discord-simulator.config.json` against the shipped schema and example. Supported adapter IDs are `raw-interaction-webhook`, `discord.js`, and `discord.py`; SDK versions are pinned. Paths must resolve inside the selected canonical project; Node/Python entry points must match the declared start command; configured adapter targets must be explicit `127.0.0.1` templates; real-looking credentials and execution-control environment variables are rejected.

### Process starts but readiness fails

The raw-webhook endpoint must bind the injected loopback port, accept the connection probe, verify the request with `DISRUNNER_PUBLIC_KEY`, and return PING bytes authenticated with `DISRUNNER_WEBHOOK_PEER_SECRET` within the startup timeout. The runtime verifies response authentication before JSON. Do not print either value; verify only that both 64-hex variables are present. A process that merely owns the port or returns `{ "type": 1 }` fails readiness without the correct `x-disrunner-webhook-response-auth` header. Review bounded output and run both transport suites:

```bash
pnpm run test:raw-webhook
pnpm --filter @disrunner/desktop run test:runtime-manager
```

For an SDK project, check the exact SDK version, the configured Node/Python executable, local REST bootstrap, and Gateway IDENTIFY/READY. Install SDK dependencies before offline use. An unsupported SDK or interpreter produces an explicit compatibility diagnostic; a listening process alone is not readiness.

### Stop leaves a PID or port

Capture the selected bot PID, runtime phase, output, and shutdown error. The runner attempts graceful stop and registered process-tree cleanup, then closes REST/Gateway services. Report a reproducible orphan as a defect; never kill unrelated processes by matching a broad name.

## Signed command and the three-second boundary

The raw-webhook adapter sends a signed interaction and expects an authenticated initial HTTP callback. SDK projects instead use local Gateway delivery and REST callback routes. For the simple `/name` shortcut, names use 1–32 lowercase letters, digits, `_`, or `-`; Command Explorer additionally validates the registered type/options. Confirm the runtime is `running`. Raw Bots must compute the response HMAC from the exact request timestamp/body, HTTP status, and serialized response bytes; reserialization after computing the MAC changes the digest.

The default dispatch timeout is 3,000 ms of host time; Scenario v2 can set bounded action/observation timeouts within its overall deadline. Failures appear as typed issues and error traces. The legacy raw shortcut additionally emits `INTERACTION_TIMEOUT`, `WEBHOOK_PEER_AUTHENTICATION_FAILED`, or `INVALID_INTERACTION_CALLBACK` findings. Fix response authentication before inspecting callback fields. Version 1 model scenarios separately control virtual-time transitions and the 900,000 ms token lifetime.

A deferred acknowledgement is not the final message. Supported later edits/followups update retained state and the selected actor's live view. In Scenario v2, use `await-response`/`await-message` and assert final content or interaction status. Unexpected structured handler diagnostics still fail a run after an initial reply, and tracked handlers must finish before the overall deadline.

## Core permissions

Permission calculations are executable through the core and scenario helper paths. Check guild/owner/member IDs, the `@everyone` role ID, member role IDs, decimal bitfields, channel overwrites, parent/sync flags, timeout and explicit `nowMs`. Run hierarchy helpers separately when the operation manages a role/member.

Check the active permission profile: SDK projects default to enforcement, while raw projects retain legacy behavior unless opted in. Ordinary message routes enforce their narrow Bot profile; v2 resource routes enforce their declared permission/hierarchy checks. The action driver and actor view separately check the human context and channel visibility. Inspect the actual denial and retained roles/overwrites, rather than a browser-demo permission label.

## Core Gateway

Gateway lifecycle and WebSocket transport are partial core-tested surfaces. Inspect local URL, synthetic token, HELLO/heartbeat/ACK, identify quota, READY session/sequence, close code, and resume inputs in a focused core test.

The pinned SDK adapters consume this local Gateway. Check actual READY/RESUMED events, session/sequence data, and Bot output when diagnosing reconnects. A generic Gateway process or an SDK version outside the pinned profiles is unsupported. Saved fixture changes apply to the next clean run.

## Core REST and rate limits

Check the exact route list in [REST emulator](rest-emulator.md), synthetic authorization, resource IDs, JSON body size/type, selected message validation, and caller-configured rate-limit rule. The built-in message-create bucket is five requests per five virtual seconds per channel/shared scope.

Scenario v2 can apply session-scoped HTTP delay/timeout/429/5xx and Gateway disconnect/duplicate plans. Check `metadata.faultEvidence`, route/event filters, and occurrence counts; an unused declared plan fails. Stop/reset clears pending effects. Malformed/partial responses, arbitrary packet loss/reorder, and commit-then-lose-response behavior remain unsupported. See [Fault injection](fault-injection.md).

## Replay divergence

CLI replay verifies the versioned recording envelope, normalized scenario hash, report/assertion/event data, and final state hash. Compare the first mismatching check plus seed, mode, scenario bytes, core/CLI version, and input file. Imported Electron bot execution is not captured by this recording format.

For real Bot runs, export a diagnostic bundle from Scenario Lab or run `disrunner repro <scenario> --out bundle.json`. It records redacted inputs/results and entry-file digests, identifies changed inputs, and requires the original project for a fresh rerun. It is not a process checkpoint or standalone replay archive.

## Offline or security failure

If an imported bot attempts Discord/external traffic, stop it and remove any live credential. DisRunner does not intercept child sockets or emit a general egress finding. Reproduce only in an externally network-isolated VM/container.

For renderer request blocking, record the attempted URL category and application build without including query secrets. For a suspected leak, do not test with a live credential.

## CI, E2E, and packaging

- Match the runner OS and pinned toolchain.
- Read the first failing step and use only redacted artifacts.
- Distinguish core assertions, Electron package smoke, Playwright renderer E2E, packaging, signing/notarization configuration, dependency audit, and external service failures.
- A skipped or failed matrix target is not green platform evidence.

## High-quality bug report

Include expected/actual behavior, the smallest reproducer, affected surface (model, raw/SDK Session, Desktop, or browser demo), version matrix, command/exit code, first failing assertion/span, relevant input/state hashes, redacted report/bundle, and a screenshot for UI defects. Review exports and state which fields were removed. Use [SECURITY.md](../SECURITY.md) for vulnerabilities.
