# Debugging manual

Start by identifying which v0.1 surface failed. Core/CLI behavior, the Electron raw-webhook runtime, and seeded renderer previews do not share the same compatibility boundary.

## Evidence checklist

Record:

1. DisRunner version/commit, OS/architecture, Node `22.x`, and pnpm `11.19.0`.
2. The exact command, first error, and exit code.
3. For CLI runs: scenario/recording path, seed, mode, first failed assertion, final state hash, and the explicitly generated redacted report.
4. For Electron: selected configuration path, runtime phase/PID, endpoint presence (not credentials), bounded stdout/stderr, command result, trace/risk entries, and a screenshot.
5. Whether the behavior came from the real mutually authenticated `/ping` path or a seeded visual preview.

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

Check `discord-simulator.config.json` against the shipped schema and example. v0.1 accepts only `raw-interaction-webhook`. Paths must resolve inside the selected canonical project; Node/Python entry points must match the declared start command; configured adapter targets must be explicit `127.0.0.1` templates; real-looking credentials and execution-control environment variables are rejected.

### Process starts but readiness fails

The raw-webhook endpoint must bind the injected loopback port, accept the connection probe, verify the request with `DISRUNNER_PUBLIC_KEY`, and return PING bytes authenticated with `DISRUNNER_WEBHOOK_PEER_SECRET` within the startup timeout. The runtime verifies response authentication before JSON. Do not print either value; verify only that both 64-hex variables are present. A process that merely owns the port or returns `{ "type": 1 }` fails readiness without the correct `x-disrunner-webhook-response-auth` header. Review bounded output and run both transport suites:

```bash
pnpm run test:raw-webhook
pnpm --filter @disrunner/desktop run test:runtime-manager
```

### Stop leaves a PID or port

Capture the selected bot PID, runtime phase, output, and shutdown error. The runner attempts graceful stop and registered process-tree cleanup, then closes REST/Gateway services. Report a reproducible orphan as a defect; never kill unrelated processes by matching a broad name.

## Signed command and the three-second boundary

Electron currently sends one real signed application-command request and expects one mutually authenticated HTTP callback. Validate the command name (`/` plus 1–32 lowercase letters, digits, `_`, or `-`), that the runtime is `running`, and that the bot computes the response HMAC from the exact request timestamp/body, HTTP status, and exact serialized response bytes. Any reserialization after computing the MAC changes the digest.

The request times out after 3,000 ms of host time and records `INTERACTION_TIMEOUT`. Missing, malformed, wrong-key, status-changed, or body-changed authentication records `WEBHOOK_PEER_AUTHENTICATION_FAILED`; fix the transport/authentication contract before inspecting callback fields. Only an authenticated response that then has invalid JSON/data/type records `INVALID_INTERACTION_CALLBACK`. Core interaction scenarios separately test virtual-time immediate/deferred/follow-up transitions and the 900,000 ms token lifetime.

Electron v0.1 does not observe a deferred callback's later REST edit/follow-up. A seeded `/slow` browser-preview message is not evidence that the imported bot completed that lifecycle.

## Core permissions

Permission calculations are executable through the core and scenario helper paths. Check guild/owner/member IDs, the `@everyone` role ID, member role IDs, decimal bitfields, channel overwrites, parent/sync flags, timeout and explicit `nowMs`. Run hierarchy helpers separately when the operation manages a role/member.

The desktop Permissions panel is seeded; REST routes do not enforce these decisions. Do not diagnose a visual `403` as a live route result.

## Core Gateway

Gateway lifecycle and WebSocket transport are partial core-tested surfaces. Inspect local URL, synthetic token, HELLO/heartbeat/ACK, identify quota, READY session/sequence, close code, and resume inputs in a focused core test.

There is no supported imported-bot Gateway adapter or automatic desktop fixture dispatch in v0.1. Seeded reconnect UI behavior does not prove a framework client resumed.

## Core REST and rate limits

Check the exact route list in [REST emulator](rest-emulator.md), synthetic authorization, resource IDs, JSON body size/type, selected message validation, and caller-configured rate-limit rule. The built-in message-create bucket is five requests per five virtual seconds per channel/shared scope.

No v0.1 fault policy injects latency, server errors, resets, malformed bodies, or post-commit response loss. If the renderer shows those concepts, treat them as planned/visual preview.

## Replay divergence

CLI replay verifies the versioned recording envelope, normalized scenario hash, report/assertion/event data, and final state hash. Compare the first mismatching check plus seed, mode, scenario bytes, core/CLI version, and input file. Imported Electron bot execution is not captured by this recording format.

## Offline or security failure

If an imported bot attempts Discord/external traffic, stop it and remove any live credential. DisRunner does not intercept child sockets or emit a general egress finding. Reproduce only in an externally network-isolated VM/container.

For renderer request blocking, record the attempted URL category and application build without including query secrets. For a suspected leak, do not test with a live credential.

## CI, E2E, and packaging

- Match the runner OS and pinned toolchain.
- Read the first failing step and use only redacted artifacts.
- Distinguish core assertions, Electron package smoke, Playwright renderer E2E, packaging, signing/notarization configuration, dependency audit, and external service failures.
- A skipped or failed matrix target is not green platform evidence.

## High-quality bug report

Include expected/actual behavior, smallest reproducer, affected surface (core/CLI, real Electron webhook, or visual preview), version matrix, exact command/exit code, first failing assertion/span, final state hash when applicable, redacted output/report, and screenshot for UI defects. State which fields were removed. Use [SECURITY.md](../SECURITY.md) for vulnerabilities.
