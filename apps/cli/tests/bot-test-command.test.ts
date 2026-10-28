import { spawn } from 'node:child_process';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { main, parseArgs } from '../src/index.js';
import type { BotTestReport } from '../src/bot-test.js';

const fixtures = fileURLToPath(new URL('./fixtures/bot-test/', import.meta.url));
const executable = fileURLToPath(new URL('../dist/index.js', import.meta.url));
const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(directories.splice(0).map((p) => rm(p, { recursive: true, force: true })));
});
async function project(mode = 'normal') {
  const path = await mkdtemp(join(tmpdir(), 'disrunner-command-'));
  directories.push(path);
  await cp(fixtures, path, { recursive: true });
  const configPath = join(path, 'discord-simulator.config.json');
  const config = JSON.parse(await readFile(configPath, 'utf8')) as {
    environment: Record<string, string>;
  };
  config.environment['DISRUNNER_TEST_MODE'] = mode;
  config.environment['DISRUNNER_TEST_TRACE'] = join(path, 'trace.jsonl');
  await writeFile(configPath, JSON.stringify(config));
  return path;
}
interface Trace {
  event: string;
  pid: number;
}
async function traces(path: string): Promise<Trace[]> {
  try {
    return (await readFile(join(path, 'trace.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Trace);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}
function launch(args: string[]) {
  const child = spawn(process.execPath, [executable, ...args], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (data: Buffer) => {
    stdout += data.toString();
  });
  child.stderr.on('data', (data: Buffer) => {
    stderr += data.toString();
  });
  const result = new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
    stdout: string;
    stderr: string;
  }>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
  return { child, result };
}
function args(path: string, file = 'case-pass.json') {
  return ['bot-test', join(path, file), '--project', path, '--timeout-ms', '5000'];
}
async function assertDead(path: string) {
  const records = await traces(path);
  for (const pid of new Set(records.map((trace) => trace.pid))) {
    expect(() => process.kill(pid, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }));
  }
}

describe('bot-test command boundary', () => {
  it('accepts exactly the bot command options without changing model test defaults', () => {
    expect(
      parseArgs([
        'bot-test',
        'case.json',
        '--project',
        'project',
        '--out',
        'result.json',
        '--timeout-ms',
        '300000',
      ]),
    ).toMatchObject({
      command: 'bot-test',
      file: 'case.json',
      projectDirectory: 'project',
      output: 'result.json',
      timeoutMs: 300000,
    });
    expect(parseArgs(['test'])).toMatchObject({ command: 'test' });
    expect(parseArgs(['run', 'scenario.yml', '--seed', '42'])).toMatchObject({
      command: 'run',
      seed: 42,
    });
  });
  it.each([
    [],
    ['case.json'],
    ['--project', 'project'],
    ['case.json', '--project'],
    ['case.json', '--project', 'project', 'extra'],
    ...['--project', '--out', '--timeout-ms'].map((flag) => [
      'case.json',
      '--project',
      'project',
      flag,
      '1',
      flag,
      '2',
    ]),
    ...['--seed', '--format', '--token', '--install', '--network', '--adapter'].map((flag) => [
      'case.json',
      '--project',
      'project',
      flag,
      '1',
    ]),
    ...['0', '300001', '-1', '1.5', '1e3', '0x10', 'NaN', '', ' 1'].map((value) => [
      'case.json',
      '--project',
      'project',
      '--timeout-ms',
      value,
    ]),
    ['case.json', '--project', '--out', 'result.json'],
    ['case.json', '--project', 'project', '--out', '--timeout-ms', '1'],
  ])('rejects ambiguous/invalid arguments %j', (...values) => {
    expect(() => parseArgs(['bot-test', ...values])).toThrow();
  });
  it('removes only its own signal listeners after preflight failure', async () => {
    const beforeInt = process.listeners('SIGINT');
    const beforeTerm = process.listeners('SIGTERM');
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    expect(await main(['bot-test', '/definitely-missing-case.json', '--project', '.'])).toBe(2);
    expect(process.listeners('SIGINT')).toEqual(beforeInt);
    expect(process.listeners('SIGTERM')).toEqual(beforeTerm);
  });
  it('executable returns finalized success JSON and identical output file after real cleanup', async () => {
    const path = await project();
    const out = join(path, 'result.json');
    const result = await launch([...args(path), '--out', out]).result;
    const report = JSON.parse(result.stdout) as BotTestReport;
    expect(result.code).toBe(0);
    expect(result.signal).toBeNull();
    expect(report.status).toBe('passed');
    expect(report.cleanupErrors).toEqual([]);
    expect(report.assertions[0]?.actual?.data['content']).toBe('Pong! Offline and deterministic.');
    expect(JSON.parse(await readFile(out, 'utf8'))).toEqual(report);
    expect((await traces(path)).some((t) => t.event === 'callback')).toBe(true);
    await assertDead(path);
  }, 15000);
  it('executable mismatch is exit 1, with observed callback rather than expected output', async () => {
    const path = await project();
    const casePath = join(path, 'case-pass.json');
    const value = JSON.parse(await readFile(casePath, 'utf8')) as {
      steps: { expect: { content: string } }[];
    };
    value.steps[0]!.expect.content = 'A different expected message.';
    await writeFile(casePath, JSON.stringify(value));
    const result = await launch(args(path)).result;
    expect(result.code).toBe(1);
    const report = JSON.parse(result.stdout) as BotTestReport;
    expect(report.status).toBe('failed');
    expect(report.assertions[0]?.passed).toBe(false);
    expect(report.assertions[0]?.expected.content).toBe('A different expected message.');
    expect(report.assertions[0]?.actual?.data['content']).toBe('Pong! Offline and deterministic.');
    await assertDead(path);
  }, 15000);
  it('cannot pass by expecting a redacted projection instead of the actual bot reply', async () => {
    const path = await project('wrong');
    const casePath = join(path, 'case-pass.json');
    const value = JSON.parse(await readFile(casePath, 'utf8')) as {
      steps: { expect: { content: string } }[];
    };
    value.steps[0]!.expect.content = 'WRONG BOT [REDACTED]';
    await writeFile(casePath, JSON.stringify(value));
    const result = await launch(args(path)).result;
    expect(result.code).toBe(1);
    const report = JSON.parse(result.stdout) as BotTestReport;
    expect(report.status).toBe('runner-error');
    expect(report.error?.code).toBe('transport');
    expect(report.assertions).toEqual([]);
    await assertDead(path);
  }, 15000);
  it('executable rejects unknown options before launch or output writes', async () => {
    const path = await project();
    const out = join(path, 'result.json');
    await writeFile(out, 'PREVIOUS RESULT');
    const result = await launch([...args(path), '--out', out, '--token', 'not-a-token']).result;
    expect(result.code).toBe(2);
    expect(result.stdout).toBe('');
    expect(await readFile(out, 'utf8')).toBe('PREVIOUS RESULT');
    expect(await traces(path)).toEqual([]);
  });
  it('rejects overwriting the case with its report', () => {
    expect(() =>
      parseArgs(['bot-test', 'case.json', '--project', '.', '--out', './case.json']),
    ).toThrow('Input and output paths must be different.');
  });
  it('executable invalid context exits 2 without spawning a bot', async () => {
    const path = await project();
    const casePath = join(path, 'case-pass.json');
    const value = JSON.parse(await readFile(casePath, 'utf8')) as { context: { actorId: string } };
    value.context.actorId = 'unknown';
    await writeFile(casePath, JSON.stringify(value));
    const result = await launch(args(path)).result;
    expect(result.code).toBe(2);
    expect((JSON.parse(result.stdout) as BotTestReport).status).toBe('invalid');
    expect(await traces(path)).toEqual([]);
  }, 15000);
  it.each([
    ['SIGINT', 130, 'startup-stall', 'readiness'],
    ['SIGTERM', 143, 'pong-only', 'command'],
  ] as const)(
    'executable %s cancels and awaits real child cleanup',
    async (signal, code, mode, event) => {
      const path = await project(mode);
      const out = join(path, 'cancelled.json');
      const running = launch([...args(path), '--out', out]);
      try {
        const deadline = Date.now() + 4000;
        while (
          !(await traces(path)).some((trace) => trace.event === event) &&
          Date.now() < deadline
        )
          await delay(10);
        expect((await traces(path)).some((trace) => trace.event === event)).toBe(true);
        expect(running.child.kill(signal)).toBe(true);
        const result = await running.result;
        expect(result.code).toBe(code);
        expect(result.signal).toBeNull();
        const report = JSON.parse(result.stdout) as BotTestReport;
        expect(report.status).toBe('cancelled');
        expect(JSON.parse(await readFile(out, 'utf8'))).toEqual(report);
        expect(report.assertions).toEqual([]);
        expect(report.cleanupErrors).toEqual([]);
        await assertDead(path);
      } finally {
        if (running.child.exitCode === null && running.child.signalCode === null)
          running.child.kill('SIGTERM');
        await running.result;
      }
    },
    15000,
  );
});
