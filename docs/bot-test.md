# Offline raw-Bot case tests

`bot-test` executes a real local child through the shared `createSession` API. It does not reinterpret the existing model-based `run` or `test` commands, install dependencies, connect to real Discord, or accept tokens. Offline transport is not an OS sandbox.

## Case v1

```json
{
  "version": 1,
  "execution": "bot",
  "name": "raw ping",
  "context": { "actorId": "3000", "guildId": "1000", "channelId": "2000" },
  "steps": [
    {
      "requestId": "ping-1",
      "input": "/ping",
      "expect": { "responseType": "message", "content": "Pong! Offline and deterministic." }
    }
  ]
}
```

Every shown key is required; extra keys are rejected. There are no model operations, regex expectations, implicit assertions, per-step timeouts, DM contexts or execution coercions. Files are limited to 1 MiB before JSON parsing. Names are 1–100 UTF-8 bytes, contexts have three nonempty NUL-free IDs of at most 128 bytes, steps number 1–100, request IDs match `[A-Za-z0-9_-]{1,64}` and are unique, input is 1–2,000 bytes using the existing command grammar, and expected text is 0–2,000 bytes. Parser output is detached and deeply frozen. Accessors, symbols, nonplain objects, sparse arrays and custom array properties are rejected.

The selected project must contain the actor, guild, and text channel, and the channel must belong to that guild. Runtime preflight additionally requires the selected actor, guild, and channel IDs to be canonical positive decimal unsigned 64-bit strings (`1` through `18446744073709551615`, without leading zeros). Noncanonical selected IDs are invalid-context errors before bot startup, not transport failures. This does not tighten the general fixture loader or model-only IDs; unselected unrelated fixture resources remain unchanged. The tests include channel 2100 as a non-first-channel positive control; cases do not implicitly select the first fixture channel. Before evaluating each result, the CLI verifies its run ID and actor/guild/channel. The evaluator separately verifies the request ID and exact whole message content. Readiness PONG, a missing response, a model-only result or a foreign authenticated identity never passes. Only a normalized response unchanged by export redaction/truncation may be evaluated; this is not a raw HTTP-byte equality claim. A transformed response is rejected with the fixed transport error `Authenticated response cannot be represented exactly and safely.`, giving runner-error/1 and no assertion for that step, without exposing the raw response. Assertions from earlier completed steps are retained. Safe wrong text is retained as actual mismatch evidence; expected text is never redacted or rewritten to manufacture a pass.

## Result and cleanup

The module exports `runBotTest(options, dependencies?)`. Its only injectable dependency is `createSession`, for unit testing. Production uses the same runtime as Desktop; it never spawns a child directly. The order is bounded read/parse, session creation, project selection, context validation, startup, sequential invoke/evaluate, disposal in `finally`, and final report writing. All steps are parsed before startup. First mismatch stops later steps; unexecuted steps are absent, not counted as passes.

The overall deadline covers preflight, startup and all steps, defaults to 30,000 ms, and accepts integers 1–300,000. Caller cancellation gives `cancelled` and exit 130 or 143. Deadline expiry is `runner-error`/1, not user cancellation. Disposal uses the shared runtime's independent shutdown window and is always awaited, including after partial startup. The module never installs global signal handlers or calls `process.exit`.

The exact report keys are `version`, `execution`, `adapter`, `name`, `runId`, `status`, `context`, `assertions`, `error`, and `cleanupErrors`. Version is 1, execution is `bot`, and adapter is `raw-interaction-webhook`. Success exits 0; mismatch or runner error 1; invalid input/project/context 2. Cleanup issues demote a pass to runner-error/1 and preserve earlier failed/invalid/cancelled outcomes and primary errors. Output failure is runner-error/1 except that cancellation retains 130/143. Prior primary issues are retained in `cleanupErrors`. Reports never include environment, authentication headers, runtime console output or arbitrary exception text.

With `outPath`, JSON is serialized only after disposal into an exclusive mode-0600 same-directory temporary file and renamed. Owned temporary files are removed on failure. An existing destination that cannot be replaced is not claimed as this run's result; callers must print the returned report, not read old output files.

## CLI usage

```text
disrunner bot-test <case.json> --project <directory> [--out <result.json>] [--timeout-ms <integer>]
```

The executable implements this command in `apps/cli/src/index.ts`. It requires one case file and `--project`, accepts only `--out` and `--timeout-ms` as additional options, and rejects unknown, duplicate or incomplete options. Timeout values must be decimal integers from 1 through 300000. The case and output paths must differ. Argument errors exit 2 through the CLI's existing error boundary. There are no `--format`, `--seed`, token, installation, network or adapter-selection options for this command.

The executable installs temporary SIGINT and SIGTERM handlers, passes cancellation to `runBotTest`, awaits cleanup, prints the finalized JSON report to stdout, and removes its handlers in `finally`. The first signal selects cancellation exit code 130 (SIGINT) or 143 (SIGTERM). The library module itself does not manage OS signals. `--out` writes the same finalized report, not a separate rendering or a previously existing result file.

`@disrunner/runtime` exports `createSession`, `parseBotCase`, `evaluateBotStep`, and the `BotCase` and `BotAssertion` types. The CLI imports these public exports; it does not use a private runtime import or a second child launcher.

## Independent oracles

`packages/runtime/tests/bot-case.test.mjs` supplies C01/C02 parser boundaries and evaluator C13 controls against the built pure module. `apps/cli/tests/bot-test.test.ts` explicitly separates structural fake-session error-path tests from real shared-session authenticated-child tests. Fake-session passes are not real-Bot evidence.

The fixture `server.mjs` verifies Ed25519 requests and uses the unchanged example's peer-auth algorithm copied with attribution into `peer-auth.mjs`. Modes preserve authentication while changing only behavior: wrong full text, PONG-only/no command reply, early zero/nonzero exit, stalled readiness/body, and unexpected exit after response. The original `wrong` control still sends `WRONG BOT RESPONSE`, but exact Session rejects its redaction projection before evaluation; neither raw nor projected content is exported into the report or fixture trace. A separate `wrong-safe` control sends fixed `Different offline reply.` and must produce an ordinary failed assertion against the unchanged canonical expectation. Additional explicitly unauthenticated/invalid-auth controls must fail. Expectations remain fixed in static JSON; the tested program never generates them.

Test-owned trace files distinguish launch, readiness, command receipt, callback, shutdown and exit. They contain IDs, PIDs and ports, never secrets or signed raw bodies. Real-child observers capture shared-session PIDs and endpoints; tests require PID death, refused loopback connections, and successful port reuse. If a recorded PID remains present, the cleanup assertion fails; the test does not signal a bare PID that may have been reused. The real session remains responsible for owned cleanup. The unchanged example is also executed separately as C03. These direct-child fixture checks do not establish process-tree or grandchild cleanup. Separate core and shared-runtime lifecycle tests are described in [Runtime lifecycle cleanup](runtime-lifecycle.md), including their platform and ownership limitations.

C01/C02 cover parsing and pre-spawn rejection. C03–C09 cover unchanged real Bot, the original redacted-response runner-error and separate safe-text mismatch, PONG-only, missing executable, both early exits and explicit fixture context. C10 covers startup/command/body AbortController cancellation. `apps/cli/tests/bot-test-command.test.ts` separately covers executable dispatch, flag rejection, finalized output and real SIGINT/SIGTERM cancellation. C11 covers independently injected primary/cleanup failures. C12 covers atomic final output, stale-file avoidance and write/rename failures. C13 covers missing response, identity/request mismatch, invalid peer authentication and stale-run rejection through the real session. C14 covers safe mismatch stop/cleanup and unexpected exit after callback. C15 uses the unchanged existing recording/replay, reporters and CLI error-boundary suites.

Use Node.js `>=22.23.2 <23` and the repository-pinned pnpm `11.19.0`. After dependencies are prepared, `pnpm run test:runtime` runs the runtime tests, and `pnpm run build:cli && pnpm --filter @disrunner/cli test:integration` builds the runtime dependency chain and CLI before running the CLI tests. The Bot command itself never installs dependencies. Fake sessions and the headless import checks are not substitutes for authenticated real-child tests.

These tests are not Gate G1 acceptance or SDK certification. Linux direct-child and lifecycle evidence does not establish Windows/macOS process-tree behavior, real CLI/Desktop parity or packaged interactive Desktop acceptance. Those require their own qualification; see [Runtime lifecycle cleanup](runtime-lifecycle.md) for the narrower lifecycle evidence and remaining gaps.

### C14 causal ordering

The Linux CLI oracle uses the real shared session and authenticated canonical callback. A test-only disposal observer releases the existing child exit gate, proves the original PID/starttime has reached a terminal state or disappeared, then invokes real disposal. The oracle independently requires the process proof, actual `child-exited` shutdown issue, CLI `runner-error`/exit 1, preserved exact successful callback assertion, and closed/reusable resources. Observer errors or timeouts cannot count as the expected runner failure. Cleanup always runs. The separate gated Session-level oracle remains in place.

This replaces the earlier unsupported race-only premise that local response completion plus a pre-`process.exit` trace line necessarily meant OS exit preceded expected-stop intent. The earlier race-only failure is not evidence of a pass; the causal oracle instead requires independent process-identity evidence. The contract requires unexpected exit before expected-stop intent to fail, not an arbitrary post-response quiescence delay. The identity-aware CLI oracle is Linux-only; other platform qualification remains pending.

## Current executable and Desktop parity status

The current implementation exports the bot-case helpers and wires the executable
`bot-test` command, help, validation and signal handling. The new
[parity harness](g1-acceptance.md) runs that built executable as a subprocess
against a frozen two-channel/singular-user corpus. Its separate actor-B project
uses the canonical config filename; it does not expand the loader.

CLI-only results must not be reported as G1: actual packaged Electron UI, preload,
IPC and real Session execution remain necessary. The harness adds no SDK support, performs no dependency installation and includes
no live-host network probe.
