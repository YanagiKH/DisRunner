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

The selected project must contain the actor, guild, and text channel. Channel 2100 is an intentional non-first-channel positive control. Before evaluating each result, the CLI verifies its run ID and actor/guild/channel. The evaluator separately verifies the request ID and exact whole message. Readiness PONG, a missing response, a model-only result or a foreign authenticated identity never passes. Only a normalized response unchanged by export redaction/truncation may be evaluated; this is not a raw HTTP-byte equality claim. A transformed response is rejected with the fixed transport error `Authenticated response cannot be represented exactly and safely.`, giving runner-error/1 and no assertions, without exposing the raw response. Safe wrong text is retained as actual mismatch evidence; expected text is never redacted or rewritten to manufacture a pass.

## Result and cleanup

The module exports `runBotTest(options, dependencies?)`. Its only injectable dependency is `createSession`, for unit testing. Production uses the same runtime as Desktop; it never spawns a child directly. The order is bounded read/parse, session creation, project selection, context validation, startup, sequential invoke/evaluate, disposal in `finally`, and final report writing. All steps are parsed before startup. First mismatch stops later steps; unexecuted steps are absent, not counted as passes.

The overall deadline covers preflight, startup and all steps, defaults to 30,000 ms, and accepts integers 1–300,000. Caller cancellation gives `cancelled` and exit 130 or 143. Deadline expiry is `runner-error`/1, not user cancellation. Disposal uses the shared runtime's independent shutdown window and is always awaited, including after partial startup. The module never installs global signal handlers or calls `process.exit`.

The exact report keys are `version`, `execution`, `adapter`, `name`, `runId`, `status`, `context`, `assertions`, `error`, and `cleanupErrors`. Version is 1, execution is `bot`, and adapter is `raw-interaction-webhook`. Success exits 0; mismatch or runner error 1; invalid input/project/context 2. Cleanup issues demote a pass to runner-error/1 and preserve earlier failed/invalid/cancelled outcomes and primary errors. Output failure is runner-error/1 except that cancellation retains 130/143. Prior primary issues are retained in `cleanupErrors`. Reports never include environment, authentication headers, runtime console output or arbitrary exception text.

With `outPath`, JSON is serialized only after disposal into an exclusive mode-0600 same-directory temporary file and renamed. Owned temporary files are removed on failure. An existing destination that cannot be replaced is not claimed as this run's result; callers must print the returned report, not read old output files.

## Root integration, not a Kuro-owned source edit

Root must add these exports to `packages/runtime/src/index.ts`:

```ts
export { parseBotCase, evaluateBotStep } from './bot-case.js';
export type { BotCase, BotAssertion } from './bot-case.js';
```

The original session API delta alone did not include these exports. Root subsequently delivered `disrunner-m1-root-bot-case-exports.json`: applying it to the Kuro source checkpoint tree `3a279643dbfb0c5aa68e89f4d6baa2462587d52f` yields `19eea7f593d146e93952e44dfcbcfd37f046af68`. Root's following `disrunner-m1-exact-response-handoff.json` yields fixed combined tree `03f606d69b77fcc1e3b17fd757304e20517fcd20` before recipient-owned test/documentation amendments. Verify all original bytes, payloads and preimages first. No worker-local runtime stub, private import or generated export shim is permitted. These deltas do not wire the executable command or OS signals.

Root owns command dispatch, help, flag validation and executable OS-signal tests. This standalone integration function is intended for `apps/cli/src/index.ts`, with its result awaited by root's existing main/error boundary:

```ts
import { runBotTest } from './bot-test.js';

async function dispatchBotTest(args: string[]): Promise<number> {
  const casePath = args[0];
  if (casePath === undefined || casePath.startsWith('--')) {
    throw new TypeError('bot-test requires one case path.');
  }
  const values = new Map<string, string>();
  const allowed = new Set(['--project', '--out', '--timeout-ms']);
  for (let i = 1; i < args.length; i += 2) {
    const flag = args[i];
    const value = args[i + 1];
    if (
      flag === undefined ||
      !allowed.has(flag) ||
      values.has(flag) ||
      value === undefined ||
      value.length === 0 ||
      value.startsWith('--')
    ) {
      throw new TypeError('Unknown, duplicate or incomplete bot-test option.');
    }
    values.set(flag, value);
  }
  const projectDirectory = values.get('--project');
  if (projectDirectory === undefined) throw new TypeError('--project is required.');
  const rawTimeout = values.get('--timeout-ms');
  const timeoutMs = rawTimeout === undefined ? 30_000 : Number(rawTimeout);
  if (
    (rawTimeout !== undefined && !/^\d+$/u.test(rawTimeout)) ||
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 300_000
  ) {
    throw new TypeError('--timeout-ms must be an integer from 1 through 300000.');
  }
  const controller = new AbortController();
  let cancellationExitCode: 130 | 143 = 130;
  const interrupt = (): void => {
    if (!controller.signal.aborted) {
      cancellationExitCode = 130;
      controller.abort();
    }
  };
  const terminate = (): void => {
    if (!controller.signal.aborted) {
      cancellationExitCode = 143;
      controller.abort();
    }
  };
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', terminate);
  try {
    // The getter supplies the final code chosen by the first OS signal.
    const outPath = values.get('--out');
    const result = await runBotTest({
      casePath,
      projectDirectory,
      timeoutMs,
      signal: controller.signal,
      get cancellationExitCode() {
        return cancellationExitCode;
      },
      ...(outPath === undefined ? {} : { outPath }),
    });
    process.stdout.write(JSON.stringify(result.report, null, 2) + '\n');
    return result.exitCode;
  } finally {
    process.off('SIGINT', interrupt);
    process.off('SIGTERM', terminate);
  }
}
```

In root's dispatcher, `bot-test` routes to `await dispatchBotTest(commandArgs)`. Invalid argument errors must use the existing exit-2 error boundary. The first matching help entry should show:

```text
disrunner bot-test <case.json> --project <directory> [--out <result.json>] [--timeout-ms <integer>]
```

## Independent oracles

`packages/runtime/tests/bot-case.test.mjs` supplies C01/C02 parser boundaries and evaluator C13 controls against the built pure module. `apps/cli/tests/bot-test.test.ts` explicitly separates structural fake-session error-path tests from real shared-session authenticated-child tests. Fake-session passes are not real-Bot evidence.

The fixture `server.mjs` verifies Ed25519 requests and uses the unchanged example's peer-auth algorithm copied with attribution into `peer-auth.mjs`. Modes preserve authentication while changing only behavior: wrong full text, PONG-only/no command reply, early zero/nonzero exit, stalled readiness/body, and unexpected exit after response. The original `wrong` control still sends `WRONG BOT RESPONSE`, but exact Session rejects its redaction projection before evaluation; neither raw nor projected content is exported into the report or fixture trace. A separate `wrong-safe` control sends fixed `Different offline reply.` and must produce an ordinary failed assertion against the unchanged canonical expectation. Additional explicitly unauthenticated/invalid-auth controls must fail. Expectations remain fixed in static JSON; the tested program never generates them.

Test-owned trace files distinguish launch, readiness, command receipt, callback, shutdown and exit. They contain IDs, PIDs and ports, never secrets or signed raw bodies. Real-child observers capture shared-session PIDs and endpoints; tests require PID death, refused loopback connections, and successful port reuse. If a recorded PID remains present, the cleanup assertion fails; the test does not signal a bare PID that may have been reused. The real session remains responsible for owned cleanup. The unchanged example is also executed separately as C03. Core process-tree/grandchild qualification belongs to fufu; direct-child fixture evidence must not be promoted to that claim.

C01/C02 cover parsing and pre-spawn rejection. C03–C09 cover unchanged real Bot, the original redacted-response runner-error and separate safe-text mismatch, PONG-only, missing executable, both early exits and explicit fixture context. C10 covers startup/command/body AbortController cancellation; root separately owns real OS signals. C11 covers independently injected primary/cleanup failures. C12 covers atomic final output, stale-file avoidance and write/rename failures. C13 covers missing response, identity/request mismatch, invalid peer authentication and stale-run rejection through the real session. C14 covers safe mismatch stop/cleanup and unexpected exit after callback. C15 uses the unchanged existing recording/replay, reporters and CLI error-boundary suites.

Use the pinned Node 22.23.2/pnpm 11.19.0 and the scoped commands required by the immutable root handoff after its deltas land. Environment preparation is separate: the explicit root authorization allows `pnpm install --frozen-lockfile --ignore-scripts`, preferring cache and only filling original lock resolutions from the official registry, without changing versions/lockfile, install scripts or audit. The Bot command itself never installs. Do not run acceptance against stubs or modify shared source to make an oracle pass. Root runs combined `verify`, actual command and Desktop/packaged parity after integration. Untested Windows/macOS, Desktop and G1 remain pending; no SDK certification is implied.

### C14 causal ordering

The Linux CLI oracle uses the real shared session and authenticated canonical callback. A test-only disposal observer releases the existing child exit gate, proves the original PID/starttime has reached a terminal state or disappeared, then invokes real disposal. The oracle independently requires the process proof, actual `child-exited` shutdown issue, CLI `runner-error`/exit 1, preserved exact successful callback assertion, and closed/reusable resources. Observer errors or timeouts cannot count as the expected runner failure. Cleanup always runs. The separate gated Session-level oracle remains in place.

This replaces the earlier unsupported race-only premise that local response completion plus a pre-`process.exit` trace line necessarily meant OS exit preceded expected-stop intent. That first failure and source are preserved in review evidence; they are not reclassified as a pass. The contract requires unexpected exit before expected-stop intent to fail, not an arbitrary post-response quiescence delay. The identity-aware CLI oracle is Linux-only; other platform qualification remains pending.
