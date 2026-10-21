import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { open, rename, unlink } from 'node:fs/promises';
import { dirname, basename, join } from 'node:path';
import {
  createSession,
  SessionError,
  parseBotCase,
  evaluateBotStep,
  type BotAssertion,
  type InvocationContext,
  type Session,
  type SessionIssue,
} from '@disrunner/runtime';

export interface BotTestOptions {
  readonly casePath: string;
  readonly projectDirectory: string;
  readonly outPath?: string;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  readonly cancellationExitCode?: 130 | 143;
}
export interface BotTestReport {
  readonly version: 1;
  readonly execution: 'bot';
  readonly adapter: 'raw-interaction-webhook';
  name: string | null;
  runId: string | null;
  status: 'passed' | 'failed' | 'invalid' | 'runner-error' | 'cancelled';
  context: InvocationContext | null;
  assertions: BotAssertion[];
  error: SessionIssue | null;
  cleanupErrors: SessionIssue[];
}
export interface BotTestDependencies {
  readonly createSession?: typeof createSession;
}
const MAX_CASE_BYTES = 1_048_576;

/** No global signal handlers or alternate launcher: root owns command wiring. */
export async function runBotTest(
  options: BotTestOptions,
  dependencies: BotTestDependencies = {},
): Promise<{ exitCode: number; report: BotTestReport }> {
  const report: BotTestReport = {
    version: 1,
    execution: 'bot',
    adapter: 'raw-interaction-webhook',
    name: null,
    runId: null,
    status: 'invalid',
    context: null,
    assertions: [],
    error: null,
    cleanupErrors: [],
  };
  let session: Session | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stage: 'case' | 'runtime' = 'case';
  const controller = new AbortController();
  const cancel = (): void => controller.abort(new SessionError('cancelled', 'Bot test cancelled.'));
  const signal = controller.signal;
  let deadlineAt = 0;
  const remaining = (maximum: number): number =>
    Math.max(1, Math.min(maximum, deadlineAt - Date.now()));
  const checkpoint = (): void => {
    if (!signal.aborted && Date.now() >= deadlineAt)
      controller.abort(new SessionError('timeout', 'Bot test overall deadline exceeded.'));
    signal.throwIfAborted();
  };
  try {
    const timeoutMs = options.timeoutMs ?? 30_000;
    if (
      !Number.isInteger(timeoutMs) ||
      timeoutMs < 1 ||
      timeoutMs > 300_000 ||
      typeof options.casePath !== 'string' ||
      options.casePath.length === 0 ||
      typeof options.projectDirectory !== 'string' ||
      options.projectDirectory.length === 0 ||
      (options.outPath !== undefined &&
        (typeof options.outPath !== 'string' || options.outPath.length === 0)) ||
      (options.cancellationExitCode !== undefined &&
        options.cancellationExitCode !== 130 &&
        options.cancellationExitCode !== 143)
    )
      throw new TypeError('Invalid bot-test options.');
    options.signal?.addEventListener('abort', cancel, { once: true });
    if (options.signal?.aborted) cancel();
    deadlineAt = Date.now() + timeoutMs;
    timer = setTimeout(
      () => controller.abort(new SessionError('timeout', 'Bot test overall deadline exceeded.')),
      timeoutMs,
    );
    checkpoint();
    const value: unknown = JSON.parse(await readCase(options.casePath, signal));
    const testCase = parseBotCase(value);
    report.name = testCase.name;
    report.context = Object.freeze({ ...testCase.context });
    stage = 'runtime';
    checkpoint();
    session = (dependencies.createSession ?? createSession)();
    await abortable(session.selectProject(options.projectDirectory), signal);
    checkpoint();
    const validated = session.validateContext(testCase.context);
    if (!sameContext(validated, testCase.context))
      throw new SessionError('transport', 'Preflight returned a different invocation context.');
    checkpoint();
    const started = await abortable(
      session.start({ signal, timeoutMs: remaining(60_000) }),
      signal,
    );
    if (typeof started.runId !== 'string' || started.runId.length === 0)
      throw new SessionError('transport', 'Startup did not return an active run ID.');
    const runId = started.runId;
    report.runId = runId;
    report.status = 'passed';
    for (const step of testCase.steps) {
      checkpoint();
      const result = await abortable(
        session.invoke(
          {
            runId,
            requestId: step.requestId,
            input: step.input,
            context: testCase.context,
          },
          { signal, timeoutMs: remaining(30_000) },
        ),
        signal,
      );
      checkpoint();
      // Never evaluate a callback belonging to another run, actor, guild or channel.
      if (result.runId !== runId || !sameContext(result.context, testCase.context))
        throw new SessionError(
          'transport',
          'Invocation result identity does not match the active case.',
        );
      if (
        !result.ok ||
        result.error !== null ||
        result.response === null ||
        result.response === undefined
      )
        throw new SessionError(
          'transport',
          'Invocation did not provide an actual successful response.',
        );
      const assertion = evaluateBotStep(step, result);
      report.assertions.push(assertion);
      if (!assertion.passed) {
        report.status = 'failed';
        break;
      }
    }
    if (report.status === 'passed') checkpoint();
  } catch (error: unknown) {
    const issue = signal.aborted
      ? sessionIssue(signal.reason)
      : stage === 'case' &&
          (error instanceof TypeError || error instanceof SyntaxError || isFileError(error))
        ? { code: 'invalid' as const, message: 'Bot case or options could not be validated.' }
        : sessionIssue(error);
    report.error = issue;
    report.status =
      issue.code === 'cancelled'
        ? 'cancelled'
        : issue.code === 'invalid'
          ? 'invalid'
          : 'runner-error';
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    options.signal?.removeEventListener('abort', cancel);
    // Shared session owns its independently bounded shutdown window; always await it.
    if (session !== undefined) {
      try {
        const shutdown = await session.dispose();
        report.cleanupErrors.push(
          ...shutdown.errors.map((issue) => ({ code: issue.code, message: issue.message })),
        );
        if (!shutdown.ok && shutdown.errors.length === 0)
          report.cleanupErrors.push({
            code: 'cleanup',
            message: 'Session cleanup did not confirm success.',
          });
      } catch {
        report.cleanupErrors.push({
          code: 'cleanup',
          message: 'Session disposal threw before cleanup was confirmed.',
        });
      }
      if (report.cleanupErrors.length > 0 && report.status === 'passed')
        report.status = 'runner-error';
    }
  }
  if (options.outPath !== undefined) {
    try {
      await writeReport(options.outPath, report);
    } catch {
      if (report.error !== null)
        report.cleanupErrors.push({
          code: 'cleanup',
          message: `Prior ${report.error.code} failure: ${report.error.message}`,
        });
      if (report.status === 'failed')
        report.cleanupErrors.push({
          code: 'cleanup',
          message: 'Prior assertion mismatch is retained in assertions; final output also failed.',
        });
      report.cleanupErrors.push({
        code: 'cleanup',
        message: 'Final report could not be written atomically; no current output file is claimed.',
      });
      if (report.status !== 'cancelled') {
        report.status = 'runner-error';
        report.error = { code: 'cleanup', message: 'Final report output failed.' };
      }
    }
  }
  return { exitCode: exitCode(report, options.cancellationExitCode ?? 130), report };
}

function sameContext(
  actual: InvocationContext | null | undefined,
  expected: InvocationContext,
): boolean {
  return (
    actual !== null &&
    actual !== undefined &&
    actual.actorId === expected.actorId &&
    actual.guildId === expected.guildId &&
    actual.channelId === expected.channelId
  );
}
function isFileError(error: unknown): boolean {
  if (!(error instanceof Error) || !('code' in error)) return false;
  return ['ENOENT', 'EACCES', 'EPERM', 'ENOTDIR', 'EISDIR', 'EINVAL', 'ENAMETOOLONG'].includes(
    String(error.code),
  );
}
function sessionIssue(error: unknown): SessionIssue {
  // The shared API guarantees redacted SessionError messages. Unknown exceptions
  // may carry environment/credentials, so never copy their arbitrary messages.
  if (error instanceof SessionError) return { code: error.code, message: error.message };
  return { code: 'transport', message: 'Unexpected bot test runner failure.' };
}
function exitCode(report: BotTestReport, cancellation: 130 | 143): number {
  if (report.status === 'cancelled') return cancellation;
  if (report.status === 'invalid') return 2;
  return report.status === 'passed' && report.cleanupErrors.length === 0 ? 0 : 1;
}
async function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let abort: (() => void) | undefined;
  const cancelled = new Promise<never>((_resolve, reject) => {
    abort = () => {
      const issue = sessionIssue(signal.reason);
      reject(new SessionError(issue.code, issue.message));
    };
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
  try {
    return await Promise.race([operation, cancelled]);
  } finally {
    if (abort !== undefined) signal.removeEventListener('abort', abort);
  }
}
async function readCase(path: string, signal: AbortSignal): Promise<string> {
  const file = await open(
    path,
    process.platform === 'win32' ? 'r' : constants.O_RDONLY | constants.O_NONBLOCK,
  );
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > MAX_CASE_BYTES)
      throw new TypeError('Bot case must be a regular file of at most 1 MiB.');
    const bytes = Buffer.alloc(MAX_CASE_BYTES + 1);
    let length = 0;
    while (length < bytes.length) {
      signal.throwIfAborted();
      const { bytesRead } = await file.read(bytes, length, bytes.length - length, null);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length > MAX_CASE_BYTES) throw new TypeError('Bot case exceeds 1 MiB.');
    return bytes.subarray(0, length).toString('utf8');
  } finally {
    await file.close();
  }
}
async function writeReport(path: string, report: BotTestReport): Promise<void> {
  const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  let owned = false;
  try {
    const file = await open(temporary, 'wx', 0o600);
    owned = true;
    try {
      await file.writeFile(JSON.stringify(report, null, 2) + '\n', 'utf8');
    } finally {
      await file.close();
    }
    await rename(temporary, path);
    owned = false;
  } finally {
    if (owned) await unlink(temporary);
  }
}
