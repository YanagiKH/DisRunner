import { afterEach, describe, expect, it } from 'vitest';
import { cp, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createConnection, createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import {
  createSession,
  SessionError,
  type InvocationRequest,
  type Session,
  type SessionInvocationResult,
  type SessionSnapshot,
  type ShutdownResult,
  type RuntimeEndpoints,
} from '@disrunner/runtime';
import { runBotTest, type BotTestOptions } from '../src/bot-test.js';

const fixtures = fileURLToPath(new URL('./fixtures/bot-test/', import.meta.url));
const repository = fileURLToPath(new URL('../../../', import.meta.url));
const canonicalText = 'Pong! Offline and deterministic.';
const context = Object.freeze({ actorId: '3000', guildId: '1000', channelId: '2000' });
const temporary: string[] = [];
afterEach(async () => {
  for (const path of temporary.splice(0)) await rm(path, { recursive: true, force: true });
});
async function directory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'disrunner-bot-test-'));
  temporary.push(path);
  return path;
}
async function caseFile(
  directory: string,
  edit?: (value: Record<string, unknown>) => void,
): Promise<string> {
  const value = JSON.parse(await readFile(join(fixtures, 'case-pass.json'), 'utf8')) as Record<
    string,
    unknown
  >;
  edit?.(value);
  const path = join(directory, 'case.json');
  await writeFile(path, JSON.stringify(value));
  return path;
}
function snapshot(): SessionSnapshot {
  return {
    schemaVersion: 1,
    sessionId: 'unit-session',
    runId: 'unit-run',
    revision: 1,
    disposed: false,
    contexts: [context],
    phase: 'running',
    project: null,
    error: null,
    pid: null,
    endpoints: null,
    output: [],
    traces: [],
    risks: [],
  };
}
function response(request: InvocationRequest): SessionInvocationResult {
  return {
    runId: request.runId,
    requestId: request.requestId,
    context: { ...request.context },
    ok: true,
    error: null,
    command: 'ping',
    interactionId: 'observed-unit-callback',
    durationMs: 1,
    response: { type: 'message', data: { content: canonicalText } },
  };
}
function shutdown(errors: ShutdownResult['errors'] = []): ShutdownResult {
  return {
    ok: errors.length === 0,
    errors,
    snapshot: { ...snapshot(), disposed: true, phase: 'ready' },
  };
}
// Structural fake sessions are used ONLY for unit failure/finally checks.
function unitSession(overrides: Partial<Session> = {}): { session: Session; calls: string[] } {
  const calls: string[] = [];
  const session: Session = {
    selectProject: () => {
      calls.push('select');
      return Promise.resolve(snapshot());
    },
    validateContext: (value) => {
      calls.push('validate');
      return { ...value };
    },
    start: () => {
      calls.push('start');
      return Promise.resolve(snapshot());
    },
    invoke: (request) => {
      calls.push(`invoke:${request.requestId}`);
      return Promise.resolve(response(request));
    },
    snapshot,
    subscribe: () => () => {},
    stop: () => Promise.resolve(shutdown()),
    dispose: () => {
      calls.push('dispose');
      return Promise.resolve(shutdown());
    },
    ...overrides,
  };
  return { session, calls };
}
async function unitOptions(): Promise<BotTestOptions> {
  const dir = await directory();
  return { casePath: await caseFile(dir), projectDirectory: dir, timeoutMs: 1000 };
}

describe('unit error-path evidence only; not real Bot acceptance', () => {
  it('C02 parser-fail-closed: malformed JSON and 1 MiB limit precede createSession', async () => {
    for (const raw of ['{broken', ' '.repeat(1_048_577)]) {
      const options = await unitOptions();
      await writeFile(options.casePath, raw);
      let created = 0;
      const result = await runBotTest(options, {
        createSession: () => {
          created++;
          return unitSession().session;
        },
      });
      expect(result.exitCode).toBe(2);
      expect(result.report.status).toBe('invalid');
      expect(created).toBe(0);
    }
  });
  it('C02 all steps preflight before start, including an invalid later step', async () => {
    const options = await unitOptions();
    await caseFile(options.projectDirectory, (v) => {
      v['steps'] = [
        {
          requestId: 'ok',
          input: '/ping',
          expect: { responseType: 'message', content: canonicalText },
        },
        {
          requestId: 'bad',
          input: '/UPPER',
          expect: { responseType: 'message', content: canonicalText },
        },
      ];
    });
    let created = 0;
    const result = await runBotTest(options, {
      createSession: () => {
        created++;
        return unitSession().session;
      },
    });
    expect(result.exitCode).toBe(2);
    expect(created).toBe(0);
  });
  it('C11 failure-finally: independently preserves select/start/invoke failures and cleanup issues', async () => {
    for (const phase of ['selectProject', 'start', 'invoke'] as const) {
      const options = await unitOptions();
      let disposals = 0;
      const failure = new SessionError(
        phase === 'selectProject' ? 'invalid' : phase === 'start' ? 'start-failed' : 'transport',
        `redacted ${phase} failure`,
      );
      const { session } = unitSession({
        [phase]: () => Promise.reject(failure),
        dispose: () => {
          disposals++;
          return Promise.resolve(
            shutdown([{ code: 'cleanup', message: 'independent cleanup failure' }]),
          );
        },
      });
      const result = await runBotTest(options, { createSession: () => session });
      expect(disposals).toBe(1);
      expect(result.exitCode).toBe(phase === 'selectProject' ? 2 : 1);
      expect(result.report.status).toBe(phase === 'selectProject' ? 'invalid' : 'runner-error');
      expect(result.report.error).toEqual({ code: failure.code, message: failure.message });
      expect(result.report.cleanupErrors).toEqual([
        { code: 'cleanup', message: 'independent cleanup failure' },
      ]);
    }
  });
  it('C11 cleanup-failure and throwing dispose can never PASS', async () => {
    for (const dispose of [
      () => Promise.resolve(shutdown([{ code: 'cleanup', message: 'not terminated' }])),
      () => Promise.reject(Error('PRIVATE ERROR NEVER COPY')),
    ]) {
      const { session } = unitSession({ dispose });
      const result = await runBotTest(await unitOptions(), { createSession: () => session });
      expect(result.exitCode).toBe(1);
      expect(result.report.status).toBe('runner-error');
      expect(result.report.cleanupErrors.length).toBe(1);
      expect(JSON.stringify(result.report)).not.toContain('PRIVATE ERROR');
    }
  });
  it('C11 unknown runtime exception is redacted and disposal still awaited', async () => {
    const { session, calls } = unitSession({
      start: () => Promise.reject(Error('TOKEN_SHOULD_NOT_APPEAR')),
    });
    const result = await runBotTest(await unitOptions(), { createSession: () => session });
    expect(result.exitCode).toBe(1);
    expect(calls.at(-1)).toBe('dispose');
    expect(JSON.stringify(result.report)).not.toContain('TOKEN_SHOULD_NOT_APPEAR');
  });
  it('C09/C13 runId or actor/guild/channel mismatch never reaches evaluation', async () => {
    for (const field of ['runId', 'actorId', 'guildId', 'channelId'] as const) {
      const { session } = unitSession({
        invoke: (request) => {
          const result = response(request);
          return Promise.resolve(
            field === 'runId'
              ? { ...result, runId: 'stale-run', requestId: 'also-wrong' }
              : {
                  ...result,
                  requestId: 'also-wrong',
                  context: { ...result.context, [field]: 'foreign' },
                },
          );
        },
      });
      const result = await runBotTest(await unitOptions(), { createSession: () => session });
      expect(result.exitCode).toBe(1);
      expect(result.report.status).toBe('runner-error');
      expect(result.report.assertions).toEqual([]);
      expect(result.report.error?.message).toBe(
        'Invocation result identity does not match the active case.',
      );
    }
  });
  it('C13 missing response and model-only success never PASS', async () => {
    const { session } = unitSession({
      invoke: (request) => Promise.resolve({ ...response(request), response: null }),
    });
    const result = await runBotTest(await unitOptions(), { createSession: () => session });
    expect(result.exitCode).toBe(1);
    expect(result.report.status).toBe('runner-error');
    expect(result.report.assertions).toEqual([]);
  });
  it('C13 mismatched requestId is a runner error, not an assertion PASS', async () => {
    const { session } = unitSession({
      invoke: (request) => Promise.resolve({ ...response(request), requestId: 'foreign-request' }),
    });
    const result = await runBotTest(await unitOptions(), { createSession: () => session });
    expect(result.exitCode).toBe(1);
    expect(result.report.status).toBe('runner-error');
    expect(result.report.assertions).toEqual([]);
  });
  it('C14 cleanup-after-mismatch: stops at first mismatch and preserves failure through cleanup', async () => {
    const options = { ...(await unitOptions()), casePath: join(fixtures, 'case-mismatch.json') };
    const { session, calls } = unitSession({
      invoke: (request) => {
        calls.push(`invoke:${request.requestId}`);
        return Promise.resolve({
          ...response(request),
          response: { type: 'message', data: { content: 'Different offline reply.' } },
        });
      },
      dispose: () => {
        calls.push('dispose');
        return Promise.resolve(shutdown([{ code: 'child-exited', message: 'unexpected exit' }]));
      },
    });
    const result = await runBotTest(options, { createSession: () => session });
    expect(result.exitCode).toBe(1);
    expect(result.report.status).toBe('failed');
    expect(result.report.assertions).toHaveLength(1);
    expect(result.report.assertions[0]?.actual?.data['content']).toBe('Different offline reply.');
    expect(calls).toEqual(['select', 'validate', 'start', 'invoke:ping-1', 'dispose']);
  });
  it('C14 child exit between valid callback and disposal prevents pass', async () => {
    const { session } = unitSession({
      dispose: () =>
        Promise.resolve(
          shutdown([{ code: 'child-exited', message: 'unexpected exit after callback' }]),
        ),
    });
    const result = await runBotTest(await unitOptions(), { createSession: () => session });
    expect(result.report.assertions[0]?.passed).toBe(true);
    expect(result.exitCode).toBe(1);
    expect(result.report.status).toBe('runner-error');
  });
  for (const phase of ['start', 'invoke'] as const)
    for (const cancellationExitCode of [130, 143] as const)
      it(`C10 cancellation during ${phase}, exit ${cancellationExitCode}, awaits cleanup`, async () => {
        const options = await unitOptions();
        const controller = new AbortController();
        let disposed = false;
        const neverUntilAbort = () =>
          new Promise<SessionSnapshot & SessionInvocationResult>((_resolve, reject) => {
            controller.signal.addEventListener(
              'abort',
              () => reject(new SessionError('cancelled', 'unit cancelled')),
              { once: true },
            );
            queueMicrotask(() => controller.abort());
          });
        const { session } = unitSession({
          [phase]: neverUntilAbort,
          dispose: async () => {
            await delay(5);
            disposed = true;
            return shutdown();
          },
        });
        const result = await runBotTest(
          { ...options, signal: controller.signal, cancellationExitCode },
          { createSession: () => session },
        );
        expect(disposed).toBe(true);
        expect(result.exitCode).toBe(cancellationExitCode);
        expect(result.report.status).toBe('cancelled');
      });
  it('C10 preaborted signal creates no session', async () => {
    const controller = new AbortController();
    controller.abort();
    let created = 0;
    const result = await runBotTest(
      { ...(await unitOptions()), signal: controller.signal },
      {
        createSession: () => {
          created++;
          return unitSession().session;
        },
      },
    );
    expect(created).toBe(0);
    expect(result.exitCode).toBe(130);
  });
  it('C10 overall deadline is timeout/runner-error, not user cancellation', async () => {
    const { session } = unitSession({ start: () => new Promise(() => {}) });
    const result = await runBotTest(
      { ...(await unitOptions()), timeoutMs: 25 },
      { createSession: () => session },
    );
    expect(result.exitCode).toBe(1);
    expect(result.report.status).toBe('runner-error');
    expect(result.report.error?.code).toBe('timeout');
  });
  it('C12 final output appears only after disposal and agrees exactly with returned report', async () => {
    const options = await unitOptions();
    const outPath = join(options.projectDirectory, 'result.json');
    await writeFile(outPath, 'PREVIOUS RESULT');
    let entered!: () => void;
    let release!: () => void;
    const disposing = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { session } = unitSession({
      dispose: async () => {
        entered();
        await gate;
        return shutdown();
      },
    });
    const running = runBotTest({ ...options, outPath }, { createSession: () => session });
    await disposing;
    expect(await readFile(outPath, 'utf8')).toBe('PREVIOUS RESULT');
    release();
    const result = await running;
    expect(JSON.parse(await readFile(outPath, 'utf8'))).toEqual(result.report);
    expect(result.exitCode).toBe(0);
    expect(Object.isFrozen(result.report.context)).toBe(true);
    expect(Object.keys(result.report).sort()).toEqual(
      [
        'version',
        'execution',
        'adapter',
        'name',
        'runId',
        'status',
        'context',
        'assertions',
        'error',
        'cleanupErrors',
      ].sort(),
    );
    expect((await readdir(options.projectDirectory)).some((n) => n.endsWith('.tmp'))).toBe(false);
  });
  it('C12 unwritable parent and rename failure cannot claim stale result', async () => {
    for (const mode of ['parent', 'rename'] as const) {
      const options = await unitOptions();
      const parent = join(options.projectDirectory, 'existing');
      await writeFile(parent, 'STALE RESULT');
      const outPath = mode === 'parent' ? join(parent, 'result.json') : options.projectDirectory;
      const result = await runBotTest(
        { ...options, outPath },
        { createSession: () => unitSession().session },
      );
      expect(result.exitCode).toBe(1);
      expect(result.report.status).toBe('runner-error');
      expect(await readFile(parent, 'utf8')).toBe('STALE RESULT');
      expect(result.report.cleanupErrors.some((e) => e.code === 'cleanup')).toBe(true);
      expect((await readdir(options.projectDirectory)).some((n) => n.endsWith('.tmp'))).toBe(false);
    }
  });
  it('C12 output failure explicitly retains a prior assertion mismatch', async () => {
    const options = await unitOptions();
    const { session } = unitSession({
      invoke: (request) =>
        Promise.resolve({
          ...response(request),
          response: { type: 'message', data: { content: 'Different offline reply.' } },
        }),
    });
    const result = await runBotTest(
      { ...options, outPath: join(options.projectDirectory, 'missing', 'result.json') },
      { createSession: () => session },
    );
    expect(result.exitCode).toBe(1);
    expect(result.report.status).toBe('runner-error');
    expect(result.report.assertions[0]?.passed).toBe(false);
    expect(
      result.report.cleanupErrors.some(
        (issue) => issue.code === 'cleanup' && issue.message.includes('Prior assertion mismatch'),
      ),
    ).toBe(true);
  });
  it('C12 output failure retains cancellation exit and primary cancellation', async () => {
    const options = await unitOptions();
    const controller = new AbortController();
    controller.abort();
    const result = await runBotTest({
      ...options,
      signal: controller.signal,
      cancellationExitCode: 143,
      outPath: join(options.projectDirectory, 'missing', 'result.json'),
    });
    expect(result.exitCode).toBe(143);
    expect(result.report.status).toBe('cancelled');
    expect(result.report.error?.code).toBe('cancelled');
    expect(result.report.cleanupErrors.length).toBeGreaterThan(0);
  });
});

interface Trace {
  event: string;
  pid: number;
  [key: string]: unknown;
}
async function traceFile(project: string): Promise<Trace[]> {
  try {
    return (await readFile(join(project, 'trace.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Trace);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}
async function project(mode = 'normal'): Promise<string> {
  const directoryPath = await directory();
  await cp(fixtures, directoryPath, { recursive: true });
  const path = join(directoryPath, 'discord-simulator.config.json');
  const config = JSON.parse(await readFile(path, 'utf8')) as {
    environment: Record<string, string>;
  };
  config.environment['DISRUNNER_TEST_MODE'] = mode;
  config.environment['DISRUNNER_TEST_TRACE'] = join(directoryPath, 'trace.jsonl');
  config.environment['DISRUNNER_TEST_EXIT_GATE'] = join(directoryPath, 'exit-gate');
  await writeFile(path, JSON.stringify(config));
  return directoryPath;
}
function observation(): {
  factory: typeof createSession;
  pids: Set<number>;
  endpoints: RuntimeEndpoints[];
  sessions: Session[];
} {
  const pids = new Set<number>();
  const endpoints: RuntimeEndpoints[] = [];
  const sessions: Session[] = [];
  const factory: typeof createSession = () => {
    // This is the real shared session, with observers only. No lifecycle stub.
    const session = createSession({
      onEndpoints: (value) => {
        if (value !== null) endpoints.push(value);
      },
    });
    session.subscribe((event) => {
      if (event.snapshot.pid !== null) pids.add(event.snapshot.pid);
    });
    sessions.push(session);
    return session;
  };
  return { factory, pids, endpoints, sessions };
}
async function portClosed(port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const socket = createConnection({ port, host: '127.0.0.1' });
    socket.once('connect', () => {
      socket.destroy();
      reject(Error(`Owned port ${port} still accepts connections`));
    });
    socket.once('error', (error) => {
      socket.destroy();
      if ((error as NodeJS.ErrnoException).code === 'ECONNREFUSED') resolve();
      else reject(error);
    });
    socket.setTimeout(500, () => {
      socket.destroy();
      reject(Error(`Owned port ${port} closure was not established`));
    });
  });
  await new Promise<void>((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });
}
async function assertCleanup(
  observed: ReturnType<typeof observation>,
  projectPath?: string,
): Promise<void> {
  const trace = projectPath ? await traceFile(projectPath) : [];
  for (const record of trace.filter((t) => t.event === 'launch')) observed.pids.add(record.pid);
  const alive: number[] = [];
  for (const pid of observed.pids) {
    try {
      process.kill(pid, 0);
      alive.push(pid);
    } catch (error) {
      expect((error as NodeJS.ErrnoException).code).toBe('ESRCH');
    }
  }
  if (alive.length > 0) {
    // A recorded PID may have been reused. Never signal it without current ownership proof.
    throw Error(
      `FAIL: recorded child PIDs are still present; no unsafe containment attempted: ${alive.join(',')}`,
    );
  }
  const ports = new Set<number>();
  for (const endpoints of observed.endpoints)
    for (const url of [endpoints.restBaseUrl, endpoints.gatewayUrl, endpoints.interactionEndpoint])
      if (url !== undefined) ports.add(Number(new URL(url).port));
  for (const record of trace.filter((t) => t.event === 'launch'))
    if (typeof record['port'] === 'number') ports.add(record['port']);
  for (const port of ports) await portClosed(port);
  for (const session of observed.sessions) {
    expect(session.snapshot().disposed).toBe(true);
    expect(session.snapshot().endpoints).toBeNull();
  }
  console.info(
    'M1_RESOURCE_EVIDENCE ' +
      JSON.stringify({
        platform: process.platform,
        pids: [...observed.pids],
        allPidsDead: true,
        ports: [...ports],
        allPortsClosedAndReusable: true,
        trace,
      }),
  );
}
async function waitTrace(projectPath: string, event: string): Promise<void> {
  const end = Date.now() + 3000;
  while (Date.now() < end) {
    if ((await traceFile(projectPath)).some((t) => t.event === event)) return;
    await delay(10);
  }
  throw Error(`Bounded fixture wait failed: ${event}`);
}

// Linux-only independent process observation, not the runtime's snapshot/status oracle.
async function processIdentity(
  pid: number,
  readStat: (path: string, encoding: 'utf8') => Promise<string> = readFile,
): Promise<{ startTime: string; state: string } | null> {
  let raw: string;
  try {
    raw = await readStat(`/proc/${pid}/stat`, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ESRCH') return null;
    throw error;
  }
  const closingParen = raw.lastIndexOf(')');
  if (!raw.startsWith(`${pid} (`) || closingParen < 0)
    throw Error('Cannot establish the original child identity.');
  const fields = raw
    .slice(closingParen + 2)
    .trim()
    .split(/\s+/u);
  const state = fields[0];
  const startTime = fields[19];
  if (
    state === undefined ||
    !/^[RSDZTtXxKWPI]$/u.test(state) ||
    startTime === undefined ||
    !/^\d+$/u.test(startTime)
  )
    throw Error('Cannot establish the original child identity.');
  return { startTime, state };
}

describe('C14 procfs observer error classification', () => {
  for (const code of ['ENOENT', 'ESRCH'])
    it(`classifies ${code} from a disappearing procfs entry as absent`, async () => {
      const error = Object.assign(new Error('Process disappeared during observation.'), { code });
      await expect(processIdentity(123, () => Promise.reject(error))).resolves.toBeNull();
    });
  for (const code of ['EACCES', 'EIO', undefined])
    it(`preserves ${code ?? 'unexpected'} observation errors`, async () => {
      const error = Object.assign(new Error('Observation failed without proof of exit.'), { code });
      await expect(processIdentity(123, () => Promise.reject(error))).rejects.toBe(error);
    });
});

describe.sequential(
  'real shared-session / authenticated child oracles (not fake-session evidence)',
  () => {
    it('C03 raw-example-pass: unchanged example, whole canonical text, exact context, cleanup', async () => {
      const observed = observation();
      const result = await runBotTest(
        {
          casePath: join(fixtures, 'case-pass.json'),
          projectDirectory: resolve(repository, 'examples/raw-webhook-bot'),
          timeoutMs: 5000,
        },
        { createSession: observed.factory },
      );
      await assertCleanup(observed);
      expect(result.exitCode).toBe(0);
      expect(result.report.status).toBe('passed');
      expect(result.report.context).toEqual(context);
      expect(result.report.assertions).toHaveLength(1);
      expect(result.report.assertions[0]?.actual).toEqual({
        type: 'message',
        data: { content: canonicalText },
      });
      console.info('C03_REPORT ' + JSON.stringify(result));
    }, 10000);
    it('C04 original wrong-bot-control: redacted response is a transport error before evaluation', async () => {
      const projectPath = await project('wrong');
      const observed = observation();
      const result = await runBotTest(
        {
          casePath: join(fixtures, 'case-mismatch.json'),
          projectDirectory: projectPath,
          timeoutMs: 5000,
        },
        { createSession: observed.factory },
      );
      await assertCleanup(observed, projectPath);
      expect(result.exitCode).toBe(1);
      expect(result.report.status).toBe('runner-error');
      expect(result.report.assertions).toEqual([]);
      expect(result.report.error).toEqual({
        code: 'transport',
        message: 'Authenticated response cannot be represented exactly and safely.',
      });
      expect(JSON.stringify(result.report)).not.toContain('WRONG BOT RESPONSE');
      expect(JSON.stringify(result.report)).not.toContain('WRONG BOT [REDACTED]');
      const trace = await traceFile(projectPath);
      expect(trace.filter((t) => t.event === 'command')).toHaveLength(1);
      expect(trace.some((t) => t.event === 'callback' && t['authenticatedResponse'] === true)).toBe(
        true,
      );
      expect(
        trace.filter((t) => t.event === 'callback').every((t) => !Object.hasOwn(t, 'content')),
      ).toBe(true);
      console.info('C04_REDACTED_CONTROL_REPORT ' + JSON.stringify(result));
    }, 10000);
    it('C04 safe-text mismatch / C14 cleanup-after-mismatch: exact actual, one command only', async () => {
      const projectPath = await project('wrong-safe');
      const observed = observation();
      const result = await runBotTest(
        {
          casePath: join(fixtures, 'case-mismatch.json'),
          projectDirectory: projectPath,
          timeoutMs: 5000,
        },
        { createSession: observed.factory },
      );
      await assertCleanup(observed, projectPath);
      expect(result.exitCode).toBe(1);
      expect(result.report.status).toBe('failed');
      expect(result.report.assertions).toHaveLength(1);
      expect(result.report.assertions[0]?.expected.content).toBe(canonicalText);
      expect(result.report.assertions[0]?.actual?.data['content']).toBe('Different offline reply.');
      const trace = await traceFile(projectPath);
      expect(trace.filter((t) => t.event === 'command')).toHaveLength(1);
      expect(trace.some((t) => t.event === 'callback' && t['authenticatedResponse'] === true)).toBe(
        true,
      );
      console.info('C04_SAFE_MISMATCH_REPORT ' + JSON.stringify(result));
    }, 10000);
    it('C05 pong-only-control: authenticated readiness is not a command response', async () => {
      const projectPath = await project('pong-only');
      const observed = observation();
      const result = await runBotTest(
        {
          casePath: join(fixtures, 'case-pass.json'),
          projectDirectory: projectPath,
          timeoutMs: 1000,
        },
        { createSession: observed.factory },
      );
      await assertCleanup(observed, projectPath);
      expect(result.exitCode).toBe(1);
      expect(result.report.status).toBe('runner-error');
      expect(result.report.assertions).toEqual([]);
      const trace = await traceFile(projectPath);
      expect(
        trace.some((t) => t.event === 'readiness-response' && t['authenticatedResponse'] === true),
      ).toBe(true);
      expect(trace.some((t) => t.event === 'command')).toBe(true);
      expect(trace.some((t) => t.event === 'callback')).toBe(false);
    }, 10000);
    it('C06 missing-executable preflight: invalid/2 and zero launch markers', async () => {
      const projectPath = await project();
      const path = join(projectPath, 'discord-simulator.config.json');
      const config = JSON.parse(await readFile(path, 'utf8')) as { bot: { startCommand: string } };
      config.bot.startCommand = 'definitely-missing-disrunner-m1-executable server.mjs';
      await writeFile(path, JSON.stringify(config));
      const observed = observation();
      const result = await runBotTest(
        { casePath: join(fixtures, 'case-pass.json'), projectDirectory: projectPath },
        { createSession: observed.factory },
      );
      await assertCleanup(observed, projectPath);
      expect(result.exitCode).toBe(2);
      expect(result.report.status).toBe('invalid');
      expect(await traceFile(projectPath)).toEqual([]);
      expect(observed.pids.size).toBe(0);
    }, 10000);
    for (const [name, mode, code] of [
      ['C07 early-zero-exit', 'early-zero', 0],
      ['C08 early-crash', 'early-crash', 17],
    ] as const)
      it(`${name}: startup cannot pass on code ${code}`, async () => {
        const projectPath = await project(mode);
        const observed = observation();
        const result = await runBotTest(
          {
            casePath: join(fixtures, 'case-pass.json'),
            projectDirectory: projectPath,
            timeoutMs: 2000,
          },
          { createSession: observed.factory },
        );
        await assertCleanup(observed, projectPath);
        expect(result.exitCode).toBe(1);
        expect(result.report.status).toBe('runner-error');
        expect(result.report.assertions).toEqual([]);
        expect(
          (await traceFile(projectPath)).some((t) => t.event === 'exit' && t['code'] === code),
        ).toBe(true);
      }, 10000);
    it('C09 context-preflight: unknown actor/guild/channel, foreign guild and nontext channel spawn zero', async () => {
      for (const changed of [
        { actorId: 'missing' },
        { guildId: 'missing' },
        { channelId: 'missing' },
        { guildId: 'foreign', channelId: '2000' },
        { channelId: '2200' },
      ]) {
        const projectPath = await project();
        const casePath = await caseFile(projectPath, (value) => {
          value['context'] = { ...context, ...changed };
        });
        const observed = observation();
        const result = await runBotTest(
          { casePath, projectDirectory: projectPath },
          { createSession: observed.factory },
        );
        await assertCleanup(observed, projectPath);
        expect(result.exitCode).toBe(2);
        expect(result.report.status).toBe('invalid');
        expect(observed.pids.size).toBe(0);
        expect(await traceFile(projectPath)).toEqual([]);
      }
    }, 10000);
    it('C09 channel fixture belongs to a different guild: reject before launch', async () => {
      const projectPath = await project();
      const guildPath = join(projectPath, 'guild.json');
      const value = JSON.parse(await readFile(guildPath, 'utf8')) as {
        guild: { channels: { guild_id: string }[] };
      };
      const channel = value.guild.channels[0];
      if (channel === undefined) throw Error('Fixture must contain a channel.');
      channel.guild_id = 'foreign-guild';
      await writeFile(guildPath, JSON.stringify(value));
      const observed = observation();
      const result = await runBotTest(
        { casePath: join(fixtures, 'case-pass.json'), projectDirectory: projectPath },
        { createSession: observed.factory },
      );
      await assertCleanup(observed, projectPath);
      expect(result.exitCode).toBe(2);
      expect(result.report.status).toBe('invalid');
      expect(observed.pids.size).toBe(0);
      expect(await traceFile(projectPath)).toEqual([]);
    }, 10000);
    it('C09 non-first text channel 2100: payload member.user and returned context match exactly', async () => {
      const projectPath = await project();
      const casePath = await caseFile(projectPath, (value) => {
        value['context'] = { ...context, channelId: '2100' };
      });
      const observed = observation();
      const result = await runBotTest(
        { casePath, projectDirectory: projectPath, timeoutMs: 5000 },
        { createSession: observed.factory },
      );
      await assertCleanup(observed, projectPath);
      expect(result.exitCode).toBe(0);
      expect(result.report.context).toEqual({ ...context, channelId: '2100' });
      expect((await traceFile(projectPath)).find((t) => t.event === 'command')).toMatchObject({
        actorId: '3000',
        actorName: 'DevUser',
        guildId: '1000',
        channelId: '2100',
        hasInventedRoles: false,
      });
      expect(result.report.assertions[0]?.actual?.data['content']).toBe(canonicalText);
    }, 10000);
    for (const [mode, event, cancellationExitCode] of [
      ['startup-stall', 'readiness', 130],
      ['pong-only', 'command', 143],
      ['body-stall', 'body-started', 130],
    ] as const)
      it(`C10 cancellation: ${mode}, exit ${cancellationExitCode}, real child/socket cleanup`, async () => {
        const projectPath = await project(mode);
        const observed = observation();
        const controller = new AbortController();
        let cancellationFailure: unknown;
        const cancellation = waitTrace(projectPath, event)
          .then(() => controller.abort())
          .catch((error: unknown) => {
            cancellationFailure = error;
            controller.abort();
          });
        const running = runBotTest(
          {
            casePath: join(fixtures, 'case-mismatch.json'),
            projectDirectory: projectPath,
            timeoutMs: 5000,
            signal: controller.signal,
            cancellationExitCode,
          },
          { createSession: observed.factory },
        );
        const result = await running;
        await cancellation;
        await assertCleanup(observed, projectPath);
        if (cancellationFailure !== undefined)
          throw cancellationFailure instanceof Error
            ? cancellationFailure
            : new Error('Fixture cancellation observation failed.', { cause: cancellationFailure });
        expect(result.exitCode).toBe(cancellationExitCode);
        expect(result.report.status).toBe('cancelled');
        expect(result.report.assertions).toEqual([]);
        expect(
          (await traceFile(projectPath)).filter((t) => t.event === 'command').length,
        ).toBeLessThanOrEqual(1);
      }, 10000);
    for (const mode of ['foreign-listener', 'invalid-auth'])
      it(`C13 no-model-shortcut: ${mode} cannot authenticate readiness or pass`, async () => {
        const projectPath = await project(mode);
        const observed = observation();
        const result = await runBotTest(
          {
            casePath: join(fixtures, 'case-pass.json'),
            projectDirectory: projectPath,
            timeoutMs: 1500,
          },
          { createSession: observed.factory },
        );
        await assertCleanup(observed, projectPath);
        expect(result.exitCode).toBe(1);
        expect(result.report.status).toBe('runner-error');
        expect(result.report.assertions).toEqual([]);
      }, 10000);
    it('C13 stale run rejection uses the actual session, not the evaluator', async () => {
      const projectPath = await project();
      const observed = observation();
      const session = observed.factory();
      try {
        await session.selectProject(projectPath);
        session.validateContext(context);
        await session.start({ timeoutMs: 3000 });
        await expect(
          session.invoke({ runId: 'stale-run', requestId: 'stale-1', input: '/ping', context }),
        ).rejects.toMatchObject({ code: 'not-running' });
      } finally {
        await session.dispose();
      }
      await assertCleanup(observed, projectPath);
      expect((await traceFile(projectPath)).some((t) => t.event === 'command')).toBe(false);
    }, 10000);
    it.skipIf(process.platform !== 'linux')(
      'C14 CLI rejects a verified original-child exit after a real callback and before disposal',
      async () => {
        const projectPath = await project('exit-after-observed-response');
        const observed = observation();
        let identity: { pid: number; startTime: string } | undefined;
        let callbackObserved = false;
        let deathProof: { pid: number; startTime: string; state: string } | undefined;
        let observerFailure: unknown;
        let actualShutdown: ShutdownResult | undefined;
        let disposeAfterProof = false;

        const factory: typeof createSession = () => {
          const session = observed.factory();
          const start = session.start.bind(session);
          const invoke = session.invoke.bind(session);
          const dispose = session.dispose.bind(session);
          session.start = async (options) => {
            const started = await start(options);
            if (started.pid === null) throw Error('Expected an owned direct child.');
            const original = await processIdentity(started.pid);
            if (original === null || ['Z', 'X', 'x'].includes(original.state))
              throw Error('Original child was not live at identity capture.');
            identity = { pid: started.pid, startTime: original.startTime };
            return started;
          };
          session.invoke = async (request, options) => {
            const result = await invoke(request, options);
            expect(result).toMatchObject({
              runId: request.runId,
              requestId: request.requestId,
              context,
              ok: true,
              error: null,
              response: { type: 'message', data: { content: canonicalText } },
            });
            callbackObserved = true;
            return result; // Actual authenticated result, never a substitute callback.
          };
          session.dispose = async () => {
            try {
              if (!callbackObserved || identity === undefined)
                throw Error('The real callback and original child identity are required.');
              await writeFile(join(projectPath, 'exit-gate'), 'observed\n');
              const deadline = performance.now() + 1500;
              while (performance.now() < deadline) {
                const current = await processIdentity(identity.pid);
                if (current !== null && current.startTime !== identity.startTime)
                  throw Error(
                    'PID was reused; this oracle requires unchanged identity or absence.',
                  );
                if (current === null || ['Z', 'X', 'x'].includes(current.state)) {
                  deathProof = { ...identity, state: current?.state ?? 'absent' };
                  break;
                }
                await delay(5); // Bounded condition polling, not a runtime quiescence interval.
              }
              if (deathProof === undefined) throw Error('Original-child exit was not observed.');
              disposeAfterProof = true;
            } catch (error) {
              observerFailure = error;
            } finally {
              actualShutdown = await dispose(); // Always perform real cleanup, even if proof fails.
            }
            return actualShutdown;
          };
          return session;
        };
        const result = await runBotTest(
          {
            casePath: join(fixtures, 'case-pass.json'),
            projectDirectory: projectPath,
            timeoutMs: 3000,
          },
          { createSession: factory },
        );
        await assertCleanup(observed, projectPath);
        // An observer exception/timeout must not masquerade as the desired runner-error.
        expect(observerFailure).toBeUndefined();
        expect(callbackObserved).toBe(true);
        expect(deathProof).toBeDefined();
        expect(disposeAfterProof).toBe(true);
        expect(actualShutdown?.ok).toBe(false);
        expect(actualShutdown?.errors.some((issue) => issue.code === 'child-exited')).toBe(true);
        expect(result.exitCode).toBe(1);
        expect(result.report.status).toBe('runner-error');
        expect(result.report.assertions).toHaveLength(1);
        expect(result.report.assertions[0]).toMatchObject({
          passed: true,
          expected: { responseType: 'message', content: canonicalText },
          actual: { type: 'message', data: { content: canonicalText } },
        });
        expect(result.report.cleanupErrors.some((issue) => issue.code === 'child-exited')).toBe(
          true,
        );
        const trace = await traceFile(projectPath);
        expect(
          trace.some((event) => event.event === 'exit' && event['gateAcknowledged'] === true),
        ).toBe(true);
        expect(trace.some((event) => event.event === 'gate-timeout')).toBe(false);
        console.info(
          'C14_CAUSAL_CLI_EVIDENCE ' +
            JSON.stringify({
              originalIdentity: identity,
              deathProof,
              callbackObserved,
              disposeAfterProof,
              shutdownErrors: actualShutdown?.errors,
              result,
            }),
        );
      },
      10000,
    );
    it('C14 a fully observed real callback followed by gated unexpected exit is a cleanup failure', async () => {
      const projectPath = await project('exit-after-observed-response');
      const observed = observation();
      const session = observed.factory();
      let disposed: ShutdownResult | undefined;
      try {
        await session.selectProject(projectPath);
        session.validateContext(context);
        const started = await session.start({ timeoutMs: 3000 });
        if (started.runId === null) throw Error('Expected a live run ID.');
        const invocation = await session.invoke(
          { runId: started.runId, requestId: 'observed-1', input: '/ping', context },
          { timeoutMs: 2000 },
        );
        expect(invocation).toMatchObject({
          runId: started.runId,
          requestId: 'observed-1',
          context,
          ok: true,
          error: null,
          response: { type: 'message', data: { content: canonicalText } },
        });
        // The fixture may exit only after this exact observed-response assertion.
        await writeFile(join(projectPath, 'exit-gate'), 'observed\n');
        await waitTrace(projectPath, 'exit');
        const end = Date.now() + 1500;
        let dead = false;
        while (Date.now() < end) {
          dead =
            [...observed.pids].length > 0 &&
            [...observed.pids].every((pid) => {
              try {
                process.kill(pid, 0);
                return false;
              } catch (error) {
                return (error as NodeJS.ErrnoException).code === 'ESRCH';
              }
            });
          if (dead) break;
          await delay(5);
        }
        expect(dead).toBe(true);
      } finally {
        disposed = await session.dispose();
      }
      await assertCleanup(observed, projectPath);
      expect(disposed.ok).toBe(false);
      expect(disposed.errors.some((issue) => issue.code === 'child-exited')).toBe(true);
      const trace = await traceFile(projectPath);
      expect(
        trace.some(
          (t) =>
            t.event === 'callback' &&
            t['authenticatedResponse'] === true &&
            t['content'] === canonicalText,
        ),
      ).toBe(true);
      expect(trace.some((t) => t.event === 'exit' && t['gateAcknowledged'] === true)).toBe(true);
      expect(trace.some((t) => t.event === 'gate-timeout')).toBe(false);
    }, 10000);
    it('C02/C09 invalid corpus before launch, including malformed JSON', async () => {
      const corpus = JSON.parse(await readFile(join(fixtures, 'cases-invalid.json'), 'utf8')) as {
        name: string;
        value?: unknown;
        raw?: string;
      }[];
      for (const entry of corpus) {
        const projectPath = await project();
        const casePath = join(projectPath, 'case.json');
        await writeFile(casePath, entry.raw ?? JSON.stringify(entry.value));
        const observed = observation();
        const result = await runBotTest(
          { casePath, projectDirectory: projectPath },
          { createSession: observed.factory },
        );
        await assertCleanup(observed, projectPath);
        expect(result.exitCode, entry.name).toBe(2);
        expect(observed.pids.size, entry.name).toBe(0);
        expect(await traceFile(projectPath)).toEqual([]);
      }
    }, 10000);
  },
);

describe('shared-config ordinary permission consumer', () => {
  for (const strict of [true, false]) {
    it(`real bot-test child observes ${strict ? 'strict 403' : 'legacy 200'} without changing human actor`, async () => {
      const projectPath = await project();
      const configPath = join(projectPath, 'discord-simulator.config.json');
      const config = JSON.parse(await readFile(configPath, 'utf8')) as {
        profile: Record<string, unknown>;
        fixtures: Record<string, string>;
      };
      if (strict) {
        config.profile['ordinaryMessagePermissions'] = 'guild-text-own-messages-v1';
        config.fixtures['bot'] = 'bot.json';
        await writeFile(
          join(projectPath, 'bot.json'),
          JSON.stringify({
            version: 1,
            user: { id: '5000', bot: true },
          }),
        );
      }
      await writeFile(configPath, JSON.stringify(config));
      await writeFile(
        join(projectPath, 'guild.json'),
        JSON.stringify({
          version: 1,
          guild: {
            id: '1000',
            owner_id: '9000',
            roles: [
              { id: '1000', permissions: '0' },
              { id: '1100', permissions: '0' },
            ],
            channels: [{ id: '2000', type: 0, permission_overwrites: [] }],
            members: [{ id: '5100', user_id: '5000', roles: ['1100'] }],
          },
        }),
      );
      await writeFile(
        join(projectPath, 'user.json'),
        JSON.stringify({
          version: 1,
          user: { id: '3000', username: 'Human', bot: false },
        }),
      );
      // Instrument only the private copy, preserving signature and peer-auth gates.
      const serverPath = join(projectPath, 'server.mjs');
      let server = await readFile(serverPath, 'utf8');
      const anchor = '      const content =';
      expect(server.split(anchor)).toHaveLength(2);
      server = server.replace("request.on('end', () => {", "request.on('end', async () => {");
      server = server.replace(
        anchor,
        `      let permissionObservation;
      if (!ping) {
        const rest = await fetch('http://127.0.0.1:' + process.env.DISRUNNER_REST_PORT + '/api/v10/channels/2000/messages', {
          method: 'POST',
          headers: { authorization: 'Bot ' + process.env.DISRUNNER_FAKE_TOKEN, 'content-type': 'application/json' },
          body: JSON.stringify({ content: 'consumer ordinary message' }),
        });
        const payload = await rest.json();
        permissionObservation = JSON.stringify({
          status: rest.status,
          result: rest.status === 403 ? payload : { content: payload.content, bot: payload.author?.bot },
          actorId: interaction.member?.user?.id,
          hasInventedRoles: Object.hasOwn(interaction.member ?? {}, 'roles'),
        });
      }
      const content = permissionObservation ? permissionObservation :`,
      );
      await writeFile(serverPath, server);
      const expected = JSON.stringify({
        status: strict ? 403 : 200,
        result: strict
          ? { code: 50013, message: 'Missing Permissions' }
          : { content: 'consumer ordinary message', bot: true },
        actorId: '3000',
        hasInventedRoles: false,
      });
      const casePath = await caseFile(projectPath, (value) => {
        value['steps'] = [
          {
            requestId: 'permissions-1',
            input: '/ping',
            expect: { responseType: 'message', content: expected },
          },
        ];
      });
      const observed = observation();
      const result = await runBotTest(
        { casePath, projectDirectory: projectPath, timeoutMs: 5000 },
        { createSession: observed.factory },
      );
      await assertCleanup(observed, projectPath);
      expect(result.exitCode).toBe(0);
      expect(result.report.status).toBe('passed');
      expect(result.report.context).toEqual(context);
      expect(result.report.assertions[0]?.actual).toEqual({
        type: 'message',
        data: { content: expected },
      });
      expect((await traceFile(projectPath)).find((row) => row.event === 'command')).toMatchObject({
        actorId: '3000',
        actorName: 'Human',
        hasInventedRoles: false,
      });
    }, 10000);
  }
});
